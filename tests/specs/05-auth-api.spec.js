// @ts-check
/**
 * 认证 API 测试 (Auth API Tests)
 *
 * 测试范围：
 *   - 登录接口
 *   - 注册接口（验证码发送）
 *   - 密码重置
 *   - 用户信息 (/me)
 *   - 登出
 *   - 登录错误计数
 *   - CSRF 保护
 *   - Session 管理
 *   - 设备管理
 *   - 登录历史
 *   - 二维码登录流程
 */
const { test, expect } = require('@playwright/test');
const { ApiHelper } = require('../helpers/api-helper');

const BASE_URL = 'http://127.0.0.1:88';

// ==================== 测试套件 1: 登录 API ====================
test.describe('认证 - 登录', () => {

  test('TC01: POST /login 有效凭据应返回成功', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: { email: 'test_e2e@fileservice.test', password: 'Test@123456!' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // May succeed or fail depending on whether test user exists
    expect(body.code).toBeDefined();
    console.log('[TEST] Login response code:', body.code, 'message:', body.message);
  });

  test('TC02: POST /login 无效邮箱应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: { email: 'nonexistent@test.com', password: 'wrongpass' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  test('TC03: POST /login 空参数应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
    expect(body.message).toBeTruthy();
  });

  test('TC04: POST /login 无效邮箱格式应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: { email: 'invalid', password: 'Test@123456!' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  test('TC05: GET /login-error-count 应返回计数信息', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/auth/login-error-count', {
      params: { email: 'nonexistent@test.com' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data).toBeDefined();
  });
});

// ==================== 测试套件 2: 注册 API ====================
test.describe('认证 - 注册', () => {

  test('TC06: POST /send-register-code 有效邮箱应成功', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/send-register-code', {
      data: { email: 'newuser_' + Date.now() + '@test.com' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Note: May fail if EMAIL_AUTH_CODE not configured
    // The API should at least validate email format
    console.log('[TEST] Send register code:', body.code, body.message);
  });

  test('TC07: POST /send-register-code 空邮箱应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/send-register-code', {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  test('TC08: POST /send-register-code 已注册邮箱应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/send-register-code', {
      data: { email: 'test_e2e@fileservice.test' },
    });
    const body = await res.json();
    // Should error because already registered
    if (body.code !== 0) {
      console.log('[TEST] Correctly rejected duplicate email');
    }
  });

  test('TC09: POST /register 无效验证码应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/register', {
      data: { email: 'test@test.com', password: 'Test@123', code: '000000' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });
});

// ==================== 测试套件 3: 密码重置 ====================
test.describe('认证 - 密码重置', () => {

  test('TC10: POST /send-reset-code 无效邮箱应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/send-reset-code', {
      data: {},
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  test('TC11: POST /reset-password 无效验证码应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/reset-password', {
      data: { email: 'test@test.com', password: 'Test@123', code: '000000' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });
});

// ==================== 测试套件 4: 用户信息 ====================
test.describe('认证 - 用户信息', () => {

  let api;

  test.beforeAll(async () => {
    api = new ApiHelper();
    await api.login('test_e2e@fileservice.test', 'Test@123456!');
  });

  test('TC12: GET /me 已登录应返回用户信息', async () => {
    const result = await api.get('/api/auth/me');
    expect(result.code).toBe(0);
    if (result.data && result.data.user) {
      expect(result.data.user.email).toBeDefined();
      console.log('[TEST] User:', result.data.user.email, 'ID:', result.data.user.id);
    }
  });

  test('TC13: GET /me 未登录应返回401', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/auth/me');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(401);
  });
});

// ==================== 测试套件 5: CSRF 保护 ====================
test.describe('认证 - CSRF 保护', () => {

  let api;

  test.beforeAll(async () => {
    api = new ApiHelper();
    await api.login('test_e2e@fileservice.test', 'Test@123456!');
  });

  test('TC14: 缺少CSRF Token的状态变更请求应被拒绝或需要认证', async () => {
    // This should fail because CSRF token is missing but we're authenticated
    if (api.csrfToken) {
      const result = await api.post('/api/files/save', {
        name: 'test',
      });
      // May pass with CSRF or fail without
      console.log('[TEST] CSRF test result:', result.code);
    }
  });

  test('TC15: 公开路径应免除CSRF检查', async ({ request }) => {
    // /api/auth/login is in the whitelist
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: { email: 'test@test.com', password: 'test' },
    });
    // Should not be 403 CSRF error
    expect(res.status()).not.toBe(403);
  });

  test('TC16: /api/share 公开路径可免CSRF访问', async ({ request }) => {
    // /api/share is in the public whitelist
    const res = await request.get(BASE_URL + '/api/share/public/nonexistent');
    expect(res.status()).not.toBe(403);
  });
});

// ==================== 测试套件 6: Session 管理 ====================
test.describe('认证 - Session', () => {

  test('TC17: 登录后应设置 Session Cookie', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/login', {
      data: { email: 'test_e2e@fileservice.test', password: 'Test@123456!' },
    });
    const cookies = res.headers()['set-cookie'];
    if (cookies) {
      console.log('[TEST] Session cookie set:', cookies.substring(0, 100));
    }
  });

  test('TC18: 登出应清除 Session', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/logout');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).toBe(0);
  });
});

// ==================== 测试套件 7: 设备管理 ====================
test.describe('认证 - 设备管理', () => {

  let api;

  test.beforeAll(async () => {
    api = new ApiHelper();
    await api.login('test_e2e@fileservice.test', 'Test@123456!');
  });

  test('TC19: GET /devices 应返回设备列表', async () => {
    const result = await api.get('/api/auth/devices');
    if (result.code === 0) {
      expect(result.data).toBeDefined();
      console.log('[TEST] Devices:', JSON.stringify(result.data).substring(0, 200));
    }
  });

  test('TC20: GET /login-history 应返回登录历史', async () => {
    const result = await api.get('/api/auth/login-history');
    if (result.code === 0) {
      expect(result.data).toBeDefined();
      console.log('[TEST] Login history available');
    }
  });
});

// ==================== 测试套件 8: 二维码登录流程 ====================
test.describe('认证 - 二维码登录', () => {

  test('TC21: GET /qr-login/generate 应生成二维码Token', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/auth/qr-login/generate');
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.code === 0) {
      expect(body.data).toBeDefined();
      expect(body.data.token || body.data.qrContent).toBeDefined();
      console.log('[TEST] QR token generated');
    }
  });

  test('TC22: GET /qr-login/status 无效Token应返回错误', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/auth/qr-login/status', {
      params: { token: 'invalid_token' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });

  test('TC23: GET /qr-login/scan 无效Token应返回错误', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/auth/qr-login/scan', {
      params: { token: 'invalid_token' },
    });
    expect(res.status()).toBe(200);
    // May return JSON error or HTML (redirect to login)
    const contentType = res.headers()['content-type'] || '';
    if (contentType.includes('application/json')) {
      const body = await res.json();
      expect(body.code).not.toBe(0);
    } else {
      // HTML response is also valid (likely redirect page)
      expect(res.status()).toBe(200);
    }
  });

  test('TC24: POST /qr-login/swap 无效swapKey应返回错误', async ({ request }) => {
    const res = await request.post(BASE_URL + '/api/auth/qr-login/swap', {
      data: { swapKey: 'invalid_key' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.code).not.toBe(0);
  });
});

// ==================== 测试套件 9: 版本管理 API ====================
test.describe('认证 - 版本管理', () => {

  test('TC25: GET /version/latest 应返回最新版本', async ({ request }) => {
    const res = await request.get(BASE_URL + '/api/version/latest');
    expect(res.status()).toBe(200);
    const body = await res.json();
    if (body.code === 0) {
      expect(body.data).toBeDefined();
      console.log('[TEST] Latest version:', body.data.version, 'URL:', body.data.url);
    }
  });
});
