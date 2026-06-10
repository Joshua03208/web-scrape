export function normalisePartNumber(raw) {
  return String(raw).toUpperCase().replace(/[\s\-.]/g, '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches: <prefix><digits/dots ending in a digit>, with an optional 1-2 letter
// suffix (cold/hot variants like 133.0438.152C). e.g. "133." -> 133.0440.351
export function buildPartNumberRegex(prefixes) {
  const alts = prefixes.map(escapeRe).join('|');
  return new RegExp(
    `(?<![£$€]\\s*)(?<![\\d.])(?:${alts})[\\d.]*\\d[a-z]{0,2}(?!\\w|\\.\\d)(?!\\s*(?:GBP|USD|EUR)\\b)`,
    'i'
  );
}
