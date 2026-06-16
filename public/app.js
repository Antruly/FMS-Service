/* ============================================================
   🌌 Sci-Fi File Manager — Application Logic (Full v3)
   ============================================================ */

(function () {
  'use strict';

  // ---------- Config ----------
  var CONFIG = {
    baseApiUrl: '/api',
    toastDuration: 3000,
    wsUrl: (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws'
  };

  // ---------- CSRF Token ----------
  var csrfToken = null;

  // 启动时从多个来源恢复 CSRF token
  (function initCsrfToken() {
    // 1. 从 localStorage 恢复（由登录页写入）
    var saved = localStorage.getItem('csrfToken');
    if (saved) {
      csrfToken = saved;
      localStorage.removeItem('csrfToken');  // 用一次就清掉
    }
    // 2. 从服务端获取（通过任意请求的响应头）
    fetchCsrfToken();
  })();

  // 从服务端读取 CSRF token（通过 fetch 获取后存储）
  function fetchCsrfToken() {
    fetchCsrfTokenAsync().catch(function() {});
  }

  // 返回 Promise，供 apiPost 等需要 token 的地方等待
  function fetchCsrfTokenAsync() {
    // 优先用 axios（已配置拦截器，自动从响应头提取 token）
    return axios.get(CONFIG.baseApiUrl + '/auth/me', {
      skipCsrf: true  // 标记跳过 CSRF 检查（避免循环）
    }).then(function(r) {
      // token 已由 axios 拦截器自动更新
      if (!csrfToken && r.headers && r.headers['x-csrf-token']) {
        csrfToken = r.headers['x-csrf-token'];
      }
      return csrfToken;
    }).catch(function() {
      // axios 失败时回退 fetch
      return fetch('/api/auth/me', { credentials: 'include' })
        .then(function(res) {
          var token = res.headers.get('X-CSRF-Token');
          if (token) csrfToken = token;
          return csrfToken;
        })
        .catch(function() { return null; });
    });
  }

  // 拦截原生 fetch 注入 CSRF token
  var _originalFetch = window.fetch;
  window.fetch = function(url, options) {
    options = options || {};
    if (csrfToken && options.method && options.method.toUpperCase() !== 'GET') {
      options.headers = options.headers || {};
      if (options.headers instanceof Headers) {
        options.headers.set('X-CSRF-Token', csrfToken);
      } else {
        options.headers['X-CSRF-Token'] = csrfToken;
      }
    }
    return _originalFetch.call(window, url, options).then(function(res) {
      var newToken = res.headers.get('X-CSRF-Token');
      if (newToken) csrfToken = newToken;
      return res;
    });
  };

  // 拦截 XMLHttpRequest 注入 CSRF token
  var _origXHROpen = XMLHttpRequest.prototype.open;
  var _origXHRSend = XMLHttpRequest.prototype.send;
  var _origXHRSetReqHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._csrfMethod = method;
    this._csrfUrl = url;
    this._csrfHeaderSet = false;
    return _origXHROpen.apply(this, arguments);
  };
  // 拦截 setRequestHeader，检测 axios 等库是否已通过拦截器设置了 CSRF header
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    if (header && header.toLowerCase() === 'x-csrf-token') {
      this._csrfHeaderSet = true;
    }
    return _origXHRSetReqHdr.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    // 只有当其他拦截器（axios）没设置过 CSRF header 时才添加，避免重复导致 "token, token"
    if (csrfToken && this._csrfMethod && this._csrfMethod.toUpperCase() !== 'GET' && !this._csrfHeaderSet) {
      _origXHRSetReqHdr.call(this, 'X-CSRF-Token', csrfToken);
    }
    var xhr = this;
    xhr.addEventListener('readystatechange', function() {
      if (xhr.readyState === 2 || xhr.readyState === 4) {
        var newToken = xhr.getResponseHeader('X-CSRF-Token');
        if (newToken) csrfToken = newToken;
      }
    });
    return _origXHRSend.apply(this, arguments);
  };

  // WebSocket 客户端
  var ws = null;
  var wsReconnectTimer = null;
  var wsReconnectDelay = 3000;
  var wsMaxReconnectDelay = 30000;
  var wsEnabled = false;

  // 初始化 WebSocket 连接
  function initWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    // 如果没有用户信息（未登录），不建立连接
    if (!state.user || !state.user.id) {
      console.log('[WS] 未登录，跳过 WebSocket 连接');
      return;
    }

    try {
      ws = new WebSocket(CONFIG.wsUrl);

      ws.onopen = function() {
        console.log('[WS] 已连接，发送认证...');
        wsEnabled = true;
        wsReconnectDelay = 3000;
        if (wsReconnectTimer) {
          clearTimeout(wsReconnectTimer);
          wsReconnectTimer = null;
        }
        // 发送认证消息，包含用户 ID
        sendWsMessage({ type: 'auth', userId: state.user.id });
      };

      ws.onmessage = function(event) {
        try {
          var msg = JSON.parse(event.data);
          handleWebSocketMessage(msg);
        } catch (e) {
          console.error('[WS] 消息解析失败:', e);
        }
      };

      ws.onclose = function(event) {
        console.log('[WS] 连接关闭:', event.code, event.reason);
        wsEnabled = false;
        ws = null;
        scheduleReconnect();
      };

      ws.onerror = function(err) {
        console.error('[WS] 连接错误:', err);
        wsEnabled = false;
      };

    } catch (e) {
      console.error('[WS] 创建连接失败:', e);
      scheduleReconnect();
    }
  }

  // 检查 App 版本更新
  var _versionChecked = false;
  function checkAppVersion() {
    if (_versionChecked) return;
    _versionChecked = true;
    var lastCheck = localStorage.getItem('_fs_last_version_check');
    if (lastCheck && Date.now() - parseInt(lastCheck) < 3600000) return; // 1小时内不重复检查
    localStorage.setItem('_fs_last_version_check', Date.now());

    axios.get('/api/version/latest', { withCredentials: false }).then(function(r) {
      if (r.data.code !== 0 || !r.data.data) return;
      var latest = r.data.data;
      var currentVer = localStorage.getItem('_fs_app_version') || '0.0.0';
      if (compareVersions(latest.version, currentVer) > 0) {
        // 显示更新提示条
        var bar = document.createElement('div');
        bar.id = 'version-update-bar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:linear-gradient(135deg,#0f9b8e,#0d7d72);color:#fff;padding:8px 16px;text-align:center;font-size:13px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.3)';
        bar.innerHTML = '&#128230; 新版本 v' + latest.version + ' 可用 (' + formatFileSize(latest.size || 0) + ') — 点击下载';
        bar.addEventListener('click', function() {
          if (latest.url) {
            var a = document.createElement('a');
            a.href = latest.url; a.download = ''; document.body.appendChild(a);
            a.click(); document.body.removeChild(a);
          }
          bar.remove();
        });
        document.body.appendChild(bar);
        setTimeout(function() { if (bar.parentNode) bar.remove(); }, 30000);
      }
    }).catch(function() {});
  }
  function compareVersions(a, b) {
    var pa = (a || '0.0.0').split('.').map(Number);
    var pb = (b || '0.0.0').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  // 发送 WebSocket 消息
  function sendWsMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // 调度重连
  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    console.log('[WS] ' + (wsReconnectDelay / 1000) + '秒后尝试重连...');
    wsReconnectTimer = setTimeout(function() {
      wsReconnectTimer = null;
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, wsMaxReconnectDelay);
      initWebSocket();
    }, wsReconnectDelay);
  }

  // 处理 WebSocket 消息
  function handleWebSocketMessage(msg) {
    if (msg.type === 'offline_task') {
      handleOfflineTaskUpdate(msg);
    }
  }

  // 处理离线任务更新
  function handleOfflineTaskUpdate(msg) {
    var action = msg.action;
    var taskId = msg.taskId;
    var data = msg.data || {};

    // 同步更新 offlineState.tasks 中的任务
    var task = offlineState.tasks.find(function(t) { return t.id === taskId; });

    if (action === 'created' && data) {
      // 新任务创建（注意：HTTP响应已在createOfflineTask中添加任务，这里只处理其他来源的推送如多端同步）
      if (!offlineState.tasks.find(function(t) { return t.id === taskId; })) {
        offlineState.tasks.unshift(data);
        renderOfflineTasks();
      }
    } else if (action === 'started' || action === 'progress') {
      // 下载进度更新
      if (task) {
        task.status = data.status || 'downloading';
        task.progress = data.progress;
        task.downloaded_bytes = data.downloaded_bytes;
        task.total_bytes = data.total_bytes;
        task.speed_bps = data.speed_bps;
        updateOfflineTaskInList(taskId, task.status, task.progress, task.downloaded_bytes);
      } else if (data.task) {
        // 任务不在本地列表中（可能是页面初始化窗口期丢失了 created 消息），用推送的完整对象添加
        offlineState.tasks.unshift(data.task);
        renderOfflineTasks();
      } else {
        // 既没有本地任务也没有推送的任务对象，重新渲染列表（会重新获取最新数据）
        renderOfflineTasks();
      }
    } else if (action === 'completed') {
      // 下载完成：保留已下载字节数（= 总大小），不清零
      if (task) {
        task.status = 'completed';
        task.progress = 100;
        if (data.total_bytes) task.total_bytes = data.total_bytes;
        if (data.downloaded_bytes > 0) task.downloaded_bytes = data.downloaded_bytes;
        else if (!task.downloaded_bytes && task.total_bytes) task.downloaded_bytes = task.total_bytes;
        updateOfflineTaskInList(taskId, 'completed', 100, task.downloaded_bytes || task.total_bytes || null);
        showToast('下载完成！', '&#10004;');
      } else if (data.task) {
        // 任务不在列表中，用推送的完整对象添加
        offlineState.tasks.unshift(data.task);
        renderOfflineTasks();
        showToast('下载完成！', '&#10004;');
      }
    } else if (action === 'failed') {
      // 下载失败
      if (task) {
        task.status = 'failed';
        task.error = data.error || '未知错误';
        updateOfflineTaskInList(taskId, 'failed', 0, 0, task.error);
        showToast('下载失败: ' + task.error, '&#9888;');
      } else if (data.task) {
        // 任务不在列表中，用推送的完整对象添加
        offlineState.tasks.unshift(data.task);
        renderOfflineTasks();
        showToast('下载失败: ' + (data.error || '未知错误'), '&#9888;');
      }
    }
  }

  // 主动关闭 WebSocket
  function closeWebSocket() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
  }

  // 全局暴露（提前初始化，避免后续赋值找不到对象）
  window.__fm = window.__fm || {};

  // ---------- 文件名/目录名校验（兼容 Windows + Linux）----------
  // 同时禁止 Windows 保留名称（CON/PRN/AUX/NUL/COM1-9/LPT1-9）和开头/结尾点号
  function validateFileName(name, maxLength) {
    maxLength = maxLength || 100;
    if (typeof name !== 'string') return { valid: false, message: '名称类型无效' };
    var t = name.trim();
    if (!t) return { valid: false, message: '名称不能为空' };
    if (t.length > maxLength) return { valid: false, message: '名称过长（最多 ' + maxLength + ' 个字符）' };
    // 字符校验（\ / : * ? " < > | 是所有平台都禁止的）
    if (/[\\/:*?"<>|]/.test(t)) return { valid: false, message: '名称不能包含 \\ / : * ? " < > |' };
    // Windows: 不能以 . 开头或结尾
    if (t.startsWith('.')) return { valid: false, message: '名称不能以点号(.)开头' };
    if (t.endsWith('.')) return { valid: false, message: '名称不能以点号(.)结尾' };
    // Windows 保留名称（不区分大小写）
    var u = t.toUpperCase();
    var reserved = ['CON','PRN','AUX','NUL','COM1','COM2','COM3','COM4','COM5','COM6','COM7','COM8','COM9','LPT1','LPT2','LPT3','LPT4','LPT5','LPT6','LPT7','LPT8','LPT9'];
    if (reserved.indexOf(u) >= 0) return { valid: false, message: '"' + t + '" 是系统保留名称，不能使用' };
    // CON/PRN/AUX 后面跟任何内容（如 CON.txt）都不允许
    if (/^(CON|PRN|AUX)\./i.test(t)) return { valid: false, message: '"' + t + '" 是系统保留名称，不能使用' };
    return { valid: true, message: '' };
  }

  function validateDirName(name) { return validateFileName(name, 100); }

  // ---------- State ----------
  var state = {
    // 视图
    currentView: 'files', // 'files' | 'profile' | 'change-password' | 'admin-users' | 'admin-quota'
    currentPath: '',       // 当前虚拟目录路径，逗号分隔的ID，如 "0,5"
    currentDirId: 0,       // 当前目录的 dir_id（个人目录）
    currentPublicPath: '',  // 公共目录当前相对路径，如 "folder1/sub"
    _personalBreadcrumb: [], // 个人目录面包屑链 [{id, name}, ...]，由后端返回
    fileData: [],          // 当前目录的项
    sortConfig: { key: 'name', order: 'asc' },
    viewMode: localStorage.getItem('viewMode') || 'grid',
    theme: localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    searchQuery: '',
    isLoading: false,

    // 用户
    user: null, // { id, email, nickname, is_admin, quota_bytes, used_bytes }
    userMenuOpen: false,
    isAdmin: false,

    // 目录类型: 'personal' | 'public'（默认个人目录，普通用户可创建文件夹）
    dirType: 'personal',

    // 多选状态
    selectedFiles: [], // 选中的文件ID数组
    isSelectionMode: false,
  };

  // ---------- Icon & Color Map ----------
  var ICON_MAP = {
    folder: '&#128193;',
    'image/jpeg': '&#127912;', 'image/png': '&#127912;', 'image/gif': '&#127912;',
    'image/webp': '&#127912;', 'image/svg+xml': '&#127912;',
    'video/mp4': '&#127909;', 'video/webm': '&#127909;',
    'audio/mpeg': '&#127925;', 'audio/wav': '&#127925;', 'audio/ogg': '&#127925;',
    'application/pdf': '&#128196;',
    'application/msword': '&#128196;',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '&#128196;',
    'application/vnd.ms-excel': '&#128200;',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '&#128200;',
    'text/plain': '&#128221;', 'text/csv': '&#128221;', 'application/json': '&#128221;',
    'application/javascript': '&#128221;',
    'application/zip': '&#128230;', 'application/x-rar-compressed': '&#128230;',
    'application/x-7z-compressed': '&#128230;',
    unknown: '&#128462;',
  };

  var TYPE_CLASS_MAP = {
    folder: 'type-folder',
    'image/jpeg': 'type-image', 'image/png': 'type-image', 'image/gif': 'type-image',
    'video/mp4': 'type-video', 'video/webm': 'type-video',
    'audio/mpeg': 'type-audio', 'audio/wav': 'type-audio',
    'application/pdf': 'type-pdf',
    'application/zip': 'type-archive', 'application/x-rar-compressed': 'type-archive',
    'text/plain': 'type-text', 'application/json': 'type-text',
    'application/javascript': 'type-text',
    'application/msword': 'type-doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'type-doc',
    'application/vnd.ms-excel': 'type-doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'type-doc',
  };

  // ---------- DOM Helpers ----------
  function $(sel, ctx) { ctx = ctx || document; return ctx.querySelector(sel); }
  function $$(sel, ctx) { ctx = ctx || document; return Array.prototype.slice.call(ctx.querySelectorAll(sel)); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function escapeAttr(str) { if (str == null) return ''; return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function formatFileSize(size) {
    if (size === '-' || size == null) return '-';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return (size % 1 === 0 ? size : size.toFixed(1)) + ' ' + units[i];
  }

  function formatBanInfo(u) {
    if (!u.is_banned) return '';
    var reason = u.ban_reason ? '，原因: ' + u.ban_reason : '';
    if (u.ban_expires_at) {
      var expiresAt = new Date(u.ban_expires_at);
      var now = new Date();
      var diff = expiresAt - now;
      var remaining = '';
      if (diff > 0) {
        var days = Math.floor(diff / 86400000);
        var hours = Math.floor((diff % 86400000) / 3600000);
        var mins = Math.floor((diff % 3600000) / 60000);
        if (days > 0) remaining = days + '天';
        else if (hours > 0) remaining = hours + '小时';
        else remaining = mins + '分钟';
        return '<span class="ban-indicator" title="到期: ' + expiresAt.toLocaleString() + reason + '">&#x26D4; ' + remaining + '后解封</span>';
      } else {
        return '<span class="ban-indicator ban-expired" title="' + reason + '">&#x26D4; 已过期</span>';
      }
    }
    return '<span class="ban-indicator" title="' + reason + '">&#x26D4; 永久封禁</span>';
  }

  function safeMimeType(mime) { return mime || 'unknown'; }
  function getIcon(mime) { return ICON_MAP[safeMimeType(mime)] || ICON_MAP['unknown']; }
  function getTypeClass(mime) { return TYPE_CLASS_MAP[safeMimeType(mime)] || 'type-default'; }
  function getFileExt(name) { var parts = name.split('.'); return parts.length > 1 ? '.' + parts[parts.length - 1].toLowerCase() : ''; }

  // ---------- Loading ----------
  function showLoading() {
    if ($('#loading-overlay')) return;
    var overlay = el('div', 'loading-overlay');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(overlay);
    state.isLoading = true;
  }

  function hideLoading() {
    var overlay = $('#loading-overlay');
    if (overlay) { overlay.style.opacity = '0'; overlay.style.transition = 'opacity 0.3s ease'; setTimeout(function () { overlay.remove(); }, 300); }
    state.isLoading = false;
  }

  // ---------- Toast ----------
  function showToast(message, icon) {
    if (!icon) icon = '&#128640;';
    var existing = $('.toast');
    if (existing) existing.remove();
    var toast = el('div', 'toast');
    toast.innerHTML = '<span class="toast-icon">' + icon + '</span><span class="toast-message">' + message + '</span>';
    document.body.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0'; toast.style.transform = 'translateY(12px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(function () { toast.remove(); }, 300);
    }, CONFIG.toastDuration);
  }

  // ==================== 登录引导弹窗（访客下载大文件时） ====================
  function showLoginPromptDiag(fileName, fileSize) {
    // 移除已有弹窗
    var existing = document.querySelector('.fm-login-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'fm-login-overlay';
    overlay.innerHTML =
      '<div class="fm-login-dialog" onclick="event.stopPropagation()">' +
        '<div class="fm-login-dialog-icon">&#128274;</div>' +
        '<h3>需要登录才能下载</h3>' +
        '<p>文件超过 100MB，登录后可不限速下载完整文件</p>' +
        '<div class="fm-login-file-info">' +
          '<span class="fm-login-file-icon">&#128196;</span>' +
          '<div class="fm-login-file-text">' +
            '<div class="fm-login-file-name">' + escHtml(fileName || '') + '</div>' +
            '<div class="fm-login-file-size">文件大小: ' + formatFileSize(fileSize || 0) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="fm-login-dialog-btns">' +
          '<button class="btn-cancel" id="fmLoginPromptCancel">以后再说</button>' +
          '<button class="btn-login" id="fmLoginPromptConfirm">&#128640; 立即登录</button>' +
        '</div>' +
      '</div>';

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    document.getElementById('fmLoginPromptCancel').addEventListener('click', function() { overlay.remove(); });
    document.getElementById('fmLoginPromptConfirm').addEventListener('click', function() {
      overlay.remove();
      window.location.href = '/login.html?return=' + encodeURIComponent(window.location.href);
    });

    // ESC 关闭
    var escH = function(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escH); }
    };
    document.addEventListener('keydown', escH);
  }

  // HTML 转义辅助函数
  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // 设置 axios 跨域携带 cookie
  axios.defaults.withCredentials = true;

  // Axios CSRF 拦截器：自动附加 CSRF token 到非 GET 请求
  axios.interceptors.request.use(function(config) {
    if (csrfToken && config.method && config.method !== 'get') {
      config.headers = config.headers || {};
      config.headers['X-CSRF-Token'] = csrfToken;
    }
    return config;
  });
  axios.interceptors.response.use(function(response) {
    var newToken = response.headers['x-csrf-token'];
    if (newToken) csrfToken = newToken;
    return response;
  });

  // ---------- API Helper ----------
  function apiGet(url) { return axios.get(CONFIG.baseApiUrl + url).then(function(r) { return r.data; }); }
  function apiPost(url, data) {
    // 如果 CSRF token 缺失，先发一个 GET 获取 token，再执行 POST（防止首次 POST 403）
    if (!csrfToken) {
      return fetchCsrfTokenAsync().then(function() {
        return axios.post(CONFIG.baseApiUrl + url, data, {
          headers: { 'Content-Type': 'application/json' }
        }).then(function(r) { return r.data; });
      });
    }
    return axios.post(CONFIG.baseApiUrl + url, data, {
      headers: { 'Content-Type': 'application/json' }
    }).then(function(r) { return r.data; });
  }
  function apiPut(url, data) {
    if (!csrfToken) {
      return fetchCsrfTokenAsync().then(function() {
        return axios.put(CONFIG.baseApiUrl + url, data, {
          headers: { 'Content-Type': 'application/json' }
        }).then(function(r) { return r.data; });
      });
    }
    return axios.put(CONFIG.baseApiUrl + url, data, {
      headers: { 'Content-Type': 'application/json' }
    }).then(function(r) { return r.data; });
  }
  function apiDelete(url) {
    if (!csrfToken) {
      return fetchCsrfTokenAsync().then(function() {
        return axios.delete(CONFIG.baseApiUrl + url).then(function(r) { return r.data; });
      });
    }
    return axios.delete(CONFIG.baseApiUrl + url).then(function(r) { return r.data; });
  }

  // ---------- 查看密码切换 ----------
  function initTogglePassword(btnId, inputId) {
    var btn = $('#' + btnId);
    var input = $('#' + inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', function() {
      var isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.classList.toggle('show-pass', isPassword);
      var eyeShow = btn.querySelector('.eye-show');
      var eyeHide = btn.querySelector('.eye-hide');
      if (eyeShow) eyeShow.style.display = isPassword ? 'none' : 'block';
      if (eyeHide) eyeHide.style.display = isPassword ? 'block' : 'none';
    });
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    if (!theme) theme = 'dark';
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    localStorage.setItem('fms-theme', theme);
    // 更新按钮显示状态
    var themeToggle = $('#theme-toggle');
    if (themeToggle) {
      var sun = themeToggle.querySelector('.sun');
      var moon = themeToggle.querySelector('.moon');
      if (sun) sun.style.display = theme === 'light' ? 'block' : 'none';
      if (moon) moon.style.display = theme === 'dark' ? 'block' : 'none';
    }
    // 通知嵌入的 iframe 同步主题
    try {
      ['storage-iframe','backup-iframe','tasks-iframe'].forEach(function(id) {
        var iframe = document.getElementById(id);
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'theme-change', theme: theme }, '*');
        }
      });
    } catch (e) {}
  }
  function toggleTheme() {
    if (!state) return;
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  // ---------- 目录类型切换 (个人/公共/回收站/分享) ----------
  function setDirType(type) {
    state.dirType = type;
    state.currentDirId = 0; // 重置到根目录
    state.currentPublicPath = ''; // 公共目录路径也要重置
    state.selectedFiles = []; // 清空选择
    state.isSelectionMode = false;
    state.fileData = [];
    state.currentView = 'files'; // 更新当前视图状态
    closeItemMenu(); // 关闭右键菜单
    closeUserMenu(); // 关闭用户下拉菜单
    closeSidebar();

    var pagePanel = $('#page-panel');
    var mainContent = $('#main-view');

    // 分享模式：嵌入 page-panel（像个人中心一样）
    if (type === 'share') {
      state.currentView = 'share';
      setHash('share'); // 同步 URL
      if (mainContent) mainContent.style.display = 'none';
      showFileToolbar(false);
      var panelTitle = $('#page-panel-title');
      if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> 我的分享';
      updateNavHighlight('share', type);
      loadShareManage();
      if (pagePanel) {
        pagePanel.classList.add('show');
        pagePanel.dataset.type = 'share';
      }
      return;
    }

    // 隐藏 page-panel，显示主内容区
    if (pagePanel) pagePanel.classList.remove('show');
    if (mainContent) mainContent.style.display = 'block';
    // 文件子类型 hash: personal 用简洁的 #files，其他用 #files/recycle 等
    setHash(type === 'personal' ? 'files' : 'files/' + type);

    // 回收站模式：隐藏下载、分享、移动按钮，显示恢复按钮
    var isRecycleMode = (type === 'recycle' || type === 'public-recycle');
    var downloadBtn = $('#sel-download-btn');
    var shareBtn = $('#sel-share-btn');
    var moveBtn = $('#sel-move-btn');
    var restoreBtn = $('#sel-restore-btn');
    if (downloadBtn) downloadBtn.style.display = isRecycleMode ? 'none' : '';
    if (shareBtn) shareBtn.style.display = isRecycleMode ? 'none' : '';
    if (moveBtn) moveBtn.style.display = isRecycleMode ? 'none' : '';
    if (restoreBtn) restoreBtn.style.display = isRecycleMode ? '' : 'none';

    // 重置选择状态
    state.selectedFiles = [];
    state.isSelectionMode = false;
    state.fileData = [];
    updateSelectionUI(); // 隐藏选择栏

    // 回收站模式下隐藏文件工具栏的普通操作
    if (type === 'recycle' || type === 'public-recycle') {
      showFileToolbar(true);
      var normal = $('#toolbar-left-normal');
      var recycle = $('#toolbar-left-recycle');
      if (normal) normal.style.display = 'none';
      if (recycle) recycle.style.display = 'flex';
    } else {
      showFileToolbar(true);
      var normal = $('#toolbar-left-normal');
      var recycle = $('#toolbar-left-recycle');
      if (normal) normal.style.display = 'flex';
      if (recycle) recycle.style.display = 'none';
    }

    updateDirTypeUI();
    updateNavHighlight('files', type);
    updateBreadcrumb();
    updateStats([]);
    updateRecycleBadge();
    if (state.isAdmin) updatePublicRecycleBadge();
    loadFiles(0);
  }

  function updateDirTypeUI() {
    var personalTab = $('#dir-tab-personal');
    var publicTab = $('#dir-tab-public');
    if (personalTab) personalTab.classList.toggle('active', state.dirType === 'personal');
    if (publicTab) publicTab.classList.toggle('active', state.dirType === 'public');
  }

  // ---------- 多选功能 ----------
  function toggleSelectionMode() {
    state.isSelectionMode = !state.isSelectionMode;
    if (!state.isSelectionMode) {
      state.selectedFiles = [];
      // 关闭选择模式：重置所有 DOM 的勾选状态
      $$('.file-card, .fm-row').forEach(function(el) {
        el.classList.remove('selected');
        var cb = el.querySelector('.card-check-wrap .checkbox, .td-check .checkbox');
        if (cb) cb.classList.remove('checked');
      });
      // 关闭选择模式：移除 selection 模式类
      var grid = $('.file-grid');
      if (grid) grid.classList.remove('fm-selection-mode');
      var tableWrap = $('.file-table-wrap');
      if (tableWrap) tableWrap.classList.remove('fm-selection-mode');
      // 清空后立即同步表头全选框（全部未选 → 无 .checked/.partial）
      var tableThCheck = $('#table-select-all-th .checkbox');
      if (tableThCheck) {
        tableThCheck.classList.remove('checked', 'partial');
      }
      updateSelectionUI();
    } else {
      // 进入选择模式：不清空 selectedFiles（保留已有勾选），只更新 UI
      $$('.file-card, .fm-row').forEach(function(el) {
        var fileId = String(el.dataset.fileId);
        if (state.selectedFiles.indexOf(fileId) !== -1) {
          el.classList.add('selected');
          var cb = el.querySelector('.card-check-wrap .checkbox, .td-check .checkbox');
          if (cb) cb.classList.add('checked');
        }
      });
      // 进入选择模式：给网格和表格添加 selection 模式类
      var grid = $('.file-grid');
      if (grid) grid.classList.add('fm-selection-mode');
      var tableWrap = $('.file-table-wrap');
      if (tableWrap) tableWrap.classList.add('fm-selection-mode');
      // 进入选择模式时，同步表头全选框状态（取决于当前是否有勾选）
      var tableThCheck = $('#table-select-all-th .checkbox');
      if (tableThCheck) {
        var rowIds = $$('.fm-row').map(function (r) { return r.dataset.fileId; });
        var allSelected2 = rowIds.length > 0 && rowIds.every(function(id) { return state.selectedFiles.indexOf(String(id)) !== -1; });
        var allDeselected2 = rowIds.length > 0 && rowIds.every(function(id) { return state.selectedFiles.indexOf(String(id)) === -1; });
        tableThCheck.classList.remove('checked', 'partial');
        if (allSelected2) tableThCheck.classList.add('checked');
        else if (!allDeselected2) tableThCheck.classList.add('partial');
      }
      updateSelectionUI();
    }
  }

  function toggleFileSelection(fileId, isDirectory) {
    // 确保 fileId 是字符串，与 state.selectedFiles 中的值保持一致
    var fileIdStr = String(fileId);
    var idx = state.selectedFiles.indexOf(fileIdStr);
    if (idx === -1) {
      state.selectedFiles.push(fileIdStr);
    } else {
      state.selectedFiles.splice(idx, 1);
    }
    if (state.selectedFiles.length === 0) {
      state.isSelectionMode = false;
      // 取消选择最后一个文件时，也要移除 selection 模式类
      var grid = $('.file-grid');
      if (grid) grid.classList.remove('fm-selection-mode');
      var tableWrap = $('.file-table-wrap');
      if (tableWrap) tableWrap.classList.remove('fm-selection-mode');
    }
    // 精准更新该行 DOM，不再整表重绘（避免重新入场动画）
    var row = document.querySelector('.fm-row[data-file-id="' + fileIdStr + '"]');
    if (row) {
      if (idx === -1) {
        row.classList.add('selected');
        var cb = row.querySelector('.td-check .checkbox');
        if (cb) cb.classList.add('checked');
      } else {
        row.classList.remove('selected');
        var cb2 = row.querySelector('.td-check .checkbox');
        if (cb2) cb2.classList.remove('checked');
      }
    }
    var card = document.querySelector('.file-card[data-file-id="' + fileIdStr + '"]');
    if (card) {
      if (idx === -1) {
        card.classList.add('selected');
        var ccb = card.querySelector('.card-check-wrap .checkbox');
        if (ccb) ccb.classList.add('checked');
      } else {
        card.classList.remove('selected');
        var ccb2 = card.querySelector('.card-check-wrap .checkbox');
        if (ccb2) ccb2.classList.remove('checked');
      }
    }
    updateSelectionUI();
  }

  function selectAllFiles() {
    var allIds = state.fileData.map(function(f) { return String(f.id); });
    state.selectedFiles = allIds.slice();
    // 精准更新所有行/卡片 DOM，不再整表重绘（避免入场动画抖动）
    $$('.fm-row').forEach(function(row) {
      var cb = row.querySelector('.td-check .checkbox');
      if (cb) cb.classList.add('checked');
      row.classList.add('selected');
    });
    $$('.file-card').forEach(function(card) {
      var cb = card.querySelector('.card-check-wrap .checkbox');
      if (cb) cb.classList.add('checked');
      card.classList.add('selected');
    });
    updateSelectionUI();
  }

  function deselectAllFiles() {
    state.selectedFiles = [];
    state.isSelectionMode = false;
    // 取消全选时移除 selection 模式类
    var grid = $('.file-grid');
    if (grid) grid.classList.remove('fm-selection-mode');
    var tableWrap = $('.file-table-wrap');
    if (tableWrap) tableWrap.classList.remove('fm-selection-mode');
    // 精准更新所有行/卡片 DOM
    $$('.fm-row').forEach(function(row) {
      var cb = row.querySelector('.td-check .checkbox');
      if (cb) cb.classList.remove('checked');
      row.classList.remove('selected');
    });
    $$('.file-card').forEach(function(card) {
      var cb = card.querySelector('.card-check-wrap .checkbox');
      if (cb) cb.classList.remove('checked');
      card.classList.remove('selected');
    });
    updateSelectionUI();
  }

  function updateSelectionUI() {
    var selectionBar = $('#selection-bar');
    if (selectionBar) {
      if (state.selectedFiles.length > 0 || state.isSelectionMode) {
        selectionBar.classList.add('show');
      } else {
        selectionBar.classList.remove('show');
      }
      var countEl = $('#selection-num');
      if (countEl) countEl.textContent = state.selectedFiles.length;
      var selectAllLabel = $('#select-all-label');
      var selectAllBtn = $('#select-all-btn');
      if (selectAllLabel) {
        var allIds = state.fileData.map(function(f) { return String(f.id); });
        var allSelected = allIds.length > 0 && allIds.every(function(id) { return state.selectedFiles.indexOf(id) !== -1; });
        selectAllLabel.textContent = allSelected ? '取消全选' : '全选';
        if (selectAllBtn) selectAllBtn.classList.toggle('active', allSelected);
      }
    }
    // 更新选择按钮状态
    var selectBtn = $('#select-btn');
    if (selectBtn) {
      selectBtn.classList.toggle('active', state.isSelectionMode);
      if (state.isSelectionMode) {
        selectBtn.querySelector('span').textContent = '取消';
      } else {
        selectBtn.querySelector('span').textContent = '选择';
      }
    }
    // 同步表格表头全选勾选框状态（与当前列表行一致，含搜索过滤后的可见行）
    var tableThCheck = $('#table-select-all-th .checkbox');
    if (tableThCheck) {
      var rowIds = $$('.fm-row').map(function (r) { return r.dataset.fileId; });
      var allSelected2 = rowIds.length > 0 && rowIds.every(function(id) { return state.selectedFiles.indexOf(String(id)) !== -1; });
      var allDeselected2 = rowIds.length > 0 && rowIds.every(function(id) { return state.selectedFiles.indexOf(String(id)) === -1; });
      tableThCheck.classList.remove('checked', 'partial');
      if (allSelected2) {
        tableThCheck.classList.add('checked');
      } else if (!allDeselected2) {
        tableThCheck.classList.add('partial');
      }
    }
    // 回收站模式：隐藏下载、分享、移动按钮，显示恢复按钮
    var downloadBtn = $('#sel-download-btn');
    var shareBtn = $('#sel-share-btn');
    var moveBtn = $('#sel-move-btn');
    var restoreBtn = $('#sel-restore-btn');
    var isRecycleMode = (state.dirType === 'recycle' || state.dirType === 'public-recycle');
    if (downloadBtn) downloadBtn.style.display = isRecycleMode ? 'none' : '';
    if (shareBtn) shareBtn.style.display = isRecycleMode ? 'none' : '';
    if (moveBtn) moveBtn.style.display = isRecycleMode ? 'none' : '';
    if (restoreBtn) restoreBtn.style.display = isRecycleMode ? '' : 'none';
  }

  // 一键下载选中文件
  function downloadSelectedFiles() {
    if (state.selectedFiles.length === 0) {
      showToast('请先选择文件', '&#9888;');
      return;
    }
    var files = state.selectedFiles
      .map(function(fileId) { return state.fileData.find(function(f) { return String(f.id) === String(fileId) && !f.isDirectory; }); })
      .filter(Boolean);
    if (files.length === 0) {
      showToast('没有可下载的文件', '&#9888;');
      return;
    }
    // 回收站（含个人/公共）禁止下载，只能恢复或永久删除
    if (state.dirType === 'recycle' || state.dirType === 'public-recycle') {
      showToast('回收站不支持下载，请使用恢复功能', '&#9888;');
      return;
    }
    downloadFiles(files);
    showToast('开始下载 ' + files.length + ' 个文件', '&#128230;');
  }

  // 批量恢复选中项目（仅回收站模式，逐个确认）
  function restoreSelectedFiles() {
    if (state.selectedFiles.length === 0) {
      showToast('请先选择文件', '&#9888;');
      return;
    }
    var items = state.selectedFiles
      .map(function(id) { return state.fileData.find(function(f) { return String(f.id) === String(id); }); })
      .filter(Boolean);
    if (items.length === 0) return;

    // 逐个恢复，每恢复一个后自动刷新列表并继续下一个
    function processNext(index) {
      if (index >= items.length) {
        // 所有项目处理完毕
        setTimeout(function() {
          state.selectedFiles = [];
          state.isSelectionMode = false;
          updateSelectionUI();
          if (state.dirType === 'public-recycle') updatePublicRecycleBadge();
          else updateRecycleBadge();
          loadFiles(0);
        }, 500);
        return;
      }

      var item = items[index];
      var itemDesc = (item.isDirectory ? '目录' : '文件') + ' "' + item.name + '"';

      // 判断是否需要逐个确认
      if (items.length > 1) {
        // 批量模式：逐个确认弹窗（只对公共回收站和个人回收站需要）
        if (!confirm('(' + (index + 1) + '/' + items.length + ') 恢复 ' + itemDesc + '？')) {
          processNext(index + 1);
          return;
        }
      }

      restoreItem(item);

      // 等待恢复完成后再处理下一个（给予足够时间让恢复完成）
      setTimeout(function() {
        processNext(index + 1);
      }, 600);
    }

    // 先清空选择状态避免视觉混乱，再开始处理
    state.selectedFiles = [];
    state.isSelectionMode = false;
    updateSelectionUI();
    processNext(0);
  }

  // 一键删除选中文件/文件夹
  function deleteSelectedFiles() {
    if (state.selectedFiles.length === 0) {
      showToast('请先选择文件', '&#9888;');
      return;
    }
    if (state.dirType === 'public' && !state.isAdmin) {
      showToast('普通用户无法删除公共文件', '&#9888;');
      return;
    }
    var items = state.selectedFiles
      .map(function(id) { return state.fileData.find(function(f) { return String(f.id) === String(id); }); })
      .filter(Boolean);
    var dirCount = items.filter(function(f) { return f.isDirectory; }).length;
    var fileCount = items.length - dirCount;
    var msg = '确定删除选中的 ' + items.length + ' 个项目';
    if (dirCount > 0) msg += '（含 ' + dirCount + ' 个文件夹）';
    msg += '？此操作不可恢复！';
    if (!confirm(msg)) return;

    var deleted = 0;
    var total = items.length;
    var pending = items.slice();
    var next = function() {
      if (pending.length === 0) return;
      var item = pending.shift();
      var url;
      var isRecycleItem = item.isRecycleItem || item.isPublicRecycleItem;

      if (isRecycleItem) {
        // 回收站中删除 = 永久删除
        if (item.isPublicRecycleItem) {
          url = item.isDirectory
            ? '/public-recycle/dirs/' + item.id
            : '/public-recycle/files/' + item.id;
        } else {
          url = item.isDirectory
            ? '/recycle/dirs/' + item.id
            : '/recycle/files/' + item.id;
        }
      } else if (item.isPublicFile) {
        var relPath = item.relPath || item.id;
        url = '/public-files?path=' + encodeURIComponent(relPath);
      } else if (item.isPublicDir) {
        var relPath2 = item.relPath || item.id;
        url = '/public-dirs?path=' + encodeURIComponent(relPath2);
      } else if (item.isDirectory) {
        url = '/dirs/' + item.id;
      } else {
        url = '/files/' + item.id;
      }
      apiDelete(url)
        .then(function(res) {
          if (res.code === 0) deleted++;
        })
        .catch(function() {})
        .finally(function() {
          next();
          if (pending.length === 0) {
            state.selectedFiles = [];
            state.isSelectionMode = false;
            showToast('已删除 ' + deleted + ' / ' + total + ' 个项目', '&#128465;');
            loadFiles(state.currentDirId);
            loadProfile();
            if (item.isPublicRecycleItem) updatePublicRecycleBadge();
            else updateRecycleBadge();
          }
        });
    };
    next();
  }

  // 创建文件夹
  function createNewFolder() {
    var promptMsg = state.dirType === 'public' ? '请输入公共目录名称：' : '请输入文件夹名称：';
    var name = prompt(promptMsg);
    if (!name || name.trim() === '') return;
    name = name.trim();
    var check = validateDirName(name);
    if (!check.valid) {
      showToast(check.message, '&#9888;');
      return;
    }
    showLoading();
    var apiUrl, postData;
    if (state.dirType === 'public') {
      // 公共目录：创建到当前子目录
      var parentPath = state.currentPublicPath || '';
      apiUrl = '/public-dirs';
      postData = JSON.stringify({ path: parentPath, name: name });
    } else {
      apiUrl = '/dirs';
      postData = JSON.stringify({ name: name, parent_id: state.currentDirId || 0 });
    }
    apiPost(apiUrl, postData)
      .then(function(res) {
        hideLoading();
        if (res.code === 0) {
          showToast(state.dirType === 'public' ? '公共目录已创建' : '文件夹已创建', '&#128193;');
          loadFiles(state.currentDirId);
        } else {
          showToast(res.message || '创建失败', '&#9888;');
        }
      })
      .catch(function() {
        hideLoading();
        showToast('创建失败', '&#9888;');
      });
  }

  // ---------- User Panel ----------
  function toggleUserMenu() {
    if (!$('#user-dropdown')) return;
    var menu = $('#user-menu');
    if (!menu) return;
    var isOpen = menu.classList.contains('show');
    state.userMenuOpen = !isOpen;
    menu.classList.toggle('show', !isOpen);
  }

  function closeUserMenu() {
    state.userMenuOpen = false;
    var menu = $('#user-menu');
    if (menu) menu.classList.remove('show');
  }

  // ==================== URL Hash 路由 ====================
  var _settingHash = false; // 防止 hashchange → showView → setHash 循环

  // 所有有效 hash → view 映射
  var HASH_VIEWS = [
    'files', 'share', 'profile', 'change-password', 'offline', 'webdav', 'admin-storage',
    'admin-users', 'admin-logs', 'admin-files', 'admin-shares', 'admin-blacklist',
    'admin-traffic', 'admin-version', 'admin-rate-limit', 'admin-backup', 'admin-tasks', 'admin-webdav', 'about', 'transfers'
  ];

  function setHash(name) {
    if (_settingHash) return;
    _settingHash = true;
    if (window.location.hash !== '#' + name) {
      window.location.hash = '#' + name;
    }
    setTimeout(function() { _settingHash = false; }, 150);
  }

  function restoreFromHash(hash) {
    // 移除可能的子路径（如 files/recycle → files）
    var viewName = hash.split('/')[0];
    var adminViews = ['admin-users','admin-logs','admin-files','admin-shares','admin-blacklist','admin-traffic','admin-version','admin-storage','admin-rate-limit','admin-backup','admin-tasks','webdav','admin-webdav'];
    if (adminViews.indexOf(viewName) !== -1 && !state.isAdmin) {
      // 非管理员无法访问管理视图，更新 URL 再切回文件
      setHash('files');
      showView('files');
      return;
    }
    // 文件子类型: files/personal files/public files/recycle files/public-recycle
    if (viewName === 'files') {
      var subType = hash.split('/')[1] || 'personal';
      var validFileTypes = ['personal', 'public', 'recycle', 'public-recycle'];
      if (validFileTypes.indexOf(subType) !== -1) {
        setDirType(subType);
      } else {
        showView('files');
      }
      return;
    }
    if (HASH_VIEWS.indexOf(viewName) !== -1) {
      showView(viewName);
    } else {
      // 未知 hash，清掉并显示文件视图
      setHash('files');
      showView('files');
    }
  }

  // 监听浏览器后退/前进（仅响应真实的用户操作）
  window.addEventListener('hashchange', function() {
    if (_settingHash) return;
    var hash = window.location.hash.replace('#', '');
    if (hash) {
      restoreFromHash(hash);
    } else {
      showView('files');
    }
  });

  // ==================== 视图切换 (使用 page-panel) ====================

  function showView(name) {
    // 同步 URL hash（files 保留子类型如 #files/recycle）
    if (name === 'files') {
      var fileHash = state.dirType === 'personal' ? 'files' : 'files/' + state.dirType;
      setHash(fileHash);
    } else {
      setHash(name);
    }
    console.log('[showView] 开始切换到视图:', name);
    closeItemMenu();
    closeUserMenu();
    closeSidebar();
    state.currentView = name;

    var pagePanel = $('#page-panel');
    var mainContent = $('#main-view');

    // 切换到非文件视图时，重置选择状态
    if (name !== 'files') {
      state.selectedFiles = [];
      state.isSelectionMode = false;
      updateSelectionUI();
    }

    if (name === 'files') {
      // 返回文件视图：隐藏 page-panel，显示文件内容
      if (pagePanel) pagePanel.classList.remove('show');
      if (mainContent) mainContent.style.display = 'block';
      // 显示工具栏和面包屑
      showFileToolbar(true);
      updateNavHighlight('files', state.dirType);
      // 重新加载文件
      loadFiles(state.currentDirId);
    } else {
      // 显示 page-panel，隐藏文件内容
      if (mainContent) mainContent.style.display = 'none';
      showFileToolbar(false);

      // 配置 page-panel
      var panelTitle = $('#page-panel-title');

      if (name === 'profile') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg> 个人中心';
        updateNavHighlight('profile', state.dirType);
        loadProfile();
      } else if (name === 'change-password') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> 修改登录密码';
        updateNavHighlight('change-password', state.dirType);
        initChangePassword();
      } else if (name === 'admin-users') {
        if (panelTitle) panelTitle.innerHTML = '&#128737; 用户管理';
        updateNavHighlight('admin-users', state.dirType);
        loadAdminUsers();
      } else if (name === 'admin-logs') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> 日志管理';
        updateNavHighlight('admin-logs', state.dirType);
        loadAdminLogs();
      } else if (name === 'admin-files') {
        // 已合并到存储管理 → 打开加密升级标签页
        setHash('admin-storage'); // 更新 URL hash
        if (panelTitle) panelTitle.innerHTML = '🔐 加密升级';
        updateNavHighlight('admin-storage', state.dirType);
        loadAdminStorage('upgrade');
        if (pagePanel) pagePanel.dataset.type = 'admin-storage';
      } else if (name === 'admin-shares') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> 分享管理';
        updateNavHighlight('admin-shares', state.dirType);
        loadAdminShares();
      } else if (name === 'admin-blacklist') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> IP黑名单';
        updateNavHighlight('admin-blacklist', state.dirType);
        loadAdminBlacklist();
      } else if (name === 'admin-traffic') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> 流量统计';
        updateNavHighlight('admin-traffic', state.dirType);
        loadAdminTraffic();
      } else if (name === 'admin-version') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 版本管理';
        updateNavHighlight('admin-version', state.dirType);
        loadAdminVersions();
      } else if (name === 'admin-rate-limit') {
        if (panelTitle) panelTitle.innerHTML = '⏱ 频率限制';
        updateNavHighlight('admin-rate-limit', state.dirType);
        loadAdminRateLimit();
      } else if (name === 'offline') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 离线下载';
        updateNavHighlight('offline', state.dirType);
        loadOffline();
      } else if (name === 'share') {
        // 分享页走 setDirType 统一入口（设置 hash/nav/content/panel）
        setDirType('share');
        closeSidebar();
        return;
      } else if (name === 'webdav') {
        if (panelTitle) panelTitle.innerHTML = '&#128194; WebDAV 管理';
        updateNavHighlight('webdav', state.dirType);
        showWebDAVManage();
      } else if (name === 'admin-storage') {
        if (panelTitle) panelTitle.innerHTML = '&#128190; 存储管理';
        updateNavHighlight('admin-storage', state.dirType);
        loadAdminStorage();
      } else if (name === 'admin-backup') {
        if (panelTitle) panelTitle.innerHTML = '&#128451; 数据库备份';
        updateNavHighlight('admin-backup', state.dirType);
        loadAdminBackup();
      } else if (name === 'admin-tasks') {
        if (panelTitle) panelTitle.innerHTML = '&#9881; 异步任务';
        updateNavHighlight('admin-tasks', state.dirType);
        loadAdminTasks();
      } else if (name === 'about') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> 关于';
        updateNavHighlight('about', state.dirType);
        loadAboutPage();
      } else if (name === 'transfers') {
        if (panelTitle) panelTitle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg> 传输列表';
        updateNavHighlight('transfers', state.dirType);
        loadTransferList();
      } else if (name === 'admin-webdav') {
        if (panelTitle) panelTitle.innerHTML = '&#128451; WebDAV 管理';
        updateNavHighlight('admin-webdav', state.dirType);
        loadAdminWebDAV();
      }

      // 显示面板
      if (pagePanel) {
        pagePanel.classList.add('show');
        // 设置面板类型
        pagePanel.dataset.type = name;
      }
    }

    closeSidebar();
  }

  // 显示/隐藏文件工具栏和面包屑
  function showFileToolbar(show) {
    var toolbar = $('#file-toolbar');
    var wrapper = $('#file-toolbar-wrapper');
    var breadcrumb = $('#breadcrumb');
    if (toolbar) toolbar.style.display = show ? 'flex' : 'none';
    if (wrapper) wrapper.style.display = show ? 'block' : 'none';
    if (breadcrumb) breadcrumb.style.display = show ? 'flex' : 'none';
  }

  // 隐藏 page-panel，返回文件视图
  function hidePagePanel() {
    showView('files');
  }

  function switchView(name) {
    showView(name);
  }

  // ==================== 文件视图 ====================

  // ---------- 面包屑 ----------
  // items: 公共目录时为字符串数组 ['folder1', 'folder2']；个人目录时为对象数组 [{id, name}, ...]
  function buildBreadcrumb(items) {
    var container = $('#breadcrumb');
    if (!container) return;
    container.innerHTML = '';

    // ROOT / 公共目录 按钮
    var root = el('span', 'breadcrumb-item');
    root.textContent = state.dirType === 'public' ? '公共目录' : 'ROOT';
    root.style.cursor = 'pointer';
    root.addEventListener('click', function () {
      if (state.dirType === 'public') {
        state.currentPublicPath = '';
        loadFiles(0);
      } else {
        loadFiles(0); // 回到个人根目录
      }
    });
    container.appendChild(root);

    if (!items || items.length === 0) return;

    items.forEach(function(item, i) {
      var sep = el('span', 'breadcrumb-sep');
      sep.textContent = '/';
      container.appendChild(sep);

      var isLast = i === items.length - 1;
      var crumb = el('span', 'breadcrumb-item' + (isLast ? ' current' : ''));
      crumb.style.cursor = 'pointer';

      if (state.dirType === 'public') {
        // 公共目录：item 是字符串，直接解码显示
        crumb.textContent = decodeURIComponent(item);
        crumb.addEventListener('click', function () {
          var parts = (state.currentPublicPath || '').split('/').filter(function(p) { return p; });
          var newParts = parts.slice(0, i + 1);
          state.currentPublicPath = newParts.join('/');
          loadFiles(0);
        });
      } else {
        // 个人目录：item 是 { id, name } 对象
        crumb.textContent = item.name;
        crumb.addEventListener('click', function () {
          if (!isLast) {
            loadFiles(item.id);
          }
        });
      }
      container.appendChild(crumb);
    });
  }

  // ---------- 视频缩略图：使用 video 标签解析首帧 ----------
  // 原理：请求解密后的视频前 512KB，通过 <video preload="metadata"> 加载元数据后，
  //       用 canvas 截取首帧作为缩略图显示。前端自行解析，无需服务器依赖 ffmpeg。
  var _videoFrameCaptureMap = {};
  var _blobUrlCache = {}; // fileId -> blobUrl 缓存，避免切换菜单后旧 fetch 完成时新卡片收不到
  var _videoPreviewRetries = {}; // fileId -> 重试计数
  var VIDEO_THUMB_RETRY_SIZES = [1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024]; // 1MB, 2MB, 4MB
  var VIDEO_THUMB_TIMEOUT = 10000; // 10秒超时

  // 绑定视频事件处理器
  function bindVideoThumbEvents(item, fileId, videoId) {
    var videoEl = item.videoEl;
    var imgEl = item.imgEl;
    var timeoutTimer;

    function clearThumbTimeout() {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }

    // 加载元数据完成
    videoEl.onloadedmetadata = function() {
      console.log('[VideoThumb] loadedmetadata，fileId=', fileId, 'readyState=', videoEl.readyState);
      clearThumbTimeout();
    };

    // seek 完成（核心采集时机）
    videoEl.onseeked = function() {
      console.log('[VideoThumb] onseeked 触发，fileId=', fileId);
      clearThumbTimeout();
      var waitList = _videoFrameCaptureMap[fileId] || [];
      waitList.forEach(function(waitItem) {
        doCaptureFrame(waitItem);
      });
    };

    // 加载错误
    videoEl.onerror = function() {
      console.warn('[VideoThumb] video.onerror 触发，fileId=', fileId);
      clearThumbTimeout();
      var retryCount = _videoPreviewRetries[fileId] || 0;
      if (retryCount < VIDEO_THUMB_RETRY_SIZES.length) {
        console.log('[VideoThumb] 触发重试机制，retryCount=', retryCount);
        retryVideoPreview(item, fileId, videoId);
      } else {
        console.warn('[VideoThumb] 重试次数耗尽，隐藏缩略图，fileId=', fileId);
        var waitList = _videoFrameCaptureMap[fileId] || [];
        waitList.forEach(function(waitItem) {
          waitItem.imgEl.style.opacity = '0';
          if (waitItem.imgEl.nextElementSibling) waitItem.imgEl.nextElementSibling.style.display = 'flex';
        });
      }
    };

    // 超时检测：如果视频数据加载后长时间没有响应
    timeoutTimer = setTimeout(function() {
      console.warn('[VideoThumb] 超时，fileId=', fileId, 'readyState=', videoEl.readyState);
      // readyState >= 2 表示元数据已加载，不需要重试
      if (videoEl.readyState < 2) {
        var retryCount = _videoPreviewRetries[fileId] || 0;
        if (retryCount < VIDEO_THUMB_RETRY_SIZES.length) {
          retryVideoPreview(item, fileId, videoId);
        } else {
          // 重试次数耗尽，隐藏缩略图
          var waitList = _videoFrameCaptureMap[fileId] || [];
          waitList.forEach(function(waitItem) {
            waitItem.imgEl.style.opacity = '0';
            if (waitItem.imgEl.nextElementSibling) waitItem.imgEl.nextElementSibling.style.display = 'flex';
          });
        }
      }
    }, VIDEO_THUMB_TIMEOUT);
  }

  // 直接给 video 设置 src 并 seek
  function applyVideoSrc(videoEl, blobUrl) {
    videoEl.src = blobUrl;
    videoEl.currentTime = 0.1;
  }

  // 重试获取更多视频数据
  function retryVideoPreview(item, fileId, videoId) {
    var retryCount = _videoPreviewRetries[fileId] || 0;
    if (retryCount >= VIDEO_THUMB_RETRY_SIZES.length) {
      console.warn('[VideoThumb] 重试次数耗尽，fileId=', fileId);
      delete _videoPreviewRetries[fileId];
      // 隐藏缩略图
      var waitList = _videoFrameCaptureMap[fileId] || [];
      waitList.forEach(function(waitItem) {
        waitItem.imgEl.style.opacity = '0';
        if (waitItem.imgEl.nextElementSibling) waitItem.imgEl.nextElementSibling.style.display = 'flex';
      });
      return;
    }

    var size = VIDEO_THUMB_RETRY_SIZES[retryCount];
    _videoPreviewRetries[fileId] = retryCount + 1;
    console.log('[VideoThumb] 重试 #' + (retryCount + 1) + '，请求 ' + (size / 1024 / 1024) + 'MB，fileId=', fileId);

    fetch('/api/files/video-preview?id=' + encodeURIComponent(fileId), {
      headers: { 'Range': 'bytes=0-' + (size - 1) }
    })
      .then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function(blob) {
        console.log('[VideoThumb] 重试 blob 创建，大小=', blob.size);
        var blobUrl = URL.createObjectURL(blob);
        _blobUrlCache[fileId] = blobUrl;
        // 重新应用 blob URL 并 seek
        applyVideoSrc(item.videoEl, blobUrl);
      })
      .catch(function(err) {
        console.warn('[VideoThumb] 重试 fetch 失败，fileId=', fileId, err.message);
        retryVideoPreview(item, fileId, videoId);
      });
  }

  function captureVideoFrame(fileId, videoId) {
    var imgEl = document.getElementById(videoId + '_img');
    var videoEl = document.getElementById(videoId);
    if (!imgEl || !videoEl) {
      console.log('[VideoThumb] 元素不存在，imgEl=', !!imgEl, 'videoEl=', !!videoEl, 'videoId=', videoId);
      return;
    }
    console.log('[VideoThumb] 开始采集，fileId=', fileId, 'videoId=', videoId);

    // 如果该文件已有 blob URL 缓存，直接应用并触发采集
    var cachedBlobUrl = _blobUrlCache[fileId];
    if (cachedBlobUrl) {
      console.log('[VideoThumb] 使用缓存 blob URL');
      imgEl._blobApplied = true;
      applyVideoSrc(videoEl, cachedBlobUrl);

      // 等待 onseeked 事件触发采集
      var cachedOnSeeked = function() {
        console.log('[VideoThumb] 缓存场景 onseeked 触发');
        doCaptureFrame({ imgEl: imgEl, videoEl: videoEl, _captured: false });
        videoEl.removeEventListener('seeked', cachedOnSeeked);
      };
      videoEl.addEventListener('seeked', cachedOnSeeked);

      // 缓存场景的错误和超时处理
      var cacheItem = { imgEl: imgEl, videoEl: videoEl };
      videoEl.onerror = function() {
        console.warn('[VideoThumb] 缓存场景 video.onerror 触发，fileId=', fileId);
        var retryCount = _videoPreviewRetries[fileId] || 0;
        if (retryCount < VIDEO_THUMB_RETRY_SIZES.length) {
          retryVideoPreview(cacheItem, fileId, videoId);
        }
      };
      return;
    }

    // 同一文件只请求一次
    var pending = _videoFrameCaptureMap[fileId];
    if (pending) {
      console.log('[VideoThumb] 添加到待处理队列，当前队列长度=', pending.length + 1);
      pending.push({ imgEl: imgEl, videoEl: videoEl });
      return;
    }
    _videoFrameCaptureMap[fileId] = [{ imgEl: imgEl, videoEl: videoEl }];
    console.log('[VideoThumb] 发起 fetch 请求');

    // 绑定事件处理器
    bindVideoThumbEvents(_videoFrameCaptureMap[fileId][0], fileId, videoId);

    // 发起 fetch
    fetch('/api/files/video-preview?id=' + encodeURIComponent(fileId))
      .then(function(res) {
        console.log('[VideoThumb] fetch 完成，status=', res.status, 'ok=', res.ok);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function(blob) {
        console.log('[VideoThumb] blob 创建，大小=', blob.size);
        var blobUrl = URL.createObjectURL(blob);
        _blobUrlCache[fileId] = blobUrl; // 缓存 blob URL
        var waitList = _videoFrameCaptureMap[fileId] || [];
        waitList.forEach(function(item) {
          if (!item.imgEl._blobApplied) {
            console.log('[VideoThumb] 应用 blob URL 到元素');
            applyVideoSrc(item.videoEl, blobUrl);
          }
        });
      })
      .catch(function(err) {
        console.warn('[VideoThumb] 文件 ' + fileId + ' 预览加载失败:', err.message);
        var waitList = _videoFrameCaptureMap[fileId] || [];
        waitList.forEach(function(item) {
          item.imgEl.style.opacity = '0';
          if (item.imgEl.nextElementSibling) item.imgEl.nextElementSibling.style.display = 'flex';
        });
      });
  }

  // 统一的帧采集逻辑
  function doCaptureFrame(item) {
    if (item._captured) {
      console.log('[VideoThumb] 已采集过，跳过');
      return;
    }
    item._captured = true;
    console.log('[VideoThumb] 开始绘制 canvas');

    var canvas = document.createElement('canvas');
    canvas.width = item.videoEl.videoWidth || 320;
    canvas.height = item.videoEl.videoHeight || 180;
    var ctx = canvas.getContext('2d');
    try {
      ctx.drawImage(item.videoEl, 0, 0, canvas.width, canvas.height);
      item.imgEl.src = canvas.toDataURL('image/jpeg', 0.75);
      item.imgEl.style.opacity = '1';
      console.log('[VideoThumb] 缩略图设置成功');
    } catch (e) {
      console.warn('[VideoThumb] canvas 绘制失败:', e);
      item.imgEl.style.opacity = '0';
      if (item.imgEl.nextElementSibling) item.imgEl.nextElementSibling.style.display = 'flex';
    }
  }

  function updateBreadcrumb() {
    if (state.dirType === 'public') {
      var parts = (state.currentPublicPath || '').split('/').filter(function(p) { return p; });
      buildBreadcrumb(parts);
    } else {
      // 个人目录：从 state._personalBreadcrumb 读取面包屑链
      buildBreadcrumb(state._personalBreadcrumb || []);
    }
  }

  function loadFiles(dirId) {
    showLoading();
    state.currentDirId = dirId;
    state.selectedFiles = [];
    state.isSelectionMode = false;
    // 清空旧数据，防止切换目录类型时旧内容闪烁
    state.fileData = [];
    renderFiles();

    var apiUrl;
    if (state.dirType === 'recycle') {
      apiUrl = '/recycle';
    } else if (state.dirType === 'public-recycle') {
      apiUrl = '/public-recycle';
    } else if (state.dirType === 'public') {
      // currentPublicPath 存储未编码的路径（原始中文名）
      // 必须用 encodeURIComponent 编码，防止 + 等特殊字符被 Express query 解码为空格
      var relPath = (state.currentPublicPath !== undefined ? state.currentPublicPath : '');
      apiUrl = '/public-files/list?path=' + encodeURIComponent(relPath);
    } else {
      apiUrl = '/dirs?path=' + (dirId || 0);
    }

    apiGet(apiUrl)
      .then(function (res) {
        hideLoading();
        if (res.code === 401) {
          showToast('请先登录', '&#9888;');
          setTimeout(function () { window.location.href = '/login.html'; }, 1000);
          return;
        }
        if (res.code !== 0) {
          showToast(res.message || '加载失败', '&#9888;');
          return;
        }
    var data;
    if (state.dirType === 'public') {
      // 后端返回的 id 是原始中文名（未编码），直接使用
      data = (res.data.dirs || []).map(function(d) {
        return {
          id: d.id,           // 原始中文名（未编码）
          name: d.name,
          isDirectory: true,
          created_at: d.created_at,
          dir_id: d.id,
          relPath: d.child_path,  // 完整相对路径，含父目录，用于导航
          isPublicDir: true
        };
      }).concat((res.data.files || []).map(function(f) {
        return {
          id: f.id,           // 原始中文名（未编码）
          name: f.name,
          size: f.size,
          mimeType: f.mime_type,
          isDirectory: false,
          created_at: f.created_at,
          file_id: f.id,
          relPath: f.relPath,  // 完整相对路径，含父目录，用于下载/删除/重命名
          isPublicFile: true
        };
      }));
    } else if (state.dirType === 'recycle') {
      // 回收站数据（个人）：目录和独立文件分开显示
      data = (res.data.dirs || []).map(function(d) {
        return {
          id: d.id,
          name: d.name,
          isDirectory: true,
          isRecycleItem: true,
          deleted_at: d.deleted_at,
          expires_at: d.expires_at,
          remaining_text: d.remaining_text || '',
          remaining_ms: d.remaining_ms || 0,
          original_dir_path: d.original_dir_path || '',
          file_count: d.file_count || 0
        };
      }).concat((res.data.files || []).map(function(f) {
        return {
          id: f.id,
          name: f.name,
          size: f.size,
          mimeType: f.mime_type,
          isDirectory: false,
          isRecycleItem: true,
          deleted_at: f.deleted_at,
          expires_at: f.expires_at,
          remaining_text: f.remaining_text || '',
          remaining_ms: f.remaining_ms || 0,
          original_dir_name: f.original_dir_name || ''
        };
      }));
    } else if (state.dirType === 'public-recycle') {
      // 公共回收站数据
      data = (res.data.dirs || []).map(function(d) {
        return {
          id: d.id,
          name: d.name,
          isDirectory: true,
          isRecycleItem: true,
          isPublicRecycleItem: true,
          deleted_at: d.deleted_at,
          expires_at: d.expires_at,
          remaining_text: d.remaining_text || '',
          remaining_ms: d.remaining_ms || 0,
          original_path: d.original_path || ''
        };
      }).concat((res.data.files || []).map(function(f) {
        return {
          id: f.id,
          name: f.name,
          size: f.size,
          mimeType: f.mime_type,
          isDirectory: false,
          isRecycleItem: true,
          isPublicRecycleItem: true,
          deleted_at: f.deleted_at,
          expires_at: f.expires_at,
          remaining_text: f.remaining_text || '',
          remaining_ms: f.remaining_ms || 0,
          original_path: f.original_path || ''
        };
      }));
    } else {
      // 个人目录
      data = (res.data.dirs || []).map(function(d) {
        return {
          id: d.id,
          name: d.name,
          isDirectory: true,
          created_at: d.created_at,
          dir_id: d.id
        };
      }).concat((res.data.files || []).map(function(f) {
        return {
          id: f.id,
          name: f.name,
          size: f.size,
          mimeType: f.mime_type,
          isDirectory: false,
          created_at: f.created_at,
          file_id: f.id
        };
      }));
    }

    // 个人目录：从 API 响应中提取面包屑链
    if (state.dirType === 'personal' && res.data.breadcrumb) {
      state._personalBreadcrumb = res.data.breadcrumb;
    }

    state.fileData = data;
        updateBreadcrumb();
        renderFiles();
        updateStats(data);
        updateToolbarVisibility();
        updateUploadBtnVisibility();
      })
      .catch(function (err) {
        hideLoading();
        showToast('加载失败', '&#9888;');
        console.error('Load error:', err);
      });
  }

  function updateStats(data) {
    var d = data || state.fileData;
    var folders = d.filter(function (f) { return f.isDirectory; }).length;
    var files = d.filter(function (f) { return !f.isDirectory; }).length;
    var statEl = $('#stats-count');
    if (statEl) {
      statEl.innerHTML =
        '<span class="stat-item">&#128193; ' + folders + ' 文件夹</span>' +
        '<span class="stat-item">&#128462; ' + files + ' 文件</span>';
    }
    var backBtn = $('#toolbar-back-btn');
    var inSubDir = state.dirType === 'public'
      ? (state.currentPublicPath && state.currentPublicPath.length > 0)
      : (state.currentDirId > 0);
    if (backBtn) backBtn.style.display = inSubDir ? 'flex' : 'none';
  }

  function navigateToDir(dirId, dirName) {
    if (state.dirType === 'public') {
      // currentPublicPath 存储未编码的路径（原始中文名），逐级拼接
      // dirId 可能是 encodeURIComponent(中文名)，需要解码后再拼接
      var decodedId = dirId;
      try { decodedId = decodeURIComponent(dirId); } catch(e) { decodedId = dirId; }
      var current = state.currentPublicPath || '';
      state.currentPublicPath = current ? current + '/' + decodedId : decodedId;
      // currentDirId 始终保持 0，不传入字符串路径以免污染状态
      loadFiles(0);
    } else {
      loadFiles(dirId);
    }
  }

  function goBackDir() {
    if (state.dirType === 'public') {
      var current = state.currentPublicPath || '';
      if (!current) return;
      var parts = current.split('/');
      parts.pop(); // 移除当前目录段
      state.currentPublicPath = parts.join('/');
      loadFiles(0);
    } else {
      // 个人目录：从 breadcrumb 链获取父目录 ID
      var bc = state._personalBreadcrumb || [];
      if (bc.length <= 1) {
        // 已经是根或只有一级，直接回到根
        loadFiles(0);
      } else {
        // 回到倒数第二级
        var parentId = bc[bc.length - 2].id;
        loadFiles(parentId);
      }
    }
  }

  function renderFiles() {
    var container = $('#file-container');
    if (!container) return;
    container.innerHTML = '';

    var data = filterData();
    var sorted = applySort(data);

    if (!sorted || sorted.length === 0) {
      renderEmpty();
      return;
    }

    if (state.viewMode === 'grid') {
      renderGrid(sorted);
    } else {
      renderTable(sorted);
    }
  }

  function filterData() {
    if (!state.searchQuery) return state.fileData;
    var q = state.searchQuery.toLowerCase();
    return state.fileData.filter(function (f) { return f.name.toLowerCase().indexOf(q) !== -1; });
  }

  function applySort(data) {
    var key = state.sortConfig.key;
    var order = state.sortConfig.order;
    var dirs = data.filter(function (f) { return f.isDirectory; });
    var files = data.filter(function (f) { return !f.isDirectory; });
    function sortArr(arr) {
      return arr.sort(function (a, b) {
        var va = key === 'size' ? (a.size || 0) : (a.name || '').toString().toLowerCase();
        var vb = key === 'size' ? (b.size || 0) : (b.name || '').toString().toLowerCase();
        if (va < vb) return order === 'asc' ? -1 : 1;
        if (va > vb) return order === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return sortArr(dirs).concat(sortArr(files));
  }

  function renderGrid(data) {
    var container = $('#file-container');
    if (!container) return;
    container.innerHTML = '';
    var grid = el('div', 'file-grid');
    if (state.isSelectionMode) grid.classList.add('fm-selection-mode');
    data.forEach(function (item, i) {
      var mime = safeMimeType(item.mimeType);
      var typeClass = item.isDirectory ? 'type-folder' : getTypeClass(mime);
      var icon = item.isDirectory ? ICON_MAP['folder'] : getIcon(mime);
      var ext = !item.isDirectory ? getFileExt(item.name) : '';
      var displayName = item.name != null ? String(item.name) : '';
      var isSelected = state.selectedFiles.indexOf(String(item.id)) !== -1;
      var card = el('div', 'file-card' + (isSelected ? ' selected' : '') + (item.is_broken ? ' broken' : ''));
      card.dataset.fileId = String(item.id);
      card.style.animationDelay = (i * 0.04) + 's';

      // 判断是否为可预览的图片或视频（用于缩略图/帧预览）
      var isImageThumb = !item.isDirectory && (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp' || mime === 'image/bmp');
      var isVideoThumb = !item.isDirectory && (mime === 'video/mp4' || mime === 'video/avi' || mime === 'video/x-msvideo' || mime === 'video/quicktime' || mime === 'video/webm');
      var iconWrapContent = '<span class="card-icon ' + typeClass + '">' + icon + '</span>';
      if (isImageThumb) {
        var gridWidth = container.clientWidth || window.innerWidth;
        var thumbSize = Math.max(Math.floor(gridWidth / 6), 120);
        // 公共文件用 relPath（完整相对路径），个人文件用 id（nonce）
        // 用 query 参数 id= 传递，避免 URL path 中斜杠被 Express 路由截断
        // 回收站文件加上 recycle=1 标记
        var thumbId = (item.isPublicFile && item.relPath) ? item.relPath : item.id;
        var recycleFlag = (item.isRecycleItem || item.isPublicRecycleItem) ? '&recycle=1' : '';
        var thumbUrl = '/api/files/thumb?id=' + encodeURIComponent(thumbId) + '&w=' + thumbSize + '&h=' + thumbSize + recycleFlag;
        iconWrapContent =
          '<img class="card-thumb" src="' + thumbUrl + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px;opacity:0;transition:opacity 0.3s" onload="this.style.opacity=\'1\'" onerror="this.style.opacity=\'0\';this.nextElementSibling.style.display=\'flex\'">' +
          '<span class="card-icon ' + typeClass + '" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:none">' + icon + '</span>';
      } else if (isVideoThumb) {
        // 公共视频用 relPath，个人视频用 id
        var videoIdParam = (item.isPublicFile && item.relPath) ? item.relPath : item.id;
        var videoPreviewUrl = '/api/files/video-preview?id=' + encodeURIComponent(videoIdParam);
        var videoId = 'vp_' + (item.isPublicFile && item.relPath ? encodeURIComponent(item.relPath) : item.id);
        iconWrapContent =
          '<div style="position:relative;width:100%;height:100%">' +
            '<img class="card-thumb video-thumb-img" id="' + videoId + '_img" src="" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px;opacity:0;transition:opacity 0.3s">' +
            '<video class="card-video-preview" id="' + videoId + '" src="' + videoPreviewUrl + '" preload="metadata" style="display:none;width:1px;height:1px;position:absolute;top:-9999px" muted crossorigin="anonymous"></video>' +
            '<span class="card-icon ' + typeClass + '" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex">' + icon + '</span>' +
            '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:36px;height:36px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;pointer-events:none">&#9654;</div>' +
          '</div>';
        // 延迟执行，避免影响列表渲染性能
        setTimeout(captureVideoFrame, 0, videoIdParam, videoId);
      }

      // 网格卡片：三dot菜单按钮（菜单内部已有权限判断）
      var showMenu = item.isRecycleItem ||
        (state.dirType === 'public') ||
        (state.dirType === 'personal');
      var menuBtn = '';
      if (showMenu) {
        menuBtn = '<div class="card-menu-btn" title="更多操作">&#8942;</div>';
      }

      // 回收站项目显示删除时间和剩余天数
      var cardMeta = '';
      if (item.isRecycleItem) {
        var delTime = item.deleted_at ? formatLogTime(item.deleted_at) : '-';
        cardMeta = '<span style="color:var(--text-muted);font-size:11px">删除于 ' + delTime + '</span>';
        if (item.remaining_text && item.remaining_ms > 0) {
          cardMeta += '<br><span style="color:#e67e22;font-size:11px">剩余 ' + item.remaining_text + '</span>';
        } else if (item.remaining_ms <= 0) {
          cardMeta += '<br><span style="color:#e74c3c;font-size:11px">已过期</span>';
        }
        // 目录显示包含的文件数量
        if (item.isDirectory && item.file_count > 0) {
          cardMeta += '<br><span style="color:var(--text-muted);font-size:11px">包含 ' + item.file_count + ' 个文件</span>';
        }
      } else {
        cardMeta = '<span>' + (item.isDirectory ? '&#128193;' : formatFileSize(item.size)) + '</span>';
      }

      card.innerHTML =
        '<div class="hover-shimmer"></div>' +
        (!item.isDirectory && ext ? '<div class="card-badge">' + escapeAttr(ext) + '</div>' : '') +
        (item.is_broken ? '<div class="card-broken-overlay" title="文件已失效，无法下载">💔 已失效</div>' : '') +
        '<div class="card-check-wrap' + (state.isSelectionMode ? '' : ' hidden-check') + '">' +
          '<div class="checkbox' + (isSelected ? ' checked' : '') + '"></div>' +
        '</div>' +
        '<div class="card-icon-wrap">' + iconWrapContent + '</div>' +
        '<div class="card-info">' +
          '<div class="card-name" title="' + escapeAttr(displayName) + '">' + (item.is_broken ? '💔 ' : '') + displayName + '</div>' +
          '<div class="card-meta">' + cardMeta + '</div>' +
        '</div>' +
        menuBtn;

      // 勾选框点击（必须阻止冒泡，防止卡片点击事件触发）
      var cbWrap = card.querySelector('.card-check-wrap');
      if (cbWrap) {
        cbWrap.addEventListener('click', function(e) {
          e.stopPropagation();
          toggleFileSelection(item.id, item.isDirectory);
        });
      }

      // 三dot菜单
      var menuEl = card.querySelector('.card-menu-btn');
      if (menuEl) {
        menuEl.addEventListener('click', function(e) {
          e.stopPropagation();
          showItemMenu(e, item, card);
        });
      }

      card.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.isSelectionMode) {
          if (e.target.closest('.card-menu-btn')) return;
          toggleFileSelection(item.id, item.isDirectory);
          return;
        }
        if (e.target.closest('.card-menu-btn')) return;
        if (item.isDirectory) {
          navigateToDir(item.id, item.name);
        } else {
          openPreview(item);
        }
      });
      // 双击也触发预览（明确行为）
      card.addEventListener('dblclick', function (e) {
        if (state.isSelectionMode) return;
        if (e.target.closest('.card-menu-btn')) return;
        if (!item.isDirectory) {
          openPreview(item);
        }
      });
      grid.appendChild(card);
    });
    container.appendChild(grid);
  }

  function renderTable(data) {
    var container = $('#file-container');
    if (!container) return;
    container.innerHTML = '';
    var wrap = el('div', 'file-table-wrap');
    var table = el('table', 'file-table');
    if (state.isSelectionMode) wrap.classList.add('fm-selection-mode');
    var colgroup = '<colgroup>' +
      '<col class="col-check" />' +
      '<col class="col-icon" />' +
      '<col class="col-name" />' +
      '<col class="col-size" />' +
      '<col class="col-date" />' +
      '<col class="col-remaining" />' +
      '<col class="col-menu" />' +
    '</colgroup>';
    var visIds = data.map(function(f) { return String(f.id); });
    var headerCbCls = '';
    if (visIds.length > 0) {
      var allVisSel = visIds.every(function(id) { return state.selectedFiles.indexOf(id) !== -1; });
      var noVisSel = visIds.every(function(id) { return state.selectedFiles.indexOf(id) === -1; });
      if (allVisSel) headerCbCls = ' checked';
      else if (!noVisSel) headerCbCls = ' partial';
    }
    var th = '<thead><tr>' +
      '<th class="th-check" id="table-select-all-th"><div class="checkbox' + headerCbCls + '"></div></th>' +
      '<th class="th-icon">类型</th>' +
      '<th class="fm-sort ' + (state.sortConfig.key === 'name' ? 'active' : '') + '" data-sort="name">名称</th>' +
      '<th class="fm-sort th-size ' + (state.sortConfig.key === 'size' ? 'active' : '') + '" data-sort="size">大小</th>' +
      '<th class="th-date">修改时间</th>' +
      '<th class="th-remaining">剩余</th>' +
      '<th class="th-menu">操作</th>' +
    '</tr></thead><tbody>';
    data.forEach(function (item, i) {
      var mime = safeMimeType(item.mimeType);
      var typeClass = item.isDirectory ? 'type-folder' : getTypeClass(mime);
      var icon = item.isDirectory ? ICON_MAP['folder'] : getIcon(mime);
      var isSelected = state.selectedFiles.indexOf(String(item.id)) !== -1;
      var showMenu = item.isRecycleItem ||
        (state.dirType === 'public') ||
        (state.dirType === 'personal');
      var menuBtn = '';
      if (showMenu) {
        menuBtn = '<button class="row-menu-btn" title="更多操作">&#8942;</button>';
      }

      // 表格行 checkbox（回收站模式下始终显示）
      var cbCell = state.dirType === 'recycle'
        ? '<td class="td-check td-first"><div class="checkbox' + (isSelected ? ' checked' : '') + '"></div></td>'
        : '<td class="td-check td-first"><div class="checkbox' + (isSelected ? ' checked' : '') + '"></div></td>';

      // 表格日期列（回收站显示删除时间）
      var tableDate = '';
      if (item.isRecycleItem) {
        tableDate = item.deleted_at ? formatLogTime(item.deleted_at) : '-';
      } else {
        tableDate = item.created_at ? item.created_at.split('T')[0] : '-';
      }

      // 表格剩余时间列（回收站显示倒计时）
      var remainingCell = '';
      if (item.isRecycleItem) {
        if (item.remaining_text && item.remaining_ms > 0) {
          remainingCell = '<td class="td-remaining" style="color:#e67e22;font-size:12px">' + item.remaining_text + '</td>';
        } else if (item.remaining_ms <= 0) {
          remainingCell = '<td class="td-remaining" style="color:#e74c3c;font-size:12px">已过期</td>';
        } else {
          remainingCell = '<td class="td-remaining" style="color:#999;font-size:12px">-</td>';
        }
      } else {
        remainingCell = '<td class="td-remaining"></td>';
      }

      th += '<tr class="fm-row' + (isSelected ? ' selected' : '') + (item.is_broken ? ' broken' : '') + '" data-file-id="' + String(item.id) + '" data-item="' + encodeURIComponent(JSON.stringify(item)) + '">' +
        cbCell +
        '<td class="td-icon"><span class="' + typeClass + '" style="font-size:18px">' + (item.is_broken ? '💔' : icon) + '</span></td>' +
        '<td class="td-name"><span class="' + typeClass + '">' + (item.is_broken ? '💔 ' : '') + escapeAttr(item.name) + '</span></td>' +
        '<td class="td-size">' + (item.isRecycleItem ? '-' : formatFileSize(item.size)) + '</td>' +
        '<td class="td-date">' + tableDate + '</td>' +
        remainingCell +
        '<td class="td-menu td-last">' + menuBtn + '</td>' +
      '</tr>';
    });
    th += '</tbody>';
    table.innerHTML = colgroup + th;
    wrap.appendChild(table);
    container.appendChild(wrap);
    $$('.fm-sort', wrap).forEach(function (el2) { el2.addEventListener('click', function () { sortBy(el2.dataset.sort); }); });

    // 表格表头全选复选框
    var selectAllTh = $('#table-select-all-th');
    if (selectAllTh) {
      var cbWrap = $('.checkbox', selectAllTh);
      if (cbWrap) {
        cbWrap.style.cursor = 'pointer';
        cbWrap.addEventListener('click', function(e) {
          e.stopPropagation();
          var allIds = data.map(function(f) { return String(f.id); });
          var allSelected = allIds.length > 0 && allIds.every(function(id) { return state.selectedFiles.indexOf(id) !== -1; });
          if (allSelected) {
            deselectAllFiles();
          } else {
            selectAllFiles();
          }
        });
      }
    }

    $$('.row-menu-btn', wrap).forEach(function (btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var row = btn.closest('.fm-row');
        if (!row) return;
        var itemRef = row.dataset.item;
        if (!itemRef) return;
        var item = JSON.parse(decodeURIComponent(itemRef));
        showItemMenu(e, item, row);
      });
    });

    // 表格行点击：selection mode 下点任意处触发勾选，方便移动端多选
    $$('.fm-row', wrap).forEach(function (row) {
      var idx = parseInt(row.rowIndex, 10) - 1;
      row.style.cursor = state.isSelectionMode ? 'default' : 'pointer';
      row.addEventListener('click', function (e) {
        if (state.isSelectionMode) {
          if (e.target.closest('.row-menu-btn')) return;
          var item = data[idx];
          if (item) toggleFileSelection(item.id, item.isDirectory);
          return;
        }
        if (e.target.closest('.td-check') || e.target.closest('.row-menu-btn')) return;
        var item = data[idx];
        if (!item) return;
        if (item.isDirectory) {
          navigateToDir(item.id, item.name);
        } else {
          openPreview(item);
        }
      });
      row.addEventListener('dblclick', function (e) {
        if (state.isSelectionMode) return;
        var item = data[idx];
        if (item && !item.isDirectory) {
          openPreview(item);
        }
      });
    });

    // 表格勾选框点击：精确响应，不冒泡
    $$('.fm-row .td-check', wrap).forEach(function (cell, i) {
      cell.addEventListener('click', function(e) {
        e.stopPropagation();
        var item = data[i];
        if (item) toggleFileSelection(item.id, item.isDirectory);
      });
    });
  }

  function renderEmpty() {
    var container = $('#file-container');
    if (!container) return;
    container.innerHTML = '';
    var empty = el('div', 'empty-state');
    var filtered = !!(state.searchQuery && state.fileData && state.fileData.length > 0);

    // 回收站空状态特殊处理
    var isRecycleMode = (state.dirType === 'recycle' || state.dirType === 'public-recycle');
    if (isRecycleMode && !filtered) {
      // 回收站空状态
      var iconDiv = el('div', 'empty-icon');
      iconDiv.innerHTML = '&#128465;';
      empty.appendChild(iconDiv);
      var h3 = el('h3');
      h3.textContent = '回收站为空';
      empty.appendChild(h3);
      var p = el('p');
      p.textContent = '删除的文件将在此处显示，您可以在此处恢复或永久删除它们';
      empty.appendChild(p);
      container.appendChild(empty);
      return;
    }

    // 空状态按钮区域（始终可见）
    var btnRow = el('div', 'empty-btn-row');
    var newFolderBtn = el('button', 'toolbar-btn primary');
    newFolderBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg><span>新建文件夹</span>';
    newFolderBtn.addEventListener('click', function() { createNewFolder(); });
    var uploadBtn = el('button', 'toolbar-btn');
    uploadBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg><span>上传文件</span>';
    uploadBtn.addEventListener('click', function() { triggerUpload(); });
    btnRow.appendChild(newFolderBtn);
    btnRow.appendChild(uploadBtn);
    empty.appendChild(btnRow);
    var iconDiv = el('div', 'empty-icon');
    iconDiv.innerHTML = '&#128462;';
    empty.appendChild(iconDiv);
    var h3 = el('h3');
    h3.textContent = filtered ? '未找到匹配文件' : '目录为空';
    empty.appendChild(h3);
    var p = el('p');
    p.textContent = filtered ? '没有文件匹配 "' + escapeAttr(state.searchQuery) + '"' : '上传文件或创建目录开始使用';
    empty.appendChild(p);
    if (filtered) {
      var btn = el('button', '');
      btn.textContent = '清除搜索';
      btn.style.cssText = 'margin-top:16px;padding:8px 20px;background:var(--accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-family:Syne,sans-serif;font-size:13px;font-weight:600;transition:all 0.3s';
      btn.addEventListener('click', function () {
        var inp = $('#toolbar-search-input');
        if (inp) inp.value = '';
        state.searchQuery = '';
        renderFiles();
      });
      empty.appendChild(btn);
    }
    container.appendChild(empty);
  }

  function sortBy(key) {
    if (state.sortConfig.key === key) {
      state.sortConfig.order = state.sortConfig.order === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortConfig.key = key;
      state.sortConfig.order = 'asc';
    }
    renderFiles();
  }

  // ---------- Download ----------
  // 使用原生 <a href download>：浏览器直连下载（零内存，支持大文件，显示真实进度条）
  // 同源请求自动携带 cookie，无需额外处理
  // 访客下载文件大小限制
  var GUEST_DL_LIMIT = 100 * 1024 * 1024; // 100MB

  function downloadFile(item) {
    // 失效文件：阻止下载
    if (item.is_broken) {
      showToast('文件已失效，存储文件已被清理，无法下载。请删除该文件后重新上传', '&#9888;');
      return;
    }

    // 访客检查：文件超过 100MB 时引导登录
    if (!state.user && (item.size || 0) > GUEST_DL_LIMIT) {
      showLoginPromptDiag(item.name || '', item.size);
      return;
    }

    var downloadUrl;
    if (item.isPublicRecycleItem && !item.isDirectory) {
      downloadUrl = '/api/public-recycle/files/' + item.id + '/download';
    } else if (item.isPublicFile) {
      var relPath = item.relPath || item.path || item.name || '';
      if (!relPath) {
        showToast('文件路径信息缺失', '&#9888;');
        console.log('[Download] 错误：item =', JSON.stringify(item));
        return;
      }
      downloadUrl = '/api/public-files/download?path=' + encodeURIComponent(relPath);
    } else {
      if (!item.id) {
        showToast('文件信息缺失', '&#9888;');
        console.log('[Download] 错误：item =', JSON.stringify(item));
        return;
      }
      downloadUrl = '/api/files/download/' + item.id;
    }
    // 用 <a download> 触发：浏览器直连服务器下载流，零内存占用，支持大文件，显示真实进度
    var a = document.createElement('a');
    a.href = downloadUrl;
    a.download = item.name || '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function downloadFiles(files) {
    // 多文件：逐个触发浏览器下载（浏览器会排队处理）
    files.forEach(function(item, i) {
      setTimeout(function() { downloadFile(item); }, i * 300);
    });
  }

  // ==================== 文件预览 ====================

  // 可预览的 MIME 类型
  var PREVIEW_IMAGE   = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/bmp','image/x-icon'];
  var PREVIEW_VIDEO   = ['video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo','video/avi'];
  var PREVIEW_AUDIO   = ['audio/mpeg','audio/ogg','audio/wav','audio/flac','audio/aac','audio/mp3'];
  var PREVIEW_TEXT    = ['text/plain','text/html','text/css','text/javascript','text/xml',
                          'application/json','application/javascript','application/xml'];
  var PREVIEW_MARKDOWN = ['text/markdown'];
  var PREVIEW_EDIT    = PREVIEW_TEXT.concat(PREVIEW_MARKDOWN).concat(
                          ['text/csv','application/x-sh','text/x-python','text/x-java',
                           'text/x-csrc','text/x-c++src','text/x-php','text/x-ruby']);

  // 按扩展名推断 MIME 类型（兜底数据库为空的情况）
  var MIME_BY_EXT = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
    'bmp': 'image/bmp', 'webp': 'image/webp', 'svg': 'image/svg+xml', 'ico': 'image/x-icon',
    'mp4': 'video/mp4', 'webm': 'video/webm', 'ogg': 'video/ogg', 'avi': 'video/x-msvideo',
    'mov': 'video/quicktime', 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'flac': 'audio/flac',
    'pdf': 'application/pdf',
    'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };

  function getMimeByName(name) {
    var n = (name || '').toLowerCase();
    var idx = n.lastIndexOf('.');
    if (idx === -1) return null;
    var ext = n.substring(idx + 1);
    return MIME_BY_EXT[ext] || null;
  }

  function getPreviewType(mime, name) {
    var n = (name || '').toLowerCase();
    var ext = n.split('.').pop();

    // 文本文件（后端流式渲染）
    if (ext === 'txt') return 'text';
    // Markdown 渲染
    if (ext === 'md') return 'markdown';
    // DOCX 转为 HTML 渲染
    if (ext === 'docx') return 'docx';
    // PDF/旧版 Office 用在线预览器（目前暂时不支持）
    if (ext === 'pdf') return 'pdf';
    if (ext === 'doc' || ext === 'xls' || ext === 'xlsx' || ext === 'ppt' || ext === 'pptx') return 'office_unsupported';

    // 图片：优先用 mime 列表判断，兜底按扩展名
    if (PREVIEW_IMAGE.includes(mime)) return 'image';
    if (PREVIEW_VIDEO.includes(mime)) return 'video';
    if (PREVIEW_AUDIO.includes(mime)) return 'audio';
    if (PREVIEW_EDIT.includes(mime)) return 'text';

    var extMime = MIME_BY_EXT[ext];
    if (extMime && extMime.startsWith('image/')) return 'image';
    if (extMime && extMime.startsWith('video/')) return 'video';
    if (extMime && extMime.startsWith('audio/')) return 'audio';

    return null;
  }

  function isEditable(mime, name) {
    return PREVIEW_EDIT.includes(mime) || getPreviewType(mime, name) === 'markdown';
  }

  function openPreview(item) {
    var type = getPreviewType(item.mime_type, item.name);
    if (!type) {
      showToast('该文件类型暂不支持预览，请下载后查看');
      return;
    }
    if (type === 'office_unsupported') {
      showToast('该格式暂不支持预览，请下载后查看');
      return;
    }
    showPreviewModal(item, type);
  }

  function showPreviewModal(item, type) {
    // 关闭已有弹窗
    closePreviewModal();

    var isEdit = isEditable(item.mime_type, item.name);
    var streamUrl = '/api/files/stream/' + item.id;
    var overlay = document.createElement('div');
    overlay.id = 'preview-overlay';
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.92);',
      'display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;padding:20px;box-sizing:border-box;'
    ].join('');

    var title = item.name;
    var contentHtml = '';

    if (type === 'image') {
      contentHtml = '<img id="pv-img" src="' + streamUrl + '" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6)" alt="' + title + '">';
    } else if (type === 'video') {
      contentHtml = '<video id="pv-video" src="' + streamUrl + '" controls autoplay playsinline style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);background:#000" crossorigin="anonymous"></video>';
    } else if (type === 'audio') {
      contentHtml = '<div style="background:var(--bg-card,rgba(20,22,35,0.98));border:1px solid var(--border,rgba(0,212,255,0.2));border-radius:16px;padding:40px 48px;text-align:center"><audio id="pv-audio" src="' + streamUrl + '" controls autoplay style="width:100%"></audio></div>';
    } else if (type === 'text') {
      // 文本文件：调用后端 /api/files/text/:id 获取内容
      var editorHeight = isEdit ? 'calc(100vh - 240px)' : 'calc(100vh - 200px)';
      contentHtml =
        '<div id="pv-text-wrap" style="width:100%;max-width:900px;display:flex;flex-direction:column;gap:0">' +
          '<textarea id="pv-textarea" spellcheck="false" ' + (isEdit ? '' : 'readonly ') +
            'style="width:100%;height:' + editorHeight +
            ';background:rgba(10,12,20,0.95);color:#e0e6f0;font-family:\'Share Tech Mono\',monospace;' +
            'font-size:13px;line-height:1.7;padding:20px;border:1px solid rgba(0,212,255,0.2);' +
            'border-radius:12px;resize:none;outline:none;box-sizing:border-box;' +
            'tab-size:2;white-space:pre;overflow:auto;' +
            (isEdit ? '' : 'cursor:default') + '">' +
          '</textarea>' +
        '</div>';
    } else if (type === 'markdown') {
      // Markdown：先加载内容，再渲染为 HTML
      var mdHeight = 'calc(100vh - 200px)';
      contentHtml =
        '<div id="pv-text-wrap" style="width:100%;max-width:900px;display:flex;flex-direction:column;gap:0">' +
          '<textarea id="pv-textarea" spellcheck="false" readonly ' +
            'style="display:none;width:100%;height:' + mdHeight +
            ';background:rgba(10,12,20,0.95);color:#e0e6f0;font-family:\'Share Tech Mono\',monospace;' +
            'font-size:13px;line-height:1.7;padding:20px;border:1px solid rgba(0,212,255,0.2);' +
            'border-radius:12px;resize:none;outline:none;box-sizing:border-box"></textarea>' +
          '<div id="pv-markdown-content" style="width:100%;height:' + mdHeight +
            ';background:rgba(10,12,20,0.95);color:#e0e6f0;font-family:\'Microsoft YaHei\',sans-serif;' +
            'font-size:14px;line-height:1.8;padding:20px;border:1px solid rgba(0,212,255,0.2);' +
            'border-radius:12px;overflow:auto;box-sizing:border-box"></div>' +
        '</div>';
    } else if (type === 'docx') {
      // DOCX：调用后端 mammoth 转为 HTML 后渲染
      contentHtml = '<div id="pv-docx-content" style="width:100%;height:calc(100vh - 180px);background:rgba(10,12,20,0.95);border:1px solid rgba(0,212,255,0.2);border-radius:12px;overflow:auto;box-sizing:border-box;padding:30px 40px;color:#e0e6f0;font-family:\'Microsoft YaHei\',sans-serif;font-size:14px;line-height:1.8"></div>';
    } else if (type === 'pdf') {
      // PDF：使用 Microsoft Office Online Viewer（支持 localhost）
      contentHtml = '<iframe id="pv-online" style="display:none;width:100%;height:calc(100vh - 180px);border-radius:8px;border:1px solid rgba(0,212,255,0.2)" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>' +
        '<div id="pv-online-loading" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:calc(100vh - 180px);gap:16px;color:#7a8194;font-family:\'Share Tech Mono\',monospace;font-size:13px"><div style="width:32px;height:32px;border:3px solid rgba(0,212,255,0.15);border-top-color:#00d4ff;border-radius:50%;animation:spin 0.8s linear infinite"></div>正在加载预览...</div>';
    }

    overlay.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;width:100%;max-width:900px;margin-bottom:16px;gap:16px;flex-shrink:0">' +
        '<div style="display:flex;align-items:center;gap:12px;min-width:0">' +
          '<span id="pv-icon" style="font-size:20px;flex-shrink:0">&#128196;</span>' +
          '<span id="pv-title" style="font-size:15px;font-weight:700;color:#fff;font-family:\'Syne\',sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + title + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">' +
          (isEdit ? '<button id="pv-edit-btn" style="display:none;padding:6px 16px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.4);border-radius:8px;color:#00d4ff;font-size:13px;font-weight:600;cursor:pointer;font-family:\'Syne\',sans-serif">&#9998; 编辑</button>' : '') +
          (isEdit ? '<button id="pv-save-btn" style="display:none;padding:6px 16px;background:linear-gradient(135deg,#00d4ff,#0099cc);border:none;border-radius:8px;color:#07090f;font-size:13px;font-weight:700;cursor:pointer;font-family:\'Syne\',sans-serif">&#128190; 保存</button>' : '') +
          '<button id="pv-dl-btn" style="padding:6px 16px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e0e6f0;font-size:13px;font-weight:600;cursor:pointer;font-family:\'Syne\',sans-serif">&#128229; 下载</button>' +
          '<button id="pv-close-btn" style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#e0e6f0;font-size:18px;cursor:pointer;flex-shrink:0">&#10005;</button>' +
        '</div>' +
      '</div>' +
      '<div id="pv-content" style="width:100%;max-width:900px;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden">' +
        contentHtml +
      '</div>' +
      '<div id="pv-loading" style="position:absolute;display:flex;flex-direction:column;align-items:center;gap:12px;color:#7a8194;font-family:\'Share Tech Mono\',monospace;font-size:13px"><div style="width:32px;height:32px;border:3px solid rgba(0,212,255,0.15);border-top-color:#00d4ff;border-radius:50%;animation:spin 0.8s linear infinite"></div>加载中...</div>';

    document.body.appendChild(overlay);

    // 遮罩点击关闭
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePreviewModal();
    });

    // ESC 关闭
    document.addEventListener('keydown', _previewEscHandler);

    // 加载内容（根据不同类型）
    if (type === 'text') {
      // 文本文件：通过后端接口获取内容
      var loadingEl = overlay.querySelector('#pv-loading');
      var ta = overlay.querySelector('#pv-textarea');
      apiGet('/files/text/' + item.id).then(function(res) {
        if (res.code !== 0) {
          showToast('文件读取失败');
          closePreviewModal();
          return;
        }
        if (ta) ta.value = res.data.content + (res.data.truncated ? '\n\n... (内容已截断，仅显示前 5MB)' : '');
        if (loadingEl) loadingEl.style.display = 'none';
      }).catch(function() {
        if (ta) {
          ta.value = '&#9888; 文件读取失败，请检查网络连接';
        }
        if (loadingEl) loadingEl.style.display = 'none';
      });
    } else if (type === 'markdown') {
      // Markdown：获取内容后用 marked.js 渲染（从 cdn 加载）
      var loadingEl = overlay.querySelector('#pv-loading');
      var ta = overlay.querySelector('#pv-textarea');
      var mdDiv = overlay.querySelector('#pv-markdown-content');
      apiGet('/files/text/' + item.id).then(function(res) {
        if (res.code !== 0) {
          showToast('文件读取失败');
          closePreviewModal();
          return;
        }
        if (ta) ta.value = res.data.content;
        // 动态加载 marked.js 渲染 Markdown
        var markedScript = document.createElement('script');
        markedScript.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
        markedScript.onload = function() {
          if (window.marked && mdDiv) {
            mdDiv.innerHTML = window.marked(res.data.content);
          } else if (mdDiv) {
            mdDiv.innerHTML = res.data.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          }
          if (loadingEl) loadingEl.style.display = 'none';
        };
        markedScript.onerror = function() {
          if (mdDiv) mdDiv.innerHTML = res.data.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          if (loadingEl) loadingEl.style.display = 'none';
        };
        document.head.appendChild(markedScript);
      }).catch(function() {
        if (loadingEl) loadingEl.innerHTML = '&#9888; 网络错误';
      });
    } else if (type === 'docx') {
      // DOCX：调用后端 mammoth 转 HTML 后渲染
      var loadingEl = overlay.querySelector('#pv-loading');
      var docxDiv = overlay.querySelector('#pv-docx-content');
      apiGet('/files/docx/' + item.id).then(function(res) {
        if (res.code !== 0) {
          showToast('DOCX 文件转换失败，请下载后查看');
          closePreviewModal();
          return;
        }
        if (docxDiv) {
          docxDiv.innerHTML = res.data.html;
          docxDiv.scrollTop = 0;
        }
        if (loadingEl) loadingEl.style.display = 'none';
      }).catch(function() {
        if (docxDiv) docxDiv.innerHTML = '&#9888; 网络错误，请检查网络连接';
        if (loadingEl) loadingEl.style.display = 'none';
      });
    } else if (type === 'pdf') {
      // PDF：使用 Microsoft Office Online Viewer
      var loadingEl = overlay.querySelector('#pv-loading');
      apiGet('/files/preview-token/' + item.id).then(function(res) {
        if (res.code !== 0) {
          showToast('获取预览令牌失败');
          closePreviewModal();
          return;
        }
        var token = res.data.token;
        var iframe = overlay.querySelector('#pv-online');
        var loadingDiv = overlay.querySelector('#pv-online-loading');
        if (iframe && loadingDiv) {
          var previewUrl = window.location.origin + streamUrl + '?token=' + encodeURIComponent(token);
          var officeViewerUrl = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(previewUrl);
          iframe.src = officeViewerUrl;
          iframe.addEventListener('load', function() {
            if (loadingDiv) loadingDiv.style.display = 'none';
            iframe.style.display = 'block';
            if (loadingEl) loadingEl.style.display = 'none';
          });
          iframe.addEventListener('error', function() {
            if (loadingDiv) loadingDiv.innerHTML = '&#9888; PDF 预览失败，请下载后查看';
          });
        }
      }).catch(function() {
        if (loadingEl) loadingEl.innerHTML = '&#9888; 网络错误';
      });
    } else {
      // 图片/视频/音频加载完成后隐藏 loading
      var loadedSelector = type === 'image' ? '#pv-img' : type === 'video' ? '#pv-video' : '#pv-audio';
      var target = overlay.querySelector(loadedSelector);
      var loadingEl = overlay.querySelector('#pv-loading');
      if (target) {
        var onLoad = function() {
          if (loadingEl) loadingEl.style.display = 'none';
          target.removeEventListener('load', onLoad);
          target.removeEventListener('loadeddata', onLoad);
          target.removeEventListener('canplay', onLoad);
        };
        target.addEventListener('load', onLoad);
        target.addEventListener('loadeddata', onLoad);
        target.addEventListener('canplay', onLoad);
        target.addEventListener('error', function() {
          if (loadingEl) loadingEl.style.display = 'none';
        });
      } else if (loadingEl) {
        setTimeout(function() { if (loadingEl) loadingEl.style.display = 'none'; }, 1500);
      }
    }

    // 按钮事件
    var closeBtn = overlay.querySelector('#pv-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', closePreviewModal);

    var dlBtn = overlay.querySelector('#pv-dl-btn');
    if (dlBtn) dlBtn.addEventListener('click', function() { downloadFile(item); });

    if (type === 'text' || type === 'markdown') {
      var editBtn = overlay.querySelector('#pv-edit-btn');
      var saveBtn = overlay.querySelector('#pv-save-btn');
      if (editBtn) {
        editBtn.style.display = 'inline-flex';
        editBtn.addEventListener('click', function() {
          var ta = overlay.querySelector('#pv-textarea');
          if (ta) { ta.readOnly = false; ta.focus(); }
          if (editBtn) editBtn.style.display = 'none';
          if (saveBtn) saveBtn.style.display = 'inline-flex';
        });
      }
      if (saveBtn) {
        saveBtn.style.display = 'inline-flex';
        saveBtn.addEventListener('click', function() {
          savePreviewContent(overlay, item);
        });
      }
    }

    // 窗口大小变化时重算图片尺寸
    if (type === 'image') {
      window.addEventListener('resize', _previewResizeHandler);
    }
  }

  var _previewEscHandler = null;
  var _previewResizeHandler = null;

  function closePreviewModal() {
    var overlay = document.getElementById('preview-overlay');
    if (overlay) {
      var ta = overlay.querySelector('#pv-textarea');
      if (ta && !ta.readOnly) {
        var confirmed = confirm('有未保存的修改，确定要关闭吗？');
        if (!confirmed) return;
      }
    }
    if (_previewEscHandler) { document.removeEventListener('keydown', _previewEscHandler); _previewEscHandler = null; }
    if (_previewResizeHandler) { window.removeEventListener('resize', _previewResizeHandler); _previewResizeHandler = null; }
    if (overlay) overlay.remove();
  }

  // ESC 关闭预览（动态创建 handler）
  document.addEventListener('keydown', function(e) {
    var overlay = document.getElementById('preview-overlay');
    if (!overlay) return;
    if (e.key === 'Escape') closePreviewModal();
  });

  function loadPreviewTextContent(item, streamUrl, isEdit) {
    var overlay = document.getElementById('preview-overlay');
    var ta = overlay ? overlay.querySelector('#pv-textarea') : null;
    var loadingEl = overlay ? overlay.querySelector('#pv-loading') : null;
    if (!ta) return;

    var xhr = new XMLHttpRequest();
    xhr.open('GET', streamUrl, true);
    xhr.responseType = 'text';
    xhr.onload = function() {
      if (xhr.status === 200) {
        ta.value = xhr.responseText;
      } else {
        ta.value = '(加载失败: ' + xhr.status + ')';
      }
      if (loadingEl) loadingEl.style.display = 'none';
    };
    xhr.onerror = function() {
      ta.value = '(网络错误，加载失败)';
      if (loadingEl) loadingEl.style.display = 'none';
    };
    xhr.send();
  }

  function savePreviewContent(overlay, item) {
    var ta = overlay ? overlay.querySelector('#pv-textarea') : null;
    var saveBtn = overlay ? overlay.querySelector('#pv-save-btn') : null;
    if (!ta || !item) return;

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中...'; }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/update/' + item.id, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '&#128190; 保存'; }
      try {
        var res = JSON.parse(xhr.responseText);
        if (res.code === 0) {
          ta.readOnly = true;
          showToast('保存成功');
          // 更新列表中该文件的大小
          var allItems = state.currentItems || [];
          var idx = allItems.findIndex(function(i) { return i.id === item.id; });
          if (idx >= 0 && res.data && res.data.size !== undefined) {
            allItems[idx].size = res.data.size;
          }
        } else {
          showToast(res.message || '保存失败');
        }
      } catch(e) {
        showToast('保存失败');
      }
    };
    xhr.onerror = function() {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '&#128190; 保存'; }
      showToast('网络错误，保存失败');
    };
    xhr.send(JSON.stringify({ content: ta.value }));
  }

  function restoreItem(item) {
    var url;
    if (item.isPublicRecycleItem) {
      url = item.isDirectory
        ? '/public-recycle/dirs/' + item.id + '/restore'
        : '/public-recycle/files/' + item.id + '/restore';
    } else {
      url = item.isDirectory
        ? '/recycle/dirs/' + item.id + '/restore'
        : '/recycle/files/' + item.id + '/restore';
    }
    // 批量恢复场景：恢复成功后立即刷新列表并继续下一个
    var isBatchMode = (state.selectedFiles.length > 1);
    apiPost(url, {}).then(function(res) {
      if (res.code === 0) {
        showToast('已恢复到原位置', '&#128260;');
        loadFiles(0);
        if (item.isPublicRecycleItem) updatePublicRecycleBadge();
        else updateRecycleBadge();
      } else if (res.code === 2) {
        // 名称冲突
        if (confirm('目标位置存在同名"' + res.data.fileName + '"，是否替换原文件？')) {
          var forceUrl = url;
          var forceData = item.isDirectory ? {} : { force: true };
          apiPost(forceUrl, forceData).then(function(r2) {
            if (r2.code === 0) {
              showToast('已替换并恢复', '&#128260;');
              loadFiles(0);
              if (item.isPublicRecycleItem) updatePublicRecycleBadge();
              else updateRecycleBadge();
            } else {
              showToast(r2.message || '恢复失败', '&#9888;');
            }
          });
        }
      } else if (res.code === 3) {
        // 原始目录不存在，需要用户选择目录
        showRestoreTargetDialog(item, res.data);
      } else {
        showToast(res.message || '恢复失败', '&#9888;');
      }
    });
  }

  // 显示恢复目标目录选择对话框（原始目录已不存在时调用）
  function showRestoreTargetDialog(item, data) {
    var overlay = el('div', 'move-overlay');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var dialog = el('div', 'move-dialog');
    dialog.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:0;min-width:480px;max-width:600px;width:90%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;';

    var isDir = !!(item.isDirectory);
    dialog.innerHTML =
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-size:16px;font-weight:600;color:var(--text-primary);">&#128260; 恢复 - 选择目标目录</span>' +
        '<button id="restore-close-btn" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;padding:4px;line-height:1;">&#10005;</button>' +
      '</div>' +
      '<div style="padding:12px 20px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-size:13px;">' +
        '原位置已不存在，请为 "<strong style="color:var(--text-primary);">' + escapeAttr(data.fileName || data.dirName) + '</strong>" 选择恢复到的目录' +
      '</div>' +
      '<div id="restore-tree-container" style="flex:1;overflow-y:auto;padding:12px 20px;min-height:200px;max-height:400px;"></div>' +
      '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="restore-cancel-btn" style="padding:8px 20px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:14px;">取消</button>' +
        '<button id="restore-confirm-btn" style="padding:8px 20px;border:none;border-radius:8px;background:var(--accent);color:white;cursor:pointer;font-size:14px;font-weight:600;">确认恢复</button>' +
      '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var treeContainer = $('#restore-tree-container');
    var confirmBtn = $('#restore-confirm-btn');
    var cancelBtn = $('#restore-cancel-btn');
    var closeBtn = $('#restore-close-btn');

    var selectedDirId = 0;

    function renderRestoreTree() {
      var availableDirs = data.availableDirs || [];
      var html = '<div style="display:flex;flex-direction:column;gap:2px;">';

      // 根目录选项
      var rootSelected = selectedDirId === 0;
      html += '<div class="restore-dir-item' + (rootSelected ? ' selected' : '') + '" data-dir-id="0" style="padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:8px;' + (rootSelected ? 'background:var(--accent);color:white;' : 'color:var(--text-primary);') + '">' +
        '<span style="font-size:16px;">&#128193;</span><span>根目录</span></div>';

      availableDirs.forEach(function(d) {
        var selected = selectedDirId === d.id;
        var label = d.path ? (d.path + ' / ' + d.name) : d.name;
        html += '<div class="restore-dir-item' + (selected ? ' selected' : '') + '" data-dir-id="' + d.id + '" style="padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:8px;' + (selected ? 'background:var(--accent);color:white;' : 'color:var(--text-primary);') + '">' +
          '<span style="font-size:16px;">&#128193;</span><span>' + escapeAttr(label) + '</span></div>';
      });

      html += '</div>';
      treeContainer.innerHTML = html;

      $$('.restore-dir-item', treeContainer).forEach(function(el) {
        el.addEventListener('click', function() {
          selectedDirId = parseInt(el.dataset.dirId, 10);
          renderRestoreTree();
        });
      });
    }

    function closeRestoreDialog() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    if (closeBtn) closeBtn.addEventListener('click', closeRestoreDialog);
    if (cancelBtn) cancelBtn.addEventListener('click', closeRestoreDialog);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeRestoreDialog();
    });

    if (confirmBtn) {
      confirmBtn.addEventListener('click', function() {
        showLoading();
        var url;
        if (item.isDirectory) {
          url = '/recycle/dirs/' + item.id + '/restore';
          apiPost(url, { target_parent_id: selectedDirId }).then(function(r2) {
            hideLoading();
            closeRestoreDialog();
            if (r2.code === 0) {
              showToast('已恢复到 "' + (data.availableDirs.find(function(d) { return d.id === selectedDirId; }) || { name: '根目录' }).name + '"', '&#128260;');
              loadFiles(0);
              updateRecycleBadge();
            } else if (r2.code === 2) {
              showToast(r2.message || '目标位置存在同名目录', '&#9888;');
            } else {
              showToast(r2.message || '恢复失败', '&#9888;');
            }
          });
        } else {
          url = '/recycle/files/' + item.id + '/restore';
          apiPost(url, { target_dir_id: selectedDirId }).then(function(r2) {
            hideLoading();
            closeRestoreDialog();
            if (r2.code === 0) {
              var targetDir = data.availableDirs.find(function(d) { return d.id === selectedDirId; });
              showToast('已恢复到 "' + (targetDir ? (targetDir.path ? targetDir.path + '/' : '') + targetDir.name : '根目录') + '"', '&#128260;');
              loadFiles(0);
              updateRecycleBadge();
            } else if (r2.code === 2) {
              showToast(r2.message || '目标位置存在同名文件', '&#9888;');
            } else {
              showToast(r2.message || '恢复失败', '&#9888;');
            }
          });
        }
      });
    }

    renderRestoreTree();
  }

  // 更新回收站徽章数量
  function updateRecycleBadge() {
    apiGet('/recycle').then(function(res) {
      var badge = $('#recycle-badge');
      if (!badge) return;
      var total = res.data ? (res.data.total || 0) : 0;
      if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    });
  }

  // ==================== 分享功能 ====================

  // 打开分享管理页面（已改为嵌入主页，通过 setDirType('share') 调用）
  function showShareManage() {
    setDirType('share');
  }

  // 分享管理临时数据存储
  var _shareManageData = [];
  function _getShareManageData() { return _shareManageData; }
  function _setShareManageData(data) { _shareManageData = data; }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : '';
  }

  function copyToClipboard(text) {
    // 优先使用 Clipboard API（现代标准，跨域 HTTPS 环境也能正常工作）
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function() {
        showToast('已复制');
      }).catch(function() {
        // Clipboard API 失败时降级到 execCommand
        var ok = _execCommandCopy(text);
        if (ok) {
          showToast('已复制');
        } else {
          showToast('复制失败，请手动选中复制', '&#9888;');
        }
      });
    } else {
      // 没有 Clipboard API，降级到 execCommand
      var ok = _execCommandCopy(text);
      if (ok) {
        showToast('已复制');
      } else {
        showToast('复制失败，请手动选中复制', '&#9888;');
      }
    }
  }

  function _execCommandCopy(text) {
    try {
      var inp = document.createElement('textarea');
      inp.style.cssText = 'position:fixed;top:0;left:0;opacity:0;width:1px;height:1px;overflow:hidden;word-wrap:break-word';
      inp.value = text;
      inp.readOnly = true;
      document.body.appendChild(inp);
      inp.focus();
      inp.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(inp);
      return ok;
    } catch(e) {
      return false;
    }
  }

  function apiDelete(url) {
    return new Promise(function(resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('DELETE', CONFIG.baseApiUrl + url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      var sid = getCookie('fileservice.sid');
      if (sid) xhr.setRequestHeader('Cookie', 'fileservice.sid=' + sid);
      xhr.onload = function() {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch(e) {}
        resolve(json || { code: -1, message: '请求失败' });
      };
      xhr.onerror = function() { resolve({ code: -1, message: '网络错误' }); };
      xhr.send();
    });
  }

  // 加载分享管理内容到 page-panel
  var _sharePage = 1;
  var _sharePageSize = 12; // grid default
  function loadShareManage() {
    var container = $('#page-panel-body');
    if (!container) return;

    container.innerHTML = '<div id="share-manage-loading" style="text-align:center;padding:40px;color:var(--text-secondary,#7a8194)">加载中...</div>';

    var viewMode = localStorage.getItem('shareManageViewMode') || 'grid';
    var pageSize = viewMode === 'list' ? 20 : 12;
    _sharePageSize = pageSize;
    var offset = (_sharePage - 1) * pageSize;

    apiGet('/share?limit=' + pageSize + '&offset=' + offset).then(function(res) {
      if (res.code !== 0) {
        if (res.code === 401) {
          container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">请先 <a href="/login.html" style="color:var(--accent)">登录</a></div>';
        } else {
          container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--error)">加载失败: ' + (res.message || '') + '</div>';
        }
        return;
      }
      var data = res.data || {};
      renderShareManageList(data.shares || data || [], data.total || (data.shares ? data.shares.length : (Array.isArray(data) ? data.length : 0)));
    }).catch(function() {
      if (container) container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--error)">加载失败，请检查网络</div>';
    });
  }

  function renderShareManageList(shares, total) {
    _setShareManageData(shares);
    var container = $('#page-panel-body');
    if (!container) return;

    total = total || shares.length;

    var viewMode = localStorage.getItem('shareManageViewMode') || 'grid';
    var modeClass = 'sm-' + viewMode;

    var actionsEl = $('#page-panel-actions');
    if (actionsEl) {
      actionsEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px">' +
        '<div class="view-toggle" role="group" aria-label="视图切换" style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
        '<button class="view-btn' + (viewMode === 'grid' ? ' active' : '') + '" data-view="grid" onclick="window.__fm._toggleShareView(\'grid\')" title="网格视图" style="width:34px;height:34px;border:none;background:' + (viewMode === 'grid' ? 'linear-gradient(135deg,var(--accent),var(--accent2))' : 'transparent') + ';color:' + (viewMode === 'grid' ? '#fff' : 'var(--text-muted)') + ';cursor:pointer;font-size:14px">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>' +
        '<button class="view-btn' + (viewMode === 'list' ? ' active' : '') + '" data-view="list" onclick="window.__fm._toggleShareView(\'list\')" title="列表视图" style="width:34px;height:34px;border:none;background:' + (viewMode === 'list' ? 'linear-gradient(135deg,var(--accent),var(--accent2))' : 'transparent') + ';color:' + (viewMode === 'list' ? '#fff' : 'var(--text-muted)') + ';cursor:pointer;font-size:14px">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>' +
        '</div>' +
        '<button class="modal-btn modal-btn-danger" style="font-size:11px;padding:4px 12px" onclick="window.__fm._deleteExpiredShares()" title="删除所有已过期的分享">🗑 删除已过期</button>' +
        '</div>';
    }

    if (shares.length === 0) {
      container.innerHTML = '<div class="empty-state" style="margin-top:80px"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg><h3>暂无分享记录</h3><p>在文件列表中选中文件或文件夹，点击三点菜单中的"分享"按钮即可创建分享链接</p></div>';
      return;
    }

    var totalPages = Math.ceil(total / _sharePageSize);
    var paginationHtml = '';
    if (totalPages > 1) {
      paginationHtml = '<div class="sm-pagination" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:16px 0 8px;font-size:12px;color:var(--text-muted)">';
      paginationHtml += '<button class="btn btn-outline btn-xs" onclick="window.__fm._goSharePage(' + (_sharePage - 1) + ')" ' + (_sharePage <= 1 ? 'disabled' : '') + '>← 上一页</button>';
      paginationHtml += '<span>第 ' + _sharePage + '/' + totalPages + ' 页 (共 ' + total + ' 条)</span>';
      paginationHtml += '<button class="btn btn-outline btn-xs" onclick="window.__fm._goSharePage(' + (_sharePage + 1) + ')" ' + (_sharePage >= totalPages ? 'disabled' : '') + '>下一页 →</button>';
      paginationHtml += '</div>';
    }

    var activeShares = shares.filter(function(s) { return !s.is_expired && !s.invalid_reason; });
    var expiredShares = shares.filter(function(s) { return s.is_expired || s.invalid_reason; });

    var html = '<div class="sm-page">';

    if (activeShares.length > 0) {
      html += '<div class="sm-section">';
      html += '<div class="sm-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>有效分享 <span class="sm-count">' + activeShares.length + '</span></div>';
      if (viewMode === 'list') {
        html += _buildShareTable(activeShares.concat(expiredShares), 'active');
      } else {
        html += '<div class="sm-cards sm-grid">';
        activeShares.forEach(function(s) { html += _buildShareCard(s, false, 'grid'); });
        html += '</div>';
      }
      html += '</div>';
    }

    if (expiredShares.length > 0) {
      html += '<div class="sm-section sm-section-gray">';
      html += '<div class="sm-section-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>已失效 <span class="sm-count">' + expiredShares.length + '</span></div>';
      if (viewMode === 'list') {
        if (activeShares.length === 0) html += _buildShareTable(expiredShares, 'expired');
      } else {
        html += '<div class="sm-cards sm-grid">';
        expiredShares.forEach(function(s) { html += _buildShareCard(s, true, 'grid'); });
        html += '</div>';
      }
      html += '</div>';
    }

    html += paginationHtml + '</div>';
    container.innerHTML = html;
  }

  function _buildShareTable(shares, section) {
    return '<div class="file-table-wrap"><table class="file-table sm-file-table"><colgroup>' +
      '<col class="col-icon-sm"><col class="col-name"><col class="col-share-info"><col class="col-share-dl"><col class="col-share-view"><col class="col-status-sm"><col class="col-menu">' +
      '</colgroup><thead><tr>' +
      '<th class="th-icon">类型</th><th>分享名称 / 路径</th><th>期限</th><th>下载</th><th>查看</th><th>状态</th><th class="th-menu">操作</th>' +
      '</tr></thead><tbody>' +
      shares.map(function(s) { return _buildShareRow(s, s.is_expired || s.invalid_reason); }).join('') +
      '</tbody></table></div>';
  }

  function _buildShareRow(s, expired) {
    var isDir = s.target_type === 'dir' || (s.target_type === 'public' && s.is_directory);
    var typeIcon = isDir
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ffc107" stroke="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#90a4ae" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var isDisabled = s.disabled;
    var statusLabel = isDisabled ? '已禁用' : (expired ? '已过期' : '有效');
    var statusColor = isDisabled ? 'var(--warning)' : (expired ? 'var(--error)' : 'var(--success)');
    var scopeLabel = s.target_scope === 'public' ? '🌐 公共' : '👤 个人';
    var infoText = (s.remaining_text || '永久');
    var dlCount = s.download_count || 0;
    var maxDl = s.max_downloads || 0;
    var dlDisplay = maxDl > 0 ? dlCount + '/' + maxDl : dlCount;
    var viewCount = s.view_count || 0;
    var btnHtml = '';
    if (!expired) {
      btnHtml += '<button class="sm-btn sm-btn-view" style="padding:3px 7px;font-size:11px" onclick="window.__fm.viewShare(' + s.id + ')" title="查看">👁</button> ';
      btnHtml += '<button class="sm-btn sm-btn-toggle" style="padding:3px 7px;font-size:11px;color:' + (isDisabled ? 'var(--success)' : 'var(--warning)') + '" onclick="window.__fm._toggleShareDisabled(' + s.id + ')" title="' + (isDisabled ? '启用' : '禁用') + '">' + (isDisabled ? '▶' : '⏸') + '</button> ';
    }
    btnHtml += '<button class="sm-btn sm-btn-del" style="padding:3px 7px;font-size:11px" onclick="window.__fm.deleteShareRecord(' + s.id + ')" title="删除">🗑</button>';
    return '<tr class="fm-row' + ((expired || isDisabled) ? '" style="opacity:' + (expired ? '0.5' : '0.55') : '') + '">' +
      '<td class="td-icon">' + typeIcon + '</td>' +
      '<td class="td-name"><div style="font-weight:600">' + escapeHtml(s.target_name) + '</div><div style="font-size:10px;color:var(--text-muted);margin-top:1px">' + scopeLabel + ' · ' + escapeHtml(s.display_path || s.target_name) + '</div></td>' +
      '<td class="td-share-info" style="font-size:12px;color:var(--text-muted);white-space:nowrap">' + infoText + '</td>' +
      '<td class="td-share-dl" style="font-size:12px;font-weight:500;white-space:nowrap">' + dlDisplay + '</td>' +
      '<td class="td-share-view" style="font-size:12px;color:var(--text-muted);white-space:nowrap">' + viewCount + '</td>' +
      '<td class="td-status-sm" style="font-size:12px;color:' + statusColor + ';font-weight:600;white-space:nowrap">' + statusLabel + '</td>' +
      '<td class="td-menu" style="white-space:nowrap">' + btnHtml + '</td>' +
    '</tr>';
  }

  function _buildShareCard(s, expired, viewMode) {
    viewMode = viewMode || 'grid';
    var isDir = s.target_type === 'dir' || (s.target_type === 'public' && s.is_directory);
    var typeIcon = isDir
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#ffc107" stroke="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#90a4ae" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

    var isDisabled = s.disabled;
    var statusLabel = isDisabled ? '已禁用' : (expired ? '已过期' : '有效');
    var statusColor = isDisabled ? 'var(--warning)' : (expired ? 'var(--error)' : 'var(--success)');
    var scopeLabel = s.target_scope === 'public' ? '🌐 公共目录' : '👤 个人目录';
    var scopeColor = s.target_scope === 'public' ? 'var(--accent)' : 'var(--accent2)';

    var html = '<div class="sm-card' + ((expired || isDisabled) ? (expired ? ' sm-card-expired' : '" style="opacity:0.55') : '') + '">';
    html += '<div class="sm-card-header">';
    html += '<div class="sm-card-title">';
    html += '<span class="sm-card-icon">' + typeIcon + '</span>';
    html += '<span class="sm-card-name" title="' + escapeHtml(s.target_name) + '">' + escapeHtml(s.target_name) + '</span>';
    html += '</div>';
    html += '<div class="sm-card-status" style="color:' + statusColor + ';font-size:12px;font-weight:500">' + statusLabel + '</div>';
    html += '</div>';
    // List-only columns: info + status
    html += '<span class="sm-list-info">' + (s.remaining_text || '永久') + '</span>';
    html += '<span class="sm-list-status" style="color:' + statusColor + '">' + statusLabel + '</span>';
    // 完整路径
    html += '<div style="font-size:11px;margin-bottom:4px;padding:0 16px">';
    html += '<span style="color:' + scopeColor + ';font-size:10px;font-weight:600;margin-right:6px">' + scopeLabel + '</span>';
    html += '<span style="font-family:monospace;color:var(--text-muted);word-break:break-all">📂 ' + escapeHtml(s.display_path || s.target_name) + '</span>';
    html += '</div>';
    html += '<div class="sm-card-meta">';
    html += '<span class="sm-badge ' + (isDir ? 'badge-dir' : 'badge-file') + '">' + (isDir ? '文件夹' : '文件') + '</span>';
    html += '<span style="font-size:12px;color:var(--text-muted)">' + s.item_count + '项</span>';
    if (s.has_password_bool) {
      html += '<span style="font-size:12px;color:#ff9800;display:flex;align-items:center;gap:3px">';
      html += '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      html += '<span style="font-family:monospace;font-weight:600;letter-spacing:2px">' + escapeHtml(s.extraction_code) + '</span>';
      html += '</span>';
    }
    html += '</div>';
    html += '<div class="sm-card-expire" style="font-size:12px;color:' + (expired ? 'var(--error)' : 'var(--text-muted)') + '">';
    html += '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    html += s.remaining_text || '永久';
    html += '<span style="margin-left:10px;font-size:11px;color:var(--text-muted);opacity:0.6">' + formatDateTime(s.created_at) + '</span>';
    var dlCount = s.download_count || 0;
    var maxDl = s.max_downloads || 0;
    var viewCount = s.view_count || 0;
    // 下载次数
    var dlColor = maxDl > 0 && dlCount >= maxDl ? 'var(--error)' : maxDl > 0 && dlCount >= maxDl * 0.8 ? 'var(--warning)' : 'var(--text-muted)';
    html += '<span style="margin-left:10px;font-size:11px;color:' + dlColor + '">&#128229; ' + (maxDl > 0 ? dlCount + '/' + maxDl : dlCount) + '</span>';
    // 查看次数
    html += '<span style="margin-left:10px;font-size:11px;color:var(--text-muted)">&#128065; ' + viewCount + '</span>';
    html += '</div>';
    if (!expired) {
      html += '<div class="sm-card-url">';
      var cardUrl = window.location.origin + '/share/' + s.hash;
      var cardOwner = s.owner ? '分享人: ' + s.owner + '\n' : '';
      var cardCopyText = s.extraction_code
        ? cardOwner + '分享链接: ' + cardUrl + '\n提取码: ' + s.extraction_code + '\n有效期: ' + (s.expires_at ? formatDateTime(s.expires_at) : '永久') + '\n来自 FMS 文件管理系统'
        : cardOwner + '分享链接: ' + cardUrl + '\n有效期: ' + (s.expires_at ? formatDateTime(s.expires_at) : '永久') + '\n来自 FMS 文件管理系统';
      html += '<input type="text" value="' + escapeHtml(cardUrl) + '" readonly class="sm-url-input" data-copy-text="' + escapeHtml(cardCopyText) + '">';
      html += '<button class="sm-url-copy" onclick="window.__fm.copyShareUrl(' + s.id + ')" title="复制链接">';
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      html += '</button>';
      html += '</div>';
    }
    // Grid mode: full action bar
    html += '<div class="sm-card-actions">';
    if (!expired) {
      html += '<button class="sm-btn sm-btn-view" onclick="window.__fm.viewShare(' + s.id + ')" title="在新窗口打开">';
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>查看</button>';
      html += '<button class="sm-btn sm-btn-qr" onclick="window.__fm.showShareQr(' + s.id + ')" title="二维码">';
      html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>二维码</button>';
      html += '<button class="sm-btn sm-btn-share" onclick="window.__fm.shareText(' + s.id + ')" title="复制分享信息">📋 分享</button>';
      html += '<button class="sm-btn sm-btn-toggle" style="color:' + (isDisabled ? 'var(--success)' : 'var(--warning)') + '" onclick="window.__fm._toggleShareDisabled(' + s.id + ')" title="' + (isDisabled ? '启用' : '禁用') + '">' + (isDisabled ? '▶ 启用' : '⏸ 禁用') + '</button>';
    }
    html += '<button class="sm-btn sm-btn-del" onclick="window.__fm.deleteShareRecord(' + s.id + ')" title="删除">';
    html += '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>删除</button>';
    html += '</div>';
    // List mode: compact action buttons (hidden by default, shown in list mode via CSS)
    html += '<div class="sm-card-actions-list" style="display:none">';
    if (!expired) {
      html += '<button class="sm-btn sm-btn-qr" style="padding:3px 8px;font-size:10px" onclick="window.__fm.showShareQr(' + s.id + ')">二维码</button>';
      html += '<button class="sm-btn sm-btn-share" style="padding:3px 8px;font-size:10px" onclick="window.__fm.shareText(' + s.id + ')">分享</button>';
      html += '<button class="sm-btn sm-btn-view" style="padding:3px 8px;font-size:10px" onclick="window.__fm.viewShare(' + s.id + ')">查看</button>';
      html += '<button class="sm-btn sm-btn-toggle" style="padding:3px 8px;font-size:10px;color:' + (isDisabled ? 'var(--success)' : 'var(--warning)') + '" onclick="window.__fm._toggleShareDisabled(' + s.id + ')">' + (isDisabled ? '启用' : '禁用') + '</button>';
    }
    html += '<button class="sm-btn sm-btn-del" style="padding:3px 8px;font-size:10px" onclick="window.__fm.deleteShareRecord(' + s.id + ')">删除</button>';
    html += '</div>';
    if (expired) {
      html += '<div class="sm-card-expired-tip" style="font-size:12px;color:var(--error);opacity:0.7;text-align:center;padding:6px 0">该分享已失效，无法访问</div>';
    }
    html += '</div>';
    return html;
  }

  // 复制分享URL（仅链接地址）
  var copyShareUrlFn = function(id) {
    var shares = _getShareManageData() || [];
    var share = shares.find(function(s) { return s.id === id; });
    if (!share && window.__shareManageState && window.__shareManageState.shares) {
      share = window.__shareManageState.shares.find(function(s) { return s.id === id; });
    }
    if (!share) { showToast('分享数据加载中，请稍后重试', '&#9888;'); return; }
    var cleanUrl = window.location.origin + '/share/' + share.hash;
    if (!cleanUrl || !share.hash) { showToast('复制失败', '&#9888;'); return; }
    copyToClipboard(cleanUrl);
  }

  // 复制分享信息（完整分享文案）
  var shareTextFn = function(id) {
    var shares = _getShareManageData() || [];
    var share = shares.find(function(s) { return s.id === id; });
    if (!share && window.__shareManageState && window.__shareManageState.shares) {
      share = window.__shareManageState.shares.find(function(s) { return s.id === id; });
    }
    if (!share) { showToast('分享数据加载中，请稍后重试', '&#9888;'); return; }
    var code = share.extraction_code || '';
    var ownerText = share.owner ? '分享人: ' + share.owner : '';
    var cleanUrl = window.location.origin + '/share/' + share.hash;
    if (!cleanUrl || !share.hash) { showToast('复制失败', '&#9888;'); return; }
    var expiresText = share.expires_at ? formatDateTime(share.expires_at) : '永久';
    var copyText = code
      ? (ownerText ? ownerText + '\n' : '') + '分享链接: ' + cleanUrl + '\n提取码: ' + code + '\n有效期: ' + expiresText + '\n来自 FMS 文件管理系统'
      : (ownerText ? ownerText + '\n' : '') + '分享链接: ' + cleanUrl + '\n有效期: ' + expiresText + '\n来自 FMS 文件管理系统';
    copyToClipboard(copyText);
  }

  // 查看分享
  var viewShareFn = function(id) {
    var shares = _getShareManageData() || [];
    var share = shares.find(function(s) { return s.id === id; });
    if (!share && window.__shareManageState && window.__shareManageState.shares) {
      share = window.__shareManageState.shares.find(function(s) { return s.id === id; });
    }
    if (!share) return;
    var code = share.extraction_code || '';
    window.open('/share/' + share.hash + (code ? '?extraction_code=' + code : ''), '_blank');
  }

  // 显示分享二维码
  var _lastShareQrId = null;
  var _lastShareData = null;
  var showShareQrFn = function(id) {
    _lastShareQrId = id;
    // 优先用内部数据，其次用分享管理页面的全局 state
    var share = (_getShareManageData() || []).find(function(s) { return s.id === id; });
    if (!share && window.__shareManageState && window.__shareManageState.shares) {
      share = window.__shareManageState.shares.find(function(s) { return s.id === id; });
    }
    if (!share) return;
    _lastShareData = share;
    var code = share.extraction_code || '';
    var url = window.location.origin + '/share/' + share.hash;
    var qrUrl = code ? url + '?extraction_code=' + code : url;

    var overlay = el('div', 'modal-overlay');
    overlay.innerHTML = '<div class="modal-card" style="max-width:380px;text-align:center">'
      + '<h3 style="margin:0 0 20px;font-size:16px;color:var(--text-primary)">' + escapeHtml(share.target_name) + ' - 二维码</h3>'
      + '<div id="qrLoadingWrap" style="display:flex;align-items:center;justify-content:center;min-height:200px"><div class="share-spinner"></div></div>'
      + '<img id="qrImg" style="display:none;max-width:200px;border-radius:12px;border:1px solid var(--border-accent);margin:0 auto 16px" alt="QR">'
      + (code ? '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px">提取码 <span style="font-size:18px;font-weight:700;color:var(--accent);letter-spacing:4px">' + escapeHtml(code) + '</span></div>' : '')
      + '<div style="margin-bottom:8px">'
      + '<input type="text" value="' + escapeHtml(url) + '" readonly class="modal-text-input" id="qrModalUrlInput" style="font-family:monospace;font-size:12px;width:100%;box-sizing:border-box">'
      + '</div>'
      + '<div style="display:flex;gap:8px">'
      + '<button onclick="window.__fm._copyQrUrl(this)" class="modal-btn modal-btn-primary" style="flex:1;white-space:nowrap">复制URL</button>'
      + '<button onclick="window.__fm._shareQrText()" class="modal-btn modal-btn-secondary" style="white-space:nowrap">分享</button>'
      + '<button onclick="this.closest(\'.modal-overlay\').remove()" class="modal-btn modal-btn-secondary" style="white-space:nowrap">关闭</button>'
      + '</div>'
      + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    var theme = document.documentElement.getAttribute('data-theme') || 'dark';
    axios.get('/api/share/qr', { params: { url: qrUrl, size: 240, theme: theme } }).then(function(res) {
      if (res.data.code === 0 && res.data.data) {
        var img = document.getElementById('qrImg');
        var loading = document.getElementById('qrLoadingWrap');
        if (img) { img.src = res.data.data; img.style.display = 'block'; }
        if (loading) loading.style.display = 'none';
      }
    }).catch(function() {});
  }

  var _copyQrUrlFn = function(btn) {
    var url = btn.closest('.modal-card').querySelector('input').value;
    if (!url) return;
    copyToClipboard(url);
  }

  var _shareQrTextFn = function() {
    var share = _lastShareData;
    if (!share) return;
    var code = share.extraction_code || '';
    var owner = share.owner ? '分享人: ' + share.owner + '\n' : '';
    var modal = document.querySelector('.modal-overlay');
    var url = modal ? modal.querySelector('input').value : '';
    if (!url) return;
    var copyText = code
      ? owner + '分享链接: ' + url + '\n提取码: ' + code + '\n有效期: ' + (share.expires_at ? formatDateTime(share.expires_at) : '永久') + '\n来自 FMS 文件管理系统'
      : owner + '分享链接: ' + url + '\n有效期: ' + (share.expires_at ? formatDateTime(share.expires_at) : '永久') + '\n来自 FMS 文件管理系统';
    copyToClipboard(copyText);
  }

  // 删除分享记录
  var deleteShareRecordFn = function(id) {
    var share = (_getShareManageData() || []).find(function(s) { return s.id === id; });
    if (!share) return;
    if (!confirm('确定要删除 "' + share.target_name + '" 的分享链接吗？')) return;
    apiDelete('/share/' + id).then(function(res) {
      if (res.code !== 0) { showToast(res.message || '删除失败', '&#9888;'); return; }
      showToast('分享已删除');
      loadShareManage();
    }).catch(function() { showToast('删除失败', '&#9888;'); });
  }

  // 为选中的文件/目录创建分享（支持批量）
  function createShareForSelected() {
    if (state.selectedFiles.length === 0) {
      showToast('请先选择要分享的文件或文件夹', '&#9888;');
      return;
    }
    // 公共目录模式：使用 public 类型分享
    if (state.dirType === 'public') {
      var pubItems = state.selectedFiles.map(function(id) {
        var item = state.fileData.find(function(f) { return f.id === id; });
        return item ? { id: item.id, name: item.name, isDirectory: item.isDirectory || item.isPublicDir, relPath: item.relPath } : null;
      }).filter(Boolean);
      if (pubItems.length === 0) return;
      doCreateShare._items = pubItems;
      showShareModal(pubItems[0], 'public', pubItems[0].name);
      return;
    }
    // 只有一个时用单选模式，否则批量
    if (state.selectedFiles.length === 1) {
      var item = state.fileData.find(function(f) { return f.id === state.selectedFiles[0]; });
      if (!item) return;
      doCreateShare._items = null;
      showShareModal(item);
    } else {
      // 批量分享：收集所有选中项
      var items = state.selectedFiles.map(function(id) {
        return state.fileData.find(function(f) { return f.id === id; });
      }).filter(function(i) { return !!i; });
      if (items.length === 0) return;
      doCreateShare._items = items;
      // 复用单选的弹窗，只改标题
      showShareModal({ id: items[0].id, isDirectory: items[0].isDirectory, name: items.length + ' 个文件' }, 'mixed', items.length + ' 个文件');
    }
  }

  // 三点菜单单个分享
  function doSingleShare(item) {
    doCreateShare._items = null;
    showShareModal(item);
  }

  // 分享设置弹窗
  function showShareModal(item, overrideType, overrideName) {
    // 公共文件使用 'public' 类型，普通用户最多1天有效期
    var isPublicShare = item.isPublicFile || item.isPublicDir;
    var maxDays = isPublicShare && !state.isAdmin ? 1 : 0; // 0 = 无限制

    if (isPublicShare) {
      overrideType = 'public';
    }

    var isDir = item.isDirectory;
    var itemName = overrideName || item.name;
    var itemType = overrideType || (isDir ? 'dir' : 'file');
    var isMixed = overrideType === 'mixed';

    // 创建弹窗
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'shareModal';

    // 普通用户分享公共文件：仅1天选项
    var expireOptionsHtml;
    if (maxDays === 1) {
      expireOptionsHtml = '\
        <div style="margin-bottom:16px">\
          <label style="display:block;margin-bottom:8px;font-size:13px;color:var(--text-secondary)">有效期（普通用户公共分享限制1天）</label>\
          <div style="display:flex;gap:8px">\
            <label class="expire-option active" style="cursor:default">\
              <input type="radio" name="expire_type" value="1" checked>\
              <span class="expire-option-label">1天</span>\
            </label>\
          </div>\
        </div>';
    } else {
      expireOptionsHtml = '\
        <div style="margin-bottom:16px">\
          <label style="display:block;margin-bottom:8px;font-size:13px;color:var(--text-secondary)">有效期</label>\
          <div style="display:flex;gap:8px">\
            <label class="expire-option active" onclick="var opts=this.closest(\'.modal-card\').querySelectorAll(\'.expire-option\');for(var i=0;i<opts.length;i++)opts[i].classList.remove(\'active\');this.classList.add(\'active\');this.closest(\'.modal-card\').querySelector(\'#customDays\').style.display=\'none\'">\
              <input type="radio" name="expire_type" value="7" checked>\
              <span class="expire-option-label">7天</span>\
            </label>\
            <label class="expire-option" onclick="var opts=this.closest(\'.modal-card\').querySelectorAll(\'.expire-option\');for(var i=0;i<opts.length;i++)opts[i].classList.remove(\'active\');this.classList.add(\'active\');this.closest(\'.modal-card\').querySelector(\'#customDays\').style.display=\'none\'">\
              <input type="radio" name="expire_type" value="30">\
              <span class="expire-option-label">30天</span>\
            </label>\
            <label class="expire-option" onclick="var opts=this.closest(\'.modal-card\').querySelectorAll(\'.expire-option\');for(var i=0;i<opts.length;i++)opts[i].classList.remove(\'active\');this.classList.add(\'active\');this.closest(\'.modal-card\').querySelector(\'#customDays\').style.display=\'flex\'">\
              <input type="radio" name="expire_type" value="custom">\
              <span class="expire-option-label">自定义</span>\
            </label>\
            <label class="expire-option" onclick="var opts=this.closest(\'.modal-card\').querySelectorAll(\'.expire-option\');for(var i=0;i<opts.length;i++)opts[i].classList.remove(\'active\');this.classList.add(\'active\');this.closest(\'.modal-card\').querySelector(\'#customDays\').style.display=\'none\'">\
              <input type="radio" name="expire_type" value="0">\
              <span class="expire-option-label">永久</span>\
            </label>\
          </div>\
          <input type="number" id="customDays" class="modal-text-input" placeholder="输入天数" min="1" max="3650" style="display:none;margin-top:8px">\
        </div>';
    }

    // 下载次数限制选项
    var downloadLimitHtml;
    if (!state.isAdmin) {
      downloadLimitHtml = '\
        <div style="margin-bottom:16px">\
          <label style="display:block;margin-bottom:8px;font-size:13px;color:var(--text-secondary)">最大下载次数（最多30次）</label>\
          <input type="number" id="maxDownloads" class="modal-text-input" value="10" min="1" max="30" style="width:100%">\
        </div>';
    } else {
      downloadLimitHtml = '\
        <div style="margin-bottom:16px">\
          <label style="display:block;margin-bottom:8px;font-size:13px;color:var(--text-secondary)">最大下载次数（0=不限制，管理员不限）</label>\
          <input type="number" id="maxDownloads" class="modal-text-input" value="0" min="0" style="width:100%">\
        </div>';
    }

    overlay.innerHTML = '\
      <div class="modal-card" style="max-width:420px">\
        <h3 style="margin:0 0 8px;font-size:16px;color:var(--text-primary)">创建分享链接</h3>\
        <p id="shareModalItem" style="margin:0 0 20px;font-size:13px;color:var(--text-secondary)">' + escapeHtml(itemName) + '</p>\
        ' + expireOptionsHtml + '\
        ' + downloadLimitHtml + '\
        <div style="margin-bottom:20px">\
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">\
            <input type="checkbox" id="needPassword" style="accent-color:var(--accent);width:16px;height:16px">\
            <span style="font-size:13px;color:var(--text-secondary)">设置提取码（4位随机字母数字）</span>\
          </label>\
        </div>\
        <div id="shareModalError" style="color:var(--error);font-size:13px;margin-bottom:12px;display:none"></div>\
        <div style="display:flex;gap:12px;justify-content:flex-end">\
          <button id="shareModalCancel" class="modal-btn modal-btn-secondary">取消</button>\
          <button id="shareModalConfirm" class="modal-btn modal-btn-primary">创建分享</button>\
        </div>\
      </div>\
    ';

    document.body.appendChild(overlay);

    // 事件绑定
    document.getElementById('shareModalCancel').onclick = function() { closeShareModal(); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeShareModal(); });
    document.getElementById('shareModalConfirm').onclick = function() { doCreateShare(item, itemType, itemName); };
  }

  function closeShareModal() {
    var modal = document.getElementById('shareModal');
    if (modal) modal.remove();
  }

  function doCreateShare(item, itemType, itemName) {
    var expireType = document.querySelector('input[name="expire_type"]:checked').value;
    var expireDays = 7;
    if (expireType === 'custom') {
      expireDays = parseInt(document.getElementById('customDays').value, 10) || 7;
    } else if (expireType === '0') {
      expireDays = 0; // 永久
    } else {
      expireDays = parseInt(expireType, 10) || 7;
    }
    var needPassword = document.getElementById('needPassword').checked;
    var maxDownloads = parseInt(document.getElementById('maxDownloads').value, 10) || 0;

    var errorEl = document.getElementById('shareModalError');
    errorEl.style.display = 'none';

    if (expireType === 'custom' && (isNaN(expireDays) || expireDays < 1)) {
      errorEl.textContent = '请输入有效的天数（1-3650）';
      errorEl.style.display = 'block';
      return;
    }

    var btn = document.getElementById('shareModalConfirm');
    btn.textContent = '创建中...';
    btn.disabled = true;

    // 批量分享支持：收集所有选中项
    var shareItems = doCreateShare._items || [{ id: item.id, type: itemType, name: itemName }];
    var body = {};

    // 公共目录分享
    if (itemType === 'public') {
      body = {
        target_type: 'public',
        target_path: item.relPath || item.id,
        expires_days: expireDays,
        password: needPassword,
        max_downloads: maxDownloads
      };
    } else if (shareItems.length > 1) {
      body = {
        target_type: 'mixed',
        target_ids: shareItems.map(function(i) { return i.id; }),
        expires_days: expireDays,
        password: needPassword,
        max_downloads: maxDownloads
      };
    } else {
      body = {
        target_type: itemType,
        target_id: item.id,
        expires_days: expireDays,
        password: needPassword,
        max_downloads: maxDownloads
      };
    }

    axios.post('/api/share', body).then(function(res) {
      if (res.data.code !== 0) {
        errorEl.textContent = res.data.message || '创建失败';
        errorEl.style.display = 'block';
        btn.textContent = '创建分享';
        btn.disabled = false;
        return;
      }
      closeShareModal();
      var data = res.data.data;
      var shareUrl = data.url;
      var extractionCode = data.extraction_code;
      showShareResultModal(itemName, shareUrl, extractionCode, data.expires_at, data.owner);
      deselectAllFiles();
    }).catch(function() {
      errorEl.textContent = '网络错误，请重试';
      errorEl.style.display = 'block';
      btn.textContent = '创建分享';
      btn.disabled = false;
    });
  }

  // 显示分享结果（带二维码）
  function showShareResultModal(itemName, shareUrl, extractionCode, expiresAt, owner) {
    var fullUrl = window.location.origin + shareUrl;
    // 去掉 URL 中的 extraction_code 参数，仅作展示用
    var cleanUrl = fullUrl.replace(/\?extraction_code=[^&]*/, '').replace(/\?extraction_code=$/, '');
    var ownerText = owner ? '分享人: ' + owner + '\n' : '';
    var qrUrl = extractionCode ? cleanUrl + '?extraction_code=' + extractionCode : cleanUrl;

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'shareResultModal';
    var codeBlock = extractionCode
      ? '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">提取码</div><div style="font-size:24px;font-weight:700;color:var(--accent);letter-spacing:6px;margin-bottom:8px">' + escapeHtml(extractionCode) + '</div>'
      : '';
    var ownerBlock = owner
      ? '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:2px">分享人</div><div style="font-size:13px;color:var(--text-primary);margin-bottom:8px">' + escapeHtml(owner) + '</div>'
      : '';
    // 4 按钮紧凑样式，匹配分享列表卡片操作栏
    var btnStyle = 'flex:1;white-space:nowrap;padding:8px 12px;font-size:12px;font-weight:500';
    overlay.innerHTML = '\
      <div class="modal-card" style="max-width:520px;text-align:center">\
        <div style="color:var(--success);margin-bottom:12px">\
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>\
        </div>\
        <h3 style="margin:0 0 4px;font-size:18px;color:var(--text-primary)">分享链接已创建</h3>\
        <p style="margin:0 0 20px;font-size:13px;color:var(--text-secondary)">' + escapeHtml(itemName) + '</p>\
        <div id="shareResultInfoBox" style="background:var(--bg-card-hover);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;text-align:left">\
          ' + ownerBlock + '\
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px">分享链接</div>\
          <div style="font-size:13px;color:var(--accent);word-break:break-all;margin-bottom:8px;font-family:monospace">' + escapeHtml(cleanUrl) + '</div>\
          ' + codeBlock + '\
          <div style="font-size:11px;color:var(--text-secondary)">有效期: ' + (expiresAt ? formatDateTime(expiresAt) : '永久') + '</div>\
        </div>\
        <div id="shareResultQrBox" style="display:none;margin-bottom:16px">\
          <div id="shareResultQrLoading" style="min-height:200px;display:flex;align-items:center;justify-content:center"><div class="share-spinner"></div></div>\
          <img id="shareResultQrImg" style="display:none;max-width:200px;border-radius:12px;border:1px solid var(--border-accent);margin:0 auto 12px" alt="QR">\
          <div style="font-size:13px;color:var(--accent);word-break:break-all;font-family:monospace;margin-bottom:4px">' + escapeHtml(cleanUrl) + '</div>\
          ' + (extractionCode ? '<div style="font-size:18px;font-weight:700;color:var(--accent);letter-spacing:4px">' + escapeHtml(extractionCode) + '</div>' : '') + '\
        </div>\
        <div style="display:flex;gap:8px;justify-content:center">\
          <button id="copyShareUrlBtn" class="modal-btn modal-btn-primary" style="' + btnStyle + '">📋 复制链接</button>\
          <button id="shareFullInfoBtn" class="modal-btn modal-btn-primary" style="' + btnStyle + '">📤 分享</button>\
          <button id="shareQrBtn" class="modal-btn modal-btn-secondary" style="' + btnStyle + '">📱 二维码</button>\
          <button id="viewShareBtn" class="modal-btn modal-btn-secondary" style="' + btnStyle + '">查看</button>\
        </div>\
      </div>\
    ';
    document.body.appendChild(overlay);

    document.getElementById('copyShareUrlBtn').onclick = function() {
      copyToClipboard(cleanUrl);
      var btn = document.getElementById('copyShareUrlBtn');
      btn.textContent = '✅ 已复制';
      setTimeout(function() { btn.textContent = '📋 复制链接'; }, 1500);
    };
    document.getElementById('shareFullInfoBtn').onclick = function() {
      var copyText = extractionCode
        ? ownerText + '分享链接: ' + cleanUrl + '\n提取码: ' + extractionCode + '\n有效期: ' + (expiresAt ? formatDateTime(expiresAt) : '永久') + '\n来自 FMS 文件管理系统'
        : ownerText + '分享链接: ' + cleanUrl + '\n有效期: ' + (expiresAt ? formatDateTime(expiresAt) : '永久') + '\n来自 FMS 文件管理系统';
      copyToClipboard(copyText);
      var btn = document.getElementById('shareFullInfoBtn');
      btn.textContent = '✅ 已复制';
      setTimeout(function() { btn.textContent = '📤 分享'; }, 1500);
    };
    document.getElementById('shareQrBtn').onclick = function() {
      var infoBox = document.getElementById('shareResultInfoBox');
      var qrBox = document.getElementById('shareResultQrBox');
      var qrImg = document.getElementById('shareResultQrImg');
      var qrLoading = document.getElementById('shareResultQrLoading');
      // 切换显示
      if (qrBox.style.display !== 'none') {
        qrBox.style.display = 'none';
        infoBox.style.display = '';
        return;
      }
      infoBox.style.display = 'none';
      qrBox.style.display = '';
      if (!qrImg.src) {
        var theme = document.documentElement.getAttribute('data-theme') || 'dark';
        axios.get('/api/share/qr', { params: { url: qrUrl, size: 240, theme: theme } }).then(function(res) {
          if (res.data.code === 0 && res.data.data) {
            qrImg.src = res.data.data;
            qrImg.style.display = 'block';
            if (qrLoading) qrLoading.style.display = 'none';
          }
        }).catch(function() {
          if (qrLoading) qrLoading.innerHTML = '<span style="color:var(--text-muted);font-size:13px">二维码加载失败</span>';
        });
      }
    };
    document.getElementById('viewShareBtn').onclick = function() {
      overlay.remove();
      window.open(cleanUrl, '_blank');
    };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDateTime(isoString) {
    if (!isoString) return '永久';
    var d = new Date(isoString);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }

  // ==================== 回收站功能 ====================

  // 清空回收站
  function emptyRecycleBin() {
    var count = state.fileData.length;
    if (count === 0) {
      showToast('回收站已是空的', '&#9888;');
      return;
    }
    if (!confirm('确定清空整个回收站？\n\n将永久删除 ' + count + ' 个文件/目录，此操作不可恢复！')) return;
    showLoading();
    var apiPath = state.dirType === 'public-recycle' ? '/public-recycle' : '/recycle';
    apiDelete(apiPath).then(function(res) {
      hideLoading();
      if (res.code === 0) {
        showToast('回收站已清空', '&#128465;');
        loadFiles(0);
        updateRecycleBadge();
        loadProfile();
      } else {
        showToast(res.message || '清空失败', '&#9888;');
      }
    });
  }

  function deleteItem(item) {
    if (item.isRecycleItem) {
      // 回收站中删除 = 永久删除
      if (!confirm('确定永久删除 "' + item.name + '"？' + (item.isDirectory ? '（包含所有子项）' : '') + '\n\n此操作不可恢复！')) return;
      var apiPath;
      if (item.isPublicRecycleItem) {
        apiPath = item.isDirectory
          ? '/public-recycle/dirs/' + item.id
          : '/public-recycle/files/' + item.id;
      } else {
        apiPath = item.isDirectory
          ? '/recycle/dirs/' + item.id
          : '/recycle/files/' + item.id;
      }
      apiDelete(apiPath).then(function (res) {
        hideLoading();
        if (res.code === 0) {
          showToast('已永久删除', '&#128465;');
          loadFiles(0);
        } else {
          showToast(res.message || '删除失败', '&#9888;');
        }
      });
      return;
    }
    var confirmMsg = '确定删除 "' + item.name + '"？' + (item.isDirectory ? '（包含所有子项）' : '') + '\n\n删除后可在回收站恢复。';
    if (!confirm(confirmMsg)) return;
    showLoading();
    var promise;
    if (item.isPublicFile) {
      // 公共文件：relPath 现在是完整相对路径（含父目录）
      promise = apiDelete('/public-files?path=' + encodeURIComponent(item.relPath));
    } else if (item.isPublicDir) {
      promise = apiDelete('/public-dirs?path=' + encodeURIComponent(item.relPath));
    } else if (item.isDirectory) {
      promise = apiDelete('/dirs/' + item.id);
    } else {
      promise = apiDelete('/files/' + item.id);
    }
    promise.then(function (res) {
      hideLoading();
      if (res.code === 0) {
        var msg = '已删除';
        if (res.data && res.data.warnings) {
          msg += '\n' + res.data.warnings.message;
          // 延迟弹窗让toast先显示
          setTimeout(function() {
            alert('⚠️ 关联链接已失效\n\n' + res.data.warnings.message);
          }, 500);
        }
        showToast(msg, '&#128465;');
        loadFiles(state.currentDirId);
        loadProfile();
      } else {
        showToast(res.message || '删除失败', '&#9888;');
      }
    }).catch(function () {
      hideLoading();
      showToast('删除失败', '&#9888;');
    });
  }

  // ---------- Item Context Menu (Three dots) ----------
  var _activeMenu = null;

  function closeItemMenu() {
    var menu = $('#item-context-menu');
    if (menu) { menu.remove(); menu = null; }
    _activeMenu = null;
    document.removeEventListener('click', closeItemMenu);
  }

  function showItemMenu(e, item, anchorEl) {
    e.preventDefault();
    e.stopPropagation();
    closeItemMenu();

    var isAdmin = state.isAdmin;
    var canRename = false;
    var canDelete = false;

    var isOwner = !state.user ? false
      : (state.dirType === 'personal' ? true
      : (item.user_id === state.user.id));

    if (item.isPublicFile || item.isPublicDir) {
      canRename = isAdmin;
      canDelete = isAdmin;
    } else {
      canRename = isOwner;
      canDelete = isOwner;
    }

    var menu = el('div', 'context-menu');
    menu.id = 'item-context-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex = '10000';

    // 移动端用底部弹出式菜单；桌面端跟随点击位置
    var isMobile = window.innerWidth <= 768;
    if (isMobile) {
      // 底部弹出菜单，居中显示，最大宽度不超过屏幕
      menu.style.left = '8px';
      menu.style.right = '8px';
      menu.style.top = 'auto';
      menu.style.bottom = '0';
      menu.style.width = 'auto';
      menu.style.borderRadius = '16px 16px 12px 12px';
    } else {
      // 桌面端：跟随点击位置，防止超出屏幕
      var menuW = 160;
      var menuH = 200;
      var left = Math.min(e.clientX, window.innerWidth - menuW);
      var top = Math.min(e.clientY, window.innerHeight - menuH);
      menu.style.left = Math.max(0, left) + 'px';
      menu.style.top = Math.max(0, top) + 'px';
      menu.style.width = menuW + 'px';
    }

    var items = [];

    // 回收站项目操作
    if (item.isRecycleItem) {
      // 恢复
      items.push({ label: '&#128260; 恢复', action: function() { closeItemMenu(); restoreItem(item); } });
      // 永久删除
      items.push({ label: '&#128465; 永久删除', action: function() { closeItemMenu(); deleteItem(item); }, danger: true });
    } else {
      // 下载（非目录）
      if (!item.isDirectory) {
        items.push({ label: '&#128229; 下载', action: function() { closeItemMenu(); downloadFile(item); } });
      }
      // 重命名
      if (canRename) {
        items.push({ label: '&#9998; 重命名', action: function() { closeItemMenu(); renameItem(item); } });
      }
      // 移动
      if (canRename || canDelete) {
        items.push({ label: '&#128240; 移动', action: function() { closeItemMenu(); moveItem(item); } });
      }
      // 删除（非回收站模式）
      if (canDelete) {
        items.push({ label: '&#128465; 删除', action: function() { closeItemMenu(); deleteItem(item); }, danger: true });
      }
      // 分享（个人目录/公共目录均可分享）
      var canShare = state.dirType === 'personal' || state.dirType === 'public';
      if (canShare) {
        items.push({ label: '&#128279; 分享', action: function() { closeItemMenu(); doSingleShare(item); } });
      }
      // WebDAV（仅目录，公共目录管理员 + 个人目录所有用户）
      if (item.isDirectory) {
        if (state.dirType === 'public' && state.isAdmin) {
          items.push({ label: '&#128194; WebDAV', action: function() { closeItemMenu(); createWebDAVLink(item, 'public'); } });
        } else if (state.dirType === 'personal') {
          items.push({ label: '&#128194; WebDAV', action: function() { closeItemMenu(); createWebDAVLink(item, 'personal'); } });
        }
      }
    }

    if (items.length === 0) {
      items.push({ label: '无操作权限', disabled: true });
    }

    items.forEach(function(mi) {
      var btn = el('button', 'context-menu-item' + (mi.danger ? ' danger' : ''));
      if (mi.disabled) btn.disabled = true;
      btn.innerHTML = mi.label;
      btn.addEventListener('click', function() {
        if (!mi.disabled) mi.action();
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    _activeMenu = menu;
    setTimeout(function() { document.addEventListener('click', closeItemMenu); }, 0);
    // 移动端滚动或触摸也关闭菜单
    if (window.innerWidth <= 768) {
      document.addEventListener('touchstart', function onTouch(e) {
        var m = $('#item-context-menu');
        if (m && !m.contains(e.target)) {
          closeItemMenu();
          document.removeEventListener('touchstart', onTouch);
        }
      });
    }
  }

  // ---------- Rename ----------
  function renameItem(item) {
    var newName = prompt('重命名 "' + item.name + '" 为：', item.name);
    if (!newName || newName.trim() === '' || newName.trim() === item.name) return;
    newName = newName.trim();
    // 目录和文件用不同的长度限制
    var isDir = item.isDirectory || item.isPublicDir;
    var check = isDir ? validateDirName(newName) : validateFileName(newName, 200);
    if (!check.valid) {
      showToast(check.message, '&#9888;');
      return;
    }

    var apiUrl, postData;
    if (item.isPublicFile) {
      apiUrl = '/public-files/rename';
      postData = JSON.stringify({ path: item.relPath, new_name: newName });
    } else if (item.isPublicDir) {
      apiUrl = '/public-dirs/rename';
      postData = JSON.stringify({ path: item.relPath, new_name: newName });
    } else if (item.isDirectory) {
      apiUrl = '/dirs/' + item.id + '/rename';
      postData = JSON.stringify({ name: newName });
    } else {
      apiUrl = '/files/' + item.id + '/rename';
      postData = JSON.stringify({ name: newName });
    }

    showLoading();
    fetch('/api' + apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: postData
    }).then(function(r) { return r.json(); })
      .then(function(res) {
        hideLoading();
        if (res.code === 0) {
          showToast('重命名成功', '&#9998;');
          loadFiles(state.currentDirId);
        } else {
          showToast(res.message || '重命名失败', '&#9888;');
        }
      })
      .catch(function() {
        hideLoading();
        showToast('重命名失败', '&#9888;');
      });
  }

  // ---------- Move Item / Move Selected（移动文件/目录，支持单个和批量） ----------
  function moveItem(item) {
    moveItems([item]);
  }

  // 批量移动选中的文件/目录
  function moveSelectedFiles() {
    if (state.selectedFiles.length === 0) {
      showToast('请先选择要移动的文件或文件夹', '&#9888;');
      return;
    }
    var items = state.selectedFiles.map(function(id) {
      return state.fileData.find(function(f) { return String(f.id) === String(id); });
    }).filter(Boolean);

    if (items.length === 0) {
      showToast('没有可移动的项目', '&#9888;');
      return;
    }

    moveItems(items);
  }

  // 移动项目（支持单个或批量）
  function moveItems(items) {
    var isBatch = items.length > 1;
    var itemName = isBatch ? items.length + ' 个项目' : items[0].name;
    var isDir = items.every(function(i) { return !!(i.isDirectory || i.isPublicDir); });
    var isPublic = !!(items[0].isPublicFile || items[0].isPublicDir);

    // 移动对话框 HTML
    var overlay = el('div', 'move-overlay');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var dialog = el('div', 'move-dialog');
    dialog.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;padding:0;min-width:480px;max-width:600px;width:90%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;';

    dialog.innerHTML =
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-size:16px;font-weight:600;color:var(--text-primary);">&#128240; ' + (isBatch ? '批量移动' : (isDir ? '移动目录' : '移动文件')) + '</span>' +
        '<button id="move-close-btn" style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;padding:4px;line-height:1;">&#10005;</button>' +
      '</div>' +
      '<div style="padding:12px 20px;border-bottom:1px solid var(--border);color:var(--text-secondary);font-size:13px;">' +
        '准备移动: <strong style="color:var(--text-primary);">' + escapeAttr(itemName) + '</strong>' +
      '</div>' +
      '<div id="move-path-bar" style="padding:8px 20px;background:var(--bg-tertiary);font-size:12px;color:var(--text-muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>' +
      '<div id="move-tree-container" style="flex:1;overflow-y:auto;padding:12px 20px;min-height:200px;max-height:400px;"></div>' +
      '<div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;">' +
        '<button id="move-cancel-btn" style="padding:8px 20px;border:1px solid var(--border);border-radius:8px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;font-size:14px;">取消</button>' +
        '<button id="move-confirm-btn" style="padding:8px 20px;border:none;border-radius:8px;background:var(--accent);color:white;cursor:pointer;font-size:14px;font-weight:600;">确认移动</button>' +
      '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    var treeContainer = $('#move-tree-container');
    var pathBar = $('#move-path-bar');
    var confirmBtn = $('#move-confirm-btn');
    var cancelBtn = $('#move-cancel-btn');
    var closeBtn = $('#move-close-btn');

    var selectedTargetId = isPublic ? null : 0;
    var currentTargetPath = isPublic ? '' : '';

    function renderMoveTree() {
      if (!treeContainer) return;

      var html = '<div style="display:flex;flex-direction:column;gap:2px;">';

      // 根目录选项（个人目录始终有）
      if (!isPublic) {
        var rootSelected = (selectedTargetId === 0);
        html += '<div class="move-dir-item' + (rootSelected ? ' selected' : '') + '" data-dir-id="0" style="padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:8px;' + (rootSelected ? 'background:var(--accent);color:white;' : 'color:var(--text-primary);') + '">' +
          '<span style="font-size:16px;">&#128193;</span><span>根目录</span></div>';
      }

      // 从 API 获取目录列表
      var apiUrl;
      if (isPublic) {
        apiUrl = '/api/public-files/list?path=' + encodeURIComponent(currentTargetPath);
      } else {
        apiUrl = '/api/dirs?path=' + (selectedTargetId || 0) + '&type=personal';
      }

      fetch(apiUrl, { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(res) {
          if (res.code !== 0) {
            treeContainer.innerHTML = '<div style="color:var(--error);padding:20px;">加载目录失败</div>';
            return;
          }
          var dirs = res.data.dirs || [];
          if (dirs.length === 0) {
            treeContainer.innerHTML = '<div style="color:var(--text-muted);padding:20px;font-size:13px;text-align:center;">此目录下暂无子目录</div>';
          } else {
            var html = '<div style="display:flex;flex-direction:column;gap:2px;">';
            dirs.forEach(function(d) {
              var dirId = isPublic ? (d.child_path || d.name) : d.id;
              var selected = isPublic ? (currentTargetPath === d.child_path) : (selectedTargetId === d.id);
              html += '<div class="move-dir-item' + (selected ? ' selected' : '') + '" data-dir-id="' + escapeAttr(String(dirId)) + '" data-dir-name="' + escapeAttr(d.name) + '" data-is-public="' + (isPublic ? '1' : '0') + '" data-child-path="' + escapeAttr(d.child_path || d.name) + '" style="padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:8px;' + (selected ? 'background:var(--accent);color:white;' : 'color:var(--text-primary);') + '">' +
                '<span style="font-size:16px;">&#128193;</span>' +
                '<span style="flex:1;">' + escapeAttr(d.name) + '</span>' +
                '<button class="move-enter-btn" data-enter-target="' + escapeAttr(String(dirId)) + '" style="padding:2px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;cursor:pointer;background:transparent;color:inherit;">进入</button>' +
              '</div>';
            });
            html += '</div>';
            treeContainer.innerHTML = html;

            // 绑定选择和进入事件
            $$('.move-dir-item', treeContainer).forEach(function(el) {
              el.addEventListener('click', function(e) {
                if (e.target.classList.contains('move-enter-btn')) return;
                var isPub = el.dataset.isPublic === '1';
                if (isPub) {
                  // 选择此目录作为目标（移动到这里）
                  currentTargetPath = el.dataset.childPath || el.dataset.dirId;
                } else {
                  selectedTargetId = parseInt(el.dataset.dirId, 10);
                  currentTargetPath = '';
                }
                renderMoveTree();
              });
              el.addEventListener('dblclick', function(e) {
                if (e.target.classList.contains('move-enter-btn')) return;
                var btn = el.querySelector('.move-enter-btn');
                if (btn) btn.click();
              });
            });

            $$('.move-enter-btn', treeContainer).forEach(function(btn) {
              btn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                var target = btn.dataset.enterTarget || '';
                if (!target) {
                  var parentEl = btn.closest('.move-dir-item');
                  target = parentEl ? (parentEl.dataset.childPath || parentEl.dataset.dirId) : '';
                }
                currentTargetPath = target;
                var parts = target.split('/');
                var name = parts[parts.length - 1];
                breadcrumbPath.push(name);
                updatePathBar();
                renderMoveTree();
              });
            });
          }
        })
        .catch(function() {
          treeContainer.innerHTML = '<div style="color:var(--error);padding:20px;">加载目录失败</div>';
        });
    }

    function updatePathBar() {
      if (!pathBar) return;
      if (isPublic) {
        pathBar.textContent = '当前位置: ' + (currentTargetPath ? currentTargetPath : '根目录');
      } else {
        pathBar.textContent = '目标目录: ' + (selectedTargetId === 0 ? '根目录' : breadcrumbPath.join(' / '));
      }
    }

    // 关闭弹窗
    function closeMoveDialog() {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    if (closeBtn) closeBtn.addEventListener('click', closeMoveDialog);
    if (cancelBtn) cancelBtn.addEventListener('click', closeMoveDialog);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeMoveDialog();
    });

    // 确认移动
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function() {
        showLoading();

        // 批量移动：逐个移动
        var moveIndex = 0;
        var moveCount = items.length;
        var successCount = 0;
        var failCount = 0;

        function doMoveOne() {
          if (moveIndex >= moveCount) {
            // 全部完成
            hideLoading();
            closeMoveDialog();
            if (successCount > 0) {
              showToast('已移动 ' + successCount + ' 项' + (failCount > 0 ? '，' + failCount + ' 项失败' : ''), '&#128240;');
              deselectAllFiles();
              if (isPublic) {
                loadFiles(0);
              } else {
                loadFiles(selectedTargetId);
              }
            } else {
              showToast('移动失败', '&#9888;');
            }
            return;
          }

          var item = items[moveIndex];
          var apiUrl, postData;

          if (isPublic) {
            var sourcePath = item.relPath || item.child_path || '';
            if (item.isPublicFile) {
              apiUrl = '/api/public-files/move';
              postData = JSON.stringify({ path: sourcePath, target_path: currentTargetPath });
            } else {
              apiUrl = '/api/public-dirs/move';
              postData = JSON.stringify({ path: sourcePath, target_path: currentTargetPath });
            }
          } else {
            if (item.isDirectory) {
              apiUrl = '/api/dirs/' + item.id + '/move';
              postData = JSON.stringify({ target_parent_id: selectedTargetId });
            } else {
              apiUrl = '/api/files/' + item.id + '/move';
              postData = JSON.stringify({ target_dir_id: selectedTargetId });
            }
          }

          fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: postData
          }).then(function(r) { return r.json(); })
            .then(function(res) {
              if (res.code === 0) {
                successCount++;
              } else {
                failCount++;
              }
              moveIndex++;
              doMoveOne();
            })
            .catch(function() {
              failCount++;
              moveIndex++;
              doMoveOne();
            });
        }

        doMoveOne();
      });
    }

    renderMoveTree();
    updatePathBar();
  }

  // ---------- 加载个人信息 ----------
  function loadProfile() {
    var panelBody = $('#page-panel-body');
    if (!panelBody) return;

    // 显示加载状态
    panelBody.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:32px;margin-bottom:16px">&#128640;</div><div>正在加载用户信息...</div></div>';

    return apiGet('/profile/me').then(function (res) {
      if (res.code === 0 && res.data) {
        state.user = res.data;
        state.isAdmin = !!res.data.is_admin;
        renderProfileView();
        // 用户信息获取后，立即更新工具栏/上传按钮可见性
        updateToolbarVisibility();
        updateUploadBtnVisibility();
        updateAdminNavVisibility();
      } else if (res.code === 401) {
        showToast('请先登录', '&#9888;');
        setTimeout(function () { window.location.href = '/login.html'; }, 1000);
      } else {
        console.warn('[app.js] 加载用户信息失败:', res.message);
        if (panelBody) {
          panelBody.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--error);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:24px;margin-bottom:12px">&#9888;</div>加载失败: ' + (res.message || '未知错误') + '</div>';
        }
      }
    }).catch(function (err) {
      console.error('[app.js] loadProfile 错误:', err);
      if (panelBody) {
        panelBody.innerHTML = '<div style="padding:40px 20px;text-align:center;color:var(--error);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:24px;margin-bottom:12px">&#9888;</div>网络错误，请检查网络连接</div>';
      }
    });
  }

  function renderProfileView() {
    var u = state.user;
    var container = $('#page-panel-body');
    if (!container) return;

    if (!u) {
      console.warn('[app.js] renderProfileView: user为空');
      container.innerHTML = '<div style="padding:20px;color:var(--text-muted)">加载中...</div>';
      return;
    }

    var pct = u.quota_bytes > 0 ? Math.round(u.used_bytes / u.quota_bytes * 100) : 0;
    var tqPct = u.traffic_quota > 0 ? Math.round((u.traffic_used || 0) / u.traffic_quota * 100) : 0;
    var tqRemaining = Math.max(0, (u.traffic_quota || 10737418240) - (u.traffic_used || 0));
    var tqColor = tqPct < 50 ? '#4caf50' : tqPct < 80 ? '#ff9800' : '#f44336';

    container.innerHTML = '';

    // 头像区
    var avatarSection = el('div', 'profile-avatar-section');
    var avatar = el('div', 'profile-avatar');
    avatar.textContent = (u.nickname || u.email || 'U').charAt(0).toUpperCase();
    avatarSection.appendChild(avatar);
    var quotaBar = el('div', 'quota-section');
    quotaBar.innerHTML =
      '<div class="quota-label">存储空间</div>' +
      '<div class="quota-bar-wrap"><div class="quota-bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="quota-text">' + formatFileSize(u.used_bytes) + ' / ' + formatFileSize(u.quota_bytes) + ' (' + pct + '%)</div>';
    avatarSection.appendChild(quotaBar);

    // 流量信息
    var trafficBar = el('div', 'quota-section');
    trafficBar.style.marginTop = '12px';
    trafficBar.innerHTML =
      '<div class="quota-label" style="margin-top:12px">月度流量 <span style="font-size:10px;color:var(--text-muted);font-weight:400">' + ((u.traffic_period) || '') + '</span></div>' +
      '<div class="quota-bar-wrap"><div class="quota-bar-fill" style="width:' + tqPct + '%;background:' + tqColor + '"></div></div>' +
      '<div class="quota-text">' + formatFileSize(u.traffic_used || 0) + ' 已用 / ' + formatFileSize(u.traffic_quota || 10737418240) + ' 配额（剩余 <span style="color:' + tqColor + ';font-weight:600">' + formatFileSize(tqRemaining) + '</span>）</div>';
    avatarSection.appendChild(trafficBar);
    container.appendChild(avatarSection);

    // 信息表单
    var form = el('div', 'profile-form');
    form.innerHTML =
      '<div class="form-group"><label>邮箱</label><input id="profile-email" type="email" value="' + escapeAttr(u.email) + '" disabled></div>' +
      '<div class="form-group"><label>昵称</label><input id="profile-nickname" type="text" value="' + escapeAttr(u.nickname || '') + '" placeholder="设置昵称"></div>' +
      '<div class="form-group" id="profile-reminder-group">' +
        '<label>邮件提醒</label>' +
        '<div class="form-group-inline">' +
          '<label class="toggle-switch">' +
            '<input type="checkbox" id="profile-reminder-toggle"' + (u.email_reminder ? ' checked' : '') + '>' +
            '<span class="toggle-slider"></span>' +
          '</label>' +
          '<span class="toggle-label">' + (u.email_reminder ? '已开启（文件过期前3天发送邮件提醒）' : '已关闭') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>注册时间</label><input type="text" value="' + (u.created_at ? u.created_at.split('T')[0] : '-') + '" disabled></div>' +
      '<div class="form-group"><label>最后登录</label><input type="text" value="' + (u.last_login ? u.last_login.replace('T', ' ').split('.')[0] : '-') + '" disabled></div>' +
      '<div class="form-group"><label>角色</label><input type="text" value="' + (u.is_admin ? '管理员' : '普通用户') + '" disabled></div>' +
      '<div class="form-actions">' +
        '<button class="btn btn-primary" id="profile-save-btn">保存修改</button>' +
      '</div>';
    container.appendChild(form);

    // ===== 设备管理面板 =====
    var deviceSection = el('div', 'profile-devices-section');
    deviceSection.style.cssText = 'margin-top:20px;padding-top:20px;border-top:1px solid var(--border)';
    deviceSection.innerHTML = '<h3 style="font-size:14px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' +
      '在线设备</h3><div id="device-list-container" style="font-size:12px;color:var(--text-muted)">加载中...</div>';
    container.appendChild(deviceSection);

    // 加载设备列表
    axios.get('/api/auth/devices', { withCredentials: true }).then(function(r) {
      var dc = document.getElementById('device-list-container');
      if (!dc) return;
      if (r.data.code !== 0) { dc.textContent = '加载失败'; return; }
      var devices = r.data.data.devices || [];
      if (devices.length === 0) { dc.innerHTML = '<span style="color:var(--text-muted)">暂无设备记录</span>'; return; }
      var html = '';
      devices.forEach(function(d) {
        var icon = d.isCurrent ? '&#128994;' : (d.online ? '&#128993;' : '&#128308;');
        var title = d.isCurrent ? '当前设备' : (d.online ? '在线' : '离线');
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;margin-bottom:6px;background:var(--bg);border-radius:6px;border:1px solid var(--border)">';
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="display:flex;align-items:center;gap:8px">';
        html += '<span style="font-size:16px" title="' + title + '">' + icon + '</span>';
        html += '<strong>' + escHtml(d.device || '未知设备') + '</strong>';
        if (d.isCurrent) html += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:var(--accent);color:#fff">当前</span>';
        html += '</div>';
        html += '<div style="margin-top:4px;font-size:11px;color:var(--text-secondary)">';
        html += 'IP: ' + escHtml(d.ip || '-') + ' · ';
        html += escHtml((d.userAgent || '').substring(0, 50));
        html += '</div>';
        html += '<div style="font-size:10px;color:var(--text-muted);margin-top:2px">登录: ' + (d.loginAt ? new Date(d.loginAt).toLocaleString() : '-') + '</div>';
        html += '</div>';
        if (!d.isCurrent) {
          html += '<button class="btn btn-danger btn-sm" onclick="window.__fm.forceLogoutDevice(\'' + escHtml(d.sid) + '\')" style="flex-shrink:0;margin-left:12px">下线</button>';
        }
        html += '</div>';
      });
      dc.innerHTML = html;
    }).catch(function() {
      var dc = document.getElementById('device-list-container');
      if (dc) dc.textContent = '加载失败';
    });

    // 邮件提醒开关：切换时更新标签文字
    var toggle = $('#profile-reminder-toggle');
    var toggleLabel = form.querySelector('.toggle-label');
    if (toggle && toggleLabel) {
      toggle.addEventListener('change', function() {
        toggleLabel.textContent = toggle.checked
          ? '已开启（文件过期前3天发送邮件提醒）'
          : '已关闭';
      });
    }

    $('#profile-save-btn').addEventListener('click', function () {
      var nickname = $('#profile-nickname').value.trim();
      var reminderEnabled = toggle ? toggle.checked : true;
      var changed = nickname !== (state.user && state.user.nickname)
        || reminderEnabled !== (state.user && state.user.email_reminder);
      if (!changed) {
        showToast('没有任何变化', '&#9888;');
        return;
      }
      showLoading();
      axios.put('/api/profile/me', { nickname: nickname, email_reminder: reminderEnabled }, { withCredentials: true })
        .then(function (res) {
          hideLoading();
          if (res.data.code === 0) {
            showToast('保存成功', '&#10004;');
            loadProfile();
          } else {
            showToast(res.data.message || '保存失败', '&#9888;');
          }
        })
        .catch(function (err) {
          hideLoading();
          showToast('保存失败', '&#9888;');
          console.error(err);
        });
    });
  }

  // ==================== 修改密码视图 ====================

  function initChangePassword() {
    var container = $('#page-panel-body');
    if (!container) return;

    // 显示加载状态
    container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:32px;margin-bottom:16px">&#128640;</div><div>正在加载...</div></div>';

    // 稍微延迟渲染表单，确保 DOM 更新后再填充内容
    setTimeout(function() {
      container.innerHTML = '';

      var form = el('div', 'change-password-form');
      form.innerHTML =
        '<div class="form-title">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
            '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
          '</svg>' +
          '修改登录密码' +
        '</div>' +
        '<div class="form-desc">为保障账户安全，请定期更换密码</div>' +

        '<div class="form-group">' +
          '<label><span class="required">*</span>当前密码</label>' +
          '<div class="input-wrap">' +
            '<input type="password" class="form-input" id="cp-old" placeholder="请输入当前密码" autocomplete="current-password">' +
            '<span class="input-icon">' +
              '<svg width="18" height="18"><use href="#icon-lock"/></svg>' +
            '</span>' +
            '<button type="button" class="toggle-password" id="toggle-cp-old" aria-label="显示密码">' +
              '<svg width="18" height="18" class="eye-show"><use href="#icon-eye"/></svg>' +
              '<svg width="18" height="18" class="eye-hide" style="display:none"><use href="#icon-eye-off"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="input-error" id="cp-old-error"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label><span class="required">*</span>新密码</label>' +
          '<div class="input-wrap">' +
            '<input type="password" class="form-input" id="cp-new" placeholder="请输入新密码（6位以上）" autocomplete="new-password">' +
            '<span class="input-icon">' +
              '<svg width="18" height="18"><use href="#icon-lock-open"/></svg>' +
            '</span>' +
            '<button type="button" class="toggle-password" id="toggle-cp-new" aria-label="显示密码">' +
              '<svg width="18" height="18" class="eye-show"><use href="#icon-eye"/></svg>' +
              '<svg width="18" height="18" class="eye-hide" style="display:none"><use href="#icon-eye-off"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="password-strength" style="margin-top:8px">' +
            '<div class="strength-bar" id="cp-strength-bar"></div>' +
            '<span class="strength-text" id="cp-strength-text">未输入</span>' +
          '</div>' +
          '<div class="input-error" id="cp-new-error"></div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label><span class="required">*</span>确认密码</label>' +
          '<div class="input-wrap">' +
            '<input type="password" class="form-input" id="cp-confirm" placeholder="再次输入新密码" autocomplete="new-password">' +
            '<span class="input-icon">' +
              '<svg width="18" height="18"><use href="#icon-lock-open"/></svg>' +
            '</span>' +
            '<button type="button" class="toggle-password" id="toggle-cp-confirm" aria-label="显示密码">' +
              '<svg width="18" height="18" class="eye-show"><use href="#icon-eye"/></svg>' +
              '<svg width="18" height="18" class="eye-hide" style="display:none"><use href="#icon-eye-off"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="input-error" id="cp-confirm-error"></div>' +
        '</div>' +

        '<div class="form-actions">' +
          '<button type="button" class="btn btn-primary" id="cp-submit-btn">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' +
            '保存修改' +
          '</button>' +
        '</div>';
      container.appendChild(form);

      // 绑定查看密码功能
      initTogglePassword('toggle-cp-old', 'cp-old');
      initTogglePassword('toggle-cp-new', 'cp-new');
      initTogglePassword('toggle-cp-confirm', 'cp-confirm');

      var oldPwdInput = $('#cp-old');
      var newPwdInput = $('#cp-new');
      var confirmPwdInput = $('#cp-confirm');
      var strengthBar = $('#cp-strength-bar');
      var strengthText = $('#cp-strength-text');

      function showError(id, msg) {
        var el = $('#' + id);
        if (el) { el.textContent = msg; el.classList.add('show'); }
      }

      function clearError(id) {
        var el = $('#' + id);
        if (el) { el.textContent = ''; el.classList.remove('show'); }
      }

      function clearAllErrors() {
        clearError('cp-old-error');
        clearError('cp-new-error');
        clearError('cp-confirm-error');
      }

      function checkPasswordStrength(pwd) {
        if (!pwd) {
          strengthBar.style.width = '0%';
          strengthBar.className = 'strength-bar';
          strengthText.textContent = '未输入';
          strengthText.style.color = '';
          return 0;
        }
        var score = 0;
        if (pwd.length >= 6) score++;
        if (pwd.length >= 8) score++;
        if (pwd.length >= 12) score++;
        if (/[A-Z]/.test(pwd)) score++;
        if (/[a-z]/.test(pwd)) score++;
        if (/[0-9]/.test(pwd)) score++;
        if (/[^a-zA-Z0-9]/.test(pwd)) score++;

        var pct = Math.min(100, score * 15);
        strengthBar.style.width = pct + '%';

        if (score <= 2) {
          strengthBar.className = 'strength-bar weak';
          strengthText.textContent = '弱';
          strengthText.style.color = '#ef4444';
        } else if (score <= 4) {
          strengthBar.className = 'strength-bar medium';
          strengthText.textContent = '中等';
          strengthText.style.color = '#f59e0b';
        } else {
          strengthBar.className = 'strength-bar strong';
          strengthText.textContent = '强';
          strengthText.style.color = '#10b981';
        }
        return score;
      }

      newPwdInput.addEventListener('input', function() {
        clearError('cp-new-error');
        checkPasswordStrength(this.value);
      });

      oldPwdInput.addEventListener('input', function() { clearError('cp-old-error'); });
      confirmPwdInput.addEventListener('input', function() { clearError('cp-confirm-error'); });

      $('#cp-submit-btn').addEventListener('click', function () {
        clearAllErrors();
        var oldPwd = oldPwdInput.value;
        var newPwd = newPwdInput.value;
        var confirmPwd = confirmPwdInput.value;

        var hasError = false;

        if (!oldPwd) {
          showError('cp-old-error', '请输入当前密码');
          oldPwdInput.focus();
          hasError = true;
          return;
        }
        if (!newPwd) {
          showError('cp-new-error', '请输入新密码');
          newPwdInput.focus();
          hasError = true;
          return;
        }
        if (newPwd.length < 6) {
          showError('cp-new-error', '新密码至少6位');
          newPwdInput.focus();
          hasError = true;
          return;
        }
        if (newPwd === oldPwd) {
          showError('cp-new-error', '新密码不能与当前密码相同');
          newPwdInput.focus();
          hasError = true;
          return;
        }
        if (!confirmPwd) {
          showError('cp-confirm-error', '请确认新密码');
          confirmPwdInput.focus();
          hasError = true;
          return;
        }
        if (newPwd !== confirmPwd) {
          showError('cp-confirm-error', '两次输入的密码不一致');
          confirmPwdInput.focus();
          hasError = true;
          return;
        }

        if (hasError) return;

        showLoading();
        apiPost('/profile/change-password', { oldPassword: oldPwd, newPassword: newPwd })
          .then(function (res) {
            hideLoading();
            if (res.code === 0) {
              showToast('密码修改成功', '&#10004;');
              oldPwdInput.value = '';
              newPwdInput.value = '';
              confirmPwdInput.value = '';
              checkPasswordStrength('');
              setTimeout(function () { switchView('files'); }, 1500);
            } else {
              showToast(res.message || '修改失败', '&#9888;');
            }
          })
          .catch(function (err) {
            hideLoading();
            showToast('网络错误，请重试', '&#9888;');
            console.error(err);
          });
      });

      // 回车提交
      [oldPwdInput, newPwdInput, confirmPwdInput].forEach(function(input) {
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            $('#cp-submit-btn').click();
          }
        });
      });
    }, 10);
  }

  // ==================== 管理员视图 ====================

  var adminUsers = [];

  // ========== 通用 Admin 页面头部 ==========
  // 返回 { headerEl, contentEl }
  function makeAdminHeader(titleText, countEl, searchPlaceholder, onSearch) {
    var wrap = el('div', 'af-admin-page');
    var header = el('div', 'af-admin-header');
    var titleArea = el('div', 'af-admin-title-area');
    var titleEl = el('span', 'af-admin-title');
    titleEl.textContent = titleText;
    titleArea.appendChild(titleEl);
    if (countEl) titleArea.appendChild(countEl);
    header.appendChild(titleArea);

    var rightArea = el('div', 'af-admin-right');
    if (searchPlaceholder !== null) {
      var searchWrap = el('div', 'af-admin-search-wrap');
      var searchIcon = el('span', 'af-admin-search-icon');
      searchIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      searchWrap.appendChild(searchIcon);
      var searchInput = el('input', 'af-admin-search');
      searchInput.type = 'search';
      searchInput.placeholder = searchPlaceholder || '搜索...';
      searchInput.addEventListener('input', function() {
        if (onSearch) onSearch(searchInput.value.trim());
      });
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && onSearch) onSearch(searchInput.value.trim());
      });
      searchWrap.appendChild(searchInput);
      rightArea.appendChild(searchWrap);
    }
    header.appendChild(rightArea);
    wrap.appendChild(header);

    var content = el('div', 'af-admin-content');
    wrap.appendChild(content);
    return { wrap: wrap, header: header, content: content };
  }

  var adminUsersFiltered = [];
  var adminUsersState = {
    users: [],
    total: 0,
    page: 1,
    limit: 20,
    keyword: ''
  };

  function loadAdminUsers() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:32px;margin-bottom:16px">&#128640;</div><div>正在加载用户列表...</div></div>';

    showLoading();
    fetchAdminUsersPage();
  }

  function fetchAdminUsersPage() {
    var url = '/admin/users?page=' + adminUsersState.page + '&limit=' + adminUsersState.limit;
    if (adminUsersState.keyword) url += '&keyword=' + encodeURIComponent(adminUsersState.keyword);
    apiGet(url).then(function (res) {
      hideLoading();
      if (res.code === 0) {
        adminUsersState.users = res.data.users || [];
        adminUsersState.total = res.data.total || 0;
        adminUsers = adminUsersState.users;
        adminUsersFiltered = adminUsers.slice();
        renderAdminUsersUI();
      } else {
        showToast(res.message || '加载失败', '&#9888;');
      }
    }).catch(function() {
      hideLoading();
      showToast('网络错误', '&#9888;');
    });
  }

  function renderAdminUsersUI() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';

    var totalPages = Math.max(1, Math.ceil(adminUsersState.total / adminUsersState.limit));
    var countEl = el('span', 'af-count-badge');
    countEl.textContent = '共 ' + adminUsersState.total + ' 人';

    var result = makeAdminHeader('用户管理', countEl, '搜索邮箱/昵称...', function(kw) {
      adminUsersState.keyword = kw;
      adminUsersState.page = 1;
      showLoading();
      fetchAdminUsersPage();
    });

    container.appendChild(result.wrap);
    // 渲染表格（内部会清空 content）
    renderAdminUsersTable(result.content);
    // 渲染完表格后，在表格上方添加分页工具栏
    addAdminUsersPager(result.content, totalPages);
  }

  function addAdminUsersPager(content, totalPages) {
    var pagerRow = el('div', 'au-pager-row');
    var pageInfo = el('span', 'au-page-info');
    pageInfo.textContent = '第 ' + adminUsersState.page + ' / ' + totalPages + ' 页，共 ' + adminUsersState.total + ' 条';
    var prevBtn = el('button', 'admin-btn');
    prevBtn.textContent = '‹ 上一页';
    prevBtn.disabled = adminUsersState.page <= 1;
    prevBtn.addEventListener('click', function() {
      if (adminUsersState.page > 1) {
        adminUsersState.page--;
        showLoading();
        fetchAdminUsersPage();
      }
    });
    var nextBtn = el('button', 'admin-btn');
    nextBtn.textContent = '下一页 ›';
    nextBtn.disabled = adminUsersState.page >= totalPages;
    nextBtn.addEventListener('click', function() {
      if (adminUsersState.page < totalPages) {
        adminUsersState.page++;
        showLoading();
        fetchAdminUsersPage();
      }
    });
    pagerRow.appendChild(prevBtn);
    pagerRow.appendChild(pageInfo);
    pagerRow.appendChild(nextBtn);

    // 分页放在表格上方（af-admin-content 内部，表格之前）
    var tableWrap = content.querySelector('.admin-table-wrap');
    if (tableWrap) {
      content.insertBefore(pagerRow, tableWrap);
    } else {
      content.appendChild(pagerRow);
    }
  }

  function renderAdminUsersTable(content) {
    if (!content) content = document.querySelector('.af-admin-content');
    if (!content) return;
    content.innerHTML = '';

    // 桌面端表格
    var tableWrap = el('div', 'admin-table-wrap');
    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['用户信息', '角色', '状态', '存储配额', '月度流量', '操作'].forEach(function(label) {
      var th = document.createElement('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');

    if (adminUsersFiltered.length === 0) {
      var emptyTr = el('tr');
      var emptyTd = el('td');
      emptyTd.colSpan = 6;
      emptyTd.textContent = '暂无用户';
      emptyTd.style.textAlign = 'center';
      emptyTd.style.color = 'var(--text-muted)';
      emptyTd.style.padding = '40px';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      adminUsersFiltered.forEach(function(u) {
        var tr = el('tr');
        var usedMb = Math.round((u.used_bytes || 0) / 1024 / 1024);
        var quotaMb = Math.round((u.quota_bytes || 1073741824) / 1024 / 1024);
        var usagePct = quotaMb > 0 ? Math.min(100, Math.round(usedMb / quotaMb * 100)) : 0;
        var usageColor = usagePct > 80 ? 'var(--error)' : usagePct > 50 ? '#f59e0b' : 'var(--success)';

        tr.innerHTML =
          '<td>' +
            '<div class="au-user-info">' +
              '<div class="au-email">' + escHtml(u.email || '') + '</div>' +
              '<div class="au-nickname">' + (u.nickname || '-') + '</div>' +
            '</div>' +
          '</td>' +
          '<td><span class="role-badge ' + (u.is_admin ? 'admin' : 'user') + '">' + (u.is_admin ? '管理员' : '普通用户') + '</span></td>' +
          '<td>' +
            '<div class="au-status-group">' +
              '<span class="status-badge ' + (u.is_active ? 'active' : 'inactive') + '">' + (u.is_active ? '正常' : '禁用') + '</span>' +
              formatBanInfo(u) +
            '</div>' +
          '</td>' +
          '<td>' +
            '<div class="au-quota-cell">' +
              '<div class="au-quota-text"><span style="font-family:\'Share Tech Mono\',monospace;color:' + usageColor + '">' + formatFileSize(u.used_bytes) + '</span> / ' + formatFileSize(u.quota_bytes) + '</div>' +
              '<div class="au-quota-bar"><div class="au-quota-fill" style="width:' + usagePct + '%;background:' + usageColor + '"></div></div>' +
            '</div>' +
          '</td>' +
          '<td>' +
            (function() {
              var tqQuota = u.monthly_quota || 10737418240;
              var tqUsed = u.monthly_used || 0;
              var tqPct = tqQuota > 0 ? Math.min(100, Math.round(tqUsed / tqQuota * 100)) : 0;
              var tqColor = tqPct > 80 ? 'var(--error)' : tqPct > 50 ? '#f59e0b' : 'var(--success)';
              return '<div class="au-quota-cell">' +
                '<div class="au-quota-text"><span style="font-family:\'Share Tech Mono\',monospace;color:' + tqColor + '">' + formatFileSize(tqUsed) + '</span> / ' + formatFileSize(tqQuota) + '</div>' +
                '<div class="au-quota-bar"><div class="au-quota-fill" style="width:' + tqPct + '%;background:' + tqColor + '"></div></div>' +
              '</div>';
            })() +
          '</td>' +
          '<td class="td-actions" data-userid="' + u.id + '"></td>';
        tbody.appendChild(tr);
      });
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    content.appendChild(tableWrap);

    // 移动端卡片
    var cardList = el('div', 'admin-card-list');
    if (adminUsersFiltered.length === 0) {
      cardList.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;font-size:13px">暂无用户</div>';
    } else {
      adminUsersFiltered.forEach(function(u) {
        var card = el('div', 'admin-user-card');
        var usedMb = Math.round((u.used_bytes || 0) / 1024 / 1024);
        var quotaMb = Math.round((u.quota_bytes || 1073741824) / 1024 / 1024);
        var usagePct = quotaMb > 0 ? Math.min(100, Math.round(usedMb / quotaMb * 100)) : 0;
        var usageColor = usagePct > 80 ? 'var(--error)' : usagePct > 50 ? '#f59e0b' : 'var(--success)';
        var tqQuota = u.monthly_quota || 10737418240;
        var tqUsed = u.monthly_used || 0;
        var tqPct = tqQuota > 0 ? Math.min(100, Math.round(tqUsed / tqQuota * 100)) : 0;
        var tqColor = tqPct > 80 ? 'var(--error)' : tqPct > 50 ? '#f59e0b' : 'var(--success)';
        card.innerHTML =
          '<div class="admin-user-card-header">' +
            '<span class="admin-user-card-email">' + escHtml(u.email || '') + '</span>' +
            '<span class="role-badge ' + (u.is_admin ? 'admin' : 'user') + '" style="margin-left:6px">' + (u.is_admin ? '管理员' : '普通用户') + '</span>' +
          '</div>' +
          '<div class="admin-user-card-row"><span>昵称:</span><span>' + escHtml(u.nickname || '-') + '</span></div>' +
          '<div class="admin-user-card-row"><span>状态:</span><span class="status-badge ' + (u.is_active ? 'active' : 'inactive') + '">' + (u.is_active ? '正常' : '禁用') + '</span>' +
            formatBanInfo(u) +
          '</div>' +
          '<div class="admin-user-card-row"><span>存储:</span><span style="font-family:\'Share Tech Mono\',monospace;color:' + usageColor + '">' + formatFileSize(u.used_bytes) + '</span><span>/</span><span style="font-family:\'Share Tech Mono\',monospace">' + formatFileSize(u.quota_bytes) + '</span></div>' +
          '<div class="au-quota-bar"><div class="au-quota-fill" style="width:' + usagePct + '%;background:' + usageColor + '"></div></div>' +
          '<div class="admin-user-card-row"><span>流量:</span><span style="font-family:\'Share Tech Mono\',monospace;color:' + tqColor + '">' + formatFileSize(tqUsed) + '</span><span>/</span><span style="font-family:\'Share Tech Mono\',monospace">' + formatFileSize(tqQuota) + '</span></div>' +
          '<div class="au-quota-bar"><div class="au-quota-fill" style="width:' + tqPct + '%;background:' + tqColor + '"></div></div>' +
          '<div class="admin-user-card-actions" data-userid="' + u.id + '"></div>';
        cardList.appendChild(card);
      });
    }
    content.appendChild(cardList);

    // 绑定操作按钮
    content.querySelectorAll('[data-userid]').forEach(function(cell) {
      var uid = parseInt(cell.dataset.userid, 10);
      var u = adminUsers.find(function(x) { return x.id === uid; });
      if (!u) return;
      var btns = [
        { label: u.is_admin ? '撤销' : '设管', title: u.is_admin ? '撤销管理员权限' : '设为管理员', action: function() { window.__fm.toggleAdmin(u.id, u.is_admin ? 0 : 1); } },
        { label: u.is_banned ? '解封' : '封禁', title: u.is_banned ? '解除封禁' : '封禁该用户', action: u.is_banned ? function() { window.__fm.unbanUser(u.id); } : function() { window.__fm.banUser(u.id); }, danger: !u.is_banned },
        { label: '存配额', title: '修改存储配额上限', action: function() { window.__fm.editStorageQuota(u.id, u.quota_bytes); } },
        { label: '流量', title: '修改月度流量配额', action: function() { window.__fm.editTrafficQuota(u.id, u.monthly_quota); } },
        { label: '删除', title: '删除该用户', action: function() { if (confirm('确认删除用户 ' + u.email + '？此操作不可恢复！')) window.__fm.deleteUser(u.id); }, danger: true }
      ];
      btns.forEach(function(b) {
        var btn = el('button', 'admin-btn' + (b.danger ? ' danger' : ''));
        btn.type = 'button';
        btn.textContent = b.label;
        btn.title = b.title;
        btn.addEventListener('click', b.action);
        cell.appendChild(btn);
      });
    });
  }

  // ==================== 日志管理 ====================

  // 日志分页状态
  var logState = {
    actionLogs: [],
    emailLogs: [],
    actionTotal: 0,
    emailTotal: 0,
    actionPage: 1,
    emailPage: 1,
    pageSize: 50,
    activeTab: 'actions', // 'actions' | 'emails'
    // 筛选条件
    actionFilters: { userId: null, email: '', action: null, status: null, startDate: '', endDate: '' },
    emailFilters: { email: '', template: '', status: null, startDate: '', endDate: '' },
    actionTypes: [],
    emailTypes: [],
    actionStats: null,
    emailStats: null
  };

  // ==================== 管理员文件管理 ====================

  var adminFilesState = {
    files: [],
    total: 0,
    page: 1,
    limit: 50,
    loading: false,
    upgrading: false,
    // 分页相关
    filePage: 1,
    fileLimit: 50,
    fileTotal: 0,
    // 自动升级
    autoUpgrade: false,
    autoUpgradeTimer: null
  };

  function formatEncVersionBadge(v) {
    if (v === 1) return '<span class="enc-badge enc-v1">V1分块</span>';
    if (v === 0) return '<span class="enc-badge enc-old">旧格式</span>';
    if (v === -1) return '<span class="enc-badge enc-none">未加密</span>';
    return '<span class="enc-badge enc-unknown">未知</span>';
  }

  function loadAdminFiles() {
    var container = $('#page-panel-body');
    if (!container) return;
    adminFilesState.loading = true;

    container.innerHTML = '<div id="af-body" class="af-body"></div>';
    var body = $('#af-body');
    body.innerHTML = '';

    apiGet('/admin/files/upgrade-stats').then(function(statsRes) {
      console.log('[admin-files] upgrade-stats response:', JSON.stringify(statsRes).substring(0, 200));
      if (statsRes.code !== 0) {
        body.innerHTML = '<div class="af-empty">加载失败: ' + (statsRes.message || '') + '</div>';
        adminFilesState.loading = false;
        return;
      }

      var pendingTotal = statsRes.data.total_pending || 0;
      var byUser = statsRes.data.by_user || [];

      // 更新徽章
      var badge = $('#upgrade-badge');
      if (badge) {
        if (pendingTotal > 0) {
          badge.textContent = pendingTotal > 99 ? '99+' : pendingTotal;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }

      // 统计卡片行
      var statsRow = el('div', 'af-stats-row');
      var card1 = el('div', 'af-stat-card');
      card1.innerHTML = '<div class="af-stat-num af-pending">' + pendingTotal + '</div><div class="af-stat-label">待升级文件</div>';
      var card2 = el('div', 'af-stat-card');
      card2.innerHTML = '<div class="af-stat-num af-users">' + byUser.length + '</div><div class="af-stat-label">有文件用户</div>';
      statsRow.appendChild(card1);
      statsRow.appendChild(card2);
      body.appendChild(statsRow);

      // 操作按钮行
      var actionRow = el('div', 'af-action-row');
      var btnOne = el('button', 'af-btn af-btn-primary');
      btnOne.textContent = '升级下一个';
      btnOne.addEventListener('click', function() { upgradeNextFile(1); });
      var btnBatch = el('button', 'af-btn af-btn-success');
      btnBatch.textContent = '批量升级10个';
      btnBatch.addEventListener('click', function() { upgradeNextFile(10); });
      var btnRefresh = el('button', 'af-btn af-btn-default');
      btnRefresh.textContent = '刷新';
      btnRefresh.addEventListener('click', loadAdminFiles);
      actionRow.appendChild(btnOne);
      actionRow.appendChild(btnBatch);
      actionRow.appendChild(btnRefresh);

      // 自动升级开关
      var autoWrap = el('div', 'af-auto-upgrade');
      var autoLabel = document.createElement('label');
      autoLabel.className = 'af-auto-label';
      var autoCheckbox = document.createElement('input');
      autoCheckbox.type = 'checkbox';
      autoCheckbox.id = 'af-auto-upgrade-check';
      autoCheckbox.checked = adminFilesState.autoUpgrade;
      autoCheckbox.addEventListener('change', function() {
        adminFilesState.autoUpgrade = autoCheckbox.checked;
        if (adminFilesState.autoUpgrade) {
          showToast('已开启自动升级，每 30 秒自动升级 1 个文件', '&#128640;');
          if (!adminFilesState.autoUpgradeTimer) startAutoUpgrade();
        } else {
          showToast('已关闭自动升级', '&#9888;');
          stopAutoUpgrade();
        }
      });
      autoLabel.appendChild(autoCheckbox);
      var autoText = document.createElement('span');
      autoText.textContent = '自动升级';
      autoLabel.appendChild(autoText);
      autoWrap.appendChild(autoLabel);
      actionRow.appendChild(autoWrap);
      body.appendChild(actionRow);

      // 用户分布
      if (byUser.length > 0) {
        var userSection = el('div', 'af-section');
        var userSectionTitle = el('div', 'af-section-title');
        userSectionTitle.textContent = '各用户待升级文件数';
        userSection.appendChild(userSectionTitle);
        byUser.forEach(function(u) {
          if (u.pending_count > 0) {
            var row = el('div', 'af-user-row');
            var emailSpan = el('span', 'af-user-email');
            emailSpan.textContent = u.email || '';
            var countSpan = el('span', 'af-user-count');
            countSpan.textContent = u.pending_count + ' 个';
            row.appendChild(emailSpan);
            row.appendChild(countSpan);
            userSection.appendChild(row);
          }
        });
        body.appendChild(userSection);
      }

      // 文件列表（使用 admin-table 样式）
      var listWrap = el('div', 'af-list-wrap');
      var tableWrap = el('div', 'admin-table-wrap');

      // 提示信息
      var tip = el('div', 'af-tip');
      tip.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 旧格式文件拖动视频播放会失败，建议尽快升级到 V1 分块格式';
      tableWrap.appendChild(tip);

      // 分页控件
      var pagerDiv = el('div', 'af-pager');
      pagerDiv.id = 'af-pager';
      tableWrap.appendChild(pagerDiv);

      var listDiv = el('div', 'af-list');
      listDiv.id = 'af-list';
      tableWrap.appendChild(listDiv);
      listWrap.appendChild(tableWrap);
      body.appendChild(listWrap);

      // 移动端卡片列表
      var cardList = el('div', 'admin-card-list af-card-list');
      cardList.id = 'af-card-list';
      body.appendChild(cardList);

      // 升级日志
      var logDiv = el('div', 'af-log');
      logDiv.style.display = 'none';
      body.appendChild(logDiv);

      adminFilesState.loading = false;
      loadAdminFilesList();
      hideLoading();
    }).catch(function() {
      var body = $('#af-body');
      if (body) body.innerHTML = '<div class="af-empty">网络错误</div>';
      adminFilesState.loading = false;
      hideLoading();
    });
  }

  function loadAdminFilesList(page) {
    var listEl = $('#af-list');
    if (!listEl) return;
    if (page) adminFilesState.filePage = page;
    listEl.innerHTML = '<div class="af-loading" style="padding:20px"><div class="af-spinner"></div><span>加载文件列表...</span></div>';

    apiGet('/admin/files/pending-upgrade?page=' + adminFilesState.filePage + '&limit=' + adminFilesState.fileLimit).then(function(res) {
      if (res.code !== 0) {
        listEl.innerHTML = '<div class="af-empty">加载失败</div>';
        return;
      }
      var files = res.data.files || [];
      adminFilesState.files = files;
      adminFilesState.fileTotal = res.data.total || 0;
      adminFilesState.total = res.data.total || 0;
      renderAdminFilesList();
      renderAdminFilesPager();
      updateStatsCards();
    }).catch(function() {
      listEl.innerHTML = '<div class="af-empty">网络错误</div>';
    });
  }

  function renderAdminFilesPager() {
    var pagerEl = $('#af-pager');
    if (!pagerEl) return;
    var totalPages = Math.max(1, Math.ceil(adminFilesState.fileTotal / adminFilesState.fileLimit));
    pagerEl.innerHTML = '';
    pagerEl.style.display = totalPages > 1 ? 'flex' : 'none';

    var info = document.createElement('span');
    info.className = 'af-pager-info';
    info.textContent = '第 ' + adminFilesState.filePage + ' / ' + totalPages + ' 页，共 ' + adminFilesState.fileTotal + ' 个文件';
    pagerEl.appendChild(info);

    var prevBtn = document.createElement('button');
    prevBtn.className = 'af-btn-sm';
    prevBtn.textContent = '‹ 上一页';
    prevBtn.disabled = adminFilesState.filePage <= 1;
    prevBtn.addEventListener('click', function() {
      if (adminFilesState.filePage > 1) loadAdminFilesList(adminFilesState.filePage - 1);
    });
    pagerEl.appendChild(prevBtn);

    var nextBtn = document.createElement('button');
    nextBtn.className = 'af-btn-sm';
    nextBtn.textContent = '下一页 ›';
    nextBtn.disabled = adminFilesState.filePage >= totalPages;
    nextBtn.addEventListener('click', function() {
      if (adminFilesState.filePage < totalPages) loadAdminFilesList(adminFilesState.filePage + 1);
    });
    pagerEl.appendChild(nextBtn);
  }

  function updateStatsCards() {
    var pendingNum = $('#af-pending-num');
    var userCount = $('#af-user-count');
    if (pendingNum) pendingNum.textContent = adminFilesState.total || 0;
    // 用户数从 statsRes 获取，这里只更新待升级数
  }

  function renderAdminFilesList() {
    var listEl = $('#af-list');
    if (!listEl) return;
    var files = adminFilesState.files;

    if (files.length === 0) {
      listEl.innerHTML = '<div class="af-success-msg"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 所有文件已升级完成，无需处理</div>';
      return;
    }

    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['文件名', '所有者', '大小', '加密版本', '创建时间', '操作'].forEach(function(label) {
      var th = el('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);

    var tbody = el('tbody');
    files.forEach(function(f) {
      var tr = el('tr');

      var tdName = el('td');
      tdName.className = 'td-email';
      tdName.textContent = f.name;
      tdName.title = f.name;

      var tdOwner = el('td');
      tdOwner.style.color = 'var(--text-secondary)';
      tdOwner.style.fontSize = '12px';
      tdOwner.textContent = f.owner_email || '-';

      var tdSize = el('td');
      tdSize.style.color = 'var(--text-secondary)';
      tdSize.style.fontSize = '12px';
      tdSize.textContent = formatFileSize(f.size);

      var tdEnc = el('td');

      var tdTime = el('td');
      tdTime.style.color = 'var(--text-muted)';
      tdTime.style.fontSize = '12px';
      tdTime.textContent = f.created_at ? f.created_at.substring(0, 16) : '-';

      var tdAct = el('td');
      var btn = el('button', 'af-btn-sm af-btn-primary');
      btn.textContent = '升级';
      btn.addEventListener('click', function() { upgradeSingleFile(f.id); });

      tdAct.appendChild(btn);
      tr.appendChild(tdName);
      tr.appendChild(tdOwner);
      tr.appendChild(tdSize);
      tdEnc.innerHTML = formatEncVersionBadge(0);
      tr.appendChild(tdEnc);
      tr.appendChild(tdTime);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    listEl.innerHTML = '';
    listEl.appendChild(table);

    // 移动端卡片
    var cardList = $('#af-card-list');
    if (cardList) {
      if (files.length === 0) {
        cardList.innerHTML = '<div class="af-empty">所有文件已升级完成，无需处理</div>';
      } else {
        cardList.innerHTML = '';
        files.forEach(function(f) {
          var card = el('div', 'admin-user-card');
          card.innerHTML =
            '<div class="admin-user-card-header">' +
              '<span class="admin-user-card-email" style="word-break:break-all">' + escHtml(f.name || '') + '</span>' +
              formatEncVersionBadge(0) +
            '</div>' +
            '<div class="admin-user-card-row"><span>所有者:</span><span>' + escHtml(f.owner_email || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>大小:</span><span style="font-family:\'Share Tech Mono\',monospace">' + formatFileSize(f.size) + '</span></div>' +
            '<div class="admin-user-card-row"><span>创建:</span><span style="font-size:11px;color:var(--text-muted)">' + (f.created_at ? f.created_at.substring(0, 16) : '-') + '</span></div>' +
            '<div class="admin-user-card-actions">' +
              '<button class="af-btn af-btn-sm af-btn-primary" data-fileid="' + f.id + '">升级</button>' +
            '</div>';
          cardList.appendChild(card);
        });
        // 绑定升级按钮
        cardList.querySelectorAll('[data-fileid]').forEach(function(btn) {
          var fid = parseInt(btn.dataset.fileid, 10);
          btn.addEventListener('click', function() { upgradeSingleFile(fid); });
        });
      }
    }
  }

  function upgradeNextFile(count) {
    if (adminFilesState.upgrading) {
      showToast('正在升级中，请等待完成', '&#9888;');
      return;
    }
    adminFilesState.upgrading = true;
    var logEl = $('#af-log');
    if (logEl) {
      logEl.style.display = 'block';
      appendLog(logEl, '[' + ts() + '] 开始批量升级 ' + count + ' 个文件...');
    }
    apiPost('/admin/files/upgrade-batch', { limit: count || 1 }).then(function(res) {
      if (res.code !== 0) {
        showToast(res.message || '升级失败', '&#9888;');
        adminFilesState.upgrading = false;
        return;
      }
      var data = res.data || {};
      if (logEl) {
        appendLog(logEl, '[' + ts() + '] 完成: 成功 ' + data.success + ' 个，失败 ' + data.failed + ' 个');
        if (data.results) {
          data.results.forEach(function(r) {
            if (r.skipped) {
              appendLog(logEl, '  跳过: ' + r.name);
            } else {
              appendLog(logEl, '  成功: ' + r.name + (r.new_size ? ' (' + formatFileSize(r.new_size) + ')' : ''));
            }
          });
        }
        if (data.errors) {
          data.errors.forEach(function(e) {
            appendLog(logEl, '  失败: ' + e.name + ' - ' + e.error);
          });
        }
      }
      loadAdminFilesList();
      refreshUpgradeBadge();
      showToast('批量升级完成，成功: ' + data.success + ' 失败: ' + data.failed, '&#10004;');
      adminFilesState.upgrading = false;
    }).catch(function() {
      if (logEl) appendLog(logEl, '[' + ts() + '] 网络错误');
      showToast('网络错误', '&#9888;');
      adminFilesState.upgrading = false;
    });
  }

  function upgradeSingleFile(fileId) {
    if (adminFilesState.upgrading) {
      showToast('正在升级中，请稍后', '&#9888;');
      return;
    }
    adminFilesState.upgrading = true;
    apiPost('/admin/files/upgrade/' + fileId, {}).then(function(res) {
      if (res.code === 0 && res.data) {
        var d = res.data;
        if (d.already_upgraded || d.already_v1) {
          showToast('文件已是 V1 格式', '&#10004;');
        } else if (d.not_encrypted) {
          showToast('文件未加密，无需升级', '&#10004;');
        } else if (d.ok) {
          showToast('升级成功', '&#10004;');
        }
      } else {
        showToast(res.message || '升级失败', '&#9888;');
      }
      loadAdminFilesList();
      refreshUpgradeBadge();
      adminFilesState.upgrading = false;
    }).catch(function() {
      showToast('网络错误', '&#9888;');
      adminFilesState.upgrading = false;
    });
  }

  function refreshUpgradeBadge() {
    apiGet('/admin/files/upgrade-stats').then(function(statsRes) {
      if (statsRes.code !== 0) return;
      var pendingTotal = statsRes.data.total_pending || 0;
      var badge = $('#upgrade-badge');
      if (badge) {
        if (pendingTotal > 0) {
          badge.textContent = pendingTotal > 99 ? '99+' : pendingTotal;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    });
  }

  // ========== 自动升级功能 ==========
  function startAutoUpgrade() {
    if (adminFilesState.autoUpgradeTimer) {
      clearInterval(adminFilesState.autoUpgradeTimer);
    }
    if (!adminFilesState.autoUpgrade) return;

    adminFilesState.autoUpgradeTimer = setInterval(function() {
      if (!adminFilesState.autoUpgrade) {
        stopAutoUpgrade();
        return;
      }
      if (adminFilesState.upgrading) return;

      // 获取当前待升级数
      apiGet('/admin/files/upgrade-stats').then(function(res) {
        if (res.code !== 0 || !res.data || res.data.total_pending <= 0) {
          stopAutoUpgrade();
          var autoCheck = $('#af-auto-upgrade-check');
          if (autoCheck) autoCheck.checked = false;
          showToast('所有文件已升级完成，自动升级已关闭', '&#10004;');
          return;
        }
        // 自动升级 1 个文件
        doAutoUpgradeOne();
      }).catch(function() {});
    }, 30000); // 每 30 秒检查一次
  }

  function stopAutoUpgrade() {
    if (adminFilesState.autoUpgradeTimer) {
      clearInterval(adminFilesState.autoUpgradeTimer);
      adminFilesState.autoUpgradeTimer = null;
    }
  }

  function doAutoUpgradeOne() {
    if (adminFilesState.upgrading) return;
    adminFilesState.upgrading = true;

    apiPost('/admin/files/upgrade-batch', { limit: 1 }).then(function(res) {
      if (res.code === 0 && res.data) {
        var d = res.data;
        var logEl = $('#af-log');
        if (logEl) {
          if (d.success > 0 && d.results && d.results[0]) {
            appendLog(logEl, '[' + ts() + '] 自动升级成功: ' + d.results[0].name);
          } else if (d.failed > 0 && d.errors && d.errors[0]) {
            appendLog(logEl, '[' + ts() + '] 自动升级失败: ' + d.errors[0].name + ' - ' + d.errors[0].error);
          }
        }
      }
      loadAdminFilesList();
      refreshUpgradeBadge();
      adminFilesState.upgrading = false;
    }).catch(function() {
      adminFilesState.upgrading = false;
    });
  }

  function ts() {
    return new Date().toLocaleTimeString();
  }

  function appendLog(el, text) {
    var p = document.createElement('p');
    p.textContent = text;
    el.appendChild(p);
    el.scrollTop = el.scrollHeight;
  }

  // ==================== 分享管理 ====================
  var adminSharesState = {
    shares: [],
    total: 0,
    page: 1,
    limit: 20,
    loading: false,
    searchKeyword: ''
  };

  function loadAdminShares() {
    var container = $('#page-panel-body');
    if (!container) return;
    adminSharesState.loading = true;
    container.innerHTML = '<div id="as-body" class="af-body"></div>';
    var body = $('#as-body');
    body.innerHTML = '';

    // 筛选栏
    var filterRow = el('div', 'as-filter-row');
    var searchWrap = el('div', 'as-user-search-wrap');
    var searchInput = el('input', 'af-admin-search');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索分享内容或用户邮箱...';
    searchInput.id = 'as-search-input';
    var searchBtn = el('button', 'af-btn af-btn-primary');
    searchBtn.textContent = '搜索';
    searchBtn.addEventListener('click', function() {
      adminSharesState.searchKeyword = searchInput.value.trim();
      adminSharesState.page = 1;
      fetchShares();
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        adminSharesState.searchKeyword = searchInput.value.trim();
        adminSharesState.page = 1;
        fetchShares();
      }
    });
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchBtn);
    filterRow.appendChild(searchWrap);

    var tableWrap = el('div', 'admin-table-wrap');
    var listDiv = el('div', 'as-list');
    listDiv.id = 'as-list';
    var tip = el('div', 'af-tip');
    tip.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 显示所有用户的分享记录，含查看/下载次数统计';
    tableWrap.appendChild(tip);
    tableWrap.appendChild(listDiv);
    body.appendChild(filterRow);
    body.appendChild(tableWrap);

    // 移动端卡片列表
    var cardList = el('div', 'admin-card-list af-card-list');
    cardList.id = 'as-card-list';
    body.appendChild(cardList);

    var pager = el('div', 'as-pager');
    body.appendChild(pager);

    adminSharesState.loading = false;
    console.log('[admin-shares] before fetchShares, #as-list:', !!$('#as-list'), '#as-body:', !!$('#as-body'));

    fetchShares();
  }

  function fetchShares() {
    var listEl = $('#as-list');
    var pagerEl = $('.as-pager');
    console.log('[fetchShares] listEl:', !!listEl, 'pagerEl:', !!pagerEl);
    if (!listEl) return;
    listEl.innerHTML = '<div class="af-loading" style="padding:20px"><div class="af-spinner"></div><span>加载中...</span></div>';
    var url = '/admin/shares?page=' + adminSharesState.page + '&limit=' + adminSharesState.limit;
    if (adminSharesState.searchKeyword) url += '&keyword=' + encodeURIComponent(adminSharesState.searchKeyword);
    console.log('[fetchShares] requesting:', url);
    apiGet(url).then(function(res) {
      console.log('[fetchShares] response:', JSON.stringify(res).substring(0, 300));
      adminSharesState.shares = res.data.shares || [];
      adminSharesState.total = res.data.total || 0;
      renderAdminShares();
      renderSharesPager(pagerEl);
    }).catch(function() { listEl.innerHTML = '<div class="af-empty">网络错误</div>'; });
  }

  function renderAdminShares() {
    var listEl = $('#as-list');
    if (!listEl) return;
    var shares = adminSharesState.shares;
    if (shares.length === 0) {
      listEl.innerHTML = '<div class="af-empty">暂无分享记录</div>';
      return;
    }
    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['分享信息', '类型', '所有者', '有效期', '查看/下载', '操作'].forEach(function(label) {
      var th = el('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');
    shares.forEach(function(s) {
      var tr = el('tr');
      var expiryText = s.expires_at ? s.expires_at.substring(0, 10) : '永久';
      var isExpired = s.expires_at && new Date(s.expires_at) < new Date();
      var typeLabel = (s.target_type === 'dir' || (s.target_type === 'public' && s.is_directory)) ? '文件夹' : s.target_type === 'mixed' ? '批量' : '文件';
      var typeClass = s.target_type === 'dir' ? 'type-dir' : s.target_type === 'mixed' ? 'type-mixed' : 'type-file';
      var createdText = s.created_at ? s.created_at.substring(0, 10) : '-';

      tr.innerHTML =
        '<td>' +
          '<div class="as-share-info">' +
            '<div class="as-hash">' +
              '<span class="as-hash-code">' + escHtml(s.share_hash || '') + '</span>' +
              '<button class="as-copy-btn" onclick="window.__fm && window.__fm.copyShareLink(\'' + escHtml(s.share_hash || '') + '\')" title="复制链接">&#128203;</button>' +
            '</div>' +
            '<div class="as-target" title="' + escHtml(s.target_name || '') + '">' + escHtml((s.target_name || '').substring(0, 24)) + '</div>' +
          '</div>' +
        '</td>' +
        '<td><span class="share-type-badge ' + typeClass + '">' + typeLabel + '</span></td>' +
        '<td class="td-email" style="font-size:12px;color:var(--text-muted)">' + escHtml(s.owner_email || '-') + '</td>' +
        '<td><span class="as-expiry ' + (isExpired ? 'expired' : '') + '">' + expiryText + '</span></td>' +
        '<td>' +
          '<div class="as-stats">' +
            '<span class="as-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg> ' + (s.view_count || 0) + '</span>' +
            '<span class="as-stat"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> ' + (s.download_count || 0) + '</span>' +
          '</div>' +
        '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="admin-btn as-toggle-btn" data-share-id="' + s.id + '" data-action="' + (s.disabled ? 'enable' : 'disable') + '" style="margin-right:4px">' + (s.disabled ? '启用' : '禁用') + '</button>' +
          '<button class="admin-btn" data-share-id="' + s.id + '" data-share-hash="' + escHtml(s.share_hash || '') + '" data-share-name="' + escHtml(s.target_name || '') + '">日志</button>' +
        '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    listEl.innerHTML = '';
    listEl.appendChild(table);

    // 绑定桌面端表格中的日志按钮（仅匹配有 data-share-hash 的，排除禁用/启用按钮）
    listEl.querySelectorAll('[data-share-hash]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        showShareLogs(parseInt(btn.dataset.shareId), btn.dataset.shareHash, btn.dataset.shareName);
      });
    });
    // 绑定禁用/启用按钮
    listEl.querySelectorAll('.as-toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var shareId = parseInt(btn.dataset.shareId);
        axios.patch('/api/share/' + shareId + '/toggle-disabled').then(function(res) {
          if (res.data.code === 0) { showToast(res.data.message); fetchShares(); }
          else showToast(res.data.message || '操作失败', '&#9888;');
        }).catch(function() { showToast('操作失败', '&#9888;'); });
      });
    });

    // 移动端卡片
    var cardList = $('#as-card-list');
    if (cardList) {
      if (shares.length === 0) {
        cardList.innerHTML = '<div class="af-empty">暂无分享记录</div>';
      } else {
        cardList.innerHTML = '';
        shares.forEach(function(s) {
          var expiryText = s.expires_at ? s.expires_at.substring(0, 10) : '永久';
          var isExpired = s.expires_at && new Date(s.expires_at) < new Date();
          var typeLabel = (s.target_type === 'dir' || (s.target_type === 'public' && s.is_directory)) ? '文件夹' : s.target_type === 'mixed' ? '批量' : '文件';
          var card = el('div', 'admin-user-card');
          card.innerHTML =
            '<div class="admin-user-card-header">' +
              '<span class="share-type-badge share-type-badge-sm" style="background:rgba(0,212,255,0.12);color:var(--accent);padding:2px 8px;border-radius:12px;font-size:10px">' + typeLabel + '</span>' +
              '<span class="as-expiry ' + (isExpired ? 'expired' : '') + '" style="font-size:11px">' + expiryText + '</span>' +
            '</div>' +
            '<div class="admin-user-card-row"><span>分享码:</span><span style="font-family:\'Share Tech Mono\',monospace;font-size:11px">' + escHtml((s.share_hash || '').substring(0, 8)) + '</span></div>' +
            '<div class="admin-user-card-row"><span>文件名:</span><span style="font-size:11px;word-break:break-all">' + escHtml(s.target_name || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>所有者:</span><span style="font-size:11px">' + escHtml(s.owner_email || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>查看:</span><span>' + (s.view_count || 0) + '</span><span>下载:</span><span>' + (s.download_count || 0) + '</span></div>' +
            '<div class="admin-user-card-actions">' +
              '<button class="admin-btn as-toggle-btn" data-share-id="' + s.id + '" data-action="' + (s.disabled ? 'enable' : 'disable') + '">' + (s.disabled ? '启用' : '禁用') + '</button>' +
              '<button class="admin-btn" data-share-id="' + s.id + '" data-share-hash="' + escHtml(s.share_hash || '') + '" data-share-name="' + escHtml(s.target_name || '') + '">日志</button>' +
            '</div>';
          cardList.appendChild(card);
        });
        // 绑定禁用/启用按钮
        cardList.querySelectorAll('.as-toggle-btn').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var shareId = parseInt(btn.dataset.shareId);
            axios.patch('/api/share/' + shareId + '/toggle-disabled').then(function(res) {
              if (res.data.code === 0) { showToast(res.data.message); fetchShares(); }
              else showToast(res.data.message || '操作失败', '&#9888;');
            }).catch(function() { showToast('操作失败', '&#9888;'); });
          });
        });
        // 绑定日志按钮（仅匹配有 data-share-hash 的）
        cardList.querySelectorAll('[data-share-hash]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            showShareLogs(parseInt(btn.dataset.shareId), btn.dataset.shareHash, btn.dataset.shareName);
          });
        });
      }
    }
  }

  function renderSharesPager(pagerEl) {
    if (!pagerEl) return;
    pagerEl.innerHTML = '';
    var total = adminSharesState.total;
    var page = adminSharesState.page;
    var limit = adminSharesState.limit;
    var totalPages = Math.ceil(total / limit);
    if (totalPages <= 1) return;
    var prevBtn = el('button', 'af-btn af-btn-default');
    prevBtn.textContent = '上一页';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', function() { if (adminSharesState.page > 1) { adminSharesState.page--; fetchShares(); } });
    var nextBtn = el('button', 'af-btn af-btn-default');
    nextBtn.textContent = '下一页';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', function() { if (adminSharesState.page < totalPages) { adminSharesState.page++; fetchShares(); } });
    var pageInfo = el('span');
    pageInfo.textContent = '第 ' + page + ' / ' + totalPages + ' 页，共 ' + total + ' 条';
    pageInfo.style.cssText = 'font-size:12px;color:var(--text-muted);padding:0 12px;';
    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(pageInfo);
    pagerEl.appendChild(nextBtn);
  }

  function showShareLogs(shareId, shareHash, shareName) {
    var overlay = el('div', 'modal-overlay');
    overlay.innerHTML = '<div class="modal-content" style="max-width:900px;max-height:80vh;display:flex;flex-direction:column;gap:12px;padding:20px"><div style="display:flex;align-items:center;justify-content:space-between"><div style="font-weight:600">' + (shareName || shareHash) + ' 访问日志</div><button id="ml-close" style="padding:4px 12px;background:rgba(255,255,255,0.1);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer">关闭</button></div><div id="ml-list" style="overflow:auto;flex:1;min-height:200px"><div class="af-loading"><div class="af-spinner"></div><span>加载中...</span></div></div></div>';
    document.body.appendChild(overlay);
    $('#ml-close').addEventListener('click', function() { document.body.removeChild(overlay); });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) document.body.removeChild(overlay); });
    apiGet('/admin/shares/' + shareId + '/logs?page=1&limit=100').then(function(res) {
      var listEl = $('#ml-list');
      if (res.code !== 0) { listEl.innerHTML = '<div class="af-empty">加载失败</div>'; return; }
      var logs = res.data.logs || [];
      if (logs.length === 0) { listEl.innerHTML = '<div class="af-empty">暂无访问记录</div>'; return; }
      var table = el('table', 'admin-table');
      var thead = el('thead');
      var headTr = el('tr');
      ['时间', '类型', 'IP', '用户', '文件', '操作'].forEach(function(label) {
        var th = el('th');
        th.textContent = label;
        headTr.appendChild(th);
      });
      thead.appendChild(headTr);
      var tbody = el('tbody');
      logs.forEach(function(log) {
        var tr = el('tr');
        var typeMap = { view: '查看', browse: '浏览', download: '下载' };
        var typeColor = { view: '#2196f3', browse: '#4caf50', download: '#ff9800' };
        tr.innerHTML =
          '<td style="font-size:12px;color:var(--text-muted)">' + (log.created_at || '').substring(0, 19) + '</td>' +
          '<td><span style="color:' + (typeColor[log.access_type] || '#999') + ';font-weight:600;font-size:12px">' + (typeMap[log.access_type] || log.access_type) + '</span></td>' +
          '<td style="font-family:\'Share Tech Mono\',monospace;font-size:12px">' + (log.ip || '-') + '</td>' +
          '<td style="font-size:12px;color:var(--text-secondary)">' + (log.email || '访客') + '</td>' +
          '<td style="font-size:12px;color:var(--text-muted);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (log.file_name || '') + '">' + (log.file_name || '-') + '</td>' +
          '<td><span style="font-family:\'Share Tech Mono\',monospace;font-size:11px;color:var(--text-muted)">#' + log.id + '</span></td>';
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      listEl.innerHTML = '';
      listEl.appendChild(table);
    });
  }

  // ==================== IP黑名单管理 ====================
  var adminBLState = {
    records: [],
    total: 0,
    page: 1,
    limit: 20,
    loading: false
  };

  function loadAdminBlacklist() {
    console.log('[blacklist] loadAdminBlacklist called');
    var container = $('#page-panel-body');
    console.log('[blacklist] container:', !!container);
    if (!container) return;
    adminBLState.loading = true;
    container.innerHTML = '<div id="bl-body" class="af-body"></div>';
    var body = $('#bl-body');
    console.log('[blacklist] body:', !!body);

    // 添加IP表单
    var addForm = el('div', 'bl-add-form');
    var ipInput = el('input', 'as-input');
    ipInput.type = 'text';
    ipInput.placeholder = 'IP地址';
    ipInput.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);width:180px;font-family:\'Share Tech Mono\',monospace';
    var reasonInput = el('input', 'as-input');
    reasonInput.placeholder = '封禁原因';
    reasonInput.style.cssText = ipInput.style.cssText + ';width:140px;margin-left:8px';
    var daysSelect = el('select', 'as-select');
    daysSelect.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);margin-left:8px';
    [{ label: '永久', value: 0 }, { label: '1天', value: 1 }, { label: '7天', value: 7 }, { label: '30天', value: 30 }].forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      daysSelect.appendChild(o);
    });
    var addBtn = el('button', 'af-btn af-btn-primary');
    addBtn.textContent = '添加封禁';
    addBtn.style.marginLeft = '8px';
    addBtn.addEventListener('click', function() {
      var ip = ipInput.value.trim();
      if (!ip) { showToast('请输入IP地址', '&#9888;'); return; }
      apiPost('/admin/blacklist', {
        ip: ip,
        reason: reasonInput.value.trim(),
        days: parseInt(daysSelect.value, 10)
      }).then(function(res) {
        if (res.code === 0) {
          showToast('已添加封禁', '&#10004;');
          ipInput.value = '';
          reasonInput.value = '';
          fetchBlacklist();
        } else {
          showToast(res.message || '添加失败', '&#9888;');
        }
      });
    });
    addForm.appendChild(ipInput);
    addForm.appendChild(reasonInput);
    addForm.appendChild(daysSelect);
    addForm.appendChild(addBtn);
    body.appendChild(addForm);

    var tableWrap = el('div', 'admin-table-wrap');
    var listDiv = el('div', 'bl-list');
    listDiv.id = 'bl-list';
    tableWrap.appendChild(listDiv);
    body.appendChild(tableWrap);

    // 移动端卡片列表
    var cardList = el('div', 'admin-card-list af-card-list');
    cardList.id = 'bl-card-list';
    body.appendChild(cardList);

    var pager = el('div', 'bl-pager');
    body.appendChild(pager);

    adminBLState.loading = false;
    fetchBlacklist();
  }

  function fetchBlacklist() {
    var listEl = $('#bl-list');
    console.log('[blacklist] fetchBlacklist called, listEl:', !!listEl);
    if (!listEl) return;
    listEl.innerHTML = '<div class="af-loading" style="padding:20px"><div class="af-spinner"></div><span>加载中...</span></div>';
    apiGet('/admin/blacklist?page=' + adminBLState.page + '&limit=' + adminBLState.limit).then(function(res) {
      console.log('[blacklist] response:', JSON.stringify(res).substring(0, 500));
      if (res.code !== 0) { listEl.innerHTML = '<div class="af-empty">加载失败</div>'; return; }
      adminBLState.records = res.data.records || [];
      adminBLState.total = res.data.total || 0;
      renderBlacklist();
      renderBlacklistPager($('.bl-pager'));
    }).catch(function(err) { console.error('[blacklist] error:', err); listEl.innerHTML = '<div class="af-empty">网络错误</div>'; });
  }

  function renderBlacklist() {
    console.log('[blacklist] renderBlacklist called, records:', adminBLState.records.length);
    var listEl = $('#bl-list');
    console.log('[blacklist] listEl:', !!listEl);
    if (!listEl) return;
    var records = adminBLState.records;
    if (records.length === 0) {
      listEl.innerHTML = '<div class="af-empty">暂无封禁记录</div>';
      return;
    }
    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['封禁IP', '原因', '级别', '操作者', '封禁时间', '到期时间', '操作'].forEach(function(label) {
      var th = el('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');
    records.forEach(function(r) {
      var tr = el('tr');
      var isPermanent = !r.expires_at;
      var isExpired = r.expires_at && new Date(r.expires_at) < new Date();
      tr.innerHTML =
        '<td>' +
          '<div class="bl-ip-cell">' +
            '<span class="bl-shield">&#x1F6E1;</span>' +
            '<span class="bl-ip">' + escHtml(r.ip || '') + '</span>' +
            (isExpired ? '<span class="bl-expired-tag">已过期</span>' : '') +
          '</div>' +
        '</td>' +
        '<td><span class="bl-reason">' + escHtml(r.reason || '-') + '</span></td>' +
        '<td>' + (r.auto_ban ? '<span class="bl-level-tag lv' + (r.ban_level || 1) + '">L' + (r.ban_level || 1) + '</span>' : '<span style="color:var(--text-muted)">手动</span>') + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted)">' + escHtml(r.created_by_email || '-') + '</td>' +
        '<td style="font-size:11px;color:var(--text-muted);font-family:\'Share Tech Mono\',monospace">' + (r.created_at ? r.created_at.substring(0, 16).replace('T', ' ') : '-') + '</td>' +
        '<td>' +
          '<span class="bl-expiry ' + (isExpired ? 'expired' : '') + '">' +
            (isPermanent ? '<span class="bl-permanent">永久</span>' : (r.expires_at ? r.expires_at.substring(0, 16).replace('T', ' ') : '-')) +
          '</span>' +
        '</td>' +
        '<td><button class="admin-btn danger" data-blid="' + r.id + '">移除</button></td>';
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    listEl.innerHTML = '';
    listEl.appendChild(table);

    // 绑定桌面端表格的移除按钮
    listEl.querySelectorAll('[data-blid]').forEach(function(btn) {
      var id = parseInt(btn.dataset.blid, 10);
      btn.addEventListener('click', function() {
        if (confirm('确认移除该IP封禁?')) {
          apiDelete('/admin/blacklist/' + id).then(function(res) {
            if (res.code === 0) { showToast('已移除', '&#10004;'); fetchBlacklist(); }
            else showToast(res.message || '失败', '&#9888;');
          });
        }
      });
    });

    // 移动端卡片
    var cardList = $('#bl-card-list');
    if (cardList) {
      if (records.length === 0) {
        cardList.innerHTML = '<div class="af-empty">暂无封禁记录</div>';
      } else {
        cardList.innerHTML = '';
        records.forEach(function(r) {
          var isPermanent = !r.expires_at;
          var isExpired = r.expires_at && new Date(r.expires_at) < new Date();
          var card = el('div', 'admin-user-card');
          card.innerHTML =
            '<div class="admin-user-card-header">' +
              '<span class="admin-user-card-email" style="font-family:\'Share Tech Mono\',monospace">' + escHtml(r.ip || '') + '</span>' +
              (isExpired ? '<span style="font-size:10px;padding:2px 6px;background:rgba(239,68,68,0.1);color:var(--error);border-radius:10px">已过期</span>' : '') +
            '</div>' +
            '<div class="admin-user-card-row"><span>原因:</span><span>' + escHtml(r.reason || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>操作者:</span><span style="font-size:11px">' + escHtml(r.created_by_email || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>封禁:</span><span style="font-size:11px;font-family:\'Share Tech Mono\',monospace">' + (r.created_at ? r.created_at.substring(0, 16).replace('T', ' ') : '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>到期:</span><span style="font-size:11px">' + (isPermanent ? '永久' : (r.expires_at ? r.expires_at.substring(0, 16).replace('T', ' ') : '-')) + '</span></div>' +
            '<div class="admin-user-card-actions">' +
              '<button class="admin-btn danger" data-blid="' + r.id + '">移除</button>' +
            '</div>';
          cardList.appendChild(card);
        });
        // 绑定移动端移除按钮
        cardList.querySelectorAll('[data-blid]').forEach(function(btn) {
          var id = parseInt(btn.dataset.blid, 10);
          btn.addEventListener('click', function() {
            if (confirm('确认移除该IP封禁?')) {
              apiDelete('/admin/blacklist/' + id).then(function(res) {
                if (res.code === 0) { showToast('已移除', '&#10004;'); fetchBlacklist(); }
                else showToast(res.message || '失败', '&#9888;');
              });
            }
          });
        });
      }
    }
  }

  function renderBlacklistPager(pagerEl) {
    if (!pagerEl) return;
    pagerEl.innerHTML = '';
    var total = adminBLState.total;
    var page = adminBLState.page;
    var limit = adminBLState.limit;
    var totalPages = Math.ceil(total / limit);
    if (totalPages <= 1) return;
    var prevBtn = el('button', 'af-btn af-btn-default');
    prevBtn.textContent = '上一页';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', function() { if (adminBLState.page > 1) { adminBLState.page--; fetchBlacklist(); } });
    var nextBtn = el('button', 'af-btn af-btn-default');
    nextBtn.textContent = '下一页';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', function() { if (adminBLState.page < totalPages) { adminBLState.page++; fetchBlacklist(); } });
    var pageInfo = el('span');
    pageInfo.textContent = '第 ' + page + ' / ' + totalPages + ' 页，共 ' + total + ' 条';
    pageInfo.style.cssText = 'font-size:12px;color:var(--text-muted);padding:0 12px;';
    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(pageInfo);
    pagerEl.appendChild(nextBtn);
  }

  // ==================== 流量管理 ====================
  var quotaState = {
    rows: [],
    period: '',
    userCount: 0,
    guestCount: 0,
    filterKeyword: '',
    filterType: 'all'
  };

  var trafficState = {
    activeTab: 'summary',
    selectedUserId: 0,
    selectedGuestIp: '',
    groupBy: 'day',
    startDate: new Date().toISOString().substring(0, 7) + '-01',
    endDate: (function() { var d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().substring(0, 10); })(),
    summary: [],
    chartData: [],
    logs: [],
    logTotal: 0,
    logPage: 1,
    logLimit: 20,
    users: [],
    guestIps: []
  };

  // ==================== 频率限制管理页面 ====================

  var rlState = { rules: null, whitelist: null, editingRule: null };

  function loadAdminRateLimit() {
    var container = $('#page-panel-body');
    if (!container) return;
    var result = makeAdminHeader('⏱ 频率限制配置', null, null, null);
    container.innerHTML = '';
    container.appendChild(result.wrap);
    var body = result.content;
    body.id = 'rl-body';
    body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)">加载中...</div>';
    fetchRateLimitData();
  }

  function fetchRateLimitData() {
    Promise.all([
      apiGet('/admin/rate-limit/rules'),
      apiGet('/admin/rate-limit/whitelist')
    ]).then(function(results) {
      var rulesData = results[0];
      var wlData = results[1];
      rlState.rules = rulesData.data;
      rlState.whitelist = wlData.data.whitelist;
      renderRateLimitPage();
    }).catch(function(e) {
      var body = $('#rl-body');
      if (body) body.innerHTML = '<div style="text-align:center;padding:40px;color:red">加载失败: ' + (e.message || '网络错误') + '</div>';
    });
  }

  function renderRateLimitPage() {
    var body = $('#rl-body');
    if (!body) return;
    var h = '';

    // ---- 已登录用户规则 ----
    h += '<div class="rl-section">';
    h += '<div class="rl-section-header"><span class="rl-section-icon">&#128274;</span> 已登录用户规则</div>';
    var authRules = (rlState.rules && rlState.rules.authenticated) ? rlState.rules.authenticated : [];
    h += renderRuleTable('authenticated', authRules);
    // Mobile cards for auth rules
    h += '<div class="admin-card-list af-card-list" style="margin-top:8px">';
    h += renderRuleCards(authRules);
    h += '</div>';
    h += '<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="window.__rlAddRule(\'authenticated\')">+ 添加规则</button></div>';
    h += '</div>';

    // ---- 未登录用户规则 ----
    h += '<div class="rl-section">';
    h += '<div class="rl-section-header"><span class="rl-section-icon">&#127760;</span> 未登录用户规则</div>';
    var anonRules = (rlState.rules && rlState.rules.anonymous) ? rlState.rules.anonymous : [];
    h += renderRuleTable('anonymous', anonRules);
    // Mobile cards for anon rules
    h += '<div class="admin-card-list af-card-list" style="margin-top:8px">';
    h += renderRuleCards(anonRules);
    h += '</div>';
    h += '<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="window.__rlAddRule(\'anonymous\')">+ 添加规则</button></div>';
    h += '</div>';

    // ---- 路径白名单 ----
    h += '<div class="rl-section">';
    h += '<div class="rl-section-header"><span class="rl-section-icon">&#9989;</span> 不受限制的路径（白名单）</div>';
    h += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>路径</th><th>描述</th><th>状态</th><th style="width:80px">操作</th></tr></thead><tbody>';
    var wl = rlState.whitelist || [];
    if (wl.length === 0) {
      h += '<tr><td colspan="4" style="text-align:center;color:var(--text-secondary)">暂无白名单</td></tr>';
    } else {
      wl.forEach(function(w) {
        h += '<tr><td><code>' + escHtml(w.path) + '</code></td><td>' + escHtml(w.description || '') + '</td>';
        h += '<td>' + (w.is_enabled ? '<span style="color:#10b981">启用</span>' : '<span style="color:var(--text-secondary)">禁用</span>') + '</td>';
        h += '<td><button class="btn btn-sm btn-outline" onclick="window.__rlDeleteWhitelist(' + w.id + ')">删除</button></td></tr>';
      });
    }
    h += '</tbody></table></div>';
    // Mobile whitelist cards
    h += '<div class="admin-card-list af-card-list" style="margin-top:8px">';
    if (wl.length === 0) {
      h += '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">暂无白名单</div>';
    } else {
      wl.forEach(function(w) {
        h += '<div class="admin-user-card" style="margin-bottom:8px">' +
          '<div class="admin-user-card-header">' +
            '<span style="font-family:monospace;font-size:12px;color:var(--accent);word-break:break-all">' + escHtml(w.path) + '</span>' +
            '<span>' + (w.is_enabled ? '<span style="color:#10b981;font-weight:600">✅ 启用</span>' : '<span style="color:var(--text-muted)">❌ 禁用</span>') + '</span>' +
          '</div>' +
          '<div class="admin-user-card-row"><span>描述</span><span>' + escHtml(w.description || '-') + '</span></div>' +
          '<div class="admin-user-card-actions">' +
            '<button class="btn btn-sm btn-outline" onclick="window.__rlDeleteWhitelist(' + w.id + ')" style="color:#e74c3c">删除</button>' +
          '</div>' +
        '</div>';
      });
    }
    h += '</div>';
    h += '<div style="margin-top:8px;display:flex;gap:8px"><input type="text" id="rl-wl-path" placeholder="路径，如 /api/xxx" style="flex:1;padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:12px"><input type="text" id="rl-wl-desc" placeholder="描述（可选）" style="flex:1;padding:5px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:12px"><button class="btn btn-sm btn-primary" onclick="window.__rlAddWhitelist()">添加白名单</button></div>';
    h += '</div>';

    // 提示
    h += '<div style="margin-top:16px;padding:12px;background:var(--bg-card);border-radius:var(--radius);font-size:12px;color:var(--text-secondary);line-height:1.6">';
    h += '<strong>&#128161; 提示：</strong><br>';
    h += '• 阈值按 <strong>排序值(sort_order)从小到大</strong> 匹配，命中最高等级即封禁<br>';
    h += '• 封禁时长 0 秒 = <strong>永久封禁</strong><br>';
    h += '• 规则和白名单修改后 <strong>立即生效</strong>（自动刷新缓存）<br>';
    h += '• 静态资源（/files/, /public/, .js/.css/.png 等）和 localhost 始终不受限<br>';
    h += '• WebDAV 有效 token 按<strong>已登录</strong>规则，无效 token 按<strong>未登录</strong>规则';
    h += '</div>';

    body.innerHTML = h;
  }

  function renderRuleTable(userType, rules) {
    var h = '<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th style="width:40px">排序</th><th>时间窗口(秒)</th><th>最大请求数</th><th>封禁时长</th><th style="width:60px">启用</th><th style="width:100px">操作</th></tr></thead><tbody>';
    if (rules.length === 0) {
      h += '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary)">暂无规则</td></tr>';
    } else {
      rules.forEach(function(r) {
        var banLabel = formatBanDuration(r.ban_duration_seconds);
        h += '<tr>';
        h += '<td>' + (r.sort_order || 0) + '</td>';
        h += '<td>' + r.window_seconds + '</td>';
        h += '<td>' + r.max_requests + '</td>';
        h += '<td>' + banLabel + '</td>';
        h += '<td>' + (r.is_enabled ? '<span style="color:#10b981">&#10003;</span>' : '<span style="color:var(--text-secondary)">&#10007;</span>') + '</td>';
        h += '<td>';
        h += '<button class="btn btn-sm btn-outline" onclick="window.__rlEditRule(' + r.id + ')" style="margin-right:4px">编辑</button>';
        h += '<button class="btn btn-sm btn-outline" onclick="window.__rlDeleteRule(' + r.id + ')" style="color:#e74c3c">删除</button>';
        h += '</td></tr>';
      });
    }
    h += '</tbody></table></div>';
    return h;
  }

  function renderRuleCards(rules) {
    var h = '';
    if (rules.length === 0) {
      h += '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">暂无规则</div>';
    } else {
      rules.forEach(function(r) {
        var banLabel = formatBanDuration(r.ban_duration_seconds).replace(/<[^>]+>/g, '');
        var enabledHtml = r.is_enabled ? '<span style="color:#10b981;font-weight:600">✅ 启用</span>' : '<span style="color:var(--text-muted)">❌ 禁用</span>';
        h += '<div class="admin-user-card" style="margin-bottom:8px">' +
          '<div class="admin-user-card-header">' +
            '<span style="font-weight:600;font-size:13px">排序: ' + (r.sort_order || 0) + '</span>' +
            enabledHtml +
          '</div>' +
          '<div class="admin-user-card-row"><span>时间窗口</span><span>' + r.window_seconds + ' 秒</span></div>' +
          '<div class="admin-user-card-row"><span>最大请求数</span><span>' + r.max_requests + '</span></div>' +
          '<div class="admin-user-card-row"><span>封禁时长</span><span>' + banLabel + '</span></div>' +
          '<div class="admin-user-card-actions">' +
            '<button class="btn btn-sm btn-outline" onclick="window.__rlEditRule(' + r.id + ')" style="margin-right:4px">编辑</button>' +
            '<button class="btn btn-sm btn-outline" style="color:#e74c3c" onclick="window.__rlDeleteRule(' + r.id + ')">删除</button>' +
          '</div>' +
        '</div>';
      });
    }
    return h;
  }

  function formatBanDuration(seconds) {
    if (seconds === 0) return '<span style="color:#e74c3c;font-weight:700">永久</span>';
    if (seconds < 60) return seconds + '秒';
    if (seconds < 3600) return Math.round(seconds / 60) + '分钟';
    if (seconds < 86400) return Math.round(seconds / 3600) + '小时';
    if (seconds < 2592000) return Math.round(seconds / 86400) + '天';
    if (seconds < 31536000) return Math.round(seconds / 2592000) + '月';
    return Math.round(seconds / 31536000) + '年';
  }

  function parseBanDuration(value, unit) {
    var multipliers = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
    return (parseInt(value, 10) || 0) * (multipliers[unit] || 1);
  }

  // 全局函数暴露（供 onclick 调用）
  window.__rlRefresh = function() { fetchRateLimitData(); };

  window.__rlAddRule = function(userType) {
    showRuleModal(null, userType);
  };

  window.__rlEditRule = function(id) {
    var allRules = [];
    if (rlState.rules) {
      allRules = allRules.concat(rlState.rules.authenticated || [], rlState.rules.anonymous || []);
    }
    var rule = allRules.find(function(r) { return r.id === id; });
    if (rule) showRuleModal(rule, rule.user_type);
  };

  window.__rlDeleteRule = function(id) {
    if (!confirm('确定删除此规则？')) return;
    apiDelete('/admin/rate-limit/rules/' + id).then(function(r) {
      if (r.code === 0) { window.__rlRefresh(); } else { alert('删除失败：' + r.message); }
    }).catch(function(e) { alert('删除失败：' + (e.message || '网络错误')); });
  };

  window.__rlAddWhitelist = function() {
    var pathInput = $('#rl-wl-path');
    var descInput = $('#rl-wl-desc');
    var p = (pathInput ? pathInput.value.trim() : '');
    if (!p) { alert('请输入路径'); return; }
    if (p.indexOf('/') !== 0) { alert('路径必须以 / 开头'); return; }
    var desc = descInput ? descInput.value.trim() : '';
    apiPost('/admin/rate-limit/whitelist', { path: p, description: desc }).then(function(r) {
      if (r.code === 0) {
        if (pathInput) pathInput.value = '';
        if (descInput) descInput.value = '';
        window.__rlRefresh();
      } else { alert('添加失败：' + r.message); }
    }).catch(function(e) { alert('添加失败：' + (e.message || '网络错误')); });
  };

  window.__rlDeleteWhitelist = function(id) {
    if (!confirm('确定从白名单删除此路径？')) return;
    apiDelete('/admin/rate-limit/whitelist/' + id).then(function(r) {
      if (r.code === 0) { window.__rlRefresh(); } else { alert('删除失败：' + r.message); }
    }).catch(function(e) { alert('删除失败：' + (e.message || '网络错误')); });
  };

  function showRuleModal(rule, userType) {
    var isEdit = !!rule;
    var modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'rl-modal';

    var banDuration = rule ? rule.ban_duration_seconds : 60;
    var durationParts = splitBanDuration(banDuration);

    var presetBtns = '';
    var presets = [
      { label: '1分钟', sec: 60 }, { label: '1小时', sec: 3600 }, { label: '1天', sec: 86400 },
      { label: '7天', sec: 604800 }, { label: '30天', sec: 2592000 }, { label: '1年', sec: 31536000 },
      { label: '永久', sec: 0 }
    ];
    presets.forEach(function(p) {
      var active = (banDuration === p.sec) ? ' rl-preset-active' : '';
      presetBtns += '<button class="btn btn-sm btn-outline rl-preset-btn' + active + '" onclick="window.__rlSetPreset(' + p.sec + ')" data-sec="' + p.sec + '">' + p.label + '</button>';
    });

    modal.innerHTML = '<div class="modal" style="max-width:520px">' +
      '<h3>' + (isEdit ? '编辑规则' : '添加规则') + '</h3>' +
      '<label>用户类型</label>' +
      '<select id="rl-e-user-type" ' + (isEdit ? 'disabled' : '') + ' style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
        '<option value="authenticated"' + (userType === 'authenticated' ? ' selected' : '') + '>已登录用户 (authenticated)</option>' +
        '<option value="anonymous"' + (userType === 'anonymous' ? ' selected' : '') + '>未登录用户 (anonymous)</option>' +
      '</select>' +
      '<label>时间窗口（秒）</label>' +
      '<input type="number" id="rl-e-window" value="' + (rule ? rule.window_seconds : 60) + '" min="1" max="3600" style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
      '<label>最大请求数</label>' +
      '<input type="number" id="rl-e-max-req" value="' + (rule ? rule.max_requests : 1000) + '" min="1" style="width:100%;padding:8px;margin:4px 0 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
      '<label>封禁时长</label>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px">' + presetBtns + '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
        '<span style="font-size:12px;color:var(--text-secondary)">自定义：</span>' +
        '<input type="number" id="rl-e-ban-val" value="' + durationParts.value + '" min="0" style="width:100px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
        '<select id="rl-e-ban-unit" style="padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
          '<option value="second"' + (durationParts.unit === 'second' ? ' selected' : '') + '>秒</option>' +
          '<option value="minute"' + (durationParts.unit === 'minute' ? ' selected' : '') + '>分钟</option>' +
          '<option value="hour"' + (durationParts.unit === 'hour' ? ' selected' : '') + '>小时</option>' +
          '<option value="day"' + (durationParts.unit === 'day' ? ' selected' : '') + '>天</option>' +
          '<option value="month"' + (durationParts.unit === 'month' ? ' selected' : '') + '>月</option>' +
          '<option value="year"' + (durationParts.unit === 'year' ? ' selected' : '') + '>年</option>' +
        '</select>' +
      '</div>' +
      '<label style="margin-top:12px">启用</label>' +
      '<label class="toggle-switch" style="margin-left:8px;vertical-align:middle">' +
        '<input type="checkbox" id="rl-e-enabled" ' + ((rule && rule.is_enabled) || !rule ? 'checked' : '') + '>' +
        '<span class="toggle-slider"></span>' +
      '</label>' +
      '<label style="margin-left:16px">排序值</label>' +
      '<input type="number" id="rl-e-sort" value="' + (rule ? (rule.sort_order || 0) : 0) + '" min="0" style="width:80px;padding:8px;margin-left:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-input);color:var(--text-primary);font-size:14px;font-family:inherit">' +
      '<div class="modal-actions" style="margin-top:16px">' +
        '<button class="btn btn-outline" onclick="window.__rlCloseModal()">取消</button>' +
        '<button class="btn btn-primary" onclick="window.__rlSaveRule(' + (isEdit ? rule.id : -1) + ')">' + (isEdit ? '保存' : '添加') + '</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) window.__rlCloseModal(); });
  }

  function splitBanDuration(totalSeconds) {
    if (totalSeconds === 0) return { value: 0, unit: 'second' };
    if (totalSeconds % 31536000 === 0 && totalSeconds > 0) return { value: totalSeconds / 31536000, unit: 'year' };
    if (totalSeconds % 2592000 === 0 && totalSeconds > 0) return { value: totalSeconds / 2592000, unit: 'month' };
    if (totalSeconds % 86400 === 0 && totalSeconds > 0) return { value: totalSeconds / 86400, unit: 'day' };
    if (totalSeconds % 3600 === 0 && totalSeconds > 0) return { value: totalSeconds / 3600, unit: 'hour' };
    if (totalSeconds % 60 === 0) return { value: totalSeconds / 60, unit: 'minute' };
    return { value: totalSeconds, unit: 'second' };
  }

  window.__rlSetPreset = function(sec) {
    var val, unit;
    if (sec === 0) { val = 0; unit = 'second'; }
    else { var parts = splitBanDuration(sec); val = parts.value; unit = parts.unit; }
    var valInput = $('#rl-e-ban-val');
    var unitSelect = $('#rl-e-ban-unit');
    if (valInput) valInput.value = val;
    if (unitSelect) unitSelect.value = unit;
    // 高亮选中的预设按钮
    var btns = document.querySelectorAll('.rl-preset-btn');
    btns.forEach(function(b) { b.classList.remove('rl-preset-active'); });
    var activeBtn = document.querySelector('.rl-preset-btn[data-sec="' + sec + '"]');
    if (activeBtn) activeBtn.classList.add('rl-preset-active');
  };

  window.__rlSaveRule = function(id) {
    var isEdit = id > 0;
    var userTypeEl = $('#rl-e-user-type');
    var windowEl = $('#rl-e-window');
    var maxReqEl = $('#rl-e-max-req');
    var banValEl = $('#rl-e-ban-val');
    var banUnitEl = $('#rl-e-ban-unit');
    var enabledEl = $('#rl-e-enabled');
    var sortEl = $('#rl-e-sort');

    var userType = userTypeEl ? userTypeEl.value : 'authenticated';
    var windowSec = parseInt(windowEl ? windowEl.value : 60, 10);
    var maxReq = parseInt(maxReqEl ? maxReqEl.value : 100, 10);
    var banVal = parseInt(banValEl ? banValEl.value : 0, 10);
    var banUnit = banUnitEl ? banUnitEl.value : 'minute';
    var totalBanSec = banVal === 0 ? 0 : parseBanDuration(banVal, banUnit);
    var enabled = enabledEl ? enabledEl.checked : true;
    var sortOrder = parseInt(sortEl ? sortEl.value : 0, 10);

    if (isNaN(windowSec) || windowSec < 1) { alert('时间窗口至少 1 秒'); return; }
    if (isNaN(maxReq) || maxReq < 1) { alert('最大请求数至少为 1'); return; }
    if (isNaN(totalBanSec) || totalBanSec < 0) { alert('封禁时长无效'); return; }

    var data = {
      user_type: userType,
      window_seconds: windowSec,
      max_requests: maxReq,
      ban_duration_seconds: totalBanSec,
      is_enabled: enabled,
      sort_order: sortOrder
    };

    var promise;
    if (isEdit) {
      promise = apiPut('/admin/rate-limit/rules/' + id, data);
    } else {
      promise = apiPost('/admin/rate-limit/rules', data);
    }

    promise.then(function(r) {
      if (r.code === 0) {
        window.__rlCloseModal();
        window.__rlRefresh();
      } else {
        alert((isEdit ? '更新' : '添加') + '失败：' + r.message);
      }
    }).catch(function(e) {
      alert((isEdit ? '更新' : '添加') + '失败：' + (e.message || '网络错误'));
    });
  };

  window.__rlCloseModal = function() {
    var modal = $('#rl-modal');
    if (modal) modal.remove();
  };

  function loadAdminTraffic() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';

    var countEl = el('span', 'af-count-badge');
    countEl.textContent = '';
    var result = makeAdminHeader('流量管理', countEl, '搜索邮箱/IP...', function(kw) {
      quotaState.filterKeyword = kw.toLowerCase();
      renderQuotaTable();
    });

    // 周期选择（默认往后一天）
    var _d = new Date();
    _d.setDate(_d.getDate() + 1);
    quotaState.period = _d.toISOString().substring(0, 7);
    var filterBar = el('div', 'af-admin-filter-bar');
    var periodWrap = el('div', 'af-admin-filter-item');
    periodWrap.innerHTML = '<label style="font-size:11px;color:var(--text-secondary);margin-right:4px">周期</label>';
    var periodInput = el('input');
    periodInput.type = 'month';
    periodInput.value = quotaState.period;
    periodInput.className = 'af-admin-search';
    periodInput.style.cssText = 'min-width:130px';
    periodInput.addEventListener('change', function() {
      quotaState.period = periodInput.value;
      fetchQuotaList();
    });
    periodWrap.appendChild(periodInput);
    filterBar.appendChild(periodWrap);

    var typeWrap = el('div', 'af-admin-filter-item');
    typeWrap.innerHTML = '<label style="font-size:11px;color:var(--text-secondary);margin-right:4px">类型</label>';
    var typeSelect = el('select', 'af-admin-search');
    typeSelect.style.cssText = 'min-width:90px';
    [{ label: '全部', value: 'all' }, { label: '用户', value: 'user' }, { label: '访客', value: 'guest' }].forEach(function(o) {
      var opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', function() {
      quotaState.filterType = typeSelect.value;
      renderQuotaTable();
    });
    typeWrap.appendChild(typeSelect);
    filterBar.appendChild(typeWrap);

    result.header.appendChild(filterBar);

    // 统计卡片
    var statsRow = el('div', 'af-stats-row');
    var cardUser = el('div', 'af-stat-card');
    cardUser.innerHTML = '<div class="af-stat-num" style="color:#4caf50" id="qt-user-count">-</div><div class="af-stat-label">注册用户</div>';
    var cardGuest = el('div', 'af-stat-card');
    cardGuest.innerHTML = '<div class="af-stat-num" style="color:#ff9800" id="qt-guest-count">-</div><div class="af-stat-label">访客IP</div>';
    var cardTotal = el('div', 'af-stat-card');
    cardTotal.innerHTML = '<div class="af-stat-num" style="color:#9c27b0" id="qt-total-used">-</div><div class="af-stat-label">总已用</div>';
    statsRow.appendChild(cardUser);
    statsRow.appendChild(cardGuest);
    statsRow.appendChild(cardTotal);
    result.content.appendChild(statsRow);

    // 表格区域
    var tableWrap = el('div', 'admin-table-wrap');
    var table = el('table', 'admin-table');
    table.id = 'quota-table';
    var thead = el('thead');
    var headTr = el('tr');
    ['类型', '账号/IP', '月度配额', '已用', '剩余', '使用率', '操作'].forEach(function(label) {
      var th = document.createElement('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');
    tbody.id = 'quota-tbody';
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    result.content.appendChild(tableWrap);

    // 移动端卡片列表
    var cardList = el('div', 'admin-card-list');
    cardList.id = 'quota-card-list';
    result.content.appendChild(cardList);

    container.appendChild(result.wrap);
    fetchQuotaList();
  }

  function fetchQuotaList() {
    var countEl = document.querySelector('.af-count-badge');
    if (countEl) countEl.textContent = '';
    apiGet('/admin/traffic/quotas?period=' + quotaState.period).then(function(res) {
      if (res.code !== 0) { showToast(res.message || '加载失败', '&#9888;'); return; }
      quotaState.rows = res.data.rows || [];
      quotaState.userCount = res.data.user_count || 0;
      quotaState.guestCount = res.data.guest_count || 0;
      var totalUsed = 0;
      quotaState.rows.forEach(function(r) { totalUsed += r.used_bytes || 0; });
      var elUserCount = $('#qt-user-count');
      var elGuestCount = $('#qt-guest-count');
      var elTotalUsed = $('#qt-total-used');
      if (elUserCount) elUserCount.textContent = quotaState.userCount;
      if (elGuestCount) elGuestCount.textContent = quotaState.guestCount;
      if (elTotalUsed) elTotalUsed.textContent = formatFileSize(totalUsed);
      if (countEl) countEl.textContent = quotaState.rows.length + ' 条记录';
      renderQuotaTable();
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  }

  function renderQuotaTable() {
    var rows = quotaState.rows.filter(function(r) {
      if (quotaState.filterType === 'user' && r.user_id === 0) return false;
      if (quotaState.filterType === 'guest' && r.user_id > 0) return false;
      if (quotaState.filterKeyword) {
        var kw = quotaState.filterKeyword;
        if (r.email && r.email.toLowerCase().indexOf(kw) !== -1) return true;
        if (r.guest_ip && r.guest_ip.toLowerCase().indexOf(kw) !== -1) return true;
        return false;
      }
      return true;
    });

    // 桌面端表格
    var tbody = $('#quota-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:40px">暂无数据</td></tr>';
      } else {
        rows.forEach(function(r) {
          var isGuest = r.user_id === 0;
          var quota = r.quota_bytes || 10737418240;
          var used = r.used_bytes || 0;
          var remaining = Math.max(0, quota - used);
          var pct = quota > 0 ? Math.round(used / quota * 100) : 0;
          var pctColor = pct < 50 ? '#4caf50' : pct < 80 ? '#ff9800' : '#f44336';
          var idAttr = isGuest ? escHtml(r.guest_ip) : r.user_id;
          var tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + (isGuest ? '<span class="role-badge" style="color:#ff9800">&#x1F3AF; 访客</span>' : '<span class="role-badge user">&#x1F464; 用户</span>') + '</td>' +
            '<td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(isGuest ? r.guest_ip : r.email) + '">' + escHtml(isGuest ? (r.guest_ip || '-') : (r.email || r.user_id)) + '</td>' +
            '<td style="font-family:\'Share Tech Mono\',monospace;font-size:12px;white-space:nowrap">' + formatFileSize(quota) + '</td>' +
            '<td style="font-family:\'Share Tech Mono\',monospace;font-size:12px;color:' + pctColor + ';white-space:nowrap">' + formatFileSize(used) + '</td>' +
            '<td style="font-family:\'Share Tech Mono\',monospace;font-size:12px;color:#4caf50;white-space:nowrap">' + formatFileSize(remaining) + '</td>' +
            '<td style="min-width:80px"><div style="font-size:11px;color:' + pctColor + ';margin-bottom:3px">' + pct + '%</div><div style="width:100%;height:4px;background:var(--border);border-radius:2px"><div style="width:' + pct + '%;height:100%;background:' + pctColor + ';border-radius:2px"></div></div></td>' +
            '<td><button class="af-btn af-btn-sm" data-setaction="setquota" data-type="' + (isGuest ? 'guest' : 'user') + '" data-id="' + idAttr + '" data-quota="' + quota + '">设配额</button></td>';
          tbody.appendChild(tr);
        });
      }
    }

    // 移动端卡片
    var cardList = $('#quota-card-list');
    if (cardList) {
      cardList.innerHTML = '';
      if (rows.length === 0) {
        cardList.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;font-size:13px">暂无数据</div>';
      } else {
        rows.forEach(function(r) {
          var isGuest = r.user_id === 0;
          var quota = r.quota_bytes || 10737418240;
          var used = r.used_bytes || 0;
          var remaining = Math.max(0, quota - used);
          var pct = quota > 0 ? Math.round(used / quota * 100) : 0;
          var pctColor = pct < 50 ? '#4caf50' : pct < 80 ? '#ff9800' : '#f44336';
          var idAttr = isGuest ? escHtml(r.guest_ip) : r.user_id;
          var card = document.createElement('div');
          card.className = 'admin-user-card';
          card.innerHTML =
            '<div class="admin-user-card-header">' +
              '<span class="admin-user-card-email">' + escHtml(isGuest ? ('&#x1F3AF; 访客 ' + (r.guest_ip || '-')) : (r.email || r.user_id)) + '</span>' +
              '<span style="font-size:11px;color:' + pctColor + ';font-family:\'Share Tech Mono\',monospace">' + pct + '%</span>' +
            '</div>' +
            '<div class="admin-user-card-row"><span>配额:</span><span style="font-family:\'Share Tech Mono\',monospace">' + formatFileSize(quota) + '</span></div>' +
            '<div class="admin-user-card-row"><span>已用:</span><span style="font-family:\'Share Tech Mono\',monospace;color:' + pctColor + '">' + formatFileSize(used) + '</span></div>' +
            '<div class="admin-user-card-row"><span>剩余:</span><span style="font-family:\'Share Tech Mono\',monospace;color:#4caf50">' + formatFileSize(remaining) + '</span></div>' +
            '<div class="admin-user-card-actions">' +
              '<button class="af-btn af-btn-sm" data-setaction="setquota" data-type="' + (isGuest ? 'guest' : 'user') + '" data-id="' + idAttr + '" data-quota="' + quota + '">设配额</button>' +
            '</div>';
          cardList.appendChild(card);
        });
      }
    }

    // 绑定设配额按钮
    document.querySelectorAll('[data-setaction="setquota"]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var type = btn.dataset.type;
        var id = btn.dataset.id;
        var curQ = parseInt(btn.dataset.quota, 10);
        var newQ = prompt('设置月度流量配额（MB）\n当前: ' + Math.round(curQ / 1024 / 1024) + ' MB\n输入新值:', Math.round(curQ / 1024 / 1024));
        if (newQ === null) return;
        newQ = parseInt(newQ, 10);
        if (isNaN(newQ) || newQ < 1) { showToast('请输入有效数字', '&#9888;'); return; }
        var url = type === 'guest' ? '/admin/traffic/quotas/guest' : '/admin/traffic/quotas/user/' + id;
        apiPut(url, { quota_bytes: newQ * 1024 * 1024 }).then(function(res) {
          if (res.code === 0) { showToast('配额已更新为 ' + newQ + ' MB', '&#10004;'); fetchQuotaList(); }
          else showToast(res.message || '更新失败', '&#9888;');
        }).catch(function() { showToast('网络错误', '&#9888;'); });
      });
    });
  }

  function loadAdminTraffic() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';

    var body = el('div', 'af-body');
    container.appendChild(body);

    // Tab 切换
    var tabs = el('div', 'traffic-tabs');
    [{ id: 'summary', label: '流量汇总' }, { id: 'chart', label: '流量图表' }, { id: 'logs', label: '流量明细' }].forEach(function(tab) {
      var btn = el('button', 'traffic-tab-btn');
      btn.textContent = tab.label;
      btn.dataset.tab = tab.id;
      if (tab.id === trafficState.activeTab) btn.classList.add('active');
      btn.addEventListener('click', function() {
        trafficState.activeTab = tab.id;
        $$('.traffic-tab-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        renderTrafficContent();
      });
      tabs.appendChild(btn);
    });
    body.appendChild(tabs);

    // 筛选栏
    var filterRow = el('div', 'traffic-filter');

    // 用户/IP筛选
    var targetSelect = el('select', 'as-select');
    targetSelect.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);min-width:160px';
    targetSelect.innerHTML = '<option value="">全部（用户+访客）</option><option value="user:0">仅访客IP</option>';
    targetSelect.addEventListener('change', function() {
      var val = targetSelect.value;
      if (val === '') { trafficState.selectedUserId = 0; trafficState.selectedGuestIp = ''; }
      else if (val === 'user:0') { trafficState.selectedUserId = 0; trafficState.selectedGuestIp = '__guest__'; }
      else { trafficState.selectedUserId = parseInt(val, 10); trafficState.selectedGuestIp = ''; }
      refreshTraffic();
    });
    filterRow.appendChild(targetSelect);

    // 时间维度
    var groupSelect = el('select', 'as-select');
    groupSelect.style.cssText = targetSelect.style.cssText;
    groupSelect.style.marginLeft = '8px';
    [{ label: '按天', value: 'day' }, { label: '按月', value: 'month' }, { label: '按年', value: 'year' }].forEach(function(opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      groupSelect.appendChild(o);
    });
    groupSelect.value = trafficState.groupBy;
    groupSelect.addEventListener('change', function() {
      trafficState.groupBy = groupSelect.value;
      trafficState.chartData = [];
      refreshTraffic();
    });
    filterRow.appendChild(groupSelect);

    // 日期范围
    var startInput = el('input');
    startInput.type = 'date';
    startInput.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);color:var(--text-primary);margin-left:8px';
    startInput.value = trafficState.startDate;
    startInput.addEventListener('change', function() {
      trafficState.startDate = startInput.value;
      refreshTraffic();
    });
    filterRow.appendChild(startInput);
    var endLabel = document.createTextNode(' 至 ');
    filterRow.appendChild(endLabel);
    var endInput = el('input');
    endInput.type = 'date';
    endInput.style.cssText = startInput.style.cssText;
    endInput.value = trafficState.endDate;
    endInput.addEventListener('change', function() {
      trafficState.endDate = endInput.value;
      refreshTraffic();
    });
    filterRow.appendChild(endInput);

    body.appendChild(filterRow);

    // 内容区
    var content = el('div', 'traffic-content');
    body.appendChild(content);

    // Mobile card list
    var cardList = el('div', 'admin-card-list af-card-list');
    cardList.id = 'traffic-cards';
    body.appendChild(cardList);

    // 加载用户列表
    apiGet('/admin/traffic/users').then(function(res) {
      if (res.code === 0 && res.data) {
        trafficState.users = res.data.users || [];
        trafficState.guestIps = res.data.guest_ips || [];
        trafficState.users.forEach(function(u) {
          var o = document.createElement('option');
          o.value = u.id;
          o.textContent = (u.nickname || u.email) + ' (' + u.email + ')';
          targetSelect.insertBefore(o, targetSelect.children[1]);
        });
      }
    });

    refreshTraffic();
  }

  function refreshTraffic() {
    var content = $('.traffic-content');
    if (!content) return;
    content.innerHTML = '';
    // Clear mobile cards (chart tab has no cards)
    var cardsEl = $('#traffic-cards');
    if (cardsEl) cardsEl.innerHTML = '';
    if (trafficState.activeTab === 'summary') fetchTrafficSummary();
    else if (trafficState.activeTab === 'chart') fetchTrafficChart();
    else fetchTrafficLogs();
  }

  function renderTrafficContent() {
    var content = $('.traffic-content');
    if (content) content.innerHTML = '';
    refreshTraffic();
  }

  function fetchTrafficSummary() {
    var content = $('.traffic-content');
    if (!content) return;
    content.innerHTML = '';
    var url = '/admin/traffic/summary';
    var params = [];
    if (trafficState.selectedUserId > 0) params.push('user_id=' + trafficState.selectedUserId);
    if (trafficState.selectedGuestIp === '__guest__') params.push('is_guest=1');
    if (trafficState.startDate) params.push('start_date=' + trafficState.startDate);
    if (trafficState.endDate) params.push('end_date=' + trafficState.endDate + ' 23:59:59');
    if (params.length) url += '?' + params.join('&');
    apiGet(url).then(function(res) {
      if (res.code !== 0) { content.innerHTML = '<div class="af-empty">加载失败</div>'; return; }
      trafficState.summary = res.data || [];
      renderTrafficSummary();
    }).catch(function() { content.innerHTML = '<div class="af-empty">网络错误</div>'; });
  }

  function renderTrafficSummary() {
    var content = $('.traffic-content');
    if (!content) return;
    var data = trafficState.summary;
    if (data.length === 0) { content.innerHTML = '<div class="af-empty">暂无流量记录</div>'; return; }

    var totalAll = 0;
    data.forEach(function(d) { totalAll += d.total_bytes || 0; });

    // 总计卡片
    var summaryRow = el('div', 'af-stats-row');
    var card1 = el('div', 'af-stat-card');
    card1.innerHTML = '<div class="af-stat-num" style="color:var(--accent)">' + formatFileSize(totalAll) + '</div><div class="af-stat-label">总流量</div>';
    summaryRow.appendChild(card1);
    var card2 = el('div', 'af-stat-card');
    card2.innerHTML = '<div class="af-stat-num" style="color:#4caf50">' + data.length + '</div><div class="af-stat-label">统计对象</div>';
    summaryRow.appendChild(card2);
    content.appendChild(summaryRow);

    // 表格（加 table-mobile-scroll 使移动端可水平滚动）
    var tableScrollWrap = el('div', 'table-mobile-scroll');
    var tableWrap = el('div', 'admin-table-wrap');
    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['用户/访客', '账号', '操作类型', '总流量', '占比'].forEach(function(label) {
      var th = el('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');
    data.forEach(function(d) {
      var tr = el('tr');
      var typeTd = el('td');
      if (d.id > 0) {
        typeTd.innerHTML = '<span class="role-badge user">&#x1F464; 用户</span>';
      } else {
        typeTd.innerHTML = '<span class="role-badge" style="color:#2196f3">&#x1F3af; 访客</span>';
      }
      var acctTd = el('td');
      acctTd.className = 'td-email';
      if (d.id > 0) {
        acctTd.textContent = d.email || d.id;
        acctTd.title = d.email || '';
      } else {
        acctTd.textContent = d.ip || '未知IP';
        acctTd.title = d.ip || '';
      }
      var actTd = el('td');
      var actTypes = Object.keys(d.actions || {});
      actTypes.forEach(function(t) {
        var badge = el('span', 'enc-badge');
        var map = { upload: '上传', download: '下载', preview: '图片预览', video_stream: '视频预览', request: 'API请求' };
        badge.textContent = (map[t] || t) + ': ' + formatFileSize(d.actions[t]);
        badge.style.marginRight = '4px';
        badge.style.fontSize = '11px';
        actTd.appendChild(badge);
      });
      var sizeTd = el('td');
      sizeTd.style.fontFamily = "'Share Tech Mono', monospace";
      sizeTd.style.fontSize = '13px';
      sizeTd.textContent = formatFileSize(d.total_bytes);
      var pctTd = el('td');
      pctTd.style.fontFamily = "'Share Tech Mono', monospace";
      pctTd.style.fontSize = '12px';
      var pct = totalAll > 0 ? Math.round((d.total_bytes / totalAll) * 100) : 0;
      pctTd.innerHTML = '<span style="color:var(--accent)">' + pct + '%</span>';
      tr.appendChild(typeTd);
      tr.appendChild(acctTd);
      tr.appendChild(actTd);
      tr.appendChild(sizeTd);
      tr.appendChild(pctTd);
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    tableScrollWrap.appendChild(tableWrap);
    content.appendChild(tableScrollWrap);

    // ---- Mobile cards ----
    var cardsEl = $('#traffic-cards');
    if (cardsEl) {
      var cardsHtml = '';
      data.forEach(function(d) {
        var actTypes = Object.keys(d.actions || {});
        var actHtml = '';
        var map = { upload: '上传', download: '下载', preview: '图片预览', video_stream: '视频预览', request: 'API请求' };
        actTypes.forEach(function(t) { actHtml += '<span style="display:inline-block;background:var(--bg-card-hover);padding:1px 6px;border-radius:4px;font-size:10px;margin-right:3px">' + (map[t] || t) + ': ' + formatFileSize(d.actions[t]) + '</span>'; });
        var pct = totalAll > 0 ? Math.round((d.total_bytes / totalAll) * 100) : 0;
        cardsHtml += '<div class="admin-user-card">' +
          '<div class="admin-user-card-header">' +
            '<span style="font-weight:600;font-size:13px">' + (d.id > 0 ? '👤 ' + escHtml(d.email || d.id) : '🎯 ' + escHtml(d.ip || '未知IP')) + '</span>' +
            '<span style="color:var(--accent);font-weight:700;font-size:14px">' + formatFileSize(d.total_bytes) + '</span>' +
          '</div>' +
          '<div class="admin-user-card-row"><span>类型</span><span>' + (d.id > 0 ? '用户' : '访客') + '</span></div>' +
          '<div class="admin-user-card-row"><span>操作</span><span>' + (actHtml || '无') + '</span></div>' +
          '<div class="admin-user-card-row"><span>占比</span><span style="color:var(--accent);font-weight:600">' + pct + '%</span></div>' +
        '</div>';
      });
      cardsEl.innerHTML = cardsHtml;
    }
  }

  function fetchTrafficChart() {
    var content = $('.traffic-content');
    if (!content) return;
    content.innerHTML = '';
    var url = '/admin/traffic/chart?group_by=' + trafficState.groupBy;
    var params = [];
    if (trafficState.selectedUserId > 0) params.push('user_id=' + trafficState.selectedUserId);
    if (trafficState.selectedGuestIp) params.push('guest_ip=' + trafficState.selectedGuestIp);
    if (trafficState.startDate) params.push('start_date=' + trafficState.startDate);
    if (trafficState.endDate) params.push('end_date=' + trafficState.endDate + ' 23:59:59');
    if (params.length) url += '&' + params.join('&');
    apiGet(url).then(function(res) {
      if (res.code !== 0) { content.innerHTML = '<div class="af-empty">加载失败</div>'; return; }
      trafficState.chartData = res.data || [];
      renderTrafficChart();
    }).catch(function() { content.innerHTML = '<div class="af-empty">网络错误</div>'; });
  }

  function renderTrafficChart() {
    var content = $('.traffic-content');
    if (!content) return;
    var data = trafficState.chartData;
    if (data.length === 0) { content.innerHTML = '<div class="af-empty">暂无数据</div>'; return; }

    // 聚合到各时间点
    var dateMap = {};
    data.forEach(function(d) {
      var label = d.date || d.month || d.year;
      if (!dateMap[label]) dateMap[label] = { total: 0, upload: 0, download: 0, preview: 0, video_stream: 0 };
      dateMap[label].total += d.bytes || 0;
      if (d.action_type) dateMap[label][d.action_type] = (dateMap[label][d.action_type] || 0) + (d.bytes || 0);
    });
    var labels = Object.keys(dateMap).sort();
    if (labels.length > 60) labels = labels.slice(labels.length - 60);

    var chartWrap = el('div', 'traffic-chart-wrap');
    var chartTitle = el('div', 'traffic-chart-title');
    chartTitle.textContent = '流量趋势（' + (trafficState.groupBy === 'day' ? '按天' : trafficState.groupBy === 'month' ? '按月' : '按年') + '）';
    chartWrap.appendChild(chartTitle);

    // 堆积柱状图（按操作类型分色）
    var typeColors = {
      'upload': '#4caf50',
      'download': '#ff9800',
      'webdav_upload': '#00bcd4',
      'webdav_download': '#0097a7',
      'image_preview': '#2196f3',
      'video_preview': '#9c27b0',
      'other': '#607d8b'
    };
    var typeNames = {
      'upload': '上传', 'download': '下载',
      'webdav_upload': 'WebDAV上传', 'webdav_download': 'WebDAV下载',
      'image_preview': '图片预览', 'video_preview': '视频预览',
      'other': '其他'
    };
    // 收集所有类型
    var allTypes = {};
    labels.forEach(function(l) {
      Object.keys(dateMap[l]).forEach(function(k) {
        if (k !== 'total') allTypes[k] = true;
      });
    });
    var types = Object.keys(allTypes);

    var chart = el('div', 'traffic-chart');
    var maxBytes = 0;
    labels.forEach(function(l) { if (dateMap[l].total > maxBytes) maxBytes = dateMap[l].total; });
    if (maxBytes === 0) maxBytes = 1;
    labels.forEach(function(label) {
      var item = dateMap[label];
      var bar = el('div', 'tc-bar-item');
      var barLabel = el('div', 'tc-label');
      barLabel.textContent = label.length > 7 ? label.substring(5) : label;
      // 堆积条
      var barStack = el('div', 'tc-bar-stack');
      barStack.style.flex = 'none';
      barStack.style.height = Math.max(2, Math.round((item.total / maxBytes) * 140)) + 'px';
      barStack.style.width = '100%';
      barStack.style.display = 'flex';
      barStack.style.flexDirection = 'column-reverse';
      barStack.style.borderRadius = '2px 2px 0 0';
      barStack.style.overflow = 'hidden';
      var remaining = item.total;
      types.forEach(function(t) {
        var val = item[t] || 0;
        if (val === 0) return;
        var seg = el('div');
        var segPct = remaining > 0 ? (val / remaining * 100) : 0;
        seg.style.height = Math.max(1, segPct) + '%';
        seg.style.width = '100%';
        seg.style.background = typeColors[t] || typeColors['other'];
        seg.style.minHeight = '1px';
        seg.title = typeNames[t] + ': ' + formatFileSize(val);
        barStack.appendChild(seg);
        remaining -= val;
      });
      var breakdown = types.map(function(t) { return (typeNames[t]||t) + ': ' + formatFileSize(item[t]||0); }).join(', ');
      barStack.title = label + ' 总计: ' + formatFileSize(item.total) + '\n' + breakdown;
      var barValue = el('div', 'tc-value');
      barValue.textContent = formatFileSize(item.total);
      bar.appendChild(barLabel);
      bar.appendChild(barStack);
      bar.appendChild(barValue);
      chart.appendChild(bar);
    });
    chartWrap.appendChild(chart);
    content.appendChild(chartWrap);

    // 图例（动态）
    var legend = el('div', 'tc-legend');
    types.forEach(function(t) {
      var dot = el('span', 'tc-legend-item');
      dot.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + (typeColors[t] || '#607d8b') + ';margin-right:4px"></span>' + (typeNames[t] || t);
      legend.appendChild(dot);
    });
    content.appendChild(legend);
  }

  function fetchTrafficLogs() {
    var content = $('.traffic-content');
    if (!content) return;
    content.innerHTML = '';
    var url = '/admin/traffic/logs?page=' + trafficState.logPage + '&limit=' + trafficState.logLimit;
    if (trafficState.selectedUserId > 0) url += '&user_id=' + trafficState.selectedUserId;
    if (trafficState.selectedGuestIp) url += '&guest_ip=' + trafficState.selectedGuestIp;
    if (trafficState.startDate) url += '&start_date=' + trafficState.startDate;
    if (trafficState.endDate) url += '&end_date=' + trafficState.endDate + ' 23:59:59';
    apiGet(url).then(function(res) {
      if (res.code !== 0) { content.innerHTML = '<div class="af-empty">加载失败</div>'; return; }
      trafficState.logs = res.data.logs || [];
      trafficState.logTotal = res.data.total || 0;
      renderTrafficLogs();
    }).catch(function() { content.innerHTML = '<div class="af-empty">网络错误</div>'; });
  }

  function renderTrafficLogs() {
    var content = $('.traffic-content');
    if (!content) return;
    var logs = trafficState.logs;
    var tableScrollWrap = el('div', 'table-mobile-scroll');
    var tableWrap = el('div', 'admin-table-wrap');
    var table = el('table', 'admin-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['时间', '用户/访客', '操作', '文件名', '文件大小', '流量'].forEach(function(label) {
      var th = el('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);
    var tbody = el('tbody');
    if (logs.length === 0) {
      var emptyTr = el('tr');
      var emptyTd = el('td');
      emptyTd.colSpan = 6;
      emptyTd.textContent = '暂无记录';
      emptyTd.style.textAlign = 'center';
      emptyTd.style.color = 'var(--text-muted)';
      emptyTd.style.padding = '32px';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      logs.forEach(function(log) {
        var tr = el('tr');
        var actionMap = { upload: '上传', download: '下载', preview: '图片预览', video_stream: '视频预览', request: 'API请求' };
        var actionColor = { upload: '#4caf50', download: '#ff9800', preview: '#2196f3', video_stream: '#9c27b0', request: '#607d8b' };
        tr.innerHTML =
          '<td style="font-size:11px;color:var(--text-muted);white-space:nowrap">' + formatTrafficTime(log.created_at) + '</td>' +
          '<td style="font-size:12px">' + (log.user_id > 0 ? '<span class="role-badge user">&#x1F464; ' + escHtml(log.email || log.user_id) + '</span>' : '<span class="role-badge" style="color:#2196f3">&#x1F3af; ' + escHtml(log.guest_ip || '访客') + '</span>') + '</td>' +
          '<td><span style="color:' + (actionColor[log.action_type] || '#999') + ';font-size:12px;font-weight:600">' + (actionMap[log.action_type] || log.action_type) + '</span></td>' +
          '<td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(log.file_name || '') + '">' + escHtml(log.file_name || '-') + '</td>' +
          '<td style="font-family:\'Share Tech Mono\',monospace;font-size:11px">' + formatFileSize(log.file_size || 0) + '</td>' +
          '<td style="font-family:\'Share Tech Mono\',monospace;font-size:12px;color:var(--accent)">' + formatFileSize(log.bytes_count || 0) + '</td>';
        tbody.appendChild(tr);
      });
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    tableScrollWrap.appendChild(tableWrap);
    content.appendChild(tableScrollWrap);

    // ---- Mobile cards ----
    var cardsEl = $('#traffic-cards');
    if (cardsEl) {
      if (logs.length === 0) {
        cardsEl.innerHTML = '<div class="af-empty" style="padding:32px;text-align:center;color:var(--text-muted)">暂无记录</div>';
      } else {
        var cardsHtml = '';
        logs.forEach(function(log) {
          var actionMap = { upload: '上传', download: '下载', preview: '图片预览', video_stream: '视频预览', request: 'API请求' };
          var actionColor = { upload: '#4caf50', download: '#ff9800', preview: '#2196f3', video_stream: '#9c27b0', request: '#607d8b' };
          cardsHtml += '<div class="admin-user-card">' +
            '<div class="admin-user-card-header">' +
              '<span style="color:' + (actionColor[log.action_type] || '#999') + ';font-weight:600;font-size:13px">' + (actionMap[log.action_type] || log.action_type) + '</span>' +
              '<span style="font-size:10px;color:var(--text-muted)">' + formatTrafficTime(log.created_at) + '</span>' +
            '</div>' +
            '<div class="admin-user-card-row"><span>用户</span><span>' + (log.user_id > 0 ? '👤 ' + escHtml(log.email || log.user_id) : '🎯 ' + escHtml(log.guest_ip || '访客')) + '</span></div>' +
            '<div class="admin-user-card-row"><span>文件</span><span style="font-size:11px;word-break:break-all">' + escHtml(log.file_name || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>大小</span><span>' + formatFileSize(log.file_size || 0) + '</span></div>' +
            '<div class="admin-user-card-row"><span>流量</span><span style="color:var(--accent);font-weight:600">' + formatFileSize(log.bytes_count || 0) + '</span></div>' +
          '</div>';
        });
        cardsEl.innerHTML = cardsHtml;
      }
    }

    // 分页
    var totalPages = Math.ceil(trafficState.logTotal / trafficState.logLimit);
    if (totalPages > 1) {
      var pager = el('div', 'as-pager');
      pager.style.marginTop = '16px';
      var prevBtn = el('button', 'af-btn af-btn-default');
      prevBtn.textContent = '上一页';
      prevBtn.disabled = trafficState.logPage <= 1;
      prevBtn.addEventListener('click', function() { if (trafficState.logPage > 1) { trafficState.logPage--; fetchTrafficLogs(); } });
      var nextBtn = el('button', 'af-btn af-btn-default');
      nextBtn.textContent = '下一页';
      nextBtn.disabled = trafficState.logPage >= totalPages;
      nextBtn.addEventListener('click', function() { if (trafficState.logPage < totalPages) { trafficState.logPage++; fetchTrafficLogs(); } });
      var info = el('span');
      info.textContent = '第 ' + trafficState.logPage + ' / ' + totalPages + ' 页，共 ' + trafficState.logTotal + ' 条';
      info.style.cssText = 'font-size:12px;color:var(--text-muted);padding:0 12px';
      pager.appendChild(prevBtn);
      pager.appendChild(info);
      pager.appendChild(nextBtn);
      content.appendChild(pager);
    }
  }

  // ==================== 版本管理（管理员） ====================

  function loadAdminVersions() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';
    var html =
      '<div class="af-body">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '<h3 style="color:var(--text-primary);margin:0;font-size:18px;">版本管理</h3>' +
          '<span style="color:var(--text-secondary);font-size:12px;margin-left:auto;">上传 APK 供用户下载和更新</span>' +
        '</div>' +
        '<div class="vm-upload-zone">' +
          '<div class="vm-upload-icon">&#128230;</div>' +
          '<p class="vm-upload-title">上传新版本 APK</p>' +
          '<p class="vm-upload-hint">支持 .apk 文件，自动解析版本号</p>' +
          '<div class="vm-upload-form">' +
            '<label class="vm-file-label">' +
              '<span id="version-file-name">选择文件...</span>' +
              '<input type="file" id="version-file-input" accept=".apk" style="display:none" onchange="var n=this.files[0]?this.files[0].name:\'选择文件...\';document.getElementById(\'version-file-name\').textContent=n">' +
            '</label>' +
            '<input type="text" id="version-notes-input" class="vm-notes-input" placeholder="更新日志（可选）">' +
            '<button onclick="window.__fm.uploadVersion()" class="vm-upload-btn">&#11014; 上传</button>' +
          '</div>' +
          '<p id="version-upload-status" class="vm-upload-status"></p>' +
        '</div>' +
        '<div id="version-list">' +
          '<p style="color:var(--text-secondary);text-align:center;padding:20px;">加载中...</p>' +
        '</div>' +
      '</div>';
    container.innerHTML = html;
    loadVersionList();
  }

  function uploadVersion() {
    var fileInput = document.getElementById('version-file-input');
    var notesInput = document.getElementById('version-notes-input');
    var statusEl = document.getElementById('version-upload-status');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
      if (statusEl) statusEl.innerHTML = '<span style="color:#f85149">请选择文件</span>';
      return;
    }
    var file = fileInput.files[0];
    statusEl.innerHTML = '上传中...';
    var form = new FormData();
    form.append('file', file);
    form.append('notes', notesInput ? notesInput.value : '');
    fetch('/api/admin/version/upload', { method: 'POST', body: form, credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken || '' } })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.code === 0) {
          statusEl.innerHTML = '<span style="color:#2ea043">✅ 上传成功 v' + d.data.version + '</span>';
          fileInput.value = '';
          if (notesInput) notesInput.value = '';
          loadVersionList();
        } else {
          statusEl.innerHTML = '<span style="color:#f85149">❌ ' + (d.message || '上传失败') + '</span>';
        }
      })
      .catch(function() { statusEl.innerHTML = '<span style="color:#f85149">网络错误</span>'; });
  }

  function loadVersionList() {
    var listEl = document.getElementById('version-list');
    if (!listEl) return;
    fetch('/api/admin/versions', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.code !== 0 || !d.data || d.data.length === 0) {
          listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px;">暂无版本记录，请上传第一个 APK</p>';
          return;
        }
        var html = '';
        d.data.forEach(function(v) {
          var isLatest = d.data.indexOf(v) === 0;
          html += '<div class="vm-card' + (isLatest ? ' latest' : '') + '">' +
            '<div class="vm-card-icon' + (isLatest ? ' latest' : ' normal') + '">' + (isLatest ? '✅' : '📦') + '</div>' +
            '<div class="vm-card-info">' +
              '<div class="vm-card-header">' +
                'v' + v.version +
                (isLatest ? '<span class="vm-badge-latest">最新</span>' : '') +
                '<span class="vm-card-size">' + formatFileSize(v.size) + '</span>' +
              '</div>' +
              (v.notes ? '<div class="vm-card-notes">' + v.notes + '</div>' : '') +
              '<div class="vm-card-time">' + (v.createdAt ? v.createdAt.substring(0,16).replace('T',' ') : '') + '</div>' +
            '</div>' +
            '<div class="vm-card-actions">' +
              '<a href="' + v.url + '" download class="vm-btn-dl">📥 下载</a>' +
              '<button onclick="if(confirm(\'确定删除 v' + v.version + '?\')){window.__fm.deleteVersion(' + v.versionCode + ')}" class="vm-btn-del">🗑</button>' +
            '</div>' +
          '</div>';
        });
        listEl.innerHTML = html;
      })
      .catch(function() { listEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;">加载失败</p>'; });
  }

  function deleteVersion(code) {
    fetch('/api/admin/version/' + code, { method: 'DELETE', credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken || '' } })
      .then(function(r) { return r.json(); })
      .then(function() { loadVersionList(); })
      .catch(function() {});
  }

  // 暴露给全局
  window.__fm.uploadVersion = uploadVersion;
  window.__fm.deleteVersion = deleteVersion;

  // ==================== 离线下载 ====================

  var offlineState = {
    tasks: [],
    defaultDirId: 0,
    defaultDirName: '我的下载',
    selectedDirId: 0,
    selectedDirName: '我的下载',
    directories: []
  };

  // 加载离线下载视图
  function loadOffline() {
    var container = $('#page-panel-body');
    if (!container) return;

    // 显示加载状态
    container.innerHTML = '<div style="padding:60px 20px;text-align:center;color:var(--text-muted);font-family:\'Share Tech Mono\',monospace;"><div style="font-size:32px;margin-bottom:16px">&#128229;</div><div>正在加载离线下载...</div></div>';

    // 并行加载任务列表和目录列表
    Promise.all([
      apiGet('/offline/list'),
      apiGet('/files/dirs'),
      apiGet('/profile/me')
    ]).then(function(results) {
      var tasksRes = results[0];
      var dirsRes = results[1];
      var profileRes = results[2];

      if (tasksRes.code === 0) {
        offlineState.tasks = tasksRes.data || [];
      }

      if (dirsRes.code === 0) {
        // /files/dirs 返回的是直接数组，需要转换格式
        offlineState.directories = (dirsRes.data || []).map(function(d) {
          return { id: d.id, name: d.name };
        });
      }

      // 获取"我的下载"目录ID
      var dlDir = offlineState.directories.find(function(d) { return d.name === '我的下载'; });
      if (dlDir) {
        offlineState.defaultDirId = dlDir.id;
        offlineState.defaultDirName = dlDir.name;
      }
      offlineState.selectedDirId = offlineState.defaultDirId;
      offlineState.selectedDirName = offlineState.defaultDirName;

      if (profileRes.code === 0 && profileRes.data) {
        state.user = profileRes.data;
      }

      renderOfflineView();
    }).catch(function(err) {
      console.error('[loadOffline] failed:', err);
      showToast('加载失败: ' + (err && err.message ? err.message : '网络错误'), '&#9888;');
      renderOfflineView();
    });
  }

  // 渲染离线下载视图
  function renderOfflineView() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';

    // 创建离线下载主容器
    var offlineMain = el('div', 'offline-panel');
    offlineMain.innerHTML = getOfflinePanelHTML();
    container.appendChild(offlineMain);

    // 渲染任务列表
    renderOfflineTasks();

    // 绑定事件
    bindOfflineEvents();
  }

  // 获取离线下载面板HTML
  function getOfflinePanelHTML() {
    var tasks = offlineState.tasks;
    var taskCount = tasks.length;

    return '<div class="offline-input-section">' +
      '<h3 class="offline-section-title">&#128229; 新建离线下载</h3>' +
      '<div class="offline-form-row">' +
        '<input type="text" id="offline-url-input" class="offline-url-input" ' +
          'placeholder="输入下载链接（支持 HTTP/HTTPS），按回车开始下载" ' +
          'onkeydown="if(event.key===\'Enter\')window.__fm && window.__fm.createOfflineTask()">' +
        '<button class="offline-submit-btn" id="offline-submit-btn" onclick="window.__fm && window.__fm.createOfflineTask()">' +
          '&#128229; 开始下载' +
        '</button>' +
      '</div>' +
      '<div class="offline-form-row offline-dir-row">' +
        '<label class="offline-dir-label">&#128193; 保存到：</label>' +
        '<div class="offline-dir-picker">' +
          '<button class="offline-dir-btn" id="offline-dir-btn" onclick="window.__fm && window.__fm.toggleDirPicker()">' +
            '<span id="offline-dir-name">' + escapeHtml(offlineState.selectedDirName) + '</span>' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
          '</button>' +
          '<div class="offline-dir-dropdown" id="offline-dir-dropdown" style="display:none">' +
            '<div class="offline-dir-search-wrap">' +
              '<input type="text" id="offline-dir-search" class="offline-dir-search" placeholder="搜索目录...">' +
            '</div>' +
            '<div class="offline-dir-list" id="offline-dir-list"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="offline-hint">&#9432; 下载完成后文件将自动保存到所选目录，仅支持 HTTP/HTTPS 链接</div>' +
    '</div>' +
    '<div class="offline-list-section">' +
      '<div class="offline-list-header">' +
        '<h3 class="offline-section-title">&#128640; 下载任务 <span class="offline-task-count" id="offline-task-count">' +
          (taskCount > 0 ? '(' + taskCount + ')' : '') + '</span></h3>' +
        '<button class="offline-refresh-btn" onclick="window.__fm && window.__fm.loadOffline()">' +
          '&#8635; 刷新' +
        '</button>' +
      '</div>' +
      '<div class="offline-task-list" id="offline-task-list">' +
        '<div class="offline-empty" id="offline-empty" style="display:' + (taskCount === 0 ? 'flex' : 'none') + '">' +
          '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">' +
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
            '<polyline points="7 10 12 15 17 10"/>' +
            '<line x1="12" y1="15" x2="12" y2="3"/>' +
          '</svg>' +
          '<h4>暂无下载任务</h4>' +
          '<p>在上方输入框中粘贴下载链接即可开始离线下载</p>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // 渲染任务列表
  function renderOfflineTasks() {
    var list = $('#offline-task-list');
    var empty = $('#offline-empty');
    if (!list) return;

    var tasks = offlineState.tasks;

    if (tasks.length === 0) {
      if (empty) empty.style.display = 'flex';
      return;
    }

    if (empty) empty.style.display = 'none';

    // 清空列表（保留空状态占位符）
    var children = list.children;
    for (var i = children.length - 1; i >= 0; i--) {
      if (children[i].id !== 'offline-empty') {
        list.removeChild(children[i]);
      }
    }

    // 按时间倒序排列，并去重（同一ID只保留第一条）
    var seen = {};
    var uniqueTasks = [];
    tasks.forEach(function(t) {
      if (!seen[t.id]) {
        seen[t.id] = true;
        uniqueTasks.push(t);
      }
    });

    uniqueTasks.sort(function(a, b) { return (b.id || 0) - (a.id || 0); });

    uniqueTasks.forEach(function(task, idx) {
      var item = el('div', 'offline-task-item');
      item.id = 'offline-task-' + task.id;
      item.style.animationDelay = (idx * 0.04) + 's';
      item.innerHTML = buildOfflineTaskHTML(task);
      list.insertBefore(item, empty);
    });
  }

  // 格式化文件大小
  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
      bytes /= 1024;
      i++;
    }
    return bytes.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  // 获取文件图标
  function getFileIcon(name) {
    var n = (name || '').toLowerCase();
    if (n.endsWith('.mp4') || n.endsWith('.webm') || n.endsWith('.avi') || n.endsWith('.mkv')) return '&#127909;';
    if (n.endsWith('.mp3') || n.endsWith('.wav') || n.endsWith('.flac') || n.endsWith('.aac')) return '&#127925;';
    if (n.endsWith('.jpg') || n.endsWith('.png') || n.endsWith('.gif') || n.endsWith('.webp') || n.endsWith('.svg') || n.endsWith('.jpeg')) return '&#128444;';
    if (n.endsWith('.pdf')) return '&#128196;';
    if (n.endsWith('.zip') || n.endsWith('.rar') || n.endsWith('.7z') || n.endsWith('.tar') || n.endsWith('.gz')) return '&#128230;';
    if (n.endsWith('.doc') || n.endsWith('.docx')) return '&#128196;';
    if (n.endsWith('.xls') || n.endsWith('.xlsx')) return '&#128202;';
    if (n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.json') || n.endsWith('.js') || n.endsWith('.css') || n.endsWith('.html')) return '&#128196;';
    return '&#128196;';
  }

  // HTML转义
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 构建任务项HTML
  function buildOfflineTaskHTML(task) {
    var statusBadge = getOfflineStatusBadge(task.status);
    var actions = getOfflineTaskActions(task);
    var sizeStr = formatSize(task.total_bytes || 0);
    var dlStr = formatSize(task.downloaded_bytes || 0);
    var speedStr = task.speed_bps > 0 ? formatSize(task.speed_bps) + '/s' : '';
    var icon = getFileIcon(task.filename || task.url || '');
    var errStr = task.error ? '<div class="offline-task-error">&#9888; ' + escapeHtml(task.error) + '</div>' : '';
    var progressClass = '';
    if (task.status === 'completed') progressClass = ' completed';
    else if (task.status === 'failed') progressClass = ' failed';
    var progressBar = '';
    if (task.status === 'downloading' || task.status === 'completed' || task.status === 'paused') {
      progressBar = '<div class="offline-task-progress">' +
        '<div class="offline-progress-bar-wrap">' +
          '<div class="offline-progress-bar' + progressClass + '" id="offline-pbar-' + task.id + '" style="width:' + Math.min(100, task.progress || 0) + '%"></div>' +
        '</div>' +
        '<div class="offline-progress-info">' +
          '<span>' + dlStr + ' / ' + sizeStr + ' ' + speedStr + '</span>' +
          '<span>' + Math.min(100, Math.round(task.progress || 0)) + '%</span>' +
        '</div>' +
      '</div>';
    }

    return '<div class="offline-task-top">' +
      '<div class="offline-task-info">' +
        '<span class="offline-task-icon">' + icon + '</span>' +
        '<div class="offline-task-detail">' +
          '<div class="offline-task-name" title="' + escapeHtml(task.filename) + '">' + escapeHtml(task.filename) + '</div>' +
          '<div class="offline-task-url" title="' + escapeHtml(task.url) + '">' + escapeHtml(task.url) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="offline-task-actions">' +
        statusBadge +
        actions +
      '</div>' +
    '</div>' +
    progressBar +
    errStr;
  }

  // 获取状态徽章
  function getOfflineStatusBadge(status) {
    var map = {
      pending: '&#8987; 待下载',
      downloading: '&#128229; 下载中',
      paused: '&#9208; 已暂停',
      completed: '&#10004; 已完成',
      failed: '&#10060; 下载失败',
      cancelled: '&#10060; 已取消'
    };
    return '<span class="offline-status-badge ' + status + '">' + (map[status] || status) + '</span>';
  }

  // 获取任务操作按钮
  function getOfflineTaskActions(task) {
    var html = '';
    // 复制链接按钮（所有状态都显示）
    html += '<button class="offline-action-btn copy-link" onclick="window.__fm && window.__fm.copyOfflineUrl(' + task.id + ')" title="复制下载链接">&#128203;</button>';
    if (task.status === 'pending' || task.status === 'failed' || task.status === 'cancelled') {
      html += '<button class="offline-action-btn start" onclick="window.__fm && window.__fm.startOfflineTask(' + task.id + ')">&#9654; 开始</button>';
    }
    if (task.status === 'downloading') {
      html += '<button class="offline-action-btn pause" onclick="window.__fm && window.__fm.pauseOfflineTask(' + task.id + ')">&#9208; 暂停</button>';
    }
    if (task.status === 'paused') {
      html += '<button class="offline-action-btn start" onclick="window.__fm && window.__fm.startOfflineTask(' + task.id + ')">&#9654; 继续</button>';
    }
    if (task.status === 'completed') {
      html += '<button class="offline-action-btn download" onclick="window.__fm && window.__fm.gotoOfflineDownloadDir()">&#128193; 查看</button>';
    }
    if (task.status !== 'completed') {
      html += '<button class="offline-action-btn cancel" onclick="window.__fm && window.__fm.cancelOfflineTask(' + task.id + ')">&#10005; 取消</button>';
    }
    html += '<button class="offline-action-btn delete" onclick="window.__fm && window.__fm.deleteOfflineTask(' + task.id + ')">&#128465;</button>';
    return html;
  }

  // 复制离线任务的下载链接
  function copyOfflineUrl(id) {
    var task = offlineState.tasks.find(function(t) { return t.id === id; });
    if (task && task.url) {
      copyToClipboard(task.url);
    } else {
      showToast('复制失败，链接不存在', '&#9888;');
    }
  }

  // 绑定离线下载事件
  function bindOfflineEvents() {
    // 点击外部关闭目录选择器
    document.addEventListener('click', function(e) {
      var dropdown = $('#offline-dir-dropdown');
      var btn = $('#offline-dir-btn');
      if (dropdown && btn && !dropdown.contains(e.target) && !btn.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });

    // 目录搜索
    var searchInput = $('#offline-dir-search');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        renderDirPickerList(this.value);
      });
    }
  }

  // 切换目录选择器
  function toggleDirPicker() {
    var dropdown = $('#offline-dir-dropdown');
    if (!dropdown) return;

    if (dropdown.style.display === 'none') {
      dropdown.style.display = 'block';
      renderDirPickerList('');
      var searchInput = $('#offline-dir-search');
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
    } else {
      dropdown.style.display = 'none';
    }
  }

  // 渲染目录选择器列表
  function renderDirPickerList(filter) {
    var list = $('#offline-dir-list');
    if (!list) return;

    var dirs = offlineState.directories || [];
    var filtered = dirs.filter(function(d) {
      return d.name.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div class="offline-dir-empty">未找到目录</div>';
      return;
    }

    list.innerHTML = '';
    filtered.forEach(function(dir) {
      var item = el('div', 'offline-dir-item' + (dir.id === offlineState.selectedDirId ? ' selected' : ''));
      item.innerHTML = '<span class="offline-dir-icon">&#128193;</span><span class="offline-dir-item-name">' + escapeHtml(dir.name) + '</span>';
      item.addEventListener('click', function() {
        offlineState.selectedDirId = dir.id;
        offlineState.selectedDirName = dir.name;
        var nameEl = $('#offline-dir-name');
        if (nameEl) nameEl.textContent = dir.name;
        var dropdown = $('#offline-dir-dropdown');
        if (dropdown) dropdown.style.display = 'none';
      });
      list.appendChild(item);
    });
  }

  // 创建离线下载任务
  function createOfflineTask() {
    var urlInput = $('#offline-url-input');
    if (!urlInput) return;

    var url = urlInput.value.trim();
    if (!url) {
      showToast('请输入下载链接', '&#9888;');
      return;
    }

    var btn = $('#offline-submit-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '&#128229; 创建中...';
    }

    apiPost('/offline/create', {
      url: url,
      target_dir_id: offlineState.selectedDirId || 0
    }).then(function(res) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#128229; 开始下载';
      }

      if (res.code !== 0) {
        showToast(res.message || '创建失败', '&#9888;');
        return;
      }

      urlInput.value = '';
      showToast('任务已创建，开始下载...', '&#128229;');

      // 添加到任务列表并立即开始
      if (res.data) {
        offlineState.tasks.unshift(res.data);
        // 重新渲染任务列表，确保新任务显示出来
        renderOfflineTasks();
        startOfflineTaskSilent(res.data.id);
      }
    }).catch(function() {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#128229; 开始下载';
      }
      showToast('创建失败，请检查网络', '&#9888;');
    });
  }

  // 开始下载任务（静默版，由 WebSocket 推送进度更新）
  function startOfflineTaskSilent(id) {
    apiPost('/offline/' + id + '/start').then(function(res) {
      if (res.code !== 0) {
        updateOfflineTaskInList(id, 'failed', 0, 0, res.message);
        showToast('下载失败: ' + res.message, '&#9888;');
        return;
      }
      // 等待 WebSocket 推送进度，不在这里更新
      updateOfflineTaskInList(id, 'downloading', 0, 0);
    }).catch(function() {
      updateOfflineTaskInList(id, 'failed', 0, 0, '网络错误');
    });
  }

  // 开始/继续任务
  function startOfflineTask(id) {
    apiPost('/offline/' + id + '/start').then(function(res) {
      if (res.code !== 0) {
        showToast(res.message || '启动失败', '&#9888;');
        return;
      }
      showToast('下载开始', '&#128229;');
      updateOfflineTaskInList(id, 'downloading', 0, 0);
      pollOfflineTask(id);
    }).catch(function() {
      showToast('启动失败', '&#9888;');
    });
  }

  // 暂停任务
  function pauseOfflineTask(id) {
    apiPost('/offline/' + id + '/pause').then(function(res) {
      if (res.code !== 0) {
        showToast(res.message || '暂停失败', '&#9888;');
        return;
      }
      updateOfflineTaskInList(id, 'paused', null, null);
      showToast('已暂停', '&#9208;');
    }).catch(function() {
      showToast('暂停失败', '&#9888;');
    });
  }

  // 取消任务
  function cancelOfflineTask(id) {
    if (!confirm('确定取消该下载任务？')) return;
    apiPost('/offline/' + id + '/cancel').then(function(res) {
      updateOfflineTaskInList(id, 'cancelled', null, null);
      showToast('已取消', '&#10005;');
    }).catch(function() {
      showToast('取消失败', '&#9888;');
    });
  }

  // 删除任务
  function deleteOfflineTask(id) {
    if (!confirm('确定删除该任务记录？')) return;
    apiDelete('/offline/' + id).then(function(res) {
      var item = $('#offline-task-' + id);
      if (item) item.remove();
      offlineState.tasks = offlineState.tasks.filter(function(t) { return t.id !== id; });
      updateOfflineTaskCount();
      showToast('已删除', '&#10004;');
    }).catch(function() {
      showToast('删除失败', '&#9888;');
    });
  }

  // 前往下载目录
  function gotoOfflineDownloadDir() {
    offlineState.selectedDirId = offlineState.defaultDirId;
    offlineState.selectedDirName = offlineState.defaultDirName;
    setDirType('personal');
  }

  // 更新任务列表中的单个任务
  function updateOfflineTaskInList(id, status, progress, downloaded, error) {
    var task = offlineState.tasks.find(function(t) { return t.id === id; });
    if (task) {
      if (status) task.status = status;
      if (progress !== null && progress !== undefined) task.progress = progress;
      if (downloaded !== null && downloaded !== undefined) task.downloaded_bytes = downloaded;
      if (error !== undefined) task.error = error;
    }

    var item = $('#offline-task-' + id);
    if (!item) return;

    // 更新状态徽章
    var badge = item.querySelector('.offline-status-badge');
    if (badge) {
      badge.className = 'offline-status-badge ' + status;
      badge.innerHTML = getOfflineStatusBadge(status).replace(/<[^>]+>/g, '');
    }

    // 更新操作按钮
    var actionsDiv = item.querySelector('.offline-task-actions');
    if (actionsDiv) {
      actionsDiv.innerHTML = getOfflineStatusBadge(status) + getOfflineTaskActions(task);
    }

    // 进度条：只有 downloading/completed/paused 状态才显示
    if (status === 'downloading' || status === 'completed' || status === 'paused') {
      var pbar = $('#offline-pbar-' + id);
      if (!pbar) {
        // 进度条DOM不存在（任务从pending切换过来），动态创建
        var detail = item.querySelector('.offline-task-detail');
        if (detail) {
          var progressWrap = el('div', 'offline-task-progress');
          var barWrap = el('div', 'offline-progress-bar-wrap');
          var bar = el('div', 'offline-progress-bar');
          bar.id = 'offline-pbar-' + id;
          bar.style.width = '0%';
          var info = el('div', 'offline-progress-info');
          info.innerHTML = '<span>0 B / 0 B </span><span>0%</span>';
          barWrap.appendChild(bar);
          progressWrap.appendChild(barWrap);
          progressWrap.appendChild(info);
          detail.appendChild(progressWrap);
        }
        pbar = $('#offline-pbar-' + id);
      }
      if (pbar) {
        var pct = Math.min(100, progress || 0);
        pbar.style.width = pct + '%';
        pbar.className = 'offline-progress-bar';
        if (status === 'completed') pbar.classList.add('completed');
        else if (status === 'failed') pbar.classList.add('failed');
        // 更新进度信息文本
        var infoEl = item.querySelector('.offline-progress-info');
        if (infoEl && task) {
          var dlStr = formatSize(task.downloaded_bytes || 0);
          var sizeStr = formatSize(task.total_bytes || 0);
          var speedStr = task.speed_bps > 0 ? formatSize(task.speed_bps) + '/s' : '';
          infoEl.innerHTML = '<span>' + dlStr + ' / ' + sizeStr + ' ' + speedStr + '</span><span>' + Math.round(pct) + '%</span>';
        }
      }
    }

    // 更新错误信息
    var errDiv = item.querySelector('.offline-task-error');
    if (error && !errDiv) {
      var err = el('div', 'offline-task-error');
      err.innerHTML = '&#9888; ' + escapeHtml(error);
      item.appendChild(err);
    }
  }

  // 轮询任务状态
  function pollOfflineTask(id) {
    var poll = function(count) {
      if (count <= 0) return;
      setTimeout(function() {
        apiGet('/offline/' + id).then(function(res) {
          if (res.code !== 0) {
            poll(count - 1);
            return;
          }
          var task = res.data;
          if (task) {
            updateOfflineTaskInList(id, task.status, task.progress, task.downloaded_bytes);
            if (task.status === 'downloading' || task.status === 'pending') {
              poll(count - 1);
            } else if (task.status === 'completed') {
              showToast('下载完成！', '&#10004;');
            } else if (task.status === 'failed') {
              showToast('下载失败: ' + (task.error || '未知错误'), '&#9888;');
            }
          }
        }).catch(function() {
          poll(count - 1);
        });
      }, 2000);
    };
    poll(60);
  }

  // 更新任务数量显示
  function updateOfflineUI() {
    var count = offlineState.tasks.length;
    var countEl = $('#offline-task-count');
    if (countEl) {
      countEl.textContent = count > 0 ? '(' + count + ')' : '';
    }
    var empty = $('#offline-empty');
    if (empty) {
      empty.style.display = count === 0 ? 'flex' : 'none';
    }
  }

  // 更新任务计数（兼容函数）
  function updateOfflineTaskCount() {
    updateOfflineUI();
  }

  // ==================== 离线下载 结束 ====================

  // ---------- 加载日志 ----------
  function loadAdminLogs() {
    var container = $('#page-panel-body');
    if (!container) return;

    container.innerHTML = '<div id="al-body" class="al-body"></div>';
    var body = $('#al-body');
    body.innerHTML = '';

    // 并行加载统计数据和类型
    Promise.all([
      apiGet('/logs/actions/stats'),
      apiGet('/logs/actions/types'),
      apiGet('/logs/emails/stats'),
      apiGet('/logs/emails/types')
    ]).then(function (results) {
      var statsRes = results[0];
      var typesRes = results[1];
      var emailStatsRes = results[2];
      var emailTypesRes = results[3];

      if (statsRes.code === 0) logState.actionStats = statsRes.data;
      if (typesRes.code === 0) logState.actionTypes = typesRes.data || [];
      if (emailStatsRes.code === 0) logState.emailStats = emailStatsRes.data;
      if (emailTypesRes.code === 0) logState.emailTypes = emailTypesRes.data || [];

      renderLogsView();
    }).catch(function () {
      showToast('加载日志统计失败', '&#9888;');
      renderLogsView();
    });
  }

  // ---------- 渲染日志主视图 ----------
  function renderLogsView() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '';

    // 统计卡片
    var statsRow = el('div', 'log-stats-row');

    // 操作日志统计
    var as = logState.actionStats || {};
    var es = logState.emailStats || {};

    statsRow.innerHTML =
      '<div class="log-stat-card">' +
        '<div class="log-stat-icon">&#128196;</div>' +
        '<div class="log-stat-body">' +
          '<div class="log-stat-label">今日操作</div>' +
          '<div class="log-stat-value" id="log-stat-today">' + (as.today || 0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="log-stat-card">' +
        '<div class="log-stat-icon">&#128197;</div>' +
        '<div class="log-stat-body">' +
          '<div class="log-stat-label">本周操作</div>' +
          '<div class="log-stat-value" id="log-stat-week">' + (as.week || 0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="log-stat-card">' +
        '<div class="log-stat-icon">&#128198;</div>' +
        '<div class="log-stat-body">' +
          '<div class="log-stat-label">本月操作</div>' +
          '<div class="log-stat-value" id="log-stat-month">' + (as.month || 0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="log-stat-card log-stat-card-email">' +
        '<div class="log-stat-icon">&#128231;</div>' +
        '<div class="log-stat-body">' +
          '<div class="log-stat-label">本月邮件</div>' +
          '<div class="log-stat-value" id="log-stat-email-month">' + (es.month || 0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="log-stat-card log-stat-card-email">' +
        '<div class="log-stat-icon">&#9888;</div>' +
        '<div class="log-stat-body">' +
          '<div class="log-stat-label">邮件失败</div>' +
          '<div class="log-stat-value log-stat-error" id="log-stat-email-failed">' + (es.failed || 0) + '</div>' +
        '</div>' +
      '</div>';

    container.appendChild(statsRow);

    // 分段标签
    var tabsWrap = el('div', 'log-tabs-wrap');
    var tabsInner = el('div', 'log-tabs');
    var tabActions = el('button', 'log-tab' + (logState.activeTab === 'actions' ? ' active' : ''));
    tabActions.textContent = '操作日志';
    tabActions.addEventListener('click', function () { switchLogTab('actions'); });
    var tabEmails = el('button', 'log-tab' + (logState.activeTab === 'emails' ? ' active' : ''));
    tabEmails.textContent = '邮件日志';
    tabEmails.addEventListener('click', function () { switchLogTab('emails'); });
    tabsInner.appendChild(tabActions);
    tabsInner.appendChild(tabEmails);
    tabsWrap.appendChild(tabsInner);
    container.appendChild(tabsWrap);

    // 内容区域
    var content = el('div', 'log-content');
    content.id = 'log-content';
    container.appendChild(content);

    if (logState.activeTab === 'actions') {
      renderActionLogs();
    } else {
      renderEmailLogs();
    }
  }

  // ---------- 切换标签 ----------
  function switchLogTab(tab) {
    logState.activeTab = tab;
    var tabs = document.querySelectorAll('.log-tab');
    if (tabs[0]) tabs[0].classList.toggle('active', tab === 'actions');
    if (tabs[1]) tabs[1].classList.toggle('active', tab === 'emails');
    var content = $('#log-content');
    if (content) {
      content.innerHTML = '';
      if (tab === 'actions') renderActionLogs();
      else renderEmailLogs();
    }
  }

  // ---------- 渲染操作日志 ----------
  function renderActionLogs() {
    var content = $('#log-content');
    if (!content) return;

    // 筛选栏
    var filterBar = el('div', 'log-filter-bar');
    filterBar.innerHTML =
      '<div class="log-filter-row">' +
        '<input type="text" class="log-filter-input" id="log-filter-action-user" placeholder="用户名/邮箱" style="min-width:160px;">' +
        '<select class="log-filter-select" id="log-filter-action-type">' +
          '<option value="">全部操作类型</option>' +
        '</select>' +
        '<select class="log-filter-select" id="log-filter-action-status">' +
          '<option value="">全部状态</option>' +
          '<option value="success">成功</option>' +
          '<option value="error">失败</option>' +
        '</select>' +
        '<input type="date" class="log-filter-input" id="log-filter-action-start" placeholder="开始日期">' +
        '<input type="date" class="log-filter-input" id="log-filter-action-end" placeholder="结束日期">' +
      '</div>' +
      '<div class="log-filter-row" style="margin-top:8px;">' +
        '<button class="log-filter-btn" id="log-filter-action-search">&#128269; 筛选</button>' +
        '<button class="log-filter-btn log-filter-btn-clear" id="log-filter-action-reset">重置</button>' +
        '<button class="log-filter-btn" id="log-action-refresh" style="margin-left:auto">&#8635; 刷新</button>' +
        '<button class="log-filter-btn log-filter-btn-danger" id="log-action-cleanup">&#128465; 清理日志</button>' +
      '</div>';
    content.appendChild(filterBar);

    // 填充操作类型下拉
    var typeSelect = $('#log-filter-action-type');
    if (typeSelect && logState.actionTypes.length > 0) {
      logState.actionTypes.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.action;
        opt.textContent = t.text;
        typeSelect.appendChild(opt);
      });
    }

    // 绑定筛选按钮事件
    var filterSearch = $('#log-filter-action-search');
    if (filterSearch) {
      filterSearch.addEventListener('click', function () {
        logState.actionFilters.userId = null; // 不再按 userId 筛选，改用 email
        logState.actionFilters.email = $('#log-filter-action-user').value.trim();
        logState.actionFilters.action = $('#log-filter-action-type').value;
        logState.actionFilters.status = $('#log-filter-action-status').value;
        logState.actionFilters.startDate = $('#log-filter-action-start').value;
        logState.actionFilters.endDate = $('#log-filter-action-end').value;
        logState.actionPage = 1;
        fetchActionLogs();
      });
    }
    var filterReset = $('#log-filter-action-reset');
    if (filterReset) {
      filterReset.addEventListener('click', function () {
        logState.actionFilters = { userId: null, email: '', action: null, status: null, startDate: '', endDate: '' };
        var userInput = $('#log-filter-action-user');
        var typeSel = $('#log-filter-action-type');
        var statSel = $('#log-filter-action-status');
        var startInput = $('#log-filter-action-start');
        var endInput = $('#log-filter-action-end');
        if (userInput) userInput.value = '';
        if (typeSel) typeSel.value = '';
        if (statSel) statSel.value = '';
        if (startInput) startInput.value = '';
        if (endInput) endInput.value = '';
        logState.actionPage = 1;
        fetchActionLogs();
      });
    }
    var refreshBtn = $('#log-action-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { fetchActionLogs(); });
    var cleanupBtn = $('#log-action-cleanup');
    if (cleanupBtn) cleanupBtn.addEventListener('click', function () { cleanupActionLogs(); });

    // 表格容器
    var tableWrap = el('div', 'log-table-wrap');
    tableWrap.id = 'log-action-table-wrap';
    tableWrap.innerHTML = '<div class="log-loading">&#128202; 加载中...</div>';
    content.appendChild(tableWrap);

    fetchActionLogs();
  }

  // ---------- 获取操作日志 ----------
  function fetchActionLogs() {
    var tableWrap = $('#log-action-table-wrap');
    if (tableWrap) tableWrap.innerHTML = '<div class="log-loading">&#128202; 加载中...</div>';

    var params = {
      limit: logState.pageSize,
      offset: (logState.actionPage - 1) * logState.pageSize,
      order: 'DESC'
    };
    if (logState.actionFilters.email) params.email = logState.actionFilters.email;
    if (logState.actionFilters.action) params.action = logState.actionFilters.action;
    if (logState.actionFilters.status) params.status = logState.actionFilters.status;
    if (logState.actionFilters.startDate) params.startDate = logState.actionFilters.startDate;
    if (logState.actionFilters.endDate) params.endDate = logState.actionFilters.endDate;

    var queryStr = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    apiGet('/logs/actions?' + queryStr).then(function (res) {
      if (res.code === 0) {
        logState.actionLogs = res.data.data || [];
        logState.actionTotal = res.data.total || 0;
        renderActionTable();
      } else {
        showToast(res.message || '加载失败', '&#9888;');
      }
    }).catch(function () {
      showToast('网络错误', '&#9888;');
    });
  }

  // ---------- 渲染操作日志表格 ----------
  function renderActionTable() {
    var tableWrap = $('#log-action-table-wrap');
    if (!tableWrap) return;
    tableWrap.innerHTML = '';

    var table = el('table', 'log-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['时间', '用户', '操作', '对象', '状态', 'IP地址'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);

    var tbody = el('tbody');
    if (logState.actionLogs.length === 0) {
      var emptyTr = el('tr');
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 6;
      emptyTd.textContent = '暂无日志记录';
      emptyTd.style.textAlign = 'center';
      emptyTd.style.color = 'var(--text-muted)';
      emptyTd.style.padding = '32px';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      logState.actionLogs.forEach(function (log) {
        var tr = el('tr');
        tr.innerHTML =
          '<td class="log-td-time">' + formatLogTime(log.createdAt) + '</td>' +
          '<td class="log-td-user" title="' + escHtml(log.email) + '">' + escHtml(log.email || '-') + '</td>' +
          '<td class="log-td-action"><span class="log-badge log-badge-action">' + escHtml(log.actionText || log.action) + '</span></td>' +
          '<td class="log-td-target" title="' + escHtml(log.targetName || '') + '">' + escHtml(log.targetName || '-') + '</td>' +
          '<td class="log-td-status">' + (log.status === 'success'
            ? '<span class="log-badge log-badge-success">&#10004; 成功</span>'
            : '<span class="log-badge log-badge-fail">&#10006; 失败</span>') + '</td>' +
          '<td class="log-td-ip">' + escHtml(log.ip || '-') + '</td>';
        tbody.appendChild(tr);
      });
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    // Mobile cards
    var cardsWrap = el('div', 'log-card-list');
    cardsWrap.id = 'log-action-cards';
    if (logState.actionLogs.length === 0) {
      cardsWrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无日志记录</div>';
    } else {
      var cardsHtml = '';
      logState.actionLogs.forEach(function(log) {
        cardsHtml += '<div class="log-card">' +
          '<div class="log-card-header">' +
            '<span>' + escHtml(log.actionText || log.action) + '</span>' +
            '<span>' + (log.status === 'success' ? '<span style="color:#10b981">✅ 成功</span>' : '<span style="color:#e74c3c">❌ 失败</span>') + '</span>' +
          '</div>' +
          '<div class="log-card-row"><span>时间</span><span>' + formatLogTime(log.createdAt) + '</span></div>' +
          '<div class="log-card-row"><span>用户</span><span>' + escHtml(log.email || '-') + '</span></div>' +
          '<div class="log-card-row"><span>对象</span><span style="word-break:break-all">' + escHtml(log.targetName || '-') + '</span></div>' +
          '<div class="log-card-row"><span>IP</span><span>' + escHtml(log.ip || '-') + '</span></div>' +
        '</div>';
      });
      cardsWrap.innerHTML = cardsHtml;
    }
    tableWrap.parentNode && tableWrap.parentNode.appendChild(cardsWrap);

    // 分页
    renderActionPagination();
  }

  // ---------- 操作日志分页 ----------
  function renderActionPagination() {
    var tableWrap = $('#log-action-table-wrap');
    if (!tableWrap) return;
    var totalPages = Math.ceil(logState.actionTotal / logState.pageSize);
    if (totalPages <= 1) return;

    var pager = el('div', 'log-pager');
    pager.innerHTML = '<span class="log-pager-info">共 ' + logState.actionTotal + ' 条，第 ' + logState.actionPage + '/' + totalPages + ' 页</span>';

    if (logState.actionPage > 1) {
      var prev = el('button', 'log-pager-btn');
      prev.textContent = '上一页';
      prev.addEventListener('click', function () {
        logState.actionPage--;
        fetchActionLogs();
      });
      pager.appendChild(prev);
    }
    if (logState.actionPage < totalPages) {
      var next = el('button', 'log-pager-btn');
      next.textContent = '下一页';
      next.addEventListener('click', function () {
        logState.actionPage++;
        fetchActionLogs();
      });
      pager.appendChild(next);
    }
    tableWrap.appendChild(pager);
  }

  // ---------- 清理操作日志 ----------
  function cleanupActionLogs() {
    var days = prompt('请输入保留天数（1-365），或输入 0 清空全部：', '90');
    if (days === null) return;
    days = parseInt(days, 10);
    var url;
    if (days === 0) {
      if (!confirm('确定要清空全部操作日志吗？此操作不可恢复！')) return;
      url = '/logs/actions?clearAll=true';
    } else {
      if (days < 1 || days > 365) { showToast('天数必须在 1-365 之间', '&#9888;'); return; }
      url = '/logs/actions?days=' + days;
    }
    apiDelete(url).then(function (res) {
      showToast(res.message || '清理完成', '&#10004;');
      logState.actionPage = 1;
      loadAdminLogs();
    }).catch(function () {
      showToast('清理失败', '&#9888;');
    });
  }

  // ---------- 渲染邮件日志 ----------
  function renderEmailLogs() {
    var content = $('#log-content');
    if (!content) return;

    var filterBar = el('div', 'log-filter-bar');
    filterBar.innerHTML =
      '<div class="log-filter-row">' +
        '<input type="text" class="log-filter-input" id="log-filter-email-to" placeholder="收件人邮箱" style="min-width:160px;">' +
        '<select class="log-filter-select" id="log-filter-email-tmpl">' +
          '<option value="">全部模板</option>' +
        '</select>' +
        '<select class="log-filter-select" id="log-filter-email-status">' +
          '<option value="">全部状态</option>' +
          '<option value="success">成功</option>' +
          '<option value="error">失败</option>' +
        '</select>' +
        '<input type="date" class="log-filter-input" id="log-filter-email-start" placeholder="开始日期">' +
        '<input type="date" class="log-filter-input" id="log-filter-email-end" placeholder="结束日期">' +
      '</div>' +
      '<div class="log-filter-row" style="margin-top:8px;">' +
        '<button class="log-filter-btn" id="log-filter-email-search">&#128269; 筛选</button>' +
        '<button class="log-filter-btn log-filter-btn-clear" id="log-filter-email-reset">重置</button>' +
        '<button class="log-filter-btn" id="log-email-refresh" style="margin-left:auto">&#8635; 刷新</button>' +
        '<button class="log-filter-btn log-filter-btn-danger" id="log-email-cleanup">&#128465; 清理日志</button>' +
      '</div>';
    content.appendChild(filterBar);

    var tmplSelect = $('#log-filter-email-tmpl');
    if (tmplSelect && logState.emailTypes.length > 0) {
      logState.emailTypes.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t.template;
        opt.textContent = t.text;
        tmplSelect.appendChild(opt);
      });
    }

    var filterSearch = $('#log-filter-email-search');
    if (filterSearch) {
      filterSearch.addEventListener('click', function () {
        logState.emailFilters.email = $('#log-filter-email-to').value.trim();
        logState.emailFilters.template = $('#log-filter-email-tmpl').value;
        logState.emailFilters.status = $('#log-filter-email-status').value;
        logState.emailFilters.startDate = $('#log-filter-email-start').value;
        logState.emailFilters.endDate = $('#log-filter-email-end').value;
        logState.emailPage = 1;
        fetchEmailLogs();
      });
    }
    var filterReset = $('#log-filter-email-reset');
    if (filterReset) {
      filterReset.addEventListener('click', function () {
        logState.emailFilters = { email: '', template: '', status: null, startDate: '', endDate: '' };
        var toInput = $('#log-filter-email-to');
        var tmpl = $('#log-filter-email-tmpl');
        var stat = $('#log-filter-email-status');
        var start = $('#log-filter-email-start');
        var end = $('#log-filter-email-end');
        if (toInput) toInput.value = '';
        if (tmpl) tmpl.value = '';
        if (stat) stat.value = '';
        if (start) start.value = '';
        if (end) end.value = '';
        logState.emailPage = 1;
        fetchEmailLogs();
      });
    }
    var refreshBtn = $('#log-email-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { fetchEmailLogs(); });
    var cleanupBtn = $('#log-email-cleanup');
    if (cleanupBtn) cleanupBtn.addEventListener('click', function () { cleanupEmailLogs(); });

    var tableWrap = el('div', 'log-table-wrap');
    tableWrap.id = 'log-email-table-wrap';
    tableWrap.innerHTML = '<div class="log-loading">&#128202; 加载中...</div>';
    content.appendChild(tableWrap);

    fetchEmailLogs();
  }

  // ---------- 获取邮件日志 ----------
  function fetchEmailLogs() {
    var tableWrap = $('#log-email-table-wrap');
    if (tableWrap) tableWrap.innerHTML = '<div class="log-loading">&#128202; 加载中...</div>';

    var params = {
      limit: logState.pageSize,
      offset: (logState.emailPage - 1) * logState.pageSize
    };
    if (logState.emailFilters.email) params.email = logState.emailFilters.email;
    if (logState.emailFilters.template) params.template = logState.emailFilters.template;
    if (logState.emailFilters.status) params.status = logState.emailFilters.status;
    if (logState.emailFilters.startDate) params.startDate = logState.emailFilters.startDate;
    if (logState.emailFilters.endDate) params.endDate = logState.emailFilters.endDate;

    var queryStr = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    apiGet('/logs/emails?' + queryStr).then(function (res) {
      if (res.code === 0) {
        logState.emailLogs = res.data.data || [];
        logState.emailTotal = res.data.total || 0;
        renderEmailTable();
      } else {
        showToast(res.message || '加载失败', '&#9888;');
      }
    }).catch(function () {
      showToast('网络错误', '&#9888;');
    });
  }

  // ---------- 渲染邮件日志表格 ----------
  function renderEmailTable() {
    var tableWrap = $('#log-email-table-wrap');
    if (!tableWrap) return;
    tableWrap.innerHTML = '';

    var table = el('table', 'log-table');
    var thead = el('thead');
    var headTr = el('tr');
    ['时间', '收件人', '模板', '状态', 'IP地址', '备注'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headTr.appendChild(th);
    });
    thead.appendChild(headTr);

    var tbody = el('tbody');
    if (logState.emailLogs.length === 0) {
      var emptyTr = el('tr');
      var emptyTd = document.createElement('td');
      emptyTd.colSpan = 6;
      emptyTd.textContent = '暂无邮件日志记录';
      emptyTd.style.textAlign = 'center';
      emptyTd.style.color = 'var(--text-muted)';
      emptyTd.style.padding = '32px';
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    } else {
      logState.emailLogs.forEach(function (log) {
        var tr = el('tr');
        tr.innerHTML =
          '<td class="log-td-time">' + formatLogTime(log.createdAt) + '</td>' +
          '<td class="log-td-email" title="' + escHtml(log.toEmail) + '">' + escHtml(log.toEmail || '-') + '</td>' +
          '<td class="log-td-template"><span class="log-badge log-badge-template">' + escHtml(log.templateText || log.template) + '</span></td>' +
          '<td class="log-td-status">' + (log.status === 'success'
            ? '<span class="log-badge log-badge-success">&#10004; 成功</span>'
            : '<span class="log-badge log-badge-fail">&#10006; 失败</span>') + '</td>' +
          '<td class="log-td-ip">' + escHtml(log.ip || '-') + '</td>' +
          '<td class="log-td-detail" title="' + escHtml(log.error || '') + '">' + escHtml(log.error || '-') + '</td>';
        tbody.appendChild(tr);
      });
    }

    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    // Mobile cards
    var cardsWrap = el('div', 'log-card-list');
    cardsWrap.id = 'log-email-cards';
    if (logState.emailLogs.length === 0) {
      cardsWrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">暂无邮件日志记录</div>';
    } else {
      var cardsHtml = '';
      logState.emailLogs.forEach(function(log) {
        cardsHtml += '<div class="log-card">' +
          '<div class="log-card-header">' +
            '<span>' + escHtml(log.templateText || log.template) + '</span>' +
            '<span>' + (log.status === 'success' ? '<span style="color:#10b981">✅ 成功</span>' : '<span style="color:#e74c3c">❌ 失败</span>') + '</span>' +
          '</div>' +
          '<div class="log-card-row"><span>时间</span><span>' + formatLogTime(log.createdAt) + '</span></div>' +
          '<div class="log-card-row"><span>收件人</span><span>' + escHtml(log.toEmail || '-') + '</span></div>' +
          '<div class="log-card-row"><span>IP</span><span>' + escHtml(log.ip || '-') + '</span></div>' +
          '<div class="log-card-row"><span>备注</span><span style="word-break:break-all">' + escHtml(log.error || '-') + '</span></div>' +
        '</div>';
      });
      cardsWrap.innerHTML = cardsHtml;
    }
    tableWrap.parentNode && tableWrap.parentNode.appendChild(cardsWrap);

    renderEmailPagination();
  }

  // ---------- 邮件日志分页 ----------
  function renderEmailPagination() {
    var tableWrap = $('#log-email-table-wrap');
    if (!tableWrap) return;
    var totalPages = Math.ceil(logState.emailTotal / logState.pageSize);
    if (totalPages <= 1) return;

    var pager = el('div', 'log-pager');
    pager.innerHTML = '<span class="log-pager-info">共 ' + logState.emailTotal + ' 条，第 ' + logState.emailPage + '/' + totalPages + ' 页</span>';

    if (logState.emailPage > 1) {
      var prev = el('button', 'log-pager-btn');
      prev.textContent = '上一页';
      prev.addEventListener('click', function () {
        logState.emailPage--;
        fetchEmailLogs();
      });
      pager.appendChild(prev);
    }
    if (logState.emailPage < totalPages) {
      var next = el('button', 'log-pager-btn');
      next.textContent = '下一页';
      next.addEventListener('click', function () {
        logState.emailPage++;
        fetchEmailLogs();
      });
      pager.appendChild(next);
    }
    tableWrap.appendChild(pager);
  }

  // ---------- 清理邮件日志 ----------
  function cleanupEmailLogs() {
    var days = prompt('请输入保留天数（1-365），或输入 0 清空全部：', '180');
    if (days === null) return;
    days = parseInt(days, 10);
    var url;
    if (days === 0) {
      if (!confirm('确定要清空全部邮件日志吗？此操作不可恢复！')) return;
      url = '/logs/emails?clearAll=true';
    } else {
      if (days < 1 || days > 365) { showToast('天数必须在 1-365 之间', '&#9888;'); return; }
      url = '/logs/emails?days=' + days;
    }
    apiDelete(url).then(function (res) {
      showToast(res.message || '清理完成', '&#10004;');
      logState.emailPage = 1;
      loadAdminLogs();
    }).catch(function () {
      showToast('清理失败', '&#9888;');
    });
  }

  // ---------- 工具函数 ----------
  // 北京时间（UTC+8）格式化流量记录时间
  function formatTrafficTime(timestamp) {
    if (!timestamp) return '-';
    var d = new Date(timestamp);
    if (isNaN(d.getTime())) return timestamp;
    d.setHours(d.getHours() + 8); // UTC → 北京时间
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function formatLogTime(timestamp) {
    if (!timestamp || timestamp === '(时间缺失)') return '-';
    var d = new Date(timestamp);
    if (isNaN(d.getTime())) return timestamp;
    var pad = function (n) { return n < 10 ? '0' + n : n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function escHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.__fm.state = state; // 调试用：直接访问内部状态
  window.__fm.editStorageQuota = function (userId, currentQuota) {
    var currentMB = Math.round((currentQuota || 10737418240) / 1024 / 1024);
    var newQuotaStr = prompt('设置存储空间上限（MB）\n当前: ' + currentMB + ' MB\n输入新值:', currentMB);
    if (!newQuotaStr) return;
    var newQuota = parseInt(newQuotaStr, 10);
    if (!newQuota || newQuota <= 0) { showToast('配额值无效', '&#9888;'); return; }
    apiPut('/admin/users/' + userId + '/quota', { quota_bytes: newQuota * 1024 * 1024 }).then(function (res2) {
      if (res2.code === 0) { showToast('存储配额已更新为 ' + newQuota + ' MB', '&#10004;'); loadAdminUsers(); }
      else showToast(res2.message || '更新失败', '&#9888;');
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  };

  window.__fm.editTrafficQuota = function (userId, currentQuota) {
    var currentMB = Math.round((currentQuota || 10737418240) / 1024 / 1024);
    var newQuotaStr = prompt('设置月度流量配额（MB）\n当前: ' + currentMB + ' MB\n输入新值:', currentMB);
    if (!newQuotaStr) return;
    var newQuota = parseInt(newQuotaStr, 10);
    if (!newQuota || newQuota <= 0) { showToast('配额值无效', '&#9888;'); return; }
    apiPut('/admin/traffic/quotas/user/' + userId, { quota_bytes: newQuota * 1024 * 1024 }).then(function (res2) {
      if (res2.code === 0) { showToast('月度流量配额已更新为 ' + newQuota + ' MB', '&#10004;'); loadAdminUsers(); }
      else showToast(res2.message || '更新失败', '&#9888;');
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  };

  window.__fm.toggleAdmin = function (userId, isAdmin) {
    apiPut('/admin/users/' + userId + '/admin', { is_admin: isAdmin }).then(function (res) {
      if (res.code === 0) { showToast(isAdmin ? '已设为管理员' : '已撤销管理员', '&#10004;'); loadAdminUsers(); }
      else showToast(res.message || '操作失败', '&#9888;');
    });
  };

  window.__fm.toggleActive = function (userId, isActive) {
    apiPut('/admin/users/' + userId + '/active', { is_active: isActive }).then(function (res) {
      if (res.code === 0) { showToast(isActive ? '已启用' : '已禁用', '&#10004;'); loadAdminUsers(); }
      else showToast(res.message || '操作失败', '&#9888;');
    });
  };

  window.__fm.deleteUser = function (userId) {
    apiDelete('/admin/users/' + userId).then(function (res) {
      if (res.code === 0) { showToast('用户已删除', '&#10004;'); loadAdminUsers(); }
      else showToast(res.message || '删除失败', '&#9888;');
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  };

  window.__fm.banUser = function (userId) {
    var reasons = [
      '多次上传违规文件',
      '分享违规文件',
      '恶意消耗服务器资源',
      '发布违法内容',
      '其他违规行为'
    ];
    var reason = prompt('请选择或输入封禁原因:\n' + reasons.map(function(r, i) { return (i + 1) + '. ' + r; }).join('\n') + '\n\n直接确定使用"其他违规行为"，取消则不封禁');
    if (reason === null) return;
    if (reason === '') reason = '其他违规行为';
    var days = prompt('请输入封禁天数(输入数字，0表示永久封禁):\n例如: 1(1天) / 7(7天) / 30(30天) / 0(永久)', '7');
    if (days === null) return;
    var daysNum = parseInt(days, 10) || 0;
    apiPost('/admin/users/' + userId + '/ban', { reason: reason, days: daysNum }).then(function (res) {
      if (res.code === 0) {
        showToast('用户已封禁' + (daysNum > 0 ? ' ' + daysNum + ' 天' : ' (永久)'), '&#10004;');
        loadAdminUsers();
      } else {
        showToast(res.message || '封禁失败', '&#9888;');
      }
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  };

  window.__fm.unbanUser = function (userId) {
    apiPost('/admin/users/' + userId + '/unban', {}).then(function (res) {
      if (res.code === 0) { showToast('用户已解封', '&#10004;'); loadAdminUsers(); }
      else showToast(res.message || '解封失败', '&#9888;');
    }).catch(function() { showToast('网络错误', '&#9888;'); });
  };

  // 用户配额修改已由 __fm.editUserQuota 处理

  // ---------- Search ----------
  function toggleSearch() {
    var box = $('#toolbar-search-box');
    if (!box) return;
    box.classList.toggle('active');
    if (box.classList.contains('active')) {
      var inp = $('#toolbar-search-input');
      if (inp) { inp.focus(); inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.searchQuery = inp.value; renderFiles(); } if (e.key === 'Escape') { box.classList.remove('active'); inp.value = ''; state.searchQuery = ''; renderFiles(); } }); }
      inp.addEventListener('input', function () { state.searchQuery = inp.value; renderFiles(); });
    }
  }

  // ---------- Sidebar ----------
  function initSidebar() {
    var sidebar = $('#sidebar');
    var overlay = $('#sidebar-overlay');
    var mobileBtn = $('#mobile-menu-btn');
    var closeBtn = $('#sidebar-close');

    if (!sidebar) return;

    // Mobile toggle
    if (mobileBtn) {
      mobileBtn.addEventListener('click', function() {
        sidebar.classList.add('open');
        if (overlay) overlay.classList.add('show');
        document.body.style.overflow = 'hidden';
      });
    }

    // Close button
    if (closeBtn) {
      closeBtn.addEventListener('click', closeSidebar);
    }

    // Overlay click
    if (overlay) {
      overlay.addEventListener('click', closeSidebar);
    }

    // Close on nav item click (mobile)
    $$('.sidebar-nav .nav-item').forEach(function(item) {
      item.addEventListener('click', function() {
        if (window.innerWidth < 768) {
          closeSidebar();
        }
      });
    });

    // ESC key to close
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        closeSidebar();
      }
    });
  }

  function closeSidebar() {
    var sidebar = $('#sidebar');
    var overlay = $('#sidebar-overlay');
    if (sidebar) {
      sidebar.classList.remove('open');
      sidebar.classList.remove('collapsed');
    }
    if (overlay) overlay.classList.remove('show');
    document.body.classList.remove('sidebar-collapsed');
    document.body.style.overflow = '';
    closeUserMenu();
  }

  function updateNavHighlight(viewName, dirType) {
    // Remove all active states
    $$('.sidebar-nav .nav-item').forEach(function(item) {
      item.classList.remove('active');
    });

    // Highlight based on current view
    if (viewName === 'files') {
      if (dirType === 'public') {
        var pubNav = $('#nav-public');
        if (pubNav) pubNav.classList.add('active');
      } else if (dirType === 'public-recycle') {
        // 公共回收站：只高亮管理员菜单的"公共回收站"按钮
        var pubRecycleNav = $('#nav-public-recycle');
        if (pubRecycleNav) pubRecycleNav.classList.add('active');
      } else if (dirType === 'recycle') {
        // 个人回收站：只高亮"回收站"菜单（不同时高亮"我的文件"）
        var recycleNav2 = $('#nav-recycle');
        if (recycleNav2) recycleNav2.classList.add('active');
      } else {
        // 个人目录（默认）：高亮"我的文件"
        var personalNav = $('#nav-personal');
        if (personalNav) personalNav.classList.add('active');
      }
    } else if (viewName === 'profile') {
      var profileNav = document.querySelector('.sidebar-nav .nav-item[onclick*="showView(\'profile\')"]');
      if (profileNav) profileNav.classList.add('active');
    } else if (viewName === 'change-password') {
      var pwNav = document.querySelector('.sidebar-nav .nav-item[onclick*="showView(\'change-password\')"]');
      if (pwNav) pwNav.classList.add('active');
    } else if (viewName === 'admin-users') {
      var adminNav = $('#nav-admin');
      if (adminNav) adminNav.classList.add('active');
    } else if (viewName === 'admin-logs') {
      var adminLogsNav = $('#nav-logs');
      if (adminLogsNav) adminLogsNav.classList.add('active');
    } else if (viewName === 'admin-storage') {
      var storageNav = $('#nav-storage');
      if (storageNav) storageNav.classList.add('active');
    } else if (viewName === 'admin-backup') {
      var backupNav = $('#nav-backup');
      if (backupNav) backupNav.classList.add('active');
    } else if (viewName === 'admin-tasks') {
      var tasksNav = $('#nav-tasks');
      if (tasksNav) tasksNav.classList.add('active');
    } else if (viewName === 'admin-rate-limit') {
      var rlNav = $('#nav-rate-limit');
      if (rlNav) rlNav.classList.add('active');
    } else if (viewName === 'share') {
      var shareNav = $('#nav-share');
      if (shareNav) shareNav.classList.add('active');
    } else if (viewName === 'webdav') {
      var webdavNav = $('#nav-webdav');
      if (webdavNav) webdavNav.classList.add('active');
    } else if (viewName === 'offline') {
      var offlineNav = $('#nav-offline');
      if (offlineNav) offlineNav.classList.add('active');
    } else if (viewName === 'admin-shares') {
      var sharesNav = $('#nav-shares');
      if (sharesNav) sharesNav.classList.add('active');
    } else if (viewName === 'admin-blacklist') {
      var blNav = $('#nav-blacklist');
      if (blNav) blNav.classList.add('active');
    } else if (viewName === 'admin-traffic') {
      var trafficNav = $('#nav-traffic');
      if (trafficNav) trafficNav.classList.add('active');
    } else if (viewName === 'admin-version') {
      var versionNav = $('#nav-version');
      if (versionNav) versionNav.classList.add('active');
    } else if (viewName === 'admin-webdav') {
      var wdNav = $('#nav-admin-webdav');
      if (wdNav) wdNav.classList.add('active');
    } else if (viewName === 'transfers') {
      var transfersNav = $('#nav-transfers');
      if (transfersNav) transfersNav.classList.add('active');
    }
  }

  // ---------- Toolbar Visibility ----------
  function updateToolbarVisibility() {
    var toolbar = $('#file-toolbar');
    var wrapper = $('#file-toolbar-wrapper');
    var selectBtn = $('#select-btn');
    var uploadBtn = $('#toolbar-upload-btn');
    var newFolderBtn = $('#toolbar-new-folder-btn');

    // 工具栏、包装器和选择按钮始终可见
    if (toolbar) toolbar.style.display = 'flex';
    if (wrapper) wrapper.style.display = 'block';
    if (selectBtn) selectBtn.style.display = 'flex';

    // 公共目录中的管理员专属操作：对非管理员用户隐藏
    var hideAdminActions = (state.dirType === 'public' && !state.isAdmin);
    if (uploadBtn) uploadBtn.style.display = hideAdminActions ? 'none' : '';
    if (newFolderBtn) newFolderBtn.style.display = hideAdminActions ? 'none' : '';
  }

  // 控制管理员专用导航项的可见性
  function updateAdminNavVisibility() {
    var adminNavs = $$('.admin-only');
    adminNavs.forEach(function(nav) {
      if (nav) {
        // nav-item 用 flex 布局，user-menu-item 也用 flex，统一用空字符串恢复 CSS 默认
        nav.style.display = state.isAdmin ? '' : 'none';
      }
    });
    // 更新公共回收站徽章
    if (state.isAdmin) {
      updatePublicRecycleBadge();
    }
  }

  // 更新公共回收站徽章
  function updatePublicRecycleBadge() {
    apiGet('/public-recycle').then(function(res) {
      if (res.code !== 0) return;
      var total = res.data.files.length + res.data.dirs.length;
      var badge = $('#public-recycle-badge');
      if (badge) {
        if (total > 0) {
          badge.textContent = total > 99 ? '99+' : total;
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      }
    });
  }

  // ---------- Upload Button Visibility ----------
  function updateUploadBtnVisibility() {
    var uploadBtn = $('#toolbar-upload-btn');
    if (!uploadBtn) return;
    // 回收站/公共回收站：不显示上传按钮
    if (state.dirType === 'recycle' || state.dirType === 'public-recycle') {
      uploadBtn.style.display = 'none';
    } else if (state.dirType === 'public') {
      // 公共目录：仅管理员可见
      uploadBtn.style.display = state.isAdmin ? 'flex' : 'none';
    } else {
      uploadBtn.style.display = 'flex';
    }
  }
  // ---------- View Mode ----------
  function setViewMode(mode) {
    if (!mode) mode = 'grid';
    state.viewMode = mode;
    localStorage.setItem('viewMode', mode);
    $$('.view-btn').forEach(function (btn) {
      if (btn && btn.classList) {
        btn.classList.toggle('active', btn.dataset && btn.dataset.view === mode);
      }
    });
    renderFiles();
  }

  // ---------- Upload Button Setup ----------
  function setupUploadButton() {
    var fileInput = $('#file-upload-input');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (fileInput.files && fileInput.files.length > 0) {
          handleUploadBatch(Array.prototype.slice.call(fileInput.files));
          fileInput.value = '';
        }
      });
    }
  }

  // ---------- Selection Bar Button Events ----------
  function initSelectionBar() {
    var selectAllBtn = $('#select-all-btn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', function() {
        var allFileIds = state.fileData.map(function(f) { return String(f.id); });
        var allSelected = allFileIds.length > 0 && allFileIds.every(function(id) { return state.selectedFiles.indexOf(id) !== -1; });
        if (allSelected) {
          deselectAllFiles();
        } else {
          selectAllFiles();
        }
      });
    }
    var downloadBtn = $('#sel-download-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', function() { downloadSelectedFiles(); });
    }
    var deleteBtn = $('#sel-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function() { deleteSelectedFiles(); });
    }
    var restoreBtn = $('#sel-restore-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function() { restoreSelectedFiles(); });
    }
    var shareBtn = $('#sel-share-btn');
    if (shareBtn) {
      shareBtn.addEventListener('click', function() { createShareForSelected(); });
    }
    var moveBtn = $('#sel-move-btn');
    if (moveBtn) {
      moveBtn.addEventListener('click', function() { moveSelectedFiles(); });
    }
    var cancelBtn = $('#sel-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function() { toggleSelectionMode(); });
    }
  }

  // ---------- Drag & Drop ----------
  function initDragDrop() {
    var overlay = $('#drop-overlay');
    if (!overlay) return;
    var dragging = 0;

    document.addEventListener('dragenter', function(e) {
      e.preventDefault();
      dragging++;
      overlay.style.display = 'flex';
    });

    document.addEventListener('dragleave', function(e) {
      e.preventDefault();
      dragging--;
      if (dragging <= 0) {
        dragging = 0;
        overlay.style.display = 'none';
      }
    });

    document.addEventListener('dragover', function(e) {
      e.preventDefault();
    });

    document.addEventListener('drop', function(e) {
      e.preventDefault();
      dragging = 0;
      overlay.style.display = 'none';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleUploadBatch(Array.prototype.slice.call(e.dataTransfer.files));
      }
    });
  }

  // ---------- Trigger Upload (button click) ----------
  function triggerUpload() {
    var fileInput = $('#file-upload-input');
    if (fileInput) fileInput.click();
  }

  // ---------- Handle Files (from input or drop) ----------
  function handleFiles(files) {
    if (!files || files.length === 0) return;
    handleUploadBatch(Array.prototype.slice.call(files));
  }

  // ---------- Upload Batch with Progress ----------
  // 客户端 SHA-256 计算（Web Crypto API）
  async function computeFileHash(file) {
    try {
      var buf = await file.arrayBuffer();
      var hashBuf = await crypto.subtle.digest('SHA-256', buf);
      var hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch(e) {
      return null; // 降级：不支持则返回 null
    }
  }

  // 秒传预检（个人文件上传前检查哈希）— 两阶段安全质询
  var INSTANT_MIN_SIZE = 1048576; // 1MB，小于此大小的文件不秒传

  async function checkInstantUpload(file, dirId) {
    // 小于 1MB 的文件直接走正常上传
    if (file.size < INSTANT_MIN_SIZE) return { instant: false, reason: 'too_small' };

    var hash = await computeFileHash(file);
    if (!hash) return { instant: false, reason: 'no_crypto' }; // 浏览器不支持 crypto API，走正常上传

    try {
      // Phase 1: 发送 hash+size，获取质询
      var phase1 = await axios.post('/api/files/check-hash', {
        hash: hash, size: file.size
      });
      if (phase1.data.code !== 0 || !phase1.data.data || !phase1.data.data.exists) {
        return { instant: false, hash: hash };
      }

      var challenge = phase1.data.data.challenge;
      if (!challenge) return { instant: false, hash: hash };

      // Phase 2: 读取文件指定位置的字节
      var slice = file.slice(challenge.offset, challenge.offset + challenge.length);
      var sliceBuf = await slice.arrayBuffer();
      var sliceBytes = new Uint8Array(sliceBuf);
      // 转 base64
      var b64 = btoa(String.fromCharCode.apply(null, sliceBytes));

      // Phase 2: 提交质询响应
      var phase2 = await axios.post('/api/files/instant-upload', {
        hash: hash,
        size: file.size,
        dir_id: dirId,
        name: file.name,
        token: challenge.token,
        data: b64
      });

      if (phase2.data.code === 0 && phase2.data.data && phase2.data.data.exists) {
        return { instant: true, data: phase2.data.data };
      }
      // 质询失败（code 2-7），走正常上传
      return { instant: false, hash: hash };
    } catch(e) {
      return { instant: false, hash: hash }; // 预检失败，正常上传
    }
  }

  function handleUploadBatch(files) {
    if (!files || files.length === 0) return;
    _uploadFileList = files;
    showUploadProgress(files.length);

    // 处理每个文件（支持秒传预检）
    files.forEach(function(file, i) {
      var isPublic = state.dirType === 'public';
      var dirId = isPublic ? '' : (state.currentDirId || 0);
      var postData = new FormData();
      postData.append('file', file);
      if (isPublic) {
        postData.append('dir_path', state.currentPublicPath || '');
      } else {
        postData.append('dir_id', dirId);
      }
      var uploadUrl = isPublic ? '/api/public-files/upload' : '/api/files/upload';

      // 个人文件：先做秒传预检
      function doUpload() {
        updateUploadItemStatus(i, 'uploading');
        updateUploadProgressOverall(0);
        axios.post(uploadUrl, postData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: function(progressEvent) {
            var pct = progressEvent.total > 0 ? Math.round((progressEvent.loaded / progressEvent.total) * 100) : 0;
            updateUploadProgressOverall(pct);
          }
        }).then(function(res) {
          completed++;
          if (res.data.code === 0) {
            updateUploadItemStatus(i, 'done', res.data.data && res.data.data.is_dedup ? '秒传' : '');
          } else {
            errors++;
            updateUploadItemStatus(i, 'error');
          }
          checkAllDone();
        }).catch(function() {
          completed++;
          errors++;
          updateUploadItemStatus(i, 'error');
          checkAllDone();
        });
      }

      var completed = 0, errors = 0;
      function checkAllDone() {
        updateUploadProgressOverall(Math.round((completed / files.length) * 100));
        updateUploadStatus((completed === files.length ? '上传完成！' : '上传中 ' + completed + '/' + files.length));
        if (completed === files.length) {
          setTimeout(function() { hideUploadProgress(); }, 1500);
          showToast('已上传 ' + files.length + ' 个文件' + (errors > 0 ? '（' + errors + ' 个失败）' : ''), '&#128230;');
          loadFiles(state.currentDirId);
          loadProfile();
        }
      }

      if (!isPublic && file.size > 0) {
        // 个人文件：秒传预检
        updateUploadItemStatus(i, 'checking');
        checkInstantUpload(file, dirId).then(function(result) {
          if (result && result.instant) {
            // 秒传成功！
            completed++;
            updateUploadItemStatus(i, 'done', '秒传');
            updateUploadProgressOverall(Math.round((completed / files.length) * 100));
            updateUploadStatus('秒传 ' + completed + '/' + files.length + ' (文件已存在，无需上传)');
            if (completed === files.length) {
              setTimeout(function() { hideUploadProgress(); }, 1500);
              showToast('秒传完成！' + files.length + ' 个文件无需上传', '&#9889;');
              loadFiles(state.currentDirId);
              loadProfile();
            }
          } else {
            doUpload();
          }
        }).catch(function() { doUpload(); });
      } else {
        // 公共文件或空文件：直接上传
        doUpload();
      }
    });
  }

  // Store file list for name/size access in showUploadProgress
  var _uploadFileList = [];
  function showUploadProgress(total) {
    var overlay = $('#upload-progress-overlay');
    var title = $('#upload-progress-title');
    var list = $('#upload-progress-list');
    var status = $('#upload-progress-status');
    if (!overlay) return;
    if (title) title.textContent = '正在上传 ' + total + ' 个文件';
    if (list) {
      list.innerHTML = '';
      for (var i = 0; i < total; i++) {
        var item = document.createElement('div');
        item.className = 'upload-progress-item';
        item.id = 'upload-item-' + i;
        var file = _uploadFileList[i] || {};
        item.innerHTML =
          '<span class="upload-progress-item-icon">&#128462;</span>' +
          '<span class="upload-progress-item-name" id="upload-item-name-' + i + '">' + escapeAttr(file.name || '文件') + '</span>' +
          '<span class="upload-progress-item-size" id="upload-item-size-' + i + '">' + formatFileSize(file.size || 0) + '</span>' +
          '<span class="upload-progress-item-status pending" id="upload-item-status-' + i + '">等待</span>';
        list.appendChild(item);
      }
    }
    if (status) status.textContent = '准备上传...';
    overlay.style.display = 'flex';
  }

  function updateUploadItemStatus(index, status, customText) {
    var el = $('#upload-item-status-' + index);
    if (!el) return;
    el.className = 'upload-progress-item-status ' + status;
    var texts = { pending: '等待', checking: '校验中', uploading: '上传中', done: customText || '完成', error: '失败' };
    el.textContent = texts[status] || status;
  }

  function updateUploadProgressOverall(pct) {
    var bar = $('#upload-progress-bar');
    if (bar) bar.style.width = pct + '%';
  }

  function updateUploadStatus(text) {
    var el = $('#upload-progress-status');
    if (el) el.textContent = text;
  }

  function hideUploadProgress() {
    var overlay = $('#upload-progress-overlay');
    if (overlay) overlay.style.display = 'none';
    _uploadFileList = [];
  }

  // ---------- 工具栏滚动固定 ----------
  var _lastScrollY = 0;
  var _toolbarHideTimer = null;

  function initToolbarScroll() {
    var wrapper = $('#file-toolbar-wrapper');
    if (!wrapper) return;

    function handleScroll() {
      var currentY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
      var isScrollingDown = currentY > _lastScrollY;
      var threshold = 80; // 滚动超过80px后触发

      if (isScrollingDown && currentY > threshold) {
        // 向下滚动且超过阈值，隐藏工具栏
        wrapper.classList.add('is-hidden');
        _lastScrollY = currentY;
      } else if (!isScrollingDown) {
        // 向上滚动，显示工具栏
        wrapper.classList.remove('is-hidden');
        _lastScrollY = currentY;
      } else {
        _lastScrollY = currentY;
      }
    }

    // 使用 requestAnimationFrame 优化滚动性能
    var ticking = false;
    window.addEventListener('scroll', function() {
      if (!ticking) {
        window.requestAnimationFrame(function() {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });

    // 切换视图/目录时重置滚动状态
    var origLoadFiles = window.__fm.loadFiles;
    window.__fm.loadFiles = function(dirId) {
      wrapper.classList.remove('is-hidden');
      _lastScrollY = 0;
      window.scrollTo({ top: 0, behavior: 'instant' });
      return origLoadFiles.apply(this, arguments);
    };
  }

  // ---------- Keyboard Shortcuts ----------
  function initKeyboard() {
    try {
      document.addEventListener('keydown', function (e) {
        var inInput = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); toggleSearch(); return; }
        if (e.key === 'Escape') {
          var box = $('#toolbar-search-box');
          if (box && box.classList.contains('active')) { box.classList.remove('active'); }
          closeUserMenu();
          return;
        }
        if (inInput) return;
        if (e.key === 'Backspace' && state.currentView === 'files') {
          if (state.dirType === 'public' && state.currentPublicPath) {
            e.preventDefault();
            goBackDir();
            return;
          }
          if (state.dirType === 'personal' && state.currentDirId > 0) {
            e.preventDefault();
            loadFiles(0);
            var breadcrumb = $('#breadcrumb');
            if (breadcrumb) breadcrumb.innerHTML = '<span class="breadcrumb-item current" onclick="window.__fm && window.__fm.loadRoot()">ROOT</span>';
            state.currentDirId = 0;
            return;
          }
        }
        if (e.key === 'g') { setViewMode('grid'); return; }
        if (e.key === 'l') { setViewMode('list'); return; }
        if (e.key === 't') { toggleTheme(); return; }
      });
    } catch (err) {
      console.warn('[app.js] initKeyboard 错误:', err);
    }
  }

  // ---------- Init（暴露给外部调用，home.html 会触发）----------
  window.__fm.init = function() {
    try {
      // 确保主题和视图模式先初始化
      applyTheme(state.theme);
      setViewMode(state.viewMode);
      initKeyboard();
      initSidebar();
      setupUploadButton();
      initSelectionBar();
      initDragDrop();
      initToolbarScroll(); // 工具栏滚动固定

      // 初始时隐藏文件区域，等 hash 检查完成后再显示对应内容
      var mainContent = $('#main-view');
      var pagePanel = $('#page-panel');
      if (mainContent) mainContent.style.display = 'none';

      // 加载数据（先加载用户信息，确保 isAdmin 状态已知后再渲染视图）
      loadProfile().then(function() {
        updateRecycleBadge();
        refreshUpgradeBadge();
        // 加载服务器版本号到状态栏
        axios.get('/api/version/server').then(function(r) {
          if (r.data.code === 0) {
            var el = document.getElementById('stats-version');
            if (el) el.innerHTML = '&#128640; v' + r.data.data.serverVersion;
          }
        }).catch(function(){});
        initWebSocket();
        checkAppVersion();
        // URL hash 路由恢复：先检查 hash 决定显示哪个视图
        var hash = window.location.hash.replace('#', '');
        if (hash && HASH_VIEWS.indexOf(hash.split('/')[0]) !== -1) {
          // 根据 hash 显示对应视图（不先加载文件列表）
          restoreFromHash(hash);
        } else {
          // 默认文件视图：显示主内容区并加载文件
          if (mainContent) mainContent.style.display = 'block';
          if (pagePanel) pagePanel.classList.remove('show');
          showFileToolbar(true);
          updateNavHighlight('files', state.dirType);
          loadFiles(0);
        }
      });
    } catch (err) {
      console.error('[app.js] init 错误:', err);
    }
  };

  // ---------- 对外暴露便捷方法 ----------
  window.__fm.loadRoot = function() {
    loadFiles(0);
  };
  window.__fm.toggleSearch = function() { toggleSearch(); };
  window.__fm.toggleSidebar = function() {
    var sidebar = $('#sidebar');
    if (!sidebar) return;
    var isCollapsed = sidebar.classList.contains('collapsed');
    if (isCollapsed) {
      sidebar.classList.remove('collapsed');
      document.body.classList.remove('sidebar-collapsed');
    } else {
      sidebar.classList.add('collapsed');
      document.body.classList.add('sidebar-collapsed');
    }
  };
  window.__fm.setViewMode = function(mode) { setViewMode(mode); };
  window.__fm.toggleTheme = function() { toggleTheme(); };
  window.__fm.showView = function(name) { showView(name); };
  window.__fm.hidePagePanel = function() { hidePagePanel(); };
  window.__fm.switchView = function(name) { switchView(name); };
  window.__fm.toggleUserMenu = function() { toggleUserMenu(); };
  window.__fm.closeUserMenu = function() { closeUserMenu(); };
  window.__fm.loadProfile = function() { loadProfile(); };
  window.__fm.setDirType = function(type) { setDirType(type); };
  window.__fm.toggleSelectionMode = function() { toggleSelectionMode(); };
  window.__fm.selectAllFiles = function() { selectAllFiles(); };
  window.__fm.deselectAllFiles = function() { deselectAllFiles(); };
  window.__fm.downloadSelectedFiles = function() { downloadSelectedFiles(); };
  window.__fm.deleteSelectedFiles = function() { deleteSelectedFiles(); };
  window.__fm.moveSelectedFiles = function() { moveSelectedFiles(); };
  window.__fm.createNewFolder = function() { createNewFolder(); };
  window.__fm.triggerUpload = function() { triggerUpload(); };
  window.__fm.handleFiles = function(files) { handleFiles(files); };
  window.__fm.goBackDir = function() { goBackDir(); };
  window.__fm.emptyRecycleBin = function() { emptyRecycleBin(); };
  window.__fm.updateRecycleBadge = function() { updateRecycleBadge(); };
  window.__fm.restoreItem = function(item) { restoreItem(item); };
  window.__fm.loadFiles = function(dirId) { loadFiles(dirId); };
  window.__fm.navigateToDir = function(dirId, dirName) { navigateToDir(dirId, dirName); };
  window.__fm.getState = function() { return JSON.parse(JSON.stringify(state)); };
  window.__fm.validateFileName = function(name, maxLen) { return validateFileName(name, maxLen); };
  window.__fm.validateDirName = function(name) { return validateDirName(name); };

  // ==================== Admin WebDAV 管理 ====================
  var adminWebDAVState = { links: [], total: 0, page: 1, limit: 20, searchKeyword: '', loading: false };

  function loadAdminWebDAV() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '<div id="aw-body"></div>';
    var body = $('#aw-body');
    if (!body) return;

    // Filter row
    var filterRow = el('div', 'as-filter-row');
    var searchWrap = el('div', 'as-user-search-wrap');
    var searchInput = el('input', 'af-admin-search');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索链接名、路径或用户邮箱...';
    searchInput.id = 'aw-search-input';
    searchInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text-primary);font-size:13px';
    var searchBtn = el('button', 'af-btn af-btn-primary');
    searchBtn.textContent = '搜索';
    searchBtn.style.cssText = 'padding:8px 16px;margin-left:8px';
    searchBtn.addEventListener('click', function() {
      adminWebDAVState.searchKeyword = searchInput.value.trim();
      adminWebDAVState.page = 1;
      fetchAdminWebDAV();
    });
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        adminWebDAVState.searchKeyword = searchInput.value.trim();
        adminWebDAVState.page = 1;
        fetchAdminWebDAV();
      }
    });
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(searchBtn);
    filterRow.appendChild(searchWrap);
    body.appendChild(filterRow);

    // Table container (desktop)
    var tableWrap = el('div', 'admin-table-wrap');
    var listDiv = el('div');
    listDiv.id = 'aw-list';
    tableWrap.appendChild(listDiv);
    body.appendChild(tableWrap);

    // Mobile card list
    var cardList = el('div', 'admin-card-list af-card-list');
    cardList.id = 'aw-card-list';
    body.appendChild(cardList);

    // Pager
    var pager = el('div', 'as-pager');
    pager.id = 'aw-pager';
    pager.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:16px 0 8px;font-size:12px;color:var(--text-muted)';
    body.appendChild(pager);

    fetchAdminWebDAV();
  }

  function fetchAdminWebDAV() {
    var listEl = $('#aw-list');
    var pagerEl = $('#aw-pager');
    if (!listEl) return;
    listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">加载中...</div>';
    var url = '/admin/webdav?page=' + adminWebDAVState.page + '&limit=' + adminWebDAVState.limit;
    if (adminWebDAVState.searchKeyword) url += '&keyword=' + encodeURIComponent(adminWebDAVState.searchKeyword);
    apiGet(url).then(function(res) {
      var data = res.data || {};
      adminWebDAVState.links = data.links || [];
      adminWebDAVState.total = data.total || 0;
      renderAdminWebDAV();
      renderWebDAVAdminPager(pagerEl);
    }).catch(function() { listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--error)">网络错误</div>'; });
  }

  function renderAdminWebDAV() {
    var listEl = $('#aw-list');
    if (!listEl) return;
    var links = adminWebDAVState.links;
    if (links.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">暂无 WebDAV 链接</div>';
      return;
    }
    var html = '<table class="file-table sm-file-table" style="width:100%"><thead><tr>' +
      '<th>名称 / Token</th><th>类型</th><th>所有者</th><th>路径</th><th>有效期</th><th>访问</th><th>状态</th><th class="th-menu">操作</th>' +
      '</tr></thead><tbody>';
    links.forEach(function(l) {
      var isExpired = l.is_expired;
      var isDisabled = l.disabled;
      var statusText = isDisabled ? '已禁用' : (isExpired ? '已过期' : '有效');
      var statusColor = isDisabled ? 'var(--warning)' : (isExpired ? 'var(--error)' : 'var(--success)');
      var typeLabel = l.target_type === 'personal' ? '个人' : '公共';
      // 有效期：日期 + 剩余天数
      var expiryHtml = '';
      if (l.expires_at) {
        var expDate = new Date(l.expires_at);
        var remainDays = Math.ceil((expDate - new Date()) / (24 * 3600 * 1000));
        var dateStr = l.expires_at.substring(5, 10);
        if (remainDays <= 0) {
          expiryHtml = '<span style="font-size:11px;color:var(--text-muted)">' + dateStr + '</span><br><span style="font-size:10px;color:var(--error)">已过期</span>';
        } else if (remainDays <= 3) {
          expiryHtml = '<span style="font-size:11px;color:var(--text-muted)">' + dateStr + '</span><br><span style="font-size:10px;color:var(--error);font-weight:600">剩' + remainDays + '天</span>';
        } else if (remainDays <= 30) {
          expiryHtml = '<span style="font-size:11px;color:var(--text-muted)">' + dateStr + '</span><br><span style="font-size:10px;color:var(--warning)">剩' + remainDays + '天</span>';
        } else {
          expiryHtml = '<span style="font-size:11px;color:var(--text-muted)">' + dateStr + '</span><br><span style="font-size:10px;color:var(--text-muted)">剩' + remainDays + '天</span>';
        }
      } else {
        expiryHtml = '<span style="font-size:11px;color:var(--success);font-weight:500">永久</span>';
      }
      var displayPath = l.display_path || l.target_path || '/';
      if (displayPath[0] !== '/') displayPath = '/' + displayPath;
      var ownerText = l.owner_email || l.owner_nickname || '-';
      var maskedToken = l.masked_token || '••••';

      html += '<tr class="fm-row' + (isDisabled ? '" style="opacity:0.55"' : '') + '">' +
        '<td style="max-width:260px">' +
          '<div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(l.target_name || l.link_name || '') + '">' + escHtml(l.target_name || l.link_name || '-') + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);margin-top:1px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(maskedToken) + '">' + escHtml(maskedToken) + '</div>' +
        '</td>' +
        '<td><span class="badge" style="background:var(--bg-card-hover);color:var(--text-secondary);padding:2px 8px;border-radius:4px;font-size:11px">' + typeLabel + '</span></td>' +
        '<td style="font-size:12px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(ownerText) + '">' + escHtml(ownerText) + '</td>' +
        '<td style="font-size:11px;color:var(--text-muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(displayPath) + '">' + escHtml(displayPath) + '</td>' +
        '<td>' + expiryHtml + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted);white-space:nowrap">' + (l.access_count || 0) + '次</td>' +
        '<td><span style="color:' + statusColor + ';font-size:12px;font-weight:600;white-space:nowrap">' + statusText + '</span></td>' +
        '<td class="td-menu" style="white-space:nowrap">' +
          '<button class="modal-btn modal-btn-secondary sm-btn" style="font-size:10px;padding:2px 8px" data-aw-toggle="' + l.id + '" data-aw-action="' + (isDisabled ? 'enable' : 'disable') + '">' + (isDisabled ? '启用' : '禁用') + '</button>' +
        '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    listEl.innerHTML = html;

    // Bind toggle buttons
    listEl.querySelectorAll('[data-aw-toggle]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = parseInt(btn.dataset.awToggle);
        adminToggleWebDAV(id, btn);
      });
    });

    // ---- 移动端卡片 ----
    var cardList = $('#aw-card-list');
    if (cardList) {
      if (links.length === 0) {
        cardList.innerHTML = '<div class="af-empty">暂无 WebDAV 链接</div>';
      } else {
        cardList.innerHTML = '';
        links.forEach(function(l) {
          var isExpired = l.is_expired;
          var isDisabled = l.disabled;
          var statusText = isDisabled ? '已禁用' : (isExpired ? '已过期' : '有效');
          var statusColor = isDisabled ? 'var(--warning)' : (isExpired ? 'var(--error)' : 'var(--success)');
          var typeLabel = l.target_type === 'personal' ? '个人' : '公共';
          var expiryText = l.expires_at ? l.expires_at.substring(0, 10) : '永久';
          var displayPath = l.display_path || l.target_path || '/';
          if (displayPath[0] !== '/') displayPath = '/' + displayPath;
          var ownerText = l.owner_email || l.owner_nickname || '-';
          var card = el('div', 'admin-user-card');
          card.innerHTML =
            '<div class="admin-user-card-header">' +
              '<span class="share-type-badge share-type-badge-sm" style="background:rgba(0,212,255,0.12);color:var(--accent);padding:2px 8px;border-radius:12px;font-size:10px">' + typeLabel + '</span>' +
              '<span class="as-expiry ' + (isExpired ? 'expired' : '') + '" style="font-size:11px">' + expiryText + '</span>' +
            '</div>' +
            '<div class="admin-user-card-row"><span>名称:</span><span style="font-size:12px;font-weight:600">' + escHtml(l.target_name || l.link_name || '-') + '</span></div>' +
            '<div class="admin-user-card-row"><span>Token:</span><span style="font-family:monospace;font-size:10px">' + escHtml(l.masked_token || '••••') + '</span></div>' +
            '<div class="admin-user-card-row"><span>所有者:</span><span style="font-size:11px">' + escHtml(ownerText) + '</span></div>' +
            '<div class="admin-user-card-row"><span>路径:</span><span style="font-size:11px;word-break:break-all">' + escHtml(displayPath) + '</span></div>' +
            '<div class="admin-user-card-row"><span>访问:</span><span>' + (l.access_count || 0) + '次</span><span>状态:</span><span style="color:' + statusColor + ';font-weight:600">' + statusText + '</span></div>' +
            '<div class="admin-user-card-actions">' +
              '<button class="admin-btn" data-aw-toggle="' + l.id + '">' + (isDisabled ? '启用' : '禁用') + '</button>' +
            '</div>';
          cardList.appendChild(card);
        });
        // Bind card toggle buttons
        cardList.querySelectorAll('[data-aw-toggle]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var id = parseInt(btn.dataset.awToggle);
            adminToggleWebDAV(id, btn);
          });
        });
      }
    }
  }

  function adminToggleWebDAV(id, btn) {
    // Find the link from state to get its token
    var link = null;
    for (var i = 0; i < adminWebDAVState.links.length; i++) {
      if (adminWebDAVState.links[i].id === id) { link = adminWebDAVState.links[i]; break; }
    }
    if (!link || !link._tid) return showToast('无法获取链接信息', '&#9888;');
    // Use the preserved token for the API call (admin has permission to toggle any link)
    axios.patch('/api/webdav/links/' + link._tid + '/toggle-disabled').then(function(res) {
      if (res.data.code === 0) {
        showToast(res.data.message);
        fetchAdminWebDAV();
      } else {
        showToast(res.data.message || '操作失败', '&#9888;');
      }
    }).catch(function() { showToast('操作失败', '&#9888;'); });
  }

  function renderWebDAVAdminPager(pagerEl) {
    if (!pagerEl) return;
    pagerEl.innerHTML = '';
    var total = adminWebDAVState.total;
    var page = adminWebDAVState.page;
    var limit = adminWebDAVState.limit;
    var totalPages = Math.ceil(total / limit);
    if (totalPages <= 1) return;
    var prevBtn = el('button', 'af-btn af-btn-default');
    prevBtn.textContent = '← 上一页';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', function() { if (adminWebDAVState.page > 1) { adminWebDAVState.page--; fetchAdminWebDAV(); } });
    var nextBtn = el('button', 'af-btn af-btn-default');
    nextBtn.textContent = '下一页 →';
    nextBtn.disabled = page >= totalPages;
    nextBtn.addEventListener('click', function() { if (adminWebDAVState.page < totalPages) { adminWebDAVState.page++; fetchAdminWebDAV(); } });
    var pageInfo = el('span');
    pageInfo.textContent = '第 ' + page + ' / ' + totalPages + ' 页，共 ' + total + ' 条';
    pagerEl.appendChild(prevBtn);
    pagerEl.appendChild(pageInfo);
    pagerEl.appendChild(nextBtn);
  }

  // ==================== WebDAV 链接管理 ====================
  function createWebDAVLink(item, targetType) {
    targetType = targetType || 'public';
    // 个人目录：用父目录ID（文件）或自身ID（目录）构建路径；公共目录：用相对路径
    var targetPath;
    if (targetType === 'personal') {
      targetPath = item.isDirectory ? String(item.id) : String(item.dirId || 0);
    } else {
      targetPath = item.relPath || item.path || String(item.id);
    }
    var targetName = item.name;
    var isDir = item.isDirectory;
    if (targetType === 'public' && !isDir && !item.isPublicFile) { showToast('仅支持公共目录文件/文件夹创建 WebDAV', '&#9888;'); return; }

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'webdavModal';
    overlay.innerHTML = '<div class="modal-card" style="max-width:420px">\
      <h3 style="margin:0 0 8px">创建 WebDAV 链接</h3>\
      <p style="margin:0 0 16px;font-size:13px;color:var(--text-secondary)">' + escHtml(targetName) + '</p>\
      <div style="margin-bottom:16px">\
        <label style="display:block;margin-bottom:8px;font-size:13px;color:var(--text-secondary)">有效期</label>\
        <select id="webdavExpiry" style="width:100%;padding:10px;background:var(--bg-input,#0a1220);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:Syne,sans-serif;font-size:14px">\
          <option value="30">30 天</option><option value="90">90 天</option><option value="180" selected>180 天（默认）</option><option value="365">365 天（最长）</option>\
        </select></div>\
      <div style="margin-bottom:16px">\
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">\
          <input type="checkbox" id="webdavRequireAuth" style="accent-color:var(--accent);width:16px;height:16px">\
          <span style="font-size:13px;color:var(--text-secondary)">需要登录认证（使用您的账号密码）</span>\
        </label></div>\
      <div id="webdavError" style="color:var(--error);font-size:13px;margin-bottom:12px;display:none"></div>\
      <div style="display:flex;gap:12px;justify-content:flex-end">\
        <button id="webdavCancel" class="modal-btn modal-btn-secondary">取消</button>\
        <button id="webdavConfirm" class="modal-btn modal-btn-primary">创建</button>\
      </div></div>';
    document.body.appendChild(overlay);

    document.getElementById('webdavCancel').onclick = function() { overlay.remove(); };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.getElementById('webdavConfirm').onclick = function() {
      var days = parseInt(document.getElementById('webdavExpiry').value, 10);
      var requireAuth = document.getElementById('webdavRequireAuth').checked;
      var btn = document.getElementById('webdavConfirm');
      btn.textContent = '创建中...'; btn.disabled = true;
      axios.post('/api/webdav/links', { target_type: targetType, target_path: targetPath, target_name: targetName, is_directory: isDir, expires_days: days, require_auth: requireAuth })
        .then(function(res) {
          if (res.data.code !== 0) {
            document.getElementById('webdavError').textContent = res.data.message || '创建失败';
            document.getElementById('webdavError').style.display = 'block';
            btn.textContent = '创建'; btn.disabled = false;
            return;
          }
          overlay.remove();
          showWebDAVResultModal(res.data.data);
        })
        .catch(function() {
          document.getElementById('webdavError').textContent = '网络错误';
          document.getElementById('webdavError').style.display = 'block';
          btn.textContent = '创建'; btn.disabled = false;
        });
    };
  }

  function showWebDAVResultModal(data) {
    var fullUrl = window.location.origin + data.url;
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'webdavResultModal';
    overlay.innerHTML = '<div class="modal-card" style="max-width:480px">\
      <h3 style="margin:0 0 4px">&#128194; WebDAV 链接已创建</h3>\
      <p style="margin:0 0 12px;font-size:12px;color:var(--error);font-weight:600">&#9888; 链接仅显示一次，请立即复制保存！</p>\
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">' + escHtml(data.target_name) + '</p>\
      <div style="display:flex;gap:8px;margin-bottom:8px">\
        <input id="webdavUrlInput" type="text" value="' + fullUrl + '" readonly style="flex:1;padding:10px;background:var(--bg-input);border:1px solid var(--border);border-radius:8px;color:var(--accent);font-family:monospace;font-size:12px">\
        <button id="webdavCopyBtn" class="modal-btn modal-btn-primary" style="white-space:nowrap">&#128203; 复制</button>\
      </div>\
      <p style="font-size:11px;color:var(--text-muted)">有效期至: ' + (data.expires_at ? new Date(data.expires_at).toLocaleString('zh-CN') : '-') + '</p>\
      ' + (data.require_auth ? '<p style="font-size:11px;color:var(--warning);margin-top:4px">&#128274; 需要登录认证（使用您的账号密码）</p>' : '<p style="font-size:11px;color:var(--text3);margin-top:4px">&#128275; 无需认证</p>') + '\
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">使用方法: 在文件管理器或 WebDAV 客户端中连接此地址</p>\
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">\
        <button id="webdavCloseAndReveal" class="modal-btn modal-btn-secondary">我已保存，关闭</button>\
      </div></div>';
    document.body.appendChild(overlay);

    document.getElementById('webdavCopyBtn').onclick = function() {
      var input = document.getElementById('webdavUrlInput');
      input.select(); document.execCommand('copy');
      document.getElementById('webdavCopyBtn').textContent = '✅ 已复制';
    };
    document.getElementById('webdavCloseAndReveal').onclick = function() {
      axios.post('/api/webdav/links/' + data.token + '/reveal').catch(function(){});
      overlay.remove();
    };
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  }

  function showWebDAVManage() {
    var panel = $('#page-panel');
    var panelTitle = $('#page-panel-title');
    var panelBody = $('#page-panel-body');
    if (!panel || !panelBody) return;
    panel.classList.add('show');
    if (panelTitle) panelTitle.innerHTML = '&#128194; WebDAV 管理';
    panelBody.innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-muted)">加载中...</p>';
    loadWebDAVManage();
  }

  var _webdavPage = 1;
  var _webdavPageSize = 12;
  function loadWebDAVManage() {
    var viewMode = localStorage.getItem('webdavViewMode') || 'grid';
    var pageSize = viewMode === 'list' ? 20 : 12;
    _webdavPageSize = pageSize;
    var offset = (_webdavPage - 1) * pageSize;

    axios.get('/api/webdav/links?limit=' + pageSize + '&offset=' + offset).then(function(res) {
      var data = res.data.data || {};
      var links = data.links || data || [];
      var total = data.total || (data.links ? data.links.length : (Array.isArray(data) ? data.length : 0));
      renderWebDAVManage(links, total);
    }).catch(function() {
      $('#page-panel-body').innerHTML = '<p style="text-align:center;padding:40px;color:var(--text-muted)">加载失败</p>';
    });
  }

  function renderWebDAVManage(links, total) {
    var container = $('#page-panel-body');
    if (!container) return;

    total = total || links.length;
    var viewMode = localStorage.getItem('webdavViewMode') || 'grid';
    var modeClass = 'wd-' + viewMode;

    var actionsEl = $('#page-panel-actions');
    if (actionsEl) {
      actionsEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px">' +
        '<div class="view-toggle" role="group" aria-label="视图切换" style="display:flex;border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
        '<button class="view-btn' + (viewMode === 'grid' ? ' active' : '') + '" data-view="grid" onclick="window.__fm._toggleWebDAVView(\'grid\')" title="网格视图" style="width:34px;height:34px;border:none;background:' + (viewMode === 'grid' ? 'linear-gradient(135deg,var(--accent),var(--accent2))' : 'transparent') + ';color:' + (viewMode === 'grid' ? '#fff' : 'var(--text-muted)') + ';cursor:pointer;font-size:14px">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>' +
        '<button class="view-btn' + (viewMode === 'list' ? ' active' : '') + '" data-view="list" onclick="window.__fm._toggleWebDAVView(\'list\')" title="列表视图" style="width:34px;height:34px;border:none;background:' + (viewMode === 'list' ? 'linear-gradient(135deg,var(--accent),var(--accent2))' : 'transparent') + ';color:' + (viewMode === 'list' ? '#fff' : 'var(--text-muted)') + ';cursor:pointer;font-size:14px">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>' +
        '</div>' +
        '<button class="modal-btn modal-btn-danger" style="font-size:11px;padding:4px 12px" onclick="window.__fm._deleteExpiredWebDAV()" title="删除所有已过期的 WebDAV 链接">🗑 删除已过期</button>' +
        '</div>';
    }

    if (links.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:60px 20px"><p style="font-size:36px;margin-bottom:12px">&#128194;</p><p style="color:var(--text-muted)">暂无 WebDAV 链接</p><p style="font-size:12px;color:var(--text-muted)">在公共目录中右键文件/文件夹创建</p></div>';
      return;
    }

    var totalPages = Math.ceil(total / _webdavPageSize);
    var paginationHtml = '';
    if (totalPages > 1) {
      paginationHtml = '<div class="wd-pagination" style="display:flex;align-items:center;justify-content:center;gap:6px;padding:16px 0 8px;font-size:12px;color:var(--text-muted)">';
      paginationHtml += '<button class="btn btn-outline btn-xs" onclick="window.__fm._goWebDAVPage(' + (_webdavPage - 1) + ')" ' + (_webdavPage <= 1 ? 'disabled' : '') + '>← 上一页</button>';
      paginationHtml += '<span>第 ' + _webdavPage + '/' + totalPages + ' 页 (共 ' + total + ' 条)</span>';
      paginationHtml += '<button class="btn btn-outline btn-xs" onclick="window.__fm._goWebDAVPage(' + (_webdavPage + 1) + ')" ' + (_webdavPage >= totalPages ? 'disabled' : '') + '>下一页 →</button>';
      paginationHtml += '</div>';
    }

    var html = '';
    if (viewMode === 'list') {
      html += '<div class="file-table-wrap"><table class="file-table sm-file-table table-wd"><colgroup>' +
        '<col class="col-icon-sm"><col class="col-name"><col class="col-wd-path"><col class="col-wd-url"><col class="col-wd-expiry"><col class="col-status-sm"><col class="col-menu">' +
        '</colgroup><thead><tr>' +
        '<th class="th-icon">类型</th><th>名称</th><th>路径</th><th>WebDAV 地址</th><th>有效期</th><th>状态</th><th class="th-menu">操作</th>' +
        '</tr></thead><tbody>';
      links.forEach(function(l) { html += _buildWebDAVRow(l); });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="wd-cards wd-grid">';
      links.forEach(function(l) { html += _buildWebDAVCard(l); });
      html += '</div>';
    }

    html += paginationHtml;
    container.innerHTML = html;
  }

  function _buildWebDAVRow(l) {
    var expired = l.is_expired;
    var disabled = l.disabled;
    var requireAuth = l.require_auth;
    var isDir = l.is_directory;
    var statusColor = disabled ? 'var(--warning)' : (expired ? 'var(--error)' : 'var(--success)');
    var statusLabel = disabled ? '已禁用' : (expired ? '已过期' : '有效');
    var showToken = requireAuth ? l.token : (l.is_revealed ? l.display_token : l.token);
    var showCopyBtn = !expired && !disabled && (requireAuth || !l.is_revealed);
    var displayPath = l.display_path || l.target_path || '/';
    var typeIcon = isDir
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ffc107" stroke="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#90a4ae" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var typeLabel = l.target_type === 'personal' ? '👤 个人' : '🌐 公共';
    // Near expiry: within 30 days of expires_at
    var nearExpiry = !expired && !disabled && l.expires_at && (new Date(l.expires_at) - new Date()) < 30 * 24 * 3600 * 1000 && (new Date(l.expires_at) - new Date()) > 0;
    // ---- 有效期列 ----
    var expiryHtml = '';
    if (l.expires_at) {
      var expDate = new Date(l.expires_at);
      var nowDate = new Date();
      var remainDays = Math.ceil((expDate - nowDate) / (24 * 3600 * 1000));
      var createdStr = l.created_at ? l.created_at.substring(5, 10) : '-';
      if (remainDays <= 0) {
        expiryHtml = '<span style="font-size:12px;color:var(--text-muted)">' + createdStr + '</span><br><span style="font-size:11px;color:var(--error)">已过期</span>';
      } else if (remainDays <= 3) {
        expiryHtml = '<span style="font-size:12px;color:var(--text-muted)">' + createdStr + '</span><br><span style="font-size:11px;color:var(--error);font-weight:600">剩' + remainDays + '天</span>';
      } else if (remainDays <= 30) {
        expiryHtml = '<span style="font-size:12px;color:var(--text-muted)">' + createdStr + '</span><br><span style="font-size:11px;color:var(--warning);font-weight:500">剩' + remainDays + '天</span>';
      } else {
        expiryHtml = '<span style="font-size:12px;color:var(--text-muted)">' + createdStr + '</span><br><span style="font-size:11px;color:var(--text-muted)">剩' + remainDays + '天</span>';
      }
    } else {
      var createdStr2 = l.created_at ? l.created_at.substring(5, 10) : '-';
      expiryHtml = '<span style="font-size:12px;color:var(--text-muted)">' + createdStr2 + '</span><br><span style="font-size:11px;color:var(--success)">永久</span>';
    }
    // ---- 操作按钮 ----
    var btnHtml = '';
    if (showCopyBtn) {
      btnHtml += '<button class="modal-btn modal-btn-primary" style="font-size:10px;padding:2px 7px;margin-right:3px" onclick="window.__fm._copyWebDAVUrl(\'' + l.token + '\',\'' + window.location.origin + '\',' + (requireAuth ? 'true' : 'false') + ')" title="复制链接">📋</button>';
    }
    if (!expired) {
      btnHtml += '<button class="modal-btn modal-btn-secondary" style="font-size:10px;padding:2px 7px;margin-right:3px;color:' + (disabled ? 'var(--success)' : 'var(--warning)') + '" onclick="window.__fm._toggleWebDAVDisabled(\'' + l.token + '\')" title="' + (disabled ? '启用' : '禁用') + '">' + (disabled ? '▶' : '⏸') + '</button>';
    }
    if (nearExpiry) {
      btnHtml += '<button class="modal-btn modal-btn-primary" style="font-size:10px;padding:2px 7px;margin-right:3px" onclick="window.__fm._extendWebDAV(\'' + l.token + '\')" title="续期至1年后">🔄</button>';
    }
    btnHtml += '<button class="modal-btn modal-btn-secondary wd-btn-del" style="font-size:10px;padding:2px 7px" onclick="if(confirm(\'确定删除？\'))window.__fm.deleteWebDAVLink(\'' + l.token + '\')" title="删除">🗑</button>';
    return '<tr class="fm-row' + ((expired || disabled) ? '" style="opacity:' + (expired ? '0.5' : '0.55') : '') + '">' +
      '<td class="td-icon">' + typeIcon + '</td>' +
      '<td class="td-name"><div style="font-weight:600">' + escHtml(l.target_name) + '</div><div style="font-size:10px;color:var(--text-muted);margin-top:1px">' + typeLabel + '</div></td>' +
      '<td class="td-wd-path" style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escHtml(displayPath) + '">' + escHtml(displayPath) + '</td>' +
      '<td class="td-wd-url" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escHtml(showToken) + '"><code style="font-size:10px;color:var(--accent)">' + escHtml(showToken) + '</code></td>' +
      '<td class="td-wd-expiry">' + expiryHtml + '</td>' +
      '<td class="td-status-sm" style="font-size:12px;color:' + statusColor + ';font-weight:600;white-space:nowrap">' + statusLabel + '</td>' +
      '<td class="td-menu" style="white-space:nowrap">' + btnHtml + '</td>' +
    '</tr>';
  }

  function _buildWebDAVCard(l) {
    var expired = l.is_expired;
    var disabled = l.disabled;
    var revealed = l.is_revealed;
    var requireAuth = l.require_auth;
    var isDir = l.is_directory;
    var statusColor = disabled ? 'var(--warning)' : (expired ? 'var(--error)' : 'var(--success)');
    var statusLabel = disabled ? '已禁用' : (expired ? '已过期' : '有效');
    var showToken = requireAuth ? l.token : (revealed ? l.display_token : l.token);
    var showCopyBtn = !expired && !disabled && (requireAuth || !revealed);
    var displayPath = l.display_path || l.target_path || '/';
    var typeLabel = l.target_type === 'personal' ? '👤 个人目录' : '🌐 公共目录';
    var typeColor = l.target_type === 'personal' ? 'var(--accent2)' : 'var(--accent)';
    var nearExpiry = !expired && !disabled && l.expires_at && (new Date(l.expires_at) - new Date()) < 30 * 24 * 3600 * 1000 && (new Date(l.expires_at) - new Date()) > 0;
    var typeIcon = isDir
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="#ffc107" stroke="none"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#90a4ae" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    var html = '<div class="wd-card' + ((expired || disabled) ? (expired ? ' wd-expired' : '" style="opacity:0.55') : '') + '">';
    html += '<div class="wd-card-header"><span class="wd-card-icon">' + typeIcon + '</span><span class="wd-card-name" title="' + escHtml(l.target_name) + '">' + escHtml(l.target_name) + '</span><span class="wd-card-status" style="color:' + statusColor + '">' + statusLabel + '</span></div>';
    html += '<div class="wd-card-detail wd-detail-type"><span style="color:' + typeColor + ';font-size:10px;font-weight:600;margin-right:8px">' + typeLabel + '</span><span style="font-family:monospace;color:var(--text-muted);word-break:break-all">📂 ' + escHtml(displayPath) + '</span></div>';
    html += '<div class="wd-card-detail wd-detail-url" style="font-family:monospace;font-size:12px;color:var(--accent);word-break:break-all">' + escHtml(showToken) + '</div>';
    html += '<div class="wd-card-detail wd-detail-meta" style="font-size:11px;color:var(--text-muted)">创建: ' + (l.created_at ? l.created_at.substring(0,10) : '-') + ' · 过期: ' + (l.expires_at ? l.expires_at.substring(0,10) : '永久') + ' · 访问: ' + l.access_count + '次 · <span style="color:' + (requireAuth ? 'var(--warning)' : 'var(--text-muted)') + ';font-size:10px">' + (requireAuth ? '🔒 需认证' : '🔓 无认证') + '</span></div>';
    html += '<div class="wd-card-actions">';
    if (showCopyBtn) { html += '<button class="modal-btn modal-btn-primary" style="font-size:11px;padding:4px 12px" onclick="window.__fm._copyWebDAVUrl(\'' + l.token + '\',\'' + window.location.origin + '\',' + (requireAuth ? 'true' : 'false') + ')">📋 复制链接</button>'; }
    if (!expired) {
      html += '<button class="modal-btn modal-btn-secondary" style="font-size:11px;padding:4px 12px;color:' + (disabled ? 'var(--success)' : 'var(--warning)') + '" onclick="window.__fm._toggleWebDAVDisabled(\'' + l.token + '\')">' + (disabled ? '▶ 启用' : '⏸ 禁用') + '</button>';
    }
    if (nearExpiry) {
      html += '<button class="modal-btn modal-btn-primary" style="font-size:11px;padding:4px 12px" onclick="window.__fm._extendWebDAV(\'' + l.token + '\')">🔄 续期</button>';
    }
    html += '<button class="modal-btn modal-btn-secondary wd-btn-del" style="font-size:11px;padding:4px 12px" onclick="if(confirm(\'确定删除此 WebDAV 链接？\'))window.__fm.deleteWebDAVLink(\'' + l.token + '\')">🗑 删除</button>';
    html += '</div></div>';
    return html;
  }

  function deleteWebDAVLink(token) {
    axios.delete('/api/webdav/links/' + token).then(function(res) {
      if (res.data.code === 0) { showToast('已删除'); loadWebDAVManage(); }
      else showToast(res.data.message || '删除失败', '&#9888;');
    }).catch(function() { showToast('删除失败', '&#9888;'); });
  }

  window.__fm._copyWebDAVUrl = function(token, origin, requireAuth) {
    var url = origin + '/webdav/' + token;
    copyToClipboard(url);
    showToast('已复制 WebDAV 地址');
    // 需认证的链接不隐藏 token（有密码保护），无需认证的才隐藏
    if (!requireAuth) {
      axios.post('/api/webdav/links/' + token + '/reveal').catch(function(){});
    }
    loadWebDAVManage();
  };

  // 分享相关函数赋值
  window.__fm.copyShare = copyShareUrlFn;
  window.__fm.copyShareUrl = copyShareUrlFn;
  window.__fm.shareText = shareTextFn;
  window.__fm.viewShare = viewShareFn;
  window.__fm.showShareQr = showShareQrFn;
  window.__fm._copyQrUrl = _copyQrUrlFn;
  window.__fm._shareQrText = _shareQrTextFn;
  window.__fm.deleteShareRecord = deleteShareRecordFn;
  window.__fm.showShareManage = function() { showShareManage(); };
  window.__fm._toggleShareView = function(mode) {
    localStorage.setItem('shareManageViewMode', mode);
    _sharePage = 1;
    loadShareManage();
  };
  window.__fm._goSharePage = function(page) {
    var totalPages = Math.ceil((_getShareManageData().length || _sharePageSize) / _sharePageSize);
    if (page < 1 || page > totalPages) return;
    _sharePage = page;
    loadShareManage();
  };
  window.__fm.createShareForSelected = function() { createShareForSelected(); };
  // 分享：切换禁用/启用
  window.__fm._toggleShareDisabled = function(shareId) {
    axios.patch('/api/share/' + shareId + '/toggle-disabled').then(function(res) {
      if (res.data.code === 0) { showToast(res.data.message); loadShareManage(); }
      else showToast(res.data.message || '操作失败', '&#9888;');
    }).catch(function() { showToast('操作失败', '&#9888;'); });
  };
  // 分享：批量删除过期
  window.__fm._deleteExpiredShares = function() {
    if (!confirm('确定删除所有已过期的分享？此操作不可撤销。')) return;
    axios.delete('/api/share/expired').then(function(res) {
      if (res.data.code === 0) { showToast(res.data.message); loadShareManage(); }
      else showToast(res.data.message || '删除失败', '&#9888;');
    }).catch(function() { showToast('删除失败', '&#9888;'); });
  };
  window.__fm.goOffline = function() { showView('offline'); };
  // WebDAV 相关函数
  window.__fm.createWebDAVLink = function(item) { createWebDAVLink(item); };
  window.__fm.showWebDAVManage = function() { showWebDAVManage(); };
  window.__fm._toggleWebDAVView = function(mode) {
    localStorage.setItem('webdavViewMode', mode);
    _webdavPage = 1;
    loadWebDAVManage();
  };
  window.__fm._goWebDAVPage = function(page) {
    if (page < 1) return;
    _webdavPage = page;
    loadWebDAVManage();
  };
  // WebDAV：切换禁用/启用
  window.__fm._toggleWebDAVDisabled = function(token) {
    axios.patch('/api/webdav/links/' + token + '/toggle-disabled').then(function(res) {
      if (res.data.code === 0) { showToast(res.data.message); loadWebDAVManage(); }
      else showToast(res.data.message || '操作失败', '&#9888;');
    }).catch(function() { showToast('操作失败', '&#9888;'); });
  };
  // WebDAV：续期
  window.__fm._extendWebDAV = function(token) {
    if (!confirm('将 WebDAV 链接有效期延长至一年（从今天起算），确定？')) return;
    axios.post('/api/webdav/links/' + token + '/extend').then(function(res) {
      if (res.data.code === 0) { showToast(res.data.message); loadWebDAVManage(); }
      else showToast(res.data.message || '续期失败', '&#9888;');
    }).catch(function() { showToast('续期失败', '&#9888;'); });
  };
  // WebDAV：批量删除过期
  window.__fm._deleteExpiredWebDAV = function() {
    if (!confirm('确定删除所有已过期的 WebDAV 链接？此操作不可撤销。')) return;
    axios.delete('/api/webdav/links/expired').then(function(res) {
      if (res.data.code === 0) { showToast(res.data.message); loadWebDAVManage(); }
      else showToast(res.data.message || '删除失败', '&#9888;');
    }).catch(function() { showToast('删除失败', '&#9888;'); });
  };
  window.__fm.showStorageManage = function() { showView('admin-storage'); };

  // 关于页面

  // ==================== 传输列表 ====================
  var _activeTransfers = [];
  var _transferFilter = 'all';

  function loadTransferList() {
    var container = $('#page-panel-body');
    if (!container) return;
    renderTransferList(container);
    fetchTransfers();
  }

  function renderTransferList(container, data) {
    var items = data ? data.items || [] : [];
    var total = data ? data.total : 0;
    var pendingCount = data ? data._pendingCount || 0 : 0;

    var html = '';
    html += '<div class="transfer-filters">';
    var filters = [{id:'all',label:'全部'},{id:'uploading',label:'上传中'},{id:'completed',label:'已完成'},{id:'error',label:'失败'}];
    filters.forEach(function(f) {
      html += '<button class="transfer-filter-btn' + (_transferFilter === f.id ? ' active' : '') + '" data-filter="' + f.id + '" onclick="window.__fm._filterTransfers(this.getAttribute(\'data-filter\'))">' + f.label + '</button>';
    });
    html += '</div>';

    if (pendingCount > 0) {
      html += '<div class="transfer-resume-banner" id="transfer-resume-banner">';
      html += '<span class="banner-text">⚠ 检测到 ' + pendingCount + ' 个未完成的上传任务</span>';
      html += '<button class="banner-btn" onclick="window.__fm._resumeAllTransfers()">▶ 恢复全部</button>';
      html += '<button class="banner-dismiss" onclick="this.parentElement.style.display=\'none\'">✕</button>';
      html += '</div>';
    }

    html += '<div class="transfer-list" id="transfer-list">';
    if (items.length === 0) {
      html += '<div class="transfer-empty"><div class="transfer-empty-icon">📦</div><p>暂无传输记录</p><p style="font-size:11px;color:var(--text-muted);margin-top:4px">上传文件将自动添加到此处</p></div>';
    } else {
      items.forEach(function(item) {
        html += renderTransferItem(item);
      });
    }
    html += '</div>';

    if (items.length > 0 && items.length < total) {
      html += '<div style="text-align:center;padding:16px"><button class="transfer-action-btn" onclick="window.__fm._loadMoreTransfers()">加载更多...</button></div>';
    }

    container.innerHTML = html;
  }

  function renderTransferItem(item) {
    var typeIcon = item.type === 'upload' ? '📤' : '📥';
    var typeClass = item.type === 'upload' ? 'upload' : 'download';
    var progressClass = item.status === 'completed' ? 'completed' : (item.status === 'error' ? 'error' : '');
    var statusMap = {pending:'等待中',uploading:'上传中',completed:'已完成',error:'失败',cancelled:'已取消',assembling:'组装中'};
    var statusText = statusMap[item.status] || item.status;
    var timeStr = (item.created_at || '').substring(0, 16).replace('T', ' ');

    var actionBtns = '';
    if (item.status === 'error' || item.status === 'cancelled') {
      actionBtns += '<button class="transfer-action-btn" onclick="window.__fm._retryTransfer(String(item.id))">重试</button>';
    }
    if (item.status === 'uploading' || item.status === 'pending') {
      actionBtns += '<button class="transfer-action-btn danger" onclick="window.__fm._cancelTransfer(String(item.id))">取消</button>';
    }
    if (item.status === 'completed' || item.status === 'error' || item.status === 'cancelled') {
      actionBtns += '<button class="transfer-action-btn danger" onclick="window.__fm._deleteTransfer(String(item.id))">删除</button>';
    }

    var progressHtml = '';
    if (item.status === 'uploading' || item.status === 'assembling') {
      progressHtml = '<div class="transfer-progress-wrap"><div class="transfer-progress-bar"><div class="transfer-progress-fill ' + progressClass + '" style="width:' + (item.progress || 0) + '%"></div></div></div>';
    }

    return '<div class="transfer-item">' +
      '<div class="transfer-icon ' + typeClass + '">' + typeIcon + '</div>' +
      '<div class="transfer-info">' +
        '<div class="transfer-name" title="' + escHtml(item.file_name) + '">' + escHtml(item.file_name) + '</div>' +
        '<div class="transfer-meta">' +
          '<span>' + formatFileSize(item.file_size || 0) + '</span>' +
          (item.device_name ? '<span>💻 ' + escHtml(item.device_name) + '</span>' : '') +
          '<span>' + timeStr + '</span>' +
        '</div>' +
      '</div>' +
      progressHtml +
      '<div class="transfer-status"><span class="transfer-status-badge ' + item.status + '">' + statusText + '</span></div>' +
      (actionBtns ? '<div class="transfer-actions">' + actionBtns + '</div>' : '') +
    '</div>';
  }

  function fetchTransfers() {
    var status = _transferFilter === 'all' ? 'all' : _transferFilter;
    axios.get('/api/transfers?status=' + status + '&limit=30').then(function(res) {
      if (res.data.code === 0) {
        var d = res.data.data;
        var pending = 0;
        d.items.forEach(function(item) {
          if (item.status === 'uploading' || item.status === 'pending') pending++;
        });
        d._pendingCount = pending;
        renderTransferList($('#page-panel-body'), d);
        updateTransferBadge(pending);
      }
    }).catch(function() {});
  }

  function updateTransferBadge(count) {
    var badge = $('#transfer-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Filter
  window.__fm._filterTransfers = function(filter) {
    _transferFilter = filter;
    fetchTransfers();
  };

  // Retry
  window.__fm._retryTransfer = function(id) {
    if (!confirm('确定要重试此传输吗？')) return;
    var tid = id.replace('u_', '');
    axios.post('/api/transfers/' + tid + '/retry').then(function(res) {
      if (res.data.code === 0) fetchTransfers();
    }).catch(function(err) {
      showToast('重试失败: ' + (err.message || ''), '❌');
    });
  };

  // Cancel
  window.__fm._cancelTransfer = function(id) {
    if (!confirm('确定要取消此上传吗？')) return;
    var tid = id.replace('u_', '');
    var active = _activeTransfers.find(function(t) { return String(t.taskId) === String(tid); });
    if (active) {
      active.cancelled = true;
      _activeTransfers = _activeTransfers.filter(function(t) { return t !== active; });
      axios.post('/api/transfer/upload/cancel', { transfer_id: active.transferId }).then(function() {
        fetchTransfers();
      }).catch(function() { fetchTransfers(); });
    } else {
      // Try to cancel via API
      axios.post('/api/transfer/upload/cancel', { transfer_id: '' }).then(function() {
        axios.delete('/api/transfers/' + id).then(function() { fetchTransfers(); });
      }).catch(function() { fetchTransfers(); });
    }
  };

  // Delete
  window.__fm._deleteTransfer = function(id) {
    if (!confirm('确定要删除此传输记录吗？')) return;
    axios.delete('/api/transfers/' + id).then(function(res) {
      if (res.data.code === 0) fetchTransfers();
    });
  };

  window.__fm._loadMoreTransfers = function() {
    fetchTransfers();
  };

  // Resume
  window.__fm._resumeAllTransfers = function() {
    var pendingKeys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('transfer_pending_') === 0) pendingKeys.push(k);
      }
    } catch(e) {}
    if (pendingKeys.length === 0) {
      showToast('没有可恢复的上传任务', 'ℹ');
      return;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = function() {
      var files = Array.from(input.files);
      pendingKeys.forEach(function(key) {
        try {
          var meta = JSON.parse(localStorage.getItem(key));
          var matchedFile = files.find(function(f) {
            return f.name === meta.fileName && Math.abs(f.size - meta.fileSize) < 100 && f.lastModified === meta.lastModified;
          });
          if (matchedFile) {
            _doChunkedUpload(matchedFile, meta.dirId || (state && state.currentDirId) || 0, meta.transferId, meta);
          }
        } catch(e) {}
      });
      if (files.length > 0) {
        showToast('开始恢复 ' + files.length + ' 个上传任务', '✅');
        fetchTransfers();
      }
    };
    input.click();
  };

  // ==================== 分块上传引擎 ====================
  function _doChunkedUpload(file, dirId, existingTransferId, existingMeta) {
    var CHUNK_SIZE = 4 * 1024 * 1024;
    var transferId = existingTransferId || '';
    var meta = existingMeta || null;
    var uploadedChunks = meta ? new Set(meta.uploadedChunks || []) : new Set();

    var task = {
      fileName: file.name, fileSize: file.size, lastModified: file.lastModified,
      dirId: dirId || 0, transferId: transferId, totalChunks: 0, chunkSize: CHUNK_SIZE,
      uploadedChunks: uploadedChunks, status: 'uploading', taskId: 0, cancelled: false
    };

    // Save metadata to localStorage for resume
    function saveMeta() {
      try {
        localStorage.setItem('transfer_pending_' + task.transferId, JSON.stringify({
          transferId: task.transferId, fileName: task.fileName, fileSize: task.fileSize,
          lastModified: task.lastModified, totalChunks: task.totalChunks, chunkSize: task.chunkSize,
          uploadedChunks: Array.from(task.uploadedChunks), dirId: task.dirId
        }));
      } catch(e) {}
    }

    computeFileHash(file).then(function(fileHash) {
      return axios.post('/api/transfer/upload/init', {
        file_name: file.name, file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        dir_id: task.dirId, file_hash: fileHash,
        device_id: localStorage.getItem('_fs_device_id') || '',
        device_name: /Mobile|Android/.test(navigator.userAgent) ? '手机浏览器' : 'PC浏览器'
      });
    }).then(function(res) {
      if (res.data.code !== 0) {
        task.status = 'error'; task.errorMessage = res.data.message;
        showToast('上传失败: ' + file.name + ' - ' + res.data.message, '❌');
        return;
      }
      var d = res.data.data;
      if (d.instant) {
        task.status = 'completed';
        fetchTransfers();
        if (window.__fm && window.__fm.refreshFileList) window.__fm.refreshFileList();
        showToast('秒传成功: ' + file.name, '⚡');
        return;
      }
      task.transferId = d.transfer_id;
      task.taskId = d.task_id;
      task.totalChunks = d.total_chunks;
      task.chunkSize = d.chunk_size;
      _activeTransfers.push(task);
      saveMeta();
      fetchTransfers();
      return _uploadChunks(task, file, saveMeta);
    }).catch(function(err) {
      var errMsg = '上传失败';
      if (err && err.response && err.response.data && err.response.data.message) {
        errMsg = err.response.data.message;
      } else if (err && err.message) {
        errMsg = err.message;
      }
      task.status = 'error';
      showToast('上传失败: ' + file.name + ' - ' + errMsg, '❌');
    });
  }

  function _uploadChunks(task, file, saveMeta) {
    var chain = Promise.resolve();
    for (var ci = 0; ci < task.totalChunks; ci++) {
      (function(chunkIndex) {
        chain = chain.then(function() {
          if (task.cancelled) return;
          if (task.uploadedChunks.has(chunkIndex)) return;
          var start = chunkIndex * task.chunkSize;
          var end = Math.min(start + task.chunkSize, file.size);
          var chunk = file.slice(start, end);
          return axios.post(
            '/api/transfer/upload/chunk?transfer_id=' + encodeURIComponent(task.transferId) + '&chunk_index=' + chunkIndex,
            chunk,
            { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 120000 }
          ).then(function(res) {
            if (res.data.code !== 0) throw new Error(res.data.message);
            task.uploadedChunks.add(chunkIndex);
            saveMeta();
            fetchTransfers();
          });
        });
      })(ci);
    }
    return chain.then(function() {
      if (task.cancelled) return;
      return axios.post('/api/transfer/upload/complete', { transfer_id: task.transferId });
    }).then(function(res) {
      if (res && res.data && res.data.code === 0) {
        task.status = 'completed';
        _activeTransfers = _activeTransfers.filter(function(t) { return t !== task; });
        try { localStorage.removeItem('transfer_pending_' + task.transferId); } catch(e) {}
        fetchTransfers();
        if (window.__fm && window.__fm.refreshFileList) window.__fm.refreshFileList();
        showToast('上传完成: ' + file.name, '✅');
      }
    }).catch(function(err) {
      task.status = 'error';
      task.errorMessage = err.message || '上传失败';
      _activeTransfers = _activeTransfers.filter(function(t) { return t !== task; });
      fetchTransfers();
      showToast('上传失败: ' + file.name + ' - ' + task.errorMessage, '❌');
    });
  }

  // Override upload handler to use chunked
  var _origHandleUploadBatch = handleUploadBatch;
  handleUploadBatch = function(files) {
    if (!files || files.length === 0) return;
    if (!state || !state.currentDirId) { state.currentDirId = 0; }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.size === 0) continue;
      _doChunkedUpload(file, state.currentDirId || 0, null, null);
    }
    showView('transfers');
    showToast('已添加 ' + files.length + ' 个文件到上传队列', '📤');
  };

  // Check pending on load
  window.__fm._checkPendingTransfers = function() {
    axios.get('/api/transfers/pending').then(function(res) {
      if (res.data.code === 0 && res.data.data.pending.length > 0) {
        updateTransferBadge(res.data.data.pending.length);
      }
    }).catch(function() {});
  };



  // ==================== 传输列表 ====================
  var _activeTransfers = [];
  var _transferFilter = 'all';

  function loadTransferList() {
    var container = $('#page-panel-body');
    if (!container) return;
    renderTransferList(container);
    fetchTransfers();
  }

  function renderTransferList(container, data) {
    var items = data ? data.items || [] : [];
    var total = data ? data.total : 0;
    var pendingCount = data ? data._pendingCount || 0 : 0;

    var html = '';
    html += '<div class="transfer-filters">';
    var filters = [{id:'all',label:'全部'},{id:'uploading',label:'上传中'},{id:'completed',label:'已完成'},{id:'error',label:'失败'}];
    filters.forEach(function(f) {
      html += '<button class="transfer-filter-btn' + (_transferFilter === f.id ? ' active' : '') + '" data-filter="' + f.id + '">' + f.label + '</button>';
    });
    html += '</div>';

    if (pendingCount > 0) {
      html += '<div class="transfer-resume-banner" id="transfer-resume-banner">';
      html += '<span class="banner-text">⚠ 检测到 ' + pendingCount + ' 个未完成的上传任务</span>';
      html += '<button class="banner-btn" onclick="window.__fm._resumeAllTransfers()">▶ 恢复全部</button>';
      html += '<button class="banner-dismiss" onclick="var t=this.parentElement;t.parentElement.removeChild(t)">✕</button>';
      html += '</div>';
    }

    html += '<div class="transfer-list" id="transfer-list">';
    if (items.length === 0) {
      html += '<div class="transfer-empty"><div class="transfer-empty-icon">📦</div><p>暂无传输记录</p><p style="font-size:11px;color:var(--text-muted);margin-top:4px">上传文件将自动添加到此处</p></div>';
    } else {
      items.forEach(function(item) {
        html += renderTransferItem(item);
      });
    }
    html += '</div>';

    if (items.length > 0 && items.length < total) {
      html += '<div style="text-align:center;padding:16px"><button class="transfer-action-btn" onclick="window.__fm._loadMoreTransfers()">加载更多...</button></div>';
    }

    container.innerHTML = html;

    // Event delegation for transfer list buttons
    container.onclick = function(e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      // Filter buttons
      var filter = btn.getAttribute('data-filter');
      if (filter) { window.__fm._filterTransfers(filter); return; }
      // Action buttons
      var action = btn.getAttribute('data-action');
      var id = btn.getAttribute('data-id');
      if (!action) return;
      if (action === 'retry') window.__fm._retryTransfer(id);
      else if (action === 'cancel') window.__fm._cancelTransfer(id);
      else if (action === 'delete') window.__fm._deleteTransfer(id);
    };
  }

  function renderTransferItem(item) {
    var typeIcon = item.type === 'upload' ? '📤' : '📥';
    var typeClass = item.type === 'upload' ? 'upload' : 'download';
    var progressClass = item.status === 'completed' ? 'completed' : (item.status === 'error' ? 'error' : '');
    var statusMap = {pending:'等待中',uploading:'上传中',completed:'已完成',error:'失败',cancelled:'已取消',assembling:'组装中'};
    var statusText = statusMap[item.status] || item.status;
    var timeStr = (item.created_at || '').substring(0, 16).replace('T', ' ');

    var actionBtns = '';
    if (item.status === 'error' || item.status === 'cancelled') {
      actionBtns += '<button class="transfer-action-btn" data-action="retry" data-id="' + item.id + '">重试</button>';
    }
    if (item.status === 'uploading' || item.status === 'pending') {
      actionBtns += '<button class="transfer-action-btn danger" data-action="cancel" data-id="' + item.id + '">取消</button>';
    }
    if (item.status === 'completed' || item.status === 'error' || item.status === 'cancelled') {
      actionBtns += '<button class="transfer-action-btn danger" data-action="delete" data-id="' + item.id + '">删除</button>';
    }

    var progressHtml = '';
    if (item.status === 'uploading' || item.status === 'assembling') {
      progressHtml = '<div class="transfer-progress-wrap"><div class="transfer-progress-bar"><div class="transfer-progress-fill ' + progressClass + '" style="width:' + (item.progress || 0) + '%"></div></div></div>';
    }

    return '<div class="transfer-item">' +
      '<div class="transfer-icon ' + typeClass + '">' + typeIcon + '</div>' +
      '<div class="transfer-info">' +
        '<div class="transfer-name" title="' + escHtml(item.file_name) + '">' + escHtml(item.file_name) + '</div>' +
        '<div class="transfer-meta">' +
          '<span>' + formatFileSize(item.file_size || 0) + '</span>' +
          (item.device_name ? '<span>💻 ' + escHtml(item.device_name) + '</span>' : '') +
          '<span>' + timeStr + '</span>' +
        '</div>' +
      '</div>' +
      progressHtml +
      '<div class="transfer-status"><span class="transfer-status-badge ' + item.status + '">' + statusText + '</span></div>' +
      (actionBtns ? '<div class="transfer-actions">' + actionBtns + '</div>' : '') +
    '</div>';
  }

  function fetchTransfers() {
    var status = _transferFilter === 'all' ? 'all' : _transferFilter;
    axios.get('/api/transfers?status=' + status + '&limit=30').then(function(res) {
      if (res.data.code === 0) {
        var d = res.data.data;
        var pending = 0;
        d.items.forEach(function(item) {
          if (item.status === 'uploading' || item.status === 'pending') pending++;
        });
        d._pendingCount = pending;
        renderTransferList($('#page-panel-body'), d);
        updateTransferBadge(pending);
      }
    }).catch(function() {});
  }

  function updateTransferBadge(count) {
    var badge = $('#transfer-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // Filter
  window.__fm._filterTransfers = function(filter) {
    _transferFilter = filter;
    fetchTransfers();
  };

  // Retry
  window.__fm._retryTransfer = function(id) {
    if (!confirm('确定要重试此传输吗？')) return;
    var tid = id.replace('u_', '');
    axios.post('/api/transfers/' + tid + '/retry').then(function(res) {
      if (res.data.code === 0) fetchTransfers();
    }).catch(function(err) {
      showToast('重试失败: ' + (err.message || ''), '❌');
    });
  };

  // Cancel
  window.__fm._cancelTransfer = function(id) {
    if (!confirm('确定要取消此上传吗？')) return;
    var tid = id.replace('u_', '');
    var active = _activeTransfers.find(function(t) { return String(t.taskId) === String(tid); });
    if (active) {
      active.cancelled = true;
      _activeTransfers = _activeTransfers.filter(function(t) { return t !== active; });
      axios.post('/api/transfer/upload/cancel', { transfer_id: active.transferId }).then(function() {
        fetchTransfers();
      }).catch(function() { fetchTransfers(); });
    } else {
      // Try to cancel via API
      axios.post('/api/transfer/upload/cancel', { transfer_id: '' }).then(function() {
        axios.delete('/api/transfers/' + id).then(function() { fetchTransfers(); });
      }).catch(function() { fetchTransfers(); });
    }
  };

  // Delete
  window.__fm._deleteTransfer = function(id) {
    if (!confirm('确定要删除此传输记录吗？')) return;
    axios.delete('/api/transfers/' + id).then(function(res) {
      if (res.data.code === 0) fetchTransfers();
    });
  };

  window.__fm._loadMoreTransfers = function() {
    fetchTransfers();
  };

  // Resume
  window.__fm._resumeAllTransfers = function() {
    var pendingKeys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('transfer_pending_') === 0) pendingKeys.push(k);
      }
    } catch(e) {}
    if (pendingKeys.length === 0) {
      showToast('没有可恢复的上传任务', 'ℹ');
      return;
    }
    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = function() {
      var files = Array.from(input.files);
      pendingKeys.forEach(function(key) {
        try {
          var meta = JSON.parse(localStorage.getItem(key));
          var matchedFile = files.find(function(f) {
            return f.name === meta.fileName && Math.abs(f.size - meta.fileSize) < 100 && f.lastModified === meta.lastModified;
          });
          if (matchedFile) {
            _doChunkedUpload(matchedFile, meta.dirId || (state && state.currentDirId) || 0, meta.transferId, meta);
          }
        } catch(e) {}
      });
      if (files.length > 0) {
        showToast('开始恢复 ' + files.length + ' 个上传任务', '✅');
        fetchTransfers();
      }
    };
    input.click();
  };

  // ==================== 分块上传引擎 ====================
  function _doChunkedUpload(file, dirId, existingTransferId, existingMeta) {
    var CHUNK_SIZE = 4 * 1024 * 1024;
    var transferId = existingTransferId || '';
    var meta = existingMeta || null;
    var uploadedChunks = meta ? new Set(meta.uploadedChunks || []) : new Set();

    var task = {
      fileName: file.name, fileSize: file.size, lastModified: file.lastModified,
      dirId: dirId || 0, transferId: transferId, totalChunks: 0, chunkSize: CHUNK_SIZE,
      uploadedChunks: uploadedChunks, status: 'uploading', taskId: 0, cancelled: false
    };

    // Save metadata to localStorage for resume
    function saveMeta() {
      try {
        localStorage.setItem('transfer_pending_' + task.transferId, JSON.stringify({
          transferId: task.transferId, fileName: task.fileName, fileSize: task.fileSize,
          lastModified: task.lastModified, totalChunks: task.totalChunks, chunkSize: task.chunkSize,
          uploadedChunks: Array.from(task.uploadedChunks), dirId: task.dirId
        }));
      } catch(e) {}
    }

    computeFileHash(file).then(function(fileHash) {
      return axios.post('/api/transfer/upload/init', {
        file_name: file.name, file_size: file.size,
        mime_type: file.type || 'application/octet-stream',
        dir_id: task.dirId, file_hash: fileHash,
        device_id: localStorage.getItem('_fs_device_id') || '',
        device_name: /Mobile|Android/.test(navigator.userAgent) ? '手机浏览器' : 'PC浏览器'
      });
    }).then(function(res) {
      if (res.data.code !== 0) {
        task.status = 'error'; task.errorMessage = res.data.message;
        showToast('上传失败: ' + file.name + ' - ' + res.data.message, '❌');
        return;
      }
      var d = res.data.data;
      if (d.instant) {
        task.status = 'completed';
        fetchTransfers();
        if (window.__fm && window.__fm.refreshFileList) window.__fm.refreshFileList();
        showToast('秒传成功: ' + file.name, '⚡');
        return;
      }
      task.transferId = d.transfer_id;
      task.taskId = d.task_id;
      task.totalChunks = d.total_chunks;
      task.chunkSize = d.chunk_size;
      _activeTransfers.push(task);
      saveMeta();
      fetchTransfers();
      return _uploadChunks(task, file, saveMeta);
    }).catch(function(err) {
      var errMsg = '上传失败';
      if (err && err.response && err.response.data && err.response.data.message) {
        errMsg = err.response.data.message;
      } else if (err && err.message) {
        errMsg = err.message;
      }
      task.status = 'error';
      showToast('上传失败: ' + file.name + ' - ' + errMsg, '❌');
    });
  }

  function _uploadChunks(task, file, saveMeta) {
    var chain = Promise.resolve();
    for (var ci = 0; ci < task.totalChunks; ci++) {
      (function(chunkIndex) {
        chain = chain.then(function() {
          if (task.cancelled) return;
          if (task.uploadedChunks.has(chunkIndex)) return;
          var start = chunkIndex * task.chunkSize;
          var end = Math.min(start + task.chunkSize, file.size);
          var chunk = file.slice(start, end);
          return axios.post(
            '/api/transfer/upload/chunk?transfer_id=' + encodeURIComponent(task.transferId) + '&chunk_index=' + chunkIndex,
            chunk,
            { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 120000 }
          ).then(function(res) {
            if (res.data.code !== 0) throw new Error(res.data.message);
            task.uploadedChunks.add(chunkIndex);
            saveMeta();
            fetchTransfers();
          });
        });
      })(ci);
    }
    return chain.then(function() {
      if (task.cancelled) return;
      return axios.post('/api/transfer/upload/complete', { transfer_id: task.transferId });
    }).then(function(res) {
      if (res && res.data && res.data.code === 0) {
        task.status = 'completed';
        _activeTransfers = _activeTransfers.filter(function(t) { return t !== task; });
        try { localStorage.removeItem('transfer_pending_' + task.transferId); } catch(e) {}
        fetchTransfers();
        if (window.__fm && window.__fm.refreshFileList) window.__fm.refreshFileList();
        showToast('上传完成: ' + file.name, '✅');
      }
    }).catch(function(err) {
      task.status = 'error';
      task.errorMessage = err.message || '上传失败';
      _activeTransfers = _activeTransfers.filter(function(t) { return t !== task; });
      fetchTransfers();
      showToast('上传失败: ' + file.name + ' - ' + task.errorMessage, '❌');
    });
  }

  // Override upload handler to use chunked
  var _origHandleUploadBatch = handleUploadBatch;
  handleUploadBatch = function(files) {
    if (!files || files.length === 0) return;
    if (!state || !state.currentDirId) { state.currentDirId = 0; }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.size === 0) continue;
      _doChunkedUpload(file, state.currentDirId || 0, null, null);
    }
    showView('transfers');
    showToast('已添加 ' + files.length + ' 个文件到上传队列', '📤');
  };

  // Check pending on load
  window.__fm._checkPendingTransfers = function() {
    axios.get('/api/transfers/pending').then(function(res) {
      if (res.data.code === 0 && res.data.data.pending.length > 0) {
        updateTransferBadge(res.data.data.pending.length);
      }
    }).catch(function() {});
  };


  function loadAboutPage() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '<div style="padding:20px 0;text-align:center;font-size:13px;color:var(--text-muted)">加载中...</div>';

    axios.get('/api/version/server').then(function(res) {
      if (res.data.code !== 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">加载失败</div>';
        return;
      }
      var d = res.data.data;
      var html = '<div style="max-width:680px;margin:0 auto;padding:20px">';

      // Logo + 名称
      html += '<div style="text-align:center;margin-bottom:28px">';
      html += '<img src="/favicon.png" alt="FMS" style="width:64px;height:64px;border-radius:16px;margin-bottom:12px">';
      html += '<h2 style="font-size:22px;font-weight:800;color:var(--text-primary);margin:0">FMS 文件管理系统</h2>';
      html += '<p style="font-size:12px;color:var(--text-muted);margin:4px 0 0">' + escHtml(d.description) + '</p>';
      html += '</div>';

      // ======== 核心特性卡片 ========
      html += '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:0 0 12px;text-align:left">⚡ 核心特性</h3>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:20px">';

      // WebDAV 卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '📡' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">WebDAV 协议</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">支持标准 WebDAV 协议挂载为网络驱动器，公共目录与个人加密目录均可映射，支持 PROPFIND/PUT/MOVE/COPY/LOCK 等标准操作</p>';
      html += '</div>';

      // 加密卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '🔐' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">AES-256 加密</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">所有个人文件采用 AES-256-GCM 分块加密存储，密钥由用户密码派生，端到端保护数据安全</p>';
      html += '</div>';

      // 秒传卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '⚡' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">哈希秒传</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">基于 SHA-256 + 随机字节质询的安全秒传机制，相同文件无需重复上传，节省带宽与存储空间</p>';
      html += '</div>';

      // 分享卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '🔗' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">文件分享</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">支持个人/公共文件分享，可设提取码、有效期、下载次数限制，一键生成分享链接与二维码</p>';
      html += '</div>';

      // 存储架构卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '🗄️' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">存储组 & 镜像</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">多存储组权重负载均衡，多镜像自动同步，支持存储组迁移/重组/回滚，数据冗余安全保障</p>';
      html += '</div>';

      // 离线下载卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '📥' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">离线下载</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">服务器代理下载远程文件到个人存储，支持进度追踪、断点续传、多任务并行，完成后自动通知</p>';
      html += '</div>';

      // 流量统计卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '📊' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">实时流量统计</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">HTTP层拦截响应字节实时计数，请求流量按用户活跃会话聚合(3分钟无活动刷入DB)，文件传输流量按实际传输字节记录，下载取消不扣</p>';
      html += '</div>';

      // 数据备份卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '💾' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">数据备份</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">定时备份 SQLite 数据库和存储文件到本地/远程路径，异步任务调度执行，管理后台可视化查看备份记录</p>';
      html += '</div>';

      // 非活跃调度卡片
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px">';
      html += '<div style="font-size:22px;margin-bottom:6px">' + '⏱️' + '</div>';
      html += '<h4 style="font-size:13px;font-weight:700;color:var(--text-primary);margin:0 0 4px">非活跃自动管理</h4>';
      html += '<p style="font-size:11px;color:var(--text-muted);line-height:1.5;margin:0">分享链接和 WebDAV 链接超过设定天数未访问则自动禁用，即将到期时邮件通知创建者，减少安全风险</p>';
      html += '</div>';
      html += '</div>';

      // ======== 版本信息 ========
      html += '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:0 0 12px;text-align:left">📊 系统信息</h3>';
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px">';
      var verRows = [
        ['服务端版本', 'v' + escHtml(d.serverVersion), 'var(--accent)'],
        ['Android App', (d.apkVersion !== '-' ? 'v' + escHtml(d.apkVersion) : '暂无'), 'var(--accent2)'],
        ['运行环境', escHtml(d.nodeVersion || '-'), 'var(--text-muted)'],
        ['数据库', 'SQLite (sql.js)', 'var(--text-muted)']
      ];
      verRows.forEach(function(vr, i) {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0' + (i < verRows.length - 1 ? ';border-bottom:1px solid var(--border)' : '') + '">';
        html += '<span style="color:var(--text-secondary);font-size:13px">' + vr[0] + '</span>';
        html += '<span style="font-family:Share Tech Mono,monospace;color:' + vr[2] + ';font-weight:600;font-size:14px">' + vr[1] + '</span>';
        html += '</div>';
      });
      html += '</div>';

      // ======== 最近更新 ========
      html += '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:0 0 12px;text-align:left">📋 最近更新</h3>';
      html += '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px">';
      if (d.apkNotes) {
        html += '<div style="margin-bottom:12px">';
        html += '<span style="font-size:11px;color:var(--accent);font-weight:600;background:var(--accent);color:#fff;padding:2px 8px;border-radius:4px">App v' + escHtml(d.apkVersion) + '</span>';
        html += '<p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:8px 0 0;white-space:pre-wrap">' + escHtml(d.apkNotes) + '</p>';
        html += '</div>';
      }
      html += '<div>';
      html += '<span style="font-size:11px;color:var(--accent2);font-weight:600;background:var(--accent2);color:#fff;padding:2px 8px;border-radius:4px">服务端 v' + escHtml(d.serverVersion) + '</span>';
      html += '<ul style="font-size:12px;color:var(--text-secondary);line-height:1.8;margin:8px 0 0;padding-left:18px">';
      html += '<li>实时流量统计：HTTP层拦截计数、活跃会话聚合、下载取消不扣流量</li>';
      html += '<li>WebDAV 流量记录修复：上传/下载正确归属到 Link 创建者</li>';
      html += '<li>修复秒传文件下载 410 错误：storage_path 为空时自动解析</li>';
      html += '<li>数据备份系统：定时备份数据库与文件，异步任务调度执行</li>';
      html += '<li>非活跃自动管理：分享/WebDAV 闲置超期自动禁用并邮件通知</li>';
      html += '<li>AES-256-GCM 分块加密存储（V1 格式，支持 Range）</li>';
      html += '<li>多存储组权重负载均衡 + 镜像自动同步 + 健康检查</li>';
      html += '<li>安全秒传：SHA-256 哈希 + 随机字节质询验证</li>';
      html += '<li>可配置频率限制与 IP 封禁管理</li>';
      html += '<li>离线下载 + WebSocket 实时进度推送</li>';
      html += '<li>文件分享（提取码/有效期/下载次数限制/二维码）</li>';
      html += '<li>回收站 30 天自动清理 + 物理文件引用追踪</li>';
      html += '</ul>';
      html += '</div>';
      html += '</div>';

      // ======== GitHub 仓库 ========
      html += '<h3 style="font-size:14px;font-weight:700;color:var(--text-primary);margin:0 0 12px;text-align:left">' + '🐙' + ' 开源仓库</h3>';
      html += '<div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">';
      // 服务端
      html += '<a href="' + escHtml(d.github) + '" target="_blank" style="flex:1;min-width:200px;display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;color:var(--text-secondary);text-decoration:none;transition:all .2s" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">';
      html += '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>';
      html += '<div><div style="font-size:13px;font-weight:700;color:var(--text-primary)">FMS-Service</div><div style="font-size:11px;color:var(--text-muted)">服务端 · Node.js</div></div>';
      html += '</a>';
      // App
      html += '<a href="' + escHtml(d.githubApp) + '" target="_blank" style="flex:1;min-width:200px;display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;color:var(--text-secondary);text-decoration:none;transition:all .2s" onmouseover="this.style.borderColor=\'var(--accent2)\'" onmouseout="this.style.borderColor=\'var(--border)\'">';
      html += '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>';
      html += '<div><div style="font-size:13px;font-weight:700;color:var(--text-primary)">FMS-Service-app</div><div style="font-size:11px;color:var(--text-muted)">Android · Capacitor</div></div>';
      html += '</a>';
      html += '</div>';

      html += '</div>';
      container.innerHTML = html;
    }).catch(function() {
      container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted)">网络错误</div>';
    });
  }

  // 存储管理页面（iframe 内嵌），tab 参数可选指定打开的标签页
  function loadAdminStorage(tab) {
    var container = $('#page-panel-body');
    if (!container) return;
    var src = '/admin-storage.html?embed=1';
    if (tab) src += '&tab=' + encodeURIComponent(tab);
    container.innerHTML = '<iframe src="' + src + '" ' +
      'style="width:100%;height:100%;border:none;min-height:600px" ' +
      'id="storage-iframe"></iframe>';
    // 高亮侧边栏
    updateNavHighlight('admin-storage');
  }
  function loadAdminBackup() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '<iframe src="/admin-backup.html?embed=1&v=3" ' +
      'style="width:100%;height:100%;border:none;min-height:600px" ' +
      'id="backup-iframe"></iframe>';
    updateNavHighlight('admin-backup');
    // 发送当前主题到 iframe
    setTimeout(function() {
      var iframe = document.getElementById('backup-iframe');
      if (iframe && iframe.contentWindow && state && state.theme) {
        iframe.contentWindow.postMessage({ type: 'theme-change', theme: state.theme }, '*');
      }
    }, 300);
  }
  function loadAdminTasks() {
    var container = $('#page-panel-body');
    if (!container) return;
    container.innerHTML = '<iframe src="/admin-tasks.html?embed=1&v=4" ' +
      'style="width:100%;height:100%;border:none;min-height:600px" ' +
      'id="tasks-iframe"></iframe>';
    updateNavHighlight('admin-tasks');
    // 发送当前主题到 iframe
    setTimeout(function() {
      var iframe = document.getElementById('tasks-iframe');
      if (iframe && iframe.contentWindow && state && state.theme) {
        iframe.contentWindow.postMessage({ type: 'theme-change', theme: state.theme }, '*');
      }
    }, 300);
  }
  window.__fm.deleteWebDAVLink = function(token) { deleteWebDAVLink(token); };
  // 将分享卡片 onclick 中调用的内部函数暴露到全局
  window.__fm.copyToClipboard = function(text) { copyToClipboard(text); };
  window.__fm.forceLogoutDevice = function(sid) {
    if (!confirm('确定要强制下线该设备吗？')) return;
    axios.post('/api/auth/devices/logout', { sid: sid }, { withCredentials: true }).then(function(r) {
      if (r.data.code === 0) { showToast('设备已下线', '&#9989;'); loadProfile(); }
      else showToast(r.data.message || '操作失败', '&#9888;');
    }).catch(function() { showToast('操作失败', '&#9888;'); });
  };
  window.__fm.showToast = function(msg, icon) { showToast(msg, icon); };
  // 离线下载相关函数暴露
  window.__fm.loadOffline = function() { loadOffline(); };
  window.__fm.createOfflineTask = function() { createOfflineTask(); };
  window.__fm.toggleDirPicker = function() { toggleDirPicker(); };
  window.__fm.startOfflineTask = function(id) { startOfflineTask(id); };
  window.__fm.pauseOfflineTask = function(id) { pauseOfflineTask(id); };
  window.__fm.cancelOfflineTask = function(id) { cancelOfflineTask(id); };
  window.__fm.deleteOfflineTask = function(id) { deleteOfflineTask(id); };
  window.__fm.gotoOfflineDownloadDir = function() { gotoOfflineDownloadDir(); };
  window.__fm.copyOfflineUrl = function(id) { copyOfflineUrl(id); };

  // ---------- Scanner Functions (使用原生插件) ----------
  function openScanner() {
    // 优先使用 Android 原生扫码
    if (window.AndroidApp && window.AndroidApp.openScanner) {
      console.log('[Scanner] Using native Android scanner');
      window.AndroidApp.openScanner();
      return;
    }

    // 回退到 Capacitor 插件扫码
    var overlay = document.getElementById('scanner-overlay');
    var errorEl = document.getElementById('scanner-error');
    var hintEl = document.getElementById('scanner-hint');
    if (!overlay) return;

    overlay.style.display = 'flex';
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    if (hintEl) { hintEl.textContent = '正在启动相机...'; hintEl.style.display = 'block'; }

    // 使用 Capacitor 原生扫码插件
    if (window.BarcodeScanner) {
      startNativeScanner();
    } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner) {
      startNativeScanner();
    } else {
      // 插件未加载，显示错误
      showScannerError('扫码插件未加载，请更新应用');
      setTimeout(function() {
        var overlay = document.getElementById('scanner-overlay');
        if (overlay) overlay.style.display = 'none';
      }, 2000);
    }
  }

  function closeScanner() {
    var overlay = document.getElementById('scanner-overlay');
    if (overlay) overlay.style.display = 'none';
    stopNativeScanner();
  }

  function startNativeScanner() {
    var hintEl = document.getElementById('scanner-hint');
    var errorEl = document.getElementById('scanner-error');
    if (hintEl) { hintEl.textContent = '准备扫描...'; hintEl.style.display = 'block'; }
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    try {
      // 检查权限
      var BarcodeScanner = window.BarcodeScanner || (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner);

      if (BarcodeScanner && BarcodeScanner.startScanning) {
        BarcodeScanner.startScanning({}, function(result) {
          // 成功扫描
          try {
            if (navigator.vibrate) navigator.vibrate(100);
          } catch (e) {}
          handleScanResult(result);
        }, function(error) {
          showScannerError('扫码失败: ' + (error.message || error));
        });
      } else {
        showScannerError('扫码功能不可用');
      }
    } catch (e) {
      showScannerError('启动扫码失败: ' + (e.message || e));
    }
  }

  function stopNativeScanner() {
    try {
      var BarcodeScanner = window.BarcodeScanner || (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BarcodeScanner);
      if (BarcodeScanner && BarcodeScanner.stopScanning) {
        BarcodeScanner.stopScanning();
      }
    } catch (e) {}
  }

  function showScannerError(msg) {
    var errorEl = document.getElementById('scanner-error');
    var hintEl = document.getElementById('scanner-hint');
    if (hintEl) hintEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }
  }

  function handleScanResult(result) {
    var text = '';
    if (typeof result === 'string') {
      text = result;
    } else if (result && result.content) {
      text = result.content;
    } else if (result && result.value) {
      text = result.value;
    }

    console.log('[Scanner] 扫描结果:', text);

    var overlay = document.getElementById('scanner-overlay');
    if (overlay) overlay.style.display = 'none';
    stopNativeScanner();

    if (!text) {
      showToast('未识别到内容', '&#9888;');
      return;
    }

    try {
      var url = text.trim();

      // ========== 二维码登录识别 ==========
      // 格式: fs://qr-login?token=xxxxx
      var qrLoginMatch = url.match(/fs:\/\/qr-login\?token=([a-zA-Z0-9_-]+)/i);
      if (qrLoginMatch && qrLoginMatch[1]) {
        var token = qrLoginMatch[1];
        console.log('[Scanner] 检测到二维码登录 token:', token);
        showQrLoginConfirm(token);
        return;
      }

      // 纯 token 格式检查（20-64位字母数字下划线）
      if (/^[a-zA-Z0-9_-]{20,64}$/.test(url)) {
        console.log('[Scanner] 尝试作为二维码登录 token 处理');
        showQrLoginConfirm(url);
        return;
      }

      // ========== 分享链接识别 ==========
      var match = url.match(/\/s\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        showToast('正在打开分享...', '&#128247;');
        window.location.href = '/share.html?hash=' + encodeURIComponent(match[1]);
        return;
      }

      // 分享链接格式2: /share/xxxx
      match = url.match(/\/share[^\/]*\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        showToast('正在打开分享...', '&#128247;');
        window.location.href = '/share.html?hash=' + encodeURIComponent(match[1]);
        return;
      }

      // 纯分享码格式（4-20位字母数字）
      if (/^[a-zA-Z0-9]{4,20}$/.test(url)) {
        showToast('正在打开分享...', '&#128247;');
        window.location.href = '/share.html?hash=' + encodeURIComponent(url);
        return;
      }

      // 完整URL解析
      if (url.startsWith('http')) {
        try {
          var parsedUrl = new URL(url);
          var hashMatch = parsedUrl.pathname.match(/\/s\/([a-zA-Z0-9]+)/) ||
                          parsedUrl.pathname.match(/\/share[^\/]*\/([a-zA-Z0-9]+)/);
          if (hashMatch && hashMatch[1]) {
            showToast('正在打开分享...', '&#128247;');
            window.location.href = '/share.html?hash=' + encodeURIComponent(hashMatch[1]);
            return;
          }
        } catch (e) {}
      }

      showToast('无法识别的内容', '&#9888;');

    } catch (e) {
      console.error('[Scanner] 处理扫码结果失败:', e);
      showToast('处理扫码结果失败', '&#9888;');
    }
  }

  // 二维码登录确认
  function showQrLoginConfirm(token) {
    var msg = confirm('是否确认登录此设备？\n\n扫码成功后，你将自动登录电脑端。');
    if (msg) {
      authorizeQrLogin(token);
    }
  }

  // 执行二维码登录授权
  function authorizeQrLogin(token) {
    showToast('正在授权登录...', '&#128279;');

    // 通过原生 APP 执行授权请求
    if (window.AndroidCallback && window.AndroidCallback.authorizeQrLogin) {
      window.AndroidCallback.authorizeQrLogin(token);
      // 设置回调处理
      window.__qrLoginCallback = function(code, result) {
        console.log('[QR Login] Response:', code, result);
        try {
          var data = JSON.parse(result);
          if (data.code === 0) {
            showToast('登录成功！', '&#10004;');
            // 3秒后跳转到主页
            setTimeout(function() {
              window.location.href = '/home.html';
            }, 1500);
          } else {
            showToast(data.message || '登录失败', '&#9888;');
          }
        } catch (e) {
          showToast('登录失败', '&#9888;');
        }
      };
    } else {
      // 没有原生支持，使用 AJAX
      axios.post('/api/auth/qr-login/authorize', { token: token })
        .then(function(res) {
          if (res.data.code === 0) {
            showToast('登录成功！', '&#10004;');
            setTimeout(function() {
              window.location.href = '/home.html';
            }, 1500);
          } else {
            showToast(res.data.message || '登录失败', '&#9888;');
          }
        })
        .catch(function() {
          showToast('网络错误', '&#9888;');
        });
    }
  }

  // 暴露扫码功能到全局
  window.__fm.openScanner = function() { openScanner(); };
  window.__fm.closeScanner = function() { closeScanner(); };

  // ---------- 主动画初始化（不自动调用，由 home.html 在认证成功后触发）----------
  // home.html 的 onReady() 会调用 window.__fm.init()

})();
