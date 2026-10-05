// 探针：profile_login → profile_reset 真实语义核查（响应载荷 vs 磁盘状态）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let buf = '', seq = 0;
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
child.stderr.on('data', () => {});
function call(name, args, timeoutMs) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + name)), timeoutMs || 60000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args || {} } }) + '\n');
  });
}
function parse(text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{' && s[i] !== '[') continue;
    try { return JSON.parse(s.slice(i).trim()); } catch { /* next */ }
  }
  return null;
}
const dirState = () => {
  const dir = path.join(ROOT, '.work', 'profile');
  if (!fs.existsSync(dir)) return { exists: false };
  let n = 0;
  try {
    const walk = (p) => { for (const f of fs.readdirSync(p)) { const fp = path.join(p, f); if (fs.statSync(fp).isDirectory()) walk(fp); else n++; } };
    walk(dir);
  } catch (e) { return { exists: true, err: String(e.message) }; }
  return { exists: true, files: n };
};
const profHome = 'http://127.0.0.1:1/probe-not-used'; // 用 404/不可达也行？不行——successText 需要页面。改用 data URL 不支持；这里临时起静态页

// 简易一次性成功页
import http from 'node:http';
const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>工作台</h1>'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + srv.address().port + '/';

console.log('登录前磁盘: ' + JSON.stringify(dirState()));
const login = await call('profile_login', { url, successText: '工作台', timeoutMs: 20000 }, 60000);
console.log('profile_login isError=' + !!login.result.isError + ' 载荷: ' + String(login.result.content[0].text).slice(0, 200).replace(/\n/g, ' '));
console.log('登录后磁盘: ' + JSON.stringify(dirState()));
const info1 = await call('profile_info', {});
console.log('登录后 info: ' + String(info1.result.content[0].text).replace(/\n/g, ' ').slice(0, 260));

const reset = await call('profile_reset', { confirm: true }, 60000);
console.log('profile_reset isError=' + !!reset.result.isError + ' 载荷: ' + String(reset.result.content[0].text).slice(0, 400).replace(/\n/g, ' '));
console.log('重置后磁盘: ' + JSON.stringify(dirState()));
const info2 = await call('profile_info', {});
const d2 = parse(String(info2.result.content[0].text));
console.log('重置后 info: enabled=' + (d2 && d2.enabled) + ' exists=' + (d2 && d2.exists) + ' bytes=' + (d2 && d2.bytes) + ' files=' + (d2 && d2.files));

child.stdin.end();
setTimeout(() => { try { child.kill(); } catch {} srv.close(); process.exit(0); }, 300);
