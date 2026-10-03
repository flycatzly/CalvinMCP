/**
 * orchestrate.js — 编排层：Excel 手工用例 → playwright-cli 执行 → 结构化结果
 *
 * 对应原文最后提到的「同一套路还能往上编」：
 *   「Excel 用例，经 playwright-cli 执行，再出报告」做成一个编排，
 *   手工用例表直接变可执行回归，结果送进报告，失败步骤一眼能看到。
 *
 * 关键取舍（必须说清，否则会误导使用方）：
 *   自然语言步骤 → 可执行步骤 这一步**不是万能的**。手工用例表里的「步骤」写法千差万别，
 *   纯靠规则匹配必然覆盖不全。所以本模块：
 *     1) 用一组明确的规则做映射，并把**每一条无法映射的步骤原样报出来**（绝不静默丢弃）；
 *     2) 映射不了的步骤不会让整条用例失败，但会在结果里标成 `unmapped`，
 *        由人来补结构化描述 —— 宁可不做，也不能猜错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToFiles, findExecutable } from './runner.js';
import { generate, writeGenerated } from './generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PY_HELPER = path.join(HERE, '..', 'py', 'read_cases.py');

/** 找可用的 Python：优先 DSH 运行时自带的（带 openpyxl）。 */
export function resolvePython() {
  const candidates = [
    process.env.DSH_PYTHON,
    path.join(process.env.USERPROFILE || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    path.join(process.env.HOME || '', '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python', 'python3', 'py',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      const exe = findExecutable(c);
      if (exe) return exe;
    }
  }
  return null;
}

/**
 * 读 Excel / CSV 用例表。
 * 通过「产出文件」而不是管道拿结果 —— 沙箱下管道捕获不可用，且大表本来也不该进内存日志。
 */
export async function readCases(inputFile, opts = {}) {
  const { cwd = process.cwd(), sheet, timeoutMs = 120_000 } = opts;
  if (!fs.existsSync(inputFile)) {
    return { ok: false, reason: 'NOT_FOUND', message: `用例表不存在：${inputFile}` };
  }
  const py = resolvePython();
  if (!py) {
    return {
      ok: false,
      reason: 'PYTHON_NOT_FOUND',
      message: '找不到 Python，无法解析 Excel。请装 Python（≥3.9，xlsx 读取有内置解析，'
        + '不需要第三方库），或把用例表另存为 .csv —— csv 可以用纯 Node 读取（本工具也会自动尝试）。',
    };
  }
  const outDir = path.join(cwd, '.playwright-artifacts', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outJson = path.join(outDir, `cases-${Date.now()}.json`);

  const res = await runToFiles({
    command: py,
    args: [PY_HELPER, path.resolve(inputFile), '--out', outJson, ...(sheet ? ['--sheet', sheet] : [])],
    cwd,
    timeoutMs,
    logDir: path.join(cwd, '.playwright-artifacts', 'logs'),
    logName: 'read-cases',
  });

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      reason: 'PARSE_FAILED',
      message: `读取用例表失败：${(res.stderr || '').slice(-400) || e.message}`,
      logFiles: { stdout: res.stdoutFile, stderr: res.stderrFile },
    };
  }
  if (parsed.error) {
    return { ok: false, reason: 'HELPER_ERROR', message: parsed.error, ...parsed };
  }
  return { ok: true, ...parsed, casesJson: outJson };
}

/* ------------------------------------------------------------------ *
 * 自然语言步骤 → 结构化步骤（规则映射，映射不了就报出来）
 * ------------------------------------------------------------------ */

/**
 * 支持的映射规则。每条：名称、匹配正则、如何产出结构化步骤。
 * 只覆盖用例表里最高频的写法；覆盖不到的一律进 unmapped，不猜。
 */
const STEP_RULES = [
  {
    name: 'goto',
    re: /(?:打开|访问|进入|导航到|open|visit|navigate to)\s*(?:页面)?\s*[:：]?\s*(\S+|https?:\/\/\S+)/i,
    build: (m) => [{ act: 'goto', url: cleanUrl(m[1]) }],
  },
  {
    name: 'fill',
    // 关键：元素名的字符类必须**排除**「输入框/框/字段」的起始字，否则贪婪匹配会把
    // 后缀吞进元素名，得到 getByLabel('账号输入框') —— 定位器直接失效。
    // 这里同时排除「输」「框」「字」「段」，让后缀留给后面的可选组去匹配。
    re: /(?:在|向)?\s*[「"']?([^「」"'':：输框字段]{1,24})[」"']?\s*(?:输入框|文本框|输入栏|字段|框)?\s*(?:中|里)?\s*(?:输入|填写|填入|填)\s*[「"']?([^「」"'\n]+?)[」"']?\s*$/i,
    build: (m) => [{ act: 'fill', locator: { kind: 'label', text: cleanLabel(m[1]) }, value: m[2].trim() }],
  },
  {
    name: 'click',
    re: /(?:点击|单击|按下|点选|click)\s*[「"']?([^「」"']+?)[」"']?\s*(?:按钮|链接|图标|菜单|标签|选项)?\s*$/i,
    build: (m) => [{ act: 'click', locator: { kind: 'role', role: 'button', name: m[1].trim() } }],
  },
  {
    name: 'check',
    re: /(?:勾选|选中|check)\s*[「"']?([^「」"']+)[」"']?/i,
    build: (m) => [{ act: 'check', locator: { kind: 'label', text: m[1].trim() } }],
  },
  {
    name: 'select',
    re: /(?:在)?\s*[「"']?([^「」"']+?)[」"']?\s*(?:下拉框|下拉|select)\s*(?:中|里)?\s*(?:选择|选中|select)\s*[「"']?([^「」"']+)[」"']?/i,
    build: (m) => [{ act: 'select', locator: { kind: 'label', text: m[1].trim() }, value: m[2].trim() }],
  },
  {
    name: 'assertVisible',
    re: /(?:应当|应该|必须|需|要)?\s*(?:看到|显示|出现|可见|展示)\s*[「"']?([^「」"']+)[」"']?/i,
    build: (m) => [{ act: 'assertVisible', locator: { byText: m[1].trim(), byTestId: slugOf(m[1]) } }],
  },
  {
    name: 'assertText',
    re: /(?:校验|断言|验证|确认|检查)\s*[「"']?([^「」"']+?)[」"']?\s*(?:等于|为|是|=|==)\s*[「"']?([^「」"']+)[」"']?/i,
    build: (m) => [{ act: 'assertText', locator: { byText: m[1].trim(), byTestId: slugOf(m[1]) }, expect: m[2].trim() }],
  },
];

/**
 * 把中文/混合元素名转成一个常见的 testid 形态，作为**第二候选**。
 *
 * 为什么敢这么猜：它只是候选，不是结论。两种情况都能收场 ——
 *   · 猜对：用上更稳的 testid 定位；
 *   · 猜错：断言找不到元素并明确报错（不会静默通过），人按实际页面改 testid 即可。
 * 定位器策略本身仍然只允许稳定写法，所以「猜」不会降低门禁强度。
 * 中文且不在词典里的保留原样 —— 中文 testid 同样常见。
 */
const CN_TO_EN = {
  账号: 'account', 账户: 'account', 用户: 'user', 用户名: 'username',
  密码: 'password', 邮箱: 'email', 手机号: 'phone', 验证码: 'code',
  登录: 'login', 提交: 'submit', 保存: 'save', 取消: 'cancel', 搜索: 'search',
  订单金额: 'order-amount', 金额: 'amount', 订单: 'order', 数量: 'count',
  用户菜单: 'user-menu', 菜单: 'menu', 状态: 'status', 名称: 'name',
  通知设置: 'notification-settings', 保存成功: 'save-success',
};

function slugOf(name) {
  const t = String(name || '').trim();
  if (!t) return undefined;
  if (CN_TO_EN[t]) return CN_TO_EN[t];
  if (/[A-Za-z]/.test(t)) return t.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return t;
}

function cleanUrl(s) {
  const t = String(s).trim().replace(/[「」"'']/g, '');
  // 已经是绝对 URL 的一律原样保留，**绝不加前缀**。
  // 曾经的写法只认 http(s)，于是 file:///D:/... 被当成相对路径加了个 '/'，
  // 变成 "/file:///D:/..." —— 报错是「Cannot navigate to invalid URL」，
  // 看起来像环境问题，实际是清理函数把绝对 URL 改坏了。
  // 除 http(s) 外，file: 与 data: 在离线可复现的用例里很常用，都要放过。
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return t.startsWith('/') ? t : `/${t}`;
}

/** 去掉「账号输入框」里的「输入框/框/字段」后缀 —— 它们描述的是控件类型，不是元素名。 */
function cleanLabel(s) {
  return String(s || '')
    .trim()
    .replace(/[「」"'']/g, '')
    .replace(/(?:输入框|文本框|输入栏|字段|框)$/u, '')
    .trim();
}

/** 把一条自然语言步骤映射成结构化步骤；映射不了返回 null。 */
export function mapStepText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  for (const rule of STEP_RULES) {
    const m = rule.re.exec(s);
    if (m) {
      try {
        const steps = rule.build(m);
        if (steps && steps.length) return { rule: rule.name, steps, source: s };
      } catch { /* 落到 unmapped */ }
    }
  }
  return null;
}

/**
 * 把一条用例（步骤文本数组 + 预期结果）转成结构化步骤。
 * 预期结果始终转成一条断言 —— 没有断言的用例只证明「页面没崩」。
 */
export function caseToSteps(c) {
  const mapped = [];
  const unmapped = [];
  for (const text of c.steps || []) {
    const r = mapStepText(text);
    if (r) mapped.push(...r.steps);
    else unmapped.push(text);
  }
  if (c.expect) {
    const r = mapStepText(c.expect) || mapStepText(`校验 ${c.expect}`);
    if (r) mapped.push(...r.steps);
    else unmapped.push(`(预期结果) ${c.expect}`);
  }
  return { steps: mapped, unmapped };
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 跑完整个编排：读表 → 映射 → 生成脚本（带门禁）→ 执行 → 报告
 *
 * @param {object} o
 * @param {string} o.input            用例表路径
 * @param {string} [o.cwd]
 * @param {string} [o.outDir]         生成脚本的落点（默认 demo/generated-orchestrated）
 * @param {boolean} [o.run]           是否实际执行（false 时只生成，便于先审脚本）
 * @param {string} [o.pageName]
 * @param {string} [o.navPath]
 */
export async function orchestrate(o) {
  const {
    input, cwd = process.cwd(), outDir = path.join(cwd, 'demo', 'generated-orchestrated'),
    run = true, pageName = 'app', navPath = '/', specName = 'from-excel',
  } = o;

  const report = {
    tool: 'orchestrate_excel',
    version: 1,
    input,
    steps: [],
    unmapped: [],
    ok: false,
  };

  // 1) 读表
  const read = await readCases(input, { cwd });
  report.read = { ok: read.ok, caseCount: read.caseCount, warnings: read.warnings, sheet: read.sheet, message: read.message };
  if (!read.ok) {
    report.message = read.message;
    return report;
  }
  report.steps.push(`读取用例表：${read.caseCount} 条用例（sheet=${read.sheet}，表头第 ${read.headerRow} 行）`);

  // 2) 映射步骤
  const cases = [];
  // 用例表里的「打开 <url>」是真实导航目标，必须用它，而不是调用方给的默认 navPath。
  // 否则生成出来的 goto() 会指向 '/'，跑起来就是「Cannot navigate to invalid URL」——
  // 而这个错误看起来像环境问题，实际是编排把导航目标丢了。
  let discoveredNavPath = null;
  for (const c of read.cases) {
    const { steps, unmapped } = caseToSteps(c);
    if (unmapped.length) {
      report.unmapped.push({ title: c.title, row: c.row, steps: unmapped });
    }
    if (!steps.length) {
      report.unmapped.push({ title: c.title, row: c.row, steps: ['(整条用例都无法映射成可执行步骤)'] });
      continue;
    }
    const gotoStep = steps.find((s) => s.act === 'goto');
    if (gotoStep?.url && !discoveredNavPath) discoveredNavPath = gotoStep.url;
    cases.push({
      title: c.title,
      page: pageName,
      claims: c.expect ? `${c.title}：${c.expect}` : `${c.title}（未填写预期结果）`,
      // goto 由页面对象的 goto() 承担（它用 navPath），所以这里不再重复
      steps: steps.filter((s) => s.act !== 'goto'),
    });
  }
  const effectiveNavPath = discoveredNavPath || navPath;
  report.navPath = effectiveNavPath;
  report.navPathSource = discoveredNavPath ? '用例表的「打开 …」步骤' : '调用方给的默认值';
  report.steps.push(`导航目标：${effectiveNavPath}（来自${report.navPathSource}）`);
  report.steps.push(`映射出 ${cases.length} 条可执行用例，${report.unmapped.length} 条存在无法映射的步骤`);

  if (!cases.length) {
    report.message = '没有任何用例能映射成可执行步骤。请检查用例表的「步骤」「预期结果」列写法，'
      + '或按 references/po-and-generation.md 的结构化描述补齐。';
    return report;
  }

  // 3) 生成脚本（门禁：语法 + lint ERROR 0 才写盘）
  const pages = [{
    name: pageName,
    navPath: effectiveNavPath,
    steps: cases.flatMap((c) => c.steps).filter((s) => s.act !== 'goto'),
  }];
  let gen;
  try {
    gen = generate({ spec: specName, pages, cases });
  } catch (e) {
    report.message = `生成脚本失败：${e.message}`;
    return report;
  }
  report.generate = { verdict: gen.verdict, lint: { errorCount: gen.lint.errorCount, warnCount: gen.lint.warnCount }, syntax: gen.syntax.passed };
  report.generatedFiles = gen.files.map((f) => f.path);
  report.steps.push(`生成脚本：${gen.verdict}`);

  if (!gen.lint.passed) {
    report.message = '生成物未通过门禁，已阻止写盘。请修掉规则表里的问题后重跑。';
    return report;
  }
  const w = writeGenerated(gen, outDir);
  report.written = w;
  report.steps.push(`脚本已落盘：${w.files?.length || 0} 个文件 → ${outDir}`);

  // 4) 执行（可选）
  if (run) {
    const { runPlaywright } = await import('./runner.js');
    const res = await runPlaywright({
      cwd,
      args: ['--config', path.join(outDir, 'playwright.config.ts')],
      timeoutMs: 600_000,
      logDir: path.join(cwd, '.playwright-artifacts', 'logs'),
    });
    report.run = {
      ok: res.ok,
      exitCode: res.code,
      durationMs: res.durationMs,
      message: res.message,
      logFiles: res.stdoutFile ? { stdout: res.stdoutFile, stderr: res.stderrFile } : undefined,
    };
    report.steps.push(res.message
      ? `执行未开始：${res.message}`
      : `执行完成，退出码 ${res.code}（${Math.round(res.durationMs / 1000)}s）`);
  }

  report.ok = report.run ? report.run.ok : true;
  report.message = report.unmapped.length
    ? `编排完成，但有 ${report.unmapped.length} 条用例存在无法映射的步骤 —— 这些步骤没有被静默丢弃，请人工补齐结构化描述。`
    : '编排完成，全部步骤均已映射。';
  return report;
}

export default { readCases, orchestrate, mapStepText, caseToSteps, resolvePython };
