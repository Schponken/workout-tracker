// Renders icons/icon.svg to the PNG sizes phones want. Run: node scripts/icons.mjs
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
// Maskable: full-bleed background, artwork inside the 80% safe zone.
const maskable = svg.replace('rx="112"', 'rx="0"').replace(/(<circle cx="256" cy="256"[\s\S]*)<\/svg>/, '<g transform="translate(256 256) scale(0.8) translate(-256 -256)">$1</g></svg>');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, size, art] of [['apple-touch-icon', 180, svg], ['icon-192', 192, svg], ['icon-512', 512, svg], ['icon-maskable-512', 512, maskable]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } }); // fresh page: resizing one leaves a stale surface
  const square = name === 'apple-touch-icon' ? art.replace('rx="112"', 'rx="0"') : art; // iOS rounds corners itself
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${square}`);
  await page.screenshot({ path: `icons/${name}.png`, omitBackground: true });
  await page.close();
}
await browser.close();
