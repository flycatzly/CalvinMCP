/**
 * cli-config.mjs — 浏览器通道配置的唯一决策源（纯函数，无 IO）
 *
 * 为什么抽出来：setup-cli-config.mjs（手动/CI 用）与 install.mjs（装的时候用）
 * 必须做**同一套决策**。两处各写一份的结局一定是漂移 —— 「脚本说 msedge、
 * 安装说 chromium」这种自相矛盾会把「这里能跑、装完就不能跑」的问题变得更难查。
 *
 * 决策矩阵（decideCliConfig），按优先级：
 *   1) PVMCP_BROWSER_CHANNEL 显式指定        → regenerate（显式意图最高）
 *   2) 配置缺失 / 解析失败                    → regenerate（杜绝「装完忘生成」）
 *   3) 配置带 _平台 且与当前平台一致          → keep（含手工调过的 launchOptions）
 *   4) 配置带 _平台 但平台不符（跨平台安装）  → regenerate
 *   5) 配置没有 _平台（手工写的）             → keep（用户显式意图优先）
 *
 * 为什么 5 保留而不重生成：手工配置可能是精心调过的（headless 参数、代理、
 * 指定可执行文件路径），重生成会把它们抹掉 —— 宁可保留也不猜错。
 */

/**
 * 选择浏览器通道。channel 为 null 表示「不指定 channel」（用 Playwright 自带 chromium）。
 * 优先级：--channel 参数 > PVMCP_BROWSER_CHANNEL 环境变量 > 平台默认。
 */
export function pickChannel({ platform = process.platform, flagChannel, envChannel = process.env.PVMCP_BROWSER_CHANNEL } = {}) {
  if (flagChannel) return { channel: String(flagChannel), source: '--channel 参数' };
  if (envChannel) return { channel: String(envChannel), source: 'PVMCP_BROWSER_CHANNEL 环境变量' };
  if (platform === 'win32') return { channel: 'msedge', source: 'Windows 默认（系统自带 Edge）' };
  return { channel: null, source: '非 Windows 默认（chromium）' };
}

/** 构造 cli.config.json 的内容（字节确定性：同输入必同输出，全树哈希比对的前提）。 */
export function buildCliConfig({ platform = process.platform, arch = process.arch, channel, source } = {}) {
  return {
    _说明: '由 setup-cli-config.mjs 生成。显式声明浏览器通道，保证源码目录与安装目录行为一致。',
    _平台: `${platform} (${arch})`,
    _通道来源: source || (channel ? 'PVMCP_BROWSER_CHANNEL 环境变量' : `默认（${platform}）`),
    browser: {
      browserName: 'chromium',
      ...(channel ? { launchOptions: { channel } } : {}),
    },
  };
}

/**
 * 决定已有配置该怎么处理。
 * @param {object} o
 *   cfg       已有配置对象；null = 缺失或解析失败
 *   platform  当前平台（默认 process.platform）
 *   envChannel 环境变量指定的通道（默认读 PVMCP_BROWSER_CHANNEL）
 * @returns {{ action: 'keep' | 'regenerate', reason: string, detail: string }}
 */
export function decideCliConfig({ cfg = null, platform = process.platform, envChannel = process.env.PVMCP_BROWSER_CHANNEL } = {}) {
  if (envChannel) {
    return { action: 'regenerate', reason: 'explicit-channel', detail: `PVMCP_BROWSER_CHANNEL=${envChannel}` };
  }
  if (cfg === null || typeof cfg !== 'object') {
    return { action: 'regenerate', reason: 'missing-or-broken', detail: '配置缺失或解析失败' };
  }
  const plat = typeof cfg._平台 === 'string' ? cfg._平台 : null;
  if (plat && plat.startsWith(platform)) {
    return { action: 'keep', reason: 'same-platform', detail: `配置声明 ${plat}，与当前 ${platform} 一致` };
  }
  if (plat) {
    return { action: 'regenerate', reason: 'cross-platform', detail: `配置声明 ${plat}，当前 ${platform}，需重新生成` };
  }
  return { action: 'keep', reason: 'hand-written', detail: '手工配置（无 _平台 字段），原样保留' };
}

export default { pickChannel, buildCliConfig, decideCliConfig };
