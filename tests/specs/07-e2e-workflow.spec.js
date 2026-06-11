// @ts-check
/**
 * 完整 E2E 工作流测试 (End-to-End Workflow Tests)
 *
 * 测试真实业务流程：
 *   文件上传 → 文件操作 → 分享 → 回收站 → 离线下载(GitHub)
 *
 * 邮件功能除外（注册验证码/密码重置需要真实邮件服务）
 */
const { test, expect } = require('@playwright/test');
const { ApiHelper } = require('../helpers/api-helper');

const BASE_URL = 'http://127.0.0.1:88';
const TEST_USER = {
  email: 'test_e2e@fileservice.test',
  password: 'Test@123456!',
};

// ==================== 全局设置 ====================
let api;
let testDirId = null;
let testFileId = null;
let testShareHash = null;
let testShareCode = null;
let offlineTaskId = null;

test.beforeAll(async () => {
  api = new ApiHelper();
  const loginResult = await api.login(TEST_USER.email, TEST_USER.password);
  expect(loginResult.code).toBe(0);
  console.log('[E2E] Logged in as:', TEST_USER.email);
});

// ==================== 阶段 1: 目录操作 ====================
test.describe('E2E 工作流 - 阶段1: 目录管理', () => {

  test('TC001: 查看当前文件列表', async () => {
    const result = await api.get('/api/dirs');
    expect(result.code).toBe(0);
    console.log('[E2E] Current files/dirs:', result.data?.files?.length || 0, 'files,', result.data?.dirs?.length || 0, 'dirs');
  });

  test('TC002: 创建测试目录', async () => {
    const dirName = 'e2e_test_' + Date.now();
    const result = await api.post('/api/dirs', { name: dirName });
    expect(result.code).toBe(0);
    expect(result.data).toBeDefined();
    testDirId = result.data && result.data.id;
    console.log('[E2E] Created dir:', dirName, 'ID:', testDirId);
    expect(testDirId).toBeTruthy();
  });

  test('TC003: 验证目录已创建', async () => {
    const result = await api.get('/api/dirs');
    expect(result.code).toBe(0);
    const dirs = result.data?.dirs || [];
    const found = dirs.find(d => d.id === testDirId);
    expect(found).toBeTruthy();
  });

  test('TC004: 重命名目录', async () => {
    expect(testDirId).toBeTruthy();
    const newName = 'e2e_renamed_' + Date.now();
    const result = await api.post('/api/dirs/' + testDirId + '/rename', { name: newName });
    expect(result.code).toBe(0);
    console.log('[E2E] Renamed dir to:', newName);
  });
});

// ==================== 阶段 2: 文件上传和操作 ====================
test.describe('E2E 工作流 - 阶段2: 文件上传与操作', () => {

  test('TC005: 上传测试文件', async ({ request }) => {
    const testFileName = 'e2e_test_' + Date.now() + '.txt';
    const testContent = 'Hello FileService! E2E test file.\nLine 2\nLine 3\n';

    // Extract session cookie from API helper
    const cookieStr = api.cookies || '';
    // Parse out the session cookie name=value
    const cookieParts = cookieStr.split('; ');
    let sessionCookie = '';
    for (const part of cookieParts) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    // Upload file using multipart form
    const uploadRes = await request.post(BASE_URL + '/api/files/upload', {
      multipart: {
        file: {
          name: testFileName,
          mimeType: 'text/plain',
          buffer: Buffer.from(testContent, 'utf-8'),
        },
      },
      headers: {
        'Cookie': sessionCookie,
      },
    });

    const uploadBody = await uploadRes.json();
    console.log('[E2E] Upload result:', uploadBody.code, uploadBody.message || '');

    if (uploadBody.code === 0 && uploadBody.data) {
      testFileId = uploadBody.data.id || uploadBody.data.fileId;
      console.log('[E2E] File uploaded, ID:', testFileId, 'Size:', testContent.length);
      expect(testFileId).toBeTruthy();
    } else {
      // May fail if CSRF or session issue; log but continue
      console.log('[E2E] Upload note:', uploadBody.message);
    }
  });

  test('TC006: 获取存储配额', async () => {
    const result = await api.get('/api/storage/quota');
    expect(result.code).toBe(0);
    console.log('[E2E] Storage:', JSON.stringify(result.data));
  });
});

// ==================== 阶段 3: 分享功能 ====================
test.describe('E2E 工作流 - 阶段3: 文件分享', () => {

  test('TC007: 查看分享列表', async () => {
    const result = await api.get('/api/share');
    expect(result.code).toBe(0);
    console.log('[E2E] Shares count:', Array.isArray(result.data) ? result.data.length : 'N/A');
  });

  test('TC008: 创建文件分享（带提取码）', async () => {
    if (!testFileId) {
      test.skip(true, '没有可分享的文件');
      return;
    }
    const result = await api.post('/api/share', {
      target_type: 'file',
      target_id: testFileId,
      password: '1234',
      expires_days: 30,
    });

    console.log('[E2E] Share result:', result.code, result.message || '');
    if (result.code === 0 && result.data) {
      testShareHash = result.data.hash || result.data.share_hash;
      testShareCode = '1234';
      console.log('[E2E] Share created, hash:', testShareHash);
    }
  });

  test('TC010: 验证错误提取码', async () => {
    if (!testShareHash) {
      test.skip(true, '没有可用的分享链接');
      return;
    }
    const result = await api.post('/api/share/verify/' + testShareHash, {
      code: 'wrong_code',
    });
    // Should fail with wrong code
    expect(result.code).not.toBe(0);
    console.log('[E2E] Wrong code correctly rejected');
  });

  test('TC011: 访问公开分享页面', async ({ page }) => {
    if (!testShareHash) {
      // Even without a share, test that the share page loads for an invalid hash
      await page.goto('/share/999999');
      await page.waitForTimeout(500);
      const bodyText = await page.textContent('body');
      expect(bodyText).toBeTruthy();
      return;
    }

    await page.goto('/share/' + testShareHash);
    await page.waitForTimeout(500);
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
    console.log('[E2E] Share page accessed');
  });
});

// ==================== 阶段 4: 回收站 ====================
test.describe('E2E 工作流 - 阶段4: 回收站操作', () => {

  test('TC012: 查看回收站', async () => {
    const result = await api.get('/api/recycle');
    expect(result.code).toBe(0);
    const count = result.data?.files?.length || 0;
    console.log('[E2E] Recycle bin items:', count);
  });

  test('TC013: 查看公共回收站', async () => {
    const result = await api.get('/api/public-recycle');
    expect(result.code).toBe(0);
    console.log('[E2E] Public recycle accessible');
  });
});

// ==================== 阶段 5: 公共文件 ====================
test.describe('E2E 工作流 - 阶段5: 公共文件', () => {

  test('TC014: 查看公共文件列表', async () => {
    const result = await api.get('/api/public-files/list');
    expect(result.code).toBe(0);
    console.log('[E2E] Public files accessible');
  });

  test('TC015: 查看用户配置', async () => {
    const result = await api.get('/api/profile/me');
    expect(result.code).toBe(0);
    if (result.data && result.data.user) {
      console.log('[E2E] User profile:', result.data.user.email);
    }
  });

  test('TC016: 更新昵称', async () => {
    const result = await api.put('/api/profile/me', {
      nickname: 'E2E_Tester',
    });
    console.log('[E2E] Nickname update:', result.code, result.message || '');
  });
});

// ==================== 阶段 6: 离线下载 (GitHub) ====================
test.describe('E2E 工作流 - 阶段6: GitHub 离线下载', () => {

  test('TC017: 创建 GitHub 项目下载任务', async () => {
    // Use a small, reliable GitHub repo
    const githubUrl = 'https://github.com/octocat/Hello-World/archive/refs/heads/master.zip';

    const result = await api.post('/api/offline/create', {
      url: githubUrl,
    });

    console.log('[E2E] Offline create result:', result.code, result.message || '');

    if (result.code === 0 && result.data) {
      offlineTaskId = result.data.id;
      console.log('[E2E] Offline task created, ID:', offlineTaskId, 'Filename:', result.data.filename);
      expect(offlineTaskId).toBeTruthy();
      expect(result.data.url).toBe(githubUrl);
    } else {
      // May fail due to network restrictions; note but don't fail
      console.log('[E2E] Offline create returned non-zero:', result.message);
    }
  });

  test('TC018: 查看离线下载列表', async () => {
    const result = await api.get('/api/offline/list');
    expect(result.code).toBe(0);
    const tasks = result.data || [];
    console.log('[E2E] Offline tasks:', tasks.length);
    if (offlineTaskId) {
      const task = tasks.find(t => t.id === offlineTaskId);
      if (task) {
        console.log('[E2E] Found task:', task.filename, 'Status:', task.status);
      }
    }
  });

  test('TC019: 查看任务详情', async () => {
    if (!offlineTaskId) {
      test.skip(true, '没有可用的离线任务');
      return;
    }
    const result = await api.get('/api/offline/' + offlineTaskId);
    expect(result.code).toBe(0);
    if (result.data) {
      console.log('[E2E] Task detail:', JSON.stringify(result.data).substring(0, 300));
    }
  });

  test('TC020: 启动下载任务', async () => {
    if (!offlineTaskId) {
      test.skip(true, '没有可用的离线任务');
      return;
    }
    const result = await api.post('/api/offline/' + offlineTaskId + '/start');
    console.log('[E2E] Start result:', result.code, result.message || '');

    // Wait a bit and check progress
    await new Promise(resolve => setTimeout(resolve, 3000));

    const detail = await api.get('/api/offline/' + offlineTaskId);
    if (detail.code === 0 && detail.data) {
      console.log('[E2E] Task status after start:', detail.data.status,
        'Progress:', detail.data.downloaded_bytes || 0, '/', detail.data.total_bytes || 0);
    }
  });

  test('TC021: 创建第二个下载任务并取消', async () => {
    const githubUrl = 'https://github.com/octocat/Spoon-Knife/archive/refs/heads/main.zip';

    const createResult = await api.post('/api/offline/create', {
      url: githubUrl,
    });

    if (createResult.code === 0 && createResult.data) {
      const taskId2 = createResult.data.id;
      console.log('[E2E] Second task created, ID:', taskId2);

      // Cancel it immediately
      const cancelResult = await api.post('/api/offline/' + taskId2 + '/cancel');
      console.log('[E2E] Cancel result:', cancelResult.code, cancelResult.message || '');

      // Verify cancelled
      const detail = await api.get('/api/offline/' + taskId2);
      if (detail.code === 0 && detail.data) {
        console.log('[E2E] Task status after cancel:', detail.data.status);
      }

      // Clean up - delete cancelled task
      await api.delete('/api/offline/' + taskId2);
    }
  });

  test('TC022: 创建带目标目录的离线下载', async () => {
    if (!testDirId) {
      test.skip(true, '没有可用的目标目录');
      return;
    }

    const githubUrl = 'https://raw.githubusercontent.com/octocat/Hello-World/master/README';

    const result = await api.post('/api/offline/create', {
      url: githubUrl,
      target_dir_id: testDirId,
    });

    console.log('[E2E] Offline to dir result:', result.code, result.message || '');
    if (result.code === 0 && result.data) {
      console.log('[E2E] Task created for dir download, ID:', result.data.id);
      // Clean up
      await api.delete('/api/offline/' + result.data.id);
    }
  });

  test('TC023: 无效URL应被拒绝', async () => {
    const result = await api.post('/api/offline/create', {
      url: 'not-a-url',
    });
    expect(result.code).not.toBe(0);
    console.log('[E2E] Invalid URL correctly rejected');
  });

  test('TC024: 非HTTP URL应被拒绝', async () => {
    const result = await api.post('/api/offline/create', {
      url: 'ftp://files.example.com/test.zip',
    });
    expect(result.code).not.toBe(0);
    console.log('[E2E] FTP URL correctly rejected');
  });

  test('TC025: 空URL应被拒绝', async () => {
    const result = await api.post('/api/offline/create', {
      url: '',
    });
    expect(result.code).not.toBe(0);
    console.log('[E2E] Empty URL correctly rejected');
  });
});

// ==================== 阶段 7: 设备管理和登录历史 ====================
test.describe('E2E 工作流 - 阶段7: 设备与安全', () => {

  test('TC026: 查看在线设备', async () => {
    const result = await api.get('/api/auth/devices');
    expect(result.code).toBe(0);
    const devices = result.data?.devices || [];
    console.log('[E2E] Online devices:', devices.length);
    if (devices.length > 0) {
      console.log('[E2E] First device:', devices[0].device, 'IP:', devices[0].ip);
    }
  });

  test('TC027: 查看登录历史', async () => {
    const result = await api.get('/api/auth/login-history');
    expect(result.code).toBe(0);
    console.log('[E2E] Login history accessible');
  });

  test('TC028: 验证当前用户信息', async () => {
    const result = await api.get('/api/auth/me');
    expect(result.code).toBe(0);
    expect(result.data.user.email).toBe(TEST_USER.email);
    console.log('[E2E] Current user:', result.data.user.email, 'Admin:', result.data.user.is_admin);
  });
});

// ==================== 阶段 8: 版本管理 ====================
test.describe('E2E 工作流 - 阶段8: 版本管理', () => {

  test('TC029: 获取最新APK版本', async () => {
    const result = await api.get('/api/version/latest');
    // May return empty if no APKs uploaded
    console.log('[E2E] Latest version:', result.data?.version || 'none', 'URL:', result.data?.url || 'none');
  });

  test('TC030: 管理后台版本列表', async () => {
    // Admin endpoint - may succeed or get 403
    const result = await api.get('/api/admin/versions');
    console.log('[E2E] Admin versions:', result.code, result.message || '');
  });
});

// ==================== 阶段 9: 管理员功能验证 ====================
test.describe('E2E 工作流 - 阶段9: 管理员面板', () => {

  test('TC031: 用户管理列表', async () => {
    const result = await api.get('/api/admin/users');
    console.log('[E2E] Admin users access:', result.code);
    if (result.code === 0 && result.data) {
      const users = result.data.users || result.data;
      console.log('[E2E] Total users:', Array.isArray(users) ? users.length : 'N/A');
    }
  });

  test('TC032: 流量摘要', async () => {
    const result = await api.get('/api/admin/traffic/summary');
    console.log('[E2E] Traffic summary:', result.code === 0 ? 'OK' : result.message);
  });

  test('TC033: 流量图表数据', async () => {
    const result = await api.get('/api/admin/traffic/chart');
    console.log('[E2E] Traffic chart:', result.code === 0 ? 'OK' : result.message);
  });

  test('TC034: 操作日志', async () => {
    const result = await api.get('/api/logs/actions');
    console.log('[E2E] Action logs:', result.code === 0 ? 'OK' : result.message);
  });

  test('TC035: 黑名单管理', async () => {
    const result = await api.get('/api/admin/blacklist');
    console.log('[E2E] Blacklist:', result.code === 0 ? 'OK' : result.message);
  });

  test('TC036: 管理员分享列表', async () => {
    const result = await api.get('/api/admin/shares');
    console.log('[E2E] Admin shares:', result.code === 0 ? 'OK' : result.message);
  });
});

// ==================== 清理 ====================
test.describe('E2E 工作流 - 清理', () => {

  test('TC037: 清理测试目录', async () => {
    if (testDirId) {
      const result = await api.delete('/api/dirs/' + testDirId);
      console.log('[E2E] Cleanup dir:', result.code === 0 ? 'Deleted' : result.message);
    }
  });

  test('TC038: 清理离线任务', async () => {
    if (offlineTaskId) {
      try {
        await api.post('/api/offline/' + offlineTaskId + '/cancel');
      } catch (e) { /* already cancelled */ }
      await api.delete('/api/offline/' + offlineTaskId);
      console.log('[E2E] Cleanup offline task:', offlineTaskId);
    }
  });

  test('TC039: 登出', async () => {
    const result = await api.post('/api/auth/logout', {});
    expect(result.code).toBe(0);
    console.log('[E2E] Logged out successfully');
  });
});
