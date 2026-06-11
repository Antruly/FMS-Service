/**
 * APK 构建前脚本 — 将版本号、更新日志、服务器地址写入 assets/
 * 构建时打包进 APK，上传时服务器自动解析
 *
 * 用法：
 *   node scripts/pre-build.js "更新日志内容..."
 *   或通过环境变量 CHANGELOG / APP_BASE_URL 传入
 */
var fs = require('fs');
var path = require('path');

var gradlePath = path.join(__dirname, '..', 'app', 'android', 'app', 'build.gradle');
var assetsDir = path.join(__dirname, '..', 'app', 'android', 'app', 'src', 'main', 'assets');

// 确保 assets 目录存在
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// 1. 从 build.gradle 读取 versionCode 和 versionName
var gradleContent = fs.readFileSync(gradlePath, 'utf-8');
var versionCodeMatch = gradleContent.match(/versionCode\s+(\d+)/);
var versionNameMatch = gradleContent.match(/versionName\s+"([^"]+)"/);

if (!versionCodeMatch || !versionNameMatch) {
  console.error('[pre-build] 无法从 build.gradle 解析版本号');
  process.exit(1);
}

var versionCode = parseInt(versionCodeMatch[1], 10);
var versionName = versionNameMatch[1];

// 2. 更新日志：命令行参数 > 环境变量 > 默认值
var changelog = process.argv[2] || process.env.CHANGELOG || '';

// 3. 服务器地址：环境变量 > __AUTO__ 占位符（上传时服务器动态注入）
var serverUrl = process.env.APP_BASE_URL || '__AUTO__';

// 4. 写入 version.json（版本信息）
var info = {
  versionName: versionName,
  versionCode: versionCode,
  changelog: changelog
};
fs.writeFileSync(path.join(assetsDir, 'version.json'), JSON.stringify(info, null, 2), 'utf-8');
console.log('[pre-build] version.json written: v' + versionName + ' (code: ' + versionCode + ')');
console.log('[pre-build] changelog: ' + (changelog || '(empty)'));

// 5. 写入 server_config.json（服务器地址）
var serverConfig = { server_url: serverUrl };
fs.writeFileSync(path.join(assetsDir, 'server_config.json'), JSON.stringify(serverConfig, null, 2), 'utf-8');
console.log('[pre-build] server_config.json written: ' + serverUrl);
