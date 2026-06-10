// Diagnose what the crawler's browser sees on a given page.
// Usage: node scripts/diagnose.mjs "<url>"
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/diagnose.mjs "<url>"');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2500);

console.log('http status :', resp?.status());
console.log('final url   :', page.url());
console.log('page title  :', await page.title());

const hrefs = await page.$$eval('a[href]', (as) => [...new Set(as.map((a) => a.href))]);
console.log('total links :', hrefs.length);
console.log('product links (/products/):', hrefs.filter((h) => /\/products?\//.test(h)).length);
console.log('category links (/product-category/):', hrefs.filter((h) => h.includes('/product-category/')).length);

const text = await page.evaluate(() => document.body.textContent);
console.log('has "Spares -" line:', /Spares\s*[–—-]\s*[A-Z0-9]/.test(text));
console.log('body starts:', (await page.evaluate(() => document.body.innerText)).trim().slice(0, 120).replace(/\s+/g, ' '));
await browser.close();
