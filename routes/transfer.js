/**
 * 文件传输管理 — 分块上传 / 断点续传 / 传输列表
 *
 * 端点:
 *   POST /api/transfer/upload/init     初始化上传
 *   POST /api/transfer/upload/chunk    上传分块
 *   POST /api/transfer/upload/complete 完成上传（拼装+加密+写存储）
 *   POST /api/transfer/upload/cancel   取消上传
 *   POST /api/transfer/download/init   初始化可恢复下载
 *   GET  /api/transfer/download/:id    下载文件（支持Range断点续传）
 *   GET  /api/transfers                传输列表
 *   GET  /api/transfers/pending        检测未完成传输（页面刷新恢复）
 *   POST /api/transfers/:id/retry      重试失败传输
 *   DELETE /api/transfers/:id          删除传输记录
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

var log = require('../lib/log');
var db = require('../lib/db');

// 分块大小：4MB
var CHUNK_SIZE = 4 * 1024 * 1024;

// 从 req 解析设备信息
function getDeviceInfo(req) {
  var deviceId = (req.headers['x-device-id'] || '').toString();
  var ua = (req.headers['user-agent'] || 'Unknown').toString();
  var deviceName = '浏览器';
  if (ua.indexOf('FileServiceApp') !== -1) {
    deviceName = 'Android App';
  } else if (ua.indexOf('Mobile') !== -1 || ua.indexOf('Android') !== -1) {
    deviceName = '手机浏览器';
  } else {
    deviceName = 'PC浏览器';
  }
  return { deviceId: deviceId, deviceName: deviceName, userAgent: ua };
}

// 获取客户端 IP（复用现有 pattern）
function getClientIp(req) {
  var ip = req.headers['x-forwarded-for'] || req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.indexOf(',') !== -1) ip = ip.split(',')[0].trim();
  return ip.replace(/^::ffff:/, '');
}

// 认证中间件（加载用户对象到 req.user）
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ code: 401, message: '请先登录', data: null });
  }
  var user = db.User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({ code: 401, message: '用户不存在', data: null });
  }
  req.user = user;
  next();
}

// ==================== 分块目录管理 ====================
function getChunkDir(transferId) {
  var dir = path.join(path.dirname(require.resolve('../lib/db')), '..', 'data', 'chunks', transferId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ==================== POST /api/transfer/upload/init ====================
router.post('/transfer/upload/init', requireAuth, function(req, res) {
  var user = req.user;
  var fileName = String(req.body.file_name || '').trim();
  var fileSize = parseInt(req.body.file_size, 10) || 0;
  var mimeType = String(req.body.mime_type || 'application/octet-stream').trim();
  var dirId = parseInt(req.body.dir_id, 10) || 0;
  var fileHash = String(req.body.file_hash || '').trim();
  var dev = getDeviceInfo(req);

  if (!fileName || fileSize <= 0) {
    return res.json({ code: 1, message: '参数错误：需要有效的 file_name 和 file_size', data: null });
  }
  if (fileSize > 3.5 * 1024 * 1024 * 1024) {
    return res.json({ code: 1, message: '文件过大（最大支持 3.5GB）', data: null });
  }

  // 配额预检
  if (user.used_bytes + fileSize > user.quota_bytes) {
    return res.json({ code: 1, message: '存储空间不足', data: null });
  }

  // 秒传检测
  if (fileHash) {
    var existing = db.FileStorage.findByHashAndSize(fileHash, fileSize);
    if (existing && db.FileStorage.hasValidPath(existing.id)) {
      // 秒传命中 → 创建虚拟文件记录
      db.FileStorage.incrementRef(existing.id);
      db.UserFileRef.create(user.id, existing.id, dirId, fileName, mimeType);
      var encVersion = (function(){ var r = db.get('SELECT enc_version FROM file_storage WHERE id = ?', [existing.id]); return (r && r.enc_version) || 1; })();
      var vfId = db.VirtualFile.createWithEncVersion(user.id, dirId, fileName, fileSize, mimeType, '', '', encVersion);
      if (vfId) db.run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [existing.id, vfId]);
      db.User.updateUsedBytes(user.id, fileSize);

      // 记录秒传任务
      var instantTaskId = db.TransferTask.create({
        user_id: user.id, direction: 'upload', transfer_id: 'instant_' + crypto.randomUUID(),
        file_name: fileName, file_size: fileSize, mime_type: mimeType, file_hash: fileHash,
        dir_id: dirId, device_id: dev.deviceId, device_name: dev.deviceName, ip: getClientIp(req),
        status: 'completed'
      });
      if (instantTaskId) {
        db.TransferTask.completeTask(instantTaskId, '', fileHash, vfId);
      }

      log.info('[Transfer] 秒传命中: ' + fileName + ' hash=' + fileHash.substring(0,12) + ' size=' + fileSize);
      return res.json({ code: 0, message: '秒传成功', data: { instant: true, virtual_file_id: vfId } });
    }
  }

  // 创建上传任务
  var transferId = crypto.randomUUID();
  var totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  var taskId = db.TransferTask.create({
    user_id: user.id, direction: 'upload', transfer_id: transferId,
    file_name: fileName, file_size: fileSize, mime_type: mimeType,
    file_hash: fileHash, dir_id: dirId, chunk_size: CHUNK_SIZE,
    total_chunks: totalChunks, device_id: dev.deviceId, device_name: dev.deviceName,
    ip: getClientIp(req), status: 'uploading'
  });

  if (!taskId) {
    return res.json({ code: 1, message: '创建任务失败', data: null });
  }

  // 创建 Redis 会话
  try {
    var TransferSession = require('../lib/redis').TransferSession;
    TransferSession.createUpload(transferId, {
      taskId: taskId, userId: user.id, fileName: fileName, fileSize: fileSize,
      mimeType: mimeType, fileHash: fileHash, dirId: dirId, chunkSize: CHUNK_SIZE,
      totalChunks: totalChunks, uploadedChunks: 0, status: 'uploading',
      deviceId: dev.deviceId, deviceName: dev.deviceName, ip: getClientIp(req)
    });
  } catch(e) {}

  log.info('[Transfer] 上传初始化: ' + fileName + ' transfer_id=' + transferId + ' chunks=' + totalChunks);
  res.json({ code: 0, data: { transfer_id: transferId, task_id: taskId, total_chunks: totalChunks, chunk_size: CHUNK_SIZE } });
});

// ==================== POST /api/transfer/upload/chunk ====================
// 使用 query 参数传递 transfer_id + chunk_index，body 为原始二进制分块数据
router.post('/transfer/upload/chunk', requireAuth, express.raw({ limit: '5mb', type: '*/*' }), function(req, res) {
  var transferId = String(req.query.transfer_id || '').trim();
  var chunkIndex = parseInt(req.query.chunk_index, 10);
  if (isNaN(chunkIndex)) chunkIndex = -1;
  var chunkData = req.body;

  if (!transferId || chunkIndex < 0) return res.json({ code: 1, message: '参数错误：需要 transfer_id 和 chunk_index', data: null });
  if (!Buffer.isBuffer(chunkData) || chunkData.length === 0) return res.json({ code: 1, message: '分块数据为空', data: null });

  // 验证任务
  var task = db.TransferTask.findByTransferId(transferId);
  if (!task || task.user_id !== req.user.id) return res.json({ code: 2, message: '任务不存在或无权操作', data: null });
  if (task.status !== 'uploading') return res.json({ code: 2, message: '任务状态不允许上传: ' + task.status, data: null });
  if (chunkIndex < 0 || chunkIndex >= task.total_chunks) return res.json({ code: 1, message: 'chunk_index 超出范围', data: null });

  // 保存 chunk
  var chunkDir = getChunkDir(transferId);
  var chunkPath = path.join(chunkDir, 'chunk_' + chunkIndex + '.part');
  try { fs.writeFileSync(chunkPath, chunkData); } catch(e) {
    return res.json({ code: 1, message: '保存分块失败: ' + e.message, data: null });
  }

  // 记录到 DB
  db.TransferChunk.upsert(task.id, chunkIndex, chunkData.length, chunkPath);

  // 更新进度
  var uploadedCount = db.TransferChunk.countUploaded(task.id);
  db.TransferTask.updateProgress(task.id, uploadedCount, task.total_chunks);

  // 更新 Redis
  try {
    var TransferSession = require('../lib/redis').TransferSession;
    TransferSession.updateUpload(transferId, {
      taskId: task.id, userId: task.user_id, fileName: task.file_name, fileSize: task.file_size,
      mimeType: task.mime_type, fileHash: task.file_hash, dirId: task.dir_id,
      chunkSize: task.chunk_size, totalChunks: task.total_chunks, uploadedChunks: uploadedCount,
      status: 'uploading', deviceId: task.device_id, deviceName: task.device_name, ip: task.ip
    });
  } catch(e) {}

  var progress = Math.floor(uploadedCount / task.total_chunks * 100);
  res.json({ code: 0, data: { chunk_index: chunkIndex, uploaded_chunks: uploadedCount, total_chunks: task.total_chunks, progress: progress } });
});

// ==================== POST /api/transfer/upload/complete ====================
router.post('/transfer/upload/complete', requireAuth, function(req, res) {
  var transferId = String(req.body.transfer_id || '').trim();
  if (!transferId) return res.json({ code: 1, message: '参数错误：需要 transfer_id', data: null });

  var task = db.TransferTask.findByTransferId(transferId);
  if (!task || task.user_id !== req.user.id) return res.json({ code: 2, message: '任务不存在或无权操作', data: null });
  if (task.status === 'completed') return res.json({ code: 0, message: '已上传', data: { virtual_file_id: task.metadata ? JSON.parse(task.metadata).virtual_file_id : 0 } });

  // 验证所有 chunks 已上传
  var uploadedCount = db.TransferChunk.countUploaded(task.id);
  if (uploadedCount < task.total_chunks) {
    return res.json({ code: 1, message: '尚有 ' + (task.total_chunks - uploadedCount) + ' 个分块未上传', data: { uploaded_chunks: uploadedCount, total_chunks: task.total_chunks } });
  }

  // 开始组装
  db.TransferTask.setAssembling(task.id);

  // 异步组装（避免阻塞）
  assembleFile(task, transferId, req.user, function(err, result) {
    if (err) {
      db.TransferTask.updateStatus(task.id, 'error', err.message);
      return;
    }
    db.TransferTask.completeTask(task.id, result.storagePath, result.fileHash, result.virtualFileId);
    log.info('[Transfer] 上传完成: ' + task.file_name + ' vfId=' + result.virtualFileId);
  });

  res.json({ code: 0, message: '正在组装文件...', data: { status: 'assembling' } });
});

// 组装分块文件、加密、写入存储
function assembleFile(task, transferId, user, callback) {
  var chunkDir = getChunkDir(transferId);
  var Storage = require('../lib/db').Storage;
  var tmpPath = Storage.getFilePath(user.id, transferId);
  try { fs.mkdirSync(path.dirname(tmpPath), { recursive: true }); } catch(e) {}

  try {
    // 1) 按顺序拼接所有 chunk 到临时文件
    var writeStream = fs.createWriteStream(tmpPath);
    var chunkIndex = 0;

    function writeNext() {
      if (chunkIndex >= task.total_chunks) {
        writeStream.end();
        return;
      }
      var chunkPath = path.join(chunkDir, 'chunk_' + chunkIndex + '.part');
      if (!fs.existsSync(chunkPath)) {
        writeStream.destroy();
        return callback(new Error('分块 ' + chunkIndex + ' 缺失（文件已损坏）'));
      }
      var data = fs.readFileSync(chunkPath);
      var ok = writeStream.write(data);
      chunkIndex++;
      if (ok) { writeNext(); } else { writeStream.once('drain', writeNext); }
    }
    writeNext();

    writeStream.on('finish', function() {
      // 2) 计算明文 SHA-256
      var plainBuf = fs.readFileSync(tmpPath);
      var fileHash = crypto.createHash('sha256').update(plainBuf).digest('hex');

      // 3) V1 加密到临时文件 — 复用正常上传的 encrypt-to-tmp 模式
      var cryptoLib = require('../lib/crypto');
      var encTmpPath = tmpPath + '.enc';
      var encResult = cryptoLib.createV1EncryptStreamSync(encTmpPath, plainBuf);
      try { fs.unlinkSync(tmpPath); } catch(e) {}  // 明文不再需要

      if (!encResult.ok) {
        try { fs.unlinkSync(encTmpPath); } catch(e) {}
        return callback(new Error('加密失败: ' + (encResult.error || '')));
      }

      // 4) 写入锁检查
      var lockErr = require('../lib/db').StoragePool.checkWriteLock();
      if (lockErr) {
        try { fs.unlinkSync(encTmpPath); } catch(e) {}
        return callback(new Error(lockErr));
      }

      // 5) 通过 StorageStream 写入均衡组（多镜像并行写入）
      var FileStorage = require('../lib/db').FileStorage;
      var UserFileRef = require('../lib/db').UserFileRef;
      var VirtualFile = require('../lib/db').VirtualFile;
      var StorageStream = require('../lib/storage-stream');
      var StorageDB = require('../lib/db').Storage;

      var fileUuid = crypto.randomUUID();
      var relPath = StorageDB.getDateBasedPath(fileUuid);
      var writeResult = StorageStream.createWriteStream(relPath);
      var groupId = writeResult.groupId;

      if (groupId === null || groupId === undefined) {
        try { fs.unlinkSync(encTmpPath); } catch(e) {}
        return callback(new Error('没有可写入的存储组'));
      }

      var encBuf = fs.readFileSync(encTmpPath);
      var ws = writeResult.stream;
      ws.end(encBuf);
      try { fs.unlinkSync(encTmpPath); } catch(e) {}

      // 6) 创建存储记录（匹配正常上传的结构）
      var storageId = FileStorage.create(fileUuid, fileHash, task.file_size, task.file_size, 1, true, encResult.nonce);
      db.run('UPDATE file_storage SET group_id = ? WHERE id = ?', [groupId, storageId]);
      (writeResult.poolIds || []).forEach(function(pid) {
        FileStorage.addPath(storageId, pid, relPath, relPath);
      });
      UserFileRef.create(user.id, storageId, task.dir_id, task.file_name, task.mime_type);

      var vfId = VirtualFile.createWithEncVersion(user.id, task.dir_id, task.file_name, task.file_size, task.mime_type, relPath, fileUuid, 1);
      if (vfId) db.run('UPDATE virtual_files SET storage_id = ? WHERE id = ?', [storageId, vfId]);

      db.User.updateUsedBytes(user.id, task.file_size);

      // 7) 清理
      try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch(e) {}
      try {
        var TransferSession = require('../lib/redis').TransferSession;
        TransferSession.deleteUpload(transferId);
      } catch(e) {}

      // 8) 记录流量
      try {
        var ip = getClientIp({ headers: {}, ip: task.ip });
        db.TrafficLog.log(user.id, ip, 'upload', vfId || 0, task.file_name, task.file_size, task.file_size, 'file_transfer');
        db.TrafficQuota.addUsed(user.id, '', false, task.file_size);
      } catch(e) {}

      log.info('[Transfer] 上传完成: ' + task.file_name + ' vfId=' + vfId + ' storageId=' + storageId + ' groupId=' + groupId);
      callback(null, { storagePath: relPath, fileHash: fileHash, virtualFileId: vfId });
    });

    writeStream.on('error', function(e) {
      try { fs.unlinkSync(tmpPath); } catch(e2) {}
      callback(e);
    });

  } catch(e) {
    try { fs.unlinkSync(tmpPath); } catch(e2) {}
    callback(e);
  }
}

// ==================== POST /api/transfer/upload/cancel ====================
router.post('/transfer/upload/cancel', requireAuth, function(req, res) {
  var transferId = String(req.body.transfer_id || '').trim();
  if (!transferId) return res.json({ code: 1, message: '参数错误：需要 transfer_id', data: null });

  var task = db.TransferTask.findByTransferId(transferId);
  if (!task || task.user_id !== req.user.id) return res.json({ code: 2, message: '任务不存在或无权操作', data: null });

  db.TransferTask.cancelTask(task.id);
  db.TransferChunk.deleteByTask(task.id);
  var chunkDir = path.join(path.dirname(require.resolve('../lib/db')), '..', 'data', 'chunks', transferId);
  try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch(e) {}

  try {
    var TransferSession = require('../lib/redis').TransferSession;
    TransferSession.deleteUpload(transferId);
  } catch(e) {}

  log.info('[Transfer] 上传已取消: ' + task.file_name + ' transfer_id=' + transferId);
  res.json({ code: 0, message: '已取消' });
});

// ==================== POST /api/transfer/download/init ====================
router.post('/transfer/download/init', requireAuth, function(req, res) {
  var fileId = parseInt(req.body.file_id, 10) || 0;
  var dev = getDeviceInfo(req);

  if (!fileId) return res.json({ code: 1, message: '参数错误：需要 file_id', data: null });

  var file = db.VirtualFile.findById(fileId);
  if (!file || file.user_id !== req.user.id) return res.json({ code: 2, message: '文件不存在', data: null });

  var transferId = 'dl_' + crypto.randomUUID();
  try {
    var TransferSession = require('../lib/redis').TransferSession;
    TransferSession.createDownload(transferId, {
      fileId: fileId, userId: req.user.id, fileName: file.name, fileSize: file.size,
      bytesTransferred: 0, status: 'started', deviceId: dev.deviceId, deviceName: dev.deviceName, ip: getClientIp(req)
    });
  } catch(e) {}

  // 记录下载日志
  db.DownloadLog.log({
    user_id: req.user.id, file_id: fileId, file_name: file.name, file_size: file.size,
    device_id: dev.deviceId, device_name: dev.deviceName, ip: getClientIp(req), user_agent: dev.userAgent
  });

  res.json({ code: 0, data: { transfer_id: transferId, file_id: fileId, file_name: file.name, file_size: file.size } });
});

// ==================== GET /api/transfer/download/:id ====================
router.get('/transfer/download/:id', requireAuth, function(req, res) {
  var transferId = req.params.id;
  if (!transferId) return res.status(400).json({ code: 1, message: '需要 transfer_id', data: null });

  var TransferSession;
  try { TransferSession = require('../lib/redis').TransferSession; } catch(e) {}

  var fileId;
  TransferSession.getDownload(transferId).then(function(session) {
    if (!session) {
      // 从 transferId 解析 fileId (fallback)
      fileId = parseInt(transferId.replace('dl_', ''), 10) || 0;
      if (!fileId) return res.status(404).json({ code: 404, message: '下载会话已过期，请重新初始化', data: null });
    } else {
      fileId = session.fileId;
    }

    // 解析文件路径（复用 download 路由逻辑）
    var file = db.VirtualFile.findById(fileId);
    if (!file || file.user_id !== req.user.id) return res.status(404).json({ code: 404, message: '文件不存在', data: null });

    // 路径解析（复用 routes/file.js 的 StoragePool 逻辑）
    var filePath = file.storage_path;
    if (!filePath || !path.isAbsolute(filePath)) {
      // 从 file_storage_paths 解析
      var paths = db.query(
        'SELECT fsp.relative_path, sp.local_path FROM file_storage_paths fsp ' +
        'JOIN storage_pools sp ON fsp.pool_id = sp.id ' +
        'WHERE fsp.storage_id = ? AND fsp.status = ?',
        [file.storage_id || 0, 'active']
      );
      for (var i = 0; i < paths.length; i++) {
        var fp = path.join(paths[i].local_path, paths[i].relative_path);
        if (fs.existsSync(fp)) { filePath = fp; break; }
      }
    }
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(410).json({ code: 410, message: '文件已失效', data: { is_broken: true } });
    }

    var fileSize = fs.statSync(filePath).size;
    var encVersion = file.enc_version || 0;
    var decryptedSize = fileSize;
    var isEncrypted = false;

    // 加密检测
    if (encVersion === 1) {
      var v1Info = require('../lib/crypto').getV1FileInfo(filePath);
      if (v1Info && v1Info.isV1) { isEncrypted = true; decryptedSize = v1Info.originalSize; }
    } else if (encVersion !== -1 && fileSize >= 88) {
      var magicBuf = Buffer.alloc(4);
      var fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, magicBuf, 0, 4, 0);
      fs.closeSync(fd);
      var magic = magicBuf.toString('ascii');
      if (magic !== 'ftyp' && magic !== 'moov' && magic !== 'mdat' &&
          !(magicBuf[0]===0xFF && magicBuf[1]===0xD8) &&
          !(magicBuf[0]===0x89 && magicBuf[1]===0x50 && magicBuf[2]===0x4E && magicBuf[3]===0x47)) {
        isEncrypted = true; decryptedSize = fileSize - 88;
      }
    }

    // Range 支持（断点续传）
    var rangeHeader = req.headers.range;
    if (rangeHeader && encVersion === 1) {
      var rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (rangeMatch) {
        var start = parseInt(rangeMatch[1], 10) || 0;
        var end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : decryptedSize - 1;
        res.status(206);
        res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + decryptedSize);
        res.set('Content-Length', end - start + 1);
        res.set('Content-Type', file.mime_type || 'application/octet-stream');
        res.set('Accept-Ranges', 'bytes');
        var decryptStream = require('../lib/crypto').createV1DecryptStream(filePath, start, end);
        decryptStream.on('error', function() { if (!res.headersSent) res.status(500).end(); });
        decryptStream.pipe(res);
        return;
      }
    }

    res.set('Content-Type', file.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(file.name) + '"');
    res.set('Content-Length', decryptedSize);
    res.set('Accept-Ranges', 'bytes');

    if (!isEncrypted) {
      fs.createReadStream(filePath).pipe(res);
    } else if (encVersion === 1) {
      var stream = require('../lib/crypto').createV1DecryptStream(filePath, 0, decryptedSize - 1);
      stream.on('error', function() { if (!res.headersSent) res.status(500).end(); });
      stream.pipe(res);
    } else {
      var si = require('../lib/crypto').createDecryptStream(filePath);
      si.readStream.on('error', function() { if (!res.headersSent) res.status(500).end(); });
      si.readStream.pipe(res);
    }

    // 更新下载会话
    if (TransferSession) {
      TransferSession.updateDownload(transferId, { bytesTransferred: decryptedSize, status: 'completed' });
    }
  }).catch(function(e) {
    log.error('[Transfer] download error:', e.message);
    if (!res.headersSent) res.status(500).json({ code: 500, message: '下载失败', data: null });
  });
});

// ==================== GET /api/transfers — 传输列表 ====================
router.get('/transfers', requireAuth, function(req, res) {
  var user = req.user;
  var status = req.query.status || 'all';
  var limit = parseInt(req.query.limit, 10) || 30;
  var offset = parseInt(req.query.offset, 10) || 0;

  // 合并上传任务和下载日志
  var uploadTasks = db.TransferTask.listByUser(user.id, status, limit + offset, 0);
  var downloadLogs = db.DownloadLog.listByUser(user.id, limit, offset);

  // 转换为统一格式
  var items = [];
  uploadTasks.forEach(function(t) {
    items.push({
      id: 'u_' + t.id, type: 'upload', file_name: t.file_name, file_size: t.file_size,
      status: t.status, progress: t.progress, device_name: t.device_name,
      transfer_id: t.transfer_id, error_message: t.error_message,
      created_at: t.created_at, updated_at: t.updated_at,
      total_chunks: t.total_chunks, uploaded_chunks: t.uploaded_chunks
    });
  });
  downloadLogs.forEach(function(d) {
    items.push({
      id: 'd_' + d.id, type: 'download', file_name: d.file_name, file_size: d.file_size,
      status: d.status, progress: 100, device_name: d.device_name,
      created_at: d.created_at
    });
  });

  // 按时间排序
  items.sort(function(a, b) {
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  var total = db.TransferTask.countByUser(user.id, status) + db.DownloadLog.countByUser(user.id);

  res.json({ code: 0, data: { items: items.slice(offset, offset + limit), total: total } });
});

// ==================== GET /api/transfers/pending — 待处理传输 ====================
router.get('/transfers/pending', requireAuth, function(req, res) {
  var user = req.user;
  var pending = db.TransferTask.findPendingByUser(user.id);
  var result = pending.map(function(t) {
    return {
      id: t.id, transfer_id: t.transfer_id, file_name: t.file_name, file_size: t.file_size,
      total_chunks: t.total_chunks, uploaded_chunks: t.uploaded_chunks,
      progress: t.progress, status: t.status, dir_id: t.dir_id, device_name: t.device_name,
      created_at: t.created_at
    };
  });
  res.json({ code: 0, data: { pending: result } });
});

// ==================== POST /api/transfers/:id/retry — 重试 ====================
router.post('/transfers/:id/retry', requireAuth, function(req, res) {
  var taskId = parseInt(req.params.id, 10) || 0;
  if (!taskId) return res.json({ code: 1, message: '参数错误', data: null });

  var task = db.TransferTask.findById(taskId);
  if (!task || task.user_id !== req.user.id) return res.json({ code: 2, message: '任务不存在', data: null });

  // 检查是否还有 chunks
  var chunks = db.TransferChunk.findByTask(taskId);
  if (chunks.length === 0) {
    // 无 chunks → 重置进度从头开始
    db.TransferTask.updateProgress(taskId, 0, task.total_chunks);
    db.TransferTask.updateStatus(taskId, 'uploading', '');
  } else {
    db.TransferTask.updateStatus(taskId, 'uploading', '');
  }

  // 重建 Redis 会话
  try {
    var TransferSession = require('../lib/redis').TransferSession;
    TransferSession.createUpload(task.transfer_id, {
      taskId: task.id, userId: task.user_id, fileName: task.file_name, fileSize: task.file_size,
      mimeType: task.mime_type, fileHash: task.file_hash, dirId: task.dir_id,
      chunkSize: task.chunk_size, totalChunks: task.total_chunks, uploadedChunks: chunks.length,
      status: 'uploading', deviceId: task.device_id, deviceName: task.device_name, ip: task.ip
    });
  } catch(e) {}

  res.json({ code: 0, message: '已重置为待上传', data: { transfer_id: task.transfer_id, total_chunks: task.total_chunks, uploaded_chunks: chunks.length } });
});

// ==================== DELETE /api/transfers/clear — 清空历史记录 ====================
// 必须在 /:id 之前定义，否则 "clear" 会被 :id 参数捕获
router.delete('/transfers/clear', requireAuth, function(req, res) {
  var user = req.user;
  // 删除已完成/失败/取消的传输记录
  var cleared = db.TransferTask.cleanup(0); // days=0: clear all completed/error/cancelled now
  // 同时清理下载日志
  try {
    db.run("DELETE FROM download_logs WHERE user_id = ? AND status != 'started'", [user.id]);
  } catch(e) {}
  res.json({ code: 0, message: '已清空 ' + cleared + ' 条历史记录', data: { cleared: cleared } });
});

// ==================== DELETE /api/transfers/:id — 删除传输记录 ====================
router.delete('/transfers/:id', requireAuth, function(req, res) {
  var rawId = String(req.params.id);
  // 格式: "u_123" (upload) 或 "d_123" (download)
  if (rawId.startsWith('u_')) {
    var taskId = parseInt(rawId.substring(2), 10) || 0;
    var task = db.TransferTask.findById(taskId);
    if (!task || task.user_id !== req.user.id) return res.json({ code: 2, message: '任务不存在', data: null });

    // 清理 chunks
    var chunks = db.TransferChunk.findByTask(taskId);
    chunks.forEach(function(c) { try { fs.unlinkSync(c.chunk_path); } catch(e) {} });
    db.TransferChunk.deleteByTask(taskId);

    try {
      var TransferSession = require('../lib/redis').TransferSession;
      TransferSession.deleteUpload(task.transfer_id);
    } catch(e) {}

    // 清理 chunk 目录
    var chunkDir = path.join(path.dirname(require.resolve('../lib/db')), '..', 'data', 'chunks', task.transfer_id);
    try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch(e) {}

    db.TransferTask.delete(taskId);
    return res.json({ code: 0, message: '已删除' });
  }

  if (rawId.startsWith('d_')) {
    var dlId = parseInt(rawId.substring(2), 10) || 0;
    db.run('DELETE FROM download_logs WHERE id = ?', [dlId]);
    return res.json({ code: 0, message: '已删除' });
  }

  res.json({ code: 1, message: '无效的 ID', data: null });
});

module.exports = router;
