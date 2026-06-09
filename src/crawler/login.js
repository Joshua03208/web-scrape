import { chromium } from 'playwright';

export async function loginAndGetCookies(site) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(site.login_url, { waitUntil: 'domcontentloaded' });
    await page
      .locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[type="text"]')
      .first().fill(site.username);
    await page.locator('input[type="password"]').first().fill(site.password);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const cookies = await page.context().cookies();
    if (!cookies.length) throw new Error('Login produced no session cookies');
    return cookies;
  } finally {
    await browser.close();
  }
}
