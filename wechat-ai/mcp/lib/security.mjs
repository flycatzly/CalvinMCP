// 隐私门禁：仓库敏感标记扫描 / 输出落盘位置校验 / 报告脱敏 / 用户清单
// 默认扫描模式对应上游 scripts/validate.sh 的私有标记检查。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PKG_ROOT } from "./paths.mjs";
import { redact, truncate } from "./util.mjs";

// 报告层的 HTML 安全工具统一从 report/security.mjs 复用（同一套白名单/URL 校验），
// 这里只做转发，避免出现两份会漂移的实现；本模块自身负责隐私扫描与输出落盘门禁。
export { escapeHtml, safeHref, sanitizeFragment, protectDocument, mdToHtmlLite } from "./report/security.mjs";

/** 默认敏感模式（字符串形式，便于调用方覆盖） */
export const DEFAULT_PRIVACY_PATTERNS = [
  { id: "wxid", pattern: "wxid_[A-Za-z0-9_-]{8,}", note: "微信 ID" },
  { id: "chatroom", pattern: "[A-Za-z0-9_-]{8,}@chatroom", note: "群聊 ID" },
  { id: "private_key", pattern: "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY", note: "私钥" },
  { id: "credential", pattern: "(api[_-]?key|access[_-]?token|client[_-]?secret|password)\\s*[:=]\\s*['\"]?\\S{8,}", note: "凭据/口令" },
];

const TEXT_EXT = new Set([".md", ".txt", ".json", ".jsonl", ".ndjson", ".csv", ".mjs", ".js", ".cjs", ".ts", ".yml", ".yaml", ".sh", ".ps1", ".py", ".html", ".htm", ".css", ".log", ".toml", ".ini", ".conf", ".env"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", "__pycache__", ".cache"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 默认排除：测试与夹具目录/文件。
 * 隐私门禁面向的是**发布产物**；测试夹具里出现 wxid_/…@chatroom 这类合成标识是正常且必要的，
 * 上游同样是在发布白名单里排除 tests、并在扫描前替换合成标记。需要连测试一起扫时传 includeTests: true。
 */
const DEFAULT_EXCLUDES = ["/tests/", "/test/", "__tests__", ".test.mjs", ".test.js", ".test.cjs", ".spec.mjs", ".spec.js", ".spec.cjs"];

function isExcluded(relPath, excludes) {
  const p = "/" + String(relPath).split(path.sep).join("/");
  return excludes.some((needle) => p.includes(needle));
}

/** 报告脱敏：先去密钥/token，再抹掉本机路径与微信标识 */
export function redactForReport(text) {
  let out = redact(String(text == null ? "" : text));
  const home = os.homedir();
  if (home) out = out.split(home).join("~");
  out = out.split(home.replace(/\\/g, "/")).join("~");
  out = out.replace(/wxid_[A-Za-z0-9_-]+/g, "<wechat-id>");
  out = out.replace(/\S+@chatroom/g, "<chatroom-id>");
  return out.replace(/\r?\n/g, " ");
}

function excerptOf(line) {
  return truncate(redactForReport(String(line).trim()), 160);
}

/**
 * 扫描目录/文件里的敏感标记。
 * @returns {{ok:boolean, findings:Array<{file:string,line:number,pattern:string,excerpt:string}>, scanned:{files:number,skipped:number,bytes:number}}}
 */
export function scanPrivacy({ root, patterns, exclude, includeTests = false } = {}) {
  const target = path.resolve(String(root || PKG_ROOT));
  const excludes = Array.isArray(exclude) && exclude.length
    ? exclude
    : includeTests
      ? []
      : DEFAULT_EXCLUDES;
  const specs = (patterns && patterns.length ? patterns : DEFAULT_PRIVACY_PATTERNS).map((p) =>
    typeof p === "string" ? { id: p, pattern: p, note: "" } : { id: p.id || p.pattern, pattern: p.pattern || p.id, note: p.note || "" },
  );
  const compiled = specs.map((s) => ({ ...s, re: new RegExp(s.pattern, "i") }));
  const findings = [];
  const scanned = { files: 0, skipped: 0, excluded: 0, bytes: 0 };

  const scanFile = (file) => {
    if (excludes.length && isExcluded(path.relative(target, file), excludes)) {
      scanned.excluded += 1;
      return;
    }
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      scanned.skipped += 1;
      return;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      scanned.skipped += 1;
      return;
    }
    const ext = path.extname(file).toLowerCase();
    if (ext && !TEXT_EXT.has(ext)) {
      scanned.skipped += 1;
      return;
    }
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      scanned.skipped += 1;
      return;
    }
    if (text.includes("\u0000")) {
      scanned.skipped += 1;
      return;
    }
    scanned.files += 1;
    scanned.bytes += stat.size;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const spec of compiled) {
        if (!spec.re.test(line)) continue;
        findings.push({ file, line: index + 1, pattern: spec.id, excerpt: excerptOf(line) });
      }
    });
  };

  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      scanned.skipped += 1;
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".git")) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        scanFile(full);
      }
    }
  };

  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat) {
    return { ok: false, findings: [], scanned, error: "路径不存在：" + target };
  }
  if (stat.isFile()) scanFile(target);
  else walk(target, 0);

  return { ok: findings.length === 0, findings, scanned, root: target, patterns: specs.map((s) => s.id) };
}

/** 报告不得落在仓库/包目录内 */
export function assertOutputOutsideRepo(outDir, { repoRoot } = {}) {
  const root = path.resolve(String(repoRoot || PKG_ROOT));
  const out = path.resolve(String(outDir || ""));
  const inside = out === root || out.startsWith(root + path.sep);
  if (inside) {
    throw new Error("报告输出目录不能位于仓库/包目录内：" + out + "（仓库根目录 " + root + "）。请改到 ~/.wechat-ai/output 之类的数据目录。");
  }
  return { ok: true, outDir: out, repoRoot: root };
}

/** 给用户看的中文隐私清单 */
export function privacyChecklist() {
  return [
    "所有微信数据只留本机：索引库在 ~/.wechat-ai/store.db，报告在 ~/.wechat-ai/output/，不上传任何云端。",
    "本项目只读取用户提供的已解密副本或导出目录；不获取密钥、不解密、不注入、不 Hook、不操作微信客户端。",
    "绝不发送/回复/转发微信消息：回复只生成本地草稿，必须由本人确认后自行发送。",
    "报告里不出现真实凭据：wxid、群 ID、私钥、token/口令一律脱敏成 <wechat-id> / <chatroom-id> / <REDACTED>。",
    "报告不得写进 git 仓库或包目录：落盘前用 assertOutputOutsideRepo 校验，避免误提交。",
    "提交代码或打包前运行 scanPrivacy 扫描敏感标记，命中即失败；不要把真实聊天记录做成测试数据。",
    "风格学习只保存聚合指标（长度、分段、标点）与本人样本统计，不把私聊原文复制到技能、报告或外部系统。",
    "分享问题截图或日志前先跑 redactForReport，删掉本机路径、联系人与聊天原文。",
  ];
}
