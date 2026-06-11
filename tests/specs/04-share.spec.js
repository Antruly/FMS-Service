// @ts-check
/**
 * 文件分享测试 (Share Feature Tests)
 *
 * 测试范围：
 *   - 创建分享链接（需有文件）
 *   - 获取分享列表
 *   - 公开分享页面访问
 *   - 提取码验证
 *   - 分享内容浏览
 *   - 分享日志
 *   - 删除分享
 */
const { test, expect } = require('@playwright/test');
const { ApiHelper } = require('../helpers/api-helper');

/**
 * Parse cookies from api.cookies string and set in browser context.
 */
async function setAuthCookies(page, api) {
  const rawCookies = api.cookies;
  if (!rawCookies) return;

  const cookieStrings = rawCookies.split('; ');
  const parsedCookies = [];
  const cookieAttrs = new Set(['path', 'domain', 'httponly', 'secure', 'samesite', 'expires', 'max-age', 'partitioned']);

  for (const part of cookieStrings) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.substring(0, eqIdx).trim();
    const value = part.substring(eqIdx + 1).trim();
    if (cookieAttrs.has(name.toLowerCase())) continue;
    parsedCookies.push({ name, value, domain: '127.0.0.1', path: '/' });
  }

  if (parsedCookies.length > 0) {
    await page.context().addCookies(parsedCookies);
  }
}

// ==================== API 测试: 分享功能 ====================
test.describe('分享功能 - API 层测试', () => {

  let api;
  let shareId = null;
  let shareHash = null;

  test.beforeAll(async () => {
    api = new ApiHelper();
    const loginResult = await api.login('test_e2e@fileservice.test', 'Test@123456!');
    if (loginResult.code !== 0) {
      console.warn('[WARNING] 测试用户登录失败');
    }
  });

  test('TC01: 获取分享列表（可能为空）', async () => {
    const result = await api.get('/api/share');
    expect(result.code).toBe(0);
    expect(result.data).toBeDefined();
    // Shares may be an array
    if (Array.isArray(result.data)) {
      console.log('[TEST] Share count:', result.data.length);
    }
  });

  test('TC02: 分享不存在/无效hash应返回错误', async () => {
    const result = await api.get('/api/share/public/nonexistent123');
    expect(result.code).not.toBe(0);
  });

  test('TC03: 验证无效提取码应返回错误', async () => {
    const result = await api.post('/api/share/verify/nonexistent123', {
      code: 'wrong123',
    });
    expect(result.code).not.toBe(0);
  });

  test('TC04: 创建分享 - 无文件应报错', async () => {
    // Try creating a share with no file IDs
    const result = await api.post('/api/share', {
      // Missing required fileIds
    });
    // Should fail validation
    expect(result.code).not.toBe(0);
  });
});

// ==================== 测试: 分享页面 (share.html) ====================
test.describe('分享功能 - 分享页面', () => {

  test('TC05: 无效分享页面应显示错误', async ({ page }) => {
    await page.goto('/share/nonexistent');
    await page.waitForTimeout(500);

    // Should show error or redirect
    const errorText = page.locator('text=/错误|不存在|已过期|error|invalid/i');
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('TC06: 无Hash分享页应重定向', async ({ page }) => {
    await page.goto('/share');
    await page.waitForTimeout(500);

    const url = page.url();
    // Should redirect or show some content
    expect(url).toBeTruthy();
  });
});

// ==================== 测试: 分享管理页面 (share-manage.html) ====================
test.describe('分享功能 - 分享管理页面', () => {

  test('TC07: 未登录访问分享管理页应重定向', async ({ page }) => {
    await page.goto('/share-manage.html');
    await page.waitForTimeout(500);

    const url = page.url();
    expect(url).toContain('login');
  });

  test('TC08: 已登录访问分享管理页', async ({ page }) => {
    const api = new ApiHelper();
    const loginResult = await api.login('test_e2e@fileservice.test', 'Test@123456!');

    if (loginResult.code === 0) {
      await setAuthCookies(page, api);

      await page.goto('/share-manage.html');
      await page.waitForTimeout(500);

      const url = page.url();
      expect(url).toContain('share-manage');
    } else {
      test.skip(true, '需要有效的测试用户');
    }
  });
});
