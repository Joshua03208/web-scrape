import { describe, it, expect } from 'vitest';
import { parseDevaProducts } from '../src/crawler/devaSpares.js';

const opts = { origin: 'https://www.deva-uk.com', collection: 'spares' };

describe('parseDevaProducts', () => {
  it('maps title/sku/price and builds the product url', () => {
    const json = {
      products: [{
        title: '72mm Slimline Bath Filler and Press Top Waste - Chrome',
        handle: '72mm-slimline-bath-filler',
        variants: [{ sku: 'BFW001', price: '159.13' }],
      }],
    };
    expect(parseDevaProducts(json, opts)).toEqual([{
      partNumber: 'BFW001',
      name: '72mm Slimline Bath Filler and Press Top Waste - Chrome',
      price: 159.13,
      currency: 'GBP',
      url: 'https://www.deva-uk.com/collections/spares/products/72mm-slimline-bath-filler',
      lowConfidence: false,
    }]);
  });
  it('skips products without a SKU or a positive price', () => {
    const json = {
      products: [
        { title: 'No sku', handle: 'a', variants: [{ sku: '', price: '5.00' }] },
        { title: 'Zero price', handle: 'b', variants: [{ sku: 'X1', price: '0' }] },
        { title: 'Good', handle: 'c', variants: [{ sku: 'X2', price: '7.06' }] },
      ],
    };
    const out = parseDevaProducts(json, opts);
    expect(out).toHaveLength(1);
    expect(out[0].partNumber).toBe('X2');
  });
  it('uses the first variant (the listing representation)', () => {
    const json = { products: [{ title: 'T', handle: 'h', variants: [
      { sku: 'FIRST', price: '10.00' }, { sku: 'SECOND', price: '12.00' },
    ] }] };
    const out = parseDevaProducts(json, opts);
    expect(out).toHaveLength(1);
    expect(out[0].partNumber).toBe('FIRST');
  });
  it('returns empty for an empty feed', () => {
    expect(parseDevaProducts({ products: [] }, opts)).toEqual([]);
    expect(parseDevaProducts({}, opts)).toEqual([]);
  });
});
