# FileService 项目指南

## 版本号规范与发布流程

### 版本号格式

- **服务器版本**：`MAJOR.MINOR.PATCH`（如 `1.1.0`），定义在 `package.json` 的 `version` 字段
  - `MAJOR`（主版本）：重大架构变更、不兼容的 API 改动
  - `MINOR`（发布版本）：累积多个功能的正式发布版本
  - `PATCH`（开发版本）：日常 bug 修复、小改进、灰度迭代
- **APK 版本**：独立于服务器版本，遵循相同三段式格式（如 `2.5.0`），定义在 `app/android/app/build.gradle`
  - `versionCode` = `major * 10000 + minor * 100 + patch`（如 2.5.0 → 20500）
  - `versionName` = `"{major}.{minor}.{patch}"`

### 开发版本（PATCH）vs 发布版本（MINOR）

| | 开发版本 (1.0.x) | 发布版本 (1.1.0) |
|---|---|---|
| 触发条件 | 日常 commit，单个或少量改动 | 累积足够功能后一次发布 |
| Git 标签 | 不打 tag | 打 `vX.Y.Z` tag |
| GitHub Release | 不发 | 创建 Release，写完整更新日志 |
| Changelog | 简短一行 | 分类汇总自上一发布版以来的所有改动 |
| 示例 | 1.0.1 → 1.0.2 → 1.0.3 | 1.1.0 → 1.2.0 → ... |

### 发布流程

1. **确认所有改动已提交且测试通过**
2. **递增版本号**：`package.json` 中 MINOR +1，PATCH 归 0；同步更新 README 徽章、首页/关于页面的版本号
3. **编译更新日志**：从 git log 或 `pre-build.js` 记录中汇总所有开发版本改动
4. **构建 APK**（如有 Android 侧改动）：递增 `build.gradle` 中的 `versionCode` 和 `versionName`
5. **打 Git 标签**：`git tag -a v1.1.0 -m "v1.1.0: 更新日志摘要"`
6. **推送到 GitHub**：`git push && git push --tags`
7. **创建 GitHub Release**：标题 `v1.1.0`，正文贴完整 changelog，上传 APK 附件

### 旧开发版本清理

正式发布 MAJOR.MINOR.0 后，删除之前同 MAJOR 的旧 PATCH 版 GitHub Release（如 v1.1.0 发布后删除 v1.0.1/v1.0.2/v1.0.3 Release），保留 git tag 历史。

### Git 提交规范

- 日常提交：`type: 简短描述`（如 `fix: 修复上传报错`、`feat: 新增全局搜索`）
- 构建提交：`build: vX.Y.Z — 更新内容`（APK 构建时）

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

- **文件名格式**: `FMS-Service-v{version}.apk`（如 `FMS-Service-v2.3.9.apk`）
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
