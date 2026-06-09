import { describe, it, expect } from 'vitest';
import { extractPairsByProximity } from '../src/extract/proximity.js';

const opts = { prefixes: ['133.'], pageUrl: 'https://example.com/p' };

describe('extractPairsByProximity', () => {
  it('pairs a part number with the nearest price in document order', () => {
    const html = `<html><head><title>Spares</title></head><body>
      <table>
        <tr><td>133.0001.111</td><td>Cold valve</td><td>£10.00</td></tr>
        <tr><td>133.0002.222</td><td>Hot valve</td><td>£12.50</td></tr>
      </table></body></html>`;
    const pairs = extractPairsByProximity(html, opts);
    expect(pairs).toEqual([
      { partNumber: '133.0001.111', name: 'Spares', price: 10.0, currency: 'GBP',
        url: 'https://example.com/p', lowConfidence: false },
      { partNumber: '133.0002.222', name: 'Spares', price: 12.5, currency: 'GBP',
        url: 'https://example.com/p', lowConfidence: false },
    ]);
  });
  it('flags low confidence when two prices are equally near', () => {
    const html = `<html><head><title>T</title></head><body>
      <span>£9.99</span><span>133.0003.333</span><span>£11.99</span></body></html>`;
    const [pair] = extractPairsByProximity(html, opts);
    expect(pair.lowConfidence).toBe(true);
  });
  it('returns empty for pages with parts but no prices', () => {
    const html = '<html><head><title>T</title></head><body><p>133.0004.444</p></body></html>';
    expect(extractPairsByProximity(html, opts)).toEqual([]);
  });
  it('ignores scripts and styles', () => {
    const html = `<html><head><title>T</title></head><body>
      <script>var x = "133.9999.999 £1.00";</script></body></html>`;
    expect(extractPairsByProximity(html, opts)).toEqual([]);
  });

  // Regression test 5: two-row table where second row has POA (no price) —
  // both parts share the only price token, so both should be lowConfidence.
  it('flags both parts as lowConfidence when they share the same price token', () => {
    const html = `<html><head><title>T</title></head><body>
      <table>
        <tr><td>133.0001.111</td><td>£10.00</td></tr>
        <tr><td>133.0002.222</td><td>POA</td></tr>
      </table></body></html>`;
    const pairs = extractPairsByProximity(html, opts);
    expect(pairs).toHaveLength(2);
    expect(pairs.find((p) => p.partNumber === '133.0001.111').lowConfidence).toBe(true);
    expect(pairs.find((p) => p.partNumber === '133.0002.222').lowConfidence).toBe(true);
  });

  // Regression test 6: same part appearing twice (e.g. breadcrumb + table) with the
  // same nearest price should be deduped to a single pair — and that pair must NOT be
  // flagged lowConfidence (only one distinct part maps to the price token).
  it('dedupes identical partNumber|price pairs', () => {
    const html = `<html><head><title>T</title></head><body>
      <nav>133.0001.111</nav>
      <table>
        <tr><td>133.0001.111</td><td>£10.00</td></tr>
      </table></body></html>`;
    const pairs = extractPairsByProximity(html, opts);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].partNumber).toBe('133.0001.111');
    expect(pairs[0].price).toBe(10);
    expect(pairs[0].lowConfidence).toBe(false);
  });
});
