// Runs MediaPipe over every clip in test/clips/<id>/clip.mp4 and saves landmarks to test/traces/<id>.json.
// Usage: node test/extract.mjs [id ...]
import { chromium } from 'playwright-core';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { serve } from '../scripts/serve.mjs';

const FPS = 30;
const server = await serve(8124);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('http://127.0.0.1:8124/test/harness.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : await readdir('test/clips');
  await mkdir('test/traces', { recursive: true });
  for (const id of ids) {
    const t0 = Date.now();
    const trace = await page.evaluate(([src, fps]) => window.extract(src, fps), [`/test/clips/${id}/clip.mp4`, FPS]);
    await writeFile(`test/traces/${id}.json`, JSON.stringify(trace));
    const seen = trace.frames.filter((f) => f.w).length;
    console.log(`${id}: ${trace.frames.length} frames, ${seen} with a pose, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
} finally {
  await browser.close();
  server.close();
}
