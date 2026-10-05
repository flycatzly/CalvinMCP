// 复探针：验证 structuredContent 纯增量（content/isError 不变、structuredContent 与 text 内 JSON 一致、fail 不带它）
import { spawn } from 'node:child_process';

function rpc(child, id, method, params) {
  return new Promise((resolve) => {
    const buf = { s: '' };
    const onData = (chunk) => {
      buf.s += chunk.toString();
      let idx;
      while ((idx = buf.s.indexOf('\n')) >= 0) {
        const line = buf.s.slice(0, idx); buf.s = buf.s.slice(idx + 1);
        const t = line.trim(); if (!t) continue;
        let m; try { m = JSON.parse(t); } catch { continue; }
        if (m.id === id) { child.stdout.off('data', onData); resolve(m); }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const child = spawn(process.execPath, ['server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
await rpc(child, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });

// --- 成功路径：lock_status ---
const ok = await rpc(child, 2, 'tools/call', { name: 'lock_status', arguments: {} });
const r = ok.result;
console.log('=== 成功 tools/call lock_status ===');
console.log('result keys =', JSON.stringify(Object.keys(r)));
console.log('isError =', r.isError, '| content[0].type =', r.content[0].type);
console.log('has structuredContent =', 'structuredContent' in r);
// content 不变性：text 仍是 summary + JSON
console.log('content[0].text (first 120) =', JSON.stringify(r.content[0].text.slice(0, 120)));
// 一致性：structuredContent 必须等于 text 里抠出的 JSON（data 真值来源同一）
const textJson = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf('{')));
console.log('structuredContent == text 内 JSON ?', JSON.stringify(r.structuredContent) === JSON.stringify(textJson));
console.log('structuredContent =', JSON.stringify(r.structuredContent));

// --- 失败路径：flow_run 不存在的流程 → isError:true 形状（必须不带 structuredContent） ---
const bad = await rpc(child, 3, 'tools/call', { name: 'flow_run', arguments: { flowId: '__不存在__' } });
const e = bad.result;
console.log('\n=== 失败 tools/call flow_run(不存在) ===');
console.log('result keys =', JSON.stringify(Object.keys(e)));
console.log('isError =', e.isError);
console.log('has structuredContent =', 'structuredContent' in e, '（必须 false：isError:true 形状不变）');
console.log('content[0].type =', e.content[0].type, '| text (first 80) =', JSON.stringify(e.content[0].text.slice(0, 80)));

// --- tools/list 仍 3 字段（outputSchema 待确认、未加） ---
const list = await rpc(child, 4, 'tools/list', {});
const keySets = new Set(list.result.tools.map((t) => Object.keys(t).sort().join(',')));
console.log('\n=== tools/list 字段集 ===');
console.log('tool count =', list.result.tools.length, '| field-sets =', JSON.stringify([...keySets]), '（outputSchema 待确认未加）');

child.kill();
process.exit(0);
