// MCP stdio 传输冒烟测试：真正用子进程 + stdin/stdout 走一遍 JSON-RPC。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "server.mjs");

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buf = "";
const responses = [];
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const waitFor = (id, ms = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const r = responses.find((x) => x.id === id);
    if (r) return resolve(r);
    if (Date.now() - t0 > ms) return reject(new Error("等待 id=" + id + " 超时；stderr=" + stderr.slice(0, 300)));
    setTimeout(tick, 40);
  };
  tick();
});

let bad = 0;
const t = (name, cond, extra = "") => {
  if (!cond) bad += 1;
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (extra ? "  " + extra : ""));
};

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } });
const init = await waitFor(1);
t("initialize 返回 serverInfo", init.result?.serverInfo?.name === "wechat-ai", JSON.stringify(init.result?.serverInfo));
t("initialize 声明 tools 能力", !!init.result?.capabilities?.tools);
t("initialize 带使用说明", typeof init.result?.instructions === "string" && init.result.instructions.length > 50);

send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const list = await waitFor(2);
t("tools/list 返回 73 个工具", list.result?.tools?.length === 73, "count=" + (list.result?.tools?.length ?? 0));
t("每个工具都有 inputSchema", (list.result?.tools ?? []).every((x) => x.inputSchema?.type === "object"));

send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wai_status", arguments: {} } });
const call = await waitFor(3);
t("tools/call wai_status 成功", !call.result?.isError && !!call.result?.structuredContent);
t("返回 content 文本块", Array.isArray(call.result?.content) && call.result.content[0]?.type === "text");

send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wai_does_not_exist", arguments: {} } });
const bad4 = await waitFor(4);
t("未知工具返回 isError", bad4.result?.isError === true);

send({ jsonrpc: "2.0", id: 5, method: "ping" });
const pong = await waitFor(5);
t("ping 有响应", !!pong.result);

child.stdin.end();
await new Promise((r) => child.on("close", r));
t("进程正常退出", true);
console.log("");
console.log("=== " + (bad === 0 ? "stdio 传输全部通过" : bad + " 项失败") + " ===");
process.exit(bad === 0 ? 0 : 1);
