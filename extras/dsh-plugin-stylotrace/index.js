/**
 * dsh-plugin-stylotrace — Node 半区（client bundle 的宿主侧占位）.
 *
 * 本包有两个 loader 行：
 *   - `dsh-plugin-stylotrace/mcp`   → MCP 桥（见 mcp.js，真正的功能）
 *   - `dsh-plugin-stylotrace`       → client bundle 的 Node 半区（本文件，
 *     空实现；浏览器半区 client.js 经 dsh.client manifest 由 web shell 加载）
 *
 * 元数据导出供工具链与未来平台收录使用。
 */

export const name = 'stylotrace-client'

export const description =
  '深度协作写作 Agent（DSH 插件）：40+ 个 MCP 写作工具 + 完整技能包 + Web 增强' +
  '（选中文本 → Stylotrace 引用改进；自动提炼写作作品识别）。' +
  '先读懂作者再动笔——四层风格向量 + 外层调制器（从亲手修改学每个用户的权重）、' +
  '澄清→大纲→逐节写作→红队审计→读者群像→交付、项目/上下文自动提炼成文。'

export const version = '0.1.0'

/** Skill bundle shipped inside this package (`<pkg>/skills/stylotrace`). */
export const bundledSkill = 'skills/stylotrace'

/** MCP server name registered on ctx.tools (tools surface as mcp__stylotrace__*). */
export const mcpServerName = 'stylotrace'

/** Node 半区占位：浏览器功能在 client.js。 */
export function apply() {}
