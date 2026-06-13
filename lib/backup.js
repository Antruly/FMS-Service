/**
 * 数据库备份模块
 * - 复制数据库文件到备份目录
 * - 可选 zip 压缩
 * - 可选 WebDAV 云同步
 * - 保留策略清理
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var AdmZip = require('adm-zip');

var dbMod = null;

function getDbMod() {
  if (!dbMod) dbMod = require('./db');
  return dbMod;
}

/**
 * 格式化本地时间为文件名安全格式
 */
function formatTimestamp() {
  var now = new Date();
  var yyyy = now.getFullYear();
  var MM = String(now.getMonth() + 1).padStart(2, '0');
  var dd = String(now.getDate()).padStart(2, '0');
  var HH = String(now.getHours()).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  var ss = String(now.getSeconds()).padStart(2, '0');
  return yyyy + '-' + MM + '-' + dd + '_' + HH + '-' + mm + '-' + ss;
}

/**
 * 计算当前数据库文件大小
 */
function getDbFileSize() {
  try {
    var config = require('../config');
    var dbPath = path.resolve(__dirname, '..', config.DB_PATH);
    if (fs.existsSync(dbPath)) {
      return fs.statSync(dbPath).size;
    }
  } catch(e) {}
  return 0;
}

/**
 * 执行备份（作为异步任务）
 * @param {object} config - BackupConfig.get() 返回的配置对象
 * @param {number} taskId - 已创建的 AsyncTask id（可选，不传则自动创建）
 * @returns {object} { taskId, recordId, filename, filePath, success }
 */
function performBackup(config, taskId, opts) {
  // 参数校验
  if (!config || !config.backup_dir) {
    var errMsg = '备份配置无效：' + (config ? '缺少备份目录' : '配置为空');
    console.error('[Backup] ' + errMsg);
    try {
      var dbErr = getDbMod();
      if (taskId) {
        dbErr.AsyncTask.appendLog(taskId, errMsg, 'error');
        dbErr.AsyncTask.complete(taskId, 'error');
      }
    } catch(e) {}
    return { taskId: taskId || 0, fileName: '', filePath: '', error: errMsg };
  }

  var db = getDbMod();
  var AsyncTask = db.AsyncTask;
  var BackupRecord = db.BackupRecord;
  opts = opts || {};
  var isScheduled = !!opts.scheduled;
  var errorMessages = []; // 收集所有错误信息用于邮件

  var ownTask = false;
  if (!taskId) {
    taskId = AsyncTask.create('db_backup', '数据库备份', { config_id: config.id, scheduled: isScheduled });
    ownTask = true;
  }

  var totalSteps = 6; // 步骤0~5共6个阶段
  var step = 0;
  var errors = 0;
  var backupDir = config.backup_dir;
  var timestamp = formatTimestamp();
  var dbFileName = 'fileservice_backup_' + timestamp + '.db';
  var destPath = path.join(backupDir, dbFileName);
  var finalPath = destPath;
  var finalFileName = dbFileName;
  var isCompressed = false;
  var webdavSynced = 0;
  var webdavMessage = '';

  function log(msg, level) {
    AsyncTask.appendLog(taskId, msg, level || 'info');
  }

  function updateProgress() {
    AsyncTask.updateProgress(taskId, step, totalSteps, errors);
  }

  function fail(errMsg, skipEmail) {
    errors++;
    errorMessages.push(errMsg);
    log('备份失败: ' + errMsg, 'error');
    AsyncTask.complete(taskId, 'error');
    try {
      BackupRecord.create({
        filename: finalFileName,
        file_path: finalPath,
        file_size: 0,
        is_compressed: isCompressed ? 1 : 0,
        webdav_synced: webdavSynced,
        webdav_message: webdavMessage,
        status: 'error',
        error_message: errMsg,
        task_id: taskId
      });
    } catch(e) {}
    // 定时备份失败发送邮件通知
    if (isScheduled && !skipEmail) {
      sendBackupAlertEmail('备份任务失败', errorMessages, taskId);
    }
  }

  // 处理流程使用 setImmediate 以避免阻塞
  function processStep() {
    try {
      // Step 1: 确保备份目录存在
      if (step === 0) {
        step = 1;
        updateProgress();
        log('开始备份: 目标目录 ' + backupDir, 'info');
        try { fs.mkdirSync(backupDir, { recursive: true }); } catch(e) {
          return fail('无法创建备份目录: ' + e.message);
        }
        return setImmediate(processStep);
      }

      // Step 2: 复制数据库文件
      if (step === 1) {
        var appCfg = require('../config');
        var dbPath = path.resolve(__dirname, '..', appCfg.DB_PATH);
        if (!fs.existsSync(dbPath)) {
          return fail('数据库文件不存在: ' + dbPath);
        }
        log('复制数据库文件: ' + dbPath + ' -> ' + destPath, 'info');
        try {
          fs.copyFileSync(dbPath, destPath);
          var dbSize = fs.statSync(destPath).size;
          log('数据库复制完成: ' + (dbSize / 1024 / 1024).toFixed(2) + ' MB', 'info');
        } catch(e) {
          return fail('复制数据库文件失败: ' + e.message);
        }
        step = 2;
        updateProgress();
        return setImmediate(processStep);
      }

      // Step 3: 压缩为 zip
      if (step === 2 && config.compress) {
        log('压缩为 ZIP...', 'info');
        try {
          var zip = new AdmZip();
          zip.addLocalFile(destPath);
          var zipPath = destPath.replace(/\.db$/, '.zip');
          zip.writeZip(zipPath);
          // 删除原始 .db 文件
          try { fs.unlinkSync(destPath); } catch(e) {}
          finalPath = zipPath;
          finalFileName = path.basename(zipPath);
          isCompressed = true;
          var zipSize = fs.statSync(zipPath).size;
          log('压缩完成: ' + (zipSize / 1024 / 1024).toFixed(2) + ' MB', 'info');
        } catch(e) {
          return fail('压缩失败: ' + e.message);
        }
        step = 3;
        updateProgress();
        return setImmediate(processStep);
      } else if (step === 2 && !config.compress) {
        step = 3;
        updateProgress();
        return setImmediate(processStep);
      }

      // Step 4: 创建备份记录
      if (step === 3) {
        var fileSize = 0;
        try { fileSize = fs.statSync(finalPath).size; } catch(e) {}
        var recordId = BackupRecord.create({
          filename: finalFileName,
          file_path: finalPath,
          file_size: fileSize,
          is_compressed: isCompressed ? 1 : 0,
          webdav_synced: 0,
          webdav_message: '',
          status: 'completed',
          error_message: '',
          task_id: taskId
        });
        log('备份记录已创建: #' + recordId, 'info');

        if (config.webdav_enabled) {
          step = 4;
          updateProgress();
          return setImmediate(processStep);
        } else {
          step = 5; // 跳到清理
          updateProgress();
          return setImmediate(processStep);
        }
      }

      // Step 5: WebDAV 云同步
      if (step === 4 && config.webdav_enabled) {
        log('开始 WebDAV 云同步: ' + config.webdav_url, 'info');
        webdavPutFile(finalPath, finalFileName, config)
          .then(function() {
            webdavSynced = 1;
            webdavMessage = '同步成功';
            log('WebDAV 云同步完成', 'info');
            // 更新记录
            var lastRecord = BackupRecord.last();
            if (lastRecord) {
              db.run(
                'UPDATE backup_records SET webdav_synced=1, webdav_message=? WHERE id=?',
                [webdavMessage, lastRecord.id]
              );
            }
            step = 5;
            updateProgress();
            setImmediate(processStep);
          })
          .catch(function(err) {
            webdavSynced = -1;
            webdavMessage = err.message;
            errorMessages.push('WebDAV同步: ' + err.message);
            log('WebDAV 同步失败: ' + err.message, 'warn');
            var lastRecord = BackupRecord.last();
            if (lastRecord) {
              db.run(
                'UPDATE backup_records SET webdav_synced=-1, webdav_message=? WHERE id=?',
                [webdavMessage, lastRecord.id]
              );
            }
            step = 5;
            updateProgress();
            setImmediate(processStep);
          });
        return;
      }

      // Step 6: 清理过期备份
      if (step === 5) {
        var retentionDays = config.retention_days || 30;
        log('清理 ' + retentionDays + ' 天前的旧备份...', 'info');
        var purged = purgeOldBackups(backupDir, retentionDays);
        if (purged > 0) {
          log('已清理 ' + purged + ' 个过期备份', 'info');
        } else {
          log('无过期备份需要清理', 'info');
        }

        // 完成
        var finalStatus = errorMessages.length > 0 ? 'error' : 'completed';
        AsyncTask.complete(taskId, finalStatus);
        log('备份完成: ' + finalFileName, 'info');
        log('=== 备份任务结束 ===', 'info');
        // 定时备份：如有部分错误（如WebDAV失败）发送邮件通知
        if (isScheduled && errorMessages.length > 0) {
          sendBackupAlertEmail('备份部分失败', errorMessages, taskId);
        }
        return;
      }
    } catch(e) {
      return fail('备份异常: ' + e.message);
    }
  }

  // 启动流程
  if (ownTask) {
    AsyncTask.start(taskId, totalSteps);
    log('=== 开始数据库备份 ===', 'info');
    log('时间: ' + new Date().toLocaleString('zh-CN'), 'info');
    log('压缩: ' + (config.compress ? '是' : '否') + ' | WebDAV: ' + (config.webdav_enabled ? '是' : '否'), 'info');
    updateProgress();
  }
  setImmediate(processStep);

  return {
    taskId: taskId,
    fileName: finalFileName,
    filePath: finalPath
  };
}

/**
 * 通过 HTTP PUT 上传文件到外部 WebDAV 服务器
 */
function webdavPutFile(localPath, remoteName, config) {
  return new Promise(function(resolve, reject) {
    try {
      var fileBuffer = fs.readFileSync(localPath);
      var url = new URL(config.webdav_url);
      var isHttps = url.protocol === 'https:';
      var transport = isHttps ? https : http;

      // 构建远程路径：URL路径前缀 + webdav_path + 文件名
      var urlPath = (url.pathname || '/').replace(/\/?$/, '/');
      var subPath = (config.webdav_path || '').replace(/^\/+/, '').replace(/\/?$/, '');
      var remotePath = urlPath + (subPath ? subPath + '/' : '') + remoteName;

      var headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileBuffer.length
      };

      // 只有填写了用户名才使用 Basic Auth，否则匿名访问
      var username = (config.webdav_username || '').trim();
      if (username) {
        var password = config.webdav_password || '';
        headers['Authorization'] = 'Basic ' +
          Buffer.from(username + ':' + password).toString('base64');
      }

      var options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: remotePath,
        method: 'PUT',
        headers: headers,
        timeout: 300000 // 5分钟超时
      };

      var req = transport.request(options, function(res) {
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('WebDAV 认证失败 (HTTP ' + res.statusCode + ')'));
          } else {
            reject(new Error('WebDAV 上传失败 (HTTP ' + res.statusCode + '): ' + body.substring(0, 200)));
          }
        });
      });

      req.on('error', function(e) {
        reject(new Error('WebDAV 连接失败: ' + e.message));
      });

      req.on('timeout', function() {
        req.destroy();
        reject(new Error('WebDAV 上传超时'));
      });

      req.write(fileBuffer);
      req.end();
    } catch(e) {
      reject(new Error('WebDAV 上传异常: ' + e.message));
    }
  });
}

/**
 * 清理过期备份文件
 * @param {string} backupDir - 备份目录
 * @param {number} retentionDays - 保留天数
 * @returns {number} 清理数量
 */
function purgeOldBackups(backupDir, retentionDays) {
  var db = getDbMod();
  var cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
  var oldRecords = db.query(
    "SELECT * FROM backup_records WHERE created_at < ?",
    [cutoff]
  );

  var purged = 0;
  oldRecords.forEach(function(r) {
    try {
      if (fs.existsSync(r.file_path)) {
        fs.unlinkSync(r.file_path);
      }
    } catch(e) {
      // 文件可能已被删除
    }
    db.run('DELETE FROM backup_records WHERE id = ?', [r.id]);
    purged++;
  });

  return purged;
}

/**
 * 发送备份失败告警邮件给所有管理员
 * @param {string} subject - 邮件主题后缀
 * @param {string[]} errors - 错误信息列表
 * @param {number} taskId - 任务ID
 */
function sendBackupAlertEmail(subject, errors, taskId) {
  try {
    var db = getDbMod();
    var admins = db.query('SELECT email FROM users WHERE is_admin = 1 AND is_active = 1');
    if (!admins.length) return;

    var emailLib = require('./email');
    var taskUrl = (require('../config').app.baseUrl || 'http://localhost:88') + '/home.html#admin-tasks';
    var timeStr = new Date().toLocaleString('zh-CN');
    var errorListHtml = errors.map(function(e, i) {
      return '<tr><td style="padding:6px 12px;border-bottom:1px solid #334155;color:#ef4444">' + (i + 1) + '. ' + emailLib.escapeHtml(e) + '</td></tr>';
    }).join('');

    var html = '<div style="background:#0f1a2e;color:#d4e5f7;padding:24px;border-radius:12px;max-width:600px;margin:0 auto;font-family:sans-serif">' +
      '<h2 style="color:#ef4444;margin:0 0 16px">⚠ 定时备份告警</h2>' +
      '<p style="color:#7a90b5;margin:0 0 16px">数据库定时备份执行过程中出现以下问题：</p>' +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">' + errorListHtml + '</table>' +
      '<p style="color:#7a90b5;margin:0 0 8px"><strong>时间:</strong> ' + timeStr + '</p>' +
      '<p style="color:#7a90b5;margin:0 0 8px"><strong>任务ID:</strong> #' + taskId + '</p>' +
      '<p style="margin:16px 0 0"><a href="' + taskUrl + '" style="color:#00d4ff;text-decoration:none">查看任务详情 →</a></p>' +
      '<p style="color:#4a6080;font-size:11px;text-align:center;margin:20px 0 0">FMS 文件管理系统 · 定时备份告警</p></div>';

    var fullSubject = '【FMS 告警】数据库备份 - ' + subject;

    function sendNext(idx) {
      if (idx >= admins.length) return;
      emailLib.sendEmail(admins[idx].email, fullSubject, html)
        .then(function() { sendNext(idx + 1); })
        .catch(function(e) {
          console.error('[BackupAlert] 发送邮件失败 (' + admins[idx].email + '):', e.message);
          sendNext(idx + 1);
        });
    }
    sendNext(0);
    console.log('[BackupAlert] 已发送备份告警邮件: ' + admins.map(function(a) { return a.email; }).join(', ') + ' errors=' + errors.length);
  } catch(e) {
    console.error('[BackupAlert] 发送告警邮件异常:', e.message);
  }
}

module.exports = {
  performBackup: performBackup,
  purgeOldBackups: purgeOldBackups,
  webdavPutFile: webdavPutFile,
  getDbFileSize: getDbFileSize,
  formatTimestamp: formatTimestamp
};
