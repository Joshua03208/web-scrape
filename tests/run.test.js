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

  it('finishes the run even if onProgress throws', async () => {
    createSite(db, SITE);
    const runId = await executeRun(db, {
      crawlSite: async () => ({ products: [], stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] } }),
      onProgress: () => { throw new Error('SSE client gone'); },
    });
    expect(listRuns(db).find((r) => r.id === runId).status).toBe('done');
  });

  it('marks the run failed when every site fails', async () => {
    createSite(db, SITE);
    const runId = await executeRun(db, { crawlSite: async () => { throw new Error('boom'); } });
    expect(listRuns(db).find((r) => r.id === runId).status).toBe('failed');
  });

  it('runs only the requested sites when siteIds is given', async () => {
    const idA = createSite(db, SITE);
    createSite(db, { ...SITE, name: 'B' });
    const crawled = [];
    await executeRun(db, {
      siteIds: [idA],
      crawlSite: async (site) => {
        crawled.push(site.name);
        return { products: [product], stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] } };
      },
    });
    expect(crawled).toEqual(['A']);
  });

  it('skips malformed products with a warning instead of failing the site', async () => {
    createSite(db, SITE);
    const runId = await executeRun(db, {
      crawlSite: async () => ({
        products: [product, { partNumber: '133.9', name: 'bad', price: null, currency: 'GBP', url: 'u', lowConfidence: false }],
        stats: { pagesVisited: 1, pagesFailed: 0, warnings: [] },
      }),
    });
    expect(latestSnapshot(db)).toHaveLength(1);
    const run = listRuns(db).find((r) => r.id === runId);
    expect(run.site_summaries[0].warnings.join(' ')).toContain('malformed');
    expect(run.status).toBe('done');
  });
});
