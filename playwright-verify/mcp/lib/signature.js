/**
 * signature.js — 失败签名归一化与分类
 *
 * 原文缺陷 4 的核心教训：
 *   「判定与签名必须吃同一份清洗后的文本。」
 *   第一版聚类把 3 条 toHaveText 断言失败全判成 timeout，因为判定正则写的是 Error: expect\(，
 *   而真实报告里是 Error: 紧跟一串 ANSI 控制字符再跟 expect( —— 永远匹配不上。
 *   更糟的是签名里清洗了 ANSI、判定里没清洗：同一份文本两种清洗度，签名看着正常、归因全歪。
 *
 * 所以本模块的硬约定：
 *   1) 所有文本先过 clean()，且 clean() 是幂等的（clean(clean(x)) === clean(x)）；
 *   2) classify() 与 signature() 只接受 clean 后的文本，绝不各自再清洗一次；
 *   3) 判定顺序从最具体到最泛（strict > assertion > not-found > timeout > env）。
 */

import fs from 'node:fs';

/** 与 Playwright / Jest 输出对齐的 ANSI 清洗（含 \x1b[2m 这类「暗淡」样式码）。 */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]|\u009b[0-9;]*[A-Za-z]/g;

/**
 * 清洗：去 ANSI、归一换行、去行尾空白。
 * 幂等 —— 这是「判定与签名吃同一份文本」的前提。
 */
export function clean(text) {
  if (text === undefined || text === null) return '';
  let s = String(text);
  s = s.replace(ANSI_RE, '');
  // 有些报告会把转义写成字面量 \x1b 文本
  s = s.replace(/\\x1b\[[0-9;]*[A-Za-z]/g, '');
  s = s.replace(/\\u001b\[[0-9;]*[A-Za-z]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  return s;
}

/** 幂等自检：同一份文本清洗两次必须完全相同。 */
export function cleanIsIdempotent(text) {
  const once = clean(text);
  return once === clean(once);
}

/* ------------------------------------------------------------------ *
 * 分类
 * ------------------------------------------------------------------ */

export const CATEGORIES = {
  'locator-strict': {
    label: '定位器命中多个元素',
    owner: '测试侧',
    nature: '用例缺陷',
    action: '收紧定位器到唯一命中（加 getByRole 的 name、scope 到容器内），或明确断言数量；'
      + '不要用 .first() 掩盖 —— 那只是把不稳定藏起来。',
  },
  assertion: {
    label: '断言未成立',
    owner: '产品 或 断言',
    nature: '待定（产品回归 / 断言写错）',
    action: '打开 trace 看页面实际状态：若页面确实错了 → 产品回归，派给开发；'
      + '若页面是对的、预期值写错了 → 用例缺陷，修断言。这一步必须人判，不允许自动放宽断言。',
  },
  'locator-not-found': {
    label: '定位器找不到元素',
    owner: '测试侧',
    nature: '用例缺陷',
    action: '对照 snapshot 检查元素是否改名/改结构/未渲染；优先改用语义定位器，'
      + '并确认等待条件写对了（等状态而不是等时间）。',
  },
  timeout: {
    label: '操作等待超时',
    owner: '待定',
    nature: '待定',
    action: '先查定位器还能不能命中（多数「超时」其实是定位器失效）；'
      + '再看 trace 里那一步的实际状态。若定位器没问题而页面确实慢，才是性能问题。',
  },
  env: {
    label: '环境不可达',
    owner: '环境',
    nature: '环境问题',
    action: '先确认环境再谈用例：检查服务是否启动、baseURL 是否指向正确环境、'
      + '网络/代理是否可用；若报 Executable doesn\'t exist / distribution not found，'
      + '是浏览器没装或通道不对 —— npx playwright install chromium，或改 .playwright/cli.config.json 的通道。'
      + '这类失败不要派人去查用例。',
  },
  unknown: {
    label: '未归类',
    owner: '人工',
    nature: '待判定',
    action: '按原始报错人工判定；若这类失败频繁出现，说明归因规则需要补一条签名。',
  },
};

/**
 * 分类判定表：**从最具体到最泛**，顺序即优先级。
 *
 * 顺序是按真实消息形态推出来的，不能乱调：
 *   env 最先 —— net::ERR_ 是唯一能立刻定性「环境不可达」的信号，绝不能被别的规则吃掉。
 *   接着 assertion —— 断言失败的消息里常带 waiting for / Timed out Nms waiting for expect(，
 *     如果不先拦，会被 timeout 或 locator-not-found 抢走（这正是缺陷 4 的形态）。
 *   然后 timeout —— 必须在 locator-not-found **之前**：操作超时的消息形如
 *     `TimeoutError: locator.click: Timeout 3000ms exceeded.`，它同时含 locator(，
 *     若先跑 locator-not-found 就会被误归成「定位器找不到元素」。
 *   最后 locator-not-found —— 收拢所有剩余的定位器相关报错。
 */
export const CLASSIFIERS = [
  {
    // env 同时收「服务不可达」与「浏览器根本没起来」两类。
    // 后者实测踩过：chromium headless shell 没装时 9 条回归全挂在 browserType.launch，
    // 而归因落在 unknown「人工判定」—— 一个环境问题被当成 9 条未知失败推给人，
    // 是归因能力的静默降级（不报错，结论却全错）。
    // 同理 CLI 缺通道（Chromium distribution '…' is not found）也是环境问题。
    id: 'env',
    re: /net::ERR_|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_TIMED_OUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|Executable doesn't exist at|browserType\.launch|distribution '[^']+' is not found|download new browsers/i,
  },
  // locator-strict 必须排在 assertion **之前**：
  // 一条 strict mode violation 往往是这样被抛出来的 ——
  //   Error: expect(locator).toBeVisible() failed
  //   Locator: getByText('<s>')
  //   Error: strict mode violation: … resolved to 3 elements
  // 若 assertion 先匹配，这条「定位器命中多个元素」就会被归成「断言未成立」，
  // 于是真正该修的定位器缺陷被写成「产品回归」，派给了错的团队。
  // 判据：消息里出现 strict mode violation / resolved to N elements，就是定位器缺陷。
  { id: 'locator-strict', re: /strict mode violation|resolved to \d+ elements?/i },
  {
    // 坑：断言方法调用自带一对括号（toBeVisible() / toHaveText('x')），
    // 所以 `expect\([^)]*\)\s*\.\s*\w+\s+failed` 这种写法会在第一个 `)` 处停住，
    // 接不上后面的 `.toBeVisible(`，**整条短消息会没有任何分支命中**。实测踩到：
    //   "Error: expect(locator).toBeVisible() failed"
    // 这一行不含 Expected:/Received:，于是被归成 unknown，派工单上写「人工判定」——
    // 一个本可自动归类的断言失败被推给人，归因能力静默降级（不会报错，只是结论变差）。
    // 修法：用 `expect\(.*?\)\s*\.\s*\w+\s*\(` 容忍方法名后的括号，
    // 并把 `Locator:` 也算作断言信号（Playwright 的断言失败一定打这一行）。
    id: 'assertion',
    re: /\bexpect\(.*?\)\s*\.\s*\w+\s*\(|Expected:\s|Received:\s|\bLocator:\s|Timed out \d+ms waiting for expect\(|waiting for expect\(locator\)/i,
  },
  { id: 'timeout', re: /TimeoutError|Timeout \d+ms exceeded|exceeded\.|Test timeout of \d+ms exceeded/i },
  { id: 'locator-not-found', re: /waiting for locator\(|locator\([^)]*\)\.(?:click|fill|check|selectOption|hover|innerText|textContent|inputValue|press|dblclick)|element is not visible|element is not attached/i },
];

/**
 * 对**已清洗**文本做分类。
 * @param {string} cleaned 必须是 clean() 的输出
 * @returns {string} 类别 id
 */
export function classify(cleaned) {
  for (const c of CLASSIFIERS) {
    if (c.re.test(cleaned)) return c.id;
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * 签名
 * ------------------------------------------------------------------ */

/**
 * 生成签名：把「同源失败」压成同一个字符串。
 * 处理掉所有会导致同源失败被拆开的变量部分：路径、行号、引号内容、数字、URL、耗时。
 *
 * @param {string} cleaned clean() 的输出
 * @param {string} [file]  用例文件路径（附加到签名上，让不同文件的失败不被混为一谈）
 */
export function signature(cleaned, file) {
  let s = cleaned;
  // 去 stack 之后的行
  s = s.split('\n').filter((l) => !/^\s*at\s/.test(l)).join('\n');
  // 去掉「Call log:」之后的细节（每次运行的定位器日志都不同，会把同源失败拆开）
  s = s.split(/\n\s*Call log:/)[0];
  // 去 URL
  s = s.replace(/https?:\/\/[^\s)'"]+/g, '<url>');
  // 去绝对/相对文件路径与行列号
  s = s.replace(/(?:[A-Za-z]:)?[\\/][\w.@\\/-]*\.(?:ts|tsx|js|jsx|mjs|cjs):\d+:\d+/g, '<loc>');
  s = s.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs):\d+:\d+/g, '<loc>');
  // 去 (行:列)
  s = s.replace(/\(\d+:\d+\)/g, '(<loc>)');
  // 引号内容 → 占位（注意先处理选择器形态，保留「形态」而丢掉具体值）
  s = s.replace(/'[^']*'/g, "'<s>'");
  s = s.replace(/"[^"]*"/g, '"<s>"');
  s = s.replace(/`[^`]*`/g, '`<s>`');
  // 数字（含小数、下划线分隔、毫秒）
  s = s.replace(/\b\d[\d_]*(?:\.\d+)?\b/g, '<n>');
  // 空白归一：去空行、折叠连续换行。
  // 必须做 —— 同一条 ANSI 消息清掉样式码后会留下前导空行，而另一条没有，
  // 两者就会因为「一个空行」被判成两个签名（同源失败被拆开）。
  s = s.replace(/[ \t]+/g, ' ');
  s = s.split('\n').map((l) => l.trim()).join('\n');
  s = s.replace(/\n{2,}/g, '\n').trim();
  // 只保留前 240 字符作为签名主体，避免长尾噪声
  s = s.slice(0, 240);
  const where = file ? `${file} :: ` : '';
  return `${where}${s}`;
}

/* ------------------------------------------------------------------ *
 * 报告解析
 * ------------------------------------------------------------------ */

/** 展平 Playwright JSON 报告的 suite 树。 */
function walkSuites(suites, out, trail) {
  for (const s of suites || []) {
    const title = s.title || '';
    const here = title ? [...trail, title] : trail;
    for (const spec of s.specs || []) {
      out.push({ specTitle: spec.title, ok: spec.ok, tests: spec.tests || [], trail: here, file: spec.file || s.file });
    }
    if (s.suites) walkSuites(s.suites, out, here);
  }
  return out;
}

/** 从 result 里抽出可读的错误文本（errors 可能是数组或对象）。 */
function errorTextOf(result) {
  const parts = [];
  const push = (e) => {
    if (!e) return;
    if (typeof e === 'string') { parts.push(e); return; }
    if (e.message) parts.push(e.message);
    if (e.stack) parts.push(e.stack);
    if (e.value) parts.push(typeof e.value === 'string' ? e.value : JSON.stringify(e.value));
  };
  if (Array.isArray(result.errors)) result.errors.forEach(push);
  else push(result.errors);
  if (result.error) push(result.error);
  if (result.stderr) result.stderr.forEach((x) => push(typeof x === 'string' ? x : x.text));
  return parts.join('\n');
}

/**
 * 解析 Playwright JSON reporter 报告，产出聚类与归因。
 * @param {object} json Playwright JSON 报告对象
 * @param {object} opts { file }
 */
export function summarize(json, opts = {}) {
  // ---- 输入校验：解析失败/不像报告必须报错，绝不静默给「全部通过（0 条）」 ----
  // 把解析失败说成没有失败，是「不报错但结论错」的典型：调用方拿到全零会当成真绿。
  // 工具面 args.json 是原始字符串（旧实现根本不解析，直接全零）；文件路径先经
  // summarizeFile 解析再进来。错误形状与 summarizeFile 一致（.error 通道），
  // 上层：工具 fail(..., 'REPORT_ERROR')、CLI finish(2) —— 两边判定口径同源。
  const bad = (msg) => ({ tool: 'summarize_report', version: 1, source: opts.file || '(inline)', error: msg });
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch (e) {
      return bad(`报告 JSON 解析失败: ${e.message}`);
    }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return bad('报告不是 JSON 对象');
  }
  if (json.suites === undefined && json.stats === undefined) {
    return bad('不是 Playwright JSON 报告（缺 suites/stats 字段）');
  }
  const specs = walkSuites(json.suites || [], [], []);
  const stats = {
    expected: json.stats?.expected ?? 0,
    unexpected: json.stats?.unexpected ?? 0,
    flaky: json.stats?.flaky ?? 0,
    skipped: json.stats?.skipped ?? 0,
    durationMs: json.stats?.duration ?? 0,
  };

  const failures = [];
  const flakes = [];
  let totalTests = 0;

  for (const spec of specs) {
    for (const t of spec.tests) {
      totalTests++;
      const results = t.results || [];
      // 明确跳过的不算失败
      if (t.status === 'skipped') continue;
      const failed = results.filter((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted');
      const passedAfterRetry = t.status === 'flaky' || (failed.length > 0 && results.some((r) => r.status === 'passed'));
      const label = [...spec.trail, spec.specTitle].filter(Boolean).join(' › ');

        if (failed.length > 0) {
        // 取最后一次失败作为代表（首次失败往往是抖动，最后一次才代表结论）
        const rep = failed[failed.length - 1];
        const raw = errorTextOf(rep);
        const cleaned = clean(raw);                       // 清洗一次
        const cat = classify(cleaned);                    // 判定吃清洗后的文本
        const sig = signature(cleaned, spec.file || opts.file);  // 签名吃同一份清洗后的文本
        // 提取 trace 附件：**扫全部失败结果**，不能只看最后一次。
        // 真实配置常见 trace: 'on-first-retry' —— trace 只落在首次重试上，
        // 而「最后一次失败」往往是第二次重试（无 trace）。只看最后一次 = 永远取不到。
        const traceUrls = [];
        for (const r of failed) {
          for (const a of (r.attachments || [])) {
            if (a.name !== 'trace') continue;
            const u = a.path || a.url;
            if (u && !traceUrls.includes(u)) traceUrls.push(u);
          }
        }
        const traceUrl = traceUrls[0] || null;
        const rec = {
          title: label,
          file: spec.file,
          retries: results.length - 1,
          retryCount: failed.length,
          flaky: passedAfterRetry,
          category: cat,
          categoryLabel: CATEGORIES[cat].label,
          signature: sig,
          // 取前 6 行时**先去掉空行**：ANSI 清洗常在开头留下空行，
          // 直接 slice(0,6) 会让 6 行里有一半是空行，真正的根因被挤出视野 ——
          // 人看到的 message 不含根因，等于要求他去翻原始报告。
          message: cleaned.split('\n').filter((l) => l.trim()).slice(0, 6).join('\n'),
          durationMs: rep.duration ?? 0,
          traceUrl,
          traceUrls,          // 本次用例全部失败结果里的 trace（去重）
        };
        failures.push(rec);
        if (passedAfterRetry) flakes.push(rec);
      }
    }
  }

  // ---- 按签名聚类 ----
  // 口径：聚类只统计「确定失败」（unexpected），偶发（重试后通过）单独列出。
  // 理由：偶发是同一条用例的抖动，若混进聚类，同一条用例会以「1 次失败 + 1 次通过」
  // 同时在 clusters 与 flakes 里出现，既虚增根因数（原文是 6 条失败聚成 4 个签名，
  // 混进偶发就会变成 5 个），也会让「一个签名派一个人」的口径失真。
  const definitive = failures.filter((f) => !f.flaky);
  const clusters = new Map();
  for (const f of definitive) {
    if (!clusters.has(f.signature)) {
      clusters.set(f.signature, {
        signature: f.signature,
        category: f.category,
        categoryLabel: f.categoryLabel,
        count: 0,
        tests: [],
        sample: f.message,
        flakyCount: 0,
        file: f.file,
        traceUrls: [],   // 失败 trace 路径列表（去重）
      });
    }
    const c = clusters.get(f.signature);
    c.count++;
    c.tests.push(f.title);
    // 收集 trace URL（去重），多个失败有同一个 trace 时不重复
    for (const u of (f.traceUrls || (f.traceUrl ? [f.traceUrl] : []))) {
      if (!c.traceUrls.includes(u)) c.traceUrls.push(u);
    }
  }

  // 辅助函数：截短 trace 路径用于显示。
  // 取最后两段（test-results/sample-x-retry1/trace.zip → sample-x-retry1/trace.zip）——
  // 绝对前缀每条都一样（截掉不损失信息），而截「开头 60 字符」会让 5 条 trace 全长一个样，
  // 报告里等于没给。目录名 + 文件名才是可区分的部分。
  const shortTrace = (url) => {
    if (!url) return null;
    const parts = String(url).replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.slice(-2).join('/');
    return short.length > 60 ? `${short.slice(0, 57)}…` : short;
  };

  const clusterList = [...clusters.values()]
    .map((c) => ({
      ...c,
      owner: CATEGORIES[c.category].owner,
      nature: CATEGORIES[c.category].nature,
      action: CATEGORIES[c.category].action,
      // 派活口径：一个签名 = 一份工作量，而不是「一条失败 = 一个人」
      workload: `${c.count} 条失败同源，派 1 人按此签名查`,
      traceUrls: c.traceUrls,    // 原始路径数组（供调用方查完整文件）
      traceShorts: c.traceUrls.map(shortTrace), // 截短显示用
    }))
    .sort((a, b) => b.count - a.count);

  const byCategory = {};
  for (const c of clusterList) {
    byCategory[c.category] = byCategory[c.category] || { category: c.category, label: c.categoryLabel, count: 0, signatures: 0 };
    byCategory[c.category].count += c.count;
    byCategory[c.category].signatures++;
  }

  const durationSec = Math.round((stats.durationMs / 1000) * 10) / 10;
  // 口径说明：一条「偶发」用例会产生 1 次 failed 重试 + 1 次 passed，
  // 若用 cluster 里的条数当失败数，就会把偶发也算成失败（6 条失败会显示成 7 条）。
  // 所以 headline 用 stats.unexpected（权威口径），聚类仍覆盖全部失败记录以便归因。
  const unexpected = stats.unexpected || failures.filter((f) => !f.flaky).length;

  return {
    tool: 'summarize_report',
    version: 1,
    source: opts.file || '(inline)',
    totals: {
      tests: totalTests,
      passed: stats.expected,
      failed: unexpected,
      flaky: stats.flaky,
      skipped: stats.skipped,
      durationSec,
    },
    // 一句话结论：把 N 条失败压成 M 个根因
    headline: unexpected === 0
      ? `全部通过（${stats.expected} 条${stats.flaky ? `，另有 ${stats.flaky} 条偶发` : ''}），耗时 ${durationSec}s`
      : `${unexpected} 条失败聚成 ${clusterList.length} 个根因签名`
        + `${flakes.length ? `（另有 ${flakes.length} 条偶发，不计入失败）` : ''}，耗时 ${durationSec}s`,
    clusters: clusterList,
    byCategory: Object.values(byCategory).sort((a, b) => b.count - a.count),
    failures: definitive,
    flakes: flakes.map((f) => f.title),
    // 偶发的归因单列：抖动要按「环境抖动」处理，不能和确定失败混在同一张派工单里
    flakeDetails: flakes.map((f) => ({
      title: f.title,
      category: f.category,
      signature: f.signature,
      retries: f.retries,
    })),
  };
}

/** 从文件读并解析 JSON 报告。 */
export function summarizeFile(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { tool: 'summarize_report', version: 1, source: file, error: `报告读取/解析失败: ${e.message}` };
  }
  return summarize(json, { file });
}

/* ------------------------------------------------------------------ *
 * 多报告趋势（v1.8.7）
 * ------------------------------------------------------------------ */

/**
 * 跨 N 份**已归因**报告（summarize() 的输出）做趋势：通过率曲线 + 签名漂移。
 *
 * 口径：
 *   - 顺序 = 传入顺序（目录展开由上层按 mtime 升序排好；谁排的谁负责时间语义）；
 *   - 签名沿用 summarize 的同一 signature()（单一源，不另造归一化 ——
 *     另造一套必然与单报告口径漂移，「上周的它」和「这周的它」就永远对不上）；
 *   - 漂移以「末份 vs 之前所有」计算：新签名 = 末份有而之前全无（回归信号）；
 *     消除 = 之前有而末份无（修复成效）；持续 = 两边都有（存量，附 prev→last 计数）。
 *
 * @param {object[]} reports summarize() 输出数组（含 .error 的报告由上层拦下，这里不吞）
 */
export function summarizeTrend(reports) {
  const runs = reports.map((r, i) => ({
    index: i + 1,
    source: r.source,
    passed: r.totals.passed,
    failed: r.totals.failed,
    flaky: r.totals.flaky,
    skipped: r.totals.skipped,
    durationSec: r.totals.durationSec,
    passRate: r.totals.tests ? Math.round((r.totals.passed / r.totals.tests) * 1000) / 10 : 0,
    signatureCount: r.clusters.length,
  }));

  // 签名 × 份数的计数矩阵（对齐数组，缺位为 0）。
  // 计数加的是簇的 count —— 一个签名在同一份报告里可能聚了多条失败（钉抓过：
  // 写成 ++ 会把「3 条同源」记成 1，持续签名的 prev→last 全部失真）。
  const series = new Map();
  reports.forEach((r, i) => {
    for (const c of r.clusters) {
      if (!series.has(c.signature)) {
        series.set(c.signature, {
          category: c.category,
          categoryLabel: c.categoryLabel,
          counts: reports.map(() => 0),
          sample: c.sample,
        });
      }
      series.get(c.signature).counts[i] += c.count;
    }
  });

  const last = reports.length - 1;
  const newSignatures = [];
  const resolvedSignatures = [];
  const persisting = [];
  for (const [sig, info] of series) {
    const before = info.counts.slice(0, last);
    const lastCount = info.counts[last];
    const entry = { signature: sig, category: info.category, categoryLabel: info.categoryLabel, lastCount };
    if (lastCount > 0 && before.every((n) => n === 0)) newSignatures.push(entry);
    else if (lastCount === 0 && before.some((n) => n > 0)) resolvedSignatures.push(entry);
    else persisting.push({ ...entry, prevCount: before[before.length - 1] ?? 0 });
  }
  const byWeight = (a, b) => b.lastCount - a.lastCount;
  newSignatures.sort(byWeight);
  resolvedSignatures.sort(byWeight);
  persisting.sort(byWeight);

  const first = runs[0];
  const lastRun = runs[runs.length - 1];
  const failedDelta = lastRun.failed - first.failed;
  return {
    tool: 'summarize_report',
    version: 1,
    mode: 'trend',
    runCount: runs.length,
    runs,
    headline: `${runs.length} 份报告：失败 ${first.failed} → ${lastRun.failed}`
      + `（${failedDelta >= 0 ? '+' : ''}${failedDelta}），通过率 ${first.passRate}% → ${lastRun.passRate}%，`
      + `新签名 ${newSignatures.length} / 消除 ${resolvedSignatures.length} / 持续 ${persisting.length}`,
    signatureSeries: [...series.entries()]
      .map(([signature, info]) => ({ signature, ...info }))
      .sort((a, b) => b.counts[last] - a.counts[last] || Math.max(...b.counts) - Math.max(...a.counts)),
    newSignatures,
    resolvedSignatures,
    persisting,
  };
}

/**
 * 趋势 md 各列表的渲染行上限：签名爆炸时 md 只展示权重最高的前 50 条 + 诚实「还有 N 条」计数。
 * v1.8.11 起该上限同时管 md 与 structuredContent 两个面（单一源 —— 两处各写一个 50，漂移只是
 * 时间问题）：全量数据以工具面落盘的趋势 JSON 文件为准，md/上下文都只截展示。
 */
export const TREND_MD_MAX_ROWS = 50;

function capMdRows(rows) {
  if (rows.length <= TREND_MD_MAX_ROWS) return { rows, note: null };
  return {
    rows: rows.slice(0, TREND_MD_MAX_ROWS),
    note: `…（该列表还有 ${rows.length - TREND_MD_MAX_ROWS} 条未展示，共 ${rows.length} 条；完整数据在趋势落盘的同名 JSON 文件 —— md 只截展示不截数据）`,
  };
}

/**
 * 趋势的上下文有界版（v1.8.11）：structuredContent 是回灌模型的负载，签名爆炸时随签名数
 * 线性膨胀（实测 130 签名 × 5 份 = 50.9KB），与「长产物一律落盘不灌上下文」红线相悖。
 * 口径（四条，缺一不可）：
 *   - 全量趋势 JSON 由工具面落盘（trend-*.json），CI 对账与 join-back 以落盘为准，一行不缺；
 *   - 四个列表（序列/新/消除/持续）各截前 TREND_MD_MAX_ROWS 条 —— 与 md 同一常量单一源；
 *   - 条目去 sample（证据文本全量在落盘 JSON，不必逐条回灌）；签名串/计数矩阵逐字段不动；
 *   - 每列表带 *Total 诚实计数 + contextTruncated 标记，version 升 2 如实标记形状变更
 *     （落盘 JSON 保持 version 1 的全量原形）。
 */
export function slimTrendForContext(trend) {
  const cap = (list) => list.slice(0, TREND_MD_MAX_ROWS);
  return {
    ...trend,
    version: 2,
    signatureSeries: cap(trend.signatureSeries.map(({ sample, ...rest }) => rest)),
    newSignatures: cap(trend.newSignatures),
    resolvedSignatures: cap(trend.resolvedSignatures),
    persisting: cap(trend.persisting),
    signatureSeriesTotal: trend.signatureSeries.length,
    newSignaturesTotal: trend.newSignatures.length,
    resolvedSignaturesTotal: trend.resolvedSignatures.length,
    persistingTotal: trend.persisting.length,
    contextTruncated: trend.signatureSeries.length > TREND_MD_MAX_ROWS
      || trend.newSignatures.length > TREND_MD_MAX_ROWS
      || trend.resolvedSignatures.length > TREND_MD_MAX_ROWS
      || trend.persisting.length > TREND_MD_MAX_ROWS,
  };
}

/** 趋势的人读版（落盘 md 用；签名截 130 字符与单报告 formatText 同口径）。 */
export function formatTrendText(trend) {
  const out = [];
  out.push(`# 回归趋势（${trend.runCount} 份报告）`);
  out.push('');
  out.push(trend.headline);
  out.push('');
  out.push('| # | 报告 | 通过/总数 | 通过率 | 失败 | 偶发 | 耗时s | 签名数 |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const r of trend.runs) {
    out.push(`| ${r.index} | ${r.source} | ${r.passed}/${r.passed + r.failed + r.flaky + r.skipped} | ${r.passRate}% | ${r.failed} | ${r.flaky} | ${r.durationSec} | ${r.signatureCount} |`);
  }
  out.push('');
  out.push('## 签名漂移（末份 vs 之前所有）');
  out.push('');
  // 三个漂移列表共用同一渲染骨架：标题带总数（原序：前缀 N 个（说明）），行超上限截断 + 诚实计数行。
  const renderList = (prefix, suffix, list, fmt) => {
    out.push(`### ${prefix} ${list.length} 个${suffix}`);
    const { rows, note } = capMdRows(list);
    for (const s of rows) out.push(fmt(s));
    if (note) out.push(note);
    else if (!list.length) out.push('- （无）');
  };
  renderList('新签名', '（回归信号，末份新出现）', trend.newSignatures,
    (s) => `- [${s.category}] ${s.signature.slice(0, 130)}（${s.lastCount} 条）`);
  out.push('');
  renderList('消除', '（修复成效，末份已无）', trend.resolvedSignatures,
    (s) => `- [${s.category}] ${s.signature.slice(0, 130)}`);
  out.push('');
  renderList('持续', '（存量，上份 → 末份计数）', trend.persisting,
    (s) => `- [${s.category}] ${s.signature.slice(0, 130)}（${s.prevCount} → ${s.lastCount}）`);
  out.push('');
  out.push('## 签名计数序列（按份）');
  out.push('');
  const { rows: seriesRows, note: seriesNote } = capMdRows(trend.signatureSeries);
  for (const s of seriesRows) out.push(`- [${s.category}] ${s.signature.slice(0, 130)}：${s.counts.join(' → ')}`);
  if (seriesNote) out.push(seriesNote);
  return out.join('\n');
}

/** 人读版渲染：结论 + 证据 + 下一步。 */
export function formatText(report) {
  if (report.error) return `summarize_report 失败：${report.error}`;
  const out = [];
  const t = report.totals;
  out.push(`summarize_report  ${report.source}`);
  out.push(`结果: 通过 ${t.passed} / 失败 ${t.failed} / 偶发 ${t.flaky} / 跳过 ${t.skipped}，共 ${t.tests} 条，耗时 ${t.durationSec}s`);
  out.push('');
  if (report.clusters.length === 0) {
    out.push('没有失败需要归因。');
    return out.join('\n');
  }
  out.push(`按签名聚类：${report.clusters.length} 个根因`);
  out.push('');
  for (const c of report.clusters) {
    out.push(`[${c.count} 次 · ${c.category}] ${c.signature.slice(0, 130)}`);
    out.push(`    归因: ${c.nature}　派给: ${c.owner}`);
    out.push(`    下一步: ${c.action}`);
    if (c.tests.length) out.push(`    涉及用例: ${c.tests.slice(0, 4).join(' | ')}${c.tests.length > 4 ? ` …共 ${c.tests.length} 条` : ''}`);
    if (c.traceShorts && c.traceShorts.length) {
      out.push(`    trace: ${c.traceShorts.join(', ')}`);
    }
    out.push('');
  }
  out.push('分类汇总:');
  for (const b of report.byCategory) out.push(`  ${b.label}（${b.category}）: ${b.count} 条失败 / ${b.signatures} 个签名`);
  if (report.flakes.length) {
    out.push('');
    out.push(`偶发（重试后才通过）: ${report.flakes.join(', ')}`);
  }
  return out.join('\n');
}

export default {
  clean, classify, signature, summarize, summarizeFile, formatText, cleanIsIdempotent,
  CATEGORIES, CLASSIFIERS, summarizeTrend, formatTrendText, slimTrendForContext,
};
