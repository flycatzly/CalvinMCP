/**
 * standards.js — 团队测试规范（AGENTS.md）的生成与校验
 *
 * 原文的观察：个人跑通不难，难的是团队不跑偏。
 * 把「无论做什么任务都要遵守」的测试规范写进 AGENTS.md，比在群里反复叮嘱管用。
 *
 * 所以这里做两件事：
 *   1) 生成一份可用的 AGENTS.md 片段（四条硬要求）；
 *   2) 校验现有 AGENTS.md 有没有覆盖这四条 —— 缺哪条就说清缺哪条、怎么补。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 四条「无论做什么任务都要遵守」的测试规范。每条的判据是可检索的关键词。 */
export const STANDARDS = [
  {
    id: 'STD001',
    title: '证据落盘到约定目录',
    requirement: '快照、截图、trace、日志一律落到 .playwright-artifacts/ 的约定子目录，不散在临时路径。',
    rationale: '散在临时路径的证据，评审时找不到；进不了制品库，也就等于没有。',
    markers: [/\.playwright-artifacts/, /落盘|artifact/i],
  },
  {
    id: 'STD002',
    title: '回归默认走 CLI + Skill，MCP 只留做探索',
    requirement: '长流程回归用 playwright-cli 落盘执行；MCP 浏览器工具只用于探索与定位，不用于跑完整回归。',
    rationale: '把完整页面状态反复灌进上下文会烧掉大量 Token（官方基准里一个多步骤会话可到 87000+），'
      + '后面的断言与失败定位会被挤掉；CLI 落盘能省下四倍多。',
    markers: [/cli/i, /探索|explore/i],
  },
  {
    id: 'STD003',
    title: '脚本必须先验证通过再保存',
    requirement: '生成的用例必须先过静态门禁（lint ERROR 0）并实际跑通，才允许写入仓库。',
    rationale: '脚本还没跑通就提交，是这条流程里最容易踩的坑。'
      + '「先自行验证再保存」是测试规范，不是可选项。',
    markers: [/验证.{0,6}(通过|保存)|先.{0,4}验证/, /lint|门禁/],
  },
  {
    id: 'STD004',
    title: '快照、截图、脚本都进制品库',
    requirement: 'CI 产物包含快照、截图、trace 与脚本，评审缺陷时直接引用产物，不靠口头复述。',
    rationale: '哪一步挂了，打开对应文件就能定位，不用重新跑一遍复现。',
    markers: [/制品|artifact/i, /快照|snapshot/i],
  },
];

/** 生成 AGENTS.md 片段（可直接粘贴到项目根的 AGENTS.md）。 */
export function renderStandardsMd(opts = {}) {
  const { artifactsDir = '.playwright-artifacts' } = opts;
  const lines = [];
  lines.push('## 测试规范（无论做什么任务都要遵守）');
  lines.push('');
  lines.push('以下四条是硬要求，不随任务类型变化。评审时按这四条对照。');
  lines.push('');
  for (const s of STANDARDS) {
    lines.push(`### ${s.id} ${s.title}`);
    lines.push('');
    lines.push(s.requirement.replace(/\.playwright-artifacts/g, artifactsDir));
    lines.push('');
    lines.push(`理由：${s.rationale}`);
    lines.push('');
  }
  lines.push('### 命令入口');
  lines.push('');
  lines.push('```bash');
  lines.push(`# 跑之前：配置基线是否可信（放最前面，因为它错的时候后面全是白干）`);
  lines.push('node scripts/check_config.mjs playwright.config.ts');
  lines.push('');
  lines.push('# 合入前：用例静态扫描，ERROR 必须为 0');
  lines.push('node scripts/lint_spec.mjs tests/');
  lines.push('');
  lines.push('# 跑之后：失败归因与派活');
  lines.push('node scripts/summarize_report.mjs test-results/report.json');
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/**
 * 校验一个 AGENTS.md（或任意规范文件）是否覆盖了四条规范。
 * @param {string} content
 * @param {string} [file]
 */
export function checkStandardsContent(content, file = 'AGENTS.md') {
  const text = String(content || '');
  const findings = STANDARDS.map((s) => {
    // 判据：所有 markers 都能命中才算覆盖
    const missing = s.markers.filter((re) => !re.test(text));
    const found = missing.length === 0;
    return {
      id: s.id,
      title: s.title,
      covered: found,
      level: found ? 'INFO' : 'WARN',
      requirement: s.requirement,
      rationale: s.rationale,
      missingHints: missing.map((re) => String(re)),
      fix: found ? '无需修改。' : `补上「${s.title}」：${s.requirement}`,
    };
  });
  const missing = findings.filter((f) => !f.covered);
  return {
    tool: 'check_standards',
    version: 1,
    file,
    total: STANDARDS.length,
    covered: findings.length - missing.length,
    missing: missing.length,
    // 规范缺失不阻断流水线（它是人的约定，不是代码缺陷），所以 exitCode 恒为 0，
    // 但把缺失项明确列出来 —— 沉默的缺失才是最贵的。
    summary: {
      missingCount: missing.length,
      exitCode: 0,
      verdict: missing.length === 0 ? 'PASS' : 'INCOMPLETE',
    },
    findings,
    template: renderStandardsMd(),
  };
}

/** 校验项目里的规范文件。找不到时返回模板并提示落点。 */
export function checkStandards(target) {
  const candidates = [];
  const t = target || process.cwd();
  if (fs.existsSync(t) && fs.statSync(t).isFile()) {
    candidates.push(t);
  } else {
    for (const n of ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md', '.github/AGENTS.md']) {
      const p = path.join(t, n);
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  if (!candidates.length) {
    return {
      tool: 'check_standards',
      version: 1,
      file: null,
      total: STANDARDS.length,
      covered: 0,
      missing: STANDARDS.length,
      summary: { missingCount: STANDARDS.length, exitCode: 0, verdict: 'NOT_FOUND' },
      message: `在 ${t} 下没有找到 AGENTS.md / CLAUDE.md。建议在项目根创建 AGENTS.md 并写入下面的测试规范。`,
      findings: STANDARDS.map((s) => ({
        id: s.id, title: s.title, covered: false, level: 'WARN',
        requirement: s.requirement, rationale: s.rationale, fix: `补上「${s.title}」：${s.requirement}`,
      })),
      template: renderStandardsMd(),
    };
  }
  const file = candidates[0];
  return checkStandardsContent(fs.readFileSync(file, 'utf8'), file);
}

export function formatText(report) {
  const out = [];
  out.push(`check_standards  ${report.file || '(未找到规范文件)'}`);
  if (report.message) out.push(report.message);
  out.push('');
  for (const f of report.findings) {
    out.push(`[${f.covered ? 'OK   ' : 'MISS '}] ${f.id}  ${f.title}`);
    if (!f.covered) {
      out.push(`        要求: ${f.requirement}`);
      out.push(`        理由: ${f.rationale}`);
      out.push(`        补法: ${f.fix}`);
    }
  }
  out.push('');
  out.push(`覆盖 ${report.covered}/${report.total}，缺失 ${report.missing}`);
  out.push(`结论: ${report.summary.verdict}`);
  return out.join('\n');
}

export default { checkStandards, checkStandardsContent, renderStandardsMd, formatText, STANDARDS };
