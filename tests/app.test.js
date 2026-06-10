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
    expect(started.body.started).toBe(true);
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
  // Fix 2: unsupported file type
  it('rejects an .xls upload without touching the parts list', async () => {
    await request(app).post('/api/parts')
      .attach('file', Buffer.from('\xd0\xcf\x11\xe0junk'), 'parts.xls').expect(400);
  });
  // Fix 2: empty file
  it('rejects an empty file', async () => {
    await request(app).post('/api/parts').attach('file', Buffer.from(''), 'parts.csv').expect(400);
  });
  // Fix 4: oversized upload returns JSON 400
  it('returns json 400 for an oversized upload', async () => {
    await request(app).post('/api/parts')
      .attach('file', Buffer.alloc(11 * 1024 * 1024, 97), 'parts.csv').expect(400)
      .then((res) => expect(res.body.error).toBeTruthy());
  });
});

describe('sites API — edge cases', () => {
  // Fix 3: no body → 400 not 500
  it('returns 400 (not 500) when no body is posted', async () => {
    await request(app).post('/api/sites').expect(400);
  });
  // Fix 6: PUT to nonexistent site → 404
  it('404s on PUT to a nonexistent site', async () => {
    await request(app).put('/api/sites/999').send(SITE).expect(404);
  });
});

describe('compare API', () => {
  it('parses an EPOS-style csv into normalised parts with prices', async () => {
    const csv = 'Epos Code,Description,RRP\nFRANKE-133.0007.840,Franke Cable,58.64\nFRANKE-112.0001.111,"Thing, big","1,234.56"\n';
    const res = await request(app).post('/api/compare')
      .attach('file', Buffer.from(csv), 'old.csv').expect(200);
    expect(res.body.parts).toEqual([
      { code: '133.0007.840', norm: '1330007840', price: 58.64 },
      { code: '112.0001.111', norm: '1120001111', price: 1234.56 },
    ]);
  });
  it('rejects files with no part numbers', async () => {
    await request(app).post('/api/compare')
      .attach('file', Buffer.from('Name\nFoo\n'), 'old.csv').expect(400);
  });
  it('rejects unsupported file types', async () => {
    await request(app).post('/api/compare')
      .attach('file', Buffer.from('junk'), 'old.xls').expect(400);
  });
});

describe('runs API — siteIds', () => {
  it('passes siteIds through to the executor', async () => {
    createSite(db, SITE);
    let received;
    app = createApp(db, {
      runExecutor: async (database, opts) => { received = opts.siteIds; return 1; },
    });
    await request(app).post('/api/runs').send({ siteIds: [1] }).expect(202);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([1]);
  });
});

describe('runs API — state machine', () => {
  // Fix 5: runId is null at the start of a new run
  it('clears the previous runId when a new run starts', async () => {
    createSite(db, SITE);
    await request(app).post('/api/runs').expect(202);
    await new Promise((r) => setTimeout(r, 100));
    const first = await request(app).get('/api/runs/current');
    expect(first.body.runId).not.toBeNull();
    // start second run with a never-resolving executor
    app = createApp(db, { runExecutor: () => new Promise(() => {}) });
    await request(app).post('/api/runs').expect(202);
    const second = await request(app).get('/api/runs/current');
    expect(second.body.runId).toBeNull();
  });
});
