import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractPairsByProximity } from '../extract/proximity.js';

export async function crawlLinkCrawl(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seen = new Set();

  // Each crawl gets its own in-memory Configuration so request queues are never shared
  // across sequential runs in the same long-lived process (e.g. Express server). Without
  // this, same-domain URLs discovered in a previous run would be considered already
  // handled and crawlee would skip them. MemoryStorage discards all state when GC'd.
  const config = new Configuration({ persistStorage: false });

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    maxRequestRetries: 2,
    respectRobotsTxtFile: true,
    maxRequestsPerCrawl: site.max_pages,
    onSkippedRequest: ({ url, reason }) => {
      stats.warnings.push(`Skipped (${reason}): ${url}`);
    },
    preNavigationHooks: [
      async ({ page }) => {
        if (cookies?.length) await page.context().addCookies(cookies);
      },
    ],
    requestHandler: async ({ page, request, enqueueLinks }) => {
      stats.pagesVisited += 1;
      const html = await page.content();
      const pairs = extractPairsByProximity(html, {
        prefixes: site.prefixes, pageUrl: request.loadedUrl ?? request.url,
      });
      for (const p of pairs) {
        const key = `${p.partNumber}|${p.price}|${p.url}`;
        if (!seen.has(key)) { seen.add(key); products.push(p); }
      }
      onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });
      await enqueueLinks({ strategy: 'same-domain' });
    },
    failedRequestHandler: ({ request }, err) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url} — ${err?.message ?? 'unknown error'}`);
    },
  }, config);

  await crawler.run([site.base_url]);
  return { products, stats };
}
