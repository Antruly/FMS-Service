@echo off
chcp 65001 >nul
echo ========================================
echo   FILE:// 文件管理系统 - 构建脚本
echo ========================================
echo.

set RELEASE_DIR=%~dp0release
set SRC_DIR=%~dp0

echo [1/5] 清理旧构建目录...
if exist "%RELEASE_DIR%" rd /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"
echo       完成
echo.

echo [2/5] 复制服务端核心文件...
xcopy "%SRC_DIR%server.js" "%RELEASE_DIR%\" /Y >nul 2>&1
xcopy "%SRC_DIR%package.json" "%RELEASE_DIR%\" /Y >nul 2>&1
xcopy "%SRC_DIR%config.js" "%RELEASE_DIR%\" /Y >nul 2>&1
xcopy "%SRC_DIR%package-lock.json" "%RELEASE_DIR%\" /Y >nul 2>&1
xcopy "%SRC_DIR%data" "%RELEASE_DIR%\data\" /E /Y >nul 2>&1
xcopy "%SRC_DIR%lib" "%RELEASE_DIR%\lib\" /E /Y >nul 2>&1
xcopy "%SRC_DIR%routes" "%RELEASE_DIR%\routes\" /E /Y >nul 2>&1
echo       完成
echo.

echo [3/5] 复制前端文件...
xcopy "%SRC_DIR%public" "%RELEASE_DIR%\public\" /E /Y >nul 2>&1
xcopy "%SRC_DIR%docs" "%RELEASE_DIR%\docs\" /E /Y >nul 2>&1
echo       完成
echo.

echo [4/5] 复制启动脚本...
xcopy "%~dp0start.bat" "%RELEASE_DIR%\" /Y >nul 2>&1
xcopy "%~dp0npm_install.bat" "%RELEASE_DIR%\" /Y >nul 2>&1
echo       完成
echo.

echo [5/5] 生成环境变量说明文件...
(
echo # FILE:// 环境变量配置说明
echo.
echo # 复制此文件为 .env 后修改对应值，或直接在系统环境变量中设置
echo.
echo # 服务端口
echo PORT=88
echo.
echo # 会话密钥（生产环境请修改为随机字符串）
echo SESSION_SECRET=fileservice-secret-key-change-in-production
echo.
echo # 数据库路径
echo DB_PATH=./data/fileservice.db
echo.
echo # Redis 配置
echo REDIS_HOST=127.0.0.1
echo REDIS_PORT=6379
echo REDIS_DB=15
echo REDIS_PREFIX=ambush:
echo.
echo # SSL 配置（可选，启用 HTTPS）
echo SSL_ENABLED=false
echo SSL_KEY_PATH=./cer/download.ssvr.top.key
echo SSL_CERT_PATH=./cer/download.ssvr.top.pem
echo SSL_PORT=8843
echo.
echo # 邮箱配置（发送验证码用）
echo EMAIL_USER=assvr@foxmail.com
echo EMAIL_AUTH_CODE=your_auth_code_here
echo EMAIL_FROM=文件管理系统
) > "%RELEASE_DIR%\.env.example"
echo       完成
echo.

echo ========================================
echo   构建完成！
echo ========================================
echo.
echo 下一步操作：
echo   1. 双击 npm_install.bat 安装依赖
echo   2. 根据需要复制 .env.example 为 .env
echo   3. 双击 start.bat 启动服务
echo.
echo 访问地址：http://localhost:88
echo.
pause
