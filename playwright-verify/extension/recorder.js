/**
 * 录制纯函数核 —— 悬浮器（floating.js）只调用这里的函数。
 *
 * 边界（红线）：
 *   1) 不碰 DOM 事件、不发网络、不读存储 —— 这里只有纯函数，可被 Node 直接加载测试；
 *   2) 敏感字段（口令/卡号/校验码一类）不录制 —— 录到的值会进生成脚本，凭据不进产物；
 *   3) 定位器优先级与 generate.js 的 canonicalLocator 同一口径：
 *      testid > label > role > placeholder > text > selector，绝不产出 XPath / nth-child。
 *
 * 本文件是经典脚本（内容脚本不能用 ESM），导出挂在全局 pvRecorderCore 上；
 * Node 测试用 vm 加载后读同一个全局。
 */
var pvRecorderCore = (function () {
  'use strict';

  /** 录制步数上限：长会话不把生成器喂撑，超出即截断（调用方按数量差如实提示）。 */
  var MAX_RECORDED_STEPS = 200;

  var SENSITIVE_RE = /(pass|pwd|secret|token|cvv|cvc|otp|card|ssn|idcard|verifycode|密码|口令|验证码|校验码|卡号|证件)/i;

  /**
   * 敏感字段判定。宁可多跳过（少录一条不丢测试），不可漏过（凭据进产物是红线）。
   * desc 形状：{ type, autocomplete, name, id, placeholder, label }
   */
  function isSensitiveField(desc) {
    var d = desc || {};
    var type = String(d.type || '').toLowerCase();
    if (type === 'password') return true;
    if (String(d.autocomplete || '').toLowerCase().indexOf('cc-') === 0) return true;
    var haystack = [d.name, d.nameAttr, d.id, d.placeholder, d.label].map(function (v) { return String(v || ''); }).join(' ');
    return SENSITIVE_RE.test(haystack);
  }

  /** 输入类元素的隐含 role（button/a 这类语义标签自带 role）。 */
  function deriveRole(desc) {
    var tag = String(desc.tag || '').toLowerCase();
    var type = String(desc.type || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return 'heading';
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
    return '';
  }

  /** selector 兜底：只用稳定形态（#id / tag[name]），绝不 XPath / nth-child。 */
  function stableSelector(desc) {
    var tag = String(desc.tag || 'div').toLowerCase();
    var id = String(desc.id || '');
    if (/^[A-Za-z][\w-]{0,39}$/.test(id)) return '#' + id;
    var nameAttr = String(desc.nameAttr || '');
    if (/^[A-Za-z][\w-]{0,39}$/.test(nameAttr)) return tag + '[name="' + nameAttr + '"]';
    return tag;
  }

  /**
   * 代码/样式文本判定：这类文本多半是录到了 <style> 或模版宿主的 textContent
   * （真机实测抓过：.gitee-modal { width: 500px !important… 被当文本定位器，回放必失配）。
   * 当文本定位器前先排除；口径收窄到代码特征（花括号 / !important / function·var·const 声明），
   * 普通中文说明文（含。（）、数字）不误伤。
   */
  function looksLikeCode(text) {
    var s = String(text || '');
    return /[{}]/.test(s) || /!\s*important/i.test(s) || /\b(?:function|var|const)\s+\w/.test(s);
  }

  /**
   * 从元素描述构建定位器。优先级与 generate.js 的推断口径一致：
   * testid > label > role > placeholder > text > selector。
   * desc 形状：{ tag, type, testid, label, name, placeholder, text, id, nameAttr }
   */
  function buildLocator(desc) {
    var d = desc || {};
    var testid = String(d.testid || '').trim();
    if (testid) return { kind: 'testid', id: testid };
    var label = String(d.label || '').trim();
    if (label) return { kind: 'label', text: label };
    var role = deriveRole(d);
    var name = String(d.name || '').trim();
    if (role && name) return { kind: 'role', role: role, name: name };
    var placeholder = String(d.placeholder || '').trim();
    if (placeholder) return { kind: 'placeholder', text: placeholder };
    var text = String(d.text || '').trim();
    if (text && !looksLikeCode(text)) return { kind: 'text', text: text };
    return { kind: 'selector', selector: stableSelector(d) };
  }

  function locatorKey(loc) {
    if (!loc || typeof loc !== 'object') return '';
    return [loc.kind, loc.id, loc.text, loc.role, loc.name, loc.selector].map(function (v) { return String(v || ''); }).join('|');
  }

  var KNOWN_ACTS = ['goto', 'fill', 'click', 'check', 'uncheck', 'select', 'press', 'hover'];

  /**
   * 录制步骤归一（喂给 generate_scripts 之前）：
   *   1) 非法动作丢弃 —— 不把不认识的步骤混进生成器；
   *   2) 同定位器连续 fill 合并成最后一条 —— 逐键 input 事件不该产出 N 条填表；
   *   3) 完全相同的连续步骤去重（连点两下按钮只算一次）；
   *   4) 超上限截断到 MAX_RECORDED_STEPS。
   */
  function normalizeRecordedSteps(steps) {
    var out = [];
    var lastFill = {}; // locatorKey → 最近一次 fill/select 的值：同值重复零信息损失，可跨 press/点击丢弃
    var list = Array.isArray(steps) ? steps : [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var act = String(s.act || '');
      if (KNOWN_ACTS.indexOf(act) === -1) continue;
      var norm = { act: act, locator: s.locator || null };
      if (act === 'fill' || act === 'select') norm.value = String(s.value == null ? '' : s.value);
      if (act === 'press') norm.key = String(s.key || 'Enter');
      if (act === 'goto') norm.url = String(s.url || '');
      if (!norm.locator && act !== 'goto') continue;

      var lk = locatorKey(norm.locator);
      if (norm.act === 'fill' || norm.act === 'select') {
        // 同定位器同值的重复 fill 丢弃（如 Playwright press(Enter) 会补发 change → 再录一条同值 fill）；
        // 值不同则保留（用户改值是真信息，绝不吞）
        if (lastFill[lk] === norm.value) continue;
        lastFill[lk] = norm.value;
        var prevF = out[out.length - 1];
        if (prevF && prevF.act === norm.act && locatorKey(prevF.locator) === lk) {
          prevF.value = norm.value; // 连续同定位器 fill：留最终值
          continue;
        }
        out.push(norm);
      } else {
        var prev = out[out.length - 1];
        if (prev && prev.act === norm.act && lk === locatorKey(prev.locator)
          && prev.value === norm.value && prev.key === norm.key && prev.url === norm.url) continue;
        out.push(norm);
      }
      if (out.length >= MAX_RECORDED_STEPS) break;
    }
    return out;
  }

  /**
   * 录制管理（多条列表，单槽升级）：纯函数、不可变更新、容量帽诚实截断。
   * 存储形状：pv_recordings_list = [{id, name, url, steps, savedAt}]；
   * 旧单槽 pv_recordings 保留写入（兼容）+ 读取迁移（老数据不丢）。
   */
  var MAX_RECORDINGS = 10;

  function makeRecording(name, url, steps) {
    var clean = normalizeRecordedSteps(steps);
    return {
      id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name || '未命名录制').slice(0, 40),
      url: String(url || ''),
      steps: clean,
      savedAt: Date.now(),
    };
  }

  /** 前插 + 容量帽：超出丢最旧并如实报 dropped（不静默吞）。 */
  function addRecording(list, rec, cap) {
    var max = Number(cap) > 0 ? Number(cap) : MAX_RECORDINGS;
    var out = [rec].concat(Array.isArray(list) ? list : []);
    var dropped = 0;
    while (out.length > max) { out.pop(); dropped += 1; }
    return { list: out, dropped: dropped };
  }

  /** 改名：空名/全空白拒绝（返回原列表，不制造无名录制）；未命中 id 诚实不动。 */
  function renameRecording(list, id, name) {
    var next = String(name || '').trim().slice(0, 40);
    if (!next) return Array.isArray(list) ? list : [];
    return (Array.isArray(list) ? list : []).map((r) => (r && r.id === id ? Object.assign({}, r, { name: next }) : r));
  }

  /** 删除：未命中 id 诚实不动（不报成功）。 */
  function deleteRecording(list, id) {
    return (Array.isArray(list) ? list : []).filter((r) => !(r && r.id === id));
  }

  /** 旧单槽 pv_recordings → 列表（自动命名）；空/坏数据 → []，不伪造条目。 */
  function migrateLegacyRecordings(legacy) {
    if (!legacy || !Array.isArray(legacy.steps) || !legacy.steps.length) return [];
    return [makeRecording('旧录制 ' + (legacy.savedAt ? new Date(legacy.savedAt).toLocaleTimeString() : ''), legacy.url, legacy.steps)];
  }

  function findRecording(list, id) {
    var found = (Array.isArray(list) ? list : []).filter((r) => r && r.id === id);
    return found.length ? found[0] : null;
  }

  /**
   * 录制步骤 → generate_scripts 入参（键集必须落在它的 inputSchema 白名单内，
   * 多一个字段都会被 additionalProperties:false 拒掉）。
   * 默认 write:false（先审再写）；overwrite 恒 false（绝不静默覆盖手写脚本）。
   */
  function stepsToGenerateInput(steps, meta) {
    var m = meta || {};
    var clean = normalizeRecordedSteps(steps).filter(function (s) { return s.act !== 'goto'; });
    var pageName = String(m.pageName || 'recorded');
    var input = {
      pages: [{ name: pageName, navPath: String(m.navPath || '/'), steps: clean }],
      cases: [{
        title: String(m.title || '录制回放'),
        page: pageName,
        claims: String(m.claims || '录制会话捕获的行为序列（提交前请人工确认）'),
        steps: clean,
        nav: true,
      }],
      spec: String(m.spec || 'recorded'),
      write: m.write === true,
      overwrite: false,
      outDir: String(m.outDir || 'generated'),
    };
    if (m.cwd) input.cwd = String(m.cwd);
    return input;
  }

  /**
   * 导出文件名清洗（纯函数，vm 可测）：录制名 → 下载安全形。
   * Windows 保留字符与路径分隔符换 _，空白压成 -，首尾 .- 剥离，60 字符帽
   * （超长路径在部分下载目录会失败），尾部残留 .- 再剥；空名/全符号回落 recording。
   * stamp 可注入（钉用固定值断言，真实调用传时间戳防同名覆盖）。
   */
  function exportFileName(recName, stamp) {
    var base = String(recName == null ? '' : recName)
      .replace(/[\\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .slice(0, 60)
      .replace(/[.\-]+$/, '');
    // 空名与「全符号洗成的下划线糊」都不携带命名信息 —— 回落 recording 比 ___ 诚实
    if (!base || /^_+$/.test(base)) base = 'recording';
    return 'pv-export-' + base + (stamp ? '-' + String(stamp) : '') + '.json';
  }

  /**
   * 定位器 → DOM 查询计划（回放用）。与 buildLocator 互为逆向：
   * buildLocator 从元素描述收敛成定位器，locatorToQuery 再把定位器展开成查询策略。
   * kind 非法直接抛错 —— 回放绝不「猜一个元素接着点」，宁可诚实失败。
   */
  function locatorToQuery(loc) {
    var l = loc || {};
    var kind = String(l.kind || '');
    switch (kind) {
      case 'testid': return { mode: 'testid', value: String(l.id || '') };
      case 'label': return { mode: 'label', value: String(l.text || '') };
      case 'role': return { mode: 'role', value: String(l.name || ''), role: String(l.role || '') };
      case 'placeholder': return { mode: 'placeholder', value: String(l.text || '') };
      case 'text': return { mode: 'text', value: String(l.text || '') };
      case 'selector': return { mode: 'selector', value: String(l.selector || '') };
      default: throw new Error('未知的定位类型：「' + kind + '」。可用：role / label / testid / text / placeholder / selector');
    }
  }

  /** 步骤 → 人类可读的一行（面板日志用）。 */
  function describeStep(s) {
    var step = s || {};
    var loc = step.locator || {};
    var target = loc.id || loc.text || loc.name || loc.selector || '';
    if (step.act === 'fill') return '填写「' + target + '」';
    if (step.act === 'press') return '在「' + target + '」按 ' + (step.key || 'Enter');
    if (step.act === 'goto') return '打开 ' + step.url;
    var actZh = { click: '点击', check: '勾选', uncheck: '取消勾选', select: '选择', hover: '悬停' };
    return (actZh[step.act] || step.act) + '「' + target + '」';
  }

  return {
    MAX_RECORDED_STEPS: MAX_RECORDED_STEPS,
    MAX_RECORDINGS: MAX_RECORDINGS,
    isSensitiveField: isSensitiveField,
    looksLikeCode: looksLikeCode,
    deriveRole: deriveRole,
    buildLocator: buildLocator,
    locatorKey: locatorKey,
    locatorToQuery: locatorToQuery,
    describeStep: describeStep,
    normalizeRecordedSteps: normalizeRecordedSteps,
    stepsToGenerateInput: stepsToGenerateInput,
    exportFileName: exportFileName,
    makeRecording: makeRecording,
    addRecording: addRecording,
    renameRecording: renameRecording,
    deleteRecording: deleteRecording,
    migrateLegacyRecordings: migrateLegacyRecordings,
    findRecording: findRecording,
  };
})();

// 内容脚本与 Node vm 测试从同一个全局取
if (typeof globalThis !== 'undefined') globalThis.pvRecorderCore = pvRecorderCore;
