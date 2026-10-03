// web-rpa-mcp — 多流程串联：把「取数 -> 填表 -> 发邮件」接成一条线
import { logger, nowIso } from './core.mjs';
import { loadFlow } from './store.mjs';
import { runFlow } from './player.mjs';

const L = logger('chain');

/**
 * 顺序执行多个流程，前一个流程的 extract 结果可通过 flow:<id>:<key> 被后一个引用。
 * @param {Array<{flow:string, params?:object, continueOnError?:boolean}>} items
 */
export async function runChain(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { status: 'fail', error: '串联没有提供任何流程', results: [] };

  const chainOut = Object.assign({}, opts.chainContext || {});
  const results = [];
  const extracted = {};
  const downloads = [];
  let status = 'pass';
  let error = null;

  for (const item of list) {
    const flowId = typeof item === 'string' ? item : item.flow;
    const flow = loadFlow(flowId);
    if (!flow) {
      status = 'fail';
      error = '流程不存在: ' + flowId;
      results.push({ flow: flowId, status: 'fail', error });
      break;
    }
    L.info('串联执行', { flow: flowId });
    const rep = await runFlow(flow, {
      params: (item && item.params) || {},
      headed: opts.headed,
      trigger: opts.trigger || 'chain',
      allowLintErrors: (item && item.allowLintErrors) || opts.allowLintErrors,
      learn: opts.learn,
      notify: opts.notify === undefined ? false : opts.notify,
      evidenceOn: opts.evidenceOn,
      chainContext: chainOut,
    });

    chainOut[flow.id] = Object.assign({}, chainOut[flow.id] || {}, {
      status: rep.status,
      name: rep.name,
      extracted: rep.extracted || {},
      downloads: rep.downloads || [],
      failedStep: rep.failedStep || null,
      error: rep.error || null,
    });
    Object.assign(extracted, rep.extracted || {});
    for (const d of rep.downloads || []) downloads.push(d);

    results.push({
      flow: flow.id,
      name: rep.name,
      status: rep.status,
      failedStep: rep.failedStep || null,
      error: rep.error || null,
      reportPath: rep.reportPath,
      durationMs: rep.durationMs,
      extracted: rep.extracted || {},
    });

    if (rep.status !== 'pass') {
      status = rep.status === 'blocked' ? 'blocked' : 'fail';
      error = flow.id + ': ' + (rep.error || '执行失败');
      if (!(item && item.continueOnError)) break;
    }
  }

  const finishedAt = nowIso();
  return {
    status,
    error,
    finishedAt,
    results,
    chains: chainOut,
    extracted,
    downloads,
    summary: results.map((r) => r.flow + '=' + r.status).join(' -> '),
  };
}
