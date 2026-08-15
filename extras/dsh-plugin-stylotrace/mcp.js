/**
 * dsh-plugin-stylotrace — Stylotrace MCP bridge plugin row.
 *
 * Wraps the official @deepseek-ai/dsh-mcp-client with the Stylotrace engine
 * pre-wired: the engine ships inside this package (`skills/stylotrace/
 * scripts/engine/`), so the child command is resolved from this module's own
 * install location at runtime. Works on every terminal / profile / platform
 * the same way — no absolute paths in the patch, no environment assumptions.
 *
 * Row config (cordis.patch.yml / profile patch) may override:
 *   env:                 { STYLOTRACE_LLM_API_KEY: 'sk-...', ... } merged into
 *                        the child's scrubbed environment (also STYLOTRACE_LLM_BASE_URL
 *                        / STYLOTRACE_LLM_MODEL / STYLOTRACE_TARGET_WORDS).
 *   toolCallTimeoutMs:   per-call timeout (default 5 min — long for writing steps).
 *   failOnStartupError:  reject activation if initial connection fails (default false).
 *   reconnect:           { enabled, initialDelayMs, maxDelayMs, maxAttempts }.
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

export const name = 'stylotrace'

/** Services required by this plugin (same as the wrapped mcp-client). */
export const inject = ['tools']

/** Relative path from this module to the vendored engine's MCP entry. */
const ENGINE_ENTRY = path.join(
  'skills', 'stylotrace', 'scripts', 'engine', 'bin', 'stylotrace.js',
)

/** Default per-call timeout for MCP tools (writing steps can run minutes). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Load @deepseek-ai/dsh-mcp-client defensively.
 *
 * It is declared as a peerDependency (ecosystem convention for official
 * @deepseek-ai/* packages). It is always present in the DSH installation and
 * in the shared `$DSH_HOME/profiles/node_modules` (the boot's
 * `healProfilesModuleFallback` symlinks the whole dependency tree there), so
 * resolution cascade:
 *   1. plain dynamic import (normal resolution under pnpm's virtual store);
 *   2. `$DSH_HOME/profiles/node_modules` — shared root populated by the boot;
 *   3. `$DSH_HOME/node_modules` — fallback anchor.
 */
async function loadMcpClient() {
  try {
    return await import('@deepseek-ai/dsh-mcp-client')
  } catch { /* fall through to shared-root resolution */ }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const anchors = [
    path.join(dshHome, 'profiles', 'node_modules'),
    path.join(dshHome, 'node_modules'),
  ]
  for (const anchor of anchors) {
    try {
      const require = createRequire(path.join(anchor, '__noop__.cjs'))
      const resolved = require.resolve('@deepseek-ai/dsh-mcp-client')
      return await import(pathToFileURL(resolved).href)
    } catch { /* try next anchor */ }
  }
  throw new Error(
    'dsh-plugin-stylotrace: cannot resolve @deepseek-ai/dsh-mcp-client — ' +
    'install it with `dsh plugin add dsh-plugin-stylotrace` (it is a dependency) ' +
    'or add it to the profile explicitly.',
  )
}

export async function apply(ctx, config = {}) {
  const { apply: applyMcpClient } = await loadMcpClient()
  const here = path.dirname(fileURLToPath(import.meta.url))
  const engineEntry = path.join(here, ENGINE_ENTRY)

  return applyMcpClient(ctx, {
    serverName: 'stylotrace',
    transport: 'stdio',
    command: process.execPath,
    args: [engineEntry, 'mcp'],
    env: config.env ?? {},
    cwd: config.cwd ?? '',
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: config.failOnStartupError ?? false,
    reconnect: config.reconnect ?? {
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30000,
      maxAttempts: 10,
    },
  })
}
