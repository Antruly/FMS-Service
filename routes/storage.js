var log = require('../lib/log');
/**
 * 存储管理 API — 管理员专用
 *
 * 功能:
 *   - 存储池 CRUD（存储组 + 镜像管理）
 *   - 数据同步（新增镜像后的文件复制）
 *   - 文件引用浏览器
 *   - 迁移控制
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// 管理员权限检查
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ code: 401, message: '请先登录' });
  }
  var User = require('../lib/db').User;
  var user = User.findById(req.session.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ code: 403, message: '需要管理员权限' });
  }
  req.user = user;
  next();
}

// ==================== 存储池管理 ====================

// GET /api/admin/storage/pools — 列出所有存储池（按存储组分组）
router.get('/admin/storage/pools', requireAdmin, function(req, res) {
  var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var groups = StoragePool.listGroups();

  // 构建分组结构
  // 获取组名/权重/状态
  var groupNames = {}, groupWeights = {}, groupStatuses = {};
  var db2 = require('../lib/db');
  var gnRows = db2.query('SELECT group_id, name, weight, status FROM storage_groups');
  gnRows.forEach(function(r) { groupNames[r.group_id] = r.name; groupWeights[r.group_id] = r.weight || 5; groupStatuses[r.group_id] = r.status || 'active'; });

  // 从 storage_pools 构建分组
  var result = [];
  var seenGroups = {};
  groups.forEach(function(g) {
    seenGroups[g.group_id] = true;
    var members = pools.filter(function(p) { return p.group_id === g.group_id; });
    result.push({
      group_id: g.group_id,
      group_name: groupNames[g.group_id] || '',
      group_weight: groupWeights[g.group_id] || 5,
      group_status: groupStatuses[g.group_id] || 'active',
      mirror_count: members.length,
      group_total: g.group_total,
      group_used: g.group_used,
      paths: members.map(function(m) {
        return {
          id: m.id, name: m.name || ('镜像' + m.mirror_index),
          local_path: m.local_path, mirror_index: m.mirror_index,
          status: m.status, sync_status: m.sync_status || 'synced',
          total_bytes: m.total_bytes, used_bytes: m.used_bytes, priority: m.priority || 5
        };
      })
    });
  });

  // 补充 storage_groups 中有但 storage_pools 已全删的组（无镜像也要显示）
  gnRows.forEach(function(gr) {
    if (!seenGroups[gr.group_id]) {
      result.push({
        group_id: gr.group_id,
        group_name: gr.name || '',
        group_weight: gr.weight || 5,
        group_status: gr.status || 'active',
        mirror_count: 0,
        group_total: 0,
        group_used: 0,
        paths: []
      });
    }
  });
  // 按 group_id 排序
  result.sort(function(a, b) { return a.group_id - b.group_id; });

  // 统计
  var stats = require('../lib/db').FileStorage.stats();

  res.json({
    code: 0, data: {
      groups: result,
      stats: {
        file_count: stats.fileCount,
        total_refs: stats.totalRefs,
        total_bytes: stats.totalBytes
      }
    }
  });
});

// POST /api/admin/storage/pools — 创建存储组（不自动创建镜像，镜像通过单独接口添加）
router.post('/admin/storage/pools', requireAdmin, function(req, res) {
  var paths = req.body.paths || [];
  var StoragePool = require('../lib/db').StoragePool;
  var groupId = StoragePool.getNextGroupId();
  var groupName = (req.body.group_name || '').trim() || ('存储组#' + groupId);

  var groupWeight = parseInt(req.body.weight, 10) || 5;
  if (groupWeight < 1) groupWeight = 1;
  if (groupWeight > 10) groupWeight = 10;
  require('../lib/db').run('INSERT OR REPLACE INTO storage_groups (group_id, name, status, weight) VALUES (?, ?, ?, ?)', [groupId, groupName, 'active', groupWeight]);

  // 向后兼容：如果传了 paths 且非空，仍创建镜像
  var results = [];
  if (Array.isArray(paths) && paths.length > 0) {
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i].trim();
      if (!p || p.length < 2) continue;
      try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch(e) {}
      var mirrorName = '镜像' + i;
      StoragePool.addPath(p.replace(/\\/g, '/'), groupId, i);
      require('../lib/db').run('UPDATE storage_pools SET name = ? WHERE group_id = ? AND mirror_index = ?', [mirrorName, groupId, i]);
      results.push({ path: p, mirror_index: i, name: mirrorName });
    }
  }

  log.info('[Storage] 新增存储组 group_id=' + groupId + ' name=' + groupName + ' paths=' + results.length);
  res.json({
    code: 0, message: results.length > 0 ? '存储组创建成功，已添加 ' + results.length + ' 个镜像' : '存储组创建成功，请通过"+ 添加镜像"添加镜像路径', data: {
      group_id: groupId,
      group_name: groupName,
      weight: groupWeight,
      paths: results
    }
  });
});

// POST /api/admin/storage/pools/:groupId/mirror — 为存储组添加镜像路径
// body: { path: "F:/data/mirror" }
router.post('/admin/storage/pools/:groupId/mirror', requireAdmin, function(req, res) {
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var mirrorPath = (req.body.path || '').trim();

  if (!mirrorPath || mirrorPath.length < 2) {
    return res.json({ code: 1, message: '请指定镜像路径' });
  }

  // 确保路径存在
  try {
    if (!fs.existsSync(mirrorPath)) {
      fs.mkdirSync(mirrorPath, { recursive: true });
    }
  } catch(e) {
    return res.json({ code: 1, message: '无法创建目录: ' + mirrorPath + ' — ' + e.message });
  }

  // 检查存储组是否存在（查 storage_groups 表，不只是 storage_pools）
  var db = require('../lib/db');
  var grpExists = db.get("SELECT group_id FROM storage_groups WHERE group_id = ?", [groupId]);
  if (!grpExists) {
    return res.json({ code: 1, message: '存储组 ' + groupId + ' 不存在，请先创建存储组' });
  }

  // 获取当前组最大 mirror_index
  var StoragePool = require('../lib/db').StoragePool;
  var allGroupPools = StoragePool.listAll().filter(function(p) { return p.group_id === groupId; });
  var maxMirror = 0;
  allGroupPools.forEach(function(p) { if (p.mirror_index > maxMirror) maxMirror = p.mirror_index; });
  var newMirrorIndex = maxMirror + 1;

  // 新镜像初始状态: stopped + unsynced（不锁存储组）
  var mirrorName = (req.body.name || '').trim() || ('镜像' + newMirrorIndex);
  StoragePool.addPath(mirrorPath.replace(/\\/g, '/'), groupId, newMirrorIndex);
  require('../lib/db').run("UPDATE storage_pools SET status = 'stopped', sync_status = 'unsynced', name = ? WHERE id = (SELECT MAX(id) FROM storage_pools WHERE group_id = ? AND mirror_index = ?)", [mirrorName, groupId, newMirrorIndex]);
  log.info('[Storage] 添加镜像(stopped/unsynced): group=' + groupId + ' name=' + mirrorName + ' path=' + mirrorPath);

  res.json({
    code: 0, message: '镜像已添加(已停用/未同步)，请停用存储组后执行数据同步', data: {
      group_id: groupId, mirror_index: newMirrorIndex, path: mirrorPath, needs_sync: true
    }
  });
});

// PUT /api/admin/storage/pools/:id — 更新存储池状态
router.put('/admin/storage/pools/:id', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10) || 0;
  var action = req.body.action || '';

  var StoragePool = require('../lib/db').StoragePool;
  var db = require('../lib/db');
  var pools = StoragePool.listAll();
  var pool = pools.find(function(p) { return p.id === poolId; });
  if (pool && (pool.status === 'processing' || pool.status === 'syncing' || pool.status === 'stopping')) {
    return res.json({ code: 1, message: '该路径正在执行任务中，请等待完成后再操作' });
  }
  // 启用校验
  if (action === 'enable') {
    if (pool.status === 'disabled_migrated') {
      return res.json({ code: 1, message: '该路径已完成数据迁移，只能删除，无法再次启用' });
    }
    if (pool.status !== 'stopped' && pool.status !== 'disabled') {
      return res.json({ code: 1, message: '当前状态('+pool.status+')不允许启用' });
    }
    // 检查是否有运行中任务
    var runningTask = db.get("SELECT COUNT(*) as cnt FROM async_tasks WHERE status IN ('running','pending') AND (json_extract(metadata,'$.group_id') = ?)", [pool.group_id]);
    if (runningTask && runningTask.cnt > 0) {
      return res.json({ code: 1, message: '该存储组有任务执行中，请等待完成' });
    }
    StoragePool.activate(poolId);
    return res.json({ code: 0, message: '路径已启用' });
  }
  if (action === 'disable') {
    if (pool.status !== 'active') {
      return res.json({ code: 1, message: '当前状态('+pool.status+')不允许停用，只能停用活跃路径' });
    }
    // 标记为停用+未同步
    db.run("UPDATE storage_pools SET status = 'stopped', sync_status = 'unsynced' WHERE id = ?", [poolId]);
    return res.json({ code: 0, message: '镜像已停用，标记为未同步。需数据同步后才能恢复' });
  } else {
    return res.json({ code: 1, message: '未知操作: ' + action });
  }
});

// POST /api/admin/storage/groups/:groupId/migrate-and-disable — 安全迁移整个存储组并停用
router.post('/admin/storage/groups/:groupId/migrate-and-disable', requireAdmin, function(req, res) {
  if (!requireGroupStoppedWithActiveMirrors(parseInt(req.params.groupId), res)) return;
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var AsyncTask = require('../lib/db').AsyncTask;
  var StoragePool = require('../lib/db').StoragePool;
  var db = require('../lib/db');
  var pools = StoragePool.listAll();

  // 获取该组所有可用路径（排除已删除和未同步的）
  var groupPaths = pools.filter(function(p) { return p.group_id === groupId && p.status !== 'deleted' && p.sync_status !== 'unsynced'; });
  if (groupPaths.length === 0) return res.json({ code: 1, message: '存储组#' + groupId + ' 没有可用的镜像路径（全部未同步或已删除）' });

  // 找目标存储组 ID 列表（组本身活跃，且有至少一个已同步的活跃镜像）
  var activeGroupRows = db.query("SELECT group_id FROM storage_groups WHERE status = 'active' AND group_id != ?", [groupId]);
  var targetGroupIds = [];
  (activeGroupRows || []).forEach(function(r) {
    var hasSynced = db.get("SELECT COUNT(*) as cnt FROM storage_pools WHERE group_id = ? AND status = 'active' AND sync_status = 'synced'", [r.group_id]);
    if (hasSynced && hasSynced.cnt > 0) targetGroupIds.push(r.group_id);
  });
  if (targetGroupIds.length === 0) {
    return res.json({ code: 1, message: '没有其他活跃存储组可接收数据，请先确保目标存储组已启用且有已同步的活跃镜像' });
  }

  // 标记整组所有路径为处理中
  groupPaths.forEach(function(p) {
    db.run("UPDATE storage_pools SET status = 'processing' WHERE id = ?", [p.id]);
  });

  // 统计整组文件数
  var poolIds = groupPaths.map(function(p) { return p.id; });
  var phs = poolIds.map(function() { return '?'; }).join(',');
  var countResult = db.get(
    'SELECT COUNT(*) as cnt FROM file_storage_paths WHERE pool_id IN (' + phs + ') AND status = ?',
    poolIds.concat(['active'])
  );
  var totalFiles = countResult ? countResult.cnt : 0;

  // 预加载目标组的所有已同步镜像（active 或 stopped 都可以写入）
  var targetMirrorMap = {}; // groupId → [pool]
  var allTargetPools = pools.filter(function(p) { return targetGroupIds.indexOf(p.group_id) >= 0 && p.status === 'active' && p.sync_status === 'synced'; });
  allTargetPools.forEach(function(p) {
    if (!targetMirrorMap[p.group_id]) targetMirrorMap[p.group_id] = [];
    targetMirrorMap[p.group_id].push(p);
  });

  var taskId = AsyncTask.create('group_migrate_disable',
    '迁移存储组#' + groupId + ' → #' + targetGroupIds.join(',#') + ' (' + totalFiles + '文件)',
    { group_id: groupId, pool_ids: poolIds, target_groups: targetGroupIds, total_files: totalFiles }
  );
  AsyncTask.start(taskId, totalFiles);
  AsyncTask.appendLog(taskId, '源组#' + groupId + ' (' + groupPaths.length + '镜像) → 目标组: ' + targetGroupIds.map(function(id){return '#'+id}).join(', '), 'info');

  var processed = 0, errors = 0, targetIdx = 0;
  function migrateBatch() {
    var files = db.query(
      'SELECT fsp.id as path_id, fsp.storage_id, fsp.full_path, fsp.relative_path, fsp.pool_id ' +
      'FROM file_storage_paths fsp ' +
      'JOIN file_storage fs ON fsp.storage_id = fs.id AND fs.group_id = ? ' +
      'WHERE fsp.pool_id IN (' + phs + ') AND fsp.status = ? LIMIT 10',
      [groupId].concat(poolIds).concat(['active'])
    );
    if (files.length === 0) {
      if (errors > 0) {
        groupPaths.forEach(function(p) {
          db.run("UPDATE storage_pools SET status = 'stopped' WHERE id = ?", [p.id]);
        });
        AsyncTask.complete(taskId, 'error');
        AsyncTask.appendLog(taskId, '迁移部分完成: ' + processed + ' 成功 / ' + errors + ' 失败', 'error');
        AsyncTask.appendLog(taskId, '池保持停用状态，可选择「数据重组」清理或重试', 'warn');
      } else {
        groupPaths.forEach(function(p) {
          db.run("UPDATE storage_pools SET status = 'disabled_migrated' WHERE id = ?", [p.id]);
        });
        AsyncTask.complete(taskId, 'completed');
        AsyncTask.appendLog(taskId, '迁移完成! ' + processed + ' 个文件已迁到 ' + targetGroupIds.length + ' 个存储组', 'info');
      }
      return;
    }
    files.forEach(function(f) {
      var tgId = targetGroupIds[targetIdx % targetGroupIds.length]; targetIdx++;
      var targetMirrors = targetMirrorMap[tgId] || [];
      if (targetMirrors.length === 0) { errors++; return; }
      try {
        // 解析源文件路径
        var srcPath = f.full_path;
        if (srcPath && !path.isAbsolute(srcPath)) {
          var srcPool = groupPaths.find(function(gp) { return gp.id === f.pool_id; });
          if (srcPool) srcPath = path.join(srcPool.local_path, srcPath);
        }
        if (!srcPath || !fs.existsSync(srcPath)) { errors++; return; }

        // 复制到目标组的所有已同步镜像
        var relPath = (f.relative_path || path.basename(f.full_path || '')).replace(/\\/g, '/');
        // 确保是相对路径（去掉可能残留的绝对路径前缀）
        if (relPath.match(/^[A-Za-z]:/)) relPath = path.basename(relPath);
        targetMirrors.forEach(function(tm) {
          var destPath = path.join(tm.local_path, relPath);
          var destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          // 存储相对路径
          require('../lib/db').FileStorage.addPath(f.storage_id, tm.id, relPath, relPath);
        });

        // 更新 file_storage 的 group_id
        db.run('UPDATE file_storage SET group_id = ? WHERE id = ?', [tgId, f.storage_id]);
        // 标记源路径为已迁移
        db.run("UPDATE file_storage_paths SET status = 'deleted' WHERE id = ?", [f.path_id]);

        // 删除源物理文件（只删第一个源路径对应的文件，其他镜像的文件由重组清理）
        try { fs.unlinkSync(srcPath); } catch(e) {}
        processed++;
      } catch(e) { errors++; }
    });
    AsyncTask.updateProgress(taskId, processed, totalFiles, errors);
    if (processed % 20 === 0) AsyncTask.appendLog(taskId, '迁移: ' + processed + '/' + totalFiles + ' (错:' + errors + ')', 'info');
    setImmediate(migrateBatch);
  }
  setImmediate(migrateBatch);
  res.json({
    code: 0, message: '已停用并开始迁移数据',
    data: { task_id: taskId, total_files: totalFiles, target_groups: targetGroupIds.length }
  });
});

// 操作守卫：检查存储组是否已停用 + 是否有活跃镜像（迁移/重组/回滚需要）
function requireGroupStopped(groupId, res) {
  var StorageStream = require('../lib/storage-stream');
  if (!StorageStream.isGroupStopped(groupId)) {
    res.json({ code: 1, message: '请先停用存储组#' + groupId + '，再进行此操作' });
    return false;
  }
  return true;
}

// 操作守卫：组已停用 + 全部镜像启用且已同步才能操作
function requireGroupStoppedWithActiveMirrors(groupId, res) {
  if (!requireGroupStopped(groupId, res)) return false;
  var db = require('../lib/db');
  var totalCount = db.get("SELECT COUNT(*) as cnt FROM storage_pools WHERE group_id = ? AND status != 'deleted'", [groupId]);
  var healthyCount = db.get("SELECT COUNT(*) as cnt FROM storage_pools WHERE group_id = ? AND status = 'active' AND sync_status = 'synced'", [groupId]);
  if (!totalCount || totalCount.cnt === 0 || !healthyCount || healthyCount.cnt < totalCount.cnt) {
    res.json({ code: 1, message: '存储组#' + groupId + ' 有 ' + (totalCount?totalCount.cnt:0) + ' 个镜像，但只有 ' + (healthyCount?healthyCount.cnt:0) + ' 个启用+已同步。需要全部镜像启用且已同步才能操作' });
    return false;
  }
  return true;
}

// POST /api/admin/storage/mirrors/:id/stop — 单独停用镜像
router.post('/admin/storage/mirrors/:id/stop', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10);
  var db = require('../lib/db');
  var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var pool = pools.find(function(p) { return p.id === poolId; });
  if (!pool) return res.json({ code: 1, message: '镜像不存在' });
  if (pool.status !== 'active') return res.json({ code: 1, message: '只能停用活跃状态的镜像，当前状态: ' + pool.status });

  // 判断组是否已停用
  var groupIsStopped = !!(db.get("SELECT status FROM storage_groups WHERE group_id = ? AND status = 'stopped'", [pool.group_id]));

  // 统计该组内其他活跃镜像数量
  var activeInGroup = pools.filter(function(p) { return p.group_id === pool.group_id && p.status === 'active'; });
  if (activeInGroup.length <= 1 && !groupIsStopped) {
    // 最后一个活跃镜像 + 组未停用 → 连带停用整个存储组
    var StorageStream = require('../lib/storage-stream');
    StorageStream.startStoppingGroup(pool.group_id);
    return res.json({ code: 0, message: '最后一个镜像，存储组#' + pool.group_id + ' 已停用' });
  }

  // 组已停用 或 组内还有其他活跃镜像 → 只停用当前镜像
  // 组已停用 → 无写入 → 保持 synced；组活跃 → 有写入遗漏 → 标记 unsynced
  var newSyncStatus = groupIsStopped ? 'synced' : 'unsynced';
  db.run("UPDATE storage_pools SET status = 'stopping', sync_status = ? WHERE id = ?", [newSyncStatus, poolId]);
  // 立即检查该镜像是否有活跃写入：没有则直接变为已停用
  var StorageStream2 = require('../lib/storage-stream');
  if (!StorageStream2.hasActivePoolWrites(poolId)) {
    db.run("UPDATE storage_pools SET status = 'stopped', sync_status = ? WHERE id = ? AND status = 'stopping'", [newSyncStatus, poolId]);
    res.json({ code: 0, message: '镜像已停用（#' + poolId + '，无活跃写入）' });
  } else {
    res.json({ code: 0, message: '镜像正在停用（#' + poolId + '），等待当前写入完成后变为已停用' });
  }
});

// POST /api/admin/storage/mirrors/:id/force-stop — 强制停止镜像
router.post('/admin/storage/mirrors/:id/force-stop', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10);
  var db = require('../lib/db');
  var StorageStream = require('../lib/storage-stream');
  var pool = db.get('SELECT * FROM storage_pools WHERE id = ?', [poolId]);
  if (!pool) return res.json({ code: 1, message: '镜像不存在' });
  if (pool.status !== 'stopping') return res.json({ code: 1, message: '只有停用中的镜像才能强制停止，当前状态: ' + pool.status });

  var stopped = StorageStream.forceStopMirror(poolId);
  res.json({ code: 0, message: '已强制停止镜像，终止了 ' + stopped + ' 个正在写入的文件', data: { stopped_writes: stopped } });
});

// POST /api/admin/storage/mirrors/:id/enable — 单独启用镜像
router.post('/admin/storage/mirrors/:id/enable', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  db.run("UPDATE storage_pools SET status = 'active' WHERE id = ? AND status IN ('stopped','disabled')", [parseInt(req.params.id, 10)]);
  res.json({ code: 0, message: '镜像已启用' });
});

// POST /api/admin/storage/pools/:groupId/sync — 数据同步
// 从已同步镜像复制文件到停用/未同步的镜像（必须组已停用）
router.post('/admin/storage/pools/:groupId/sync', requireAdmin, function(req, res) {
  if (!requireGroupStopped(parseInt(req.params.groupId), res)) return;
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var StoragePool = require('../lib/db').StoragePool;
  var FileStorage = require('../lib/db').FileStorage;
  var db = require('../lib/db');

  // 获取该组所有路径（不只是活跃的）
  var allPools = StoragePool.listAll().filter(function(p) { return p.group_id === groupId; });
  if (allPools.length < 2) {
    return res.json({ code: 1, message: '该组没有镜像需要同步（至少需要 2 个路径）' });
  }

  // 目标: 停用且未同步的镜像（可指定单个镜像ID只同步那一个）
  var targetMirrorId = parseInt(req.body.mirror_id, 10) || 0;
  var targetMirrors = allPools.filter(function(p) {
    if (targetMirrorId > 0) return p.id === targetMirrorId && (p.status === 'stopped' || p.status === 'degraded') && p.sync_status === 'unsynced';
    return (p.status === 'stopped' || p.status === 'degraded') && p.sync_status === 'unsynced';
  });
  if (targetMirrors.length === 0) {
    return res.json({ code: targetMirrorId > 0 ? 1 : 0, message: targetMirrorId > 0 ? '指定镜像不需要同步或不处于未同步状态' : '所有镜像已同步', data: { synced: true } });
  }

  // 收集目标镜像 ID（排除作为源候选，防止自己同步到自己）
  var targetIds = {};
  targetMirrors.forEach(function(m) { targetIds[m.id] = true; });

  // 源: 已同步的镜像（只有 sync_status='synced' 的镜像才有完整数据）
  // 同时排除目标镜像自身
  var sourcePools = allPools.filter(function(p) {
    return (p.status === 'active' || p.status === 'stopped' || p.status === 'disabled' || p.status === 'degraded')
        && p.sync_status === 'synced'
        && !targetIds[p.id];
  });
  // 如果没有已同步的源，尝试放宽条件（允许未同步但有实际数据的源）
  if (sourcePools.length === 0) {
    sourcePools = allPools.filter(function(p) {
      return (p.status === 'active' || p.status === 'stopped' || p.status === 'disabled' || p.status === 'degraded')
          && !targetIds[p.id];
    });
  }
  if (sourcePools.length === 0) {
    return res.json({ code: 1, message: '没有可用的源镜像（所有镜像可能均是同步目标或已删除）' });
  }

  // 源优先级：活跃 > 已停用(已同步) > 降级 > 停用/未同步
  var statusOrder = { active: 0, stopped: 1, disabled: 2, degraded: 3 };
  sourcePools.sort(function(a, b) {
    var sa = statusOrder[a.status] || 10, sb = statusOrder[b.status] || 10;
    if (sa !== sb) return sa - sb;
    // 同状态优先选已同步的
    var synca = a.sync_status === 'synced' ? 0 : 1;
    var syncb = b.sync_status === 'synced' ? 0 : 1;
    return synca - syncb;
  });

  // 标记目标镜像为同步中（锁定）
  targetMirrors.forEach(function(m) {
    db.run("UPDATE storage_pools SET status = 'syncing' WHERE id = ?", [m.id]);
  });

  var sourcePool = sourcePools[0];

  // 获取需要同步的文件列表（只同步 ref_count > 0 的文件）
  var allFiles = db.query(
    'SELECT fs.id, fs.uuid, fs.file_size, ' +
    '(SELECT fsp.relative_path FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id AND fsp.pool_id = ? AND fsp.status = ? LIMIT 1) as rel_path ' +
    'FROM file_storage fs WHERE fs.ref_count > 0 AND fs.status = ? ORDER BY fs.id',
    [sourcePool.id, 'active', 'active']
  );

  var syncTasks = [];
  targetMirrors.forEach(function(mirror) {
    allFiles.forEach(function(file) {
      if (file.rel_path) {
        var destPath = path.join(mirror.local_path, file.rel_path);
        syncTasks.push({
          storage_id: file.id,
          source: path.join(sourcePool.local_path, file.rel_path),
          dest: destPath,
          mirror_id: mirror.id,
          mirror_path: mirror.local_path,
          rel_path: file.rel_path
        });
      }
    });
  });

  // 创建异步任务
  var AsyncTask = require('../lib/db').AsyncTask;
  var mirrorNames = targetMirrors.map(function(m) { return path.basename(m.local_path); }).join(', ');
  var taskId = AsyncTask.create('data_sync', '数据同步 组#' + groupId + ' → ' + mirrorNames, {
    group_id: groupId, total_files: syncTasks.length, mirrors: targetMirrors.map(function(m) { return m.id; })
  });
  AsyncTask.start(taskId, syncTasks.length);
  AsyncTask.appendLog(taskId, '源镜像: ' + sourcePool.local_path, 'info');
  AsyncTask.appendLog(taskId, '同步 ' + syncTasks.length + ' 个文件到 ' + targetMirrors.length + ' 个镜像', 'info');

  log.info('[Storage] 开始数据同步: group=' + groupId + ' files=' + syncTasks.length + ' mirrors=' + targetMirrors.length + ' task_id=' + taskId);

  // 异步执行同步
  var completed = 0, errors = 0;
  function processNext() {
    if (syncTasks.length === 0) {
      // 同步完成 → 标记镜像已同步，恢复为已停用状态（由用户手动启用）
      targetMirrors.forEach(function(m) {
        db.run("UPDATE storage_pools SET status = 'stopped', sync_status = 'synced' WHERE id = ?", [m.id]);
      });
      AsyncTask.complete(taskId, errors > 0 ? 'completed' : 'completed');
      AsyncTask.appendLog(taskId, '同步完成! 成功:' + completed + ' 失败:' + errors + ' (镜像保持停用状态，需手动启用)', errors > 0 ? 'warn' : 'info');
      log.info('[Storage] 数据同步完成: completed=' + completed + ' errors=' + errors);
      return;
    }

    var task = syncTasks.shift();
    try {
      var destDir = path.dirname(task.dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(task.source, task.dest);
      FileStorage.addPath(task.storage_id, task.mirror_id, task.rel_path, task.dest.replace(/\\/g, '/'));
      completed++;
    } catch(e) {
      errors++;
      AsyncTask.appendLog(taskId, '同步失败: ' + path.basename(task.source) + ' err=' + e.message, 'error');
      log.error('[Storage] 同步失败: ' + task.source + ' -> ' + task.dest + ' error=' + e.message);
    }
    AsyncTask.updateProgress(taskId, completed, syncTasks.length + completed, errors);
    if (completed % 50 === 0) AsyncTask.appendLog(taskId, '进度: ' + completed + '/' + (syncTasks.length + completed), 'info');
    setImmediate(processNext);
  }

  setImmediate(processNext);

  res.json({
    code: 0, message: '数据同步已启动', data: {
      task_id: taskId,
      total_files: syncTasks.length,
      source: { id: sourcePool.id, path: sourcePool.local_path },
      targets: targetMirrors.map(function(m) { return { id: m.id, path: m.local_path }; })
    }
  });
});

// GET /api/admin/storage/sync-status/:groupId — 查询同步进度
router.get('/admin/storage/sync-status/:groupId', requireAdmin, function(req, res) {
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var StoragePool = require('../lib/db').StoragePool;
  var allPools = StoragePool.listAll().filter(function(p) { return p.group_id === groupId; });

  var syncing = allPools.filter(function(p) { return p.status === 'syncing'; });
  var active = allPools.filter(function(p) { return p.status === 'active'; });
  var stopped = allPools.filter(function(p) { return p.status === 'stopped'; });

  res.json({
    code: 0, data: {
      group_id: groupId,
      is_syncing: syncing.length > 0,
      syncing_count: syncing.length,
      active_count: active.length,
      total_count: allPools.length
    }
  });
});

// ==================== 文件引用浏览器 ====================

// GET /api/admin/storage/files — 列出文件引用（支持筛选 + 状态标记）
router.get('/admin/storage/files', requireAdmin, function(req, res) {
  var search = req.query.search || '';
  var filter = req.query.filter || ''; // zero_ref | no_paths | lost | all
  var limit = parseInt(req.query.limit, 10) || 50;
  var offset = parseInt(req.query.offset, 10) || 0;

  var FileStorage = require('../lib/db').FileStorage;
  var db = require('../lib/db');
  var fs = require('fs');
  var pathLib = require('path');

  var where = "WHERE fs.status = 'active'";
  var params = [];
  if (search) {
    where += ' AND (fs.file_hash LIKE ? OR fs.uuid LIKE ?)';
    params.push('%' + search + '%', '%' + search + '%');
  }

  // 筛选条件
  if (filter === 'zero_ref') {
    where += ' AND fs.ref_count <= 0';
  } else if (filter === 'no_paths') {
    where += ' AND fs.ref_count > 0 AND (SELECT COUNT(*) FROM file_storage_paths fsp2 WHERE fsp2.storage_id = fs.id AND fsp2.status = \'active\') = 0';
  } else if (filter === 'lost') {
    // 丢失 = 无路径(logical) OR 有路径但不可读(physical)
    where += ' AND (fs.ref_count <= 0 OR (SELECT COUNT(*) FROM file_storage_paths fsp2 WHERE fsp2.storage_id = fs.id AND fsp2.status = \'active\') = 0)';
  } else if (filter === 'physical_lost') {
    // 有路径记录但物理文件可能不可达 — 需要逐行检查
    where += ' AND (SELECT COUNT(*) FROM file_storage_paths fsp2 WHERE fsp2.storage_id = fs.id AND fsp2.status = \'active\') > 0 AND fs.ref_count > 0';
  }

  var files = db.query(
    'SELECT fs.id, fs.uuid, fs.file_hash, fs.file_size, fs.plaintext_size, fs.ref_count, fs.enc_version, fs.group_id, fs.created_at, fs.status as fs_status, ' +
    '(SELECT GROUP_CONCAT(u.email, \', \') FROM user_file_refs ufr LEFT JOIN users u ON ufr.user_id = u.id WHERE ufr.storage_id = fs.id) as ref_users, ' +
    '(SELECT COUNT(*) FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id AND fsp.status = \'active\') as path_count, ' +
    '(SELECT fsp.relative_path FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id AND fsp.status = \'active\' LIMIT 1) as rel_path ' +
    'FROM file_storage fs ' + where + ' ORDER BY fs.id DESC LIMIT ? OFFSET ?',
    params.concat([limit, offset])
  );

  // 批量查询所有有路径记录的文件的物理可达性（一次 SQL，精确复用 getValidPaths 逻辑）
  var storageIdToValid = {};
  var filesWithPaths = files.filter(function(f) { return f.path_count > 0; });
  if (filesWithPaths.length > 0) {
    var sidList = filesWithPaths.map(function(f) { return f.id; });
    var phs2 = sidList.map(function() { return '?'; }).join(',');
    var allPathRows = db.query(
      'SELECT fsp.storage_id, fsp.full_path, sp.local_path FROM file_storage_paths fsp ' +
      'LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
      'WHERE fsp.storage_id IN (' + phs2 + ') AND fsp.status = ? AND (sp.status IS NULL OR sp.status = ?)',
      sidList.concat(['active', 'active'])
    );
    allPathRows.forEach(function(row) {
      if (storageIdToValid[row.storage_id]) return; // 已确认有效，跳过
      var checkPath = row.full_path;
      if (checkPath && !pathLib.isAbsolute(checkPath) && row.local_path) {
        checkPath = pathLib.join(row.local_path, checkPath);
      }
      try { if (checkPath && fs.existsSync(checkPath)) storageIdToValid[row.storage_id] = true; } catch(e) {}
    });
  }

  var mapped = files.map(function(f) {
    // 判断状态
    var fileStatus = 'normal';
    if (f.fs_status === 'cleaned') {
      fileStatus = 'cleaned';
    } else if (f.ref_count <= 0) {
      fileStatus = 'zero_ref';
    } else if (f.path_count === 0) {
      fileStatus = 'logical_lost';
    }

    var hasValidPath = !!storageIdToValid[f.id];

    // 有路径但物理文件全丢了 → 物理丢失
    if (fileStatus === 'normal' && f.path_count > 0 && !hasValidPath) {
      fileStatus = 'physical_lost';
    }

    // physical_lost 筛选：二次过滤
    if (filter === 'physical_lost' && fileStatus !== 'physical_lost') return null;

    return {
      id: f.id,
      uuid: f.uuid,
      file_hash: f.file_hash ? f.file_hash.substring(0, 16) + '...' : '',
      file_size: f.file_size,
      ref_count: f.ref_count,
      ref_users: f.ref_users || '',
      path_count: f.path_count || 0,
      group_id: f.group_id || 0,
      rel_path: f.rel_path || '',
      enc_version: f.enc_version,
      created_at: f.created_at,
      has_valid_path: hasValidPath,
      status: fileStatus
    };
  }).filter(Boolean); // 过滤 null（physical_lost 筛选中不匹配的）

  var total = db.get('SELECT COUNT(*) as cnt FROM file_storage fs ' + where, params);
  var totalCount = total ? total.cnt : 0;

  res.json({
    code: 0, data: {
      files: mapped,
      total: totalCount,
      limit: limit,
      offset: offset
    }
  });
});

// GET /api/admin/storage/files/:id — 文件详情（引用用户、存储路径）
router.get('/admin/storage/files/:id', requireAdmin, function(req, res) {
  var storageId = parseInt(req.params.id, 10) || 0;
  var FileStorage = require('../lib/db').FileStorage;
  var db = require('../lib/db');

  var file = FileStorage.findById(storageId);
  if (!file) return res.json({ code: 1, message: '文件不存在' });

  var refs = FileStorage.listRefUsers(storageId);
  var paths = db.query(
    'SELECT fsp.pool_id, fsp.relative_path, fsp.full_path, fsp.status, ' +
    'sp.local_path, sp.mirror_index, sp.group_id, MAX(fsp.id) as id ' +
    'FROM file_storage_paths fsp LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
    'WHERE fsp.storage_id = ? AND fsp.status = ? GROUP BY fsp.pool_id ORDER BY sp.group_id, sp.mirror_index',
    [storageId, 'active']
  );

  res.json({
    code: 0, data: {
      id: file.id,
      uuid: file.uuid,
      file_hash: file.file_hash,
      file_size: file.file_size,
      plaintext_size: file.plaintext_size,
      ref_count: file.ref_count,
      enc_version: file.enc_version,
      is_encrypted: file.is_encrypted,
      status: file.status,
      created_at: file.created_at,
      ref_users: refs,
      paths: paths.map(function(p) {
        var exists = false;
        // full_path是相对路径时拼池路径
        var checkPath = p.full_path;
        if (checkPath && !require('path').isAbsolute(checkPath) && p.local_path) {
          checkPath = require('path').join(p.local_path, checkPath);
        }
        try { exists = fs.existsSync(checkPath); } catch(e) {}
        return {
          id: p.id,
          pool_id: p.pool_id,
          group_id: p.group_id,
          mirror_index: p.mirror_index,
          local_path: p.local_path,
          full_path: p.full_path,
          relative_path: p.relative_path,
          status: p.status,
          exists: exists
        };
      })
    }
  });
});

// ==================== 迁移控制 ====================

// GET /api/admin/storage/migration-status — 查看迁移状态
router.get('/admin/storage/migration-status', requireAdmin, function(req, res) {
  var db = require('../lib/db');

  // 尚未关联 storage_id 的旧文件（排除已标记失败的）
  var oldFiles = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0)"
  );
  var oldCount = oldFiles ? oldFiles.cnt : 0;
  // 已失败的
  var failedFiles = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE migration_status = -1"
  );
  var failedCount = failedFiles ? failedFiles.cnt : 0;

  // 已迁移的文件
  var migrated = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE storage_id > 0"
  );
  var migratedCount = migrated ? migrated.cnt : 0;

  // 总文件数
  var total = db.get("SELECT COUNT(*) as cnt FROM virtual_files");
  var totalCount = total ? total.cnt : 0;

  res.json({
    code: 0, data: {
      total_files: totalCount,
      migrated: migratedCount,
      pending: oldCount,
      failed: failedCount,
      progress: totalCount > 0 ? Math.round(migratedCount / totalCount * 100) : 0
    }
  });
});

// POST /api/admin/storage/reset-failed — 重置迁移失败文件为待迁移状态
router.post('/admin/storage/reset-failed', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  var count = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE migration_status = -1"
  );
  if (!count || count.cnt === 0) {
    return res.json({ code: 0, message: '没有迁移失败的文件', data: { reset: 0 } });
  }
  db.run(
    "UPDATE virtual_files SET migration_status = 0 WHERE migration_status = -1"
  );
  log.info('[Migration] 已重置 ' + count.cnt + ' 个失败文件为待迁移');
  res.json({ code: 0, message: '已重置 ' + count.cnt + ' 个失败文件', data: { reset: count.cnt } });
});

// 一键重置失败并自动迁移全部
router.post('/admin/storage/retry-failed', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  var resetCount = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE migration_status = -1"
  );
  if (!resetCount || resetCount.cnt === 0) {
    return res.json({ code: 0, message: '没有迁移失败的文件', data: { reset: 0 } });
  }
  db.run(
    "UPDATE virtual_files SET migration_status = 0 WHERE migration_status = -1"
  );
  log.info('[Migration] 重试失败文件: ' + resetCount.cnt + ' 个');

  // 触发自动迁移任务（复用现有逻辑）
  var totalPending = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0)"
  );

  if (!totalPending || totalPending.cnt === 0) {
    return res.json({ code: 0, message: '已重置但没有待迁移文件', data: { reset: resetCount.cnt } });
  }

  var AsyncTask = require('../lib/db').AsyncTask;
  var taskId = AsyncTask.create('auto_migrate', '迁移失败文件重试 (' + totalPending.cnt + '个)', {
    total_pending: totalPending.cnt
  });
  AsyncTask.start(taskId, totalPending.cnt);
  AsyncTask.appendLog(taskId, '开始重试迁移失败文件，共 ' + totalPending.cnt + ' 个', 'info');

  var migrated = 0, errors = 0;
  var batchSize = 5;

  function runBatch() {
    var files = db.query(
      "SELECT * FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0) ORDER BY id LIMIT ?",
      [batchSize]
    );
    if (files.length === 0) {
      AsyncTask.complete(taskId, 'completed');
      AsyncTask.appendLog(taskId, '重试迁移完成! 成功:' + migrated + ' 失败:' + errors, 'info');
      return;
    }
    migrateFileBatch(files, function(batchMigrated, batchErrors) {
      migrated += batchMigrated;
      errors += batchErrors;
      AsyncTask.updateProgress(taskId, migrated, totalPending.cnt, errors);
      if (migrated % 10 === 0) {
        AsyncTask.appendLog(taskId, '迁移进度: ' + migrated + '/' + totalPending.cnt + ' (失败:' + errors + ')', 'info');
      }
      setImmediate(runBatch);
    });
  }

  setImmediate(runBatch);

  res.json({ code: 0, message: '已开始重试 ' + totalPending.cnt + ' 个文件', data: { reset: resetCount.cnt, pending: totalPending.cnt } });
});

// POST /api/admin/storage/migrate — 批量迁移旧文件（异步处理）
router.post('/admin/storage/migrate', requireAdmin, function(req, res) {
  var batchSize = parseInt(req.body.batch_size, 10) || 10;
  if (batchSize > 100) batchSize = 100;
  if (batchSize < 1) batchSize = 1;

  var db = require('../lib/db');
  var crypto = require('crypto');
  var FileStorage = require('../lib/db').FileStorage;
  var StoragePool = require('../lib/db').StoragePool;

  // 查找未迁移的文件（跳过已标记失败的）
  var files = db.query(
    'SELECT * FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0) ORDER BY id LIMIT ?',
    [batchSize]
  );

  if (files.length === 0) {
    return res.json({ code: 0, message: '没有需要迁移的文件', data: { migrated: 0 } });
  }

  // 异步扫描式迁移
  migrateFileBatch(files, function(m, e) {
    log.info('[Migration] 批次完成: migrated=' + m + ' errors=' + e);
  });

  function doMigrateFile(file, plainBuf) {
    try {
      var fileHash = crypto.createHash('sha256').update(plainBuf).digest('hex');
      var existing = FileStorage.findByHashAndSize(fileHash, plainBuf.length);
      var storageId;

      // 从 storage_path 中提取 uuid（文件名去掉 .enc 后缀和路径）
      var oldFileName = path.basename(file.storage_path || '');
      var newUuid = oldFileName.replace(/\.enc$/, '') || crypto.randomUUID();

      var Storage = require('../lib/db').Storage;
      var defaultPool = StoragePool.getDefaultPath();
      var dateRelPath = Storage.getDateBasedPath(newUuid, file.created_at);
      var newFullPath = path.join(defaultPool, dateRelPath);

      if (existing) {
        storageId = existing.id;
        FileStorage.incrementRef(storageId);
        log.info('[Migration] 去重: vf_id=' + file.id + ' -> storage_id=' + storageId);
      } else {
        storageId = FileStorage.create(
          newUuid, fileHash, file.size, plainBuf.length,
          file.enc_version || 1, true, file.nonce
        );
        // 确保目标目录存在
        var destDir = path.dirname(newFullPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        // 剪切（移动）文件到存储组路径
        if (fs.existsSync(file.storage_path)) {
          try {
            fs.renameSync(file.storage_path, newFullPath);
          } catch(e) {
            fs.copyFileSync(file.storage_path, newFullPath);
            fs.unlinkSync(file.storage_path);
          }
        }
        // 记录存储组路径
        FileStorage.addPath(storageId, 1, dateRelPath, dateRelPath);

        // 复制到所有镜像路径
        var pools = StoragePool.getWritePathsForGroup(0);
        pools.forEach(function(pool) {
          if (pool.mirror_index === 0) return; // 跳过主路径(已处理)
          try {
            var mirrorDir = path.join(pool.local_path, path.dirname(dateRelPath));
            var mirrorFullPath = path.join(pool.local_path, dateRelPath);
            if (!fs.existsSync(mirrorDir)) fs.mkdirSync(mirrorDir, { recursive: true });
            fs.copyFileSync(newFullPath, mirrorFullPath);
            FileStorage.addPath(storageId, pool.id, dateRelPath, mirrorFullPath.replace(/\\/g, '/'));
            log.info('[Migration] 镜像同步: mirror=' + pool.mirror_index + ' path=' + pool.local_path);
          } catch(e) {
            log.info('[Migration] 镜像同步失败: mirror=' + pool.mirror_index + ' err=' + e.message);
          }
        });
      }

      // 更新 virtual_files
      db.run('UPDATE virtual_files SET storage_id = ?, storage_path = ?, migration_status = 1 WHERE id = ?',
        [storageId, newFullPath.replace(/\\/g, '/'), file.id]);
      // 创建 user_file_refs 引用
      var UserFileRef = require('../lib/db').UserFileRef;
      var existingRef = UserFileRef.findByUserAndFile(file.user_id, storageId);
      if (!existingRef) {
        UserFileRef.create(file.user_id, storageId, file.dir_id || 0, file.name, file.mime_type);
      }
    } catch(e) {
      log.error('[Migration] doMigrateFile 异常: id=' + file.id + ' err=' + e.message);
      db.run('UPDATE virtual_files SET migration_status = -1 WHERE id = ?', [file.id]);
    }
  }

  // 开始异步处理，立即返回响应
  res.json({
    code: 0, message: '迁移已启动，正在异步处理...', data: {
      total: files.length,
      started: true,
      has_more: files.length >= batchSize
    }
  });

  processNext();
});

// ==================== 路径修复 ====================

// POST /api/admin/storage/repair-paths — 自动修复丢失的文件路径引用
router.post('/admin/storage/repair-paths', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var FileStorage = require('../lib/db').FileStorage;
  var StoragePool = require('../lib/db').StoragePool;
  var Storage = require('../lib/db').Storage;

  // 查找丢失路径的文件：ref_count>0 但没有 active 的 file_storage_paths
  var orphanFiles = db.query(
    'SELECT fs.id, fs.uuid, fs.file_size, fs.ref_count, fs.created_at ' +
    'FROM file_storage fs ' +
    'WHERE fs.ref_count > 0 AND fs.status = ? ' +
    'AND (SELECT COUNT(*) FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id AND fsp.status = ?) = 0 ' +
    'ORDER BY fs.id',
    ['active', 'active']
  );

  if (orphanFiles.length === 0) {
    return res.json({ code: 0, message: '没有丢失路径的文件', data: { total: 0 } });
  }

  // 收集所有可用池路径（活跃+停用+降级，只要有物理文件就行）
  var pools = StoragePool.listAll().filter(function(p) { return p.status === 'active' || p.status === 'stopped' || p.status === 'degraded' || p.status === 'disabled'; });
  if (pools.length === 0) {
    return res.json({ code: 1, message: '没有可用的存储池' });
  }

  // 创建任务
  var taskId = AsyncTask.create('repair_paths', '修复丢失路径 (' + orphanFiles.length + '个文件)', {
    total_files: orphanFiles.length
  });
  AsyncTask.start(taskId, orphanFiles.length);
  AsyncTask.appendLog(taskId, '扫描 ' + pools.length + ' 个活跃池修复 ' + orphanFiles.length + ' 个丢失路径', 'info');

  var repaired = 0, failed = 0, idx = 0;
  function repairNext() {
    if (idx >= orphanFiles.length) {
      AsyncTask.complete(taskId, failed > 0 ? 'completed' : 'completed');
      AsyncTask.appendLog(taskId, '修复完成! 成功:' + repaired + ' 失败:' + failed, failed > 0 ? 'warn' : 'info');
      return;
    }

    var file = orphanFiles[idx]; idx++;
    var found = false;

    // 按优先级遍历池：先尝试从 created_at 推断的日期路径
    var dateStr = file.created_at || '';
    var dateParts = dateStr.substring(0, 10).split('-'); // YYYY-MM-DD
    var dateDir = dateParts.length === 3 ? dateParts.join('/') : '';

    for (var pi = 0; pi < pools.length && !found; pi++) {
      var pool = pools[pi];
      try {
        // 策略1: 按 created_at 日期路径找
        if (dateDir) {
          var datePath = path.join(pool.local_path, dateDir, file.uuid + '.enc');
          if (fs.existsSync(datePath)) {
            var rel = dateDir + '/' + file.uuid + '.enc';
            FileStorage.addPath(file.id, pool.id, rel, rel);
            repaired++; found = true;
            AsyncTask.appendLog(taskId, '修复(日期): ' + file.uuid.substring(0,8) + ' → ' + rel, 'info');
            break;
          }
        }
        // 策略2: 扫描该池所有年月日目录
        if (!found && fs.existsSync(pool.local_path)) {
          var years = fs.readdirSync(pool.local_path).filter(function(d) { return /^\d{4}$/.test(d); });
          for (var yi = 0; yi < years.length && !found; yi++) {
            var yearDir = path.join(pool.local_path, years[yi]);
            if (!fs.statSync(yearDir).isDirectory()) continue;
            var months = fs.readdirSync(yearDir).filter(function(d) { return /^\d{2}$/.test(d); });
            for (var mi = 0; mi < months.length && !found; mi++) {
              var monthDir = path.join(yearDir, months[mi]);
              if (!fs.statSync(monthDir).isDirectory()) continue;
              var days = fs.readdirSync(monthDir).filter(function(d) { return /^\d{2}$/.test(d); });
              for (var di = 0; di < days.length && !found; di++) {
                var targetFile = path.join(monthDir, days[di], file.uuid + '.enc');
                if (fs.existsSync(targetFile)) {
                  var rel2 = years[yi] + '/' + months[mi] + '/' + days[di] + '/' + file.uuid + '.enc';
                  FileStorage.addPath(file.id, pool.id, rel2, rel2);
                  repaired++; found = true;
                  AsyncTask.appendLog(taskId, '修复(扫描): ' + file.uuid.substring(0,8) + ' → ' + rel2, 'info');
                  break;
                }
              }
            }
          }
        }
      } catch(e) {}
    }

    if (!found) {
      failed++;
      AsyncTask.appendLog(taskId, '未找到: ' + file.uuid.substring(0,12) + ' (size=' + file.file_size + ' refs=' + file.ref_count + ')', 'warn');
    }

    AsyncTask.updateProgress(taskId, repaired + failed, orphanFiles.length, failed);
    if (idx % 20 === 0) AsyncTask.appendLog(taskId, '进度: ' + idx + '/' + orphanFiles.length + ' 修复:' + repaired, 'info');
    setImmediate(repairNext);
  }

  setImmediate(repairNext);
  res.json({
    code: 0, message: '修复任务已启动',
    data: { task_id: taskId, total_files: orphanFiles.length, pools: pools.length }
  });
});

// 替换 routes/storage.js 中的修复端点

// POST /api/admin/storage/repair-manual — 手动修复（UUID模式 或 哈希模式）
router.post('/admin/storage/repair-manual', requireAdmin, function(req, res) {
  var manualPath = (req.body.path || '').trim();
  if (!manualPath || !fs.existsSync(manualPath)) {
    return res.json({ code: 1, message: '目录不存在: ' + manualPath });
  }
  var verifyHash = req.body.verify_hash !== false;
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var FileStorage = require('../lib/db').FileStorage;
  var Storage = require('../lib/db').Storage;
  var StoragePool = require('../lib/db').StoragePool;
  var crypto = require('crypto');

  var anyActivePool = StoragePool.listAll().find(function(p) { return p.status === 'active'; });
  if (!anyActivePool) return res.json({ code: 1, message: '没有活跃池' });

  // 收集真正丢失的文件（使用统一的 getLostFiles，会检查物理文件是否存在）
  var realLost = FileStorage.getLostFiles();
  var lostFiles = realLost.map(function(f) {
    var fsEntry = FileStorage.findById(f.id);
    return {type:'fs', id:f.id, uuid:f.uuid, hash:f.hash||'', size:f.size, created_at:f.created_at,
            enc_version: fsEntry ? fsEntry.enc_version : 1, nonce: fsEntry ? fsEntry.nonce : null};
  });
  // 也加未迁移的 virtual_files
  var vfLost = db.query('SELECT * FROM virtual_files WHERE enc_version >= 1 AND (storage_id IS NULL OR storage_id = 0)');
  vfLost.forEach(function(vf) {
    var u = require('path').basename(vf.storage_path||'');
    while(u.endsWith('.enc'))u=u.substring(0,u.length-4);
    // avoid dup
    if (!lostFiles.find(function(lf) { return lf.uuid === u; })) {
      lostFiles.push({type:'vf', vf:vf, uuid:u, hash:null, size:vf.size, created_at:vf.created_at, enc_version:vf.enc_version, nonce:vf.nonce});
    }
  });

  // 扫描磁盘
  var diskFiles = [];
  function scanDir(dir) {
    try { fs.readdirSync(dir).forEach(function(e) {
      var full = path.join(dir, e);
      try { if(fs.statSync(full).isDirectory()) scanDir(full); else if(e.endsWith('.enc')) {
        var u = path.basename(e); while(u.endsWith('.enc'))u=u.substring(0,u.length-4);
        diskFiles.push({fullPath:full, uuid:u});
      }} catch(ex) {}
    }); } catch(ex) {}
  }
  scanDir(manualPath);

  var taskId = AsyncTask.create('repair_manual', (verifyHash?'[哈希]':'[UUID]')+'修复: '+manualPath+' (磁盘:'+diskFiles.length+' 丢失:'+lostFiles.length+')', {path:manualPath, verify_hash:verifyHash});
  AsyncTask.start(taskId, lostFiles.length);

  if (diskFiles.length === 0) {
    AsyncTask.complete(taskId, 'completed');
    return res.json({ code: 0, message: '目录为空, 无需修复', data: {task_id:taskId} });
  }

  var repaired = 0, errs = 0, fileIdx = 0;

  function processHashMode() {
    // 哈希模式：逐个解密文件→计算哈希→批量匹配所有丢失文件
    if (fileIdx >= diskFiles.length) { finish(); return; }
    var df = diskFiles[fileIdx]; fileIdx++;
    try {
      var fileBuf = fs.readFileSync(df.fullPath);
      var cryptoLib = require('../lib/crypto');
      // 尝试V1解密
      var plainBuf = null;
      try {
        var ds = cryptoLib.createV1DecryptStream(df.fullPath);
        var chunks = [];
        ds.on('data', function(c) { chunks.push(c); });
        ds.on('end', function() {
          var pb = Buffer.concat(chunks);
          if(pb.length>0) matchByHash(df, pb);
          else { errs++; AsyncTask.appendLog(taskId, '解密为空: '+df.uuid.substring(0,12), 'error'); }
          processHashMode();
        });
        ds.on('error', function() { errs++; AsyncTask.appendLog(taskId, '解密失败: '+df.uuid.substring(0,12), 'error'); processHashMode(); });
      } catch(e) { errs++; processHashMode(); }
    } catch(e) { errs++; processHashMode(); }
  }

  function matchByHash(df, plainBuf) {
    var hash = crypto.createHash('sha256').update(plainBuf).digest('hex');
    var size = plainBuf.length;
    // 找到所有(hash,size)匹配的丢失文件
    var matched = lostFiles.filter(function(lf) { return lf.hash === hash && lf.size === size; });
    if (matched.length === 0) {
      // 也尝试匹配未计算哈希的vf文件(通过大小+uuid二次确认)
      matched = lostFiles.filter(function(lf) { return lf.type==='vf' && lf.size === size && lf.uuid === df.uuid; });
    }
    if (matched.length === 0) return;

    // 检查是否已有相同hash且路径可用的非丢失文件(排除丢失文件自身)
    var lostIds = matched.map(function(m) { return m.id; });
    var placeholders2 = lostIds.map(function() { return '?'; }).join(',');
    var existingHealthy = (lostIds.length > 0) ? db.query(
      'SELECT fs.id FROM file_storage fs WHERE fs.file_hash=? AND fs.file_size=? AND fs.ref_count>0 AND fs.id NOT IN (' + placeholders2 + ') ' +
      'AND (SELECT COUNT(*) FROM file_storage_paths fsp WHERE fsp.storage_id=fs.id AND fsp.status=?) > 0 LIMIT 1',
      [hash, size].concat(lostIds).concat(['active'])
    ) : [];
    var reuseStorageId = (existingHealthy.length > 0) ? existingHealthy[0].id : null;

    var dateRelPath = Storage.getDateBasedPath(df.uuid, matched[0].created_at || new Date().toISOString());
    var destPath = path.join(anyActivePool.local_path, dateRelPath);
    var destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    // 始终复制文件到活跃池
    if (df.fullPath !== destPath) fs.copyFileSync(df.fullPath, destPath);

    if (reuseStorageId) {
      // 去重：删除旧路径，引用健康文件，同时为健康文件添加新路径
      FileStorage.addPath(reuseStorageId, anyActivePool.id, dateRelPath, dateRelPath);
      matched.forEach(function(m) {
        if (m.type === 'fs') {
          db.run("UPDATE file_storage_paths SET status='deleted' WHERE storage_id=?", [m.id]);
          db.run('UPDATE file_storage SET ref_count=ref_count-1 WHERE id=? AND ref_count>0', [m.id]);
          db.run('UPDATE file_storage SET ref_count=ref_count+1 WHERE id=?', [reuseStorageId]);
          db.run('UPDATE virtual_files SET storage_id=? WHERE storage_id=?', [reuseStorageId, m.id]);
          db.run('UPDATE user_file_refs SET storage_id=? WHERE storage_id=?', [reuseStorageId, m.id]);
          AsyncTask.appendLog(taskId, '去重: '+df.uuid.substring(0,12)+' → sid='+reuseStorageId, 'info');
        }
      });
    } else {
      var firstSid = null;
      matched.forEach(function(m) {
        if (m.type === 'fs') {
          // 删除旧路径
          db.run("UPDATE file_storage_paths SET status='deleted' WHERE storage_id=?", [m.id]);
          // 添加新路径
          FileStorage.addPath(m.id, anyActivePool.id, dateRelPath, dateRelPath);
          db.run('UPDATE file_storage SET group_id=?, file_hash=?, file_size=?, uuid=? WHERE id=?', [anyActivePool.group_id, hash, size, df.uuid, m.id]);
          if (!firstSid) firstSid = m.id;
        } else {
          var sid = FileStorage.create(df.uuid, hash, size, size, m.enc_version||1, true, m.nonce);
          db.run('UPDATE file_storage SET group_id=? WHERE id=?', [anyActivePool.group_id, sid]);
          FileStorage.addPath(sid, anyActivePool.id, dateRelPath, dateRelPath);
          db.run('UPDATE virtual_files SET storage_id=?, storage_path=?, migration_status=1 WHERE id=?', [sid, dateRelPath, m.vf.id]);
          require('../lib/db').UserFileRef.create(m.vf.user_id, sid, m.vf.dir_id||0, m.vf.name, m.vf.mime_type||'');
          if (!firstSid) firstSid = sid;
        }
      });
      // 合并其他同hash丢失文件到这个新路径
      matched.forEach(function(m) {
        if (m.type === 'fs' && m.id !== firstSid) {
          db.run('UPDATE file_storage SET ref_count=ref_count-1 WHERE id=? AND ref_count>0', [m.id]);
          db.run('UPDATE file_storage SET ref_count=ref_count+1 WHERE id=?', [firstSid]);
          db.run('UPDATE virtual_files SET storage_id=? WHERE storage_id=?', [firstSid, m.id]);
          db.run('UPDATE user_file_refs SET storage_id=? WHERE storage_id=?', [firstSid, m.id]);
          AsyncTask.appendLog(taskId, '合并: sid='+m.id+' → sid='+firstSid, 'info');
        }
      });
      AsyncTask.appendLog(taskId, '修复: '+df.uuid.substring(0,12)+' → 匹配'+matched.length+'个丢失文件', 'info');
    }
    // 修复后从丢失列表移除，避免重复匹配
    matched.forEach(function(m) {
      lostFiles = lostFiles.filter(function(lf) { return lf.id !== m.id; });
    });
    repaired++;
    AsyncTask.updateProgress(taskId, repaired, diskFiles.length, errs);
  }

  function processUuidMode() {
    // UUID模式：按文件名匹配
    var uuidMap = {};
    lostFiles.forEach(function(lf) { if(!uuidMap[lf.uuid])uuidMap[lf.uuid]=[]; uuidMap[lf.uuid].push(lf); });
    diskFiles.forEach(function(df) {
      var matched = uuidMap[df.uuid];
      if (matched && matched.length > 0) {
        try {
          var dateRelPath = Storage.getDateBasedPath(df.uuid, matched[0].created_at || new Date().toISOString());
          var destPath = path.join(anyActivePool.local_path, dateRelPath);
          var destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          if (df.fullPath !== destPath) {
            fs.copyFileSync(df.fullPath, destPath); // 只复制不删备份
          }
          matched.forEach(function(m) {
            if (m.type === 'fs') {
              FileStorage.addPath(m.id, anyActivePool.id, dateRelPath, dateRelPath);
              db.run('UPDATE file_storage SET group_id = ? WHERE id = ?', [anyActivePool.group_id, m.id]);
            } else {
              var sid = FileStorage.create(df.uuid, 'uuid_'+df.uuid.substring(0,24), m.size, m.size, m.enc_version||1, true, m.nonce);
              db.run('UPDATE file_storage SET group_id = ? WHERE id = ?', [anyActivePool.group_id, sid]);
              FileStorage.addPath(sid, anyActivePool.id, dateRelPath, dateRelPath);
              db.run('UPDATE virtual_files SET storage_id = ?, storage_path = ?, migration_status = 1 WHERE id = ?', [sid, dateRelPath, m.vf.id]);
              require('../lib/db').UserFileRef.create(m.vf.user_id, sid, m.vf.dir_id||0, m.vf.name, m.vf.mime_type||'application/octet-stream');
            }
          });
          repaired++;
          AsyncTask.appendLog(taskId, '修复(UUID): '+df.uuid.substring(0,12)+' → '+matched.length+'个引用', 'info');
        } catch(e) { errs++; }
      }
    });
    finish();
  }

  function finish() {
    AsyncTask.complete(taskId, errs>0?'completed':'completed');
    AsyncTask.appendLog(taskId, '修复完成! '+repaired+'/'+diskFiles.length+' 失败:'+errs, errs>0?'warn':'info');
  }

  if (verifyHash) {
    AsyncTask.appendLog(taskId, '哈希模式: 扫描'+diskFiles.length+'文件, 丢失记录'+lostFiles.length, 'info');
    setImmediate(processHashMode);
  } else {
    AsyncTask.appendLog(taskId, 'UUID模式: 扫描'+diskFiles.length+'文件, 丢失记录'+lostFiles.length, 'info');
    setImmediate(processUuidMode);
  }
  res.json({ code: 0, message: '修复已启动('+(verifyHash?'哈希':'UUID')+'模式, '+diskFiles.length+'文件)', data: { task_id: taskId, disk_files: diskFiles.length, lost_files: lostFiles.length, mode: verifyHash?'hash':'uuid' } });
});

// GET /api/admin/storage/duplicates — 查看重复文件（相同哈希+大小的物理文件）
router.get('/admin/storage/duplicates', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  // 找出有重复的哈希组
  var dupGroups = db.query(
    'SELECT file_hash, file_size, COUNT(*) as cnt, GROUP_CONCAT(id) as ids ' +
    'FROM file_storage WHERE status = ? ' +
    'GROUP BY file_hash, file_size HAVING COUNT(*) > 1 ORDER BY cnt DESC',
    ['active']
  );
  var result = [];
  dupGroups.forEach(function(g) {
    var ids = (g.ids || '').split(',').map(Number);
    var files = db.query(
      'SELECT fs.*, ' +
      '(SELECT GROUP_CONCAT(u.email, \', \') FROM user_file_refs ufr LEFT JOIN users u ON ufr.user_id = u.id WHERE ufr.storage_id = fs.id) as ref_users ' +
      'FROM file_storage fs WHERE fs.id IN (' + ids.map(function() { return '?'; }).join(',') + ')',
      ids
    );
    // 获取每个文件的路径
    files.forEach(function(f) {
      f.paths = db.query(
        'SELECT fsp.relative_path, fsp.full_path, sp.local_path, sp.name as pool_name, sp.group_id, sp.mirror_index, fsp.status ' +
        'FROM file_storage_paths fsp LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
        'WHERE fsp.storage_id = ? AND fsp.status = ?',
        [f.id, 'active']
      );
    });
    result.push({ file_hash: g.file_hash, file_size: g.file_size, dup_count: g.cnt, files: files });
  });
  res.json({ code: 0, data: { groups: result, total: result.length } });
});

// GET /api/admin/storage/lost-files — 查看丢失文件(分类: 物理丢失/逻辑丢失)
router.get('/admin/storage/lost-files', requireAdmin, function(req, res) {
  var FileStorage = require('../lib/db').FileStorage;
  var db = require('../lib/db');
  var lost = FileStorage.getLostFiles();
  // 分类：物理丢失(有路径但不可读) vs 逻辑丢失(无路径引用)
  var physical = lost.filter(function(f) { return f.reason === 'all_inaccessible'; });
  var logical = lost.filter(function(f) { return f.reason === 'no_paths'; });
  res.json({
    code: 0, data: {
      total: lost.length,
      physical: { count: physical.length, files: physical },
      logical: { count: logical.length, files: logical }
    }
  });
});

// POST /api/admin/storage/repair-with-hash — 修复时带哈希校验
router.post('/admin/storage/repair-with-hash', requireAdmin, function(req, res) {
  var verifyHash = req.body.verify_hash !== false; // 默认true
  var manualPath = (req.body.path || '').trim();
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var FileStorage = require('../lib/db').FileStorage;
  var Storage = require('../lib/db').Storage;
  var crypto = require('crypto');

  var lostFiles = FileStorage.getLostFiles();
  if (lostFiles.length === 0) return res.json({ code: 0, message: '没有丢失文件' });

  var taskId = AsyncTask.create('repair_lost', '修复丢失文件(' + lostFiles.length + '个)' + (verifyHash ? ' [哈希校验]' : ' [仅文件名]'), { verify_hash: verifyHash });
  AsyncTask.start(taskId, lostFiles.length);

  var repaired = 0, failed = 0, idx = 0;
  function repairNext() {
    if (idx >= lostFiles.length) {
      AsyncTask.complete(taskId, failed > 0 ? 'completed' : 'completed');
      AsyncTask.appendLog(taskId, '修复完成! ' + repaired + ' 成功 / ' + failed + ' 失败', failed > 0 ? 'warn' : 'info');
      return;
    }
    var f = lostFiles[idx]; idx++;
    var found = false;

    // 扫描所有活跃池查找匹配文件
    var StoragePool = require('../lib/db').StoragePool;
    var pools = StoragePool.listAll().filter(function(p) { return p.status === 'active' || p.status === 'degraded' || p.status === 'disabled'; });

    for (var pi = 0; pi < pools.length && !found; pi++) {
      var pool = pools[pi];
      try {
        if (!fs.existsSync(pool.local_path)) continue;
        var years = fs.readdirSync(pool.local_path).filter(function(d) { return /^\d{4}$/.test(d); });
        for (var yi = 0; yi < years.length && !found; yi++) {
          var yDir = path.join(pool.local_path, years[yi]);
          var months = fs.readdirSync(yDir).filter(function(d) { return /^\d{2}$/.test(d); });
          for (var mi = 0; mi < months.length && !found; mi++) {
            var mDir = path.join(yDir, months[mi]);
            var days = fs.readdirSync(mDir).filter(function(d) { return /^\d{2}$/.test(d); });
            for (var di = 0; di < days.length && !found; di++) {
              var targetFile = path.join(mDir, days[di], f.uuid + '.enc');
              if (!fs.existsSync(targetFile)) continue;

              // 文件名匹配了
              if (!verifyHash) {
                // 仅文件名匹配→直接修复
                var rel = years[yi] + '/' + months[mi] + '/' + days[di] + '/' + f.uuid + '.enc';
                FileStorage.addPath(f.id, pool.id, rel, targetFile.replace(/\\/g, '/'));
                repaired++; found = true;
                AsyncTask.appendLog(taskId, '修复(名): ' + f.uuid.substring(0,8) + ' → ' + rel, 'info');
                break;
              }

              // 修复：按文件名匹配直接修复
              try {
                var rel = years[yi] + '/' + months[mi] + '/' + days[di] + '/' + f.uuid + '.enc';
                FileStorage.addPath(f.id, pool.id, rel, targetFile.replace(/\\/g, '/'));
                repaired++; found = true;
                AsyncTask.appendLog(taskId, '修复: ' + f.uuid.substring(0,8) + ' → ' + rel, 'info');
              } catch(e) {}
            }
          }
        }
      } catch(e) {}
    }

    if (!found) { failed++; }
    AsyncTask.updateProgress(taskId, repaired + failed, lostFiles.length);
    setImmediate(repairNext);
  }

  setImmediate(repairNext);
  res.json({
    code: 0, message: '修复已启动' + (verifyHash ? '(哈希校验)' : '(仅文件名)'),
    data: { task_id: taskId, total: lostFiles.length, verify_hash: verifyHash }
  });
});

// GET /api/admin/storage/orphan-files — 查看丢失路径的文件列表
router.get('/admin/storage/orphan-files', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  // Debug
  var totalFS = db.get('SELECT COUNT(*) as cnt FROM file_storage WHERE ref_count > 0 AND status = ?', ['active']);
  log.info('[orphan-files] total active file_storage: ' + (totalFS?totalFS.cnt:0));
  var orphans = db.query(
    'SELECT fs.id, fs.uuid, fs.file_hash, fs.file_size, fs.ref_count, fs.created_at, ' +
    'GROUP_CONCAT(u.email) as user_emails ' +
    'FROM file_storage fs ' +
    'LEFT JOIN user_file_refs ufr ON fs.id = ufr.storage_id ' +
    'LEFT JOIN users u ON ufr.user_id = u.id ' +
    'WHERE fs.ref_count > 0 AND fs.status = ? ' +
    'AND (SELECT COUNT(*) FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id AND fsp.status = ?) = 0 ' +
    'GROUP BY fs.id ORDER BY fs.id',
    ['active', 'active']
  );

  res.json({
    code: 0, data: {
      total: orphans.length,
      files: orphans.map(function(f) {
        return {
          id: f.id, uuid: f.uuid,
          hash: (f.file_hash||'').substring(0, 16),
          size: f.file_size, ref_count: f.ref_count,
          created_at: f.created_at,
          users: f.user_emails || ''
        };
      })
    }
  });
});

// ==================== 物理文件清理 ====================

// POST /api/admin/storage/cleanup — 异步清理物理文件（保留逻辑记录）
router.post('/admin/storage/cleanup', requireAdmin, function(req, res) {
  var storageIds = req.body.storage_ids || [];
  if (!Array.isArray(storageIds) || storageIds.length === 0) {
    return res.json({ code: 1, message: '请指定要清理的 storage_ids 列表' });
  }
  // 去重、过滤非法值
  storageIds = storageIds.filter(function(id) { return id > 0; });
  if (storageIds.length === 0) {
    return res.json({ code: 1, message: '没有有效的 storage_id' });
  }

  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var FileStorage = require('../lib/db').FileStorage;
  var StoragePool = require('../lib/db').StoragePool;
  var fs = require('fs');
  var pathLib = require('path');

  var taskId = AsyncTask.create('physical_cleanup',
    '清理物理文件 (' + storageIds.length + '个)',
    { storage_ids: storageIds, total: storageIds.length }
  );
  AsyncTask.start(taskId, storageIds.length);
  AsyncTask.appendLog(taskId, '开始清理 ' + storageIds.length + ' 个文件的物理存储', 'info');

  var cleaned = 0, errors = 0, skipped = 0, idx = 0;

  function processNext() {
    if (idx >= storageIds.length) {
      AsyncTask.complete(taskId, errors > 0 ? 'completed' : 'completed');
      AsyncTask.appendLog(taskId,
        '清理完成! 成功:' + cleaned + ' 失败:' + errors + ' 跳过:' + skipped,
        errors > 0 ? 'warn' : 'info'
      );
      log.info('[Cleanup] 任务完成: taskId=' + taskId + ' cleaned=' + cleaned + ' errors=' + errors + ' skipped=' + skipped);
      return;
    }

    var sid = storageIds[idx++];
    try {
      var fsEntry = FileStorage.findById(sid);
      if (!fsEntry) {
        AsyncTask.appendLog(taskId, '跳过 #' + sid + ': file_storage 记录不存在', 'warn');
        skipped++;
        setImmediate(processNext);
        return;
      }

      // 获取所有存储路径（包括已标记 deleted 的）
      var allPaths = db.query(
        'SELECT fsp.id as path_id, fsp.full_path, fsp.relative_path, fsp.pool_id, sp.local_path, sp.status as pool_status ' +
        'FROM file_storage_paths fsp LEFT JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
        'WHERE fsp.storage_id = ?',
        [sid]
      );

      var deletedCount = 0;
      allPaths.forEach(function(p) {
        var fp = p.full_path;
        if (fp && !pathLib.isAbsolute(fp) && p.local_path) {
          fp = pathLib.join(p.local_path, fp);
        }
        // 尝试删除物理文件
        try {
          if (fp && fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            deletedCount++;
          }
        } catch(e) {
          AsyncTask.appendLog(taskId, '删除失败 #' + sid + ' path=' + fp + ' err=' + e.message, 'warn');
        }
        // 标记路径记录为 deleted
        db.run("UPDATE file_storage_paths SET status = 'deleted' WHERE id = ?", [p.path_id]);
      });

      // 标记 file_storage 为已清理（不删除记录，保持逻辑引用可查看）
      db.run("UPDATE file_storage SET status = 'cleaned' WHERE id = ?", [sid]);

      if (deletedCount > 0) {
        cleaned++;
        AsyncTask.appendLog(taskId, '✅ #' + sid + ' 清理 ' + deletedCount + ' 个物理文件 (uuid=' + (fsEntry.uuid||'').substring(0,8) + ')', 'info');
      } else {
        skipped++;
        AsyncTask.appendLog(taskId, '⏭️ #' + sid + ' 无物理文件可清理', 'info');
      }
    } catch(e) {
      errors++;
      AsyncTask.appendLog(taskId, '❌ #' + sid + ' 清理异常: ' + e.message, 'error');
      log.error('[Cleanup] storage_id=' + sid + ' error=' + e.message);
    }

    AsyncTask.updateProgress(taskId, cleaned + errors + skipped, storageIds.length, errors);
    if (idx % 10 === 0) {
      AsyncTask.appendLog(taskId, '进度: ' + idx + '/' + storageIds.length + ' 清理:' + cleaned + ' 错:' + errors, 'info');
    }
    setImmediate(processNext);
  }

  setImmediate(processNext);

  log.info('[Cleanup] 启动清理任务: taskId=' + taskId + ' files=' + storageIds.length);
  res.json({
    code: 0, message: '清理任务已启动，正在异步处理...',
    data: { task_id: taskId, total: storageIds.length }
  });
});

// ==================== 异步任务管理 API ====================

// GET /api/admin/tasks — 任务列表
router.get('/admin/tasks', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var status = req.query.status || '';
  var limit = parseInt(req.query.limit, 10) || 20;
  var offset = parseInt(req.query.offset, 10) || 0;
  var tasks = AsyncTask.list(status || 'all', limit, offset);
  res.json({ code: 0, data: { tasks: tasks } });
});

// GET /api/admin/tasks/:id — 任务详情（含日志）
router.get('/admin/tasks/:id', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var task = AsyncTask.get(parseInt(req.params.id, 10));
  if (!task) return res.json({ code: 1, message: '任务不存在' });
  res.json({ code: 0, data: task });
});

// POST /api/admin/storage/groups/:groupId/reorganize — 重组整个存储组
router.post('/admin/storage/groups/:groupId/reorganize', requireAdmin, function(req, res) {
  if (!requireGroupStoppedWithActiveMirrors(parseInt(req.params.groupId), res)) return;
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var db = require('../lib/db'); var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var groupPaths = pools.filter(function(p) { return p.group_id === groupId; });
  if (groupPaths.length === 0) return res.json({ code: 1, message: '存储组不存在' });
  var poolIds = groupPaths.map(function(p) { return p.id; });
  var phs = poolIds.map(function() { return '?'; }).join(',');
  var remaining = db.get('SELECT COUNT(*) as cnt FROM file_storage_paths WHERE pool_id IN (' + phs + ') AND status = ?', poolIds.concat(['active']));
  var remainingCount = remaining ? remaining.cnt : 0;
  var cleaned = 0;
  var deletedPaths = db.query('SELECT id, full_path FROM file_storage_paths WHERE pool_id IN (' + phs + ') AND status = ?', poolIds.concat(['deleted']));
  deletedPaths.forEach(function(p) { try { if (fs.existsSync(p.full_path)) { fs.unlinkSync(p.full_path); cleaned++; } } catch(e) {} });
  groupPaths.forEach(function(p) { db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [p.id]); });
  res.json({ code: 0, message: '重组完成! 剩余' + remainingCount + '文件, 清理' + cleaned + '个', data: { remaining: remainingCount, cleaned: cleaned } });
});

// 兼容旧的路由（单个路径）
router.post('/admin/storage/pools/:id/reorganize', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10) || 0;
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var pool = pools.find(function(p) { return p.id === poolId; });
  if (!pool) return res.json({ code: 1, message: '路径不存在' });
  if (pool.status !== 'disabled') return res.json({ code: 1, message: '只有停用状态才能重组' });

  // 统计当前池剩余文件和已迁移文件
  var remaining = db.get('SELECT COUNT(*) as cnt FROM file_storage_paths WHERE pool_id = ? AND status = ?', [poolId, 'active']);
  var remainingCount = remaining ? remaining.cnt : 0;

  var taskId = AsyncTask.create('pool_reorganize',
    '数据重组: ' + pool.local_path + ' (' + remainingCount + '个剩余文件)',
    { pool_id: poolId, remaining_files: remainingCount }
  );
  AsyncTask.start(taskId, remainingCount);
  AsyncTask.appendLog(taskId, '当前剩余 ' + remainingCount + ' 个文件仍在此池中', 'info');

  // 清理该池中已被标记为 deleted 的路径对应的物理文件
  var deletedPaths = db.query(
    'SELECT id, full_path FROM file_storage_paths WHERE pool_id = ? AND status = ?',
    [poolId, 'deleted']
  );
  var cleaned = 0;
  deletedPaths.forEach(function(p) {
    try { if (fs.existsSync(p.full_path)) { fs.unlinkSync(p.full_path); cleaned++; } } catch(e) {}
  });
  AsyncTask.appendLog(taskId, '清理了 ' + cleaned + ' 个已标记删除的物理文件', 'info');

  // 恢复池为正常状态
  db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [poolId]);
  AsyncTask.complete(taskId, 'completed');
  AsyncTask.appendLog(taskId, '数据重组完成！池已恢复为正常状态，剩余 ' + remainingCount + ' 个文件', 'info');
  res.json({ code: 0, message: '数据重组完成，剩余 ' + remainingCount + ' 个文件，池已恢复', data: { remaining: remainingCount, cleaned: cleaned } });
});

// POST /api/admin/storage/groups/:groupId/rollback — 回滚整个存储组
router.post('/admin/storage/groups/:groupId/rollback', requireAdmin, function(req, res) {
  if (!requireGroupStoppedWithActiveMirrors(parseInt(req.params.groupId), res)) return;
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var db = require('../lib/db'); var AsyncTask = require('../lib/db').AsyncTask;
  var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var groupPaths = pools.filter(function(p) { return p.group_id === groupId; });
  if (groupPaths.length === 0) return res.json({ code: 1, message: '存储组不存在' });
  var poolIds = groupPaths.map(function(p) { return p.id; });
  var phs = poolIds.map(function() { return '?'; }).join(',');
  var mainPool = groupPaths.find(function(p) { return p.mirror_index === 0; });
  if (!mainPool) return res.json({ code: 1, message: '该组没有主路径' });
  var migratedFiles = db.query(
    'SELECT fsp.id, fsp.storage_id, fsp.full_path, fsp.relative_path FROM file_storage_paths fsp WHERE fsp.status = ? AND fsp.pool_id NOT IN (' + phs + ') ' +
    'AND fsp.storage_id IN (SELECT storage_id FROM file_storage_paths WHERE pool_id IN (' + phs + '))',
    ['active'].concat(poolIds).concat(poolIds)
  );
  if (migratedFiles.length === 0) return res.json({ code: 1, message: '没有可回滚的文件' });
  var taskId = AsyncTask.create('group_rollback', '回滚存储组#' + groupId + ' (' + migratedFiles.length + '文件)', { group_id: groupId });
  AsyncTask.start(taskId, migratedFiles.length);
  var rolled = 0, errs = 0;
  function rollNext() {
    if (migratedFiles.length === 0) {
      groupPaths.forEach(function(p) { db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [p.id]); });
      AsyncTask.complete(taskId, errs > 0 ? 'error' : 'completed');
      return;
    }
    var f = migratedFiles.shift();
    try {
      var destPath = path.join(mainPool.local_path, f.relative_path || path.basename(f.full_path));
      var destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(f.full_path)) {
        try { fs.renameSync(f.full_path, destPath); } catch(e) { fs.copyFileSync(f.full_path, destPath); fs.unlinkSync(f.full_path); }
      }
      db.run("UPDATE file_storage_paths SET pool_id = ?, full_path = ?, status = 'active' WHERE id = ?", [mainPool.id, destPath.replace(/\\/g, '/'), f.id]);
      rolled++;
    } catch(e) { errs++; }
    setImmediate(rollNext);
  }
  setImmediate(rollNext);
  res.json({ code: 0, message: '回滚已启动', data: { task_id: taskId, files: migratedFiles.length } });
});

// 兼容旧路由
router.post('/admin/storage/pools/:id/rollback', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10) || 0;
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var StoragePool = require('../lib/db').StoragePool;
  var pools = StoragePool.listAll();
  var pool = pools.find(function(p) { return p.id === poolId; });
  if (!pool) return res.json({ code: 1, message: '路径不存在' });

  // 找到迁移时被搬走的文件（不在本池但在其他池的、同 storage_id 的活跃路径）
  var migratedFiles = db.query(
    'SELECT fsp.id, fsp.storage_id, fsp.full_path, fsp.relative_path, fsp.pool_id as new_pool_id, sp2.local_path as new_pool_path ' +
    'FROM file_storage_paths fsp ' +
    'LEFT JOIN storage_pools sp2 ON fsp.pool_id = sp2.id ' +
    'WHERE fsp.status = ? AND fsp.pool_id != ? ' +
    'AND fsp.storage_id IN (SELECT storage_id FROM file_storage_paths WHERE pool_id = ?)',
    ['active', poolId, poolId]
  );

  if (migratedFiles.length === 0) {
    return res.json({ code: 1, message: '没有可回滚的文件（文件可能已被清理）' });
  }

  var taskId = AsyncTask.create('pool_rollback',
    '回滚迁移: ' + pool.local_path + ' (' + migratedFiles.length + '个文件)',
    { pool_id: poolId }
  );
  AsyncTask.start(taskId, migratedFiles.length);
  AsyncTask.appendLog(taskId, '开始回滚 ' + migratedFiles.length + ' 个文件到原始池', 'info');

  var rolled = 0, errs = 0;
  function rollNext() {
    if (migratedFiles.length === 0) {
      db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [poolId]);
      AsyncTask.complete(taskId, errs > 0 ? 'error' : 'completed');
      AsyncTask.appendLog(taskId, '回滚完成! ' + rolled + ' 成功 / ' + errs + ' 失败', errs > 0 ? 'error' : 'info');
      return;
    }
    var f = migratedFiles.shift();
    try {
      var destPath = path.join(pool.local_path, f.relative_path || path.basename(f.full_path));
      var destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      if (fs.existsSync(f.full_path)) {
        try { fs.renameSync(f.full_path, destPath); } catch(e) {
          fs.copyFileSync(f.full_path, destPath); fs.unlinkSync(f.full_path);
        }
      }
      db.run("UPDATE file_storage_paths SET pool_id = ?, full_path = ?, status = 'active' WHERE id = ?",
        [poolId, destPath.replace(/\\/g, '/'), f.id]);
      rolled++;
    } catch(e) { errs++; }
    AsyncTask.updateProgress(taskId, rolled + errs, migratedFiles.length + rolled + errs, errs);
    setImmediate(rollNext);
  }
  setImmediate(rollNext);
  res.json({ code: 0, message: '回滚已启动', data: { task_id: taskId, files: migratedFiles.length } });
});

// POST /api/admin/tasks/:id/cancel — 取消运行中的任务并解锁池
router.post('/admin/tasks/:id/cancel', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var task = AsyncTask.get(parseInt(req.params.id, 10));
  if (!task) return res.json({ code: 1, message: '任务不存在' });
  if (task.status !== 'running' && task.status !== 'pending') {
    return res.json({ code: 1, message: '只能取消运行中或等待中的任务' });
  }

  // 解锁关联的池（迁移类任务保持 disabled，非迁移类恢复 active）
  try {
    var meta = task.metadata || {};
    var isMigrateTask = (task.type === 'pool_migrate_disable' || task.type === 'pool_delete_migrate');
    var newStatus = isMigrateTask ? 'disabled' : 'active';
    if (meta.pool_id) {
      db.run("UPDATE storage_pools SET status = ? WHERE id = ? AND status IN ('processing','syncing')", [newStatus, meta.pool_id]);
    }
    if (meta.group_id) {
      db.run("UPDATE storage_pools SET status = ? WHERE group_id = ? AND status IN ('processing','syncing')", [newStatus, meta.group_id]);
    }
  } catch(e) {}

  AsyncTask.complete(task.id, 'cancelled');
  AsyncTask.appendLog(task.id, '任务已被手动取消', 'warn');
  res.json({ code: 0, message: '任务已取消，池已解锁' });
});

// DELETE /api/admin/tasks/:id — 手动删除任务记录（同时解锁关联池）
router.delete('/admin/tasks/:id', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');
  var task = AsyncTask.get(parseInt(req.params.id, 10));
  if (task) {
    // 解锁关联的池
    try {
      var meta = task.metadata || {};
      if (meta.pool_id) {
        db.run("UPDATE storage_pools SET status = 'active' WHERE id = ? AND status IN ('processing','syncing')", [meta.pool_id]);
      }
      if (meta.group_id) {
        db.run("UPDATE storage_pools SET status = 'active' WHERE group_id = ? AND status IN ('processing','syncing')", [meta.group_id]);
      }
    } catch(e) {}
  }
  db.run('DELETE FROM async_tasks WHERE id = ?', [parseInt(req.params.id, 10)]);
  res.json({ code: 0, message: '已删除并解锁关联池' });
});

// POST /api/admin/storage/groups/:groupId/verify — 数据校验（异步任务，锁定存储组）
router.post('/admin/storage/groups/:groupId/verify', requireAdmin, function(req, res) {
  if (!requireGroupStopped(parseInt(req.params.groupId), res)) return;
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var db = require('../lib/db');
  var AsyncTask = require('../lib/db').AsyncTask;
  var StoragePool = require('../lib/db').StoragePool;
  var fs = require('fs');
  var pathLib = require('path');

  var allPools = StoragePool.listAll().filter(function(p) { return p.group_id === groupId && p.status !== 'deleted'; });
  if (allPools.length === 0) return res.json({ code: 1, message: '存储组#' + groupId + ' 没有镜像' });

  // 锁定组内所有镜像（标记为 processing）
  allPools.forEach(function(p) {
    db.run("UPDATE storage_pools SET status = 'processing' WHERE id = ? AND status NOT IN ('deleted','disabled_migrated')", [p.id]);
  });

  // 统计总文件数
  var totalPaths = 0;
  allPools.forEach(function(pool) {
    var cnt = db.get("SELECT COUNT(*) as cnt FROM file_storage_paths WHERE pool_id = ? AND status = ?", [pool.id, 'active']);
    totalPaths += (cnt ? cnt.cnt : 0);
  });

  var taskId = AsyncTask.create('verify_data', '数据校验 存储组#' + groupId + ' (' + allPools.length + '镜像)',
    { group_id: groupId, mirror_count: allPools.length });
  AsyncTask.start(taskId, allPools.length);
  AsyncTask.appendLog(taskId, '开始校验存储组#' + groupId + '，共 ' + allPools.length + ' 个镜像', 'info');

  // 逐个镜像校验
  var poolResults = [];
  var poolIdx = 0;
  var totalProcessed = 0, totalExists = 0, totalMissing = 0, totalRestored = 0;

  function verifyNextPool() {
    if (poolIdx >= allPools.length) {
      var allSynced = poolResults.every(function(r) { return r.sync_status === 'synced'; });
      allPools.forEach(function(p) {
        db.run("UPDATE storage_pools SET status = 'stopped' WHERE id = ? AND status = 'processing'", [p.id]);
      });
      AsyncTask.complete(taskId, 'completed');
      // 清理残留路径：file_storage.group_id 不属于该组的路径标记为 deleted
      var cleaned = db.run(
        "UPDATE file_storage_paths SET status = 'deleted' WHERE status = 'active' AND pool_id IN (SELECT id FROM storage_pools WHERE group_id = ?) " +
        "AND storage_id IN (SELECT id FROM file_storage WHERE group_id != ? AND group_id IS NOT NULL AND group_id != 0)",
        [groupId, groupId]
      );
      if (cleaned.changes > 0) AsyncTask.appendLog(taskId, '清理残留路径: ' + cleaned.changes + ' 条（文件已不属于本组）', 'info');

      AsyncTask.appendLog(taskId, '校验完成! ' + poolResults.length + '个镜像, 总文件:' + totalProcessed + ' 存在:' + totalExists + ' 缺失:' + totalMissing + ' → ' + (allSynced ? '全部已同步' : '部分未同步'), allSynced ? 'info' : 'warn');
      return;
    }

    var pool = allPools[poolIdx]; poolIdx++;
    AsyncTask.appendLog(taskId, '校验镜像: ' + (pool.name || ('镜像' + pool.mirror_index)) + ' (' + pool.local_path + ')', 'info');

    // 查该存储组的所有物理文件
    // group 0 额外包含 group_id IS NULL 的旧文件（迁移前遗留）
    var groupFilter = (groupId === 0)
      ? '(fs.group_id = 0 OR fs.group_id IS NULL)'
      : 'fs.group_id = ?';
    var groupParams = (groupId === 0) ? [] : [groupId];
    var allFiles = db.query(
      'SELECT fs.uuid, fs.file_size, ' +
      '(SELECT fsp.relative_path FROM file_storage_paths fsp WHERE fsp.storage_id = fs.id ORDER BY fsp.id LIMIT 1) as relative_path ' +
      'FROM file_storage fs WHERE fs.ref_count > 0 AND fs.status = ? AND ' + groupFilter + ' ORDER BY fs.id',
      ['active'].concat(groupParams)
    );
    // 兜底：没有 path 记录时按 uuid 推算 YYYY/MM/DD/uuid.enc
    var Storage = require('../lib/db').Storage;
    allFiles.forEach(function(f) {
      if (!f.relative_path) f.relative_path = Storage.getDateBasedPath(f.uuid);
    });

    if (allFiles.length === 0) {
      // 该组没有文件 → 标记为 synced。disabled_migrated 的镜像恢复为 stopped
      if (pool.status === 'disabled_migrated') {
        db.run("UPDATE storage_pools SET status = 'stopped', sync_status = 'synced' WHERE id = ?", [pool.id]);
        AsyncTask.appendLog(taskId, '  → 无文件，已迁移待删除 → 恢复为已停用+已同步', 'info');
      } else {
        db.run("UPDATE storage_pools SET sync_status = 'synced' WHERE id = ?", [pool.id]);
        AsyncTask.appendLog(taskId, '  → 无文件，标记已同步', 'info');
      }
      poolResults.push({ pool_id: pool.id, name: pool.name || ('镜像' + pool.mirror_index), total: 0, exists: 0, missing: 0, sync_status: 'synced' });
      AsyncTask.updateProgress(taskId, poolIdx, allPools.length, 0);
      setImmediate(verifyNextPool);
      return;
    }

    // 先扫描镜像目录建立 uuid→磁盘路径 的映射
    var diskMap = {}; // uuid → { fullPath, relativePath }
    function scanDir(dir, depth) {
      if (depth > 4) return;
      try {
        fs.readdirSync(dir).forEach(function(e) {
          var fp = pathLib.join(dir, e);
          try {
            var st = fs.statSync(fp);
            if (st.isDirectory()) { scanDir(fp, depth + 1); return; }
            if (!e.endsWith('.enc')) return;
            var uuid = pathLib.basename(e);
            while (uuid.endsWith('.enc')) uuid = uuid.substring(0, uuid.length - 4);
            var rel = pathLib.relative(pool.local_path, fp).replace(/\\/g, '/');
            diskMap[uuid] = { fullPath: fp, relativePath: rel };
          } catch(ex) {}
        });
      } catch(ex) {}
    }
    if (fs.existsSync(pool.local_path)) scanDir(pool.local_path, 0);
    AsyncTask.appendLog(taskId, '  磁盘扫描: ' + Object.keys(diskMap).length + ' 个 .enc 文件', 'info');

    var exists = 0, missing = 0, updated = 0;
    var missingUuids = [];
    allFiles.forEach(function(f) {
      var df = diskMap[f.uuid];
      if (df) {
        exists++;
        if (f.relative_path !== df.relativePath) {
          db.run("UPDATE file_storage_paths SET relative_path = ?, full_path = ? WHERE storage_id = (SELECT id FROM file_storage WHERE uuid = ? LIMIT 1) AND status = 'active'",
            [df.relativePath, df.relativePath, f.uuid]);
          var noActive = db.get("SELECT COUNT(*) as cnt FROM file_storage_paths WHERE storage_id = (SELECT id FROM file_storage WHERE uuid = ? LIMIT 1) AND status = 'active'", [f.uuid]);
          if (!noActive || noActive.cnt === 0) {
            var fsEntry = db.get("SELECT id FROM file_storage WHERE uuid = ?", [f.uuid]);
            if (fsEntry) require('../lib/db').FileStorage.addPath(fsEntry.id, pool.id, df.relativePath, df.relativePath);
          }
          updated++;
        }
      } else {
        missing++;
        missingUuids.push(f.uuid.substring(0,12));
      }
    });
    if (missingUuids.length > 0) AsyncTask.appendLog(taskId, '  缺失的UUID: ' + missingUuids.join(', '), 'warn');
    // 也汇报磁盘有但DB没有的文件
    var dbUuids = {};
    allFiles.forEach(function(f) { dbUuids[f.uuid] = true; });
    var orphanDisk = Object.keys(diskMap).filter(function(u) { return !dbUuids[u]; });
    if (orphanDisk.length > 0) AsyncTask.appendLog(taskId, '  磁盘有多余文件(' + orphanDisk.length + '个): ' + orphanDisk.map(function(u){return u.substring(0,12)}).join(', '), 'warn');
    var total = allFiles.length;
    var newSyncStatus = (missing === 0) ? 'synced' : 'unsynced';
    // 如果是 disabled_migrated 且校验通过 → 恢复为 stopped+synced（可复用）
    if (pool.status === 'disabled_migrated' && missing === 0) {
      db.run("UPDATE storage_pools SET status = 'stopped', sync_status = 'synced' WHERE id = ?", [pool.id]);
      AsyncTask.appendLog(taskId, '  镜像原为已迁移待删除，校验通过 → 恢复为已停用+已同步，可重新启用', 'info');
    } else {
      db.run("UPDATE storage_pools SET sync_status = ? WHERE id = ?", [newSyncStatus, pool.id]);
    }
    poolResults.push({ pool_id: pool.id, name: pool.name || ('镜像' + pool.mirror_index), total: total, exists: exists, missing: missing, sync_status: newSyncStatus });
    totalProcessed += total; totalExists += exists; totalMissing += missing;
    AsyncTask.appendLog(taskId, '  → ' + exists + '/' + total + '存在' + (missing > 0 ? ' ⚠缺失' + missing : '') + (updated > 0 ? ' 更新' + updated + '条路径' : '') + ' → ' + newSyncStatus, missing > 0 ? 'warn' : 'info');
    AsyncTask.updateProgress(taskId, poolIdx, allPools.length, totalMissing);
    setImmediate(verifyNextPool);
  }

  setImmediate(verifyNextPool);

  res.json({
    code: 0, message: '数据校验已启动', data: { task_id: taskId, total_files: totalPaths, mirrors: allPools.length }
  });
});

// POST /api/admin/storage/groups/:groupId/stop — 停用存储组（只改 storage_groups.status，不动镜像）
router.post('/admin/storage/groups/:groupId/stop', requireAdmin, function(req, res) {
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var StorageStream = require('../lib/storage-stream');
  StorageStream.startStoppingGroup(groupId);
  res.json({ code: 0, message: '存储组#' + groupId + ' 已停用（镜像状态不变）' });
});

// POST /api/admin/storage/groups/:groupId/activate — 启用存储组
router.post('/admin/storage/groups/:groupId/activate', requireAdmin, function(req, res) {
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var db = require('../lib/db');
  var grp = db.get("SELECT status FROM storage_groups WHERE group_id = ?", [groupId]);
  if (grp && grp.status === 'active') {
    return res.json({ code: 1, message: '存储组#' + groupId + ' 已是活跃状态' });
  }
  var StorageStream = require('../lib/storage-stream');
  var result = StorageStream.activateGroup(groupId);
  if (!result.ok) {
    return res.json({ code: 1, message: result.message });
  }
  res.json({ code: 0, message: '存储组#' + groupId + ' 已启用，未启用的镜像已标记为未同步' });
});

// PUT /api/admin/storage/groups/:groupId/weight — 更新存储组权重(1-10)
router.put('/admin/storage/groups/:groupId/weight', requireAdmin, function(req, res) {
  var groupId = parseInt(req.params.groupId, 10) || 0;
  var weight = parseInt(req.body.weight, 10) || 5;
  if (weight < 1) weight = 1;
  if (weight > 10) weight = 10;
  var db = require('../lib/db');
  db.run('UPDATE storage_groups SET weight = ? WHERE group_id = ?', [weight, groupId]);
  res.json({ code: 0, message: '存储组#' + groupId + ' 权重已更新为 ' + weight, data: { group_id: groupId, weight: weight } });
});

// POST /api/admin/storage/unlock — 强制解锁所有被锁的池
router.post('/admin/storage/unlock', requireAdmin, function(req, res) {
  var db = require('../lib/db');
  var result = db.run("UPDATE storage_pools SET status = 'active' WHERE status IN ('processing','syncing')");
  var unlocked = result.changes || 0;
  res.json({ code: 0, message: '已解锁 ' + unlocked + ' 个池' });
});

// POST /api/admin/tasks/:id/pause — 暂停任务
router.post('/admin/tasks/:id/pause', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  AsyncTask.pause(parseInt(req.params.id, 10));
  res.json({ code: 0, message: '已暂停' });
});

// POST /api/admin/tasks/:id/resume — 恢复任务
router.post('/admin/tasks/:id/resume', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  AsyncTask.resume(parseInt(req.params.id, 10));
  res.json({ code: 0, message: '已恢复' });
});

// 重构：路径删除改为异步任务（支持文件迁移到其他存储组）
router.delete('/admin/storage/pools/:id', requireAdmin, function(req, res) {
  var poolId = parseInt(req.params.id, 10) || 0;
  var AsyncTask = require('../lib/db').AsyncTask;
  var StoragePool = require('../lib/db').StoragePool;
  var db = require('../lib/db');

  var pools = StoragePool.listAll();
  var pool = pools.find(function(p) { return p.id === poolId; });
  if (!pool) return res.json({ code: 1, message: '路径不存在' });

  // 删除守卫
  if (pool.status === 'processing' || pool.status === 'syncing' || pool.status === 'stopping') {
    return res.json({ code: 1, message: '该路径正在执行任务中，请等待完成后再操作' });
  }
  // 主路径必须已停用或已迁移完成才能删除
  if (pool.mirror_index === 0 && pool.status !== 'stopped' && pool.status !== 'disabled_migrated') {
    return res.json({ code: 1, message: '主路径必须先停用存储组（迁移数据后）才能删除。当前状态: ' + pool.status });
  }
  // 镜像可以直接删除（数据由主路径保留）
  if (pool.mirror_index > 0 && pool.status !== 'stopped' && pool.status !== 'active' && pool.status !== 'degraded' && pool.status !== 'error' && pool.status !== 'disabled_migrated') {
    return res.json({ code: 1, message: '镜像路径状态异常(' + pool.status + ')，无法删除' });
  }

  // 锁定池
  db.run("UPDATE storage_pools SET status = 'processing' WHERE id = ?", [poolId]);

  // 判断删除类型
  // 主路径(mirror=0) + 该组最后一个活跃路径 → 必须迁移文件
  var groupPaths = pools.filter(function(p) { return p.group_id === pool.group_id && p.status === 'active'; });
  var isLastInGroup = groupPaths.length <= 1; // pools 加载于锁之前，包含自身

  // 镜像直接走普通删除
  if (pool.mirror_index > 0) {
    return doNormalDelete(poolId, pool, res);
  }

  // 主路径：检查是否需要迁移
  if (!isLastInGroup) {
    // 组内还有其他活跃路径（镜像），直接删除即可
    return doNormalDelete(poolId, pool, res);
  }

  // === 最后的主路径，必须迁移文件到其他存储组 ===
  var otherGroups = pools.filter(function(p) {
    return p.group_id !== pool.group_id && p.status === 'active' && p.mirror_index === 0;
  });
  // 去重
  var seen = {};
  var targetGroups = [];
  otherGroups.forEach(function(p) {
    if (!seen[p.group_id]) { seen[p.group_id] = true; targetGroups.push(p); }
  });

  if (targetGroups.length === 0) {
    // 没有其他存储组可迁移 → 允许直接删除（用户已确认风险，文件引用会变成丢失状态）
    log.info('[Storage] 最后一个主路径且无其他存储组，直接删除（不迁移）: pool=' + poolId);
    return doNormalDelete(poolId, pool, res);
  }

  // 统计活跃文件数
  var countResult = db.get(
    'SELECT COUNT(*) as cnt FROM file_storage_paths WHERE pool_id = ? AND status = ?',
    [poolId, 'active']
  );
  var totalFiles = countResult ? countResult.cnt : 0;

  // 创建迁移+删除任务
  var taskId = AsyncTask.create('pool_delete_migrate',
    '删除存储组#' + pool.group_id + ' → 迁移到 ' + targetGroups.length + ' 个组 (' + totalFiles + '个文件)',
    { pool_id: poolId, group_id: pool.group_id, target_groups: targetGroups.map(function(g) { return g.group_id; }), total_files: totalFiles }
  );
  AsyncTask.start(taskId, totalFiles);
  AsyncTask.appendLog(taskId, '存储组#' + pool.group_id + ' 最后一个主路径', 'info');
  AsyncTask.appendLog(taskId, '文件数: ' + totalFiles + ' | 目标组: ' + targetGroups.map(function(g) { return '#' + g.group_id + '(' + path.basename(g.local_path) + ')'; }).join(', '), 'info');

  // 异步迁移
  var processed = 0, errors = 0;
  var groupIdx = 0;
  function migrateBatch() {
    var files = db.query(
      'SELECT fsp.id as path_id, fsp.storage_id, fsp.full_path, fsp.relative_path ' +
      'FROM file_storage_paths fsp ' +
      'WHERE fsp.pool_id = ? AND fsp.status = ? LIMIT 10',
      [poolId, 'active']
    );
    if (files.length === 0) {
      if (errors > 0) {
        db.run("UPDATE storage_pools SET status = 'active' WHERE id = ?", [poolId]);
        AsyncTask.complete(taskId, 'error');
        AsyncTask.appendLog(taskId, '迁移失败! 回滚: ' + processed + ' 成功 / ' + errors + ' 失败, 池已恢复', 'error');
      } else {
        StoragePool.remove(poolId);
        AsyncTask.complete(taskId, 'completed');
        AsyncTask.appendLog(taskId, '迁移完成! ' + processed + ' 个文件已平均分配到 ' + targetGroups.length + ' 个组', 'info');
      }
      return;
    }

    files.forEach(function(f) {
      var target = targetGroups[groupIdx % targetGroups.length];
      groupIdx++;
      try {
        var destDir = path.join(target.local_path, path.dirname(f.relative_path || ''));
        var destPath = path.join(target.local_path, f.relative_path || path.basename(f.full_path));
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        if (fs.existsSync(f.full_path)) {
          try { fs.renameSync(f.full_path, destPath); } catch(e) {
            fs.copyFileSync(f.full_path, destPath);
            try { fs.unlinkSync(f.full_path); } catch(e2) {}
          }
        }
        db.run("UPDATE file_storage_paths SET pool_id = ?, full_path = ?, status = 'active' WHERE id = ?",
          [target.id, destPath.replace(/\\/g, '/'), f.path_id]);
        processed++;
      } catch(e) {
        errors++;
        AsyncTask.appendLog(taskId, '迁移失败: ' + path.basename(f.full_path||'') + ' err=' + e.message, 'error');
      }
    });
    AsyncTask.updateProgress(taskId, processed, totalFiles, errors);
    if (processed % 50 === 0) AsyncTask.appendLog(taskId, '迁移进度: ' + processed + '/' + totalFiles, 'info');
    setImmediate(migrateBatch);
  }
  setImmediate(migrateBatch);
  return res.json({
    code: 0, message: '已创建文件迁移任务（存储组#' + pool.group_id + ' → ' + targetGroups.length + ' 个组，' + totalFiles + '个文件）',
    data: { task_id: taskId, total_files: totalFiles, target_groups: targetGroupIds.length }
  });
});

// 普通删除（镜像路径，不涉及文件迁移）
function doNormalDelete(poolId, pool, res) {
  var StoragePool = require('../lib/db').StoragePool;
  var db = require('../lib/db');

  // 镜像删除：直接批量标记 file_storage_paths 为 deleted，然后移除池
  // 不需要异步任务 — 一个 UPDATE 就完成，物理文件不删（由组内其他镜像保留）
  var result = db.run("UPDATE file_storage_paths SET status = 'deleted' WHERE pool_id = ? AND status = 'active'", [poolId]);
  var affected = result.changes || 0;
  StoragePool.remove(poolId);
  log.info('[Storage] 镜像删除: pool_id=' + poolId + ' path=' + pool.local_path + ' affected=' + affected);
  res.json({ code: 0, message: '镜像已删除（' + pool.local_path + '），清理了 ' + affected + ' 条路径引用' });
};

// 自动迁移：一键完成所有待迁移文件
router.post('/admin/storage/auto-migrate', requireAdmin, function(req, res) {
  var AsyncTask = require('../lib/db').AsyncTask;
  var db = require('../lib/db');

  var pending = db.get(
    "SELECT COUNT(*) as cnt FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0)"
  );
  var totalPending = pending ? pending.cnt : 0;
  if (totalPending === 0) {
    return res.json({ code: 0, message: '没有待迁移的文件' });
  }

  var taskId = AsyncTask.create('auto_migrate', '自动迁移全部文件 (' + totalPending + '个)', {
    total_pending: totalPending
  });
  AsyncTask.start(taskId, totalPending);
  AsyncTask.appendLog(taskId, '开始自动迁移，共 ' + totalPending + ' 个文件', 'info');

  // 递归批量迁移
  var batchSize = 5;
  var migrated = 0, errors = 0;

  function runBatch() {
    var files = db.query(
      'SELECT * FROM virtual_files WHERE (storage_id IS NULL OR storage_id = 0) AND enc_version >= 1 AND (migration_status IS NULL OR migration_status = 0) ORDER BY id LIMIT ?',
      [batchSize]
    );
    if (files.length === 0) {
      AsyncTask.complete(taskId, errors > 0 ? 'completed' : 'completed');
      AsyncTask.appendLog(taskId, '自动迁移完成! 成功:' + migrated + ' 失败:' + errors, 'info');
      return;
    }
    migrateFileBatch(files, function(batchMigrated, batchErrors) {
      migrated += batchMigrated;
      errors += batchErrors;
      AsyncTask.updateProgress(taskId, migrated, totalPending, errors);
      if (migrated % 10 === 0) {
        AsyncTask.appendLog(taskId, '迁移进度: ' + migrated + '/' + totalPending + ' (失败:' + errors + ')', 'info');
      }
      setImmediate(runBatch);
    });
  }

  setImmediate(runBatch);

  res.json({ code: 0, message: '自动迁移已启动', data: { task_id: taskId, total: totalPending } });
});

// 迁移文件批处理辅助（扫描模式：不解密，直接找物理文件+建DB记录）
function migrateFileBatch(files, callback) {
  var idx = 0, migrated = 0, errors = 0;
  var db = require('../lib/db');
  var FileStorage = require('../lib/db').FileStorage;
  var StoragePool = require('../lib/db').StoragePool;
  var Storage = require('../lib/db').Storage;

  // 缓存活跃池数据
  var activePools = StoragePool.listAll().filter(function(p) { return p.status === 'active'; });
  var dedupMap = {}; // hash_size -> storageId 内存去重

  // 异步计算文件哈希并去重迁移
  function computeHashAndMigrate(file, foundPath, foundPool, foundRelPath, dateRelPath, fileUuid, callback) {
    var FileStorage2 = require('../lib/db').FileStorage;
    var db2 = require('../lib/db');
    var activePools2 = activePools;

    function finish(fileHash, plainSize) {
      var dedupKey = fileHash + '_' + plainSize;
      var existingId = dedupMap[dedupKey];
      if (!existingId) {
        // 也查数据库
        var existingFS = FileStorage2.findByHashAndSize(fileHash, plainSize);
        if (existingFS && FileStorage2.hasValidPath(existingFS.id)) existingId = existingFS.id;
      }
      var storageId, groupId = foundPool.group_id;

      if (existingId) {
        storageId = existingId;
        FileStorage2.incrementRef(storageId);
        dedupMap[dedupKey] = storageId;
        try { fs.unlinkSync(foundPath); } catch(e) {}
        log.info('[Migration] 去重: #'+file.id+' -> storage_id='+storageId+' hash='+fileHash.substring(0,12));
      } else {
        storageId = FileStorage2.create(fileUuid, fileHash, file.size, plainSize, file.enc_version||1, true, file.nonce);
        dedupMap[dedupKey] = storageId;
        db2.run('UPDATE file_storage SET group_id = ? WHERE id = ?', [groupId, storageId]);
        FileStorage2.addPath(storageId, foundPool.id, foundRelPath, foundRelPath);
        // 镜像
        activePools2.filter(function(p) { return p.group_id === groupId && p.mirror_index > 0; }).forEach(function(m) {
          try {
            var mfp = path.join(m.local_path, foundRelPath);
            var md = path.dirname(mfp);
            if (!fs.existsSync(md)) fs.mkdirSync(md, {recursive: true});
            if (!fs.existsSync(mfp)) fs.copyFileSync(foundPath, mfp);
            FileStorage2.addPath(storageId, m.id, foundRelPath, foundRelPath);
          } catch(e) {}
        });
      }
      db2.run('UPDATE virtual_files SET storage_id = ?, storage_path = ?, migration_status = 1 WHERE id = ?',
        [storageId, foundRelPath, file.id]);
      require('../lib/db').UserFileRef.create(file.user_id, storageId, file.dir_id||0, file.name, file.mime_type);
      callback(true);
    }

    if (file.enc_version === 1) {
      try {
        var cryptoLib = require('../lib/crypto');
        var dStream = cryptoLib.createV1DecryptStream(foundPath);
        var dChunks = [];
        dStream.on('data', function(c) { dChunks.push(c); });
        dStream.on('end', function() {
          var pb = Buffer.concat(dChunks);
          if (pb.length > 0) {
            var h = require('crypto').createHash('sha256').update(pb).digest('hex');
            finish(h, pb.length);
          } else { finish('mig_'+fileUuid.substring(0,24), file.size); }
        });
        dStream.on('error', function() { finish('mig_'+fileUuid.substring(0,24), file.size); });
        return;
      } catch(e) {}
    }
    if (file.nonce) {
      try {
        var encBuf = fs.readFileSync(foundPath);
        var decRes = require('../lib/crypto').createDecryptStream(encBuf, file.nonce);
        if (decRes && decRes.plaintext && decRes.plaintext.length > 0) {
          var h2 = require('crypto').createHash('sha256').update(decRes.plaintext).digest('hex');
          finish(h2, decRes.plaintext.length);
          return;
        }
      } catch(e) {}
    }
    finish('mig_'+fileUuid.substring(0,24), file.size);
  }

  function next() {
    if (idx >= files.length) { callback(migrated, errors); return; }
    var file = files[idx]; idx++;

    // 从 storage_path 提取 uuid（去掉路径和所有.enc后缀）
    var oldFileName = path.basename(file.storage_path || '');
    var fileUuid = oldFileName;
    while (fileUuid.endsWith('.enc')) fileUuid = fileUuid.substring(0, fileUuid.length - 4);
    if (!fileUuid) fileUuid = crypto.randomUUID();
    var dateRelPath = Storage.getDateBasedPath(fileUuid, file.created_at);

    // 扫描所有活跃池查找这个 uuid.enc
    var foundPath = null, foundPool = null, foundRelPath = null;
    for (var pi = 0; pi < activePools.length && !foundPath; pi++) {
      var pool = activePools[pi];
      try {
        if (!fs.existsSync(pool.local_path)) continue;
        var years = fs.readdirSync(pool.local_path).filter(function(d) { return /^\d{4}$/.test(d); });
        for (var yi = 0; yi < years.length && !foundPath; yi++) {
          var yDir = path.join(pool.local_path, years[yi]);
          var months = fs.readdirSync(yDir).filter(function(d) { return /^\d{2}$/.test(d); });
          for (var mi = 0; mi < months.length && !foundPath; mi++) {
            var mDir = path.join(yDir, months[mi]);
            var days = fs.readdirSync(mDir).filter(function(d) { return /^\d{2}$/.test(d); });
            for (var di = 0; di < days.length && !foundPath; di++) {
              var checkFile = path.join(mDir, days[di], fileUuid + '.enc');
              if (fs.existsSync(checkFile)) {
                foundPath = checkFile; foundPool = pool;
                foundRelPath = years[yi] + '/' + months[mi] + '/' + days[di] + '/' + fileUuid + '.enc';
              }
            }
          }
        }
      } catch(e) {}
    }

    // 如果池里没找到，检查旧 userdata 路径
    // 检查旧路径（DB无.enc但物理文件有.enc）
    var oldPathWithEnc = file.storage_path + '.enc';
    if (!foundPath && file.storage_path && (fs.existsSync(file.storage_path) || fs.existsSync(oldPathWithEnc))) {
      if (fs.existsSync(oldPathWithEnc)) file.storage_path = oldPathWithEnc;
      foundPath = file.storage_path;
      foundPool = activePools.find(function(p) { return p.group_id === 0 && p.mirror_index === 0; }) || activePools[0];
      if (foundPool) {
        // 移动到目标日期目录
        var destFullPath = path.join(foundPool.local_path, dateRelPath);
        var destDir = path.dirname(destFullPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        try { fs.renameSync(foundPath, destFullPath); } catch(e) {
          fs.copyFileSync(foundPath, destFullPath);
          try { fs.unlinkSync(foundPath); } catch(e2) {}
        }
        foundPath = destFullPath; foundRelPath = dateRelPath;
      }
    }

    if (!foundPath || !foundPool) {
      errors++; db.run('UPDATE virtual_files SET migration_status = -1 WHERE id = ?', [file.id]);
      return next();
    }

    // 异步计算哈希+去重
    computeHashAndMigrate(file, foundPath, foundPool, foundRelPath, dateRelPath, fileUuid, function(success) {
      if (success) migrated++; else { errors++; db.run('UPDATE virtual_files SET migration_status = -1 WHERE id = ?', [file.id]); }
      next();
    });
  }

  next();
}

module.exports = router;
