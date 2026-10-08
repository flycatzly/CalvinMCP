#!/usr/bin/env node
// web-rpa-mcp — MCP 服务器（stdio / JSON-RPC 2.0，零依赖协议层）
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  DIRS, ROOT, MCP_DIR, ensureDirs, readConfig, writeConfig, ok, fail,
  logger, maskSecret, redactPath, nowIso, readJson, DEFAULT_CONFIG, validateArgs, SAFE_ID_PATTERN,
} from './lib/core.mjs';
import {
  listFlows, loadFlow, saveFlow, deleteFlow, requireFlow, listRuns, loadRun,
  flowMarkdown, stepLabel, newFlowId, listBackups, restoreFlow, backupFlow,
} from './lib/store.mjs';
import { lintFlow } from './lib/lint.mjs';
import { runFlow, preflightFlow } from './lib/player.mjs';
import { runChain } from './lib/chain.mjs';
import {
  startRecording, stopRecording, cancelRecording, recordingStatus, activeSession, startSplice,
} from './lib/recorder.mjs';
import {
  addSchedule, listSchedules, removeSchedule, runScheduleNow, queryTask, isWindows,
} from './lib/schedule.mjs';
import { statusReport, pruneRuns, pruneAllRuns, pruneLogs, lockInfo, releaseLock } from './lib/ops.mjs';
import { sendNotify, composeRunMessage, shouldNotify, outboxInfo } from './lib/notify.mjs';
import { setSecret, listSecrets, deleteSecret } from './lib/secrets.mjs';
import {
  getPlaywright, detectBrowserPlan, detectFfmpeg, closeAll, openCount,
  launchContext, closeContext, profileInfo, resetProfile,
} from './lib/browser.mjs';
import { resolveParams, describeParams, fromTable } from './lib/vars.mjs';
import { readTable, resolveColumn } from './lib/table.mjs';

const VERSION = '1.8.3';
const L = logger('server');

const PROTOCOL_FALLBACK = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

/* ------------------------------------------------------------------ */
/* 工具表                                                              */
/* ------------------------------------------------------------------ */

const TOOLS = [];
function tool(name, description, inputSchema, handler) {
  TOOLS.push({ name, description, inputSchema: inputSchema || { type: 'object', properties: {} }, handler });
}

const S_FLOW = { type: 'string', description: '流程 id（1–128 字符，不得含路径分隔符等特殊符号）', pattern: SAFE_ID_PATTERN };
const S_IDX = { type: 'integer', minimum: 1, description: '步骤序号（从 1 开始）' };

/** 改动/删除流程前先快照磁盘上的当前定义：flow_restore 才能在改坏后一键回滚（每个流程最多留 10 份） */
function snapshot(id) {
  try { backupFlow(id); } catch (e) { L.warn('流程备份失败（不阻断本次改动）', { id, err: String(e && e.message ? e.message : e) }); }
}

/* ---------------- 录制 ---------------- */

tool('record_start',
  '开始录制：打开一个可见浏览器窗口，人类在其中把日常的网页操作演示一遍，所有点击/填写/选择/跳转都会被记录成步骤。演示完调用 record_stop 生成技能。遇到验证码/登录态/敏感系统请勿录制，改用 humanHandoff。',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: '起始网址（录制从打开这个页面开始）' },
      name: { type: 'string', description: '技能名称（后续可用 record_stop 覆盖）' },
      viewport: { type: 'object', properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } } },
    },
  },
  async (a) => {
    const r = await startRecording(a);
    return r.ok ? ok(r, '录制已开始，请在刚打开的浏览器里演示你的操作') : fail(r.error || '无法开始录制', r);
  });

tool('record_status', '查看当前录制会话：已记录了哪些步骤、有哪些提醒（敏感值/验证码/下载等）。',
  { type: 'object', properties: {} },
  async () => {
    const s = recordingStatus();
    return s.recording ? ok(s, '录制中，已记录 ' + s.stepCount + ' 步') : ok({ recording: false }, '当前没有进行中的录制');
  });

tool('record_stop',
  '结束录制并生成技能：整理步骤清单、把「今天/昨天/明天」的日期字面量自动替换成变量、根据页面结果推断结果校验断言、跑静态检查并保存。返回可人工审阅的步骤清单。' +
  '若当前是 record_splice_start 起的片段重录会话，则改为把新片段拼接回原流程（自动备份原定义）。',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名称' },
      save: { type: 'boolean', description: '是否保存为流程文件，默认 true' },
      inferAssertions: { type: 'boolean', description: '是否自动推断结果校验断言，默认 true' },
      keepBrowserOpen: { type: 'boolean', description: '保留浏览器窗口（调试用），默认 false' },
    },
  },
  async (a) => {
    const r = await stopRecording(a || {});
    if (!r.ok) return fail(r.error, r);
    const summary = '技能已生成：' + r.flowId + '（' + r.stepCount + ' 步，' + r.assertions.length + ' 条断言）' +
      (r.lint.errors.length ? ' ⚠ 有 ' + r.lint.errors.length + ' 个阻断项待修' : ' ✓ 静态检查通过');
    return ok({
      flowId: r.flowId,
      stepCount: r.stepCount,
      assertions: r.assertions,
      autoVariables: r.autoVariables,
      paramSuggestions: r.paramSuggestions,
      lint: r.lint,
      notes: r.notes,
      steps: r.flow.steps.map((s, i) => stepLabel(s, i)),
      next: r.next,
      markdown: r.markdown,
    }, summary);
  });

tool('record_splice_start',
  '片段重录：只重录"录错的那一段"，不必整条重录。会先用同一个执行器把原流程的前 from-1 步重放一遍' +
  '（页面回到出错那一步之前的真实状态），再打开录制让你只把第 from~to 步重做一遍；' +
  '完成后调用 record_stop 自动拼接回流程并备份原定义。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      from: { type: 'integer', minimum: 1, description: '要重录的第一段步骤序号（从 1 开始）' },
      to: { type: 'integer', minimum: 1, description: '要重录的最后一段步骤序号；不传=到最后一步' },
      keepSuffix: { type: 'boolean', description: '是否保留第 to 步之后的原步骤，默认 true' },
      params: { type: 'object', description: '重放前缀所需的变量取值' },
      headed: { type: 'boolean', description: '是否显示浏览器窗口，默认 true（人要在里面操作）' },
    },
    required: ['flowId', 'from'],
  },
  async (a) => {
    const r = await startSplice(a);
    return r.ok ? ok(r, r.message) : fail(r.error || '无法开始片段重录', r);
  });

tool('flow_restore',
  '把流程回滚到最近一次备份（备份在「片段重录 / 任何流程改动或删除」时自动生成，每个流程最多留 10 份）。误删的流程也能从备份恢复。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      which: { type: 'string', description: '指定备份的时间戳或完整路径；不传=最近一次' },
      list: { type: 'boolean', description: '只列出可用备份，不回滚' },
    },
    required: ['flowId'],
  },
  async (a) => {
    if (a.list) {
      const backups = listBackups(a.flowId);
      return ok({ flowId: a.flowId, backups }, backups.length ? '共 ' + backups.length + ' 份备份' : '还没有备份（只有改动流程时才会生成）');
    }
    const r = restoreFlow(a.flowId, a.which);
    return r.ok ? ok({ flowId: a.flowId, restoredFrom: r.restoredFrom, stepCount: r.stepCount }, '已回滚到 ' + r.restoredFrom)
      : fail(r.error, r.available ? { available: r.available } : undefined);
  });

tool('record_cancel', '取消当前录制，丢弃已记录的步骤并关闭浏览器。',
  { type: 'object', properties: {} },
  async () => {
    const r = await cancelRecording();
    return r.ok ? ok(r, '已取消录制，丢弃 ' + r.discardedSteps + ' 步') : fail(r.error, r);
  });

/* ---------------- 流程管理 ---------------- */

tool('flow_list', '列出所有已录制的流程技能（id / 名称 / 步骤数 / 参数数 / 断言数 / 更新时间）。',
  { type: 'object', properties: {} },
  async () => {
    const flows = listFlows();
    return ok({ count: flows.length, flows }, flows.length ? '共 ' + flows.length + ' 个流程' : '还没有任何流程，先用 record_start 录一个');
  });

tool('flow_show', '按人类可读的方式查看一个流程的完整步骤清单（含变量与断言），用于「录完自己先看一遍步骤清单」。',
  { type: 'object', properties: { flowId: S_FLOW, format: { type: 'string', enum: ['markdown', 'json'], description: '默认 markdown' } } },
  async (a) => {
    const flow = requireFlow(a.flowId);
    if ((a.format || 'markdown') === 'json') return ok(flow, '流程 ' + flow.id + ' 定义');
    return ok({ markdown: flowMarkdown(flow), params: describeParams(flow) }, '流程 ' + flow.id + ' 步骤清单');
  });

tool('flow_lint', '对流程做静态检查：敏感/验证码步骤、缺失的结果校验、未声明变量、脆弱定位符、硬编码日期、重复提交、下载缺路径等（把踩过的坑变成规则）。',
  { type: 'object', properties: { flowId: S_FLOW } },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const r = lintFlow(flow, readConfig());
    const msg = r.ok ? '静态检查通过（' + r.warnings.length + ' 个警告）'
      : '发现 ' + r.errors.length + ' 个阻断项、' + r.warnings.length + ' 个警告';
    return ok(r, msg);
  });

tool('flow_delete', '删除一个流程及其运行记录索引。',
  { type: 'object', properties: { flowId: S_FLOW } },
  async (a) => {
    snapshot(a.flowId);   // 删除前也留备份：误删可用 flow_restore 找回
    const deleted = deleteFlow(a.flowId);
    return ok({ deleted, flowId: a.flowId }, deleted ? '已删除 ' + a.flowId : '流程不存在: ' + a.flowId);
  });

tool('flow_rename', '重命名流程（只改显示名，id 不变，避免打断定时任务与运行记录）。',
  { type: 'object', properties: { flowId: S_FLOW, name: { type: 'string' } } },
  async (a) => {
    const flow = requireFlow(a.flowId);
    flow.name = a.name;
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ flowId: flow.id, name: flow.name }, '已重命名为 ' + a.name);
  });

tool('flow_param_add',
  '给流程声明一个变量。source 支持：const / env:NAME / secret:NAME / excel:<文件>#<列>[@行|*] / csv:... / flow:<流程id>:<键> / prompt。' +
  '例：source="excel:D:/data/orders.xlsx#单号@0" 取第一行单号；"excel:...#单号@*" 取整列（换行拼接）。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      name: { type: 'string', description: '变量名（步骤里用 \${name} 引用）' },
      label: { type: 'string' },
      source: { type: 'string' },
      default: { type: 'string' },
      required: { type: 'boolean' },
      secret: { type: 'boolean', description: '标记为敏感：输出/日志中掩码' },
    },
    required: ['flowId', 'name'],
  },
  async (a) => {
    const flow = requireFlow(a.flowId);
    flow.params = flow.params || [];
    const existing = flow.params.findIndex((p) => p.name === a.name);
    const rec = {
      name: a.name, label: a.label, source: a.source,
      default: a.default, required: !!a.required, secret: !!a.secret,
    };
    if (existing >= 0) flow.params[existing] = rec; else flow.params.push(rec);
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ flowId: flow.id, params: describeParams(flow) }, (existing >= 0 ? '已更新' : '已添加') + ' 变量 ' + a.name);
  });

tool('flow_param_remove', '删除一个流程变量。',
  { type: 'object', properties: { flowId: S_FLOW, name: { type: 'string' } }, required: ['flowId', 'name'] },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const before = (flow.params || []).length;
    flow.params = (flow.params || []).filter((p) => p.name !== a.name);
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ flowId: flow.id, removed: before - flow.params.length, params: describeParams(flow) }, '已删除变量 ' + a.name);
  });

tool('flow_assertion_add',
  '给流程加结果校验断言（文章强调：缺了结果校验，跑完了也不知道到底成没成）。kind 可选：tableNotEmpty / listNotEmpty / textPresent / textAbsent / elementVisible / elementAbsent / url / title / download / extracted / noErrorBanner。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      kind: { type: 'string' },
      message: { type: 'string', description: '失败时要显示的说明' },
      text: { type: 'string', description: 'textPresent/textAbsent 用' },
      selector: { type: 'string', description: 'tableNotEmpty/listNotEmpty 用，如 "table tbody tr"' },
      min: { type: 'integer', minimum: 1, description: '最少行数/数量（≥1；0/负数会让「结果非空」断言空过）' },
      contains: { type: 'string' }, equals: { type: 'string' }, regex: { type: 'string' },
      as: { type: 'string', description: 'extracted 用，引用 extract 步骤的 as' },
      minBytes: { type: 'integer', minimum: 1, description: 'download 用，字节下限（≥1；缺省 1）' },
      minLines: { type: 'integer', minimum: 0, description: 'download 用，数据行数下限（缺省 0=不检查行数）' },
      locators: { type: 'array', description: 'elementVisible/elementAbsent 用' },
    },
    required: ['flowId', 'kind'],
  },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const { flowId, ...spec } = a;
    flow.assertions = flow.assertions || [];
    flow.assertions.push(spec);
    snapshot(a.flowId);
    saveFlow(flow);
    const lint = lintFlow(flow, readConfig());
    return ok({ added: spec, assertions: flow.assertions, lint }, '已添加断言 [' + a.kind + ']');
  });

tool('flow_assertion_remove', '删除第 n 条断言（从 1 开始）。',
  { type: 'object', properties: { flowId: S_FLOW, index: S_IDX }, required: ['flowId', 'index'] },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const list = flow.assertions || [];
    if (a.index < 1 || a.index > list.length) return fail('断言序号越界（1..' + list.length + '）');
    const removed = list.splice(a.index - 1, 1)[0];
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ removed, assertions: flow.assertions }, '已删除断言 ' + a.index);
  });

tool('flow_step_delete', '删除某一一步骤（录错了一段就删掉那一步，不必整段重录）。',
  { type: 'object', properties: { flowId: S_FLOW, index: S_IDX }, required: ['flowId', 'index'] },
  async (a) => {
    const flow = requireFlow(a.flowId);
    if (a.index < 1 || a.index > (flow.steps || []).length) return fail('步骤序号越界（1..' + (flow.steps || []).length + '）');
    const removed = flow.steps.splice(a.index - 1, 1)[0];
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ removedLabel: stepLabel(removed), steps: flow.steps.map((s, i) => stepLabel(s, i)) }, '已删除第 ' + a.index + ' 步');
  });

tool('flow_step_update', '局部修改一个步骤（例如把写死的值换成变量、补上传文件路径、标记 expectDownload）。',
  {
    type: 'object',
    properties: { flowId: S_FLOW, index: S_IDX, patch: { type: 'object', description: '要合并进该步骤的字段' } },
    required: ['flowId', 'index', 'patch'],
  },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const s = (flow.steps || [])[a.index - 1];
    if (!s) return fail('步骤序号越界');
    Object.assign(s, a.patch);
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ step: stepLabel(s, a.index - 1) }, '已更新第 ' + a.index + ' 步');
  });

tool('flow_step_move', '调整步骤顺序（把某一步移动到另一个位置）。',
  { type: 'object', properties: { flowId: S_FLOW, from: S_IDX, to: S_IDX }, required: ['flowId', 'from', 'to'] },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const steps = flow.steps || [];
    if (a.from < 1 || a.from > steps.length || a.to < 1 || a.to > steps.length) return fail('序号越界（1..' + steps.length + '）');
    const [m] = steps.splice(a.from - 1, 1);
    steps.splice(a.to - 1, 0, m);
    snapshot(a.flowId);
    saveFlow(flow);
    return ok({ steps: steps.map((s, i) => stepLabel(s, i)) }, '已移动第 ' + a.from + ' 步到第 ' + a.to + ' 步');
  });

tool('flow_export', '导出流程定义为 JSON（便于备份、分享、纳入 git）。',
  { type: 'object', properties: { flowId: S_FLOW } },
  async (a) => {
    const flow = requireFlow(a.flowId);
    return ok({ flowId: flow.id, json: JSON.stringify(flow) }, '已导出 ' + flow.id);
  });

tool('flow_import', '导入流程定义 JSON。',
  { type: 'object', properties: { flow: { description: '流程对象或 JSON 字符串' }, overwrite: { type: 'boolean' } } },
  async (a) => {
    let f = a.flow;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch (e) { return fail('flow 不是合法 JSON: ' + String(e.message)); } }
    if (!f || !Array.isArray(f.steps)) return fail('流程定义缺少 steps 数组');
    if (!f.id) f.id = newFlowId(f.name || 'imported');
    if (!a.overwrite && loadFlow(f.id)) return fail('流程已存在: ' + f.id + '（加 overwrite=true 覆盖）');
    if (loadFlow(f.id)) snapshot(f.id);   // 覆盖已存在的流程前先留备份
    const saved = saveFlow(f);
    return ok({ flowId: saved.id, stepCount: saved.steps.length }, '已导入 ' + saved.id);
  });

/* ---------------- 回放 / 校验 ---------------- */

tool('flow_run',
  '回放流程技能：执行录制的每一步，遇到定位符失效会自动用元素指纹自愈并回写修复，最后跑结果校验、截图留证、必要时发告警。' +
  '有阻断级静态问题时会拒绝执行（除非 allowLintErrors=true）；同一流程并发执行会被锁挡住（避免重复提交）。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      params: { type: 'object', description: '变量取值，如 {"日期":"2026-09-30"}' },
      headed: { type: 'boolean', description: '是否显示浏览器窗口（默认无头）' },
      allowLintErrors: { type: 'boolean', description: '忽略静态检查的阻断项强制运行' },
      learn: { type: 'boolean', description: '是否把自愈成功的定位符回写进流程文件，默认 true' },
      evidenceOn: { type: 'string', enum: ['always', 'failure', 'never'] },
      maxDurationMs: { type: 'integer', minimum: 0, description: '本次运行总时限（毫秒），到期后优雅收尾（截图+报告+告警+释放锁）；不传用配置 run.maxDurationMs（默认 0=不限）。计时自运行开始，含 profile 锁等待（被剩余预算夹取）与浏览器启动（不可中断，越线≤启动时长）；报告与响应带 budgetOverrunMs/budgetSource/launchMs 可观测字段（launchMs=启动耗时）' },
      saveVideo: { type: 'boolean', description: '本次是否全程录像留证；不传用配置 run.saveVideo（流程含敏感输入时自动跳过，防录像泄露密码画面）' },
      videoOn: { type: 'string', enum: ['failure', 'always'], description: '成功时是否保留录像（failure=删成功录像省空间）' },
      trigger: { type: 'string' },
    },
    required: ['flowId'],
  },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const report = await runFlow(flow, a);
    const head = report.status === 'pass'
      ? '✅ 回放成功：' + (flow.name || flow.id) + '（' + report.steps.length + ' 步 / ' + Math.round(report.durationMs / 1000) + 's）'
      : (report.status === 'blocked' ? '⛔ 未执行：' : '❌ 回放失败：') + (report.error || '').split('\n')[0];
    return ok({
      status: report.status,
      flowId: report.flowId,
      failedStep: report.failedStep,
      error: report.error,
      durationMs: report.durationMs,
      stepDetails: report.steps.map((s) => ({ n: s.index, op: s.op, status: s.status, ms: s.ms, healed: s.healed, detail: s.detail, error: s.error })),
      assertions: report.assertions,
      healed: report.healed,
      flowSelfHealed: !!report.flowPatched,
      emptyGuard: report.emptyGuard,
      extracted: report.extracted,
      downloads: report.downloads,
      screenshots: report.screenshots,
      videos: report.videos,
      videoNote: report.videoNote || null,
      timedOut: !!report.timedOut,
      maxDurationMs: report.maxDurationMs,
      budgetOverrunMs: report.budgetOverrunMs,
      budgetSource: report.budgetSource || null,
      launchMs: report.launchMs ?? null,
      // 观察期实锤的接线缺口：attribution/finalUrl/finalTitle 已在 report.json 里，
      // 但响应投影漏透出——UI（renderRunResult 归因行）与调用方在 flow_run 响应里看不到
      attribution: report.attribution || null,
      finalUrl: report.finalUrl || null,
      finalTitle: report.finalTitle || null,
      reportPath: report.reportPath,
      notifications: report.notifications,
    }, head);
  });

tool('flow_preflight',
  '非破坏性预检：打开起始页，逐个检查每个步骤的定位符现在还能不能解析（页面改版会在这里提前暴露），不会点击任何按钮。',
  { type: 'object', properties: { flowId: S_FLOW, headed: { type: 'boolean' } }, required: ['flowId'] },
  async (a) => {
    const flow = requireFlow(a.flowId);
    const r = await preflightFlow(flow, a);
    const bad = (r.steps || []).filter((s) => s.checked && !s.resolvable).length;
    return ok(r, bad ? '预检完成：' + bad + ' 个步骤在起始页上找不到元素（需人工确认）' : '预检完成：起始页上可检查的定位符全部命中');
  });

tool('run_history', '查看某个流程的历史执行记录（状态、耗时、触发方式、自愈次数、失败步骤）。',
  { type: 'object', properties: { flowId: S_FLOW, limit: { type: 'integer', minimum: 1, description: '最近 N 次，缺省 20' } }, required: ['flowId'] },
  async (a) => {
    const runs = listRuns(a.flowId, a.limit || 20);
    return ok({ flowId: a.flowId, count: runs.length, runs }, runs.length ? '最近 ' + runs.length + ' 次执行记录' : '还没有执行记录');
  });

tool('run_report', '读取某次执行的完整报告（默认 latest）。',
  { type: 'object', properties: { flowId: S_FLOW, stamp: { type: 'string', description: '执行时间戳，默认 latest', pattern: SAFE_ID_PATTERN } }, required: ['flowId'] },
  async (a) => {
    const r = loadRun(a.flowId, a.stamp || 'latest');
    if (!r) return fail('没有找到 ' + a.flowId + ' 的执行报告');
    return ok(r, '执行报告：' + r.stamp + ' / ' + r.status);
  });

tool('status_report',
  '无人值守总览：所有流程的总运行次数（totalRuns=真实总数，含进行中/中断，不受摘要窗口封顶）、最后状态、' +
  '连续失败次数（consecutiveFailures 只数已定论的失败 fail/blocked，进行中 running/崩溃 interrupted 不计；全量真值不受摘要窗口封顶）、' +
  '是否中断/正在执行/等待人工、自愈趋势（healedTotal=全量累计自愈次数，同样不受摘要窗口封顶）、定时配置，以及需要关注的问题清单。' +
  '每天早上（或定时任务跑完后）先看这一个就够。',
  { type: 'object', properties: { onlyProblems: { type: 'boolean', description: '只返回有问题的流程' } } },
  async (a) => {
    const r = statusReport({ onlyProblems: !!a.onlyProblems });
    const head = r.summary.problematic
      ? '[需关注] ' + r.summary.problematic + '/' + r.summary.flows + ' 个流程需要关注'
      : '[正常] 全部 ' + r.summary.flows + ' 个流程最近一次执行正常';
    return ok(r, head + '（' + r.conclusion + '）');
  });

tool('runs_prune',
  '按留存策略清理历史运行记录（默认每流程保留最近 50 次且 30 天内；录像默认每流程只留最近 20 段）。' +
  '规则：只传 keepCount 或 keepDays 之一时按该单一维度清理（另一维度不限）；两者都传=超出保留次数且超过天龄才删；' +
  '都不传=按配置 run.keepRunsPerFlow / run.keepRunDays 双约束。**默认只预演不删除**，确认后再传 dryRun:false。',
  {
    type: 'object',
    properties: {
      flowId: { type: 'string', description: '只清理某个流程；不传=全部', pattern: SAFE_ID_PATTERN },
      keepCount: { type: 'integer', minimum: 0, description: '每流程保留最近多少次；0=不按次数清理（注意：0 不是"全删"）。只传它时按次数单维度清理' },
      keepDays: { type: 'integer', minimum: 0, description: '保留多少天；0=不按天龄清理（注意：0 不是"全删"）。只传它时按天龄单维度清理' },
      keepVideos: { type: 'integer', minimum: 0, description: '每流程保留最近多少段录像（默认 run.keepVideosPerFlow=20，0=不限）' },
      dryRun: { type: 'boolean', description: '默认 true，只列出将被删除的内容' },
      logs: { type: 'boolean', description: '同时清理过期日志文件' },
    },
  },
  async (a) => {
    const dryRun = a.dryRun !== false;
    const out = { dryRun };
    const opt = { keepCount: a.keepCount, keepDays: a.keepDays, keepVideos: a.keepVideos, dryRun };
    out.runs = a.flowId ? [pruneRuns(a.flowId, opt)] : pruneAllRuns(opt);
    if (a.logs) out.logs = pruneLogs({ keepDays: a.keepDays, dryRun });
    const removed = out.runs.reduce((s, r) => s + (r.removed ? r.removed.length : 0), 0) + (out.logs ? out.logs.removed.length : 0);
    const videos = out.runs.reduce((s, r) => s + (r.videosRemoved || 0), 0);
    return ok(out, (dryRun ? '预演：将清理 ' : '已清理 ') + removed + ' 项历史文件' + (videos ? '，另 ' + (dryRun ? '将清理 ' : '清理 ') + videos + ' 段录像' : ''));
  });

tool('lock_status',
  '查看某个流程（或全部）的执行锁：谁在跑、从什么时候开始、是否已成为过期锁。排查"明明没在跑却提示正在执行"时用。',
  { type: 'object', properties: { flowId: { type: 'string', description: '流程 id', pattern: SAFE_ID_PATTERN } } },
  async (a) => {
    if (a.flowId) {
      const info = lockInfo(a.flowId);
      return ok(info, info.held ? '正在执行中（pid ' + info.pid + '）' : (info.stale ? '存在过期锁，下次执行会自动清理' : '未在执行'));
    }
    const locks = listFlows().map((f) => lockInfo(f.id)).filter((l) => l.held || l.stale);
    const pl = lockInfo('__profile__');
    if (pl.held || pl.stale) locks.push(Object.assign({ profile: true }, pl));
    return ok({ locks }, locks.length ? '有 ' + locks.length + ' 个加锁项（含浏览器 profile 锁）' : '当前没有任何流程在执行');
  });

tool('lock_release',
  '强制释放某个流程的执行锁。**仅在上一次执行确实已经不在运行、但锁没被清掉时使用**（例如进程被强杀）。',
  { type: 'object', properties: { flowId: S_FLOW }, required: ['flowId'] },
  async (a) => {
    const info = lockInfo(a.flowId);
    releaseLock(a.flowId);
    return ok({ before: info, released: true }, info.held ? '已强制释放 ' + a.flowId + ' 的锁（原持有者 pid ' + info.pid + '）' : '该流程本来就没有锁');
  });

tool('chain_run',
  '多流程串联执行（取数 → 填表 → 发邮件 一条线跑完）。前一个流程 extract 出的值可在后一个流程里用 \${<前一个流程id>:<键>} 引用。',
  {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '按顺序执行的步骤：[{flow:"id", params:{...}, continueOnError:false}]',
        items: {
          type: 'object',
          properties: {
            flow: { type: 'string', description: '流程 id' },
            params: { type: 'object', description: '该流程的变量取值' },
            continueOnError: { type: 'boolean', description: '该流程失败后是否继续后面的流程，默认 false' },
          },
          required: ['flow'],
        },
      },
      headed: { type: 'boolean' },
      allowLintErrors: { type: 'boolean' },
      notify: { type: 'boolean', description: '是否发送告警，默认 false' },
      maxDurationMs: { type: 'integer', minimum: 0, description: '整条串联的总时限（毫秒），到期后剩余流程不再执行；不传=不限（子流程各自按 run.maxDurationMs 生效）' },
    },
    required: ['items'],
  },
  async (a) => {
    const r = await runChain(a.items, {
      headed: a.headed, allowLintErrors: a.allowLintErrors,
      notify: a.notify, trigger: 'chain', learn: true,
      maxDurationMs: a.maxDurationMs,
    });
    return r.status === 'pass'
      ? ok(r, '✅ 串联全部成功：' + r.summary)
      : fail('串联中断：' + (r.error || '未知原因'), r);
  });

/* ---------------- 定时 ---------------- */

tool('schedule_add',
  '把流程注册成 Windows 定时任务（默认每天 09:00 自动跑）。frequency 可选 daily / weekly / hourly / minute / once / logon。',
  {
    type: 'object',
    properties: {
      flowId: S_FLOW,
      frequency: { type: 'string', description: 'daily(默认) / weekly / hourly / minute / once / logon' },
      at: { type: 'string', description: '时刻 HH:mm，默认 09:00' },
      days: { type: 'array', items: { type: 'string' }, description: 'weekly 用，如 ["MON","WED"]' },
      everyMinutes: { type: 'integer', minimum: 1, description: 'minute 频率：每 N 分钟（≥1；0 不再被静默当 30）' },
      everyHours: { type: 'integer', minimum: 1, description: 'hourly 频率：每 N 小时（≥1；0 不再被静默当 1）' },
      date: { type: 'string', description: 'once 用，如 2026/10/01' },
      params: { type: 'object', description: '定时运行时使用的变量取值' },
      headed: { type: 'boolean', description: '定时是否显示浏览器窗口' },
    },
    required: ['flowId'],
  },
  async (a) => {
    if (!isWindows()) return fail('定时依赖 Windows 任务计划程序（schtasks），当前系统不支持');
    const flow = requireFlow(a.flowId);
    const { flowId, ...spec } = a;
    const r = await addSchedule(flowId, spec);
    return r.ok
      ? ok(r, '✅ 已注册定时任务 ' + r.task + '（' + JSON.stringify(spec) + '）')
      : fail('注册定时任务失败：' + (r.error || r.stderr), r);
  });

tool('schedule_list', '列出已登记的定时任务及其在系统中的实际状态（下次运行时间、上次结果）。',
  { type: 'object', properties: {} },
  async () => {
    if (!isWindows()) return fail('定时依赖 Windows 任务计划程序（schtasks），当前系统不支持');
    const list = await listSchedules();
    return ok({ count: list.length, tasks: list }, list.length ? '共 ' + list.length + ' 个定时任务' : '还没有定时任务');
  });

tool('schedule_remove', '删除一个定时任务。',
  { type: 'object', properties: { flowId: S_FLOW }, required: ['flowId'] },
  async (a) => {
    const r = await removeSchedule(a.flowId);
    return r.ok ? ok(r, '已删除定时任务 ' + r.task) : fail('删除失败：' + r.stderr, r);
  });

tool('schedule_run_now', '立即触发一次已注册的定时任务（走任务计划，便于验证定时链路是否通）。',
  { type: 'object', properties: { flowId: S_FLOW }, required: ['flowId'] },
  async (a) => {
    const r = await runScheduleNow(a.flowId);
    if (!r.ok) return fail('触发失败：' + r.stderr + '（用 schedule_list 确认任务已注册）', r);
    return ok({ ...r, note: '任务已触发，稍后用 run_history 查看结果；日志见 logs/schedule-' + a.flowId + '.log' }, '已触发 ' + r.task);
  });

/* ---------------- 告警 ---------------- */

tool('notify_config', '查看或设置异常告警（不传参数=查看）。type 可选 wecom / dingtalk / feishu / slack / generic；on 可选 failure / success / healed / all。',
  {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      type: { type: 'string' },
      webhook: { type: 'string', description: 'Webhook 地址（企业微信/钉钉/飞书机器人）' },
      on: { type: 'array', items: { type: 'string' } },
      mention: { type: 'string', description: '附在消息末尾的 @ 提醒文本' },
    },
  },
  async (a) => {
    const patch = {};
    for (const k of ['enabled', 'type', 'webhook', 'on', 'mention']) if (a[k] !== undefined) patch[k] = a[k];
    const cfg = Object.keys(patch).length ? writeConfig({ notify: patch }) : readConfig();
    const safe = { ...cfg.notify, webhook: cfg.notify.webhook ? maskSecret(cfg.notify.webhook, 12) : '' };
    return ok({ notify: safe }, Object.keys(patch).length ? '告警配置已更新' : '当前告警配置');
  });

tool('notify_test', '发送一条测试告警，验证 Webhook 是否配置正确。',
  { type: 'object', properties: { message: { type: 'string' } } },
  async (a) => {
    const cfg = readConfig();
    const text = a.message || ('Web RPA 测试消息 ' + nowIso());
    const res = await sendNotify({ title: 'Web RPA 测试', text, markdown: '**Web RPA 测试**\n' + text, data: { test: true } }, cfg, { force: true });
    return res.sent ? ok(res, '✅ 测试告警已发送') : fail('发送失败：' + (res.error || res.skipped), res);
  });

/* ---------------- 凭据与配置 ---------------- */

tool('secret_set', '加密保存一个凭据（AES-256-GCM，密钥在本机 .work/key），供参数 source="secret:<名字>" 使用；任何输出都不会回显明文。',
  { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] },
  async (a) => {
    setSecret(a.name, a.value);
    return ok({ name: a.name, masked: maskSecret(a.value) }, '已加密保存凭据 ' + a.name);
  });

tool('secret_list', '列出已保存的凭据名称（不含值）。',
  { type: 'object', properties: {} },
  async () => {
    const list = listSecrets();
    return ok({ count: list.length, secrets: list }, list.length ? '共 ' + list.length + ' 个凭据' : '还没有保存任何凭据');
  });

tool('secret_delete', '删除一个凭据。',
  { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async (a) => {
    const deleted = deleteSecret(a.name);
    return ok({ deleted, name: a.name }, deleted ? '已删除凭据 ' + a.name : '凭据不存在: ' + a.name);
  });

tool('profile_login',
  '打开一个可见浏览器窗口，**让人工登录一次**（扫码/短信/账号密码都行），登录成功后把登录态保存进持久化 profile；' +
  '之后所有执行（含定时任务）都复用这个登录态，不必再登。会自动开启 browser.persistProfile。',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: '打开的地址（通常是登录页，或"登录后会停在的首页"）' },
      successText: { type: 'string', description: '页面上出现这段文字即视为登录成功，例如「工作台」' },
      successUrlContains: { type: 'string', description: '地址包含这段字符串即视为登录成功，例如 "/dashboard"' },
      timeoutMs: { type: 'integer', minimum: 1, description: '最多等多久（毫秒），缺省 300000（5 分钟）' },
    },
    required: ['url'],
  },
  async (a) => {
    if (!a.successText && !a.successUrlContains) {
      return fail('请至少给出一个"登录成功"的判断条件：successText 或 successUrlContains（否则无法知道什么时候存登录态）');
    }
    writeConfig({ browser: { persistProfile: true } });
    const cfg = readConfig();
    const timeoutMs = Number(a.timeoutMs) || 300000;
    let handle = null;
    try {
      handle = await launchContext({ headed: true, persistent: true });
      const page = handle.context.pages()[0] || await handle.context.newPage();
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: cfg.run.navTimeoutMs });
      const deadline = Date.now() + timeoutMs;
      let logged = false;
      let lastUrl = page.url();
      while (Date.now() < deadline) {
        lastUrl = page.url();
        if (a.successUrlContains && lastUrl.indexOf(a.successUrlContains) >= 0) { logged = true; break; }
        if (a.successText) {
          const n = await page.getByText(a.successText).count().catch(() => 0);
          if (n > 0) { logged = true; break; }
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      const info = profileInfo();
      return logged
        ? ok({ loggedIn: true, url: lastUrl, profile: info }, '✅ 登录态已保存进 profile：' + info.dir + '（之后无需再登）')
        : fail('等待登录超时（' + Math.round(timeoutMs / 1000) + 's），未检测到登录成功标志；profile 里可能存的是未登录状态', { url: lastUrl, profile: info });
    } finally {
      await closeContext(handle);
    }
  });

tool('profile_info',
  '查看持久化登录态：是否开启、目录、体积、上次使用时间、是否正被别的执行占用。',
  { type: 'object', properties: {} },
  async () => {
    const info = profileInfo();
    return ok(info, info.enabled
      ? (info.exists
        ? 'profile 已开启：' + info.dir + '（' + Math.round(info.bytes / 1024) + ' KB，' + info.files + ' 个文件）'
        : 'profile 已开启，但登录态目录还没有内容：先用 profile_login 人工登录一次（当前 ' + info.dir + ' 为空）')
      : 'profile 未开启：需要登录的系统请先调用 profile_login');
  });

tool('profile_reset',
  '清空持久化登录态（删除 profile 目录）。**会一并清除所有已登录会话**，需要显式传 confirm:true。',
  { type: 'object', properties: { confirm: { type: 'boolean', description: '必须为 true 才会真正删除' } }, required: ['confirm'] },
  async (a) => {
    if (a.confirm !== true) return fail('为防误操作，需要显式传 confirm: true');
    const before = profileInfo();
    const r = await resetProfile();
    return ok({ before, result: r }, r.removed ? '已清空 profile（下次执行需要重新登录）' : 'profile 目录不存在，无需清理');
  });

tool('config_get', '查看当前配置（浏览器、回放、告警、安全）。',
  { type: 'object', properties: {} },
  async () => {
    const cfg = readConfig();
    const safe = { ...cfg, notify: { ...cfg.notify, webhook: cfg.notify.webhook ? maskSecret(cfg.notify.webhook, 12) : '' } };
    return ok({ config: safe, configPath: DIRS.configFile }, '当前配置');
  });

tool('config_set', '合并式更新配置（只覆盖传入的字段）。',
  { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] },
  async (a) => {
    const cfg = writeConfig(a.patch || {});
    const safe = { ...cfg, notify: { ...cfg.notify, webhook: cfg.notify.webhook ? maskSecret(cfg.notify.webhook, 12) : '' } };
    return ok({ config: safe }, '配置已更新');
  });

tool('doctor',
  '环境自检：Node 版本、playwright 是否可用、会用哪个浏览器、流程/运行目录、定时与告警配置状态、当前是否有录制会话。排查"为什么跑不起来"先跑这个。',
  { type: 'object', properties: {} },
  async () => {
    const cfg = readConfig();
    const out = {
      version: VERSION,
      node: process.version,
      platform: process.platform,
      root: ROOT,
      dirs: { flows: DIRS.flows, runs: DIRS.runs, logs: DIRS.logs, work: DIRS.work, configFile: DIRS.configFile },
      playwright: { ok: false },
      browser: null,
      flows: listFlows().length,
      recording: recordingStatus().recording,
      openBrowsers: openCount(),
      schedule: { supported: isWindows(), tasks: 0 },
      notify: { enabled: !!cfg.notify.enabled, type: cfg.notify.type, webhook: cfg.notify.webhook ? maskSecret(cfg.notify.webhook, 12) : '', outbox: 0 },
      video: detectFfmpeg(),
      run: {
        maxDurationMs: Number(cfg.run.maxDurationMs) || 0,
        unattendedMaxDurationMs: Number(cfg.run.unattendedMaxDurationMs) || 0,
        saveVideo: !!cfg.run.saveVideo,
      },
      problems: [],
      hints: [],
    };
    try {
      const pw = await getPlaywright();
      out.playwright = { ok: true, version: pw && pw.chromium ? 'chromium api available' : 'unknown' };
    } catch (e) {
      out.playwright = { ok: false, error: String(e && e.message ? e.message : e) };
      out.problems.push('playwright 不可用');
      out.hints.push('在 mcp 目录执行 npm install，或复用同工作区已安装的 playwright');
    }
    const plan = detectBrowserPlan(cfg);
    out.browser = { kind: plan.kind, detail: plan.detail };
    if (plan.brokenList && plan.brokenList.length) {
      out.browser.knownBroken = plan.knownBroken;
      out.browser.brokenList = plan.brokenList;
      out.hints.push('以下浏览器此前启动失败、已被缓存跳过（' + plan.brokenList.join('、') + '）：修好后重跑 doctor 会自动清除缓存；急用可手工删除 .work/browser-broken.json');
    }
    if (plan.kind === 'none' || plan.kind === 'chromium-missing') {
      out.problems.push('没有可用浏览器');
      out.hints.push('npx playwright install chromium，或在 web-rpa.config.json 设置 browser.channel="msedge"');
    }
    if (isWindows()) {
      try { out.schedule.tasks = (await listSchedules()).length; } catch { /* ignore */ }
    }
    const ob = outboxInfo();
    out.notify.outbox = ob.count;
    out.notify.outboxOldestAgeHours = ob.oldestAgeHours;
    if (ob.count > 0) {
      out.hints.push('发件箱有 ' + ob.count + ' 条积压告警（最旧 ' + (ob.oldestAgeHours === null ? '?' : ob.oldestAgeHours) + ' 小时）：下次任何告警发送成功前会自动按顺序补发（.work/notify-outbox.json）');
    }
    if (!out.video.ffmpeg && cfg.run.saveVideo) {
      out.hints.push('run.saveVideo 已开启但没找到 Playwright 自带的 ffmpeg：录像会自动降级为不录像（可执行 npx playwright install ffmpeg 补装）');
    }
    if (!Number(cfg.run.maxDurationMs) && !Number(cfg.run.unattendedMaxDurationMs)) {
      out.hints.push('run.maxDurationMs 与 run.unattendedMaxDurationMs 都是 0：没有任何总超时保护，卡死的运行会一直挂着（建议至少配一个；定时运行默认有 ' + Math.round((DEFAULT_CONFIG.run.unattendedMaxDurationMs || 0) / 60000) + ' 分钟上限）');
    }
    if (!fs.existsSync(DIRS.configFile)) out.hints.push('还没有 web-rpa.config.json，当前使用内置默认值（需要时用 config_set 生成）');
    return ok(out, out.problems.length ? '自检发现 ' + out.problems.length + ' 个问题' : '环境自检通过，可以开始录制/回放');
  });

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                 */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const want = params && params.protocolVersion;
        const version = SUPPORTED_PROTOCOLS.has(want) ? want : PROTOCOL_FALLBACK;
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'web-rpa-mcp', version: VERSION },
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
        return;
      case 'resources/list':
        reply(id, { resources: [] });
        return;
      case 'prompts/list':
        reply(id, { prompts: [] });
        return;
      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const t = TOOLS.find((x) => x.name === name);
        if (!t) { replyError(id, -32602, '未知工具: ' + name); return; }
        // 入口统一按 inputSchema 验收：错参数在这里挡下（INVALID_ARGUMENT 点名参数），
        // 不让 handler 用宽松真值判断把错误参数悄悄变成相反语义（如 headed:'false' 当 true）
        const v = validateArgs(args, t.inputSchema);
        if (!v.ok) {
          L.warn('工具参数不合法', { tool: name, param: v.error.param, got: v.error.got });
          reply(id, fail('参数不合法：' + v.error.message,
            { code: 'INVALID_ARGUMENT', tool: name, param: v.error.param, expected: v.error.expected, got: v.error.got }));
          return;
        }
        try {
          const res = await t.handler(v.value);
          reply(id, res);
        } catch (e) {
          // 回给外部客户端的内容必须脱敏：message/stack 里的安装绝对路径压成相对段/文件名（形状不变）
          const message = redactPath(String(e && e.message ? e.message : e));
          L.error('工具执行失败', { tool: name, message });
          reply(id, fail(message, { tool: name, code: 'TOOL_ERROR', stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).map(redactPath) : undefined }));
        }
        return;
      }
      default:
        if (!isNotification) replyError(id, -32601, '未支持的方法: ' + method);
        return;
    }
  } catch (e) {
    if (!isNotification) replyError(id, -32603, '内部错误: ' + redactPath(String(e && e.message ? e.message : e)));
  }
}

function startServer() {
  ensureDirs();
  process.stdout.on('error', () => {});
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    if (text.startsWith('Content-Length:')) return;
    let msg;
    try { msg = JSON.parse(text); }
    catch (e) { L.warn('无法解析的输入行', { head: text.slice(0, 120) }); return; }
    handle(msg).catch((e) => L.error('处理消息异常', { err: String(e && e.message ? e.message : e) }));
  });
  rl.on('close', async () => {
    L.info('stdin 关闭，正在退出');
    try { await closeAll(); } catch { /* ignore */ }
    process.exit(0);
  });
  L.info('web-rpa-mcp 已启动', { version: VERSION, tools: TOOLS.length, pid: process.pid });
}

const arg = process.argv[2];
if (arg === '--doctor') {
  (async () => {
    const t = TOOLS.find((x) => x.name === 'doctor');
    const res = await t.handler({});
    // 只输出 JSON，方便管道给 jq / ConvertFrom-Json
    const text = res.content[0].text;
    const i = text.indexOf('{');
    process.stdout.write((i >= 0 ? text.slice(i) : text) + '\n');
    process.exit(0);
  })();
} else if (arg === '--tools') {
  process.stdout.write(TOOLS.map((t) => t.name + '\t' + t.description.split('\n')[0].slice(0, 100)).join('\n') + '\n');
  process.exit(0);
} else {
  startServer();
}
