var log = require('../lib/log');
﻿const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const mime = require('mime-types');
const { Share, VirtualDir, VirtualFile, Storage, query, get, run, ShareStats, ShareAccessLog, TrafficLog, TrafficQuota } = require('../lib/db');
const { createV1DecryptStream, createDecryptStream, getV1FileInfo } = require('../lib/crypto');
// 安全导入（兼容未更新的 lib/utils.js）
var _su = {};
try { _su = require('../lib/utils'); } catch(e) {}
var getClientIp = _su.getClientIp || function(req) {
  var ip = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
};
var formatFileSize = _su.formatFileSize || function(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  var units = ['B','KB','MB','GB','TB'];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i >= units.length) i = units.length - 1;
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 2 : 0) + ' ' + units[i];
};
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// 尝试加载流量缓冲
var TrafficBuffer = null;
try { TrafficBuffer = require('../lib/redis').TrafficBuffer; } catch (e) {}

function logTraffic(userId, guestIp, actionType, fileId, fileName, fileSize, bytesCount) {
  if (bytesCount <= 0) return;

  var record = { user_id: userId || 0, guest_ip: guestIp || '', action_type: actionType, file_id: fileId || 0, file_name: fileName || '', file_size: fileSize || 0, bytes_count: bytesCount || 0 };

  if (TrafficBuffer) {
    TrafficBuffer.add(record);
  } else {
    try {
      TrafficLog.log(record.user_id, record.guest_ip, record.action_type, record.file_id, record.file_name, record.file_size, record.bytes_count);
      // 更新配额
      if (userId > 0) {
        TrafficQuota.addUsed(userId, '', false, bytesCount);
      } else if (guestIp) {
        TrafficQuota.addUsed(0, guestIp, true, bytesCount);
      }
    } catch (e) {}
  }
}
const logger = require('../lib/logger');
const QRCode = require('qrcode');

// ==================== 辅助函数 ====================
function getRemainingMs(expiresAt) {
  if (!expiresAt) return -1; // -1 表示永久
  var diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 ? diff : 0;
}

function formatRemainingTime(expiresAt) {
  if (!expiresAt) return '永久有效';
  var ms = getRemainingMs(expiresAt);
  if (ms <= 0) return '已过期';
  var seconds = Math.floor(ms / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);
  if (days > 0) return days + '天' + (hours % 24) + '小时';
  if (hours > 0) return hours + '小时' + (minutes % 60) + '分钟';
  if (minutes > 0) return minutes + '分钟';
  return '不到1分钟';
}

// ==================== 需要登录的中间件 ====================
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.json({ code: 401, message: '请先登录', data: null });
  }
  var User = require('../lib/db').User;
  var user = User.findById(req.session.userId);
  if (!user) { req.session.destroy(function() {}); return res.json({ code: 401, message: '请先登录', data: null }); }
  if (!user.is_active) { req.session.destroy(function() {}); return res.json({ code: 403, message: '账号已被禁用', data: null }); }
  req.user = user;
  next();
}

// ==================== API: 创建分享 ====================
// POST /api/share
// body: { target_type: 'file'|'dir'|'mixed', target_id: number, target_ids: [id1,id2], expires_days: number(0=永久), password: bool }
// target_type=mixed 表示批量分享多个文件/文件夹
router.post('/share', requireAuth, function(req, res) {
  var user = req.user;
  var targetType = req.body.target_type;
  var targetId = parseInt(req.body.target_id, 10);
  var targetIds = req.body.target_ids; // array, for batch
  var expiresDays = parseInt(req.body.expires_days, 10) || 7;
  var needPassword = !!req.body.password;

  if (!targetType) return res.json({ code: 1, message: '参数错误', data: null });

  var targetName = '';
  var finalTargetIds = [];

  // 下载次数限制：默认10次，普通用户最多30次，管理员不限制(0)
  var maxDownloads = parseInt(req.body.max_downloads, 10) || 0;
  if (!user.is_admin) {
    if (maxDownloads <= 0 || maxDownloads > 30) maxDownloads = 10;
  }

  // 公共文件分享（管理员无限制，普通用户最多1天有效期）
  if (targetType === 'public') {
    // 普通用户限制：公共文件分享最多1天
    if (!user.is_admin && expiresDays > 1) {
      expiresDays = 1;
    }
    var publicPath = (req.body.target_path || '').trim();
    if (!publicPath) return res.json({ code: 1, message: '请指定公共文件路径', data: null });
    // 安全检查：防止路径遍历
    if (publicPath.includes('..')) return res.json({ code: 1, message: '路径包含非法字符', data: null });
    var publicFullPath = path.join(Storage.PUBLIC_DIR, publicPath);
    if (!fs.existsSync(publicFullPath)) return res.json({ code: 1, message: '文件不存在', data: null });
    var pubStat = fs.statSync(publicFullPath);
    if (pubStat.isDirectory()) {
      targetName = path.basename(publicPath) || publicPath;
    } else {
      targetName = path.basename(publicPath);
    }
    finalTargetIds = [publicPath]; // 存路径而非 ID
  } else if (targetType === 'file' || targetType === 'dir') {
    if (!targetId) return res.json({ code: 1, message: '参数错误', data: null });
    if (targetType === 'file') {
      var file = get('SELECT * FROM virtual_files WHERE id = ? AND user_id = ?', [targetId, user.id]);
      if (!file) return res.json({ code: 1, message: '文件不存在', data: null });
      targetName = file.name;
    } else {
      var dir = get('SELECT * FROM virtual_dirs WHERE id = ? AND user_id = ?', [targetId, user.id]);
      if (!dir) return res.json({ code: 1, message: '目录不存在', data: null });
      targetName = dir.name;
    }
    finalTargetIds = [targetId];
  } else if (targetType === 'mixed') {
    // 批量分享
    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return res.json({ code: 1, message: '请选择要分享的文件', data: null });
    }
    if (targetIds.length === 1) {
      // 只有一个时退化为普通分享
      var singleFile = get('SELECT * FROM virtual_files WHERE id = ? AND user_id = ?', [targetIds[0], user.id]);
      if (singleFile) { targetType = 'file'; targetId = targetIds[0]; targetName = singleFile.name; }
      else {
        var singleDir = get('SELECT * FROM virtual_dirs WHERE id = ? AND user_id = ?', [targetIds[0], user.id]);
        if (singleDir) { targetType = 'dir'; targetId = targetIds[0]; targetName = singleDir.name; }
        else return res.json({ code: 1, message: '文件不存在', data: null });
      }
      finalTargetIds = [targetId];
    } else {
      // 多个目标
      targetName = targetIds.length + ' 个文件';
      finalTargetIds = targetIds;
    }
  } else {
    return res.json({ code: 1, message: '目标类型错误', data: null });
  }

  var share = Share.create(user.id, targetType, targetId || 0, targetName, expiresDays, needPassword ? '1' : null, finalTargetIds, maxDownloads);

  logger.logShare(req, 'share_create', targetType, targetName, targetId || 0);

  res.json({
    code: 0,
    message: '分享创建成功',
    data: {
      id: share.id,
      hash: share.hash,
      extraction_code: share.extraction_code,
      expires_at: share.expires_at,
      max_downloads: share.max_downloads,
      target_type: targetType,
      target_name: targetName,
      owner: req.user.nickname || req.user.email || '未知用户',
      url: '/share/' + share.hash + (share.extraction_code ? '?extraction_code=' + share.extraction_code : '')
    }
  });
});

// ==================== API: 获取我的分享列表 ====================
// GET /api/share
router.get('/share', requireAuth, function(req, res) {
  var user = req.user;
  var shares = Share.list(user.id);

    var result = shares.map(function(s) {
    var validity = Share.checkValidity(s);
    var info = Share.getPublicInfo(s);
    var targetIds = [];
    try { targetIds = JSON.parse(s.target_ids || '[]'); } catch(e) {}
    // target_scope 和 display_path：用于前端区分公共/个人分享
    var targetScope = 'personal';
    var displayPath = s.target_name;
    if (s.target_type === 'public') {
      targetScope = 'public';
      // 公共目录：完整路径在 target_ids[0] 中，target_path 列未使用
      var rawPath = (targetIds.length > 0 ? targetIds[0] : '') || s.target_name;
      displayPath = (rawPath && rawPath[0] !== '/') ? '/' + rawPath : rawPath;
    } else if (s.target_type === 'dir') {
      targetScope = 'personal';
      // 构建个人目录的完整路径：从根到该目录
      displayPath = buildPersonalPath(s.target_id, 0, s.user_id) || s.target_name;
    } else if (s.target_type === 'file') {
      targetScope = 'personal';
      // 构建个人文件的完整路径：目录路径 + 文件名
      var fileInfo = getFileInfo(s.target_id, s.user_id);
      if (fileInfo) {
        displayPath = (buildPersonalPath(fileInfo.dir_id, 0, s.user_id) || '') + '/' + fileInfo.name;
      }
    }
    return {
      id: s.id,
      hash: s.share_hash,
      target_type: s.target_type,
      target_name: s.target_name,
      target_scope: targetScope,
      display_path: displayPath,
      owner: s.owner || '',
      has_password: s.hasOwnProperty('extraction_code') && !!s.extraction_code,
      has_password_bool: !!s.extraction_code,
      extraction_code: s.extraction_code || '',
      target_ids: targetIds,
      is_mixed: targetIds.length > 1,
      is_expired: info.is_expired,
      invalid_reason: info.invalid_reason,
      item_count: info.item_count,
      created_at: s.created_at,
      expires_at: s.expires_at,
      remaining_text: formatRemainingTime(s.expires_at),
      remaining_ms: getRemainingMs(s.expires_at),
      download_count: s.download_count || 0,
      max_downloads: s.max_downloads || 0,
      is_directory: s.target_type === 'public' ? info.is_directory : (s.target_type === 'dir'),
      url: '/share/' + s.share_hash + (s.extraction_code ? '?extraction_code=' + s.extraction_code : '')
    };
  });

  res.json({ code: 0, message: '', data: result });
});

// ==================== API: 删除分享 ====================
// DELETE /api/share/:id
router.delete('/share/:id', requireAuth, function(req, res) {
  var user = req.user;
  var shareId = parseInt(req.params.id, 10);

  var ok = Share.delete(shareId, user.id);
  if (!ok) return res.json({ code: 1, message: '分享不存在或无权限', data: null });

  logger.logShare(req, 'share_delete', 'share', '', shareId);
  res.json({ code: 0, message: '分享已删除', data: null });
});

// ==================== API: 获取分享访问日志 ====================
// GET /api/share/:id/logs
router.get('/share/:id/logs', requireAuth, function(req, res) {
  var user = req.user;
  var shareId = parseInt(req.params.id, 10);
  var page = Math.max(1, parseInt(req.query.page, 10) || 1);
  var limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

  // 验证分享属于当前用户
  var share = Share.get(shareId);
  if (!share || share.user_id !== user.id) {
    return res.json({ code: 1, message: '分享不存在或无权限', data: null });
  }

  var result = ShareAccessLog.listByShare(shareId, page, limit);
  res.json({ code: 0, data: { total: result.total, page: page, limit: limit, logs: result.logs } });
});

// ==================== API: 公开获取分享信息（验证前） ====================
// GET /api/share/public/:hash
// 无需登录，公开接口
router.get('/share/public/:hash', function(req, res) {
  var hash = req.params.hash;
  var share = Share.getByHash(hash);

  if (!share) {
    return res.json({ code: 1, message: '分享不存在', data: null });
  }

  var info = Share.getPublicInfo(share);
  var remaining = getRemainingMs(share.expires_at);
  var isValid = remaining === -1 || remaining > 0;

  // 记录查看统计
  try { ShareStats.incrementView(share.id); } catch(e) {}
  try {
    var clientIp = (req.ip || '').replace(/^::ffff:/, '') || '';
    ShareAccessLog.log(share.id, 'view', clientIp, 0, '访客', 0, '');
  } catch(e) {}

  res.json({
    code: 0,
    message: '',
    data: {
      hash: info.hash,
      target_type: info.target_type,
      target_name: info.target_name,
      has_password: info.has_password,
      is_valid: isValid,
      invalid_reason: !isValid ? (remaining === 0 ? 'expired' : 'unknown') : null,
      item_count: info.item_count,
      created_at: info.created_at,
      expires_at: info.expires_at,
      remaining_text: formatRemainingTime(info.expires_at)
    }
  });
});

// ==================== API: 验证提取码 ====================
// POST /api/share/verify/:hash
router.post('/share/verify/:hash', function(req, res) {
  var hash = req.params.hash;
  var code = req.body.extraction_code || '';

  var result = Share.verifyCode(hash, code);

  if (!result.valid) {
    var msg = '提取码错误';
    if (result.reason === 'share_not_found') msg = '分享不存在';
    else if (result.reason === 'share_expired') msg = '分享已过期';
    return res.json({ code: 1, message: msg, data: null });
  }

  var info = Share.getPublicInfo(result.share);
  res.json({
    code: 0,
    message: '验证成功',
    data: {
      hash: info.hash,
      target_type: info.target_type,
      target_name: info.target_name,
      item_count: info.item_count,
      created_at: info.created_at,
      expires_at: info.expires_at
    }
  });
});

// ==================== API: 获取当前登录用户（通过 session cookie）====================
router.get('/share/me', function(req, res) {
  if (req.session && req.session.userId) {
    var user = require('../lib/db').User.findById(req.session.userId);
    if (user) {
      return res.json({
        code: 0,
        data: {
          user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            is_admin: user.is_admin
          }
        }
      });
    }
  }
  res.json({ code: 1, message: '未登录', data: null });
});

// ==================== API: 获取分享内容（验证后） ====================
// GET /api/share/content/:hash
// 可选参数 ?sub_dir=xxx（浏览子目录）, ?extraction_code=xxx（提取码）
router.get('/share/content/:hash', function(req, res) {
  var hash = req.params.hash;
  var subDirId = req.query.sub_dir;
  var extractionCode = req.query.extraction_code || '';
  log.info('[share content] hash=' + hash + ', subDirId=' + subDirId + ', extractionCode=' + extractionCode);
  var share = Share.getByHash(hash);

  if (!share) {
    return res.json({ code: 1, message: '分享不存在', data: null });
  }

  var validity = Share.checkValidity(share);
  if (!validity.valid) {
    return res.json({ code: 1, message: validity.reason === 'expired' ? '分享已过期' : '分享目标已删除', data: null });
  }

  var remaining = getRemainingMs(share.expires_at);
  if (remaining !== -1 && remaining <= 0) {
    return res.json({ code: 1, message: '分享已过期', data: null });
  }

  var items;
  var parentDir = null;
  if (share.target_type === 'public') {
    // 公共文件分享：从文件系统读取，合并为统一格式
    var pubResult = getPublicShareItems(share, subDirId);
    items = (pubResult.dirs || []).concat(pubResult.files || []);
    parentDir = pubResult._parentDir;
  } else {
    items = Share.getShareItems(share, subDirId);
    if (items._parentDir) {
      parentDir = items._parentDir;
      delete items._parentDir;
    }
  }
  var owner = require('../lib/db').User.findById(share.user_id);

  // 提取父目录信息
  var parentDir = null;
  if (items._parentDir) {
    parentDir = items._parentDir;
    delete items._parentDir;
  }

  // 记录浏览统计
  try { ShareStats.incrementView(share.id); } catch(e) {}
  try {
    var clientIp = (req.ip || '').replace(/^::ffff:/, '') || '';
    var userId = req.session && req.session.userId ? req.session.userId : 0;
    var userEmail = '';
    if (userId) {
      var u = require('../lib/db').User.findById(userId);
      if (u) userEmail = u.email;
    }
    ShareAccessLog.log(share.id, 'browse', clientIp, userId, userEmail, 0, '');
  } catch(e) {}

  res.json({
    code: 0,
    message: '',
    data: {
      share_id: share.id,
      hash: share.share_hash,
      target_type: share.target_type,
      target_name: share.target_name,
      owner: owner ? owner.nickname || owner.email : '未知',
      owner_id: share.user_id,
      created_at: share.created_at,
      expires_at: share.expires_at,
      remaining_text: formatRemainingTime(share.expires_at),
      current_dir_id: subDirId || null,
      parent_dir: parentDir,
      download_count: share.download_count || 0,
      max_downloads: share.max_downloads || 0,
      is_directory: share.target_type === 'public' ? _isPublicShareDir(share) : (share.target_type === 'dir'),
      items: items
    }
  });
});

// 检查公共分享目标是否为目录
function _isPublicShareDir(share) {
  try {
    var sharePath = share.target_ids ? JSON.parse(share.target_ids || '[]')[0] || share.target_name : share.target_name;
    var fullPath = path.join(Storage.PUBLIC_DIR, sharePath);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
  } catch(e) { return false; }
}

// ==================== 辅助函数：检查文件是否在分享范围内 ====================
function _isFileInShareTree(file, share) {
  // 单文件/批量分享：文件ID在 target_ids 中即为合法
  if (share.target_type === 'file') {
    return parseInt(file.id) === parseInt(share.target_id);
  }
  if (share.target_type === 'mixed') {
    var ids = [];
    try { ids = JSON.parse(share.target_ids || '[]'); } catch(e) {}
    // 批量分享中每个目标都是根节点，其下文件都属分享范围
    for (var i = 0; i < ids.length; i++) {
      if (parseInt(file.id) === ids[i]) return true;
      // 如果是目录，递归检查子文件
      if (_isDirInTree(ids[i], parseInt(file.dir_id))) return true;
    }
    return false;
  }
  // 目录分享：从分享根目录向下遍历所有子目录
  return _isDirInTree(parseInt(share.target_id), parseInt(file.dir_id));
}

// 递归检查子目录是否包含 targetDirId
function _isDirInTree(rootDirId, targetDirId) {
  if (rootDirId === targetDirId) return true;
  var subDirs = query('SELECT id FROM virtual_dirs WHERE parent_id = ?', [rootDirId]);
  for (var i = 0; i < subDirs.length; i++) {
    if (_isDirInTree(subDirs[i].id, targetDirId)) return true;
  }
  return false;
}

// 获取公共文件分享的内容列表
function getPublicShareItems(share, subDir) {
  var publicRoot = Storage.PUBLIC_DIR;
  var sharePath = share.target_ids ? (function() {
    try { var ids = JSON.parse(share.target_ids); return ids[0] || share.target_name; } catch(e) { return share.target_name; }
  })() : share.target_name;

  var basePath = path.join(publicRoot, sharePath);
  // subDir 是相对于分享根目录的子路径，如果 subDir 以 sharePath 开头则去掉重复前缀
  var subPath = subDir || '';
  if (subPath.indexOf(sharePath) === 0) {
    subPath = subPath.substring(sharePath.length).replace(/^\//, '');
  }
  var currentPath = subPath ? path.join(basePath, subPath) : basePath;

  // 安全检查
  if (currentPath.indexOf(publicRoot) !== 0) return { dirs: [], files: [] };

  var result = { dirs: [], files: [], _parentDir: null };

  try {
    var stat = fs.statSync(currentPath);
    // 单文件分享：直接返回文件信息
    if (stat.isFile()) {
      result.files.push({
        id: sharePath.replace(/\//g, '%2F'),
        name: path.basename(sharePath),
        path: sharePath,
        size: stat.size,
        mimeType: mime.lookup(sharePath) || 'application/octet-stream',
        isDirectory: false,
        isPublicFile: true
      });
      return result;
    }
    // 目录分享：列出目录内容
    var entries = fs.readdirSync(currentPath);
    for (var i = 0; i < entries.length; i++) {
      var fullPath = path.join(currentPath, entries[i]);
      var entryStat = fs.statSync(fullPath);
      var relPath = path.relative(publicRoot, fullPath).replace(/\\/g, '/');
      if (entryStat.isDirectory()) {
        // 使用完整相对路径作为 id（getDownloadUrl 会直接拼接到 URL path 中，需要编码 / 为 %2F）
        var encPath = relPath.replace(/\//g, '%2F');
        result.dirs.push({ id: encPath, name: entries[i], path: relPath, isDirectory: true });
      } else {
        result.files.push({
          id: relPath.replace(/\//g, '%2F'),
          name: entries[i],
          path: relPath,
          size: entryStat.size,
          mimeType: mime.lookup(entries[i]) || 'application/octet-stream',
          isDirectory: false,
          isPublicFile: true
        });
      }
    }
  } catch(e) {
    log.error('[share] 读取公共目录失败:', e.message);
  }

  // 父目录信息
  if (subDir) {
    var parentPath = path.dirname(subDir);
    if (parentPath === '.') parentPath = '';
    result._parentDir = { id: parentPath, name: parentPath ? path.basename(parentPath) : share.target_name };
  }

  return result;
}

// ==================== API: 转存分享文件到个人目录（需登录） ====================
// POST /api/share/save/:hash
// 个人文件分享: 创建引用（ref_count + 1），不复制文件数据
// 公共文件分享: 独立复制（下载后重新上传到个人目录）
router.post('/share/save/:hash', requireAuth, function(req, res) {
  var user = req.user;
  var hash = req.params.hash;
  var dirId = parseInt(req.body.dir_id || '0', 10);
  var extractionCode = req.body.extraction_code || '';

  // 校验目标目录存在
  if (dirId !== 0) {
    var targetDir = require('../lib/db').VirtualDir.findById(dirId);
    if (!targetDir || targetDir.user_id !== user.id) {
      return res.json({ code: 1, message: '目标目录不存在或已被删除，请重新选择', data: null });
    }
  }

  var share = Share.getByHash(hash);
  if (!share) return res.json({ code: 1, message: '分享不存在或已过期', data: null });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return res.json({ code: 1, message: '分享已过期', data: null });
  }

  // 验证提取码
  if (share.extraction_code) {
    var verifyResult = Share.verifyCode(hash, extractionCode);
    if (!verifyResult.valid) {
      return res.json({ code: 1, message: verifyResult.reason === 'wrong_code' ? '提取码错误' : '验证失败', data: null });
    }
  }

  // 检查下载次数限制
  if (share.max_downloads > 0 && share.download_count >= share.max_downloads) {
    return res.json({ code: 1, message: '已达到最大下载次数', data: null });
  }

  // 不能转存自己的分享
  if (share.user_id === user.id) {
    return res.json({ code: 1, message: '不能转存自己的分享', data: null });
  }

  var VirtualFile = require('../lib/db').VirtualFile;
  var User = require('../lib/db').User;
  var FileStorage = require('../lib/db').FileStorage;
  var UserFileRef = require('../lib/db').UserFileRef;

  // 支持指定文件 ID（批量转存）；为空则转存分享中的第一个文件
  var fileIds = [];
  try {
    var rawIds = req.body.file_ids || req.body.fileIds || [];
    if (Array.isArray(rawIds)) fileIds = rawIds.map(function(id) { return parseInt(id, 10) || 0; }).filter(Boolean);
    else if (typeof rawIds === 'string') fileIds = rawIds.split(',').map(function(id) { return parseInt(id.trim(), 10) || 0; }).filter(Boolean);
  } catch(e) { fileIds = []; }

  var targetType = (share.target_type || '').toLowerCase();

  if (targetType === 'public') {
    // ===== 公共文件转存：独立复制 =====
    var sharePath = share.target_name;
    var targetIds = [];
    try { targetIds = JSON.parse(share.target_ids || '[]'); } catch(e) {}
    if (targetIds.length === 10) sharePath = targetIds[0] || share.target_name;

    var Storage = require('../lib/db').Storage;
    var srcPath = require('path').join(Storage.PUBLIC_DIR, sharePath);
    var fs = require('fs');
    if (!fs.existsSync(srcPath)) {
      return res.json({ code: 1, message: '源文件不存在', data: null });
    }

    var stat = fs.statSync(srcPath);
    var fileName = require('path').basename(sharePath);

    // 检查配额
    if (user.used_bytes + stat.size > user.quota_bytes) {
      return res.json({ code: 1, message: '存储空间不足，无法转存', data: null });
    }

    // 上传到个人目录（完整复制）
    // 读取文件 → 加密 → 写入个人存储
    var fileBuffer = fs.readFileSync(srcPath);
    var crypto = require('crypto');
    var fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    var fileUuid = crypto.randomUUID();
    var cryptoLib = require('../lib/crypto');
    var storagePath = Storage.getFilePath(user.id, fileUuid);
    var encResult = cryptoLib.createV1EncryptStreamSync(storagePath, fileBuffer);
    if (!encResult.ok) {
      return res.json({ code: 1, message: '文件加密失败', data: null });
    }

    // 创建 file_storage
    var storageId = FileStorage.create(fileUuid, fileHash, stat.size, stat.size, 1, true, encResult.nonce);
    var StoragePool = require('../lib/db').StoragePool;
    var defaultPool = StoragePool.getDefaultPath();
    // 找到默认池的ID
    var poolInfo = require('../lib/db').get("SELECT id FROM storage_pools WHERE local_path = ? AND status = 'active' LIMIT 1", [defaultPool]);
    var poolId = poolInfo ? poolInfo.id : 1;
    var relPath = require('path').relative(defaultPool, storagePath).replace(/\\/g, '/');
    FileStorage.addPath(storageId, poolId, relPath, storagePath.replace(/\\/g, '/'));

    // 创建用户引用
    UserFileRef.create(user.id, storageId, dirId, fileName, require('mime-types').lookup(fileName) || 'application/octet-stream');

    var vfId = VirtualFile.createWithEncVersion(
      user.id, dirId, fileName, stat.size,
      require('mime-types').lookup(fileName) || 'application/octet-stream',
      storagePath, fileUuid, 1
    );
    if (vfId) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, vfId]);
    }

    User.updateUsedBytes(user.id, stat.size);
    ShareStats.incrementDownload(share.id);

    log.info('[ShareSave] 公共文件转存: ' + fileName + ' user=' + user.id);
    return res.json({
      code: 0, message: '转存成功', data: { id: vfId, name: fileName, size: stat.size, is_copy: true }
    });
  }

  // ===== 个人文件转存：引用计数 =====
  var targetIds = [];
  try { targetIds = JSON.parse(share.target_ids || '[]'); } catch(e) {}
  var firstFileId = targetIds.length > 0 ? parseInt(targetIds[0], 10) : (parseInt(share.target_id, 10) || 0);
  if (!firstFileId) {
    return res.json({ code: 1, message: '分享数据异常', data: null });
  }

  var file = VirtualFile.findById(firstFileId);
  if (!file) return res.json({ code: 1, message: '源文件不存在', data: null });

  // 检查配额
  if (user.used_bytes + file.size > user.quota_bytes) {
    return res.json({ code: 1, message: '存储空间不足，无法转存', data: null });
  }

  // 查找到底层的 file_storage 记录
  var storageId = file.storage_id || 0;
  var fsEntry = null;
  if (storageId > 0) {
    fsEntry = FileStorage.findById(storageId);
  }

  if (fsEntry) {
    // V2 路径：使用引用计数
    if (!FileStorage.hasValidPath(storageId)) {
      return res.json({ code: 1, message: '源文件已损坏，无法转存', data: null });
    }

    // 检查用户是否已经转存过
    var existingRef = UserFileRef.findByUserAndFile(user.id, storageId);
    if (existingRef) {
      return res.json({ code: 1, message: '你已经转存过该文件', data: null });
    }

    // 创建引用
    UserFileRef.create(user.id, storageId, dirId, file.name, file.mime_type);
    FileStorage.incrementRef(storageId);

    var vfId2 = VirtualFile.createWithEncVersion(
      user.id, dirId, file.name, file.size, file.mime_type,
      '', '', file.enc_version || 1
    );
    if (vfId2) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, vfId2]);
    }

    User.updateUsedBytes(user.id, file.size);
    ShareStats.incrementDownload(share.id);

    log.info('[ShareSave] 个人文件引用转存: ' + file.name + ' storage_id=' + storageId + ' user=' + user.id);
    return res.json({
      code: 0, message: '转存成功（引用）', data: { id: vfId2, name: file.name, size: file.size, is_reference: true, storage_id: storageId }
    });
  }

  // V1 路径（旧文件，未迁移）：降级为独立复制
  var sourcePath = file.storage_path;
  var fs2 = require('fs');
  if (!fs2.existsSync(sourcePath)) {
    return res.json({ code: 1, message: '源文件不可访问', data: null });
  }

  // 读取旧文件 → 计算哈希 → 重新加密 → 创建新引用
  var fileBufOld = fs2.readFileSync(sourcePath);
  var cryptoLib2 = require('../lib/crypto');
  var decResult = cryptoLib2.createDecryptStream(fileBufOld, file.nonce);
  var plainBuf = decResult.plaintext;
  var fileHashOld = crypto.createHash('sha256').update(plainBuf).digest('hex');

  // 检查是否已有相同哈希的文件
  var existingFS = FileStorage.findByHashAndSize(fileHashOld, plainBuf.length);
  if (existingFS && FileStorage.hasValidPath(existingFS.id)) {
    // 引用已有文件
    UserFileRef.create(user.id, existingFS.id, dirId, file.name, file.mime_type);
    FileStorage.incrementRef(existingFS.id);

    var vfId3 = VirtualFile.createWithEncVersion(
      user.id, dirId, file.name, file.size, file.mime_type, '', '', 1
    );
    if (vfId3) {
      require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [existingFS.id, vfId3]);
    }

    User.updateUsedBytes(user.id, file.size);
    ShareStats.incrementDownload(share.id);

    log.info('[ShareSave] V1→V2 引用转存: ' + file.name + ' found existing storage_id=' + existingFS.id);
    return res.json({
      code: 0, message: '转存成功（引用）', data: { id: vfId3, name: file.name, size: file.size, is_reference: true, storage_id: existingFS.id }
    });
  }

  // 全新加密存储
  var newUuid = crypto.randomUUID();
  var Storage3 = require('../lib/db').Storage;
  var newPath = Storage3.getFilePath(user.id, newUuid);
  var encResult2 = cryptoLib2.createV1EncryptStreamSync(newPath, plainBuf);
  if (!encResult2.ok) {
    return res.json({ code: 1, message: '文件加密失败', data: null });
  }

  var newStorageId = FileStorage.create(newUuid, fileHashOld, plainBuf.length, plainBuf.length, 1, true, encResult2.nonce);
  var StoragePool3 = require('../lib/db').StoragePool;
  var dp3 = StoragePool3.getDefaultPath();
  var poolId2 = require('../lib/db').get("SELECT id FROM storage_pools WHERE local_path = ? AND status = 'active' LIMIT 1", [dp3]);
  FileStorage.addPath(newStorageId, poolId2 ? poolId2.id : 1, require('path').relative(dp3, newPath).replace(/\\/g, '/'), newPath.replace(/\\/g, '/'));

  UserFileRef.create(user.id, newStorageId, dirId, file.name, file.mime_type);

  var vfId4 = VirtualFile.createWithEncVersion(
    user.id, dirId, file.name, file.size, file.mime_type, newPath, newUuid, 1
  );
  if (vfId4) {
    require('../lib/db').run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [newStorageId, vfId4]);
  }

  User.updateUsedBytes(user.id, file.size);
  Share.incrementDownload(share.id);

  log.info('[ShareSave] V1→V2 独立复制: ' + file.name + ' new storage_id=' + newStorageId);
  return res.json({
    code: 0, message: '转存成功（复制）', data: { id: vfId4, name: file.name, size: file.size, is_copy: true, storage_id: newStorageId }
  });
});

// ==================== API: 分享文件下载（公开，无需登录） ====================
// GET /api/share/download/:hash/:fileId
// 可选参数 ?sub_dir=xxx（浏览子目录时指定当前目录）
router.get('/share/download/:hash/:fileId', function(req, res) {
  var hash = req.params.hash;
  var rawFileId = req.params.fileId;
  // 公共文件分享：fileId 是路径（含 %2F 编码的斜杠），个人分享：fileId 是数字 ID
  var fileId = /^\d+$/.test(rawFileId) ? parseInt(rawFileId, 10) : rawFileId;
  var extractionCode = req.query.extraction_code || '';
  var subDirId = req.query.sub_dir || null;

  // 验证提取码
  var verifyResult = Share.verifyCode(hash, extractionCode);
  if (!verifyResult.valid) {
    if (verifyResult.reason === 'wrong_code') {
      return res.status(403).json({ code: 403, message: '提取码错误', data: null });
    }
    return res.status(410).json({ code: 410, message: verifyResult.reason === 'share_expired' ? '分享已过期' : '分享不存在', data: null });
  }

  var share = verifyResult.share;
  var validity = Share.checkValidity(share);
  if (!validity.valid) {
    if (validity.reason === 'download_limit_reached') {
      return res.status(410).json({ code: 410, message: '分享下载次数已用完（' + (share.max_downloads || 0) + '次）', data: null });
    }
    return res.status(410).json({ code: 410, message: '分享目标已删除', data: null });
  }

  // 公共文件分享：从文件系统读取
  if (share.target_type === 'public') {
    var encodedPath = req.params.fileId;
    var relPath;
    try { relPath = decodeURIComponent(encodedPath); } catch(e) { relPath = encodedPath; }
    var publicFullPath = path.join(Storage.PUBLIC_DIR, relPath);
    // 安全检查
    if (publicFullPath.indexOf(Storage.PUBLIC_DIR) !== 0) {
      return res.status(403).json({ code: 403, message: '无权限', data: null });
    }
    if (!fs.existsSync(publicFullPath) || fs.statSync(publicFullPath).isDirectory()) {
      return res.status(404).json({ code: 404, message: '文件不存在', data: null });
    }
    // 记录日志
    try { ShareStats.incrementDownload(share.id); } catch(e) {}
    try {
      var clientIp = (req.ip || '').replace(/^::ffff:/, '') || '';
      var logUserId = req.session && req.session.userId ? req.session.userId : 0;
      var logUserEmail = '';
      if (logUserId) { var lu = require('../lib/db').User.findById(logUserId); if (lu) logUserEmail = lu.email; }
      ShareAccessLog.log(share.id, 'download', clientIp, logUserId, logUserEmail, 0, path.basename(relPath));
    } catch(e) {}
    // 直接发送文件（公共文件未加密）
    var publicFileName = path.basename(relPath);
    res.setHeader('Content-Type', mime.lookup(publicFileName) || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(publicFileName) + '"');
    res.setHeader('Content-Length', fs.statSync(publicFullPath).size);
    var pubReadStream = fs.createReadStream(publicFullPath);
    pubReadStream.pipe(res);
    return;
  }

  var file;
  // 单文件分享：直接校验目标ID
  if (share.target_type === 'file') {
    if (fileId !== share.target_id) {
      return res.status(403).json({ code: 403, message: '无权限', data: null });
    }
    file = get('SELECT * FROM virtual_files WHERE id = ?', [fileId]);
  } else {
    // 目录/批量分享：确定当前浏览的目录范围
    // subDirId 优先（子目录浏览），否则用分享根目录
    var currentDirId = subDirId || parseInt(share.target_id, 10);
    file = get('SELECT * FROM virtual_files WHERE id = ? AND dir_id = ?', [fileId, currentDirId]);

    // 如果子目录查不到，尝试根目录（兼容旧链接）
    if (!file) {
      file = get('SELECT * FROM virtual_files WHERE id = ? AND dir_id = ?', [fileId, share.target_id]);
    }

    // 权限范围检查：文件必须属于分享树内
    if (file) {
      var inShareTree = _isFileInShareTree(file, share);
      if (!inShareTree) {
        return res.status(403).json({ code: 403, message: '该文件不在分享范围内', data: null });
      }
    }
  }

  if (!file) {
    return res.status(404).json({ code: 404, message: '文件不存在', data: null });
  }

  // 记录下载统计和日志
  try { ShareStats.incrementDownload(share.id); } catch(e) {}
  try {
    var clientIp = (req.ip || '').replace(/^::ffff:/, '') || '';
    var downloaderId = 0;
    var downloaderEmail = '访客';
    if (req.session && req.session.userId) {
      downloaderId = req.session.userId;
      var u = require('../lib/db').User.findById(downloaderId);
      if (u) downloaderEmail = u.email;
    }
    ShareAccessLog.log(share.id, 'download', clientIp, downloaderId, downloaderEmail, fileId, file.name);
  } catch(e) {}

  // ===== 第1步：解析实际文件路径（处理 V2 引用文件 storage_path 为空的情况）=====
  var storagePath = file.storage_path;
  if (!storagePath || !fs.existsSync(storagePath)) {
    if (file.storage_id && file.storage_id > 0) {
      var resolvedPath = require('./file').getDecryptedFilePath(file);
      log.info('[ShareDownload] storage_path 为空,通过 storage_id=' + file.storage_id + ' 解析: ' + (resolvedPath || 'null'));
      if (resolvedPath) storagePath = resolvedPath;
    }
    if (!storagePath || !fs.existsSync(storagePath)) {
      return res.status(404).json({ code: 404, message: '文件不存在或已被删除', data: null });
    }
  }

  // ===== 第2步：快速获取文件大小（元数据，不加载完整文件）=====
  var encVersion = file.enc_version || 0;
  var decryptedSize = 0;
  try {
    if (encVersion === 1) {
      if (!fs.existsSync(storagePath)) throw new Error('文件不存在');
      var v1Info = getV1FileInfo(storagePath);
      if (!v1Info.isV1) throw new Error('V1格式错误');
      decryptedSize = v1Info.originalSize;
    } else {
      if (!fs.existsSync(storagePath)) throw new Error('文件不存在');
      var fileSize = fs.statSync(storagePath).size;
      if (fileSize >= 88) {
        var magicBuf = Buffer.alloc(4);
        var fd = fs.openSync(storagePath, 'r');
        fs.readSync(fd, magicBuf, 0, 4, 0);
        fs.closeSync(fd);
        var isEncrypted = !(magicBuf.toString('ascii',0,4) === 'ftyp' ||
                            magicBuf.toString('ascii',0,4) === 'moov' ||
                            magicBuf.toString('ascii',0,4) === 'mdat' ||
                            (magicBuf[0]===0xFF && magicBuf[1]===0xD8) ||
                            (magicBuf[0]===0x89 && magicBuf[1]===0x50 && magicBuf[2]===0x4E && magicBuf[3]===0x47));
        decryptedSize = isEncrypted ? fileSize - 88 : fileSize;
      } else {
        decryptedSize = fileSize;
      }
    }
  } catch(e) {
    return res.status(500).json({ code: 500, message: '文件读取失败: ' + e.message, data: null });
  }

  // ===== 第2步：访客限检查（在任何响应头之前！）=====
  var isGuest = !req.session || !req.session.userId;
  var dlUserId = req.session && req.session.userId ? req.session.userId : 0;
  var dlGuestIp = dlUserId === 0 ? getClientIp(req) : '';
  var GUEST_LIMIT = 100 * 1024 * 1024;

  if (isGuest && decryptedSize > GUEST_LIMIT) {
    var loginUrl = '/login.html?return=' + encodeURIComponent('/share/' + hash);
    res.status(403).send('<!DOCTYPE html>' +
'<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
'<title>需要登录 - FileService</title><style>'+
'*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'+
'background:linear-gradient(135deg,#0d1117,#161b22);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}'+
'.card{background:#1c2128;border:1px solid #30363d;border-radius:20px;padding:48px 40px;max-width:460px;width:100%;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.5)}'+
'.icon{width:80px;height:80px;background:linear-gradient(135deg,#1a7f4b,#2ea043);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 28px;font-size:44px;box-shadow:0 8px 32px rgba(46,160,67,.3)}'+
'h2{color:#e6edf3;font-size:22px;margin:0 0 10px}p{color:#8b949e;font-size:14px;line-height:1.7;margin:0 0 6px}'+
'.fbox{background:#0d1117;border:1px solid #30363d;border-radius:12px;padding:16px;margin:20px 0;display:flex;align-items:center;gap:12px;text-align:left}'+
'.ficon{font-size:32px;flex-shrink:0}.finfo{flex:1;min-width:0}.fname{color:#e6edf3;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'+
'.fsize{color:#7ee787;font-size:13px;margin-top:3px}.flim{color:#d29922;font-size:12px;margin-top:2px}'+
'.btn{display:inline-flex;align-items:center;gap:6px;padding:14px 48px;background:linear-gradient(135deg,#1a7f4b,#2ea043);color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;transition:all .2s;margin-top:8px;box-shadow:0 4px 16px rgba(46,160,67,.3)}'+
'.btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(46,160,67,.5)}'+
'.back{display:block;margin-top:18px;color:#8b949e;font-size:13px;text-decoration:none}.back:hover{color:#e6edf3}'+
'</style></head><body><div class="card"><div class="icon">&#128274;</div><h2>需要登录才能下载</h2><p>此文件超过 100MB，访客模式下暂不支持下载</p><p>登录后可不限速下载完整文件</p>'+
'<div class="fbox"><span class="ficon">&#128196;</span><div class="finfo"><div class="fname">'+escHtml(file.name||'未知文件')+'</div><div class="fsize">文件大小: '+formatFileSize(decryptedSize)+'</div><div class="flim">访客下载上限: 100 MB</div></div></div>'+
'<a class="btn" href="'+loginUrl+'">&#128640; 立即登录并下载</a><a class="back" href="javascript:history.back()">&#8592; 返回上一页</a></div></body></html>');
    return;
  }

  // ===== 第3步：创建解密流并发送 =====
  var readStream = null;
  try {
    if (encVersion === 1) {
      readStream = createV1DecryptStream(storagePath, 0, decryptedSize - 1);
    } else if (decryptedSize < fs.statSync(storagePath).size) {
      // 旧加密格式（加密文件比原文件大88字节）
      var si = createDecryptStream(storagePath);
      readStream = si.readStream;
    } else {
      readStream = fs.createReadStream(storagePath);
    }
  } catch(e) {
    return res.status(500).json({ code: 500, message: '文件流创建失败', data: null });
  }

  res.set('Content-Type', file.mime_type || 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(file.name) + '"');
  res.set('Content-Length', decryptedSize);

    // 检查流量配额（注册用户从分享下载也消耗配额）
    if (!isGuest) {
      var quotaInfo = TrafficQuota.get(dlUserId, '', false);
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
    }

    // 记录流量（用户或访客）
    res.on('finish', function() {
      var sentBytes = parseInt(res.getHeader('content-length') || '0', 10);
      if (sentBytes > 0) {
        logTraffic(dlUserId, dlGuestIp, 'download', file.id, file.name, decryptedSize, sentBytes);
      }
    });

    readStream.pipe(res);
    log.info('[ShareDownload] 分享下载: ' + file.name + ' (加密:' + encVersion + ', ' + Math.round(decryptedSize / 1024 / 1024 * 10) / 10 + 'MB)');
});

// ==================== API: 生成本地二维码 ====================
// GET /api/share/qr?url=xxx
router.get('/share/qr', function(req, res) {
  var url = req.query.url;
  if (!url) return res.status(400).json({ code: 1, message: '缺少url参数', data: null });

  var size = parseInt(req.query.size, 10) || 240;
  size = Math.min(Math.max(size, 100), 400);

  QRCode.toDataURL(url, {
    width: size,
    margin: 2,
    color: { dark: '#e8eaf0', light: '#07090f' }
  }, function(err, dataUrl) {
    if (err) return res.status(500).json({ code: 1, message: '生成二维码失败', data: null });
    res.json({ code: 0, data: dataUrl });
  });
});

// ==================== 辅助：构建个人目录/文件的完整路径 ====================
// 从目录ID向上追溯到根，返回如 "/根目录/子目录/目标目录"
function buildPersonalPath(dirId, parentStopId, userId) {
  if (!dirId || dirId <= 0) return '';
  var VirtualDir = require('../lib/db').VirtualDir;
  var parts = [];
  var cur = dirId;
  var depth = 0;
  while (cur > 0 && depth < 20) {
    var d = VirtualDir.findById(cur);
    if (!d) break;
    if (d.user_id !== userId && userId !== 0) break;
    if (parentStopId > 0 && cur === parentStopId) break;
    parts.unshift(d.name);
    cur = d.parent_id;
    depth++;
  }
  return parts.length > 0 ? '/' + parts.join('/') : '';
}

// 获取个人文件的信息（dir_id + name）
function getFileInfo(fileId, userId) {
  if (!fileId || fileId <= 0) return null;
  var VirtualFile = require('../lib/db').VirtualFile;
  var f = VirtualFile.findById(fileId);
  if (!f || (userId > 0 && f.user_id !== userId)) return null;
  return { dir_id: f.dir_id || 0, name: f.name };
}

module.exports = router;
