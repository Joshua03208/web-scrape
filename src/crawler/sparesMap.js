import { PlaywrightCrawler, Configuration } from 'crawlee';

// Pulls spare-part codes out of page text. Pages list them as
// "Spares – IX100025CP, ST20004XX, ST00003XX, ..." (one or more such lines).
export function parseSparesText(text) {
  const codes = new Set();
  for (const m of text.matchAll(/Spares\s*[–—-]\s*([^\n]+)/gi)) {
    for (const raw of m[1].split(',')) {
      const code = raw.trim().replace(/\.+$/, '');
      if (/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,19}$/.test(code)) codes.add(code.toUpperCase());
    }
  }
  return [...codes];
}

// Crawls a shop category of products (e.g. WooCommerce showers category), opens
// each product page and records: product title, SKU, and every spare-part code
// from its Spares tab. base_url = the category listing URL.
export async function crawlSparesMap(site, { cookies = null, onProgress = () => {} } = {}) {
  const spares = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seenProducts = new Set();

  const base = new URL(site.base_url);
  const baseTag = base.searchParams.get('product_tag');
  const basePath = base.pathname.replace(/\/page\/\d+\/?$/, '');

  // category/subcategory/pagination links must stay under the base category
  // (and carry the same product tag, if the base url has one)
  const isSameCategory = (u) =>
    u.pathname.startsWith(basePath) &&
    (!baseTag || u.searchParams.get('product_tag') === baseTag);
  // canonical form so sort/display variants of one category page collapse
  const canonicalCategoryUrl = (u) =>
    `${u.origin}${u.pathname}${baseTag ? `?product_tag=${encodeURIComponent(baseTag)}` : ''}`;

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
    requestHandler: async ({ page, request, crawler }) => {
      stats.pagesVisited += 1;
      if (request.userData.kind === 'product') {
        const shower = (await page.locator('h1').first().innerText().catch(() => '')).trim();
        // textContent, not innerText: the Spares tab panel is hidden until clicked
        const text = await page.evaluate(() => document.body.textContent);
        const codes = parseSparesText(text);
        // SKU: first code-looking cell of a table whose header mentions SKU
        const sku = await page.$$eval('table', (tables) => {
          for (const t of tables) {
            if (!/SKU/i.test(t.querySelector('th, thead, tr')?.textContent ?? '')) continue;
            for (const td of t.querySelectorAll('td')) {
              const v = td.textContent.trim();
              if (/^[A-Za-z0-9][A-Za-z0-9\-\/]{2,19}$/.test(v)) return v;
            }
          }
          return null;
        }).catch(() => null);
        if (shower && codes.length > 0) {
          for (const spare of codes) {
            spares.push({ shower, sku, spare, url: request.loadedUrl ?? request.url });
          }
        } else if (shower) {
          // recorded with spare = null so the Spares tab shows the product
          // as "none published" rather than hiding it
          spares.push({ shower, sku, spare: null, url: request.loadedUrl ?? request.url });
        }
        onProgress({ pagesVisited: stats.pagesVisited, partsFound: spares.length });
        return;
      }
      // category page: enqueue product links + same-category pagination
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
      const requests = [];
      for (const h of [...new Set(hrefs)]) {
        let u;
        try { u = new URL(h); } catch { continue; }
        if (u.origin !== base.origin || u.hash.length > 1) continue;
        if (/\/products?\//.test(u.pathname)) {
          const url = `${u.origin}${u.pathname}`;
          if (!seenProducts.has(url)) {
            seenProducts.add(url);
            requests.push({ url, userData: { kind: 'product' }, uniqueKey: url });
          }
        } else if (isSameCategory(u)) {
          const url = canonicalCategoryUrl(u);
          requests.push({ url, userData: { kind: 'category' }, uniqueKey: url });
        }
      }
      if (requests.length > 0) await crawler.addRequests(requests);
      onProgress({ pagesVisited: stats.pagesVisited, partsFound: spares.length });
    },
    failedRequestHandler: ({ request }, err) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url} — ${err?.message ?? 'unknown error'}`);
    },
  }, config);

  await crawler.run([{ url: site.base_url, userData: { kind: 'category' }, uniqueKey: site.base_url }]);
  // spares_map writes its own table; products stays empty for the orchestrator
  return { products: [], spares, stats };
}
