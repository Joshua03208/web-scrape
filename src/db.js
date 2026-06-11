import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalisePartNumber } from './extract/partNumber.js';

const DEFAULT_DB = fileURLToPath(new URL('../data/scraper.db', import.meta.url));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  strategy TEXT NOT NULL,
  search_url_pattern TEXT,
  prefixes TEXT NOT NULL DEFAULT '[]',
  login_url TEXT, username TEXT, password TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_pages INTEGER NOT NULL DEFAULT 200
);
CREATE TABLE IF NOT EXISTS shower_spares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  shower TEXT NOT NULL,
  sku TEXT,
  spare TEXT,
  url TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_spares ON shower_spares(spare);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS run_sites (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  pages_visited INTEGER NOT NULL DEFAULT 0,
  parts_found INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  warnings TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, site_id)
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
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
  part_number_norm TEXT PRIMARY KEY,
  part_number TEXT NOT NULL
);
`;

export function openDb(path = DEFAULT_DB) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateSitesStrategyCheck(db);
  migrateShowerSparesNullable(db);
  // in-memory dbs are for tests — seed only real (file) databases
  if (path !== ':memory:') seedDefaultSites(db);
  return db;
}

// Early databases had a CHECK constraint on sites.strategy, which blocks new
// strategy values. SQLite can't alter a CHECK, so rebuild once WITHOUT it —
// strategy validation lives in the API layer.
function migrateSitesStrategyCheck(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sites'").get();
  if (!row || !row.sql.includes('CHECK (strategy')) return;
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE sites_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      strategy TEXT NOT NULL,
      search_url_pattern TEXT,
      prefixes TEXT NOT NULL DEFAULT '[]',
      login_url TEXT, username TEXT, password TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_pages INTEGER NOT NULL DEFAULT 200
    );
    INSERT INTO sites_migrated SELECT * FROM sites;
    DROP TABLE sites;
    ALTER TABLE sites_migrated RENAME TO sites;
    COMMIT;
  `);
  db.pragma('foreign_keys = ON');
}

// shower_spares.spare was NOT NULL at first; null now means "product has no
// spares published" so those products still show on the Spares tab.
function migrateShowerSparesNullable(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shower_spares'").get();
  if (!row || !row.sql.includes('spare TEXT NOT NULL')) return;
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE shower_spares_migrated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      shower TEXT NOT NULL,
      sku TEXT,
      spare TEXT,
      url TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO shower_spares_migrated SELECT * FROM shower_spares;
    DROP TABLE shower_spares;
    ALTER TABLE shower_spares_migrated RENAME TO shower_spares;
    COMMIT;
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_spares ON shower_spares(spare)');
  db.pragma('foreign_keys = ON');
}

// Built-in sites. Seeded once on a fresh database (and re-added if missing) so
// the known scrapers are always present without manual setup. An existing site
// matching the same host is left untouched, so user tweaks are never overwritten.
const DEFAULT_SITES = [
  {
    name: 'Central Services', base_url: 'https://central-servicesuk.co.uk/',
    strategy: 'prefix_search',
    search_url_pattern: 'index.php?route=product/search&search={query}&page={page}&limit=100',
    prefixes: ['112.', '113.', '119.', '120.', '133.', '150.', '992.', '995.'],
    enabled: 1, max_pages: 200,
    host: 'central-servicesuk.co.uk',
  },
  {
    name: 'Intatec Showers',
    base_url: 'https://www.intatec.co.uk/product-category/plumbing-and-heating/showers/?product_tag=inspiration-showers',
    strategy: 'spares_map', prefixes: [], enabled: 1, max_pages: 80,
    host: 'intatec.co.uk',
  },
];

export function seedDefaultSites(db) {
  const existing = db.prepare('SELECT base_url FROM sites').all().map((r) => r.base_url);
  for (const { host, ...site } of DEFAULT_SITES) {
    if (existing.some((u) => u.includes(host))) continue;
    createSite(db, site);
  }
}

// --- shower spares (spares_map strategy) ---
// Latest mapping only: each successful crawl replaces the site's rows.
export function replaceShowerSpares(db, siteId, rows) {
  const tx = db.transaction((items) => {
    db.prepare('DELETE FROM shower_spares WHERE site_id = ?').run(siteId);
    const stmt = db.prepare(
      'INSERT INTO shower_spares (site_id, shower, sku, spare, url) VALUES (?, ?, ?, ?, ?)');
    for (const r of items) stmt.run(siteId, r.shower, r.sku ?? null, r.spare ?? null, r.url ?? null);
  });
  tx(rows);
}
export function listShowerSpares(db) {
  return db.prepare(`
    SELECT ss.shower, ss.sku, ss.spare, ss.url, ss.observed_at, s.name AS site_name
    FROM shower_spares ss JOIN sites s ON s.id = ss.site_id
    ORDER BY ss.shower, ss.spare
  `).all();
}

// --- sites ---
const siteFromRow = (r) => ({ ...r, prefixes: JSON.parse(r.prefixes) });

const SITE_DEFAULTS = {
  search_url_pattern: null, login_url: null, username: null, password: null,
  enabled: 1, max_pages: 200,
};
function siteParams(s) {
  const merged = { ...SITE_DEFAULTS, ...s };
  return {
    name: merged.name, base_url: merged.base_url, strategy: merged.strategy,
    search_url_pattern: merged.search_url_pattern,
    prefixes: JSON.stringify(merged.prefixes ?? []),
    login_url: merged.login_url, username: merged.username, password: merged.password,
    enabled: merged.enabled ? 1 : 0,
    max_pages: Number(merged.max_pages) || 200,
  };
}

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
  `).run(siteParams(s));
  return info.lastInsertRowid;
}
export function updateSite(db, id, s) {
  db.prepare(`
    UPDATE sites SET name=@name, base_url=@base_url, strategy=@strategy,
      search_url_pattern=@search_url_pattern, prefixes=@prefixes, login_url=@login_url,
      username=@username, password=@password, enabled=@enabled, max_pages=@max_pages
    WHERE id=@id
  `).run({ ...siteParams(s), id });
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
    WITH per_run AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY site_id, part_number_norm, run_id ORDER BY id DESC) AS dup
      FROM observations
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY site_id, part_number_norm ORDER BY run_id DESC, id DESC) AS rn
      FROM per_run WHERE dup = 1
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
    const stmt = db.prepare('INSERT OR IGNORE INTO my_parts (part_number_norm, part_number) VALUES (?, ?)');
    for (const p of rows) stmt.run(normalisePartNumber(p.partNumber), p.partNumber);
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
