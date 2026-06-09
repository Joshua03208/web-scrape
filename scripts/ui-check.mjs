// scripts/ui-check.mjs — screenshot the three dashboard tabs (dev aid, server must be running)
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });

const shots = [];
for (const tab of ['sites', 'run', 'results']) {
  await page.click(`nav button[data-tab="${tab}"]`);
  await page.waitForTimeout(600);
  const path = `storage/ui-${tab}.png`;
  await page.screenshot({ path, fullPage: true });
  shots.push(path);
}
console.log('Saved:', shots.join(', '));
await browser.close();
