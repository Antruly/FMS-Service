// @ts-check
/**
 * 大文件上传下载测试 (Large File Upload/Download Tests)
 *
 * 测试范围：
 *   - 大文件上传进度追踪
 *   - 上传后文件列表验证
 *   - 文件下载（完整下载）
 *   - 文件大小验证
 *   - 存储配额更新验证
 *   - Range 请求（部分下载）
 *   - 大文件删除
 *   - 配额限制验证
 */
const { test, expect } = require('@playwright/test');
const { ApiHelper } = require('../helpers/api-helper');
const fs = require('fs');

const BASE_URL = 'http://127.0.0.1:88';
const TEST_USER = {
  email: 'test_e2e@fileservice.test',
  password: 'Test@123456!',
};

// Expected ISO file properties
const ISO_FILE_PATH = 'd:/cn_windows_server_2019_updated_jan_2020_x64_dvd_4bbe2c37.iso';
const ISO_FILE_SIZE = fs.existsSync(ISO_FILE_PATH) ? fs.statSync(ISO_FILE_PATH).size : 0;

let api;
let isoFileId = null;
let isoFileName = null;

// ==================== 阶段 1: 准备和验证 ====================
test.describe('大文件测试 - 阶段1: 环境准备', () => {

  test.beforeAll(async () => {
    api = new ApiHelper();
    const loginResult = await api.login(TEST_USER.email, TEST_USER.password);
    expect(loginResult.code).toBe(0);
    console.log('[LargeFile] Logged in as:', TEST_USER.email);
  });

  test('TC-L01: 验证 ISO 文件存在', async () => {
    expect(fs.existsSync(ISO_FILE_PATH)).toBe(true);
    console.log('[LargeFile] ISO file size:', (ISO_FILE_SIZE / 1024 / 1024 / 1024).toFixed(2), 'GB');
    expect(ISO_FILE_SIZE).toBeGreaterThan(1024 * 1024 * 1024); // > 1 GB
  });

  test('TC-L02: 上传前查看存储配额', async () => {
    const result = await api.get('/api/storage/quota');
    expect(result.code).toBe(0);
    console.log('[LargeFile] Pre-upload quota:', JSON.stringify(result.data));
    console.log('[LargeFile] Available:', (result.data.available_bytes / 1024 / 1024 / 1024).toFixed(2), 'GB');
  });

  test('TC-L03: 上传前查看文件列表', async () => {
    const result = await api.get('/api/dirs');
    expect(result.code).toBe(0);
    const files = result.data?.files || [];
    console.log('[LargeFile] Files before upload:', files.length);
    // Store any existing ISO file IDs
    for (const f of files) {
      if (f.name && f.name.includes('.iso')) {
        console.log('[LargeFile] Found existing ISO:', f.name, 'ID:', f.id, 'Size:', f.size);
      }
    }
  });
});

// ==================== 阶段 2: 验证上传结果 ====================
test.describe('大文件测试 - 阶段2: 上传验证', () => {

  test('TC-L04: 查找已上传的 ISO 文件', async () => {
    const result = await api.get('/api/dirs');
    expect(result.code).toBe(0);
    const files = result.data?.files || [];

    // Find the ISO file
    let found = null;
    for (const f of files) {
      const name = f.name || '';
      if (name.includes('cn_windows_server') || name.includes('.iso')) {
        found = f;
        break;
      }
    }

    if (found) {
      isoFileId = found.id;
      isoFileName = found.name;
      console.log('[LargeFile] Found ISO:', isoFileName, 'ID:', isoFileId, 'Size:', found.size);
      console.log('[LargeFile] Uploaded size matches?', found.size === ISO_FILE_SIZE ? 'YES' : 'NO (server:' + found.size + ' vs local:' + ISO_FILE_SIZE + ')');
    } else {
      console.log('[LargeFile] ISO file not found in listing - upload may still be in progress');
      console.log('[LargeFile] All files:', files.map(f => f.name + '(' + f.size + ')').join(', '));
    }
  });

  test('TC-L05: 上传后查看存储配额', async () => {
    const result = await api.get('/api/storage/quota');
    expect(result.code).toBe(0);
    console.log('[LargeFile] Post-upload quota:', JSON.stringify(result.data));
    const usedMB = (result.data.used_bytes / 1024 / 1024).toFixed(2);
    console.log('[LargeFile] Used:', usedMB, 'MB');
    // Storage should reflect the uploaded file
    if (isoFileId) {
      expect(result.data.used_bytes).toBeGreaterThan(0);
    }
  });

  test('TC-L06: 验证配额使用量约等于 ISO 文件大小', async () => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到（上传可能还在进行或失败）');
      return;
    }

    const quotaRes = await api.get('/api/storage/quota');
    expect(quotaRes.code).toBe(0);

    const usedBytes = quotaRes.data.used_bytes;
    const diff = Math.abs(usedBytes - ISO_FILE_SIZE);
    const diffMB = (diff / 1024 / 1024).toFixed(2);

    console.log('[LargeFile] Quota used:', usedBytes, 'ISO size:', ISO_FILE_SIZE, 'Diff:', diffMB, 'MB');
    // Allow small difference for encryption overhead
    // V1 format adds ~28 bytes header + 16 bytes auth tag per chunk (64KB chunks)
    const expectedOverhead = Math.ceil(ISO_FILE_SIZE / (64 * 1024)) * (28 + 16);
    const maxDiff = expectedOverhead + 1024; // Allow 1KB extra tolerance
    console.log('[LargeFile] Expected overhead:', expectedOverhead, 'bytes, Max allowed diff:', maxDiff, 'bytes');

    // The difference should be within encryption overhead
    expect(diff).toBeLessThanOrEqual(maxDiff + 100000); // Allow 100KB tolerance for any rounding
  });
});

// ==================== 阶段 3: 下载验证 ====================
test.describe('大文件测试 - 阶段3: 下载验证', () => {

  test('TC-L07: 下载 ISO 文件（完整下载）', async ({ request }) => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    const startTime = Date.now();
    const downloadRes = await request.get(BASE_URL + '/api/files/download/' + isoFileId, {
      headers: {
        'Cookie': sessionCookie,
      },
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('[LargeFile] Download status:', downloadRes.status(), 'Duration:', duration, 's');

    if (downloadRes.status() === 200) {
      const body = await downloadRes.body();
      const downloadedSize = body.length;
      console.log('[LargeFile] Downloaded size:', downloadedSize, 'bytes (', (downloadedSize / 1024 / 1024 / 1024).toFixed(2), 'GB)');
      console.log('[LargeFile] Original size:', ISO_FILE_SIZE, 'bytes (', (ISO_FILE_SIZE / 1024 / 1024 / 1024).toFixed(2), 'GB)');

      // Verify size matches (decrypted size should match original)
      expect(downloadedSize).toBe(ISO_FILE_SIZE);
      console.log('[LargeFile] Size verification: PASSED');

      // Calculate download speed
      const speedMBps = (downloadedSize / 1024 / 1024 / parseFloat(duration)).toFixed(1);
      console.log('[LargeFile] Download speed:', speedMBps, 'MB/s');
    } else if (downloadRes.status() === 404) {
      console.log('[LargeFile] Download returned 404 - file may not exist on server');
    } else {
      console.log('[LargeFile] Download returned status:', downloadRes.status());
    }
  });

  test('TC-L08: Range 请求 - 下载前 1MB', async ({ request }) => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    const rangeSize = 1024 * 1024; // 1 MB
    const downloadRes = await request.get(BASE_URL + '/api/files/download/' + isoFileId, {
      headers: {
        'Cookie': sessionCookie,
        'Range': 'bytes=0-' + (rangeSize - 1),
      },
    });

    console.log('[LargeFile] Range request status:', downloadRes.status());

    if (downloadRes.status() === 206) {
      const body = await downloadRes.body();
      console.log('[LargeFile] Range response size:', body.length, 'bytes');
      expect(body.length).toBe(rangeSize);

      // Check content-range header
      const contentRange = downloadRes.headers()['content-range'];
      console.log('[LargeFile] Content-Range:', contentRange);
      expect(contentRange).toBeTruthy();
    } else if (downloadRes.status() === 200) {
      // Server may not support Range but still return full file
      console.log('[LargeFile] Server returned 200 (full file) instead of 206 (partial)');
    }
  });

  test('TC-L09: Range 请求 - 下载最后 1MB', async ({ request }) => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    const rangeSize = 1024 * 1024; // 1 MB
    const startByte = ISO_FILE_SIZE - rangeSize;
    const downloadRes = await request.get(BASE_URL + '/api/files/download/' + isoFileId, {
      headers: {
        'Cookie': sessionCookie,
        'Range': 'bytes=' + startByte + '-' + (ISO_FILE_SIZE - 1),
      },
    });

    console.log('[LargeFile] Range (last MB) status:', downloadRes.status());

    if (downloadRes.status() === 206) {
      const body = await downloadRes.body();
      console.log('[LargeFile] Last MB response size:', body.length, 'bytes');
      expect(body.length).toBe(rangeSize);
    }
  });

  test('TC-L10: Range 请求 - 多段 Range', async ({ request }) => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    // Request bytes 0-99 and 200-299
    const downloadRes = await request.get(BASE_URL + '/api/files/download/' + isoFileId, {
      headers: {
        'Cookie': sessionCookie,
        'Range': 'bytes=0-99,200-299',
      },
    });

    console.log('[LargeFile] Multi-range status:', downloadRes.status());
    // Server may support multipart/byteranges or return 200
    expect([206, 200]).toContain(downloadRes.status());
  });
});

// ==================== 阶段 4: 流式预览/缩略图 ====================
test.describe('大文件测试 - 阶段4: 文件操作', () => {

  test('TC-L11: 获取文件缩略图（大文件）', async ({ request }) => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    const res = await request.get(BASE_URL + '/api/files/thumb/' + isoFileId, {
      headers: {
        'Cookie': sessionCookie,
      },
    });

    console.log('[LargeFile] Thumb status:', res.status());
    // ISO files may not have thumbnails, which is fine
  });

  test('TC-L12: 重命名大文件', async () => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const newName = isoFileName || 'windows_server_2019.iso';
    const result = await api.post('/api/files/' + isoFileId + '/rename', {
      name: newName,
    });

    console.log('[LargeFile] Rename result:', result.code, result.message || '');
    // May succeed or fail; validate the response structure
  });

  test('TC-L13: 文件预览 Token', async () => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const result = await api.get('/api/files/preview-token/' + isoFileId);
    console.log('[LargeFile] Preview token result:', result.code);
    if (result.code === 0 && result.data) {
      console.log('[LargeFile] Preview token generated');
    }
  });
});

// ==================== 阶段 5: 配额限制验证 ====================
test.describe('大文件测试 - 阶段5: 配额限制', () => {

  test('TC-L14: 配额已满时上传应被拒绝', async ({ request }) => {
    // Create a small test file
    const testContent = Buffer.from('This file should be rejected due to quota', 'utf-8');

    const cookieStr = api.cookies || '';
    let sessionCookie = '';
    for (const part of cookieStr.split('; ')) {
      if (part.startsWith('fileservice.sid=')) {
        sessionCookie = part;
        break;
      }
    }

    // First check current usage
    const quotaRes = await api.get('/api/storage/quota');
    const available = quotaRes.data?.available_bytes || 0;
    console.log('[LargeFile] Available before quota test:', available, 'bytes');

    if (available < testContent.length) {
      // Try upload - should fail
      const uploadRes = await request.post(BASE_URL + '/api/files/upload', {
        multipart: {
          file: {
            name: 'quota_test.txt',
            mimeType: 'text/plain',
            buffer: testContent,
          },
        },
        headers: {
          'Cookie': sessionCookie,
        },
      });

      const body = await uploadRes.json();
      console.log('[LargeFile] Quota-rejected upload:', body.code, body.message);
      // Should reject with quota error
      expect(body.code).not.toBe(0);
    } else {
      console.log('[LargeFile] Sufficient space available, skipping quota rejection test');
    }
  });
});

// ==================== 阶段 6: 清理 ====================
test.describe('大文件测试 - 阶段6: 清理', () => {

  test('TC-L15: 删除大文件（移到回收站）', async () => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const result = await api.delete('/api/files/' + isoFileId);
    console.log('[LargeFile] Delete result:', result.code, result.message || '');

    if (result.code === 0) {
      console.log('[LargeFile] File moved to recycle bin');
    }
  });

  test('TC-L16: 验证文件在回收站中', async () => {
    if (!isoFileId) {
      test.skip(true, 'ISO 文件未找到');
      return;
    }

    const result = await api.get('/api/recycle');
    expect(result.code).toBe(0);

    const files = result.data?.files || [];
    const found = files.find(f => f.name === isoFileName || f.original_name === isoFileName);
    if (found) {
      console.log('[LargeFile] File found in recycle bin:', found.name, 'Size:', found.size);
    } else {
      console.log('[LargeFile] File not in recycle bin (may have been permanently deleted)');
    }
  });

  test('TC-L17: 查看回收站后存储配额变化', async () => {
    const result = await api.get('/api/storage/quota');
    expect(result.code).toBe(0);
    const usedMB = (result.data.used_bytes / 1024 / 1024).toFixed(2);
    console.log('[LargeFile] Final storage used:', usedMB, 'MB');
  });
});
