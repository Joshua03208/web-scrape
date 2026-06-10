import { listSites, createRun, finishRun, insertObservations, saveRunSiteSummary } from '../db.js';
import { crawlPrefixSearch } from './prefixSearch.js';
import { crawlLinkCrawl } from './linkCrawl.js';
import { crawlCategoryCrawl } from './categoryCrawl.js';
import { loginAndGetCookies } from './login.js';

const STRATEGIES = {
  prefix_search: crawlPrefixSearch,
  category_crawl: crawlCategoryCrawl,
  link_crawl: crawlLinkCrawl,
};

async function defaultCrawlSite(site, { onProgress }) {
  let cookies = null;
  if (site.login_url && site.username) {
    cookies = await loginAndGetCookies(site);
  }
  const crawl = STRATEGIES[site.strategy] ?? crawlLinkCrawl;
  return crawl(site, { cookies, onProgress });
}

export async function executeRun(db, { crawlSite = defaultCrawlSite, onProgress = () => {}, siteIds } = {}) {
  const runId = createRun(db);
  let sites = listSites(db).filter((s) => s.enabled);
  if (Array.isArray(siteIds) && siteIds.length > 0) {
    const wanted = new Set(siteIds.map(Number));
    sites = sites.filter((s) => wanted.has(s.id));
  }
  const enabledCount = sites.length;
  let failures = 0;
  try {
    for (const site of sites) {
      let summarySaved = false;
      try {
        try { onProgress({ runId, siteName: site.name, phase: 'start' }); } catch (_) {}
        const { products, stats } = await crawlSite(site, {
          onProgress: (p) => {
            try { onProgress({ runId, siteName: site.name, phase: 'crawling', ...p }); } catch (_) {}
          },
        });

        // Fix 2: filter out malformed products before insert
        const valid = products.filter(
          (p) => p.partNumber && Number.isFinite(p.price) && p.price > 0,
        );
        const dropped = products.length - valid.length;
        const warnings = [...stats.warnings];
        if (dropped > 0) warnings.push(`Skipped ${dropped} malformed product(s)`);

        insertObservations(db, runId, site.id, valid);
        saveRunSiteSummary(db, runId, site.id, {
          pagesVisited: stats.pagesVisited, partsFound: valid.length,
          pagesFailed: stats.pagesFailed, warnings,
        });
        summarySaved = true;
        try { onProgress({ runId, siteName: site.name, phase: 'done', partsFound: valid.length }); } catch (_) {}
      } catch (err) {
        failures += 1;
        if (!summarySaved) {
          saveRunSiteSummary(db, runId, site.id, {
            pagesVisited: 0, partsFound: 0, pagesFailed: 0,
            warnings: [`Site failed: ${err.message}`],
          });
        }
        try { onProgress({ runId, siteName: site.name, phase: 'failed', error: err.message }); } catch (_) {}
      }
    }
  } finally {
    const status = failures > 0 && failures === enabledCount ? 'failed' : 'done';
    finishRun(db, runId, status);
  }
  return runId;
}
