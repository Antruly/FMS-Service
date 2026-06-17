var log = require('../lib/log');
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const mime = require('mime-types');
const multer = require('multer');
const { User, VirtualDir, VirtualFile, Permission, Storage, RecycleBin, OfflineDownload, TrafficLog, TrafficQuota, query, get, run } = require('../lib/db');
// 安全导入：如果 lib/utils.js 未更新，使用内联回退
var _fileUtils = {};
try { _fileUtils = require('../lib/utils'); } catch(e) {}
var getClientIp = _fileUtils.getClientIp || function(req) {
  var ip = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
};
var getRemainingMs = _fileUtils.getRemainingMs || function(expiresAt) {
  if (!expiresAt) return 0;
  var diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 ? diff : 0;
};
var formatRemainingTime = _fileUtils.formatRemainingTime || function(expiresAt) {
  var ms = getRemainingMs(expiresAt);
  if (ms <= 0) return '';
  var seconds = Math.floor(ms / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);
  if (days > 0) return days + '天' + (hours % 24) + '小时';
  if (hours > 0) return hours + '小时' + (minutes % 60) + '分钟';
  if (minutes > 0) return minutes + '分钟';
  return '不到1分钟';
};
var formatFileSize = _fileUtils.formatFileSize || function(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
};
const { encryptFileToBuffer, decryptFileFromBuffer, createDecryptStream, createDecryptStreamRange, createEncryptStream, isV1EncryptedFile, createV1DecryptStream, createV1DecryptStreamHead, createDecryptStreamAuto, getV1FileInfo, detectFileEncVersion, upgradeFileToV1, createV1EncryptStreamSync, createV1EncryptStreamTransform, ENC_V1_VERSION } = require('../lib/crypto');
const crypto = require('crypto');
const XLSX = require('xlsx');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');
const PREVIEW_MAX_SIZE = 10 * 1024 * 1024; // 文档预览最大 10MB

// 尝试加载流量缓冲（Redis）
var TrafficBuffer = null;
try { TrafficBuffer = require('../lib/redis').TrafficBuffer; } catch (e) {}

// 流量记录辅助函数
// action_type: 'upload' | 'download' | 'preview' | 'video_stream'
// 注意：有 Redis 时，TrafficBuffer.flush 会统一处理流量记录和配额更新
//       没有 Redis 时，这里直接写入 DB 并更新配额
function logTraffic(userId, guestIp, actionType, fileId, fileName, fileSize, bytesCount) {
  if (bytesCount <= 0) return;

  var record = {
    user_id: userId || 0,
    guest_ip: guestIp || '',
    action_type: actionType,
    file_id: fileId || 0,
    file_name: fileName || '',
    file_size: fileSize || 0,
    bytes_count: bytesCount || 0,
    traffic_category: 'file_transfer'
  };

  if (TrafficBuffer) {
    // 有 Redis：TrafficBuffer.flush 会统一处理流量记录和配额更新
    TrafficBuffer.add(record);
  } else {
    // 没有 Redis：直接写入 DB 并更新配额
    try {
      TrafficLog.log(record.user_id, record.guest_ip, record.action_type, record.file_id, record.file_name, record.file_size, record.bytes_count, record.traffic_category);
      var isGuest = !userId || userId === 0;
      if (isGuest) {
        TrafficQuota.addUsed(0, guestIp || '', true, bytesCount);
      } else {
        TrafficQuota.addUsed(userId, '', false, bytesCount);
      }
    } catch (e) { log.error('[logTraffic] error:', e.message); }
  }
}

// 为流添加流量计数记录（插入到 pipe 链中间）
// src.pipe(countingTransform).pipe(dest) 即可自动记录
function makeTrafficCounter(userId, fileId, fileName, fileSize, actionType) {
  var totalBytes = 0;
  var recorded = false;
  var t = new stream.Transform({
    transform: function(chunk, enc, cb) {
      if (chunk && chunk.length) totalBytes += chunk.length;
      this.push(chunk);
      cb();
    }
  });
  t.on('finish', function() {
    if (recorded || totalBytes <= 0) return;
    recorded = true;
    logTraffic(userId, '', actionType, fileId, fileName, fileSize, totalBytes);
  });
  t.on('error', function() { recorded = true; });
  return t;
}

// 包装 res.write / res.end，自动记录流量
// 返回包装后的 res，调用方直接 pipe 即可
function wrapResForTraffic(res, userId, fileId, fileName, fileSize, actionType) {
  var totalBytes = 0;
  var origWrite = res.write;
  var origEnd = res.end;
  var recorded = false;
  function doRecord() {
    if (recorded) return;
    recorded = true;
    if (totalBytes > 0) {
      logTraffic(userId, '', actionType, fileId, fileName, fileSize, totalBytes);
    }
  }
  res.write = function(chunk, encoding, cb) {
    if (chunk && chunk.length) totalBytes += chunk.length;
    return origWrite.apply(res, arguments);
  };
  res.end = function(chunk, encoding, cb) {
    if (chunk && chunk.length) totalBytes += chunk.length;
    doRecord();
    return origEnd.apply(res, arguments);
  };
  res.on('finish', doRecord);
  res.on('error', doRecord);
  return res;
}
const { rimrafSync } = require('rimraf');
const { validateFileName, validateDirName } = require('../lib/validator');
const logger = require('../lib/logger');
const sharp = require('sharp');
const mammoth = require('mammoth');

// WebSocket推送服务（可选，用于实时推送离线下载进度）
var wsPush = null;
try { wsPush = require('../lib/ws'); } catch (e) { log.warn('[Offline] WebSocket初始化失败:', e.message); }

// ==================== 预览Token：用于安全分享和Google Docs Viewer鉴权 ====================
var PREVIEW_TOKEN_EXPIRE = 3600; // 1小时有效期
var PREVIEW_TOKEN_SECRET = require('../config').previewTokenSecret;

// 生成预览Token
function generatePreviewToken(fileId, userId) {
  var payload = fileId + ':' + userId;
  var sig = crypto.createHmac('sha256', PREVIEW_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

// 验证预览Token
function verifyPreviewToken(token) {
  try {
    var decoded = Buffer.from(token, 'base64url').toString();
    var parts = decoded.split(':');
    if (parts.length !== 3) return null;
    var fileId = parseInt(parts[0], 10);
    var userId = parseInt(parts[1], 10);
    var sig = parts[2];
    var payload = parts[0] + ':' + parts[1];
    var expectedSig = crypto.createHmac('sha256', PREVIEW_TOKEN_SECRET).update(payload).digest('hex');
    if (sig !== expectedSig) return null;
    return { fileId: fileId, userId: userId };
  } catch (e) { return null; }
}


// ==================== multipart 解析器（修复 busboy 中文文件名乱码）====================
// busboy 1.6.0 对 UTF-8 编码的中文文件名处理有 bug（当 latin1 解码），
// 故直接解析 HTTP 请求体，始终用 UTF-8 解码文件名。
//
// 大文件优化：先流式写入临时文件（边写边检查配额），
// 全部接收后再从文件读取解析，避免 Buffer.concat 内存溢出。

var os = require('os');

// 从 multipart header 中提取文件名，智能处理多种编码（UTF-8 / latin1 / 系统编码）
function extractFilename(headerStr, headerBuf) {
  // 优先 RFC 5987: filename*=UTF-8''percent-encoded
  var fnMatch = headerStr.match(/filename\*=(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
  if (fnMatch) {
    return decodeURIComponent(fnMatch[1].trim().replace(/^["']|["']$/g, ''));
  }
  // 从 raw buffer 中提取 filename 字节，避免 UTF-8 解码错误
  var fnIdx = headerBuf.indexOf(Buffer.from('filename'));
  if (fnIdx !== -1) {
    var afterFn = headerBuf.slice(fnIdx + 8);
    if (afterFn[0] === 0x2A) afterFn = afterFn.slice(1); // skip '*'
    var valStart = 0;
    while (valStart < afterFn.length && (afterFn[valStart] === 0x3D || afterFn[valStart] === 0x20)) valStart++;
    var quoteChar = 0;
    if (valStart < afterFn.length && (afterFn[valStart] === 0x22 || afterFn[valStart] === 0x27)) {
      quoteChar = afterFn[valStart]; valStart++;
    }
    var valEnd = valStart;
    while (valEnd < afterFn.length) {
      var b = afterFn[valEnd];
      if (quoteChar) { if (b === quoteChar || b === 0x0D || b === 0x0A) break; }
      else { if (b === 0x3B || b === 0x22 || b === 0x0D || b === 0x0A) break; }
      valEnd++;
    }
    var fnBytes = afterFn.slice(valStart, valEnd);
    var name = fnBytes.toString('utf8');
    // UTF-8 失败则尝试 GBK（Windows 中文系统常用），最后回退 latin1
    if (name.includes('�')) {
      try { var iconv = require('iconv-lite'); name = iconv.decode(fnBytes, 'gbk'); } catch(e) {}
      if (name.includes('�')) name = fnBytes.toString('latin1');
    }
    return name;
  }
  // 回退：正则匹配（兼容无 buffer 的场景）
  var legacyMatch = headerStr.match(/filename\*?=\s*["']?([^;"\r\n]+)/i);
  if (legacyMatch) {
    var raw = legacyMatch[1].trim().replace(/^["']|["']$/g, '');
    return raw.includes('%') ? decodeURIComponent(raw) : raw;
  }
  return '';
}

// 配额检查用流式解析器：实时计算文件大小，超额立即中止连接
// quotaBytes: 用户剩余配额
// returns: Promise<{ fields, file } | { aborted, filename }>
// 调用方检查 result.aborted && res.json(配额超限错误)
function parseMultipartWithQuotaCheck(req, user) {
  return new Promise(function(resolve, reject) {
    var tmpDir = path.join(__dirname, '..', 'files', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
    }
    var tmpName = 'upload_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    var tmpPath = path.join(tmpDir, tmpName);
    var writeStream = null;
    var totalSize = 0;
    var aborted = false;

    try {
      writeStream = fs.createWriteStream(tmpPath);
    } catch(e) {
      log.error('[Upload] 创建临时文件失败:', e.message);
      reject(e);
      return;
    }

    writeStream.on('error', function(err) {
      log.error('[Upload] 临时文件写入失败:', err.message);
      aborted = true;
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      reject(err);
    });

    req.on('data', function(chunk) {
      if (aborted) return;
      totalSize += chunk.length;
      // 配额检查（以总请求大小近似文件大小，已足够精确）
      if (user.used_bytes + totalSize > user.quota_bytes) {
        aborted = true;
        writeStream.close();
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        req.destroy(); // 立即切断连接，不继续读
        return;
      }
      // 流式写入临时文件（write 返回 boolean，false 表示内核缓冲区满，等待 drain）
      if (!writeStream.write(chunk)) {
        req.pause();
        writeStream.once('drain', function() { req.resume(); });
      }
    });

    req.on('end', function() {
      writeStream.end(function() {
        if (aborted) {
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          resolve({ aborted: true, filename: null });
          return;
        }

        // 检查文件大小，超过 3.5 GB 拒绝（Node.js Buffer 上限约 4 GB）
        var MAX_UPLOAD_SIZE = 3.5 * 1024 * 1024 * 1024;
        var fileStat = fs.statSync(tmpPath);
        if (fileStat.size > MAX_UPLOAD_SIZE) {
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          var errMsg = '文件过大（' + Math.round(fileStat.size/1024/1024) + 'MB），最大支持 ' + Math.round(MAX_UPLOAD_SIZE/1024/1024) + 'MB';
          log.error('[Upload] ' + errMsg);
          reject(new Error(errMsg));
          return;
        }

        var body;
        try {
          body = fs.readFileSync(tmpPath);
        } catch (readErr) {
          try { fs.unlinkSync(tmpPath); } catch(e2) {}
          reject(readErr);
          return;
        }

        try {
          var fields = {};
          var fileData = null;

          var ct = req.headers['content-type'] || '';
          var m = ct.match(/boundary=(.+)/i);
          if (!m) {
            try { fs.unlinkSync(tmpPath); } catch(e) {}
            resolve(null);
            return;
          }
          var boundary = '--' + m[1].replace(/^["']|["']$/g, '');

          var pos = 0;
          var bnBuf = Buffer.from(boundary);

          while (true) {
            var partStart = body.indexOf(bnBuf, pos);
            if (partStart === -1) break;
            var partEnd = body.indexOf(bnBuf, partStart + bnBuf.length);
            if (partEnd === -1) break;

            var partData = body.slice(partStart, partEnd);
            var headerEndIdx = partData.indexOf(Buffer.from('\r\n\r\n'));
            if (headerEndIdx === -1) {
              pos = partEnd;
              continue;
            }

            var headerBuf = partData.slice(0, headerEndIdx);
            var headerStr = headerBuf.toString('utf8');

            if (/filename/i.test(headerStr)) {
              var filename = extractFilename(headerStr, headerBuf);
              if (filename) {
                var ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
                var mimetype = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
                fileData = {
                  filename: filename,
                  mimetype: mimetype,
                  buffer: partData.slice(headerEndIdx + 4, partData.length - 2),
                  size: partData.slice(headerEndIdx + 4, partData.length - 2).length
                };
              }
            } else {
              var dataStr = partData.slice(headerEndIdx + 4, partData.length - 2).toString('utf8');
              var nameMatch = headerStr.match(/name="([^"]+)"/);
              if (nameMatch) { fields[nameMatch[1]] = dataStr; }
            }

            pos = partEnd;
          }

          // 清理临时文件
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          resolve({ fields: fields, file: fileData });
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch(e2) {}
          reject(e);
        }
      });
    });

    req.on('error', function(e) {
      if (aborted) return;
      try { writeStream.close(); } catch(e2) {}
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
      reject(e);
    });
  });
}

// 旧版完整解析（保持兼容，也改用流式写入临时文件避免大文件内存溢出）
function parseMultipart(req) {
  return new Promise(function(resolve, reject) {
    var tmpDir = path.join(__dirname, '..', 'files', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
    }
    var tmpName = 'pub_upload_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    var tmpPath = path.join(tmpDir, tmpName);
    var writeStream = fs.createWriteStream(tmpPath);

    writeStream.on('error', function(err) {
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      reject(err);
    });

    req.on('data', function(chunk) {
      if (!writeStream.write(chunk)) {
        req.pause();
        writeStream.once('drain', function() { req.resume(); });
      }
    });

    req.on('end', function() {
      writeStream.end(function() {
        // 检查文件大小，超过 3.5 GB 拒绝
        var MAX_UPLOAD_SIZE = 3.5 * 1024 * 1024 * 1024;
        var fileStat;
        try { fileStat = fs.statSync(tmpPath); } catch(e) { reject(e); return; }
        if (fileStat.size > MAX_UPLOAD_SIZE) {
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          reject(new Error('文件过大（' + Math.round(fileStat.size/1024/1024) + 'MB），最大支持 ' + Math.round(MAX_UPLOAD_SIZE/1024/1024) + 'MB'));
          return;
        }

        try {
          var body = fs.readFileSync(tmpPath);
          try { fs.unlinkSync(tmpPath); } catch(e) {}
          var ct = req.headers['content-type'] || '';
        var m = ct.match(/boundary=(.+)/i);
        if (!m) return resolve(null);
        var boundary = '--' + m[1].replace(/^["']|["']$/g, '');

        var fields = {};
        var fileData = null;

        // 把 body 按 boundary 分割（不用字符串 split，避免编码问题）
        var pos = 0;
        var bnBuf = Buffer.from(boundary);

        while (true) {
          var partStart = body.indexOf(bnBuf, pos);
          if (partStart === -1) break;
          var partEnd = body.indexOf(bnBuf, partStart + bnBuf.length);
          if (partEnd === -1) break;

          var partData = body.slice(partStart, partEnd);
          var headerEndIdx = partData.indexOf(Buffer.from('\r\n\r\n'));
          if (headerEndIdx === -1) {
            pos = partEnd;
            continue;
          }

          // header 用 UTF-8 解码
          var headerBuf = partData.slice(0, headerEndIdx);
          var headerStr = headerBuf.toString('utf8');

          // 判断是文件还是字段
          if (/filename/i.test(headerStr)) {
            var filename = extractFilename(headerStr, headerBuf);
            if (filename) {
              var ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
              var mimetype = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
              fileData = {
                filename: filename,
                mimetype: mimetype,
                buffer: partData.slice(headerEndIdx + 4, partData.length - 2),
                size: partData.slice(headerEndIdx + 4, partData.length - 2).length
              };
            }
          } else {
            // 字段 part：name="xxx"\r\n\r\nvalue
            var dataStr = partData.slice(headerEndIdx + 4, partData.length - 2).toString('utf8');
            var nameMatch = headerStr.match(/name="([^"]+)"/);
            if (nameMatch) {
              fields[nameMatch[1]] = dataStr;
            }
          }

          pos = partEnd;
        }

        resolve({ fields: fields, file: fileData });
      } catch (e) {
        try { fs.unlinkSync(tmpPath); } catch(e2) {}
        reject(e);
      }
    });
    });

    req.on('error', function(e) {
      try { writeStream.close(); } catch(e2) {}
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
      reject(e);
    });
  });
}

// ==================== 通用 ====================

// 获取当前用户信息
function getUser(userId) {
  return User.findById(userId);
}

// 检查用户是否有某目录的权限
function checkPerm(user, dirId, action) {
  // 管理员有所有权限
  if (user.is_admin) return true;
  // dirId === 0 表示用户的根目录，始终允许
  if (dirId === 0) return true;
  var perm = Permission.get(user.id, dirId);
  if (!perm) {
    // 检查目录是否属于该用户（所有者自动获得完整权限）
    var dir = VirtualDir.findById(dirId);
    if (dir && dir.user_id === user.id) {
      // 旧版代码创建的目录可能缺少权限记录，自动补全
      Permission.set(user.id, dirId, {
        canRead: true, canWrite: true, canDelete: true,
        canUpload: true, canDownload: true, canCreateDir: true
      });
      log.info('[PermFix] 为用户 ' + user.email + ' 自动补全目录 ' + dirId + ' (' + dir.name + ') 的权限');
      return true;
    }
    return false;
  }
  switch (action) {
    case 'read': return perm.can_read;
    case 'write': return perm.can_write;
    case 'delete': return perm.can_delete;
    case 'upload': return perm.can_upload;
    case 'download': return perm.can_download;
    case 'create_dir': return perm.can_create_dir;
    default: return false;
  }
}

// 401/403 响应
function deny401(res) { res.status(401).json({ code: 401, message: '请先登录', data: null }); }
function deny403(res, msg) { res.status(403).json({ code: 403, message: msg || '禁止访问', data: null }); }
function deny404(res, msg) { res.status(404).json({ code: 404, message: msg || '资源不存在', data: null }); }

// ==================== 身份中间件 ====================

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return deny401(res);
  var user = User.findById(req.session.userId);
  if (!user) { req.session.destroy(function() {}); return deny401(res); }
  if (!user.is_active) { req.session.destroy(function() {}); return deny403(res, '账号已被禁用'); }
  req.user = user;
  req._user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, function() {
    if (!req.user.is_admin) return deny403(res, '需要管理员权限');
    next();
  });
}

// ==================== 用户信息 ====================

// GET /api/profile/me
router.get('/profile/me', requireAuth, function(req, res) {
  var user = req.user;
  var userId = user.id;
  var period = new Date().toISOString().substring(0, 7);
  var tq = TrafficQuota.get(userId, '', false);
  res.json({
    code: 0, message: 'success', data: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      is_admin: user.is_admin,
      quota_bytes: user.quota_bytes,
      used_bytes: user.used_bytes,
      created_at: user.created_at,
      last_login: user.last_login,
      email_reminder: user.email_reminder,
      traffic_quota: tq.quota_bytes || 10737418240,
      traffic_used: tq.used_bytes || 0,
      traffic_period: tq.period || period
    }
  });
});

// PUT /api/profile/me
router.put('/profile/me', requireAuth, function(req, res) {
  var { nickname, email_reminder } = req.body;
  if (nickname !== undefined) {
    User.updateNickname(req.user.id, nickname);
  }
  if (email_reminder !== undefined) {
    User.updateEmailReminder(req.user.id, email_reminder);
  }
  var user = User.findById(req.user.id);
  res.json({ code: 0, message: 'success', data: { user: user } });
});

// POST /api/profile/change-password
router.post('/profile/change-password', requireAuth, function(req, res) {
  var { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.json({ code: 1, message: '请填写完整', data: null });
  }
  var result = User.changePassword(req.user.id, oldPassword, newPassword);
  if (!result.ok) {
    return res.json({ code: 1, message: result.message, data: null });
  }
  res.json({ code: 0, message: '密码修改成功', data: null });
});

// ==================== 存储配额 ====================

// GET /api/storage/quota
router.get('/storage/quota', requireAuth, function(req, res) {
  var user = req.user;
  res.json({
    code: 0, message: 'success', data: {
      quota_bytes: user.quota_bytes,
      used_bytes: user.used_bytes,
      available_bytes: Math.max(0, user.quota_bytes - user.used_bytes)
    }
  });
});

// ==================== 搜索 API ====================

// GET /api/files/search-local?q=keyword&dir_id=X&type=personal|public
// 局部搜索：当前目录 + 递归子目录
router.get('/files/search-local', requireAuth, function(req, res) {
	var q = (req.query.q || '').trim();
	var dirId = parseInt(req.query.dir_id || '0', 10);
	var dirType = req.query.type || 'personal';
	if (!q || q.length < 1) {
		return res.json({ code: 1, message: '请输入搜索关键词', data: { files: [], dirs: [] } });
	}

	var userId = req.user.id;
	var results = { files: [], dirs: [], currentDir: dirId, dirType: dirType };

	if (dirType === 'personal') {
		// 个人目录：DB递归，无深度限制
		try {
			var likeQ = '%' + q.replace(/[%_\\]/g, '\\$&') + '%';

			// 1. 搜索当前目录下的文件
			results.files = query(
				'SELECT f.id, f.name, f.size, f.mime_type, f.dir_id, f.created_at ' +
				'FROM virtual_files f WHERE f.user_id = ? AND f.dir_id = ? AND f.name LIKE ? ESCAPE \'\\\' ' +
				'ORDER BY f.name LIMIT 200',
				[userId, dirId, likeQ]
			);

			// 2. 搜索当前目录下的子目录
			results.dirs = query(
				'SELECT id, name, parent_id, created_at FROM virtual_dirs ' +
				'WHERE user_id = ? AND parent_id = ? AND name LIKE ? ESCAPE \'\\\' ' +
				'ORDER BY name LIMIT 100',
				[userId, dirId, likeQ]
			);

			// 3. 递归搜索子目录（获取所有后代目录ID，然后查询）
			var allChildIds = [];
			var VirtualDir = require('../lib/db').VirtualDir;
			try {
				// 获取当前目录的直接子目录
				var directChildren = query(
					'SELECT id FROM virtual_dirs WHERE user_id = ? AND parent_id = ?',
					[userId, dirId]
				);
				for (var ci = 0; ci < directChildren.length; ci++) {
					var childId = directChildren[ci].id;
					allChildIds.push(childId);
					var grandChildren = VirtualDir.getAllChildIds(childId);
					for (var gi = 0; gi < grandChildren.length; gi++) {
						allChildIds.push(grandChildren[gi]);
					}
				}
			} catch(e) {}

			// 在子目录中搜索匹配的文件和目录
			if (allChildIds.length > 0) {
				var placeholders = allChildIds.map(function() { return '?'; }).join(',');
				var childFiles = query(
					'SELECT f.id, f.name, f.size, f.mime_type, f.dir_id, f.created_at ' +
					'FROM virtual_files f WHERE f.user_id = ? AND f.dir_id IN (' + placeholders + ') AND f.name LIKE ? ESCAPE \'\\\' ' +
					'ORDER BY f.name LIMIT 200',
					[userId].concat(allChildIds).concat([likeQ])
				);
				for (var fi = 0; fi < childFiles.length; fi++) {
					results.files.push(childFiles[fi]);
				}
				var childDirs = query(
					'SELECT id, name, parent_id, created_at FROM virtual_dirs ' +
					'WHERE user_id = ? AND id IN (' + placeholders + ') AND name LIKE ? ESCAPE \'\\\' ' +
					'ORDER BY name LIMIT 100',
					[userId].concat(allChildIds).concat([likeQ])
				);
				for (var di = 0; di < childDirs.length; di++) {
					results.dirs.push(childDirs[di]);
				}
			}

			// 补全个人文件/目录的完整路径（递归获取直至根目录）
			for (var fi = 0; fi < results.files.length; fi++) {
				results.files[fi].dir_path = VirtualDir.getFullPath(results.files[fi].dir_id);
			}
			for (var di = 0; di < results.dirs.length; di++) {
				results.dirs[di].dir_path = VirtualDir.getFullPath(results.dirs[di].parent_id);
			}
		} catch(e) {
			log.error('局部搜索个人目录失败:', e.message);
		}
	} else if (dirType === 'public') {
		// 公共目录：文件系统递归，最大深度8层
		try {
			var storageMod = require('../lib/db').Storage;
			var publicDir = storageMod.PUBLIC_DIR;
			if (publicDir) {
				var fs = require('fs');
				var path = require('path');
				var delBakRe = /\.\d+\.delbak$/;
				var MAX_DEPTH = 8;

				// 构建当前目录的物理路径
				var currentRelPath = req.query.path || '';
				var startDir = currentRelPath ? path.resolve(publicDir, currentRelPath) : publicDir;
				if (!startDir.startsWith(publicDir)) startDir = publicDir;

				function scanDir(dirPath, relPath, depth) {
					if (depth > MAX_DEPTH || results.files.length + results.dirs.length >= 300) return;
					var entries;
					try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch(e) { return; }
					for (var i = 0; i < entries.length; i++) {
						var e = entries[i];
						var fullPath = path.join(dirPath, e.name);
						var entryRel = relPath ? relPath + '/' + e.name : e.name;
						if (e.name.charAt(0) === '.') continue;
						if (e.name === 'Thumbs.db' || e.name === '__MACOSX' || e.name === 'desktop.ini') continue;
						if (delBakRe.test(e.name)) continue;
						if (e.name.toLowerCase().indexOf(q.toLowerCase()) === -1) {
							// 名称不匹配但仍需深入子目录搜索
							if (e.isDirectory() && !delBakRe.test(e.name)) {
								scanDir(fullPath, entryRel, depth + 1);
							}
							continue;
						}
						if (e.isDirectory()) {
							results.dirs.push({ name: e.name, path: entryRel, type: 'dir', size: 0 });
							scanDir(fullPath, entryRel, depth + 1);
						} else {
							var stat;
							try { stat = fs.statSync(fullPath); } catch(ex) { stat = { size: 0 }; }
							results.files.push({
								name: e.name, path: entryRel, type: 'file',
								size: stat.size || 0,
								mime_type: (require('mime-types') || require('../lib/db').mime || {}).lookup ? require('mime-types').lookup(e.name) : ''
							});
						}
					}
				}
				scanDir(startDir, currentRelPath, 0);
			}
		} catch(e) {
			log.error('局部搜索公共目录失败:', e.message);
		}
	}

	return res.json({ code: 0, data: results });
});

// GET /api/files/search?q=keyword  全局搜索个人全部+公共目录
router.get('/files/search', requireAuth, function(req, res) {
	var q = (req.query.q || '').trim();
	if (!q || q.length < 1) {
		return res.json({ code: 1, message: '请输入搜索关键词', data: { files: [], dirs: [], publicFiles: [] } });
	}

	var userId = req.user.id;
	var results = { files: [], dirs: [], publicFiles: [] };

	// 1. 搜索个人文件（DB INSTR，跨全部目录，无深度限制）
	try {
		results.files = VirtualFile.searchByName(userId, q, 500);
	} catch(e) {
		log.error('搜索个人文件失败:', e.message);
	}

	// 2. 搜索个人目录（DB INSTR，跨全部目录，无深度限制）
	try {
		results.dirs = VirtualDir.searchByName(userId, q, 500);
	} catch(e) {
		log.error('搜索个人目录失败:', e.message);
	}

	// 补全个人文件/目录的完整路径
	for (var fi = 0; fi < results.files.length; fi++) {
		var f = results.files[fi];
		f.dir_path = VirtualDir.getFullPath(f.dir_id);
	}
	for (var di = 0; di < results.dirs.length; di++) {
		var d = results.dirs[di];
		d.dir_path = VirtualDir.getFullPath(d.parent_id);
	}

	// 3. 搜索公共目录（Redis缓存优先 + 文件系统回退）
	try {
		var PublicDirCache = require('../lib/redis').PublicDirCache;
		PublicDirCache.getTree().then(function(tree) {
			if (tree && tree.length > 0) {
				// Redis缓存命中 → 直接过滤
				var qLower = q.toLowerCase();
				results.publicFiles = tree.filter(function(entry) {
					return entry.name.toLowerCase().indexOf(qLower) !== -1;
				}).slice(0, 200);
				return res.json({ code: 0, data: results });
			}

			// 缓存未命中 → 扫描文件系统
			try {
				var storageMod = require('../lib/db').Storage;
				var publicDir = storageMod.PUBLIC_DIR;
				if (!publicDir) {
					return res.json({ code: 0, data: results });
				}
				var fs = require('fs');
				var path = require('path');

				// 递归扫描公共目录（最大深度8层）
				var allEntries = [];
				var MAX_DEPTH = 8;
				// 匹配已删除文件: name.ext.{number}.delbak
				var delBakRe = /\.\d+\.delbak$/;

				function scanDir(dirPath, relPath, depth) {
					if (depth > MAX_DEPTH) return;
					var entries;
					try {
						entries = fs.readdirSync(dirPath, { withFileTypes: true });
					} catch(e) { return; }
					for (var i = 0; i < entries.length; i++) {
						var e = entries[i];
						var fullPath = path.join(dirPath, e.name);
						var entryRel = relPath ? relPath + '/' + e.name : e.name;
						// 跳过隐藏文件、系统文件、已删除备份文件
						if (e.name.charAt(0) === '.') continue;
						if (e.name === 'Thumbs.db' || e.name === '__MACOSX' || e.name === 'desktop.ini') continue;
						if (delBakRe.test(e.name)) continue; // 排除 .delbak 删除标记文件
						if (e.isDirectory()) {
							// 跳过已删除的目录（目录名匹配 .delbak 模式）
							if (delBakRe.test(e.name)) continue;
							allEntries.push({ name: e.name, path: entryRel, type: 'dir', size: 0, mime_type: '' });
							scanDir(fullPath, entryRel, depth + 1);
						} else if (e.isFile()) {
							var stat;
							try { stat = fs.statSync(fullPath); } catch(ex) { stat = { size: 0 }; }
							allEntries.push({
								name: e.name, path: entryRel, type: 'file',
								size: stat.size || 0,
								mime_type: require('mime-types').lookup(e.name) || 'application/octet-stream'
							});
						}
					}
				}
				scanDir(publicDir, '', 0);

				// 缓存到Redis（异步，不阻塞响应）
				PublicDirCache.setTree(allEntries).catch(function(){});

				// 过滤匹配
				var qLower2 = q.toLowerCase();
				results.publicFiles = allEntries.filter(function(entry) {
					return entry.name.toLowerCase().indexOf(qLower2) !== -1;
				}).slice(0, 200);

				return res.json({ code: 0, data: results });
			} catch(fsErr) {
				log.error('扫描公共目录失败:', fsErr.message);
				return res.json({ code: 0, data: results });
			}
		}).catch(function(err) {
			log.error('PublicDirCache.getTree失败:', err ? err.message : '');
			return res.json({ code: 0, data: results });
		});
	} catch(e) {
		log.error('公共目录搜索失败:', e.message);
		return res.json({ code: 0, data: results });
	}
});

// ==================== 虚拟目录 ====================

// GET /api/dirs?path=xxx&type=personal|public  (path: 逗号分隔的目录ID，如 "0,5,12")
// type=public 时重定向到 /api/public-files/list
router.get('/dirs', requireAuth, function(req, res) {
  var dirId = parseInt(req.query.path || '0', 10);
  var dirType = req.query.type || 'personal';

  // 公共目录：改用新接口
  if (dirType === 'public') {
    var relPath = dirId === 0 ? '' : '';
    var publicRoot = Storage.PUBLIC_DIR;
    Storage.ensurePublicDir();

    var entries;
    try {
      entries = fs.readdirSync(publicRoot);
    } catch (err) {
      return res.json({ code: 1, message: '读取目录失败', data: { dirs: [], files: [] } });
    }

    var dirs = [], files = [];
    entries.forEach(function(name) {
      if (name === '.' || name === '..') return;
      if (name.endsWith('.delbak')) return;
      var fullPath = path.join(publicRoot, name);
      try {
        var stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          dirs.push({ id: encodeURIComponent(name), name: name, parent_path: '', created_at: stat.ctime });
        } else {
          files.push({
            id: encodeURIComponent(name),
            name: name,
            size: stat.size,
            mime_type: mime.lookup(name) || 'application/octet-stream',
            created_at: stat.ctime
          });
        }
      } catch (err) {}
    });

    dirs.sort(function(a, b) { return a.name.localeCompare(b.name); });
    files.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return res.json({ code: 0, message: 'success', data: { dirs: dirs, files: files } });
  }

  var user = req.user;

  // 个人目录
  if (!checkPerm(user, dirId, 'read')) return deny403(res, '无权限查看此目录');

  // 构建面包屑链：从当前目录向上追溯到根
  var breadcrumb = [];
  var curId = dirId;
  while (curId > 0) {
    var dir = VirtualDir.findById(curId);
    if (!dir) break;
    breadcrumb.unshift({ id: dir.id, name: dir.name });
    curId = dir.parent_id;
  }

  var dirs = VirtualDir.listPersonalByParent(user.id, dirId);
  var files = VirtualFile.listByDir(user.id, dirId);

  // 批量检查文件存储是否有效（一次查询，避免 N+1）
  var storageIds = files.filter(function(f) { return f.storage_id > 0; }).map(function(f) { return f.storage_id; });
  var validStorageIds = {};
  if (storageIds.length > 0) {
    var phs = storageIds.map(function() { return '?'; }).join(',');
    var activeRows = query(
      'SELECT DISTINCT storage_id FROM file_storage_paths WHERE storage_id IN (' + phs + ') AND status = ?',
      storageIds.concat(['active'])
    );
    activeRows.forEach(function(r) { validStorageIds[r.storage_id] = true; });
  }

  res.json({
    code: 0, message: 'success', data: {
      dirs: dirs.map(function(d) { return { id: d.id, name: d.name, parent_id: d.parent_id, created_at: d.created_at }; }),
      files: files.map(function(f) {
        return {
          id: f.id, name: f.name, size: f.size, mime_type: f.mime_type,
          created_at: f.created_at,
          is_broken: f.storage_id > 0 && !validStorageIds[f.storage_id],
          storage_id: f.storage_id || 0
        };
      }),
      breadcrumb: breadcrumb
    }
  });
});

// POST /api/dirs  创建目录
router.post('/dirs', requireAuth, function(req, res) {
  var { name, parent_id, is_public } = req.body;
  var parentId = parseInt(parent_id || '0', 10);
  var isPublic = is_public ? true : false;
  var user = req.user;

  if (!name || name.trim() === '') return res.json({ code: 1, message: '目录名不能为空', data: null });
  if (name.length > 100) return res.json({ code: 1, message: '目录名过长', data: null });
  // 禁止特殊字符（Windows+Linux 平台兼容）
  var dirCheck = validateDirName(name);
  if (!dirCheck.valid) return res.json({ code: 1, message: dirCheck.message, data: null });

  // 公共目录不能嵌套（仅支持根级公共目录）
  if (isPublic && parentId !== 0) {
    return res.json({ code: 1, message: '公共目录只能在根目录创建', data: null });
  }

  // 公共目录需要检查权限
  if (isPublic) {
    // 只有管理员或用户自己可以创建公共目录（这里简单允许登录用户创建）
  } else {
    if (!checkPerm(user, parentId, 'create_dir')) return deny403(res, '无权限创建目录');
  }

  // 避免重名（仅在个人目录中查重，公共目录独立存在）
  var existing = VirtualDir.listPersonalByParent(user.id, parentId);
  if (existing.find(function(d) { return d.name === name.trim(); })) {
    return res.json({ code: 1, message: '目录已存在', data: null });
  }

  var dirId = VirtualDir.create(user.id, parentId, name.trim(), isPublic ? 1 : 0);
  if (!dirId) return res.json({ code: 1, message: '创建失败', data: null });

  // 给新目录设置默认权限（继承父目录权限，如果父目录无权限则默认读+下载）
  var parentPerm = Permission.get(user.id, parentId);
  var defaultPerm = parentPerm || { can_read: 1, can_write: 1, can_delete: 1, can_upload: 1, can_download: 1, can_create_dir: 1 };
  Permission.set(user.id, dirId, {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canUpload: true,
    canDownload: true,
    canCreateDir: true
  });

  logger.logCreateDir(req, name.trim(), true);

  res.json({ code: 0, message: '目录已创建', data: { id: dirId, name: name.trim(), is_public: isPublic ? 1 : 0 } });
});

// DELETE /api/dirs/:id  将目录及其内容移入回收站（软删除）
router.delete('/dirs/:id', requireAuth, function(req, res) {
  var dirId = parseInt(req.params.id, 10);
  var user = req.user;

  var dir = VirtualDir.findById(dirId);
  if (!dir || dir.user_id !== user.id) return deny404(res, '目录不存在');
  if (!checkPerm(user, dirId, 'delete')) return deny403(res, '无权限删除目录');

  // ========== 检查关联的分享和WebDAV链接 ==========
  var dbModule = require('../lib/db');
  // 收集该目录及其所有子目录ID
  var allDirIds = [dirId];
  try {
    var childIds = VirtualDir.getAllChildIds(dirId);
    if (childIds && childIds.length > 0) allDirIds = allDirIds.concat(childIds);
  } catch(e) {}
  var placeholders = allDirIds.map(function() { return '?'; }).join(',');

  // 检查分享（target_type='dir' 且 target_id 在删除范围内）
  var affectedShares = dbModule.query(
    'SELECT id, hash, title, target_id FROM shares WHERE target_type = ? AND target_id IN (' + placeholders + ') AND status = ?',
    ['dir'].concat(allDirIds).concat(['active'])
  );

  // 检查 WebDAV 个人链接（target_type='personal' 且 target_path 对应目录ID）
  var affectedWebDAV = [];
  allDirIds.forEach(function(did) {
    var links = dbModule.query(
      'SELECT id, link_name, target_path FROM webdav_links WHERE target_type = ? AND target_path = ? AND status = ?',
      ['personal', String(did), 'active']
    );
    links.forEach(function(l) { affectedWebDAV.push(l); });
  });

  var hasWarnings = (affectedShares && affectedShares.length > 0) || affectedWebDAV.length > 0;

  // 递归移入回收站（物理文件保留在原位置）
  var moved = RecycleBin.moveDir(dirId, user.id);
  if (!moved) return deny404(res, '目录不存在');

  // ========== 自动失效关联的分享和WebDAV链接 ==========
  if (affectedShares && affectedShares.length > 0) {
    affectedShares.forEach(function(s) {
      try { dbModule.run("UPDATE shares SET status = 'disabled' WHERE id = ?", [s.id]); } catch(e) {}
    });
    log.info('[DeleteDir] 已失效 ' + affectedShares.length + ' 个分享链接');
  }
  if (affectedWebDAV.length > 0) {
    affectedWebDAV.forEach(function(w) {
      try { dbModule.run("UPDATE webdav_links SET status = 'disabled' WHERE id = ?", [w.id]); } catch(e) {}
    });
    log.info('[DeleteDir] 已失效 ' + affectedWebDAV.length + ' 个WebDAV链接');
  }

  logger.logRecycleDelete(req, dir.name, true, true);

  res.json({
    code: 0, message: '目录已移入回收站' + (hasWarnings ? '，关联的分享/WebDAV链接已自动失效' : ''),
    data: {
      warnings: hasWarnings ? {
        shares: (affectedShares || []).map(function(s) { return { id: s.id, title: s.title, hash: s.hash }; }),
        webdav: affectedWebDAV.map(function(w) { return { id: w.id, name: w.link_name }; }),
        message: '该目录或子目录存在 ' + (affectedShares ? affectedShares.length : 0) + ' 个分享链接和 ' + affectedWebDAV.length + ' 个WebDAV链接，已自动失效'
      } : null
    }
  });
});

// ==================== 虚拟文件 ====================

// 秒传质询缓存（内存，5分钟过期）
// key: token → { storageId, offset, length, fileHash, fileSize, expires }
var instantChallenges = new Map();
// 定期清理过期质询
setInterval(function() {
  var now = Date.now();
  instantChallenges.forEach(function(v, k) {
    if (v.expires < now) instantChallenges.delete(k);
  });
}, 60000);

// POST /api/files/check-hash  秒传预检 Phase 1：检查文件是否存在，返回随机字节质询
// crypto 已在文件顶部声明: const crypto = require('crypto');
router.post('/files/check-hash', requireAuth, function(req, res) {
  var fileHash = String(req.body.hash || '').trim();
  var fileSize = parseInt(req.body.size, 10) || 0;

  if (!fileHash || fileHash.length !== 64 || !fileSize) {
    return res.json({ code: 1, message: '参数错误：需要有效的 hash(SHA-256) 和 size', data: null });
  }

  // 小于 1MB 的文件不允许秒传
  var MIN_INSTANT_SIZE = 1048576; // 1MB
  if (fileSize < MIN_INSTANT_SIZE) {
    return res.json({ code: 0, message: '文件小于1MB，不支持秒传', data: { exists: false, too_small: true } });
  }

  var FileStorage = require('../lib/db').FileStorage;
  var existing = FileStorage.findByHashAndSize(fileHash, fileSize);

  if (!existing) {
    return res.json({ code: 0, message: '文件不存在，需要正常上传', data: { exists: false } });
  }

  // 文件存在，检查是否有可读取的有效路径
  if (!FileStorage.hasValidPath(existing.id)) {
    // 文件存在但所有路径都失效 → 需要用户上传新文件来修复
    log.info('[HashCheck] 文件损坏，请求上传修复: hash=' + fileHash.substring(0, 12) + ' size=' + fileSize);
    return res.json({ code: 0, message: '文件需要重新上传', data: { exists: false, need_repair: true } });
  }

  // 生成随机质询：从文件中随机位置取 128B ~ 1KB
  var CHALLENGE_MIN = 128;
  var CHALLENGE_MAX = 1024;
  var challengeLen = CHALLENGE_MIN + Math.floor(Math.random() * (CHALLENGE_MAX - CHALLENGE_MIN + 1));
  var maxOffset = Math.max(0, fileSize - challengeLen);
  var challengeOffset = Math.floor(Math.random() * (maxOffset + 1));

  // 生成质询 token（绑定到用户）
  var token = require('crypto').randomBytes(16).toString('hex');
  instantChallenges.set(token, {
    storageId: existing.id,
    offset: challengeOffset,
    length: challengeLen,
    fileHash: fileHash,
    fileSize: fileSize,
    expires: Date.now() + 5 * 60 * 1000 // 5分钟
  });

  log.info('[HashCheck] Phase1 质询: hash=' + fileHash.substring(0, 12) + ' offset=' + challengeOffset + ' len=' + challengeLen + ' token=' + token.substring(0, 8));

  return res.json({
    code: 0, message: '需要验证文件内容', data: {
      exists: true,
      challenge: { token: token, offset: challengeOffset, length: challengeLen }
    }
  });
});

// POST /api/files/instant-upload  秒传预检 Phase 2：验证随机字节质询，完成秒传
router.post('/files/instant-upload', requireAuth, function(req, res) {
  var fileHash = String(req.body.hash || '').trim();
  var fileSize = parseInt(req.body.size, 10) || 0;
  var dirId = parseInt(req.body.dir_id || '0', 10);
  var fileName = String(req.body.name || '秒传文件').trim();
  var token = String(req.body.token || '').trim();
  var challengeDataB64 = String(req.body.data || '').trim();

  if (!token || !challengeDataB64) {
    return res.json({ code: 1, message: '参数错误：需要 token 和 data', data: null });
  }

  // 查找质询记录
  var challenge = instantChallenges.get(token);
  if (!challenge) {
    return res.json({ code: 2, message: '质询已过期或无效，请重试', data: null });
  }

  // 验证 hash 和 size 是否匹配
  if (challenge.fileHash !== fileHash || challenge.fileSize !== fileSize) {
    instantChallenges.delete(token);
    return res.json({ code: 3, message: '质询参数不匹配', data: null });
  }

  // 解码客户端提交的字节数据
  var submittedData;
  try {
    submittedData = Buffer.from(challengeDataB64, 'base64');
  } catch (e) {
    return res.json({ code: 4, message: '数据格式错误', data: null });
  }

  if (submittedData.length !== challenge.length) {
    instantChallenges.delete(token);
    return res.json({ code: 5, message: '数据长度不匹配：期望' + challenge.length + '字节，收到' + submittedData.length + '字节', data: null });
  }

  // ========== 存储架构：通过 storage-stream 获取文件流（不手动操作路径） ==========
  var fs = require('fs');
  var FileStorage = require('../lib/db').FileStorage;
  var cryptoLib = require('../lib/crypto');
  var dbMod = require('../lib/db');
  var StorageStream = require('../lib/storage-stream');

  // 1) 从 file_storage 获取加密状态和存储组
  var storageRecord = dbMod.get('SELECT * FROM file_storage WHERE id = ?', [challenge.storageId]);
  if (!storageRecord) {
    log.error('[InstantUpload] file_storage 记录不存在: storageId=' + challenge.storageId);
    instantChallenges.delete(token);
    return res.json({ code: 6, message: '文件存储记录不存在(storageId=' + challenge.storageId + ')', data: null });
  }
  var groupId = storageRecord.group_id;
  var isEncrypted = storageRecord.is_encrypted;

  // 2) 从 file_storage_paths 获取相对路径（任意一条 active 记录即可，路径在所有镜像中相同）
  var pathRow = dbMod.get(
    "SELECT relative_path FROM file_storage_paths WHERE storage_id = ? AND status = 'active' LIMIT 1",
    [challenge.storageId]
  );
  if (!pathRow || !pathRow.relative_path) {
    log.error('[InstantUpload] 无活跃存储路径记录: storageId=' + challenge.storageId);
    instantChallenges.delete(token);
    return res.json({ code: 6, message: '文件无可用存储路径(storageId=' + challenge.storageId + ')', data: null });
  }
  var relativePath = pathRow.relative_path;

  // 3) 通过存储架构解析所有可用镜像路径（内部处理负载均衡和镜像选择）
  var allPaths = StorageStream.resolveAllReadPaths(relativePath, groupId);
  if (!allPaths || allPaths.length === 0) {
    log.error('[InstantUpload] 存储组无可用镜像: storageId=' + challenge.storageId + ' groupId=' + groupId + ' relPath=' + relativePath);
    instantChallenges.delete(token);
    return res.json({ code: 6, message: '文件所有镜像均不可读(storageId=' + challenge.storageId + ' groupId=' + groupId + ')', data: null });
  }

  // decryptedStart/decryptedEnd 为闭区间（inclusive）
  var decStart = challenge.offset;
  var decEnd = challenge.offset + challenge.length - 1;

  // 4) 逐条尝试每个镜像路径（容错：文件可能在上一个检查后被删除）
  var pathIdx = 0;
  function tryNextPath() {
    if (pathIdx >= allPaths.length) {
      log.error('[InstantUpload] 所有镜像路径均不可读: storageId=' + challenge.storageId + ' tried=' + allPaths.length);
      instantChallenges.delete(token);
      return res.json({ code: 6, message: '文件所有存储路径均不可读(storageId=' + challenge.storageId + ')', data: null });
    }
    var fullPath = allPaths[pathIdx++];

    try {
      if (isEncrypted) {
        // 加密文件：走 crypto 流式解密（只解密质询区间，不加载整个文件）
        var decryptStream = cryptoLib.createDecryptStreamAuto(fullPath, decStart, decEnd);
        var chunks = [];
        decryptStream.on('data', function(c) { chunks.push(c); });
        decryptStream.on('end', function() { completeInstantUpload(Buffer.concat(chunks)); });
        decryptStream.on('error', function(err) {
          log.warn('[InstantUpload] 镜像解密失败: ' + fullPath + ' err=' + err.message + '，尝试下一条...');
          tryNextPath();
        });
      } else {
        // 非加密文件：流式读取指定区间
        var readStream = fs.createReadStream(fullPath, { start: decStart, end: decEnd });
        var bufs = [];
        readStream.on('data', function(c) { bufs.push(c); });
        readStream.on('end', function() { completeInstantUpload(Buffer.concat(bufs)); });
        readStream.on('error', function(err) {
          log.warn('[InstantUpload] 镜像读取失败: ' + fullPath + ' err=' + err.message + '，尝试下一条...');
          tryNextPath();
        });
      }
    } catch(e) {
      log.warn('[InstantUpload] 镜像异常: ' + fullPath + ' err=' + e.message + '，尝试下一条...');
      tryNextPath();
    }
  }
  tryNextPath();

  function completeInstantUpload(serverData) {
    if (!submittedData.equals(serverData)) {
      log.warn('[InstantUpload] 质询验证失败: ' + fileName + ' hash=' + fileHash.substring(0, 12) +
        ' offset=' + challenge.offset + ' len=' + challenge.length +
        ' 客户端前8字节=' + submittedData.slice(0, 8).toString('hex') +
        ' 服务端前8字节=' + serverData.slice(0, 8).toString('hex'));
      instantChallenges.delete(token);
      return res.json({ code: 7, message: '文件内容验证失败，请正常上传', data: null });
    }

    // 质询通过 → 删除质询记录（防止重放）
    instantChallenges.delete(token);

    // 检查同名文件（含回收站）：存在则自动重命名为 "文件名 (1).ext"
    var VirtualFile = require('../lib/db').VirtualFile;
    var dbModule = require('../lib/db');
    function nameExistsInDir(name) {
      var vf = VirtualFile.listByDir(req.user.id, dirId).find(function(f) { return f.name === name; });
      if (vf) return true;
      var df = dbModule.get("SELECT id FROM deleted_files WHERE user_id = ? AND dir_id = ? AND name = ?", [req.user.id, dirId, name]);
      return !!df;
    }
    var originalName = fileName;
    if (nameExistsInDir(fileName)) {
      var ext = '', base = fileName;
      var dotIdx = fileName.lastIndexOf('.');
      if (dotIdx > 0) { base = fileName.substring(0, dotIdx); ext = fileName.substring(dotIdx); }
      else { base = fileName; ext = ''; }
      var n = 1;
      while (nameExistsInDir(base + ' (' + n + ')' + ext)) { n++; }
      fileName = base + ' (' + n + ')' + ext;
      log.info('[InstantUpload] 重命名: ' + originalName + ' → ' + fileName);
    }

    // 创建引用
    var UserFileRef = require('../lib/db').UserFileRef;
    UserFileRef.create(req.user.id, challenge.storageId, dirId, fileName, null);

    // 更新引用计数
    FileStorage.incrementRef(challenge.storageId);

    // 在 virtual_files 中也创建一条记录
    var vfId = VirtualFile.createWithEncVersion(
      req.user.id, dirId, fileName, fileSize,
      require('mime-types').lookup(fileName) || 'application/octet-stream',
      '', '',
      (function(){ var r = require('../lib/db').get('SELECT enc_version FROM file_storage WHERE id = ?', [challenge.storageId]); return (r && r.enc_version) || 1; })()
    );
    if (vfId) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [challenge.storageId, vfId]);
    }

    // 更新配额
    var User = require('../lib/db').User;
    var u = User.findById(req.user.id);
    if (u.used_bytes + fileSize <= u.quota_bytes) {
      User.updateUsedBytes(req.user.id, fileSize);
    }

    log.info('[InstantUpload] 秒传成功(质询通过): ' + fileName + ' hash=' + fileHash.substring(0, 12) + ' size=' + fileSize);
    return res.json({
      code: 0, message: '秒传成功', data: {
        id: vfId, name: fileName, size: fileSize,
        exists: true, is_instant: true, storage_id: challenge.storageId
      }
    });
  }

});

// POST /api/files/upload  上传文件
router.post('/files/upload', requireAuth, function(req, res) {
  var user = req.user;

  // 配额预检：流式读取，超配额立即切断连接，不浪费带宽
  parseMultipartWithQuotaCheck(req, user).then(function(result) {
    if (result && result.aborted) {
      return res.json({ code: 1, message: '存储空间不足，无法上传', data: null });
    }
    if (!result || !result.file) {
      return res.json({ code: 1, message: '未找到上传文件', data: null });
    }

    var dirId = parseInt(result.fields.dir_id || '0', 10);
    if (!checkPerm(user, dirId, 'upload')) return deny403(res, '无权限上传到此目录');

    var fileName = result.file.filename;
    var fileBuffer = result.file.buffer;

    if (!fileName || typeof fileName !== 'string') {
      return res.json({ code: 1, message: '文件名解析失败', data: null });
    }

    // 禁止特殊字符（Windows+Linux 平台兼容）
    var fileCheck = validateFileName(fileName, { maxLength: 200 });
    if (!fileCheck.valid) {
      return res.json({ code: 1, message: fileCheck.message, data: null });
    }

    // 检查配额
    if (user.used_bytes + fileBuffer.length > user.quota_bytes) {
      logger.logUpload(req, fileName, fileBuffer.length, false, '存储空间不足');
      return res.json({ code: 1, message: '存储空间不足，无法上传', data: null });
    }

    // ========== 存储架构 V3: 计算明文哈希 + 秒传去重 ==========
    var fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    var plaintextSize = fileBuffer.length;
    var mimeType = mime.lookup(fileName) || 'application/octet-stream';

    var FileStorage = require('../lib/db').FileStorage;
    var UserFileRef = require('../lib/db').UserFileRef;
    var fileId, storageId, isDedup = false;

    // 先检查去重：已存在同哈希+大小的文件 → 秒传
    var existing = FileStorage.findByHashAndSize(fileHash, plaintextSize);
    var brokenExisting = null; // 有记录但路径丢失的旧记录
    if (existing) {
      if (FileStorage.hasValidPath(existing.id)) {
        // 文件已存在且有可访问路径 → 秒传
        storageId = existing.id;
        FileStorage.incrementRef(storageId);
        isDedup = true;
        log.info('[Upload] 秒传: hash=' + fileHash.substring(0, 12) + ' -> storage_id=' + storageId);
      } else {
        // 有记录但路径全丢了 → 记下来，上传后修复引用
        brokenExisting = existing;
        log.info('[Upload] 已存在但路径无效，重新上传: hash=' + fileHash.substring(0, 12));
      }
    }

    if (!isDedup) {
      // 生成唯一存储名和相对路径
      var fileUuid = crypto.randomUUID();
      var StorageMod = require('../lib/db').Storage;
      var relPath = StorageMod.getDateBasedPath(fileUuid);

      // 加密到临时文件
      var tmpPath = Storage.getFilePath(user.id, fileUuid);
      try {
        var encResult = createV1EncryptStreamSync(tmpPath, fileBuffer);
        if (!encResult.ok) {
          logger.logUpload(req, fileName, fileBuffer.length, false, '文件加密失败');
          return res.json({ code: 1, message: '文件加密失败', data: null });
        }
      } catch (err) {
        logger.logUpload(req, fileName, fileBuffer.length, false, 'V1加密失败');
        return res.json({ code: 1, message: '文件加密失败', data: null });
      }

      // 写入锁检查：只在需要实际写入时检查
      var lockErr2 = require('../lib/db').StoragePool.checkWriteLock();
      if (lockErr2) {
        try { require('fs').unlinkSync(tmpPath); } catch(e) {}
        return res.status(503).json({ code: 503, message: lockErr2, data: null });
      }

      // 通过存储流写入均衡组
      var StorageStream = require('../lib/storage-stream');
      var writeResult = StorageStream.createWriteStream(relPath);
      var groupId = writeResult.groupId;
      log.info('[Upload] createWriteStream result: groupId=' + groupId + ' poolIds=' + JSON.stringify(writeResult.poolIds));

      if (groupId === null || groupId === undefined) {
        try { require('fs').unlinkSync(tmpPath); } catch(e) {}
        var errMsg2 = '没有可写入的存储组: groupId返回null';
        return res.status(503).json({ code: 503, message: errMsg2, data: null });
      }

      var encBuf = require('fs').readFileSync(tmpPath);
      ws = writeResult.stream;
      ws.end(encBuf);
      try { require('fs').unlinkSync(tmpPath); } catch(e) {}

      storageId = FileStorage.create(fileUuid, fileHash, plaintextSize, plaintextSize, ENC_V1_VERSION, true, encResult.nonce);
      require('../lib/db').run('UPDATE file_storage SET group_id = ? WHERE id = ?', [groupId, storageId]);
      (writeResult.poolIds || []).forEach(function(pid) {
        FileStorage.addPath(storageId, pid, relPath, relPath);
      });

      // 如果之前有同哈希但路径丢失的旧记录，迁移引用并清理
      var currentUserAlreadyHasRef = false;
      if (brokenExisting) {
        var oldRefs = FileStorage.listRefUsers(brokenExisting.id);
        oldRefs.forEach(function(ref) {
          UserFileRef.removeOneRef(brokenExisting.id, ref.user_id, ref.dir_id || 0, ref.name);
          UserFileRef.create(ref.user_id, storageId, ref.dir_id || 0, ref.name, null);
          if (ref.user_id === user.id) currentUserAlreadyHasRef = true;
        });
        require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE storage_id = ?', [storageId, brokenExisting.id]);
        FileStorage.delete(brokenExisting.id);
        log.info('[Upload] 修复旧引用: ' + oldRefs.length + ' 个用户 → 新 storage_id=' + storageId);
      }
    }

    // 检查同名文件（含回收站）：存在则自动重命名为 "文件名 (1).ext"
    var VirtualFile = require('../lib/db').VirtualFile;
    var dbModule = require('../lib/db');
    function nameExistsInDir(name) {
      var vf = VirtualFile.listByDir(user.id, dirId).find(function(f) { return f.name === name; });
      if (vf) return true;
      var df = dbModule.get("SELECT id FROM deleted_files WHERE user_id = ? AND dir_id = ? AND name = ?", [user.id, dirId, name]);
      return !!df;
    }
    var originalName = fileName;
    if (nameExistsInDir(fileName)) {
      var ext = '', base = fileName;
      var dotIdx = fileName.lastIndexOf('.');
      if (dotIdx > 0) { base = fileName.substring(0, dotIdx); ext = fileName.substring(dotIdx); }
      else { base = fileName; ext = ''; }
      var n = 1;
      while (nameExistsInDir(base + ' (' + n + ')' + ext)) { n++; }
      fileName = base + ' (' + n + ')' + ext;
      log.info('[Upload] 重命名: ' + originalName + ' → ' + fileName);
    }

    // 创建用户引用（如果修复迁移时已创建则跳过）
    if (!currentUserAlreadyHasRef) {
      UserFileRef.create(user.id, storageId, dirId, fileName, mimeType);
    }

    // 写入 virtual_files（同名文件直接覆盖，防止重复）
    var existingVF = VirtualFile.listByDir(user.id, dirId).find(function(f) { return f.name === fileName; });
    log.info('[Upload] vf check: fileName=' + fileName + ' existingVF=' + (existingVF?existingVF.id:'none') + ' isDedup=' + isDedup);
    if (existingVF) {
      require('../lib/db').run('UPDATE virtual_files SET size = ?, storage_id = ?, storage_path = ?, nonce = ? WHERE id = ?',
        [fileBuffer.length, storageId, isDedup ? '' : relPath, isDedup ? '' : fileUuid, existingVF.id]);
      fileId = existingVF.id;
      log.info('[Upload] 更新已有virtual_files: id=' + existingVF.id);
    } else {
      fileId = VirtualFile.createWithEncVersion(user.id, dirId, fileName, fileBuffer.length, mimeType, isDedup ? 'dedup_' + fileHash.substring(0, 12) : relPath, isDedup ? '' : fileUuid, ENC_V1_VERSION);
      if (fileId) {
        require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, fileId]);
      }
      log.info('[Upload] 新建virtual_files: id=' + fileId + ' name=' + fileName);
    }

    User.updateUsedBytes(user.id, fileBuffer.length);
    logger.logUpload(req, fileName, fileBuffer.length, true);
    logTraffic(user.id, '', 'upload', fileId, fileName, fileBuffer.length, fileBuffer.length);

    res.json({
      code: 0, message: isDedup ? '秒传成功（文件已存在）' : '上传成功', data: {
        id: fileId, name: fileName, size: fileBuffer.length, mime_type: mimeType, is_dedup: isDedup,
        file_hash: fileHash.substring(0, 16)
      }
    });
  }).catch(function(err) {
    log.error('[Upload] 解析失败:', err);
    logger.logUpload(req, '未知', 0, false, '解析失败: ' + err.message);
    var msg = err.message && err.message.includes('文件过大') ? err.message : '文件解析失败';
    res.json({ code: 1, message: msg, data: null });
  });
});

// ========== 存储架构 V2: 惰性迁移辅助函数 ==========
// 下载时自动将旧文件迁移到新的 file_storage 系统
function lazyMigrateFile(file) {
  var fs = require('fs');
  var crypto = require('crypto');
  var FileStorage = require('../lib/db').FileStorage;
  var StoragePool = require('../lib/db').StoragePool;
  var db = require('../lib/db');

  if (!fs.existsSync(file.storage_path)) return; // 文件不存在，无法迁移

  var fileBuf = fs.readFileSync(file.storage_path);
  var cryptoLib = require('../lib/crypto');
  var plainBuf;

  // 解密获取明文
  if (file.enc_version === 1) {
    // V1 格式：惰性迁移放在异步回调中，不阻塞下载
    try {
      var info = cryptoLib.getV1FileInfo(file.storage_path);
      if (info && info.originalSize > 0 && info.originalSize < 200 * 1024 * 1024) {
        var decryptStream2 = cryptoLib.createV1DecryptStream(file.storage_path);
        var chunks2 = [];
        decryptStream2.on('data', function(c) { chunks2.push(c); });
        decryptStream2.on('end', function() {
          try {
            var pb = Buffer.concat(chunks2);
            if (pb && pb.length > 0) {
              var fh = crypto.createHash('sha256').update(pb).digest('hex');
              var ex = FileStorage.findByHashAndSize(fh, pb.length);
              var sid;
              if (ex && FileStorage.hasValidPath(ex.id)) { sid = ex.id; FileStorage.incrementRef(sid); }
              else {
                sid = FileStorage.create(file.uuid || crypto.randomUUID(), fh, file.size, pb.length, file.enc_version || 1, true, file.nonce);
                FileStorage.addPath(sid, 1, file.storage_path.replace(/\\/g, '/'), file.storage_path.replace(/\\/g, '/'));
              }
              db.run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [sid, file.id]);
              log.info('[LazyMigrate] V1异步迁移完成: id=' + file.id + ' storage_id=' + sid);
            }
          } catch(e) { log.info('[LazyMigrate] V1异步迁移失败: ' + e.message); }
        });
        decryptStream2.on('error', function() {});
      }
    } catch(e) { log.info('[LazyMigrate] V1解密失败: ' + e.message); }
    return; // V1 文件的惰性迁移在后台异步完成，不阻塞下载
  } else if (file.nonce) {
    // 旧格式：nonce 解密
    try {
      var decResult = cryptoLib.createDecryptStream(fileBuf, file.nonce);
      plainBuf = decResult.plaintext;
    } catch(e) {
      log.info('[LazyMigrate] 旧格式解密失败: ' + e.message);
      return;
    }
  } else {
    // 未加密文件
    plainBuf = fileBuf;
  }

  if (!plainBuf || plainBuf.length === 0) return;

  // 计算哈希
  var fileHash = crypto.createHash('sha256').update(plainBuf).digest('hex');

  // 检查去重
  var existing = FileStorage.findByHashAndSize(fileHash, plainBuf.length);
  var storageId;

  if (existing && FileStorage.hasValidPath(existing.id)) {
    // 引用已有
    storageId = existing.id;
    FileStorage.incrementRef(storageId);
  } else {
    // 新建
    var uuid = file.uuid || crypto.randomUUID();
    storageId = FileStorage.create(uuid, fileHash, file.size, plainBuf.length, file.enc_version || 1, true, file.nonce);
    var defaultPool = StoragePool.getDefaultPath();
    var relPath = require('path').relative(defaultPool, file.storage_path).replace(/\\/g, '/');
    FileStorage.addPath(storageId, 1, relPath, file.storage_path.replace(/\\/g, '/'));
  }

  // 创建用户引用（如果还没有）
  var UserFileRef = require('../lib/db').UserFileRef;
  var existingRef = UserFileRef.findByUserAndFile(file.user_id, storageId);
  if (!existingRef) {
    UserFileRef.create(file.user_id, storageId, file.dir_id || 0, file.name, file.mime_type);
  }

  // 更新 virtual_files
  db.run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, file.id]);
}

// GET /api/files/download/:id  下载文件（流式解密，大文件不爆内存）
router.get('/files/download/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;

  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');

  if (!checkPerm(user, file.dir_id, 'download')) return deny403(res, '无权限下载');

  // 检查文件是否被封禁
  if (file.is_banned) {
    return res.status(403).json({
      code: 403,
      message: '文件已被管理员封禁: ' + (file.ban_reason || ''),
      data: null
    });
  }

  // 引用文件：找到源文件
  if (file.is_reference && file.reference_source_id) {
    var sourceFile = VirtualFile.findById(file.reference_source_id);
    if (!sourceFile || sourceFile.user_id !== user.id) return deny404(res, '源文件不存在或已被删除');
    var sourcePath = sourceFile.storage_path;
    if (!fs.existsSync(sourcePath)) return res.status(410).json({ code: 410, message: '文件已失效（源文件已被删除）', data: null });
    file = sourceFile;
  }

  // ========== 存储架构 V3: 解析实际文件路径（随机负载均衡） ==========
  var filePath = file.storage_path;
  // 秒传文件的 storage_path 为空但有 storage_id，同样需要从存储系统解析路径
  if (!filePath || !require('path').isAbsolute(filePath)) {
    var fsEntry = require('../lib/db').FileStorage.findById(file.storage_id || 0);
    var StoragePool = require('../lib/db').StoragePool;
    // 从 file_storage_paths + 全组池收集所有可访问路径，随机选一个实现负载均衡
    var validPaths = [];
    var seenPools = {};
    // 1) 查 file_storage_paths 记录
    var knownPaths = require('../lib/db').query(
      'SELECT fsp.relative_path, fsp.pool_id, sp.local_path FROM file_storage_paths fsp ' +
      'JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
      'WHERE fsp.storage_id = ? AND fsp.status = ?',
      [file.storage_id || 0, 'active']
    );
    knownPaths.forEach(function(kp) {
      if (seenPools[kp.pool_id]) return; seenPools[kp.pool_id] = true;
      var fp = require('path').join(kp.local_path, kp.relative_path);
      try { if (fs.existsSync(fp)) validPaths.push(fp); } catch(e) {}
    });
    // 2) 兜底：扫描该组所有非删除池
    if (validPaths.length === 0) {
      var groupId = fsEntry ? fsEntry.group_id : 0;
      var allPools = StoragePool.listAll().filter(function(p) { return p.group_id === groupId && p.status !== 'deleted'; });
      allPools.forEach(function(p) {
        if (seenPools[p.id]) return;
        if (!filePath) return;  // 秒传文件无 storage_path，靠 file_storage_paths 解析即可
        var fp = require('path').join(p.local_path, filePath);
        try { if (fs.existsSync(fp)) validPaths.push(fp); } catch(e) {}
      });
    }
    // 3) 随机选一个（并发负载均衡）
    if (validPaths.length > 0) {
      filePath = validPaths[Math.floor(Math.random() * validPaths.length)];
    }
  }
  if (!filePath || !fs.existsSync(filePath)) {
    // 有 storage_id 但物理文件丢失 → 文件已失效（被清理或移动）
    if (file.storage_id && file.storage_id > 0) {
      return res.status(410).json({ code: 410, message: '文件已失效（存储文件已被清理或移动）', data: { is_broken: true } });
    }
    return deny404(res, '文件不存在');
  }

  // ========== 存储架构 V2: 惰性迁移 ==========
  if (!file.storage_id || file.storage_id === 0) {
    // 文件尚未迁移到 V2，自动迁移
    try {
      lazyMigrateFile(file);
      // 重新读取更新后的 storage_id
      var updatedFile = VirtualFile.findById(fileId);
      if (updatedFile && updatedFile.storage_id > 0) {
        file.storage_id = updatedFile.storage_id;
        log.info('[Download] 惰性迁移完成: fileId=' + fileId + ' storage_id=' + updatedFile.storage_id);
      }
    } catch(e) {
      log.info('[Download] 惰性迁移失败（继续正常下载）: ' + e.message);
    }
  }

  var fileSize = fs.statSync(filePath).size;

  // 获取文件加密版本
  var encVersion = file.enc_version || 0;

  // 判断是否加密（优先用 DB 记录的 enc_version）
  var isEncrypted = false;
  var decryptedSize = fileSize;

  if (encVersion === 1) {
    // V1 分块格式
    var v1Info = getV1FileInfo(filePath);
    if (v1Info.isV1) {
      isEncrypted = true;
      decryptedSize = v1Info.originalSize;
    }
  } else if (encVersion === -1) {
    // 未加密
    isEncrypted = false;
  } else {
    // 旧格式（enc_version === 0）或未记录：用魔法字节检测
    if (fileSize >= 88) {
      var magicBuf = Buffer.alloc(4);
      var fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, magicBuf, 0, 4, 0);
      fs.closeSync(fd);
      var magic = magicBuf.toString('ascii');
      var isVideoMagic = (magic === 'ftyp' || magic === 'moov' || magic === 'mdat');
      var isImageMagic = (magicBuf[0] === 0xFF && magicBuf[1] === 0xD8) ||
                         (magicBuf[0] === 0x89 && magicBuf[1] === 0x50 && magicBuf[2] === 0x4E && magicBuf[3] === 0x47);
      if (!isVideoMagic && !isImageMagic) {
        isEncrypted = true;
        decryptedSize = fileSize - 88;
      }
    }
  }

  log.info('[Download] 用户 ' + user.email + ' 下载文件: ' + file.name + ' (' + Math.round(fileSize / 1024 / 1024 * 10) / 10 + 'MB), encVersion=' + encVersion + ', isEncrypted=' + isEncrypted);

  // 检查流量配额
  var quotaInfo = TrafficQuota.get(user.id, '', false);
  if (quotaInfo.used_bytes + decryptedSize > quotaInfo.quota_bytes) {
    return res.status(403).json({
      code: 403,
      message: '月度流量配额不足（已用 ' + formatFileSize(quotaInfo.used_bytes) + ' / 配额 ' + formatFileSize(quotaInfo.quota_bytes) + '）',
      data: {
        quota: quotaInfo.quota_bytes,
        used: quotaInfo.used_bytes,
        overage: quotaInfo.used_bytes + decryptedSize - quotaInfo.quota_bytes
      }
    });
  }

  res.set('Content-Type', file.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(file.name) + '"');
  res.set('Content-Length', decryptedSize);

  if (!isEncrypted) {
    // 未加密：直接返回
    logger.logDownload(req, file.name, fileId, true);
    // 设置流量元数据，由全局中间件在响应完成时按实际传输字节记录
    res._trafficMeta = { category: 'file_transfer', action_type: 'download', file_id: fileId, file_name: file.name, file_size: decryptedSize, user_id: user.id, guest_ip: '' };
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 加密文件：流式解密
  try {
    if (encVersion === 1) {
      // V1 格式：完整文件流
      var v1Stream = createV1DecryptStream(filePath, 0, decryptedSize - 1);
      logger.logDownload(req, file.name, fileId, true);
      // 设置流量元数据，由全局中间件在响应完成时按实际传输字节记录
      res._trafficMeta = { category: 'file_transfer', action_type: 'download', file_id: fileId, file_name: file.name, file_size: decryptedSize, user_id: user.id, guest_ip: '' };
      v1Stream.on('error', function(err) {
        log.error('[Download] V1 流错误:', err.message);
        if (!res.headersSent) { res.statusCode = 500; res.end(); }
      });
      v1Stream.pipe(res);
    } else {
      // 旧格式
      var streamInfo = createDecryptStream(filePath);
      logger.logDownload(req, file.name, fileId, true);
      // 设置流量元数据，由全局中间件在响应完成时按实际传输字节记录
      res._trafficMeta = { category: 'file_transfer', action_type: 'download', file_id: fileId, file_name: file.name, file_size: decryptedSize, user_id: user.id, guest_ip: '' };
      streamInfo.readStream.on('error', function(err) {
        log.error('[Download] 流错误:', err.message);
        if (!res.headersSent) { res.statusCode = 500; res.end(); }
      });
      streamInfo.readStream.pipe(res);
    }
  } catch (err) {
    log.error('[Download] 流式解密初始化失败:', err.message);
    return deny404(res, '文件读取失败');
  }
});

// DELETE /api/files/:id  将文件移入回收站（软删除）
router.delete('/files/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;

  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');

  if (!checkPerm(user, file.dir_id, 'delete')) return deny403(res, '无权限删除');

  // 移入回收站（保留物理文件，更新配额）
  var moved = RecycleBin.moveFile(fileId, user.id);
  if (!moved) return deny404(res, '文件不存在');

  User.updateUsedBytes(user.id, -moved.size);

  // ========== 存储架构 V2: 减少引用计数 ==========
  var FileStorage = require('../lib/db').FileStorage;
  var UserFileRef = require('../lib/db').UserFileRef;
  // 通过 virtual_files 的 storage_id 查找引用
  if (moved.storage_id && moved.storage_id > 0) {
    UserFileRef.removeOneRef(moved.storage_id, user.id, moved.dir_id || 0, moved.name);
    var newRefCount = FileStorage.decrementRef(moved.storage_id);
    log.info('[Delete] storage_id=' + moved.storage_id + ' ref_count=' + newRefCount + ' user=' + user.id);
    // ref_count = 0 → 立即清理物理文件
    if (newRefCount === 0) {
      var paths = FileStorage.getValidPaths(moved.storage_id);
      paths.forEach(function(p) {
        var fp = p.full_path;
        if (fp && !require('path').isAbsolute(fp) && p.local_path) fp = require('path').join(p.local_path, fp);
        try { require('fs').unlinkSync(fp); log.info('[Delete] 物理删除: ' + fp); } catch(e) {}
      });
      FileStorage.delete(moved.storage_id);
      log.info('[Delete] ref_count=0, 已物理删除 storage_id=' + moved.storage_id);
    }
  }

  logger.logRecycleDelete(req, moved.name, false, true);

  res.json({ code: 0, message: '文件已移入回收站', data: null });
});

// POST /api/files/:id/rename  重命名个人文件
router.post('/files/:id/rename', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;
  var newName = (req.body.name || '').trim();

  if (!newName) return res.json({ code: 1, message: '新文件名不能为空', data: null });
  var fileCheck = validateFileName(newName, { maxLength: 200 });
  if (!fileCheck.valid) return res.json({ code: 1, message: fileCheck.message, data: null });

  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'write')) return deny403(res, '无权限');

  try {
    VirtualFile.rename(fileId, newName);
    logger.logRename(req, file.name, newName, fileId, true);
    res.json({ code: 0, message: '重命名成功', data: { id: fileId, name: newName } });
  } catch (err) {
    log.error('[Rename] 重命名文件失败:', err);
    logger.logRename(req, file.name, newName, fileId, false, err.message);
    res.json({ code: 1, message: '重命名失败', data: null });
  }
});

// POST /api/files/:id/move  移动个人文件到指定目录
router.post('/files/:id/move', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;
  var targetDirId = req.body.target_dir_id ? parseInt(req.body.target_dir_id, 10) : 0;

  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'write')) return deny403(res, '无权限');

  // 检查目标目录
  if (targetDirId) {
    var targetDir = VirtualDir.findById(targetDirId);
    if (!targetDir || targetDir.user_id !== user.id) {
      return res.json({ code: 1, message: '目标目录不存在', data: null });
    }
    if (!checkPerm(user, targetDirId, 'write')) return deny403(res, '无权限写入目标目录');
  }

  // 不能把文件移动到自身所在目录
  if (file.dir_id === targetDirId) {
    return res.json({ code: 1, message: '文件已在目标目录中', data: null });
  }

  // 检查目标目录是否有同名文件
  var existing = query('SELECT id FROM virtual_files WHERE user_id = ? AND dir_id = ? AND name = ?', [user.id, targetDirId, file.name]);
  if (existing && existing.length > 0) {
    return res.json({ code: 2, message: '目标目录存在同名文件 "' + file.name + '"', data: { conflict: true, fileName: file.name } });
  }

  VirtualFile.moveTo(fileId, targetDirId);
  logger.logMove(req, 'file', file.name, fileId, '移动到 dir_id=' + targetDirId);
  res.json({ code: 0, message: '文件已移动', data: null });
});

// POST /api/dirs/:id/rename  重命名个人目录
router.post('/dirs/:id/rename', requireAuth, function(req, res) {
  var dirId = parseInt(req.params.id, 10);
  var user = req.user;
  var newName = (req.body.name || '').trim();

  if (!newName) return res.json({ code: 1, message: '新目录名不能为空', data: null });
  var dirCheck = validateDirName(newName);
  if (!dirCheck.valid) return res.json({ code: 1, message: dirCheck.message, data: null });

  var dir = VirtualDir.findById(dirId);
  if (!dir || dir.user_id !== user.id) return deny404(res, '目录不存在');
  if (!checkPerm(user, dirId, 'write')) return deny403(res, '无权限');

  try {
    VirtualDir.rename(dirId, newName);
    logger.logRenameDir(req, dir.name, newName, dirId, true);
    res.json({ code: 0, message: '重命名成功', data: { id: dirId, name: newName } });
  } catch (err) {
    log.error('[Rename] 重命名目录失败:', err);
    logger.logRenameDir(req, dir.name, newName, dirId, false, err.message);
    res.json({ code: 1, message: '重命名失败', data: null });
  }
});

// POST /api/dirs/:id/move  移动个人目录到指定父目录
router.post('/dirs/:id/move', requireAuth, function(req, res) {
  var dirId = parseInt(req.params.id, 10);
  var user = req.user;
  var targetParentId = req.body.target_parent_id ? parseInt(req.body.target_parent_id, 10) : 0;

  var dir = VirtualDir.findById(dirId);
  if (!dir || dir.user_id !== user.id) return deny404(res, '目录不存在');
  if (!checkPerm(user, dirId, 'write')) return deny403(res, '无权限');

  // 不能移动到自身内部
  if (dirId === targetParentId) {
    return res.json({ code: 1, message: '不能将目录移动到自身内部', data: null });
  }

  // 检查目标父目录
  if (targetParentId) {
    var targetParent = VirtualDir.findById(targetParentId);
    if (!targetParent || targetParent.user_id !== user.id) {
      return res.json({ code: 1, message: '目标目录不存在', data: null });
    }
    if (!checkPerm(user, targetParentId, 'write')) return deny403(res, '无权限写入目标目录');
    // 检查是否将目录移动到自身子目录下（防止循环）
    var childIds = VirtualDir.getAllChildIds(dirId);
    if (childIds.indexOf(targetParentId) !== -1) {
      return res.json({ code: 1, message: '不能将目录移动到自身子目录下', data: null });
    }
  }

  // 检查目标目录是否有同名子目录
  var existing = query('SELECT id FROM virtual_dirs WHERE user_id = ? AND parent_id = ? AND name = ?', [user.id, targetParentId, dir.name]);
  if (existing && existing.length > 0) {
    return res.json({ code: 2, message: '目标目录存在同名子目录 "' + dir.name + '"', data: { conflict: true, dirName: dir.name } });
  }

  run('UPDATE virtual_dirs SET parent_id = ? WHERE id = ?', [targetParentId, dirId]);
  logger.logMove(req, 'directory', dir.name, dirId, '移动到 parent_id=' + targetParentId);
  res.json({ code: 0, message: '目录已移动', data: null });
});

// ==================== 公共目录（直接文件系统，不加密）====================
// path 参数：URL 编码的相对路径，如 "" 表示根目录，"folder1/sub" 表示根目录下的 folder1/sub

// GET /api/public-files/list?path=xxx  公共目录列表（支持子目录）
router.get('/public-files/list', requireAuth, function(req, res) {
  // 前端已用 encodeURIComponent 编码，后端直接解码即可正确还原包含 + 等特殊字符的路径
  var relPath = req.query.path ? decodeURIComponent(req.query.path) : '';
  var publicRoot = Storage.PUBLIC_DIR;
  var targetDir;

  // 安全检查：禁止 .. 跳出 publicRoot
  try {
    targetDir = path.resolve(publicRoot, relPath);
    if (!targetDir.startsWith(publicRoot)) {
      return res.json({ code: 1, message: '非法路径', data: { dirs: [], files: [] } });
    }
  } catch (e) {
    return res.json({ code: 1, message: '路径解析失败', data: { dirs: [], files: [] } });
  }

  Storage.ensurePublicDir();

  var entries;
  try {
    entries = fs.readdirSync(targetDir);
  } catch (err) {
    return res.json({ code: 1, message: '读取目录失败', data: { dirs: [], files: [] } });
  }

  var dirs = [];
  var files = [];

  entries.forEach(function(name) {
    if (name === '.' || name === '..') return;
    // 过滤删除标记文件
    if (name.endsWith('.delbak')) return;
    var fullPath = path.join(targetDir, name);
    try {
      var stat = fs.statSync(fullPath);
      // 相对路径用 / 拼接（中文路径在文件系统上正常读取）
      var childRel = relPath ? relPath + '/' + name : name;
      if (stat.isDirectory()) {
        dirs.push({
          id: name,           // 原始中文名，未编码，前端直接使用
          child_path: childRel,
          name: name,
          parent_path: relPath,
          created_at: stat.ctime
        });
      } else {
        files.push({
          id: name,           // 原始中文名，未编码，前端直接使用
          relPath: childRel,  // 完整相对路径，含父目录，用于下载/删除/重命名
          name: name,
          size: stat.size,
          mime_type: mime.lookup(name) || 'application/octet-stream',
          created_at: stat.ctime
        });
      }
    } catch (err) {
      log.warn('[PublicList] 跳过 ' + name + ':', err.message);
    }
  });

  dirs.sort(function(a, b) { return a.name.localeCompare(b.name); });
  files.sort(function(a, b) { return a.name.localeCompare(b.name); });

  res.json({ code: 0, message: 'success', data: { dirs: dirs, files: files } });
});

// POST /api/public-files/upload  上传公共文件（仅管理员）
router.post('/public-files/upload', requireAdmin, function(req, res) {
  parseMultipart(req).then(function(result) {
    if (!result || !result.file) {
      return res.json({ code: 1, message: '未找到上传文件', data: null });
    }

    var relPath = (result.fields.dir_path || '').trim();
    var fileName = result.file.filename;
    var fileBuffer = result.file.buffer;

    if (!fileName || typeof fileName !== 'string' || fileName.trim() === '') {
      return res.json({ code: 1, message: '文件名无效', data: null });
    }
    var fileCheck = validateFileName(fileName, { maxLength: 200 });
    if (!fileCheck.valid) {
      return res.json({ code: 1, message: fileCheck.message, data: null });
    }

    var publicRoot = Storage.PUBLIC_DIR;
    var targetDir;
    try {
      targetDir = path.resolve(publicRoot, relPath);
      if (!targetDir.startsWith(publicRoot)) {
        return res.json({ code: 1, message: '非法路径', data: null });
      }
    } catch (e) {
      return res.json({ code: 1, message: '路径无效', data: null });
    }

    // 确保目录存在
    Storage.ensurePublicDir();
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    var storagePath = path.join(targetDir, fileName);
    try {
      fs.writeFileSync(storagePath, fileBuffer);
    } catch (err) {
      log.error('[PublicUpload] 保存失败:', err);
      return res.json({ code: 1, message: '文件保存失败', data: null });
    }

    var stat = fs.statSync(storagePath);
    var savedRelPath = relPath ? relPath + '/' + fileName : fileName;
    logger.logPublicUpload(req, fileName, stat.size, true);

    // 记录上传流量
    logTraffic(req.user.id, '', 'upload', 0, savedRelPath, stat.size, stat.size);

    res.json({
      code: 0, message: '上传成功', data: {
        id: savedRelPath,
        name: fileName,
        size: stat.size,
        mime_type: mime.lookup(fileName) || 'application/octet-stream'
      }
    });
  }).catch(function(err) {
    log.error('[PublicUpload] 解析失败:', err);
    var msg = err.message && err.message.includes('文件过大') ? err.message : '文件解析失败';
    res.json({ code: 1, message: msg, data: null });
  });
});

// GET /api/public-files/download  下载公共文件（query: path=相对路径）
router.get('/public-files/download', requireAuth, function(req, res) {
  // Express 的 query parser 不会自动 decode '%2F'（因为 / 在 URL path 中是保留字符），
  // 所以这里手动 decode，确保 test%2Ffile.txt → test/file.txt
  var relPath = req.query.path ? decodeURIComponent(req.query.path) : '';
  var publicRoot = Storage.PUBLIC_DIR;
  var filePath;

  try {
    filePath = path.resolve(publicRoot, relPath);
    if (!filePath.startsWith(publicRoot)) {
      return deny403(res, '非法路径');
    }
  } catch (e) {
    return deny404(res, '文件不存在');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return deny404(res, '文件不存在');
  }

  var fileName = path.basename(filePath);
  var fileSize = fs.statSync(filePath).size;
  log.info('[PublicDownload] 用户 ' + req.user.email + ' 下载: ' + relPath);
  logger.logPublicDownload(req, relPath, true);

  // 设置流量元数据，由全局中间件在响应完成时按实际传输字节记录
  res._trafficMeta = { category: 'file_transfer', action_type: 'download', file_id: 0, file_name: relPath, file_size: fileSize, user_id: req.user.id, guest_ip: '' };

  res.download(filePath, fileName);
});

// POST /api/public-files/rename  重命名公共文件（仅管理员）
router.post('/public-files/rename', requireAdmin, function(req, res) {
  // req.body.path 来自前端 JSON body（已经是解码字符串）
  var relPath = (req.body.path || '');
  var newName = (req.body.new_name || '').trim();

  if (!newName) return res.json({ code: 1, message: '新文件名不能为空', data: null });
  var fileCheck = validateFileName(newName, { maxLength: 200 });
  if (!fileCheck.valid) {
    return res.json({ code: 1, message: fileCheck.message, data: null });
  }

  var publicRoot = Storage.PUBLIC_DIR;
  var oldPath, newPath, parentDir;

  try {
    oldPath = path.resolve(publicRoot, relPath);
    var parentRel = '';
    var slashIdx = relPath.lastIndexOf('/');
    if (slashIdx >= 0) {
      parentRel = relPath.substring(0, slashIdx);
    }
    parentDir = parentRel ? path.resolve(publicRoot, parentRel) : publicRoot;
    newPath = path.join(parentDir, newName);
    if (!oldPath.startsWith(publicRoot) || !newPath.startsWith(publicRoot)) {
      return res.json({ code: 1, message: '非法路径', data: null });
    }
  } catch (e) {
    return res.json({ code: 1, message: '路径无效', data: null });
  }

  if (!fs.existsSync(oldPath) || fs.statSync(oldPath).isDirectory()) {
    return res.json({ code: 1, message: '文件不存在', data: null });
  }
  if (fs.existsSync(newPath)) {
    return res.json({ code: 1, message: '目标文件名已存在', data: null });
  }

  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    return res.json({ code: 1, message: '重命名失败: ' + err.message, data: null });
  }

  var newRelPath = parentRel ? parentRel + '/' + newName : newName;
  res.json({ code: 0, message: '重命名成功', data: { id: encodeURIComponent(newRelPath), name: newName } });
});

// POST /api/public-dirs  创建公共目录（仅管理员）
router.post('/public-dirs', requireAdmin, function(req, res) {
  var relPath = (req.body.path || '').trim(); // 父目录相对路径
  var name = (req.body.name || '').trim();
  if (!name) return res.json({ code: 1, message: '目录名不能为空', data: null });
  var dirCheck = validateDirName(name);
  if (!dirCheck.valid) return res.json({ code: 1, message: dirCheck.message, data: null });

  var publicRoot = Storage.PUBLIC_DIR;
  var newDirPath;

  try {
    newDirPath = path.resolve(publicRoot, relPath ? relPath + '/' + name : name);
    if (!newDirPath.startsWith(publicRoot)) {
      return res.json({ code: 1, message: '非法路径', data: null });
    }
  } catch (e) {
    return res.json({ code: 1, message: '路径无效', data: null });
  }

  Storage.ensurePublicDir();

  if (fs.existsSync(newDirPath)) {
    return res.json({ code: 1, message: '目录已存在', data: null });
  }

  try {
    fs.mkdirSync(newDirPath, { recursive: true });
  } catch (err) {
    return res.json({ code: 1, message: '创建目录失败', data: null });
  }

  var newRelPath = relPath ? relPath + '/' + name : name;
  res.json({ code: 0, message: '目录已创建', data: { id: encodeURIComponent(newRelPath), name: name } });
});

// POST /api/public-dirs/rename  重命名公共目录（仅管理员）
router.post('/public-dirs/rename', requireAdmin, function(req, res) {
  // req.body 中的路径来自前端 JSON body（已经是解码字符串）
  var relPath = (req.body.path || ''); // 目录相对路径
  var newName = (req.body.new_name || '').trim();

  if (!newName) return res.json({ code: 1, message: '新目录名不能为空', data: null });
  var dirCheck = validateDirName(newName);
  if (!dirCheck.valid) return res.json({ code: 1, message: dirCheck.message, data: null });

  var publicRoot = Storage.PUBLIC_DIR;
  var oldPath, newPath, parentDir;

  try {
    oldPath = path.resolve(publicRoot, relPath);
    var parentRel = '';
    var slashIdx = relPath.lastIndexOf('/');
    if (slashIdx >= 0) {
      parentRel = relPath.substring(0, slashIdx);
    }
    parentDir = parentRel ? path.resolve(publicRoot, parentRel) : publicRoot;
    newPath = path.join(parentDir, newName);
    if (!oldPath.startsWith(publicRoot) || !newPath.startsWith(publicRoot)) {
      return res.json({ code: 1, message: '非法路径', data: null });
    }
  } catch (e) {
    return res.json({ code: 1, message: '路径无效', data: null });
  }

  if (!fs.existsSync(oldPath) || !fs.statSync(oldPath).isDirectory()) {
    return res.json({ code: 1, message: '目录不存在', data: null });
  }
  if (fs.existsSync(newPath)) {
    return res.json({ code: 1, message: '目标目录名已存在', data: null });
  }

  try {
    fs.renameSync(oldPath, newPath);
  } catch (err) {
    return res.json({ code: 1, message: '重命名失败: ' + err.message, data: null });
  }

  res.json({ code: 0, message: '重命名成功', data: { id: encodeURIComponent(parentRel ? parentRel + '/' + newName : newName), name: newName } });
});

// DELETE /api/public-files  删除公共文件（仅管理员，query: path=相对路径），重命名+Redis标记
router.delete('/public-files', requireAdmin, function(req, res) {
  // 手动 decode，防止 %2F 被当作字面字符
  var relPath = req.query.path ? decodeURIComponent(req.query.path) : '';
  var publicRoot = Storage.PUBLIC_DIR;
  var filePath;

  try {
    filePath = path.resolve(publicRoot, relPath);
    if (!filePath.startsWith(publicRoot)) return deny403(res, '非法路径');
  } catch (e) {
    return deny404(res, '文件不存在');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return deny404(res, '文件不存在');
  }

  var fileStat = fs.statSync(filePath);
  var mimeType = mime.lookup(filePath) || 'application/octet-stream';
  var fileName = path.basename(filePath);
  var dirPath = path.dirname(filePath);

  // 用 Redis INCR 原子计数器获取唯一序号（多文件同时删除也不会冲突）
  var DelFile = require('../lib/redis').DelFile;
  DelFile._nextSeq().then(function(nextSeq) {
    var deletedName = fileName + '.' + nextSeq + '.delbak';
    var deletedPath = path.join(dirPath, deletedName);

    // 重命名文件为删除后缀
    try {
      fs.renameSync(filePath, deletedPath);
    } catch (err) {
      return res.json({ code: 1, message: '重命名失败: ' + err.message, data: null });
    }

    // 将删除标记存入 Redis（必须等待完成后再返回）
    return DelFile.add(fileName, deletedPath, fileStat.size, mimeType, req.user.id, nextSeq).then(function() {
      logger.logPublicDelete(req, relPath, false, true);
      log.info('[PublicDelete] 删除文件（重命名）: ' + relPath + ' -> ' + deletedName + ' seq=' + nextSeq);
      res.json({ code: 0, message: '文件已删除', data: null });
    }).catch(function(e) {
      log.error('[PublicDelete] Redis写入失败:', e.message);
      // 即使 Redis 失败也不影响，文件已重命名，可手动恢复
      logger.logPublicDelete(req, relPath, false, true);
      log.info('[PublicDelete] 删除文件（重命名）: ' + relPath + ' -> ' + deletedName + ' seq=' + nextSeq + ' (Redis写入失败)');
      res.json({ code: 0, message: '文件已删除（警告：恢复标记存储失败）', data: null });
    });
  });
});

// POST /api/public-files/move  移动公共文件（仅管理员）
router.post('/public-files/move', requireAdmin, function(req, res) {
  var relPath = (req.body.path || '');
  var targetRelPath = (req.body.target_path || '');

  if (!relPath) return res.json({ code: 1, message: '缺少源路径', data: null });

  var publicRoot = Storage.PUBLIC_DIR;
  var oldPath, newPath;

  try {
    oldPath = path.resolve(publicRoot, relPath);
    if (!oldPath.startsWith(publicRoot)) return res.json({ code: 1, message: '非法源路径', data: null });
    var fileName = path.basename(oldPath);
    newPath = path.resolve(publicRoot, targetRelPath ? targetRelPath + '/' + fileName : fileName);
    if (!newPath.startsWith(publicRoot)) return res.json({ code: 1, message: '非法目标路径', data: null });
  } catch (e) {
    return res.json({ code: 1, message: '路径无效', data: null });
  }

  if (!fs.existsSync(oldPath) || fs.statSync(oldPath).isDirectory()) return res.json({ code: 1, message: '文件不存在', data: null });
  if (fs.existsSync(newPath)) return res.json({ code: 2, message: '目标目录存在同名文件', data: { conflict: true, fileName: path.basename(newPath) } });

  try { fs.renameSync(oldPath, newPath); } catch (err) { return res.json({ code: 1, message: '移动失败: ' + err.message, data: null }); }

  var newRelPath = targetRelPath ? targetRelPath + '/' + path.basename(newPath) : path.basename(newPath);
  res.json({ code: 0, message: '文件已移动', data: { id: encodeURIComponent(newRelPath), name: path.basename(newPath) } });
});

// POST /api/public-dirs/move  移动公共目录（仅管理员）
router.post('/public-dirs/move', requireAdmin, function(req, res) {
  var relPath = (req.body.path || '');
  var targetRelPath = (req.body.target_path || '');

  if (!relPath) return res.json({ code: 1, message: '缺少源路径', data: null });

  var publicRoot = Storage.PUBLIC_DIR;
  var oldPath, newPath;

  try {
    oldPath = path.resolve(publicRoot, relPath);
    if (!oldPath.startsWith(publicRoot)) return res.json({ code: 1, message: '非法源路径', data: null });
    var dirName = path.basename(oldPath);
    newPath = path.resolve(publicRoot, targetRelPath ? targetRelPath + '/' + dirName : dirName);
    if (!newPath.startsWith(publicRoot)) return res.json({ code: 1, message: '非法目标路径', data: null });
  } catch (e) {
    return res.json({ code: 1, message: '路径无效', data: null });
  }

  if (!fs.existsSync(oldPath) || !fs.statSync(oldPath).isDirectory()) return res.json({ code: 1, message: '目录不存在', data: null });
  if (fs.existsSync(newPath)) return res.json({ code: 2, message: '目标位置存在同名目录', data: { conflict: true, dirName: path.basename(newPath) } });

  try { fs.renameSync(oldPath, newPath); } catch (err) { return res.json({ code: 1, message: '移动失败: ' + err.message, data: null }); }

  var newRelPath = targetRelPath ? targetRelPath + '/' + path.basename(newPath) : path.basename(newPath);
  res.json({ code: 0, message: '目录已移动', data: { id: encodeURIComponent(newRelPath), name: path.basename(newPath) } });
});

// DELETE /api/public-dirs  删除公共目录（仅管理员，递归），重命名+Redis标记
router.delete('/public-dirs', requireAdmin, function(req, res) {
  var relPath = req.query.path ? decodeURIComponent(req.query.path) : '';
  var publicRoot = Storage.PUBLIC_DIR;
  var dirPath;

  try {
    dirPath = path.resolve(publicRoot, relPath);
    if (!dirPath.startsWith(publicRoot)) return deny403(res, '非法路径');
  } catch (e) {
    return deny404(res, '目录不存在');
  }

  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return deny404(res, '目录不存在');
  }

  // 不允许删除根目录
  if (relPath === '' || relPath === '.') {
    return res.json({ code: 1, message: '不能删除根目录', data: null });
  }

  // 重命名目录为 .delbak 后缀（软删除）
  var dirName = path.basename(dirPath);
  var DelFile = require('../lib/redis').DelFile;
  DelFile._nextSeq().then(function(nextSeq) {
    var deletedName = dirName + '.' + nextSeq + '.delbak';
    var parentDir = path.dirname(dirPath);
    var deletedPath = path.join(parentDir, deletedName);

    try {
      fs.renameSync(dirPath, deletedPath);
    } catch (err) {
      return res.json({ code: 1, message: '删除失败: ' + err.message, data: null });
    }

    // 记录到回收站（传入重命名后的路径）
    RecycleBin.movePublicDir(dirPath, dirName, req.user.id, deletedPath);

    logger.logPublicDelete(req, relPath, true, true);
    log.info('[PublicDeleteDir] 删除目录（重命名）: ' + relPath + ' -> ' + deletedName + ' seq=' + nextSeq);
    res.json({ code: 0, message: '目录已删除', data: null });
  });
});

// ==================== 管理员API ====================

// GET /api/admin/users  用户列表
router.get('/admin/users', requireAdmin, function(req, res) {
  var page = Math.max(1, (parseInt(req.query.page, 10) || 1));
  var limit = Math.min(200, Math.max(1, (parseInt(req.query.limit, 10) || 20)));
  var keyword = req.query.keyword || '';
  var result = User.getAll(page, limit, keyword);
  var users = result.users;

  // 批量查询流量配额
  var userIds = users.map(function(u) { return u.id; });
  var quotaMap = {};
  var period = new Date().toISOString().substring(0, 7);
  userIds.forEach(function(uid) {
    var q = TrafficQuota.get(uid, '', false);
    quotaMap[uid] = q;
  });

  res.json({
    code: 0, message: 'success', data: {
      users: users.map(function(u) {
        var q = quotaMap[u.id] || {};
        return {
          id: u.id, email: u.email, nickname: u.nickname,
          is_admin: u.is_admin, is_active: u.is_active,
          is_banned: !!u.is_banned,
          ban_reason: u.ban_reason || '',
          ban_expires_at: u.ban_expires_at || null,
          quota_bytes: u.quota_bytes, used_bytes: u.used_bytes,
          monthly_quota: q.quota_bytes || 10737418240,
          monthly_used: q.used_bytes || 0,
          created_at: u.created_at, last_login: u.last_login
        };
      }),
      total: result.total,
      page: page,
      limit: limit
    }
  });
});

// PUT /api/admin/users/:id/quota  存储配额
router.put('/admin/users/:id/quota', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var { quota_bytes } = req.body;
  quota_bytes = parseInt(quota_bytes, 10);
  if (!quota_bytes || quota_bytes < 0) {
    return res.json({ code: 1, message: '配额值无效', data: null });
  }
  User.updateQuota(userId, quota_bytes);
  var targetUser = User.findById(userId);
  logger.logAdmin(req, 'update_quota', 'user', targetUser ? targetUser.email : userId, String(userId), '新存储配额: ' + quota_bytes + ' bytes');
  res.json({ code: 0, message: '存储配额已更新', data: null });
});

// PUT /api/admin/users/:id/admin
router.put('/admin/users/:id/admin', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var { is_admin } = req.body;
  if (userId === req.user.id) {
    return res.json({ code: 1, message: '不能修改自己的管理员权限', data: null });
  }
  User.setAdmin(userId, is_admin ? true : false);
  var targetUser = User.findById(userId);
  logger.logAdmin(req, 'set_admin', 'user', targetUser ? targetUser.email : userId, String(userId), 'is_admin=' + (is_admin ? 1 : 0));
  res.json({ code: 0, message: '权限已更新', data: null });
});

// PUT /api/admin/users/:id/active
router.put('/admin/users/:id/active', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var { is_active } = req.body;
  User.setActive(userId, is_active ? true : false);
  var targetUser = User.findById(userId);
  logger.logAdmin(req, 'set_active', 'user', targetUser ? targetUser.email : userId, String(userId), 'is_active=' + (is_active ? 1 : 0));
  res.json({ code: 0, message: '状态已更新', data: null });
});

// GET /api/admin/users/:id/permissions
router.get('/admin/users/:id/permissions', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var perms = Permission.getAllForUser(userId);
  res.json({ code: 0, message: 'success', data: perms });
});

// PUT /api/admin/users/:id/permissions
router.put('/admin/users/:id/permissions', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.json({ code: 1, message: '参数错误', data: null });

  // permissions: [{ dir_id, can_read, can_write, can_delete, can_upload, can_download, can_create_dir }]
  for (var i = 0; i < permissions.length; i++) {
    var p = permissions[i];
    Permission.set(userId, p.dir_id, {
      canRead: !!p.can_read,
      canWrite: !!p.can_write,
      canDelete: !!p.can_delete,
      canUpload: !!p.can_upload,
      canDownload: !!p.can_download,
      canCreateDir: !!p.can_create_dir
    });
  }
  var targetUser = User.findById(userId);
  logger.logAdmin(req, 'update_perms', 'user', targetUser ? targetUser.email : userId, String(userId), '更新了 ' + permissions.length + ' 个目录权限');
  res.json({ code: 0, message: '权限已更新', data: null });
});

// ==================== 回收站 API ====================

// GET /api/recycle  获取回收站列表
router.get('/recycle', requireAuth, function(req, res) {
  var user = req.user;
  var files = RecycleBin.listFiles(user.id);
  var dirs = RecycleBin.listDirs(user.id);
  var fileCount = RecycleBin.countFiles(user.id);
  var dirCount = RecycleBin.countDirs(user.id);

  var formattedFiles = (files || []).map(function(f) {
    return {
      id: f.id,
      name: f.name,
      size: f.size,
      mime_type: f.mime_type,
      dir_id: f.dir_id,
      original_dir_name: f.original_dir_name || '',
      deleted_at: f.deleted_at,
      expires_at: f.expires_at,
      remaining_text: formatRemainingTime(f.expires_at),
      remaining_ms: getRemainingMs(f.expires_at),
      type: 'file'
    };
  });

  var formattedDirs = (dirs || []).map(function(d) {
    return {
      id: d.id,
      name: d.name,
      parent_id: d.parent_id,
      original_dir_path: d.original_dir_path || '',
      file_count: d.file_count || 0,
      deleted_at: d.deleted_at,
      expires_at: d.expires_at,
      remaining_text: formatRemainingTime(d.expires_at),
      remaining_ms: getRemainingMs(d.expires_at),
      type: 'directory'
    };
  });

  res.json({
    code: 0,
    data: {
      files: formattedFiles,
      dirs: formattedDirs,
      total: formattedFiles.length + formattedDirs.length
    }
  });
});

// POST /api/recycle/files/:id/restore  恢复文件
router.post('/recycle/files/:id/restore', requireAuth, function(req, res) {
  var recycleFileId = parseInt(req.params.id, 10);
  var user = req.user;
  var force = req.body.force || false;
  var userProvidedTarget = req.body.target_dir_id !== undefined;

  // 先获取文件信息（恢复后会从 deleted_files 删除）
  var fileInfo = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [recycleFileId, user.id]);
  if (!fileInfo) return res.json({ code: 1, message: '文件不存在', data: null });

  // 如果前端没有指定目标目录，尝试用原始目录
  var targetDirId = 0;
  if (userProvidedTarget) {
    targetDirId = parseInt(req.body.target_dir_id, 10);
    // 验证目标目录有效性
    if (targetDirId) {
      var targetDir = VirtualDir.findById(targetDirId);
      if (!targetDir || targetDir.user_id !== user.id) {
        return res.json({ code: 1, message: '目标目录不存在', data: null });
      }
      if (!checkPerm(user, targetDirId, 'write')) return deny403(res, '无权限写入目标目录');
    }
  } else {
    // 前端未指定目标目录，尝试恢复到原始目录
    if (fileInfo.dir_id && fileInfo.dir_id !== 0) {
      var originalDir = VirtualDir.findById(fileInfo.dir_id);
      if (originalDir && originalDir.user_id === user.id) {
        // 原始目录仍然存在，使用它
        targetDirId = fileInfo.dir_id;
      } else {
        // 原始目录已不存在，返回特殊码让前端弹出目录选择框
        return res.json({
          code: 3,
          message: '原始目录已不存在，请选择恢复到的目录',
          data: {
            needs_dir_select: true,
            fileId: recycleFileId,
            fileName: fileInfo.name,
            availableDirs: getAvailableDirs(user.id)
          }
        });
      }
    } else {
      targetDirId = 0; // 根目录
    }
  }

  var result = RecycleBin.restoreFile(recycleFileId, user.id, targetDirId);

  if (!result.ok) {
    if (result.reason === 'name_conflict') {
      if (force) {
        // 永久删除同名文件后恢复
        var existingFile = get('SELECT id, nonce, size FROM virtual_files WHERE user_id = ? AND dir_id = ? AND name = ?', [user.id, targetDirId, result.fileName]);
        if (existingFile) {
          Storage.deleteFile(user.id, existingFile.nonce);
          run('DELETE FROM virtual_files WHERE id = ?', [existingFile.id]);
          User.updateUsedBytes(user.id, -existingFile.size);
        }
        RecycleBin.restoreFile(recycleFileId, user.id, targetDirId);
        User.updateUsedBytes(user.id, fileInfo.size);
        logger.logRecycleRestore(req, fileInfo.name, false, true);
        return res.json({ code: 0, message: '已替换并恢复', data: null });
      }
      return res.json({
        code: 2,
        message: '目标目录存在同名文件 "' + result.fileName + '"，是否替换？',
        data: { conflict: true, fileName: result.fileName }
      });
    }
    return res.json({ code: 1, message: '文件不存在或无法恢复', data: null });
  }

  // 恢复成功，更新配额
  User.updateUsedBytes(user.id, fileInfo.size);
  logger.logRecycleRestore(req, fileInfo.name, false, true);
  res.json({ code: 0, message: '文件已恢复', data: null });
});

// 获取用户可用的目录列表（用于恢复时让用户选择目录）
function getAvailableDirs(userId) {
  var allDirs = query('SELECT id, parent_id, name FROM virtual_dirs WHERE user_id = ? ORDER BY name', [userId]);
  var dirs = [];
  allDirs.forEach(function(d) {
    var pathParts = [];
    var curId = d.parent_id;
    while (curId && curId !== 0) {
      var parent = VirtualDir.findById(curId);
      if (parent) {
        pathParts.unshift(parent.name);
        curId = parent.parent_id;
      } else { break; }
    }
    dirs.push({
      id: d.id,
      name: d.name,
      path: pathParts.join('/')
    });
  });
  // 添加根目录选项
  dirs.unshift({ id: 0, name: '根目录', path: '' });
  return dirs;
}

// POST /api/recycle/dirs/:id/restore  恢复目录
router.post('/recycle/dirs/:id/restore', requireAuth, function(req, res) {
  var recycleDirId = parseInt(req.params.id, 10);
  var user = req.user;
  var force = req.body.force || false;
  var userProvidedTarget = req.body.target_parent_id !== undefined;

  var deletedDir = get('SELECT * FROM deleted_dirs WHERE id = ? AND user_id = ?', [recycleDirId, user.id]);
  if (!deletedDir) return res.json({ code: 1, message: '目录不存在', data: null });

  var targetParentId = 0;
  if (userProvidedTarget) {
    targetParentId = parseInt(req.body.target_parent_id, 10);
    if (targetParentId) {
      var targetDir = VirtualDir.findById(targetParentId);
      if (!targetDir || targetDir.user_id !== user.id) {
        return res.json({ code: 1, message: '目标目录不存在', data: null });
      }
    }
  } else {
    // 尝试恢复到原始父目录
    if (deletedDir.parent_id && deletedDir.parent_id !== 0) {
      var originalParent = VirtualDir.findById(deletedDir.parent_id);
      if (originalParent && originalParent.user_id === user.id) {
        targetParentId = deletedDir.parent_id;
      } else {
        // 原始目录不存在，返回特殊码让前端弹出目录选择框
        return res.json({
          code: 3,
          message: '原始目录已不存在，请选择恢复到的位置',
          data: {
            needs_dir_select: true,
            dirId: recycleDirId,
            dirName: deletedDir.name,
            availableDirs: getAvailableDirs(user.id)
          }
        });
      }
    } else {
      targetParentId = 0;
    }
  }

  var result = RecycleBin.restoreDir(recycleDirId, user.id, targetParentId);

  if (!result.ok) {
    if (result.reason === 'name_conflict') {
      return res.json({
        code: 2,
        message: '目标位置存在同名目录 "' + result.dirName + '"，请先处理',
        data: { conflict: true, dirName: result.dirName }
      });
    }
    return res.json({ code: 1, message: '目录不存在或无法恢复', data: null });
  }

  logger.logRecycleRestore(req, deletedDir.name, true, true);
  res.json({ code: 0, message: '目录已恢复', data: null });
});

// DELETE /api/recycle/files/:id  永久删除文件
router.delete('/recycle/files/:id', requireAuth, function(req, res) {
  var recycleFileId = parseInt(req.params.id, 10);
  var user = req.user;

  var file = RecycleBin.purgeFile(recycleFileId, user.id);
  if (!file) return res.json({ code: 1, message: '文件不存在', data: null });

  // 删除物理文件（旧路径，如果还在用的话）
  Storage.deleteFile(user.id, file.nonce);

  // ========== 存储架构 V2: 如果还有引用则不删物理文件 ==========
  // 软删除时已减引用计数，这里检查是否需要清理
  // ref_count 已归零的文件会在凌晨定时任务统一清理

  // 不需要更新配额（配额在软删除时已扣除）

  logger.logRecyclePurge(req, file.name, false, true);
  res.json({ code: 0, message: '文件已永久删除', data: null });
});

// DELETE /api/recycle/dirs/:id  永久删除目录（递归删除所有子目录和文件）
router.delete('/recycle/dirs/:id', requireAuth, function(req, res) {
  var recycleDirId = parseInt(req.params.id, 10);
  var user = req.user;

  var dir = get('SELECT * FROM deleted_dirs WHERE id = ? AND user_id = ?', [recycleDirId, user.id]);
  if (!dir) return res.json({ code: 1, message: '目录不存在', data: null });

  // 递归永久删除（删除文件和所有子回收站目录）
  function purgeRecurse(rid) {
    // 删除该目录下所有文件
    var files = query('SELECT * FROM deleted_files WHERE user_id = ? AND recycle_dir_id = ?', [user.id, rid]);
    files.forEach(function(f) {
      Storage.deleteFile(user.id, f.nonce);
      RecycleBin._decrementStorageRef(f, user.id);
      run('DELETE FROM deleted_files WHERE id = ?', [f.id]);
    });
    // 递归删除子回收站目录
    var children = query('SELECT id FROM deleted_dirs WHERE user_id = ? AND parent_recycle_id = ?', [user.id, rid]);
    children.forEach(function(child) {
      purgeRecurse(child.id);
    });
    // 删除自身
    run('DELETE FROM deleted_dirs WHERE id = ?', [rid]);
  }

  purgeRecurse(recycleDirId);

  logger.logRecyclePurge(req, dir.name, true, true);
  res.json({ code: 0, message: '目录已永久删除', data: null });
});

// DELETE /api/recycle  清空回收站
router.delete('/recycle', requireAuth, function(req, res) {
  var user = req.user;

  // 先删除所有物理文件
  var files = RecycleBin.listFiles(user.id);
  files.forEach(function(f) {
    Storage.deleteFile(user.id, f.nonce);
  });

  var result = RecycleBin.emptyAll(user.id);
  logger.logRecycleEmpty(req, result.files ? result.files.length : 0, 0, true);

  res.json({ code: 0, message: '回收站已清空', data: { count: result.files ? result.files.length : 0 } });
});

// ==================== 公共目录回收站 API ====================

// GET /api/public-recycle  获取公共回收站列表（文件从Redis，目录从SQLite）
router.get('/public-recycle', requireAuth, function(req, res) {
  var DelFile = require('../lib/redis').DelFile;

  DelFile.listAll().then(function(files) {
    var dirs = RecycleBin.listPublicDirs();

    var formattedFiles = (files || []).map(function(f) {
      var now = Date.now();
      var expiresAtMs = new Date(f.expiresAt).getTime();
      var remainingMs = expiresAtMs - now;
      var remainingStr = '';
      if (remainingMs > 0) {
        var days = Math.floor(remainingMs / (24 * 3600 * 1000));
        var hours = Math.floor((remainingMs % (24 * 3600 * 1000)) / (3600 * 1000));
        var minutes = Math.floor((remainingMs % (3600 * 1000)) / (60 * 1000));
        if (days > 0) remainingStr = days + '天' + hours + '小时';
        else if (hours > 0) remainingStr = hours + '小时' + minutes + '分钟';
        else remainingStr = minutes + '分钟';
      }
      return {
        id: f.seq,
        name: f.originalName,
        size: f.size,
        mime_type: f.mimeType,
        original_path: f.storagePath,
        deleted_at: f.deletedAt,
        expires_at: f.expiresAt,
        remaining_text: remainingStr,
        remaining_ms: remainingMs,
        type: 'file'
      };
    });

    var formattedDirs = (dirs || []).map(function(d) {
      var now = Date.now();
      var expiresAtMs = new Date(d.expires_at).getTime();
      var remainingMs = expiresAtMs - now;
      var remainingStr = '';
      if (remainingMs > 0) {
        var days = Math.floor(remainingMs / (24 * 3600 * 1000));
        var hours = Math.floor((remainingMs % (24 * 3600 * 1000)) / (3600 * 1000));
        var minutes = Math.floor((remainingMs % (3600 * 1000)) / (60 * 1000));
        if (days > 0) remainingStr = days + '天' + hours + '小时';
        else if (hours > 0) remainingStr = hours + '小时' + minutes + '分钟';
        else remainingStr = minutes + '分钟';
      }
      return {
        id: d.id,
        name: d.name,
        original_path: d.dir_path || '',
        deleted_at: d.deleted_at,
        expires_at: d.expires_at,
        remaining_text: remainingStr,
        remaining_ms: remainingMs,
        type: 'directory'
      };
    });

    res.json({
      code: 0,
      data: {
        files: formattedFiles,
        dirs: formattedDirs,
        total: formattedFiles.length + formattedDirs.length
      }
    });
  });
});

// POST /api/public-recycle/files/:id/restore  恢复公共文件（id为Redis序号）
router.post('/public-recycle/files/:id/restore', requireAdmin, function(req, res) {
  var DelFile = require('../lib/redis').DelFile;
  var seq = req.params.id;

  DelFile.get(seq).then(function(record) {
    if (!record) return res.json({ code: 1, message: '文件不存在或已过期', data: null });

    var deletedPath = record.storagePath;
    var originalName = record.originalName;
    var targetPath = path.join(path.dirname(deletedPath), originalName);

    // 检查原路径是否已有同名文件
    if (fs.existsSync(targetPath)) {
      return res.json({
        code: 2,
        message: '目标目录存在同名文件 "' + originalName + '"',
        data: { conflict: true, fileName: originalName }
      });
    }

    // 重命名回来（移除 .delbak 后缀）
    try {
      fs.renameSync(deletedPath, targetPath);
    } catch (err) {
      return res.json({ code: 1, message: '恢复失败: ' + err.message, data: null });
    }

    // 从 Redis 删除标记
    DelFile.remove(seq);

    logger.logPublicRestore(req, originalName, false, true);
    log.info('[PublicRestore] 恢复文件: ' + originalName);
    res.json({ code: 0, message: '文件已恢复', data: null });
  });
});

// POST /api/public-recycle/dirs/:id/restore  恢复公共目录（从SQLite）
router.post('/public-recycle/dirs/:id/restore', requireAdmin, function(req, res) {
  var recycleId = parseInt(req.params.id, 10);
  var result = RecycleBin.restorePublicDir(recycleId);

  if (!result.ok) {
    if (result.reason === 'name_conflict') {
      return res.json({
        code: 2,
        message: '目标目录存在同名目录 "' + result.dirName + '"',
        data: { conflict: true, dirName: result.dirName }
      });
    }
    return res.json({ code: 1, message: '目录不存在或无法恢复', data: null });
  }

  logger.logPublicRestore(req, result.dirName, true, true);
  res.json({ code: 0, message: '目录已恢复', data: null });
});

// DELETE /api/public-recycle/files/:id  永久删除公共回收站文件（id为Redis序号）
router.delete('/public-recycle/files/:id', requireAdmin, function(req, res) {
  var DelFile = require('../lib/redis').DelFile;
  var seq = req.params.id;

  DelFile.get(seq).then(function(record) {
    if (!record) return res.json({ code: 1, message: '文件不存在或已过期', data: null });

    var deletedPath = record.storagePath;

    // 删除物理文件
    try {
      if (fs.existsSync(deletedPath)) {
        fs.unlinkSync(deletedPath);
      }
    } catch (e) {}

    // 从 Redis 删除标记
    DelFile.remove(seq);

    logger.logPublicPurge(req, record.originalName, false, true);
    log.info('[PublicPurge] 永久删除: ' + record.originalName);
    res.json({ code: 0, message: '文件已永久删除', data: null });
  });
});

// GET /api/public-recycle/files/:id/download  下载回收站文件（id为Redis序号，文件在.delbak后缀路径）
router.get('/public-recycle/files/:id/download', requireAdmin, function(req, res) {
  var DelFile = require('../lib/redis').DelFile;
  var seq = req.params.id;

  DelFile.get(seq).then(function(record) {
    if (!record) return deny404(res, '文件不存在或已过期');

    var deletedPath = record.storagePath;
    if (!fs.existsSync(deletedPath)) {
      return deny404(res, '文件不存在或已过期');
    }

    var fileName = record.originalName;
    log.info('[PublicRecycleDownload] 用户 ' + req.user.email + ' 下载回收站文件: ' + fileName);
    res.download(deletedPath, fileName);
  });
});

// DELETE /api/public-recycle/dirs/:id  永久删除公共回收站目录（从SQLite）
router.delete('/public-recycle/dirs/:id', requireAdmin, function(req, res) {
  var recycleId = parseInt(req.params.id, 10);
  var dir = RecycleBin.purgePublicDir(recycleId);
  if (!dir) return res.json({ code: 1, message: '目录不存在', data: null });

  logger.logPublicPurge(req, dir.name, true, true);
  res.json({ code: 0, message: '目录已永久删除', data: null });
});

// DELETE /api/public-recycle  清空公共回收站
router.delete('/public-recycle', requireAdmin, function(req, res) {
  var DelFile = require('../lib/redis').DelFile;

  // 先从 Redis 获取所有文件记录，删除物理文件
  DelFile.listAll().then(function(files) {
    var deletedCount = 0;
    files.forEach(function(f) {
      try {
        if (fs.existsSync(f.storagePath)) {
          fs.unlinkSync(f.storagePath);
        }
      } catch (e) {}
      DelFile.remove(f.seq);
      deletedCount++;
    });

    // 清空 SQLite 中的目录
    var result = RecycleBin.emptyPublicAll();

    logger.logPublicEmpty(req, deletedCount, result.dirs ? result.dirs.length : 0);

    res.json({
      code: 0,
      message: '公共回收站已清空',
      data: { files: deletedCount, dirs: result.dirs ? result.dirs.length : 0 }
    });
  });
});

// ==================== 管理员：清理过期回收站文件（定时任务调用） ====================
// GET /api/admin/recycle/purge-expired  管理员清理过期文件
router.get('/admin/recycle/purge-expired', requireAdmin, function(req, res) {
  // 个人文件过期清理（SQLite）
  var personalResult = RecycleBin.purgeExpired();
  // 公共文件过期清理（Redis）
  var DelFile = require('../lib/redis').DelFile;
  DelFile.purgeExpired().then(function(publicResult) {
    var combined = {
      personal: personalResult,
      public: publicResult,
      total: personalResult.count + publicResult.count
    };
    log.info('[RecycleBin] 自动清理过期文件: ' + JSON.stringify(combined));
    res.json({ code: 0, message: '已清理过期文件', data: combined });
  });
});

// ==================== 转存文件（从分享保存到自己的目录） ====================
// POST /api/files/save
// body: { hash, file_ids[], target_dir_id, mode: 'link'|'copy' }
// mode=link: 创建引用（不占空间），mode=copy: 复制文件（占空间）
router.post('/files/save', requireAuth, function(req, res) {
  var user = req.user;
  var hash = req.body.hash;
  var fileIds = req.body.file_ids; // array of file IDs in share
  var targetDirId = parseInt(req.body.target_dir_id, 10) || 0;
  var mode = req.body.mode || 'link';

  if (!hash || !Array.isArray(fileIds) || fileIds.length === 0) {
    return res.json({ code: 1, message: '参数错误', data: null });
  }

  var share = require('../lib/db').Share.getByHash(hash);
  if (!share) return res.json({ code: 1, message: '分享不存在', data: null });

  var validity = require('../lib/db').Share.checkValidity(share);
  if (!validity.valid) return res.json({ code: 1, message: '分享已失效', data: null });

  var remaining = getRemainingMs(share.expires_at);
  if (remaining !== 0 && remaining <= 0) return res.json({ code: 1, message: '分享已过期', data: null });

  // 如果目标是根目录（targetDirId === 0），自动在根目录创建「我的转存」文件夹
  if (targetDirId === 0) {
    var existingSaveDir = VirtualDir.findByName(user.id, 0, '我的转存');
    if (existingSaveDir) {
      targetDirId = existingSaveDir.id;
    } else {
      var newDirId = VirtualDir.create(user.id, 0, '我的转存');
      if (!newDirId) return res.json({ code: 1, message: '创建「我的转存」目录失败', data: null });
      Permission.set(user.id, newDirId, {
        canRead: true, canWrite: true, canDelete: true,
        canUpload: true, canDownload: true, canCreateDir: true
      });
      targetDirId = newDirId;
    }
  }

  // 验证目标目录存在且属于当前用户
  if (targetDirId !== 0) {
    var targetDir = VirtualDir.findById(targetDirId);
    if (!targetDir || targetDir.user_id !== user.id) {
      return res.json({ code: 1, message: '目标目录不存在', data: null });
    }
  }

  // 确认用户配额（copy 模式需要检查）
  if (mode === 'copy') {
    var totalSize = 0;
    fileIds.forEach(function(fileId) {
      var f = VirtualFile.findById(fileId);
      if (f) totalSize += f.size || 0;
    });
    if (user.used_bytes + totalSize > user.quota_bytes) {
      return res.json({ code: 1, message: '存储空间不足，无法转存副本', data: null });
    }
  }

  var saved = [];
  var errors = [];

  fileIds.forEach(function(fileId) {
    // 查找文件（从分享的目录中）
    var sourceFile;
    if (share.target_type === 'dir') {
      sourceFile = VirtualFile.findById(fileId);
    } else if (parseInt(share.target_id, 10) === parseInt(fileId, 10)) {
      sourceFile = VirtualFile.findById(fileId);
    }

    if (!sourceFile) {
      errors.push({ id: fileId, error: '文件不存在' });
      return;
    }

    if (mode === 'link') {
      // 引用模式：使用源文件的存储路径（引用不占存储空间，由 reference_source_id 关联源文件）
      var refId = VirtualFile.create(user.id, targetDirId, sourceFile.name, sourceFile.size, sourceFile.mime_type, sourceFile.storage_path, sourceFile.nonce, {
        is_reference: 1,
        reference_source_id: sourceFile.id
      });
      saved.push({ id: refId, name: sourceFile.name, mode: 'link' });
    } else {
      // 副本模式：复制文件
      var newFileId = VirtualFile.copy(sourceFile.id, user.id, targetDirId);
      if (newFileId) {
        saved.push({ id: newFileId, name: sourceFile.name, mode: 'copy' });
      } else {
        errors.push({ id: fileId, error: '复制失败' });
      }
    }
  });

  res.json({
    code: 0,
    message: '转存完成',
    data: { saved: saved, errors: errors }
  });
});

// 获取用户根目录（用于转存时选择目录）
router.get('/files/dirs', requireAuth, function(req, res) {
  var user = req.user;
  var dirs = VirtualDir.listRoot(user.id);
  res.json({ code: 0, data: dirs });
});

// ==================== 离线下载功能 ====================

// 确保用户有"下载"目录，返回目录ID
function ensureDownloadDir(userId) {
  // 先查找「我的下载」目录
  var downloadDir = VirtualDir.findByName(userId, 0, '我的下载');
  if (downloadDir && downloadDir.id) {
    // 确保权限存在
    var existingPerm = Permission.get(userId, downloadDir.id);
    if (!existingPerm) {
      Permission.set(userId, downloadDir.id, {
        canRead: true, canWrite: true, canDelete: true,
        canUpload: true, canDownload: true, canCreateDir: true
      });
    }
    return downloadDir.id;
  }

  // 不存在则创建
  var newDirId = VirtualDir.create(userId, 0, '我的下载');
  if (!newDirId) {
    log.error('[Offline] 为用户 ' + userId + ' 创建「我的下载」目录失败，使用根目录');
    return 0;
  }

  // 设置权限
  try {
    Permission.set(userId, newDirId, {
      canRead: true, canWrite: true, canDelete: true,
      canUpload: true, canDownload: true, canCreateDir: true
    });
  } catch(e) {
    log.error('[Offline] 设置目录权限失败:', e.message);
  }

  log.info('[Offline] 为用户 ' + userId + ' 自动创建「我的下载」目录，ID: ' + newDirId);
  return newDirId;
}

// ==================== 离线下载 ====================
// POST /api/offline/create  创建离线下载任务
router.post('/offline/create', requireAuth, function(req, res) {
  var user = req.user;
  var url = (req.body.url || '').trim();
  var targetDirId = parseInt(req.body.target_dir_id, 10) || 0;

  if (!url) return res.json({ code: 1, message: '请填写URL', data: null });

  // 智能提取文件名
  var filename = '';
  try {
    var u = new URL(url);
    var parts = u.pathname.split('/').filter(Boolean);
    var lastPart = parts.length > 0 ? parts[parts.length - 1] : '';
    if (lastPart && lastPart !== '/') {
      try { filename = decodeURIComponent(lastPart); } catch(e) { filename = lastPart; }
    }
    // 移除 URL 查询参数（某些 URL 把参数放在 path 里）
    if (filename.includes('?')) filename = filename.split('?')[0];

    // 文件名清理
    filename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\0/g, '');

    // 如果文件名无效或缺少扩展名，生成带时间戳的名称
    if (!filename || filename === '/' || filename.length > 200) {
      filename = 'download_' + Date.now();
    } else if (!filename.includes('.') && filename.length < 3) {
      // 路径太短且无扩展名，如 "/a" → 生成带时间戳的
      filename = filename + '_' + Date.now();
    }
  } catch(e) {
    filename = 'download_' + Date.now();
  }

  // 仅支持 HTTP/HTTPS
  if (!/^https?:\/\//i.test(url)) {
    return res.json({ code: 1, message: '仅支持 HTTP/HTTPS 链接', data: null });
  }

  var mimeType = mime.lookup(filename) || 'application/octet-stream';
  var dirId = targetDirId;

  // 检查目录权限
  if (dirId !== 0) {
    if (!checkPerm(user, dirId, 'upload')) return deny403(res, '无权限上传到目标目录');
  } else {
    // 默认放到"下载"目录
    dirId = ensureDownloadDir(user.id);
  }

  var task = OfflineDownload.create(user.id, url, filename, mimeType, dirId);
  if (!task) return res.json({ code: 1, message: '创建任务失败', data: null });

  log.info('[Offline] 用户 ' + user.email + ' 创建下载任务: ' + filename + ' -> ' + url);
  res.json({ code: 0, message: '创建成功', data: task });
});

// GET /api/offline/list  获取离线下载列表
router.get('/offline/list', requireAuth, function(req, res) {
  var user = req.user;
  var tasks = OfflineDownload.listByUser(user.id);
  res.json({ code: 0, message: 'ok', data: tasks });
});

// GET /api/offline/:id  获取任务详情
router.get('/offline/:id', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10);
  var user = req.user;
  var task = OfflineDownload.findById(taskId, user.id);
  if (!task) return deny404(res, '任务不存在');
  res.json({ code: 0, message: 'ok', data: task });
});

// POST /api/offline/:id/start  开始/重新开始
router.post('/offline/:id/start', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10);
  var user = req.user;
  var task = OfflineDownload.findById(taskId, user.id);
  if (!task) return deny404(res, '任务不存在');
  if (task.status === 'completed') return res.json({ code: 1, message: '任务已完成', data: null });
  if (task.status === 'cancelled') return res.json({ code: 1, message: '任务已取消', data: null });

  // 立即返回
  res.json({ code: 0, message: '开始', data: null });

  // 执行下载（传入 req 以支持同源认证 URL）
  doOfflineDownload(task, user, req, function(err, fileId) {
    if (err) {
      log.error('[Offline] 下载失败: ' + err.message);
      if (wsPush) wsPush.pushOfflineUpdate(user.id, taskId, 'failed', { error: err.message });
    } else {
      if (wsPush) wsPush.pushOfflineUpdate(user.id, taskId, 'completed', { fileId: fileId });
    }
  });
});

// POST /api/offline/:id/pause  暂停任务
router.post('/offline/:id/pause', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10);
  var user = req.user;
  var task = OfflineDownload.findById(taskId, user.id);
  if (!task) return deny404(res, '任务不存在');
  // 已完成/已取消/已失败的任务不能暂停
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') {
    return res.json({ code: 1, message: '无法暂停', data: null });
  }
  OfflineDownload.updateStatus(taskId, 'paused');
  res.json({ code: 0, message: '已暂停', data: null });
});

// POST /api/offline/:id/cancel  取消任务
router.post('/offline/:id/cancel', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10);
  var user = req.user;
  var task = OfflineDownload.findById(taskId, user.id);
  if (!task) return deny404(res, '任务不存在');
  if (task.status === 'completed') return res.json({ code: 1, message: '已完成的任务无法取消', data: null });
  OfflineDownload.updateStatus(taskId, 'cancelled');
  res.json({ code: 0, message: '已取消', data: null });
});

// DELETE /api/offline/:id  删除任务
router.delete('/offline/:id', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10);
  var user = req.user;
  var task = OfflineDownload.findById(taskId, user.id);
  if (!task) return deny404(res, '任务不存在');
  OfflineDownload.delete(taskId, user.id);
  res.json({ code: 0, message: '已删除', data: null });
});

// 执行离线下载（Node.js 原生 HTTP/HTTPS，支持重定向、浏览器头、大文件流式下载）
// 最大重定向次数
var MAX_REDIRECTS = 10;

function doOfflineDownload(task, user, req, callback) {
  // 在异步操作前提取 session cookie 和 host（避免 req 被清理后无法访问）
  var sessionCookie = null;
  var reqHost = '';
  if (req && req.headers) {
    reqHost = req.headers.host || '';
    if (req.headers.cookie) {
      var match = req.headers.cookie.match(/(fileservice\.sid=[^;]+)/);
      if (match) sessionCookie = match[0];
    }
  }

  // 开始前先更新状态为 downloading
  OfflineDownload.markDownloading(task.id);

  var freshTask = OfflineDownload.findById(task.id, user.id);

  // 通知前端任务开始
  if (wsPush) {
    wsPush.pushOfflineUpdate(user.id, task.id, 'started', {
      status: 'downloading',
      progress: 0,
      downloaded_bytes: 0,
      total_bytes: 0,
      task: freshTask || task
    });
  }

  // 发起请求（支持重定向跟随）
  _doRequest(task.url, 0);

  function _doRequest(targetUrl, redirectCount) {
    // 检查是否超过最大重定向次数
    if (redirectCount > MAX_REDIRECTS) {
      var tooManyErr = '重定向次数过多（超过' + MAX_REDIRECTS + '次），最终URL: ' + targetUrl;
      log.error('[Offline] ' + tooManyErr);
      OfflineDownload.updateStatus(task.id, 'failed', tooManyErr);
      if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: tooManyErr });
      return callback(new Error(tooManyErr));
    }

    // 每次请求前检查任务状态（支持外部取消/暂停）
    var currentTask = OfflineDownload.findById(task.id, user.id);
    if (!currentTask) {
      return callback(new Error('任务不存在'));
    }
    if (currentTask.status === 'cancelled') {
      return callback(new Error('任务已取消'));
    }
    if (currentTask.status === 'paused') {
      // 暂停状态：不报错，静默返回，等待用户手动恢复
      return callback(null, null);
    }

    var isHttps = targetUrl.toLowerCase().startsWith('https:');
    var httpModule = isHttps ? require('https') : require('http');

    // 解析 URL 获取 hostname + path
    var parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch(e) {
      var parseErr = 'URL 格式无效: ' + targetUrl;
      log.error('[Offline] ' + parseErr);
      OfflineDownload.updateStatus(task.id, 'failed', parseErr);
      if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: parseErr });
      return callback(new Error(parseErr));
    }

    // 构建浏览器级请求头
    var requestHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',  // 不压缩，方便流式处理
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': parsedUrl.origin + '/',
    };

    // 同源请求：携带 session cookie（支持需要登录的 API，如 /api/public-files/download）
    if (sessionCookie) {
      var targetHost = parsedUrl.host;
      log.info('[Offline] 同源检测: reqHost=' + reqHost + ' targetHost=' + targetHost);
      if (reqHost && targetHost === reqHost) {
        requestHeaders['Cookie'] = sessionCookie;
        log.info('[Offline] 同源请求，携带 session cookie');
      }
    }

    var reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: requestHeaders,
      timeout: 120000,  // 120 秒超时
      rejectUnauthorized: false,  // 允许自签名证书
      family: 4  // 强制 IPv4（某些服务器 IPv6 不通）
    };

    log.info('[Offline] 请求: ' + targetUrl + ' (重定向次数: ' + redirectCount + ')');
    log.info('[Offline] 请求头: User-Agent=' + requestHeaders['User-Agent'].substring(0, 50) + '...');

    var req = httpModule.request(reqOptions, function(httpRes) {
      var statusCode = httpRes.statusCode || 0;
      log.info('[Offline] HTTP响应: status=' + statusCode + ', content-type=' + httpRes.headers['content-type']);

      // 处理重定向
      if (statusCode >= 300 && statusCode < 400 && httpRes.headers.location) {
        // 消耗掉响应体，避免内存泄漏
        httpRes.resume();

        var redirectUrl = httpRes.headers.location;
        // 处理相对路径重定向
        if (redirectUrl.startsWith('/')) {
          redirectUrl = parsedUrl.origin + redirectUrl;
        } else if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
          redirectUrl = parsedUrl.origin + '/' + redirectUrl;
        }

        log.info('[Offline] 重定向 -> ' + redirectUrl);
        // 更新任务 URL（便于暂停后恢复时使用最新 URL）
        OfflineDownload._updateUrl(task.id, redirectUrl);
        return _doRequest(redirectUrl, redirectCount + 1);
      }

      // 非 2xx 响应：下载失败
      if (statusCode < 200 || statusCode >= 300) {
        httpRes.resume();
        var statusErr = '服务器返回错误状态码: ' + statusCode + ' (URL: ' + targetUrl.substring(0, 100) + ')';
        log.error('[Offline] ' + statusErr);
        OfflineDownload.updateStatus(task.id, 'failed', statusErr);
        if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: statusErr });
        return callback(new Error(statusErr));
      }

      // ===== 正常下载流程 =====
      var totalBytes = parseInt(httpRes.headers['content-length'], 10) || 0;
      var filename = task.filename;
      var mimeType = httpRes.headers['content-type'] || mime.lookup(filename) || 'application/octet-stream';

      // 解析 Content-Disposition 获取真实文件名
      var cd = httpRes.headers['content-disposition'];
      if (cd) {
        var m = cd.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
        if (!m) m = cd.match(/filename=(?:"([^"]*)"|'([^']*)'|([^;]+))/i);
        if (m) {
          var rawName = m[1] || m[2] || m[3] || '';
          rawName = rawName.trim().replace(/^["']|["']$/g, '');
          try {
            filename = decodeURIComponent(rawName);
          } catch(e) {
            filename = rawName;
          }
        }
      }

      // 如果文件名缺少扩展名，从 URL 补充
      if (!filename.includes('.') && task.filename.includes('.')) {
        filename = task.filename;
      }

      // 确保文件名安全（移除非法字符）
      filename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\0/g, '');
      if (!filename || filename.length > 200) {
        filename = 'download_' + Date.now();
      }

      log.info('[Offline] 文件名: ' + filename + ', 大小: ' + (totalBytes > 0 ? Math.round(totalBytes / 1024) + 'KB' : '未知'));

      // 先下载到临时文件
      var uuid = crypto.randomBytes(16).toString('hex');
      var storagePath = Storage.getFilePath(user.id, uuid);
      var tempPath = storagePath + '.tmp';
      var writeStream = fs.createWriteStream(tempPath);
      var downloadedBytes = 0;
      var lastUpdate = Date.now();
      var lastBytes = 0;

      writeStream.on('error', function(err) {
        try { httpRes.destroy(); } catch(e) {}
        try { fs.unlinkSync(tempPath); } catch(e) {}
        try { fs.unlinkSync(storagePath); } catch(e) {}
        log.error('[Offline] 写入文件失败:', err.message);
        OfflineDownload.updateStatus(task.id, 'failed', '磁盘写入失败: ' + err.message);
        if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '磁盘写入失败: ' + err.message });
        callback(new Error('磁盘写入失败: ' + err.message));
      });

      httpRes.on('data', function(chunk) {
        // 每次收数据都检查任务状态（支持实时暂停/取消）
        var ct = OfflineDownload.findById(task.id, user.id);
        if (!ct || ct.status === 'paused' || ct.status === 'cancelled') {
          httpRes.destroy();
          writeStream.destroy();
          if (ct && ct.status === 'cancelled') {
            log.info('[Offline] 任务已取消: ' + task.id);
            OfflineDownload.updateStatus(task.id, 'cancelled');
            if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'cancelled', {});
          }
          return;
        }
        downloadedBytes += chunk.length;
        writeStream.write(chunk);

        // 每 2 秒更新进度
        var now = Date.now();
        if (now - lastUpdate >= 2000) {
          var elapsed = (now - lastUpdate) / 1000;
          var speedBps = elapsed > 0 ? Math.round((downloadedBytes - lastBytes) / elapsed) : 0;
          OfflineDownload.updateProgress(task.id, downloadedBytes, totalBytes, speedBps);
          if (wsPush) {
            var progress = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            wsPush.pushOfflineUpdate(user.id, task.id, 'progress', {
              status: 'downloading',
              progress: progress,
              downloaded_bytes: downloadedBytes,
              total_bytes: totalBytes,
              speed_bps: speedBps
            });
          }
          lastUpdate = now;
          lastBytes = downloadedBytes;
        }
      });

      httpRes.on('end', function() {
        writeStream.end();
        writeStream.on('finish', function() {
          var actualSize = 0;
          try { actualSize = fs.statSync(tempPath).size; } catch(e) {}

          log.info('[Offline] 下载完成: ' + filename + ', 临时文件=' + Math.round(actualSize / 1024) + 'KB');

          // 检查文件是否为空
          if (actualSize === 0) {
            try { fs.unlinkSync(tempPath); } catch(e) {}
            var emptyErr = '下载的文件为空（服务器未返回数据）';
            log.error('[Offline] ' + emptyErr);
            OfflineDownload.updateStatus(task.id, 'failed', emptyErr);
            if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: emptyErr });
            return callback(new Error(emptyErr));
          }

          // ========== 存储架构 V3: 离线下载接入存储组 ==========
          try {
            var tempData = fs.readFileSync(tempPath);
            var plaintextSize = tempData.length;
            // 计算明文哈希（用于秒传去重）
            var fileHash = crypto.createHash('sha256').update(tempData).digest('hex');
            var FileStorage = require('../lib/db').FileStorage;
            var UserFileRef = require('../lib/db').UserFileRef;
            var fileId, storageId, isDedup = false;

            // 检查去重
            var existing = FileStorage.findByHashAndSize(fileHash, plaintextSize);
            if (existing && FileStorage.hasValidPath(existing.id)) {
              storageId = existing.id;
              FileStorage.incrementRef(storageId);
              isDedup = true;
              log.info('[Offline] 秒传: hash=' + fileHash.substring(0, 12) + ' -> storage_id=' + storageId);
            }

            if (!isDedup) {
              // V1 加密到临时文件
              var encResult = createV1EncryptStreamSync(storagePath, tempData);
              if (!encResult.ok) {
                log.error('[Offline] V1 加密失败:', encResult.error);
                try { fs.unlinkSync(tempPath); } catch(e) {}
                OfflineDownload.updateStatus(task.id, 'failed', '加密失败: ' + encResult.error);
                if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '加密失败: ' + encResult.error });
                return callback(new Error('V1加密失败: ' + encResult.error));
              }

              // 写入锁检查
              var lockErr2 = require('../lib/db').StoragePool.checkWriteLock();
              if (lockErr2) {
                try { fs.unlinkSync(tempPath); } catch(e) {}
                try { fs.unlinkSync(storagePath); } catch(e) {}
                OfflineDownload.updateStatus(task.id, 'failed', lockErr2);
                return callback(new Error(lockErr2));
              }

              // 通过存储流写入均衡组
              var StorageMod = require('../lib/db').Storage;
              var relPath = StorageMod.getDateBasedPath(uuid);
              var StorageStream = require('../lib/storage-stream');
              var writeResult = StorageStream.createWriteStream(relPath);
              var groupId = writeResult.groupId;
              log.info('[Offline] createWriteStream: groupId=' + groupId + ' poolIds=' + JSON.stringify(writeResult.poolIds));

              if (groupId === null || groupId === undefined) {
                try { fs.unlinkSync(tempPath); } catch(e) {}
                try { fs.unlinkSync(storagePath); } catch(e) {}
                var errMsg2 = '没有可写入的存储组';
                OfflineDownload.updateStatus(task.id, 'failed', errMsg2);
                return callback(new Error(errMsg2));
              }

              var encBuf = fs.readFileSync(storagePath);
              var ws = writeResult.stream;
              ws.end(encBuf);
              // 删除旧格式临时文件
              try { fs.unlinkSync(storagePath); } catch(e) {}

              storageId = FileStorage.create(uuid, fileHash, plaintextSize, plaintextSize, ENC_V1_VERSION, true, encResult.nonce);
              require('../lib/db').run('UPDATE file_storage SET group_id = ? WHERE id = ?', [groupId, storageId]);
              (writeResult.poolIds || []).forEach(function(pid) {
                FileStorage.addPath(storageId, pid, relPath, relPath);
              });
              log.info('[Offline] storageId=' + storageId + ' relPath=' + relPath + ' mirrors=' + (writeResult.poolIds || []).length);
            }

            // 删除临时文件（明文 + 旧加密）
            try { fs.unlinkSync(tempPath); } catch(e) {}
            if (isDedup) { try { fs.unlinkSync(storagePath); } catch(e) {} }

            // 校验目标目录仍存在（离线下载是异步的，目录可能在任务创建后被删除）
            var dirId = task.target_dir_id || 0;
            if (dirId !== 0) {
              var targetDir = require('../lib/db').VirtualDir.findById(dirId);
              if (!targetDir || targetDir.user_id !== user.id) {
                // 目录已删除，回退到根目录
                log.warn('[Offline] 目标目录 ' + dirId + ' 已不存在，回退到根目录');
                dirId = 0;
              }
            }

            // 创建用户引用
            UserFileRef.create(user.id, storageId, dirId, filename, mimeType);

            // 创建 virtual_files 记录（关联 storage_id）
            fileId = VirtualFile.createWithEncVersion(user.id, dirId, filename, plaintextSize, mimeType,
              isDedup ? 'dedup_' + fileHash.substring(0, 12) : relPath,
              isDedup ? '' : uuid, ENC_V1_VERSION);
            log.info('[Offline] VirtualFile.create 返回 fileId=' + fileId);

            if (fileId) {
              require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, fileId]);
            }

            if (!fileId) {
              OfflineDownload.updateStatus(task.id, 'failed', '创建文件记录失败');
              if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '创建文件记录失败' });
              return callback(new Error('创建文件记录失败'));
            }

            User.updateUsedBytes(user.id, plaintextSize);
            OfflineDownload.updateProgress(task.id, downloadedBytes, totalBytes, 0);
            OfflineDownload.updateStatus(task.id, 'completed');

            log.info('[Offline] 完成: ' + filename + ' (' + Math.round(plaintextSize / 1024) + 'KB)' + (isDedup ? ' [秒传]' : ''));
            if (wsPush) {
              wsPush.pushOfflineUpdate(user.id, task.id, 'completed', {
                fileId: fileId,
                fileName: filename,
                fileSize: plaintextSize
              });
            }
            callback(null, fileId);
          } catch(e) {
            log.error('[Offline] 存储写入异常:', e.message);
            try { fs.unlinkSync(tempPath); } catch(e2) {}
            try { fs.unlinkSync(storagePath); } catch(e2) {}
            OfflineDownload.updateStatus(task.id, 'failed', '存储写入异常: ' + e.message);
            if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '存储写入异常: ' + e.message });
            return callback(e);
          }
        });
      });

      httpRes.on('error', function(err) {
        writeStream.destroy();
        try { fs.unlinkSync(tempPath); } catch(e) {}
        try { fs.unlinkSync(storagePath); } catch(e) {}
        log.error('[Offline] 下载响应错误:', err.message);
        OfflineDownload.updateStatus(task.id, 'failed', '网络错误: ' + err.message);
        if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '网络错误: ' + err.message });
        callback(err);
      });
    });

    req.on('timeout', function() {
      req.destroy();
      log.error('[Offline] 请求超时: ' + targetUrl);
      OfflineDownload.updateStatus(task.id, 'failed', '请求超时（60秒）');
      if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '请求超时（60秒）' });
      callback(new Error('请求超时'));
    });

    req.on('error', function(err) {
      log.error('[Offline] 请求错误:', err.message);
      OfflineDownload.updateStatus(task.id, 'failed', '请求失败: ' + err.message);
      if (wsPush) wsPush.pushOfflineUpdate(user.id, task.id, 'failed', { error: '请求失败: ' + err.message });
      callback(err);
    });

    req.end();
  }  // _doRequest
}

// ==================== 缩略图预览+视频帧+文本预览+DOCX预览====================
// GET /api/files/thumb/:id?w=200&h=200
// 支持格式：jpg, jpeg, png, gif, webp, bmp
var THUMB_SUPPORTED = ['jpg','jpeg','png','gif','webp','bmp'];

// 获取解密后的文件路径（处理引用文件）
function getDecryptedFilePath(fileRecord) {
  if (fileRecord.is_reference && fileRecord.reference_source_id) {
    fileRecord = VirtualFile.findById(fileRecord.reference_source_id);
    if (!fileRecord) return null;
  }
  var filePath = fileRecord.storage_path;
  // storage_path为空但storage_id有效→从file_storage_paths查找
  if (!filePath && fileRecord.storage_id && fileRecord.storage_id > 0) {
    var p2 = require('../lib/db').query(
      'SELECT fsp.relative_path, fsp.full_path, sp.local_path FROM file_storage_paths fsp ' +
      'JOIN storage_pools sp ON fsp.pool_id = sp.id WHERE fsp.storage_id = ? LIMIT 1',
      [fileRecord.storage_id]
    );
    if (p2.length > 0) filePath = require('path').join(p2[0].local_path, p2[0].relative_path || p2[0].full_path);
    log.info('[getDecryptedFilePath] resolved via storage_id=' + fileRecord.storage_id + ' → ' + filePath);
  }
  if (!filePath) return null;
  // 绝对路径 → 直接返回
  if (require('path').isAbsolute(filePath)) {
    return fs.existsSync(filePath) ? filePath : null;
  }
  // 相对路径 → 通过存储架构解析（包括已删除路径，文件可能还在磁盘上）
  if (fileRecord.storage_id && fileRecord.storage_id > 0) {
    var paths = require('../lib/db').query(
      'SELECT fsp.relative_path, fsp.full_path, sp.local_path FROM file_storage_paths fsp ' +
      'JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
      'WHERE fsp.storage_id = ?',
      [fileRecord.storage_id]
    );
    for (var i = 0; i < paths.length; i++) {
      var fp = require('path').join(paths[i].local_path, paths[i].relative_path || filePath);
      if (fs.existsSync(fp)) return fp;
    }
  }
  // 兜底：扫所有池（包括 stopped/degraded）
  var allPools = require('../lib/db').StoragePool.listAll().filter(function(p) { return p.status !== 'deleted'; });
  for (var j = 0; j < allPools.length; j++) {
    var fp2 = require('path').join(allPools[j].local_path, filePath);
    if (fs.existsSync(fp2)) return fp2;
  }
  return null;
}

router.get('/files/thumb/:id?', requireAuth, async function(req, res) {
  var rawId = req.query.id || req.params.id;
  if (!rawId) return deny404(res, '缺少文件标识');
  var user = req.user;
  log.info('[Thumb] id=' + rawId + ', user=' + user.email);
  var isDecrypted = false;
  var filePath = null;

  // ---------- 分类：纯数字 ID 可能是个人文件 或 回收站文件 ----------
  if (/^\d+$/.test(rawId)) {
    var fileId = parseInt(rawId, 10);
    // 1) 普通个人文件
    var fileRecord = VirtualFile.findById(fileId);
    if (fileRecord && fileRecord.user_id === user.id) {
      if (!checkPerm(user, fileRecord.dir_id, 'read')) return deny403(res, '无权限');
      var ext = (fileRecord.name || '').toLowerCase().split('.').pop();
      if (THUMB_SUPPORTED.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的图片格式' });
      filePath = getDecryptedFilePath(fileRecord);
      isDecrypted = true;

    } else {
      // 2) 个人回收站文件
      var delFile = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [fileId, user.id]);
      if (delFile) {
        var ext = (delFile.name || '').toLowerCase().split('.').pop();
        if (THUMB_SUPPORTED.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的图片格式' });
        filePath = delFile.storage_path; // 完整绝对路径
        isDecrypted = true;

      } else {
        // 3) 公共回收站文件（数据在 Redis）
        var DelFile = require('../lib/redis').DelFile;
        var pubDelFile = null;
        try {
          pubDelFile = await DelFile.get(String(fileId));
        } catch (e) {}
        if (pubDelFile) {
          var ext = (pubDelFile.originalName || '').toLowerCase().split('.').pop();
          if (THUMB_SUPPORTED.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的图片格式' });
          filePath = pubDelFile.storagePath; // Redis 存的绝对路径，公共文件不加密
          isDecrypted = false;
        }
        // 都不存在 → filePath = null，后续 404
      }
    }

  // ---------- 非纯数字 ID：nonce 或公共文件路径 ----------
  } else {
    var possibleNonce = (rawId || '').replace(/\.[^.]+$/, '');
    if (possibleNonce) {
      var rec = get('SELECT * FROM virtual_files WHERE user_id = ? AND nonce = ?', [user.id, possibleNonce]);
      if (!rec) rec = get('SELECT * FROM virtual_files WHERE user_id = ? AND LOWER(nonce) = LOWER(?)', [user.id, possibleNonce]);
      if (rec) {
        // 普通个人文件（nonce 方式）
        if (!checkPerm(user, rec.dir_id, 'read')) return deny403(res, '无权限');
        var ext = (rec.name || '').toLowerCase().split('.').pop();
        if (THUMB_SUPPORTED.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的图片格式' });
        filePath = getDecryptedFilePath(rec);
        isDecrypted = true;
      }
    }
    // 没找到 nonce → 当作公共文件路径
    if (!filePath) {
      var ext = (rawId || '').toLowerCase().split('.').pop();
      if (THUMB_SUPPORTED.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的图片格式' });
      filePath = path.join(Storage.PUBLIC_DIR, rawId);
      isDecrypted = false;
    }
  }

  if (!filePath || !fs.existsSync(filePath)) return deny404(res, '文件不存在');

  var thumbFileId = 0;
  var thumbFileName = rawId;
  var thumbFileSize = 0;
  var thumbIsPublic = false;

  if (/^\d+$/.test(rawId)) {
    var fId = parseInt(rawId, 10);
    if (fileRecord && fileRecord.user_id === user.id) {
      thumbFileId = fId; thumbFileName = fileRecord.name; thumbFileSize = fileRecord.size || 0;
    } else {
      var df = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [fId, user.id]);
      if (df) { thumbFileId = fId; thumbFileName = df.name; thumbFileSize = df.size || 0; }
      else { thumbIsPublic = true; }
    }
  } else {
    var possibleNonce = (rawId || '').replace(/\.[^.]+$/, '');
    if (possibleNonce) {
      var rec2 = get('SELECT * FROM virtual_files WHERE user_id = ? AND (nonce = ? OR LOWER(nonce) = LOWER(?))', [user.id, possibleNonce, possibleNonce]);
      if (rec2) { thumbFileId = rec2.id; thumbFileName = rec2.name; thumbFileSize = rec2.size || 0; }
      else { thumbIsPublic = true; }
    } else {
      thumbIsPublic = true;
    }
  }

  // 设置流量元数据，由全局中间件在响应完成时按实际传输字节记录
  res._trafficMeta = { category: 'file_transfer', action_type: 'preview', file_id: thumbFileId, file_name: thumbFileName, file_size: thumbFileSize, user_id: thumbIsPublic ? 0 : user.id, guest_ip: thumbIsPublic ? getClientIp(req) : '' };

  var w = Math.min(Math.max(parseInt(req.query.w, 10) || 200, 20), 1920);
  var h = Math.min(Math.max(parseInt(req.query.h, 10) || 200, 20), 1920);

  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');

  if (isDecrypted) {
    // 加密文件：自动检测加密格式并解密
    try {
      var encVersion = detectFileEncVersion(filePath);
      if (encVersion === 1) {
        // V1 格式：先解密全部内容，再传给 sharp
        createV1DecryptStreamHead(filePath, 10 * 1024 * 1024, function(err, decryptedData) {
          if (err || !decryptedData || decryptedData.length === 0) {
            res.status(500).json({ code: 500, message: '文件解密失败' });
            return;
          }
          var sharpStream = require('stream').Readable.from(decryptedData)
            .pipe(sharp().resize(w, h, { fit: 'inside', withoutEnlargement: true }))
            .jpeg({ quality: 80 });
          sharpStream.on('error', function() { res.status(500).json({ code: 500, message: '生成失败' }); });
          sharpStream.pipe(res);
        });
      } else {
        // 旧格式：直接流式解密
        var result = createDecryptStream(filePath);
        var sharpStream = result.readStream
          .pipe(sharp().resize(w, h, { fit: 'inside', withoutEnlargement: true }))
          .jpeg({ quality: 80 });
        sharpStream.on('error', function() { res.status(500).json({ code: 500, message: '生成失败' }); });
        sharpStream.pipe(res);
      }
    } catch (err) {
      log.error('[Thumb] 流式解密失败, id=' + rawId + ', path=' + filePath + ', err:', err.stack || err.message);
      res.status(500).json({ code: 500, message: '文件解密失败' });
    }
  } else {
    // 未加密文件：直接流式传给 sharp 生成缩略图
    var readStream = fs.createReadStream(filePath);
    var sharpStream = readStream
      .pipe(sharp().resize(w, h, { fit: 'inside', withoutEnlargement: true }))
      .jpeg({ quality: 80 });
    sharpStream.on('error', function() { res.status(500).json({ code: 500, message: '生成失败' }); });
    sharpStream.pipe(res);
  }
});

// ==================== 文件流预览（图片/视频/音频全量解密流，支持 Range 请求）====================
// GET  /api/files/stream/:id   - 获取文件流，支持 Range 请求
// HEAD /api/files/stream/:id   - 获取文件大小（元数据），让浏览器知道视频总长度
// 支持图片直接显示、视频/音频流式播放
// ID 格式同 thumb：纯数字 | UUID格式nonce（含扩展名）
var STREAM_SUPPORTED = ['jpg','jpeg','png','gif','webp','bmp','mp4','avi','mov','webm','mkv','mp3','wav','ogg','flac','aac','pdf'];
var ENCRYPTED_HEADER_SIZE = 88; // keyNonce(12) + encFileKey(32) + keyAuthTag(16) + nonce(12) + authTag(16)

// 解析 Range header，返回 {start, end} 或 null
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  var match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;
  var start = 0;
  var end = totalSize - 1;
  if (match[1]) start = Math.max(0, parseInt(match[1], 10));
  if (match[2]) end = Math.min(totalSize - 1, parseInt(match[2], 10));
  if (end < start) end = start;
  return { start: start, end: end };
}

// 获取文件元数据（解密后大小 + 是否加密 + 加密格式版本）
// encVersion: 文件记录的 enc_version（来自 DB，可选），用于辅助判断
function getStreamMeta(filePath, fileRecord, encVersion) {
  var fileSize = fs.statSync(filePath).size;
  var mimeType = fileRecord ? (fileRecord.mime_type || 'application/octet-stream') : 'application/octet-stream';

  // encVersion = -1 表示明确知道是未加密的，跳过所有检测
  if (encVersion === -1) {
    return {
      mimeType: mimeType,
      fileSize: fileSize,
      decryptedSize: fileSize,
      isEncrypted: false,
      encVersion: -1
    };
  }

  // encVersion = 1 表示明确是 V1 加密格式
  if (encVersion === 1) {
    // V1 分块格式
    var v1Info = getV1FileInfo(filePath);
    if (v1Info.isV1) {
      return {
        mimeType: mimeType,
        fileSize: fileSize,
        decryptedSize: v1Info.originalSize,
        isEncrypted: true,
        encVersion: 1,
        blockSize: v1Info.blockSize
      };
    }
    // DB 说 V1 但文件不是 V1，降级为旧格式
  }

  // 魔法字节检测
  var magicBuf = Buffer.alloc(4);
  var fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, magicBuf, 0, 4, 0);
  fs.closeSync(fd);

  // 检查是否是 V1 格式（魔法字节）
  var magicStr = magicBuf.toString('ascii', 0, 4);
  if (magicStr === 'EV1\0') {
    var v1Info = getV1FileInfo(filePath);
    if (v1Info.isV1) {
      return {
        mimeType: mimeType,
        fileSize: fileSize,
        decryptedSize: v1Info.originalSize,
        isEncrypted: true,
        encVersion: 1,
        blockSize: v1Info.blockSize
      };
    }
  }

  // 检查是否未加密（常见格式）
  // 视频格式检测（支持更多格式）
  var isVideoMagic = false;
  var magicHex = magicBuf.toString('hex');
  var magicAscii = magicBuf.toString('ascii', 0, 4);
  if (magicAscii === 'ftyp' || magicAscii === 'moov' || magicAscii === 'mdat') {
    isVideoMagic = true; // MP4/MOV/M4V
  } else if (magicAscii === 'RIFF' && magicBuf[8] === 0x57) {
    isVideoMagic = true; // AVI (RIFF....WAVE)
  } else if (magicAscii === '\x1A\x45\xDF\xA3') {
    isVideoMagic = true; // MKV/WebM (EBML header)
  } else if (magicAscii === 'MThd') {
    isVideoMagic = true; // MIDI
  } else if (magicAscii === 'ID3') {
    isVideoMagic = true; // MP3 with ID3
  } else if (magicAscii === 'OggS') {
    isVideoMagic = true; // OGG
  }
  var isImageMagic = (magicBuf[0] === 0xFF && magicBuf[1] === 0xD8) ||
                     (magicBuf[0] === 0x89 && magicBuf[1] === 0x50 && magicBuf[2] === 0x4E && magicBuf[3] === 0x47);
  if (isVideoMagic || isImageMagic) {
    return {
      mimeType: mimeType,
      fileSize: fileSize,
      decryptedSize: fileSize,
      isEncrypted: false,
      encVersion: -1 // 未加密
    };
  }

  // 旧加密格式（>= 88 字节）
  if (fileSize >= ENCRYPTED_HEADER_SIZE) {
    return {
      mimeType: mimeType,
      fileSize: fileSize,
      decryptedSize: fileSize - ENCRYPTED_HEADER_SIZE,
      isEncrypted: true,
      encVersion: 0 // 旧格式
    };
  }

  // 小文件或未知格式
  return {
    mimeType: mimeType,
    fileSize: fileSize,
    decryptedSize: fileSize,
    isEncrypted: false,
    encVersion: -1
  };
}

// 文件流核心处理
// mode: 'stream' (GET) | 'head' (HEAD)
async function handleStreamRequest(req, res, mode) {
  try {
  var rawId = req.params.id;
  var user = req.user;

  var fileRecord = null;
  var filePath = null;
  var isPublicFile = false;
  var isRecycleFile = false;
  var isPublicRecycleFile = false;

  // 公共文件：通过 public_path 查询参数指定相对路径（支持子目录）
  if (req.query.public_path) {
    isPublicFile = true;
    filePath = path.join(Storage.PUBLIC_DIR, req.query.public_path);
    // 安全检查：禁止 .. 跳出 PUBLIC_DIR
    if (!filePath.startsWith(Storage.PUBLIC_DIR)) {
      return deny404(res, '文件不存在');
    }
  } else if (/^\d+$/.test(rawId)) {
    var fileId = parseInt(rawId, 10);
    fileRecord = VirtualFile.findById(fileId);
    if (!fileRecord || fileRecord.user_id !== user.id) {
      var deletedFile = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [fileId, user.id]);
      if (deletedFile) {
        isRecycleFile = true;
        filePath = deletedFile.storage_path;
      } else {
        var DelFile = require('../lib/redis').DelFile;
        var pubDelFile = null;
        try { pubDelFile = await DelFile.get(String(fileId)); } catch (e) {}
        if (pubDelFile) {
          isPublicRecycleFile = true;
          filePath = pubDelFile.storagePath;
        }
      }
    }
  } else {
    var possibleNonce = (rawId || '').replace(/\.[^.]+$/, '');
    if (possibleNonce) {
      fileRecord = get('SELECT * FROM virtual_files WHERE user_id = ? AND nonce = ?', [user.id, possibleNonce]);
      if (!fileRecord) {
        fileRecord = get('SELECT * FROM virtual_files WHERE user_id = ? AND LOWER(nonce) = LOWER(?)', [user.id, possibleNonce]);
      }
    }
    if (!fileRecord) {
      isPublicFile = true;
      filePath = path.join(Storage.PUBLIC_DIR, rawId);
    }
  }

  if (fileRecord) {
    if (!checkPerm(user, fileRecord.dir_id, 'read')) return deny403(res, '无权限');
    var ext = (fileRecord.name || '').toLowerCase().split('.');
    ext = ext[ext.length - 1] ? ext[ext.length - 1].toLowerCase() : '';
    if (STREAM_SUPPORTED.indexOf(ext) === -1) {
      return res.status(415).json({ code: 415, message: '不支持预览此格式' });
    }
    filePath = getDecryptedFilePath(fileRecord);
  }

  if (!filePath || !fs.existsSync(filePath)) return deny404(res, '文件不存在');

  // 回收站个人文件：不允许预览
  if (isRecycleFile) {
    return res.status(403).json({ code: 403, message: '请先恢复文件后查看' });
  }

  // 公共文件：公共目录的文件默认都是未加密的，不需要魔法字节检测
  var isPublicUnencrypted = false;
  if (isPublicFile || isPublicRecycleFile) {
    isPublicUnencrypted = true;
  }

  // 获取 enc_version（来自 DB 记录）
  var encVersion = 0;
  if (fileRecord && fileRecord.enc_version !== undefined) {
    encVersion = fileRecord.enc_version || 0;
  }
  // 公共未加密文件：标记为未加密
  if (isPublicUnencrypted) {
    encVersion = -1;
  }

  var meta = getStreamMeta(filePath, fileRecord, encVersion);

  // 检查流量配额（预览视频也会消耗流量）
  var quotaUid = isPublicFile || isPublicRecycleFile ? 0 : user.id;
  var quotaIp = isPublicFile || isPublicRecycleFile ? getClientIp(req) : '';
  var quotaInfo = TrafficQuota.get(quotaUid, quotaIp, isPublicFile || isPublicRecycleFile);
  if (quotaInfo.used_bytes + meta.decryptedSize > quotaInfo.quota_bytes) {
    return res.status(403).json({
      code: 403,
      message: '月度流量配额不足（已用 ' + formatFileSize(quotaInfo.used_bytes) + ' / 配额 ' + formatFileSize(quotaInfo.quota_bytes) + '）',
      data: {
        quota: quotaInfo.quota_bytes,
        used: quotaInfo.used_bytes,
        overage: quotaInfo.used_bytes + meta.decryptedSize - quotaInfo.quota_bytes
      }
    });
  }

  // 提取文件元信息用于流量记录
  var streamFileId = fileRecord ? fileRecord.id : 0;
  var streamFileName = fileRecord ? fileRecord.name : rawId;
  var streamFileSize = fileRecord ? (fileRecord.size || 0) : meta.decryptedSize;

  // 统一设置流量元数据（由全局中间件在响应完成时按实际传输字节记录）
  function recordStreamTraffic() {
    res._trafficMeta = { category: 'file_transfer', action_type: 'preview', file_id: streamFileId, file_name: streamFileName, file_size: streamFileSize, user_id: isPublicFile || isPublicRecycleFile ? 0 : user.id, guest_ip: isPublicFile || isPublicRecycleFile ? getClientIp(req) : '' };
  }

  // HEAD 请求：只返回元数据，让浏览器知道文件总大小
  if (mode === 'head') {
    res.set('Content-Type', meta.mimeType);
    res.set('Content-Length', meta.decryptedSize);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'no-cache');
    return res.end();
  }

  // GET 请求
  res.set('Content-Type', meta.mimeType);
  res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'no-cache');

  var range = parseRange(req.headers['range'], meta.decryptedSize);

  if (range) {
    // Range 请求
    var rangeLength = range.end - range.start + 1;

    recordStreamTraffic();

    if (meta.isEncrypted) {
      // 加密文件：Range 解密
      if (meta.encVersion === 1) {
        // V1 分块格式
        try {
          var v1Stream = createV1DecryptStream(filePath, range.start, range.end);
          res.writeHead(206, {
            'Content-Type': meta.mimeType,
            'Content-Length': rangeLength,
            'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + meta.decryptedSize,
            'Accept-Ranges': 'bytes'
          });
          v1Stream.on('error', function(err) {
            log.error('[Stream] V1 Range 解密错误:', err.message);
            if (!res.headersSent) { res.statusCode = 500; res.end(); }
          });
          v1Stream.pipe(res);
        } catch (err) {
          log.error('[Stream] V1 Range 解密初始化失败:', err.message);
          res.statusCode = 500;
          res.end();
        }
      } else {
        // 旧格式
        try {
          var streamInfo = createDecryptStreamRange(filePath, range.start, range.end);
          res.writeHead(206, {
            'Content-Type': meta.mimeType,
            'Content-Length': rangeLength,
            'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + meta.decryptedSize,
            'Accept-Ranges': 'bytes'
          });
          streamInfo.readStream.on('error', function(err) {
            log.error('[Stream] Range 解密流错误:', err.message);
            if (!res.headersSent) { res.statusCode = 500; res.end(); }
          });
          streamInfo.readStream.pipe(res);
        } catch (err) {
          log.error('[Stream] Range 解密初始化失败:', err.message);
          res.statusCode = 500;
          res.end();
        }
      }
    } else {
      // 未加密文件：直接读取指定范围
      res.writeHead(206, {
        'Content-Type': meta.mimeType,
        'Content-Length': rangeLength,
        'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + meta.decryptedSize,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    }
  } else {
    // 无 Range 请求：完整文件
    res.set('Content-Length', meta.decryptedSize);

    recordStreamTraffic();

    if (meta.isEncrypted) {
      if (meta.encVersion === 1) {
        // V1 完整文件流
        try {
          var v1Stream = createV1DecryptStream(filePath, 0, meta.decryptedSize - 1);
          v1Stream.on('error', function(err) {
            log.error('[Stream] V1 解密流错误:', err.message);
            if (!res.headersSent) { res.statusCode = 500; res.end(); }
          });
          v1Stream.pipe(res);
        } catch (err) {
          log.error('[Stream] V1 解密初始化失败:', err.message);
          res.statusCode = 500;
          res.end();
        }
      } else {
        // 旧格式完整文件流
        try {
          var streamInfo = createDecryptStream(filePath);
          streamInfo.readStream.on('error', function(err) {
            log.error('[Stream] 解密流错误:', err.message);
            if (!res.headersSent) { res.statusCode = 500; res.end(); }
          });
          streamInfo.readStream.pipe(res);
        } catch (err) {
          log.error('[Stream] 流式解密初始化失败:', err.message);
          res.statusCode = 500;
          res.end();
        }
      }
    } else {
      res.sendFile(filePath);
    }
  }
  } catch (e) {
    log.error('[handleStreamRequest] 错误:', e.message, e.stack);
    res.status(500).json({ code: 500, message: '预览失败: ' + e.message });
  }
}

// GET 和 HEAD 路由
router.get('/files/stream/:id', requireAuth, async function(req, res) {
  handleStreamRequest(req, res, 'stream');
});

router.head('/files/stream/:id', requireAuth, async function(req, res) {
  handleStreamRequest(req, res, 'head');
});

// ==================== 预览Token（用于Office Online Viewer）====================
// GET /api/files/preview-token/:id
router.get('/files/preview-token/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;
  var file = VirtualFile.findById(fileId);

  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'read')) return deny403(res, '无权限');

  var token = generatePreviewToken(file.id, user.id);
  res.json({ code: 0, data: { token: token } });
});

// ==================== 视频预览（range请求 + 前端video标签解析首帧）====================
// GET /api/files/video-preview/:id
// 支持格式：mp4, avi, mov, webm, mkv
// 实现：解密视频文件的前 N 字节返回，前端通过 <video preload="metadata"> 加载并解析首帧
// 注意：不再依赖 ffmpeg，纯 Node.js 流式解密，支持 range 请求节省带宽
var VIDEO_PREVIEW_FORMATS = ['mp4','avi','mov','webm','mkv'];
var VIDEO_PREVIEW_SIZE = 512 * 1024; // 解密并返回前 512KB（足够解析视频元数据 + 首帧）

router.get('/files/video-preview/:id?', requireAuth, async function(req, res) {
  try {
  var rawId = req.query.id || req.params.id;
  if (!rawId) return deny404(res, '缺少文件标识');
  var user = req.user;
  var videoPreviewFileId = 0;
  var videoPreviewFileName = '';
  var videoPreviewTotalSize = 0;

  // 设置流量元数据（懒求值，中间件在 finish 时读取变量的最新值）
  function setupVideoTrafficCounter() {
    res._trafficMeta = {
      category: 'file_transfer',
      action_type: 'video_stream',
      get file_id() { return videoPreviewFileId; },
      get file_name() { return videoPreviewFileName; },
      get file_size() { return videoPreviewTotalSize; },
      user_id: user.id,
      guest_ip: ''
    };
  }

  var fileRecord = null;
  var filePath = null;
  var isPublicFile = false;
  var isRecycleFile = false;
  var isPublicRecycleFile = false;
  setupVideoTrafficCounter();

  if (/^\d+$/.test(rawId)) {
    var fileId = parseInt(rawId, 10);
    // 先查普通文件
    fileRecord = VirtualFile.findById(fileId);
    if (fileRecord && fileRecord.user_id === user.id) {
      // 记录视频预览流量（按实际请求字节数统计）
      videoPreviewFileId = fileRecord.id;
      videoPreviewFileName = fileRecord.name;
      videoPreviewTotalSize = fileRecord.size || 0;
    }
    if (!fileRecord || fileRecord.user_id !== user.id) {
      // 普通文件不存在，查回收站
      var deletedFile = get('SELECT * FROM deleted_files WHERE id = ? AND user_id = ?', [fileId, user.id]);
      if (deletedFile) {
        isRecycleFile = true;
        var ext = (deletedFile.name || '').toLowerCase().split('.').pop();
        if (VIDEO_PREVIEW_FORMATS.indexOf(ext) === -1) {
          return res.status(415).json({ code: 415, message: '不支持的视频格式' });
        }
        filePath = deletedFile.storage_path;
      } else {
        // 查公共回收站（数据在 Redis）
        var DelFile = require('../lib/redis').DelFile;
        var pubDelFile = null;
        try {
          pubDelFile = await DelFile.get(String(fileId));
        } catch (e) {}
        if (pubDelFile) {
          isPublicRecycleFile = true;
          var ext = (pubDelFile.originalName || '').toLowerCase().split('.').pop();
          if (VIDEO_PREVIEW_FORMATS.indexOf(ext) === -1) return res.status(415).json({ code: 415, message: '不支持的视频格式' });
          filePath = pubDelFile.storagePath; // Redis 存的绝对路径
        }
        // else: 文件彻底不存在，后续 404
      }
    }
  } else {
    // 非纯数字ID：nonce 或公共文件路径
    var possibleNonce = (rawId || '').replace(/\.[^.]+$/, '');
    if (possibleNonce) {
      fileRecord = get('SELECT * FROM virtual_files WHERE user_id = ? AND nonce = ?', [user.id, possibleNonce]);
      if (!fileRecord) {
        fileRecord = get('SELECT * FROM virtual_files WHERE user_id = ? AND LOWER(nonce) = LOWER(?)', [user.id, possibleNonce]);
      }
    }
    if (!fileRecord) {
      isPublicFile = true;
      filePath = path.join(Storage.PUBLIC_DIR, rawId);
    }
  }

  // 处理普通个人文件
  if (fileRecord) {
    if (!checkPerm(user, fileRecord.dir_id, 'read')) return deny403(res, '无权限');
    var ext = (fileRecord.name || '').toLowerCase().split('.').pop();
    if (VIDEO_PREVIEW_FORMATS.indexOf(ext) === -1) {
      return res.status(415).json({ code: 415, message: '不支持的视频格式' });
    }
    filePath = getDecryptedFilePath(fileRecord);
  }

  if (!filePath || !fs.existsSync(filePath)) return deny404(res, '文件不存在');

  // 解析 range 请求头（支持部分内容请求）
  var rangeHeader = req.headers['range'];
  var fileSize = fs.statSync(filePath).size;

  // 公共未加密文件检测（视频/图片格式）
  var isPublicUnencrypted = false;
  if (isPublicFile || isPublicRecycleFile) {
    var pubMagicBuf = Buffer.alloc(4);
    var pubFd = fs.openSync(filePath, 'r');
    fs.readSync(pubFd, pubMagicBuf, 0, 4, 0);
    fs.closeSync(pubFd);
    var pubMagic = pubMagicBuf.toString('ascii', 0, 4);
    var isPubVideoMagic = (pubMagic === 'ftyp' || pubMagic === 'moov' || pubMagic === 'mdat');
    var isPubImageMagic = (pubMagicBuf[0] === 0xFF && pubMagicBuf[1] === 0xD8) ||
                          (pubMagicBuf[0] === 0x89 && pubMagicBuf[1] === 0x50 && pubMagicBuf[2] === 0x4E && pubMagicBuf[3] === 0x47);
    if (isPubVideoMagic || isPubImageMagic) {
      isPublicUnencrypted = true;
    }
  }

  // 计算实际解密后的原始文件大小
  var encVersion = detectFileEncVersion(filePath);
  // 公共未加密文件：标记为未加密
  if (isPublicUnencrypted) {
    encVersion = -1;
  }
  var decryptedFileSize;
  if (encVersion === 1) {
    var v1Info = getV1FileInfo(filePath);
    decryptedFileSize = v1Info.originalSize || 0;
  } else if (encVersion === -1) {
    decryptedFileSize = fileSize; // 未加密：解密后大小等于文件大小
  } else {
    decryptedFileSize = fileSize - 88;
    if (decryptedFileSize < 0) decryptedFileSize = 0;
  }

  // 检查流量配额（预览也会消耗流量，预览最多512KB）
  var previewBytes = Math.min(VIDEO_PREVIEW_SIZE, decryptedFileSize);
  var quotaInfo = TrafficQuota.get(user.id, '', false);
  if (quotaInfo.used_bytes + previewBytes > quotaInfo.quota_bytes) {
    return res.status(403).json({
      code: 403,
      message: '月度流量配额不足（已用 ' + formatFileSize(quotaInfo.used_bytes) + ' / 配额 ' + formatFileSize(quotaInfo.quota_bytes) + '）',
      data: {
        quota: quotaInfo.quota_bytes,
        used: quotaInfo.used_bytes,
        overage: quotaInfo.used_bytes + previewBytes - quotaInfo.quota_bytes
      }
    });
  }

  if (isPublicFile || isPublicRecycleFile) {
    // 公共/回收站公共视频：直接读取，不解密
    var previewSize = Math.min(VIDEO_PREVIEW_SIZE, fileSize);
    // 设置公共文件流量记录
    videoPreviewFileId = 0;
    videoPreviewFileName = rawId;
    videoPreviewTotalSize = fileSize;

    if (rangeHeader) {
      // 解析 range: bytes=start-end
      var rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      var start = 0;
      var end = Math.min(previewSize - 1, fileSize - 1);
      if (rangeMatch) {
        if (rangeMatch[1]) start = Math.min(parseInt(rangeMatch[1], 10), fileSize - 1);
        if (rangeMatch[2]) end = Math.min(parseInt(rangeMatch[2], 10), fileSize - 1);
      }
      if (end < start) end = start;
      var contentLength = end - start + 1;
      var readStream = fs.createReadStream(filePath, { start: start, end: end });
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': contentLength,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      readStream.pipe(res);
    } else {
      // 无 range 请求：只返回前 previewSize 字节
      var readStream = fs.createReadStream(filePath, { start: 0, end: previewSize - 1 });
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': previewSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      readStream.pipe(res);
    }
    return;
  }

  // 个人视频：需要解密后再返回（使用 detectFileEncVersion 统一检测加密格式）
  var encVersion = detectFileEncVersion(filePath);
  var isEncrypted = (encVersion === 0 || encVersion === 1);

  var decryptStream;
  if (!isEncrypted) {
    // 未加密：直接读取前 VIDEO_PREVIEW_SIZE 字节（但文件不能为空）
    if (fileSize === 0) {
      return res.status(500).json({ code: 500, message: '文件为空或大小异常' });
    }
    var previewSize = Math.min(VIDEO_PREVIEW_SIZE, fileSize);
    if (rangeHeader) {
      var rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      var start = rangeMatch && rangeMatch[1] ? Math.min(parseInt(rangeMatch[1], 10), fileSize - 1) : 0;
      var end = rangeMatch && rangeMatch[2] ? Math.min(parseInt(rangeMatch[2], 10), fileSize - 1) : fileSize - 1;
      if (end < start) end = start;
      var contentLength = end - start + 1;
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': contentLength,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': previewSize,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(filePath, { start: 0, end: previewSize - 1 }).pipe(res);
    return;
  }

  try {
    // 自动检测并使用正确的解密流（支持 V1 和旧格式）
    decryptStream = createDecryptStreamAuto(filePath, 0, VIDEO_PREVIEW_SIZE - 1);
  } catch (err) {
    log.error('[VideoPreview] 解密流创建失败, fileId=' + rawId + ', path=' + filePath + ', err:', err.stack || err.message);
    return res.status(500).json({ code: 500, message: '文件解密失败' });
  }

  if (rangeHeader) {
    // 解析 range
    var rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    var start = 0;
    var end = Math.min(VIDEO_PREVIEW_SIZE - 1, decryptedFileSize - 1);
    if (decryptedFileSize <= 0) end = -1;
    if (rangeMatch) {
      if (rangeMatch[1]) start = Math.min(parseInt(rangeMatch[1], 10), Math.max(0, decryptedFileSize - 1));
      if (rangeMatch[2]) end = Math.min(parseInt(rangeMatch[2], 10), Math.min(VIDEO_PREVIEW_SIZE - 1, decryptedFileSize - 1));
    }
    if (end < start) end = start;
    if (end < 0) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + decryptedFileSize });
      return res.end();
    }

    // range 跳过前 start 字节
    if (start > 0) {
      var skipChunks = [];
      var skipped = 0;
      decryptStream = decryptStream.pipe(new stream.Transform({
        transform: function(chunk, enc, cb) {
          if (skipped < start) {
            var remain = start - skipped;
            if (chunk.length <= remain) {
              skipped += chunk.length;
              cb();
            } else {
              skipped = start;
              this.push(chunk.slice(remain));
              cb();
            }
          } else {
            this.push(chunk);
            cb();
          }
        }
      }));
    }

    // 限制最多返回 VIDEO_PREVIEW_SIZE 字节
    var limitTransform = new stream.Transform({
      transform: function(chunk, enc, cb) {
        if (this._sentBytes >= VIDEO_PREVIEW_SIZE) {
          cb();
          return;
        }
        var remain = VIDEO_PREVIEW_SIZE - (this._sentBytes || 0);
        if (chunk.length <= remain) {
          this._sentBytes = (this._sentBytes || 0) + chunk.length;
          this.push(chunk);
          cb();
        } else {
          this.push(chunk.slice(0, remain));
          this._sentBytes = VIDEO_PREVIEW_SIZE;
          cb();
        }
      }
    });

    var contentLength = end - start + 1;
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': contentLength,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + decryptedFileSize,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });
    decryptStream.pipe(limitTransform).pipe(res);
  } else {
    // 无 range：只返回前 VIDEO_PREVIEW_SIZE 字节
    var limitTransform = new stream.Transform({
      transform: function(chunk, enc, cb) {
        if (this._sentBytes >= VIDEO_PREVIEW_SIZE) {
          cb();
          return;
        }
        var remain = VIDEO_PREVIEW_SIZE - (this._sentBytes || 0);
        if (chunk.length <= remain) {
          this._sentBytes = (this._sentBytes || 0) + chunk.length;
          this.push(chunk);
          cb();
        } else {
          this.push(chunk.slice(0, remain));
          this._sentBytes = VIDEO_PREVIEW_SIZE;
          cb();
        }
      }
    });

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': Math.min(VIDEO_PREVIEW_SIZE, decryptedFileSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });
    decryptStream.pipe(limitTransform).pipe(res);
  }
  } catch(err) {
    log.error('[VideoPreview] 视频预览异常:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ code: 500, message: '服务器错误: ' + err.message });
  }
});

// ==================== 文本预览 =====================
// GET /api/files/text/:id?public_path=xxx
router.get('/files/text/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;

  var TEXT_SUPPORTED = ['txt','log','json','jsonc','json5','js','ts','jsx','tsx','css','html','htm','xml','svg','md','mdx','csv','sh','bash','zsh','bat','cmd','ps1','py','pyw','java','c','cpp','cc','cxx','h','hpp','hh','hxx','cs','php','rb','pl','pm','sql','yml','yaml','ini','conf','cfg','properties','env','htaccess','toml','go','rs','swift','kt','lua','r','scala','vue','svelte','less','scss','sass','asp','aspx','jsp','dockerfile','makefile','cmake','gitignore','editorconfig','nginx','tex','bib','rst','readme','changelog','license','graphql','gql','dart'];

  // 公共文件：通过 public_path 查询参数指定相对路径（支持子目录）
  if (req.query.public_path) {
    var pubPath = req.query.public_path;
    var pubRoot = Storage.PUBLIC_DIR;
    var pubFilePath = path.resolve(pubRoot, pubPath);
    // 安全检查：禁止 .. 跳出 PUBLIC_DIR
    if (!pubFilePath.startsWith(pubRoot)) return deny404(res, '文件不存在');
    if (!fs.existsSync(pubFilePath)) return deny404(res, '文件不存在');

    var pubExt = pubPath.toLowerCase().split('.').pop();
    if (TEXT_SUPPORTED.indexOf(pubExt) === -1) {
      return res.status(415).json({ code: 415, message: '不支持的文本格式' });
    }

    var fileSize = fs.statSync(pubFilePath).size;
    var rawData = fs.readFileSync(pubFilePath);
    var buf = rawData;
    var truncated = fileSize > 5 * 1024 * 1024;
    if (truncated) buf = buf.slice(0, 5 * 1024 * 1024);
    var decoded = detectAndDecode(buf, req.query.encoding);
    logTraffic(user.id, '', 'preview', 0, pubPath, fileSize, buf.length);
    return res.json({
      code: 0,
      data: {
        filename: path.basename(pubPath),
        mime_type: 'text/plain',
        size: fileSize,
        truncated: truncated,
        content: decoded.content,
        encoding: decoded.encoding
      }
    });
  }

  var file = VirtualFile.findById(fileId);

  if (!file || file.user_id !== user.id) {
    log.info('[text] 文件未找到或权限不足: fileId=' + fileId + ' file=' + !!file + ' userId=' + user.id);
    return deny404(res, '文件不存在');
  }
  if (!checkPerm(user, file.dir_id, 'read')) return deny403(res, '无权限');

  var ext = (file.name || '').toLowerCase().split('.').pop();
  if (TEXT_SUPPORTED.indexOf(ext) === -1 && !(file.mime_type || '').startsWith('text/')) {
    return res.status(415).json({ code: 415, message: '不支持的文本格式' });
  }

  var filePath;
  try { filePath = getDecryptedFilePath(file); } catch(e) { log.info('[text] getDecryptedFilePath 异常: ' + e.message); filePath = null; }
  if (!filePath) {
    log.info('[text] 文件路径解析失败: fileId=' + fileId + ' name=' + file.name);
    return deny404(res, '文件不存在');
  }
  log.info('[text] 准备读取: fileId=' + fileId + ' name=' + file.name + ' path=' + filePath);

  try {
    var fileSize = fs.statSync(filePath).size;
  } catch(e) {
    log.info('[text] statSync 失败: path=' + filePath + ' err=' + e.message);
    return deny404(res, '文件不存在或已被删除');
  }
  var ENCRYPTED_MIN_SIZE = 88;
  var isUnencrypted = (fileSize < ENCRYPTED_MIN_SIZE);

  if (isUnencrypted) {
    try {
      var rawData = fs.readFileSync(filePath);
      var buf = rawData;
      var truncated = rawData.length > 5 * 1024 * 1024;
      if (truncated) buf = buf.slice(0, 5 * 1024 * 1024);
      var decoded = detectAndDecode(buf, req.query.encoding);
      logTraffic(user.id, '', 'preview', file.id, file.name, fileSize, buf.length);
      return res.json({
        code: 0,
        data: {
          filename: file.name,
          mime_type: file.mime_type,
          size: rawData.length,
          truncated: truncated,
          content: decoded.content,
          encoding: decoded.encoding
        }
      });
    } catch(e) {
      log.info('[text] 读取未加密文件失败: path=' + filePath + ' err=' + e.message);
      return res.status(500).json({ code: 500, message: '文件读取失败: ' + e.message });
    }
  }

  // 根据加密版本选择解密方式
  if (file.enc_version === 1) {
    // V1 分块加密格式
    try {
      var decryptStream = createV1DecryptStream(filePath, 0, fileSize - 1);
      var chunks = [];
      decryptStream.on('data', function(chunk) { chunks.push(chunk); });
      decryptStream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          var size = buf.length;
          if (size > 5 * 1024 * 1024) buf = buf.slice(0, 5 * 1024 * 1024);
          var decoded = detectAndDecode(buf, req.query.encoding);
          logTraffic(user.id, '', 'preview', file.id, file.name, fileSize, buf.length);
          res.json({
            code: 0,
            data: {
              filename: file.name,
              mime_type: file.mime_type,
              size: size,
              truncated: size > 5 * 1024 * 1024,
              content: decoded.content,
              encoding: decoded.encoding
            }
          });
        } catch(e) {
          if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解码失败: ' + e.message });
        }
      });
      decryptStream.on('error', function(err) {
        if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解密失败: ' + (err && err.message || '未知错误') });
      });
    } catch(e) {
      return res.status(500).json({ code: 500, message: 'V1文件解密失败: ' + e.message });
    }
  } else {
    // V0 原始加密格式
    try {
      var streamInfo = createDecryptStream(filePath);
      var chunks = [];

      streamInfo.readStream.on('data', function(chunk) { chunks.push(chunk); });
      streamInfo.readStream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          var size = buf.length;
          if (size > 5 * 1024 * 1024) { buf = buf.slice(0, 5 * 1024 * 1024); }
          var decoded = detectAndDecode(buf, req.query.encoding);
          logTraffic(user.id, '', 'preview', file.id, file.name, fileSize, buf.length);
          res.json({
            code: 0,
            data: {
              filename: file.name,
              mime_type: file.mime_type,
              size: size,
              truncated: size > 5 * 1024 * 1024,
              content: decoded.content,
              encoding: decoded.encoding
            }
          });
        } catch(e) {
          if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解码失败' });
        }
      });
      streamInfo.readStream.on('error', function(err) {
        if (!res.headersSent) res.status(500).json({ code: 500, message: '文件读取失败: ' + (err && err.message || '') });
      });
    } catch(e) {
      return res.status(500).json({ code: 500, message: '文件解密失败: ' + e.message });
    }
  }
});

// ==================== 文本编码检测辅助 ====================
function detectAndDecode(buf, overrideEncoding) {
  var result = { encoding: 'UTF-8', content: '', confidence: 0 };
  try {
    // 用户指定编码时直接使用，跳过自动检测
    if (overrideEncoding) {
      var enc = overrideEncoding.toLowerCase();
      if (enc === 'utf-8' || enc === 'utf8' || enc === 'ascii') {
        result.content = buf.toString('utf8');
        result.encoding = overrideEncoding.toUpperCase();
      } else {
        result.content = iconv.decode(buf, enc);
        result.encoding = overrideEncoding.toUpperCase();
      }
      result.confidence = 1;
      return result;
    }
    var detected = jschardet.detect(buf);
    if (detected && detected.encoding && detected.confidence > 0.5) {
      var enc = detected.encoding.toLowerCase();
      if (enc === 'utf-8' || enc === 'utf8' || enc === 'ascii') {
        result.content = buf.toString('utf8');
        result.encoding = 'UTF-8';
      } else {
        try {
          result.content = iconv.decode(buf, enc);
          result.encoding = enc.toUpperCase();
        } catch(e) {
          result.content = buf.toString('utf8');
          result.encoding = 'UTF-8 (fallback)';
        }
      }
      result.confidence = detected.confidence;
    } else {
      result.content = buf.toString('utf8');
      result.encoding = 'UTF-8';
      result.confidence = detected ? detected.confidence : 1;
    }
  } catch(e) {
    result.content = buf.toString('utf8');
    result.encoding = 'UTF-8';
  }
  return result;
}

// ==================== 文本文件保存（编辑后覆盖上传）====================
// PUT /api/files/text/:id  — 个人加密文件
// POST /api/files/text/0?public_path=xxx — 公共文件
router.put('/files/text/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;
  var content = req.body && req.body.content;
  if (!content && content !== '') return res.status(400).json({ code: 400, message: '缺少 content 字段' });

  // 公共文件保存
  if (req.query.public_path) {
    var pubPath = req.query.public_path;
    var pubRoot = Storage.PUBLIC_DIR;
    var pubFilePath = path.resolve(pubRoot, pubPath);
    if (!pubFilePath.startsWith(pubRoot)) return deny404(res, '路径不合法');
    try {
      var saveEncoding = (req.body.encoding || 'utf-8').toLowerCase();
      var saveBuf;
      if (saveEncoding === 'utf-8' || saveEncoding === 'utf8' || saveEncoding === 'ascii') {
        saveBuf = Buffer.from(content, 'utf8');
      } else {
        saveBuf = iconv.encode(content, saveEncoding);
      }
      fs.writeFileSync(pubFilePath, saveBuf);
      logTraffic(user.id, '', 'edit_save', 0, pubPath, saveBuf.length, saveBuf.length);
      return res.json({ code: 0, message: '保存成功', data: { size: saveBuf.length } });
    } catch(e) {
      return res.status(500).json({ code: 500, message: '保存失败: ' + e.message });
    }
  }

  // 个人文件保存（加密文件：先写临时文件 → 删除旧文件 → 重命名）
  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'write')) return deny403(res, '无写入权限');

  // 获取原文件路径
  var filePath;
  try { filePath = getDecryptedFilePath(file); } catch(e) { filePath = null; }
  if (!filePath) return deny404(res, '文件路径解析失败');

  var tmpPath = filePath + '.tmp_' + Date.now();

  try {
    // 编码新内容
    var saveEncoding = (req.body.encoding || 'utf-8').toLowerCase();
    var plainBuf;
    if (saveEncoding === 'utf-8' || saveEncoding === 'utf8' || saveEncoding === 'ascii') {
      plainBuf = Buffer.from(content, 'utf8');
    } else {
      plainBuf = iconv.encode(content, saveEncoding);
    }

    // 判断加密版本 → 写出到临时文件
    if (file.enc_version === 1 || file.enc_version === ENC_V1_VERSION) {
      var encResult = createV1EncryptStreamSync(tmpPath, plainBuf);
      if (!encResult.ok) throw new Error(encResult.error);
    } else {
      var encResult2 = encryptFileToBuffer(plainBuf);
      fs.writeFileSync(tmpPath, encResult2.encrypted);
    }

    // 删除旧文件（永久删除，不进回收站）
    try { fs.unlinkSync(filePath); } catch(e) { /* 旧文件可能已被清理 */ }

    // 重命名临时文件为原文件名
    fs.renameSync(tmpPath, filePath);

    // 更新数据库文件大小
    run('UPDATE virtual_files SET size = ? WHERE id = ?', [plainBuf.length, file.id]);
    file.size = plainBuf.length;

    logTraffic(user.id, '', 'edit_save', file.id, file.name, plainBuf.length, plainBuf.length);
    return res.json({ code: 0, message: '保存成功', data: { size: plainBuf.length } });
  } catch(e) {
    // 清理临时文件
    try { fs.unlinkSync(tmpPath); } catch(_) {}
    log.error('[text-save] 个人文件保存失败:', e.message);
    return res.status(500).json({ code: 500, message: '保存失败: ' + e.message });
  }
});

// ==================== DOCX 转换为HTML====================
// GET /api/files/docx/:id?public_path=xxx
router.get('/files/docx/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;

  // 公共文件：通过 public_path 查询参数指定相对路径
  if (req.query.public_path) {
    var pubPath = req.query.public_path;
    var pubRoot = Storage.PUBLIC_DIR;
    var pubFilePath = path.resolve(pubRoot, pubPath);
    if (!pubFilePath.startsWith(pubRoot)) return deny404(res, '文件不存在');
    if (!fs.existsSync(pubFilePath)) return deny404(res, '文件不存在');

    var pubExt = pubPath.toLowerCase().split('.').pop();
    if (pubExt !== 'docx') return res.status(415).json({ code: 415, message: '仅支持 docx 格式' });

    var rawData = fs.readFileSync(pubFilePath);
    mammoth.convertToHtml({ buffer: rawData }, {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "b => strong", "i => em", "u => u"
      ]
    }).then(function(result) {
      logTraffic(user.id, '', 'preview', 0, pubPath, rawData.length, 0);
      return res.json({ code: 0, data: { html: result.value, warnings: result.messages.map(function(m) { return m.message; }) } });
    }).catch(function(err) {
      log.error('[DOCX] 公共文件转换失败:', err.message);
      return res.status(500).json({ code: 500, message: 'DOCX 转换失败' });
    });
    return;
  }

  var file = VirtualFile.findById(fileId);

  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'read')) return deny403(res, '无权限');

  var ext = (file.name || '').toLowerCase().split('.').pop();
  if (ext !== 'docx') {
    return res.status(415).json({ code: 415, message: '仅支持 docx 格式' });
  }

  var filePath;
  try { filePath = getDecryptedFilePath(file); } catch(e) { filePath = null; }
  if (!filePath) return deny404(res, '文件不存在');

  var fileSize;
  try { fileSize = fs.statSync(filePath).size; } catch(e) { return deny404(res, '文件不存在或已被删除'); }

  function convertDocxBuffer(buf, size) {
    mammoth.convertToHtml({ buffer: buf }, {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "b => strong", "i => em", "u => u"
      ]
    }).then(function(result) {
      logTraffic(user.id, '', 'preview', file.id, file.name, fileSize, size);
      res.json({ code: 0, data: { filename: file.name, html: result.value, warnings: result.messages.map(function(m) { return m.message; }) } });
    }).catch(function(err) {
      log.error('[DOCX] 转换失败:', err.message);
      if (!res.headersSent) res.status(500).json({ code: 500, message: 'DOCX 转换失败: ' + err.message });
    });
  }

  var ENCRYPTED_MIN_SIZE = 88;
  var isUnencrypted = (fileSize < ENCRYPTED_MIN_SIZE);

  if (isUnencrypted) {
    try {
      var rawData = fs.readFileSync(filePath);
      convertDocxBuffer(rawData, rawData.length);
    } catch(e) {
      return res.status(500).json({ code: 500, message: '文件读取失败: ' + e.message });
    }
    return;
  }

  // 根据加密版本选择解密方式
  if (file.enc_version === 1) {
    // V1 分块加密格式
    try {
      var decryptStream = createV1DecryptStream(filePath, 0, fileSize - 1);
      decryptStream.on('error', function(err) {
        if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解密失败: ' + (err && err.message || '') });
      });
      var chunks = [];
      decryptStream.on('data', function(chunk) { chunks.push(chunk); });
      decryptStream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          convertDocxBuffer(buf, buf.length);
        } catch(e) {
          if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解码失败' });
        }
      });
    } catch(e) {
      return res.status(500).json({ code: 500, message: 'V1文件解密失败: ' + e.message });
    }
  } else {
    // V0 原始加密格式
    try {
      var streamInfo = createDecryptStream(filePath);
      var chunks = [];
      streamInfo.readStream.on('data', function(chunk) { chunks.push(chunk); });
      streamInfo.readStream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          convertDocxBuffer(buf, buf.length);
        } catch(e) {
          if (!res.headersSent) res.status(500).json({ code: 500, message: '文件解码失败' });
        }
      });
      streamInfo.readStream.on('error', function(err) {
        if (!res.headersSent) res.status(500).json({ code: 500, message: '文件读取失败: ' + (err && err.message || '') });
      });
    } catch(e) {
      return res.status(500).json({ code: 500, message: '文件解密失败: ' + e.message });
    }
  }

});

// ==================== 辅助函数：解密文件到 Buffer ====================
// 根据 enc_version 自动选择 V0/V1 解密，返回完整解密后的 Buffer
function decryptFileToBuffer(fileRecord, filePath, callback) {
  var fileSize;
  try { fileSize = fs.statSync(filePath).size; } catch(e) { return callback(e); }

  if (fileSize < 88) {
    // 未加密小文件，直接读取
    try {
      var raw = fs.readFileSync(filePath);
      return callback(null, raw, raw.length);
    } catch(e) { return callback(e); }
  }

  if (fileRecord.enc_version === 1) {
    // V1 分块加密
    try {
      var v1Stream = createV1DecryptStream(filePath, 0, fileSize - 1);
      var chunks = [];
      v1Stream.on('data', function(c) { chunks.push(c); });
      v1Stream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          callback(null, buf, buf.length);
        } catch(e) { callback(e); }
      });
      v1Stream.on('error', function(err) { callback(err); });
    } catch(e) { callback(e); }
  } else {
    // V0 原始加密
    try {
      var streamInfo = createDecryptStream(filePath);
      var chunks = [];
      streamInfo.readStream.on('data', function(c) { chunks.push(c); });
      streamInfo.readStream.on('end', function() {
        try {
          var buf = Buffer.concat(chunks);
          callback(null, buf, buf.length);
        } catch(e) { callback(e); }
      });
      streamInfo.readStream.on('error', function(err) { callback(err); });
    } catch(e) { callback(e); }
  }
}

// ==================== XLSX/Excel 转换为 HTML 预览 ====================
// GET /api/files/xlsx/:id?public_path=xxx
router.get('/files/xlsx/:id', requireAuth, function(req, res) {
  var fileId = parseInt(req.params.id, 10);
  var user = req.user;

  // 公共文件
  if (req.query.public_path) {
    var pubPath = req.query.public_path;
    var pubRoot = Storage.PUBLIC_DIR;
    var pubFilePath = path.resolve(pubRoot, pubPath);
    if (!pubFilePath.startsWith(pubRoot)) return deny404(res, '文件不存在');
    if (!fs.existsSync(pubFilePath)) return deny404(res, '文件不存在');
    var pubExt = pubPath.toLowerCase().split('.').pop();
    if (pubExt !== 'xlsx' && pubExt !== 'xls') return res.status(415).json({ code: 415, message: '仅支持 xlsx/xls 格式' });

    var pubSize = fs.statSync(pubFilePath).size;
    if (pubSize > PREVIEW_MAX_SIZE) return res.status(413).json({ code: 413, message: '文件超过10MB，不支持在线预览，请下载后查看' });

    try {
      var workbook = XLSX.readFile(pubFilePath);
      var html = renderXlsxToHtml(workbook);
      logTraffic(user.id, '', 'preview', 0, pubPath, pubSize, 0);
      return res.json({ code: 0, data: { filename: path.basename(pubPath), html: html, sheets: workbook.SheetNames } });
    } catch(e) {
      return res.status(500).json({ code: 500, message: 'Excel 解析失败: ' + e.message });
    }
  }

  // 个人文件
  var file = VirtualFile.findById(fileId);
  if (!file || file.user_id !== user.id) return deny404(res, '文件不存在');
  if (!checkPerm(user, file.dir_id, 'read')) return deny403(res, '无权限');

  if (file.size > PREVIEW_MAX_SIZE) {
    return res.status(413).json({ code: 413, message: '文件超过10MB，不支持在线预览，请下载后查看' });
  }

  var ext = (file.name || '').toLowerCase().split('.').pop();
  if (ext !== 'xlsx' && ext !== 'xls') return res.status(415).json({ code: 415, message: '仅支持 xlsx/xls 格式' });

  var filePath;
  try { filePath = getDecryptedFilePath(file); } catch(e) { filePath = null; }
  if (!filePath) return deny404(res, '文件不存在');

  decryptFileToBuffer(file, filePath, function(err, buf, decSize) {
    if (err) return res.status(500).json({ code: 500, message: '文件解密失败: ' + (err.message || '') });
    try {
      var workbook = XLSX.read(buf, { type: 'buffer' });
      var html = renderXlsxToHtml(workbook);
      logTraffic(user.id, '', 'preview', file.id, file.name, file.size, decSize);
      return res.json({ code: 0, data: { filename: file.name, html: html, sheets: workbook.SheetNames } });
    } catch(e) {
      return res.status(500).json({ code: 500, message: 'Excel 解析失败: ' + e.message });
    }
  });
});

// 将 xlsx workbook 渲染为带样式的 HTML 表格
function renderXlsxToHtml(workbook) {
  var esc = function(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
  var html = '';
  var sheetNames = workbook.SheetNames;
  if (sheetNames.length === 1) {
    var sheet = workbook.Sheets[sheetNames[0]];
    html = XLSX.utils.sheet_to_html(sheet, { id: '', editable: false });
  } else {
    // 多工作表：用 tab 切换
    html = '<div class="xlsx-tabs" style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">';
    for (var i = 0; i < sheetNames.length; i++) {
      html += '<button class="xlsx-tab" style="padding:6px 16px;border:1px solid rgba(0,212,255,0.3);border-radius:6px;background:' + (i === 0 ? 'rgba(0,212,255,0.15)' : 'transparent') + ';color:' + (i === 0 ? '#00d4ff' : '#8b949e') + ';cursor:pointer;font-size:13px" onclick="var p=this.parentNode;var s=p.nextElementSibling;var btns=p.querySelectorAll(\'.xlsx-tab\');var sheets=s.querySelectorAll(\'.xlsx-sheet\');for(var j=0;j<btns.length;j++){btns[j].style.background=j===' + i + '?\'rgba(0,212,255,0.15)\':\'transparent\';btns[j].style.color=j===' + i + '?\'#00d4ff\':\'#8b949e\';sheets[j].style.display=j===' + i + '?\'block\':\'none\';}">' + esc(sheetNames[i]) + '</button>';
    }
    html += '</div><div class="xlsx-sheets">';
    for (var i = 0; i < sheetNames.length; i++) {
      var sheet = workbook.Sheets[sheetNames[i]];
      var sheetHtml = XLSX.utils.sheet_to_html(sheet, { id: '', editable: false });
      html += '<div class="xlsx-sheet" style="' + (i === 0 ? '' : 'display:none') + '">' + sheetHtml + '</div>';
    }
    html += '</div>';
  }
  return html;
}

// ==================== 文件升级管理 API（管理员） ====================

// 获取升级统计信息
router.get('/admin/files/upgrade-stats', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  try {
    var total = VirtualFile.countForUpgrade();
    var users = query(
      'SELECT u.id, u.email, u.nickname, COUNT(vf.id) as pending_count FROM users u LEFT JOIN virtual_files vf ON u.id = vf.user_id AND vf.enc_version = 0 GROUP BY u.id ORDER BY pending_count DESC'
    );
    res.json({
      code: 0,
      data: {
        total_pending: total,
        by_user: users.map(function(u) {
          return {
            user_id: u.id,
            email: u.email,
            nickname: u.nickname,
            pending_count: u.pending_count || 0
          };
        })
      }
    });
  } catch(e) {
    log.error('[admin/files/upgrade-stats] error:', e);
    res.status(500).json({ code: 500, message: String(e) });
  }
});

// 获取待升级文件列表（分页）
router.get('/admin/files/pending-upgrade', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');

  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  var offset = (page - 1) * limit;
  var userId = parseInt(req.query.user_id, 10) || 0;

  var where = 'vf.enc_version = 0';
  var params = [];
  if (userId > 0) {
    where += ' AND vf.user_id = ?';
    params.push(userId);
  }

  var total = get('SELECT COUNT(*) as count FROM virtual_files vf WHERE ' + where, params);
  var files = query(
    'SELECT vf.id, vf.user_id, vf.name, vf.size, vf.storage_path, vf.nonce, vf.created_at, u.email, u.nickname as owner_name FROM virtual_files vf LEFT JOIN users u ON vf.user_id = u.id WHERE ' + where + ' ORDER BY vf.id LIMIT ' + limit + ' OFFSET ' + offset,
    params
  );

  res.json({
    code: 0,
    data: {
      total: total ? total.count : 0,
      page: page,
      limit: limit,
      files: files.map(function(f) {
        return {
          id: f.id,
          user_id: f.user_id,
          name: f.name,
          size: f.size,
          owner_email: f.email,
          owner_name: f.owner_name,
          created_at: f.created_at
        };
      })
    }
  });
});

// 升级单个文件
router.post('/admin/files/upgrade/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');

  var fileId = parseInt(req.params.id, 10);
  var file = VirtualFile.findById(fileId);
  if (!file) return deny404(res, '文件不存在');
  if (file.enc_version === ENC_V1_VERSION) {
    return res.json({ code: 0, data: { already_upgraded: true } });
  }

  var filePath = getDecryptedFilePath(file);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ code: 404, message: '文件不存在' });
  }

  // 检测当前文件是否已经是 V1 格式
  if (isV1EncryptedFile(filePath)) {
    VirtualFile.setEncVersion(fileId, ENC_V1_VERSION);
    return res.json({ code: 0, data: { already_v1: true } });
  }

  // 检测是否是未加密文件
  var encVer = detectFileEncVersion(filePath);
  if (encVer === -1) {
    VirtualFile.setEncVersion(fileId, -1); // 标记为未加密
    return res.json({ code: 0, data: { not_encrypted: true } });
  }

  // 生成临时文件路径
  var tempPath = filePath + '.v1tmp.' + Date.now();

  upgradeFileToV1(filePath, tempPath, function(err, newSize) {
    if (err) {
      // 清理临时文件
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
      return res.status(500).json({ code: 500, message: '升级失败: ' + (err.message || err) });
    }

    // 原子替换：先将旧文件重命名为 .bak，再将新文件移到原位置
    var bakPath = filePath + '.bak.' + Date.now();
    try {
      fs.renameSync(filePath, bakPath);
      fs.renameSync(tempPath, filePath);
      // 删除备份
      fs.unlinkSync(bakPath);
    } catch(e) {
      // 恢复
      try { if (fs.existsSync(bakPath)) fs.renameSync(bakPath, filePath); } catch(e2) {}
      return res.status(500).json({ code: 500, message: '文件替换失败: ' + e.message });
    }

    // 更新数据库
    VirtualFile.setEncVersion(fileId, ENC_V1_VERSION);
    log.info('[Upgrade] 文件 ' + fileId + ' 已升级到 V1，大小: ' + newSize);

    res.json({
      code: 0,
      data: {
        ok: true,
        file_id: fileId,
        new_size: newSize,
        old_size: file.size
      }
    });
  });
});

// 批量升级
router.post('/admin/files/upgrade-batch', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');

  var limit = Math.min(50, Math.max(1, parseInt(req.body.limit, 10) || 10));
  var files = VirtualFile.listForUpgrade(limit);
  var results = [];
  var errors = [];

  function processNext(idx) {
    if (idx >= files.length) {
      return res.json({
        code: 0,
        data: {
          processed: results.length + errors.length,
          success: results.length,
          failed: errors.length,
          results: results,
          errors: errors
        }
      });
    }

    var file = files[idx];
    var filePath = getDecryptedFilePath(file);

    if (!filePath || !fs.existsSync(filePath)) {
      errors.push({ id: file.id, name: file.name, error: '文件不存在' });
      processNext(idx + 1);
      return;
    }

    // 已经是 V1 或未加密
    if (isV1EncryptedFile(filePath) || detectFileEncVersion(filePath) === -1) {
      VirtualFile.setEncVersion(file.id, isV1EncryptedFile(filePath) ? ENC_V1_VERSION : -1);
      results.push({ id: file.id, name: file.name, skipped: true });
      processNext(idx + 1);
      return;
    }

    var tempPath = filePath + '.v1tmp.' + Date.now();
    upgradeFileToV1(filePath, tempPath, function(err, newSize) {
      if (err) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch(e) {}
        errors.push({ id: file.id, name: file.name, error: err.message || String(err) });
      } else {
        var bakPath = filePath + '.bak.' + Date.now();
        try {
          fs.renameSync(filePath, bakPath);
          fs.renameSync(tempPath, filePath);
          fs.unlinkSync(bakPath);
          VirtualFile.setEncVersion(file.id, ENC_V1_VERSION);
          results.push({ id: file.id, name: file.name, new_size: newSize });
        } catch(e2) {
          try { if (fs.existsSync(bakPath)) fs.renameSync(bakPath, filePath); } catch(e3) {}
          errors.push({ id: file.id, name: file.name, error: '替换失败: ' + e2.message });
        }
      }
      // 下一个（加延迟避免并发过高）
      setTimeout(function() { processNext(idx + 1); }, 50);
    });
  }

  processNext(0);
});

// ==================== 管理员文件列表（只读）====================

// ==================== 用户管理增强：封禁、解封、删除 ====================

// DELETE /api/admin/users/:id  删除用户（同时删除所有文件）
router.delete('/admin/users/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var userId = parseInt(req.params.id, 10);
  if (userId === req.user.id) return res.json({ code: 1, message: '不能删除自己', data: null });

  var targetUser = User.findById(userId);
  if (!targetUser) return res.json({ code: 1, message: '用户不存在', data: null });

  // 获取用户所有文件，删除物理文件
  var userFiles = query('SELECT * FROM virtual_files WHERE user_id = ?', [userId]);
  var userDirs = query('SELECT * FROM virtual_dirs WHERE user_id = ?', [userId]);
  userFiles.forEach(function(f) {
    if (f.storage_path) {
      try { fs.unlinkSync(f.storage_path); } catch (e) {}
    }
  });
  userDirs.forEach(function(d) {
    var dirPath = path.join(require('../config').STORAGE_PATH || path.join(__dirname, '..', 'storage'), 'files', String(userId));
    try { if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true }); } catch (e) {}
  });

  // 删除用户记录（CASCADE 会自动删除相关数据）
  User.delete(userId);
  logger.logAdmin(req, 'delete_user', 'user', targetUser.email, String(userId), '删除用户及其所有文件');

  res.json({ code: 0, message: '用户已删除', data: null });
});

// POST /api/admin/users/:id/ban  封禁用户
router.post('/admin/users/:id/ban', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var userId = parseInt(req.params.id, 10);
  if (userId === req.user.id) return res.json({ code: 1, message: '不能封禁自己', data: null });

  var targetUser = User.findById(userId);
  if (!targetUser) return res.json({ code: 1, message: '用户不存在', data: null });

  var reason = req.body.reason || '';
  var days = parseInt(req.body.days, 10) || 0; // 0=永久
  var expiresAt = null;
  if (days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  User.ban(userId, reason, expiresAt);
  logger.logAdmin(req, 'ban_user', 'user', targetUser.email, String(userId), '封禁原因: ' + reason + (expiresAt ? ', 到期: ' + expiresAt : ', 永久'));

  res.json({ code: 0, message: '用户已封禁', data: { expires_at: expiresAt } });
});

// POST /api/admin/users/:id/unban  解封用户
router.post('/admin/users/:id/unban', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var userId = parseInt(req.params.id, 10);

  var targetUser = User.findById(userId);
  if (!targetUser) return res.json({ code: 1, message: '用户不存在', data: null });

  User.unban(userId);
  logger.logAdmin(req, 'unban_user', 'user', targetUser.email, String(userId), '解除封禁');

  res.json({ code: 0, message: '用户已解封', data: null });
});

// PUT /api/admin/users/:id/traffic  设置用户流量限制
router.put('/admin/users/:id/traffic', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var userId = parseInt(req.params.id, 10);
  var uploadLimit = parseInt(req.body.upload_limit, 10);
  var downloadLimit = parseInt(req.body.download_limit, 10);
  if (!uploadLimit || !downloadLimit) return res.json({ code: 1, message: '参数错误', data: null });

  User.setTrafficLimit(userId, uploadLimit, downloadLimit);
  var targetUser = User.findById(userId);
  logger.logAdmin(req, 'set_traffic_limit', 'user', targetUser ? targetUser.email : userId, String(userId), '上传:' + formatFileSize(uploadLimit) + '/天, 下载:' + formatFileSize(downloadLimit) + '/天');

  res.json({ code: 0, message: '流量限制已更新', data: null });
});

// GET /api/admin/users/:id/traffic  获取用户流量信息
router.get('/admin/users/:id/traffic', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var userId = parseInt(req.params.id, 10);
  var today = new Date().toISOString().substring(0, 10);
  var traffic = User.getDailyTraffic(userId, today);
  var limits = User.getTrafficLimits(userId);

  res.json({
    code: 0,
    data: {
      date: today,
      upload_bytes: traffic ? traffic.upload_bytes : 0,
      download_bytes: traffic ? traffic.download_bytes : 0,
      upload_limit: limits.daily_upload_limit,
      download_limit: limits.daily_download_limit
    }
  });
});

// ==================== 文件管理增强：封禁、查看存储路径 ====================

// GET /api/admin/files  获取所有文件（增强版）
router.get('/admin/files', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');

  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  var offset = (page - 1) * limit;
  var userId = parseInt(req.query.user_id, 10) || 0;
  var keyword = req.query.keyword || '';
  var isBanned = req.query.is_banned;
  var encVersion = req.query.enc_version;

  var where = [];
  var params = [];
  if (userId > 0) { where.push('vf.user_id = ?'); params.push(userId); }
  if (keyword) { where.push('(vf.name LIKE ? OR u.email LIKE ?)'); params.push('%' + keyword + '%', '%' + keyword + '%'); }
  if (isBanned !== undefined && isBanned !== '' && isBanned !== null) {
    where.push('vf.is_banned = ?'); params.push(isBanned === 'true' || isBanned === '1' ? 1 : 0);
  }
  if (encVersion !== undefined && encVersion !== '' && encVersion !== null) {
    where.push('vf.enc_version = ?'); params.push(parseInt(encVersion, 10));
  }

  var whereStr = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  var total = get('SELECT COUNT(*) as count FROM virtual_files vf LEFT JOIN users u ON vf.user_id = u.id ' + whereStr, params);

  var files = query(
    'SELECT vf.id, vf.user_id, vf.dir_id, vf.name, vf.size, vf.mime_type, vf.enc_version, vf.is_banned, vf.ban_reason, vf.created_at, vf.updated_at, u.email, u.nickname as owner_name FROM virtual_files vf LEFT JOIN users u ON vf.user_id = u.id ' + whereStr + ' ORDER BY vf.id DESC LIMIT ' + limit + ' OFFSET ' + offset,
    params
  );

  // 获取每个文件的实际存储大小
  var resultFiles = files.map(function(f) {
    var storageSize = 0;
    if (f.storage_path) {
      try { storageSize = fs.statSync(f.storage_path).size; } catch (e) {}
    }
    return {
      id: f.id,
      user_id: f.user_id,
      dir_id: f.dir_id,
      name: f.name,
      size: f.size,
      storage_size: storageSize,
      mime_type: f.mime_type,
      enc_version: f.enc_version,
      is_banned: !!f.is_banned,
      ban_reason: f.ban_reason || '',
      owner_email: f.email,
      owner_name: f.owner_name,
      storage_path: f.storage_path,
      created_at: f.created_at,
      updated_at: f.updated_at
    };
  });

  res.json({ code: 0, data: { total: total ? total.count : 0, page: page, limit: limit, files: resultFiles } });
});

// POST /api/admin/files/:id/ban  封禁文件
router.post('/admin/files/:id/ban', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var fileId = parseInt(req.params.id, 10);
  var reason = req.body.reason || '';
  var days = parseInt(req.body.days, 10) || 0;
  var expiresAt = null;
  if (days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  VirtualFile.ban(fileId, reason, expiresAt);
  var file = VirtualFile.findById(fileId);
  logger.logAdmin(req, 'ban_file', 'file', file ? file.name : fileId, String(fileId), '封禁原因: ' + reason);

  res.json({ code: 0, message: '文件已封禁', data: { expires_at: expiresAt } });
});

// POST /api/admin/files/:id/unban  解封文件
router.post('/admin/files/:id/unban', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var fileId = parseInt(req.params.id, 10);

  VirtualFile.unban(fileId);
  var file = VirtualFile.findById(fileId);
  logger.logAdmin(req, 'unban_file', 'file', file ? file.name : fileId, String(fileId), '解除封禁');

  res.json({ code: 0, message: '文件已解封', data: null });
});

// ==================== 黑名单管理 ====================

// GET /api/admin/blacklist  获取IP黑名单列表
router.get('/admin/blacklist', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  var result = require('../lib/db').IPBlacklist.getAll(page, limit);
  res.json({ code: 0, data: { total: result.total, page: page, limit: limit, records: result.records } });
});

// POST /api/admin/blacklist  添加IP到黑名单
router.post('/admin/blacklist', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var ip = (req.body.ip || '').trim();
  var reason = req.body.reason || '';
  var days = parseInt(req.body.days, 10) || 0;
  var expiresAt = null;
  if (days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  if (!ip) return res.json({ code: 1, message: '请输入IP地址', data: null });

  var id = require('../lib/db').IPBlacklist.add(ip, reason, req.user.id, expiresAt);
  logger.logAdmin(req, 'add_ip_blacklist', 'ip_blacklist', ip, String(id), reason + (expiresAt ? ', 到期: ' + expiresAt : ', 永久'));

  res.json({ code: 0, message: 'IP已加入黑名单', data: { id: id } });
});

// DELETE /api/admin/blacklist/:id  从黑名单移除
router.delete('/admin/blacklist/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var id = parseInt(req.params.id, 10);
  require('../lib/db').IPBlacklist.delete(id);
  logger.logAdmin(req, 'remove_ip_blacklist', 'ip_blacklist', String(id), String(id), '删除黑名单记录');
  res.json({ code: 0, message: '已从黑名单移除', data: null });
});

// ==================== 频率限制规则管理 ====================

// GET /api/admin/rate-limit/rules  获取所有规则
router.get('/admin/rate-limit/rules', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var rules = require('../lib/db').RateLimitRules.getAll();
  var authenticated = rules.filter(function(r) { return r.user_type === 'authenticated'; });
  var anonymous = rules.filter(function(r) { return r.user_type === 'anonymous'; });
  res.json({ code: 0, data: { authenticated: authenticated, anonymous: anonymous } });
});

// POST /api/admin/rate-limit/rules  新增规则
router.post('/admin/rate-limit/rules', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var body = req.body;
  var userType = body.user_type;
  if (userType !== 'authenticated' && userType !== 'anonymous') {
    return res.json({ code: 400, message: 'user_type 必须是 authenticated 或 anonymous' });
  }
  var windowSeconds = parseInt(body.window_seconds, 10) || 60;
  if (windowSeconds < 1 || windowSeconds > 3600) {
    return res.json({ code: 400, message: '时间窗口必须在 1-3600 秒之间' });
  }
  var maxRequests = parseInt(body.max_requests, 10) || 1;
  if (maxRequests < 1) {
    return res.json({ code: 400, message: '最大请求数至少为 1' });
  }
  var banDurationSeconds = parseInt(body.ban_duration_seconds, 10);
  if (isNaN(banDurationSeconds) || banDurationSeconds < 0) {
    return res.json({ code: 400, message: '封禁时长必须 >= 0（0=永久）' });
  }
  var sortOrder = parseInt(body.sort_order, 10) || 0;
  var id = require('../lib/db').RateLimitRules.add(userType, windowSeconds, maxRequests, banDurationSeconds, sortOrder);
  if (global.__rateLimitReload) global.__rateLimitReload();
  logger.logAdmin(req, 'add_rate_limit_rule', 'rate_limit_rules', String(id), JSON.stringify(body), '新增频率限制规则');
  res.json({ code: 0, message: '规则已添加', data: { id: id } });
});

// PUT /api/admin/rate-limit/rules/:id  更新规则
router.put('/admin/rate-limit/rules/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var id = parseInt(req.params.id, 10);
  var existing = require('../lib/db').RateLimitRules.getById(id);
  if (!existing) return res.json({ code: 404, message: '规则不存在' });
  var fields = {};
  if (req.body.user_type !== undefined) fields.user_type = req.body.user_type;
  if (req.body.window_seconds !== undefined) fields.window_seconds = parseInt(req.body.window_seconds, 10);
  if (req.body.max_requests !== undefined) fields.max_requests = parseInt(req.body.max_requests, 10);
  if (req.body.ban_duration_seconds !== undefined) fields.ban_duration_seconds = parseInt(req.body.ban_duration_seconds, 10);
  if (req.body.is_enabled !== undefined) fields.is_enabled = req.body.is_enabled ? 1 : 0;
  if (req.body.sort_order !== undefined) fields.sort_order = parseInt(req.body.sort_order, 10);
  require('../lib/db').RateLimitRules.update(id, fields);
  if (global.__rateLimitReload) global.__rateLimitReload();
  logger.logAdmin(req, 'update_rate_limit_rule', 'rate_limit_rules', String(id), JSON.stringify(fields), '更新频率限制规则');
  res.json({ code: 0, message: '规则已更新' });
});

// DELETE /api/admin/rate-limit/rules/:id  删除规则
router.delete('/admin/rate-limit/rules/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var id = parseInt(req.params.id, 10);
  var existing = require('../lib/db').RateLimitRules.getById(id);
  if (!existing) return res.json({ code: 404, message: '规则不存在' });
  require('../lib/db').RateLimitRules.delete(id);
  if (global.__rateLimitReload) global.__rateLimitReload();
  logger.logAdmin(req, 'delete_rate_limit_rule', 'rate_limit_rules', String(id), String(id), '删除频率限制规则');
  res.json({ code: 0, message: '规则已删除' });
});

// ==================== 频率限制白名单管理 ====================

// GET /api/admin/rate-limit/whitelist  获取白名单
router.get('/admin/rate-limit/whitelist', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var list = require('../lib/db').RateLimitWhitelist.getAll();
  res.json({ code: 0, data: { whitelist: list } });
});

// POST /api/admin/rate-limit/whitelist  添加白名单路径
router.post('/admin/rate-limit/whitelist', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var body = req.body;
  var p = (body.path || '').trim();
  if (!p) return res.json({ code: 400, message: '路径不能为空' });
  if (p.indexOf('/') !== 0) return res.json({ code: 400, message: '路径必须以 / 开头' });
  var desc = (body.description || '').trim();
  var id = require('../lib/db').RateLimitWhitelist.add(p, desc);
  if (global.__rateLimitReload) global.__rateLimitReload();
  logger.logAdmin(req, 'add_rate_limit_whitelist', 'rate_limit_whitelist', String(id), p, '添加频率限制白名单');
  res.json({ code: 0, message: '白名单已添加', data: { id: id } });
});

// DELETE /api/admin/rate-limit/whitelist/:id  删除白名单
router.delete('/admin/rate-limit/whitelist/:id', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var id = parseInt(req.params.id, 10);
  require('../lib/db').RateLimitWhitelist.delete(id);
  if (global.__rateLimitReload) global.__rateLimitReload();
  logger.logAdmin(req, 'delete_rate_limit_whitelist', 'rate_limit_whitelist', String(id), String(id), '删除频率限制白名单');
  res.json({ code: 0, message: '白名单已删除' });
});

// ==================== 分享管理 ====================

// GET /api/admin/shares  获取所有分享列表
router.get('/admin/shares', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  log.info('[admin/shares] called, user:', req.user.email);
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  var userId = parseInt(req.query.user_id, 10) || 0;
  var keyword = req.query.keyword || '';
  var result = require('../lib/db').ShareStats.listAdmin(page, limit, userId, keyword);
  res.json({ code: 0, data: { total: result.total, page: page, limit: limit, shares: result.shares } });
});

// GET /api/admin/shares/:id/logs  获取分享访问日志
router.get('/admin/shares/:id/logs', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var shareId = parseInt(req.params.id, 10);
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  var result = require('../lib/db').ShareAccessLog.listByShare(shareId, page, limit);
  res.json({ code: 0, data: { total: result.total, page: page, limit: limit, logs: result.logs } });
});

// GET /api/admin/shares/access-logs  获取全部分享访问日志
router.get('/admin/shares/access-logs', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  var filters = {
    share_id: parseInt(req.query.share_id, 10) || 0,
    ip: req.query.ip || '',
    access_type: req.query.access_type || '',
    start_date: req.query.start_date || '',
    end_date: req.query.end_date || ''
  };
  var result = require('../lib/db').ShareAccessLog.listAll(page, limit, filters);
  res.json({ code: 0, data: { total: result.total, page: page, limit: limit, logs: result.logs } });
});

// ==================== 流量统计 API ====================

// GET /api/admin/traffic/summary  流量汇总（按用户/IP维度）
router.get('/admin/traffic/summary', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var opts = {
    user_id: parseInt(req.query.user_id, 10) || 0,
    is_guest: req.query.is_guest === '1' || req.query.is_guest === 'true',
    start_date: req.query.start_date || '',
    end_date: req.query.end_date || ''
  };
  var summary = TrafficLog.summaryByUser(opts);
  // 按用户聚合
  var userMap = {};
  summary.forEach(function(s) {
    var key = opts.is_guest ? s.guest_ip : ('u_' + s.key_id);
    if (!userMap[key]) {
      userMap[key] = { id: s.key_id, ip: s.guest_ip, total_bytes: 0, actions: {} };
    }
    userMap[key].total_bytes += s.total_bytes || 0;
    userMap[key].actions[s.action_type] = (userMap[key].actions[s.action_type] || 0) + (s.total_bytes || 0);
  });
  var results = Object.keys(userMap).map(function(k) { return userMap[k]; });
  results.sort(function(a, b) { return b.total_bytes - a.total_bytes; });
  // 补充用户信息
  results.forEach(function(r) {
    if (r.id > 0) {
      var u = User.findById(r.id);
      if (u) { r.email = u.email; r.nickname = u.nickname; }
    }
  });
  res.json({ code: 0, data: results });
});

// GET /api/admin/traffic/logs  流量明细记录
router.get('/admin/traffic/logs', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var opts = {
    user_id: parseInt(req.query.user_id, 10) || 0,
    guest_ip: req.query.guest_ip || '',
    action_type: req.query.action_type || '',
    start_date: req.query.start_date || '',
    end_date: req.query.end_date || '',
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
    limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
  };
  var result = TrafficLog.list(opts);
  res.json({ code: 0, data: { total: result.total, page: opts.page, limit: opts.limit, logs: result.logs } });
});

// GET /api/admin/traffic/chart  图表数据（每日/月度/年）
router.get('/admin/traffic/chart', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var groupBy = req.query.group_by || 'day'; // 'day' | 'month' | 'year'
  var userId = parseInt(req.query.user_id, 10) || 0;
  var guestIp = req.query.guest_ip || '';
  var opts = { user_id: userId, guest_ip: guestIp };
  var data = [];
  if (groupBy === 'day') {
    data = TrafficLog.dailySummary(opts);
  } else if (groupBy === 'month') {
    data = TrafficLog.monthlySummary(opts);
  } else {
    data = TrafficLog.yearlySummary(opts);
  }
  res.json({ code: 0, data: data });
});

// GET /api/admin/traffic/users  获取所有有流量记录的用户列表
router.get('/admin/traffic/users', requireAuth, function(req, res) {
  if (!req.user.is_admin) return deny403(res, '需要管理员权限');
  var users = query(
    'SELECT DISTINCT u.id, u.email, u.nickname FROM users u INNER JOIN traffic_logs tl ON u.id = tl.user_id ORDER BY u.email LIMIT 200'
  );
  var ips = query(
    'SELECT DISTINCT guest_ip FROM traffic_logs WHERE user_id = 0 AND guest_ip != "" ORDER BY guest_ip LIMIT 200'
  );
  res.json({ code: 0, data: { users: users, guest_ips: ips } });
});

// ==================== 流量配额管理 API ====================

// GET /api/admin/traffic/quotas  获取当前周期所有用户+访客的流量配额列表
router.get('/admin/traffic/quotas', requireAdmin, function(req, res) {
  var period = req.query.period || new Date().toISOString().substring(0, 7);
  var rows = TrafficQuota.listAll(period);
  // 补充用户信息
  rows.forEach(function(r) {
    if (r.user_id > 0) {
      var u = User.findById(r.user_id);
      if (u) { r.email = u.email; r.nickname = u.nickname; }
    }
  });
  // 分别统计用户数和访客数
  var userCount = rows.filter(function(r) { return r.user_id > 0; }).length;
  var guestCount = rows.filter(function(r) { return r.user_id === 0; }).length;
  res.json({ code: 0, data: {
    period: period,
    rows: rows,
    user_count: userCount,
    guest_count: guestCount
  }});
});

// GET /api/admin/traffic/quotas/:id_or_ip  获取单个配额详情
router.get('/admin/traffic/quotas/:idOrIp', requireAdmin, function(req, res) {
  var param = req.params.idOrIp;
  var period = req.query.period || new Date().toISOString().substring(0, 7);
  var isGuestIp = /^[0-9a-f.:]+$/i.test(param);
  var info;
  if (isGuestIp) {
    info = TrafficQuota.get(0, param, true);
    info.email = '访客';
    info.nickname = param;
    info.history = TrafficQuota.listByGuestIp(param);
  } else {
    var userId = parseInt(param, 10);
    info = TrafficQuota.get(userId, '', false);
    var u = User.findById(userId);
    if (u) { info.email = u.email; info.nickname = u.nickname; }
    info.history = TrafficQuota.listByUser(userId);
  }
  res.json({ code: 0, data: info });
});

// PUT /api/admin/traffic/quotas/user/:id  设置用户月度流量配额
router.put('/admin/traffic/quotas/user/:id', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var quotaBytes = parseInt(req.body.quota_bytes, 10);
  if (!quotaBytes || quotaBytes < 0) {
    return res.json({ code: 1, message: '配额值无效', data: null });
  }
  TrafficQuota.setQuota(userId, '', false, quotaBytes);
  var u = User.findById(userId);
  logger.logAdmin(req, 'update_traffic_quota', 'user', u ? u.email : userId, String(userId), '新流量配额: ' + quotaBytes + ' bytes');
  res.json({ code: 0, message: '流量配额已更新', data: null });
});

// PUT /api/admin/traffic/quotas/guest  设置访客月度流量配额（针对特定IP）
router.put('/admin/traffic/quotas/guest', requireAdmin, function(req, res) {
  var guestIp = (req.body.guest_ip || '').trim();
  var quotaBytes = parseInt(req.body.quota_bytes, 10);
  if (!guestIp) return res.json({ code: 1, message: '访客IP不能为空', data: null });
  if (!quotaBytes || quotaBytes < 0) {
    return res.json({ code: 1, message: '配额值无效', data: null });
  }
  TrafficQuota.setQuota(0, guestIp, true, quotaBytes);
  logger.logAdmin(req, 'update_traffic_quota', 'guest_ip', guestIp, guestIp, '新流量配额: ' + quotaBytes + ' bytes');
  res.json({ code: 0, message: '访客流量配额已更新', data: null });
});

// GET /api/admin/traffic/quotas/user/:id/history  用户历史配额记录
router.get('/admin/traffic/quotas/user/:id/history', requireAdmin, function(req, res) {
  var userId = parseInt(req.params.id, 10);
  var history = TrafficQuota.listByUser(userId);
  var u = User.findById(userId);
  res.json({ code: 0, data: { user: u ? { id: u.id, email: u.email, nickname: u.nickname } : null, history: history } });
});

module.exports = router;
module.exports.getDecryptedFilePath = getDecryptedFilePath;
