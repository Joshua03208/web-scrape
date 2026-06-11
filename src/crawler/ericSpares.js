import https from 'node:https';
import tls from 'node:tls';
import * as cheerio from 'cheerio';
import { parse } from 'csv-parse/sync';

const ERIC_ORIGIN = 'https://eric.ultrasap.com';

// The endpoint serves a VALID Let's Encrypt certificate, but issued for the
// hosting provider's wildcard (*.roxorgroup.com) instead of eric.ultrasap.com —
// a hostname mismatch only. So we keep full chain validation (rejectUnauthorized
// stays on: forged / expired / untrusted certs are still rejected) and relax
// ONLY the hostname check, and only to that one expected subject. If the host
// ever serves a different/forged cert this fails loudly rather than silently
// trusting it — far safer than disabling verification wholesale.
const EXPECTED_CERT_HOST = 'roxorgroup.com';
const insecureAgent = new https.Agent({
  checkServerIdentity: (host, cert) => {
    const cn = cert?.subject?.CN ?? '';
    const san = cert?.subjectaltname ?? '';
    if (cn.includes(EXPECTED_CERT_HOST) || san.includes(EXPECTED_CERT_HOST)) {
      return undefined; // expected hostname mismatch — accept
    }
    return tls.checkServerIdentity(host, cert); // anything else: normal check (errors)
  },
});

// Minimal GET that we fully control: no auto-redirect (we need to SEE the 302 to
// default.htm that signals an expired session), custom cookie, hard timeout.
export function ericGet(path, { cookie = '', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${ERIC_ORIGIN}${path}`,
      {
        method: 'GET',
        agent: insecureAgent,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'text/html,application/xml',
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          location: res.headers.location ?? null,
          setCookie: res.headers['set-cookie'] ?? [],
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
  });
}

// Visit the site root once to be issued an `ericsid` session cookie. Falls back
// to a caller-supplied value (e.g. ERIC_SID env) if the handshake doesn't yield one.
export async function acquireEricSession(fallback = '') {
  try {
    const res = await ericGet('/', { timeout: 20000 });
    for (const c of res.setCookie) {
      const m = c.match(/ericsid=([^;]+)/i);
      if (m) return `ericsid=${m[1]}`;
    }
  } catch { /* fall through to fallback */ }
  return fallback ? (fallback.includes('=') ? fallback : `ericsid=${fallback}`) : '';
}

// A response is "not a valid spares page" if the server bounced us to the login
// page or the XML root is missing — both mean the session is dead/invalid.
export function sessionLooksInvalid(res) {
  if (res.status >= 300 && res.status < 400) return true;
  if (/default\.htm/i.test(res.location ?? '')) return true;
  return !res.body.includes('<root');
}

// Lenient HTML parse (the response has blank lines before <?xml?>, which trips
// strict XML parsers). One row per <tr> in the spares table: 4 cells.
export function parseSpares(xmlish) {
  const $ = cheerio.load(xmlish);
  const rows = [];
  $('table.spares tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length >= 4 && cells[0]) {
      rows.push({ code: cells[0], description: cells[1], colour: cells[2], stock: cells[3] });
    }
  });
  return rows;
}

// Pull the lookup code out of a CSV cell. With useSuffix, take the part after the
// last " - " (the material code is the tail of the product Name); else the cell.
export function extractCode(value, { useSuffix = true } = {}) {
  const v = String(value ?? '').trim();
  if (!useSuffix) return v;
  const idx = v.lastIndexOf(' - ');
  return (idx >= 0 ? v.slice(idx + 3) : v).trim();
}

// Read product codes from an uploaded CSV: choose the column by header name
// (or first column), extract codes, drop blanks, de-dupe preserving order.
export function readCodesFromCsv(buffer, { column = null, useSuffix = true } = {}) {
  const records = parse(buffer, { bom: true, skip_empty_lines: true, relax_column_count: true });
  if (records.length === 0) return { headers: [], codes: [] };
  const headers = records[0].map((h) => String(h).trim());
  let col = 0;
  if (column) {
    const i = headers.findIndex((h) => h.toLowerCase() === String(column).toLowerCase());
    if (i >= 0) col = i;
  }
  const seen = new Set();
  const codes = [];
  for (const row of records.slice(1)) {
    const code = extractCode(row[col], { useSuffix });
    if (code && !seen.has(code)) { seen.add(code); codes.push(code); }
  }
  return { headers, codes };
}

export const ERIC_COLUMNS = [
  { key: 'product', header: 'Product' },
  { key: 'spareCode', header: 'Spare Code' },
  { key: 'description', header: 'Description' },
  { key: 'colour', header: 'Colour' },
  { key: 'stock', header: 'Free Stock' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Look every code up on the eric feed. One request per code, 1s apart, 30s
// timeout, one retry, and errors are logged not thrown. Products with no spares
// still get a "NO SPARES FOUND" row so every input code is accounted for.
export async function runEricLookup(codes, {
  cookie = '', onProgress = () => {}, delayMs = 1000, fetchFn = ericGet,
} = {}) {
  const rows = [];
  const stats = { total: codes.length, done: 0, spares: 0, failures: 0 };
  let sessionDead = false;

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        const r = await fetchFn(`/spares.xml?zmatnr=${encodeURIComponent(code)}`, { cookie, timeout: 30000 });
        if (sessionLooksInvalid(r)) {
          if (attempt === 1) { sessionDead = true; }
        } else { res = r; }
      } catch {
        if (attempt === 1) { /* give up on this code */ }
      }
      if (!res && attempt === 0) await sleep(300);
    }

    if (!res) {
      stats.failures += 1;
      rows.push({ product: code, spareCode: 'LOOKUP FAILED', description: '', colour: '', stock: '' });
      try { onProgress({ ...stats, line: `[${i + 1}/${codes.length}] ${code}: failed${sessionDead ? ' (session invalid)' : ''}` }); } catch { /* ignore */ }
    } else {
      const spares = parseSpares(res.body);
      if (spares.length === 0) {
        rows.push({ product: code, spareCode: 'NO SPARES FOUND', description: '', colour: '', stock: '' });
      } else {
        for (const s of spares) {
          rows.push({ product: code, spareCode: s.code, description: s.description, colour: s.colour, stock: s.stock });
        }
        stats.spares += spares.length;
      }
      try { onProgress({ ...stats, line: `[${i + 1}/${codes.length}] ${code}: ${spares.length} spares` }); } catch { /* ignore */ }
    }
    stats.done += 1;
    if (sessionDead) { stats.aborted = 'eric session expired — set ERIC_SID or try again'; break; }
    if (i < codes.length - 1) await sleep(delayMs);
  }
  return { rows, stats };
}
