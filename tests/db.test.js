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
