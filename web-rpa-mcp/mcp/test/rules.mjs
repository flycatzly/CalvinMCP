// web-rpa-mcp — 静态检查规则全量测试：26 条规则逐条构造触发用例
import assert from 'node:assert/strict';
import { lintFlow } from '../lib/lint.mjs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + (e && e.message ? e.message : e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}

const URL0 = 'https://example.com/app';
const L = (v) => [{ strategy: 'testid', value: v }];

/** 一个"基本正确"的流程骨架，各用例只叠加触发目标规则的那一点 */
function base(extra) {
  return Object.assign({
    id: 'r', name: 'r', startUrl: URL0,
    steps: [{ op: 'goto', url: URL0 }],
    params: [],
    assertions: [{ kind: 'textPresent', text: 'ok' }],
  }, extra || {});
}
function codes(flow) {
  const l = lintFlow(flow, {});
  return [...l.errors, ...l.warnings, ...l.infos].map((x) => x.code);
}
function has(flow, code) { return codes(flow).includes(code); }
function only(flow, code) {
  const c = codes(flow);
  return c.includes(code);
}

console.log('\n[lint 规则]');

t('L000 流程没有任何步骤', () => {
  assert.ok(has(base({ steps: [], assertions: [{ kind: 'textPresent', text: 'x' }] }), 'L000'));
});

t('L001 缺少起始地址且首步不是 goto', () => {
  assert.ok(has(base({ startUrl: null, steps: [{ op: 'click', locators: L('a') }] }), 'L001'));
});

t('L002 goto 指向浏览器内置页', () => {
  assert.ok(has(base({ steps: [{ op: 'goto', url: 'edge://downloads-hub/' }] }), 'L002'));
  assert.ok(has(base({ steps: [{ op: 'goto', url: 'chrome://settings' }] }), 'L002'));
  assert.ok(has(base({ steps: [{ op: 'goto', url: 'about:blank' }] }), 'L002'));
});

t('L010 没有任何结果校验', () => {
  assert.ok(has(base({ assertions: [] }), 'L010'));
});

t('L020 存在验证码却没有人工作接管', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('submit'), captchaPresent: true },
      { op: 'assert', kind: 'textPresent', text: 'ok' },
    ],
  }), 'L020'));
  // 前面有人工接管就不该报
  assert.ok(!has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'humanHandoff', reason: '验证码' },
      { op: 'click', locators: L('submit'), captchaPresent: true },
    ],
  }), 'L020'), '有人工接管时不应报 L020');
});

t('L021 录到短信/动态验证码输入', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'fill', locators: L('code'), value: '123456', sensitive: true, sensitiveReason: 'verification-code' },
    ],
  }), 'L021'));
});

t('L022 密码以明文写在流程里', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'fill', locators: L('pwd'), value: 'plaintext-pwd', sensitive: true, sensitiveReason: 'password' },
    ],
  }), 'L022'));
  // 用变量引用就不该报
  assert.ok(!has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'fill', locators: L('pwd'), value: '$' + '{PWD}', sensitive: true, sensitiveReason: 'password' },
    ],
    params: [{ name: 'PWD', source: 'secret:pwd' }],
  }), 'L022'), '参数化的密码不应报 L022');
});

t('L023 参数来源是环境变量', () => {
  assert.ok(has(base({ params: [{ name: 'p', source: 'env:FOO' }] }), 'L023'));
});

t('L025 录到了浏览器弹窗（提示级）', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('submit'), expectDialog: { accept: true, message: '确认？' } },
    ],
  }), 'L025'));
});

t('L030 引用了未声明的变量', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'fill', locators: L('no'), value: '$' + '{未声明变量}' },
    ],
  }), 'L030'));
});

t('L031 必填参数既无默认值也无来源', () => {
  assert.ok(has(base({ params: [{ name: 'p', required: true }] }), 'L031'));
});

t('L040 步骤缺少定位符', () => {
  assert.ok(has(base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click' }] }), 'L040'));
});

t('L041 只有 text/css/xpath，缺稳定定位策略', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'text', value: '提交' }] }],
  }), 'L041'));
});

t('L042 CSS 含构建产物随机类名', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'css', value: 'button.css-1a2b3c' }] }],
  }), 'L042'));
});

t('L043 XPath 依赖位置序号（提示级）', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'xpath', value: '//div[2]/button[3]' }] }],
  }), 'L043'));
});

t('L050 日期写死了', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('d'), value: '2026-01-01' }],
  }), 'L050'));
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('d'), value: '20260101' }],
  }), 'L050'), '紧凑日期也应报');
});

t('L060 提交类点击后没有等待/校验', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('submit'), text: '提交' },
      { op: 'fill', locators: L('x'), value: 'y' },
    ],
  }), 'L060'));
  // 带 waitForNav 就不该报
  assert.ok(!has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('submit'), text: '提交', waitForNav: 'load' },
      { op: 'fill', locators: L('x'), value: 'y' },
    ],
  }), 'L060'), '带 waitForNav 不应报 L060');
});

t('L061 连续两次点击同一个提交按钮', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('submit'), text: '提交' },
      { op: 'click', locators: L('submit'), text: '提交' },
    ],
  }), 'L061'));
});

t('L070 点击了破坏性操作', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('del'), text: '删除' }],
  }), 'L070'));
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('reset'), text: 'Reset All' }],
  }), 'L070'), '英文破坏性文案也应报');
});

t('L080 下载步骤没有保存路径', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'download' }],
  }), 'L080'));
});

t('L081 点击会触发下载但没指定 saveAs（提示级）', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('exp'), expectDownload: true },
      { op: 'assert', kind: 'download', minBytes: 1 },
    ],
  }), 'L081'));
});

t('L090 填入空值', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('x'), value: '' }],
  }), 'L090'));
});

t('L091 上传文件步骤缺少本地路径', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'setInputFiles', locators: L('f'), fileNames: ['a.txt'] }],
  }), 'L091'));
});

t('L100 未知断言类型', () => {
  assert.ok(has(base({
    steps: [{ op: 'goto', url: URL0 }, { op: 'assert', kind: 'noSuchKind' }],
  }), 'L100'));
});

t('L110 会导出/取数却没有"结果非空"校验', () => {
  assert.ok(has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('exp'), text: '导出', waitForNav: 'load' },
    ],
    assertions: [{ kind: 'noErrorBanner' }],
  }), 'L110'));
  // 有 tableNotEmpty 就不该报
  assert.ok(!has(base({
    steps: [
      { op: 'goto', url: URL0 },
      { op: 'click', locators: L('exp'), text: '导出', waitForNav: 'load' },
    ],
    assertions: [{ kind: 'tableNotEmpty', selector: 'table tbody tr' }],
  }), 'L110'), '有非空校验时不应报 L110');
});

t('L120 没有显式截图步骤（提示级）', () => {
  assert.ok(has(base({}), 'L120'));
});

t('全部 26 条规则都能被触发到', () => {
  const ALL = ['L000', 'L001', 'L002', 'L010', 'L020', 'L021', 'L022', 'L023', 'L025', 'L030', 'L031',
    'L040', 'L041', 'L042', 'L043', 'L050', 'L060', 'L061', 'L070', 'L080', 'L081', 'L090', 'L091', 'L100', 'L110', 'L120'];
  const seen = new Set();
  const flows = [
    base({ steps: [], assertions: [{ kind: 'textPresent', text: 'x' }] }),
    base({ startUrl: null, steps: [{ op: 'click', locators: L('a') }] }),
    base({ steps: [{ op: 'goto', url: 'edge://x' }] }),
    base({ assertions: [] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('s'), captchaPresent: true }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('c'), sensitive: true, sensitiveReason: 'verification-code' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('p'), value: 'x', sensitive: true, sensitiveReason: 'password' }] }),
    base({ params: [{ name: 'p', source: 'env:F' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('s'), expectDialog: { accept: true } }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('n'), value: '$' + '{undef}' }] }),
    base({ params: [{ name: 'p', required: true }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click' }] }),
    // 提交类点击后面跟一个"非等待"步骤、且不是末步 -> L060
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('s'), text: '提交' }, { op: 'fill', locators: L('x'), value: 'y' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'text', value: 't' }] }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'css', value: '.css-1a2b3c' }] }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: [{ strategy: 'xpath', value: '//a[1]' }] }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('d'), value: '2026-01-01' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('s'), text: '提交' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('s'), text: '提交' }, { op: 'click', locators: L('s'), text: '提交' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('d'), text: '删除' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'download' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('e'), expectDownload: true }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'fill', locators: L('x'), value: '' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'setInputFiles', locators: L('f') }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'assert', kind: 'nope' }] }),
    base({ steps: [{ op: 'goto', url: URL0 }, { op: 'click', locators: L('e'), text: '导出' }], assertions: [{ kind: 'noErrorBanner' }] }),
  ];
  for (const f of flows) for (const c of codes(f)) seen.add(c);
  const missing = ALL.filter((c) => !seen.has(c));
  assert.deepEqual(missing, [], '以下规则未被任何用例触发: ' + JSON.stringify(missing));
});

console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed');
if (fail) console.log('\n失败项:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);
