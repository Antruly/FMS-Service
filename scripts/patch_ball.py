#!/usr/bin/env python
"""Replace floating ball in home.html with animated progress circle"""
import re

HOME = 'D:/tools/fileservice/public/home.html'

with open(HOME, 'r', encoding='utf-8') as f:
    content = f.read()

# Find the floating ball section — from comment to the closing </script> of its script block
start = content.find('<!-- 悬浮球：移动端下载入口')
if start < 0:
    print('ERROR: start marker not found')
    exit(1)

# Find the script block that contains the floating ball code (line 769 <script> to line 917 </script>)
script_start = content.find('<script>\n(function(){\n  var container', start)
if script_start < 0:
    print('ERROR: floating ball script start not found')
    exit(1)

script_end = content.find('</script>', script_start)
if script_end < 0:
    print('ERROR: floating ball script end not found')
    exit(1)
script_end += len('</script>')

# Everything after script_end should be preserved (</body>\n</html>)
trailing = content[script_end:]

new_section = r'''悬浮球：多功能进度球（上传进度 / App下载）
<style>
#mobile-floating-ball { position:fixed; z-index:9999; user-select:none; -webkit-user-select:none; }
#mobile-floating-ball .ball-btn {
  width:50px;height:50px;border-radius:50%;cursor:grab;
  box-shadow:0 4px 20px rgba(0,0,0,.55);position:relative;
  transition:box-shadow .3s,transform .3s;
}
#mobile-floating-ball .ball-btn:active { cursor:grabbing; }
#mobile-floating-ball .ball-btn:hover { box-shadow:0 0 24px rgba(0,212,255,0.4);transform:scale(1.08); }
#mobile-floating-ball .ball-btn svg { width:100%;height:100%;display:block; }
/* Water-fill progress circle */
.ball-progress-circle { fill:none;stroke:var(--border,#30363d);stroke-width:3; }
.ball-progress-fill {
  fill:none;stroke:var(--accent,#00d4ff);stroke-width:3;
  stroke-dasharray:138.23; /* 2*PI*22 ≈ 138.23 */
  stroke-dashoffset:138.23;
  transform:rotate(-90deg);transform-origin:center;
  transition:stroke-dashoffset .5s ease;
}
.ball-progress-text {
  font-size:11px;font-weight:700;fill:var(--text-primary,#e6edf3);
  text-anchor:middle;dominant-baseline:central;
}
/* Panel */
#mobile-floating-ball .ball-panel {
  display:none;position:absolute;bottom:58px;right:-4px;
  background:var(--bg-card,#1c2128);border:1px solid var(--border,#30363d);
  border-radius:12px;padding:14px;width:240px;max-height:360px;overflow-y:auto;
  box-shadow:0 8px 32px rgba(0,0,0,.6);text-align:left;
}
#mobile-floating-ball .ball-panel.show { display:block; }
#mobile-floating-ball .ball-panel .qr-wrap { width:120px;height:120px;margin:0 auto 10px;background:#fff;border-radius:8px;padding:4px;display:flex;align-items:center;justify-content:center;color:#0d1117;font-size:11px; }
#mobile-floating-ball .ball-panel .dl-link { color:#58a6ff;font-size:12px;text-decoration:none;display:block;text-align:center;margin-bottom:8px; }
#mobile-floating-ball .ball-panel .hide-btn { color:var(--text-muted,#666);font-size:11px;cursor:pointer;background:none;border:1px solid var(--border,#333);border-radius:6px;padding:4px 12px;transition:all .2s;display:block;margin:0 auto; }
#mobile-floating-ball .ball-panel .hide-btn:hover { color:var(--text-secondary,#aaa);border-color:var(--accent,#555); }
/* Upload list in panel */
.ball-upload-item { display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border,#222);font-size:11px;color:var(--text-secondary,#aaa); }
.ball-upload-item:last-child { border-bottom:none; }
.ball-upload-name { flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary,#ddd); }
.ball-upload-size { color:var(--text-muted,#777);font-size:10px; }
.ball-upload-bar { height:3px;border-radius:2px;background:var(--bg-tertiary,#222);overflow:hidden;margin-top:2px; }
.ball-upload-bar-fill { height:100%;background:linear-gradient(90deg,#2196F3,#00d4ff);border-radius:2px;transition:width .3s; }
.ball-upload-status { font-size:10px; }
.ball-upload-status.uploading { color:#2196F3; }
.ball-upload-status.completed { color:#2ea043; }
.ball-upload-status.error { color:#f85149; }
.ball-panel-title { font-size:13px;font-weight:700;color:var(--text-primary,#e6edf3);margin:0 0 8px;text-align:center; }
.ball-empty-upload { text-align:center;font-size:11px;color:var(--text-muted,#666);padding:20px 0; }
/* Corner tab */
#mobile-floating-ball-corner { display:none;position:fixed;z-index:9998;width:18px;height:40px;background:var(--bg-card,#1c2128);border:2px solid var(--border,#30363d);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:all .2s; }
#mobile-floating-ball-corner:hover { border-color:var(--accent,#00d4ff);box-shadow:0 0 12px rgba(0,212,255,0.25); }
#mobile-floating-ball-corner svg { width:100%;height:100%; }
/* Fly-to-ball animation */
@keyframes floatBallPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.2)} }
.float-ball-pulse { animation:floatBallPulse .4s ease 2; }
@keyframes floatBallBounce { 0%{transform:scale(1)} 30%{transform:scale(1.25)} 60%{transform:scale(0.9)} 100%{transform:scale(1)} }
.float-ball-bounce { animation:floatBallBounce .5s ease; }
</style>
<div id="mobile-floating-ball">
  <div class="ball-btn" title="传输进度 / App下载（可拖拽移动）">
    <svg viewBox="0 0 50 50">
      <circle class="ball-progress-circle" cx="25" cy="25" r="22"/>
      <circle class="ball-progress-fill" id="ball-progress-fill" cx="25" cy="25" r="22"/>
      <text class="ball-progress-text" id="ball-progress-text" x="25" y="25">📱</text>
    </svg>
  </div>
  <div class="ball-panel" id="ball-panel">
    <!-- Upload list section (shown when active transfers exist) -->
    <div id="ball-upload-section" style="display:none">
      <div class="ball-panel-title">📤 上传进度</div>
      <div id="ball-upload-list"></div>
      <div id="ball-upload-empty" class="ball-empty-upload" style="display:none">暂无上传任务</div>
    </div>
    <!-- App download section (shown when no active transfers) -->
    <div id="ball-app-section">
      <p style="color:var(--text-primary,#e6edf3);font-size:13px;margin:0 0 8px;text-align:center">📱 扫码下载 FMS App</p>
      <div class="qr-wrap" id="mobile-dl-qr">加载中...</div>
      <a class="dl-link" id="mobile-dl-link" href="#">📩 直接下载 APK</a>
      <button class="hide-btn" id="mobile-dl-hide">◀ 隐藏悬浮球</button>
    </div>
  </div>
</div>
<div id="mobile-floating-ball-corner">
  <svg viewBox="0 0 18 40"><circle cx="9" cy="20" r="7" fill="none" stroke="var(--accent,#00d4ff)" stroke-width="2"/><text x="9" y="21" text-anchor="middle" font-size="8" fill="var(--text-primary)">📱</text></svg>
</div>
<script>
(function(){
  var container = document.getElementById('mobile-floating-ball');
  var ballBtn = container.querySelector('.ball-btn');
  var panel = document.getElementById('ball-panel');
  var corner = document.getElementById('mobile-floating-ball-corner');
  var hideBtn = document.getElementById('mobile-dl-hide');
  var qrEl = document.getElementById('mobile-dl-qr');
  var linkEl = document.getElementById('mobile-dl-link');
  var progressFill = document.getElementById('ball-progress-fill');
  var progressText = document.getElementById('ball-progress-text');
  var uploadSection = document.getElementById('ball-upload-section');
  var uploadList = document.getElementById('ball-upload-list');
  var uploadEmpty = document.getElementById('ball-upload-empty');
  var appSection = document.getElementById('ball-app-section');
  var CIRCUMFERENCE = 2 * Math.PI * 22; // ~138.23
  var lastProgress = -1;
  var panelMode = 'app'; // 'app' | 'upload'

  // --- State ---
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('_fs_ball_pos')||'{}'); } catch(e) {}
  var x = (saved.x != null && !isNaN(saved.x)) ? saved.x : (window.innerWidth - 70);
  var y = (saved.y != null && !isNaN(saved.y)) ? saved.y : (window.innerHeight - 180);
  var hidden = !!saved.hidden;
  var cornerSide = saved.cornerSide || 'right';
  var isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent) || window.innerWidth < 768;

  function saveState() {
    try { localStorage.setItem('_fs_ball_pos', JSON.stringify({x:x, y:y, hidden:hidden, cornerSide:cornerSide})); } catch(e) {}
  }
  function position() {
    container.style.left = x + 'px'; container.style.top = y + 'px';
    container.style.right = 'auto'; container.style.bottom = 'auto';
    container.style.display = '';
  }
  function showCorner() {
    container.style.display = 'none';
    corner.style.display = '';
    corner.style.right = ''; corner.style.left = ''; corner.style.top = ''; corner.style.bottom = '';
    if (cornerSide === 'right') { corner.style.right = '0'; corner.style.top = '40%'; corner.style.borderRight = 'none'; corner.style.borderRadius = '8px 0 0 8px'; }
    else if (cornerSide === 'left') { corner.style.left = '0'; corner.style.top = '40%'; corner.style.borderLeft = 'none'; corner.style.borderRadius = '0 8px 8px 0'; }
    else if (cornerSide === 'bottom') { corner.style.bottom = '0'; corner.style.left = '50%'; corner.style.borderBottom = 'none'; corner.style.borderRadius = '8px 8px 0 0'; }
    else { corner.style.top = '0'; corner.style.left = '50%'; corner.style.borderTop = 'none'; corner.style.borderRadius = '0 0 8px 8px'; cornerSide = 'top'; }
  }
  function showBall() {
    var maxX = window.innerWidth - 30, maxY = window.innerHeight - 30;
    if (x < -30 || x > maxX || y < -30 || y > maxY) { x = maxX - 20; y = maxY - 100; }
    x = Math.max(-30, Math.min(maxX, x));
    y = Math.max(-30, Math.min(maxY, y));
    hidden = false; position(); corner.style.display = 'none'; saveState();
  }
  function hideBall() {
    var cx = x + 25, cy = y + 25;
    var dR = window.innerWidth - cx, dL = cx, dB = window.innerHeight - cy, dT = cy;
    var minD = Math.min(dR, dL, dB, dT);
    if (minD === dR) cornerSide = 'right';
    else if (minD === dL) cornerSide = 'left';
    else if (minD === dB) cornerSide = 'bottom';
    else cornerSide = 'top';
    hidden = true; showCorner(); saveState();
  }

  // --- Progress circle update ---
  function updateProgressCircle(pct) {
    if (pct === lastProgress) return;
    lastProgress = pct;
    var dashoffset = CIRCUMFERENCE * (1 - pct / 100);
    progressFill.style.strokeDasharray = CIRCUMFERENCE;
    progressFill.style.strokeDashoffset = dashoffset;
    progressFill.style.stroke = pct >= 100 ? '#2ea043' : 'var(--accent,#00d4ff)';
    progressText.textContent = pct > 0 ? Math.round(pct) + '%' : '📱';
    progressText.style.fontSize = pct > 0 ? '11px' : '16px';
  }
  function resetProgressCircle() {
    lastProgress = -1;
    progressFill.style.strokeDasharray = '0';
    progressFill.style.strokeDashoffset = '0';
    progressFill.style.stroke = 'var(--border,#30363d)';
    progressText.textContent = '📱';
    progressText.style.fontSize = '16px';
  }

  // --- Panel content switching ---
  function showUploadPanel() {
    panelMode = 'upload';
    uploadSection.style.display = '';
    appSection.style.display = 'none';
  }
  function showAppPanel() {
    panelMode = 'app';
    uploadSection.style.display = 'none';
    appSection.style.display = '';
  }

  // --- Render upload list ---
  function renderUploadList() {
    var transfers = [];
    try {
      if (window.__fm && window.__fm._getActiveTransfers) {
        transfers = window.__fm._getActiveTransfers();
      }
    } catch(e) {}
    // Also check pending from localStorage
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('transfer_pending_') === 0) {
          var meta = JSON.parse(localStorage.getItem(k));
          var exists = transfers.find(function(t){return t.transferId === meta.transferId;});
          if (!exists) transfers.push({fileName:meta.fileName,fileSize:meta.fileSize,transferId:meta.transferId,status:'pending',progress:0,uploadedChunks:[],totalChunks:meta.totalChunks||0});
        }
      }
    } catch(e) {}

    if (transfers.length === 0) {
      uploadList.innerHTML = ''; uploadEmpty.style.display = '';
      resetProgressCircle();
      showAppPanel();
      return;
    }
    uploadEmpty.style.display = 'none';
    showUploadPanel();

    // Calculate overall progress
    var totalChunks = 0, doneChunks = 0;
    transfers.forEach(function(t) {
      totalChunks += (t.totalChunks || 1);
      doneChunks += (t.uploadedChunks ? t.uploadedChunks.size || t.uploadedChunks.length : 0);
    });
    var overallPct = totalChunks > 0 ? Math.round(doneChunks / totalChunks * 100) : 0;
    updateProgressCircle(overallPct);

    var html = '';
    transfers.forEach(function(t) {
      var pct = t.totalChunks > 0 ? Math.round((t.uploadedChunks ? (t.uploadedChunks.size || t.uploadedChunks.length) : 0) / t.totalChunks * 100) : 0;
      var statusClass = t.status === 'completed' ? 'completed' : (t.status === 'error' ? 'error' : 'uploading');
      var statusText = t.status === 'completed' ? '✓' : (t.status === 'error' ? '✕' : pct + '%');
      var sizeStr = t.fileSize > 1048576 ? (t.fileSize/1048576).toFixed(1)+'MB' : (t.fileSize/1024).toFixed(0)+'KB';
      html += '<div class="ball-upload-item">';
      html += '<span style="font-size:14px">📄</span>';
      html += '<div style="flex:1;min-width:0">';
      html += '<div class="ball-upload-name">' + escHtml(t.fileName) + '</div>';
      html += '<div class="ball-upload-bar"><div class="ball-upload-bar-fill" style="width:' + pct + '%"></div></div>';
      html += '</div>';
      html += '<span class="ball-upload-size">' + sizeStr + '</span>';
      html += '<span class="ball-upload-status ' + statusClass + '">' + statusText + '</span>';
      html += '</div>';
    });
    uploadList.innerHTML = html;
  }

  // --- Initialize: render correct panel ---
  function initPanel() {
    var hasUploads = false;
    try {
      if (window.__fm && window.__fm._getActiveTransfers) {
        var t = window.__fm._getActiveTransfers();
        if (t && t.length > 0) hasUploads = true;
      }
    } catch(e) {}
    if (!hasUploads) {
      try {
        for (var i = 0; i < localStorage.length; i++) {
          if (localStorage.key(i).indexOf('transfer_pending_') === 0) { hasUploads = true; break; }
        }
      } catch(e) {}
    }
    if (hasUploads) { showUploadPanel(); renderUploadList(); }
    else { showAppPanel(); resetProgressCircle(); }
  }

  // --- Timing ---
  initPanel();
  var updateTimer = setInterval(function() {
    if (panel.classList.contains('show') || document.hidden) return;
    // Only update if there might be uploads
    if (panelMode === 'upload' || (window.__fm && window.__fm._getActiveTransfers && window.__fm._getActiveTransfers().length > 0)) {
      renderUploadList();
    }
  }, 1000);

  // Public API for app.js to call
  window._floatBallPulse = function() {
    ballBtn.classList.add('float-ball-bounce');
    setTimeout(function(){ ballBtn.classList.remove('float-ball-bounce'); }, 500);
    renderUploadList();
    // Open panel briefly
    if (!panel.classList.contains('show')) {
      panel.classList.add('show');
      setTimeout(function(){ panel.classList.remove('show'); }, 2000);
    }
  };
  window._floatBallRefresh = function() { renderUploadList(); };

  // --- Drag logic (preserved from original) ---
  if (hidden) { showCorner(); } else { position(); }
  var dragging, startX, startY, startOX, startOY, moved;
  function onDown(ex, ey) {
    if (ex.target && (panel.contains(ex.target) || ex.target === hideBtn)) return;
    startX = ex; startY = ey; startOX = x; startOY = y;
    dragging = true; moved = false;
  }
  ballBtn.addEventListener('mousedown', function(e){ onDown(e.clientX, e.clientY); });
  ballBtn.addEventListener('touchstart', function(e){
    if (e.target && (panel.contains(e.target) || e.target === hideBtn)) return;
    onDown(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:false});
  function onMove(ex, ey) {
    if (!dragging) return;
    var dx = ex - startX, dy = ey - startY;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    moved = true;
    x = startOX + dx; y = startOY + dy;
    x = Math.max(-30, Math.min(window.innerWidth - 30, x));
    y = Math.max(-30, Math.min(window.innerHeight - 30, y));
    position();
  }
  document.addEventListener('mousemove', function(e){ onMove(e.clientX, e.clientY); });
  document.addEventListener('touchmove', function(e){ onMove(e.touches[0].clientX, e.touches[0].clientY); }, {passive:false});
  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    var cx = x + 25, cy = y + 25;
    var edge = 50;
    if (!panel.classList.contains('show')) {
      if (cx < edge || cx > window.innerWidth - edge || cy < edge || cy > window.innerHeight - edge) {
        hideBall();
      }
    }
    saveState();
  }
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);

  // --- Panel toggle ---
  ballBtn.addEventListener('click', function(e) {
    if (moved) return;
    panel.classList.toggle('show');
    if (panel.classList.contains('show')) {
      if (panelMode === 'upload') { renderUploadList(); }
      else { tryRenderQr(); }
    }
  });
  ballBtn.addEventListener('touchend', function(e) {
    if (moved) return;
    e.preventDefault();
    panel.classList.toggle('show');
    if (panel.classList.contains('show')) {
      if (panelMode === 'upload') { renderUploadList(); }
      else { tryRenderQr(); }
    }
  });

  // --- Close on outside click ---
  document.addEventListener('click', function(e) {
    if (!container.contains(e.target) && e.target !== corner) { panel.classList.remove('show'); }
  });
  panel.addEventListener('click', function(e) { e.stopPropagation(); });

  // --- Hide / corner ---
  hideBtn.addEventListener('click', hideBall);
  corner.addEventListener('click', showBall);

  // --- Resize ---
  window.addEventListener('resize', function() {
    x = Math.max(-30, Math.min(window.innerWidth - 30, x));
    y = Math.max(-30, Math.min(window.innerHeight - 30, y));
    if (hidden) showCorner(); else position();
  });

  // --- QR Code (lazy load on first panel open) ---
  var qrLoaded = false;
  function escHtml(s){ var d=document.createElement('div');d.textContent=s;return d.innerHTML; }
  function tryRenderQr() {
    if (qrLoaded) return;
    qrLoaded = true;
    fetch('/api/version/latest').then(function(r){return r.json()}).then(function(d){
      if (d.code === 0 && d.data) {
        linkEl.href = d.data.url || '#';
        linkEl.textContent = '📥 v'+d.data.version+' ('+Math.round(d.data.size/1024/1024)+'MB)';
        var theme = (document.documentElement.getAttribute('data-theme')||'dark')==='dark'?'dark':'light';
        var qrUrl = '/api/qr?text='+encodeURIComponent(d.data.url||serverUrl)+'&size=200&theme='+theme;
        var img = document.createElement('img');
        img.src = qrUrl; img.style.width='100%';img.style.height='100%';img.onerror=function(){qrEl.textContent='加载失败'};
        qrEl.innerHTML = ''; qrEl.appendChild(img);
      } else { qrEl.textContent = '暂无版本'; }
    });
  }
  // Call tryRenderQr after a short delay so serverUrl is available
  setTimeout(tryRenderQr, 2000);
})();
</script>
'''

# Replace the floating ball section
content = content[:start] + new_section + trailing

with open(HOME, 'w', encoding='utf-8') as f:
    f.write(content)
print('home.html floating ball replaced successfully')
print('New size:', len(content))
