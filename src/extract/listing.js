import * as cheerio from 'cheerio';
import { findAllPrices } from './price.js';
import { buildPartNumberRegex } from './partNumber.js';

// Fix 3: robust URL resolution — skips garbage hrefs and javascript: URLs.
function resolveUrl(href, baseUrl) {
  if (!href) return null;
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    return null;
  } catch {
    return null;
  }
}

export function extractListingProducts(html, { prefixes, baseUrl }) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  // Description excerpts on listing cards often cross-reference OTHER part numbers
  // ("Suitable For 133.0007.855 ..."), which breaks the one-part-number-per-card
  // expansion rule and silently drops the product. We never extract from
  // descriptions (name comes from the heading/link), so remove them up front.
  $('.description').remove();
  const partRe = buildPartNumberRegex(prefixes);
  const partReG = new RegExp(partRe.source, 'gi');
  const products = [];
  const seen = new Set();

  // Fix 2 helpers
  const countParts = (txt) => (txt.match(new RegExp(partRe.source, 'gi')) ?? []).length;
  const countPrices = (txt) => findAllPrices(txt).length;

  $('body *').each((_, el) => {
    const $el = $(el);
    const ownText = $el.clone().children().remove().end().text();
    const m = ownText.match(partRe);
    if (!m) return;
    const partNumber = m[0];

    // Fix 2: expand to the product card with tighter rules.
    let $card = $el;
    while (true) {
      const $parent = $card.parent();
      if (!$parent.length || $parent.is('body,html')) break;
      const parentTxt = $parent.text();
      const cardTxt = $card.text();
      const distinct = new Set(parentTxt.match(partReG) ?? []);
      if (distinct.size > 1) break;
      const cardHasPrice = countPrices(cardTxt) > 0;
      if (cardHasPrice && countParts(parentTxt) > countParts(cardTxt)) break;
      if (cardHasPrice && countPrices(parentTxt) > countPrices(cardTxt)) break;
      $card = $parent;
    }

    if (findAllPrices($card.text()).length === 0) return;

    // On pages with a single product (e.g. a full-code search result) the card
    // expands far beyond the product markup. Fields are therefore taken from the
    // INNER card: the smallest ancestor of the code element that carries a price.
    let $inner = $el;
    while (!$inner.is($card) && findAllPrices($inner.text()).length === 0) {
      $inner = $inner.parent();
    }
    const prices = findAllPrices($inner.text());
    const distinctAmounts = new Set(prices.map((p) => p.amount));

    const $name = $inner
      .find('h1,h2,h3,h4,a')
      .filter((_, n) => {
        const t = $(n).text().trim();
        return t.length > 2 && !partRe.test(t) && findAllPrices(t).length === 0;
      })
      .first();
    const name = $name.text().trim() || null;

    // Fix 3: try candidates in order, skip failures and javascript: hrefs.
    const hrefCandidates = [
      $name.is('a') ? $name.attr('href') : null,
      $name.closest('a').attr('href'),
      $inner.find('a[href]').first().attr('href'),
      $card.find('a[href]').first().attr('href'),
    ];
    let url = null;
    for (const href of hrefCandidates) {
      const resolved = resolveUrl(href, baseUrl);
      if (resolved) { url = resolved; break; }
    }

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
