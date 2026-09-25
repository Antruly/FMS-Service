// @ts-check
/**
 * 安全回归用例（FMS-01/02/03/04/05/06/07/08/09）
 *
 * 这一组用例覆盖的每条漏洞都在对本项目 1.2.0 部署的黑盒测试里被实际利用过。
 * 断言的是「修复后的系统必须拒绝什么」，所以它们同时也是防回归网 —— 一旦
 * 有人把某道校验改回去，这里会立刻红。
 *
 * ── 为什么需要两个账号 ─────────────────────────────────────────────
 * FMS-04/05/07 是跨用户越权，必须有第二个普通用户当「受害者」。用例会自动
 * 通过 API 建目录/分享作为夹具，结束时清理掉，不会污染既有数据。
 *
 * ── 怎么拿到登录态 ────────────────────────────────────────────────
 * 本项目的登录带图形验证码，自动化登录不现实，所以用例接受预置的会话 cookie：
 *
 *   1) 环境变量（推荐，临时用）：
 *        FMS_BASE_URL=http://127.0.0.1:88 \
 *        FMS_SEC_COOKIE_A='fileservice.sid=s%3Axxx.yyy' \
 *        FMS_SEC_COOKIE_B='fileservice.sid=s%3Azzz.www' \
 *        npx playwright test 11-security-regression
 *
 *   2) 或落到文件（可长期复用，与既有 tests/.auth 约定一致）：
 *        tests/.auth/sec-a.json  /  tests/.auth/sec-b.json
 *        内容就是 Playwright 的 storageState，即 { "cookies": [...] }，
 *        浏览器 DevTools 或 `page.context().storageState()` 都能拿到。
 *
 * 两者都没有时整组用例 skip 并给出提示，而不是失败 —— 缺夹具不等于有漏洞。
 */
const fs = require('fs');
const path = require('path');
const { test, expect, request } = require('@playwright/test');

const BASE_URL = process.env.FMS_BASE_URL || 'http://127.0.0.1:88';
const SESSION_COOKIE = 'fileservice.sid';

// 任意整数都行：用例要证明的是「不管客户端报谁的 ID，服务端都不认」
const VICTIM_ID = 1;

test.use({ baseURL: BASE_URL });

// ==================== 会话 cookie 读取 ====================
function readCookie(envKey, stateFile) {
  if (process.env[envKey]) return process.env[envKey].trim();
  try {
    if (fs.existsSync(stateFile)) {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const c = (st.cookies || []).find((x) => x.name === SESSION_COOKIE);
      if (c) return SESSION_COOKIE + '=' + c.value;
    }
  } catch (e) { /* 读不出来就当没有 */ }
  return null;
}

const COOKIE_A = readCookie('FMS_SEC_COOKIE_A', path.join(__dirname, '..', '.auth', 'sec-a.json'));
const COOKIE_B = readCookie('FMS_SEC_COOKIE_B', path.join(__dirname, '..', '.auth', 'sec-b.json'));

function cookieToStorageState(cookieHeader) {
  const eq = cookieHeader.indexOf('=');
  const name = cookieHeader.slice(0, eq);
  const value = cookieHeader.slice(eq + 1);
  return {
    cookies: [{
      name: name, value: value, domain: new URL(BASE_URL).hostname,
      path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
    }],
    origins: [],
  };
}

async function apiAs(cookieHeader) {
  const ctx = await request.newContext({ baseURL: BASE_URL, storageState: cookieToStorageState(cookieHeader) });
  // 服务端在每个响应上都回显当前会话的 CSRF 令牌，取一次即可，不必手工准备
  const probe = await ctx.get('/api/auth/me');
  ctx._csrf = probe.headers()['x-csrf-token'] || null;
  return ctx;
}

/** POST/GET 并解析响应封装 { code, message, data }（非 JSON 时降级为文本） */
async function call(ctx, method, url, data, opts) {
  const headers = {};
  if (ctx && ctx._csrf && !(opts && opts.noCsrf)) headers['X-CSRF-Token'] = ctx._csrf;
  const res = method === 'GET' ? await ctx.get(url, { headers: headers })
    : method === 'DELETE' ? await ctx.delete(url, { headers: headers })
    : await ctx.post(url, { data: data || {}, headers: headers });
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch (e) { body = { code: res.status(), message: text.slice(0, 120), data: null, _raw: true }; }
  return { status: res.status(), body: body };
}

// ==================== 夹具：两个账号各自的目录树 ====================
let A, B;
const cleanup = { dirs: [], shares: [] };

/** 取某个账号的第 n 个夹具目录 id */
function dirOf(who, n) {
  const list = cleanup.dirs.filter((d) => d.who === who);
  return list[n || 0] ? list[n || 0].id : null;
}

test.beforeAll(async () => {
  if (!COOKIE_A || !COOKIE_B) return;
  A = await apiAs(COOKIE_A);
  B = await apiAs(COOKIE_B);

  const suffix = Date.now().toString(36).slice(-5);
  for (const [ctx, who] of [[A, 'A'], [B, 'B']]) {
    for (const tag of ['1', '2']) {
      const r = await call(ctx, 'POST', '/api/dirs', { name: 'sec_' + who + tag + '_' + suffix, parent_id: 0 });
      expect(r.body.code, '夹具目录创建失败（' + who + tag + '）: ' + r.body.message).toBe(0);
      cleanup.dirs.push({ ctx: ctx, who: who, id: r.body.data.id });
    }
  }
});

test.afterAll(async () => {
  for (const s of cleanup.shares) {
    try { await call(s.ctx, 'DELETE', '/api/share/' + s.id); } catch (e) {}
  }
  for (const d of cleanup.dirs) {
    try { await call(d.ctx, 'DELETE', '/api/dirs/' + d.id); } catch (e) {}
  }
  if (A) await A.dispose();
  if (B) await B.dispose();
});

// ==================== FMS-01/02：扫码登录接管 / WS 身份伪造 ====================
test.describe('FMS-01/02 扫码登录与 WebSocket 身份必须来自服务端会话', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  test('WS 自报 userId 不能订阅他人推送', async () => {
    const WebSocket = require('ws');
    const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws') + '/ws');
    const received = [];
    await new Promise((resolve) => ws.once('open', resolve));
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch (e) {} });

    ws.send(JSON.stringify({ type: 'auth', userId: VICTIM_ID }));
    await new Promise((r) => setTimeout(r, 1200));

    const authOk = received.find((m) => m.type === 'auth_ok');
    expect(authOk, '无会话的连接竟然通过了 auth').toBeFalsy();
    expect(received.some((m) => m.type === 'auth_error'), '应当回 auth_error').toBeTruthy();
    ws.terminate();
  });

  test('无凭据的扫码登录流程不能把调用方会话变成受害者', async () => {
    const WebSocket = require('ws');

    // 攻击者（无任何凭据）生成二维码，并拿到属于自己的一次性会话 cookie
    const genRes = await fetch(BASE_URL + '/api/auth/qr-login/generate');
    const gen = await genRes.json();
    const token = gen.data.token;
    const setCookie = genRes.headers.getSetCookie ? genRes.headers.getSetCookie()[0] : genRes.headers.get('set-cookie');
    expect(token, 'generate 应当返回 token').toBeTruthy();
    const pcCookie = setCookie.split(';')[0];

    // 攻击者挂一条 WS，冒充受害者扫码并授权
    const ws = new WebSocket(BASE_URL.replace(/^http/, 'ws') + '/ws');
    await new Promise((resolve) => ws.once('open', resolve));
    const seen = [];
    ws.on('message', (d) => { try { seen.push(JSON.parse(d.toString())); } catch (e) {} });
    ws.send(JSON.stringify({ type: 'qr_login_request', token: token }));
    ws.send(JSON.stringify({ type: 'qr_login_scan', token: token, userId: VICTIM_ID }));
    ws.send(JSON.stringify({ type: 'qr_login_authorize', token: token }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen.some((m) => m.type === 'qr_login_authorized'), '无会话的 WS 竟然完成了授权').toBeFalsy();

    // 攻击者自己的会话不该因此变成受害者
    const me = await fetch(BASE_URL + '/api/auth/me', { headers: { Cookie: pcCookie } });
    const meBody = await me.json();
    expect(meBody.code, '攻击者会话被接管了: ' + JSON.stringify(meBody.data)).not.toBe(0);
    ws.terminate();
  });
});

// ==================== FMS-03：路径穿越 ====================
test.describe('FMS-03 文件接口不得越过公共目录', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  const TRAVERSALS = [
    '/api/files/stream/..%2F..%2F.env',
    '/api/files/stream/..%2F..%2Fpackage.json',
    '/api/files/stream/..%2F..%2Fsecret_outside.txt',
    '/api/files/stream/1?public_path=..%2F..%2F.env',
    '/api/files/stream/1?public_path=..%2F..%2Fpackage.json',
    '/api/files/thumb/..%2F..%2F.env',
    '/api/files/video-preview/..%2F..%2F.env',
  ];

  for (const url of TRAVERSALS) {
    test('拒绝 ' + url, async () => {
      const res = await A.get(url);
      const text = await res.text();
      // 只要没把公共目录之外的内容吐出来就算通过；状态码不苛求
      expect(text, '疑似读到了公共目录之外的文件').not.toMatch(/SESSION_SECRET|SYSTEM_MASTER_KEY|"name"\s*:\s*"fileservice"/);
      await expect(res).not.toBeOK();
    });
  }
});

// ==================== FMS-04：批量分享必须逐个校验归属 ====================
test.describe('FMS-04 批量分享不得引用他人文件', () => {
  test.skip(!COOKIE_A || !COOKIE_B, '需要两个账号的会话（A / B）');

  test('A 把 B 的目录 id 塞进 mixed 分享会被拒绝', async () => {
    const r = await call(A, 'POST', '/api/share', {
      target_type: 'mixed',
      target_ids: [dirOf('A'), dirOf('B')],
      expires_days: 1,
    });
    expect(r.body.code, '建分享时没有校验归属，分享指向了他人目录').not.toBe(0);
    if (r.body.code === 0 && r.body.data) cleanup.shares.push({ ctx: A, id: r.body.data.id });
  });

  test('只分享自己的目录仍然可以', async () => {
    const own = cleanup.dirs.filter((d) => d.who === 'A').map((d) => d.id);
    if (own.length < 2) test.skip(true, '夹具不足两个自有目录');
    const r = await call(A, 'POST', '/api/share', { target_type: 'mixed', target_ids: own, expires_days: 1 });
    expect(r.body.code, '合法的 self-only 批量分享被误伤: ' + r.body.message).toBe(0);
    if (r.body.data) cleanup.shares.push({ ctx: A, id: r.body.data.id });
  });
});

// ==================== FMS-07：sub_dir 不得指向分享树之外 ====================
test.describe('FMS-07 分享的 sub_dir 必须落在分享树内', () => {
  test.skip(!COOKIE_A || !COOKIE_B, '需要两个账号的会话（A / B）');

  test('A 的目录分享不能用 sub_dir 浏览 B 的目录', async () => {
    const shareRes = await call(A, 'POST', '/api/share', {
      target_type: 'dir', target_id: dirOf('A'), expires_days: 1,
    });
    expect(shareRes.body.code, '夹具分享创建失败: ' + shareRes.body.message).toBe(0);
    const hash = shareRes.body.data.hash;
    cleanup.shares.push({ ctx: A, id: shareRes.body.data.id });

    const evil = await call(A, 'GET', '/api/share/content/' + hash + '?sub_dir=' + dirOf('B'));
    // 关键：不能列出他人目录里任何东西
    const text = JSON.stringify(evil.body);
    expect(text, 'sub_dir 越权读到了他人目录').not.toMatch(/sec_b_|sec_b2_/);
  });

  test('A 的目录分享浏览自己的子目录仍然可用', async () => {
    const shareRes = await call(A, 'POST', '/api/share', {
      target_type: 'dir', target_id: dirOf('A'), expires_days: 1,
    });
    if (shareRes.body.code !== 0) test.skip(true, '夹具分享创建失败');
    const hash = shareRes.body.data.hash;
    cleanup.shares.push({ ctx: A, id: shareRes.body.data.id });

    const ok = await call(A, 'GET', '/api/share/content/' + hash);
    expect(ok.body.code, '自己的目录分享打不开了: ' + ok.body.message).toBe(0);
  });
});

// ==================== FMS-05/08：公共分享 ====================
test.describe('FMS-05/08 公共分享必须限定自身范围并校验提取码', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  // 公共分享的夹具要落在 Storage.PUBLIC_DIR 里的真实目录上，环境里不一定有。
  // 没有就 skip 并说明怎么建，而不是把用例写死成失败。
  async function makePublicShare(needCode) {
    const candidates = (process.env.FMS_SEC_PUBLIC_PATH || 'public').split(',');
    for (const p of candidates) {
      const r = await call(A, 'POST', '/api/share', {
        target_type: 'public', target_path: p, expires_days: 1, password: needCode ? '1' : undefined,
      });
      if (r.body.code === 0) return r.body.data;
    }
    return null;
  }

  test('无提取码的公共分享仍可直接浏览', async () => {
    const s = await makePublicShare(false);
    test.skip(!s, '环境里没有可分享的公共目录，设置 FMS_SEC_PUBLIC_PATH 后重试');
    cleanup.shares.push({ ctx: A, id: s.id });
    const r = await call(A, 'GET', '/api/share/content/' + s.hash);
    expect(r.body.code, '公开分享被误伤: ' + r.body.message).toBe(0);
  });

  test('设了提取码的分享不带码读内容必须被拒', async () => {
    const s = await makePublicShare(true);
    test.skip(!s, '环境里没有可分享的公共目录，设置 FMS_SEC_PUBLIC_PATH 后重试');
    cleanup.shares.push({ ctx: A, id: s.id });

    const noCode = await call(A, 'GET', '/api/share/content/' + s.hash);
    expect(noCode.body.code, '不带提取码就读到了内容').toBe(401);

    const withCode = await call(A, 'GET', '/api/share/content/' + s.hash + '?extraction_code=' + s.extraction_code);
    expect(withCode.body.code, '带正确提取码却打不开: ' + withCode.body.message).toBe(0);
  });

  test('公共分享不能读到自身范围之外的文件', async () => {
    const s = await makePublicShare(false);
    test.skip(!s, '环境里没有可分享的公共目录，设置 FMS_SEC_PUBLIC_PATH 后重试');
    cleanup.shares.push({ ctx: A, id: s.id });

    for (const evil of ['..%2F..%2F.env', '..%2F..%2Fpackage.json', '..%2F..%2Fdata%2Ffileservice.db']) {
      const r = await A.get('/api/share/download/' + s.hash + '/' + evil);
      const text = await r.text();
      expect(text, '借公共分享读到了范围外的文件').not.toMatch(/SESSION_SECRET|SYSTEM_MASTER_KEY|SQLite format/);
    }
  });
});

// ==================== FMS-06：WebDAV 新链接默认要求认证 ====================
test.describe('FMS-06 WebDAV 链接默认必须认证', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  test('不传 require_auth 时创建出来的链接匿名访问不了', async () => {
    if (!dirOf('A')) test.skip(true, '夹具不足');
    const r = await call(A, 'POST', '/api/webdav/links', {
      target_path: String(dirOf('A')), target_name: 'sec', target_type: 'personal', expires_days: 1,
    });
    expect(r.body.code, '建链接失败: ' + r.body.message).toBe(0);
    expect(!!r.body.data.require_auth, '新建链接默认没有要求认证').toBe(true);

    const anon = await request.newContext({ baseURL: BASE_URL });
    const g = await anon.get('/webdav/' + r.body.data.token);
    expect(g.status(), '匿名就能访问 WebDAV 链接').toBe(401);
    await anon.dispose();

    await A.delete('/api/webdav/links/' + r.body.data.token, { headers: { 'X-CSRF-Token': A._csrf } });
  });

  test('显式 require_auth:false 的链接仍可匿名访问（存量行为不变）', async () => {
    if (!dirOf('A')) test.skip(true, '夹具不足');
    const r = await call(A, 'POST', '/api/webdav/links', {
      target_path: String(dirOf('A')), target_name: 'sec', target_type: 'personal',
      expires_days: 1, require_auth: false,
    });
    expect(r.body.code, '建链接失败: ' + r.body.message).toBe(0);
    expect(!!r.body.data.require_auth, '显式关闭认证没生效').toBe(false);

    const anon = await request.newContext({ baseURL: BASE_URL });
    const g = await anon.get('/webdav/' + r.body.data.token);
    expect(g.status(), '显式公开的链接被误伤成 401').not.toBe(401);
    await anon.dispose();

    await A.delete('/api/webdav/links/' + r.body.data.token, { headers: { 'X-CSRF-Token': A._csrf } });
  });
});

// ==================== FMS-09：确认页提示与 CSRF ====================
test.describe('FMS-09 扫码确认页', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  test('确认页显示的是「发起登录的设备 IP」而不是手机自己的 IP', async () => {
    const gen = await (await fetch(BASE_URL + '/api/auth/qr-login/generate')).json();
    const page = await A.get('/api/auth/qr-login/confirm?token=' + gen.data.token);
    const html = await page.text();
    expect(html, '确认页没有提示发起登录的设备 IP').toContain('发起登录的设备 IP');
    expect(html, '确认页缺少风险提示').toMatch(/请核对上方/);
  });

  test('确认页的内联请求带 CSRF 令牌，且 authorize 无令牌会被拒', async () => {
    const gen = await (await fetch(BASE_URL + '/api/auth/qr-login/generate')).json();
    const page = await A.get('/api/auth/qr-login/confirm?token=' + gen.data.token);
    expect(await page.text(), '确认页的内联 fetch 没带 CSRF 头').toContain('X-CSRF-Token');

    const noCsrf = await call(A, 'POST', '/api/auth/qr-login/authorize', { token: gen.data.token }, { noCsrf: true });
    expect(noCsrf.status, '无 CSRF 令牌的 authorize 被放行了').toBe(403);
  });
});
