import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractListingProducts } from '../src/extract/listing.js';

const html = readFileSync('tests/fixtures/opencart-search.html', 'utf8');
const opts = { prefixes: ['133.'], baseUrl: 'https://central-servicesuk.co.uk/' };

describe('extractListingProducts', () => {
  it('extracts every product card with part number, name, price, absolute url', () => {
    const products = extractListingProducts(html, opts);
    expect(products).toHaveLength(3);
    expect(products[0]).toEqual({
      partNumber: '133.0440.351',
      name: 'Valve (20 Splines) : COLD',
      price: 20.81,
      currency: 'GBP',
      url: 'https://central-servicesuk.co.uk/valve-20-splines-cold?search=133.',
      lowConfidence: false,
    });
  });
  it('flags cards with multiple distinct prices as low confidence', () => {
    const products = extractListingProducts(html, opts);
    const sale = products.find((p) => p.partNumber === '133.0358.055');
    expect(sale.lowConfidence).toBe(true);
    expect(sale.price).toBe(25.0); // first price in card; flagged for human review
  });
  it('returns empty array when no prefixes match', () => {
    expect(extractListingProducts(html, { ...opts, prefixes: ['999.'] })).toEqual([]);
  });
  it('returns empty array for a no-results page', () => {
    const empty = '<html><body><p>There is no product that matches the search criteria.</p></body></html>';
    expect(extractListingProducts(empty, opts)).toEqual([]);
  });
});
