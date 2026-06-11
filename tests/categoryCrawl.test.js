import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';
import { normaliseCategoryUrl } from '../src/crawler/categoryCrawl.js';
import { openDb, createSite, listSites } from '../src/db.js';

const BASE = 'https://central-servicesuk.co.uk/';

describe('normaliseCategoryUrl', () => {
  it('keeps route/path, forces limit=100, strips sort/order noise', () => {
    expect(normaliseCategoryUrl(
      `${BASE}index.php?route=product/category&path=4_944&sort=p.price&order=DESC&limit=25`, BASE
    )).toBe(`${BASE}index.php?route=product%2Fcategory&path=4_944&limit=100`);
  });
  it('keeps pagination beyond page 1', () => {
    const out = normaliseCategoryUrl(`${BASE}index.php?route=product/category&path=4_944&page=3`, BASE);
    expect(out).toContain('page=3');
    expect(out).toContain('limit=100');
  });
  it('collapses page=1 into the base category url', () => {
    const a = normaliseCategoryUrl(`${BASE}index.php?route=product/category&path=4_944&page=1`, BASE);
    const b = normaliseCategoryUrl(`${BASE}index.php?route=product/category&path=4_944`, BASE);
    expect(a).toBe(b);
  });
  it('returns null for non-category urls', () => {
    expect(normaliseCategoryUrl(`${BASE}index.php?route=product/search&search=133.`, BASE)).toBeNull();
    expect(normaliseCategoryUrl(`${BASE}about-us`, BASE)).toBeNull();
    expect(normaliseCategoryUrl('javascript:void(0)', BASE)).toBeNull();
  });
});

describe('sites strategy migration', () => {
  it('upgrades an old database so category_crawl is accepted', () => {
    const path = join(tmpdir(), `scraper-migrate-test-${process.pid}.db`);
    // build a db with the ORIGINAL schema (no category_crawl in the CHECK)
    const old = new Database(path);
    old.exec(`
      CREATE TABLE sites (
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
      INSERT INTO sites (name, base_url, strategy) VALUES ('Old', 'https://x/', 'prefix_search');
    `);
    old.close();

    const db = openDb(path);
    const id = createSite(db, {
      name: 'Cats', base_url: 'https://y/', strategy: 'category_crawl', prefixes: ['133.'],
    });
    const sites = listSites(db);
    // (openDb also seeds the built-in sites on a file db; assert on the ones we made)
    expect(sites.find((s) => s.id === id).strategy).toBe('category_crawl');
    expect(sites.find((s) => s.name === 'Old').strategy).toBe('prefix_search');
    db.close();
    unlinkSync(path);
  });
});
