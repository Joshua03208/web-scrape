import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractListingProducts } from '../extract/listing.js';
import { buildSearchUrl } from '../extract/pagination.js';

export async function crawlPrefixSearch(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seenUrls = new Set();

  // Each crawl gets its own in-memory Configuration so request queues are never shared
  // across sequential runs in the same long-lived process (e.g. Express server). Without
  // this, static uniqueKeys like `${site.id}:${prefix}:1` would be considered "already
  // handled" on a second run and crawlee would crawl nothing. MemoryStorage (the default
  // when persistStorage is false) keeps all state in-process and discards it when the
  // Configuration/crawler is GC'd.
  const config = new Configuration({ persistStorage: false });

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    maxRequestRetries: 2,
    respectRobotsTxtFile: true,
    preNavigationHooks: [
      async ({ page }) => {
        if (cookies?.length) await page.context().addCookies(cookies);
      },
    ],
    requestHandler: async ({ page, request, crawler }) => {
      stats.pagesVisited += 1;
      const { prefix, pageNo } = request.userData;
      const html = await page.content();
      const found = extractListingProducts(html, { prefixes: [prefix], baseUrl: site.base_url });
      const fresh = found.filter((p) => !seenUrls.has(`${p.partNumber}|${p.url}`));
      for (const p of fresh) seenUrls.add(`${p.partNumber}|${p.url}`);
      products.push(...fresh);
      onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });

      if (pageNo === 1 && found.length === 0) {
        stats.warnings.push(`No results for prefix ${prefix} — check search pattern or site`);
      }
      // next page only while this page produced new products
      if (fresh.length > 0 && pageNo < site.max_pages) {
        await crawler.addRequests([{
          url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, pageNo + 1),
          userData: { prefix, pageNo: pageNo + 1 },
          uniqueKey: `${site.id}:${prefix}:${pageNo + 1}`,
        }]);
      }
    },
    failedRequestHandler: ({ request }) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url}`);
    },
  }, config);

  await crawler.run(site.prefixes.map((prefix) => ({
    url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, 1),
    userData: { prefix, pageNo: 1 },
    uniqueKey: `${site.id}:${prefix}:1`,
  })));
  return { products, stats };
}
