import { chromium } from 'playwright';

const urls = [
  'https://www.intatec.co.uk/products/mio-safe-touch-single-outlet-thermostatic-shower-with-flexible-riser-kit/',
  'https://www.intatec.co.uk/products/enzo-safe-touch-single-outlet-thermostatic-shower-with-flexible-riser-kit-and-multi-function-handset/',
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const u of urls) {
  await page.goto(u, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const found = await page.evaluate(() => {
    const t = document.body.textContent;
    const out = [];
    for (const m of t.matchAll(/spares?/gi)) {
      out.push(t.slice(Math.max(0, m.index - 30), m.index + 120).replace(/\s+/g, ' '));
    }
    return out.slice(0, 6);
  });
  console.log(`\n=== ${u.split('/products/')[1].slice(0, 50)}`);
  found.forEach((s) => console.log('  ...' + s));
  await page.waitForTimeout(1000);
}
await browser.close();
