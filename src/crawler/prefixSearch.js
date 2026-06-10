import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractListingProducts } from '../extract/listing.js';
import { buildPartNumberRegex } from '../extract/partNumber.js';
import { buildSearchUrl } from '../extract/pagination.js';
import { crawlCategoryCrawl } from './categoryCrawl.js';

export async function crawlPrefixSearch(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };

  // Per-prefix seenUrls so overlapping prefixes don't prematurely stop each other's pagination
  const seenByPrefix = new Map();
  // Site-wide dedup set keyed partNumber|url (used at products.push time)
  const seenSiteWide = new Set();
  // Every prefix-matching code seen ANYWHERE in page text (incl. "Suitable For"
  // cross-references in descriptions). Codes never captured as products get a
  // targeted full-code search afterwards — some shops have products that their
  // own search doesn't return for partial terms.
  const harvestRe = new RegExp(buildPartNumberRegex(site.prefixes).source, 'gi');
  const harvested = new Set();

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
      for (const code of html.match(harvestRe) ?? []) harvested.add(code);
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
      // Keep paginating while pages still contain products. Some shops repeat
      // products across pages (unstable sort), so a single all-duplicates page must
      // not end the prefix — only stop after 2 consecutive pages with nothing new,
      // or a genuinely empty page. max_pages stays the hard cap either way.
      const noFreshStreak = freshForPrefix.length > 0 ? 0 : (request.userData.noFreshStreak ?? 0) + 1;
      if (found.length > 0 && noFreshStreak < 2 && pageNo < site.max_pages) {
        await crawler.addRequests([{
          url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, pageNo + 1),
          userData: { prefix, pageNo: pageNo + 1, noFreshStreak },
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

  // --- Phase 2: category walk ---
  // Some products never appear in search results for partial terms but ARE listed
  // on category pages (and vice versa); crawl both and take the union.
  const catResult = await crawlCategoryCrawl(site, {
    cookies,
    onProgress: (p) => onProgress({ pagesVisited: stats.pagesVisited + p.pagesVisited, partsFound: products.length }),
    onPageHtml: (html) => {
      for (const code of html.match(harvestRe) ?? []) harvested.add(code);
    },
  });
  stats.pagesVisited += catResult.stats.pagesVisited;
  stats.pagesFailed += catResult.stats.pagesFailed;
  for (const w of catResult.stats.warnings) {
    if (!w.startsWith('Category crawl found no products')) stats.warnings.push(w);
  }
  for (const p of catResult.products) {
    const key = `${p.partNumber}|${p.url}`;
    if (!seenSiteWide.has(key)) {
      seenSiteWide.add(key);
      products.push(p);
    }
  }
  onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });

  // --- Phase 3: cross-reference harvest ---
  // Codes that appeared in page text but were never captured as products are
  // searched individually (one page each, no pagination).
  const captured = new Set(products.map((p) => p.partNumber));
  const orphans = [...harvested].filter((c) => !captured.has(c));
  if (orphans.length > 0) {
    const harvestCrawler = new PlaywrightCrawler({
      maxConcurrency: 2,
      maxRequestRetries: 2,
      respectRobotsTxtFile: true,
      maxRequestsPerCrawl: orphans.length + 5,
      preNavigationHooks: [
        async ({ page }) => {
          if (cookies?.length) await page.context().addCookies(cookies);
        },
      ],
      requestHandler: async ({ page, request }) => {
        stats.pagesVisited += 1;
        const html = await page.content();
        const found = extractListingProducts(html, { prefixes: site.prefixes, baseUrl: site.base_url });
        for (const p of found) {
          // keep only the searched code itself; full-code result pages can echo the
          // code in titles/breadcrumbs (price 0) or show cross-referencing products
          if (p.partNumber !== request.userData.code || !(p.price > 0)) continue;
          const key = `${p.partNumber}|${p.url}`;
          if (!seenSiteWide.has(key)) {
            seenSiteWide.add(key);
            products.push(p);
          }
        }
        onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });
      },
      failedRequestHandler: ({ request }, err) => {
        stats.pagesFailed += 1;
        stats.warnings.push(`Harvest page failed: ${request.url} — ${err?.message ?? 'unknown error'}`);
      },
    }, new Configuration({ persistStorage: false }));

    await harvestCrawler.run(orphans.map((code) => ({
      url: buildSearchUrl(site.search_url_pattern, site.base_url, code, 1),
      userData: { code },
      uniqueKey: `${site.id}:harvest:${code}`,
    })));
  }

  return { products, stats };
}
