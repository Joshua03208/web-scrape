import { chromium } from 'playwright';

export async function loginAndGetCookies(site) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(site.login_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const form = page.locator('form:has(input[type="password"])').first();
    await form
      .locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[type="text"]')
      .first().fill(site.username, { timeout: 10000 });
    await form.locator('input[type="password"]').first().fill(site.password, { timeout: 10000 });
    await form.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const passwordStillVisible = await page
      .locator('input[type="password"]').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    if (passwordStillVisible) {
      throw new Error('Login appears to have failed — password field still present after submit (check credentials)');
    }
    const cookies = await page.context().cookies();
    if (!cookies.length) throw new Error('Login produced no session cookies');
    return cookies;
  } finally {
    await browser.close();
  }
}
