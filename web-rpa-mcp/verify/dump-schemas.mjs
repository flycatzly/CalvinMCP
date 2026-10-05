// 探针：拉起 MCP server，dump 全部工具 schema 到 JSON 文件
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'mcp', 'server.mjs');
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
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
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
function call(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'schema-dump', version: '1.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tl = await call('tools/list', {});
const out = { serverInfo: init.result.serverInfo, protocolVersion: init.result.protocolVersion, tools: tl.result.tools };
fs.writeFileSync(path.join(__dirname, 'tools-schema.json'), JSON.stringify(out, null, 1));
console.log('tools=' + tl.result.tools.length + ' server=' + JSON.stringify(init.result.serverInfo));
child.stdin.end();
setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 300);
