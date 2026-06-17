# 🔐 FMS — File Management System

<p align="center">
  <img src="public/favicon.png" alt="FMS Logo" width="80" height="80">
</p>

<p align="center">
  <strong>End-to-End Encrypted Private File Management Service</strong><br><sub>v1.1.1 — Android Edge-to-Edge · Global Search · Resumable Transfer · Backup · Storage Balance</sub>
</p>

<p align="center">
  <strong>English</strong> | <a href="README.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-brightgreen" alt="Platform">
</p>

---

## 📖 Overview

FMS (FileService) is a **self-hosted file management service** featuring end-to-end encryption, file sharing, WebDAV access, and an Android app.

- 🔐 **AES-256-GCM Encryption** — Files are encrypted client-side before upload; servers cannot read plaintext
- 📡 **WebDAV Protocol** — Mount as a network drive on Windows/Mac/Linux
- 🔗 **File Sharing** — Share links + access codes with download limits
- 📱 **Android App** — Capacitor WebView-based mobile client
- 🗄️ **Multi-Pool Storage** — Weighted allocation, health checks, automatic failover
- 🎨 **Dark/Light Theme** — Follow system preference or toggle manually

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Redis](https://redis.io/) >= 6 (for sessions, caching, public recycle bin)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/Antruly/FMS-Service.git
cd FMS-Service

# 2. Install dependencies
npm install

# 3. Configure environment (fresh install will auto-generate keys)
cp .env.example .env
# Edit .env, configure at minimum:
#   - PORT: server port (default: 88)
#   - REDIS_HOST / REDIS_PORT: Redis connection
#   - EMAIL_USER / EMAIL_AUTH_CODE: QQ email SMTP (optional, for verification codes)

# 4. Start the server
npm start
```

Open http://localhost:88 in your browser.

### Install as a System Service

| Platform | Script | Description |
|----------|--------|-------------|
| **Windows** | `scripts/install-windows-service.bat` | Uses native `sc` command, no third-party tools, requires admin |
| **Linux** | `scripts/install-linux-service.sh` | Uses native systemd, auto-creates dedicated user, requires root |

```bash
# Linux
sudo bash scripts/install-linux-service.sh

# Windows (run as Administrator)
scripts\install-windows-service.bat
```

### Docker (Coming Soon)

> Docker deployment support is planned.

## 📂 Project Structure

```
FMS-Service/
├── server.js              # Express entry point, middleware, startup
├── config.js              # Environment loader, key management
├── package.json           # Dependencies
├── .env.example           # Environment template
├── LICENSE                # MIT License
│
├── routes/                # API Routes
│   ├── auth.js            # Auth: login/register/QR/device management
│   ├── file.js            # File CRUD / upload / download / preview / recycle bin
│   ├── share.js           # File sharing / access codes / batch share
│   ├── webdav.js          # WebDAV protocol / link management
│   ├── storage.js         # Storage groups / mirrors / async tasks
│   ├── version.js         # APK version management / upload / download
│   ├── backup.js         # Backup task management
│   └── logs.js            # Admin audit logs
│
├── lib/                   # Core Libraries
│   ├── db.js              # SQLite database models (sql.js/WASM)
│   ├── redis.js              # Redis operations (sessions, traffic, verification)
│   ├── crypto.js             # AES-256-GCM encrypt/decrypt (V1 chunked format)
│   ├── storage-stream.js     # Storage pool streaming I/O
│   ├── traffic-middleware.js # Global traffic stats middleware (HTTP-layer counting)
│   ├── backup.js             # Data backup logic
│   ├── backup-scheduler.js   # Backup scheduling
│   ├── inactivity-scheduler.js # Share/WebDAV inactivity auto-disable
│   ├── email.js              # Email sending (QQ SMTP)
│   ├── ws.js                 # WebSocket push notifications
│   ├── log.js                # Leveled logging (info/debug/warn/error)
│   ├── logger.js             # Audit logging
│   ├── utils.js              # Shared utilities
│   └── validator.js          # Input validation
│
├── public/                # Frontend Static Files
│   ├── index.html         # Homepage / Dashboard
│   ├── home.html          # Main SPA (sidebar + content panel)
│   ├── login.html         # Login page (password/code/QR)
│   ├── share.html         # Share file browser/downloader
│   ├── admin-storage.html # Storage management (embedded iframe)
│   ├── admin-backup.html  # Backup management
│   ├── admin-tasks.html   # Async task management
│   ├── app.js             # Frontend application logic
│   ├── style.css          # Global styles / theme system
│   └── favicon.png        # Logo
│
├── scripts/               # Utility Scripts
│   ├── pre-build.js       # APK pre-build (version injection)
│   ├── install-windows-service.bat   # Windows service installer
│   ├── uninstall-windows-service.bat # Windows service uninstaller
│   └── install-linux-service.sh      # Linux systemd installer
│
├── app/android/           # Android App Source (Capacitor)
│   ├── app/src/main/java/com/fileservice/app/
│   │   ├── MainActivity.java         # Main Activity
│   │   └── SettingsActivity.java     # Settings
│   └── app/build.gradle              # Build config / version
│
└── tests/                 # E2E Tests (Playwright)
```

## ✨ Features

### File Management
- 📤 Upload / Download / Rename / Move / Delete
- 📁 Multi-level directories (personal + public)
- 🔍 File name search
- 🖼️ Image/video thumbnails and in-browser preview
- 🗑️ Recycle bin (30-day auto-cleanup with restore)
- 🗜️ Offline batch download (zip packaging)

### Encryption & Security
- 🔐 AES-256-GCM file encryption (V1 chunked format with Range support)
- 🔑 Client-side key derivation (password never transmitted in plaintext)
- 🛡️ CSRF protection + Session management
- 🚦 Rate limiting + Automatic IP bans
- 📧 Email verification for registration

### File Sharing
- 🔗 Share links + access codes
- ⏱️ Expiry time + download count limits
- 📊 Share logs (access/download tracking)
- 🗂️ Single-file and batch sharing

### WebDAV
- 🌐 Standard WebDAV protocol (PROPFIND/GET/PUT/DELETE/MOVE/COPY/LOCK)
- 🔗 Link management (create/expire/delete)
- 🔒 Password-protected and public links
- 📂 Personal directory and public directory support

### Traffic Statistics
- 📊 HTTP-layer real-time response byte counting
- 👤 Request traffic aggregated by user activity sessions (3min idle / 60min max)
- 📁 File transfer traffic recorded by actual transmitted bytes, cancellations not counted
- 📈 Admin dashboard with traffic charts (daily/monthly/yearly summaries)

### Data Backup
- 💾 Scheduled backup of SQLite database + storage files
- ☁️ Local/remote backup path support
- 📋 Async task scheduling with admin visualization
- 🔔 Email notifications on completion/failure

### Inactivity Management
- ⏱️ Auto-disable share links after inactivity period
- 🔗 Auto-disable WebDAV links after inactivity
- 📧 Email notifications before expiry

### Storage Pool
- 🗄️ Multi-group / multi-mirror paths
- ⚖️ Weighted write allocation (1-10)
- ❤️ Health checks + automatic failover
- 🔄 File migration / reorganization / rollback
- 📋 Async task system (batch operations)

### Android App
- 📱 Capacitor WebView wrapper
- 🔍 QR code login
- ⚙️ Custom server URL
- 🌐 In-app WebDAV access
- 📲 Update detection

## ⚙️ Configuration

All settings are configured via `.env` environment variables. See [`.env.example`](.env.example) for the full list.

### Key Settings

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 88) |
| `SESSION_SECRET` | Auto* | Session encryption key |
| `SYSTEM_MASTER_KEY` | Auto* | File encryption master key ⚠️ Lost key = unrecoverable files |
| `REDIS_HOST` | Yes | Redis host address |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `EMAIL_USER` | No | QQ email address (for verification codes) |
| `EMAIL_AUTH_CODE` | No | QQ email SMTP authorization code |
| `APP_BASE_URL` | No | Public-facing app URL (for share links in emails) |
| `CORS_ORIGINS` | No | CORS whitelist (empty = dev mode, allow all) |
| `LOG_LEVEL` | No | Log level: debug / info / warn / error |
| `SSL_ENABLED` | No | Enable HTTPS |
| `STORAGE_ALERT_EMAIL` | No | Storage health alert recipients |

\* Auto-generated on fresh install; must be manually configured if database exists.

### QQ Email SMTP Setup

1. Log into QQ Mail → Settings → Account → POP3/SMTP Service
2. Enable the service and get the authorization code
3. Configure in `.env`:
   ```
   EMAIL_USER=your-email@foxmail.com
   EMAIL_AUTH_CODE=your-authorization-code
   EMAIL_FROM=File Management System
   ```

## 🔧 Development

```bash
# Start in development mode (debug logging)
LOG_LEVEL=debug node server.js

# Run E2E tests
npx playwright test

# Build Android APK (see CLAUDE.md for details)
node scripts/pre-build.js "Changelog entry"
cd app/android && ./gradlew assembleRelease
```

## 📄 License

[MIT License](LICENSE) — Free to use, modify, and distribute.

## 🔗 Links

| Project | Repository |
|---------|------------|
| 🌐 **Server** | [Antruly/FMS-Service](https://github.com/Antruly/FMS-Service) |
| 📱 **Android App** | [Antruly/FMS-Service-app](https://github.com/Antruly/FMS-Service-app) |

## 🙏 Acknowledgments

- [Express](https://expressjs.com/) — Web framework
- [sql.js](https://sql.js.org/) — SQLite WASM implementation
- [ioredis](https://github.com/redis/ioredis) — Redis client
- [Capacitor](https://capacitorjs.com/) — Cross-platform WebView framework
- [Playwright](https://playwright.dev/) — E2E testing framework
