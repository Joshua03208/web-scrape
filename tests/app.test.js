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
