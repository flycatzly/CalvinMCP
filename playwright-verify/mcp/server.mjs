#!/usr/bin/env node
/**
 * playwright-verify-mcp — MCP server (stdio, JSON-RPC 2.0)
 *
 * 设计目标（对齐 calvin-db-mcp 的既有风格：手写协议循环、零协议框架）：
 *  1) 零依赖：不装 MCP SDK。协议只有 initialize / tools/list / tools/call 三个动作，
 *     手写循环比起引入一整套 SDK 更好审计，也不会因为 SDK 升级而改行为。
 *  2) 结果落盘优先：长产物（快照/截图/日志/报告）一律写文件，工具返回路径与摘要。
 *     这是省 Token 的关键 —— 把完整页面状态反复灌进上下文，后面的断言与失败定位会被挤掉。
 *  3) 门禁有阻断力：lint / check_config / generate 的 ERROR 通过 exitCode 与 isError 表达，
 *     只有这样才能挂进 CI。只有 WARN 的检查等于没有检查。
 *  4) 绝不静默成功：任何失败都返回 isError:true + 人能看懂的原因，不让调用方拿到假的成功。
 *
 * 协议版本：官方 client 支持 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07。
 * 按 MCP 规范：客户端请求的版本若在支持列表内就回同一个，否则回我们最高的版本。
 *
 * Env:
 *   PVMCP_CWD          默认工作目录（默认 process.cwd()）
 *   PVMCP_LOG          日志文件路径（默认不写日志；设了就写，便于排查协议问题）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { lint, lintSource, formatText as lintText, RULES } from './lib/lint.js';
import { checkConfig, formatText as cfgText, BASELINE } from './lib/configcheck.js';
import { summarize, summarizeFile, formatText as sumText, CATEGORIES } from './lib/signature.js';
import { runPlaywright, playwrightVersion, resolvePlaywrightRunner } from './lib/runner.js';
import { runCli, cliHealthCheck, ARTIFACT_DIRS, CLI_ALLOWLIST } from './lib/cli.js';
import { generate, writeGenerated, locatorExpr } from './lib/generate.js';
import { checkStandards, formatText as stdText, renderStandardsMd } from './lib/standards.js';
import { orchestrate, readCases, resolvePython } from './lib/orchestrate.js';
import { boolArg, numArg, arrayArg } from './lib/args.js';
import { maskComments, maskCommentsAndStrings, selfCheck as tokenizerSelfCheck } from './lib/tokenizer.js';
import { llmChatJson, llmStatus, resolveLlm } from './lib/llmclient.js';
import { buildPlanMessages, normalizePlan, fallbackPlan, verdictOf, PLAN_MAX_STEPS } from './lib/nlplan.js';
import {
  assertGoalAllowed, assertTargetAllowed, executePlan, buildReport, writeReport,
} from './lib/agent.js';
import {
  FACTS_EVAL_FN, factsPath, judgeImages, classifyLinks, probeLinks, judgeExplore, parseConsoleErrors, readFacts,
} from './lib/explore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 版本单一真相源是 package.json（避免 server 与文档各写一个版本号而漂移）。 */
export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '1.0.0';
  } catch { return '1.0.0'; }
})();

const SERVER_NAME = 'playwright-verify';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const DEFAULT_CWD = process.env.PVMCP_CWD || process.cwd();

/* ------------------------------------------------------------------ *
 * 日志（可选）
 * ------------------------------------------------------------------ */
const LOG_FILE = process.env.PVMCP_LOG || '';
function log(msg) {
  if (!LOG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不能影响主流程 */ }
}

/* ------------------------------------------------------------------ *
 * 工具实现
 * ------------------------------------------------------------------ */

/** 把结果整理成「给模型看的文本」+「结构化数据」。 */
function result(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}
function fail(text, structured) {
  return { content: [{ type: 'text', text }], isError: true, structuredContent: structured };
}

const TOOLS = [
  /* ---------------- 验收线 ---------------- */
  {
    name: 'check_config',
    title: '配置基线体检',
    description:
      '体检 Playwright 配置基线，规则 CFG001–CFG012。放在流水线最前面：配置错的时候后面全是白干 —— '
      + '没有 forbidOnly，.only 会带着一条用例进 CI；timeout 拉到 300 秒，任何失败都会以「超时」的样子出现。'
      + 'ERROR 存在时返回 isError:true 且 structuredContent.exitCode=1。'
      + '判据不明时（表达式、变量）降级为 INFO 交人确认，绝不因为算不出来就误报。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '配置文件路径；不传则在 cwd 下自动寻找 playwright.config.{ts,js,mts,mjs,cts,cjs}' },
        cwd: { type: 'string', description: '工作目录（默认服务启动目录）' },
        format: { type: 'string', enum: ['text', 'json'], description: '返回格式，默认 text' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = args.cwd || DEFAULT_CWD;
      let file = args.file;
      if (!file) {
        const { findConfigFiles } = await import('./lib/configcheck.js');
        const found = findConfigFiles(cwd);
        if (!found.length) {
          return fail(`在 ${cwd} 下没找到 playwright.config.*。请用 file 参数指定配置文件路径。`, { error: 'CONFIG_NOT_FOUND', cwd });
        }
        file = found[0];
      }
      const rep = checkConfig(path.resolve(cwd, file));
      const text = args.format === 'json' ? JSON.stringify(rep, null, 2) : cfgText(rep);
      // 阻断与否**看 exitCode，不看 errorCount**。
      // 原因：函数式配置可能「读到了坏值、但读不到某些键」，此时 errorCount>0 而 exitCode 仍为 0
      // （我们明确不因自身解析能力的边界去阻断别人的流水线）。若这里用 errorCount 判定，
      // 就会把「不该阻断」的情况变成 isError —— 前后自相矛盾。
      const blocked = rep.summary.exitCode !== 0;
      if (blocked) {
        return fail(`${text}\n\n[门禁] 有 ${rep.summary.errorCount} 个 ERROR，配置不可信，`
          + '后面的检查与执行结论都会失真。', rep);
      }
      if (rep.summary.verdict === 'UNPARSEABLE') {
        return result(`${text}\n\n[提示] 检测到函数式配置：键值判定是尽力而为，`
          + '缺失类结论不作为阻断依据；建议把函数返回的对象展开后单独体检。', rep);
      }
      return result(text, rep);
    },
  },
  {
    name: 'lint_spec',
    title: '用例静态扫描',
    description:
      '扫描 Playwright 用例，20 条规则分 ERROR（阻断，退出码 1）/ WARN（人工确认）。'
      + `核心规则：PW001 固定时长等待、PW002 .only 泄漏、PW003 绝对 XPath、PW004 nth-child、PW005 force:true、`
      + 'PW006 断言没 await、PW007 用例无断言、PW008 断言降级成 JS 判断、PW009 只用 toHaveCount、PW010 CSS 类名、'
      + 'PW011 位置收敛、PW012 networkidle、PW013 超时放宽过百秒、PW014 :visible 旧写法；'
      + '补充规则 PW101–PW104、PW106、PW107。'
      + '检测在等长脱敏文本上跑、证据回原文取，所以行号与证据一定对得上。'
      + 'ERROR 存在时 isError:true（这样才能挂进 CI —— 只有 WARN 的检查等于没有检查）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '要扫描的文件或目录（目录会递归找 *.spec.* / *.test.*）' },
        cwd: { type: 'string', description: '工作目录' },
        include: { type: 'array', items: { type: 'string' }, description: '自定义文件名后缀过滤，如 [".spec.ts"]' },
        exclude: { type: 'array', items: { type: 'string' }, description: '路径包含这些子串则跳过' },
        disableRules: { type: 'array', items: { type: 'string' }, description: '要关闭的规则 id，如 ["PW011"]' },
        severityOverrides: { type: 'object', description: '覆盖某些规则的级别，如 {"PW011":"ERROR"}' },
        tiers: { type: 'array', items: { type: 'string', enum: ['core', 'ext'] }, description: '只跑哪些档位的规则，默认全跑' },
        format: { type: 'string', enum: ['text', 'json'], description: '返回格式，默认 text' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = args.cwd || DEFAULT_CWD;
      const target = path.resolve(cwd, args.target);
      if (!fs.existsSync(target)) return fail(`目标不存在：${target}`, { error: 'NOT_FOUND', target });
      const rep = lint(target, {
        include: args.include, exclude: args.exclude, tiers: args.tiers,
        ruleConfig: { disableRules: args.disableRules, severityOverrides: args.severityOverrides },
      });
      const text = args.format === 'json' ? JSON.stringify(rep, null, 2) : lintText(rep);
      return rep.summary.errorCount > 0
        ? fail(`${text}\n\n[门禁] ERROR 必须清零才能合入 —— 这是本门禁的阻断条件。`, rep)
        : result(text, rep);
    },
  },
  {
    name: 'summarize_report',
    title: '失败聚类与归因',
    description:
      '解析 Playwright JSON 报告，做 ANSI 清洗 + 失败签名归一化 + 四类归因聚类。'
      + '归因类别：locator-strict（定位器命中多个元素）/ assertion（断言未成立，产品回归或断言写错，必须人判）/ '
      + 'locator-not-found（定位器找不到元素）/ timeout（操作等待超时，先查定位器）/ env（环境不可达）。'
      + '核心价值：把 N 条失败压成 M 个根因签名，派活口径从「一条失败一个人」变成「一个签名一份工作量」；'
      + '偶发（重试后通过）单独列出，不混进失败聚类。'
      + '判定与签名吃同一份清洗后的文本 —— 这是「断言失败被归成超时」那个缺陷的修法。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Playwright JSON 报告路径（reporter: [["json",{outputFile:...}]] 的产物）' },
        json: { type: 'object', description: '直接传报告对象（若已有 JSON，可省去读文件）' },
        cwd: { type: 'string', description: '工作目录' },
        format: { type: 'string', enum: ['text', 'json'], description: '返回格式，默认 text' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = args.cwd || DEFAULT_CWD;
      let rep;
      if (args.json) rep = summarize(args.json, { file: '(inline)' });
      else if (args.file) {
        const f = path.resolve(cwd, args.file);
        if (!fs.existsSync(f)) {
          return fail(`报告不存在：${f}。请确认配置里有 json reporter（见 check_config 的 CFG004），`
            + '并且用例确实跑过。', { error: 'NOT_FOUND', file: f });
        }
        rep = summarizeFile(f);
      } else {
        return fail('需要 file 或 json 之一。', { error: 'BAD_ARGS' });
      }
      if (rep.error) return fail(rep.error, rep);
      const text = args.format === 'json' ? JSON.stringify(rep, null, 2) : sumText(rep);
      return result(text, rep);
    },
  },

  /* ---------------- 执行线 ---------------- */
  {
    name: 'run_verify',
    title: '执行验证（落盘执行）',
    description:
      '在指定项目里跑 Playwright 用例。输出重定向到文件而不是管道（沙箱下管道捕获不可用，且长回归日志本来也不该进内存）。'
      + 'execution=false（默认）时只做环境自检与干跑，不真正执行 —— 先确认环境再谈用例。'
      + '真实执行后建议紧接着调 summarize_report 做归因。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '项目根目录（需有 node_modules/@playwright/test）' },
        files: { type: 'array', items: { type: 'string' }, description: '要跑的用例文件（相对 cwd），不传则跑全部' },
        config: { type: 'string', description: '配置文件路径（相对 cwd）' },
        grep: { type: 'string', description: '只跑标题匹配该正则的用例' },
        project: { type: 'string', description: '只跑指定 project（如 chromium）' },
        retries: { type: 'number', description: '覆盖重试次数' },
        env: { type: 'object', description: '额外环境变量，如 {"BASE_URL":"http://localhost:3000"}' },
        timeoutMs: { type: 'number', description: '整体超时（默认 600000）' },
        execution: { type: 'boolean', description: '是否真正执行；默认 false 只干跑自检' },
      },
      required: ['cwd'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd);
      if (!fs.existsSync(cwd)) return fail(`目录不存在：${cwd}`, { error: 'NOT_FOUND', cwd });
      const runner = resolvePlaywrightRunner(cwd);
      const version = await playwrightVersion(cwd);
      if (!runner) {
        return fail(
          `${cwd} 下找不到 Playwright。请先在该项目执行：\n`
          + '  npm i -D @playwright/test && npx playwright install chromium\n'
          + '（这就是硬规则 3「先验证再保存」的前置条件 —— 没装运行器就不能声称脚本通过。）',
          { error: 'PLAYWRIGHT_NOT_INSTALLED', cwd },
        );
      }
      const pwArgs = [];
      if (args.config) pwArgs.push('--config', args.config);
      if (args.grep) pwArgs.push('--grep', args.grep);
      if (args.project) pwArgs.push('--project', args.project);
      if (args.retries !== undefined) pwArgs.push('--retries', String(args.retries));
      if (args.files && args.files.length) pwArgs.push(...args.files);

      if (!boolArg(args.execution, 'execution', false)) {
        return result(
          `[干跑] 环境已就绪，未真正执行。\n`
          + `  运行器: ${runner.how}\n  Playwright 版本: ${version || '(未知)'}\n`
          + `  将执行: playwright test ${pwArgs.join(' ')}\n\n`
          + '把 execution 设为 true 才会真正跑。建议先确认 baseURL/环境可用（见 dry run 结论），再开执行。',
          { dryRun: true, runner: runner.how, version, args: pwArgs },
        );
      }

      const res = await runPlaywright({
        cwd,
        args: pwArgs,
        env: args.env || {},
        timeoutMs: args.timeoutMs || 600_000,
        logDir: path.join(cwd, ARTIFACT_DIRS.logs),
      });
      const tail = (res.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(-30).join('\n');
      const head = {
        cwd, runner: runner.how, version,
        exitCode: res.code, durationMs: res.durationMs, timedOut: res.timedOut,
        logFiles: { stdout: res.stdoutFile, stderr: res.stderrFile },
        message: res.message,
      };
      const text = `执行完成：退出码 ${res.code}（${Math.round((res.durationMs || 0) / 1000)}s）\n`
        + `日志：${res.stdoutFile}\n\n--- 输出尾部 ---\n${tail}\n\n`
        + '下一步：用 summarize_report 解析 test-results/report.json 做失败聚类与归因。';
      return res.code === 0 ? result(text, head) : fail(text, head);
    },
  },
  {
    name: 'cli_session',
    title: 'CLI 会话操作（产出落盘）',
    description:
      '通过 @playwright/cli 驱动浏览器，**任何产出一律先落盘**：快照→.playwright-artifacts/snapshots（markdown）、'
      + '截图→screenshots（png）、trace→traces、日志→logs。返回值只给路径与摘要，不返回全文 —— '
      + '这是省 Token 的关键：把完整页面状态反复灌进模型，后面的断言、截图、失败定位全会被挤掉。'
      + 'open 之前建议先调 cli_health 验收最小闭环（能开页面、能拿快照、能截图）。'
      + '调试用 headed=true，回归保持无头（默认），免得有头窗口被带进夜间回归。',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          description: 'CLI 子命令，如 open / goto / click / fill / snapshot / screenshot / console / requests / '
            + 'tracing-start / tracing-stop / state-save / close。完整白名单见 references/cli-mode.md。',
        },
        args: { type: 'array', items: { type: 'string' }, description: '子命令的位置参数与选项，如 ["https://example.com"] 或 ["e12"]' },
        session: { type: 'string', description: '会话名（多流程/多标签隔离），默认 default' },
        headed: { type: 'boolean', description: '调试用有头模式；默认 false（回归无头）' },
        cwd: { type: 'string', description: '工作目录（产物落在这里的 .playwright-artifacts/）' },
        timeoutMs: { type: 'number', description: '超时（默认 120000）' },
      },
      required: ['subcommand'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd || DEFAULT_CWD);
      const res = await runCli({
        cwd,
        session: args.session || 'default',
        subcommand: args.subcommand,
        args: args.args || [],
        headed: boolArg(args.headed, 'headed', false),
        timeoutMs: args.timeoutMs || 120_000,
      });
      const lines = [
        `[${res.ok ? 'OK' : 'FAIL'}] playwright-cli ${res.subcommand}（session=${res.session}）`,
        res.summary || '',
        res.artifacts && Object.keys(res.artifacts).length ? `产物: ${JSON.stringify(res.artifacts)}` : '',
        res.logFiles ? `日志: ${res.logFiles.stdout}` : '',
        res.stderrTail ? `\n--- stderr 尾部 ---\n${res.stderrTail}` : '',
      ].filter(Boolean);
      const text = lines.join('\n');
      return res.ok ? result(text, res) : fail(`${text}\n\n原因：${res.reason}${res.message ? `｜${res.message}` : ''}`, res);
    },
  },
  {
    name: 'cli_health',
    title: 'CLI 最小闭环验收',
    description:
      '验收「能开页面、能拿快照、能截图」这条最小闭环。建议当成团队接入 CLI 的第一条验收 —— '
      + '这三步过了，CLI 就能进测试仓库当执行器。失败时明确给出缺什么（CLI 未安装 / 浏览器未安装 / 命令不在白名单）。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '工作目录' },
        session: { type: 'string', description: '用于验收的会话名，默认 healthcheck' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd || DEFAULT_CWD);
      const res = await cliHealthCheck({ cwd, session: args.session || 'healthcheck' });
      const text = [
        res.verdict || res.message,
        ...res.steps.map((s) => `  ${s.ok ? 'PASS' : 'FAIL'} ${s.step}: ${s.summary}`),
      ].join('\n');
      return res.ok ? result(text, res) : fail(text, res);
    },
  },

  /* ---------------- 智能体线（自然语言声明式测试） ---------------- */
  {
    name: 'explore_page',
    title: '页面探索巡检（死链/坏图/表单盘点）',
    description:
      '打开页面并做确定性巡检：链接、图片、表单盘点 + 死链（HTTP 4xx/5xx）与坏图（加载完成但宽度为 0）判定。'
      + '这是探索性测试的落地 —— 判据是确定的，所以不用 LLM，用 LLM 判反而把确定的事变成概率的事。'
      + '链接探活用 HEAD 抽样（默认 20 条）：HTTP ≥400 记死链进 Fail；网络不可达只警告不进 Fail'
      + '（离线环境外链必然不可达，把环境问题算成页面问题是假警报）。'
      + '只放行 http/https；看起来是生产的主机需要显式 confirmProd=true（独立审批留痕）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要巡检的页面地址（http/https）' },
        cwd: { type: 'string', description: '工作目录（证据落在这里的 .playwright-artifacts/）' },
        session: { type: 'string', description: 'CLI 会话名，默认 explore' },
        checkLinks: { type: 'boolean', description: '是否探活链接，默认 true' },
        maxLinks: { type: 'number', description: '链接抽样上限，默认 20' },
        headed: { type: 'boolean', description: '调试用有头模式；默认 false' },
        confirmProd: { type: 'boolean', description: '生产地址的独立审批留痕：显式 true 才执行生产主机' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd || DEFAULT_CWD);
      const gate = assertTargetAllowed(args.url, { confirmProd: boolArg(args.confirmProd, 'confirmProd', false) });
      if (!gate.ok) return fail(`[拒绝] ${gate.why}`, { error: 'TARGET_REFUSED', why: gate.why });

      const session = args.session || 'explore';
      const open = await runCli({ cwd, session, subcommand: 'open', args: [args.url], headed: boolArg(args.headed, 'headed', false) });
      if (!open.ok) {
        return fail(`打开页面失败：${open.summary}\n${open.stderrTail || ''}`, { error: 'OPEN_FAILED', detail: open.summary });
      }

      // 事实采集：eval 结果显式落盘到报告目录（不回灌上下文），再从盘上解析。
      // --filename 由我们指定（eval 不在 MUST_REDIRECT 里），产物路径固定可控。
      const fFile = factsPath(cwd, session);
      const evalRes = await runCli({
        cwd, session, subcommand: 'eval', args: [FACTS_EVAL_FN, '--filename', fFile],
        headed: boolArg(args.headed, 'headed', false),
      });
      const facts = readFacts(fFile) || readFacts(evalRes.logFiles?.stdout);
      if (!facts) {
        return fail(
          `页面事实采集失败（eval 未产出可解析结果）。摘要：${evalRes.summary}\n`
          + '可改用 cli_session 的 snapshot 人工观察页面。',
          { error: 'FACTS_FAILED', detail: evalRes.summary },
        );
      }

      const images = judgeImages(facts.images || []);
      let linkResults = [];
      let classify = { probe: [], skipped: [], total: (facts.links || []).length };
      if (boolArg(args.checkLinks, 'checkLinks', true)) {
        classify = classifyLinks(facts.links || [], {
          max: Math.min(50, Math.max(1, numArg(args.maxLinks, 'maxLinks', 20))),
        });
        linkResults = await probeLinks(classify.probe);
      }

      const consoleRes = await runCli({ cwd, session, subcommand: 'console', args: [] });
      // console 全量输出在落盘日志里；解析只挑 error 级条目，不整包回灌
      const consoleText = consoleRes.logFiles?.stdout && fs.existsSync(consoleRes.logFiles.stdout)
        ? fs.readFileSync(consoleRes.logFiles.stdout, 'utf8')
        : (consoleRes.stdoutTail || '');
      const consoleErrors = parseConsoleErrors(consoleText);

      const judged = judgeExplore({ images, linkResults, consoleErrors });
      const report = {
        url: facts.url || args.url,
        title: facts.title || '',
        lang: facts.lang || '',
        forms: (facts.forms || []).map((f) => ({ action: f.action, method: f.method, inputs: (f.inputs || []).slice(0, 10) })),
        links: { total: classify.total, probed: classify.probe.length, skipped: classify.skipped.length },
        images,
        linkResults,
        consoleErrors,
        verdict: judged.verdict,
        issues: judged.issues,
        warnings: judged.warnings,
        generatedAt: new Date().toISOString(),
      };
      const reportFile = writeReport(cwd, report, 'explore');

      const lines = [
        `巡检完成：${report.verdict}　${report.url}${report.title ? `（${report.title}）` : ''}`,
        `  链接: 总数 ${classify.total} / 探活 ${classify.probe.length} / 跳过 ${classify.skipped.length}`,
        `  图片: 总数 ${images.total} / 坏图 ${images.broken.length}`,
        `  表单: ${report.forms.length} 个`,
        `  报告: ${reportFile}`,
        '',
        judged.issues.length ? `问题（${judged.issues.length}）：` : '未发现死链与坏图。',
        ...judged.issues.map((i) => `  · ${i.kind} ${i.href || i.src} ${i.status || ''} ${i.text || i.alt || ''}`.trim()),
        judged.warnings.length ? `\n警告（${judged.warnings.length}，不影响判定）：` : '',
        ...judged.warnings.slice(0, 10).map((w) => `  · ${w.kind} ${w.href || w.detail || ''}`.trim()),
      ].filter(Boolean).join('\n');

      return judged.verdict === 'Pass' ? result(lines, report) : fail(`${lines}\n\n[门禁] 存在死链或坏图，巡检不通过。`, report);
    },
  },
  {
    name: 'nl_test_goal',
    title: '自然语言测试目标（声明式测试）',
    description:
      '把「说目标，不说步骤」的测试目标转成检查清单并执行，输出 JSON Pass/Fail 报告（CI 挂门禁看 verdict 字段）。'
      + '分工是刻意的：LLM 只做规划（默认本地 Ollama，页面内容不出机；云端 DeepSeek 须显式 PVMCP_LLM=deepseek），'
      + '执行、断言判定、证据落盘全走本服务既有执行线 —— 模型编造不了「通过」。'
      + '计划动作白名单：goto/click/fill/press/expect_text/expect_visible/screenshot；'
      + '白名单外的动作拒绝并列出，绝不静默丢弃。LLM 不可用时降级为确定性骨架并如实标注 source: fallback。'
      + '守门：危险目标（真实资金/破坏性数据/生产操作/对外发送）在打开浏览器之前就被拒绝；'
      + '生产主机需要显式 confirmProd=true。断言只判定成立与否，绝不放宽。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '自然语言测试目标，如「登录后把商品加入购物车，购物车里应看到该商品」' },
        url: { type: 'string', description: '入口地址（http/https；生产主机需 confirmProd）' },
        cwd: { type: 'string', description: '工作目录（证据落在这里的 .playwright-artifacts/）' },
        session: { type: 'string', description: 'CLI 会话名，默认 nl-goal' },
        llm: { type: 'string', enum: ['auto', 'off'], description: 'auto=按环境配置走 LLM 规划（默认）；off=强制确定性骨架' },
        maxSteps: { type: 'number', description: '计划步数上限（默认 12，硬上限 20）' },
        headed: { type: 'boolean', description: '调试用有头模式；默认 false' },
        confirmProd: { type: 'boolean', description: '生产地址的独立审批留痕：显式 true 才执行生产主机' },
      },
      required: ['goal', 'url'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd || DEFAULT_CWD);
      const startedAt = new Date().toISOString();
      const goal = String(args.goal || '');

      // 守门顺序是设计：危险目标与越权地址在**打开浏览器之前**就被拒绝
      const goalGate = assertGoalAllowed(goal);
      if (!goalGate.ok) {
        return fail(
          `[拒绝] 该目标不在自动化范围内：${goalGate.why}\n`
          + '智能体线不碰真实资金与生产数据、不执行破坏性操作、不对外发送 —— 这不是免责声明，是硬拦截。',
          { error: 'GOAL_REFUSED', why: goalGate.why, goal },
        );
      }
      const targetGate = assertTargetAllowed(args.url, { confirmProd: boolArg(args.confirmProd, 'confirmProd', false) });
      if (!targetGate.ok) {
        return fail(`[拒绝] ${targetGate.why}`, { error: 'TARGET_REFUSED', why: targetGate.why });
      }

      const session = args.session || 'nl-goal';
      const cap = Math.min(PLAN_MAX_STEPS, Math.max(1, numArg(args.maxSteps, 'maxSteps', 12)));
      const forceFallback = args.llm === 'off';

      // 规划：LLM（auto）或确定性骨架（off / LLM 不可用）
      let plan;
      let source = 'fallback';
      let planNote = '';
      if (!forceFallback) {
        const cfg = resolveLlm();
        const msgs = buildPlanMessages({ goal, url: args.url, facts: null });
        const llmRes = await llmChatJson(msgs);
        if (llmRes.ok) {
          const norm = normalizePlan(llmRes.json, { goal, url: args.url });
          if (norm.ok) {
            plan = { steps: norm.steps.slice(0, cap), problems: [] };
            source = 'llm';
            planNote = `LLM 规划（${llmRes.provider}/${llmRes.model}，${llmRes.latencyMs}ms）`;
          } else {
            planNote = `LLM 规划不合法（${norm.problems.join('；')}），降级确定性骨架`;
          }
        } else {
          planNote = `LLM 不可用（${llmRes.why}），降级确定性骨架`;
        }
      } else {
        planNote = '调用方指定 llm=off，用确定性骨架';
      }
      if (!plan) {
        const fb = fallbackPlan({ goal, url: args.url });
        plan = { steps: fb.steps.slice(0, cap), problems: fb.problems };
        source = 'fallback';
      }

      const { steps: stepResults, stopped, reason } = await executePlan({ steps: plan.steps, cwd, session, headed: boolArg(args.headed, 'headed', false) });
      const report = buildReport({
        goal, url: args.url, source, plan, stepResults,
        problems: [...(plan.problems || []), ...(stopped ? [`执行在失败步骤后停止：${reason}`] : [])],
        startedAt,
      });
      report.planNote = planNote;
      const reportFile = writeReport(cwd, report, 'nl');

      const lines = [
        `判定：${report.verdict}　（来源 ${source}｜${planNote}）`,
        `目标：${goal}`,
        `入口：${args.url}`,
        '',
        '步骤：',
        ...stepResults.map((s) => `  ${s.ok ? 'PASS' : 'FAIL'} ${s.act}${s.target ? ` ${s.target}` : ''}${s.value ? ` = ${s.value}` : ''}`
          + `　${s.detail || ''}${s.evidence ? `　证据: ${s.evidence}` : ''}`),
        plan.problems?.length ? `\n计划提示：\n${plan.problems.map((p) => `  · ${p}`).join('\n')}` : '',
        `\nJSON 报告（CI 读 verdict 字段）：${reportFile}`,
        verdictOf(stepResults) === 'Pass'
          ? ''
          : '\n判定为 Fail/Blocked 时先看证据文件再定责 —— 断言不成立是事实，放宽断言不是选项。',
      ].filter(Boolean).join('\n');

      return report.verdict === 'Pass'
        ? result(lines, { ...report, reportFile })
        : fail(lines, { ...report, reportFile });
    },
  },

  /* ---------------- 生成线 ---------------- */
  {
    name: 'generate_scripts',
    title: '生成 PO 分层脚本',
    description:
      '把结构化的原子步骤翻译成 Playwright 脚本，页面层（pages/）与用例层（tests/）分开写。'
      + '这不是「让模型自由写脚本」，而是让它填空：选择器策略被锁死（只允许 role/label/testid/text/placeholder/selector，'
      + '拒绝裸 XPath 与 nth-child），未解析的占位符（${X}、{{X}}、<X>）会被拒绝而不是当字面量写进脚本。'
      + '**生成门禁**：语法检查 + lint ERROR 必须为 0 才允许写盘 —— 「脚本还没跑通就提交」是这条流程里最容易踩的坑。'
      + '每条用例必须给 claims（这条用例证明了什么），否则门禁会提示补齐。',
    inputSchema: {
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          description: '页面层定义',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '页面标识（用于用例引用）' },
              className: { type: 'string', description: '可选的类名，默认由 name 推导' },
              navPath: { type: 'string', description: '相对 baseURL 的路径，会生成 goto()' },
              steps: { type: 'array', items: { type: 'object' }, description: '该页面的原子步骤' },
            },
            required: ['name', 'steps'],
          },
        },
        cases: {
          type: 'array',
          description: '用例层定义',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '用例标题（同时用作 Playwright 的 test 名称，建议写清业务动作与预期）' },
              page: { type: 'string', description: '引用哪个 page 的 name' },
              claims: { type: 'string', description: '这条用例证明了什么（交付契约要求，缺了会在生成物里标「未声明」）' },
              steps: {
                type: 'array',
                description: '该用例的原子步骤。会优先复用页面层已有的同名方法，避免定位细节渗进用例层。',
                items: { type: 'object' },
              },
              nav: { type: 'boolean', description: '是否先调 goto()，默认 true' },
            },
            required: ['title', 'page', 'steps'],
          },
        },
        spec: { type: 'string', description: '用例文件名（不含 .spec.ts），默认 generated' },
        cwd: { type: 'string', description: '工作目录' },
        outDir: { type: 'string', description: '写盘目录；不传则只生成不写盘' },
        write: { type: 'boolean', description: '是否写盘，默认 false（先审再写）' },
        overwrite: { type: 'boolean', description: '目标已有同名文件时是否覆盖，默认 false（拒绝并列出冲突，避免抹掉手写内容）' },
      },
      required: ['pages', 'cases'],
      additionalProperties: false,
    },
    async handler(args) {
      let gen;
      try {
        gen = generate({ spec: args.spec, pages: args.pages, cases: args.cases });
      } catch (e) {
        return fail(`生成失败：${e.message}`, { error: 'GENERATE_FAILED', message: e.message });
      }
      let writeInfo = null;
      if (boolArg(args.write, 'write', false)) {
        const outDir = path.resolve(args.cwd || DEFAULT_CWD, args.outDir || 'generated');
        // 默认不覆盖已有文件：生成的页面对象可能落到人手写过、带注释的路径上，
        // 静默覆盖会直接抹掉人的工作。要覆盖必须显式传 overwrite: true。
        writeInfo = writeGenerated(gen, outDir, { overwrite: boolArg(args.overwrite, 'overwrite', false) });
      }
      const text = [
        gen.verdict,
        `语法: ${gen.syntax.passed ? 'OK' : 'FAIL'}　lint: ERROR ${gen.lint.errorCount} / WARN ${gen.lint.warnCount}`,
        `文件: ${gen.files.map((f) => f.path).join(', ')}`,
        '',
        '用例主张（交付契约）：',
        ...gen.claims.map((c) => `  · ${c.title} → ${c.claims}`),
        writeInfo ? (writeInfo.written ? `\n已写盘 ${writeInfo.files.length} 个文件。` : `\n未写盘：${writeInfo.message}`) : '\n（未写盘；确认无误后把 write 设为 true，或设为 outDir）',
        '',
        '--- 生成内容预览 ---',
        ...gen.files.map((f) => `\n===== ${f.path} =====\n${f.content}`),
      ].join('\n');
      const payload = { ...gen, write: writeInfo };
      // 门禁不过 → 以 isError 表达，避免调用方误以为可以合入
      if (!gen.lint.passed) return fail(text, payload);
      return result(text, payload);
    },
  },

  /* ---------------- 规范与编排 ---------------- */
  {
    name: 'check_standards',
    title: '团队测试规范校验',
    description:
      '校验项目 AGENTS.md / CLAUDE.md 是否覆盖四条「无论做什么任务都要遵守」的测试规范：'
      + 'STD001 证据落盘到约定目录、STD002 回归默认走 CLI + Skill（MCP 只留做探索）、'
      + 'STD003 脚本必须先验证通过再保存、STD004 快照/截图/脚本都进制品库。'
      + '找不到规范文件时返回可直接复制的模板。规范缺失不阻断流水线（它是人的约定），但会明确列出缺哪条。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '项目目录或规范文件路径' },
        cwd: { type: 'string', description: '工作目录' },
        templateOnly: { type: 'boolean', description: '只要模板，不校验' },
        format: { type: 'string', enum: ['text', 'json'], description: '返回格式，默认 text' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      if (args.templateOnly) {
        return result(`下面是可直接粘贴进 AGENTS.md 的测试规范：\n\n${renderStandardsMd()}`, { template: renderStandardsMd() });
      }
      const target = path.resolve(args.cwd || DEFAULT_CWD, args.target || '.');
      const rep = checkStandards(target);
      const text = args.format === 'json' ? JSON.stringify(rep, null, 2) : stdText(rep);
      return result(text, rep);
    },
  },
  {
    name: 'orchestrate_excel',
    title: 'Excel 用例编排执行',
    description:
      '把手工用例表（.xlsx/.xlsm/.csv）编排成可执行回归：读表 → 自然语言步骤映射成原子步骤 → '
      + '生成 PO 分层脚本（带生成门禁）→ 可选执行 → 输出结果。'
      + '**不会静默丢步骤**：映射不了的步骤原样报在 unmapped 里，由人补结构化描述 —— 宁可不做，也不能猜错。'
      + '读 Excel 用运行时的 Python + openpyxl（MCP 本体保持零依赖）。',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '用例表路径（.xlsx/.xlsm/.csv）' },
        cwd: { type: 'string', description: '工作目录' },
        outDir: { type: 'string', description: '生成脚本落点，默认 <cwd>/demo/generated-orchestrated' },
        run: { type: 'boolean', description: '是否执行；默认 false 只生成（先审脚本再跑）' },
        pageName: { type: 'string', description: '页面标识，默认 app' },
        navPath: { type: 'string', description: '页面导航路径，默认 /' },
        specName: { type: 'string', description: '用例文件名，默认 from-excel' },
        readOnly: { type: 'boolean', description: '只读表并返回映射结果，不生成脚本' },
      },
      required: ['input'],
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = args.cwd || DEFAULT_CWD;
      if (boolArg(args.readOnly, 'readOnly', false)) {
        const r = await readCases(path.resolve(cwd, args.input), { cwd });
        if (!r.ok) return fail(r.message || '读取失败', r);
        const { caseToSteps } = await import('./lib/orchestrate.js');
        const lines = [`用例表：${r.file}（sheet=${r.sheet}，${r.caseCount} 条）`, ''];
        for (const c of r.cases) {
          const m = caseToSteps(c);
          lines.push(`[第 ${c.row} 行] ${c.title}`);
          lines.push(`  映射出 ${m.steps.length} 步；无法映射 ${m.unmapped.length} 步`);
          for (const s of m.steps) lines.push(`    ✓ ${s.act} ${JSON.stringify(s.locator || s.url || '')}${s.value !== undefined ? ` = ${s.value}` : ''}${s.expect !== undefined ? ` → ${s.expect}` : ''}`);
          for (const u of m.unmapped) lines.push(`    ? 无法映射：${u}`);
        }
        if (r.warnings?.length) lines.push('', '提示：', ...r.warnings.map((w) => `  · ${w}`));
        return result(lines.join('\n'), r);
      }
      const rep = await orchestrate({
        input: path.resolve(cwd, args.input),
        cwd,
        outDir: args.outDir ? path.resolve(cwd, args.outDir) : undefined,
        run: boolArg(args.run, 'run', false),
        pageName: args.pageName || 'app',
        navPath: args.navPath || '/',
        specName: args.specName || 'from-excel',
      });
      const text = [
        `编排${rep.ok ? '完成' : '未完成'}：${rep.message || ''}`,
        '',
        ...rep.steps.map((s) => `  · ${s}`),
        rep.unmapped?.length ? `\n无法映射的步骤（${rep.unmapped.length} 条，未丢弃）：\n${rep.unmapped.map((u) => `  [第 ${u.row} 行] ${u.title}: ${u.steps.join(' / ')}`).join('\n')}` : '',
        rep.generatedFiles?.length ? `\n生成文件：${rep.generatedFiles.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      return rep.ok ? result(text, rep) : fail(text, rep);
    },
  },
  {
    name: 'explain_rules',
    title: '规则表自省',
    description:
      '列出 lint / config / 归因的完整规则表，含每条规则的级别、判据说明与修法。'
      + '用于回答「这条为什么报」「怎么关掉某条规则」。也可用来确认工具版本里的规则清单。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', enum: ['all', 'lint', 'config', 'category'], description: '看哪一组，默认 all' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const group = args.group || 'all';
      const out = {};
      if (group === 'all' || group === 'lint') {
        out.lint = RULES.map((r) => ({
          id: r.id, severity: r.severity, tier: r.tier, title: r.title, fix: r.fix,
        }));
      }
      if (group === 'all' || group === 'config') {
        out.config = {
          baseline: BASELINE,
          note: '规则 id 为 CFG001–CFG012：forbidOnly / timeout / trace / reporter / retries / workers / 证据 / '
            + 'actionTimeout / expect 超时 / baseURL / testDir / 生产保护。',
        };
      }
      if (group === 'all' || group === 'category') {
        out.category = Object.entries(CATEGORIES).map(([id, c]) => ({ id, ...c }));
      }
      const lines = [];
      if (out.lint) {
        lines.push(`## lint_spec 规则（${out.lint.length} 条）`, '');
        for (const r of out.lint) lines.push(`- **${r.id}** [${r.severity}/${r.tier}] ${r.title}`);
      }
      if (out.category) {
        lines.push('', '## 失败归因类别', '');
        for (const c of out.category) lines.push(`- **${c.id}** ${c.label}　派给: ${c.owner}　性质: ${c.nature}`);
      }
      if (out.config) {
        lines.push('', '## 配置基线阈值', '', `- 用例超时上限: ${out.config.baseline.timeoutMaxMs} ms`,
          `- expect 超时上限: ${out.config.baseline.expectTimeoutMaxMs} ms`,
          `- actionTimeout 上限: ${out.config.baseline.actionTimeoutMaxMs} ms`,
          `- retries 合理区间: ${out.config.baseline.retriesMin}–${out.config.baseline.retriesMax}`);
      }
      return result(lines.join('\n'), out);
    },
  },
  {
    name: 'selfcheck',
    title: '服务自检',
    description:
      '服务级自检：等长脱敏不变量、规则表完整性、运行器与 CLI 可用性、Python（Excel 编排用）可用性。'
      + '部署后先跑这个，比逐个人工试探快。任何一项失败都会明确说明缺什么。',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: '工作目录' } },
      additionalProperties: false,
    },
    async handler(args) {
      const cwd = path.resolve(args.cwd || DEFAULT_CWD);
      const tok = tokenizerSelfCheck();
      const runner = resolvePlaywrightRunner(cwd);
      const py = resolvePython();
      const { resolveCliRunner } = await import('./lib/runner.js');
      const cli = resolveCliRunner(cwd);
      const checks = [
        { name: '等长脱敏不变量', ok: tok.ok, detail: tok.ok ? `${tok.checked} 组样例通过` : tok.problems.join('; ') },
        { name: '规则表', ok: RULES.length >= 14, detail: `${RULES.length} 条（ERROR ${RULES.filter((r) => r.severity === 'ERROR').length} / WARN ${RULES.filter((r) => r.severity === 'WARN').length}）` },
        { name: 'Playwright 运行器', ok: !!runner, detail: runner ? runner.how : '未安装（执行类工具不可用，其余工具不受影响）', optional: true },
        { name: 'playwright-cli', ok: !!cli, detail: cli ? cli.how : '未安装（CLI 类工具不可用）', optional: true },
        { name: 'Python（Excel 编排）', ok: !!py, detail: py || '未找到（orchestrate_excel 用 .csv 仍可用）', optional: true },
        (() => {
          const llm = llmStatus();
          const ok = llm.provider !== 'deepseek' || !!resolveLlm().hasKey;
          return { name: 'LLM（智能体线）', ok, detail: `${llm.provider}${llm.model ? `/${llm.model}` : ''}：${llm.why}`, optional: true };
        })(),
      ];
      const required = checks.filter((c) => !c.optional);
      const ok = required.every((c) => c.ok);
      const text = [
        `playwright-verify-mcp 自检（协议 ${LATEST_PROTOCOL_VERSION}，工具 ${TOOLS.length} 个）`,
        '',
        ...checks.map((c) => `  ${c.ok ? 'PASS' : (c.optional ? 'SKIP' : 'FAIL')} ${c.name}: ${c.detail}`),
        '',
        ok ? '必需项全部通过。' : '有关键项失败，请按上面的说明补齐。',
      ].join('\n');
      return ok ? result(text, { checks, version: VERSION, protocolVersion: LATEST_PROTOCOL_VERSION }) : fail(text, { checks });
    },
  },
];

/* ------------------------------------------------------------------ *
 * JSON-RPC / MCP 协议循环（手写，零框架）
 * ------------------------------------------------------------------ */

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function makeResponse(id, payload) { return { jsonrpc: '2.0', id, ...payload }; }
function makeError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function writeMessage(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 按 MCP 规范协商协议版本。 */
function negotiateVersion(requested) {
  if (requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return LATEST_PROTOCOL_VERSION;
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  // 按 JSON-RPC 2.0：没有 id 就是通知，通知**永远不产生响应**（成功或失败都不回）。
  // 每个分支都必须尊重这一点 —— 曾经因为 ping 分支直接 return 响应，
  // 导致「无 id 的 ping」回了消息，破坏了通知语义。
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const protocolVersion = negotiateVersion(params?.protocolVersion);
        log(`initialize client=${params?.clientInfo?.name || '?'}@${params?.clientInfo?.version || '?'} `
          + `requested=${params?.protocolVersion} → ${protocolVersion}`);
        if (isNotification) return null;
        return makeResponse(id, {
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: VERSION },
            instructions:
              'Playwright 端到端测试的「验收 / 门禁 / 执行」工具集。'
              + '推荐顺序：check_config（配置是否可信）→ lint_spec（合入前 ERROR 清零）→ run_verify（执行）→ '
              + 'summarize_report（失败聚类归因）；探索页面用 cli_health + cli_session；'
              + '生成脚本用 generate_scripts（带生成门禁）；'
              + '智能体线（声明式测试）：说目标不说步骤用 nl_test_goal（LLM 只做规划，执行与断言走本服务，输出 JSON Pass/Fail），'
              + '死链/坏图巡检用 explore_page。'
              + '硬规则：不自动修改断言（healer 可提议，人必须来判）；凭据只从环境变量读，绝不写死在脚本里；'
              + '默认只允许 test/staging 环境，生产验证要走独立审批；不碰真实资金与生产数据。'
              + '长产物一律落盘到 .playwright-artifacts/，工具返回路径与摘要，请按需读取文件而不是要求返回全文。',
          },
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return null;   // 通知不需要响应

      case 'ping':
        log(`ping id=${id === undefined ? '(notification)' : id}`);
        return isNotification ? null : makeResponse(id, { result: {} });

      case 'tools/list':
        return isNotification ? null : makeResponse(id, {
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        });

      case 'tools/call': {
        const name = params?.name;
        const tool = TOOL_MAP.get(name);
        if (!name) {
          return isNotification ? null : makeError(id, -32602, '缺少参数 name（要调用的工具名）', { available: [...TOOL_MAP.keys()] });
        }
        if (!tool) {
          // 未知工具按协议返回错误（-32602 无效参数），而不是静默成功
          return isNotification ? null : makeError(id, -32602, `未知工具：${name}`, { available: [...TOOL_MAP.keys()] });
        }
        const started = Date.now();
        try {
          const out = await tool.handler(params?.arguments || {});
          log(`tools/call ${name} ${Date.now() - started}ms ${out.isError ? 'ERROR' : 'ok'}`);
          return isNotification ? null : makeResponse(id, { result: out });
        } catch (e) {
          // 工具内部异常：转成 isError 结果，让调用方看到真实原因
          log(`tools/call ${name} threw: ${e.stack || e.message}`);
          if (isNotification) return null;
          return makeResponse(id, {
            result: {
              content: [{ type: 'text', text: `工具执行异常：${e.message}` }],
              isError: true,
              structuredContent: { error: 'TOOL_EXCEPTION', message: e.message },
            },
          });
        }
      }

      case 'resources/list':
        return isNotification ? null : makeResponse(id, { result: { resources: [] } });
      case 'prompts/list':
        return isNotification ? null : makeResponse(id, { result: { prompts: [] } });

      default:
        return isNotification ? null : makeError(id, -32601, `不支持的方法：${method}`);
    }
  } catch (e) {
    log(`handler error for ${method}: ${e.stack || e.message}`);
    if (isNotification) return null;
    return makeError(id, -32603, `服务内部错误：${e.message}`);
  }
}

export function startServer() {
  // 用 readline 逐行读 NDJSON。stdio 传输下每条消息一行，这是 MCP 的规定。
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      // 解析失败没有 id 可用，按协议返回 id:null
      writeMessage(makeError(null, -32700, `JSON 解析失败：${e.message}`));
      return;
    }
    // 串行处理，保证响应顺序与请求一致（工具调用可能很慢，并发会让输出交错）
    queue = queue.then(async () => {
      const res = await handleMessage(msg);
      if (res) writeMessage(res);
    }).catch((e) => {
      log(`queue error: ${e.stack || e.message}`);
    });
  });

  rl.on('close', () => {
    log('stdin closed, exiting');
    process.exit(0);
  });
}

/* 直接运行则启动；被 import（自检）时不启动。
 *
 * 判定方式：把 argv[1] 解析成真实路径，与 import.meta.url 比较。
 * 为什么不用 `/server\.mjs$/.test(argv[1])` 那种正则：
 *   客户端完全可能用别名、软链或复制品来启动（例如包装脚本、或装到别的文件名下）。
 *   正则匹配不上 → **不启动 stdio 循环 → 一个工具都不出现，而且没有任何报错**。
 *   这是最难查的一类故障：进程活着、退出码 0，只是永远不响应。
 *   按真实路径比较可以免疫改名与软链。
 * 保留环境变量兜底：某些宿主会用 `node --eval` 或包装器改变 argv，届时用 PVMCP_FORCE_LISTEN=1 强制启动。
 */
function isMainModule() {
  if (process.env.PVMCP_FORCE_LISTEN === '1') return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule() && process.env.PVMCP_NO_LISTEN !== '1') {
  log(`starting ${SERVER_NAME} v${VERSION} cwd=${DEFAULT_CWD}`);
  startServer();
}

export { TOOLS, handleMessage, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION };
