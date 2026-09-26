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
// 管理员会话：FMS-10 的写入上限（靠 /api/admin/app-logs 数行）与 FMS-14 的 order
// 注入（/api/logs/actions 是 requireAdmin）都需要它。没有就 skip，不假装通过。
const COOKIE_ADMIN = readCookie('FMS_SEC_COOKIE_ADMIN', path.join(__dirname, '..', '.auth', 'sec-admin.json'));

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
let A, B, ADMIN;
const cleanup = { dirs: [], shares: [], offline: [], webdav: [], publicFiles: [] };

/** 取某个账号的第 n 个夹具目录 id */
function dirOf(who, n) {
  const list = cleanup.dirs.filter((d) => d.who === who);
  return list[n || 0] ? list[n || 0].id : null;
}

test.beforeAll(async () => {
  if (COOKIE_ADMIN) ADMIN = await apiAs(COOKIE_ADMIN);
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
  for (const o of cleanup.offline) {
    try { await call(o.ctx, 'DELETE', '/api/offline/' + o.id); } catch (e) {}
  }
  for (const w of cleanup.webdav) {
    try {
      await w.ctx.delete('/api/webdav/links/' + w.token, { headers: { 'X-CSRF-Token': w.ctx._csrf } });
    } catch (e) {}
  }
  for (const s of cleanup.shares) {
    try { await call(s.ctx, 'DELETE', '/api/share/' + s.id); } catch (e) {}
  }
  for (const d of cleanup.dirs) {
    try { await call(d.ctx, 'DELETE', '/api/dirs/' + d.id); } catch (e) {}
  }
  if (A) await A.dispose();
  if (B) await B.dispose();
  if (ADMIN) await ADMIN.dispose();
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

// ============================================================================
// 第二批（1.2.3）：FMS-10/11/12/13/14/15/17 + FMS-03 同族路径校验收敛
// ============================================================================

// ==================== FMS-17：免鉴权泄露服务器绝对路径 ====================
test.describe('FMS-17 调试路由不得泄露服务器绝对路径', () => {
  test('已删除的 /api/admin/version/test 匿名访问返回 404', async () => {
    const anon = await request.newContext({ baseURL: BASE_URL });
    const r = await anon.get('/api/admin/version/test');
    expect(r.status(), '调试路由仍然存在').toBe(404);
    const text = await r.text();
    expect(text, '响应里出现了绝对路径').not.toMatch(/[A-Za-z]:[\\/]/);
    await anon.dispose();
  });
});

// ==================== FMS-10：匿名 App 日志上报 ====================
test.describe('FMS-10 匿名 App 日志上报必须被拒绝', () => {
  test('匿名单条上报被拒', async () => {
    const anon = await request.newContext({ baseURL: BASE_URL });
    const r = await anon.post('/api/auth/app-log', {
      data: { level: 'info', tag: 'sec', message: 'anon-single-' + Date.now() },
    });
    const b = await r.json();
    expect(b.code, '匿名日志上报竟然被接受了').toBe(401);
    await anon.dispose();
  });

  test('匿名批量上报被拒', async () => {
    const anon = await request.newContext({ baseURL: BASE_URL });
    const r = await anon.post('/api/auth/app-log', {
      data: { logs: [{ level: 'error', tag: 'sec', message: 'anon-batch-' + Date.now() }] },
    });
    const b = await r.json();
    expect(b.code, '匿名批量上报竟然被接受了').toBe(401);
    await anon.dispose();
  });
});

// ==================== FMS-10 上限（需管理员会话） ====================
test.describe('FMS-10 单次上报的写入上限', () => {
  test.skip(!COOKIE_ADMIN, '未提供 FMS_SEC_COOKIE_ADMIN / tests/.auth/sec-admin.json');

  test('一次塞 600 条只会落 50 条，且如实告知被截断', async () => {
    const tag = 'sec-cap-' + Date.now().toString(36);
    const logs = [];
    for (let i = 0; i < 600; i++) logs.push({ level: 'info', tag: tag, message: 'cap-' + i });

    const r = await call(ADMIN, 'POST', '/api/auth/app-log', { logs });
    expect(r.body.code, '超量上报应当返回截断提示 code=1').toBe(1);
    expect(r.body.data.written, '实际写入量不是上限 50').toBe(50);

    // 用管理端接口反查落库行数（tag 唯一，只可能是这次写的）
    // 注意：auth 路由挂在 /api/auth 下，所以这条是 /api/auth/admin/app-logs
    const listed = await call(ADMIN, 'GET', '/api/auth/admin/app-logs?limit=200&offset=0');
    const mine = (listed.body.data.logs || []).filter((l) => l.tag === tag);
    expect(mine.length, '实际落库行数超过上限: ' + mine.length).toBeLessThanOrEqual(50);
    expect(mine.length, '一条都没落库').toBeGreaterThan(0);
  });

  test('超长 message / 非法 level / 非法 device-id 都被规范化', async () => {
    const r = await call(ADMIN, 'POST', '/api/auth/app-log', {
      level: 'NOT-A-LEVEL',
      tag: 'x'.repeat(500),
      message: 'y'.repeat(10000),
      metadata: { nested: true },
    });
    expect(r.body.code, '合法请求被拒了: ' + r.body.message).toBe(0);
    expect(r.body.data.written, '对象型 metadata 让整行写失败了').toBe(1);
  });
});

// ==================== FMS-11：升级包解包 zip-slip ====================
test.describe('FMS-11 升级包解包不得写出目标目录', () => {
  test('含 ../../ 等越界条目的 zip 解包后不产生目录外文件', async () => {
    // eslint-disable-next-line global-require
    const AdmZip = require('adm-zip');
    const os = require('os');
    // extractRelease 原先没有导出，这次为可测性补上了导出（lib/upgrade.js）
    // eslint-disable-next-line global-require
    const upgrade = require('../../lib/upgrade');

    const base = path.join(os.tmpdir(), 'fms-zipslip-spec-' + Date.now());
    const extractDir = path.join(base, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });

    const markRel = 'pwned-spec-' + Date.now() + '.txt';
    const zipPath = path.join(base, 'evil.zip');
    const zip = new AdmZip();
    zip.addFile('good.txt', Buffer.from('legit'));
    // 第一个条目必须是普通名（否则顶层目录剥离逻辑会介入）。adm-zip 的 addFile 会把
    // ../../ 净化掉（utils.zipnamefix），所以要在 writeZip 之前直接改写 entryName。
    const evil = [
      { name: '../../' + markRel, data: 'escaped' },
      { name: '../evil_dir/', data: '' },
      { name: '/abs-' + markRel, data: 'abs' },
      { name: 'sub/ok.txt', data: 'nested-ok' },
    ];
    evil.forEach((e) => zip.addFile(e.name, Buffer.from(e.data)));
    const entries = zip.getEntries();
    for (let i = 1; i < entries.length; i++) entries[i].entryName = evil[i - 1].name;
    zip.writeZip(zipPath);

    try {
      await upgrade.extractRelease(zipPath, extractDir);

      // 合法条目必须还在（否则是"修坏了"而不是"修好了"）
      expect(fs.existsSync(path.join(extractDir, 'good.txt')), '合法顶层文件没解出来').toBe(true);
      expect(fs.existsSync(path.join(extractDir, 'sub', 'ok.txt')), '合法嵌套文件没解出来').toBe(true);

      // extractDir 之外不得有新文件
      expect(fs.existsSync(path.join(base, '..', markRel)), '越界条目写出了目标目录: ' + markRel).toBe(false);
      expect(fs.existsSync(path.join('/abs-' + markRel)), '绝对路径条目被写出了').toBe(false);
      expect(fs.existsSync(path.join(extractDir, 'evil_dir')), '越界目录条目被创建了').toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// ==================== FMS-15：分享码 / WebDAV token 的随机源 ====================
// 说明：黑盒无法证明"用的是 CSPRNG"，这里只能钉死形状（长度/字符集）防回归，
// 真正的证明在代码审查（lib/db.js 的 randomString + crypto.randomBytes）。
const SHARE_CHARS_RE = /^[A-HJ-NP-Za-km-z2-9]+$/;   // 与 lib/db.js 的 SHARE_CHARS 同集（去 I/O/l/0/1）

test.describe('FMS-15 分享码与 WebDAV token 的形状', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  test('分享码 8 位、提取码 4 位，且都落在 55 字符集内', async () => {
    if (!dirOf('A')) test.skip(true, '夹具不足');
    const r = await call(A, 'POST', '/api/share', {
      target_type: 'dir', target_id: dirOf('A'), expires_days: 1, password: true,
    });
    expect(r.body.code, '建分享失败: ' + r.body.message).toBe(0);
    cleanup.shares.push({ ctx: A, id: r.body.data.id });

    const hash = r.body.data.hash;
    expect(hash, '分享码长度不是 8: ' + hash).toHaveLength(8);
    expect(hash, '分享码字符越界: ' + hash).toMatch(SHARE_CHARS_RE);

    const code = r.body.data.extraction_code;
    if (code) {
      expect(code, '提取码长度不是 4: ' + code).toHaveLength(4);
      expect(code, '提取码字符越界: ' + code).toMatch(SHARE_CHARS_RE);
    }
  });

  test('WebDAV token 为 32 位且落在同一字符集内', async () => {
    if (!dirOf('A')) test.skip(true, '夹具不足');
    const r = await call(A, 'POST', '/api/webdav/links', {
      target_path: String(dirOf('A')), target_name: 'sec', target_type: 'personal', expires_days: 1,
    });
    expect(r.body.code, '建 WebDAV 链接失败: ' + r.body.message).toBe(0);
    cleanup.webdav.push({ ctx: A, token: r.body.data.token });
    expect(r.body.data.token, 'token 长度不是 32').toHaveLength(32);
    expect(r.body.data.token, 'token 字符越界').toMatch(SHARE_CHARS_RE);
  });
});

// ==================== FMS-14：操作日志 order 参数注入 ====================
test.describe('FMS-14 操作日志的 order 参数不得拼进 SQL', () => {
  test.skip(!COOKIE_ADMIN, '未提供 FMS_SEC_COOKIE_ADMIN / tests/.auth/sec-admin.json');

  test('order 传注入载荷时降级为 DESC，不报 500', async () => {
    // 必须和 DESC 基线逐行比对，不能只断言"200 + 是数组"。
    // 原因：旧代码把 order 裸拼进 SQL，载荷会让语句变成语法错误，而 lib/db.js 的 query()
    // 把异常吞掉返回 []（实测旧服务：基线 DESC 返回 [94,93,92,91,90]，注入载荷返回 0 行）。
    // 只断言 not-500 的话，'静默空数组' 这种失败形态照样通过，用例就不成立了。
    // 改成比对基线后：静默空数组 ≠ 非空基线 → 旧代码必挂；新代码降级为 DESC → 与基线全等。
    const base = await call(ADMIN, 'GET', '/api/logs/actions?limit=5&order=DESC');
    expect(base.body.code, 'DESC 基线都取不到，用例前提不成立: ' + base.body.message).toBe(0);
    const baseRows = base.body.data.data;
    expect(Array.isArray(baseRows)).toBe(true);
    expect(baseRows.length, '库里没有操作日志，比对基线无意义').toBeGreaterThan(0);
    const baseIds = baseRows.map((x) => x.id);

    const payloads = [
      'id DESC#',             // 注释截断
      'id; DROP TABLE users', // 堆叠语句
      '(SELECT 1)',           // 子查询
      'RANDOM()',             // 非白名单函数
    ];
    for (const p of payloads) {
      const r = await call(ADMIN, 'GET', '/api/logs/actions?limit=5&order=' + encodeURIComponent(p));
      expect(r.status, '注入载荷把接口打成了 ' + r.status + ': ' + p).toBe(200);
      expect(r.body.code, '注入载荷导致失败: ' + p + ' → ' + r.body.message).toBe(0);
      // 该接口的行数组在 data.data（不是 data.logs）
      expect(Array.isArray(r.body.data.data), '返回结构被破坏: ' + p).toBe(true);
      expect(r.body.data.data.map((x) => x.id),
        '注入载荷改变了结果集（载荷真的进了 SQL）: ' + p).toEqual(baseIds);
    }
  });

  test('正常 order=ASC 仍然生效（白名单没把合法值也挡掉）', async () => {
    const asc = await call(ADMIN, 'GET', '/api/logs/actions?limit=2&order=ASC');
    expect(asc.body.code, '合法的 order=ASC 被误伤: ' + asc.body.message).toBe(0);
    expect(Array.isArray(asc.body.data.data)).toBe(true);
  });
});

// ==================== FMS-12/13：离线下载 SSRF ====================
// 这些用例把服务端指向环回地址。注意服务自身就跑在 127.0.0.1:88，
// 所以夹具端口刻意避开 88，用的是 18898（未放行）与 18899（允许清单内）。
const LOOPBACK_BLOCKED_PORT = 18898;
const LOOPBACK_ALLOWED_PORT = 18899;
const BLOCKED_HINT = '不允许访问';

/** 建任务 → 启动 → 轮询到终态；创建阶段就被拒时返回 { createRejected: true } */
async function runOffline(ctx, url, maxWaitMs) {
  const created = await call(ctx, 'POST', '/api/offline/create', { url });
  if (created.body.code !== 0) return { createRejected: true, create: created };
  const id = created.body.data.id;
  cleanup.offline.push({ ctx: ctx, id: id });
  await call(ctx, 'POST', '/api/offline/' + id + '/start');
  const deadline = Date.now() + (maxWaitMs || 15000);
  let detail = null;
  while (Date.now() < deadline) {
    const r = await call(ctx, 'GET', '/api/offline/' + id);
    detail = r.body.data;
    if (detail && ['failed', 'completed', 'cancelled'].indexOf(detail.status) >= 0) break;
    await new Promise((res) => setTimeout(res, 400));
  }
  return { createRejected: false, id: id, task: detail };
}

test.describe('FMS-12 离线下载不得访问内网 / 环回 / 保留地址', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');

  test('IP 字面量形态的内网目标在创建阶段就被拒', async () => {
    const targets = [
      'http://127.0.0.1:' + LOOPBACK_BLOCKED_PORT + '/api/version/latest',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data/',                     // 云元数据
      'http://[::1]:' + LOOPBACK_BLOCKED_PORT + '/',
      'http://[::ffff:7f00:1]:' + LOOPBACK_BLOCKED_PORT + '/',         // IPv4-mapped 十六进制形态
      'http://0.0.0.0/x',
    ];
    for (const u of targets) {
      const r = await call(A, 'POST', '/api/offline/create', { url: u });
      expect(r.body.code, '内网目标未被拦截: ' + u).not.toBe(0);
      expect(r.body.message, '拦截文案不对: ' + u).toContain(BLOCKED_HINT);
    }
  });

  test('域名解析到环回时在连接期被拒（证明 lookup 钩子生效）', async () => {
    // localhost 不是 IP 字面量 → 创建阶段不做 DNS、放行；拦截必须发生在连接期。
    // 这条同时覆盖"IP 字面量会绕过 lookup 钩子"的反面：字面量走上一条预检，域名走 lookup。
    const r = await runOffline(A, 'http://localhost:' + LOOPBACK_BLOCKED_PORT + '/api/version/latest');
    expect(r.createRejected, 'localhost 在创建阶段就被拒了（预检不该做 DNS）').toBe(false);
    expect(r.task, '任务没有到终态').toBeTruthy();
    expect(r.task.status, '解析到环回却没被拦: ' + JSON.stringify(r.task)).toBe('failed');
    expect(r.task.error || '', '失败原因不是拦截文案: ' + r.task.error).toContain(BLOCKED_HINT);
  });
});

test.describe('FMS-13 重定向的每一跳都必须重新校验', () => {
  test.skip(!COOKIE_A, '未提供 FMS_SEC_COOKIE_A / tests/.auth/sec-a.json');
  test.skip(!process.env.FMS_SEC_OFFLINE_ALLOWED_HOST,
    '需要服务端以 OFFLINE_DOWNLOAD_ALLOWED_HOSTS=127.0.0.1:' + LOOPBACK_ALLOWED_PORT + ' 启动');

  test('第一跳在允许清单内、第二跳落到清单外 → 被拒', async () => {
    // eslint-disable-next-line global-require
    const http = require('http');
    const srv = http.createServer((rq, rs) => {
      if (rq.url === '/redirect') {
        rs.writeHead(302, { Location: 'http://127.0.0.1:' + LOOPBACK_BLOCKED_PORT + '/api/version/latest' });
        return rs.end();
      }
      rs.writeHead(200, { 'Content-Type': 'text/plain' });
      return rs.end('ok-' + Date.now());
    });
    await new Promise((res) => srv.listen(LOOPBACK_ALLOWED_PORT, '127.0.0.1', res));
    try {
      const r = await runOffline(A, 'http://127.0.0.1:' + LOOPBACK_ALLOWED_PORT + '/redirect');
      expect(r.createRejected, '允许清单内的目标在创建阶段就被拒了').toBe(false);
      expect(r.task, '任务没有到终态').toBeTruthy();
      expect(r.task.status, '重定向第二跳没被拦: ' + JSON.stringify(r.task)).toBe('failed');
      expect(r.task.error || '', '失败原因不是拦截文案: ' + r.task.error).toContain(BLOCKED_HINT);
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });

  test('允许清单内的目标本身可以下载成功（证明是按规则拦，不是一刀切）', async () => {
    // eslint-disable-next-line global-require
    const http = require('http');
    const srv = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'Content-Type': 'text/plain' });
      rs.end('allowlisted-ok');
    });
    await new Promise((res) => srv.listen(LOOPBACK_ALLOWED_PORT, '127.0.0.1', res));
    try {
      const r = await runOffline(A, 'http://127.0.0.1:' + LOOPBACK_ALLOWED_PORT + '/ok.txt');
      expect(r.task, '任务没有到终态').toBeTruthy();
      expect(r.task.status, '允许清单内的目标被误伤: ' + JSON.stringify(r.task)).toBe('completed');
      if (r.task.file_id) cleanup.publicFiles.push({ ctx: A, id: r.task.file_id });
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });
});

// ==================== FMS-03 同族：路径包含性（前缀兄弟目录） ====================
test.describe('路径包含性不得被前缀兄弟目录绕过', () => {
  test('WebDAV MOVE 的 Destination 指向兄弟目录 → 403', async () => {
    if (!COOKIE_A) test.skip(true, '未提供 FMS_SEC_COOKIE_A');
    // 造一个公共目录链接，baseDir = files/download/<target>。
    // Destination 用 `<baseDir 的上一级>/<target>_evil/x`：
    // 旧写法 destPath.indexOf(baseDir) === 0 会放行（字符串前缀相同），新写法拒绝。
    const target = 'tmp';   // files/download 下已存在
    const created = await call(A, 'POST', '/api/webdav/links', {
      target_path: target, target_name: 'sec', target_type: 'public',
      expires_days: 1, require_auth: false,
    });
    expect(created.body.code, '建公共 WebDAV 链接失败: ' + created.body.message).toBe(0);
    const token = created.body.data.token;
    cleanup.webdav.push({ ctx: A, token: token });

    // 源文件刻意不存在：即使校验被改回去，MOVE 也会先 404，
    // 不会真的把任何东西搬出夹具范围（用例本身不具破坏性）。
    // 因此断言 403 才能把"修好了"和"改回去了"区分开。
    const mv = await A.fetch('/webdav/' + token + '/no-such-source.txt', {
      method: 'MOVE',
      headers: { Destination: BASE_URL + '/webdav/' + token + '/../' + target + '_evil/pwn.txt' },
    });
    expect(mv.status(), '兄弟目录目标没有被拒绝（旧写法会放行 → 404）').toBe(403);
  });

  test('合法子路径仍能正常浏览（公共 WebDAV 根 PROPFIND 不为 403）', async () => {
    if (!COOKIE_A) test.skip(true, '未提供 FMS_SEC_COOKIE_A');
    const created = await call(A, 'POST', '/api/webdav/links', {
      target_path: 'tmp', target_name: 'sec', target_type: 'public',
      expires_days: 1, require_auth: false,
    });
    expect(created.body.code, '建公共 WebDAV 链接失败: ' + created.body.message).toBe(0);
    const token = created.body.data.token;
    cleanup.webdav.push({ ctx: A, token: token });

    const anon = await request.newContext({ baseURL: BASE_URL });
    // subPath 为空 → 走 baseDir 分支，不能被 resolveWithin 的空串返回 null 误伤
    const r = await anon.fetch('/webdav/' + token + '/', { method: 'PROPFIND', headers: { Depth: '1' } });
    expect(r.status(), '根目录 PROPFIND 被误伤成 403').not.toBe(403);
    await anon.dispose();
  });

  test('resolveWithin 的判定与真实包含性一致（含兄弟目录）', () => {
    // eslint-disable-next-line global-require
    const resolveWithin = require('../../lib/validator').resolveWithin;
    const root = path.resolve(__dirname, '..', '..', 'files', 'download');
    const sep = path.sep;

    // 兄弟目录：字符串前缀相同，但真实不在 root 内 → 必须拒绝
    expect(resolveWithin(root, '..' + sep + 'download_evil' + sep + 'x'), '兄弟目录被放行了').toBeNull();
    expect(resolveWithin(root, '..' + sep + '..' + sep + 'x'), '上跳两级被放行了').toBeNull();
    expect(resolveWithin(root, '.' + sep + '..' + sep + 'x'), '绕一圈的上跳被放行了').toBeNull();
    // 绝对路径与 NUL 一律拒绝
    expect(resolveWithin(root, path.resolve(sep, 'etc', 'passwd'))).toBeNull();
    expect(resolveWithin(root, 'a' + String.fromCharCode(0) + 'b')).toBeNull();
    expect(resolveWithin(root, '')).toBeNull();
    // 正常子路径照常放行
    expect(resolveWithin(root, 'sub' + sep + 'ok.txt')).toBe(path.join(root, 'sub', 'ok.txt'));
    expect(resolveWithin(root, 'sub' + sep + '..' + sep + 'ok.txt')).toBe(path.join(root, 'ok.txt'));
    expect(resolveWithin(root, '.')).toBe(root);
  });
});
