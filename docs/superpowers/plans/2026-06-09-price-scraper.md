# Shower Parts Price Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard that scrapes supplier sites for part numbers + prices (prefix-search or link-crawl per site), stores history in SQLite, and exports CSV/xlsx.

**Architecture:** Pure extraction functions (cheerio over HTML strings) are unit-tested against fixtures and called by thin Crawlee/Playwright crawl strategies. A run orchestrator writes append-only observations to SQLite. An Express app serves a JSON API + static single-page dashboard.

**Tech Stack:** Node.js (ESM), Crawlee + Playwright, better-sqlite3, Express, cheerio, exceljs, csv-parse, multer; Vitest + supertest for tests.

**Spec:** `docs/superpowers/specs/2026-06-09-price-scraper-design.md`

---

## File structure

```
package.json            ESM, scripts: start/test
.gitignore
src/
  extract/price.js          parsePrice(text) -> {amount, currency} | null
  extract/partNumber.js     normalisePartNumber, buildPartNumberRegex
  extract/pagination.js     buildSearchUrl(pattern, base, query, page)
  extract/listing.js        extractListingProducts(html, {prefixes, baseUrl})
  extract/proximity.js      extractPairsByProximity(html, {prefixes, pageUrl, title})
  db.js                     openDb + all query helpers
  export/csv.js             rowsToCsv(rows, columns)
  export/xlsx.js            rowsToXlsxBuffer(rows, columns)
  crawler/login.js          loginAndGetCookies(site)
  crawler/prefixSearch.js   crawlPrefixSearch(site, opts)
  crawler/linkCrawl.js      crawlLinkCrawl(site, opts)
  crawler/run.js            executeRun(db, opts) orchestrator
  server/app.js             createApp(db, deps) Express factory
  server/public/index.html  dashboard UI
  server/public/app.js
  server/public/style.css
  index.js                  entry point
scripts/smoke.mjs           manual smoke test against real site
tests/                      one test file per src module + fixtures/
```

Notes for the engineer:
- Everything is ESM (`"type": "module"`). Use `import`, not `require`.
- All DB helpers take the `db` handle as first argument — tests use `:memory:`.
- Crawlee writes a `storage/` directory at runtime; it is gitignored.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `.gitignore`

- [ ] **Step 1: Init package and install dependencies**

```powershell
npm init -y
npm pkg set type=module scripts.test="vitest run" scripts.start="node src/index.js"
npm install crawlee playwright better-sqlite3 express cheerio exceljs csv-parse multer
npm install -D vitest supertest
npx playwright install chromium
```

Expected: installs complete without errors. (better-sqlite3 ships prebuilt Windows binaries; if it tries to compile, check Node is an LTS version.)

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
storage/
data/
*.db
```

- [ ] **Step 3: Verify vitest runs**

Run: `npx vitest run`
Expected: "No test files found" (exit code 1 is fine at this stage).

- [ ] **Step 4: Commit**

```powershell
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold node project with crawlee, sqlite, express, vitest"
```

---

### Task 2: Price parser

**Files:**
- Create: `src/extract/price.js`
- Test: `tests/price.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/price.test.js
import { describe, it, expect } from 'vitest';
import { parsePrice, findAllPrices } from '../src/extract/price.js';

describe('parsePrice', () => {
  it('parses GBP symbol', () => {
    expect(parsePrice('£20.81')).toEqual({ amount: 20.81, currency: 'GBP' });
  });
  it('parses USD symbol with surrounding text', () => {
    expect(parsePrice('Now only $123.45 each')).toEqual({ amount: 123.45, currency: 'USD' });
  });
  it('parses trailing currency code', () => {
    expect(parsePrice('123.45 USD')).toEqual({ amount: 123.45, currency: 'USD' });
  });
  it('parses thousands separators', () => {
    expect(parsePrice('£1,234.56')).toEqual({ amount: 1234.56, currency: 'GBP' });
  });
  it('parses whole-number prices', () => {
    expect(parsePrice('€45')).toEqual({ amount: 45, currency: 'EUR' });
  });
  it('returns null when no price present', () => {
    expect(parsePrice('Valve (20 Splines) : COLD')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });
  it('findAllPrices returns every amount in order', () => {
    // used by listing extractor for low-confidence detection
    expect(findAllPrices('was £25.00 now £20.81, £20.81 inc VAT')).toEqual([
      { amount: 25.0, currency: 'GBP' },
      { amount: 20.81, currency: 'GBP' },
      { amount: 20.81, currency: 'GBP' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/price.test.js`
Expected: FAIL — cannot find module `src/extract/price.js`.

- [ ] **Step 3: Write implementation**

```js
// src/extract/price.js
const SYMBOLS = { '£': 'GBP', '$': 'USD', '€': 'EUR' };
const PRICE_RE = /(£|\$|€)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(GBP|USD|EUR)\b/gi;

function toMatch(m) {
  const amountStr = m[2] ?? m[3];
  const amount = Number(amountStr.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const currency = m[1] ? SYMBOLS[m[1]] : m[4].toUpperCase();
  return { amount, currency };
}

export function findAllPrices(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const p = toMatch(m);
    if (p) out.push(p);
  }
  return out;
}

export function parsePrice(text) {
  return findAllPrices(text)[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/price.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```powershell
git add src/extract/price.js tests/price.test.js
git commit -m "feat: price parser for symbol and currency-code formats"
```

---

### Task 3: Part number utilities

**Files:**
- Create: `src/extract/partNumber.js`
- Test: `tests/partNumber.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/partNumber.test.js
import { describe, it, expect } from 'vitest';
import { normalisePartNumber, buildPartNumberRegex } from '../src/extract/partNumber.js';

describe('normalisePartNumber', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalisePartNumber('133.0440-351 a')).toBe('133.0440351A');
  });
});

describe('buildPartNumberRegex', () => {
  const re = buildPartNumberRegex(['133.', '112.']);
  it('matches a full part number with a known prefix', () => {
    expect('Code: 133.0440.351 here'.match(re)[0]).toBe('133.0440.351');
    expect('112.0021.45'.match(re)[0]).toBe('112.0021.45');
  });
  it('does not match other prefixes', () => {
    expect('999.0440.351'.match(re)).toBeNull();
  });
  it('does not match the bare prefix alone', () => {
    expect('see section 133. for details'.match(re)).toBeNull();
  });
  it('does not match when prefix is inside a longer number', () => {
    expect('5133.0440.351'.match(re)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/partNumber.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```js
// src/extract/partNumber.js
export function normalisePartNumber(raw) {
  return String(raw).toUpperCase().replace(/[\s\-]/g, '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches: <prefix><digits/dots ending in a digit>, e.g. "133." -> 133.0440.351
export function buildPartNumberRegex(prefixes) {
  const alts = prefixes.map(escapeRe).join('|');
  return new RegExp(`(?<![\\d.])(?:${alts})[\\d.]*\\d`, 'i');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/partNumber.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/extract/partNumber.js tests/partNumber.test.js
git commit -m "feat: part number normalisation and prefix regex"
```

---

### Task 4: Search URL builder

**Files:**
- Create: `src/extract/pagination.js`
- Test: `tests/pagination.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/pagination.test.js
import { describe, it, expect } from 'vitest';
import { buildSearchUrl } from '../src/extract/pagination.js';

describe('buildSearchUrl', () => {
  const base = 'https://central-servicesuk.co.uk/';
  const pattern = 'index.php?route=product/search&search={query}&page={page}';

  it('substitutes query and page, resolving against base url', () => {
    expect(buildSearchUrl(pattern, base, '133.', 2)).toBe(
      'https://central-servicesuk.co.uk/index.php?route=product/search&search=133.&page=2'
    );
  });
  it('URL-encodes the query', () => {
    expect(buildSearchUrl(pattern, base, 'a b&c', 1)).toContain('search=a%20b%26c');
  });
  it('accepts absolute patterns', () => {
    expect(buildSearchUrl('https://other.com/s?q={query}&p={page}', base, 'x', 3)).toBe(
      'https://other.com/s?q=x&p=3'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pagination.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```js
// src/extract/pagination.js
export function buildSearchUrl(pattern, baseUrl, query, page) {
  const filled = pattern
    .replaceAll('{query}', encodeURIComponent(query))
    .replaceAll('{page}', String(page));
  return new URL(filled, baseUrl).href;
}
```

Note: `encodeURIComponent('133.')` leaves the dot as-is, which matches the real site's URLs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pagination.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/extract/pagination.js tests/pagination.test.js
git commit -m "feat: search url builder with query/page substitution"
```

---

### Task 5: Listing-page extractor

**Files:**
- Create: `src/extract/listing.js`, `tests/fixtures/opencart-search.html`
- Test: `tests/listing.test.js`

- [ ] **Step 1: Create the HTML fixture**

This mirrors the real OpenCart structure from central-servicesuk.co.uk (product grid: code in a div, name in `h4 > a`, price in a `.price` paragraph). Card 3 has an old/new price pair to exercise low-confidence flagging.

```html
<!-- tests/fixtures/opencart-search.html -->
<!DOCTYPE html>
<html><head><title>Search - 133.</title></head><body>
<div id="content">
  <h2>Products meeting the search criteria</h2>
  <div class="row">
    <div class="product-layout col-md-3">
      <div class="product-thumb">
        <div class="image"><a href="/valve-20-splines-cold?search=133."><img src="/img/1.jpg" alt=""></a></div>
        <div class="code">133.0440.351</div>
        <div class="caption">
          <h4><a href="/valve-20-splines-cold?search=133.">Valve (20 Splines) : COLD</a></h4>
          <p class="price">£20.81</p>
        </div>
        <button type="button">ADD TO CART</button>
      </div>
    </div>
    <div class="product-layout col-md-3">
      <div class="product-thumb">
        <div class="image"><a href="/basket-strainer-plug?search=133."><img src="/img/2.jpg" alt=""></a></div>
        <div class="code">133.0049.669</div>
        <div class="caption">
          <h4><a href="/basket-strainer-plug?search=133.">Semi Integrated Basket Strainer Plug</a></h4>
          <p class="price">£17.63</p>
        </div>
        <button type="button">ADD TO CART</button>
      </div>
    </div>
    <div class="product-layout col-md-3">
      <div class="product-thumb">
        <div class="image"><a href="/valve-cold?search=133."><img src="/img/3.jpg" alt=""></a></div>
        <div class="code">133.0358.055</div>
        <div class="caption">
          <h4><a href="/valve-cold?search=133.">Valve : COLD</a></h4>
          <p class="price"><span class="old">£25.00</span> £20.81</p>
        </div>
        <button type="button">ADD TO CART</button>
      </div>
    </div>
  </div>
</div>
</body></html>
```

- [ ] **Step 2: Write the failing test**

```js
// tests/listing.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractListingProducts } from '../src/extract/listing.js';

const html = readFileSync('tests/fixtures/opencart-search.html', 'utf8');
const opts = { prefixes: ['133.'], baseUrl: 'https://central-servicesuk.co.uk/' };

describe('extractListingProducts', () => {
  it('extracts every product card with part number, name, price, absolute url', () => {
    const products = extractListingProducts(html, opts);
    expect(products).toHaveLength(3);
    expect(products[0]).toEqual({
      partNumber: '133.0440.351',
      name: 'Valve (20 Splines) : COLD',
      price: 20.81,
      currency: 'GBP',
      url: 'https://central-servicesuk.co.uk/valve-20-splines-cold?search=133.',
      lowConfidence: false,
    });
  });
  it('flags cards with multiple distinct prices as low confidence', () => {
    const products = extractListingProducts(html, opts);
    const sale = products.find((p) => p.partNumber === '133.0358.055');
    expect(sale.lowConfidence).toBe(true);
    expect(sale.price).toBe(25.0); // first price in card; flagged for human review
  });
  it('returns empty array when no prefixes match', () => {
    expect(extractListingProducts(html, { ...opts, prefixes: ['999.'] })).toEqual([]);
  });
  it('returns empty array for a no-results page', () => {
    const empty = '<html><body><p>There is no product that matches the search criteria.</p></body></html>';
    expect(extractListingProducts(empty, opts)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/listing.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Write implementation**

How it works: find elements whose own text contains exactly one part number, expand upward to the largest ancestor still containing only that one part number (= the product card), then pull the first price, a name (heading/link text that is neither the part number nor a price), and the product URL from the card.

```js
// src/extract/listing.js
import * as cheerio from 'cheerio';
import { findAllPrices } from './price.js';
import { buildPartNumberRegex } from './partNumber.js';

export function extractListingProducts(html, { prefixes, baseUrl }) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const partRe = buildPartNumberRegex(prefixes);
  const partReG = new RegExp(partRe.source, 'gi');
  const products = [];
  const seen = new Set();

  $('body *').each((_, el) => {
    const $el = $(el);
    const ownText = $el.clone().children().remove().end().text();
    const m = ownText.match(partRe);
    if (!m) return;
    const partNumber = m[0];

    // Expand to the product card: largest ancestor with only this part number.
    let $card = $el;
    while (true) {
      const $parent = $card.parent();
      if (!$parent.length || $parent.is('body,html')) break;
      const distinct = new Set($parent.text().match(partReG) ?? []);
      if (distinct.size > 1) break;
      $card = $parent;
    }

    const prices = findAllPrices($card.text());
    if (prices.length === 0) return;
    const distinctAmounts = new Set(prices.map((p) => p.amount));

    const $name = $card
      .find('h1,h2,h3,h4,a')
      .filter((_, n) => {
        const t = $(n).text().trim();
        return t.length > 2 && !partRe.test(t) && findAllPrices(t).length === 0;
      })
      .first();
    const name = $name.text().trim() || null;

    const href =
      ($name.is('a') ? $name.attr('href') : null) ??
      $name.closest('a').attr('href') ??
      $card.find('a[href]').first().attr('href');
    const url = href ? new URL(href, baseUrl).href : null;

    const key = `${partNumber}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    products.push({
      partNumber,
      name,
      price: prices[0].amount,
      currency: prices[0].currency,
      url,
      lowConfidence: distinctAmounts.size > 1,
    });
  });
  return products;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/listing.test.js`
Expected: PASS. If the card-expansion logic grabs the whole grid, check the `distinct.size > 1` stop condition first.

- [ ] **Step 6: (Optional but recommended) Add a real saved page as a second fixture**

In a browser, save `https://central-servicesuk.co.uk/index.php?route=product/search&search=133.` as `tests/fixtures/central-real-search.html` (HTML only) and add:

```js
// append to tests/listing.test.js — skip cleanly if fixture absent
import { existsSync } from 'node:fs';
const realPath = 'tests/fixtures/central-real-search.html';
describe.skipIf(!existsSync(realPath))('real central-servicesuk page', () => {
  it('extracts at least 10 products with valid prices', () => {
    const real = readFileSync(realPath, 'utf8');
    const products = extractListingProducts(real, opts);
    expect(products.length).toBeGreaterThanOrEqual(10);
    for (const p of products) {
      expect(p.partNumber.startsWith('133.')).toBe(true);
      expect(p.price).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 7: Commit**

```powershell
git add src/extract/listing.js tests/listing.test.js tests/fixtures/
git commit -m "feat: generic listing-page product extractor"
```

---

### Task 6: Proximity extractor (link-crawl mode)

**Files:**
- Create: `src/extract/proximity.js`
- Test: `tests/proximity.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/proximity.test.js
import { describe, it, expect } from 'vitest';
import { extractPairsByProximity } from '../src/extract/proximity.js';

const opts = { prefixes: ['133.'], pageUrl: 'https://example.com/p' };

describe('extractPairsByProximity', () => {
  it('pairs a part number with the nearest price in document order', () => {
    const html = `<html><head><title>Spares</title></head><body>
      <table>
        <tr><td>133.0001.111</td><td>Cold valve</td><td>£10.00</td></tr>
        <tr><td>133.0002.222</td><td>Hot valve</td><td>£12.50</td></tr>
      </table></body></html>`;
    const pairs = extractPairsByProximity(html, opts);
    expect(pairs).toEqual([
      { partNumber: '133.0001.111', name: 'Spares', price: 10.0, currency: 'GBP',
        url: 'https://example.com/p', lowConfidence: false },
      { partNumber: '133.0002.222', name: 'Spares', price: 12.5, currency: 'GBP',
        url: 'https://example.com/p', lowConfidence: false },
    ]);
  });
  it('flags low confidence when two prices are equally near', () => {
    const html = `<html><head><title>T</title></head><body>
      <span>£9.99</span><span>133.0003.333</span><span>£11.99</span></body></html>`;
    const [pair] = extractPairsByProximity(html, opts);
    expect(pair.lowConfidence).toBe(true);
  });
  it('returns empty for pages with parts but no prices', () => {
    const html = '<html><head><title>T</title></head><body><p>133.0004.444</p></body></html>';
    expect(extractPairsByProximity(html, opts)).toEqual([]);
  });
  it('ignores scripts and styles', () => {
    const html = `<html><head><title>T</title></head><body>
      <script>var x = "133.9999.999 £1.00";</script></body></html>`;
    expect(extractPairsByProximity(html, opts)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proximity.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```js
// src/extract/proximity.js
import * as cheerio from 'cheerio';
import { findAllPrices } from './price.js';
import { buildPartNumberRegex } from './partNumber.js';

// Walks text nodes in document order, records part-number and price tokens
// with their position, then pairs each part with its nearest price.
export function extractPairsByProximity(html, { prefixes, pageUrl }) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const title = $('title').text().trim() || null;
  const partReG = new RegExp(buildPartNumberRegex(prefixes).source, 'gi');

  const parts = [];
  const prices = [];
  let pos = 0;
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.type === 'text') {
        const text = child.data;
        pos += 1;
        for (const m of text.match(partReG) ?? []) parts.push({ value: m, pos });
        for (const p of findAllPrices(text)) prices.push({ ...p, pos });
      } else {
        walk(child);
      }
    }
  };
  walk($('body')[0] ?? { childNodes: [] });

  if (prices.length === 0) return [];
  return parts.map(({ value, pos: partPos }) => {
    const byDistance = [...prices].sort(
      (a, b) => Math.abs(a.pos - partPos) - Math.abs(b.pos - partPos)
    );
    const nearest = byDistance[0];
    const second = byDistance[1];
    const lowConfidence =
      second != null &&
      Math.abs(second.pos - partPos) - Math.abs(nearest.pos - partPos) <= 1 &&
      second.amount !== nearest.amount;
    return {
      partNumber: value,
      name: title,
      price: nearest.amount,
      currency: nearest.currency,
      url: pageUrl,
      lowConfidence,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proximity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/extract/proximity.js tests/proximity.test.js
git commit -m "feat: proximity-based part/price extractor for link-crawl mode"
```

---

### Task 7: Database layer

**Files:**
- Create: `src/db.js`
- Test: `tests/db.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/db.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb, listSites, createSite, updateSite, deleteSite,
  createRun, finishRun, saveRunSiteSummary, listRuns,
  insertObservations, latestSnapshot, fullHistory,
  replaceMyParts, missingMyParts,
} from '../src/db.js';

let db;
beforeEach(() => { db = openDb(':memory:'); });

const SITE = {
  name: 'Central Services', base_url: 'https://central-servicesuk.co.uk/',
  strategy: 'prefix_search',
  search_url_pattern: 'index.php?route=product/search&search={query}&page={page}',
  prefixes: ['133.', '112.'], login_url: null, username: null, password: null,
  enabled: 1, max_pages: 200,
};

describe('sites CRUD', () => {
  it('creates, lists, updates, deletes', () => {
    const id = createSite(db, SITE);
    expect(listSites(db)).toHaveLength(1);
    expect(listSites(db)[0].prefixes).toEqual(['133.', '112.']);
    updateSite(db, id, { ...SITE, name: 'CS', enabled: 0 });
    expect(listSites(db)[0].name).toBe('CS');
    deleteSite(db, id);
    expect(listSites(db)).toHaveLength(0);
  });
});

describe('runs and observations', () => {
  it('stores observations and derives latest snapshot with previous price', () => {
    const siteId = createSite(db, SITE);
    const run1 = createRun(db);
    insertObservations(db, run1, siteId, [
      { partNumber: '133.0440.351', name: 'Valve', price: 20.81, currency: 'GBP',
        url: 'https://x/1', lowConfidence: false },
    ]);
    saveRunSiteSummary(db, run1, siteId, { pagesVisited: 3, partsFound: 1, pagesFailed: 0, warnings: [] });
    finishRun(db, run1, 'done');

    const run2 = createRun(db);
    insertObservations(db, run2, siteId, [
      { partNumber: '133.0440.351', name: 'Valve', price: 22.0, currency: 'GBP',
        url: 'https://x/1', lowConfidence: false },
    ]);
    finishRun(db, run2, 'done');

    const snap = latestSnapshot(db);
    expect(snap).toHaveLength(1);
    expect(snap[0].price).toBe(22.0);
    expect(snap[0].prev_price).toBe(20.81);
    expect(snap[0].site_name).toBe('Central Services');
    expect(fullHistory(db)).toHaveLength(2);
    expect(listRuns(db)[0].status).toBe('done');
  });

  it('normalises part numbers for snapshot identity', () => {
    const siteId = createSite(db, SITE);
    const run1 = createRun(db);
    insertObservations(db, run1, siteId, [
      { partNumber: '133.0440-351', name: 'V', price: 1, currency: 'GBP', url: 'u', lowConfidence: false },
      { partNumber: '133.0440 351', name: 'V', price: 2, currency: 'GBP', url: 'u', lowConfidence: false },
    ]);
    expect(latestSnapshot(db)).toHaveLength(1);
  });
});

describe('my parts list', () => {
  it('flags snapshot rows in my list and reports missing parts', () => {
    const siteId = createSite(db, SITE);
    const run = createRun(db);
    insertObservations(db, run, siteId, [
      { partNumber: '133.0440.351', name: 'V', price: 1, currency: 'GBP', url: 'u', lowConfidence: false },
    ]);
    replaceMyParts(db, [{ partNumber: '133.0440.351' }, { partNumber: '112.9999.000' }]);
    const snap = latestSnapshot(db);
    expect(snap[0].in_my_list).toBe(1);
    expect(missingMyParts(db)).toEqual([{ part_number: '112.9999.000' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```js
// src/db.js
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalisePartNumber } from './extract/partNumber.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('prefix_search','link_crawl')),
  search_url_pattern TEXT,
  prefixes TEXT NOT NULL DEFAULT '[]',
  login_url TEXT, username TEXT, password TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_pages INTEGER NOT NULL DEFAULT 200
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS run_sites (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  pages_visited INTEGER NOT NULL DEFAULT 0,
  parts_found INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, site_id)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  part_number TEXT NOT NULL,
  part_number_norm TEXT NOT NULL,
  name TEXT,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  url TEXT,
  low_confidence INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_obs ON observations(site_id, part_number_norm, id);
CREATE TABLE IF NOT EXISTS my_parts (
  part_number TEXT PRIMARY KEY,
  part_number_norm TEXT NOT NULL
);
`;

export function openDb(path = 'data/scraper.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// --- sites ---
const siteFromRow = (r) => ({ ...r, prefixes: JSON.parse(r.prefixes) });

export function listSites(db) {
  return db.prepare('SELECT * FROM sites ORDER BY id').all().map(siteFromRow);
}
export function getSite(db, id) {
  const row = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return row ? siteFromRow(row) : null;
}
export function createSite(db, s) {
  const info = db.prepare(`
    INSERT INTO sites (name, base_url, strategy, search_url_pattern, prefixes,
                       login_url, username, password, enabled, max_pages)
    VALUES (@name, @base_url, @strategy, @search_url_pattern, @prefixes,
            @login_url, @username, @password, @enabled, @max_pages)
  `).run({ ...s, prefixes: JSON.stringify(s.prefixes ?? []) });
  return info.lastInsertRowid;
}
export function updateSite(db, id, s) {
  db.prepare(`
    UPDATE sites SET name=@name, base_url=@base_url, strategy=@strategy,
      search_url_pattern=@search_url_pattern, prefixes=@prefixes, login_url=@login_url,
      username=@username, password=@password, enabled=@enabled, max_pages=@max_pages
    WHERE id=@id
  `).run({ ...s, id, prefixes: JSON.stringify(s.prefixes ?? []) });
}
export function deleteSite(db, id) {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

// --- runs ---
export function createRun(db) {
  return db.prepare('INSERT INTO runs DEFAULT VALUES').run().lastInsertRowid;
}
export function finishRun(db, runId, status) {
  db.prepare("UPDATE runs SET finished_at = datetime('now'), status = ? WHERE id = ?")
    .run(status, runId);
}
export function listRuns(db) {
  return db.prepare(`
    SELECT r.*,
      (SELECT json_group_array(json_object(
         'site_id', rs.site_id, 'pages_visited', rs.pages_visited,
         'parts_found', rs.parts_found, 'pages_failed', rs.pages_failed,
         'warnings', json(rs.warnings)))
       FROM run_sites rs WHERE rs.run_id = r.id) AS site_summaries
    FROM runs r ORDER BY r.id DESC
  `).all().map((r) => ({ ...r, site_summaries: JSON.parse(r.site_summaries ?? '[]') }));
}
export function saveRunSiteSummary(db, runId, siteId, { pagesVisited, partsFound, pagesFailed, warnings }) {
  db.prepare(`
    INSERT OR REPLACE INTO run_sites (run_id, site_id, pages_visited, parts_found, pages_failed, warnings)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, siteId, pagesVisited, partsFound, pagesFailed, JSON.stringify(warnings ?? []));
}

// --- observations ---
export function insertObservations(db, runId, siteId, products) {
  const stmt = db.prepare(`
    INSERT INTO observations (run_id, site_id, part_number, part_number_norm, name,
                              price, currency, url, low_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((rows) => {
    for (const p of rows) {
      stmt.run(runId, siteId, p.partNumber, normalisePartNumber(p.partNumber),
        p.name, p.price, p.currency, p.url, p.lowConfidence ? 1 : 0);
    }
  });
  insertAll(products);
}

export function latestSnapshot(db) {
  return db.prepare(`
    WITH ranked AS (
      SELECT o.*, ROW_NUMBER() OVER (
        PARTITION BY o.site_id, o.part_number_norm ORDER BY o.id DESC) AS rn
      FROM observations o
    )
    SELECT cur.part_number, cur.part_number_norm, cur.name, cur.price, cur.currency,
           cur.url, cur.low_confidence, cur.observed_at, cur.site_id,
           s.name AS site_name, prev.price AS prev_price,
           EXISTS(SELECT 1 FROM my_parts mp WHERE mp.part_number_norm = cur.part_number_norm) AS in_my_list
    FROM ranked cur
    JOIN sites s ON s.id = cur.site_id
    LEFT JOIN ranked prev ON prev.site_id = cur.site_id
      AND prev.part_number_norm = cur.part_number_norm AND prev.rn = 2
    WHERE cur.rn = 1
    ORDER BY cur.part_number
  `).all();
}

export function fullHistory(db) {
  return db.prepare(`
    SELECT o.part_number, o.name, o.price, o.currency, o.url, o.low_confidence,
           o.observed_at, o.run_id, s.name AS site_name
    FROM observations o JOIN sites s ON s.id = o.site_id ORDER BY o.id
  `).all();
}

// --- my parts ---
export function replaceMyParts(db, parts) {
  const replaceAll = db.transaction((rows) => {
    db.prepare('DELETE FROM my_parts').run();
    const stmt = db.prepare('INSERT OR IGNORE INTO my_parts (part_number, part_number_norm) VALUES (?, ?)');
    for (const p of rows) stmt.run(p.partNumber, normalisePartNumber(p.partNumber));
  });
  replaceAll(parts);
}
export function missingMyParts(db) {
  return db.prepare(`
    SELECT mp.part_number FROM my_parts mp
    WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.part_number_norm = mp.part_number_norm)
    ORDER BY mp.part_number
  `).all();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/db.js tests/db.test.js
git commit -m "feat: sqlite layer with sites, runs, observations, my-parts"
```

---

### Task 8: CSV and xlsx export

**Files:**
- Create: `src/export/csv.js`, `src/export/xlsx.js`
- Test: `tests/export.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/export.test.js
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { rowsToCsv } from '../src/export/csv.js';
import { rowsToXlsxBuffer } from '../src/export/xlsx.js';

const columns = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
];
const rows = [
  { part_number: '133.0440.351', name: 'Valve, "COLD" 20mm', price: 20.81 },
  { part_number: '133.0049.669', name: null, price: 17.63 },
];

describe('rowsToCsv', () => {
  it('emits header row and escapes quotes/commas', () => {
    const csv = rowsToCsv(rows, columns);
    expect(csv.split('\r\n')[0]).toBe('Part Number,Name,Price');
    expect(csv).toContain('"Valve, ""COLD"" 20mm"');
    expect(csv.split('\r\n')[2]).toBe('133.0049.669,,17.63');
  });
});

describe('rowsToXlsxBuffer', () => {
  it('produces a workbook with header and data rows', async () => {
    const buf = await rowsToXlsxBuffer(rows, columns);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Part Number');
    expect(ws.getCell('A2').value).toBe('133.0440.351');
    expect(ws.getCell('C3').value).toBe(17.63);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/export.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write implementations**

```js
// src/export/csv.js
function escapeCell(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function rowsToCsv(rows, columns) {
  const lines = [columns.map((c) => escapeCell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c.key])).join(','));
  }
  return lines.join('\r\n');
}
```

```js
// src/export/xlsx.js
import ExcelJS from 'exceljs';

export async function rowsToXlsxBuffer(rows, columns) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prices');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 24 }));
  for (const row of rows) ws.addRow(row);
  return wb.xlsx.writeBuffer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/export/ tests/export.test.js
git commit -m "feat: csv and xlsx export"
```

---

### Task 9: Crawl strategies and run orchestrator

**Files:**
- Create: `src/crawler/login.js`, `src/crawler/prefixSearch.js`, `src/crawler/linkCrawl.js`, `src/crawler/run.js`
- Test: `tests/run.test.js` (orchestrator only — strategies are exercised by the Task 12 smoke test; their page-parsing logic is already covered by Tasks 5–6)

- [ ] **Step 1: Write the failing orchestrator test**

```js
// tests/run.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, createSite, listRuns, latestSnapshot } from '../src/db.js';
import { executeRun } from '../src/crawler/run.js';

let db;
const SITE = {
  name: 'A', base_url: 'https://a.example/', strategy: 'prefix_search',
  search_url_pattern: 's?q={query}&p={page}', prefixes: ['133.'],
  login_url: null, username: null, password: null, enabled: 1, max_pages: 10,
};
beforeEach(() => { db = openDb(':memory:'); });

const product = { partNumber: '133.1', name: 'V', price: 9.99, currency: 'GBP', url: 'u', lowConfidence: false };

describe('executeRun', () => {
  it('crawls all enabled sites, stores observations and summaries', async () => {
    createSite(db, SITE);
    createSite(db, { ...SITE, name: 'B', enabled: 0 }); // disabled: skipped
    const crawled = [];
    const fakeCrawlSite = async (site) => {
      crawled.push(site.name);
      return { products: [product], stats: { pagesVisited: 2, pagesFailed: 0, warnings: [] } };
    };
    const runId = await executeRun(db, { crawlSite: fakeCrawlSite });
    expect(crawled).toEqual(['A']);
    expect(latestSnapshot(db)).toHaveLength(1);
    const run = listRuns(db).find((r) => r.id === runId);
    expect(run.status).toBe('done');
    expect(run.site_summaries[0].parts_found).toBe(1);
  });

  it('continues past a site that throws and records the failure', async () => {
    createSite(db, SITE);
    createSite(db, { ...SITE, name: 'B' });
    const fakeCrawlSite = async (site) => {
      if (site.name === 'A') throw new Error('login failed');
      return { products: [product], stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] } };
    };
    const runId = await executeRun(db, { crawlSite: fakeCrawlSite });
    const run = listRuns(db).find((r) => r.id === runId);
    expect(run.status).toBe('done');
    const summaryA = run.site_summaries.find((s) => s.warnings.length);
    expect(summaryA.warnings[0]).toContain('login failed');
    expect(latestSnapshot(db)).toHaveLength(1); // site B's data still saved
  });

  it('reports progress through onProgress', async () => {
    createSite(db, SITE);
    const events = [];
    await executeRun(db, {
      crawlSite: async () => ({ products: [], stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] } }),
      onProgress: (e) => events.push(e),
    });
    expect(events.some((e) => e.siteName === 'A')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the orchestrator**

```js
// src/crawler/run.js
import { listSites, createRun, finishRun, insertObservations, saveRunSiteSummary } from '../db.js';
import { crawlPrefixSearch } from './prefixSearch.js';
import { crawlLinkCrawl } from './linkCrawl.js';
import { loginAndGetCookies } from './login.js';

async function defaultCrawlSite(site, { onProgress }) {
  let cookies = null;
  if (site.login_url && site.username) {
    cookies = await loginAndGetCookies(site);
  }
  const crawl = site.strategy === 'prefix_search' ? crawlPrefixSearch : crawlLinkCrawl;
  return crawl(site, { cookies, onProgress });
}

export async function executeRun(db, { crawlSite = defaultCrawlSite, onProgress = () => {} } = {}) {
  const runId = createRun(db);
  const sites = listSites(db).filter((s) => s.enabled);
  for (const site of sites) {
    onProgress({ runId, siteName: site.name, phase: 'start' });
    try {
      const { products, stats } = await crawlSite(site, {
        onProgress: (p) => onProgress({ runId, siteName: site.name, phase: 'crawling', ...p }),
      });
      insertObservations(db, runId, site.id, products);
      saveRunSiteSummary(db, runId, site.id, {
        pagesVisited: stats.pagesVisited, partsFound: products.length,
        pagesFailed: stats.pagesFailed, warnings: stats.warnings,
      });
      onProgress({ runId, siteName: site.name, phase: 'done', partsFound: products.length });
    } catch (err) {
      saveRunSiteSummary(db, runId, site.id, {
        pagesVisited: 0, partsFound: 0, pagesFailed: 0,
        warnings: [`Site failed: ${err.message}`],
      });
      onProgress({ runId, siteName: site.name, phase: 'failed', error: err.message });
    }
  }
  finishRun(db, runId, 'done');
  return runId;
}
```

- [ ] **Step 4: Write the login helper**

Heuristic login: fill the first username/email field and first password field on the login page, submit, return session cookies. Sites where this fails will surface as a warning on the run (and we add a per-site fix then — YAGNI until a real site needs it).

```js
// src/crawler/login.js
import { chromium } from 'playwright';

export async function loginAndGetCookies(site) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(site.login_url, { waitUntil: 'domcontentloaded' });
    await page
      .locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[type="text"]')
      .first().fill(site.username);
    await page.locator('input[type="password"]').first().fill(site.password);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const cookies = await page.context().cookies();
    if (!cookies.length) throw new Error('Login produced no session cookies');
    return cookies;
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 5: Write the prefix-search strategy**

```js
// src/crawler/prefixSearch.js
import { PlaywrightCrawler } from 'crawlee';
import { extractListingProducts } from '../extract/listing.js';
import { buildSearchUrl } from '../extract/pagination.js';

export async function crawlPrefixSearch(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seenUrls = new Set();

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
  });

  await crawler.run(site.prefixes.map((prefix) => ({
    url: buildSearchUrl(site.search_url_pattern, site.base_url, prefix, 1),
    userData: { prefix, pageNo: 1 },
    uniqueKey: `${site.id}:${prefix}:1`,
  })));
  return { products, stats };
}
```

- [ ] **Step 6: Write the link-crawl strategy**

```js
// src/crawler/linkCrawl.js
import { PlaywrightCrawler } from 'crawlee';
import { extractPairsByProximity } from '../extract/proximity.js';

export async function crawlLinkCrawl(site, { cookies = null, onProgress = () => {} } = {}) {
  const products = [];
  const stats = { pagesVisited: 0, pagesFailed: 0, warnings: [] };
  const seen = new Set();

  const crawler = new PlaywrightCrawler({
    maxConcurrency: 2,
    maxRequestRetries: 2,
    respectRobotsTxtFile: true,
    maxRequestsPerCrawl: site.max_pages,
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
    failedRequestHandler: ({ request }) => {
      stats.pagesFailed += 1;
      stats.warnings.push(`Page failed: ${request.url}`);
    },
  });

  await crawler.run([site.base_url]);
  return { products, stats };
}
```

- [ ] **Step 7: Run orchestrator test**

Run: `npx vitest run tests/run.test.js`
Expected: PASS (the fake `crawlSite` means no browser launches in tests).

- [ ] **Step 8: Run full suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/crawler/ tests/run.test.js
git commit -m "feat: crawl strategies, login helper, run orchestrator"
```

---

### Task 10: Express API

**Files:**
- Create: `src/server/app.js`, `src/index.js`
- Test: `tests/app.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/app.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb, createSite, createRun, insertObservations, finishRun } from '../src/db.js';
import { createApp } from '../src/server/app.js';

let db, app, fakeRun;
const SITE = {
  name: 'A', base_url: 'https://a.example/', strategy: 'prefix_search',
  search_url_pattern: 's?q={query}&p={page}', prefixes: ['133.'],
  login_url: null, username: null, password: null, enabled: 1, max_pages: 10,
};

beforeEach(() => {
  db = openDb(':memory:');
  fakeRun = async (database, opts) => {
    const { executeRun } = await import('../src/crawler/run.js');
    return executeRun(database, {
      ...opts,
      crawlSite: async () => ({
        products: [{ partNumber: '133.1', name: 'V', price: 5, currency: 'GBP', url: 'u', lowConfidence: false }],
        stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] },
      }),
    });
  };
  app = createApp(db, { runExecutor: fakeRun });
});

describe('sites API', () => {
  it('POST/GET/PUT/DELETE /api/sites', async () => {
    const created = await request(app).post('/api/sites').send(SITE).expect(201);
    expect(created.body.id).toBeDefined();
    const list = await request(app).get('/api/sites').expect(200);
    expect(list.body).toHaveLength(1);
    await request(app).put(`/api/sites/${created.body.id}`).send({ ...SITE, name: 'B' }).expect(200);
    await request(app).delete(`/api/sites/${created.body.id}`).expect(204);
  });
  it('rejects invalid strategy', async () => {
    await request(app).post('/api/sites').send({ ...SITE, strategy: 'nope' }).expect(400);
  });
});

describe('runs API', () => {
  it('POST /api/runs starts a run and progress is queryable', async () => {
    createSite(db, SITE);
    const started = await request(app).post('/api/runs').expect(202);
    expect(started.body.runId).toBeDefined();
    // wait for the in-process run to finish
    await new Promise((r) => setTimeout(r, 100));
    const status = await request(app).get('/api/runs/current').expect(200);
    expect(status.body.running).toBe(false);
    const runs = await request(app).get('/api/runs').expect(200);
    expect(runs.body[0].status).toBe('done');
  });
  it('rejects a second run while one is in progress', async () => {
    createSite(db, SITE);
    app = createApp(db, { runExecutor: () => new Promise(() => {}) }); // never resolves
    await request(app).post('/api/runs').expect(202);
    await request(app).post('/api/runs').expect(409);
  });
});

describe('results API', () => {
  beforeEach(() => {
    const siteId = createSite(db, SITE);
    const runId = createRun(db);
    insertObservations(db, runId, siteId, [
      { partNumber: '133.1', name: 'V', price: 5, currency: 'GBP', url: 'u', lowConfidence: false },
    ]);
    finishRun(db, runId, 'done');
  });
  it('GET /api/results returns the snapshot', async () => {
    const res = await request(app).get('/api/results').expect(200);
    expect(res.body[0].part_number).toBe('133.1');
  });
  it('GET /api/export/latest.csv downloads csv', async () => {
    const res = await request(app).get('/api/export/latest.csv').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('133.1');
  });
  it('GET /api/export/latest.xlsx downloads workbook', async () => {
    const res = await request(app).get('/api/export/latest.xlsx').expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
  it('GET /api/export/history.csv downloads history', async () => {
    const res = await request(app).get('/api/export/history.csv').expect(200);
    expect(res.text).toContain('133.1');
  });
});

describe('my parts API', () => {
  beforeEach(() => {
    // an observation must exist so 133.1 counts as "found"
    const siteId = createSite(db, SITE);
    const runId = createRun(db);
    insertObservations(db, runId, siteId, [
      { partNumber: '133.1', name: 'V', price: 5, currency: 'GBP', url: 'u', lowConfidence: false },
    ]);
    finishRun(db, runId, 'done');
  });
  it('uploads a csv parts list and reports missing parts', async () => {
    const csv = 'Part Number\n133.1\n112.9\n';
    await request(app)
      .post('/api/parts')
      .attach('file', Buffer.from(csv), 'parts.csv')
      .expect(200);
    const missing = await request(app).get('/api/parts/missing').expect(200);
    expect(missing.body).toEqual([{ part_number: '112.9' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the Express app**

```js
// src/server/app.js
import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  listSites, createSite, updateSite, deleteSite, getSite,
  listRuns, latestSnapshot, fullHistory, replaceMyParts, missingMyParts,
} from '../db.js';
import { executeRun } from '../crawler/run.js';
import { rowsToCsv } from '../export/csv.js';
import { rowsToXlsxBuffer } from '../export/xlsx.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SNAPSHOT_COLUMNS = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
  { key: 'currency', header: 'Currency' },
  { key: 'prev_price', header: 'Previous Price' },
  { key: 'site_name', header: 'Site' },
  { key: 'url', header: 'URL' },
  { key: 'in_my_list', header: 'In My List' },
  { key: 'low_confidence', header: 'Low Confidence' },
  { key: 'observed_at', header: 'Last Seen (UTC)' },
];
const HISTORY_COLUMNS = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
  { key: 'currency', header: 'Currency' },
  { key: 'site_name', header: 'Site' },
  { key: 'url', header: 'URL' },
  { key: 'run_id', header: 'Run' },
  { key: 'observed_at', header: 'Observed (UTC)' },
];

function validateSite(body) {
  if (!body.name || !body.base_url) return 'name and base_url are required';
  if (!['prefix_search', 'link_crawl'].includes(body.strategy)) return 'invalid strategy';
  if (body.strategy === 'prefix_search' && !body.search_url_pattern)
    return 'search_url_pattern required for prefix_search';
  return null;
}

async function parsePartsUpload(file) {
  let rows;
  if (file.originalname.toLowerCase().endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    rows = [];
    wb.worksheets[0].eachRow((row) => rows.push(row.values.slice(1).map((v) => String(v ?? ''))));
  } else {
    rows = parse(file.buffer.toString('utf8'), { skip_empty_lines: true });
  }
  if (rows.length === 0) return [];
  // Pick the part-number column: header containing "part", else first column.
  const header = rows[0].map((h) => String(h).toLowerCase());
  let col = header.findIndex((h) => h.includes('part'));
  const dataRows = col >= 0 ? rows.slice(1) : rows;
  if (col < 0) col = 0;
  return dataRows
    .map((r) => String(r[col] ?? '').trim())
    .filter(Boolean)
    .map((partNumber) => ({ partNumber }));
}

export function createApp(db, { runExecutor = executeRun } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // in-memory state for the current run
  const current = { running: false, runId: null, events: [] };

  // --- sites ---
  app.get('/api/sites', (req, res) => res.json(listSites(db)));
  app.post('/api/sites', (req, res) => {
    const err = validateSite(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = createSite(db, { enabled: 1, max_pages: 200, prefixes: [], ...req.body });
    res.status(201).json(getSite(db, id));
  });
  app.put('/api/sites/:id', (req, res) => {
    const err = validateSite(req.body);
    if (err) return res.status(400).json({ error: err });
    updateSite(db, Number(req.params.id), { enabled: 1, max_pages: 200, prefixes: [], ...req.body });
    res.json(getSite(db, Number(req.params.id)));
  });
  app.delete('/api/sites/:id', (req, res) => {
    deleteSite(db, Number(req.params.id));
    res.status(204).end();
  });

  // --- runs ---
  app.post('/api/runs', (req, res) => {
    if (current.running) return res.status(409).json({ error: 'A run is already in progress' });
    current.running = true;
    current.events = [];
    const promise = runExecutor(db, { onProgress: (e) => current.events.push(e) });
    res.status(202).json({ runId: 'pending' });
    promise
      .then((runId) => { current.runId = runId; })
      .catch((err) => current.events.push({ phase: 'fatal', error: err.message }))
      .finally(() => { current.running = false; });
  });
  app.get('/api/runs/current', (req, res) =>
    res.json({ running: current.running, runId: current.runId, events: current.events.slice(-200) }));
  app.get('/api/runs', (req, res) => res.json(listRuns(db)));

  // --- results & export ---
  app.get('/api/results', (req, res) => res.json(latestSnapshot(db)));
  app.get('/api/export/latest.csv', (req, res) => {
    res.type('text/csv').attachment('latest-prices.csv')
      .send(rowsToCsv(latestSnapshot(db), SNAPSHOT_COLUMNS));
  });
  app.get('/api/export/latest.xlsx', async (req, res) => {
    const buf = await rowsToXlsxBuffer(latestSnapshot(db), SNAPSHOT_COLUMNS);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment('latest-prices.xlsx').send(Buffer.from(buf));
  });
  app.get('/api/export/history.csv', (req, res) => {
    res.type('text/csv').attachment('price-history.csv')
      .send(rowsToCsv(fullHistory(db), HISTORY_COLUMNS));
  });

  // --- my parts ---
  app.post('/api/parts', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const parts = await parsePartsUpload(req.file);
      replaceMyParts(db, parts);
      res.json({ count: parts.length });
    } catch (err) {
      res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }
  });
  app.get('/api/parts/missing', (req, res) => res.json(missingMyParts(db)));

  return app;
}
```

```js
// src/index.js
import { openDb } from './db.js';
import { createApp } from './server/app.js';

const db = openDb();
const app = createApp(db);
const port = 3000;
app.listen(port, () => {
  console.log(`Price scraper dashboard: http://localhost:${port}`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/app.test.js`
Expected: PASS. (The 100ms wait in the runs test covers the in-process fake run; if flaky, raise to 300ms.)

- [ ] **Step 5: Commit**

```powershell
git add src/server/app.js src/index.js tests/app.test.js
git commit -m "feat: express api for sites, runs, results, export, parts upload"
```

---

### Task 11: Dashboard UI

**Files:**
- Create: `src/server/public/index.html`, `src/server/public/app.js`, `src/server/public/style.css`

No automated tests — the API is already covered; this is verified manually in Step 4.

- [ ] **Step 1: Create `index.html`**

```html
<!-- src/server/public/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Price Scraper</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <h1>Price Scraper</h1>
    <nav>
      <button data-tab="sites" class="active">Sites</button>
      <button data-tab="run">Run</button>
      <button data-tab="results">Results</button>
    </nav>
  </header>

  <main>
    <section id="tab-sites">
      <h2>Sites</h2>
      <table id="sites-table">
        <thead><tr><th>On</th><th>Name</th><th>Strategy</th><th>Prefixes</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
      <h3 id="site-form-title">Add site</h3>
      <form id="site-form">
        <input type="hidden" name="site_id">
        <label>Name <input name="name" required></label>
        <label>Base URL <input name="base_url" type="url" required placeholder="https://example.co.uk/"></label>
        <label>Strategy
          <select name="strategy">
            <option value="prefix_search">Prefix search</option>
            <option value="link_crawl">Crawl all links</option>
          </select>
        </label>
        <label>Search URL pattern
          <input name="search_url_pattern" placeholder="index.php?route=product/search&amp;search={query}&amp;page={page}">
        </label>
        <label>Prefixes (comma separated) <input name="prefixes" placeholder="112., 113., 133."></label>
        <label>Max pages <input name="max_pages" type="number" value="200"></label>
        <fieldset>
          <legend>Dealer login (optional)</legend>
          <label>Login URL <input name="login_url"></label>
          <label>Username <input name="username" autocomplete="off"></label>
          <label>Password <input name="password" type="password" autocomplete="off"></label>
        </fieldset>
        <label><input type="checkbox" name="enabled" checked> Enabled</label>
        <button type="submit">Save site</button>
        <button type="button" id="site-form-reset">Clear</button>
      </form>
    </section>

    <section id="tab-run" hidden>
      <h2>Run</h2>
      <button id="run-button">▶ Run now</button>
      <pre id="run-log"></pre>
      <h3>Past runs</h3>
      <table id="runs-table">
        <thead><tr><th>Run</th><th>Started</th><th>Status</th><th>Summary</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section id="tab-results" hidden>
      <h2>Results</h2>
      <div class="toolbar">
        <input id="results-filter" placeholder="Filter by part number or name...">
        <a href="/api/export/latest.csv">Export CSV</a>
        <a href="/api/export/latest.xlsx">Export Excel</a>
        <a href="/api/export/history.csv">Export full history</a>
        <label class="upload">Upload my parts list
          <input type="file" id="parts-file" accept=".csv,.xlsx" hidden>
        </label>
      </div>
      <p id="parts-status"></p>
      <table id="results-table">
        <thead><tr>
          <th>Part Number</th><th>Name</th><th>Price</th><th>Change</th>
          <th>Site</th><th>Mine</th><th>Last seen</th>
        </tr></thead>
        <tbody></tbody>
      </table>
      <details id="missing-parts"><summary>My parts not found on any site</summary><ul></ul></details>
    </section>
  </main>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `app.js`**

```js
// src/server/public/app.js
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.status === 204 ? null : res.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- tabs ---
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('main section').forEach((s) => (s.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
    if (btn.dataset.tab === 'results') loadResults();
    if (btn.dataset.tab === 'run') loadRuns();
    if (btn.dataset.tab === 'sites') loadSites();
  });
});

// --- sites ---
async function loadSites() {
  const sites = await api('/api/sites');
  $('#sites-table tbody').innerHTML = sites.map((s) => `
    <tr>
      <td>${s.enabled ? '✅' : '⬜'}</td>
      <td>${esc(s.name)}</td>
      <td>${s.strategy === 'prefix_search' ? 'Prefix search' : 'Link crawl'}</td>
      <td>${esc(s.prefixes.join(', '))}</td>
      <td>
        <button data-edit="${s.id}">Edit</button>
        <button data-del="${s.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('#sites-table tbody').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => fillForm(sites.find((s) => s.id === Number(b.dataset.edit)))));
  $('#sites-table tbody').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('Delete this site?')) { await api(`/api/sites/${b.dataset.del}`, { method: 'DELETE' }); loadSites(); }
    }));
}

// NOTE: always go through form.elements — `form.name` and `form.id` are
// built-in HTMLFormElement properties and shadow inputs with those names.
function fillForm(s) {
  const el = $('#site-form').elements;
  $('#site-form-title').textContent = `Edit: ${s.name}`;
  el.site_id.value = s.id; el.name.value = s.name; el.base_url.value = s.base_url;
  el.strategy.value = s.strategy; el.search_url_pattern.value = s.search_url_pattern ?? '';
  el.prefixes.value = s.prefixes.join(', '); el.max_pages.value = s.max_pages;
  el.login_url.value = s.login_url ?? ''; el.username.value = s.username ?? '';
  el.password.value = s.password ?? ''; el.enabled.checked = !!s.enabled;
}

$('#site-form-reset').addEventListener('click', () => {
  $('#site-form').reset(); $('#site-form').elements.site_id.value = '';
  $('#site-form-title').textContent = 'Add site';
});

$('#site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = e.target.elements;
  const body = {
    name: el.name.value, base_url: el.base_url.value, strategy: el.strategy.value,
    search_url_pattern: el.search_url_pattern.value || null,
    prefixes: el.prefixes.value.split(',').map((p) => p.trim()).filter(Boolean),
    max_pages: Number(el.max_pages.value) || 200,
    login_url: el.login_url.value || null, username: el.username.value || null,
    password: el.password.value || null, enabled: el.enabled.checked ? 1 : 0,
  };
  try {
    if (el.site_id.value) await api(`/api/sites/${el.site_id.value}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/api/sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#site-form-reset').click();
    loadSites();
  } catch (err) { alert(err.message); }
});

// --- run ---
let pollTimer = null;
$('#run-button').addEventListener('click', async () => {
  try {
    await api('/api/runs', { method: 'POST' });
    $('#run-log').textContent = 'Run started...\n';
    pollTimer = setInterval(pollRun, 1000);
  } catch (err) { alert(err.message); }
});

async function pollRun() {
  const cur = await api('/api/runs/current');
  $('#run-log').textContent = cur.events.map((e) =>
    e.phase === 'crawling'
      ? `[${e.siteName}] pages: ${e.pagesVisited}, parts: ${e.partsFound}`
      : `[${e.siteName ?? 'run'}] ${e.phase}${e.error ? ': ' + e.error : ''}${e.partsFound != null ? ` (${e.partsFound} parts)` : ''}`
  ).join('\n');
  if (!cur.running) { clearInterval(pollTimer); $('#run-log').textContent += '\nFinished.'; loadRuns(); }
}

async function loadRuns() {
  const runs = await api('/api/runs');
  $('#runs-table tbody').innerHTML = runs.map((r) => `
    <tr><td>#${r.id}</td><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td>
    <td>${r.site_summaries.map((s) =>
      `site ${s.site_id}: ${s.parts_found} parts, ${s.pages_visited} pages` +
      (s.pages_failed ? `, ${s.pages_failed} failed` : '') +
      (s.warnings.length ? ` ⚠ ${esc(s.warnings.join('; '))}` : '')).join('<br>')}</td></tr>`).join('');
}

// --- results ---
let allResults = [];
async function loadResults() {
  allResults = await api('/api/results');
  renderResults();
  const missing = await api('/api/parts/missing');
  $('#missing-parts ul').innerHTML = missing.map((m) => `<li>${esc(m.part_number)}</li>`).join('');
  $('#missing-parts summary').textContent = `My parts not found on any site (${missing.length})`;
}

function renderResults() {
  const q = $('#results-filter').value.toLowerCase();
  const rows = allResults.filter((r) =>
    !q || r.part_number.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q));
  $('#results-table tbody').innerHTML = rows.map((r) => {
    const changed = r.prev_price != null && r.prev_price !== r.price;
    return `<tr class="${changed ? 'changed' : ''} ${r.low_confidence ? 'lowconf' : ''}">
      <td><a href="${esc(r.url)}" target="_blank">${esc(r.part_number)}</a></td>
      <td>${esc(r.name)}${r.low_confidence ? ' ⚠' : ''}</td>
      <td>${r.currency === 'GBP' ? '£' : r.currency + ' '}${r.price.toFixed(2)}</td>
      <td>${changed ? `${r.prev_price.toFixed(2)} → ${r.price.toFixed(2)}` : ''}</td>
      <td>${esc(r.site_name)}</td>
      <td>${r.in_my_list ? '✔' : ''}</td>
      <td>${esc(r.observed_at)}</td></tr>`;
  }).join('');
}
$('#results-filter').addEventListener('input', renderResults);

$('#parts-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const out = await api('/api/parts', { method: 'POST', body: form });
    $('#parts-status').textContent = `Parts list uploaded: ${out.count} part numbers.`;
    loadResults();
  } catch (err) { $('#parts-status').textContent = `Upload failed: ${err.message}`; }
});

loadSites();
```

- [ ] **Step 3: Create `style.css`**

```css
/* src/server/public/style.css */
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; color: #1a1a1a; background: #f7f7f8; }
header { display: flex; align-items: center; gap: 2rem; padding: 0.75rem 1.5rem;
  background: #fff; border-bottom: 1px solid #e2e2e6; }
h1 { font-size: 1.2rem; margin: 0; }
nav button { border: none; background: none; padding: 0.6rem 1rem; cursor: pointer;
  font-size: 1rem; border-bottom: 2px solid transparent; }
nav button.active { border-bottom-color: #c0392b; font-weight: 600; }
main { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
table { width: 100%; border-collapse: collapse; background: #fff; margin: 1rem 0; }
th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #ececf0; font-size: 0.9rem; }
tr.changed td { background: #fff8e0; }
tr.lowconf td { background: #fdf0ef; }
form { display: grid; gap: 0.6rem; max-width: 540px; background: #fff; padding: 1rem;
  border: 1px solid #e2e2e6; border-radius: 8px; }
label { display: grid; gap: 0.2rem; font-size: 0.85rem; }
input, select { padding: 0.45rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }
fieldset { border: 1px solid #e2e2e6; border-radius: 6px; display: grid; gap: 0.6rem; }
button { padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #c0392b;
  background: #c0392b; color: #fff; cursor: pointer; }
button[type="button"], td button { background: #fff; color: #c0392b; }
#run-button { font-size: 1.05rem; }
#run-log { background: #16161a; color: #c8e6c9; padding: 1rem; border-radius: 6px;
  min-height: 8rem; max-height: 20rem; overflow: auto; white-space: pre-wrap; }
.toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.toolbar input { flex: 1; min-width: 200px; }
.toolbar a, .upload { font-size: 0.85rem; color: #c0392b; cursor: pointer; text-decoration: underline; }
```

- [ ] **Step 4: Manual verification**

```powershell
npm start
```

Then in a browser at `http://localhost:3000` verify:
1. Sites tab: add the site — Name `Central Services`, Base URL `https://central-servicesuk.co.uk/`, strategy Prefix search, pattern `index.php?route=product/search&search={query}&page={page}`, prefixes `112., 113., 119., 120., 133., 150., 992., 995.`. It appears in the table; Edit and Delete work.
2. Run tab: Run button is present (full run happens in Task 12).
3. Results tab: empty table, export links download (empty) files without errors.

- [ ] **Step 5: Commit**

```powershell
git add src/server/public/
git commit -m "feat: dashboard ui (sites, run, results tabs)"
```

---

### Task 12: End-to-end smoke test against the real site

**Files:**
- Create: `scripts/smoke.mjs`

- [ ] **Step 1: Create the smoke script**

Limited scope on purpose: ONE prefix, max 2 pages, so it finishes in under a minute and is polite to the site.

```js
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
  console.log(`${p.partNumber}  £${p.price}  ${p.name}  ${p.lowConfidence ? '⚠' : ''}`);
}
if (products.length === 0) process.exit(1);
```

- [ ] **Step 2: Run it**

Run: `node scripts/smoke.mjs`
Expected: ~12–24 products printed (12 per page, 2 pages max), each like `133.0440.351  £20.81  Valve (20 Splines) : COLD`, exit code 0. If 0 products: save the page HTML (the optional Step 6 fixture in Task 5) and debug the extractor against it — do NOT hammer the live site in a loop.

- [ ] **Step 3: Full dashboard run**

```powershell
npm start
```

In the dashboard: set Central Services `max_pages` to 5 (temporary, to keep this verification quick), Run tab → Run now. Verify: live progress log updates, run finishes, Results tab shows parts with prices, Export CSV opens in Excel with correct columns.

- [ ] **Step 4: Restore max_pages and commit**

Set the site's `max_pages` back to 200 in the dashboard. Then:

```powershell
git add scripts/smoke.mjs
git commit -m "feat: smoke script for real-site verification"
```

---

## Self-review checklist (run after all tasks)

- `npx vitest run` — all green.
- Spec coverage: prefix search (T9), link crawl (T9/T6), logins (T9), SQLite history (T7), dashboard 3 tabs (T11), CSV/xlsx + history export (T8/T10), parts list upload + missing report (T10), per-site failure isolation (T9), zero-result prefix warning (T9), price-change highlight (T7 prev_price + T11 UI), low-confidence flag (T5/T6).
- Politeness: `respectRobotsTxtFile: true`, `maxConcurrency: 2`, bounded `max_pages` — present in both strategies.
