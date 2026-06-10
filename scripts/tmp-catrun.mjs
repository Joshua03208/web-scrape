import { crawlCategoryCrawl } from '../src/crawler/categoryCrawl.js';

const SAMPLES = ['133.0007.851', '133.0007.855', '133.0007.856', '133.0060.773',
  '133.0358.053', '133.0358.055', '133.0440.361', '133.0301.532', '133.0050.083',
  '133.0438.152C', '133.0438.154H'];

const site = {
  id: 0,
  name: 'Central Services (category test)',
  base_url: 'https://central-servicesuk.co.uk/',
  prefixes: ['112.', '113.', '119.', '120.', '133.', '150.', '992.', '995.'],
  max_pages: 250,
};

const { products, stats } = await crawlCategoryCrawl(site, {
  onProgress: (p) => { if (p.pagesVisited % 10 === 0) console.log(`pages: ${p.pagesVisited}, parts: ${p.partsFound}`); },
});

const codes = new Set(products.map((p) => p.partNumber));
console.log(`\n${products.length} product listings, ${codes.size} distinct codes, ${stats.pagesVisited} pages, ${stats.pagesFailed} failed`);
if (stats.warnings.length) console.log('warnings:', stats.warnings.slice(0, 5).join(' | '));
console.log('samples:', SAMPLES.map((s) => `${s}:${codes.has(s) ? 'YES' : 'no'}`).join('  '));
const byPrefix = {};
for (const c of codes) { const p = c.slice(0, 4); byPrefix[p] = (byPrefix[p] ?? 0) + 1; }
console.log('by prefix:', JSON.stringify(byPrefix));
