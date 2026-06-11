var log = require('../lib/log');
/**
 * WebDAV 协议支持 + WebDAV 链接管理
 *
 * WebDAV 端点: /webdav/:token/*  (基于 token 认证，无需登录)
 * 管理 API:    /api/webdav/links  (CRUD，需登录)
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 锁管理：lockToken → { userId, dirId, fileName, lockPath, expires }
var _activeLocks = {};
setInterval(function(){
  var now = Date.now();
  Object.keys(_activeLocks).forEach(function(k){
    if (_activeLocks[k].expires < now) delete _activeLocks[k];
  });
}, 60000);

// 锁空资源(Lock-null): LOCK不存在的URL时创建占位
function createLockNull(userId, dirId, fileName) {
  var crypto2 = require('crypto');
  var emptyUuid = crypto2.randomUUID();
  var Storage2 = require('../lib/db').Storage;
  var emptyPath = Storage2.getFilePath(userId, emptyUuid);
  var emptyDir = require('path').dirname(emptyPath);
  if (!require('fs').existsSync(emptyDir)) require('fs').mkdirSync(emptyDir, { recursive: true });
  require('fs').writeFileSync(emptyPath, Buffer.alloc(0));
  var VirtualFile2 = require('../lib/db').VirtualFile;
  return VirtualFile2.createWithEncVersion(userId, dirId, fileName, 0, 'application/octet-stream', emptyPath, emptyUuid, 0);
}

// 日志和流量记录
function logWebDAV(req, link, action, targetName, size, status) {
  try {
    var ActionLog = require('../lib/db').ActionLog;
    var ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().replace(/^::ffff:/, '');
    ActionLog.log(link.user_id, '', action, 'webdav_file', targetName, link.id, ip, req.headers['user-agent'] || 'WebDAV', status ? 'success' : 'error', '');
  } catch(e) {}
}
function trackTraffic(req, link, bytes) {
  try {
    var TrafficLog = require('../lib/db').TrafficLog;
    var ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().replace(/^::ffff:/, '');
    TrafficLog.log(link.user_id, ip, 'download', link.id, '', bytes);
  } catch(e) {}
}

// ==================== WebDAV 协议处理 ====================

// 处理无 token 的根路径（Windows 偶尔会探测）
router.all('/webdav', function(req, res) {
  if (req.method === 'OPTIONS') return setWebDAVOptions(res);
  res.status(404).end('WebDAV token required');
});

// OPTIONS - 声明支持的 WebDAV 方法
function setWebDAVOptions(res) {
  res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK');
  res.setHeader('DAV', '1,2');
  res.setHeader('MS-Author-Via', 'DAV'); // Windows 客户端兼容
  res.status(200).end();
}
router.options('/webdav/:token', function(req, res) { setWebDAVOptions(res); });
router.options('/webdav/:token/*', function(req, res) { setWebDAVOptions(res); });

// LOCK/UNLOCK - RFC 4918 Section 9.10
function handleLock(req, res, resolved) {
  var lockToken = 'opaquelocktoken:' + crypto.randomBytes(16).toString('hex');
  var timeout = 3600;
  var now = Date.now();

  // 解析Depth和Timeout
  var depth = (req.headers.depth || 'infinity').toString();
  var timeoutHeader = req.headers.timeout || '';
  if (timeoutHeader.indexOf('Second-') === 0) timeout = parseInt(timeoutHeader.substring(7), 10) || 3600;

  // 如果URL对应的资源不存在→创建锁空资源(Lock-Null)
  if (resolved && resolved.isPersonal && resolved.subPath) {
    var VF = require('../lib/db').VirtualFile, VD = require('../lib/db').VirtualDir;
    var parts2 = resolved.subPath.split('/').filter(Boolean);
    var fname2 = decodeURIComponent(parts2.pop() || '');
    var did = resolved.rootDirId;
    for (var pi = 0; pi < parts2.length; pi++) {
      var sds = VD.listPersonalByParent(resolved.userId, did);
      var fd2 = sds.find(function(d){ return d.name === decodeURIComponent(parts2[pi]); });
      if (!fd2) break;
      did = fd2.id;
    }
    if (fname2) {
      var files = VF.listByDir(resolved.userId, did);
      var existingFile = files.find(function(f){ return f.name === fname2; });
      if (!existingFile) {
        // 资源不存在→创建锁空资源
        var emptyId = createLockNull(resolved.userId, did, fname2);
        _activeLocks[lockToken] = { userId: resolved.userId, dirId: did, fileName: fname2, emptyId: emptyId, expires: now + timeout * 1000 };
        log.debug('[WebDAV-LOCK] Created lock-null resource: ' + fname2 + ' id=' + emptyId + ' token=' + lockToken.substring(0,20));
      } else {
        // 资源已存在→正常锁
        _activeLocks[lockToken] = { userId: resolved.userId, path: resolved.subPath, expires: now + timeout * 1000 };
      }
    }
  }

  var xml = '<?xml version="1.0"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>' +
    '<D:depth>' + depth + '</D:depth><D:timeout>Second-' + timeout + '</D:timeout>' +
    '<D:locktoken><D:href>' + lockToken + '</D:href></D:locktoken>' +
    '</D:activelock></D:lockdiscovery></D:prop>';
  res.setHeader('Lock-Token', '<' + lockToken + '>');
  res.status(200).send(xml);
  return;
}

// LOCK/UNLOCK 已移至 getHandler 和 router.all 中处理(有 resolved 上下文)

// 验证 token 并路由到公共/个人 WebDAV 处理器
function resolveWebDAV(token, subPath, req, res) {
  var WebDAVLink = require('../lib/db').WebDAVLink;
  var link = WebDAVLink.findByToken(token);
  if (!link) { res.status(404).end('Token not found'); return null; }
  if (WebDAVLink.checkExpired(link)) { res.status(410).end('Token expired'); return null; }

  if ((link.target_type || 'public') === 'personal') {
    log.debug('[WebDAV] PROPFIND personal link, userId=' + link.user_id + ', method=' + req.method);
    return resolvePersonalWebDAV(link, subPath, req, res);
  }
  log.debug('[WebDAV] PROPFIND public link, target=' + link.target_path + ', method=' + req.method);
  return resolvePublicWebDAV(link, subPath, req, res);
}

// 公共文件 WebDAV 解析
function resolvePublicWebDAV(link, subPath, req, res) {
  var User = require('../lib/db').User;
  if (link.require_auth) {
    var authOk = checkBasicAuth(req, res, link, User);
    if (!authOk) return null;
  }
  var Storage = require('../lib/db').Storage;
  var baseDir = path.join(Storage.PUBLIC_DIR, link.target_path);
  var fullPath = subPath ? path.join(baseDir, subPath) : baseDir;
  if (fullPath.indexOf(Storage.PUBLIC_DIR) !== 0) { res.status(403).end('Forbidden'); return null; }
  require('../lib/db').WebDAVLink.touchAccess(link.id);
  return { link: link, fullPath: fullPath, baseDir: baseDir, isPersonal: false };
}

function checkBasicAuth(req, res, link, UserArg) {
  var User = UserArg || require('../lib/db').User;
  var authHeader = req.headers.authorization || '';
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
    res.status(401).end('Authentication required');
    return false;
  }
  var creds = Buffer.from(authHeader.substring(6), 'base64').toString().split(':');
  var user = User.findByEmail(creds[0]);
  if (!user || !User.checkPassword(user, creds.slice(1).join(':'))) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
    res.status(401).end('Invalid credentials');
    return false;
  }
  if (user.id !== link.user_id && !user.is_admin) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
    res.status(403).end('Access denied');
    return false;
  }
  return true;
}

// 个人文件 WebDAV 解析：基于虚拟文件系统
function resolvePersonalWebDAV(link, subPath, req, res) {
  var VirtualDir = require('../lib/db').VirtualDir;
  var VirtualFile = require('../lib/db').VirtualFile;
  var User = require('../lib/db').User;
  var linkDirId = parseInt(link.target_path, 10) || 0;

  // Basic Auth
  if (link.require_auth) {
    var authHeader = req.headers.authorization || '';
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
      res.status(401).end('Authentication required');
      return null;
    }
    var creds = Buffer.from(authHeader.substring(6), 'base64').toString().split(':');
    var username = creds[0], password = creds.slice(1).join(':');
    var user = User.findByEmail(username);
    if (!user || !User.checkPassword(user, password)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
      res.status(401).end('Invalid credentials');
      return null;
    }
    if (user.id !== link.user_id && !user.is_admin) {
      res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV"');
      res.status(403).end('Access denied');
      return null;
    }
  }

  require('../lib/db').WebDAVLink.touchAccess(link.id);
  return { link: link, isPersonal: true, rootDirId: linkDirId, userId: link.user_id };
}

// PROPFIND - 列出目录内容或文件属性（使用 router.all 兼容所有 Express 版本）
router.all('/webdav/:token', function(req, res, next) {
  if (req.method === 'PROPFIND') return propfindHandler(req, res);
  next();
});
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method === 'PROPFIND') return propfindHandler(req, res);
  next();
});

// ==================== Redis 目录缓存 ====================
var _redis = null;
function getRedis() {
  if (_redis) return _redis;
  try { _redis = require('../lib/redis'); } catch(e) {}
  return _redis;
}
function cacheKey(userId, dirId) { return 'davcache:' + userId + ':' + dirId; }
function cacheGet(userId, dirId, cb) {
  var r = getRedis();
  if (!r || !r.get) return cb(null);
  r.get(cacheKey(userId, dirId), function(err, data) {
    if (err || !data) return cb(null);
    try { cb(JSON.parse(data)); } catch(e) { cb(null); }
  });
}
function cacheSet(userId, dirId, data) {
  var r = getRedis();
  if (!r || !r.setex) return;
  r.setex(cacheKey(userId, dirId), 15, JSON.stringify(data));
}
function cacheInvalidate(userId, dirId) {
  var r = getRedis();
  if (!r || !r.del) return;
  r.del(cacheKey(userId, dirId));
}

// ==================== 个人文件 WebDAV 操作 ====================
function personalPropfind(resolved, subPath, req, res) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var dirId = resolved.rootDirId;

  // 子路径导航：subPath 可能是目录路径或文件路径
  // Windows WebDAV 客户端会对每个文件单独发 PROPFIND (Depth:0)
  var depth = (req.headers.depth || 'infinity').toString();
  if (subPath) {
    var parts = subPath.split('/').filter(Boolean);
    // 先尝试纯目录导航（所有段都是目录）
    var navDirId = dirId;
    var allDirs = true;
    for (var i = 0; i < parts.length; i++) {
      var subDirs = VirtualDir.listPersonalByParent(resolved.userId, navDirId);
      var found = subDirs.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
      if (!found) { allDirs = false; break; }
      navDirId = found.id;
    }
    if (allDirs) {
      // 所有段都是目录
      dirId = navDirId;
    } else {
      // 最后一段可能是文件：分开处理
      var lastPart = decodeURIComponent(parts.pop());
      for (var j = 0; j < parts.length; j++) {
        var sds = VirtualDir.listPersonalByParent(resolved.userId, navDirId);
        var fd = sds.find(function(d) { return d.name === decodeURIComponent(parts[j]); });
        if (!fd) { res.status(404).end('Not found'); return; }
        navDirId = fd.id;
      }
      // 在最终目录中查找文件
      var dirFiles = VirtualFile.listByDir(resolved.userId, navDirId);
      var targetFile = dirFiles.find(function(f) { return f.name === lastPart; });
      if (targetFile) {
        // PROPFIND on a single file: 返回文件属性
        var fileBaseUrl = '/webdav/' + resolved.link.token + '/' + subPath;
        var User2 = require('../lib/db').User;
        var fu = User2.findById(resolved.userId);
        var fQuotaTotal = fu ? (fu.quota_bytes || 0) : 10 * 1024 * 1024 * 1024;
        var fQuotaUsed = fu ? (fu.used_bytes || 0) : 0;
        var fQuotaAvail = Math.max(0, fQuotaTotal - fQuotaUsed);
        var fileXml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n';
        fileXml += buildPropstat(fileBaseUrl, { mtime: new Date(targetFile.created_at || Date.now()), size: targetFile.size, mime: targetFile.mime_type || 'application/octet-stream', isDirectory: function() { return false; } }, false, fQuotaAvail, fQuotaUsed);
        fileXml += '</D:multistatus>\n';
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(207).send(fileXml);
        return;
      }
      // 也不是文件 → 检查是否是锁空占位文件
      var lockFile = null;
      Object.keys(_activeLocks).forEach(function(lt) {
        var l = _activeLocks[lt];
        if (l.fileName && l.userId === resolved.userId && l.dirId === navDirId && l.fileName === lastPart) {
          lockFile = l;
        }
      });
      if (lockFile) {
        var lockBaseUrl = '/webdav/' + resolved.link.token + '/' + subPath;
        var User3 = require('../lib/db').User;
        var lu = User3.findById(resolved.userId);
        var lQuotaTotal = lu ? (lu.quota_bytes || 0) : 10 * 1024 * 1024 * 1024;
        var lQuotaUsed = lu ? (lu.used_bytes || 0) : 0;
        var lQuotaAvail = Math.max(0, lQuotaTotal - lQuotaUsed);
        var lockXml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n';
        lockXml += buildPropstat(lockBaseUrl, { mtime: new Date(), size: 0, mime: 'application/octet-stream', isDirectory: function() { return false; } }, false, lQuotaAvail, lQuotaUsed);
        lockXml += '</D:multistatus>\n';
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.status(207).send(lockXml);
        return;
      }
      res.status(404).end('Not found'); return;
    }
  }

  // 缓存：异步set，不阻塞当前请求
  var dirs, files, currentDir;
  dirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
  files = VirtualFile.listByDir(resolved.userId, dirId);
  currentDir = VirtualDir.findById(dirId);
  // 异步写入Redis缓存（不阻塞响应）
  var cacheKey2 = 'davcache:' + resolved.userId + ':' + dirId;
  var rds2 = getRedis();
  if (rds2 && rds2.setex) {
    var cacheData = JSON.stringify({
      d: dirs.map(function(d){ return [d.id,d.name,d.created_at]; }),
      f: files.map(function(f){ return [f.id,f.name,f.size,f.mime_type,f.created_at,f.storage_id,f.storage_path,f.enc_version]; }),
      c: currentDir ? [currentDir.id, currentDir.created_at] : null
    });
    rds2.setex(cacheKey2, 12, cacheData);
  }
  var baseUrl = '/webdav/' + resolved.link.token + (subPath ? '/' + subPath : '');

  var xml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n';

  // 获取用户配额信息
  var User = require('../lib/db').User;
  var u = User.findById(resolved.userId);
  var quotaTotal = u ? (u.quota_bytes || 0) : 10 * 1024 * 1024 * 1024;
  var quotaUsed = u ? (u.used_bytes || 0) : 0;
  var quotaAvail = Math.max(0, quotaTotal - quotaUsed);
  log.debug('[WebDAV-Personal] quota=' + (quotaTotal/1024/1024/1024).toFixed(2) + 'GB, used=' + (quotaUsed/1024/1024/1024).toFixed(2) + 'GB, avail=' + (quotaAvail/1024/1024/1024).toFixed(2) + 'GB');

  // 当前目录（附加用户配额信息）
  var dirStat = { mtime: currentDir ? new Date(currentDir.created_at) : new Date(), size: 0, isDirectory: function() { return true; } };
  xml += buildPropstat(baseUrl, dirStat, true, quotaAvail, quotaUsed);

  // RFC 4918 9.1: Depth 0 只返回资源本身
  if (depth !== '0') {
    dirs.forEach(function(d) {
      var href = baseUrl.replace(/\/$/, '') + '/' + encodeURIComponent(d.name);
      xml += buildPropstat(href, { mtime: new Date(d.created_at || Date.now()), size: 0, isDirectory: function() { return true; } }, true, quotaAvail, quotaUsed);
    });
    files.forEach(function(f) {
      var href = baseUrl.replace(/\/$/, '') + '/' + encodeURIComponent(f.name);
      xml += buildPropstat(href, { mtime: new Date(f.created_at || Date.now()), size: f.size, mime: f.mime_type || 'application/octet-stream', isDirectory: function() { return false; } }, false, quotaAvail, quotaUsed);
    });
    // 锁空占位文件：从_activeLocks中找出当前目录的占位
    Object.keys(_activeLocks).forEach(function(lockToken) {
      var l = _activeLocks[lockToken];
      if (!l.fileName || l.userId !== resolved.userId) return;
      if (l.dirId !== dirId) return;
      if (files.find(function(f){ return f.name === l.fileName; })) return;
      var href2 = baseUrl.replace(/\/$/, '') + '/' + encodeURIComponent(l.fileName);
      xml += buildPropstat(href2, { mtime: new Date(), size: 0, mime: 'application/octet-stream', isDirectory: function() { return false; } }, false, quotaAvail, quotaUsed);
    });
  }

  xml += '</D:multistatus>\n';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(207).send(xml);
}

function personalGetFile(resolved, subPath, req, res) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var dirId = resolved.rootDirId, fileName = '';

  if (subPath) {
    var parts = subPath.split('/').filter(Boolean);
    fileName = decodeURIComponent(parts.pop());
    for (var i = 0; i < parts.length; i++) {
      var subDirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
      var found = subDirs.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
      if (!found) { res.status(404).end('Not found'); return; }
      dirId = found.id;
    }
  }

  if (!fileName) {
    // 请求的是目录本身
    personalPropfind(resolved, subPath, req, res);
    return;
  }

  var files = VirtualFile.listByDir(resolved.userId, dirId);
  var file = files.find(function(f) { return f.name === fileName; });
  // 占位文件：DB里没有但在_activeLocks中（遍历查找，handleLock用lockToken作key）
  if (!file) {
    var lockEntry = null;
    Object.keys(_activeLocks).forEach(function(lt) {
      var l = _activeLocks[lt];
      if (l.fileName && l.userId === resolved.userId && l.dirId === dirId && l.fileName === fileName) {
        lockEntry = l;
      }
    });
    if (lockEntry) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', '0');
      res.setHeader('Accept-Ranges', 'bytes');
      if (req.method === 'HEAD') res.status(200).end(); else res.status(200).end('');
      return;
    }
  }
  if (!file) {
    // 可能是子目录
    var subDirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
    var subDir = subDirs.find(function(d) { return d.name === fileName; });
    if (subDir) {
      var newSubPath = subPath ? subPath.replace('/' + encodeURIComponent(fileName), '') + '/' + encodeURIComponent(fileName) : encodeURIComponent(fileName);
      personalPropfind(resolved, newSubPath, req, res);
      return;
    }
    res.status(404).end('Not found'); return;
  }

  // 解析文件路径
  var storagePath = file.storage_path;
  log.debug('[WebDAV-GET] file=' + file.name + ' storagePath=' + (storagePath||'(empty)') + ' storageId=' + file.storage_id);
  if (!storagePath || !fs.existsSync(storagePath)) {
    // 通过 storage_id 查找
    if (file.storage_id && file.storage_id > 0) {
      var resolvedPath = require('../routes/file').getDecryptedFilePath(file);
      log.debug('[WebDAV-GET] resolved via storage_id: ' + (resolvedPath||'null'));
      if (resolvedPath) storagePath = resolvedPath;
    }
    if (!storagePath || !fs.existsSync(storagePath)) { res.status(404).end('File not on disk'); return; }
  }

  // 流式解密下载（支持 Range）
  var cryptoLib = require('../lib/crypto');

  var mime = file.mime_type || 'application/octet-stream';
  var inline = isInlineMedia(mime);
  var fileSize = file.size;
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  if (!inline) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(file.name) + '"');
  else res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(file.name) + '"');

  var range = req.headers.range;

  // V2 XOR 加密
  if (file.enc_version === 2) {
    var v2Info = require('../lib/crypto').getV2FileInfo(storagePath);
    var v2Size = v2Info ? v2Info.originalSize : file.size;
    res.setHeader('Content-Length', v2Size);
    if (req.method === 'HEAD') { res.status(200).end(); return; }
    var v2Stream = require('../lib/crypto').createV2DecryptStream(storagePath);
    v2Stream.on('error', function() { if (!res.headersSent) res.status(500).end('Decrypt error'); });
    v2Stream.pipe(res);
    logWebDAV(req, resolved.link, 'download', file.name, v2Size, true);
    trackTraffic(req, resolved.link, v2Size);
    return;
  }
  // V1 加密文件 Range 支持：解密后切片（0字节也可正常解密）
  if (file.enc_version === 1) {
    // 对于 Range 请求且文件 < 50MB，解密到内存后切片
    if (range && fileSize < 50 * 1024 * 1024) {
      var info = cryptoLib.getV1FileInfo(storagePath);
      var originalSize = info ? info.originalSize : fileSize;
      var decryptStream = cryptoLib.createV1DecryptStream(storagePath);
      var chunks = [];
      decryptStream.on('data', function(c) { chunks.push(c); });
      decryptStream.on('end', function() {
        var fullData = Buffer.concat(chunks);
        serveRange(res, fullData, originalSize, range, mime, inline, file.name);
      });
      decryptStream.on('error', function() { if (!res.headersSent) res.status(500).end('Decrypt error'); });
      return;
    }
    // 完整下载（流式）
    var info2 = cryptoLib.getV1FileInfo(storagePath);
    res.setHeader('Content-Length', info2 ? info2.originalSize : fileSize);
    var ds = cryptoLib.createV1DecryptStream(storagePath);
    ds.on('error', function() { if (!res.headersSent) res.status(500).end('Decrypt error'); });
    ds.pipe(res);
    logWebDAV(req, resolved.link, 'download', file.name, fileSize, true);
    trackTraffic(req, resolved.link, fileSize);
    return;
  }

  // 旧格式加密
  var encBuffer = fs.readFileSync(storagePath);
  var result = cryptoLib.createDecryptStream(encBuffer, file.nonce);
  if (range) { serveRange(res, result.plaintext, result.plaintext.length, range, mime, inline, file.name); return; }
  res.setHeader('Content-Length', result.plaintext.length);
  logWebDAV(req, resolved.link, 'download', file.name, result.plaintext.length, true);
  trackTraffic(req, resolved.link, result.plaintext.length);
  res.send(result.plaintext);
}

// Range 请求辅助函数
function serveRange(res, fullData, totalSize, rangeHeader, mime, inline, filename) {
  var parts = rangeHeader.replace(/bytes=/, '').split('-');
  var start = parseInt(parts[0], 10) || 0;
  var end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
  if (end >= totalSize) end = totalSize - 1;
  if (start >= totalSize) { res.status(416).setHeader('Content-Range', 'bytes */' + totalSize).end(); return; }
  var slice = fullData.slice(start, end + 1);
  res.status(206);
  res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + totalSize);
  res.setHeader('Content-Length', slice.length);
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  if (!inline) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
  else res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(filename) + '"');
  res.send(slice);
}

function personalPutFile(resolved, subPath, res, req) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var cryptoLib = require('../lib/crypto');
  var Storage = require('../lib/db').Storage;
  var tmpDir = path.join(require('os').tmpdir(), 'webdav_upload');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  var dirId = resolved.rootDirId, fileName = '';

  if (subPath) {
    var parts = subPath.split('/').filter(Boolean);
    fileName = decodeURIComponent(parts.pop());
    for (var i = 0; i < parts.length; i++) {
      var subDirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
      var found = subDirs.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
      if (!found) { res.status(404).end('Parent not found'); return; }
      dirId = found.id;
    }
  }
  if (!fileName) { res.status(400).end('Filename required'); return; }

  log.debug('[WebDAV-PUT] upload target: fileName=' + fileName + ' dirId=' + dirId + ' userId=' + resolved.userId + ' subPath=' + (subPath||'(root)'));

  // 流式写入临时文件 + 增量计算 SHA256（避免 finish 后全量 fs.readFileSync）
  var tmpPath = path.join(tmpDir, 'webdav_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'));
  var ws = fs.createWriteStream(tmpPath);
  var putError = null;
  var hash = crypto.createHash('sha256');
  var totalBytes = 0;
  req.on('data', function(chunk) { totalBytes += chunk.length; hash.update(chunk); });
  ws.on('error', function(e) { putError = e; try { fs.unlinkSync(tmpPath); } catch(e2) {} if (!res.headersSent) res.status(500).end(e.message); });
  req.on('error', function(e) { putError = e; try { fs.unlinkSync(tmpPath); } catch(e2) {} if (!res.headersSent) res.status(500).end(e.message); });
  req.pipe(ws);

  ws.on('finish', function() {
    if (putError) return;
    var mimeType = require('mime-types').lookup(fileName) || 'application/octet-stream';
    var fileHash = hash.digest('hex');
    try {
      // 检查同名文件
      var existing = VirtualFile.listByDir(resolved.userId, dirId).find(function(f) { return f.name === fileName; });
      if (existing) {
        if (existing.size === 0) {
          try { fs.unlinkSync(existing.storage_path); } catch(e) {}
          require('../lib/db').run('DELETE FROM virtual_files WHERE id = ?', [existing.id]);
        } else {
          require('../lib/db').RecycleBin.moveFile(existing.id, resolved.userId);
          require('../lib/db').User.updateUsedBytes(resolved.userId, -existing.size);
        }
      }

      // 哈希秒传检测（在加密前，节省计算）
      var FileStorage = require('../lib/db').FileStorage;
      var UserFileRef = require('../lib/db').UserFileRef;
      var existingFS = FileStorage.findByHashAndSize(fileHash, totalBytes);
      if (existingFS && FileStorage.hasValidPath(existingFS.id)) {
        // 秒传：文件已存在，直接引用
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        FileStorage.incrementRef(existingFS.id);
        UserFileRef.create(resolved.userId, existingFS.id, dirId, fileName, mimeType);
        var vfId2 = VirtualFile.createWithEncVersion(resolved.userId, dirId, fileName, totalBytes, mimeType, '', '', 1);
        if (vfId2) require('../lib/db').run('UPDATE virtual_files SET storage_id=? WHERE id=?', [existingFS.id, vfId2]);
        require('../lib/db').User.updateUsedBytes(resolved.userId, totalBytes);
        cacheInvalidate(resolved.userId, dirId);
        logWebDAV(req, resolved.link, 'upload', fileName, totalBytes, true);
        log.info('[WebDAV-PUT] 秒传命中: ' + fileName + ' dirId=' + dirId + ' hash=' + fileHash.substring(0,12));
        res.status(201).end('Created');
        return;
      }

      // V1 分块流式加密（使用 createV1EncryptStreamLarge，按4MB块读写，内存友好）
      var fileUuid = crypto.randomUUID();
      var storagePath = Storage.getFilePath(resolved.userId, fileUuid);
      var encResult = cryptoLib.createV1EncryptStreamLarge(tmpPath, storagePath);
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      if (!encResult.ok) { res.status(500).end('Encrypt error: ' + (encResult.error || '')); return; }

      // 创建存储记录
      var storageId = FileStorage.create(fileUuid, fileHash, totalBytes, totalBytes, 1, true, encResult.nonce);
      require('../lib/db').run('UPDATE file_storage SET group_id=(SELECT group_id FROM storage_pools WHERE status=? ORDER BY group_id,mirror_index LIMIT 1) WHERE id=?', ['active', storageId]);
      var wPool = require('../lib/db').get('SELECT id,local_path FROM storage_pools WHERE status=? ORDER BY group_id,mirror_index LIMIT 1', ['active']);
      var relP = (wPool&&wPool.local_path) ? require('path').relative(wPool.local_path, storagePath).replace(/\\/g,'/') : storagePath.replace(/\\/g,'/');
      FileStorage.addPath(storageId, wPool?wPool.id:1, relP, relP);
      UserFileRef.create(resolved.userId, storageId, dirId, fileName, mimeType);

      var vfId = VirtualFile.createWithEncVersion(resolved.userId, dirId, fileName, totalBytes, mimeType, storagePath, fileUuid, 1);
      if (vfId) require('../lib/db').run('UPDATE virtual_files SET storage_id=? WHERE id=?', [storageId, vfId]);

      require('../lib/db').User.updateUsedBytes(resolved.userId, totalBytes);
      cacheInvalidate(resolved.userId, dirId);
      logWebDAV(req, resolved.link, 'upload', fileName, totalBytes, true);
      log.debug('[WebDAV-PUT] success: ' + fileName + ' dirId=' + dirId + ' size=' + Math.round(totalBytes/1024) + 'KB storageId=' + storageId + ' vfId=' + vfId);
      res.status(201).end('Created');
    } catch(e) {
      log.error('[WebDAV-PUT] Error:', e.message);
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
      if (!res.headersSent) res.status(500).end(e.message);
    }
  });
}

function personalDelete(resolved, subPath, res) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var RecycleBin = require('../lib/db').RecycleBin;
  var User = require('../lib/db').User;
  var dirId = resolved.rootDirId;

  if (!subPath) { res.status(403).end('Cannot delete root'); return; }

  var parts = subPath.split('/').filter(Boolean);
  var targetName = decodeURIComponent(parts.pop());
  for (var i = 0; i < parts.length; i++) {
    var subDirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
    var found = subDirs.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
    if (!found) { res.status(404).end('Not found'); return; }
    dirId = found.id;
  }

  var files = VirtualFile.listByDir(resolved.userId, dirId);
  var file = files.find(function(f) { return f.name === targetName; });
  if (file) {
    cacheInvalidate(resolved.userId, dirId);
    RecycleBin.moveFile(file.id, resolved.userId);
    User.updateUsedBytes(resolved.userId, -file.size);
    res.status(204).end(); return;
  }

  var dirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
  var dir = dirs.find(function(d) { return d.name === targetName; });
  if (dir) {
    // 递归计算目录树中所有文件的总大小
    var totalSize = getPersonalDirTotalSize(resolved.userId, dir.id);
    RecycleBin.moveDir(dir.id, resolved.userId);
    User.updateUsedBytes(resolved.userId, -totalSize);
    res.status(204).end(); return;
  }

  res.status(404).end('Not found');
}

// 递归统计个人虚拟目录下所有文件总大小
function getPersonalDirTotalSize(userId, dirId) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var total = 0;
  var files = VirtualFile.listByDir(userId, dirId);
  files.forEach(function(f) { total += f.size || 0; });
  var subDirs = VirtualDir.listPersonalByParent(userId, dirId);
  subDirs.forEach(function(d) { total += getPersonalDirTotalSize(userId, d.id); });
  return total;
}

function personalMkcol(resolved, subPath, res) {
  var VirtualDir = require('../lib/db').VirtualDir;
  var dirId = resolved.rootDirId;
  if (!subPath) { res.status(405).end('Name required'); return; }

  var parts = subPath.split('/').filter(Boolean);
  var newDirName = decodeURIComponent(parts.pop());
  for (var i = 0; i < parts.length; i++) {
    var subDirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
    var found = subDirs.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
    if (!found) { res.status(404).end('Parent not found'); return; }
    dirId = found.id;
  }

  var existing = VirtualDir.listPersonalByParent(resolved.userId, dirId).find(function(d) { return d.name === newDirName; });
  if (existing) { res.status(405).end('Already exists'); return; }

  VirtualDir.create(resolved.userId, dirId, newDirName, false);
  res.status(201).end('Created');
}

// MOVE - 个人文件移动/重命名
function personalMove(resolved, subPath, destSubPath, req, res) {
  try {
    var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
    var dirId = resolved.rootDirId;

    // destSubPath 来自 Destination 头（原始 HTTP 头，未URL解码），需要解码
    var destDecoded = decodeURIComponent(destSubPath);
    var destParts = destDecoded.split('/').filter(Boolean);
    var destName = destParts.pop() || '';
    if (!destName) { res.status(400).end('Destination name required'); return; }

    // subPath 来自 Express req.params[0]，已被 Express URL解码过，不再重复解码
    var parts = subPath.split('/').filter(Boolean);
    var srcName = parts.pop() || '';
    for (var i = 0; i < parts.length; i++) {
      var sd = VirtualDir.listPersonalByParent(resolved.userId, dirId);
      var f = sd.find(function(d) { return d.name === parts[i]; });
      if (!f) { res.status(404).end('Source path not found: ' + parts[i]); return; }
      dirId = f.id;
    }

    // 定位目标目录（destParts 是解码后的目录名，直接比较）
    var destDirId = resolved.rootDirId;
    for (var j = 0; j < destParts.length; j++) {
      var dsd = VirtualDir.listPersonalByParent(resolved.userId, destDirId);
      var df = dsd.find(function(d) { return d.name === destParts[j]; });
      if (!df) { res.status(409).end('Destination parent not found: ' + destParts[j]); return; }
      destDirId = df.id;
    }

    // 查找源文件/目录
    var files = VirtualFile.listByDir(resolved.userId, dirId);
    var file = files.find(function(f) { return f.name === srcName; });
    if (file) {
      require('../lib/db').run('UPDATE virtual_files SET dir_id = ?, name = ?, updated_at = datetime("now") WHERE id = ?',
        [destDirId, destName, file.id]);
      cacheInvalidate(resolved.userId, dirId);
      cacheInvalidate(resolved.userId, destDirId);
      log.info('[WebDAV-MOVE] OK: ' + srcName + ' id=' + file.id + ' from dirId=' + dirId + ' to dirId=' + destDirId);
      res.status(201).end('Moved');
      return;
    }

    var dirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
    var dir = dirs.find(function(d) { return d.name === srcName; });
    if (dir) {
      require('../lib/db').run('UPDATE virtual_dirs SET parent_id = ?, name = ? WHERE id = ?',
        [destDirId, destName, dir.id]);
      cacheInvalidate(resolved.userId, dirId);
      cacheInvalidate(resolved.userId, destDirId);
      log.info('[WebDAV-MOVE] OK dir: ' + srcName + ' id=' + dir.id + ' from parent=' + dirId + ' to parent=' + destDirId);
      res.status(201).end('Moved');
      return;
    }

    log.warn('[WebDAV-MOVE] Source not found: srcName=' + srcName + ' in dirId=' + dirId);
    res.status(404).end('Source not found: ' + srcName);
  } catch(e) {
    log.error('[WebDAV-MOVE] Error:', e.message, e.stack);
    if (!res.headersSent) res.status(500).end('Move error: ' + e.message);
  }
}

// COPY - 个人文件复制（通过引用计数）
function personalCopy(resolved, subPath, destSubPath, req, res) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var FileStorage = require('../lib/db').FileStorage;
  var UserFileRef = require('../lib/db').UserFileRef;
  var dirId = resolved.rootDirId;

  var destParts = decodeURIComponent(destSubPath).split('/').filter(Boolean);
  var destName = destParts.pop() || '';
  if (!destName) { res.status(400).end('Destination name required'); return; }

  // 定位源文件
  var parts = subPath.split('/').filter(Boolean);
  var srcName = decodeURIComponent(parts.pop() || '');
  for (var i = 0; i < parts.length; i++) {
    var sd = VirtualDir.listPersonalByParent(resolved.userId, dirId);
    var f = sd.find(function(d) { return d.name === decodeURIComponent(parts[i]); });
    if (!f) { res.status(404).end('Not found'); return; }
    dirId = f.id;
  }

  // 定位目标目录
  var destDirId = resolved.rootDirId;
  for (var j = 0; j < destParts.length; j++) {
    var dsd = VirtualDir.listPersonalByParent(resolved.userId, destDirId);
    var df = dsd.find(function(d) { return d.name === destParts[j]; });
    if (!df) { res.status(409).end('Destination parent not found'); return; }
    destDirId = df.id;
  }

  // 查找源文件
  var files = VirtualFile.listByDir(resolved.userId, dirId);
  var file = files.find(function(f) { return f.name === srcName; });
  if (file) {
    // 通过引用计数复制（不是物理复制）
    var storageId = file.storage_id || 0;
    if (storageId > 0) {
      FileStorage.incrementRef(storageId);
      UserFileRef.create(resolved.userId, storageId, destDirId, destName, file.mime_type);
    }
    // 创建 virtual_files 副本
    var crypto = require('crypto');
    VirtualFile.createWithEncVersion(resolved.userId, destDirId, destName, file.size, file.mime_type,
      file.storage_path, file.uuid || crypto.randomUUID(), file.enc_version || 1);
    var newFile = VirtualFile.listByDir(resolved.userId, destDirId).find(function(f) { return f.name === destName; });
    if (newFile && storageId > 0) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, newFile.id]);
    }
    var User = require('../lib/db').User;
    User.updateUsedBytes(resolved.userId, file.size);
    res.status(201).end('Copied');
    return;
  }

  // 查找源目录
  var dirs = VirtualDir.listPersonalByParent(resolved.userId, dirId);
  var dir = dirs.find(function(d) { return d.name === srcName; });
  if (dir) {
    // 递归复制目录
    var newDirId = VirtualDir.create(resolved.userId, destDirId, destName, false);
    if (!newDirId) { res.status(500).end('Copy dir failed'); return; }
    // 递归复制子内容
    personalCopyDirRecursive(resolved.userId, dir.id, newDirId);
    res.status(201).end('Copied');
    return;
  }

  res.status(404).end('Not found');
}

// 递归复制目录内容（用于个人 COPY）
function personalCopyDirRecursive(userId, srcDirId, destDirId) {
  var VirtualFile = require('../lib/db').VirtualFile, VirtualDir = require('../lib/db').VirtualDir;
  var FileStorage = require('../lib/db').FileStorage;
  var UserFileRef = require('../lib/db').UserFileRef;
  var crypto = require('crypto');

  // 复制文件
  var files = VirtualFile.listByDir(userId, srcDirId);
  files.forEach(function(f) {
    var sid = f.storage_id || 0;
    if (sid > 0) { FileStorage.incrementRef(sid); UserFileRef.create(userId, sid, destDirId, f.name, f.mime_type); }
    VirtualFile.createWithEncVersion(userId, destDirId, f.name, f.size, f.mime_type,
      f.storage_path, f.uuid || crypto.randomUUID(), f.enc_version || 1);
    var nf = VirtualFile.listByDir(userId, destDirId).find(function(x) { return x.name === f.name; });
    if (nf && sid > 0) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [sid, nf.id]);
    }
  });

  // 递归子目录
  var dirs = VirtualDir.listPersonalByParent(userId, srcDirId);
  dirs.forEach(function(d) {
    var newChildId = VirtualDir.create(userId, destDirId, d.name, false);
    if (newChildId) personalCopyDirRecursive(userId, d.id, newChildId);
  });
}

function propfindHandler(req, res) {
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (resolved.isPersonal) { personalPropfind(resolved, subPath, req, res); return; }

  var fullPath = resolved.fullPath;
  var baseUrl = '/webdav/' + token + (subPath ? '/' + subPath : '');
  // RFC 4918 9.1: 尊重 Depth 头
  var depth = (req.headers.depth || 'infinity').toString();

  if (!fs.existsSync(fullPath)) { res.status(404).end('Not found'); return; }

  var stat = fs.statSync(fullPath);
  var xml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n';

  if (stat.isDirectory()) {
    // 目录本身（附加可用空间信息）
    var ds = getDiskSpace(fullPath);
    xml += buildPropstat(baseUrl, stat, true, ds.free, ds.total - ds.free);
    // Depth "0" 只返回资源本身；Depth "1"/"infinity" 包含子内容
    if (depth !== '0') {
      var entries = fs.readdirSync(fullPath);
      for (var i = 0; i < entries.length; i++) {
      if (entries[i].endsWith('.delbak')) continue; // 跳过回收站标记文件
      var entryPath = path.join(fullPath, entries[i]);
      if (!fs.existsSync(entryPath)) continue;
      var entryStat = fs.statSync(entryPath);
        var href = baseUrl.replace(/\/$/, '') + '/' + encodeURIComponent(entries[i]);
        xml += buildPropstat(href, entryStat, entryStat.isDirectory(), ds.free, ds.total - ds.free);
      }
    }
  } else {
    xml += buildPropstat(baseUrl, stat, false);
  }

  xml += '</D:multistatus>\n';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(207).send(xml);
}

function buildPropstat(href, stat, isDir, quotaAvail, quotaUsed) {
  var x = '  <D:response>\n';
  x += '    <D:href>' + escXml(href) + '</D:href>\n';
  x += '    <D:propstat>\n      <D:prop>\n';
  if (isDir) {
    x += '        <D:resourcetype><D:collection/></D:resourcetype>\n';
  } else {
    x += '        <D:resourcetype/>\n';
    x += '        <D:getcontentlength>' + stat.size + '</D:getcontentlength>\n';
  }
  // 配额信息放在最前面，Windows Explorer 优先读取
  if (typeof quotaAvail === 'number') {
    x += '        <D:quota-available-bytes>' + quotaAvail + '</D:quota-available-bytes>\n';
    x += '        <D:quota-used-bytes>' + (quotaUsed || 0) + '</D:quota-used-bytes>\n';
    x += '        <D:quota-bytes>' + (quotaAvail + (quotaUsed || 0)) + '</D:quota-bytes>\n';
  }
  x += '        <D:displayname>' + escXml(path.basename(href)) + '</D:displayname>\n';
  x += '        <D:getlastmodified>' + stat.mtime.toISOString() + '</D:getlastmodified>\n';
  x += '        <D:creationdate>' + (stat.birthtime || stat.mtime).toISOString() + '</D:creationdate>\n';
  x += '        <D:getcontenttype>' + (isDir ? 'httpd/unix-directory' : (stat.mime || 'application/octet-stream')) + '</D:getcontenttype>\n';
  // Windows 原生 WebDAV 客户端需要的扩展属性
  x += '        <D:iscollection>' + (isDir ? '1' : '0') + '</D:iscollection>\n';
  x += '        <D:ishidden>0</D:ishidden>\n';
  x += '        <D:isreadonly>0</D:isreadonly>\n';
  x += '        <D:isroot>0</D:isroot>\n';
  x += '        <D:getetag>"' + Math.random().toString(36).substring(2, 10) + '"</D:getetag>\n';
  var mtime = stat.mtime instanceof Date ? stat.mtime : new Date();
  x += '        <Z:Win32FileAttributes>' + (isDir ? '00000010' : '00000020') + '</Z:Win32FileAttributes>\n';
  x += '        <Z:Win32CreationTime>' + mtime.toISOString() + '</Z:Win32CreationTime>\n';
  x += '        <Z:Win32LastAccessTime>' + mtime.toISOString() + '</Z:Win32LastAccessTime>\n';
  x += '        <Z:Win32LastModifiedTime>' + mtime.toISOString() + '</Z:Win32LastModifiedTime>\n';
  // 文件也需要 supportedlock，否则 Windows 可能不锁文件直接写入
  x += '        <D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>\n';
  // 空 lockdiscovery（文件未被锁定）
  x += '        <D:lockdiscovery/>\n';
  x += '      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n';
  x += '    </D:propstat>\n  </D:response>\n';
  return x;
}

function getDiskSpace(basePath) {
  try {
    // Node.js 18+ 支持 fs.statfsSync（返回实际磁盘空间）
    var st = require('fs').statfsSync(basePath);
    return { free: st.bsize * st.bfree, total: st.bsize * st.blocks };
  } catch(e) {
    // 降级：返回合理的默认值
    return { free: 100 * 1024 * 1024 * 1024, total: 120 * 1024 * 1024 * 1024 };
  }
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// GET - 下载文件（支持 Range 断点续传/流媒体播放）
router.get('/webdav/:token', getHandler);
router.get('/webdav/:token/*', getHandler);

// 判断是否为可内联显示的媒体类型
function isInlineMedia(mime) {
  return mime && (mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('image/') || mime === 'application/pdf');
}

function getHandler(req, res) {
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (req.method === 'LOCK') { handleLock(req, res, resolved); return; }
  if (req.method === 'UNLOCK') { res.status(204).end(); return; }
  if (resolved.isPersonal) { personalGetFile(resolved, subPath, req, res); return; }

  var fullPath = resolved.fullPath;
  if (!fs.existsSync(fullPath)) { res.status(404).end('Not found'); return; }
  var stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    propfindHandler(req, res);
    return;
  }

  var fileSize = stat.size;
  var mime = require('mime-types').lookup(fullPath) || 'application/octet-stream';
  var inline = isInlineMedia(mime);

  // 支持 Range 请求（断点续传/视频拖动）
  var range = req.headers.range;
  if (range) {
    var parts = range.replace(/bytes=/, '').split('-');
    var start = parseInt(parts[0], 10);
    var end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= fileSize) end = fileSize - 1;

    if (start >= fileSize) { res.status(416).setHeader('Content-Range', 'bytes */' + fileSize).end(); return; }

    var chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + fileSize);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    if (!inline) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(fullPath)) + '"');
    else res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(fullPath)) + '"');

    var rangeStream = fs.createReadStream(fullPath, { start: start, end: end });
    rangeStream.pipe(res);
  } else {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    if (!inline) res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(path.basename(fullPath)) + '"');
    else res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(path.basename(fullPath)) + '"');
    var readStream = fs.createReadStream(fullPath);
    readStream.pipe(res);
    // 记录下载日志和流量
    logWebDAV(req, resolved.link, 'download', path.basename(fullPath), stat.size, true);
    trackTraffic(req, resolved.link, stat.size);
  }
}

// PUT - 上传文件
// LOCK for resources（放在 PUT handler 之前，Express 会先匹配）
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method !== 'LOCK' && req.method !== 'UNLOCK') return next();
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (req.method === 'LOCK') { handleLock(req, res, resolved); return; }
  if (req.method === 'UNLOCK') { res.status(204).end(); return; }
});

router.put('/webdav/:token/*', function(req, res) {
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (resolved.isPersonal) {
    personalPutFile(resolved, subPath, res, req); return;
  }

  var fullPath = resolved.fullPath;
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    res.status(405).end('Cannot PUT to a directory');
    return;
  }

  var dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

  var totalBytes = 0;
  req.on('data', function(c) { totalBytes += c.length; });
  var ws = fs.createWriteStream(fullPath);
  req.pipe(ws);
  ws.on('finish', function() {
    var fileStat = fs.statSync(fullPath);
    var etag = '"' + fileStat.size.toString(16) + '-' + fileStat.mtime.getTime().toString(16) + '"';
    res.setHeader('ETag', etag);
    logWebDAV(req, resolved.link, 'upload', path.basename(fullPath), fileStat.size, true);
    res.status(201).end('Created');
  });
  ws.on('error', function(e) { if (!res.headersSent) res.status(500).end(e.message); });
  req.on('error', function(e) { if (!res.headersSent) res.status(500).end(e.message); });
});

// DELETE - 删除文件或目录
router.delete('/webdav/:token', deleteHandler);
router.delete('/webdav/:token/*', deleteHandler);

function deleteHandler(req, res) {
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (resolved.isPersonal) { personalDelete(resolved, subPath, res); return; }

  var fullPath = resolved.fullPath;
  if (!fs.existsSync(fullPath)) { res.status(404).end('Not found'); return; }

  if (fullPath === resolved.baseDir) {
    res.status(403).end('Cannot delete root of WebDAV share');
    return;
  }

  var stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true });
  } else {
    fs.unlinkSync(fullPath);
  }
  res.status(204).end();
}

// MKCOL - 创建目录
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method !== 'MKCOL') return next();
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  if (resolved.isPersonal) { personalMkcol(resolved, subPath, res); return; }

  var fullPath = resolved.fullPath;
  // RFC 4918 9.3.1: MKCOL on existing resource MUST return 405 Method Not Allowed
  if (fs.existsSync(fullPath)) { res.status(405).end('Collection already exists'); return; }

  // RFC 4918 9.3.1: 409 if intermediate collections don't exist
  var parentDir = path.dirname(fullPath);
  if (!fs.existsSync(parentDir)) { res.status(409).end('Intermediate collections missing'); return; }

  fs.mkdirSync(fullPath);
  res.status(201).end('Created');
});

// MOVE - 移动/重命名
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method !== 'MOVE') return next();
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;

  // 解析目标路径（必须在 isPersonal 分支之前，两边都需要）
  var destHeader = req.headers.destination || '';
  var destMatch = destHeader.match(/\/webdav\/[^/]+\/(.*)/);
  if (!destMatch) { res.status(400).end('Bad destination'); return; }

  if (resolved.isPersonal) { personalMove(resolved, subPath, destMatch[1], req, res); return; }
  var destPath = path.join(resolved.baseDir, decodeURIComponent(destMatch[1]));

  if (destPath.indexOf(resolved.baseDir) !== 0) { res.status(403).end('Forbidden'); return; }
  if (!fs.existsSync(resolved.fullPath)) { res.status(404).end('Not found'); return; }

  var destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  fs.renameSync(resolved.fullPath, destPath);
  res.status(201).end('Moved');
});

// PROPPATCH - RFC 4918 Section 9.2: 设置/删除属性
router.all('/webdav/:token', function(req, res, next) {
  if (req.method !== 'PROPPATCH') return next();
  handlePropPatch(req, res);
});
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method !== 'PROPPATCH') return next();
  handlePropPatch(req, res);
});

function handlePropPatch(req, res) {
  // 我们不持久化自定义属性，但返回合规的 multi-status 响应
  var xml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">\n';
  var href = '/webdav/' + req.params.token + (req.params[0] ? '/' + req.params[0] : '');
  xml += '  <D:response>\n    <D:href>' + escXml(href) + '</D:href>\n';
  xml += '    <D:propstat>\n      <D:prop/>\n';
  xml += '      <D:status>HTTP/1.1 200 OK</D:status>\n';
  xml += '    </D:propstat>\n  </D:response>\n';
  xml += '</D:multistatus>\n';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(207).send(xml);
}

// COPY - RFC 4918 Section 9.8: 复制资源到目标 URI
router.all('/webdav/:token', function(req, res, next) {
  if (req.method !== 'COPY') return next();
  handleCopy(req, res);
});
router.all('/webdav/:token/*', function(req, res, next) {
  if (req.method !== 'COPY') return next();
  handleCopy(req, res);
});

function handleCopy(req, res) {
  var token = req.params.token;
  var subPath = req.params[0] || '';
  var destHeader = req.headers.destination || '';
  // 解析目标 URL 中的 token 和路径
  var destMatch = destHeader.match(/\/webdav\/([^/]+)\/?(.*)/);
  if (!destMatch) { res.status(400).end('Bad destination'); return; }
  var destToken = destMatch[1];
  var destSubPath = decodeURIComponent(destMatch[2] || '');

  if (destToken !== token) { res.status(502).end('Cross-token copy not supported'); return; }

  var resolved = resolveWebDAV(token, subPath, req, res);
  if (!resolved) return;
  // 目标路径直接构建（可能尚不存在）
  var baseDir = resolved.baseDir;
  var fullPath = resolved.fullPath;
  var destPath = destSubPath ? path.join(baseDir, destSubPath) : baseDir;
  // 安全检查
  if (destPath.indexOf(baseDir) !== 0) { res.status(403).end('Forbidden'); return; }

  if (resolved.isPersonal) { personalCopy(resolved, subPath, destSubPath, req, res); return; }

  // 公共文件 COPY
  if (!fs.existsSync(fullPath)) { res.status(404).end('Not found'); return; }
  var srcStat = fs.statSync(fullPath);
  var overwrite = req.headers.overwrite !== 'F';
  if (fs.existsSync(destPath) && !overwrite) { res.status(412).end('Destination exists'); return; }

  var depth = req.headers.depth || 'infinity';
  if (srcStat.isDirectory() && depth === '0') {
    // 只复制目录本身（创建空目录）
    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath);
    res.status(201).end('Created');
    return;
  }

  try {
    copyRecursive(fullPath, destPath);
    res.status(fs.existsSync(destPath + (destPath.endsWith('/') ? '' : '')) ? 204 : 201).end('Copied');
  } catch(e) {
    res.status(507).end('Copy failed: ' + e.message);
  }
}

function copyRecursive(src, dest) {
  var stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    var entries = fs.readdirSync(src);
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].endsWith('.delbak')) continue;
      copyRecursive(path.join(src, entries[i]), path.join(dest, entries[i]));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// ==================== WebDAV Link 管理 API ====================
var requireAuth = require('./auth').requireAuth || function(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ code: 401, message: '请先登录' });
  var User = require('../lib/db').User;
  req.user = User.findById(req.session.userId);
  if (!req.user) return res.status(401).json({ code: 401, message: '请先登录' });
  next();
};

// GET /api/webdav/links - 获取我的 WebDAV 链接列表
router.get('/api/webdav/links', requireAuth, function(req, res) {
  var WebDAVLink = require('../lib/db').WebDAVLink;
  var links = WebDAVLink.listByUser(req.user.id);
  var result = links.map(function(l) {
    return {
      id: l.id,
      token: l.token,
      // 安全：只对未查看过的链接返回完整 token
      display_token: l.is_revealed ? l.token.substring(0, 8) + '••••••••••••••••' + l.token.substring(24) : l.token,
      target_path: l.target_path,
      target_name: l.target_name,
      is_directory: !!l.is_directory,
      is_revealed: !!l.is_revealed,
      require_auth: !!l.require_auth,
      target_type: l.target_type || 'public',
      url: '/webdav/' + l.token,
      expires_at: l.expires_at,
      created_at: l.created_at,
      last_accessed: l.last_accessed,
      access_count: l.access_count,
      is_expired: WebDAVLink.checkExpired(l)
    };
  });
  res.json({ code: 0, data: result });
});

// POST /api/webdav/links - 创建 WebDAV 链接
router.post('/api/webdav/links', requireAuth, function(req, res) {
  var WebDAVLink = require('../lib/db').WebDAVLink;
  var targetPath = String(req.body.target_path || '').trim();
  var targetName = String(req.body.target_name || '').trim();
  var isDirectory = req.body.is_directory ? true : false;
  var requireAuth = req.body.require_auth ? true : false;
  var targetType = req.body.target_type || 'public';
  var expiresDays = parseInt(req.body.expires_days, 10) || 180;
  if (expiresDays > 365) expiresDays = 365;
  if (expiresDays < 1) expiresDays = 1;

  if (!targetPath) return res.json({ code: 1, message: '请指定目标路径' });
  if (targetPath.includes('..')) return res.json({ code: 1, message: '路径包含非法字符' });

  if (targetType === 'personal') {
    var VirtualDir = require('../lib/db').VirtualDir;
    var dirId = parseInt(targetPath, 10) || 0;
    var dir = dirId > 0 ? VirtualDir.findById(dirId) : null;
    if (dirId > 0 && (!dir || dir.user_id !== req.user.id)) {
      return res.json({ code: 1, message: '目录不存在或无权访问' });
    }
  } else {
    var Storage = require('../lib/db').Storage;
    var fullPath = path.join(Storage.PUBLIC_DIR, targetPath);
    if (!fs.existsSync(fullPath)) return res.json({ code: 1, message: '目标路径不存在' });
    var stat = fs.statSync(fullPath);
    isDirectory = isDirectory || stat.isDirectory();
  }

  var result = WebDAVLink.create(req.user.id, targetPath, targetName, isDirectory, expiresDays, requireAuth, targetType);

  res.json({
    code: 0, message: '创建成功',
    data: {
      token: result.token,
      url: '/webdav/' + result.token,
      expires_at: result.expires_at,
      require_auth: result.require_auth,
      target_path: targetPath,
      target_name: targetName
    }
  });
});

// POST /api/webdav/links/:token/reveal - 标记为已查看（隐藏 token）
router.post('/api/webdav/links/:token/reveal', requireAuth, function(req, res) {
  var WebDAVLink = require('../lib/db').WebDAVLink;
  var link = WebDAVLink.findByUserAndToken(req.user.id, req.params.token);
  if (!link) return res.json({ code: 1, message: '链接不存在' });
  WebDAVLink.reveal(link.id);
  res.json({ code: 0, message: '已标记为已查看' });
});

// DELETE /api/webdav/links/:token - 删除 WebDAV 链接
router.delete('/api/webdav/links/:token', requireAuth, function(req, res) {
  var WebDAVLink = require('../lib/db').WebDAVLink;
  var link = WebDAVLink.findByUserAndToken(req.user.id, req.params.token);
  if (!link) return res.json({ code: 1, message: '链接不存在' });
  WebDAVLink.delete(link.id, req.user.id);
  res.json({ code: 0, message: '已删除' });
});

// 导出 requireAuth 供 server.js 使用
router._requireAuth = requireAuth;

module.exports = router;
