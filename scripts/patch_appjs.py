#!/usr/bin/env python
"""Add transfer list and chunked upload functions to app.js"""
import json, os

APP_JS = 'D:/tools/fileservice/public/app.js'

with open(APP_JS, 'r', encoding='utf-8') as f:
    content = f.read()

# Find insertion point
marker = '  function loadAboutPage() {'
if marker not in content:
    print('ERROR: loadAboutPage not found')
    exit(1)

new_code = '''
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
      html += '<button class="banner-dismiss" onclick="var b=document.getElementById(\"transfer-resume-banner\");if(b)b.style.display=\"none\"">✕</button>';
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

    // Event delegation for transfer actions
    var listEl = document.getElementById('transfer-list');
    if (listEl) {
      listEl.onclick = function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        if (action === 'retry') window.__fm._retryTransfer(id);
        else if (action === 'cancel') window.__fm._cancelTransfer(id);
        else if (action === 'delete') window.__fm._deleteTransfer(id);
      };
    }
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
      task.status = 'error';
      showToast('上传失败: ' + file.name + ' - ' + (err.message || '初始化失败'), '❌');
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
'''

content = content.replace(marker, new_code + '\n\n' + marker)

with open(APP_JS, 'w', encoding='utf-8') as f:
    f.write(content)

print('app.js updated successfully')
print('Lines:', len(content.splitlines()))
