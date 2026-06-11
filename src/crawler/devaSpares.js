// Deva is a Shopify store. Its collection pages expose a clean JSON feed
// (/collections/<c>/products.json) with title + variant SKU + price, so there's
// no HTML scraping or browser needed — two light requests cover everything.

const COLLECTIONS = ['spares', 'spares-2'];
const PAGE_LIMIT = 250; // Shopify max per page

// Turn one collection's products.json payload into {partNumber, name, price, ...}
// rows. One row per product (the listing card), keyed on the variant SKU.
export function parseDevaProducts(json, { origin, collection }) {
  const out = [];
  for (const p of json.products ?? []) {
    const v = (p.variants ?? [])[0] ?? {};
    const sku = String(v.sku ?? '').trim();
    if (!sku) continue;
    const price = Number(v.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({
      partNumber: sku,
      name: String(p.title ?? '').trim() || null,
      price,
      currency: 'GBP',
      url: `${origin}/collections/${collection}/products/${p.handle}`,
      lowConfidence: false,
    });
  }
  return out;
}

// Fetches every product from the configured collections, de-duped by SKU.
export async function crawlDevaSpares(site, { onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seen = new Set();
  const origin = new URL(site.base_url).origin;

  for (const collection of COLLECTIONS) {
    for (let page = 1; page <= site.max_pages; page++) {
      const url = `${origin}/collections/${collection}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
      let json;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      } catch (err) {
        stats.pagesFailed += 1;
        stats.warnings.push(`Failed: ${url} — ${err.message}`);
        break; // stop this collection on error
      }
      stats.pagesVisited += 1;
      const rows = parseDevaProducts(json, { origin, collection });
      if (rows.length === 0) break; // past the last page
      for (const r of rows) {
        if (seen.has(r.partNumber)) continue; // no duplicates across collections
        seen.add(r.partNumber);
        products.push(r);
      }
      onProgress({ pagesVisited: stats.pagesVisited, partsFound: products.length });
      // gentle pacing between requests
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (products.length === 0) stats.warnings.push('Deva returned no products — check the collection feed');
  return { products, stats };
}
