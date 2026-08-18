// preset.js — 内置名家风格预设（从公版名家笔墨蒸馏出的可执行风格指纹）。
//
// 支撑"学习任何人的风格"：开箱即用，用户说"学鲁迅" / "鲁迅的风格" /
// "写成老舍的味儿" 时，命中预设并把风格卡注入改写提示词。
// 零 LLM 开销（确定性读库），文件在 templates/style-presets.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** 读预设库（容错：文件缺失返回空）。 */
export function loadPresets() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'style-presets.json'), 'utf8'));
    return Array.isArray(data.presets) ? data.presets : [];
  } catch {
    return [];
  }
}

/** 列出全部预设（名称 + 一句话定位）。 */
export function listPresets() {
  return loadPresets().map((p) => ({ id: p.id, name: p.name, tagline: p.tagline }));
}

/** 按 id 精确取。 */
export function viewPreset(id) {
  const p = loadPresets().find((x) => x.id === String(id).trim());
  return p || null;
}

/**
 * 从用户的一句话里识别风格预设（"学鲁迅" / "鲁迅的风格" / "写成老舍的味儿" /
 * "luxun" / "像史铁生那样"）。命中返回 preset，否则 null。
 */
export function findPresetByPhrase(phrase) {
  const s = String(phrase || '');
  const presets = loadPresets();
  // 精确 id
  const byId = presets.find((p) => s.includes(p.id));
  if (byId) return byId;
  // 名字命中（"鲁迅" / "学鲁迅" / "鲁迅的风格" / "像史铁生那样"）
  const byName = presets.find((p) => s.includes(p.name));
  if (byName) return byName;
  return null;
}

/**
 * 把风格卡渲染成可注入提示词的文本（9 轴 + 锚点 + 雷区）。
 * 锚点是"能照着复现"的关键——规则会骗人，原句不会。
 */
export function renderPreset(preset) {
  if (!preset) return '';
  const dims = Object.entries(preset.dims || {})
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  const anchors = (preset.anchors || []).map((a) => `  · ${a}`).join('\n');
  const forbidden = (preset.forbidden || []).map((f) => `  × ${f}`).join('\n');
  return [
    `【风格预设：${preset.name}（${preset.tagline}）】`,
    `写法：\n${dims}`,
    anchors ? `锚点原句（模仿句式与语气）：\n${anchors}` : '',
    forbidden ? `雷区（绝不这样做）：\n${forbidden}` : '',
  ].filter(Boolean).join('\n');
}

/** CLI 渲染：preset list。 */
export const PRESET_LIST_RENDER = (list) =>
  list.length
    ? list.map((p) => `  ${p.id}  ${p.name} · ${p.tagline}`).join('\n')
    : '（预设库为空）';

/** CLI 渲染：preset view。 */
export const PRESET_VIEW_RENDER = (p) => renderPreset(p);
