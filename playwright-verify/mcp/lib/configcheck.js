/**
 * check_config.js — Playwright 配置基线体检
 *
 * 为什么它必须排在三个脚本的最前面（原文第 5 节）：
 *   配置错的时候，后面所有结论都是白干 —— 没有 forbidOnly，.only 会带着一条用例进 CI；
 *   timeout 拉到 300 秒，任何失败都以「超时」的样子出现，你再也分不清是页面慢了还是功能坏了。
 *
 * 判定策略：**没有把握就不下结论**。
 *   配置文件里的值可以是表达式（!!process.env.CI、process.env.CI ? 2 : undefined），
 *   本工具不做符号求值。能静态判定的判 ERROR/WARN，判不了的（undefined、变量、函数调用）
 *   降级成 INFO 并说明「需要人确认」，绝不因为算不出来就误报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { topLevelEntries, nestedGet } from './configobj.js';

export const BASELINE = {
  timeoutMaxMs: 60_000,      // 用例超时上限（超过即 ERROR：失败会被拖成「超时」的样子）
  expectTimeoutMaxMs: 15_000,
  actionTimeoutMaxMs: 30_000,
  retriesMin: 1,
  retriesMax: 3,
};

/** 静态求一个布尔字面量；算不出来返回 null（未知）。 */
function boolLiteral(v) {
  if (v === undefined) return null;
  const s = String(v).trim().replace(/;+$/, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/** 静态求一个数字字面量（支持 1_000 / 30 * 1000）；算不出来返回 null。 */
function numLiteral(v) {
  if (v === undefined) return null;
  const s = String(v).trim().replace(/;+$/, '');
  const parts = s.split('*').map((x) => x.trim().replace(/_/g, ''));
  let value = 1;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    value *= Number(p);
  }
  return Number.isFinite(value) ? value : null;
}

/** 判断值是否是「明确的 none/off」。 */
function isOff(v) {
  if (v === undefined) return false;
  const s = String(v).trim().replace(/;+$/, '');
  return s === "'off'" || s === '"off"' || s === "'none'" || s === '"none"' || s === 'off' || s === 'none';
}

/**
 * 体检一份配置源文本。
 * 返回 { file, version, findings[], summary, facts }
 */
export function checkConfigSource(src, filename = '(inline)') {
  const findings = [];
  const facts = {};

  // 「配置解析不出来」与「配置有问题」是两件事，不能都按 ERROR 报。
  //
  // 函数式导出（`defineConfig(() => ({...}))` 或 `defineConfig(function(){...})`）完全合法，
  // 但它把键藏在函数体里。实测：箭头形式 `() => ({...})` 有时会被 topLevelEntries 顺带捞出来
  // （它长得像对象字面量），而 `function(){ return {...} }` 形式捞不到。
  // 也就是说提取结果**不可信** → 后续所有「某键缺失」的判定都失去依据：
  //   没有 forbidOnly ≠ 他没写 forbidOnly，可能只是我们没读到 → 报 ERROR 会阻断一条健康流水线。
  // 这直接违反本项目自述原则「判不了就降级 INFO，绝不因为算不出来就误报」。
  //
  // 处理：先认出函数式配置。能读到的键值照常判定（尽力体检），
  // 但把「读取缺失」类结论统一降级为不阻断，并把 verdict 标成 UNPARSEABLE。
  const isFunctionalConfig = /defineConfig\s*\(\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(src)
    || /export\s+default\s+(?:async\s*)?(?:function\b|\()/.test(src);

  const add = (level, id, title, detail, value, fix) => {
    // 函数式配置下要区分两种情况，不能一刀切降级：
    //   · **键读到了** → 值就是文件里的真值，判定有效，该 ERROR 就 ERROR
    //     （例如真读到 timeout: 300_000，那是实打实的过长，不该被放过）；
    //   · **键没读到**（值为「(缺省)」/「(未设置)」）→ 只说明我们没解析出来，
    //     不能反推「他没写」，此时降级为 WARN 不阻断。
    // 一刀切降级会让坏配置混过去；一刀切 ERROR 又会阻断健康流水线 —— 两头都错。
    const couldNotRead = /^\((?:缺省|未设置)/.test(String(value ?? ''));
    const downgrade = isFunctionalConfig && level === 'ERROR' && couldNotRead;
    findings.push({
      level: downgrade ? 'WARN' : level,
      id,
      title: downgrade ? `${title}（函数式配置，该项未读到；未阻断）` : title,
      detail: detail || '',
      value: value === undefined ? '' : String(value),
      fix: fix || '',
      file: filename,
    });
  };

  const entries = topLevelEntries(src);
  if (!entries.length && !isFunctionalConfig) {
    add('ERROR', 'CFG000', '无法解析配置对象',
      '没有找到 defineConfig({...}) 或 export default {...} / module.exports = {...} 形式的配置对象。',
      '', '确认文件是 Playwright 配置文件；若是多层封装的配置工厂，请把展开后的对象交给本工具。');
    return finish(filename, findings, facts, src);
  }
  if (!entries.length && isFunctionalConfig) {
    add('WARN', 'CFG000', '配置是函数式导出，无法静态体检（未阻断）',
      '检测到函数式配置，且一个顶层键都没能提取到。本工具不做符号求值，'
      + '因此无法判定 forbidOnly / timeout / trace 等基线项。这不是配置错误 —— '
      + '请把函数返回的那个对象展开后单独体检，或人工对照基线核对。',
      '', '把配置里对象字面量的内容单独存成一个文件，用 check_config 再跑一次。');
    const rep = finish(filename, findings, facts, src);
    rep.summary.verdict = 'UNPARSEABLE';
    rep.summary.exitCode = 0;
    return rep;
  }
  facts.keys = entries.map((e) => e.key);

  /* ---------------- ERROR 级：结论会失真的配置 ---------------- */

  // CFG001 forbidOnly
  const fo = entries.find((e) => e.key === 'forbidOnly');
  if (!fo) {
    add('ERROR', 'CFG001', '未设置 forbidOnly',
      '这是 CI 上最关键的一道保险：没有它，一个 test.only 就能让整条流水线只跑一条用例却报绿。',
      '(缺省)', 'forbidOnly: !!process.env.CI,');
  } else {
    facts.forbidOnly = fo.valueText;
    const b = boolLiteral(fo.valueText);
    if (b === false) {
      add('ERROR', 'CFG001', 'forbidOnly 被显式关闭',
        'forbidOnly: false 等于放弃这道保险。', fo.valueText, 'forbidOnly: !!process.env.CI,');
    } else if (b === null) {
      const hasCI = /process\.env\.CI/.test(fo.valueText);
      if (hasCI) {
        // 与 CI 绑定是官方推荐写法 —— 认可它，不产生任何噪音（基线的目标是 0 ERROR/0 WARN/0 INFO）。
        facts.forbidOnlyStrategy = 'env-bound';
      } else {
        add('WARN', 'CFG001', 'forbidOnly 取值无法静态判定',
          '既不是 true/false 字面量，也没看到 process.env.CI。请人工确认它在 CI 上确实为 true。',
          fo.valueText, '建议直接写成 !!process.env.CI，让它随 CI 自动生效。');
      }
    }
  }

  // CFG002 用例超时
  const to = entries.find((e) => e.key === 'timeout');
  if (!to) {
    facts.timeout = '(缺省 30000)';
  } else {
    facts.timeout = to.valueText;
    const ms = numLiteral(to.valueText);
    if (ms === null) {
      add('INFO', 'CFG002', '用例超时无法静态判定',
        '超时值来自表达式或变量，需人工确认不超过基线。', to.valueText,
        `确认最终值 <= ${BASELINE.timeoutMaxMs} ms。`);
    } else if (ms > BASELINE.timeoutMaxMs) {
      add('ERROR', 'CFG002', '用例超时过长',
        `超时 ${ms} ms 超过基线 ${BASELINE.timeoutMaxMs} ms。超时一长，所有失败都会以「超时」的形式出现，`
        + '你再也分不清是页面慢了还是功能坏了。',
        to.valueText, `降到 ${BASELINE.timeoutMaxMs}（或按项目实测基线收紧）。`);
    } else if (ms < 5_000) {
      add('WARN', 'CFG002', '用例超时过短',
        `超时 ${ms} ms 低于 5 秒，正常页面交互都可能超时，容易变成 flaky 源头。`,
        to.valueText, '按最慢的一条用例实测值 × 2 来定。');
    }
  }

  // CFG003 trace
  const trace = entries.find((e) => e.key === 'trace');
  const traceNested = nestedGet(entries, 'use', 'trace');
  const traceVal = trace ? trace.valueText : traceNested;
  facts.trace = traceVal || '(缺省 off)';
  if (traceVal === undefined || isOff(traceVal)) {
    add('ERROR', 'CFG003', '未开启 trace（失败后无现场）',
      'trace: off 或未设置时，失败现场只有一行报错 —— 没有 DOM 快照、没有网络、没有每一步的截图，'
      + '归因就只能靠猜。证据链不完整，三类归因（产品回归/用例缺陷/环境抖动）根本无从展开。',
      facts.trace, "trace: 'on-first-retry'（推荐）或 'retain-on-failure'。");
  } else {
    const s = String(traceVal);
    if (/'on'|"on"|'always'|"always"/.test(s)) {
      add('WARN', 'CFG003', 'trace 全量开启',
        'trace: on 会给每条用例都录 trace，CI 时间和磁盘占用显著上升。', traceVal,
        "改为 'on-first-retry' 或 'retain-on-failure'。");
    } else if (/'retain-on-failure'|"retain-on-failure"|'on-first-retry'|"on-first-retry"|'on-all-retries'|"on-all-retries"/.test(s)) {
      // 达标即静默（不产生 INFO 噪音）
      facts.traceStrategy = 'ok';
    }
  }

  // CFG004 reporter
  const rep = entries.find((e) => e.key === 'reporter');
  facts.reporter = rep ? rep.valueText : '(缺省 list)';
  if (!rep) {
    add('ERROR', 'CFG004', '未配置 reporter（报告不可机器消费）',
      '默认 list reporter 只给人看。失败聚类与归因需要一个机器可读的报告产物，'
      + '否则「按签名聚类再派活」这一步无法自动化。',
      facts.reporter, "reporter: [['list'], ['json', { outputFile: 'test-results/report.json' }]],");
  } else if (!/json/i.test(rep.valueText)) {
    add('WARN', 'CFG004', 'reporter 里没有 json（无法自动聚类）',
      '没有 json reporter 就拿不到结构化失败记录，summarize_report 只能靠解析文本，稳定性下降。',
      rep.valueText, "追加 ['json', { outputFile: 'test-results/report.json' }]。");
  } else {
    // 已含 json reporter —— 达标即静默（不产生 INFO 噪音）
    facts.reporterStrategy = 'ok';
  }

  /* ---------------- WARN 级：会影响稳定性与结论可信度 ---------------- */

  // CFG005 retries
  const rt = entries.find((e) => e.key === 'retries');
  facts.retries = rt ? rt.valueText : '(缺省 0)';
  if (!rt) {
    add('WARN', 'CFG005', '未设置 retries',
      '不重试时，偶发失败会混在真实失败里，无法区分「环境抖动」与「产品回归」。',
      facts.retries, 'retries: process.env.CI ? 2 : 0,');
  } else {
    const n = numLiteral(rt.valueText);
    if (n === null) {
      if (!/process\.env\.CI/.test(rt.valueText)) {
        add('INFO', 'CFG005', 'retries 无法静态判定', '需人工确认重试次数在合理区间。', rt.valueText, '建议 1–3 次。');
      }
    } else if (n > BASELINE.retriesMax) {
      add('WARN', 'CFG005', 'retries 过多，会掩盖真实回归',
        `重试 ${n} 次意味着一条真坏的用例也可能在某一轮侥幸通过，回归就会被漏掉。`,
        rt.valueText, `降到 ${BASELINE.retriesMax} 次以内。`);
    } else if (n === 0) {
      // retries 显式为 0：本地开发常见写法。作为配置基线不算问题，静默通过。
      facts.retriesStrategy = 'explicit-zero';
    }
  }

  // CFG006 workers
  const wk = entries.find((e) => e.key === 'workers');
  facts.workers = wk ? wk.valueText : '(缺省)';
  if (!wk) {
    add('WARN', 'CFG006', '未设置 workers 上限',
      'worker 数不设限时，CI 机器上会按 CPU 核数拉满浏览器进程，'
      + '资源争抢会制造出与代码无关的失败 —— 这正是「环境抖动」类失败的主要来源。',
      facts.workers, 'workers: process.env.CI ? 2 : undefined,');
  } else if (numLiteral(wk.valueText) === null && !/process\.env/.test(wk.valueText)) {
    add('INFO', 'CFG006', 'workers 无法静态判定', '', wk.valueText, '人工确认 CI 上有上限。');
  }

  // CFG007 失败证据：screenshot / video
  const shot = nestedGet(entries, 'use', 'screenshot');
  const video = nestedGet(entries, 'use', 'video');
  facts.screenshot = shot || '(缺省 off)';
  facts.video = video || '(缺省 off)';
  if (shot === undefined && video === undefined) {
    add('WARN', 'CFG007', '失败时没有 screenshot / video 证据',
      '结果回译要附「对应步骤截图」才有说服力；没有截图，同事看完结论仍会来找人确认，封装就白做了。',
      '', "use: { screenshot: 'only-on-failure', video: 'retain-on-failure' },");
  } else if (shot !== undefined && /'on'|"on"/.test(String(shot))) {
    add('WARN', 'CFG007', 'screenshot 全量开启', '每条用例都截图会显著拖慢 CI。', shot, "改为 'only-on-failure'。");
  }

  // CFG008 actionTimeout：必须短于用例超时
  const at = nestedGet(entries, 'use', 'actionTimeout');
  facts.actionTimeout = at || '(缺省 0 = 无限)';
  const atMs = numLiteral(at);
  const toMs = numLiteral(to ? to.valueText : undefined);
  if (at === undefined) {
    add('WARN', 'CFG008', '未设置 actionTimeout',
      'actionTimeout 缺省为 0（不单独限时），于是一个点不动的按钮会一直等到整条用例超时，'
      + '失败信息只剩「用例超时」。把它压到短于用例超时，操作级超时会先暴露，直接指向那个元素。',
      facts.actionTimeout, 'use: { actionTimeout: 3000 },（务必短于 timeout）');
  } else if (atMs !== null && toMs !== null && atMs >= toMs) {
    add('ERROR', 'CFG008', 'actionTimeout 不小于用例 timeout',
      `actionTimeout ${atMs} ms >= timeout ${toMs} ms：操作级超时永远不会先触发，`
      + '等于没有配置它，「操作超时」与「整条用例超时」再也分不开。',
      `${at} vs ${to ? to.valueText : ''}`, '让 actionTimeout 明显短于 timeout（如 3000 vs 30000）。');
  }

  // CFG009 expect 超时
  const et = nestedGet(entries, 'expect', 'timeout');
  facts.expectTimeout = et || '(缺省 5000)';
  const etMs = numLiteral(et);
  if (etMs !== null && etMs > BASELINE.expectTimeoutMaxMs) {
    add('WARN', 'CFG009', 'expect 超时偏长',
      `断言超时 ${etMs} ms 超过基线 ${BASELINE.expectTimeoutMaxMs} ms，断言失败要等很久才报，`
      + '而且长断言超时容易被误归因成「操作超时」。', et, `建议 <= ${BASELINE.expectTimeoutMaxMs}。`);
  }

  /* ---------------- INFO 级：环境与可移植性 ---------------- */

  // CFG010 baseURL
  const bu = nestedGet(entries, 'use', 'baseURL');
  facts.baseURL = bu || '(未设置)';
  if (bu === undefined) {
    add('INFO', 'CFG010', '未设置 baseURL',
      'baseURL 交给配置后，用例里只写相对路径，切环境不用改用例；'
      + '同时也能从机制上避免用例里出现生产域名。', facts.baseURL, "use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },");
  }

  // CFG011 testDir
  const td = entries.find((e) => e.key === 'testDir');
  facts.testDir = td ? td.valueText : '(缺省 当前目录)';
  if (!td) {
    add('INFO', 'CFG011', '未设置 testDir',
      '不限定目录时，扫描器与运行器都可能跑到不该跑的文件。',
      facts.testDir, "testDir: './tests',");
  }

  // CFG012 生产环境保护
  const usesProdGuard = /process\.env\.(?:BASE_URL|PW_BASE_URL|TEST_ENV|ALLOW_PROD)/.test(src);
  if (!usesProdGuard) {
    add('INFO', 'CFG012', '未见环境开关（生产保护）',
      '建议把可跑环境锁在 test / staging：由环境变量注入 baseURL，并在 CI 上显式拒绝生产域名，'
      + '生产验证走独立审批，避免误触真实交易。',
      '', "baseURL: process.env.BASE_URL, 并在 CI 校验 BASE_URL 不含 prod。");
  }

  const out = finish(filename, findings, facts, src);
  if (isFunctionalConfig) {
    // 尽力体检的结论要如实标注「解析可能不完整」，并**不阻断** ——
    // 否则一条合法配置会被误判成必须修的问题。
    out.summary.verdict = 'UNPARSEABLE';
    out.summary.exitCode = 0;
    out.summary.note = '检测到函数式配置：键值判定是尽力而为，缺失类结论不作为阻断依据。'
      + '建议把函数返回的对象展开后单独体检。';
  }
  return out;
}

function finish(filename, findings, facts, src) {
  const errorCount = findings.filter((f) => f.level === 'ERROR').length;
  const warnCount = findings.filter((f) => f.level === 'WARN').length;
  const infoCount = findings.filter((f) => f.level === 'INFO').length;
  // 版本感知：Playwright 变化很快，把过时写法写进 Skill 等于给团队埋雷
  const m = /"@playwright\/test"\s*:\s*"[\^~]?(\d+)\.(\d+)\.(\d+)/.exec(src);
  const version = m ? `${m[1]}.${m[2]}.${m[3]}` : null;
  return {
    tool: 'check_config',
    version: 1,
    file: filename,
    playwrightVersionInConfig: version,
    facts,
    summary: {
      errorCount, warnCount, infoCount,
      exitCode: errorCount > 0 ? 1 : 0,
      verdict: errorCount > 0 ? 'BLOCK' : (warnCount > 0 ? 'PASS_WITH_WARNINGS' : 'PASS'),
    },
    findings,
  };
}

/** 体检一个配置文件路径。 */
export function checkConfig(file) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      tool: 'check_config', version: 1, file,
      facts: {},
      summary: { errorCount: 1, warnCount: 0, infoCount: 0, exitCode: 1, verdict: 'BLOCK' },
      findings: [{ level: 'ERROR', id: 'CFG000', title: '配置文件读取失败', detail: e.message, value: '', fix: '', file }],
    };
  }
  return checkConfigSource(src, file);
}

/** 自动寻找项目里的 playwright 配置文件。 */
export function findConfigFiles(dir) {
  const names = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mts',
    'playwright.config.mjs', 'playwright.config.cts', 'playwright.config.cjs'];
  const out = [];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

export function formatText(report) {
  const out = [];
  out.push(`check_config  ${report.file}`);
  if (report.playwrightVersionInConfig) out.push(`配置中声明的 Playwright 版本: ${report.playwrightVersionInConfig}`);
  out.push('');
  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  for (const f of [...report.findings].sort((a, b) => order[a.level] - order[b.level])) {
    out.push(`[${f.level.padEnd(5)}] ${f.id}　${f.title}`);
    if (f.detail) out.push(`        ${f.detail}`);
    if (f.value) out.push(`        当前值: ${f.value.replace(/\s+/g, ' ').slice(0, 120)}`);
    if (f.fix && f.level !== 'INFO') out.push(`        修法:   ${f.fix}`);
    else if (f.fix) out.push(`        建议:   ${f.fix}`);
  }
  out.push('');
  out.push(`汇总: ERROR ${report.summary.errorCount} / WARN ${report.summary.warnCount} / INFO ${report.summary.infoCount}`);
  out.push(`结论: ${report.summary.verdict}（退出码 ${report.summary.exitCode}）`);
  return out.join('\n');
}

export default { checkConfig, checkConfigSource, formatText, findConfigFiles, BASELINE };
