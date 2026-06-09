# Shower Parts Price Scraper — Design

**Date:** 2026-06-09
**Status:** Approved by Josh (design conversation, this date)

## Purpose

Josh sells shower parts but manufacturers/suppliers don't provide price lists. This tool
collects prices and part numbers from supplier websites, tracks them over time, and exports
them to spreadsheets — replacing manual browsing of thousands of product pages.

## Requirements

- Many target sites, and the list changes often — adding a site must not require code changes
  for the common case.
- Some sites require dealer login (username/password supplied by Josh, stored locally only).
- Primary outputs: CSV/xlsx export of latest prices, plus price history across runs.
- Optional matching against Josh's own parts list (uploaded CSV/Excel), flagging which scraped
  parts are his and which of his parts were not found.
- Local web dashboard as the interface (not CLI).
- Listing-page data is sufficient: part number, product name, price (inc VAT), product URL.
  Individual product pages are NOT opened during normal runs.

## Stack

| Component | Choice |
|-----------|--------|
| Crawl engine | Crawlee (PlaywrightCrawler) on Node.js |
| Storage | SQLite (single local file) |
| Dashboard | Express + single-page UI at `localhost:3000` |
| Export | CSV and .xlsx |

## Architecture

### Per-site strategies

Each configured site has a **strategy**:

1. **Prefix search** (preferred where the site has a search URL): the crawler hits the site's
   search endpoint once per configured prefix (e.g. `112.`, `113.`, `119.`, `120.`, `133.`,
   `150.`, `992.`, `995.`) and paginates (`&page=2`, `&page=3`, ...) until results run out.
   Part number, name, and price are extracted from each product card on the results pages.
   Example site: `central-servicesuk.co.uk` (OpenCart), search URL pattern
   `index.php?route=product/search&search={query}&page={n}`.
2. **Link crawl** (fallback for sites without usable search): start at the base URL, follow
   internal links on the same domain, and scan each page for part-number/price pairs by
   proximity in the page layout.

Site configuration fields: name, base URL, strategy, search URL pattern, prefix list,
optional login (login URL, username, password), enabled flag.

### Extraction

- Product cards on listing pages are parsed for: part number (product code), product name,
  price, and link URL.
- Part numbers are normalised for comparison (case-insensitive, dashes/spaces ignored) but
  stored as displayed.
- Prices are parsed from common formats (`£20.81`, `$123.45`, `123.45 USD`). Currency symbol
  is stored with the price.
- In link-crawl mode, when multiple prices appear near one part number, the closest is taken
  and the observation is flagged low-confidence for review in the dashboard.

### Logins

For sites with credentials, the crawler performs the login in the Playwright browser session
before crawling and reuses the session cookies for the rest of that site's run. Credentials
live only in the local SQLite file.

### Politeness

Crawlee defaults: robots.txt respected, per-domain rate limiting, retries with backoff,
bounded concurrency.

## Data model (SQLite)

- `sites` — site config as above.
- `runs` — one row per run: started/finished timestamps, per-site summary (pages visited,
  parts found, pages failed).
- `observations` — append-only: run id, site id, part number (raw + normalised), name, price,
  currency, product URL, confidence flag, timestamp. This is the price history.
- `my_parts` — Josh's uploaded parts list (part number raw + normalised, plus any extra
  columns from his file, kept as-is).

"Latest price" views are derived from `observations` (most recent run per site/part), never
by overwriting.

## Dashboard

- **Sites page** — add/edit/toggle sites and their strategy settings and credentials.
- **Run page** — Run button, live progress (pages visited, parts found per site), failure log.
- **Results page** — searchable table of latest data: part number, name, price, site, URL,
  last seen. Price changes since the previous run highlighted with old → new. Optional
  "in my list" column when a parts list is uploaded, and a "my parts not found" report.
- **Export** — CSV / xlsx of the latest snapshot; separate full-history export.

## Error handling

- A failing site, login, or page never aborts the run: the error is logged, surfaced in the
  dashboard, and the run continues.
- Each run stores its summary so an anomalous run (many failures, far fewer parts than usual)
  is distinguishable from genuine price changes.
- Zero results for a prefix that previously returned results is surfaced as a warning
  (likely site change or search pattern breakage).

## Testing

- Extraction logic is unit-tested against saved HTML fixtures of real pages (e.g. the
  central-servicesuk search results and product pages), so site redesigns surface as test
  failures, not silent bad data.
- Pagination termination, price parsing formats, and part-number normalisation each get
  dedicated tests.

## Out of scope (YAGNI)

- Opening individual product pages for Ex VAT price / stock (listing data is sufficient;
  can be added later as a per-site option).
- Scheduling/automatic runs (Josh runs it manually from the dashboard).
- Multi-user access, remote hosting, authentication on the dashboard itself.
