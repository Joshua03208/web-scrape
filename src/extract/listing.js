import * as cheerio from 'cheerio';
import { findAllPrices } from './price.js';
import { buildPartNumberRegex } from './partNumber.js';

export function extractListingProducts(html, { prefixes, baseUrl }) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const partRe = buildPartNumberRegex(prefixes);
  const partReG = new RegExp(partRe.source, 'gi');
  const products = [];
  const seen = new Set();

  $('body *').each((_, el) => {
    const $el = $(el);
    const ownText = $el.clone().children().remove().end().text();
    const m = ownText.match(partRe);
    if (!m) return;
    const partNumber = m[0];

    // Expand to the product card: largest ancestor with only this part number.
    let $card = $el;
    while (true) {
      const $parent = $card.parent();
      if (!$parent.length || $parent.is('body,html')) break;
      const distinct = new Set($parent.text().match(partReG) ?? []);
      if (distinct.size > 1) break;
      $card = $parent;
    }

    const prices = findAllPrices($card.text());
    if (prices.length === 0) return;
    const distinctAmounts = new Set(prices.map((p) => p.amount));

    const $name = $card
      .find('h1,h2,h3,h4,a')
      .filter((_, n) => {
        const t = $(n).text().trim();
        return t.length > 2 && !partRe.test(t) && findAllPrices(t).length === 0;
      })
      .first();
    const name = $name.text().trim() || null;

    const href =
      ($name.is('a') ? $name.attr('href') : null) ??
      $name.closest('a').attr('href') ??
      $card.find('a[href]').first().attr('href');
    const url = href ? new URL(href, baseUrl).href : null;

    const key = `${partNumber}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    products.push({
      partNumber,
      name,
      price: prices[0].amount,
      currency: prices[0].currency,
      url,
      lowConfidence: distinctAmounts.size > 1,
    });
  });
  return products;
}
