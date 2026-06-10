import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestSnapshot } from '../db.js';

const IMAGES_ROOT = fileURLToPath(new URL('../../data/images', import.meta.url));
export function imagesRoot() { return IMAGES_ROOT; }

export function safeFolderName(part) {
  return String(part).replace(/[^A-Za-z0-9._-]/g, '_');
}

// FRANKE-133.0440.351.jpg when a product has one image,
// FRANKE-133.0440.351_0.jpg / _1 / _2 when it has several.
export function buildImageFilename(prefix, part, idx, total, ext) {
  const base = `${prefix}${part}`;
  return total > 1 ? `${base}_${idx}.${ext}` : `${base}.${ext}`;
}

export function extFromUrl(url) {
  const m = url.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

// Shops serve resized cache variants (...-228x228.jpg, ...-600x315w.jpg) of the
// same photo. Group by the underlying file and keep the largest variant
// (an un-sized URL is the original and wins outright).
export function dedupeImageUrls(urls) {
  const best = new Map();
  for (const u of urls) {
    const clean = u.split('?')[0];
    const key = clean
      .replace(/^https?:\/\//, '')
      .replace(/\/image\/cache\//, '/image/')
      .replace(/-\d+x\d+[a-z]?(?=\.\w+$)/i, '');
    const m = clean.match(/-(\d+)x(\d+)[a-z]?\.\w+$/i);
    const area = m ? Number(m[1]) * Number(m[2]) : Infinity;
    const cur = best.get(key);
    if (!cur || area > cur.area) best.set(key, { url: u, area });
  }
  return [...best.values()].map((v) => v.url);
}

// A product's own photos are typically named after its code; pictures of OTHER
// products on the page (related items, menus, logos) are not.
export function pickProductImages(urls, partNumber) {
  const part = String(partNumber).toUpperCase();
  const imageish = urls.filter((u) => /\/image\/.*\.(jpe?g|png|webp)(\?|$)/i.test(u));
  const own = imageish.filter((u) => {
    try {
      return decodeURIComponent(u.split('?')[0].split('/').pop()).toUpperCase().includes(part);
    } catch {
      return false;
    }
  });
  return dedupeImageUrls(own).slice(0, 10);
}

// Visits each scraped product page for a site and saves its gallery images to
// data/images/<part number>/. Parts that already have a folder are skipped, so
// re-runs only fetch new products.
export async function harvestImages(db, site, { prefix = '', onProgress = () => {}, limit = 0 } = {}) {
  let rows = latestSnapshot(db).filter((r) => r.site_id === site.id && r.url);
  if (limit > 0) rows = rows.slice(0, limit);
  const stats = { total: rows.length, done: 0, saved: 0, skipped: 0, noImages: 0, failed: 0 };
  const queue = [...rows];

  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  async function worker() {
    const page = await ctx.newPage();
    while (queue.length > 0) {
      const r = queue.shift();
      const folder = join(IMAGES_ROOT, safeFolderName(r.part_number));
      try {
        if (existsSync(folder) && readdirSync(folder).length > 0) {
          stats.skipped += 1;
          continue;
        }
        await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(400);
        const found = await page.evaluate(() => {
          const out = { urls: [], og: null };
          document.querySelectorAll('a[href]').forEach((a) => out.urls.push(a.href));
          document.querySelectorAll('img[src]').forEach((i) => out.urls.push(i.src));
          const og = document.querySelector('meta[property="og:image"]');
          if (og?.content) { out.og = og.content; out.urls.push(og.content); }
          return out;
        });
        let imgs = pickProductImages(found.urls, r.part_number);
        // fallback: no code-named images — take the page's main (og) image
        if (imgs.length === 0 && found.og) imgs = [found.og];
        if (imgs.length === 0) {
          stats.noImages += 1;
          continue;
        }
        mkdirSync(folder, { recursive: true });
        let saved = 0;
        for (let i = 0; i < imgs.length; i++) {
          const resp = await ctx.request.get(imgs[i]).catch(() => null);
          if (!resp?.ok()) continue;
          const name = buildImageFilename(prefix, r.part_number, i, imgs.length, extFromUrl(imgs[i]));
          writeFileSync(join(folder, name), await resp.body());
          saved += 1;
        }
        stats.saved += saved;
        if (saved === 0) stats.failed += 1;
      } catch {
        stats.failed += 1;
      } finally {
        stats.done += 1;
        try { onProgress({ ...stats }); } catch { /* progress is best-effort */ }
        await page.waitForTimeout(250);
      }
    }
    await page.close();
  }

  await Promise.all([worker(), worker()]);
  await browser.close();
  return stats;
}
