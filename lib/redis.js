const config = require('../config');

// ===================== Redis 客户端（延迟加载）=====================
var redisClient = null;
var redisConnected = false;

function getRedisClient() {
  if (redisClient) return redisClient;

  try {
    var Redis = require('ioredis');
  } catch (err) {
    console.warn('[Redis] Redis模块不可用，使用内存存储');
    return null;
  }

  try {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      db: config.redis.db,
      // 注意：不设 keyPrefix！connect-redis 会自己加前缀，其他模块也各自加前缀。
      // 这样可以避免 ioredis 的 keyPrefix 干扰 SCAN/KEYS 等遍历命令。
      retryStrategy: function(times) {
        if (times > 3) {
          console.warn('[Redis] 连接失败次数过多');
          return null;
        }
        return Math.min(times * 500, 2000);
      },
      maxRetriesPerRequest: 1
    });

    redisClient.on('ready', function() {
      console.log('[Redis] 连接成功 (DB ' + config.redis.db + ')');
      redisConnected = true;
    });

    redisClient.on('error', function(err) {
      if (!redisConnected) {
        console.warn('[Redis] 连接错误:', err.message);
      }
    });

    return redisClient;
  } catch (err) {
    console.warn('[Redis] Redis不可用，使用内存存储');
    return null;
  }
}


// ===================== 底层存储 =====================
// 内存存储（备用）
var memoryStore = {};

var MemoryBackend = {
  get: function(key) {
    var record = memoryStore[key];
    if (!record) return Promise.resolve(null);
    if (record.expires && Date.now() > record.expires) {
      delete memoryStore[key];
      return Promise.resolve(null);
    }
    return Promise.resolve(record.value);
  },
  set: function(key, value, ttlSeconds) {
    memoryStore[key] = { value: value };
    if (ttlSeconds) memoryStore[key].expires = Date.now() + ttlSeconds * 1000;
  },
  del: function(key) { delete memoryStore[key]; },
  incr: function(key, ttlSeconds) {
    var record = memoryStore[key];
    if (!record || (record.expires && Date.now() > record.expires)) {
      memoryStore[key] = { value: 1 };
      if (ttlSeconds) memoryStore[key].expires = Date.now() + ttlSeconds * 1000;
      return Promise.resolve(1);
    }
    record.value++;
    return Promise.resolve(record.value);
  },
  ttl: function(key) {
    var record = memoryStore[key];
    if (!record || !record.expires) return Promise.resolve(-1);
    if (Date.now() > record.expires) {
      delete memoryStore[key];
      return Promise.resolve(-1);
    }
    return Promise.resolve(Math.ceil((record.expires - Date.now()) / 1000));
  }
};

// Redis 后端（优先使用）
var RedisBackend = null;

function getBackend() {
  var client = getRedisClient();
  // 延迟初始化：RedisClient 已创建但尚未 ready 时，先用 pipeline 测试
  // 等 ready 后 backend 会被替换为真实 Redis 后端
  if (!client) return MemoryBackend;

  // 首次调用时初始化 RedisBackend（用实时 client）
  return {
    get: function(key) { return client.get(key).catch(function() { return null; }); },
    set: function(key, value, ttlSeconds) {
      if (ttlSeconds) return client.set(key, value, 'EX', ttlSeconds).catch(function() {});
      return client.set(key, value).catch(function() {});
    },
    del: function(key) { return client.del(key).catch(function() {}); },
    incr: function(key, ttlSeconds) {
      var pipeline = client.pipeline();
      pipeline.incr(key);
      if (ttlSeconds) pipeline.expire(key, ttlSeconds);
      return pipeline.exec().then(function(results) { return results[0][1]; }).catch(function() { return 1; });
    },
    ttl: function(key) { return client.ttl(key).catch(function() { return -1; }); }
  };
}

var REDIS_PREFIX = config.redis.keyPrefix; // 'ambush:'

// ===================== VerifyCode =====================
var VerifyCode = {
  generate: function() { return Math.random().toString().slice(2, 8); },

  canSend: function(email, type) {
    return getBackend().get(REDIS_PREFIX + 'send_limit:' + type + ':' + email).then(function(r) { return !r; });
  },

  setSendLimit: function(email, type) {
    return getBackend().set(REDIS_PREFIX + 'send_limit:' + type + ':' + email, '1', 60);
  },

  set: function(email, type, code) {
    return getBackend().set(REDIS_PREFIX + 'verify:' + type + ':' + email, code, config.security.verifyCodeExpire);
  },

  get: function(email, type) {
    return getBackend().get(REDIS_PREFIX + 'verify:' + type + ':' + email).catch(function() { return null; });
  },

  del: function(email, type) {
    return getBackend().del(REDIS_PREFIX + 'verify:' + type + ':' + email);
  },

  verify: function(email, type, code) {
    return VerifyCode.get(email, type).then(function(result) {
      if (!result || result !== code) return false;
      VerifyCode.del(email, type);
      return true;
    });
  }
};

// ===================== LoginError =====================
var LoginError = {
  getCount: function(email) {
    return getBackend().get(REDIS_PREFIX + 'login_err:' + email).then(function(r) { return parseInt(r) || 0; });
  },
  inc: function(email) { return getBackend().incr(REDIS_PREFIX + 'login_err:' + email, config.security.loginErrorExpire); },
  clear: function(email) { return getBackend().del(REDIS_PREFIX + 'login_err:' + email); },
  isLocked: function(email) { return LoginError.getCount(email).then(function(c) { return c >= config.security.maxLoginErrors; }); },
  getTTL: function(email) { return getBackend().ttl(REDIS_PREFIX + 'login_err:' + email); }
};

// ===================== ResetAttempt =====================
var ResetAttempt = {
  getCount: function(email) {
    return getBackend().get(REDIS_PREFIX + 'reset_verify_err:' + email).then(function(r) { return parseInt(r) || 0; });
  },
  inc: function(email) { return getBackend().incr(REDIS_PREFIX + 'reset_verify_err:' + email, 60); },
  clear: function(email) { return getBackend().del(REDIS_PREFIX + 'reset_verify_err:' + email); },
  isLimited: function(email) { return ResetAttempt.getCount(email).then(function(c) { return c >= 3; }); },
  getTTL: function(email) { return getBackend().ttl(REDIS_PREFIX + 'reset_verify_err:' + email); }
};

// ===================== Session Store =====================
var SessionRedisStore = null;

function getSessionStore() {
  if (SessionRedisStore) return SessionRedisStore;

  var client = getRedisClient();
  if (!client) {
    console.warn('[Session] Redis不可用，使用内存存储 sessions');
    return null;
  }

  try {
    var RedisStoreLib = require('connect-redis').RedisStore;
    SessionRedisStore = new RedisStoreLib({
      client: client,
      prefix: config.redis.keyPrefix + 'session:',
      enableReadyCheck: true
    });
    console.log('[Session] 使用 Redis 存储 sessions');
    return SessionRedisStore;
  } catch (err) {
    console.warn('[Session] Redis不可用，使用内存存储 sessions');
    return null;
  }
}

// ===================== DelFile：公共文件删除标记 ====================
// Redis Key 规则：ambush:del_pub:{seq} -> JSON{...}
// seq 为自增序号，存储在 Redis key "ambush:del_pub:seq" 中
var DelFile = {
  // 获取下一个序号（Redis INCR 原子操作，保证多文件同时删除也不会冲突）
  _nextSeq: function() {
    return getBackend().incr(REDIS_PREFIX + 'del_pub:seq', 30 * 24 * 3600); // 30天TTL
  },

  // 存储一条删除标记（seq 由调用方传入）
  add: function(fileName, deletedPath, size, mimeType, deletedBy, seq) {
    var now = Date.now();
    var expiresAt = now + 30 * 24 * 3600 * 1000; // 30天
    var key = REDIS_PREFIX + 'del_pub:' + seq;
    var record = JSON.stringify({
      originalName: fileName,
      storagePath: deletedPath,
      size: size,
      mimeType: mimeType,
      deletedBy: deletedBy,
      deletedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      timeMs: now,
      seq: seq
    });
    return getBackend().set(key, record, 30 * 24 * 3600);
  },

  // 获取一条删除标记
  get: function(seq) {
    return getBackend().get(REDIS_PREFIX + 'del_pub:' + seq).then(function(r) {
      if (!r) return null;
      try {
        var obj = JSON.parse(r);
        obj._key = String(seq);
        return obj;
      } catch (e) { return null; }
    });
  },

  // 删除一条记录
  remove: function(seq) {
    return getBackend().del(REDIS_PREFIX + 'del_pub:' + seq);
  },

  // 列出所有删除标记（仅返回当前未过期的）
  // 注意：去掉 keyPrefix 后，scan MATCH 需手动加前缀
  listAll: function() {
    return new Promise(function(resolve) {
      var client = getRedisClient();
      var backend = getBackend();
      if (!client) {
        resolve([]);
        return;
      }
      var allKeys = [];
      (function scanNext(cursor) {
        client.scan(cursor, 'MATCH', REDIS_PREFIX + 'del_pub:*', 'COUNT', 100).then(function(result) {
          var newCursor = result[0];
          var batch = result[1];
          if (batch && batch.length > 0) {
            allKeys = allKeys.concat(batch);
          }
          if (newCursor !== '0') {
            scanNext(newCursor);
          } else {
            if (allKeys.length === 0) {
              resolve([]);
              return;
            }
            var promises = allKeys.map(function(fullKey) {
              // 跳过序号计数器本身
              if (fullKey === REDIS_PREFIX + 'del_pub:seq') return Promise.resolve(null);
              return backend.get(fullKey).then(function(r) {
                if (!r) return null;
                try {
                  var obj = JSON.parse(r);
                  obj._key = fullKey.replace(REDIS_PREFIX + 'del_pub:', '');
                  return obj;
                } catch (e) { return null; }
              });
            });
            Promise.all(promises).then(function(results) {
              var now = Date.now();
              var valid = results.filter(function(r) {
                return r && new Date(r.expiresAt).getTime() > now;
              });
              valid.sort(function(a, b) { return b.timeMs - a.timeMs; });
              resolve(valid);
            });
          }
        }).catch(function() {
          resolve([]);
        });
      })('0');
    });
  },

  // 删除所有记录
  clearAll: function() {
    return new Promise(function(resolve) {
      var client = getRedisClient();
      if (!client) {
        resolve(0);
        return;
      }
      var allKeys = [];
      (function scanNext(cursor) {
        client.scan(cursor, 'MATCH', REDIS_PREFIX + 'del_pub:*', 'COUNT', 100).then(function(result) {
          var newCursor = result[0];
          var batch = result[1];
          if (batch && batch.length > 0) {
            allKeys = allKeys.concat(batch);
          }
          if (newCursor !== '0') {
            scanNext(newCursor);
          } else {
            var shortKeys = allKeys.filter(function(k) { return k !== REDIS_PREFIX + 'del_pub:seq'; });
            if (shortKeys.length === 0) {
              resolve(0);
              return;
            }
            var pipeline = client.pipeline();
            shortKeys.forEach(function(k) { pipeline.del(k); });
            pipeline.exec().then(function() {
              resolve(shortKeys.length);
            }).catch(function() {
              resolve(0);
            });
          }
        }).catch(function() {
          resolve(0);
        });
      })('0');
    });
  },

  // 清理过期文件（定时任务调用）：删除物理文件并移除Redis记录
  purgeExpired: function() {
    return new Promise(function(resolve) {
      var client = getRedisClient();
      var backend = getBackend();
      if (!client) {
        resolve({ count: 0, files: 0 });
        return;
      }
      var allKeys = [];
      (function scanNext(cursor) {
        client.scan(cursor, 'MATCH', REDIS_PREFIX + 'del_pub:*', 'COUNT', 100).then(function(result) {
          var newCursor = result[0];
          var batch = result[1];
          if (batch && batch.length > 0) {
            allKeys = allKeys.concat(batch);
          }
          if (newCursor !== '0') {
            scanNext(newCursor);
          } else {
            var promises = allKeys.map(function(fullKey) {
              if (fullKey === REDIS_PREFIX + 'del_pub:seq') return Promise.resolve(null);
              return backend.get(fullKey).then(function(r) {
                if (!r) return null;
                try {
                  var obj = JSON.parse(r);
                  obj._key = fullKey;
                  return obj;
                } catch (e) { return null; }
              });
            });
            Promise.all(promises).then(function(results) {
              var now = Date.now();
              var expired = results.filter(function(r) {
                return r && new Date(r.expiresAt).getTime() <= now;
              });
              var deletedCount = 0;
              expired.forEach(function(r) {
                try {
                  if (fs.existsSync(r.storagePath)) {
                    fs.unlinkSync(r.storagePath);
                  }
                } catch (e) {}
                backend.del(r._key);
                deletedCount++;
              });
              resolve({ count: deletedCount, files: deletedCount });
            });
          }
        }).catch(function() {
          resolve({ count: 0, files: 0 });
        });
      })('0');
    });
  },

  // 查找目录下同名文件已用的最大序号（用于生成下一个序号）
  _findMaxSeq: function(dirPath, baseName) {
    try {
      var entries = fs.readdirSync(dirPath);
      var maxSeq = 0;
      var prefix = baseName + '.';
      entries.forEach(function(name) {
        if (name.startsWith(prefix) && name.endsWith('.delbak')) {
          var middle = name.slice(prefix.length, name.length - '.delbak'.length);
          var seq = parseInt(middle, 10);
          if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
      });
      return maxSeq;
    } catch (e) {
      return 0;
    }
  }
};

// ===================== 流量缓冲写入 ====================
// 视频预览流量先存 Redis，每30秒或积累100条后批量写入DB
var REDIS_TRAFFIC_PREFIX = 'ambush:traffic:';
var REDIS_TRAFFIC_LIST = 'ambush:traffic:list';
var trafficBuffer = []; // 内存缓冲
var trafficFlushTimer = null;
var trafficFlushRunning = false;

var TrafficBuffer = {
  // 添加一条流量记录
  add: function(record) {
    trafficBuffer.push(record);
    // 缓冲超过100条立即刷新
    if (trafficBuffer.length >= 100) {
      TrafficBuffer.flush();
    }
    // 启动定时刷新（每30秒一次）
    if (!trafficFlushTimer) {
      trafficFlushTimer = setInterval(function() { TrafficBuffer.flush(); }, 30000);
    }
  },

  // 刷新到数据库
  flush: function() {
    if (trafficFlushRunning || trafficBuffer.length === 0) return;
    trafficFlushRunning = true;
    var toFlush = trafficBuffer.splice(0, trafficBuffer.length);
    try {
      var TrafficLog = require('./db').TrafficLog;
      var TrafficQuota = require('./db').TrafficQuota;
      TrafficLog.logBatch(toFlush);
      // 更新配额表
      var userTotals = {};
      var guestTotals = {};
      toFlush.forEach(function(r) {
        if (r.user_id > 0) {
          userTotals[r.user_id] = (userTotals[r.user_id] || 0) + r.bytes_count;
        } else if (r.guest_ip) {
          guestTotals[r.guest_ip] = (guestTotals[r.guest_ip] || 0) + r.bytes_count;
        }
      });
      Object.keys(userTotals).forEach(function(uid) {
        TrafficQuota.addUsed(parseInt(uid), '', false, userTotals[uid]);
      });
      Object.keys(guestTotals).forEach(function(ip) {
        TrafficQuota.addUsed(0, ip, true, guestTotals[ip]);
      });
    } catch (e) {
      console.error('[TrafficBuffer] flush error:', e.message, e.stack);
      // 写回内存缓冲
      trafficBuffer = toFlush.concat(trafficBuffer);
    }
    trafficFlushRunning = false;
  }
};

// 服务关闭时刷新剩余缓冲
process.on('exit', function() { TrafficBuffer.flush(); });

// ===================== 用户会话追踪 =====================
var SESSION_TRACK_PREFIX = REDIS_PREFIX + 'user_sessions:';

var SessionTracker = {
  // 记录用户登录会话（同一设备 ID 会更新旧记录而非新增）
  addSession: function(userId, sessionId, info) {
    var key = SESSION_TRACK_PREFIX + userId;
    var deviceId = info.deviceId || '';
    var entry = JSON.stringify({
      sid: sessionId,
      ip: info.ip || '',
      ua: info.userAgent || '',
      device: info.device || '未知设备',
      deviceId: deviceId,
      loginAt: new Date().toISOString(),
      lastSeen: Date.now()
    });
    // If device ID is provided, remove old entries for same device
    var backend = getBackend();
    var client = getRedisClient();
    var addNew = function() {
      return backend.set(key + ':' + sessionId, entry, 7 * 24 * 3600).then(function() {
        if (client) { client.sadd(key, sessionId); client.expire(key, 7 * 24 * 3600); }
      }).catch(function() {});
    };
    if (deviceId && client) {
      // Find and remove old sessions with same device ID
      client.smembers(key).then(function(members) {
        if (!members || members.length === 0) return addNew();
        var toCheck = members.filter(function(sid) { return sid !== sessionId; });
        if (toCheck.length === 0) return addNew();
        var checked = 0;
        toCheck.forEach(function(sid) {
          backend.get(key + ':' + sid).then(function(r) {
            checked++;
            if (r) {
              try {
                var old = JSON.parse(r);
                if (old.deviceId === deviceId) {
                  client.srem(key, sid);
                  backend.del(key + ':' + sid);
                  console.log('[SessionTracker] Removed old session for device ' + deviceId.substring(0,8));
                }
              } catch(e) {}
            }
            if (checked >= toCheck.length) addNew();
          }).catch(function() { checked++; if (checked >= toCheck.length) addNew(); });
        });
      }).catch(function() { addNew(); });
    } else {
      return addNew();
    }
  },

  // 移除会话
  removeSession: function(userId, sessionId) {
    var key = SESSION_TRACK_PREFIX + userId;
    var client = getRedisClient();
    if (client) {
      client.srem(key, sessionId);
      client.del(key + ':' + sessionId);
    }
  },

  // 获取用户所有活跃会话
  listSessions: function(userId) {
    return new Promise(function(resolve) {
      var client = getRedisClient();
      var backend = getBackend();
      if (!client) { resolve([]); return; }
      var key = SESSION_TRACK_PREFIX + userId;
      client.smembers(key).then(function(members) {
        if (!members || members.length === 0) { resolve([]); return; }
        var promises = members.map(function(sid) {
          return backend.get(key + ':' + sid).then(function(r) {
            if (!r) return null;
            try { var obj = JSON.parse(r); obj._sid = sid; return obj; } catch(e) { return null; }
          });
        });
        Promise.all(promises).then(function(results) {
          resolve(results.filter(Boolean).sort(function(a, b) { return b.lastSeen - a.lastSeen; }));
        });
      }).catch(function() { resolve([]); });
    });
  },

  // 更新会话最后活跃时间（每次请求调用，轻量）
  touch: function(userId, sessionId) {
    var key = SESSION_TRACK_PREFIX + userId + ':' + sessionId;
    var backend = getBackend();
    backend.get(key).then(function(r) {
      if (r) {
        try {
          var obj = JSON.parse(r);
          obj.lastSeen = Date.now();
          backend.set(key, JSON.stringify(obj), 7 * 24 * 3600);
        } catch(e) {}
      }
    }).catch(function() {});
  },

  // 获取在线数量
  countOnline: function(userId) {
    return SessionTracker.listSessions(userId).then(function(sessions) {
      return sessions.filter(function(s) { return Date.now() - s.lastSeen < 5 * 60 * 1000; }).length;
    });
  }
};

// ===================== TransferSession：断点续传会话 =====================
// Redis Key: ambush:transfer:upload:{transferId} / ambush:transfer:download:{transferId}
// TTL: 86400 秒（1天）
var TransferSession = {
  _serialize: function(data) { return JSON.stringify(data); },
  _deserialize: function(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e) { return null; }
  },

  // —— 上传会话 ——
  createUpload: function(transferId, data) {
    var key = REDIS_PREFIX + 'transfer:upload:' + transferId;
    return getBackend().set(key, TransferSession._serialize(data), 86400);
  },
  getUpload: function(transferId) {
    var key = REDIS_PREFIX + 'transfer:upload:' + transferId;
    return getBackend().get(key).then(TransferSession._deserialize);
  },
  updateUpload: function(transferId, data) {
    var key = REDIS_PREFIX + 'transfer:upload:' + transferId;
    return getBackend().set(key, TransferSession._serialize(data), 86400);
  },
  deleteUpload: function(transferId) {
    var key = REDIS_PREFIX + 'transfer:upload:' + transferId;
    return getBackend().del(key);
  },

  // —— 下载会话 ——
  createDownload: function(transferId, data) {
    var key = REDIS_PREFIX + 'transfer:download:' + transferId;
    return getBackend().set(key, TransferSession._serialize(data), 86400);
  },
  getDownload: function(transferId) {
    var key = REDIS_PREFIX + 'transfer:download:' + transferId;
    return getBackend().get(key).then(TransferSession._deserialize);
  },
  updateDownload: function(transferId, data) {
    var key = REDIS_PREFIX + 'transfer:download:' + transferId;
    return getBackend().set(key, TransferSession._serialize(data), 86400);
  },
  deleteDownload: function(transferId) {
    var key = REDIS_PREFIX + 'transfer:download:' + transferId;
    return getBackend().del(key);
  }
};

// ==================== 公共目录树缓存（全局搜索用） ====================
var PublicDirCache = {
  CACHE_KEY: REDIS_PREFIX + 'pubdir:tree',
  TTL: 300, // 5分钟

  // 获取缓存的目录树（返回对象或null）
  getTree: function() {
    return new Promise(function(resolve) {
      getBackend().get(PublicDirCache.CACHE_KEY).then(function(raw) {
        if (!raw) return resolve(null);
        try {
          var tree = JSON.parse(raw);
          resolve(tree);
        } catch(e) {
          resolve(null);
        }
      }).catch(function() {
        resolve(null);
      });
    });
  },

  // 设置目录树缓存
  setTree: function(tree) {
    return getBackend().set(PublicDirCache.CACHE_KEY, JSON.stringify(tree), PublicDirCache.TTL);
  },

  // 失效缓存（公共目录文件变更时调用）
  invalidate: function() {
    return getBackend().del(PublicDirCache.CACHE_KEY);
  }
};

// 服务关闭时刷新剩余缓冲
process.on('exit', function() { TrafficBuffer.flush(); });

module.exports = {
  VerifyCode: VerifyCode,
  LoginError: LoginError,
  ResetAttempt: ResetAttempt,
  DelFile: DelFile,
  getSessionStore: getSessionStore,
  TrafficBuffer: TrafficBuffer,
  SessionTracker: SessionTracker,
  TransferSession: TransferSession,
  PublicDirCache: PublicDirCache
};
