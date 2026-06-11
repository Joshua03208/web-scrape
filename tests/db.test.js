import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDb, listSites, createSite, updateSite, deleteSite,
  createRun, finishRun, saveRunSiteSummary, listRuns,
  insertObservations, latestSnapshot, fullHistory,
  replaceMyParts, missingMyParts, seedDefaultSites,
} from '../src/db.js';

let db;
beforeEach(() => { db = openDb(':memory:'); });

describe('seedDefaultSites', () => {
  it('adds the built-in sites once and never duplicates', () => {
    seedDefaultSites(db);
    const after1 = listSites(db);
    expect(after1.map((s) => s.name).sort()).toEqual(['Central Services', 'Intatec Showers']);
    seedDefaultSites(db); // idempotent
    expect(listSites(db)).toHaveLength(2);
  });
  it('does not overwrite an existing site on the same host', () => {
    createSite(db, { ...SITE, name: 'My Tweaked CS', max_pages: 7 });
    seedDefaultSites(db);
    const cs = listSites(db).filter((s) => s.base_url.includes('central-servicesuk'));
    expect(cs).toHaveLength(1);
    expect(cs[0].name).toBe('My Tweaked CS'); // user config preserved
  });
});

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

describe('runs and observations — deduplication', () => {
  it('ignores within-run duplicates for prev_price', () => {
    const siteId = createSite(db, SITE);
    const run1 = createRun(db);
    insertObservations(db, run1, siteId, [
      { partNumber: '133.1', name: 'V', price: 10, currency: 'GBP', url: 'a', lowConfidence: false },
    ]);
    finishRun(db, run1, 'done');
    const run2 = createRun(db);
    insertObservations(db, run2, siteId, [
      { partNumber: '133.1', name: 'V', price: 12, currency: 'GBP', url: 'a', lowConfidence: false },
      { partNumber: '133.1', name: 'V', price: 12, currency: 'GBP', url: 'b', lowConfidence: false },
    ]);
    finishRun(db, run2, 'done');
    const [row] = latestSnapshot(db);
    expect(row.price).toBe(12);
    expect(row.prev_price).toBe(10); // not masked by run2's duplicate
  });
  it('reports null prev_price on the first run even with duplicates', () => {
    const siteId = createSite(db, SITE);
    const run1 = createRun(db);
    insertObservations(db, run1, siteId, [
      { partNumber: '133.2', name: 'V', price: 20, currency: 'GBP', url: 'a', lowConfidence: false },
      { partNumber: '133.2', name: 'V', price: 19.5, currency: 'GBP', url: 'b', lowConfidence: false },
    ]);
    finishRun(db, run1, 'done');
    const [row] = latestSnapshot(db);
    expect(row.prev_price).toBeNull();
  });
});

describe('deleteSite cascade', () => {
  it('deletes a site with crawl history (cascades)', () => {
    const siteId = createSite(db, SITE);
    const run = createRun(db);
    insertObservations(db, run, siteId, [
      { partNumber: '133.3', name: 'V', price: 1, currency: 'GBP', url: 'u', lowConfidence: false },
    ]);
    saveRunSiteSummary(db, run, siteId, { pagesVisited: 1, partsFound: 1, pagesFailed: 0, warnings: [] });
    finishRun(db, run, 'done');
    deleteSite(db, siteId);
    expect(listSites(db)).toHaveLength(0);
    expect(latestSnapshot(db)).toHaveLength(0);
  });
});

describe('createSite defaults and boolean coercion', () => {
  it('accepts minimal site with only required fields and sets defaults', () => {
    const id = createSite(db, { name: 'Min', base_url: 'https://min.test/', strategy: 'prefix_search', prefixes: ['133.'] });
    const site = listSites(db).find(s => s.id === id);
    expect(site).toBeDefined();
    expect(site.max_pages).toBe(200);
    expect(site.enabled).toBe(1);
    expect(site.search_url_pattern).toBeNull();
  });
  it('coerces enabled: true to 1', () => {
    const id = createSite(db, { name: 'Bool', base_url: 'https://bool.test/', strategy: 'prefix_search', prefixes: [], enabled: true });
    const site = listSites(db).find(s => s.id === id);
    expect(site.enabled).toBe(1);
  });
});

describe('my_parts deduplication by norm', () => {
  it('replaceMyParts with variant spellings yields a single missingMyParts row', () => {
    replaceMyParts(db, [{ partNumber: '133.0440-351' }, { partNumber: '133.0440 351' }]);
    expect(missingMyParts(db)).toHaveLength(1);
  });
});
