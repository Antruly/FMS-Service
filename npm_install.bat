@echo off
chcp 65001 >nul
echo ========================================
echo   安装依赖
echo ========================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装
    echo   下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 检查 npm
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 npm，请先安装 Node.js
    pause
    exit /b 1
)

echo [信息] 开始安装依赖（这可能需要几分钟）...
echo.

npm install --registry=https://registry.npmmirror.com

if %errorlevel% equ 0 (
    echo.
    echo [完成] 依赖安装成功！
    echo.
    echo 下一步：双击 start.bat 启动服务
) else (
    echo.
    echo [错误] 依赖安装失败，请检查网络或 Node.js 版本
)

pause
