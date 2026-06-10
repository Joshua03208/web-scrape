import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractListingProducts } from '../extract/listing.js';

// Normalise category-page URLs so sort/limit/display variants of the same page
// collapse into one request: keep route + path (+ page beyond 1), force limit=100.
// Returns null for anything that isn't a category page.
export function normaliseCategoryUrl(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    if (u.searchParams.get('route') !== 'product/category') return null;
    const path = u.searchParams.get('path');
    if (!path) return null;
    const keep = new URLSearchParams();
    keep.set('route', 'product/category');
    keep.set('path', path);
    const page = u.searchParams.get('page');
    if (page && page !== '1') keep.set('page', page);
    keep.set('limit', '100');
    return `${u.origin}${u.pathname}?${keep.toString()}`;
  } catch {
    return null;
  }
}

// Walks the shop's category tree (menus -> categories -> pagination) and extracts
// product cards from every listing page. Unlike prefix search this does not depend
// on the site's search engine, which on some shops misses products whose name/model
// fields don't contain the search term.
export async function crawlCategoryCrawl(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seen = new Set();

  // Per-call in-memory storage: see prefixSearch.js for why (request-queue reuse
  // across sequential runs in one long-lived process).
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
    requestHandler: async ({ page, crawler }) => {
      stats.pagesVisited += 1;
      const html = await page.content();
      const found = extractListingProducts(html, { prefixes: site.prefixes, baseUrl: site.base_url });
      for (const p of found) {
        const key = `${p.partNumber}|${p.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          products.push(p);
        }
      }
      onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
      const targets = [...new Set(hrefs.map((h) => normaliseCategoryUrl(h, site.base_url)).filter(Boolean))];
      if (targets.length > 0) {
        await crawler.addRequests(targets.map((url) => ({ url, uniqueKey: url })));
      }
    },
    failedRequestHandler: ({ request }, err) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url} — ${err?.message ?? 'unknown error'}`);
    },
  }, config);

  // Seed with the base URL and the shop's sitemap page — menus often expose only
  // top-level categories, while the sitemap lists the whole category tree.
  // (Standard OpenCart route; on shops without it the request just fails softly.)
  await crawler.run([
    site.base_url,
    new URL('index.php?route=information/sitemap', site.base_url).href,
  ]);
  if (products.length === 0) {
    stats.warnings.push('Category crawl found no products — check the site has category pages (route=product/category)');
  }
  return { products, stats };
}
