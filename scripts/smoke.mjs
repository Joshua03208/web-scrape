// scripts/smoke.mjs
import { crawlPrefixSearch } from '../src/crawler/prefixSearch.js';

const site = {
  id: 0,
  name: 'Central Services (smoke)',
  base_url: 'https://central-servicesuk.co.uk/',
  search_url_pattern: 'index.php?route=product/search&search={query}&page={page}',
  prefixes: ['133.'],
  max_pages: 2,
};

const { products, stats } = await crawlPrefixSearch(site, {
  onProgress: (p) => console.log(`pages: ${p.pagesVisited}, parts: ${p.partsFound}`),
});

console.log(`\n${products.length} products from ${stats.pagesVisited} pages`);
console.log(stats.warnings.length ? `warnings: ${stats.warnings.join('; ')}` : 'no warnings');
for (const p of products.slice(0, 5)) {
  console.log(`${p.partNumber}  £${p.price}  ${p.name}  ${p.lowConfidence ? 'LOW-CONF' : ''}`);
}
if (products.length === 0) process.exit(1);
