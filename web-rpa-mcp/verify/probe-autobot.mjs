// 探针：验证 autobot 站点的自动演示链（合成 DOM 事件）真实走通
import { createRequire } from 'node:module';
import { startAutobotServer } from './autobot-site.mjs';

const require2 = createRequire(import.meta.url);
const { chromium } = require2('D:/work/MCP/web-rpa-mcp/mcp/node_modules/playwright');

const autobot = await startAutobotServer();
console.log('autobot: ' + autobot.url);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const events = [];
let download = null;
page.on('download', (d) => { download = d.suggestedFilename(); });
page.on('framenavigated', (f) => { if (f === page.mainFrame()) events.push('nav->' + f.url()); });

await page.goto(autobot.url + '/?auto=1');
await page.waitForTimeout(6000);
console.log('最终 URL: ' + page.url());
console.log('导航轨迹: ' + events.join(' | '));
console.log('下载: ' + download);
const tableRows = await page.locator('#orders tbody tr').count().catch(() => -1);
console.log('表格行数: ' + tableRows);
await browser.close();
autobot.server.close();

const urlOk = page.url().includes('/report?date=');
const dlOk = !!download && /^orders-\d{4}-\d{2}-\d{2}\.csv$/.test(download);
console.log(urlOk && dlOk && tableRows === 3 ? 'PROBE-PASS' : 'PROBE-FAIL');
process.exit(urlOk && dlOk && tableRows === 3 ? 0 : 1);
