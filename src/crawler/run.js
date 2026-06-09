import { listSites, createRun, finishRun, insertObservations, saveRunSiteSummary } from '../db.js';
import { crawlPrefixSearch } from './prefixSearch.js';
import { crawlLinkCrawl } from './linkCrawl.js';
import { loginAndGetCookies } from './login.js';

async function defaultCrawlSite(site, { onProgress }) {
  let cookies = null;
  if (site.login_url && site.username) {
    cookies = await loginAndGetCookies(site);
  }
  const crawl = site.strategy === 'prefix_search' ? crawlPrefixSearch : crawlLinkCrawl;
  return crawl(site, { cookies, onProgress });
}

export async function executeRun(db, { crawlSite = defaultCrawlSite, onProgress = () => {} } = {}) {
  const runId = createRun(db);
  const sites = listSites(db).filter((s) => s.enabled);
  for (const site of sites) {
    onProgress({ runId, siteName: site.name, phase: 'start' });
    try {
      const { products, stats } = await crawlSite(site, {
        onProgress: (p) => onProgress({ runId, siteName: site.name, phase: 'crawling', ...p }),
      });
      insertObservations(db, runId, site.id, products);
      saveRunSiteSummary(db, runId, site.id, {
        pagesVisited: stats.pagesVisited, partsFound: products.length,
        pagesFailed: stats.pagesFailed, warnings: stats.warnings,
      });
      onProgress({ runId, siteName: site.name, phase: 'done', partsFound: products.length });
    } catch (err) {
      saveRunSiteSummary(db, runId, site.id, {
        pagesVisited: 0, partsFound: 0, pagesFailed: 0,
        warnings: [`Site failed: ${err.message}`],
      });
      onProgress({ runId, siteName: site.name, phase: 'failed', error: err.message });
    }
  }
  finishRun(db, runId, 'done');
  return runId;
}
