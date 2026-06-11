/**
 * 存储架构封装 — 流式读写
 *
 * 业务层只需操作流，不关心物理路径和均衡组选择
 *
 * 写入: createWriteStream(relativePath) → { stream, groupId }
 * 读取: createReadStream(relativePath, groupId) → stream
 */
const fs = require('fs');
const path = require('path');
const stream = require('stream');

// 活跃写入计数(按均衡组)，用于 stopping→stopped 判定
var activeWriteCounts = {};

// 按镜像跟踪活跃写入流，用于强制停止
// activePoolWrites[poolId] = [{ stream, filePath, groupId }]
var activePoolWrites = {};

function trackPoolWrite(poolId, ws, filePath, groupId) {
  if (!activePoolWrites[poolId]) activePoolWrites[poolId] = [];
  activePoolWrites[poolId].push({ stream: ws, path: filePath, groupId: groupId });
}

function untrackPoolWrite(poolId, ws) {
  if (!activePoolWrites[poolId]) return;
  activePoolWrites[poolId] = activePoolWrites[poolId].filter(function(w) { return w.stream !== ws; });
  if (activePoolWrites[poolId].length === 0) delete activePoolWrites[poolId];
}

/**
 * 强制停止指定镜像 — 立即终止所有写入流，删除部分文件，标记为已停用
 * @returns {number} 被终止的写入数
 */
function forceStopMirror(poolId) {
  var writes = activePoolWrites[poolId] || [];
  var fs = require('fs');
  var db = require('./db');
  var stopped = 0;

  writes.forEach(function(w) {
    try {
      w.stream.destroy();
      stopped++;
      // 删除未完成的文件
      try { if (fs.existsSync(w.path)) fs.unlinkSync(w.path); } catch(e) {}
      // 递减写入计数
      if (w.groupId != null && activeWriteCounts[w.groupId]) {
        activeWriteCounts[w.groupId] = Math.max(0, (activeWriteCounts[w.groupId] || 1) - 1);
      }
    } catch(e) {}
  });

  delete activePoolWrites[poolId];

  // 标记镜像为已停用+未同步
  db.run("UPDATE storage_pools SET status = 'stopped', sync_status = 'unsynced' WHERE id = ?", [poolId]);
  console.log('[StorageStream] 强制停止镜像#' + poolId + ' 终止' + stopped + '个写入');

  return stopped;
}

/**
 * 获取镜像是否有活跃写入
 */
function hasActivePoolWrites(poolId) {
  return !!(activePoolWrites[poolId] && activePoolWrites[poolId].length > 0);
}

// ==================== 写入 ====================

/**
 * 创建写入流 — 自动选均衡组，同步写入所有镜像
 * @param {string} relativePath - 相对路径如 2026/06/06/uuid.enc
 * @returns {{ stream: Writable, groupId: number }}
 */
function createWriteStream(relativePath) {
  var StoragePool = require('./db').StoragePool;
  var db = require('./db');
  var writeGroup = StoragePool.selectWriteGroup();
  if (!writeGroup) {
    var errStream = new stream.PassThrough();
    var reason = [];
    var allGroups2 = db.query("SELECT group_id, status FROM storage_groups");
    var allPools2 = StoragePool.listAll();
    allGroups2.forEach(function(g) {
      var ap = allPools2.filter(function(p) { return p.group_id === g.group_id && p.status === 'active'; });
      if (g.status !== 'active') reason.push('存储组#' + g.group_id + ' ' + g.status);
      else if (ap.length === 0) reason.push('存储组#' + g.group_id + ' 无活跃镜像');
    });
    var msg = '没有可写入的存储组: ' + (reason.length > 0 ? reason.join('; ') : '请创建存储组并添加镜像');
    setImmediate(function() { errStream.emit('error', new Error(msg)); });
    return { stream: errStream, groupId: null };
  }

  // 检查组级别状态：即使镜像 active，组被停用也不能写入
  var grpStatus = db.get("SELECT status FROM storage_groups WHERE group_id = ?", [writeGroup.group_id]);
  if (grpStatus && grpStatus.status !== 'active') {
    var errStream = new stream.PassThrough();
    setImmediate(function() { errStream.emit('error', new Error('均衡组#' + writeGroup.group_id + ' 已停用，无法写入')); });
    return { stream: errStream, groupId: writeGroup.group_id };
  }

  var groupId = writeGroup.group_id;
  var pools = StoragePool.getWritePathsForGroup(groupId).filter(function(p) {
    return p.status === 'active'; // 只写活跃路径
  });

  // 增加写入计数
  if (!activeWriteCounts[groupId]) activeWriteCounts[groupId] = 0;
  activeWriteCounts[groupId]++;

  // 为每个镜像创建写入流
  var mirrorStreams = [];
  var mainStream = new stream.PassThrough();
  var hasError = false;
  var finishedMirrors = 0;

  pools.forEach(function(pool) {
    var fullPath = path.join(pool.local_path, relativePath);
    var dir = path.dirname(fullPath);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      var ws = fs.createWriteStream(fullPath);
      // 跟踪该镜像的写入
      trackPoolWrite(pool.id, ws, fullPath, groupId);
      ws.on('finish', function() { untrackPoolWrite(pool.id, ws); });
      ws.on('error', function() { untrackPoolWrite(pool.id, ws); });
      mirrorStreams.push({ stream: ws, poolId: pool.id, path: fullPath, mirrorIndex: pool.mirror_index });
    } catch(e) {
      // 该镜像路径无法写入 → 标记降权
      StoragePool.markDegraded(pool.id);
    }
  });

  if (mirrorStreams.length === 0) {
    activeWriteCounts[groupId]--;
    var errStream2 = new stream.PassThrough();
    setImmediate(function() { errStream2.emit('error', new Error('均衡组#' + groupId + ' 无可用写入路径')); });
    return { stream: errStream2, groupId: groupId };
  }

  // Pipe 主写入流到所有镜像流
  mirrorStreams.forEach(function(ms) {
    mainStream.pipe(ms.stream);
    ms.stream.on('error', function(err) {
      if (!hasError) {
        hasError = true;
        // 标记该镜像损坏
        try { StoragePool.markDegraded(ms.poolId); } catch(e) {}
      }
    });
    ms.stream.on('finish', function() {
      finishedMirrors++;
    });
  });

  // 主写入流的关闭事件
  var originalEnd = mainStream.end.bind(mainStream);
  mainStream.end = function(chunk, encoding, callback) {
    originalEnd(chunk, encoding, callback);
    // 所有镜像流也会跟着关闭（pipe 自动处理）
  };

  mainStream.on('finish', function() {
    activeWriteCounts[groupId] = Math.max(0, (activeWriteCounts[groupId] || 1) - 1);
  });
  mainStream.on('error', function() {
    activeWriteCounts[groupId] = Math.max(0, (activeWriteCounts[groupId] || 1) - 1);
  });

  var poolIds = mirrorStreams.map(function(ms) { return ms.poolId; });
  return {
    stream: mainStream,
    groupId: groupId,
    mirrorCount: mirrorStreams.length,
    poolIds: poolIds
  };
}

// ==================== 读取 ====================

/**
 * 创建读取流 — 按权重选择最优可用路径
 * @param {string} relativePath - 相对路径
 * @param {number} groupId - 均衡组ID
 * @returns {Readable}
 */
function createReadStream(relativePath, groupId) {
  var StoragePool = require('./db').StoragePool;
  // 收集所有可访问路径（组内镜像平等，随机选实现并发负载均衡）
  var allPools = StoragePool.listAll().filter(function(p) {
    return p.group_id === groupId && p.status !== 'deleted' && p.status !== 'error';
  });
  var validPaths = [];
  allPools.forEach(function(p) {
    var fullPath = path.join(p.local_path, relativePath);
    try { if (fs.existsSync(fullPath)) validPaths.push(fullPath); } catch(e) {}
  });

  if (validPaths.length > 0) {
    return fs.createReadStream(validPaths[Math.floor(Math.random() * validPaths.length)]);
  }

  // 全部不可用 → 返回错误流
  var errStream = new stream.PassThrough();
  setImmediate(function() {
    errStream.emit('error', new Error('文件不可用: ' + relativePath + ' (均衡组#' + groupId + '所有路径都无法读取)'));
  });
  return errStream;
}

// ==================== 均衡组状态管理 ====================

/**
 * 开始停用均衡组 — 只改存储组状态，不动镜像状态
 * 镜像保持各自的 active/stopped/synced/unsynced 不变
 * 写入由 storage_groups.status 控制，不检查镜像状态
 */
function startStoppingGroup(groupId) {
  var db = require('./db');
  db.run("UPDATE storage_groups SET status = 'stopped' WHERE group_id = ?", [groupId]);
  console.log('[StorageStream] 均衡组#' + groupId + ' → stopped (镜像状态不变)');
}

/**
 * 检查均衡组是否可以切换到已停用（已废弃，保持兼容）
 */
function checkStoppingGroup(groupId) {
  // 组级停用不再需要等待写入，直接改 storage_groups.status 即可
  // 但单个镜像停用时仍需此函数
  if ((activeWriteCounts[groupId] || 0) > 0) return false;
  var db = require('./db');
  db.run("UPDATE storage_pools SET status = 'stopped' WHERE group_id = ? AND status = 'stopping'", [groupId]);
  return true;
}

/**
 * 检查均衡组是否已停用（通过 storage_groups.status）
 */
function isGroupStopped(groupId) {
  var db = require('./db');
  var grp = db.get("SELECT status FROM storage_groups WHERE group_id = ?", [groupId]);
  return grp && grp.status === 'stopped';
}

/**
 * 获取均衡组状态
 */
function getGroupStatus(groupId) {
  var db = require('./db');
  var grp = db.get("SELECT status FROM storage_groups WHERE group_id = ?", [groupId]);
  if (!grp) return 'empty';
  return grp.status;
}

/**
 * 恢复均衡组为活跃
 * 要求至少一个镜像处于活跃状态，否则拒绝启用
 * 启用的镜像保持 synced，未启用的镜像标记为 unsynced（错过写入）
 */
function activateGroup(groupId) {
  var db = require('./db');
  var activeCount = db.get("SELECT COUNT(*) as cnt FROM storage_pools WHERE group_id = ? AND status = 'active'", [groupId]);
  if (!activeCount || activeCount.cnt === 0) {
    return { ok: false, message: '均衡组#' + groupId + ' 没有活跃的镜像，无法启用。请先启用至少一个镜像' };
  }
  db.run("UPDATE storage_groups SET status = 'active' WHERE group_id = ?", [groupId]);
  // 未启用的镜像标记为未同步
  db.run("UPDATE storage_pools SET sync_status = 'unsynced' WHERE group_id = ? AND status != 'active' AND status != 'deleted'", [groupId]);
  console.log('[StorageStream] 均衡组#' + groupId + ' → active (活跃:' + activeCount.cnt + '个, 其他标记unsynced)');
  return { ok: true };
}

module.exports = {
  createWriteStream: createWriteStream,
  createReadStream: createReadStream,
  startStoppingGroup: startStoppingGroup,
  checkStoppingGroup: checkStoppingGroup,
  isGroupStopped: isGroupStopped,
  getGroupStatus: getGroupStatus,
  activateGroup: activateGroup,
  forceStopMirror: forceStopMirror,
  hasActivePoolWrites: hasActivePoolWrites
};
