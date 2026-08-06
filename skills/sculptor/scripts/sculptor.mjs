#!/usr/bin/env node
// Sculptor skill 引擎启动器：完整 agent 内嵌于 scripts/engine/（零依赖，无外部 CLI 依赖）。
// engine/ 由 scripts/sync-skill-engine.sh 从 agent/ 生成，CI 校验防漂移；勿手改。
import { fileURLToPath } from 'node:url';

const entry = new URL('./engine/bin/sculptor.js', import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry);
