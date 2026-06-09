export function normalisePartNumber(raw) {
  return String(raw).toUpperCase().replace(/[\s\-]/g, '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Matches: <prefix><digits/dots ending in a digit>, e.g. "133." -> 133.0440.351
export function buildPartNumberRegex(prefixes) {
  const alts = prefixes.map(escapeRe).join('|');
  return new RegExp(`(?<![\\d.])(?:${alts})[\\d.]*\\d`, 'i');
}
