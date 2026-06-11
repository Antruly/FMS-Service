/**
 * 文件下载测试脚本 - 用于调试 relPath 问题
 */
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const CHROME_PATH = 'd:\\tools\\fileservice\\chrome-win64\\chrome.exe';
const CHROMEDRIVER_PATH = 'd:\\tools\\fileservice\\chromedriver-win64\\chromedriver.exe';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'Test@123456';
const BASE_URL = 'http://localhost:88';
const screenshotsDir = path.join(__dirname, 'screenshots');
// ========== 配置结束 ==========

async function initDriver() {
    const options = new chrome.Options();
    options.setChromeBinaryPath(CHROME_PATH);
    options.addArguments('--no-sandbox');
    options.addArguments('--disable-dev-shm-usage');
    options.addArguments('--disable-gpu');
    options.addArguments('--window-size=1920,1080');
    options.addArguments('--disable-blink-features=AutomationControlled');

    const service = new chrome.ServiceBuilder(CHROMEDRIVER_PATH);
    return await new Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .setChromeService(service)
        .build();
}

async function takeScreenshot(driver, name) {
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const screenshotPath = path.join(screenshotsDir, `${name}.png`);
    try {
        const image = await driver.takeScreenshot();
        fs.writeFileSync(screenshotPath, image, 'base64');
        console.log(`  [截图] ${name}.png`);
    } catch (e) {
        console.log(`  [截图失败] ${e.message}`);
    }
}

async function login(driver) {
    console.log('\n=== 步骤1: 登录 ===');
    
    // 先访问登录页获取初始 session
    await driver.get(`${BASE_URL}/login.html`);
    await driver.sleep(1000);
    
    // 获取初始 cookies
    const cookies1 = await driver.manage().getCookies();
    console.log(`  [初始 Cookies] ${cookies1.length} 个`);
    
    // 通过 JavaScript 注入调用 API 登录
    const loginResult = await driver.executeAsyncScript(async function(callback) {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: process.env.TEST_EMAIL || 'test@example.com',
                password: process.env.TEST_PASSWORD || 'Test@123456'
            }),
            credentials: 'include'
        });
        const data = await response.json();
        callback({ ok: response.ok, status: response.status, data: data });
    });
    
    console.log(`  [API 响应] status=${loginResult.status}, code=${loginResult.data.code}, message=${loginResult.data.message}`);
    
    if (loginResult.data.code === 0) {
        console.log('  [OK] 登录成功');
        
        // 获取新的 cookies
        const cookies2 = await driver.manage().getCookies();
        console.log(`  [登录后 Cookies] ${cookies2.length} 个`);
        
        // 访问 home.html
        await driver.get(`${BASE_URL}/home.html`);
        await driver.sleep(2000);
        
        const url = await driver.getCurrentUrl();
        if (url.includes('home.html')) {
            console.log('  [OK] 跳转到首页成功');
            return true;
        }
    }
    
    // 如果 API 登录失败，尝试表单登录
    console.log('  [尝试] 表单登录...');
    await driver.get(`${BASE_URL}/login.html`);
    await driver.sleep(1000);
    
    try {
        await driver.findElement(By.id('login-email')).clear();
        await driver.findElement(By.id('login-password')).clear();
        await driver.findElement(By.id('login-email')).sendKeys(process.env.TEST_EMAIL || 'test@example.com');
        await driver.findElement(By.id('login-password')).sendKeys(process.env.TEST_PASSWORD || 'Test@123456');
        await driver.findElement(By.id('btn-login')).click();
        await driver.sleep(3000);
        
        const url = await driver.getCurrentUrl();
        if (url.includes('home.html')) {
            console.log('  [OK] 表单登录成功');
            return true;
        }
    } catch (e) {
        console.log(`  [表单错误] ${e.message}`);
    }
    
    console.log('  [失败] 登录失败');
    await takeScreenshot(driver, 'login-failed');
    return false;
}

async function injectDebugLogger(driver) {
    // 注入控制台日志捕获
    await driver.executeScript(`
        window.__downloadLogs = [];
        window.__downloadErrors = [];
        
        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function(url, options) {
            if (typeof url === 'string' && url.includes('download')) {
                window.__downloadLogs.push('[Fetch] ' + url);
            }
            return originalFetch.apply(this, arguments);
        };
        
        // 拦截 console
        const originalLog = console.log;
        console.log = function() {
            const args = Array.from(arguments);
            if (args[0] && args[0].toString().includes('[Download]')) {
                window.__downloadLogs.push(args.map(a => String(a)).join(' '));
            }
            originalLog.apply(console, arguments);
        };
        
        console.log('[Debug] Logger injected');
    `);
}

async function testDownloadFile(driver, fileInfo) {
    console.log(`\n=== 测试下载文件 ===`);
    console.log(`  [目标文件] ${fileInfo.name}`);
    console.log(`  [ID] ${fileInfo.id}`);
    console.log(`  [relPath] ${fileInfo.relPath}`);
    console.log(`  [isPublicFile] ${fileInfo.isPublicFile}`);
    
    // 清除之前的日志
    await driver.executeScript(`window.__downloadLogs = [];`);
    
    // 点击文件触发下载
    const fileCard = await driver.findElement(By.xpath(`//*[@data-file-id="${fileInfo.id}"]`));
    await fileCard.click();
    await driver.sleep(2000);
    
    // 获取下载日志
    const downloadLogs = await driver.executeScript(`return window.__downloadLogs;`);
    console.log('\n  [下载日志]');
    downloadLogs.forEach(log => console.log(`    ${log}`));
    
    // 检查浏览器网络请求
    console.log('\n  [提示] 请查看浏览器开发者工具 Network 标签页中的下载请求');
    
    await takeScreenshot(driver, '03-after-download-click');
}

async function testPublicFilesDownload(driver) {
    console.log('\n=== 步骤2: 进入公共文件目录 ===');
    
    // 等待文件容器加载
    await driver.wait(until.elementLocated(By.id('file-container')), 10000);
    await driver.sleep(1000);
    
    // 检查当前目录
    const currentDir = await driver.executeScript(`
        return window.__fm ? window.__fm.state.currentPublicPath : 'unknown';
    `);
    console.log(`  [当前路径] ${currentDir || '(根目录)'}`);
    
    // 获取文件列表数据
    const fileData = await driver.executeScript(`
        return window.__fm ? window.__fm.state.fileData : [];
    `);
    console.log(`  [文件数量] ${fileData.length}`);
    
    // 列出所有文件和目录
    console.log('  [目录列表]');
    fileData.forEach((f, i) => {
        console.log(`    [${i}] ${f.name} | isDir=${f.isDirectory} | relPath=${f.relPath || 'null'}`);
    });
    
    // 查找 apk 目录或可下载的文件
    const apkDir = fileData.find(f => f.isDirectory && f.name === 'apk');
    if (!apkDir) {
        // 尝试找一个可下载的文件
        const downloadFile = fileData.find(f => !f.isDirectory);
        if (downloadFile) {
            console.log(`  [找到可下载文件] ${downloadFile.name}, relPath=${downloadFile.relPath}`);
            await testDownloadFile(driver, downloadFile);
            return;
        }
        console.log('  [错误] 找不到 apk 目录和可下载文件');
        await takeScreenshot(driver, 'no-apk-dir');
        return;
    }
    console.log(`  [找到] apk 目录, relPath=${apkDir.relPath}`);
    
    await takeScreenshot(driver, '01-public-files-root');
    
    console.log('\n=== 步骤3: 进入 apk 目录 ===');
    
    // 点击 apk 目录
    const apkCard = await driver.findElement(By.xpath(`//*[@data-file-id="${apkDir.id}"]`));
    await apkCard.click();
    await driver.sleep(2000);
    
    // 检查当前路径
    const newDir = await driver.executeScript(`
        return window.__fm ? window.__fm.state.currentPublicPath : 'unknown';
    `);
    console.log(`  [当前路径] ${newDir}`);
    
    // 获取 apk 目录下的文件
    const apkFiles = await driver.executeScript(`
        return window.__fm ? window.__fm.state.fileData : [];
    `);
    console.log(`  [文件数量] ${apkFiles.length}`);
    
    // 获取原始 API 响应
    const rawData = await driver.executeAsyncScript(async function(callback) {
        const response = await fetch('/api/public-files/list?path=apk', {
            credentials: 'include'
        });
        const data = await response.json();
        callback(data);
    });
    console.log('\n  [原始 API 响应]');
    console.log(`    code: ${rawData.code}`);
    console.log(`    dirs count: ${(rawData.data && rawData.data.dirs) ? rawData.data.dirs.length : 0}`);
    console.log(`    files count: ${(rawData.data && rawData.data.files) ? rawData.data.files.length : 0}`);
    if (rawData.data && rawData.data.files && rawData.data.files.length > 0) {
        console.log('    [第一个文件原始数据]');
        console.log(`      ${JSON.stringify(rawData.data.files[0])}`);
    }
    
    // 打印文件信息
    apkFiles.forEach((f, i) => {
        console.log(`    [${i}] ${f.name} | id=${f.id} | relPath=${f.relPath} | isPublicFile=${f.isPublicFile}`);
    });
    
    await takeScreenshot(driver, '02-apk-directory');
    
    if (apkFiles.length === 0) {
        console.log('  [错误] apk 目录下没有文件');
        return;
    }
    
    console.log('\n=== 步骤4: 点击下载第一个文件 ===');
    
    const firstFile = apkFiles.find(f => !f.isDirectory);
    if (!firstFile) {
        console.log('  [错误] 找不到可下载的文件');
        return;
    }
    
    console.log(`  [目标文件] ${firstFile.name}`);
    console.log(`  [ID] ${firstFile.id}`);
    console.log(`  [relPath] ${firstFile.relPath}`);
    console.log(`  [isPublicFile] ${firstFile.isPublicFile}`);
    
    // 点击文件触发下载
    const fileCard = await driver.findElement(By.xpath(`//*[@data-file-id="${firstFile.id}"]`));
    
    // 清除之前的日志
    await driver.executeScript(`window.__downloadLogs = [];`);
    
    // 点击文件
    await fileCard.click();
    await driver.sleep(2000);
    
    // 获取下载日志
    const downloadLogs = await driver.executeScript(`return window.__downloadLogs;`);
    console.log('\n  [下载日志]');
    downloadLogs.forEach(log => console.log(`    ${log}`));
    
    // 检查浏览器网络请求
    console.log('\n  [提示] 请查看浏览器开发者工具 Network 标签页中的下载请求');
    
    await takeScreenshot(driver, '03-after-download-click');
}

async function testPersonalFilesDownload(driver) {
    console.log('\n=== 步骤5: 测试个人文件下载 ===');
    
    // 切换到个人文件标签
    const personalTab = await driver.findElement(By.xpath(`//*[contains(@class, 'tab-btn') and contains(text(), '个人文件')]`));
    await personalTab.click();
    await driver.sleep(2000);
    
    // 获取文件列表
    const fileData = await driver.executeScript(`
        return window.__fm ? window.__fm.state.fileData : [];
    `);
    console.log(`  [文件数量] ${fileData.length}`);
    
    fileData.forEach((f, i) => {
        console.log(`    [${i}] ${f.name} | id=${f.id} | isDirectory=${f.isDirectory}`);
    });
    
    // 找第一个可下载的文件
    const downloadFile = fileData.find(f => !f.isDirectory);
    if (downloadFile) {
        console.log(`\n  [目标文件] ${downloadFile.name} (id=${downloadFile.id})`);
        
        // 清除日志
        await driver.executeScript(`window.__downloadLogs = [];`);
        
        // 点击文件
        const fileCard = await driver.findElement(By.xpath(`//*[@data-file-id="${downloadFile.id}"]`));
        await fileCard.click();
        await driver.sleep(2000);
        
        const downloadLogs = await driver.executeScript(`return window.__downloadLogs;`);
        console.log('\n  [下载日志]');
        downloadLogs.forEach(log => console.log(`    ${log}`));
    }
    
    await takeScreenshot(driver, '04-personal-files');
}

async function main() {
    let driver;
    try {
        console.log('='.repeat(60));
        console.log('文件下载测试 - 调试 relPath 问题');
        console.log('='.repeat(60));
        
        driver = await initDriver();
        await driver.manage().setTimeouts({ implicit: 10000 });
        
        // 登录
        if (!await login(driver)) {
            return;
        }
        
        await takeScreenshot(driver, '00-after-login');
        
        // 注入调试日志
        await injectDebugLogger(driver);
        
        // 测试公共文件下载
        await testPublicFilesDownload(driver);
        
        // 测试个人文件下载
        await testPersonalFilesDownload(driver);
        
        console.log('\n' + '='.repeat(60));
        console.log('测试完成');
        console.log('='.repeat(60));
        
    } catch (e) {
        console.error('\n[错误]', e.message);
        if (driver) {
            await takeScreenshot(driver, 'error');
        }
    } finally {
        if (driver) {
            console.log('\n按 Enter 键关闭浏览器...');
            await driver.sleep(5000);
            await driver.quit();
        }
    }
}

main();
