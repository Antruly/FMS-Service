# 🔐 FMS 文件管理系统

<p align="center">
  <img src="public/favicon.png" alt="FMS Logo" width="80" height="80">
</p>

<p align="center">
  <strong>端到端加密的私有文件管理服务</strong><br><sub>v1.0.3 — 全局文件搜索 · 断点续传 · 悬浮球增强 · WebDAV权限修复</sub>
</p>

<p align="center">
  <a href="README_EN.md">English</a> | <strong>中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-brightgreen" alt="Platform">
</p>

---

## 📖 简介

FMS (FileService) 是一个**自托管的文件管理服务**，提供端到端加密、文件分享、WebDAV 访问和 Android App。

- 🔐 **AES-256-GCM 加密** — 文件上传前在客户端加密，服务器无法读取明文
- 📡 **WebDAV 协议** — 支持 Windows/Mac/Linux 挂载为网络驱动器
- 🔗 **文件分享** — 生成分享链接 + 提取码，支持下载次数限制
- 📱 **Android App** — 基于 Capacitor WebView 的移动客户端
- 🗄️ **多镜像存储池** — 支持加权分配、健康检查、自动故障转移
- 🎨 **暗色/亮色主题** — 跟随系统或手动切换

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Redis](https://redis.io/) >= 6（用于 Session、缓存、公共回收站）

### 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/Antruly/FMS-Service.git
cd FMS-Service

# 2. 安装依赖
npm install

# 3. 配置环境变量（全新安装会自动生成密钥）
cp .env.example .env
# 编辑 .env，至少配置：
#   - PORT: 服务端口（默认 88）
#   - REDIS_HOST / REDIS_PORT: Redis 连接
#   - EMAIL_USER / EMAIL_AUTH_CODE: QQ邮箱 SMTP（可选，用于注册验证码）

# 4. 启动服务
npm start
```

访问 http://localhost:88 即可使用。

### 安装为系统服务

| 平台 | 脚本 | 说明 |
|------|------|------|
| **Windows** | `scripts/install-windows-service.bat` | 使用原生 `sc` 命令，无需第三方工具，需管理员权限 |
| **Linux** | `scripts/install-linux-service.sh` | 使用原生 systemd，自动创建专用用户，需 root |

```bash
# Linux
sudo bash scripts/install-linux-service.sh

# Windows（以管理员权限运行）
scripts\install-windows-service.bat
```

### Docker（计划中）

> Docker 部署方案即将推出。

## 📂 项目结构

```
FMS-Service/
├── server.js              # Express 主入口，中间件，启动逻辑
├── config.js              # 环境变量加载，密钥管理
├── package.json           # 依赖管理
├── .env.example           # 环境变量示例
├── LICENSE                # MIT 开源协议
│
├── routes/                # API 路由
│   ├── auth.js            # 登录/注册/QR登录/设备管理/验证码
│   ├── file.js            # 文件 CRUD / 上传下载 / 预览 / 回收站
│   ├── share.js           # 文件分享 / 提取码 / 批量分享
│   ├── webdav.js          # WebDAV 协议 / 链接管理
│   ├── storage.js         # 存储组 / 镜像 / 异步任务
│   ├── version.js         # APK 版本管理 / 上传 / 下载
│   ├── backup.js         # 备份任务管理
│   └── logs.js            # 管理员操作日志
│
├── lib/                   # 核心库
│   ├── db.js              # SQLite 数据库模型（sql.js/WASM）
│   ├── redis.js              # Redis 操作（Session 跟踪、流量、验证码）
│   ├── crypto.js             # AES-256-GCM 加密/解密（V1 分块格式）
│   ├── storage-stream.js     # 存储池流式读写
│   ├── traffic-middleware.js # 全局流量统计中间件（HTTP层实时计数）
│   ├── backup.js             # 数据备份逻辑
│   ├── backup-scheduler.js   # 备份定时调度
│   ├── inactivity-scheduler.js # 分享/WebDAV 非活跃自动禁用
│   ├── email.js              # 邮件发送（QQ SMTP）
│   ├── ws.js                 # WebSocket 推送
│   ├── log.js                # 分级日志（info/debug/warn/error）
│   ├── logger.js             # 审计日志（操作记录）
│   ├── utils.js              # 公共工具函数
│   └── validator.js          # 输入验证
│
├── public/                # 前端静态文件
│   ├── index.html         # 首页 / 仪表盘
│   ├── home.html          # 主应用 SPA（侧边栏 + 内容面板）
│   ├── login.html         # 登录页（密码/验证码/扫码）
│   ├── share.html         # 分享文件浏览/下载
│   ├── admin-storage.html # 存储管理（内嵌 iframe）
│   ├── admin-backup.html  # 备份管理
│   ├── admin-tasks.html   # 异步任务管理
│   ├── app.js             # 前端主逻辑
│   ├── style.css          # 全局样式 / 主题系统
│   └── favicon.png        # Logo
│
├── scripts/               # 工具脚本
│   ├── pre-build.js       # APK 构建前置（版本号写入）
│   ├── install-windows-service.bat   # Windows 服务安装
│   ├── uninstall-windows-service.bat # Windows 服务卸载
│   └── install-linux-service.sh      # Linux systemd 安装
│
├── app/android/           # Android App 源码（Capacitor）
│   ├── app/src/main/java/com/fileservice/app/
│   │   ├── MainActivity.java         # 主 Activity
│   │   └── SettingsActivity.java     # 设置页面
│   └── app/build.gradle              # 构建配置 / 版本号
│
└── tests/                 # E2E 测试（Playwright）
```

## ✨ 功能特性

### 文件管理
- 📤 上传 / 下载 / 重命名 / 移动 / 删除
- 📁 多级目录（个人目录 + 公共目录）
- 🔍 文件名搜索
- 🖼️ 图片/视频缩略图和在线预览
- 🗑️ 回收站（30 天自动清理，支持恢复）
- 🗜️ 离线批量下载（zip 打包）

### 加密安全
- 🔐 AES-256-GCM 文件加密（V1 分块格式支持 Range 请求）
- 🔑 客户端密钥派生（不传输明文密码）
- 🛡️ CSRF 保护 + Session 管理
- 🚦 请求频率限制 + IP 自动封禁
- 📧 QQ 邮箱验证码注册

### 文件分享
- 🔗 生成分享链接 + 提取码
- ⏱️ 有效期设置 + 下载次数限制
- 📊 分享日志（访问/下载记录）
- 🗂️ 支持单文件和批量分享

### WebDAV
- 🌐 标准 WebDAV 协议（PROPFIND/GET/PUT/DELETE/MOVE/COPY/LOCK）
- 🔗 链接管理（创建/过期/删除）
- 🔒 支持无密码公开链接和密码保护链接
- 📂 区分个人目录和公共目录

### 流量统计
- 📊 HTTP 层实时拦截响应字节计数
- 👤 请求流量按用户活跃会话聚合（3分钟无活动 / 60分钟上限刷入）
- 📁 文件传输流量按实际传输字节记录，下载取消不扣
- 📈 管理后台流量图表（按天/月/年汇总）

### 数据备份
- 💾 定时备份 SQLite 数据库 + 存储文件
- ☁️ 支持本地/远程备份路径
- 📋 异步任务调度，管理后台可视化
- 🔔 备份完成/失败邮件通知

### 非活跃管理
- ⏱️ 分享链接超期未访问自动禁用
- 🔗 WebDAV 链接超期自动禁用
- 📧 即将到期邮件通知创建者

### 存储池管理
- 🗄️ 多存储组 / 多镜像路径
- ⚖️ 加权写入分配（1-10）
- ❤️ 健康检查 + 自动故障转移
- 🔄 文件迁移 / 重组 / 回滚
- 📋 异步任务系统（批量操作）

### Android App
- 📱 Capacitor WebView 封装
- 🔍 扫一扫登录
- ⚙️ 自定义服务器地址
- 🌐 应用内 WebDAV 访问
- 📲 应用更新检测

## ⚙️ 配置说明

所有配置通过 `.env` 环境变量设置，完整配置项参见 [`.env.example`](.env.example)。

### 关键配置

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 服务端口（默认 88） |
| `SESSION_SECRET` | 自动* | 会话加密密钥 |
| `SYSTEM_MASTER_KEY` | 自动* | 文件加密主密钥 ⚠️ 丢失后文件无法解密 |
| `REDIS_HOST` | 是 | Redis 地址 |
| `REDIS_PORT` | 否 | Redis 端口（默认 6379） |
| `EMAIL_USER` | 否 | QQ 邮箱地址（用于发送验证码） |
| `EMAIL_AUTH_CODE` | 否 | QQ 邮箱 SMTP 授权码 |
| `APP_BASE_URL` | 否 | App 公网地址（用于生成分享链接） |
| `CORS_ORIGINS` | 否 | CORS 白名单（留空=开发模式） |
| `LOG_LEVEL` | 否 | 日志级别：debug / info / warn / error |
| `SSL_ENABLED` | 否 | 是否启用 HTTPS |
| `STORAGE_ALERT_EMAIL` | 否 | 存储健康告警邮件接收人 |

\* 全新安装时自动生成并写入 .env；已有数据时需手动配置。

### QQ 邮箱 SMTP 配置

1. 登录 QQ 邮箱 → 设置 → 账户 → POP3/SMTP 服务
2. 开启服务并获取授权码
3. 在 `.env` 中配置：
   ```
   EMAIL_USER=your-email@foxmail.com
   EMAIL_AUTH_CODE=获取到的授权码
   EMAIL_FROM=文件管理系统
   ```

## 🔧 开发

```bash
# 启动开发模式（日志级别设为 debug 查看详细日志）
LOG_LEVEL=debug node server.js

# 运行 E2E 测试
npx playwright test

# 构建 Android APK（详见 CLAUDE.md）
node scripts/pre-build.js "更新日志"
cd app/android && ./gradlew assembleRelease
```

## 📄 开源协议

[MIT License](LICENSE) — 自由使用、修改、分发。

## 🔗 相关链接

| 项目 | 仓库 |
|------|------|
| 🌐 **服务端** | [Antruly/FMS-Service](https://github.com/Antruly/FMS-Service) |
| 📱 **Android App** | [Antruly/FMS-Service-app](https://github.com/Antruly/FMS-Service-app) |

## 🙏 致谢

- [Express](https://expressjs.com/) — Web 框架
- [sql.js](https://sql.js.org/) — SQLite WASM 实现
- [ioredis](https://github.com/redis/ioredis) — Redis 客户端
- [Capacitor](https://capacitorjs.com/) — 跨平台 WebView 框架
- [Playwright](https://playwright.dev/) — E2E 测试框架
