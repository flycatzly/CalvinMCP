/**
 * rules-check.mjs — 规则表与文档的一致性检查
 *
 * 为什么需要它：references/ 里的 12 篇文档是「知识层」，规则表在代码里是「执行层」。
 * 两边一旦漂移，就会出现最坏的情况 —— 文档教人写 A，脚本按 B 判。本测试专门拦这个：
 *   1) 规则 id 唯一、格式统一（PWnnn / CFGnnn）
 *   2) 文档里引用的每个 PW/CFG 编号，都必须在实际规则表 / 配置规则里存在
 *   3) 实际规则表里的每条核心规则，至少要有一篇文档提到（避免「实现了但没写文档」）
 *   4) 文档不得声称存在被废弃的编号（PW105 是特例：只允许以「不存在」的方式出现）
 *   5) SKILL.md 的 description 必须写明「什么时候不用」与「不做什么」
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES } from '../lib/lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SKILL = path.join(ROOT, 'skill', 'playwright-verify');
const REFS = path.join(SKILL, 'references');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

/* ---- 1) 规则表自身 ---- */
const ids = RULES.map((r) => r.id);
check('规则 id 唯一', new Set(ids).size === ids.length,
  ids.filter((id, i) => ids.indexOf(id) !== i).join(','));
check('规则 id 格式统一（PW + 3 位数字）', ids.every((id) => /^PW\d{3}$/.test(id)), ids.join(','));
check('规则条数 >= 14（原文规则完整还原）', RULES.length >= 14, `${RULES.length} 条`);
check('核心规则含 PW001–PW014',
  Array.from({ length: 14 }, (_, i) => `PW${String(i + 1).padStart(3, '0')}`).every((id) => ids.includes(id)));
check('每条规则都有 severity/title/fix',
  RULES.every((r) => ['ERROR', 'WARN'].includes(r.severity) && r.title && r.fix));
check('每条规则都有 tier', RULES.every((r) => ['core', 'ext'].includes(r.tier)));
check('PW105 不存在（该编号已废弃，不得被实现）', !ids.includes('PW105'));
const coreN = RULES.filter((r) => r.tier === 'core').length;
const extN = RULES.filter((r) => r.tier === 'ext').length;
check('核心/补充分档合理', coreN === 14 && extN >= 4, `core ${coreN} / ext ${extN}`);

/* ---- 2) 文档引用一致性 ---- */
check('references 目录存在', fs.existsSync(REFS));
const refFiles = fs.readdirSync(REFS).filter((f) => f.endsWith('.md'));
check('文档数 >= 10', refFiles.length >= 10, `${refFiles.length} 篇`);

const docs = new Map();
for (const f of refFiles) docs.set(f, fs.readFileSync(path.join(REFS, f), 'utf8'));
const skillMd = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
docs.set('SKILL.md', skillMd);

// 收集所有文档里提到的编号
const mentioned = new Set();
for (const text of docs.values()) {
  for (const m of text.match(/PW\d{3}/g) || []) mentioned.add(m);
  for (const m of text.match(/CFG\d{3}/g) || []) mentioned.add(m);
}

// 2a) 文档提到的 PW 编号必须真实存在。
// PW105 是唯一的特例：它被明确定义为「不存在」，所以允许出现，
// 但**每一处出现都必须在声明它不存在**（不能有任何一处把它当成真规则来引用）。
// 判定按「整个文件」做，而不是逐条 80 字窗口 —— 标题和正文可能把「不存在」分开写。
const badPw = [...mentioned].filter((id) => id.startsWith('PW') && !ids.includes(id));
const LEGIT_ABSENCE = /不存在|已废弃|不要引用|没有这条|未实现|都是错的/;
const illegal = [];
for (const id of badPw) {
  for (const [f, text] of docs) {
    const re = new RegExp(`[^\\n]{0,120}${id}[^\\n]{0,120}`, 'g');
    const ctxs = text.match(re) || [];
    if (!ctxs.length) continue;
    const allLegit = ctxs.every((c) => LEGIT_ABSENCE.test(c));
    if (!allLegit) illegal.push(`${id}@${f}`);
  }
}
check('文档提到的不存在编号都只用于「声明它不存在」', illegal.length === 0, illegal.join(','));
if (badPw.length) {
  check(`  特例说明：${badPw.join(',')} 属于「声明不存在」，允许出现`, illegal.length === 0,
    badPw.join(','));
}

// 2b) 实际核心规则必须至少被一篇文档提到
const undocumented = RULES.filter((r) => r.tier === 'core' && !mentioned.has(r.id)).map((r) => r.id);
check('每条核心规则都有文档覆盖', undocumented.length === 0, undocumented.join(','));

// 2c) CFG 编号必须在 configcheck 的规则集合里
const cfgSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'lib', 'configcheck.js'), 'utf8');
const cfgImplemented = new Set(cfgSrc.match(/CFG\d{3}/g) || []);
const badCfg = [...mentioned].filter((id) => id.startsWith('CFG') && !cfgImplemented.has(id));
check('文档未引用不存在的 CFG 编号', badCfg.length === 0, badCfg.join(','));
check('configcheck 实现了 CFG001–CFG012 的主体',
  ['CFG001', 'CFG002', 'CFG003', 'CFG004', 'CFG005', 'CFG006', 'CFG007', 'CFG008'].every((id) => cfgImplemented.has(id)),
  [...cfgImplemented].sort().join(','));

/* ---- 3) SKILL.md 入口契约 ---- */
check('SKILL.md 有 YAML frontmatter', /^---\n[\s\S]*?\n---\n/.test(skillMd));
check('description 写明了「什么时候不用」/边界',
  /不负责|不适用|不做什么|明确不负责/.test(skillMd.slice(0, 2000)),
  'description 只写能做什么会让触发面失控：用户让你写单元测试它也会自信地接活');
check('SKILL.md 指出目录树（渐进披露）', /references\/|scripts\/|assets\//.test(skillMd));
check('SKILL.md 含硬规则且写成一句 No', /No 裸 XPath|No 固定时长等待/.test(skillMd), '硬规则要一眼能判定违反');
check('SKILL.md 含输出契约（每条用例证明了什么）', /证明了什么/.test(skillMd));
check('SKILL.md 引用了全部 12 篇 references',
  refFiles.every((f) => skillMd.includes(f)),
  refFiles.filter((f) => !skillMd.includes(f)).join(','));

/* ---- 4) assets 与 scripts 完整性 ---- */
const assets = fs.readdirSync(path.join(SKILL, 'assets'));
check('assets 有配置基线模板', assets.includes('playwright.config.ts'));
check('assets 有用例骨架模板', assets.includes('test-template.spec.ts'));
check('assets 有页面对象模板', assets.includes('page-object-template.ts'));
check('assets 有 AGENTS.md 规范片段', assets.includes('AGENTS.md'));
check('assets 有账号映射示例', assets.includes('accounts.example.json'));

const scripts = fs.readdirSync(path.join(SKILL, 'scripts'));
for (const s of ['lint_spec.mjs', 'check_config.mjs', 'summarize_report.mjs', 'run_verify.mjs', 'check_standards.mjs', 'selfcheck.mjs', 'verify-lib.mjs']) {
  check(`scripts 有 ${s}`, scripts.includes(s));
}

/* ---- 5) 工具面与文档的对应 ---- */
const serverSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'server.mjs'), 'utf8');
const toolNames = [...serverSrc.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
check('server 暴露 >= 13 个工具', toolNames.length >= 13, `${toolNames.length} 个：${toolNames.join(',')}`);
const missingInSkill = toolNames.filter((t) => !skillMd.includes(t));
check('SKILL.md 提到所有工具', missingInSkill.length === 0, missingInSkill.join(','));

log('');
log(failures === 0 ? '规则表与文档一致性检查全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
