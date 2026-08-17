/**
 * dsh-plugin-stylotrace — Node 半区（client bundle 的宿主侧 + 文件预览路由）。
 *
 * 本包有两个 loader 行：
 *   - `dsh-plugin-stylotrace/mcp`   → MCP 桥（见 mcp.js）
 *   - `dsh-plugin-stylotrace`       → 本文件：
 *       1) client bundle 的 Node 半区（占位）；
 *       2) 文件预览路由 `/stylotrace/file?path=<abs>` —— Codex 式"在 web 中
 *          显示文件"：client 侧 fetch 本路由读取文件内容并内嵌渲染。
 *          （仅当 webServer 服务可用时注册；headless/无 host 环境自动跳过。）
 *
 * 安全约束：
 *   - 只读：仅 GET；绝不写文件；
 *   - 路径必须绝对路径、必须存在且是文件；
 *   - 大小上限 300KB（超出返回 too-large，由 client 提示用系统打开）；
 *   - 文本扩展名直接返回内容；docx/pdf 等二进制返回 binary 标记与提示；
 *   - 路由挂在 host 的 webServer 下，仅本机部署可达。
 */

import fs from 'node:fs'
import path from 'node:path'

export const name = 'stylotrace-client'

export const description =
  '深度协作写作 Agent（DSH 插件）：40+ 个 MCP 写作工具 + 完整技能包 + Web 增强' +
  '（选中文本 → Stylotrace 引用改进；批注系统；作品识别；文件内嵌预览）。' +
  '先读懂作者再动笔——四层风格向量 + 外层调制器、澄清→大纲→逐节写作→红队审计→' +
  '读者群像→交付、项目/上下文自动提炼成文。'

export const version = '0.1.3'

/** Skill bundle shipped inside this package (`<pkg>/skills/stylotrace`). */
export const bundledSkill = 'skills/stylotrace'

/** MCP server name registered on ctx.tools (tools surface as mcp__stylotrace__*). */
export const mcpServerName = 'stylotrace'

/** 文件预览路由前缀（client 侧 fetch 用）。 */
export const FILE_ROUTE = '/stylotrace/file'

const MAX_PREVIEW_BYTES = 300 * 1024

const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.yml', '.yaml', '.toml',
  '.py', '.sh', '.bash', '.zsh', '.rb', '.go', '.rs', '.java', '.c', '.cpp',
  '.h', '.sql', '.csv', '.log', '.ini', '.cfg', '.env', '.svg', '.gitignore',
])

const BINARY_HINT = {
  '.docx': 'Word 文档（点击"系统打开"用 Word 打开）',
  '.pdf': 'PDF 文档（点击"系统打开"用 PDF 阅读器打开）',
  '.xlsx': 'Excel 表格',
  '.pptx': 'PowerPoint 演示',
  '.doc': 'Word 文档（旧格式）',
  '.zip': '压缩包',
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.gif': '图片', '.webp': '图片',
  '.mp4': '视频', '.mp3': '音频',
}

function writeJson(res, status, obj) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  } catch {}
}

function fence(req) {
  // 轻量护栏：仅允许本机部署的 GET 请求（webServer 本身只在本机监听）。
  try {
    if (req.method !== 'GET') return false
    const host = req.headers && req.headers.host ? String(req.headers.host) : ''
    if (!host) return true // 无 Host 头视为本机内部
    const h = host.split(':')[0]
    return h === 'localhost' || h === '127.0.0.1' || h === '::1'
  } catch {
    return false
  }
}

export function apply(ctx) {
  // 条件注入：webServer 可用才注册路由（headless/无 host 部署自动跳过，插件仍正常）。
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => sctx.webServer.register({
      kind: 'prefix',
      path: FILE_ROUTE,
      handler: async (req, res) => {
        if (!fence(req)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const raw = url.searchParams.get('path')
          if (!raw) {
            writeJson(res, 400, { ok: false, error: 'path required' })
            return
          }
          const abs = path.resolve(String(raw))
          const st = fs.statSync(abs)
          if (!st.isFile()) {
            writeJson(res, 400, { ok: false, error: 'not a file' })
            return
          }
          if (st.size > MAX_PREVIEW_BYTES) {
            writeJson(res, 413, { ok: false, error: 'file too large for preview', path: abs })
            return
          }
          const ext = path.extname(abs).toLowerCase()
          const name = path.basename(abs)
          if (TEXT_EXT.has(ext)) {
            const content = fs.readFileSync(abs, 'utf8')
            writeJson(res, 200, { ok: true, name, path: abs, content, kind: 'text' })
          } else {
            writeJson(res, 200, {
              ok: true, name, path: abs, binary: true, kind: 'binary',
              hint: BINARY_HINT[ext] || '二进制文件（点击"系统打开"用默认应用打开）',
            })
          }
        } catch (e) {
          writeJson(res, 500, { ok: false, error: String(e && e.message || e) })
        }
      },
    }), 'dsh-plugin-stylotrace: /stylotrace/file route')
  })
}
