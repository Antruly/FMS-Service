# FileService 项目指南

## APK 构建规范

### 构建步骤（每次构建必须递增版本号）

1. **递增版本号**：修改 `app/android/app/build.gradle`，`versionCode` +1，`versionName` 的 patch 版本 +1
   - 例如：2.3.9 → 2.3.10，versionCode 20309 → 20310
2. **写入更新日志**到 APK（构建时自动打包进 assets/version.json，上传时服务器解析）：
```bash
node scripts/pre-build.js "更新日志内容，如: 修复WebDAV大文件上传; 新增扫一扫功能"
```
3. 运行构建命令：
```bash
cd app/android && ./gradlew assembleRelease
```
4. 将 APK 复制到 `app/release/` 目录，按版本号命名：
```bash
cp app/android/app/build/outputs/apk/release/app-release.apk app/release/FMS-Service-v{version}.apk
```

### APK 版本自动识别

- 构建时 `pre-build.js` 从 `build.gradle` 读取 versionCode/versionName，写入 `assets/version.json`
- 上传时服务器通过 `adm-zip` 解析 APK 内的 `assets/version.json`，自动提取版本号和更新日志
- 回退：解析失败时从文件名正则 `v?(\d+)\.(\d+)\.(\d+)` 提取版本

### 版本号命名规则

- **文件名格式**: `FileService-v{version}.apk`（如 `FileService-v2.3.9.apk`）
- **versionCode**: `{major} * 10000 + {minor} * 100 + {patch}`（如 2.3.9 → 20309）
- **versionName**: `{major}.{minor}.{patch}`（如 `2.3.9`）

### 版本管理后台

- 上传 APK 时后台从文件名自动解析版本号（正则: `v?(\d+)\.(\d+)\.(\d+)`）
- Android App 启动时自动调用 `/api/version/latest` 检查更新
- APK 文件名不符合规范时版本会被解析为 `0.0.0`

## 项目架构

- **后端**: Node.js + Express 4.21，SQLite (sql.js/WASM)，ioredis
- **前端**: 纯 HTML/JS/CSS，单页应用
- **移动端**: Android WebView 应用（Capacitor 封装），Java 源码在 `app/android/`
- **加密**: AES-256-GCM 文件加密

## 关键文件

| 文件 | 用途 |
|------|------|
| `server.js` | Express 主入口，CORS/CSRF/Session 中间件，路由挂载 |
| `config.js` | 环境变量加载，必须参数校验 |
| `routes/auth.js` | 登录/注册/QR登录/设备管理 |
| `routes/file.js` | 文件 CRUD，离线下载，预览 |
| `routes/share.js` | 文件分享，提取码验证 |
| `routes/version.js` | APK 版本管理（上传/列表/删除/最新） |
| `lib/redis.js` | Redis 操作：Session跟踪，流量缓冲，验证码 |
| `lib/db.js` | SQLite 数据库模型 |
| `lib/crypto.js` | AES-256-GCM 文件加密/解密 |
| `public/app.js` | 前端主逻辑（1128+ 行，需模块化重构） |
