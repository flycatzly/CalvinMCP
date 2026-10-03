/**
 * cli-e2e.mjs — CLI 落盘模式的真实交互验证
 *
 * 之前只验到「能开页面、能拿快照、能截图」（最小闭环）。本测试继续往下走，
 * 验证真实交互循环与落盘约束：
 *   1) open 一个自造页面 → snapshot 能拿到 Ref 编号（e1/e2…）
 *   2) 用 Ref 做 fill / click（真实交互，不是空转）
 *   3) 交互后重新 snapshot，能观察到页面状态真的变了（证明操作生效）
 *   4) 每次 snapshot/screenshot 的产物都落盘，返回值**不含**全文
 *   5) --headed 只影响调试，不影响落盘行为
 *
 * 为什么用自造页面（data: URL）：不依赖任何外部服务，离线可复现 ——
 * 这套检查要能随 Skill 一起分发，别人拉下来就能验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, ensureArtifactDirs, ARTIFACT_DIRS } from '../lib/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

const SESSION = `e2e-${Date.now().toString(36)}`;
const dirs = ensureArtifactDirs(ROOT);

// 自造一个可交互页面：一个输入框 + 一个按钮，点按钮后写入一段文本。
// Ref 编号与按钮文案都用 ASCII，避免不同环境的编码差异影响断言。
const PAGE = 'data:text/html,' + encodeURIComponent(`<!doctype html><html lang="en"><body>
<h1>CLI E2E</h1>
<label for="q">Keyword</label><input id="q" aria-label="Keyword">
<button id="go" onclick="document.getElementById('out').textContent='RESULT-OK'">Search</button>
<p id="out">EMPTY</p>
</body></html>`);

log(`会话：${SESSION}\n`);

/* ---- 1) open ---- */
const open = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'open', args: [PAGE] });
check('open 成功', open.ok, open.summary);
if (!open.ok) {
  log('\nopen 失败，后续检查无法进行。');
  log(`stderr: ${open.stderrTail}`);
  process.exit(1);
}

/* ---- 2) snapshot 落盘 + 拿到 Ref ---- */
const snap1 = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'snapshot', args: [] });
check('snapshot 成功', snap1.ok, snap1.summary);
const snapFile = snap1.artifacts?.snapshot;
check('snapshot 落盘到 snapshots 目录', !!snapFile && snapFile.startsWith(dirs.snapshots), snapFile || '(无)');
check('snapshot 文件真实存在且非空', !!snapFile && fs.existsSync(snapFile) && fs.statSync(snapFile).size > 0,
  snapFile ? `${fs.statSync(snapFile).size} bytes` : '(无)');
const snapText = snapFile && fs.existsSync(snapFile) ? fs.readFileSync(snapFile, 'utf8') : '';
check('快照里有 Ref 编号（e1/e2…）', /\[ref=e\d+\]/.test(snapText),
  (snapText.match(/\[ref=e\d+\]/g) || []).slice(0, 5).join(' '));
check('返回值只给摘要，不回快照全文', !snap1.summary.includes('<h1>') && snap1.summary.length < 300,
  snap1.summary.slice(0, 120));

// 从快照里找输入框与按钮的 ref，用于真实交互
const refOf = (label) => {
  const line = snapText.split('\n').find((l) => l.includes(label));
  const m = line && /\[ref=(e\d+)\]/.exec(line);
  return m ? m[1] : null;
};
const inputRef = refOf('textbox') || refOf('Keyword');
const buttonRef = refOf('button');
const outRef = refOf('paragraph') || refOf('EMPTY');
check('能从快照解析出输入框 ref', !!inputRef, inputRef || '(未找到)');
check('能从快照解析出按钮 ref', !!buttonRef, buttonRef || '(未找到)');

/* ---- 3) 真实交互：fill + click ---- */
if (inputRef) {
  const fill = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'fill', args: [inputRef, 'hello-cli'] });
  check('fill 用 Ref 成功', fill.ok, fill.summary);
}
if (buttonRef) {
  const click = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'click', args: [buttonRef] });
  check('click 用 Ref 成功', click.ok, click.summary);
}

/* ---- 4) 重新快照，确认操作真的生效 ---- */
const snap2 = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'snapshot', args: [] });
check('交互后 snapshot 成功', snap2.ok, snap2.summary);
const snap2File = snap2.artifacts?.snapshot;
check('第二次快照落到**新**文件（按序号递增）', !!snap2File && snap2File !== snapFile,
  `${path.basename(snapFile || '')} → ${path.basename(snap2File || '')}`);
const snap2Text = snap2File && fs.existsSync(snap2File) ? fs.readFileSync(snap2File, 'utf8') : '';
check('页面状态真的变了（点击生效：EMPTY → RESULT-OK）',
  /RESULT-OK/.test(snap2Text) && !/\bEMPTY\b/.test(snap2Text.replace(/RESULT-OK[\s\S]*/g, '')),
  snap2Text.split('\n').filter((l) => /RESULT|EMPTY/.test(l)).join(' | ').slice(0, 160));
check('输入值真的写进去了（快照里出现 hello-cli）', /hello-cli/.test(snap2Text),
  snap2Text.split('\n').filter((l) => /hello-cli|textbox/.test(l))[0]?.slice(0, 140) || '(未找到)');

/* ---- 5) screenshot 落盘 ---- */
const shot = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'screenshot', args: [] });
check('screenshot 成功', shot.ok, shot.summary);
const shotFile = shot.artifacts?.file;
check('截图落盘到 screenshots 且是合法 PNG',
  !!shotFile && shotFile.startsWith(dirs.screenshots) && fs.existsSync(shotFile)
  && fs.readFileSync(shotFile).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  shotFile ? `${fs.statSync(shotFile).size} bytes（PNG 魔数校验通过）` : '(无)');

/* ---- 6) find（在快照里搜索，避免整棵读进上下文） ---- */
const found = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'find', args: ['RESULT'] });
check('find 能在页面里搜到文本', found.ok, found.summary.slice(0, 110));

/* ---- 7) generate-locator（把探索结果变成可用定位器） ---- */
if (buttonRef) {
  const loc = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'generate-locator', args: [buttonRef] });
  check('generate-locator 产出定位器', loc.ok, (loc.stdoutTail || '').split('\n').slice(0, 2).join(' ').slice(0, 140));
}

/* ---- 8) 白名单与拒绝 ---- */
const denied = await runCli({ cwd: ROOT, session: SESSION, subcommand: 'run-code', args: ['1+1'] });
check('run-code 不在白名单内（拒绝任意代码透传）', denied.ok === false && denied.reason === 'SUBCOMMAND_NOT_ALLOWED',
  denied.reason);

/* ---- 9) headed 只影响调试，不影响落盘 ---- */
const headedSnap = await runCli({
  cwd: ROOT, session: `${SESSION}-h`, subcommand: 'open', args: [PAGE], headed: true,
});
check('headed 模式可启动', headedSnap.ok, headedSnap.summary);
if (headedSnap.ok) {
  const hs = await runCli({ cwd: ROOT, session: `${SESSION}-h`, subcommand: 'snapshot', args: [] });
  check('headed 下快照照样落盘', hs.ok && !!hs.artifacts?.snapshot && fs.existsSync(hs.artifacts.snapshot));
  await runCli({ cwd: ROOT, session: `${SESSION}-h`, subcommand: 'close', args: [] });
}

/* ---- 清理 ---- */
await runCli({ cwd: ROOT, session: SESSION, subcommand: 'close', args: [] });

log('');
log(`产物目录：${dirs.snapshots}`);
log(`          ${dirs.screenshots}`);
log(failures === 0 ? 'CLI 真实交互与落盘验证全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
