// web-rpa-mcp — Playwright 解析 / 浏览器候选探测 / 启动自愈与生命周期
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MCP_DIR, ROOT, DIRS, ensureDirs, readConfig, readJson, writeJson, logger, nowIso } from './core.mjs';
import { acquireLock, releaseLock, lockInfo } from './ops.mjs';

/** 持久化 profile 的全局锁名：同一时间只允许一个浏览器用它（Playwright 不允许同一 user-data-dir 开两次） */
export const PROFILE_LOCK = '__profile__';

const L = logger('browser');

let _pwCache = null;

/** 在同工作区 / DSh profile / 全局目录里找出已安装的 playwright */
function playwrightCandidates() {
  const out = [];
  const push = (base) => {
    if (!base) return;
    out.push(path.join(base, 'node_modules', 'playwright', 'index.js'));
    out.push(path.join(base, 'node_modules', 'playwright-core', 'index.js'));
  };
  push(MCP_DIR);
  push(ROOT);
  try {
    const parent = path.dirname(ROOT);
    for (const d of fs.readdirSync(parent, { withFileTypes: true })) {
      if (d.isDirectory()) push(path.join(parent, d.name));
    }
  } catch { /* ignore */ }
  const home = os.homedir();
  for (const base of [
    path.join(home, '.dsh', 'profiles'),
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(home, 'AppData', 'Local', 'pnpm'),
  ]) {
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory()) push(path.join(base, d.name));
      }
    } catch { /* ignore */ }
  }
  return [...new Set(out)];
}

export async function getPlaywright() {
  if (_pwCache) return _pwCache;
  const tried = [];
  for (const p of playwrightCandidates()) {
    if (!fs.existsSync(p)) continue;
    tried.push(p);
    try {
      const mod = await import(pathToFileURL(p).href);
      const m = mod && mod.chromium ? mod : (mod && mod.default ? mod.default : mod);
      if (m && m.chromium) {
        _pwCache = m;
        L.info('已加载 playwright', { from: p });
        return _pwCache;
      }
    } catch (e) {
      L.warn('加载 playwright 失败', { p, err: String(e && e.message ? e.message : e) });
    }
  }
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(name);
      const m = mod && mod.chromium ? mod : (mod && mod.default ? mod.default : mod);
      if (m && m.chromium) { _pwCache = m; L.info('已加载 ' + name); return _pwCache; }
    } catch { /* ignore */ }
  }
  const err = new Error(
    '未找到可用的 playwright。请在 mcp 目录执行 npm install，或复用同工作区已安装的 playwright。\n已尝试：\n' +
    (tried.length ? tried.join('\n') : '(无候选路径存在)')
  );
  err.code = 'PLAYWRIGHT_NOT_FOUND';
  throw err;
}

/* ---------------- 候选浏览器 ---------------- */

function systemBrowserPaths() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return {
    msedge: [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    ].filter(Boolean),
    chrome: [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean),
  };
}

function findBundledChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      if (!/^chromium/.test(d)) continue;
      for (const rel of [
        ['chrome-win64', 'chrome.exe'],
        ['chrome-win', 'chrome.exe'],
        ['chrome-linux', 'chrome'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ]) {
        const exe = path.join(r, d, ...rel);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

/**
 * 探测 Playwright 自带的 ffmpeg（录像转码依赖）。
 * 没有它 recordVideo 不会报错但产出不了 .webm——doctor 提前说出来，别等出事找不到录像。
 * @returns {{ffmpeg: boolean, path: string|null}}
 */
export function detectFfmpeg() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      if (!/^ffmpeg/i.test(d)) continue;
      for (const name of ['ffmpeg-win64.exe', 'ffmpeg-win-x64.exe', 'ffmpeg-win32.exe', 'ffmpeg-linux', 'ffmpeg-mac']) {
        const exe = path.join(r, d, name);
        if (fs.existsSync(exe)) return { ffmpeg: true, path: exe };
      }
      // 兜底：不同 Playwright 版本的可执行文件命名有差异，认目录里任意 ffmpeg* 文件
      let files = [];
      try { files = fs.readdirSync(path.join(r, d)); } catch { continue; }
      for (const f of files) {
        if (!/^ffmpeg.*(\.exe)?$/i.test(f)) continue;
        const exe = path.join(r, d, f);
        try { if (fs.statSync(exe).isFile()) return { ffmpeg: true, path: exe }; } catch { /* ignore */ }
      }
    }
  }
  return { ffmpeg: false, path: null };
}

export function planKey(plan) { return plan.kind + '|' + String(plan.detail || ''); }

/**
 * 返回按优先级排列的候选浏览器。
 * 新装的 Chromium 排在系统 Edge 之前，但"已知启动失败"的会被自动跳过（见 broken 缓存）。
 */
export function candidatePlans(cfg = readConfig()) {
  const b = cfg.browser || {};
  if (b.mode === 'custom' && b.executablePath) {
    return [{ kind: 'custom', launchOptions: { executablePath: b.executablePath }, detail: b.executablePath }];
  }
  if (b.channel) {
    return [{ kind: b.channel, launchOptions: { channel: b.channel }, detail: 'channel:' + b.channel }];
  }
  if (b.mode === 'chromium') {
    const exe = findBundledChromium();
    return exe
      ? [{ kind: 'chromium', launchOptions: { executablePath: exe }, detail: exe }]
      : [{ kind: 'chromium-missing', launchOptions: {}, detail: '未找到自带 Chromium' }];
  }
  if (b.mode && b.mode !== 'auto') {
    return [{ kind: b.mode, launchOptions: { channel: b.mode }, detail: 'channel:' + b.mode }];
  }
  const list = [];
  const exe = findBundledChromium();
  if (exe) list.push({ kind: 'chromium', launchOptions: { executablePath: exe }, detail: exe });
  for (const name of ['msedge', 'chrome']) {
    const found = systemBrowserPaths()[name].find((p) => fs.existsSync(p));
    if (found) list.push({ kind: name, launchOptions: { channel: name }, detail: found });
  }
  return list;
}

/* ---------------- "启动失败"缓存（自愈核心） ---------------- */

const BROKEN_TTL_MS = 7 * 24 * 3600 * 1000;
function brokenFile() { return path.join(DIRS.work, 'browser-broken.json'); }
function loadBroken() { return readJson(brokenFile(), {}) || {}; }

function markBroken(plan, error) {
  ensureDirs();
  const db = loadBroken();
  db[planKey(plan)] = { at: nowIso(), kind: plan.kind, detail: plan.detail, error: String(error).split('\n')[0].slice(0, 300) };
  writeJson(brokenFile(), db);
  L.warn('已把该浏览器标记为不可用，后续自动跳过', { kind: plan.kind, detail: plan.detail });
}

function clearBroken(plan) {
  const db = loadBroken();
  if (db[planKey(plan)]) { delete db[planKey(plan)]; writeJson(brokenFile(), db); }
}

function isBroken(plan) {
  const rec = loadBroken()[planKey(plan)];
  if (!rec) return false;
  const age = Date.now() - new Date(rec.at).getTime();
  return Number.isFinite(age) && age < BROKEN_TTL_MS;
}

export function brokenBrowsers() {
  const db = loadBroken();
  const out = [];
  for (const key of Object.keys(db)) {
    const age = Date.now() - new Date(db[key].at).getTime();
    if (Number.isFinite(age) && age < BROKEN_TTL_MS) out.push({ ...db[key], key });
  }
  return out;
}

/** 首选方案（供 doctor / 展示用） */
export function detectBrowserPlan(cfg = readConfig()) {
  const all = candidatePlans(cfg);
  if (!all.length) return { kind: 'none', launchOptions: {}, detail: '未发现任何可用浏览器（也未配置）' };
  const usable = all.find((p) => !isBroken(p));
  const chosen = usable || all[0];
  return { ...chosen, knownBroken: !usable, brokenList: all.filter(isBroken).map((p) => p.kind) };
}

/** 真实验证一次启动（doctor 用） */
export async function verifyBrowser({ headed = false } = {}) {
  const cfg = readConfig();
  const all = candidatePlans(cfg);
  const attempts = [];
  for (const plan of all) {
    if (plan.kind === 'chromium-missing') continue;
    try {
      const pw = await getPlaywright();
      const b = await pw.chromium.launch({ headless: !headed, ...plan.launchOptions, timeout: 40000 });
      await b.close();
      clearBroken(plan);
      attempts.push({ kind: plan.kind, ok: true });
      return { ok: true, plan, attempts };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split('\n')[0];
      markBroken(plan, msg);
      attempts.push({ kind: plan.kind, ok: false, error: msg });
    }
  }
  return { ok: false, attempts, error: '所有候选浏览器都启动失败' };
}

/* ---------------- 持久化登录态（profile） ---------------- */

const PROFILE_MARKER = () => path.join(DIRS.work, 'profile.json');

export function profilePath(cfg = readConfig()) {
  const d = cfg.browser && cfg.browser.profileDir;
  return d ? path.resolve(d) : path.join(DIRS.work, 'profile');
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (p, depth) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else {
        files++;
        try { bytes += fs.statSync(full).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return { bytes, files };
}

export function profileInfo(cfg = readConfig()) {
  const dir = profilePath(cfg);
  const enabled = !!(cfg.browser && cfg.browser.persistProfile);
  const exists = fs.existsSync(dir);
  const marker = readJson(PROFILE_MARKER(), {}) || {};
  const out = {
    enabled,
    dir,
    exists,
    bytes: 0,
    files: 0,
    lastUsedAt: marker.lastUsedAt || null,
    lastUrl: marker.lastUrl || null,
    lock: lockInfo(PROFILE_LOCK),
    hint: enabled
      ? (exists
        ? '已开启：所有执行共用这个用户目录，人工登录一次即可长期复用'
        : '已开启，但登录态目录还没有内容（先用 profile_login 人工登录一次才会保存登录态）')
      : '未开启：每次执行都是全新会话（需要登录的系统请用 profile_login 开启）',
  };
  if (exists) Object.assign(out, dirStats(dir));
  return out;
}

function touchProfile(dir, extra = {}) {
  try {
    ensureDirs();
    writeJson(PROFILE_MARKER(), Object.assign({ dir, lastUsedAt: nowIso() }, readJson(PROFILE_MARKER(), {}), extra));
  } catch { /* ignore */ }
}

export function resetProfile(cfg = readConfig()) {
  const dir = profilePath(cfg);
  if (!fs.existsSync(dir)) return { removed: false, dir, reason: '目录不存在' };
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.unlinkSync(PROFILE_MARKER()); } catch { /* ignore */ }
  L.warn('已清空浏览器 profile（登录态一并清除）', { dir });
  return { removed: true, dir };
}

const OPEN = new Set();

/**
 * 启动浏览器 + 上下文。候选按优先级依次尝试，失败的会被记入缓存并跳过。
 * headed=true 用于录制/人工接管；headless=true 用于定时回放。
 */
function attachDownloads(handle, downloadsDir) {
  handle.context.on('download', async (d) => {
    try {
      const target = path.join(downloadsDir, d.suggestedFilename());
      await d.saveAs(target);
      handle.downloads.push({ path: target, name: d.suggestedFilename() });
    } catch (e) { L.warn('下载保存失败', { err: String(e && e.message ? e.message : e) }); }
  });
}

export async function launchContext({ headed = false, viewport, slowMo, downloadsDir, extraContext = {}, persistent } = {}) {
  const cfg = readConfig();
  const pw = await getPlaywright();
  const all = candidatePlans(cfg);
  const real = all.filter((p) => p.kind !== 'chromium-missing');
  if (!real.length) {
    const e = new Error(
      '未找到可用浏览器。请任选其一：\n' +
      '  1) npx playwright install chromium\n' +
      '  2) 在 web-rpa.config.json 设置 browser.channel = "msedge"\n' +
      '  3) 设置 browser.mode="custom" 且 browser.executablePath="<浏览器 exe 路径>"'
    );
    e.code = 'BROWSER_NOT_FOUND';
    throw e;
  }

  // 先用未标记失败的；若全被标记失败，则再原样试一遭（可能环境已修好）
  const fresh = real.filter((p) => !isBroken(p));
  const order = fresh.length ? fresh : real;

  const vp = viewport || cfg.browser.viewport;
  const usePersistent = persistent === undefined ? !!(cfg.browser && cfg.browser.persistProfile) : !!persistent;

  // 录像（recordVideo）只在普通上下文支持；持久化 launchPersistentContext 不支持，需剥掉并说明
  let videoNote = '';
  const extra = { ...extraContext };
  if (usePersistent && extra.recordVideo) {
    delete extra.recordVideo;
    videoNote = '持久化 profile（launchPersistentContext）不支持录像，本次已跳过视频证据';
  }

  /* 持久化 profile 路径：人工登录一次，之后无人值守直接复用登录态 */
  if (usePersistent) {
    const dir = profilePath(cfg);
    const lock = acquireLock(PROFILE_LOCK, { trigger: 'browser', profileDir: dir });
    if (!lock.ok) {
      const e = new Error(
        '浏览器 profile 正被另一个执行占用（pid ' + lock.heldBy.pid + '，开始于 ' + lock.heldBy.at + '，触发方式 ' + (lock.heldBy.trigger || '未知') + '）。' +
        '同一个用户目录不能被两个浏览器同时打开，请等它结束，或用 lock_release 释放过期锁。'
      );
      e.code = 'PROFILE_BUSY';
      throw e;
    }
    fs.mkdirSync(dir, { recursive: true });
    const pAttempts = [];
    for (const cand of order) {
      try {
        const context = await pw.chromium.launchPersistentContext(dir, {
          headless: !headed,
          slowMo: slowMo === undefined ? (cfg.browser.slowMo || 0) : slowMo,
          timeout: 60000,
          viewport: vp && vp.width ? { width: vp.width, height: vp.height } : undefined,
          locale: cfg.browser.locale,
          timezoneId: cfg.browser.timezoneId,
          acceptDownloads: true,
          userAgent: cfg.browser.userAgent || undefined,
          ...cand.launchOptions,
          ...extra,
        });
        const handle = { browser: context.browser() || null, context, plan: cand, downloads: [], persistent: true, profileDir: dir, videoNote };
        if (downloadsDir) attachDownloads(handle, downloadsDir);
        OPEN.add(handle);
        clearBroken(cand);
        touchProfile(dir);
        L.info('已用持久化 profile 启动浏览器', { kind: cand.kind, headed, dir });
        return handle;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).split('\n')[0];
        pAttempts.push({ kind: cand.kind, error: msg });
        // 不 markBroken：持久化失败常是 profile 被占用/损坏之类的环境原因，
        // 记进 broken 缓存会连累普通（非持久化）回放 7 天选不到这个浏览器
        L.warn('持久化启动失败，尝试下一个候选', { kind: cand.kind, err: msg });
      }
    }
    releaseLock(PROFILE_LOCK);
    const err = new Error('持久化 profile 启动失败（已尝试 ' + pAttempts.length + ' 个候选）：\n' + pAttempts.map((a) => '  - ' + a.kind + ': ' + a.error).join('\n'));
    err.code = 'BROWSER_LAUNCH_FAILED';
    throw err;
  }

  const attempts = [];
  let browser = null;
  let plan = null;

  for (const cand of order) {
    try {
      browser = await pw.chromium.launch({
        headless: !headed,
        slowMo: slowMo === undefined ? (cfg.browser.slowMo || 0) : slowMo,
        timeout: 45000,
        ...cand.launchOptions,
      });
      plan = cand;
      clearBroken(cand);
      break;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split('\n')[0];
      attempts.push({ kind: cand.kind, error: msg });
      markBroken(cand, msg);
      L.warn('浏览器启动失败，尝试下一个候选', { kind: cand.kind, err: msg });
    }
  }

  if (!browser) {
    const err = new Error(
      '所有候选浏览器都启动失败：\n' +
      attempts.map((a) => '  - ' + a.kind + ': ' + a.error).join('\n') +
      '\n提示：先运行 doctor 查看环境；自带 Chromium 损坏时可执行 npx playwright install chromium 重新安装。'
    );
    err.code = 'BROWSER_LAUNCH_FAILED';
    err.attempts = attempts;
    throw err;
  }

  let context;
  const ctxOpts = {
    viewport: vp && vp.width ? { width: vp.width, height: vp.height } : undefined,
    locale: cfg.browser.locale,
    timezoneId: cfg.browser.timezoneId,
    acceptDownloads: true,
    userAgent: cfg.browser.userAgent || undefined,
    ...extra,
  };
  try {
    context = await browser.newContext(ctxOpts);
  } catch (e) {
    if (ctxOpts.recordVideo) {
      // 缺 ffmpeg 等录像依赖时降级为不录像：录像只是加分项，不能反过来把整个运行弄挂
      const msg = String(e && e.message ? e.message : e).split('\n')[0];
      videoNote = '录像不可用，已降级为不录像（' + msg + '）';
      L.warn('录像上下文创建失败，降级为不录像', { err: msg });
      delete ctxOpts.recordVideo;
      try {
        context = await browser.newContext(ctxOpts);
      } catch (e2) {
        try { await browser.close(); } catch { /* ignore */ }
        throw e2;
      }
    } else {
      // 上下文建不起来时浏览器已启动：必须关掉，否则每次失败都泄漏一个浏览器进程
      try { await browser.close(); } catch { /* ignore */ }
      throw e;
    }
  }
  const handle = { browser, context, plan, downloads: [], persistent: false, videoNote };
  if (downloadsDir) attachDownloads(handle, downloadsDir);
  OPEN.add(handle);
  L.info('浏览器已启动', { kind: plan.kind, headed, viewport: vp, attempts: attempts.length });
  return handle;
}

export async function closeContext(handle) {
  if (!handle) return;
  OPEN.delete(handle);
  try { if (handle.context) await handle.context.close(); } catch { /* ignore */ }
  try { if (handle.browser) await handle.browser.close(); } catch { /* ignore */ }
  if (handle.persistent) releaseLock(PROFILE_LOCK);
}

export async function closeAll() {
  for (const h of [...OPEN]) await closeContext(h);
}

export function openCount() { return OPEN.size; }
