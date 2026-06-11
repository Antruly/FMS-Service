var log = require('./lib/log');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/file');
const logRoutes = require('./routes/logs');
const shareRoutes = require('./routes/share');
const versionRoutes = require('./routes/version');
const { initDatabase } = require('./lib/db');
const { User } = require('./lib/db');
const { getSessionStore } = require('./lib/redis');
// 安全导入：如果 lib/utils.js 未更新，使用内联回退
var utils = {};
try { utils = require('./lib/utils'); } catch(e) {}
utils.getClientIp = utils.getClientIp || function(req) {
  var ip = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
};
const wsService = require('./lib/ws');
const webdavRoutes = require('./routes/webdav');
const storageRoutes = require('./routes/storage');

// 让 Express 支持 WebDAV 非常规 HTTP 方法（安全方式）
var methods = require('methods');
['PROPFIND', 'MKCOL', 'MOVE', 'COPY', 'LOCK', 'UNLOCK'].forEach(function(m) {
  try { methods.push(m.toLowerCase()); } catch(e) {}
  try { methods.push(m.toUpperCase()); } catch(e) {}
});

const app = express();
const STATIC_DIR = path.join(__dirname, 'files', 'download');

// HTTPS 支持（必须在 app 创建之后）
var httpsServer = null;
if (config.ssl && config.ssl.enabled) {
  try {
    const https = require('https');
    const sslOptions = {
      key: fs.readFileSync(path.resolve(config.ssl.key)),
      cert: fs.readFileSync(path.resolve(config.ssl.cert))
    };
    httpsServer = https.createServer(sslOptions, app);
    log.info('[HTTPS] SSL 证书配置成功');
  } catch (e) {
    log.error('[HTTPS] SSL 证书加载失败:', e.message);
    log.info('[HTTPS] 将以 HTTP 模式启动');
  }
}

// ==================== 全局中间件 ====================

// CORS（必须在 session 之前，让 OPTIONS 预检也带 cookie）
app.use(cors({
  preflightContinue: true, // 允许 WebDAV OPTIONS 处理器设置 DAV 头
  origin: function(origin, callback) {
    // 允许同源请求（无 origin header）、file:// 协议、Office Online Viewer
    if (!origin || origin === 'null' || origin.startsWith('https://view.officeapps.live.com')) {
      return callback(null, true);
    }
    // 检查白名单
    var allowedOrigins = config.corsAllowedOrigins || [];
    if (allowedOrigins.length > 0) {
      for (var i = 0; i < allowedOrigins.length; i++) {
        if (origin === allowedOrigins[i] || origin.endsWith('.' + allowedOrigins[i])) {
          return callback(null, true);
        }
      }
    }
    // 开发模式：如果未配置白名单，允许所有（打印警告）
    if (allowedOrigins.length === 0) {
      log.warn('[CORS] 未配置 CORS_ORIGINS 环境变量，允许所有来源（不安全！生产环境请配置）');
      return callback(null, true);
    }
    // 生产模式：拒绝不在白名单中的来源
    callback(new Error('CORS blocked: ' + origin));
  },
  credentials: true,                 // 允许携带 cookie（同源请求生效）
  exposedHeaders: ['X-CSRF-Token'],  // 允许前端读取 CSRF token 响应头
  allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Requested-With']  // 允许自定义请求头
}));

// ==================== 请求频率监控 & 自动封禁 ====================
var requestLog = {}; // { ip: { times: [timestamp, ...], banUntil: ts } }

var getClientIp = utils.getClientIp;

// 加载频率限制缓存
var rateLimitCache = null;
try { rateLimitCache = require('./lib/rate-limit-cache'); } catch (e) {}

// 清理过期的请求记录（每2分钟执行一次）
setInterval(function() {
  var now = Date.now();
  Object.keys(requestLog).forEach(function(ip) {
    var r = requestLog[ip];
    // 清理超过10分钟未活跃的 IP 记录
    if (r.times.length === 0 && r.banUntil < now) { delete requestLog[ip]; return; }
    // 清理120秒前的旧时间戳（保留足够长的窗口以适应不同的 window_seconds 配置）
    r.times = r.times.filter(function(t) { return now - t < 120000; });
  });
}, 120000);

// 封禁 IP
function banIP(ip, reason, durationMinutes) {
  try {
    var db = require('./lib/db');
    var now = new Date();
    var expiresAt = durationMinutes <= 0 ? null : new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString();
    db.run('UPDATE ip_blacklist SET is_active = 0 WHERE ip = ? AND auto_ban = 1', [ip]);
    var label = durationMinutes <= 0 ? '永久' : (durationMinutes >= 10080 ? Math.round(durationMinutes/10080) + '周' : (durationMinutes >= 60 ? Math.round(durationMinutes/60) + '小时' : durationMinutes + '分钟'));
    var banLevel = durationMinutes <= 0 ? 5 : (durationMinutes >= 10080 ? 3 : (durationMinutes >= 60 ? 2 : 1));
    db.run('INSERT INTO ip_blacklist (ip, reason, auto_ban, ban_level, created_by, created_at, expires_at, is_active) VALUES (?, ?, 1, ?, 0, ?, ?, 1)',
      [ip, reason + '，封禁' + label, banLevel, now.toISOString(), expiresAt]);
    log.info('[Anti-Scrap] 已封禁 IP:', ip, '时长:', label, '原因:', reason);
  } catch(e) {
    log.error('[Anti-Scrap] 封禁失败:', e.message);
  }
}

// Body parsers（仅在非 WebDAV 路径生效，避免消费 PUT body）
app.use(function(req, res, next) {
  if (req.path.indexOf('/webdav') === 0) return next();
  express.json()(req, res, next);
});
app.use(function(req, res, next) {
  if (req.path.indexOf('/webdav') === 0) return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// HTTP 到 HTTPS 重定向（启用 SSL 时）
if (config.ssl && config.ssl.enabled) {
  app.use(function(req, res, next) {
    // 如果不是 HTTPS 请求，重定向到 HTTPS
    if (!req.secure && req.protocol !== 'https') {
      var httpsPort = config.ssl.port;
      var host = req.headers.host.split(':')[0]; // 去掉端口
      return res.redirect('https://' + host + ':' + httpsPort + req.originalUrl);
    }
    next();
  });
}

// ==================== Session ====================
var redisStore = getSessionStore();
var sessionConfig = {
  secret: config.SESSION_SECRET,
  name: config.SESSION_NAME,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',     // 防止跨站请求携带 cookie（CSRF 防护）
    secure: config.ssl && config.ssl.enabled  // HTTPS 时启用 secure
  }
};
if (redisStore) sessionConfig.store = redisStore;
app.use(session(sessionConfig));

// ==================== 请求频率监控 & 自动封禁 ====================
// 注意：必须在 Session 之后运行，才能正确识别已登录用户提高限制
app.use(function(req, res, next) {
  var path = req.path;
  if (path.startsWith('/files/') || path.startsWith('/public/') ||
      path === '/favicon.ico' || path.endsWith('.js') || path.endsWith('.css') ||
      path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.svg') ||
      path.endsWith('.woff2') || path.endsWith('.woff') || path.endsWith('.ttf') ||
      path === '/webdav') { // 裸 /webdav 固定返回 404，无需频率限制
    return next();
  }

  var ip = getClientIp(req);
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();

  var now = Date.now();
  if (!requestLog[ip]) requestLog[ip] = { times: [], banUntil: 0 };
  var rec = requestLog[ip];

  // 解封：封禁到期自动清除
  if (rec.banUntil > 0 && rec.banUntil <= now) {
    rec.banUntil = 0;
  }

  // 滑动窗口：只保留120秒内的时间戳（支持最大 window_seconds=3600 的规则）
  rec.times = rec.times.filter(function(t) { return now - t < 120000; });
  // 封禁中也记录时间戳，以便在封禁期内升级到更高等级
  rec.times.push(now);
  var count = rec.times.length;

  var isBanned = rec.banUntil > now;

  var isWebDAV = path.startsWith('/webdav/');
  // 检查是否已登录（有 session userId）—— 现在 Session 已初始化，可以正确识别
  var isAuthenticated = !!(req.session && req.session.userId);

  // 从缓存获取频率限制规则
  var userType, thresholds;
  if (rateLimitCache) {
    // 白名单路径：跳过频率限制
    if (rateLimitCache.isWhitelisted(path)) {
      return next();
    }

    // WebDAV token 有效性判断（有效 token 视为已登录）
    if (isWebDAV) {
      var tokenMatch = path.match(/^\/webdav\/([A-Za-z0-9]+)/);
      var isValidToken = false;
      if (tokenMatch) {
        try {
          var WebDAVLink = require('./lib/db').WebDAVLink;
          var wlink = WebDAVLink.findByToken(tokenMatch[1]);
          isValidToken = !!(wlink && !WebDAVLink.checkExpired(wlink));
        } catch(e) {}
      }
      userType = isValidToken ? 'authenticated' : 'anonymous';
    } else {
      userType = isAuthenticated ? 'authenticated' : 'anonymous';
    }
    var rules = rateLimitCache.getRules(userType);
    // 转换为 middleware 使用的格式：{ limit, banMin }
    thresholds = rules.map(function(r) {
      return { limit: r.max_requests, banMin: Math.ceil(r.ban_duration_seconds / 60), windowSec: r.window_seconds };
    });
  } else {
    // 缓存不可用时的回退：使用旧的硬编码值
    if (path === '/api/version/latest') {
      thresholds = [{ limit: 1000, banMin: 1 }];
    } else if (isWebDAV) {
      thresholds = [{ limit: 10000, banMin: 1 }];
    } else if (isAuthenticated) {
      thresholds = [{ limit: 1000, banMin: 1 }];
    } else {
      thresholds = [
        { limit: 60,  banMin: 1 },
        { limit: 120, banMin: 60 },
        { limit: 200, banMin: 10080 },
        { limit: 400, banMin: 0 },
      ];
    }
  }

  // 检查是否超过阈值（从高到低，匹配最高等级）
  var hitRule = null;
  for (var i = thresholds.length - 1; i >= 0; i--) {
    var rule = thresholds[i];
    var windowMs = (rule.windowSec || 60) * 1000;
    // 统计窗口内的请求数（当前请求已经 push 进 times）
    var windowCount = rec.times.filter(function(t) { return now - t < windowMs; }).length;
    if (windowCount >= rule.limit) {
      hitRule = rule;
      break; // 从高到低遍历，命中即最高等级
    }
  }

  if (hitRule) {
    var banMin = hitRule.banMin;
    var newBanUntil = banMin <= 0 ? now + 365*24*3600*1000 : now + banMin * 60 * 1000;
    var label = banMin <= 0 ? '永久' : (banMin >= 10080 ? Math.round(banMin/10080) + '周' : (banMin >= 60 ? Math.round(banMin/60) + '小时' : banMin + '分钟'));

    if (isBanned) {
      // 已在封禁中 → 检查是否需要升级
      if (newBanUntil > rec.banUntil) {
        var oldRemaining = Math.ceil((rec.banUntil - now) / 60000);
        log.info('[Anti-Scrap] 封禁升级！IP:', ip, '路径:', path, '用户类型:', userType||'unknown',
          '原剩余:', oldRemaining + '分钟', '→ 升级为:', label);
        banIP(ip, '封禁升级（' + windowCount + '次/' + (hitRule.windowSec||60) + '秒），路径: ' + path, banMin);
        rec.banUntil = newBanUntil;
      }
      // 未达到升级条件 → 保持原封禁，继续 403
      var remaining = Math.ceil((rec.banUntil - now) / 60000);
      return res.status(403).json({ code: 403, message: '访问被拒绝，请' + remaining + '分钟后再试', data: null });
    } else {
      // 首次触发封禁
      log.info('[Anti-Scrap] 高频请求，IP:', ip, '路径:', path, '用户类型:', userType||'unknown',
        '频率:', windowCount + '次/' + (hitRule.windowSec||60) + '秒 → 封禁' + label);
      banIP(ip, '高频请求（' + windowCount + '次/' + (hitRule.windowSec||60) + '秒），路径: ' + path, banMin);
      rec.banUntil = newBanUntil;
      return res.status(403).json({ code: 403, message: '访问被拒绝，检测到异常请求行为', data: null });
    }
  }

  // 已封禁但未达到更高等级 → 继续返回 403
  if (isBanned) {
    var remaining = Math.ceil((rec.banUntil - now) / 60000);
    return res.status(403).json({ code: 403, message: '访问被拒绝，请' + remaining + '分钟后再试', data: null });
  }

  next();
});

// ==================== IP 黑名单中间件 ====================
var IPBlacklist = null;
try { IPBlacklist = require('./lib/db').IPBlacklist; } catch (e) {}

app.use(function(req, res, next) {
  if (!IPBlacklist) return next();
  var ip = getClientIp(req);
  if (IPBlacklist.isBlocked(ip)) {
    return res.status(403).json({ code: 403, message: '访问被拒绝，您的IP已被封禁', data: null });
  }
  next();
});

// ==================== 在线状态追踪 ====================
// 每次认证请求更新用户会话的 lastSeen 时间戳
app.use(function(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      var SessionTracker = require('./lib/redis').SessionTracker;
      SessionTracker.touch(req.session.userId, req.sessionID);
    } catch(e) {}
  }
  next();
});

// ==================== CSRF 保护 ====================
// 在 session 初始化后生成 CSRF token
app.use(function(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    var crypto = require('crypto');
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session._csrfJustGenerated = true;
  }
  // 暴露 CSRF token 给前端（通过响应头）
  if (req.session && req.session.csrfToken) {
    res.setHeader('X-CSRF-Token', req.session.csrfToken);
  }
  next();
});

// 验证 CSRF token（POST/PUT/DELETE 等状态变更请求）
app.use(function(req, res, next) {
  // 跳过 GET/HEAD/OPTIONS 请求
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  // 跳过 WebDAV（有自己的认证，不走 body parser）
  if (req.path.indexOf('/webdav') === 0) return next();
  // 跳过公开 API（它们在登录前调用，没有 session）
  var publicPaths = ['/api/auth/login', '/api/auth/register', '/api/auth/send-register-code',
                     '/api/auth/send-login-code', '/api/auth/send-reset-code', '/api/auth/reset-password',
                     '/api/auth/qr-login/', '/api/auth/captcha/', '/api/auth/setup',
                     '/api/share', '/api/offline/', '/api/admin/',
                     '/api/files/upload', '/api/public-files/upload', '/api/auth/logout'];
  for (var i = 0; i < publicPaths.length; i++) {
    if (req.path.startsWith(publicPaths[i])) {
      return next();
    }
  }
  // 如果 session 存在但还没 CSRF token，自动生成（兼容 session 迁移/重建）
  if (req.session && req.session.userId && !req.session.csrfToken) {
    var crypto = require('crypto');
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
      req.session._csrfJustGenerated = true;
  }
  // 验证 CSRF token
  var token = req.headers['x-csrf-token'] || (req.body && req.body._csrf) || req.query._csrf;
  if (!req.session || !req.session.userId) {
    // 未登录用户不需要 CSRF（没有 session 可保护）
    return next();
  }
  // 如果 session 刚刚生成了 token 且客户端还没拿到，允许通过
  if (req.session._csrfJustGenerated) {
    delete req.session._csrfJustGenerated;
    return next();
  }
  if (!token || token !== req.session.csrfToken) {
    log.warn('[CSRF] 请求被拒绝:', req.method, req.path, 'IP:', getClientIp(req));
    return res.status(403).json({ code: 403, message: 'CSRF 验证失败，请刷新页面后重试', data: null });
  }
  next();
});

// ==================== 首次启动初始化重定向 ====================
// 用户表为空时，所有页面请求重定向到 /setup
app.use(function(req, res, next) {
  // 跳过 API、静态资源、/setup 本身、WebDAV
  if (req.path === '/setup' ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/webdav') ||
      req.path.startsWith('/files/') ||
      req.path.match(/\.(js|css|png|jpe?g|svg|ico|woff2?|ttf|map|json)(\?.*)?$/)) {
    return next();
  }
  var User;
  try { User = require('./lib/db').User; } catch(e) { return next(); }
  try {
    if (User.count() === 0) {
      return res.redirect('/setup');
    }
  } catch(e) { /* DB 未初始化，跳过 */ }
  next();
});

// ==================== 路由 ====================
// 初始化设置页面（后端动态生成 HTML，仅首次启动可见）
app.get('/setup', function(req, res) {
  var User;
  try { User = require('./lib/db').User; } catch(e) { User = null; }
  if (User && User.count() > 0) {
    return res.redirect('/login.html');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getSetupPageHtml());
});

app.use(express.static(path.join(__dirname, 'public')));

// 认证路由
app.use('/api/auth', authRoutes);

// 分享API路由（公开接口+需认证接口）
app.use('/api', shareRoutes);

// 移动端版本管理（必须在 fileRoutes 之前，避免 admin 路由冲突）
app.use('/api', versionRoutes);
app.use('/files', versionRoutes);

// 文件API路由
app.use('/api', fileRoutes);

// 日志管理路由（仅管理员）
app.use('/api/logs', logRoutes);
app.use('/api', storageRoutes);

// WebDAV 路由（协议端点 + API 管理）
// 先设置 DAV 头（在 CORS 之前，避免 CORS 短路 OPTIONS）
// 处理 Expect: 100-continue（Windows 客户端 PUT 时需要）
app.use('/webdav', function(req, res, next) {
  if (req.headers.expect && req.headers.expect.toLowerCase() === '100-continue') {
    try { res.writeContinue(); } catch(e) { /* 兼容旧版 Node */ }
  }
  next();
});
app.use('/webdav', function(req, res, next) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK');
    res.setHeader('DAV', '1,2');
    res.setHeader('MS-Author-Via', 'DAV');
  }
  next();
});
app.use(webdavRoutes);

// ==================== 分享页面路由 ====================
// 分享分享页面（验证+浏览页）- SPA，路由由前端控制
app.get('/share/:hash', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// 分享管理页面（需登录）
app.get('/share-manage.html', function(req, res) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html?redirect=/share-manage.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'share-manage.html'));
});

// 离线下载页面（需登录）
app.get('/offline.html', function(req, res) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login.html?redirect=/offline.html');
  }
  res.sendFile(path.join(__dirname, 'public', 'offline.html'));
});

// 管理员静态文件下载（需要登录）
app.get('/download/*', function(req, res) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ code: 401, message: '请先登录', data: null });
  }
  var user = User.findById(req.session.userId);
  if (!user) { req.session.destroy(function() {}); return res.status(401).json({ code: 401, message: '请先登录', data: null }); }
  if (!user.is_active) { req.session.destroy(function() {}); return res.status(403).json({ code: 403, message: '账号已被禁用', data: null }); }

  var relativeFilePath = req.params[0];
  var filePath = path.join(STATIC_DIR, relativeFilePath);

  if (!path.resolve(filePath).startsWith(path.resolve(STATIC_DIR))) {
    return res.status(403).json({ code: 403, message: '禁止访问', data: null });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ code: 404, message: '文件不存在', data: null });
  }

  log.info('[Download] 用户 ' + user.email + ' 下载文件: ' + relativeFilePath);
  res.download(filePath, function(err) {
    if (err) log.error('[Download] 下载失败:', err);
  });
});

// ==================== 页面路由 ====================
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 回收站定时提醒 ====================
var reminderTimer = null;

// 检查即将过期的文件（3天内过期）并发送提醒邮件
function checkRecycleReminders() {
  var db = require('./lib/db');
  var User = db.User;
  var RecycleBin = db.RecycleBin;
  var emailLib = require('./lib/email');
  var now = Date.now();
  var threeDaysMs = 3 * 24 * 3600 * 1000;
  var expiryThreshold = new Date(now + threeDaysMs).toISOString();
  var nowISO = new Date(now).toISOString();

  // 收集所有即将过期的文件：{ userId, userName, email, files[] }
  var userFileMap = {}; // userId -> { user, files: [...] }
  var allUsers = db.query('SELECT * FROM users WHERE is_active = 1') || [];

  // 构建 userId -> user 快速查找
  var userById = {};
  allUsers.forEach(function(u) { userById[u.id] = u; });

  function addFile(userId, name, size, expiresAt) {
    if (!userId) return;
    if (!userFileMap[userId]) {
      var u = userById[userId];
      userFileMap[userId] = {
        user: u || { id: userId, email: '', email_reminder: 0 },
        files: []
      };
    }
    userFileMap[userId].files.push({ name: name, size: size, expires_at: expiresAt });
  }

  // ===== 1. 检查个人回收站（SQLite）=====
  try {
    var personalFiles = db.query(
      'SELECT * FROM deleted_files WHERE expires_at > ? AND expires_at <= ?',
      [nowISO, expiryThreshold]
    );
    personalFiles.forEach(function(f) {
      addFile(f.user_id, f.name, f.size, f.expires_at);
    });
    var personalDirs = db.query(
      'SELECT * FROM deleted_dirs WHERE expires_at > ? AND expires_at <= ?',
      [nowISO, expiryThreshold]
    );
    personalDirs.forEach(function(d) {
      addFile(d.user_id, d.name + '/', 0, d.expires_at);
    });
  } catch(e) {
    log.error('[Reminder] 个人回收站检查失败:', e.message);
  }

  // ===== 2. 检查公共回收站（Redis）=====
  try {
    var DelFile = require('./lib/redis').DelFile;
    DelFile.listAll().then(function(pubFiles) {
      if (pubFiles && pubFiles.length > 0) {
        pubFiles.forEach(function(f) {
          var expiresAtMs = new Date(f.expiresAt).getTime();
          var remaining = expiresAtMs - now;
          if (remaining > 0 && remaining <= threeDaysMs) {
            // 公共文件通知所有管理员
            allUsers.forEach(function(u) {
              if (u.is_admin === 1 || u.is_admin === '1') {
                addFile(u.id, '[公共] ' + f.originalName, f.size, f.expiresAt);
              }
            });
          }
        });
      }
      sendReminders();
    }).catch(function(e) {
      log.error('[Reminder] 公共回收站检查失败:', e.message);
      sendReminders(); // 即使公共检查失败也要发送个人提醒
    });
  } catch(e) {
    log.error('[Reminder] 公共回收站检查失败:', e.message);
    sendReminders();
  }

  // ===== 3. 发送邮件 =====
  function sendReminders() {
    var baseUrl = 'http://localhost:' + config.PORT;
    var sent = 0;

    // 获取 Redis 连接用于去重（每24小时最多一封）
    var redisClient = null;
    try {
      var Redis = require('ioredis');
      var redisCfg = config.redis;
      redisClient = new Redis({ host: redisCfg.host, port: redisCfg.port, db: redisCfg.db, maxRetriesPerRequest: 1, retryStrategy: function() { return null; } });
    } catch(e) {}

    Object.keys(userFileMap).forEach(function(uid) {
      var entry = userFileMap[uid];
      if (!entry.user || !entry.user.email) return;
      if (entry.files.length === 0) return;

      // 管理员始终接收（除非主动关闭 email_reminder）
      var isAdmin = entry.user.is_admin === 1 || entry.user.is_admin === '1';
      // 普通用户需开启 email_reminder
      var reminderEnabled = entry.user.email_reminder !== 0 && entry.user.email_reminder !== '0';

      if (!isAdmin && !reminderEnabled) return;

      // 去重：每24小时最多发一封提醒给同一用户
      var dedupKey = (config.redis.keyPrefix || 'ambush:') + 'reminder_sent:' + uid;
      if (redisClient) {
        redisClient.get(dedupKey).then(function(exists) {
          if (exists) return; // 24小时内已发过，跳过
          sendReminderEmail(uid, entry);
          redisClient.setex(dedupKey, 86400, '1'); // 标记已发送，24h过期
        }).catch(function() { sendReminderEmail(uid, entry); });
      } else {
        sendReminderEmail(uid, entry); // 无 Redis 时仍发送
      }
    });

    function sendReminderEmail(uid, entry) {

      // 计算剩余时间
      var filesWithText = entry.files.map(function(f) {
        var remainingMs = new Date(f.expires_at).getTime() - now;
        var days = Math.floor(remainingMs / (24 * 3600 * 1000));
        var hours = Math.floor((remainingMs % (24 * 3600 * 1000)) / (3600 * 1000));
        var remainingText = days > 0 ? days + '天' + hours + '小时' : hours + '小时';
        if (days === 0 && hours === 0) remainingText = '不到1小时';
        return { name: f.name, size: f.size, remaining_text: remainingText, expires_at: f.expires_at };
      });

      emailLib.sendRecycleReminder(entry.user.email, filesWithText, baseUrl).then(function(ok) {
        if (ok) {
          log.info('[Reminder] 已向 ' + entry.user.email + ' 发送 ' + filesWithText.length + ' 个文件的过期提醒');
        }
      });
    }
  }
}

// 启动定时检查（每小时一次）
function startReminderScheduler() {
  reminderTimer = setTimeout(function run() {
    checkRecycleReminders();
    reminderTimer = setTimeout(run, 3600000); // 1小时
  }, 300000);
  log.info('[Reminder] 定时提醒已启动（每小时检查一次）');
}

// ==================== 文件引用清理定时任务 ====================
// 每天凌晨 3:00 清理 ref_count=0 的孤立文件
var fileCleanupTimer = null;
var FILE_CLEANUP_HOUR = 3;
var FILE_CLEANUP_MINUTE = 0;
var FILE_CLEANUP_BATCH = 100;

function runFileCleanup() {
  log.info('[FileCleanup] 开始清理孤立文件 (ref_count=0)...');
  try {
    var FileStorage = require('./lib/db').FileStorage;
    // 只清理创建超过 1 小时且 ref_count=0 的文件（避免清理刚创建的去重文件）
    var orphans = FileStorage.findOrphansForCleanupByAge(1, FILE_CLEANUP_BATCH);
    if (orphans.length === 0) {
      log.info('[FileCleanup] 没有需要清理的孤立文件');
      return;
    }

    var fs = require('fs');
    var cleaned = 0, errors = 0;
    orphans.forEach(function(fsEntry) {
      try {
        // 再次确认引用计数为 0
        var current = FileStorage.findById(fsEntry.id);
        if (!current || current.ref_count > 0) return;

        // 删除物理文件
        var paths = FileStorage.getValidPaths(fsEntry.id);
        paths.forEach(function(p) {
          try { fs.unlinkSync(p.full_path); } catch(e) {}
        });

        // 删除数据库记录
        FileStorage.delete(fsEntry.id);
        cleaned++;
      } catch(e) {
        errors++;
        log.error('[FileCleanup] 清理失败: id=' + fsEntry.id + ' error=' + e.message);
      }
    });

    if (cleaned > 0 || errors > 0) {
      log.info('[FileCleanup] 清理完成: 成功=' + cleaned + ' 失败=' + errors + ' 剩余批次=' + (orphans.length === FILE_CLEANUP_BATCH ? '有更多' : '无'));
    }
  } catch(e) {
    log.error('[FileCleanup] 清理任务异常:', e.message);
  }
}

function startFileCleanupScheduler() {
  // 计算到凌晨3点的延迟
  var now = new Date();
  var target = new Date(now);
  target.setHours(FILE_CLEANUP_HOUR, FILE_CLEANUP_MINUTE, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1); // 明天凌晨3点
  }
  var delay = target.getTime() - now.getTime();
  log.info('[FileCleanup] 文件清理定时任务已启动 (每天 ' + FILE_CLEANUP_HOUR + ':0' + FILE_CLEANUP_MINUTE + ')，首次在 ' + Math.round(delay / 3600000) + ' 小时后');

  fileCleanupTimer = setTimeout(function run() {
    runFileCleanup();
    // 每24小时执行一次
    fileCleanupTimer = setTimeout(run, 24 * 3600000);
  }, delay);
}

// ==================== 首次启动设置页面（后端生成 HTML） ====================
function getSetupPageHtml() {
  return '<!DOCTYPE html>' +
'<html lang="zh-CN">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">' +
'<title>FMS 初始化设置</title>' +
'<style>' +
/* ===== 主题变量（默认暗色，兼容亮色） ===== */
':root {' +
'--bg-page:#0a0a0f;--bg-card:#111118;--bg-input:#0d0d14;--border:#1e2230;' +
'--text-primary:#e0e6f0;--text-secondary:#8892a8;--text-muted:#555d72;' +
'--accent:#00d4ff;--accent2:#7c3aed;--danger:#ef4444;--success:#10b981;' +
'--font-ui:"Syne",-apple-system,sans-serif;--font-mono:"Share Tech Mono",monospace;' +
'}' +
'@media (prefers-color-scheme:light) {' +
':root {' +
'--bg-page:#f4f6fb;--bg-card:#ffffff;--bg-input:#f8f9fc;--border:#d8dce6;' +
'--text-primary:#1a1d2e;--text-secondary:#5a6070;--text-muted:#8c94a5;' +
'--accent:#0284c7;--accent2:#6d28d9;' +
'}' +
'}' +
/* ===== 基础样式 ===== */
'*{margin:0;padding:0;box-sizing:border-box}' +
'body{font-family:var(--font-ui);background:var(--bg-page);color:var(--text-primary);' +
'display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}' +
/* ===== 背景光晕 ===== */
'.bg-glow{position:fixed;border-radius:50%;filter:blur(120px);opacity:.12;pointer-events:none}' +
'.bg-glow.c{width:500px;height:500px;background:var(--accent);top:-10%;left:50%;transform:translateX(-50%)}' +
'.bg-glow.p{width:400px;height:400px;background:var(--accent2);bottom:-15%;right:-10%}' +
/* ===== 卡片 ===== */
'.card{position:relative;background:var(--bg-card);border:1px solid var(--border);' +
'border-radius:20px;padding:40px 36px 32px;width:400px;max-width:94vw;' +
'box-shadow:0 24px 80px rgba(0,0,0,.35),0 0 2px rgba(0,212,255,.06)}' +
/* ===== 图标 ===== */
'.logo{width:60px;height:60px;background:linear-gradient(135deg,var(--accent),var(--accent2));' +
'border-radius:16px;display:flex;align-items:center;justify-content:center;' +
'font-size:28px;margin:0 auto 16px;box-shadow:0 8px 32px rgba(0,212,255,.25)}' +
'.logo svg{width:32px;height:32px;fill:#fff}' +
/* ===== 标题 ===== */
'.title{text-align:center;font-size:20px;font-weight:800;margin-bottom:4px}' +
'.subtitle{text-align:center;font-size:12px;color:var(--text-muted);margin-bottom:24px}' +
/* ===== 表单 ===== */
'.field{margin-bottom:16px}' +
'.field label{display:block;font-size:11px;font-weight:700;color:var(--text-secondary);' +
'text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}' +
'.field input{width:100%;padding:11px 14px;background:var(--bg-input);border:1px solid var(--border);' +
'border-radius:10px;color:var(--text-primary);font-size:14px;outline:none;transition:border .2s}' +
'.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.1)}' +
'.field input::placeholder{color:var(--text-muted)}' +
/* ===== 按钮 ===== */
'.btn{width:100%;padding:12px;border:none;border-radius:10px;font-size:15px;font-weight:700;' +
'cursor:pointer;transition:all .2s;font-family:var(--font-ui)}' +
'.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;' +
'box-shadow:0 4px 20px rgba(0,212,255,.3)}' +
'.btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 28px rgba(0,212,255,.4)}' +
'.btn-primary:active{transform:translateY(0)}' +
'.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}' +
/* ===== 消息 ===== */
'.msg{text-align:center;font-size:12px;min-height:18px;margin-top:12px;transition:color .2s}' +
'.msg.error{color:var(--danger)}' +
'.msg.success{color:var(--success)}' +
/* ===== 底部 ===== */
'.footer{text-align:center;margin-top:20px;font-size:11px;color:var(--text-muted)}' +
'.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);' +
'border-top-color:#fff;border-radius:50%;animation:s .6s linear infinite;vertical-align:middle;margin-right:4px}' +
'@keyframes s{to{transform:rotate(360deg)}}' +
'</style>' +
'</head>' +
'<body>' +
'<div class="bg-glow c"></div><div class="bg-glow p"></div>' +
'<div class="card">' +
'<div class="logo"><svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg></div>' +
'<div class="title">FMS 文件管理系统</div>' +
'<div class="subtitle">首次使用，请设置管理员账号</div>' +
'<div class="field"><label>邮箱</label><input id="email" type="email" placeholder="admin@example.com" autofocus></div>' +
'<div class="field"><label>密码</label><input id="password" type="password" placeholder="至少8位，含大小写字母+数字"></div>' +
'<button class="btn btn-primary" id="btn-submit" onclick="doSetup()">创建管理员账号</button>' +
'<div class="msg" id="msg"></div>' +
'<div class="footer">账号创建后将自动成为系统管理员</div>' +
'</div>' +
'<script>' +
'function msg(text, type) { var m = document.getElementById("msg"); m.textContent = text; m.className = "msg " + (type || ""); }' +
'function setLoading(loading) { var btn = document.getElementById("btn-submit"); btn.disabled = loading; btn.innerHTML = loading ? \'<span class="spinner"></span>正在创建...\' : \'创建管理员账号\'; }' +
'async function doSetup() {' +
'var email = document.getElementById("email").value.trim();' +
'var password = document.getElementById("password").value;' +
'if (!email) return msg("请输入邮箱", "error");' +
'if (!password) return msg("请输入密码", "error");' +
'if (password.length < 8) return msg("密码至少需要8位", "error");' +
'setLoading(true);' +
'try {' +
'var resp = await fetch("/api/auth/setup", {' +
'method:"POST", headers:{"Content-Type":"application/json"},' +
'body:JSON.stringify({email:email,password:password})' +
'});' +
'var data = await resp.json();' +
'if (data.code === 0) {' +
'msg("初始化成功！正在跳转...", "success");' +
'if (data.data && data.data.csrfToken) { localStorage.setItem("csrfToken", data.data.csrfToken); }' +
'setTimeout(function() { window.location.href = "/home.html"; }, 1200);' +
'} else {' +
'msg(data.message || "初始化失败", "error");' +
'setLoading(false);' +
'}' +
'} catch(e) {' +
'msg("网络错误，请检查服务是否正常运行", "error");' +
'setLoading(false);' +
'}' +
'}' +
'document.getElementById("password").addEventListener("keydown", function(e) { if (e.key === "Enter") doSetup(); });' +
'</script>' +
'</body>' +
'</html>';
}

// ==================== 全局错误处理 ====================
// 捕获未处理的路由错误
app.use(function(err, req, res, next) {
  log.error('[Error] 未处理的服务器错误:', err.message);
  log.error('[Error] 请求路径:', req.method, req.path);
  log.error('[Error] 堆栈:', err.stack);
  // 如果响应头已发送，交给 Express 默认错误处理
  if (res.headersSent) return next(err);
  // 根据错误类型返回适当的响应
  var statusCode = err.status || err.statusCode || 500;
  var message = statusCode === 500 ? '服务器内部错误，请稍后重试' : err.message;
  res.status(statusCode).json({ code: statusCode, message: message, data: null });
});

// 404 处理（必须放在所有路由之后）
app.use(function(req, res) {
  // 对于 API 请求返回 JSON，对于页面请求返回简单文本
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ code: 404, message: '接口不存在', data: null });
  } else {
    res.status(404).send('404 - 页面不存在');
  }
});

// 捕获未处理的 Promise rejection
process.on('unhandledRejection', function(reason, promise) {
  log.error('[Process] 未处理的 Promise Rejection:', reason);
  if (reason && reason.stack) log.error('[Process] 堆栈:', reason.stack);
});

// 捕获未处理的异常
process.on('uncaughtException', function(err) {
  log.error('[Process] 未捕获的异常:', err.message);
  log.error('[Process] 堆栈:', err.stack);
  // 给服务器一些时间来完成正在处理的请求
  log.error('[Process] 服务器将在一秒后退出...');
  setTimeout(function() { process.exit(1); }, 1000);
});

// ==================== 启动服务器 ====================
async function startServer() {
  try {
    await initDatabase();
    log.info('[Server] 数据库初始化完成');

    startReminderScheduler();
    startFileCleanupScheduler();

    // 存储池健康检查（每分钟）
    setInterval(function() {
      try { require('./lib/db').StoragePool.runHealthCheck(); } catch(e) {}
    }, 60000);
    log.info('[HealthCheck] 存储池健康检查已启动（每分钟）');

    // 每月1号凌晨自动重置流量配额
    var lastResetMonth = null;
    function checkMonthlyReset() {
      var now = new Date();
      var currentMonth = now.toISOString().substring(0, 7); // YYYY-MM
      if (lastResetMonth === currentMonth) return;
      // 检查是否1号
      if (now.getDate() === 1) {
        var prevMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().substring(0, 7);
        try {
          var TrafficQuota = require('./lib/db').TrafficQuota;
          TrafficQuota.resetPeriod(prevMonth);
          log.info('[TrafficQuota] 已重置 ' + prevMonth + ' 的流量配额');
        } catch (e) {
          log.error('[TrafficQuota] 重置失败:', e.message);
        }
      }
      lastResetMonth = currentMonth;
    }
    checkMonthlyReset();
    // 每小时检查一次
    setInterval(checkMonthlyReset, 3600000);
    log.info('[TrafficQuota] 月度自动重置定时器已启动');

    // 创建 HTTP 服务器（与 WebSocket 共享）
    var server = http.createServer(app);

    // 初始化 WebSocket 服务（同时监听 HTTP 和 HTTPS）
    wsService.init(server);
    if (httpsServer) wsService.init(httpsServer);

    // 启动 HTTP 服务器
    server.listen(config.PORT, function() {
      log.info('[HTTP] Server running at http://localhost:' + config.PORT);
    });

    // 启动 HTTPS 服务器
    if (httpsServer) {
      var sslPort = config.ssl.port;
      httpsServer.listen(sslPort, function() {
        log.info('[HTTPS] Server running at https://localhost:' + sslPort);
        log.info('[HTTPS] 外部访问地址: https://' + require('os').hostname() + ':' + sslPort);
      });
    } else {
      log.info('[HTTPS] 未启用 SSL，请设置环境变量 SSL_ENABLED=true 启用 HTTPS');
    }

    log.info('文件管理: http://localhost:' + config.PORT);
    log.info('登录页面: http://localhost:' + config.PORT + '/login.html');
  } catch (err) {
    log.error('[Server] 启动失败:', err);
    process.exit(1);
  }
}

startServer();
