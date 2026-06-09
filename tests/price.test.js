import { describe, it, expect } from 'vitest';
import { parsePrice, findAllPrices } from '../src/extract/price.js';

describe('parsePrice', () => {
  it('parses GBP symbol', () => {
    expect(parsePrice('£20.81')).toEqual({ amount: 20.81, currency: 'GBP' });
  });
  it('parses USD symbol with surrounding text', () => {
    expect(parsePrice('Now only $123.45 each')).toEqual({ amount: 123.45, currency: 'USD' });
  });
  it('parses trailing currency code', () => {
    expect(parsePrice('123.45 USD')).toEqual({ amount: 123.45, currency: 'USD' });
  });
  it('parses thousands separators', () => {
    expect(parsePrice('£1,234.56')).toEqual({ amount: 1234.56, currency: 'GBP' });
  });
  it('parses whole-number prices', () => {
    expect(parsePrice('€45')).toEqual({ amount: 45, currency: 'EUR' });
  });
  it('returns null when no price present', () => {
    expect(parsePrice('Valve (20 Splines) : COLD')).toBeNull();
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null)).toBeNull();
  });
  it('findAllPrices returns every amount in order', () => {
    expect(findAllPrices('was £25.00 now £20.81, £20.81 inc VAT')).toEqual([
      { amount: 25.0, currency: 'GBP' },
      { amount: 20.81, currency: 'GBP' },
      { amount: 20.81, currency: 'GBP' },
    ]);
  });
});
