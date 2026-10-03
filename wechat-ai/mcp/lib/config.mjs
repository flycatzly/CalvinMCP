// 配置：数据源 / 场景 / 转发目标 / 设置。零凭据落盘。
import fs from "node:fs";
import { ensureHome, paths } from "./paths.mjs";
import { readJson, writeJson } from "./util.mjs";

/** 默认场景（对应微信流「按聊天场景预设任务」） */
export const DEFAULT_SCENES = [
  {
    id: "customer",
    name: "客户群",
    match: ["客户", "需求群", "对接群", "商务"],
    priority: 80,
    task: "提炼客户需求、风险与下一步行动；标注承诺与截止时间；不要复述寒暄。",
    targets: ["codex", "obsidian"],
  },
  {
    id: "project",
    name: "项目群",
    match: ["项目", "交付", "初稿", "终稿", "排期"],
    priority: 70,
    task: "输出项目当前状态、阻塞点、负责人与时间节点；区分已确认与待核实。",
    targets: ["codex", "obsidian"],
  },
  {
    id: "deal",
    name: "商单群",
    match: ["商单", "投放", "合作", "报价", "brief"],
    priority: 90,
    task: "判断是否真实商单：找需求方、预算、排期、交付要求；区分品牌方/中间人/加热者。",
    targets: ["codex", "obsidian"],
  },
  {
    id: "knowledge",
    name: "知识/文章",
    match: ["公众号", "文章", "视频号", "课程"],
    priority: 40,
    task: "先摘要再决定是否深读；保留原链接与关键结论。",
    targets: ["obsidian"],
  },
  {
    id: "default",
    name: "通用",
    match: [],
    priority: 0,
    task: "总结要点、待办与需要我回复的内容。",
    targets: ["clipboard"],
  },
];

/** 默认转发目标（对应微信流的 Agent / Obsidian / 剪贴板 / 文件夹 / 自定义） */
export const DEFAULT_TARGETS = [
  { id: "codex", name: "Codex", kind: "agent", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "claude-code", name: "Claude Code", kind: "agent", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "deepseek-harness", name: "DeepSeek Harness", kind: "agent", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "workbuddy", name: "WorkBuddy", kind: "agent", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "doubao", name: "豆包", kind: "agent", app: "Doubao", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "qwen-work", name: "千问办公", kind: "agent", app: "QwenWork", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "wesight", name: "WeSight", kind: "agent", app: "WeSight", promptFile: "{{out}}/{{slug}}.prompt.md", enabled: true },
  { id: "obsidian", name: "Obsidian", kind: "obsidian", vault: "", folder: "微信流", enabled: false },
  { id: "clipboard", name: "剪贴板", kind: "clipboard", enabled: true },
  { id: "folder", name: "文件夹", kind: "folder", path: "", enabled: false },
  { id: "custom", name: "自定义应用", kind: "custom", command: "", enabled: false },
];

export function defaultConfig() {
  const p = paths();
  return {
    version: 1,
    owner: { aliases: [], handles: [] },
    vaults: [],
    readers: [],
    sqliteSources: [],
    scenes: DEFAULT_SCENES,
    targets: DEFAULT_TARGETS,
    settings: {
      defaultHours: 24,
      maxImmediateActions: 10,
      candidateStaleDays: 14,
      reactivationInactiveDays: 21,
      replyHistoryDays: 30,
      minimumChatMessages: 5,
      batchMaxItems: 100,
      outputDir: p.output,
      autoPurgeInboxDays: 30,
    },
    privacy: { redactOutputs: true, blockInsideRepo: true, maxReportLinkShare: 1 },
    createdAt: Date.now(),
  };
}

let _cfg = null;
let _cfgSig = null;

/** 配置文件签名（mtime+size）：reload 时文件没变就直接用缓存，免掉每请求一次同步读盘 */
function configSig(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

export function loadConfig({ reload = false } = {}) {
  if (_cfg && !reload) return _cfg;
  ensureHome();
  const p = paths();
  const sig = configSig(p.config);
  if (_cfg && reload && sig === _cfgSig) return _cfg;
  let cfg = readJson(p.config, null);
  if (!cfg || typeof cfg !== "object") {
    // 文件存在但读不出来 = 损坏：先备份再重建，绝不静默丢弃用户配置
    backupCorrupt(p.config, cfg === null);
    cfg = defaultConfig();
    writeJson(p.config, cfg);
  } else {
    const d = defaultConfig();
    cfg = {
      ...d,
      ...cfg,
      owner: { ...d.owner, ...(cfg.owner || {}) },
      settings: { ...d.settings, ...(cfg.settings || {}) },
      privacy: { ...d.privacy, ...(cfg.privacy || {}) },
      scenes: Array.isArray(cfg.scenes) && cfg.scenes.length ? cfg.scenes : d.scenes,
      targets: Array.isArray(cfg.targets) && cfg.targets.length ? cfg.targets : d.targets,
    };
  }
  _cfg = cfg;
  _cfgSig = configSig(p.config);
  return cfg;
}

/** 把损坏的配置文件改名备份，便于排查 */
export function backupCorrupt(file, hadContent) {
  try {
    if (!fs.existsSync(file)) return null;
    if (!hadContent) return null;
    const bak = `${file}.corrupt-${Date.now()}.bak`;
    fs.renameSync(file, bak);
    return bak;
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  const p = paths();
  writeJson(p.config, cfg);
  _cfg = cfg;
  return p.config;
}

export function updateConfig(patch) {
  const cfg = loadConfig();
  const next = {
    ...cfg,
    ...patch,
    owner: { ...cfg.owner, ...(patch.owner || {}) },
    settings: { ...cfg.settings, ...(patch.settings || {}) },
    privacy: { ...cfg.privacy, ...(patch.privacy || {}) },
  };
  return saveConfig(next);
}

export function configPath() {
  return paths().config;
}

export function configExists() {
  return fs.existsSync(paths().config);
}

export function sceneById(id) {
  return loadConfig().scenes.find((s) => s.id === id) || null;
}

export function targetById(id) {
  return loadConfig().targets.find((t) => t.id === id) || null;
}

/** 按群名/标题匹配场景：优先 priority 高者，其次 match 命中长度 */
export function matchScene(title, cfg = loadConfig()) {
  const t = String(title ?? "");
  let best = null;
  let bestScore = -1;
  for (const s of cfg.scenes ?? []) {
    if (s.enabled === false) continue;
    let score = 0;
    for (const kw of s.match ?? []) {
      if (kw && t.includes(kw)) score += 10 + String(kw).length;
    }
    if (score === 0 && (s.match ?? []).length === 0) score = 1; // 兜底场景
    if (score > 0) score += (s.priority ?? 0) / 100;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}
