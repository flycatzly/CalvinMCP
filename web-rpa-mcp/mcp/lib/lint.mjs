// web-rpa-mcp — 步骤清单静态检查（把文章里作者踩过的坑变成可自动拦截的规则）
import { stepLabel } from './store.mjs';

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;
const DESTRUCTIVE_TEXT_RE = /删除|清空|重置|注销|退出|撤回|作废|退订|drop|delete|remove|reset|trash|unsubscribe/i;
const SUBMIT_TEXT_RE = /提交|保存|确定|确认|发送|导出|下载|登录|注册|付款|支付|submit|save|confirm|send|export|download|sign\s?in|log\s?in/i;
const HASHED_CLASS_RE = /\.[a-z]{1,3}\d{4,}|\.(css|sc|jsx)-[a-z0-9]+/i;
const UNSTABLE_CSS_RE = /:nth-(of-type|child)\(|\[class\*=|>[^>]*>/;

const ASSERT_KINDS = new Set([
  'textPresent', 'textAbsent', 'elementVisible', 'elementAbsent',
  'tableNotEmpty', 'listNotEmpty', 'url', 'title', 'download',
  'extracted', 'noErrorBanner',
]);

function findPlaceholders(step) {
  const names = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER_RE)) names.push({ name: String(m[1]).split(':')[0], raw: m[0] });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(step);
  return names;
}

function textOf(step) {
  const parts = [];
  for (const l of step.locators || []) parts.push(String(l.value || ''), String(l.name || ''));
  if (step.text) parts.push(String(step.text));
  if (step.label) parts.push(String(step.label));
  return parts.join(' ');
}

/**
 * 检查一个流程定义。
 * @returns {{errors:Array, warnings:Array, infos:Array, ok:boolean, hasAssertion:boolean}}
 */
export function lintFlow(flow, config = {}) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const steps = flow.steps || [];
  const known = new Set((flow.params || []).map((p) => p.name));
  const builtinNames = new Set(['today', 'now', 'yesterday', 'tomorrow', 'daystart', 'dayend', 'time', 'date',
    'timestamp', 'uuid', 'random', 'root', 'cwd', 'env', 'osuser', 'file',
    'monthstart', 'yeartoday']);
  const add = (arr, code, i, message, hint) => arr.push({ code, step: i === undefined ? null : i + 1, message, hint: hint || null });

  if (!steps.length) add(errors, 'L000', undefined, '流程没有任何步骤');

  if (!flow.startUrl && (steps[0] || {}).op !== 'goto') {
    add(errors, 'L001', undefined, '流程缺少起始地址，且首步不是 goto', '录制时先打开目标页面，或手动补一个 goto 步骤');
  }
  if (steps.length && steps[0].op !== 'goto' && !flow.startUrl) {
    add(warnings, 'L002', 0, '首步不是 goto，回放依赖浏览器当前页面', '建议首步固定为 goto');
  }

  /* goto 必须是真正的网页：浏览器内置页混进流程会导致回放跑到空白页 */
  steps.forEach((s, i) => {
    if (s.op !== 'goto' || !s.url) return;
    const u = String(s.url);
    if (u.indexOf('$' + '{') >= 0) return;   // 变量形式，运行时再判断
    if (/^https?:\/\//i.test(u) || /^file:\/\//i.test(u)) return;
    add(errors, 'L002', i, 'goto 指向的不是网页地址: ' + u, 'edge:// / chrome:// / about: / devtools:// 这类浏览器内置页不应被录进流程');
  });

  /* 断言检查：文章强调「缺了结果校验」 */
  const inlineAsserts = steps.filter((s) => s.op === 'assert').length;
  const hasAssertion = (flow.assertions || []).length > 0 || inlineAsserts > 0;
  if (!hasAssertion) {
    if (flow.emptyResultOk === true) {
      add(warnings, 'L010', undefined, '流程声明了 emptyResultOk（允许空结果）且没有任何结果校验', '确认这是有意为之；否则补一条 assert');
    } else if (config.run && config.run.emptyResultGuard === false) {
      add(warnings, 'L010', undefined, '流程没有任何结果校验，跑完无法判断是否真的成功', '加一条 assert（如 tableNotEmpty / textPresent）；或开启 run.emptyResultGuard 自动兜底');
    } else {
      add(errors, 'L010', undefined, '流程没有任何结果校验（文章作者的原话：缺了「结果校验」那一步，回去补）', '用 flow_assertion_add 增加断言，例如 tableNotEmpty 或 textPresent');
    }
  }

  /* 敏感步骤：文章说验证码/登录态不要录进去 */
  const handoffIdx = new Set(steps.map((s, i) => (s.op === 'humanHandoff' ? i : -1)).filter((i) => i >= 0));
  steps.forEach((s, i) => {
    if (s.captchaPresent && !handoffIdx.has(i) && !handoffIdx.has(i - 1)) {
      add(errors, 'L020', i, '该步骤所在页面存在验证码组件，自动回放会卡死', '在它前面插入 humanHandoff 步骤，把验证码交给人来点');
    }
    if (s.sensitiveReason === 'verification-code' && s.op === 'fill') {
      add(errors, 'L021', i, '录制到了短信/动态验证码输入，自动回放必然失败', '改为 humanHandoff 步骤，由人工填写');
    }
    if (s.sensitiveReason === 'password' && s.op === 'fill' && s.value && !/\$\{/.test(String(s.value))) {
      add(warnings, 'L022', i, '密码以明文写在流程文件里', '改用 secret_set 存凭据，并把该步 value 设为 \${<名字>}，同时标记 sensitive');
    }
  });

  /* 变量绑定 */
  steps.forEach((s, i) => {
    for (const ph of findPlaceholders(s)) {
      if (!known.has(ph.name) && !builtinNames.has(ph.name)) {
        add(errors, 'L030', i, '引用了未声明的变量 ' + ph.raw, '用 flow_param_add 声明参数，或改成内置变量（如 \${today:YYYYMMDD}）');
      }
    }
  });
  (flow.params || []).forEach((p, i) => {
    const src = p.source || '';
    if (p.required && p.default === undefined && !src) {
      add(warnings, 'L031', i, '参数「' + p.name + '」标为必填但没有默认值也没有来源', '运行时必须显式传值，否则会拒绝执行');
    }
  });

  /* 环境变量来源的参数在"任务计划程序"下可能取不到 */
  (flow.params || []).forEach((p) => {
    if (String(p.source || '').indexOf('env:') === 0) {
      add(warnings, 'L023', undefined, '参数「' + p.name + '」来源是环境变量', '定时任务（任务计划程序）运行时的环境变量可能与手工执行不同，建议改用 secret: 或在 schedule_add 里显式传 params');
    }
  });

  /* 浏览器弹窗：录到了就提醒确认按钮语义 */
  steps.forEach((s, i) => {
    if (s.expectDialog) {
      add(infos, 'L025', i, '该点击会弹出浏览器弹窗，已记录为「' + (s.expectDialog.accept === false ? '取消' : '接受') + '」' + (s.expectDialog.message ? '：' + s.expectDialog.message : ''), '请确认弹窗按钮语义与该选择一致（confirm 被取消会导致操作没生效）');
    }
  });

  /* 定位符稳定性 */
  steps.forEach((s, i) => {
    const locs = s.locators || [];
    if (!['click', 'fill', 'select', 'check', 'press', 'hover', 'waitFor', 'extract', 'setInputFiles', 'scrollIntoView'].includes(s.op)) return;
    if (!locs.length) { add(errors, 'L040', i, '缺少定位符', '重新录制该步骤或手动补 locators'); return; }
    const stable = locs.some((l) => ['testid', 'role', 'label', 'placeholder', 'name'].includes(l.strategy));
    if (!stable) {
      add(warnings, 'L041', i, '没有稳定定位策略（只有 text/css/xpath），页面改版容易失效', '给目标元素加 data-testid，或手动补一条 role/label 定位符');
    }
    if (locs.some((l) => l.strategy === 'css' && HASHED_CLASS_RE.test(String(l.value)))) {
      add(warnings, 'L042', i, 'CSS 定位符含构建产物随机类名', '改用 testid / role / label 定位');
    }
    if (locs.some((l) => l.strategy === 'xpath' && /\[\d+\]/.test(String(l.value)))) {
      infos.push({ code: 'L043', step: i + 1, message: 'XPath 依赖位置序号，较脆弱', hint: null });
    }
  });

  /* 硬编码日期（文章说"依赖今天日期"要交代清楚） */
  steps.forEach((s, i) => {
    if (s.op === 'fill' && typeof s.value === 'string' && !/\$\{/.test(s.value)) {
      const v = s.value.trim();
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v) || /^\d{8}$/.test(v)) {
        add(warnings, 'L050', i, '日期写死了：' + v, '改成 \${today:YYYYMMDD} 这类内置变量，或声明成参数');
      }
    }
  });

  /* 提交类点击后缺少等待 / 断言 */
  steps.forEach((s, i) => {
    if (s.op !== 'click') return;
    const txt = textOf(s);
    if (!SUBMIT_TEXT_RE.test(txt)) return;
    const next = steps.slice(i + 1, i + 4);
    const hasWait = s.waitForNav || s.expectDownload ||
      next.some((n) => ['waitFor', 'waitForText', 'assert', 'download', 'clickAndDownload', 'extract', 'screenshot', 'goto'].includes(n.op));
    // 先查"重复提交"：它与下面的"缺等待"互不排斥。
    // （曾经的写法把 L061 放在 !hasWait 的 return 之后，导致这条规则永远不可能被触发）
    const dup = next.find((n) => n.op === 'click' && textOf(n) === txt);
    if (dup) {
      add(warnings, 'L061', i, '连续两次点击同一个提交按钮，可能重复提交', '确认是否手滑多点了一次；必要时删掉重复步骤');
      return;
    }

    if (!hasWait) {
      // 末步提交且流程已有结果校验时不必再告警（例如"导出"后由 download 断言兜底）
      const lastAndGuarded = i === steps.length - 1 &&
        ((flow.assertions || []).length > 0 || steps.some((x) => x.op === 'assert' || x.expectDownload));
      if (!lastAndGuarded) {
        add(warnings, 'L060', i, '点了提交类按钮，但后面没有等待/校验步骤', '加 waitForText（如"提交成功"）或 assert，否则可能抢跑');
      }
    }
  });

  /* 破坏性操作 */
  steps.forEach((s, i) => {
    if (s.op !== 'click') return;
    const txt = textOf(s);
    if (DESTRUCTIVE_TEXT_RE.test(txt)) {
      add(warnings, 'L070', i, '点击了疑似破坏性操作（删除/清空/作废）', '确认这是你要的；建议加断言并考虑人工确认');
    }
  });

  /* 下载步骤 */
  steps.forEach((s, i) => {
    if (s.op === 'download' && !s.saveAs && !s.optional) {
      add(warnings, 'L080', i, '下载步骤没有指定保存路径', '设置 saveAs，避免文件散落在临时目录');
    }
    if (s.op === 'click' && s.expectDownload && !s.saveAs) {
      infos.push({ code: 'L081', step: i + 1, message: '点击会触发下载，建议指定 saveAs', hint: null });
    }
  });

  /* 空值填写 & 上传文件路径 */
  steps.forEach((s, i) => {
    if (s.op === 'fill' && (s.value === '' || s.value === undefined || s.value === null) && !s.sensitive) {
      add(warnings, 'L090', i, '填入空值（可能录到了清空动作）', '确认这是有意的清空，否则重录该步');
    }
    if (s.op === 'setInputFiles' && !s.path) {
      add(errors, 'L091', i, '上传文件步骤缺少本地路径（浏览器安全限制无法自动获取）', '手动补 path 字段');
    }
  });

  /* 断言字段合法性 */
  for (const a of steps.filter((s) => s.op === 'assert')) {
    if (!ASSERT_KINDS.has(a.kind)) {
      add(errors, 'L100', steps.indexOf(a), '未知断言类型: ' + a.kind, '可选: ' + [...ASSERT_KINDS].join(', '));
    }
  }

  /* 文章头号坑：页面改版后按钮挪位却产生了空报表 -> 必须显式校验结果非空 */
  const hasTableTab = steps.some((s) => s.op === 'extract' || (s.op === 'click' && /导出|下载|报表|export|download|report/i.test(textOf(s))));
  const nonEmptyKinds = ['tableNotEmpty', 'listNotEmpty', 'download', 'textPresent', 'extracted'];
  const hasNonEmpty = steps.some((s) => s.op === 'assert' && nonEmptyKinds.includes(s.kind)) ||
    (flow.assertions || []).some((a) => nonEmptyKinds.includes(a.kind));
  if (hasTableTab && !hasNonEmpty) {
    add(warnings, 'L110', undefined, '流程会导出/取数，但没有「结果非空」校验', '加一条 assert kind=tableNotEmpty 或 download(minBytes>0)，否则空结果会被当成成功');
  }

  /* 证据 */
  if (!steps.some((s) => s.op === 'screenshot')) {
    infos.push({ code: 'L120', step: null, message: '没有显式截图步骤（回放时会自动补末尾截图）', hint: null });
  }

  return { errors, warnings, infos, ok: errors.length === 0, hasAssertion, stepCount: steps.length };
}

export const _internal = { ASSERT_KINDS, findPlaceholders, textOf };
