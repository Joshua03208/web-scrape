import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractListingProducts } from '../extract/listing.js';
import { buildSearchUrl } from '../extract/pagination.js';

export async function crawlPrefixSearch(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };

  // Per-prefix seenUrls so overlapping prefixes don't prematurely stop each other's pagination
  const seenByPrefix = new Map();
  // Site-wide dedup set keyed partNumber|url (used at products.push time)
  const seenSiteWide = new Set();

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
    maxRequestsPerCrawl: site.max_pages * site.prefixes.length,
    onSkippedRequest: ({ url, reason }) => {
      stats.warnings.push(`Skipped (${reason}): ${url}`);
    },
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

      // Per-prefix dedup to decide pagination continuity
      if (!seenByPrefix.has(prefix)) seenByPrefix.set(prefix, new Set());
      const prefixSeen = seenByPrefix.get(prefix);
      const freshForPrefix = found.filter((p) => !prefixSeen.has(`${p.partNumber}|${p.url}`));
      for (const p of freshForPrefix) prefixSeen.add(`${p.partNumber}|${p.url}`);

      // Site-wide dedup to avoid duplicates across prefixes
      for (const p of freshForPrefix) {
        const key = `${p.partNumber}|${p.url}`;
        if (!seenSiteWide.has(key)) {
          seenSiteWide.add(key);
          products.push(p);
        }
      }

      onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });

      if (pageNo === 1 && found.length === 0) {
        stats.warnings.push(`No results for prefix ${prefix} — check search pattern or site`);
      }
      // next page only while this page produced new products (per-prefix freshness)
      if (freshForPrefix.length > 0 && pageNo < site.max_pages) {
        await crawler.addRequests([{
          url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, pageNo + 1),
          userData: { prefix, pageNo: pageNo + 1 },
          uniqueKey: `${site.id}:${prefix}:${pageNo + 1}`,
        }]);
      }
    },
    failedRequestHandler: ({ request }, err) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url} — ${err?.message ?? 'unknown error'}`);
    },
  }, config);

  await crawler.run(site.prefixes.map((prefix) => ({
    url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, 1),
    userData: { prefix, pageNo: 1 },
    uniqueKey: `${site.id}:${prefix}:1`,
  })));
  return { products, stats };
}
