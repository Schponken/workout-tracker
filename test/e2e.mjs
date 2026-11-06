// End-to-end: the real page in Chrome, fed real workout clips, both through the camera path
// (Chrome's fake camera device) and the ?src= file path. Needs test/clips (see test/extract.mjs).
// Usage: node test/e2e.mjs   — screenshots go to $SHOTS (default: a temp folder).
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../scripts/serve.mjs';

const PORT = 8125, BASE = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOTS ?? join(tmpdir(), 'reps-e2e');
mkdirSync(SHOTS, { recursive: true });
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
const repsOf = (page, ex) => page.evaluate((ex) => window.__reps.events.filter((e) => e.type === 'rep' && e.ex === ex).length, ex);

async function startApp(page, query = '') {
  await page.goto(BASE + query);
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('start').hidden, null, { timeout: 90000 });
}

const server = await serve(PORT);
let browser;
try {
  // 1) File path, phone-sized landscape: counts must match the hand-counted clips.
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  for (const [id, ex, want] of [['24277', 'pushup', 9], ['52112', 'lunge', 3], ['36015', 'crunch', 9]]) {
    if (!existsSync(`test/clips/${id}/clip.mp4`)) { console.log(`skip ${id}: clip missing`); continue; }
    await startApp(page, `?src=/test/clips/${id}/clip.mp4&once&debug`);
    await page.waitForFunction((d) => document.getElementById('video').currentTime > d, 4, { timeout: 30000 });
    await page.screenshot({ path: join(SHOTS, `landscape-${id}.png`) });
    await page.waitForFunction(() => document.getElementById('video').ended, null, { timeout: 120000 });
    const got = await repsOf(page, ex);
    const shown = await page.textContent('#count');
    check(got === want, `${id}: ${got}/${want} ${ex} counted in the live app (HUD shows ${shown})`);
  }

  // 2) Log survives a reload: bank the open set the way backgrounding does, then reopen.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await page.click('#startLog');
  const logText = await page.textContent('#logBody');
  check(/Crunches/.test(logText), `log keeps sets across reloads ("${logText.slice(0, 80).replace(/\s+/g, ' ')}…")`);
  await page.screenshot({ path: join(SHOTS, 'log.png') });
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();

  // 3) Camera path: getUserMedia with a fake device playing the front-view pushup clip, portrait phone.
  const y4m = join(tmpdir(), 'reps-731.y4m');
  if (existsSync('test/clips/731/clip.mp4') && !existsSync(y4m)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', 'test/clips/731/clip.mp4', '-vf', 'scale=480:270', '-r', '30', '-pix_fmt', 'yuv420p', y4m]);
  }
  if (existsSync(y4m)) {
    browser = await chromium.launch({
      channel: 'chrome', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    });
    const cam = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] })).newPage();
    const camErrors = [];
    cam.on('pageerror', (e) => camErrors.push(e.message));
    await startApp(cam, '?debug');
    await cam.waitForTimeout(11000); // one pass of the clip: 6 pushups
    await cam.screenshot({ path: join(SHOTS, 'portrait-camera.png') });
    const got = await repsOf(cam, 'pushup');
    check(got >= 5 && got <= 7, `camera path: ${got} pushups from the fake camera (clip has 6)`);
    check(await cam.evaluate(() => document.getElementById('video').classList.contains('mirror')), 'front camera preview is mirrored');
    check(camErrors.length === 0, `no page errors on the camera path${camErrors.length ? ': ' + camErrors.join(' | ') : ''}`);
  }
} finally {
  await browser?.close();
  server.close();
}
console.log(`\nscreenshots: ${SHOTS}`);
process.exit(failures.length ? 1 : 0);
