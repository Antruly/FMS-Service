// ==================== 全局流量统计中间件 ====================
// 包装 res.write / res.end 计数所有出站字节
// 两类流量：
//   - 请求流量 (request)：按用户活跃会话聚合，3分钟无活动或满60分钟刷入 DB
//   - 文件传输流量 (file_transfer)：设置了 res._trafficMeta 的下载/预览，finish 时直接写 DB

// 安全导入 getClientIp
var _utils = {};
try { _utils = require('./utils'); } catch (e) {}
var getClientIp = _utils.getClientIp || function (req) {
  var ip = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
};

// ==================== 用户活跃会话管理 ====================
// key: "userId|guestIp" → session
// Session 在一次"活跃期"内累积请求流量，非活跃 3 分钟后刷入 DB 并结束
var userSessions = {};
var INACTIVE_FLUSH_MS = 3 * 60 * 1000;   // 3 分钟无请求 → 刷入 DB，离线
var MAX_SESSION_MS = 60 * 60 * 1000;      // 累计 60 分钟 → 中途刷入，继续

// 获取或创建用户会话
function getOrCreateSession(userId, guestIp) {
  var key = (userId || 0) + '|' + (guestIp || '');
  var now = Date.now();
  var session = userSessions[key];
  if (!session || !session.active) {
    // 新会话（首次或离线后重新活跃）
    session = {
      userId: userId || 0,
      guestIp: guestIp || '',
      accumulatedBytes: 0,
      lastActivityTime: now,
      sessionStartTime: now,
      active: true
    };
    userSessions[key] = session;
  }
  return session;
}

// 添加请求流量到用户会话
function accumulateRequestTraffic(userId, guestIp, bytes) {
  if (bytes <= 0) return;
  var session = getOrCreateSession(userId, guestIp);
  session.accumulatedBytes += bytes;
  session.lastActivityTime = Date.now();
}

// 刷一个会话到 DB
function flushSession(session) {
  if (!session || session.accumulatedBytes <= 0) return;
  try {
    var db = require('./db');
    db.TrafficLog.log(session.userId, session.guestIp, 'request', 0, '', 0, session.accumulatedBytes, 'request');
    var isGuest = !session.userId || session.userId === 0;
    if (isGuest) {
      db.TrafficQuota.addUsed(0, session.guestIp || '', true, session.accumulatedBytes);
    } else {
      db.TrafficQuota.addUsed(session.userId, '', false, session.accumulatedBytes);
    }
  } catch (e) {
    // 静默失败
  }
  session.accumulatedBytes = 0;
}

// 定时检查：3分钟不活跃 → 刷入并标记离线；满60分钟 → 中途刷入
function checkSessions() {
  var now = Date.now();
  Object.keys(userSessions).forEach(function (key) {
    var s = userSessions[key];
    if (!s.active) return;
    var inactiveMs = now - s.lastActivityTime;
    var sessionMs = now - s.sessionStartTime;

    if (inactiveMs >= INACTIVE_FLUSH_MS) {
      // 3 分钟无活动 → 刷入 DB，标记离线
      flushSession(s);
      s.active = false;
    } else if (sessionMs >= MAX_SESSION_MS) {
      // 持续活跃 60 分钟 → 中途刷入，重置起始时间继续累积
      flushSession(s);
      s.sessionStartTime = now;
    }
  });

  // 清理已离线的旧会话（超过 10 分钟未再活跃就删除）
  Object.keys(userSessions).forEach(function (key) {
    var s = userSessions[key];
    if (!s.active && (now - s.lastActivityTime) > 10 * 60 * 1000) {
      delete userSessions[key];
    }
  });
}

// 每 60 秒检查一次
var checkTimer = setInterval(checkSessions, 60000);

// 优雅退出：刷所有活跃会话
function flushAllSessions() {
  Object.keys(userSessions).forEach(function (key) {
    var s = userSessions[key];
    if (s.active && s.accumulatedBytes > 0) {
      flushSession(s);
      s.active = false;
    }
  });
}

process.on('exit', function () {
  flushAllSessions();
  try {
    var redis = require('./redis');
    if (redis && redis.TrafficBuffer) redis.TrafficBuffer.flush();
  } catch (e) {}
});

// ==================== 辅助函数 ====================

// 从 req 解析用户身份
function resolveTrafficIdentity(req) {
  var userId = 0;
  var guestIp = '';
  if (req.session && req.session.userId) {
    userId = req.session.userId;
  } else {
    guestIp = getClientIp(req);
  }
  return { userId: userId, guestIp: guestIp };
}

// 准确计算 chunk 字节数
function chunkBytes(chunk, encoding) {
  if (!chunk) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding || 'utf8');
  return 0;
}

// 直接写文件传输流量到 DB（不聚合，即时记录）
function writeFileTransferTraffic(record) {
  try {
    var db = require('./db');
    db.TrafficLog.log(record.user_id, record.guest_ip, record.action_type,
      record.file_id, record.file_name, record.file_size, record.bytes_count,
      record.traffic_category);
    var isGuest = !record.user_id || record.user_id === 0;
    if (isGuest) {
      db.TrafficQuota.addUsed(0, record.guest_ip || '', true, record.bytes_count);
    } else {
      db.TrafficQuota.addUsed(record.user_id, '', false, record.bytes_count);
    }
  } catch (e) {
    console.error('[Traffic] writeFileTransferTraffic ERROR:', e.message, e.stack);
  }
}

// ==================== 导出中间件 ====================
module.exports = function trafficMiddleware(req, res, next) {
  // 跳过静态文件路径和 WebDAV
  var p = req.path;
  if (p.startsWith('/files/') || p.startsWith('/public/') ||
      p === '/favicon.ico' || p.endsWith('.js') || p.endsWith('.css') ||
      p.endsWith('.png') || p.endsWith('.jpg') || p.endsWith('.svg') ||
      p.endsWith('.woff2') || p.endsWith('.woff') || p.endsWith('.ttf') ||
      p === '/webdav') {
    return next();
  }

  // 防止重复包装
  if (res._trafficWrapped) return next();
  res._trafficWrapped = true;

  var identity = resolveTrafficIdentity(req);
  var totalBytes = 0;
  var recorded = false;

  // 包装 res.write
  var origWrite = res.write;
  res.write = function (chunk, encoding, cb) {
    totalBytes += chunkBytes(chunk, encoding);
    return origWrite.apply(res, arguments);
  };

  // 包装 res.end
  var origEnd = res.end;
  res.end = function (chunk, encoding, cb) {
    totalBytes += chunkBytes(chunk, encoding);
    return origEnd.apply(res, arguments);
  };

  // 记录流量（只执行一次）
  function doRecord() {
    if (recorded) return;
    if (totalBytes <= 0) { recorded = true; return; }
    recorded = true;

    var meta = res._trafficMeta;
    if (meta && meta.skip) return;

    if (meta && meta.category === 'file_transfer') {
      // 文件传输流量：直接写 DB（不参与用户会话聚合）
      writeFileTransferTraffic({
        user_id: meta.user_id || identity.userId || 0,
        guest_ip: meta.guest_ip || identity.guestIp || '',
        action_type: meta.action_type || 'download',
        file_id: meta.file_id || 0,
        file_name: meta.file_name || '',
        file_size: meta.file_size || 0,
        bytes_count: totalBytes,
        traffic_category: 'file_transfer'
      });
    } else {
      // 请求流量：累积到用户活跃会话，3min 无活动或 60min 后刷入 DB
      accumulateRequestTraffic(identity.userId, identity.guestIp, totalBytes);
    }
  }

  res.on('finish', doRecord);
  res.on('close', doRecord);
  res.on('error', function () { recorded = true; });

  next();
};
