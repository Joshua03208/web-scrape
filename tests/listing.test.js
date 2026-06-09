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

  // Regression test 1: single-result page must not grab the header cart total.
  it('single-result page: extracts one product without grabbing header cart price', () => {
    const singleHtml = `<!DOCTYPE html>
<html><head><title>Search</title></head><body>
  <header><div id="cart">0 item(s) - £0.00</div></header>
  <div id="content">
    <div class="product-layout">
      <div class="product-thumb">
        <div class="image"><a href="/basket-strainer-plug?search=133."><img src="/img/1.jpg" alt=""></a></div>
        <div class="code">133.0008.411</div>
        <div class="caption">
          <h4><a href="/basket-strainer-plug?search=133.">Basket Strainer Plug</a></h4>
          <p class="price">£17.35</p>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
    const products = extractListingProducts(singleHtml, opts);
    expect(products).toHaveLength(1);
    expect(products[0].partNumber).toBe('133.0008.411');
    expect(products[0].price).toBe(17.35);
  });

  // Regression test 2: two cards with the same part number but different URLs/prices.
  it('two cards with the same part number emit two separate products', () => {
    const twoCardHtml = `<!DOCTYPE html>
<html><head><title>Search</title></head><body>
  <div id="content">
    <div class="row">
      <div class="product-layout col-md-3">
        <div class="product-thumb">
          <div class="image"><a href="/product-a"><img src="/img/1.jpg" alt=""></a></div>
          <div class="code">133.0001.111</div>
          <div class="caption">
            <h4><a href="/product-a">Product A</a></h4>
            <p class="price">£10.00</p>
          </div>
        </div>
      </div>
      <div class="product-layout col-md-3">
        <div class="product-thumb">
          <div class="image"><a href="/product-b"><img src="/img/2.jpg" alt=""></a></div>
          <div class="code">133.0001.111</div>
          <div class="caption">
            <h4><a href="/product-b">Product B</a></h4>
            <p class="price">£12.00</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
    const products = extractListingProducts(twoCardHtml, opts);
    expect(products).toHaveLength(2);
    const prices = products.map((p) => p.price).sort((a, b) => a - b);
    expect(prices).toEqual([10, 12]);
  });

  // Regression test 3: price value shares prefix digits — must not emit phantom part.
  it('does not emit a phantom part number from a price like £133.50', () => {
    const priceHtml = `<!DOCTYPE html>
<html><head><title>Search</title></head><body>
  <div id="content">
    <div class="product-layout">
      <div class="product-thumb">
        <div class="image"><a href="/product-c"><img src="/img/3.jpg" alt=""></a></div>
        <div class="code">133.0001.111</div>
        <div class="caption">
          <h4><a href="/product-c">Product C</a></h4>
          <p class="price">£133.50</p>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
    const products = extractListingProducts(priceHtml, opts);
    expect(products).toHaveLength(1);
    expect(products[0].partNumber).toBe('133.0001.111');
    expect(products[0].price).toBe(133.5);
  });

  // Regression test 4: broken href must yield url: null, not throw.
  it('returns url: null (not a throw) when the only anchor href is broken', () => {
    const brokenHtml = `<!DOCTYPE html>
<html><head><title>Search</title></head><body>
  <div id="content">
    <div class="product-layout">
      <div class="product-thumb">
        <div class="code">133.0001.111</div>
        <div class="caption">
          <h4><a href="http://">broken</a></h4>
          <p class="price">£10.00</p>
        </div>
      </div>
    </div>
  </div>
</body></html>`;
    let products;
    expect(() => { products = extractListingProducts(brokenHtml, opts); }).not.toThrow();
    expect(products).toHaveLength(1);
    expect(products[0].url).toBeNull();
  });
});
