// @ts-check
/**
 * Custom Playwright test fixture with authentication helpers.
 */
const { test: base, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const TEST_USER = {
  email: 'test_e2e@fileservice.test',
  password: 'Test@123456!',
};

const STATE_FILE = path.join(__dirname, '..', '.auth', 'test-user-state.json');

/**
 * Extended test fixture that provides:
 * - authenticatedPage: a page that's already logged in
 * - api: API helper for backend operations
 * - testUser: test user credentials
 */
const test = base.extend({
  // Storage state for authenticated tests
  storageState: async ({}, use) => {
    if (fs.existsSync(STATE_FILE)) {
      await use(STATE_FILE);
    } else {
      await use(undefined);
    }
  },

  // Test user credentials
  testUser: async ({}, use) => {
    await use(TEST_USER);
  },

  // Authenticated page (already logged in)
  authenticatedPage: async ({ browser, storageState }, use) => {
    const context = await browser.newContext({
      storageState: storageState,
      baseURL: 'http://127.0.0.1:88',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

/**
 * Helper: Login via the browser UI.
 */
async function loginViaUI(page, email, password) {
  await page.goto('/login.html');
  await page.waitForSelector('#login-email', { state: 'visible' });

  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await page.click('#btn-login');

  // Wait for success message or redirect
  await page.waitForTimeout(1500);

  // Check if login was successful by looking for success message or being on home page
  const url = page.url();
  const messageEl = page.locator('.message.success');
  const isSuccess = (await messageEl.count()) > 0 || url.includes('home.html');

  return { success: isSuccess, url };
}

/**
 * Helper: Register via the browser UI.
 */
async function registerViaUI(page, email, password) {
  await page.goto('/login.html');
  await page.waitForSelector('#reg-email', { state: 'visible' });

  // Switch to register tab
  await page.click('.tab[data-tab="register"]');
  await page.waitForSelector('#reg-email', { state: 'visible' });

  await page.fill('#reg-email', email);
  await page.fill('#reg-password', password);

  // Wait for password validation
  await page.waitForTimeout(300);
}

/**
 * Helper: Wait for and return toast/message elements.
 */
async function getMessage(page) {
  const msg = page.locator('.message.show, .toast, .notification');
  if ((await msg.count()) > 0) {
    return await msg.first().textContent();
  }
  return null;
}

module.exports = { test, expect, loginViaUI, registerViaUI, getMessage, TEST_USER };
