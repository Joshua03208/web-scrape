import * as cheerio from 'cheerio';
import { findAllPrices } from './price.js';
import { buildPartNumberRegex } from './partNumber.js';

// Walks text nodes in document order, records part-number and price tokens
// with their position, then pairs each part with its nearest price.
export function extractPairsByProximity(html, { prefixes, pageUrl }) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const title = $('title').text().trim() || null;
  const partReG = new RegExp(buildPartNumberRegex(prefixes).source, 'gi');

  const parts = [];
  const prices = [];
  let pos = 0;
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.type === 'text') {
        const text = child.data;
        pos += 1;
        for (const m of text.match(partReG) ?? []) parts.push({ value: m, pos });
        for (const p of findAllPrices(text)) prices.push({ ...p, pos });
      } else {
        walk(child);
      }
    }
  };
  walk($('body')[0] ?? { childNodes: [] });

  if (prices.length === 0) return [];

  return parts.map(({ value, pos: partPos }) => {
    // Sort by absolute distance; on tie prefer prices after the part number.
    const byDistance = [...prices].sort((a, b) => {
      const da = Math.abs(a.pos - partPos);
      const db = Math.abs(b.pos - partPos);
      if (da !== db) return da - db;
      // Tiebreak: price after part beats price before.
      const afterA = a.pos >= partPos ? 0 : 1;
      const afterB = b.pos >= partPos ? 0 : 1;
      return afterA - afterB;
    });
    const nearest = byDistance[0];
    const nearestDist = Math.abs(nearest.pos - partPos);

    // Find all prices at the same distance as nearest with a different amount.
    const rivals = byDistance.slice(1).filter(
      (p) => Math.abs(p.pos - partPos) === nearestDist && p.amount !== nearest.amount
    );

    let lowConfidence = false;
    if (rivals.length > 0) {
      // A rival is a true ambiguity only if it has no closer (or equally close) part number
      // other than the current part — i.e. it is not clearly "claimed" by another part.
      lowConfidence = rivals.some((rival) => {
        const rivalDist = Math.abs(rival.pos - partPos);
        // The rival price is "claimed" by another part if that part is at most as close.
        return !parts.some(
          (p) => p.pos !== partPos && Math.abs(p.pos - rival.pos) <= rivalDist
        );
      });
    }

    return {
      partNumber: value,
      name: title,
      price: nearest.amount,
      currency: nearest.currency,
      url: pageUrl,
      lowConfidence,
    };
  });
}
