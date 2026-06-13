/**
 * 数据库备份 API 路由
 * GET  /api/admin/backup/config   - 获取备份配置+统计
 * PUT  /api/admin/backup/config   - 保存备份配置
 * POST /api/admin/backup/now      - 手动触发备份
 * GET  /api/admin/backup/list     - 备份文件列表
 * DELETE /api/admin/backup/files/:id - 删除备份文件
 * GET  /api/admin/backup/download/:id - 下载备份文件
 */

var express = require('express');
var router = express.Router();
var path = require('path');
var fs = require('fs');

// 延迟加载避免循环依赖
function getDb() { return require('../lib/db'); }
function getBackup() { return require('../lib/backup'); }

// 管理员权限中间件
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ code: 401, message: '请先登录', data: null });
  }
  var db = getDb();
  var user = db.User.findById(req.session.userId);
  if (!user) {
    req.session.destroy(function() {});
    return res.status(401).json({ code: 401, message: '用户不存在', data: null });
  }
  if (!user.is_active) {
    req.session.destroy(function() {});
    return res.status(403).json({ code: 403, message: '账号已被禁用', data: null });
  }
  if (!user.is_admin) {
    return res.status(403).json({ code: 403, message: '需要管理员权限', data: null });
  }
  req._adminUser = user;
  next();
}

// GET /api/admin/backup/config - 获取备份配置+统计
router.get('/admin/backup/config', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var cfg = db.BackupConfig.get();
    if (!cfg) {
      return res.json({ code: 0, data: { config: null, stats: {} } });
    }
    // 屏蔽密码字段
    var safeCfg = {
      id: cfg.id,
      enabled: cfg.enabled,
      schedule_type: cfg.schedule_type,
      schedule_time: cfg.schedule_time,
      schedule_day: cfg.schedule_day,
      backup_dir: cfg.backup_dir,
      retention_days: cfg.retention_days,
      compress: cfg.compress,
      webdav_enabled: cfg.webdav_enabled,
      webdav_url: cfg.webdav_url,
      webdav_username: cfg.webdav_username,
      webdav_password: cfg.webdav_password ? '••••••••' : '',
      webdav_path: cfg.webdav_path,
      updated_at: cfg.updated_at
    };

    var lastBackup = db.BackupRecord.last();
    var stats = {
      last_backup: lastBackup ? lastBackup.created_at : null,
      last_filename: lastBackup ? lastBackup.filename : null,
      total_backups: db.BackupRecord.count(),
      total_size: db.BackupRecord.totalSize(),
      db_size: getBackup().getDbFileSize()
    };

    res.json({ code: 0, data: { config: safeCfg, stats: stats } });
  } catch(e) {
    res.json({ code: 500, message: '获取备份配置失败: ' + e.message, data: null });
  }
});

// PUT /api/admin/backup/config - 保存备份配置
router.put('/admin/backup/config', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var body = req.body || {};

    // 验证保留天数
    var retentionDays = parseInt(body.retention_days, 10);
    if (isNaN(retentionDays) || retentionDays < 1) {
      return res.json({ code: 400, message: '保留天数至少为1', data: null });
    }

    // 验证备份目录
    var backupDir = (body.backup_dir || '').trim();
    if (!backupDir) {
      return res.json({ code: 400, message: '备份目录不能为空', data: null });
    }

    // 如果启用了WebDAV，验证必要字段
    if (body.webdav_enabled) {
      if (!body.webdav_url || !body.webdav_url.trim()) {
        return res.json({ code: 400, message: '启用WebDAV时需填写WebDAV地址', data: null });
      }
    }

    // 如果不传密码，保留原密码
    if (body.webdav_password === '••••••••' || body.webdav_password === undefined || body.webdav_password === null) {
      var existing = db.BackupConfig.get();
      if (existing) {
        body.webdav_password = existing.webdav_password;
      }
    }

    db.BackupConfig.save({
      enabled: body.enabled ? 1 : 0,
      schedule_type: body.schedule_type || 'daily',
      schedule_time: body.schedule_time || '03:00',
      schedule_day: parseInt(body.schedule_day, 10) || 0,
      backup_dir: backupDir,
      retention_days: retentionDays,
      compress: body.compress ? 1 : 0,
      webdav_enabled: body.webdav_enabled ? 1 : 0,
      webdav_url: (body.webdav_url || '').trim(),
      webdav_username: (body.webdav_username || '').trim(),
      webdav_password: body.webdav_password || '',
      webdav_path: (body.webdav_path || '/').trim()
    });

    // 重启调度器以应用新配置
    try {
      var scheduler = require('../lib/backup-scheduler');
      scheduler.stopBackupScheduler();
      scheduler.startBackupScheduler();
    } catch(e) {}

    res.json({ code: 0, message: '配置已保存', data: null });
  } catch(e) {
    res.json({ code: 500, message: '保存配置失败: ' + e.message, data: null });
  }
});

// POST /api/admin/backup/now - 手动触发备份
router.post('/admin/backup/now', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var cfg = db.BackupConfig.get();
    if (!cfg) {
      return res.json({ code: 400, message: '请先配置备份参数', data: null });
    }

    var backup = getBackup();
    var result = backup.performBackup(cfg, null);

    res.json({
      code: 0,
      message: '备份任务已启动',
      data: { task_id: result.taskId }
    });
  } catch(e) {
    res.json({ code: 500, message: '启动备份失败: ' + e.message, data: null });
  }
});

// GET /api/admin/backup/list - 备份文件列表
router.get('/admin/backup/list', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var limit = parseInt(req.query.limit, 10) || 20;
    var offset = parseInt(req.query.offset, 10) || 0;
    var records = db.BackupRecord.list(limit, offset);
    var total = db.BackupRecord.count();

    res.json({
      code: 0,
      data: {
        records: records,
        total: total,
        limit: limit,
        offset: offset
      }
    });
  } catch(e) {
    res.json({ code: 500, message: '获取备份列表失败: ' + e.message, data: null });
  }
});

// DELETE /api/admin/backup/files/:id - 删除备份文件
router.delete('/admin/backup/files/:id', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var recordId = parseInt(req.params.id, 10);
    if (isNaN(recordId)) {
      return res.json({ code: 400, message: '无效的记录ID', data: null });
    }

    var record = db.BackupRecord.get(recordId);
    if (!record) {
      return res.json({ code: 404, message: '备份记录不存在', data: null });
    }

    // 删除物理文件
    try {
      if (fs.existsSync(record.file_path)) {
        fs.unlinkSync(record.file_path);
      }
    } catch(e) {
      // 文件可能已被删除
    }

    // 删除数据库记录
    db.BackupRecord.delete(recordId);

    res.json({ code: 0, message: '备份文件已删除', data: null });
  } catch(e) {
    res.json({ code: 500, message: '删除备份失败: ' + e.message, data: null });
  }
});

// GET /api/admin/backup/download/:id - 下载备份文件
router.get('/admin/backup/download/:id', requireAdmin, function(req, res) {
  try {
    var db = getDb();
    var recordId = parseInt(req.params.id, 10);
    if (isNaN(recordId)) {
      return res.status(400).json({ code: 400, message: '无效的记录ID', data: null });
    }

    var record = db.BackupRecord.get(recordId);
    if (!record) {
      return res.status(404).json({ code: 404, message: '备份记录不存在', data: null });
    }

    // 路径穿越保护
    var normalizedPath = path.normalize(record.file_path);
    var cfg = db.BackupConfig.get();
    var normalizedBase = cfg ? path.normalize(cfg.backup_dir) : '';
    if (normalizedBase && normalizedPath.indexOf(normalizedBase) !== 0) {
      return res.status(403).json({ code: 403, message: '禁止访问', data: null });
    }

    if (!fs.existsSync(normalizedPath)) {
      return res.status(404).json({ code: 404, message: '备份文件已被删除', data: null });
    }

    var filename = record.filename;
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(filename) + '"');
    res.setHeader('Content-Type', 'application/octet-stream');
    var fileStream = fs.createReadStream(normalizedPath);
    fileStream.pipe(res);
    fileStream.on('error', function() {
      if (!res.headersSent) {
        res.status(500).json({ code: 500, message: '读取文件失败', data: null });
      }
    });
  } catch(e) {
    if (!res.headersSent) {
      res.status(500).json({ code: 500, message: '下载失败: ' + e.message, data: null });
    }
  }
});

// POST /api/admin/backup/test-webdav - 测试 WebDAV 连接
router.post('/admin/backup/test-webdav', requireAdmin, function(req, res) {
  try {
    var body = req.body || {};
    var webdavUrl = (body.webdav_url || '').trim();
    if (!webdavUrl) {
      return res.json({ code: 400, message: '请输入 WebDAV 服务器地址', data: null });
    }

    // 测试连接：直接 PROPFIND WebDAV 地址本身（不拼接 webdav_path，后者只用于上传路径前缀）
    var httpMod = webdavUrl.startsWith('https') ? require('https') : require('http');
    var urlObj = new URL(webdavUrl);

    var options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'PROPFIND',
      headers: {
        'Depth': '0',
        'User-Agent': 'FMS-Backup/1.0'
      },
      timeout: 15000
    };

    // 如果有用户名，添加 Basic Auth
    var username = (body.webdav_username || '').trim();
    var password = body.webdav_password || '';
    if (username) {
      options.headers['Authorization'] = 'Basic ' +
        Buffer.from(username + ':' + password).toString('base64');
    }

    var req2 = httpMod.request(options, function(proxyRes) {
      var data = '';
      proxyRes.on('data', function(chunk) { data += chunk; });
      proxyRes.on('end', function() {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          res.json({ code: 0, message: '连接成功 (HTTP ' + proxyRes.statusCode + ')', data: null });
        } else if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
          res.json({ code: -1, message: '认证失败 (HTTP ' + proxyRes.statusCode + ')，请检查用户名密码', data: null });
        } else if (proxyRes.statusCode === 404) {
          res.json({ code: -1, message: '路径不存在 (HTTP 404)，请检查远程路径', data: null });
        } else {
          res.json({ code: -1, message: '服务器响应异常 (HTTP ' + proxyRes.statusCode + ')', data: null });
        }
      });
    });

    req2.on('error', function(e) {
      res.json({ code: -1, message: '连接失败: ' + e.message, data: null });
    });

    req2.on('timeout', function() {
      req2.destroy();
      res.json({ code: -1, message: '连接超时，请检查服务器地址是否正确', data: null });
    });

    req2.end();
  } catch(e) {
    res.json({ code: 500, message: '测试失败: ' + e.message, data: null });
  }
});

module.exports = router;
