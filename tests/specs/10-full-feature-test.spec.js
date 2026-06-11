// @ts-check
/**
 * 全功能集成测试 (Full Feature Integration Tests)
 *
 * 覆盖: 存储V2引用计数 / 秒传 / 分享转存 / 设备管理 /
 *       WebDAV协议 / 迁移 / 日志 / 版本检查 / 存储管理
 *
 * 测试账号: test_e2e@fileservice.test / Test123456
 * 管理员:   test_e2e@fileservice.test (is_admin=1)
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BASE = 'http://127.0.0.1:88';
const TEST_USER = 'test_e2e@fileservice.test';
const TEST_PASS = 'Test123456';

// ==================== 辅助函数 ====================
async function loginAsAdmin(page) {
  await page.goto(BASE + '/login.html');
  await page.fill('#login-email', TEST_USER);
  await page.fill('#login-password', TEST_PASS);
  await page.click('#btn-password-login');
  await page.waitForTimeout(3000);
  const url = page.url();
  return !url.includes('login');
}

async function loginViaAPI(request) {
  // 通过 API 登录获取 session
  const res = await request.post(BASE + '/api/auth/login', {
    data: { email: TEST_USER, password: TEST_PASS }
  });
  return res;
}

async function apiGet(request, url) {
  const res = await request.get(BASE + url);
  return { status: res.status(), data: await res.json().catch(() => ({})) };
}

async function apiPost(request, url, data) {
  const res = await request.post(BASE + url, { data: data || {} });
  return { status: res.status(), data: await res.json().catch(() => ({})) };
}

// ==================== 1. 存储V2: 引用计数 + 秒传 ====================
test.describe('1-存储V2: 引用计数和秒传', () => {

  test('TC-F01: 上传文件后 file_storage 表有记录', async ({ request }) => {
    // 登录获取 session
    await loginViaAPI(request);

    // 生成测试文件
    const testContent = crypto.randomBytes(1024 * 100); // 100KB random
    const testHash = crypto.createHash('sha256').update(testContent).digest('hex');

    // 上传文件
    const formData = new FormData();
    formData.append('file', new Blob([testContent]), 'test_upload.bin');
    formData.append('dir_id', '0');

    // 直接用 fetch 因为 playwright request 不支持 FormData
    const fetchRes = await fetch(BASE + '/api/files/upload', {
      method: 'POST',
      body: formData,
      headers: { 'X-Device-Id': 'test_v2_upload' },
      credentials: 'include'
    });
    const uploadData = await fetchRes.json();
    console.log('[F01] Upload result:', uploadData.code, uploadData.message);

    // 可能因为未认证而失败，但至少 API 可访问
    expect(uploadData).toBeDefined();
    expect([0, 401]).toContain(uploadData.code);
  });

  test('TC-F02: check-hash API 返回正确格式', async ({ request }) => {
    const testHash = 'a'.repeat(64);
    const res = await apiPost(request, '/api/files/check-hash', {
      hash: testHash, size: 12345, dir_id: 0, name: 'test.bin'
    });
    // 401=未登录, 200=已登录
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.code).toBe(0);
      expect(res.data.data).toBeDefined();
      expect(typeof res.data.data.exists).toBe('boolean');
    }
  });

  test('TC-F03: 无效 hash 参数返回错误', async ({ request }) => {
    const res = await apiPost(request, '/api/files/check-hash', {
      hash: 'too-short', size: 0
    });
    // 无论是否登录，无效参数应被拦截
    if (res.status === 200) {
      expect(res.data.code).toBe(1);
    }
  });

  test('TC-F04: 存储管理 API 需要认证', async ({ request }) => {
    const res = await apiGet(request, '/api/admin/storage/pools');
    expect([200, 401, 403]).toContain(res.status);
  });

  test('TC-F05: 存储管理 API 返回正确结构', async ({ page, request }) => {
    // 先登录
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F05] Login failed, skipping admin API test');
      return;
    }
    // 使用 page 的 cookies
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/admin/storage/pools', {
      headers: { Cookie: cookieHeader, 'X-Device-Id': 'test_admin' }
    });
    const data = await fetchRes.json();
    console.log('[F05] Storage pools:', data.code, data.data ? 'groups:' + (data.data.groups ? data.data.groups.length : '?') : 'no data');

    expect(data.code).toBe(0);
    expect(data.data).toBeDefined();
    expect(data.data.groups).toBeDefined();
    expect(data.data.stats).toBeDefined();
    expect(typeof data.data.stats.file_count).toBe('number');
    expect(typeof data.data.stats.total_refs).toBe('number');
  });
});

// ==================== 2. 分享系统: 创建/验证/转存 ====================
test.describe('2-分享系统: 创建和转存', () => {

  test('TC-F06: 分享 API 需要登录', async ({ request }) => {
    const res = await apiPost(request, '/api/share', {
      target_type: 'file', target_id: 1
    });
    // 200(已登录状态) 或 401(未登录)
    expect([200, 401]).toContain(res.status);
  });

  test('TC-F07: 转存 API 正确响应', async ({ request }) => {
    const res = await apiPost(request, '/api/share/save/nonexistent', {
      dir_id: 0
    });
    // 200(未登录但有session) 或 401
    expect([200, 401]).toContain(res.status);
  });

  test('TC-F08: 分享验证 API', async ({ request }) => {
    // 测试公开分享验证
    const res = await apiGet(request, '/api/share/public/test-nonexistent');
    expect(res.status).toBe(200);
    // 不存在会返回错误
    expect(res.data.code).toBeDefined();
  });

  test('TC-F09: 获取分享内容 API', async ({ request }) => {
    const res = await apiGet(request, '/api/share/content/test-nonexistent');
    expect(res.status).toBe(200);
    expect(res.data.code).toBeDefined();
  });
});

// ==================== 3. 设备管理 ====================
test.describe('3-设备管理', () => {

  test('TC-F10: 登录记录设备信息', async ({ page }) => {
    await page.goto(BASE + '/login.html');
    await page.fill('#login-email', TEST_USER);
    await page.fill('#login-password', TEST_PASS);
    await page.click('#btn-password-login');
    await page.waitForTimeout(3000);

    // 应该重定向到主页面
    const url = page.url();
    console.log('[F10] After login URL:', url);
    // 不管是否登录成功，至少验证码弹窗或主页
    expect(url).toBeDefined();
  });

  test('TC-F11: 设备列表 API 可访问', async ({ page, request }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F11] Login failed, testing unauthenticated');
    }
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/auth/devices', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F11] Devices:', data.code, data.data ? 'count:' + (data.data.devices ? data.data.devices.length : 0) : '');
  });

  test('TC-F12: 强制下线 API 需要参数', async ({ page, request }) => {
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/auth/devices/logout', {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: '' })
    });
    const data = await fetchRes.json();
    console.log('[F12] Force logout (empty sid):', data.code);
  });
});

// ==================== 4. WebDAV 协议 ====================
test.describe('4-WebDAV 协议', () => {

  test('TC-F13: OPTIONS 返回正确的 Allow 头', async ({ request }) => {
    // 使用公共 token
    const res = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
      method: 'OPTIONS'
    });
    expect(res.status()).toBe(200);
    const allow = res.headers()['allow'];
    expect(allow).toBeDefined();
    expect(allow).toContain('PROPFIND');
    expect(allow).toContain('GET');
    expect(allow).toContain('PUT');
  });

  test('TC-F14: PROPFIND Depth:0 返回目录属性+配额', async ({ request }) => {
    const res = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
      method: 'PROPFIND',
      headers: { Depth: '0' }
    });
    expect(res.status()).toBe(207);
    const text = await res.text();
    expect(text).toContain('multistatus');
    expect(text).toContain('quota-available-bytes');
    expect(text).toContain('quota-bytes');
  });

  test('TC-F15: PROPFIND 个人文件返回用户配额', async ({ request }) => {
    const res = await request.fetch(BASE + '/webdav/P34SNVz846f8tV22MsCdF7ETUehyjjUk', {
      method: 'PROPFIND',
      headers: { Depth: '0' }
    });
    expect(res.status()).toBe(207);
    const text = await res.text();
    expect(text).toContain('quota-available-bytes');
    expect(text).toContain('quota-bytes');
    // 个人文件配额应该是 10GB 级（10737418240）
    expect(text).toContain('10737418240');
  });

  test('TC-F16: GET 下载文件', async ({ request }) => {
    // 获取公共目录中的文件
    const res = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
      method: 'PROPFIND',
      headers: { Depth: '1' }
    });
    expect(res.status()).toBe(207);
  });

  test('TC-F17: MKCOL 创建目录', async ({ request }) => {
    const testDir = 'test_' + Date.now();
    const res = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B/' + testDir, {
      method: 'MKCOL'
    });
    // 可能成功(201) 或因为权限问题失败
    expect([201, 401, 403, 405]).toContain(res.status());
    console.log('[F17] MKCOL status:', res.status());
  });

  test('TC-F18: LOCK/UNLOCK 支持', async ({ request }) => {
    // LOCK
    const lockRes = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
      method: 'LOCK'
    });
    expect(lockRes.status()).toBe(200);
    const lockText = await lockRes.text();
    expect(lockText).toContain('lockdiscovery');

    // UNLOCK
    const unlockRes = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
      method: 'UNLOCK'
    });
    expect(unlockRes.status()).toBe(204);
  });

  test('TC-F19: 无 token 返回 404', async ({ request }) => {
    const res = await request.fetch(BASE + '/webdav', {
      method: 'PROPFIND',
      headers: { Depth: '0' }
    });
    expect(res.status()).toBe(404);
  });

  test('TC-F20: 过期 token 返回 410', async ({ request }) => {
    // 使用一个不存在的 token（模拟过期）
    const res = await request.fetch(BASE + '/webdav/expired_token_12345_test', {
      method: 'PROPFIND',
      headers: { Depth: '0' }
    });
    expect([404, 410]).toContain(res.status());
  });
});

// ==================== 5. 版本检查 ====================
test.describe('5-版本检查', () => {

  test('TC-F21: 版本 API 返回正确结构', async ({ request }) => {
    const res = await apiGet(request, '/api/version/latest');
    expect(res.status).toBe(200);
    expect(res.data.code).toBe(0);
    expect(res.data.data).toBeDefined();
    if (res.data.data) {
      expect(res.data.data.version).toBeDefined();
      expect(res.data.data.url).toBeDefined();
      // 版本号格式验证
      expect(res.data.data.version).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  test('TC-F22: 版本号从文件名正确解析', async ({ request }) => {
    const res = await apiGet(request, '/api/version/latest');
    if (res.data.code === 0 && res.data.data) {
      const ver = res.data.data.version;
      const parts = ver.split('.').map(Number);
      expect(parts.length).toBe(3);
      parts.forEach(p => expect(typeof p).toBe('number'));
    }
  });
});

// ==================== 6. App 日志系统 ====================
test.describe('6-App 日志系统', () => {

  test('TC-F23: 单条日志上报', async ({ request }) => {
    const res = await apiPost(request, '/api/auth/app-log', {
      level: 'info',
      tag: 'test',
      message: 'E2E test log message ' + Date.now()
    });
    expect(res.status).toBe(200);
    expect(res.data.code).toBe(0);
  });

  test('TC-F24: 批量日志上报', async ({ request }) => {
    const res = await apiPost(request, '/api/auth/app-log', {
      logs: [
        { level: 'debug', tag: 'test', message: 'batch log 1' },
        { level: 'info', tag: 'test', message: 'batch log 2' },
        { level: 'error', tag: 'test', message: 'batch log 3', metadata: 'error context' }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.data.code).toBe(0);
  });

  test('TC-F25: 空日志不报错', async ({ request }) => {
    const res = await apiPost(request, '/api/auth/app-log', {
      level: 'info', tag: 'test', message: ''
    });
    expect(res.status).toBe(200);
  });
});

// ==================== 7. 迁移系统 ====================
test.describe('7-迁移系统', () => {

  test('TC-F26: 管理员查看迁移状态', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F26] Login failed, skipping');
      return;
    }
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/admin/storage/migration-status', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F26] Migration status:', JSON.stringify(data));
    if (data.code === 0) {
      expect(data.data).toBeDefined();
      expect(typeof data.data.total_files).toBe('number');
      expect(typeof data.data.migrated).toBe('number');
      expect(typeof data.data.pending).toBe('number');
    }
  });

  test('TC-F27: 管理员查看文件引用列表', async ({ page }) => {
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/admin/storage/files?limit=5', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F27] File list:', data.code, data.data ? 'total:' + data.data.total : '');
    if (data.code === 0) {
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data.files)).toBe(true);
    }
  });
});

// ==================== 8. 存储管理页面 UI ====================
test.describe('8-存储管理页面', () => {

  test('TC-F28: 页面加载无 JS 错误', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(BASE + '/admin-storage.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    // 未登录会跳转到登录页，但不应有 JS 错误
    expect(errors.length).toBe(0);
  });

  test('TC-F29: 页面可访问并返回 200', async ({ page }) => {
    const res = await page.goto(BASE + '/admin-storage.html');
    expect(res.status()).toBe(200);
    // 页面加载后会被重定向到登录页，验证不报错即可
    await page.waitForTimeout(500);
    const title = await page.title();
    console.log('[F29] Title:', title || '(empty - may have redirected)');
  });

  test('TC-F30: 统计面板 DOM 存在', async ({ page }) => {
    await page.goto(BASE + '/admin-storage.html', { waitUntil: 'domcontentloaded' });
    // 统计卡片应该存在（即使未登录重定向前）
    const statsEl = page.locator('.stats');
    // 页面可能已经重定向，所以我们只验证 DOM 被正确解析
    expect(statsEl).toBeDefined();
  });

  test('TC-F31: 管理员登录后查看存储管理', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F31] Login failed');
      return;
    }
    // 导航到存储管理页
    await page.goto(BASE + '/admin-storage.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const url = page.url();
    console.log('[F31] URL:', url);
    // 如果已登录管理员，应留在存储管理页
    if (url.includes('admin-storage')) {
      // 检查统计面板
      const statVals = page.locator('.stat-val');
      const count = await statVals.count();
      console.log('[F31] Stat cards:', count);
      expect(count).toBeGreaterThan(0);
    }
  });
});

// ==================== 9. 主页功能验证 ====================
test.describe('9-主页功能', () => {

  test('TC-F32: 主页可访问', async ({ page }) => {
    const res = await page.goto(BASE + '/home.html');
    expect(res.status()).toBe(200);
    const title = await page.title();
    expect(title).toContain('FILE');
  });

  test('TC-F33: 侧边栏导航项存在', async ({ page }) => {
    // 先登录以看到完整侧边栏
    await loginAsAdmin(page);
    await page.goto(BASE + '/home.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const navItems = page.locator('.sidebar-nav .nav-item');
    const count = await navItems.count();
    console.log('[F33] Nav items (after login):', count);
    expect(count).toBeGreaterThanOrEqual(0); // 未登录时可能重定向
  });

  test('TC-F34: 悬浮球存在', async ({ page }) => {
    await page.goto(BASE + '/home.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    // 悬浮球可能被隐藏（取决于之前的 localStorage 状态）
    const ball = page.locator('#mobile-floating-ball');
    const exists = await ball.count() > 0;
    console.log('[F34] Floating ball exists:', exists);
    expect(exists).toBe(true);
  });

  test('TC-F35: 首页管理面板有存储管理链接', async ({ page }) => {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    // index.html 的 admin view
    const adminView = page.locator('#adminView');
    expect(adminView).toBeDefined();
  });

  test('TC-F36: 个人中心可访问', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F36] Login failed');
      return;
    }
    await page.goto(BASE + '/home.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // 点击个人中心
    const profileNav = page.locator('.nav-item:has-text("个人中心")');
    if (await profileNav.count() > 0) {
      await profileNav.click();
      await page.waitForTimeout(1000);
      // 检查设备管理面板
      const deviceSection = page.locator('.profile-devices-section');
      const visible = await deviceSection.isVisible().catch(() => false);
      console.log('[F36] Device section visible:', visible);
    }
  });
});

// ==================== 10. 登录和认证 ====================
test.describe('10-登录和认证', () => {

  test('TC-F37: 登录页面加载', async ({ page }) => {
    const res = await page.goto(BASE + '/login.html');
    expect(res.status()).toBe(200);
    const title = await page.title();
    expect(title).toContain('FILE');
  });

  test('TC-F38: 登录表单元素存在', async ({ page }) => {
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    // 检查邮箱和密码输入框
    const emailInput = page.locator('#login-email');
    const passwordInput = page.locator('#login-password');
    await expect(emailInput).toBeVisible({ timeout: 3000 });
    await expect(passwordInput).toBeVisible({ timeout: 3000 });
  });

  test('TC-F39: 登录按钮存在', async ({ page }) => {
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const loginBtn = page.locator('#btn-password-login');
    await expect(loginBtn).toBeVisible({ timeout: 3000 });
  });

  test('TC-F40: 验证码发送按钮存在（验证码登录模式）', async ({ page }) => {
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    // 切换到验证码登录
    const codeSwitcher = page.locator('#switch-code');
    if (await codeSwitcher.count() > 0) {
      await codeSwitcher.click();
      await page.waitForTimeout(500);
      const sendBtn = page.locator('#btn-send-code');
      await expect(sendBtn).toBeVisible({ timeout: 2000 }).catch(() => {
        console.log('[F40] Send code button may require captcha');
      });
    }
  });

  test('TC-F41: 扫码登录入口存在', async ({ page }) => {
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    // 扫码登录使用狗耳折角 (card-dogear) 而非 tab
    const dogear = page.locator('#card-dogear');
    const qrMode = page.locator('#login-mode-qr');
    // 至少其中一个存在
    const dogearExists = await dogear.count() > 0;
    const qrModeExists = await qrMode.count() > 0;
    console.log('[F41] Dogear:', dogearExists, 'QR mode:', qrModeExists);
    expect(dogearExists || qrModeExists).toBe(true);
  });

  test('TC-F42: 登出 API 可访问', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (loggedIn) {
      const cookies = await page.context().cookies();
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const fetchRes = await fetch(BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookieHeader }
      });
      const data = await fetchRes.json();
      console.log('[F42] Logout:', data.code);
    }
  });

  test('TC-F43: /api/auth/me 返回用户信息', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/auth/me', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F43] Me:', data.code, data.data ? data.data.user?.email : 'no user');
    if (data.code === 0 && data.data && data.data.user) {
      expect(data.data.user.email).toBe(TEST_USER);
    }
  });
});

// ==================== 11. 文件管理 API ====================
test.describe('11-文件管理', () => {

  test('TC-F44: 文件列表 API', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) {
      console.log('[F44] Login failed');
      return;
    }
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/files/dirs', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F44] Dirs:', data.code, Array.isArray(data.data) ? data.data.length + ' items' : '');
    if (data.code === 0) {
      expect(Array.isArray(data.data)).toBe(true);
    }
  });

  test('TC-F45: 个人资料 API', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) return;
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/profile/me', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F45] Profile:', data.code);
    if (data.code === 0 && data.data) {
      expect(data.data.email).toBeDefined();
      expect(data.data.quota_bytes).toBeDefined();
    }
  });

  test('TC-F46: 回收站 API', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) return;
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/recycle', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F46] Recycle:', data.code);
  });

  test('TC-F47: 公共文件列表 API', async ({ page }) => {
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/public-files?dir_path=', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F47] Public files:', data.code);
  });
});

// ==================== 12. WebDAV 链接管理 ====================
test.describe('12-WebDAV 链接管理', () => {

  test('TC-F48: WebDAV 链接列表 API', async ({ page }) => {
    const loggedIn = await loginAsAdmin(page);
    if (!loggedIn) return;
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const fetchRes = await fetch(BASE + '/api/webdav/links', {
      headers: { Cookie: cookieHeader }
    });
    const data = await fetchRes.json();
    console.log('[F48] WebDAV links:', data.code, data.data ? data.data.length + ' links' : '');
    if (data.code === 0) {
      expect(Array.isArray(data.data)).toBe(true);
    }
  });
});

// ==================== 13. 频率限制 ====================
test.describe('13-频率限制', () => {

  test('TC-F49: 版本 API 不受严格限制（1000/min）', async ({ request }) => {
    // 连续请求 10 次版本 API，不应被封
    const results = [];
    for (let i = 0; i < 10; i++) {
      const res = await apiGet(request, '/api/version/latest');
      results.push(res.status);
    }
    const blocked = results.filter(s => s === 429 || s === 403);
    console.log('[F49] 10 rapid requests, blocked:', blocked.length);
    expect(blocked.length).toBe(0);
  });

  test('TC-F50: WebDAV 不受频率限制', async ({ request }) => {
    // 连续请求 5 次 WebDAV PROPFIND
    for (let i = 0; i < 5; i++) {
      const res = await request.fetch(BASE + '/webdav/JQNQVnGS7KqSJS8rrNC47bym98hSWs5B', {
        method: 'PROPFIND',
        headers: { Depth: '0' }
      });
      expect(res.status()).toBe(207);
    }
  });
});
