// Checks the deployed site the way a phone uses it: first load, a reload served by the service worker,
// then a reload with no network. Camera input is a real pushup clip through Chrome's fake camera.
// Usage: node test/live.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'https://schponken.github.io/workout-tracker/';
const y4m = join(tmpdir(), 'reps-731.y4m');
if (!existsSync(y4m)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', 'test/clips/731/clip.mp4', '-vf', 'scale=480:270', '-r', '30', '-pix_fmt', 'yuv420p', y4m]);
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
});
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const session = async (label) => {
    await page.goto(BASE);
    await page.click('#go');
    await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 120000 });
    await page.waitForTimeout(12500); // one pass of the 6-pushup clip
    const reps = await page.evaluate(() => window.__reps.events.filter((e) => e.type === 'rep').length);
    check(reps >= 5 && reps <= 7, `${label}: counted ${reps} pushups (clip has 6)`);
  };
  await session('first load, from the network');
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready, null, { timeout: 30000 });
  const cached = await page.evaluate(async () => {
    const c = await caches.open('reps-assets-1');
    return Promise.all(['models/pose_landmarker_full.task', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm'].map(async (p) => !!(await c.match(new URL(p, location.href).href))));
  });
  check(cached.every(Boolean), `model + wasm seeded into the offline cache after the first load (${cached})`);
  await session('second load, through the service worker');
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
  await ctx.setOffline(true);
  await session('third load, offline');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
}
process.exit(failures.length ? 1 : 0);
