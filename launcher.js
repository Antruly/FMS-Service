/**
 * FMS 启动器 — 管理 server.js worker 进程生命周期
 * - 永不退出，作为父进程守护 worker
 * - 收到 worker 的 IPC restart 消息时：杀旧 worker → fork 新 worker
 * - Worker 崩溃时自动重启（限流保护）
 * - 转发系统信号给 worker
 */

var cp = require('child_process');
var path = require('path');

var WORKER_SCRIPT = path.join(__dirname, 'server.js');
var MAX_RESTARTS = 5;       // 60秒内最大重启次数
var RESTART_WINDOW = 60000; // 时间窗口（毫秒）
var RESTART_DELAY = 2000;   // 崩溃后重启等待（毫秒）

var worker = null;
var restartTimestamps = [];
var shuttingDown = false;

function log(msg) {
  var ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log('[Launcher ' + ts + '] ' + msg);
}

function startWorker() {
  if (shuttingDown) return;

  log('启动 worker: ' + WORKER_SCRIPT);
  worker = cp.fork(WORKER_SCRIPT, [], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { IS_LAUNCHER_CHILD: '1' }),
    silent: false,      // worker 的 stdout/stderr 继承父进程
    stdio: 'inherit'    // 直接 pipe 到父进程的 stdio
  });

  worker.on('message', function(msg) {
    if (!msg || !msg.type) return;
    log('收到 IPC: ' + JSON.stringify(msg));

    if (msg.type === 'restart') {
      log('========== 执行升级重启 ==========');
      restartWorker(true);
    } else if (msg.type === 'restart_complete') {
      log('Worker 报告重启完成');
    }
  });

  worker.on('exit', function(code, signal) {
    log('Worker 退出 (code=' + code + ', signal=' + signal + ')');
    worker = null;

    if (shuttingDown) {
      log('正在关闭，不重启');
      return;
    }

    // 限流检查
    var now = Date.now();
    restartTimestamps = restartTimestamps.filter(function(t) { return now - t < RESTART_WINDOW; });
    restartTimestamps.push(now);

    if (restartTimestamps.length > MAX_RESTARTS) {
      log('60秒内崩溃 ' + restartTimestamps.length + ' 次，超过阈值 ' + MAX_RESTARTS + '，停止重启');
      log('请检查错误日志，手动修复后重新启动');
      process.exit(1);
      return;
    }

    // 快速崩溃（如端口占用）用较短延迟重试
    var delay = (code === 1 && !signal) ? 1000 : RESTART_DELAY;
    log('将在 ' + (delay / 1000) + ' 秒后重启 worker...');
    setTimeout(startWorker, delay);
  });

  worker.on('error', function(err) {
    log('Worker 错误: ' + err.message);
  });
}

function restartWorker(isUpgrade) {
  if (!worker) {
    log('无运行中的 worker，直接启动');
    startWorker();
    return;
  }

  var oldWorker = worker;
  worker = null; // 先置空，防止 startWorker 里的 exit 事件触发自动重启

  // 移除旧 worker 的所有监听器，防止重复触发
  oldWorker.removeAllListeners('exit');
  oldWorker.removeAllListeners('error');
  oldWorker.removeAllListeners('message');

  // 给旧 worker 发送关闭信号
  if (isUpgrade) {
    try { oldWorker.send({ type: 'prepare_shutdown' }); } catch (e) {}
  }

  var PORT = process.env.PORT || 88;
  var restartDelay = isUpgrade ? 2500 : 500;
  var killed = false;

  function forceFreePort(isUpgrade, callback) {
    // 仅升级时才强杀占用端口的进程（第一次启动可能是其他正常服务）
    if (!isUpgrade) {
      callback();
      return;
    }
    var cp = require('child_process');
    cp.exec('netstat -ano | findstr ":' + PORT + ' "', { timeout: 5000 }, function(err, stdout) {
      if (!err && stdout) {
        var seen = {};
        stdout.trim().split(/\r?\n/).forEach(function(line) {
          var parts = line.trim().split(/\s+/);
          var pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid) && pid !== '0' && !seen[pid]) {
            seen[pid] = true;
            log('端口 ' + PORT + ' 被 PID ' + pid + ' 占用，强制终止（升级模式）...');
            try { cp.execSync('taskkill /F /PID ' + pid, { timeout: 5000 }); } catch(e) {}
          }
        });
      }
      setTimeout(callback, 1000);
    });
  }

  function doStartNew() {
    if (killed) return;
    killed = true;
    clearTimeout(killTimeout);
    clearTimeout(forceKillTimer);
    log('旧 worker 已退出，等待 ' + (restartDelay / 1000) + ' 秒后启动新 worker');
    setTimeout(function() {
      // 仅升级时强杀占用端口的旧进程（首次启动不能杀，可能是其他服务）
      forceFreePort(isUpgrade, function() {
        log('启动新版本 worker...');
        startWorker();
      });
    }, restartDelay);
  }

  // 正常退出
  oldWorker.once('exit', function() {
    doStartNew();
  });

  // 保底1: 10 秒未退出 → SIGKILL 强杀
  var killTimeout = setTimeout(function() {
    log('旧 worker 未在 10 秒内退出，发送 SIGKILL 强制终止');
    try { oldWorker.kill('SIGKILL'); } catch (e) {}
  }, 10000);

  // 保底2: 15 秒后无论如何启动新 worker（防止 SIGKILL 也无响应）
  var forceKillTimer = setTimeout(function() {
    log('15 秒超时，强制启动新 worker（旧进程可能僵死）');
    doStartNew();
  }, 15000);

  // 发送 SIGTERM，让 worker 优雅关闭
  try { oldWorker.kill('SIGTERM'); } catch (e) {
    log('发送 SIGTERM 失败: ' + e.message + '，直接启动新 worker');
    doStartNew();
  }
}

// ==================== 系统信号处理 ====================

process.on('SIGINT', function() {
  log('收到 SIGINT，优雅关闭...');
  shuttingDown = true;
  if (worker) {
    try { worker.kill('SIGINT'); } catch (e) {}
    setTimeout(function() { process.exit(0); }, 5000);
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', function() {
  log('收到 SIGTERM，优雅关闭...');
  shuttingDown = true;
  if (worker) {
    try { worker.kill('SIGTERM'); } catch (e) {}
    setTimeout(function() { process.exit(0); }, 5000);
  } else {
    process.exit(0);
  }
});

process.on('uncaughtException', function(err) {
  log('Launcher 未捕获异常: ' + err.message);
  log(err.stack);
});

// ==================== 启动 ====================

log('FMS Launcher 启动');
log('工作目录: ' + __dirname);
startWorker();
