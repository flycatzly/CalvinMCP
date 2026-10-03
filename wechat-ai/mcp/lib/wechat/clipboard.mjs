// 系统剪贴板读写（Windows / macOS / Linux），零依赖。
// 安全约定：
//   1. 待写入的文本一律通过子进程 stdin 传递，绝不拼进命令行字符串；
//   2. 命令名与参数全部是本文件写死的常量，用户数据只走 stdin / 环境变量 / 临时文件；
//   3. 所有函数都不抛异常，失败返回 {ok:false, error}。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "../util.mjs";

/** 默认超时（毫秒）：剪贴板命令是本地短命令，超时即视为失败 */
const TIMEOUT_MS = 8000;

/** Windows 读取剪贴板时用于中转文本的临时文件路径（经环境变量传给 PowerShell） */
const WIN_TMP_ENV = "WECHAT_AI_CLIP_TMP";

/** 各平台的剪贴板命令；Windows 写入用 clip.exe、读取用 PowerShell Get-Clipboard。 */
export function clipboardPlan(platform = process.platform) {
  if (platform === "win32") {
    return {
      platform,
      write: { cmd: "clip.exe", args: [] },
      read: { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"] },
      writeFallback: {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $t = Get-Content -LiteralPath $env:" + WIN_TMP_ENV + " -Raw -Encoding UTF8; Set-Clipboard -Value $t",
        ],
      },
      readToFile: {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; Get-Clipboard -Raw | Set-Content -LiteralPath $env:" + WIN_TMP_ENV + " -Encoding UTF8",
        ],
      },
    };
  }
  if (platform === "darwin") {
    return {
      platform,
      write: { cmd: "pbcopy", args: [] },
      read: { cmd: "pbpaste", args: [] },
      writeFallback: null,
      readToFile: null,
    };
  }
  return {
    platform,
    write: { cmd: "xclip", args: ["-selection", "clipboard"] },
    read: { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
    writeFallback: null,
    readToFile: null,
  };
}

/** 当前平台是否具备可用的剪贴板通道（只做命令存在性判断，不实际调用） */
export function clipboardSupport() {
  const plan = clipboardPlan();
  const probe = (cmd) => {
    if (process.platform !== "win32") {
      // POSIX 下用 which/where 的等价实现：遍历 PATH 找可执行文件
      const dirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
      return dirs.some((d) => {
        try { return fs.existsSync(path.join(d, cmd)); } catch { return false; }
      });
    }
    const r = spawnSync("where.exe", [cmd], { windowsHide: true, encoding: "utf8", timeout: TIMEOUT_MS });
    return r.status === 0;
  };
  return {
    platform: plan.platform,
    writeCmd: plan.write.cmd,
    readCmd: plan.read.cmd,
    writeAvailable: probe(plan.write.cmd),
    readAvailable: probe(plan.read.cmd),
  };
}

function tmpFile(tag) {
  const dir = path.join(os.tmpdir(), "wechat-ai-clip");
  ensureDir(dir);
  return path.join(dir, tag + "-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".txt");
}

function readTmp(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(file); } catch { /* 忽略清理失败 */ }
  }
}

/** 同步执行一条命令；输入走 stdin，返回结构化结果，不抛异常。 */
function runSync(spec, { input = null, env = null, timeout = TIMEOUT_MS } = {}) {
  try {
    const r = spawnSync(spec.cmd, spec.args, {
      input: input === null ? undefined : input,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    if (r.error) return { ok: false, error: String(r.error.message ?? r.error) };
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: (r.stderr ?? "").trim(),
      error: r.status === 0 ? null : "命令退出码 " + r.status + (r.stderr ? "：" + String(r.stderr).trim().slice(0, 300) : ""),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 异步执行一条命令，同样只把文本放进 stdin。 */
function runAsync(spec, { input = null, env = null, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      finish({ ok: false, error: String(e?.message ?? e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      finish({ ok: false, error: "剪贴板命令超时（" + timeout + "ms）" });
    }, timeout);
    child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: String(e?.message ?? e) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        status: code,
        stdout,
        stderr: stderr.trim(),
        error: code === 0 ? null : "命令退出码 " + code + (stderr.trim() ? "：" + stderr.trim().slice(0, 300) : ""),
      });
    });
    try {
      if (input !== null) child.stdin.end(input, "utf8");
      else child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e?.message ?? e) });
    }
  });
}

/** 归一化比较用文本：去掉 BOM、统一换行、去掉尾部空行 */
function normalizeForCompare(text) {
  return String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/** Windows：用 PowerShell 把剪贴板内容写到 UTF-8 临时文件后读回，避免控制台代码页影响中文。 */
function readWindowsViaFile(plan) {
  const file = tmpFile("read");
  try {
    const r = runSync(plan.readToFile, { env: { [WIN_TMP_ENV]: file } });
    if (!r.ok) return { ok: false, error: r.error ?? "读取剪贴板失败" };
    const text = readTmp(file);
    if (text === null) return { ok: false, error: "读取剪贴板失败：临时文件不可读" };
    return { ok: true, text, via: "powershell-file" };
  } catch (e) {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Windows：用 PowerShell 从 UTF-8 临时文件写剪贴板（clip.exe 编码不可靠时的回退）。 */
function writeWindowsViaFile(plan, text) {
  const file = tmpFile("write");
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, String(text), "utf8");
    const r = runSync(plan.writeFallback, { env: { [WIN_TMP_ENV]: file } });
    if (!r.ok) return { ok: false, error: r.error ?? "PowerShell 写入剪贴板失败" };
    return { ok: true, via: "powershell" };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

/** 写入系统剪贴板。成功返回 {ok:true, bytes, via, verified}，失败返回 {ok:false, error}。 */
export function setClipboardText(text) {
  const value = String(text ?? "");
  try {
    const plan = clipboardPlan();
    const first = runSync(plan.write, { input: value });
    let via = plan.write.cmd;
    let warning = null;

    if (!first.ok && plan.writeFallback) {
      const fb = writeWindowsViaFile(plan, value);
      if (!fb.ok) return { ok: false, error: first.error ?? fb.error ?? "写入剪贴板失败" };
      via = fb.via;
      warning = "clip.exe 写入失败，已改用 PowerShell：" + (first.error ?? "");
    } else if (!first.ok) {
      return { ok: false, error: first.error ?? "写入剪贴板失败" };
    }

    // 校验：只在能读回内容时判定。读不回不算失败，只标注未能校验。
    let verified = null;
    const back = getClipboardText();
    if (back.ok) {
      verified = normalizeForCompare(back.text) === normalizeForCompare(value);
      if (!verified && plan.writeFallback) {
        const fb = writeWindowsViaFile(plan, value);
        if (fb.ok) {
          via = fb.via;
          const again = getClipboardText();
          verified = again.ok ? normalizeForCompare(again.text) === normalizeForCompare(value) : null;
          warning = "clip.exe 写入与原文不一致（控制台代码页转换所致），已改为 PowerShell 按 UTF-8 重写。";
        }
      }
    }
    return { ok: true, bytes: Buffer.byteLength(value, "utf8"), via, verified, warning };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 读取系统剪贴板文本。成功返回 {ok:true, text}，失败返回 {ok:false, error}。 */
export function getClipboardText() {
  try {
    const plan = clipboardPlan();
    if (plan.readToFile) {
      const viaFile = readWindowsViaFile(plan);
      if (viaFile.ok) return viaFile;
    }
    const r = runSync(plan.read, {});
    if (!r.ok) return { ok: false, error: r.error ?? "读取剪贴板失败" };
    return { ok: true, text: String(r.stdout ?? "").replace(/^\uFEFF/, ""), via: plan.read.cmd };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** setClipboardText 的异步版本：同样通过 stdin 传入文本，适合不阻塞事件循环的调用方。 */
export async function setClipboardTextAsync(text) {
  const value = String(text ?? "");
  try {
    const plan = clipboardPlan();
    const r = await runAsync(plan.write, { input: value });
    if (r.ok) return { ok: true, bytes: Buffer.byteLength(value, "utf8"), via: plan.write.cmd };
    if (plan.writeFallback) {
      const fb = writeWindowsViaFile(plan, value);
      if (fb.ok) return { ok: true, bytes: Buffer.byteLength(value, "utf8"), via: fb.via, warning: r.error };
    }
    return { ok: false, error: r.error ?? "写入剪贴板失败" };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** getClipboardText 的异步版本。 */
export async function getClipboardTextAsync() {
  try {
    const plan = clipboardPlan();
    if (plan.readToFile) {
      const viaFile = readWindowsViaFile(plan);
      if (viaFile.ok) return viaFile;
    }
    const r = await runAsync(plan.read, {});
    if (!r.ok) return { ok: false, error: r.error ?? "读取剪贴板失败" };
    return { ok: true, text: String(r.stdout ?? "").replace(/^\uFEFF/, ""), via: plan.read.cmd };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
