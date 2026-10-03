// web-rpa-mcp — 生成一个开箱即跑的示例流程（对着本地演示站点真实录制一遍）
// 用法: node demo/seed-demo-flow.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from './app.mjs';
import { startRecording, stopRecording, activeSession } from '../mcp/lib/recorder.mjs';
import { loadFlow, saveFlow, deleteFlow, listFlows, stepLabel } from '../mcp/lib/store.mjs';
import { runFlow } from '../mcp/lib/player.mjs';
import { lintFlow } from '../mcp/lib/lint.mjs';
import { formatDate } from '../mcp/lib/core.mjs';
import { closeAll } from '../mcp/lib/browser.mjs';

const PORT = 4319;
const FLOW_NAME = '演示-订单日报导出';

async function main() {
  const today = formatDate(new Date(), 'YYYY-MM-DD');
  let demo;
  try {
    demo = await startDemoServer(PORT);
  } catch (e) {
    console.error('端口 ' + PORT + ' 被占用，无法生成示例（示例流程里写死了该端口）。');
    process.exit(1);
  }
  console.log('演示站点: ' + demo.url);

  console.log('\n[1/4] 对着演示站点真实录制一遍...');
  const rec = await startRecording({ url: demo.url + '/', name: FLOW_NAME });
  if (!rec.ok) { console.error('录制失败: ' + JSON.stringify(rec)); process.exit(1); }
  const page = activeSession().page;
  await page.waitForSelector('[data-testid="empNo"]');
  await page.fill('[data-testid="empNo"]', '1001');
  await page.waitForTimeout(400);
  await page.fill('#pwd', 'demo-pass');
  await page.waitForTimeout(400);
  await page.click('[data-testid="loginBtn"]');
  await page.waitForURL('**/report', { timeout: 15000 });
  await page.fill('[data-testid="reportDate"]', today);
  await page.waitForTimeout(400);
  await page.click('[data-testid="queryBtn"]');
  await page.waitForSelector('[data-testid="queryDone"]', { timeout: 15000 });
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('[data-testid="exportBtn"]')]);
  await dl.saveAs(path.join(demo.url ? process.env.TEMP || '.' : '.', 'seed-export.csv'));
  await new Promise((r) => setTimeout(r, 1200));

  console.log('[2/4] 生成流程...');
  // 幂等：先清掉同名旧流程与其运行记录，避免重复生成堆积带后缀的副本
  for (const old of listFlows()) {
    if (old.name === FLOW_NAME) {
      deleteFlow(old.id);
      try { fs.rmSync(path.join('runs', old.id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      console.log('    已清理同名旧流程: ' + old.id);
    }
  }
  const stop = await stopRecording({ name: FLOW_NAME });
  if (!stop.ok) { console.error('生成失败: ' + JSON.stringify(stop)); process.exit(1); }

  console.log('[3/4] 把演示密码改成参数并复核...');
  const flow = loadFlow(stop.flowId);
  const pwd = flow.steps.find((s) => s.op === 'fill' && s.sensitiveReason === 'password');
  if (pwd) pwd.value = '${DEMO_PWD}';
  flow.params = [{ name: 'DEMO_PWD', label: '演示密码', default: 'demo-pass' }];
  flow.name = FLOW_NAME;
  flow.note = '示例流程：需要先启动演示站点 node demo/app.mjs ' + PORT;
  saveFlow(flow);

  const lint = lintFlow(loadFlow(flow.id), {});
  console.log('    步骤清单:');
  loadFlow(flow.id).steps.forEach((s, i) => console.log('      ' + stepLabel(s, i)));
  console.log('    常量: ' + JSON.stringify(loadFlow(flow.id).assertions));
  console.log('    lint: errors=' + lint.errors.length + ' warnings=' + lint.warnings.length);
  lint.errors.forEach((e) => console.log('      ERROR [' + e.code + '] ' + e.message));
  lint.warnings.forEach((e) => console.log('      warn  [' + e.code + '] ' + e.message));

  console.log('[4/4] 立刻回放验证...');
  const rep = await runFlow(loadFlow(flow.id), { params: {}, headed: false, trigger: 'seed' });
  console.log('    状态=' + rep.status + ' 耗时=' + rep.durationMs + 'ms');
  (rep.assertions || []).forEach((a) => console.log('    ' + (a.pass ? 'PASS' : 'FAIL') + ' [' + a.kind + '] ' + a.detail));
  if (rep.error) console.log('    错误: ' + rep.error);

  demo.server.close();
  await closeAll();

  if (rep.status !== 'pass') { console.error('\n示例流程回放未通过，请检查。'); process.exit(1); }
  console.log('\n示例流程已就绪: flows/' + flow.id + '.json');
  console.log('再次运行:');
  console.log('  node demo/app.mjs ' + PORT + '                    # 另开一个窗口启动演示站点');
  console.log('  node mcp/runner.mjs run "' + flow.id + '"');
}

main().catch(async (e) => {
  console.error('生成示例失败: ' + String(e && e.stack ? e.stack : e));
  try { await closeAll(); } catch { /* ignore */ }
  process.exit(1);
});
