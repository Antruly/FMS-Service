var log = require('../lib/log');
/**
 * 移动端版本管理
 * GET  /api/version/latest  - 获取最新版本信息（公开）
 * POST /api/admin/version/upload - 上传新版本（管理员）
 * GET  /api/admin/versions     - 版本列表（管理员）
 */
var express = require('express');
var router = express.Router();
var fs = require('fs');
var path = require('path');
var multer = require('multer');
var AdmZip = require('adm-zip');

// 从 APK 内部 assets/version.json 解析版本信息
function parseApkInfo(filePath) {
  try {
    var buf = fs.readFileSync(filePath);
    var zip = new AdmZip(buf);
    var versionEntry = zip.getEntry('assets/version.json');
    if (!versionEntry) return null;
    var raw = versionEntry.getData().toString('utf8');
    var info = JSON.parse(raw);
    return {
      versionName: info.versionName || '',
      versionCode: parseInt(info.versionCode, 10) || 0,
      changelog: info.changelog || ''
    };
  } catch(e) {
    log.warn('[Version] APK解析失败 (' + path.basename(filePath) + '):', e.message);
    return null;
  }
}

var VERSION_DIR = path.join(__dirname, '..', 'files', 'app');
var VERSION_FILE = path.join(VERSION_DIR, 'versions.json');

// Ensure directory exists
if (!fs.existsSync(VERSION_DIR)) fs.mkdirSync(VERSION_DIR, { recursive: true });
if (!fs.existsSync(VERSION_FILE)) fs.writeFileSync(VERSION_FILE, '[]', 'utf-8');

function readVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8')); } catch(e) { return []; }
}
function saveVersions(versions) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(versions, null, 2), 'utf-8');
}

// Upload storage — 先用临时名，解析后再按版本重命名
var storage = multer.diskStorage({
  destination: VERSION_DIR,
  filename: function(req, file, cb) { cb(null, 'FMS-uploading-' + Date.now() + '.apk'); }
});
var upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } });

// Auth helpers
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ code: 401, message: '请先登录', data: null });
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, function() {
    var User = require('../lib/db').User;
    var u = User.findById(req.session.userId);
    if (!u || !u.is_admin) return res.status(403).json({ code: 403, message: '需要管理员权限', data: null });
    req.user = u;
    next();
  });
}

// Test endpoint - verify routes are working
router.get('/admin/version/test', function(req, res) {
  res.json({ code: 0, message: 'OK', dir: VERSION_DIR });
});

// GET /api/version/latest - Public
router.get('/version/latest', function(req, res) {
  var versions = readVersions();
  if (versions.length === 0) return res.json({ code: 0, data: { version: '0.0.0', versionCode: 0, url: '', size: 0, notes: '', createdAt: '' } });
  var latest = versions[versions.length - 1];
  res.json({ code: 0, data: latest });
});

// POST /api/admin/version/upload - Admin only
router.post('/admin/version/upload', requireAdmin, upload.single('file'), function(req, res) {
  var file = req.file;
  if (!file) return res.json({ code: 1, message: '未上传文件', data: null });

  // 优先从 APK 内部 assets/version.json 解析版本号和更新日志
  var version, versionCode, notes;
  var apkInfo = parseApkInfo(file.path);
  if (apkInfo && apkInfo.versionName) {
    version = apkInfo.versionName;
    versionCode = apkInfo.versionCode;
    notes = apkInfo.changelog || req.body.notes || '';
    log.info('[Version] APK自动识别: v' + version + ' (' + versionCode + ') changelog: ' + (notes ? notes.substring(0, 40) : ''));
  } else {
    // 回退：从文件名解析
    version = req.body.version || '';
    versionCode = parseInt(req.body.versionCode, 10) || 0;
    if (!version) {
      var m = file.originalname.match(/v?(\d+)\.(\d+)\.(\d+)/);
      if (m) {
        version = parseInt(m[1]) + '.' + parseInt(m[2]) + '.' + parseInt(m[3]);
        versionCode = parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]);
      } else {
        version = '0.0.0';
        versionCode = 0;
      }
    }
    notes = req.body.notes || '';
  }

  // 重命名为 FMS-Service-v{version}.apk
  var newFileName = 'FMS-Service-v' + version + '.apk';
  var newPath = path.join(VERSION_DIR, newFileName);
  try {
    if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
    fs.renameSync(file.path, newPath);
    file.filename = newFileName;
    file.path = newPath;
  } catch(e) {
    log.error('[Version] 文件重命名失败:', e.message);
  }

  var url = '/files/app/' + file.filename;
  var entry = {
    version: version,
    versionCode: versionCode,
    url: url,
    size: file.size,
    notes: notes,
    fileName: file.filename,
    createdAt: new Date().toISOString()
  };

  var versions = readVersions();
  // Remove old entry with same version
  versions = versions.filter(function(v) { return v.version !== version; });
  versions.push(entry);
  versions.sort(function(a, b) { return a.versionCode - b.versionCode; });
  saveVersions(versions);

  log.info('[Version] New APK uploaded: v' + version + ' (' + Math.round(file.size/1024/1024) + 'MB)');
  res.json({ code: 0, message: '上传成功', data: entry });
});

// GET /api/admin/versions - Admin only
router.get('/admin/versions', requireAdmin, function(req, res) {
  var versions = readVersions();
  res.json({ code: 0, data: versions.reverse() });
});

// DELETE /api/admin/version/:versionCode - Admin only
router.delete('/admin/version/:versionCode', requireAdmin, function(req, res) {
  var code = parseInt(req.params.versionCode, 10);
  var versions = readVersions();
  var entry = versions.find(function(v) { return v.versionCode === code; });
  if (entry) {
    try { fs.unlinkSync(path.join(VERSION_DIR, entry.fileName)); } catch(e) {}
    versions = versions.filter(function(v) { return v.versionCode !== code; });
    saveVersions(versions);
  }
  res.json({ code: 0, message: '已删除', data: null });
});

// Serve uploaded APK files
// GET /api/version/server - 服务器版本信息（公开）
router.get('/version/server', function(req, res) {
  var pkg = require('../package.json');
  var versions = readVersions();
  var latestApk = versions.length > 0 ? versions[versions.length - 1] : null;
  res.json({ code: 0, data: {
    serverVersion: pkg.version || '1.0.0',
    description: pkg.description || '',
    nodeVersion: process.version || '',
    github: 'https://github.com/Antruly/FMS-Service',
    githubApp: 'https://github.com/Antruly/FMS-Service-app',
    apkVersion: latestApk ? latestApk.version : '-',
    apkVersionCode: latestApk ? latestApk.versionCode : 0,
    apkNotes: latestApk ? latestApk.notes : ''
  }});
});

// ==================== GitHub 版本检查（不自动下载，仅返回信息） ====================

// GET /api/version/backend/check - 检查后台版本更新（仅检查，不下载）
router.get('/version/backend/check', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var cfg = upgrade.loadConfig();
    upgrade.checkBackendVersion().then(function(result) {
      // 手动检查永远不自动下载，仅返回版本信息和下载状态
      result._download = upgrade.getDownloadStatus('backend');
      result._config = { autoDownload: cfg.autoDownload, autoUpgrade: cfg.autoUpgrade, autoUpgradeTime: cfg.autoUpgradeTime };
      res.json({ code: 0, data: result });
    }).catch(function(err) {
      res.json({ code: 0, data: { error: err.message, hasUpdate: false } });
    });
  } catch(e) {
    res.json({ code: 1, message: '检查失败: ' + e.message, data: null });
  }
});

// GET /api/version/app/check - 检查 App 版本更新（仅检查，不下载）
router.get('/version/app/check', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var versions = readVersions();
    var latestLocal = versions.length > 0 ? versions[versions.length - 1].version : '0.0.0';
    upgrade.checkAppVersion(latestLocal).then(function(result) {
      result._download = upgrade.getDownloadStatus('app');
      res.json({ code: 0, data: result });
    }).catch(function(err) {
      res.json({ code: 0, data: { error: err.message, hasUpdate: false } });
    });
  } catch(e) {
    res.json({ code: 1, message: '检查失败: ' + e.message, data: null });
  }
});

// ==================== 手动下载（从 GitHub 下载到本地，带进度） ====================

// POST /api/version/backend/download - 手动触发后台版本下载
router.post('/version/backend/download', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var url = req.body.url || '';
    var version = req.body.version || '';
    if (!url) return res.json({ code: 1, message: '缺少下载地址', data: null });

    var ds = upgrade.getDownloadStatus('backend');
    if (ds.downloading) {
      return res.json({ code: 1, message: '已有下载进行中 (' + ds.progress + '%)', data: ds });
    }
    var userId = req.session && req.session.userId ? req.session.userId : '';
    upgrade.startAutoDownload('backend', url, version, null, userId);
    log.info('[Version] 手动下载后台 v' + version + ' 已触发');
    res.json({ code: 0, message: '下载已开始', data: upgrade.getDownloadStatus('backend') });
  } catch(e) {
    res.json({ code: 1, message: '下载失败: ' + e.message, data: null });
  }
});

// POST /api/version/app/download - 手动触发 App 版本下载
router.post('/version/app/download', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var url = req.body.url || '';
    var version = req.body.version || '';
    if (!url) return res.json({ code: 1, message: '缺少下载地址', data: null });

    var ds = upgrade.getDownloadStatus('app');
    if (ds.downloading) {
      return res.json({ code: 1, message: '已有下载进行中 (' + ds.progress + '%)', data: ds });
    }
    var apkName = 'FMS-Service-v' + version + '.apk';
    var userId2 = req.session && req.session.userId ? req.session.userId : '';
    upgrade.startAutoDownload('app', url, version, apkName, userId2);
    log.info('[Version] 手动下载 App v' + version + ' 已触发');
    res.json({ code: 0, message: '下载已开始', data: upgrade.getDownloadStatus('app') });
  } catch(e) {
    res.json({ code: 1, message: '下载失败: ' + e.message, data: null });
  }
});

// GET /api/version/download/status - 获取下载状态和进度
router.get('/version/download/status', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    res.json({ code: 0, data: upgrade.getDownloadStatus() });
  } catch(e) {
    res.json({ code: 1, message: e.message, data: null });
  }
});

// ==================== 升级配置管理 ====================

// GET /api/admin/upgrade/config - 获取升级配置
router.get('/admin/upgrade/config', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    res.json({ code: 0, data: upgrade.loadConfig() });
  } catch(e) {
    res.json({ code: 1, message: e.message, data: null });
  }
});

// PUT /api/admin/upgrade/config - 保存升级配置
router.put('/admin/upgrade/config', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var updates = {};
    if (typeof req.body.autoDownload === 'boolean') updates.autoDownload = req.body.autoDownload;
    if (typeof req.body.autoUpgrade === 'boolean') updates.autoUpgrade = req.body.autoUpgrade;
    if (req.body.autoUpgradeTime) updates.autoUpgradeTime = req.body.autoUpgradeTime;
    var cfg = upgrade.saveConfig(updates);
    res.json({ code: 0, message: '配置已保存', data: cfg });
  } catch(e) {
    res.json({ code: 1, message: e.message, data: null });
  }
});

// ==================== 后台升级 ====================

// GET /api/admin/upgrade/status - 获取升级状态（管理员）
router.get('/admin/upgrade/status', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var status = upgrade.getStatus();
    res.json({ code: 0, data: status });
  } catch(e) {
    res.json({ code: 1, message: e.message, data: null });
  }
});

// POST /api/admin/upgrade/start - 开始后台升级（管理员）
// 优先使用自动下载到本地的缓存文件，避免重复下载
router.post('/admin/upgrade/start', requireAdmin, function(req, res) {
  try {
    var upgrade = require('../lib/upgrade');
    var state = global.upgradeState;

    if (state && state.active) {
      return res.json({ code: 1, message: '已有升级在进行中', data: null });
    }

    var versionTo = req.body.version || '';
    var downloadUrl = req.body.url || '';
    var backupDb = req.body.backupDb === true || req.body.backupDb === 'true';
    var manualZipPath = req.body.manualZipPath || '';

    // 优先使用前端传来的本地缓存路径
    if (!manualZipPath && !downloadUrl) {
      var ds = upgrade.getDownloadStatus('backend');
      if (ds.done && ds.filePath && require('fs').existsSync(ds.filePath)) {
        manualZipPath = ds.filePath;
        versionTo = versionTo || ds.version;
        log.info('[Upgrade] 使用内存缓存: ' + manualZipPath);
      } else {
        // 回退：扫描 data/tmp 目录找已下载的升级包
        var tmpDir = require('path').join(__dirname, '..', 'data', 'tmp');
        try {
          if (require('fs').existsSync(tmpDir)) {
            var files = require('fs').readdirSync(tmpDir);
            // 优先找最新下载的 backend_v*.zip
            var bestFile = null, bestTime = 0;
            files.forEach(function(f) {
              if (f.endsWith('.zip') && f.indexOf('backend_v') === 0) {
                var fullPath = require('path').join(tmpDir, f);
                var stat = require('fs').statSync(fullPath);
                if (stat.mtimeMs > bestTime) { bestTime = stat.mtimeMs; bestFile = fullPath; }
              }
            });
            if (bestFile) {
              manualZipPath = bestFile;
              log.info('[Upgrade] 从磁盘找到升级包: ' + bestFile);
            }
          }
        } catch(e) {}
      }
      if (ds && ds.downloading) {
        return res.json({ code: 1, message: '安装包正在下载中 (' + ds.progress + '%)，请等待下载完成', data: { downloading: true, progress: ds.progress } });
      }
    }

    // 如果有 URL 但本地已有缓存，优先用本地文件
    if (!manualZipPath && downloadUrl) {
      var ds2 = upgrade.getDownloadStatus('backend');
      if (ds2.done && ds2.filePath && require('fs').existsSync(ds2.filePath)) {
        manualZipPath = ds2.filePath;
        log.info('[Upgrade] 使用本地缓存替代远程下载: ' + manualZipPath);
      }
    }

    if (!manualZipPath && !downloadUrl) {
      return res.json({ code: 1, message: '没有可用的升级包，请先下载升级包到本地，或手动上传', data: null });
    }

    // 立即返回，异步执行升级
    res.json({ code: 0, message: '升级已启动', data: { phase: 'draining' } });

    upgrade.performUpgrade({
      url: downloadUrl,
      versionTo: versionTo,
      backupDb: backupDb,
      manualZipPath: manualZipPath
    }).then(function() {
      log.info('[Upgrade] 升级流程完成');
    }).catch(function(err) {
      log.error('[Upgrade] 升级失败: ' + err.message);
    });
  } catch(e) {
    res.json({ code: 1, message: '启动升级失败: ' + e.message, data: null });
  }
});

// POST /api/admin/upgrade/upload - 上传升级包（管理员）
var upgradeStorage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'data', 'tmp'),
  filename: function(req, file, cb) {
    var ext = '.zip';
    if (file.originalname && file.originalname.endsWith('.tar.gz')) ext = '.tar.gz';
    else if (file.originalname && file.originalname.endsWith('.tgz')) ext = '.tgz';
    cb(null, 'upgrade_upload_' + Date.now() + ext);
  }
});
var upgradeUpload = multer({
  storage: upgradeStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: function(req, file, cb) {
    var allowed = ['.zip', '.tar.gz', '.tgz', '.tar'];
    var matched = false;
    for (var i = 0; i < allowed.length; i++) {
      if (file.originalname && file.originalname.toLowerCase().endsWith(allowed[i])) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return cb(new Error('仅支持 .zip / .tar.gz / .tgz 格式'));
    }
    cb(null, true);
  }
});

router.post('/admin/upgrade/upload', requireAdmin, upgradeUpload.single('file'), function(req, res) {
  var file = req.file;
  if (!file) return res.json({ code: 1, message: '未上传文件', data: null });

  var zipPath = file.path;
  log.info('[Upgrade] 收到升级包: ' + file.originalname + ' (' + Math.round(file.size / 1024) + ' KB)');

  // 尝试从文件名解析版本号
  var versionMatch = (file.originalname || '').match(/v?(\d+\.\d+\.\d+)/);
  var versionTo = versionMatch ? versionMatch[1] : '';

  res.json({
    code: 0,
    message: '上传成功',
    data: {
      path: zipPath,
      fileName: file.originalname,
      size: file.size,
      versionTo: versionTo
    }
  });
});

router.use('/app', express.static(VERSION_DIR));

module.exports = router;
