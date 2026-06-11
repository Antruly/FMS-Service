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

router.use('/app', express.static(VERSION_DIR));

module.exports = router;
