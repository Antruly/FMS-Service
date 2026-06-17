/**
 * 版本升级模块
 * - GitHub Release 检查（App + 后台）
 * - 升级流程编排：排空请求 → 备份 → 下载 → 解压 → 重启
 * - 通过 global.upgradeState 暴露实时状态
 */

var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');
var crypto = require('crypto');
var AdmZip = require('adm-zip');

var log = require('./log');
var PROJECT_ROOT = path.join(__dirname, '..');

// ==================== 全局升级状态 ====================
// 挂到 global 上，方便 server.js 中间件和 routes 共享
global.upgradeState = {
  active: false,
  phase: '',
  progress: 0,
  pendingCount: 0,
  totalSteps: 0,
  currentStep: 0,
  stepLabel: '',
  error: '',
  logs: [],
  startedAt: null,
  completedAt: null,
  versionFrom: '',
  versionTo: '',
  taskId: null,
  requestCountAtStart: 0
};

// 启动时检查是否有上次升级遗留的结果文件
(function checkPreviousUpgradeResult() {
  var resultFile = path.join(PROJECT_ROOT, 'data', 'upgrade_result.json');
  try {
    if (fs.existsSync(resultFile)) {
      var result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      if (result.completed && Date.now() - new Date(result.completedAt).getTime() < 300000) {
        global.upgradeState.phase = 'done';
        global.upgradeState.progress = 100;
        global.upgradeState.completedAt = result.completedAt;
        global.upgradeState.versionFrom = result.versionFrom || '';
        global.upgradeState.versionTo = result.versionTo || '';
        global.upgradeState.logs.push({ time: new Date().toISOString(), msg: '升级已完成（从磁盘恢复）' });
        log.info('[Upgrade] 检测到上次升级已完成: v' + result.versionFrom + ' → v' + result.versionTo);
      }
      try { fs.unlinkSync(resultFile); } catch(e) {}
    }
  } catch(e) {}
})();

// ==================== 自动下载状态（版本检查时自动下载） ====================
global.downloadState = global.downloadState || {
  backend: { downloading: false, progress: 0, version: '', filePath: '', fileName: '', size: 0, done: false, error: '' },
  app:     { downloading: false, progress: 0, version: '', filePath: '', fileName: '', size: 0, done: false, error: '' }
};

function resetDownloadState(type) {
  global.downloadState[type] = { downloading: false, progress: 0, version: '', filePath: '', fileName: '', size: 0, done: false, error: '' };
}

/**
 * 自动下载 release 文件到本地（后台运行，不阻塞）
 * @param {'backend'|'app'} type
 * @param {string} downloadUrl
 * @param {string} version
 * @param {string} [fileName] 可选指定文件名
 */
function startAutoDownload(type, downloadUrl, version, fileName, adminUserId) {
  var ds = global.downloadState[type];
  if (ds.downloading) {
    log.info('[Upgrade] ' + type + ' 已有下载进行中，跳过');
    return;
  }
  resetDownloadState(type);
  ds.downloading = true;
  ds.version = version;
  ds.adminUserId = adminUserId || '';

  var destDir, destName;
  if (type === 'backend') {
    destDir = path.join(PROJECT_ROOT, 'data', 'tmp');
    destName = fileName || ('backend_v' + version + '_' + Date.now() + '.zip');
  } else {
    destDir = path.join(PROJECT_ROOT, 'files', 'app');
    destName = fileName || ('FMS-Service-v' + version + '.apk');
  }

  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  var destPath = path.join(destDir, destName);
  ds.filePath = destPath;
  ds.fileName = destName;

  log.info('[Upgrade] 下载 ' + type + ' v' + version + ' → ' + destPath);

  downloadFileWithProgress(downloadUrl, destPath, function(progress) {
    ds.progress = Math.min(99, progress);
    // WebSocket 实时推送进度给管理员
    pushDownloadProgress(type, ds);
  }).then(function(filePath) {
    ds.downloading = false;
    ds.done = true;
    ds.progress = 100;
    try { ds.size = fs.statSync(filePath).size; } catch(e) {}
    log.info('[Upgrade] ' + type + ' 下载完成: ' + filePath + ' (' + Math.round(ds.size/1024) + ' KB)');

    // 下载完成后自动入库
    if (type === 'app') {
      registerDownloadedApk(filePath, version);
    }
    pushDownloadProgress(type, ds);
  }).catch(function(err) {
    ds.downloading = false;
    ds.done = false;
    ds.error = err.message;
    log.error('[Upgrade] ' + type + ' 下载失败: ' + err.message);
    pushDownloadProgress(type, ds);
  });
}

/**
 * 将下载的 APK 解析并注册到版本列表
 */
function registerDownloadedApk(filePath, fallbackVersion) {
  try {
    var AdmZip = require('adm-zip');
    var buf = fs.readFileSync(filePath);
    var zip = new AdmZip(buf);
    var versionEntry = zip.getEntry('assets/version.json');
    var version, versionCode, notes;

    if (versionEntry) {
      var raw = versionEntry.getData().toString('utf8');
      var info = JSON.parse(raw);
      version = info.versionName || fallbackVersion;
      versionCode = parseInt(info.versionCode, 10) || 0;
      notes = info.changelog || '';
    } else {
      // 回退：从文件名解析版本号
      version = fallbackVersion;
      var m = (version || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
      versionCode = m ? parseInt(m[1]) * 10000 + parseInt(m[2]) * 100 + parseInt(m[3]) : 0;
      notes = '';
    }

    if (!version) { log.warn('[Upgrade] 无法解析 APK 版本号'); return; }

    var VERSION_DIR = path.join(PROJECT_ROOT, 'files', 'app');
    var VERSION_FILE = path.join(VERSION_DIR, 'versions.json');

    // 重命名为规范文件名
    var newName = 'FMS-Service-v' + version + '.apk';
    var newPath = path.join(VERSION_DIR, newName);
    if (filePath !== newPath) {
      if (fs.existsSync(newPath)) fs.unlinkSync(newPath);
      fs.renameSync(filePath, newPath);
    }

    // 更新 versions.json
    var versions = [];
    if (fs.existsSync(VERSION_FILE)) {
      try { versions = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8')); } catch(e) {}
    }
    versions = versions.filter(function(v) { return v.version !== version; });
    versions.push({
      version: version,
      versionCode: versionCode,
      url: '/files/app/' + newName,
      size: fs.statSync(newPath).size,
      notes: notes,
      fileName: newName,
      createdAt: new Date().toISOString()
    });
    versions.sort(function(a, b) { return a.versionCode - b.versionCode; });
    fs.writeFileSync(VERSION_FILE, JSON.stringify(versions, null, 2), 'utf-8');

    log.info('[Upgrade] APK v' + version + ' 已注册到版本列表 (' + Math.round(fs.statSync(newPath).size/1024) + ' KB)');
  } catch(e) {
    log.error('[Upgrade] APK 注册失败: ' + e.message);
  }
}

/**
 * 通过 WebSocket 推送下载进度给管理员
 */
function pushDownloadProgress(type, ds) {
  try {
    var wsService = require('./ws');
    var payload = {
      type: 'download_progress',
      data: {
        target: type,  // 'backend' | 'app'
        downloading: ds.downloading,
        done: ds.done,
        progress: ds.progress,
        version: ds.version,
        fileName: ds.fileName,
        filePath: ds.filePath,
        size: ds.size || 0,
        error: ds.error || ''
      }
    };
    if (ds.adminUserId) {
      wsService.sendToUser(ds.adminUserId, payload);
    }
    // 同时广播给所有管理员（以便多设备同步）
    wsService.broadcast(payload);
  } catch(e) {
    // WebSocket 不可用时忽略
  }
}

/**
 * 下载文件并回调进度
 */
// 浏览器级请求头（避免被 GitHub 等站点当作爬虫拦截）
var BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'identity',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

function getBrowserHeaders(url) {
  var h = Object.assign({}, BROWSER_HEADERS);
  try {
    var p = require('url').parse(url);
    h['Referer'] = (p.protocol || 'https:') + '//' + (p.host || 'github.com') + '/';
  } catch(e) {}
  return h;
}

function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise(function(resolve, reject) {
    var parsed = require('url').parse(url);
    var mod = parsed.protocol === 'https:' ? https : http;
    var opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      headers: getBrowserHeaders(url),
      timeout: 600000
    };

    function doRequest(requestOpts, redirectCount) {
      if (redirectCount > 5) return reject(new Error('重定向次数过多'));
      var req = mod.request(requestOpts, function(resp) {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          var redirUrl = resp.headers.location;
          // 处理相对路径重定向
          if (redirUrl.startsWith('/')) {
            redirUrl = (parsed.protocol || 'https:') + '//' + parsed.host + redirUrl;
          }
          var rp = require('url').parse(redirUrl);
          return doRequest({
            hostname: rp.hostname, port: rp.port, path: rp.path,
            method: 'GET',
            headers: getBrowserHeaders(redirUrl),
            timeout: 600000
          }, redirectCount + 1);
        }
        if (resp.statusCode >= 400) return reject(new Error('下载失败 HTTP ' + resp.statusCode));

        var totalSize = parseInt(resp.headers['content-length'], 10) || 0;
        var downloaded = 0;
        var fileStream = fs.createWriteStream(destPath);

        resp.on('data', function(chunk) {
          downloaded += chunk.length;
          if (totalSize > 0 && onProgress) onProgress(Math.round(downloaded / totalSize * 100));
        });
        resp.pipe(fileStream);
        fileStream.on('finish', function() { fileStream.close(); resolve(destPath); });
        fileStream.on('error', function(e) { reject(e); });
      });
      req.on('error', function(e) { reject(e); });
      req.on('timeout', function() { req.destroy(); reject(new Error('下载超时')); });
      req.end();
    }
    doRequest(opts, 0);
  });
}

/**
 * 获取下载状态
 */
function getDownloadStatus(type) {
  if (type) return global.downloadState[type];
  return { backend: global.downloadState.backend, app: global.downloadState.app };
}

function appendLog(msg) {
  var entry = { time: new Date().toISOString(), msg: msg };
  global.upgradeState.logs.push(entry);
  // 保留最近 200 条
  if (global.upgradeState.logs.length > 200) {
    global.upgradeState.logs = global.upgradeState.logs.slice(-200);
  }
  log.info('[Upgrade] ' + msg);
  // 如果有 AsyncTask，同步写入
  try {
    if (global.upgradeState.taskId) {
      var db = require('./db');
      db.AsyncTask.appendLog(global.upgradeState.taskId, msg, 'info');
    }
  } catch (e) {}
}

function setPhase(phase, progress, stepLabel) {
  global.upgradeState.phase = phase;
  global.upgradeState.progress = progress || 0;
  global.upgradeState.stepLabel = stepLabel || '';
  appendLog('阶段: ' + phase + ' (' + progress + '%)');
  // 同步 AsyncTask 进度
  try {
    if (global.upgradeState.taskId) {
      var db = require('./db');
      db.AsyncTask.updateProgress(
        global.upgradeState.taskId,
        global.upgradeState.currentStep,
        global.upgradeState.totalSteps || 1,
        0
      );
    }
  } catch (e) {}
}

// ==================== GitHub API ====================

var GITHUB_API = 'https://api.github.com';
var BACKEND_REPO = 'Antruly/FMS-Service';
var APP_REPO = 'Antruly/FMS-Service-app';

function githubGet(repo, path) {
  return new Promise(function(resolve, reject) {
    var url = GITHUB_API + '/repos/' + repo + '/' + (path || 'releases/latest');
    log.debug('[Upgrade] GitHub API: GET ' + url);
    var parsed = require('url').parse(url);
    var mod = parsed.protocol === 'https:' ? https : http;
    var opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Accept': 'application/vnd.github.v3+json'
      },
      timeout: 15000
    };
    var req = mod.request(opts, function(resp) {
      var buf = [];
      resp.on('data', function(c) { buf.push(c); });
      resp.on('end', function() {
        var body = Buffer.concat(buf).toString('utf-8');
        try {
          var data = JSON.parse(body);
          if (resp.statusCode >= 400) {
            reject(new Error('GitHub API ' + resp.statusCode + ': ' + (data.message || body)));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error('GitHub API 解析失败: ' + body.substring(0, 200)));
        }
      });
    });
    req.on('error', function(e) { reject(e); });
    req.on('timeout', function() { req.destroy(); reject(new Error('GitHub API 超时')); });
    req.end();
  });
}

function compareVersions(v1, v2) {
  // 返回 >0 如果 v1 > v2, <0 如果 v1 < v2, 0 如果相等
  var a = (v1 || '0.0.0').replace(/^v/, '').split('.').map(Number);
  var b = (v2 || '0.0.0').replace(/^v/, '').split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

/**
 * 检查后台版本更新（从 GitHub Releases）
 */
function checkBackendVersion() {
  var pkg = require(path.join(PROJECT_ROOT, 'package.json'));
  var currentVersion = pkg.version || '0.0.0';
  log.info('[Upgrade] 检查后台版本更新，当前: v' + currentVersion);

  return githubGet(BACKEND_REPO, 'releases?per_page=5')
    .then(function(releases) {
      if (!Array.isArray(releases) || releases.length === 0) {
        return { current: currentVersion, latest: currentVersion, hasUpdate: false, releases: [] };
      }
      // 过滤非预发布版本（优先正式版）
      var stable = releases.filter(function(r) { return !r.prerelease; });
      var candidates = stable.length > 0 ? stable : releases;
      var latest = candidates[0];
      var latestVersion = (latest.tag_name || '').replace(/^v/, '');
      var hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      // 找当前版本之后的所有新版本
      var newReleases = candidates.filter(function(r) {
        var rv = (r.tag_name || '').replace(/^v/, '');
        return compareVersions(rv, currentVersion) > 0;
      });

      return {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate: hasUpdate,
        releaseUrl: latest.html_url || '',
        releaseNotes: latest.body || '',
        publishedAt: latest.published_at || '',
        tagName: latest.tag_name || '',
        downloadUrl: (latest.assets && latest.assets.length > 0)
          ? latest.assets[0].browser_download_url
          : (latest.zipball_url || ''),
        newReleases: newReleases.map(function(r) {
          return {
            version: (r.tag_name || '').replace(/^v/, ''),
            notes: r.body || '',
            publishedAt: r.published_at || '',
            downloadUrl: (r.assets && r.assets.length > 0)
              ? r.assets[0].browser_download_url
              : (r.zipball_url || '')
          };
        })
      };
    })
    .catch(function(err) {
      log.error('[Upgrade] 检查后台版本失败: ' + err.message);
      return {
        current: currentVersion,
        latest: '',
        hasUpdate: false,
        error: err.message,
        newReleases: []
      };
    });
}

/**
 * 检查 App 版本更新（从 GitHub App Releases）
 */
function checkAppVersion(latestLocalVersion) {
  log.info('[Upgrade] 检查 App 版本更新');

  return githubGet(APP_REPO, 'releases?per_page=5')
    .then(function(releases) {
      if (!Array.isArray(releases) || releases.length === 0) {
        return { latest: null, hasUpdate: false, releases: [] };
      }
      var stable = releases.filter(function(r) { return !r.prerelease; });
      var candidates = stable.length > 0 ? stable : releases;
      var latest = candidates[0];
      var latestVersion = (latest.tag_name || '').replace(/^v/, '');
      var currentVersion = latestLocalVersion || '0.0.0';
      var hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      return {
        latest: latestVersion,
        hasUpdate: hasUpdate,
        releaseUrl: latest.html_url || '',
        releaseNotes: latest.body || '',
        publishedAt: latest.published_at || '',
        tagName: latest.tag_name || '',
        downloadUrl: (latest.assets && latest.assets.length > 0)
          ? latest.assets[0].browser_download_url
          : (latest.zipball_url || ''),
        allReleases: candidates.map(function(r) {
          return {
            version: (r.tag_name || '').replace(/^v/, ''),
            notes: r.body || '',
            publishedAt: r.published_at || '',
            downloadUrl: (r.assets && r.assets.length > 0)
              ? r.assets[0].browser_download_url
              : (r.zipball_url || '')
          };
        })
      };
    })
    .catch(function(err) {
      log.error('[Upgrade] 检查 App 版本失败: ' + err.message);
      return { latest: null, hasUpdate: false, error: err.message, releases: [] };
    });
}

// ==================== 文件操作工具 ====================

var BACKUP_EXCLUDES = [
  'node_modules', 'files', 'data', 'backups', 'app',
  '.git', 'public/monaco', 'cer', '.env',
  'release', 'screenshots', 'test-results',
  '.claude', 'chromedriver-win64', 'chrome-win64'
];

function shouldExclude(name) {
  return BACKUP_EXCLUDES.indexOf(name) !== -1;
}

/**
 * 递归复制目录（排除特定目录）
 */
function copyDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  var entries = fs.readdirSync(srcDir);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (shouldExclude(entry)) continue;
    var srcPath = path.join(srcDir, entry);
    var destPath = path.join(destDir, entry);
    var stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 备份当前项目文件
 */
function backupProject(backupDir) {
  appendLog('开始备份项目文件到: ' + backupDir);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  copyDirRecursive(PROJECT_ROOT, backupDir);
  appendLog('项目文件备份完成');
  return backupDir;
}

/**
 * 下载文件到本地
 */
function downloadFile(url, destPath) {
  return new Promise(function(resolve, reject) {
    appendLog('下载: ' + url);
    var parsed = require('url').parse(url);
    var mod = parsed.protocol === 'https:' ? https : http;

    // 处理 GitHub 重定向
    var opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'GET',
      headers: getBrowserHeaders(url),
      timeout: 300000  // 5 分钟超时
    };

    function doRequest(requestOpts, redirectCount) {
      if (redirectCount > 5) {
        return reject(new Error('重定向次数过多'));
      }
      var req = mod.request(requestOpts, function(resp) {
        // 处理重定向
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          var redirUrl = resp.headers.location;
          if (redirUrl.startsWith('/')) {
            redirUrl = (parsed.protocol || 'https:') + '//' + parsed.host + redirUrl;
          }
          var redirParsed = require('url').parse(redirUrl);
          var redirOpts = {
            hostname: redirParsed.hostname,
            port: redirParsed.port,
            path: redirParsed.path,
            method: 'GET',
            headers: getBrowserHeaders(redirUrl),
            timeout: 300000
          };
          return doRequest(redirOpts, redirectCount + 1);
        }
        if (resp.statusCode >= 400) {
          return reject(new Error('下载失败 HTTP ' + resp.statusCode));
        }
        var fileStream = fs.createWriteStream(destPath);
        var totalSize = parseInt(resp.headers['content-length'], 10) || 0;
        var downloaded = 0;

        resp.on('data', function(chunk) {
          downloaded += chunk.length;
          if (totalSize > 0) {
            var pct = Math.min(99, Math.round(downloaded / totalSize * 100));
            global.upgradeState.progress = pct;
          }
        });

        resp.pipe(fileStream);
        fileStream.on('finish', function() {
          fileStream.close();
          appendLog('下载完成: ' + Math.round(downloaded / 1024) + ' KB');
          resolve(destPath);
        });
        fileStream.on('error', function(e) { reject(e); });
      });
      req.on('error', function(e) { reject(e); });
      req.on('timeout', function() { req.destroy(); reject(new Error('下载超时')); });
      req.end();
    }

    doRequest(opts, 0);
  });
}

/**
 * 解压 release zip 到目标目录（覆盖）
 */
function extractRelease(zipPath, targetDir) {
  return new Promise(function(resolve, reject) {
    try {
      appendLog('解压: ' + path.basename(zipPath) + ' → ' + targetDir);
      var buf = fs.readFileSync(zipPath);
      var zip = new AdmZip(buf);
      var entries = zip.getEntries();

      // GitHub release zip 通常包含一个顶层目录（如 FMS-Service-1.2.0/）
      // 需要处理这种嵌套
      var topDir = null;
      if (entries.length > 0) {
        var firstEntry = entries[0];
        var slashIdx = firstEntry.entryName.indexOf('/');
        if (slashIdx > 0) {
          var candidate = firstEntry.entryName.substring(0, slashIdx);
          // 检查所有条目是否都在这个目录下
          var allUnder = true;
          for (var i = 0; i < entries.length; i++) {
            if (!entries[i].entryName.startsWith(candidate + '/')) {
              allUnder = false;
              break;
            }
          }
          if (allUnder) {
            topDir = candidate;
            appendLog('检测到嵌套顶层目录: ' + topDir);
          }
        }
      }

      // 提取文件
      var extracted = 0;
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        var entryName = entry.entryName;

        // 如果有顶层目录，剥离它
        if (topDir) {
          if (entryName === topDir + '/') continue; // 跳过目录本身
          entryName = entryName.substring(topDir.length + 1);
        }

        // 跳过排除的目录
        var firstSlash = entryName.indexOf('/');
        var rootName = firstSlash > 0 ? entryName.substring(0, firstSlash) : entryName;
        var skip = false;
        for (var j = 0; j < BACKUP_EXCLUDES.length; j++) {
          if (rootName === BACKUP_EXCLUDES[j] || entryName.startsWith(BACKUP_EXCLUDES[j] + '/')) {
            skip = true;
            break;
          }
        }
        if (skip) {
          appendLog('跳过受保护路径: ' + entryName);
          continue;
        }

        var destPath = path.join(targetDir, entryName);
        if (entry.isDirectory) {
          if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
          }
        } else {
          // 确保父目录存在
          var parentDir = path.dirname(destPath);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.writeFileSync(destPath, entry.getData());
          extracted++;
        }
      }
      appendLog('解压完成: ' + extracted + ' 个文件');
      resolve(extracted);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 运行 npm install（如有 package.json 变化）
 */
function runNpmInstall() {
  return new Promise(function(resolve, reject) {
    appendLog('运行 npm install --production...');
    var exec = require('child_process').exec;
    exec('npm install --production', {
      cwd: PROJECT_ROOT,
      timeout: 300000,
      maxBuffer: 1024 * 1024
    }, function(err, stdout, stderr) {
      if (err) {
        appendLog('npm install 警告: ' + (stderr || err.message));
        // npm install 失败不阻塞升级
        resolve(false);
      } else {
        appendLog('npm install 完成');
        resolve(true);
      }
    });
  });
}

// ==================== 升级流程 ====================

/**
 * 执行升级（异步，通过 setImmediate 链式调用不阻塞事件循环）
 * @param {object} opts - { url?, backupDb?: boolean, versionTo?: string, manualZipPath?: string }
 */
function performUpgrade(opts) {
  opts = opts || {};
  var state = global.upgradeState;

  if (state.active) {
    appendLog('已有升级在进行中，拒绝重复触发');
    return Promise.reject(new Error('已有升级在进行中'));
  }

  state.active = true;
  state.phase = 'draining';
  state.progress = 0;
  state.error = '';
  state.logs = [];
  state.startedAt = new Date().toISOString();
  state.completedAt = null;
  state.versionFrom = require(path.join(PROJECT_ROOT, 'package.json')).version || '0.0.0';
  state.versionTo = opts.versionTo || '';
  state.requestCountAtStart = state.pendingCount;

  // 创建 AsyncTask
  try {
    var db = require('./db');
    var taskId = db.AsyncTask.create(
      'backend_upgrade',
      '后台升级: v' + state.versionFrom + ' → v' + state.versionTo,
      { versionFrom: state.versionFrom, versionTo: state.versionTo, manual: !!opts.manualZipPath }
    );
    db.AsyncTask.start(taskId, 6); // 6 个阶段
    state.taskId = taskId;
    appendLog('AsyncTask 已创建: #' + taskId);
  } catch (e) {
    log.warn('[Upgrade] AsyncTask 创建失败: ' + e.message);
  }

  appendLog('========== 开始升级 ==========');
  appendLog('当前版本: v' + state.versionFrom);
  appendLog('目标版本: v' + state.versionTo);
  appendLog('当前活跃请求: ' + state.requestCountAtStart);

  // 通过 WebSocket 广播升级通知
  try {
    var wsService = require('./ws');
    wsService.broadcast({
      type: 'system_upgrade',
      data: {
        versionFrom: state.versionFrom,
        versionTo: state.versionTo,
        phase: 'draining'
      }
    });
  } catch (e) {}

  var backupDir = '';
  var zipPath = '';
  var steps = ['draining', 'backing_up', 'downloading', 'extracting', 'installing', 'restarting'];
  state.totalSteps = steps.length;
  state.currentStep = 0;

  return new Promise(function(resolve, reject) {
    function runStep(index) {
      if (index >= steps.length) {
        // 完成
        state.phase = 'done';
        state.progress = 100;
        state.completedAt = new Date().toISOString();
        appendLog('========== 升级完成 ==========');
        try {
          var db = require('./db');
          if (state.taskId) db.AsyncTask.complete(state.taskId, 'completed');
        } catch (e) {}
        resolve();
        return;
      }

      state.currentStep = index + 1;
      var phase = steps[index];
      var progress = Math.round((index / steps.length) * 100);
      setPhase(phase, progress, getPhaseLabel(phase));

      function next() {
        setImmediate(function() { runStep(index + 1); });
      }

      switch (phase) {
        case 'draining':
          drainRequests().then(next).catch(function(e) {
            appendLog('排空请求失败（不阻塞升级）: ' + e.message);
            next();
          });
          break;

        case 'backing_up':
          backupAndPrepare(opts).then(function(result) {
            backupDir = result.backupDir;
            zipPath = result.zipPath;
            next();
          }).catch(function(e) {
            state.error = '备份失败: ' + e.message;
            setPhase('error', progress, state.error);
            appendLog('ERROR: ' + state.error);
            reject(e);
          });
          break;

        case 'downloading':
          if (zipPath && fs.existsSync(zipPath)) {
            appendLog('使用已提供的升级包: ' + zipPath);
            next();
          } else if (opts.url) {
            var tmpDir = path.join(PROJECT_ROOT, 'data', 'tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            zipPath = path.join(tmpDir, 'upgrade_' + Date.now() + '.zip');
            downloadFile(opts.url, zipPath).then(function() {
              next();
            }).catch(function(e) {
              state.error = '下载失败: ' + e.message;
              setPhase('error', progress, state.error);
              appendLog('ERROR: ' + state.error);
              reject(e);
            });
          } else {
            state.error = '无下载 URL 且未提供升级包';
            setPhase('error', progress, state.error);
            reject(new Error(state.error));
          }
          break;

        case 'extracting':
          extractRelease(zipPath, PROJECT_ROOT).then(function() {
            // 清理临时 zip
            try { if (zipPath.indexOf('data/tmp') !== -1) fs.unlinkSync(zipPath); } catch (e) {}
            next();
          }).catch(function(e) {
            state.error = '解压失败: ' + e.message;
            setPhase('error', progress, state.error);
            appendLog('ERROR: ' + state.error);
            reject(e);
          });
          break;

        case 'installing':
          runNpmInstall().then(function() {
            next();
          }).catch(function() {
            next(); // 不阻塞
          });
          break;

        case 'restarting':
          restartService();
          // restart 是异步的，不等待完成
          next();
          break;
      }
    }

    setImmediate(function() { runStep(0); });
  });
}

function getPhaseLabel(phase) {
  var labels = {
    'draining': '等待活跃请求完成...',
    'backing_up': '备份项目文件...',
    'downloading': '下载新版本...',
    'extracting': '解压安装文件...',
    'installing': '安装依赖...',
    'restarting': '重启服务...',
    'done': '升级完成',
    'error': '升级出错'
  };
  return labels[phase] || phase;
}

/**
 * 等待活跃请求排空
 */
function drainRequests() {
  return new Promise(function(resolve) {
    var maxWait = 60000; // 最多等待 60 秒
    var checkInterval = 1000;
    var waited = 0;

    function check() {
      var pending = global.upgradeState.pendingCount;
      appendLog('活跃请求: ' + pending);

      if (pending <= 0) {
        appendLog('所有请求已排空');
        resolve();
        return;
      }

      waited += checkInterval;
      if (waited >= maxWait) {
        appendLog('等待超时 (' + (maxWait / 1000) + 's)，强制继续。剩余请求: ' + pending);
        resolve();
        return;
      }

      setTimeout(check, checkInterval);
    }

    check();
  });
}

/**
 * 备份项目 + 可选数据库备份
 */
function backupAndPrepare(opts) {
  return new Promise(function(resolve, reject) {
    try {
      // 可选数据库备份
      if (opts.backupDb) {
        appendLog('执行数据库备份...');
        try {
          var backup = require('./backup');
          var db = require('./db');
          var config = db.BackupConfig.get();
          if (config && config.enabled) {
            backup.performBackup(config, null);
            appendLog('数据库备份已触发');
          }
        } catch (e) {
          appendLog('数据库备份失败（不阻塞升级）: ' + e.message);
        }
      }

      // 备份项目文件
      var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      var backupDir = path.join(PROJECT_ROOT, 'backups', 'upgrade_' + ts);
      backupProject(backupDir);

      resolve({ backupDir: backupDir, zipPath: opts.manualZipPath || '' });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 重启服务（通过 IPC 通知 launcher）
 */
function restartService() {
  appendLog('通知 launcher 重启 worker...');

  // 写入升级完成标记文件（服务重启后前端能读到结果）
  var resultFile = path.join(PROJECT_ROOT, 'data', 'upgrade_result.json');
  try {
    var dir = path.dirname(resultFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({
      completed: true,
      versionFrom: global.upgradeState.versionFrom,
      versionTo: global.upgradeState.versionTo,
      completedAt: new Date().toISOString()
    }), 'utf-8');
    appendLog('升级结果已写入磁盘');
    // 5 分钟后自动清理（避免下次启动误读）
    setTimeout(function() {
      try { if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile); } catch(e) {}
    }, 300000);
  } catch(e) {
    appendLog('写入升级结果失败: ' + e.message);
  }

  // 通过 IPC 发送 restart 消息给 launcher
  if (process.send) {
    process.send({ type: 'restart', reason: 'upgrade' });
  } else {
    // 无 launcher 时，直接退出让 PM2 或手动重启
    appendLog('警告: 未检测到 launcher (process.send 不可用)，将退出进程');
    setTimeout(function() {
      process.exit(0);
    }, 2000);
  }
}

/**
 * 获取升级状态（供 API 使用）
 */
function getStatus() {
  var state = global.upgradeState;
  return {
    active: state.active,
    phase: state.phase,
    progress: state.progress,
    pendingCount: state.pendingCount,
    stepLabel: state.stepLabel,
    error: state.error,
    logs: state.logs.slice(-50), // 返回最近 50 条日志
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    versionFrom: state.versionFrom,
    versionTo: state.versionTo,
    taskId: state.taskId
  };
}

// ==================== 升级配置管理 ====================

var CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'upgrade_config.json');
var DEFAULT_CONFIG = {
  autoDownload: false,       // 检查到新版本后是否自动下载
  autoUpgrade: false,        // 是否启用定时自动升级
  autoUpgradeTime: '03:00',  // 自动升级时间 (HH:MM)
  lastCheck: null            // 上次检查时间
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      var data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      // 合并默认值，确保新增字段存在
      Object.keys(DEFAULT_CONFIG).forEach(function(k) {
        if (!(k in data)) data[k] = DEFAULT_CONFIG[k];
      });
      return data;
    }
  } catch(e) {
    log.error('[Upgrade] 加载配置文件失败: ' + e.message);
  }
  return Object.assign({}, DEFAULT_CONFIG);
}

function saveConfig(updates) {
  try {
    var cfg = loadConfig();
    Object.keys(updates).forEach(function(k) { cfg[k] = updates[k]; });
    var dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    return cfg;
  } catch(e) {
    log.error('[Upgrade] 保存配置失败: ' + e.message);
    return null;
  }
}

/**
 * 启动时版本检查（带超时，不阻塞服务）
 */
function startupVersionCheck() {
  var cfg = loadConfig();
  log.info('[Upgrade] 启动时版本检查...');

  // 10 秒超时，不阻塞启动
  var timedOut = false;
  var timer = setTimeout(function() {
    timedOut = true;
    log.warn('[Upgrade] 启动版本检查超时（10s），已取消');
  }, 10000);

  checkBackendVersion().then(function(result) {
    if (timedOut) return;
    clearTimeout(timer);

    cfg.lastCheck = new Date().toISOString();
    saveConfig({ lastCheck: cfg.lastCheck });

    if (result.hasUpdate) {
      log.info('[Upgrade] 发现新后台版本: v' + result.latest + ' (当前 v' + result.current + ')');
      if (cfg.autoDownload) {
        log.info('[Upgrade] 自动下载已启用，开始下载 v' + result.latest);
        startAutoDownload('backend', result.downloadUrl, result.latest);
      }
      if (cfg.autoUpgrade) {
        // 检查是否到了自动升级时间
        checkAndAutoUpgrade(result, cfg);
      }
    } else {
      log.info('[Upgrade] 后台已是最新版本 v' + result.current);
    }

    // 同样检查 App 版本
    var versionsFile = path.join(PROJECT_ROOT, 'files', 'app', 'versions.json');
    var latestLocal = '0.0.0';
    try {
      if (fs.existsSync(versionsFile)) {
        var versions = JSON.parse(fs.readFileSync(versionsFile, 'utf-8'));
        if (versions.length > 0) latestLocal = versions[versions.length - 1].version;
      }
    } catch(e) {}

    checkAppVersion(latestLocal).then(function(appResult) {
      if (appResult.hasUpdate) {
        log.info('[Upgrade] 发现新 App 版本: v' + appResult.latest);
        if (cfg.autoDownload) {
          log.info('[Upgrade] 自动下载 App v' + appResult.latest);
          startAutoDownload('app', appResult.downloadUrl, appResult.latest, 'FMS-Service-v' + appResult.latest + '.apk');
        }
      }
    }).catch(function() {});
  }).catch(function(err) {
    if (timedOut) return;
    clearTimeout(timer);
    log.warn('[Upgrade] 启动版本检查失败: ' + err.message);
  });
}

/**
 * 定时版本检查（每天 01:00 触发）
 */
function scheduledVersionCheck() {
  var cfg = loadConfig();
  log.info('[Upgrade] 定时版本检查（每日 01:00）');

  cfg.lastCheck = new Date().toISOString();
  saveConfig({ lastCheck: cfg.lastCheck });

  checkBackendVersion().then(function(result) {
    if (result.hasUpdate) {
      log.info('[Upgrade] 定时检查发现新后台版本: v' + result.latest);
      if (cfg.autoDownload) {
        startAutoDownload('backend', result.downloadUrl, result.latest);
      }
      if (cfg.autoUpgrade) {
        checkAndAutoUpgrade(result, cfg);
      }
    } else {
      log.info('[Upgrade] 定时检查：后台已是最新版本');
    }
  }).catch(function(err) {
    log.warn('[Upgrade] 定时版本检查失败: ' + err.message);
  });
}

/**
 * 检查是否应该自动升级（匹配配置的时间窗口）
 */
function checkAndAutoUpgrade(result, cfg) {
  if (!cfg.autoUpgrade || !cfg.autoUpgradeTime) return;

  var now = new Date();
  var currentHM = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

  // 在配置时间的前后 5 分钟内视为匹配（防止定时器偏差）
  var cfgParts = cfg.autoUpgradeTime.split(':');
  var cfgMins = parseInt(cfgParts[0]) * 60 + parseInt(cfgParts[1]);
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var diff = Math.abs(nowMins - cfgMins);

  if (diff <= 5) {
    log.info('[Upgrade] 当前时间 ' + currentHM + ' 匹配自动升级时间 ' + cfg.autoUpgradeTime + '，开始自动升级');

    // 检查是否已下载
    var ds = global.downloadState.backend;
    var zipPath = '';
    if (ds.done && ds.filePath && fs.existsSync(ds.filePath)) {
      zipPath = ds.filePath;
    }

    performUpgrade({
      url: zipPath ? '' : result.downloadUrl,
      versionTo: result.latest,
      backupDb: true,
      manualZipPath: zipPath
    }).then(function() {
      log.info('[Upgrade] 自动升级完成');
    }).catch(function(err) {
      log.error('[Upgrade] 自动升级失败: ' + err.message);
    });
  } else {
    log.info('[Upgrade] 当前时间 ' + currentHM + ' 不匹配自动升级时间 ' + cfg.autoUpgradeTime + '（偏差 ' + diff + ' 分钟），跳过');
  }
}

/**
 * 启动定时版本检查调度器
 */
var _versionCheckTimer = null;
function startVersionCheckScheduler() {
  // 计算到凌晨 1:00 的延迟
  var now = new Date();
  var target = new Date(now);
  target.setHours(1, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  var delay = target.getTime() - now.getTime();
  log.info('[Upgrade] 版本检查调度器已启动，首次在 ' + Math.round(delay / 3600000) + ' 小时后（每日 01:00）');

  _versionCheckTimer = setTimeout(function run() {
    scheduledVersionCheck();
    _versionCheckTimer = setTimeout(run, 24 * 3600000);
  }, delay);
}

// ==================== 导出 ====================

module.exports = {
  checkBackendVersion: checkBackendVersion,
  checkAppVersion: checkAppVersion,
  performUpgrade: performUpgrade,
  getStatus: getStatus,
  compareVersions: compareVersions,
  startAutoDownload: startAutoDownload,
  getDownloadStatus: getDownloadStatus,
  resetDownloadState: resetDownloadState,
  downloadFileWithProgress: downloadFileWithProgress,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  startupVersionCheck: startupVersionCheck,
  scheduledVersionCheck: scheduledVersionCheck,
  startVersionCheckScheduler: startVersionCheckScheduler,
  BACKEND_REPO: BACKEND_REPO,
  APP_REPO: APP_REPO
};
