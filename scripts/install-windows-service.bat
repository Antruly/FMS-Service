@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: ============================================================
:: FMS (FileService) - Windows 原生服务安装脚本
:: 使用 Windows 内置 sc 命令，无需第三方工具
:: 需要以管理员权限运行
:: ============================================================

set "SERVICE_NAME=FMSFileService"
set "DISPLAY_NAME=FMS 文件管理系统"
set "DESCRIPTION=FMS 文件管理系统 - 端到端加密文件服务"
set "CURRENT_DIR=%~dp0.."
set "NODE_PATH=%CURRENT_DIR%\node_modules\.bin"

:: 检查管理员权限
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 此脚本需要管理员权限，请右键以管理员身份运行！
    pause
    exit /b 1
)

:: 检查 Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

:: 自动查找 node.exe 完整路径
for /f "delims=" %%i in ('where node') do set "NODE_EXE=%%i"
echo [信息] Node.js 路径: %NODE_EXE%

:: 检查 .env 文件
if not exist "%CURRENT_DIR%\.env" (
    echo [警告] 未找到 .env 文件，将使用默认配置
    echo [警告] 建议先复制 .env.example 为 .env 并修改配置
)

:: 安装 npm 依赖
echo [信息] 检查 npm 依赖...
if not exist "%CURRENT_DIR%\node_modules" (
    echo [信息] 正在安装 npm 依赖...
    cd /d "%CURRENT_DIR%"
    call npm install --production
    if %errorlevel% neq 0 (
        echo [错误] npm install 失败！
        pause
        exit /b 1
    )
)

:: ============================================================
:: 方式 1: 使用 sc create (推荐，适合生产环境)
:: ============================================================

echo.
echo [信息] 正在安装服务: %SERVICE_NAME%...

:: 先停止并删除旧服务（如果存在）
sc query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
    echo [信息] 发现已存在的服务，正在移除...
    sc stop "%SERVICE_NAME%" >nul 2>&1
    timeout /t 3 >nul
    sc delete "%SERVICE_NAME%" >nul 2>&1
    timeout /t 2 >nul
)

:: 创建 binPath：node.exe 完整路径 + server.js 完整路径
:: 使用 --harmony 让 Node 支持最新 ES 特性
set "BIN_PATH=%NODE_EXE% --harmony server.js"

:: 创建服务
:: start= auto = 自动启动
:: type= own = 独立进程
sc create "%SERVICE_NAME%" ^
    binPath= "\"%NODE_EXE%\" \"%CURRENT_DIR%\server.js\"" ^
    start= auto ^
    type= own ^
    DisplayName= "%DISPLAY_NAME%" ^
    obj= LocalSystem

if %errorlevel% neq 0 (
    echo [错误] 服务创建失败！
    pause
    exit /b 1
)

:: 设置服务描述
sc description "%SERVICE_NAME%" "%DESCRIPTION%"

:: 设置失败恢复：第一次失败重启，第二次失败重启，后续失败重启
:: 重置失败计数间隔 = 86400秒（24小时）
sc failure "%SERVICE_NAME%" reset= 86400 actions= restart/60000/restart/60000/restart/60000

:: 设置服务启动目录（通过注册表）
set "REG_KEY=HKLM\SYSTEM\CurrentControlSet\Services\%SERVICE_NAME%"
reg add "%REG_KEY%" /v "AppDirectory" /t REG_SZ /d "%CURRENT_DIR%" /f >nul 2>&1

echo.
echo ============================================================
echo   安装完成！
echo ============================================================
echo   服务名称: %SERVICE_NAME%
echo   显示名称: %DISPLAY_NAME%
echo   工作目录: %CURRENT_DIR%
echo.
echo   启动服务:
echo     sc start %SERVICE_NAME%
echo     或: net start %SERVICE_NAME%
echo.
echo   停止服务:
echo     sc stop %SERVICE_NAME%
echo     或: net stop %SERVICE_NAME%
echo.
echo   查看状态:
echo     sc query %SERVICE_NAME%
echo.
echo   卸载服务（先停止）:
echo     sc stop %SERVICE_NAME%
echo     然后运行: scripts\uninstall-windows-service.bat
echo ============================================================

:: 询问是否立即启动
set /p "START_NOW=是否立即启动服务？(Y/N): "
if /i "!START_NOW!"=="Y" (
    echo [信息] 正在启动服务...
    sc start "%SERVICE_NAME%"
    timeout /t 3 >nul
    sc query "%SERVICE_NAME%"
)

echo.
echo [完成] 服务安装完毕！
pause
