import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseSpares, extractCode, readCodesFromCsv, sessionLooksInvalid, runEricLookup,
} from '../src/crawler/ericSpares.js';

const fixture = readFileSync('tests/fixtures/eric-ksi305sl.xml', 'utf8');

describe('parseSpares', () => {
  it('extracts every spare row with 4 cells, stock kept as string', () => {
    const rows = parseSpares(fixture);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ code: 'SPAR4020', description: 'Aerator', colour: 'Unavailable', stock: '20' });
    // the date-style stock cell stays as text
    expect(rows[1]).toEqual({
      code: 'SPBF62', description: 'Base Flange', colour: 'Chrome',
      stock: 'Next Available Date:14/08/2026',
    });
  });
  it('returns empty for a No Results response', () => {
    expect(parseSpares('<root><p class="error">No Results</p></root>')).toEqual([]);
  });
});

describe('extractCode', () => {
  it('takes the tail after the last " - " by default', () => {
    expect(extractCode('Nuie Windon Twin Thermostatic Valve - WIN7TW01')).toBe('WIN7TW01');
  });
  it('returns the whole value when no dash and when suffix disabled', () => {
    expect(extractCode('KSI305SL')).toBe('KSI305SL');
    expect(extractCode('Nuie Valve - WIN7TW01', { useSuffix: false })).toBe('Nuie Valve - WIN7TW01');
  });
});

describe('readCodesFromCsv', () => {
  it('picks a column by header, extracts suffix codes, dedupes preserving order, handles BOM', () => {
    const csv = '﻿"Epos Code","Name"\n"NUIE-1","Valve - WIN7TW01"\n"NUIE-2","Valve - WIN15TW02"\n"NUIE-3","Other - WIN7TW01"\n';
    const out = readCodesFromCsv(Buffer.from(csv, 'utf8'), { column: 'Name', useSuffix: true });
    expect(out.headers).toEqual(['Epos Code', 'Name']);
    expect(out.codes).toEqual(['WIN7TW01', 'WIN15TW02']); // 3rd row dupes WIN7TW01
  });
  it('defaults to the first column with suffix off', () => {
    const csv = 'Code\nKSI305SL\n\nKSI305SL\nABC123\n';
    expect(readCodesFromCsv(Buffer.from(csv), { useSuffix: false }).codes).toEqual(['KSI305SL', 'ABC123']);
  });
});

describe('sessionLooksInvalid', () => {
  it('flags redirects, default.htm and missing root', () => {
    expect(sessionLooksInvalid({ status: 302, location: '/default.htm', body: '' })).toBe(true);
    expect(sessionLooksInvalid({ status: 200, location: null, body: 'no root here' })).toBe(true);
    expect(sessionLooksInvalid({ status: 200, location: null, body: '<root>ok</root>' })).toBe(false);
  });
});

describe('runEricLookup', () => {
  const okResp = (body) => ({ status: 200, location: null, body });
  it('emits one row per spare and a NO SPARES FOUND row for empties', async () => {
    const fetchFn = async (path) =>
      path.includes('GOOD') ? okResp(fixture) : okResp('<root><p class="error">No Results</p></root>');
    const { rows, stats } = await runEricLookup(['GOOD', 'EMPTY'], { delayMs: 0, fetchFn });
    expect(stats).toMatchObject({ total: 2, done: 2, spares: 5, failures: 0 });
    expect(rows.filter((r) => r.product === 'GOOD')).toHaveLength(5);
    const empty = rows.find((r) => r.product === 'EMPTY');
    expect(empty.spareCode).toBe('NO SPARES FOUND');
  });
  it('records a failure row when a code errors twice', async () => {
    const fetchFn = async () => { throw new Error('boom'); };
    const { rows, stats } = await runEricLookup(['X'], { delayMs: 0, fetchFn });
    expect(stats.failures).toBe(1);
    expect(rows[0].spareCode).toBe('LOOKUP FAILED');
  });
});
