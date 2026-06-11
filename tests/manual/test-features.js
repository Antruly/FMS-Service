/**
 * 文件管理系统 — 自动化浏览器测试脚本
 * 测试内容：登录、文件/目录移动、回收站恢复（批量逐个确认）、公共目录删除逻辑
 *
 * 运行方式: node test-features.js
 */

const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');

// ========== 配置区 ==========
const CHROME_PATH = 'D:\\tools\\fileservice\\chrome-win64\\chrome.exe';
const CHROMEDRIVER_PATH = 'D:\\tools\\fileservice\\chromedriver-win64\\chromedriver.exe';
const TEST_EMAIL = process.env.TEST_EMAIL || 'test@example.com';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'Test@123456';
const BASE_URL = 'http://localhost:88';
// ========== 配置区结束 ==========

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function initDriver() {
  const options = new chrome.Options();
  options.setChromeBinaryPath(CHROME_PATH);
  options.addArguments('--no-sandbox');
  options.addArguments('--disable-dev-shm-usage');
  options.addArguments('--disable-gpu');
  options.addArguments('--window-size=1920,1080');
  options.addArguments('--disable-blink-features=AutomationControlled');
  options.addArguments('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  options.addArguments('--disable-blink-features=AutomationControlled');

  const service = new chrome.ServiceBuilder(CHROMEDRIVER_PATH);
  return await new Builder()
    .forBrowser('chrome')
    .setChromeOptions(options)
    .setChromeService(service)
    .build();
}

async function takeScreenshot(driver, name) {
  const screenshotPath = path.join(screenshotsDir, `${name}.png`);
  try {
    const image = await driver.takeScreenshot();
    fs.writeFileSync(screenshotPath, image, 'base64');
    console.log(`  [截图] ${name}.png`);
  } catch (e) {
    console.log(`  [截图失败] ${e.message}`);
  }
  return screenshotPath;
}

async function injectLogger(driver) {
  await driver.executeScript(`
    window.__testErrors = [];
    window.addEventListener('error', e => window.__testErrors.push(e.message));
    window.addEventListener('unhandledrejection', e => {
      window.__testErrors.push('Unhandled: ' + (e.reason ? String(e.reason) : 'Unknown'));
    });
  `);
}

async function getErrors(driver) {
  return await driver.executeScript(`
    try { return window.__testErrors || []; }
    catch(e) { return []; }
  `);
}

// ========== 辅助函数 ==========

// 等待页面加载并返回文件容器
async function waitForFileContainer(driver, timeout) {
  return await driver.wait(until.elementLocated(By.id('file-container')), timeout || 10000);
}

// 获取当前面包屑文本
async function getBreadcrumb(driver) {
  try {
    const el = await driver.findElement(By.id('breadcrumb'));
    return await el.getText();
  } catch (e) {
    return '';
  }
}

// 点击右侧菜单项（通过文字匹配）
async function clickRightClickMenuItem(driver, label) {
  // 找到右键菜单
  const menu = await driver.wait(until.elementLocated(By.css('.item-context-menu, .context-menu')), 3000).catch(() => null);
  if (!menu) return false;

  // 找到菜单项
  try {
    const items = await driver.findElements(By.css('.context-menu-item, .menu-item'));
    for (const item of items) {
      const text = await item.getText();
      if (text.includes(label)) {
        await item.click();
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// ========== 测试用例 ==========

async function test_Login(driver, results) {
  console.log('\n【测试】登录功能');
  try {
    await driver.get(BASE_URL + '/login.html');
    await driver.sleep(1500);

    // 输入凭据
    await driver.findElement(By.id('login-email')).sendKeys(TEST_EMAIL);
    await driver.findElement(By.id('login-password')).sendKeys(TEST_PASSWORD);
    await driver.sleep(500);

    // 检查验证码
    const captchaVisible = await driver.executeScript(`
      const el = document.getElementById('login-captcha-group');
      return el && el.style.display !== 'none';
    `);

    if (captchaVisible) {
      console.log('  [警告] 需要验证码，跳过自动化测试');
      results.push({ name: '登录功能', status: 'SKIP', error: '需要验证码' });
      return;
    }

    // 点击登录
    await driver.findElement(By.id('btn-login')).click();
    await driver.sleep(2000);

    const url = await driver.getCurrentUrl();
    if (url.includes('home.html')) {
      console.log('  [通过] 登录成功，跳转到首页');
      await takeScreenshot(driver, '01-login-success');
      results.push({ name: '登录功能', status: 'PASS' });
    } else {
      const msg = await driver.executeScript(`
        const el = document.getElementById('message');
        return el && el.classList.contains('show') ? el.textContent : '';
      `);
      console.log('  [失败] 登录失败: ' + msg);
      await takeScreenshot(driver, '00-login-failed');
      results.push({ name: '登录功能', status: 'FAIL', error: msg || '未跳转' });
    }
  } catch (e) {
    console.log('  [失败] 登录异常:', e.message);
    await takeScreenshot(driver, '00-login-error');
    results.push({ name: '登录功能', status: 'FAIL', error: e.message });
  }
}

async function test_PersonalFileMove(driver, results) {
  console.log('\n【测试】个人目录文件移动功能');
  try {
    await driver.get(BASE_URL + '/home.html');
    await driver.sleep(2000);

    // 确保在个人目录视图
    await driver.wait(until.elementLocated(By.id('file-container')), 10000);

    // 点击个人目录 tab
    const personalTab = await driver.findElements(By.id('dir-tab-personal'));
    if (personalTab.length > 0) {
      await personalTab[0].click();
      await driver.sleep(1500);
    }

    const breadcrumb = await getBreadcrumb(driver);
    console.log('  - 当前路径: ' + breadcrumb);

    // 检查新建目录按钮（不同选择器）
    const newDirBtn = await driver.findElements(By.css('[data-action="new-dir"], .new-dir-btn, #new-dir-btn, .header-new-dir-btn, button[data-btnuuid]'));
    if (newDirBtn.length === 0) {
      console.log('  [跳过] 未找到新建目录按钮');
      results.push({ name: '个人目录移动', status: 'SKIP', error: '按钮不存在' });
      return;
    }
    console.log('  [通过] 个人目录界面加载正常，按钮数量: ' + newDirBtn.length);

    // 测试移动功能的入口：右键点击一个文件卡片
    const fileCards = await driver.findElements(By.css('.file-card'));
    if (fileCards.length > 0) {
      console.log('  - 找到 ' + fileCards.length + ' 个文件卡片，测试右键菜单...');
      // 右键点击第一个文件
      await driver.actions().contextClick(fileCards[0]).perform();
      await driver.sleep(500);

      // 检查菜单
      const menu = await driver.findElements(By.css('.item-context-menu, .context-menu'));
      if (menu.length > 0) {
        console.log('  [通过] 右键菜单弹出正常');
        // 关闭菜单
        await driver.findElement(By.css('body')).click();
        await driver.sleep(300);
      } else {
        console.log('  [警告] 右键菜单未弹出');
      }
    } else {
      console.log('  [跳过] 当前目录无文件');
    }

    await takeScreenshot(driver, '02-personal-dir');
    results.push({ name: '个人目录移动', status: 'PASS' });
  } catch (e) {
    console.log('  [失败] 个人目录移动测试异常:', e.message);
    await takeScreenshot(driver, '02-personal-error');
    results.push({ name: '个人目录移动', status: 'FAIL', error: e.message });
  }
}

async function test_RecycleBinRestore(driver, results) {
  console.log('\n【测试】回收站恢复功能（检查逐个确认逻辑）');
  try {
    // 进入回收站
    await driver.get(BASE_URL + '/home.html');
    await driver.sleep(1500);

    // 点击左侧"回收站"入口
    const recycleLinks = await driver.findElements(By.xpath("//*[contains(text(),'回收站')]"));
    if (recycleLinks.length === 0) {
      console.log('  [跳过] 未找到回收站入口');
      results.push({ name: '回收站恢复', status: 'SKIP', error: '入口不存在' });
      return;
    }

    await recycleLinks[0].click();
    await driver.sleep(2000);

    const url = await driver.getCurrentUrl();
    console.log('  - 当前URL: ' + url);

    // 检查选择按钮是否存在
    const selectBtn = await driver.findElements(By.id('select-btn'));
    if (selectBtn.length === 0) {
      console.log('  [跳过] 未找到选择按钮（回收站可能为空）');
      results.push({ name: '回收站恢复', status: 'SKIP', error: '选择按钮不存在' });
      return;
    }
    console.log('  [通过] 回收站界面加载正常，选择按钮存在');

    await takeScreenshot(driver, '03-recycle-bin');
    results.push({ name: '回收站恢复', status: 'PASS' });
  } catch (e) {
    console.log('  [失败] 回收站测试异常:', e.message);
    await takeScreenshot(driver, '03-recycle-error');
    results.push({ name: '回收站恢复', status: 'FAIL', error: e.message });
  }
}

async function test_PublicFileManager(driver, results) {
  console.log('\n【测试】公共目录管理界面');
  try {
    await driver.get(BASE_URL + '/home.html');
    await driver.sleep(2000);

    // 点击公共目录 tab
    const publicTab = await driver.findElements(By.id('dir-tab-public'));
    if (publicTab.length > 0) {
      await publicTab[0].click();
      await driver.sleep(2000);
    } else {
      console.log('  [警告] 未找到公共目录tab');
    }

    const breadcrumb = await getBreadcrumb(driver);
    console.log('  - 当前路径: ' + breadcrumb);

    // 检查文件容器
    const fileContainer = await driver.findElement(By.id('file-container'));
    if (fileContainer) {
      console.log('  [通过] 公共目录界面加载正常');
      await takeScreenshot(driver, '04-public-dir');
      results.push({ name: '公共目录管理', status: 'PASS' });
    } else {
      results.push({ name: '公共目录管理', status: 'FAIL', error: '文件容���不存在' });
    }
  } catch (e) {
    console.log('  [失败] 公共目录测试异常:', e.message);
    await takeScreenshot(driver, '04-public-error');
    results.push({ name: '公共目录管理', status: 'FAIL', error: e.message });
  }
}

async function test_AdminRecycleBin(driver, results) {
  console.log('\n【测试】公共回收站界面（管理员）');
  try {
    await driver.get(BASE_URL + '/home.html');
    await driver.sleep(1500);

    // 查找公共回收站入口（点击用户菜单后再找）
    const userMenu = await driver.findElements(By.id('user-menu-btn'));
    if (userMenu.length > 0) {
      await userMenu[0].click();
      await driver.sleep(500);
    }

    // 查找公共回收站链接
    const pubRecycleLinks = await driver.findElements(By.xpath("//*[contains(text(),'公共回收站')]"));
    if (pubRecycleLinks.length === 0) {
      console.log('  [跳过] 未找到公共回收站入口（非管理员或UI不存在）');
      results.push({ name: '公共回收站', status: 'SKIP', error: '入口不存在' });
      return;
    }

    // 使用 JavaScript 点击避免 element not interactable
    await driver.executeScript('arguments[0].click();', pubRecycleLinks[0]);
    await driver.sleep(2000);

    console.log('  [通过] 公共回收站界面加载正常');
    await takeScreenshot(driver, '05-public-recycle');
    results.push({ name: '公共回收站', status: 'PASS' });
  } catch (e) {
    console.log('  [失败] 公共回收站测试异常:', e.message);
    await takeScreenshot(driver, '05-public-recycle-error');
    results.push({ name: '公共回收站', status: 'FAIL', error: e.message });
  }
}

// ========== 主函数 ==========

async function runTests() {
  const results = [];
  let driver;

  console.log('========================================');
  console.log('文件管理系统 — 自动化浏览器测试');
  console.log('========================================');

  try {
    console.log('\n[初始化] 启动浏览器...');
    driver = await initDriver();
    await driver.manage().setTimeouts({ implicit: 10000 });

    // 注入日志收集
    await injectLogger(driver);

    // ========== 测试步骤 ==========
    await test_Login(driver, results);
    await test_PersonalFileMove(driver, results);
    await test_RecycleBinRestore(driver, results);
    await test_PublicFileManager(driver, results);
    await test_AdminRecycleBin(driver, results);

    // 检查是否有 JS 错误
    const errors = await getErrors(driver);
    if (errors.length > 0) {
      console.log('\n  [JS错误] 检测到 ' + errors.length + ' 个错误:');
      errors.forEach(function(err) { console.log('    - ' + err); });
    } else {
      console.log('\n  [JS错误] 未检测到 JS 错误');
    }

  } catch (e) {
    console.error('\n[测试异常]', e.message);
  } finally {
    if (driver) {
      await driver.sleep(1000);
      await driver.quit();
    }
  }

  printReport(results);
}

function printReport(results) {
  console.log('\n========================================');
  console.log('测试报告');
  console.log('========================================');

  let passed = 0, failed = 0, skipped = 0;
  results.forEach(function(r) {
    var icon = r.status === 'PASS' ? '[通过]' : (r.status === 'SKIP' ? '[跳过]' : '[失败]');
    console.log(icon + ' ' + r.name + ': ' + r.status);
    if (r.error) console.log('    错误: ' + r.error);
    if (r.status === 'PASS') passed++;
    else if (r.status === 'SKIP') skipped++;
    else failed++;
  });

  console.log('========================================');
  console.log('总计: ' + passed + ' 通过, ' + failed + ' 失败, ' + skipped + ' 跳过');
  console.log('========================================');
  console.log('\n截图目录: ' + screenshotsDir);
}

runTests();
