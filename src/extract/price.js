const SYMBOLS = { '£': 'GBP', '$': 'USD', '€': 'EUR' };
const PRICE_RE = /(£|\$|€)\s*(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s*(GBP|USD|EUR)\b/gi;

function toMatch(m) {
  const amountStr = m[2] ?? m[3];
  const amount = Number(amountStr.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const currency = m[1] ? SYMBOLS[m[1]] : m[4].toUpperCase();
  return { amount, currency };
}

export function findAllPrices(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const p = toMatch(m);
    if (p) out.push(p);
  }
  return out;
}

export function parsePrice(text) {
  return findAllPrices(text)[0] ?? null;
}
