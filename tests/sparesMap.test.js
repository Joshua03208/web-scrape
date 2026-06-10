import { describe, it, expect, beforeEach } from 'vitest';
import { parseSparesText } from '../src/crawler/sparesMap.js';
import { openDb, createSite, replaceShowerSpares, listShowerSpares } from '../src/db.js';

describe('parseSparesText', () => {
  it('extracts the codes from a Spares line', () => {
    const text = 'PRODUCTS\nSpares – IX100025CP, ST20004XX, ST00003XX, PU100009XX, 30009CPX, HS1007CP, 31612CP, WB103, 20010CP, 800032CP\nDownload';
    expect(parseSparesText(text)).toEqual([
      'IX100025CP', 'ST20004XX', 'ST00003XX', 'PU100009XX', '30009CPX',
      'HS1007CP', '31612CP', 'WB103', '20010CP', '800032CP',
    ]);
  });
  it('handles plain hyphens and multiple lines, dedupes', () => {
    const text = 'Spares - AB123, CD456\nblah\nSpares - CD456, EF789';
    expect(parseSparesText(text)).toEqual(['AB123', 'CD456', 'EF789']);
  });
  it('ignores junk fragments', () => {
    expect(parseSparesText('Spares – AB123, and more, !!')).toEqual(['AB123']);
  });
  it('returns empty when no spares line exists', () => {
    expect(parseSparesText('A shower page with no spares section')).toEqual([]);
  });
});

describe('shower spares storage', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });

  it('replaces a site mapping and lists it with the site name', () => {
    const siteId = createSite(db, {
      name: 'Intatec', base_url: 'https://www.intatec.co.uk/x', strategy: 'spares_map', prefixes: [],
    });
    replaceShowerSpares(db, siteId, [
      { shower: 'Enzo Deluxe', sku: 'IX100025CP', spare: 'ST20004XX', url: 'https://x/p' },
      { shower: 'Enzo Deluxe', sku: 'IX100025CP', spare: 'WB103', url: 'https://x/p' },
    ]);
    expect(listShowerSpares(db)).toHaveLength(2);
    // a re-crawl replaces, not appends
    replaceShowerSpares(db, siteId, [
      { shower: 'Enzo Deluxe', sku: 'IX100025CP', spare: 'ST20004XX', url: 'https://x/p' },
    ]);
    const rows = listShowerSpares(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].site_name).toBe('Intatec');
    expect(rows[0].spare).toBe('ST20004XX');
  });

  it('stores products without published spares as null-spare rows', () => {
    const siteId = createSite(db, {
      name: 'Intatec', base_url: 'https://x/', strategy: 'spares_map', prefixes: [],
    });
    replaceShowerSpares(db, siteId, [
      { shower: 'Mio Safe-Touch', sku: 'IX300020CP', spare: null, url: 'https://x/m' },
      { shower: 'Enzo Deluxe', sku: 'IX100025CP', spare: 'WB103', url: 'https://x/e' },
    ]);
    const rows = listShowerSpares(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.shower === 'Mio Safe-Touch').spare).toBeNull();
  });
});
