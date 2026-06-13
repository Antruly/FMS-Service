/**
 * 备份调度器
 * 使用 setTimeout 链模式（与 server.js startFileCleanupScheduler 一致）
 */

var log = require('./log');

var backupTimer = null;

/**
 * 计算到下次触发时间的延迟（毫秒）
 * @param {object} cfg - BackupConfig.get() 返回的配置
 * @returns {number} 毫秒
 */
function calculateDelay(cfg) {
  var now = new Date();
  var timeParts = (cfg.schedule_time || '03:00').split(':');
  var targetHour = parseInt(timeParts[0], 10) || 3;
  var targetMinute = parseInt(timeParts[1], 10) || 0;

  var target = new Date(now);
  target.setHours(targetHour, targetMinute, 0, 0);

  if (cfg.schedule_type === 'daily') {
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }
  } else if (cfg.schedule_type === 'weekly') {
    // schedule_day: 0=周日, 1=周一, ..., 6=周六
    var targetDay = cfg.schedule_day || 0;
    var currentDay = now.getDay();
    var daysUntilTarget = targetDay - currentDay;
    if (daysUntilTarget < 0 || (daysUntilTarget === 0 && target <= now)) {
      daysUntilTarget += 7;
    }
    target.setDate(now.getDate() + daysUntilTarget);
  } else if (cfg.schedule_type === 'monthly') {
    // schedule_day: 1-31
    var targetDate = cfg.schedule_day || 1;
    target.setDate(Math.min(targetDate, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    if (target <= now) {
      // 下个月
      target.setMonth(target.getMonth() + 1);
      target.setDate(Math.min(targetDate, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    }
  }

  var delay = target.getTime() - now.getTime();
  return Math.max(1000, delay); // 至少1秒
}

function startBackupScheduler() {
  var db;
  try { db = require('./db'); } catch(e) {
    log.error('[BackupScheduler] 无法加载数据库模块，30秒后重试');
    backupTimer = setTimeout(startBackupScheduler, 30000);
    return;
  }

  function scheduleNext() {
    try {
      var cfg = db.BackupConfig.get();
      if (!cfg || !cfg.enabled) {
        log.debug('[BackupScheduler] 备份未启用，60秒后重新检查');
        backupTimer = setTimeout(scheduleNext, 60000);
        return;
      }

      var delay = calculateDelay(cfg);
      var nextTime = new Date(Date.now() + delay);
      log.info('[BackupScheduler] 下次备份时间: ' + nextTime.toLocaleString('zh-CN') +
        ' (' + cfg.schedule_type + ' ' + cfg.schedule_time + ')');

      backupTimer = setTimeout(function run() {
        log.info('[BackupScheduler] 定时备份触发');
        try {
          var freshCfg = db.BackupConfig.get();
          if (freshCfg && freshCfg.enabled) {
            var backup = require('./backup');
            var AsyncTask = db.AsyncTask;
            var taskId = AsyncTask.create('db_backup', '定时备份', { scheduled: true });
            AsyncTask.start(taskId, freshCfg.webdav_enabled ? 5 : (freshCfg.compress ? 4 : 3));
            AsyncTask.appendLog(taskId, '=== 定时备份触发 ===', 'info');
            AsyncTask.appendLog(taskId, '时间: ' + new Date().toLocaleString('zh-CN'), 'info');
            AsyncTask.updateProgress(taskId, 0, freshCfg.webdav_enabled ? 5 : (freshCfg.compress ? 4 : 3), 0);
            backup.performBackup(freshCfg, taskId, { scheduled: true });
          }
        } catch(e) {
          log.error('[BackupScheduler] 备份执行异常:', e.message);
        }
        // 执行完后重新计算下次
        scheduleNext();
      }, delay);

    } catch(e) {
      log.error('[BackupScheduler] 调度异常:', e.message);
      backupTimer = setTimeout(scheduleNext, 60000);
    }
  }

  log.info('[BackupScheduler] 备份调度器已启动');
  scheduleNext();
}

function stopBackupScheduler() {
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
  log.info('[BackupScheduler] 备份调度器已停止');
}

module.exports = {
  startBackupScheduler: startBackupScheduler,
  stopBackupScheduler: stopBackupScheduler
};
