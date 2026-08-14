// 全局风格档案：把工作区的风格资产（write/read 档案 + 适配卡 + 旧稿样本 + 修改记录）
// 导出成便携 bundle，或从 bundle 导入合并到另一个工作区。
// 合并语义保守：本地维度置信度 >= 导入值时保留本地；证据求并集；
// 适配卡本地已有则不覆盖；样本/修改记录按内容去重。
import fs from 'node:fs';
import path from 'node:path';
import * as ws from './workspace.js';

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 导出风格 bundle（默认写入 STYLOTRACE_HOME 或当前目录 stylotrace-profile.json）。 */
export function exportProfile(workspace, outFile = '') {
  const vault = path.join(workspace, 'vault');
  const samples = {};
  const samplesDir = path.join(vault, 'style-samples');
  try {
    for (const f of fs.readdirSync(samplesDir).filter((x) => x.endsWith('.md'))) {
      samples[f] = fs.readFileSync(path.join(samplesDir, f), 'utf8');
    }
  } catch {}
  const edits = [];
  try {
    edits = fs
      .readFileSync(path.join(vault, 'edits.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {}
  const bundle = {
    schemaVersion: '1.0',
    exportedAt: ws.nowIso(),
    writeStyle: readJsonSafe(path.join(vault, 'write-style.json')),
    readStyle: readJsonSafe(path.join(vault, 'read-style.json')),
    adapter: readJsonSafe(path.join(vault, 'style-adapter.json')),
    samples,
    edits,
  };
  const dest = outFile
    ? path.resolve(outFile)
    : process.env.STYLOTRACE_HOME
      ? path.join(process.env.STYLOTRACE_HOME, 'style-profile.json')
      : path.join(workspace, 'vault', 'style-profile-export.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  ws.writeJson(dest, bundle);
  return {
    file: dest,
    samples: Object.keys(samples).length,
    edits: edits.length,
    hasAdapter: Boolean(bundle.adapter),
  };
}

function mergeDims(localObj, incomingObj, key) {
  const local = localObj?.[key] || {};
  const incoming = incomingObj?.[key] || {};
  let merged = 0;
  for (const [k, d] of Object.entries(incoming)) {
    if (!d || typeof d !== 'object') continue;
    const cur = local[k];
    if (cur && (cur.confidence || 0) >= (d.confidence || 0)) {
      // 本地置信度更高：保留本地，但补上缺失的证据
      cur.evidence = [...new Set([...(cur.evidence || []), ...(d.evidence || [])])].slice(0, 12);
    } else {
      local[k] = JSON.parse(
        JSON.stringify({
          ...d,
          evidence: [...new Set([...(cur?.evidence || []), ...(d.evidence || [])])].slice(0, 12),
        }),
      );
    }
    merged += 1;
  }
  if (localObj) localObj[key] = local;
  return merged;
}

/** 导入合并风格 bundle；本地维度不被动覆盖（只升不降，证据并集）。 */
export function importProfile(workspace, inFile) {
  const bundle = readJsonSafe(path.resolve(inFile));
  if (!bundle || !bundle.writeStyle) throw new Error(`不是合法的风格档案 bundle: ${inFile}`);
  const vault = path.join(workspace, 'vault');
  const writeFile = path.join(vault, 'write-style.json');
  const readFile = path.join(vault, 'read-style.json');
  const writeObj = readJsonSafe(writeFile) || { dimensions: {} };
  const readObj = readJsonSafe(readFile) || { structure: {} };
  const dimsMerged =
    mergeDims(writeObj, bundle.writeStyle, 'dimensions') +
    mergeDims(readObj, bundle.readStyle, 'structure');
  writeObj.lastUpdated = ws.nowIso();
  readObj.lastUpdated = ws.nowIso();
  ws.writeJson(writeFile, writeObj);
  ws.writeJson(readFile, readObj);
  // 样本：按内容去重后补入
  const samplesDir = path.join(vault, 'style-samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  let samplesAdded = 0;
  const existingTexts = new Set();
  try {
    for (const f of fs.readdirSync(samplesDir).filter((x) => x.endsWith('.md'))) {
      existingTexts.add(fs.readFileSync(path.join(samplesDir, f), 'utf8').trim());
    }
  } catch {}
  for (const [name, text] of Object.entries(bundle.samples || {})) {
    const t = String(text || '').trim();
    if (!t || existingTexts.has(t)) continue;
    const safe = name.replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40) || 'sample';
    fs.writeFileSync(path.join(samplesDir, `${Date.now()}-${safe}.md`), t + '\n');
    existingTexts.add(t);
    samplesAdded += 1;
  }
  // 修改记录：按 original+changed 去重追加
  const editFile = path.join(vault, 'edits.jsonl');
  const existingEdits = new Set();
  try {
    for (const l of fs.readFileSync(editFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(l);
        existingEdits.add(`${e.original}|${e.changed}`);
      } catch {}
    }
  } catch {}
  let editsAdded = 0;
  for (const e of bundle.edits || []) {
    const key = `${e.original || ''}|${e.changed || ''}`;
    if (existingEdits.has(key)) continue;
    ws.appendLine(editFile, JSON.stringify(e));
    existingEdits.add(key);
    editsAdded += 1;
  }
  // 适配卡：本地已有则不覆盖
  if (bundle.adapter && !fs.existsSync(path.join(vault, 'style-adapter.json'))) {
    ws.writeJson(path.join(vault, 'style-adapter.json'), bundle.adapter);
  }
  ws.logContext(
    workspace,
    'profile-import',
    `导入风格档案：合并 ${dimsMerged} 维、样本 +${samplesAdded}、修改记录 +${editsAdded}`,
  );
  return { dimsMerged, samplesAdded, editsAdded };
}

export function profileStatus(workspace) {
  const vault = path.join(workspace, 'vault');
  const dims = (o, k) =>
    Object.values(o?.[k] || {}).filter((d) => d && (d.confidence || 0) > 0).length;
  return {
    write: dims(readJsonSafe(path.join(vault, 'write-style.json')), 'dimensions'),
    read: dims(readJsonSafe(path.join(vault, 'read-style.json')), 'structure'),
    samples: (() => {
      try {
        return fs.readdirSync(path.join(vault, 'style-samples')).filter((f) => f.endsWith('.md'))
          .length;
      } catch {
        return 0;
      }
    })(),
    edits: ws.countLines(path.join(vault, 'edits.jsonl')),
    hasAdapter: fs.existsSync(path.join(vault, 'style-adapter.json')),
    globalPath: process.env.STYLOTRACE_HOME
      ? path.join(process.env.STYLOTRACE_HOME, 'style-profile.json')
      : '',
  };
}
