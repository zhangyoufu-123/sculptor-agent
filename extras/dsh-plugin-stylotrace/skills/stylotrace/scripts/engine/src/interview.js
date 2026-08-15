// Phase 1 结构化访谈（Interview）：把澄清阶段变成用户看得见的多轮对话。
// 每一轮：一个问题 + 建议 + 选项 + 确认清单表格 + 进度 + 剩余项。
// 复用 clarifyStep 作为唯一状态机，不另起一套逻辑（避免两套架构打架）。
import readline from 'node:readline';
import { clarifyStep, renderBlueprint, activeBlueprint } from './clarify.js';
import * as ws from './workspace.js';
import { styleProgress } from './style.js';

function checklistOf(state) {
  const c = state.confirmed || {};
  const mats = state.materials || [];
  const rows = activeBlueprint(state).map((f) => ({
    key: f.key,
    label: f.label,
    required: f.required,
    count: f.count || 1,
    list: f.list || '',
  }));
  // v0.37：大纲/蓝图由 LLM 从对话总结并进入"正式大纲确认"，不再单列蓝图确认项。
  rows.push({
    key: 'outlineConfirm',
    label: '大纲确认',
    required: true,
    count: 1,
    list: '',
  });
  return rows.map((row) => {
    let done = false;
    let note = '';
    if (row.list === 'materials') {
      done = mats.length >= (row.count || 1);
      note = `${mats.length}/${row.count}`;
    } else if (row.list === 'arguments') {
      const args = c.arguments || [];
      done = args.length >= (row.count || 1);
      note = `${args.length}/${row.count}`;
    } else if (row.list === 'items') {
      const items = c.items || [];
      done = items.length >= (row.count || 1);
      note = `${items.length}/${row.count}`;
    } else if (row.key === 'styleSample') {
      done = Boolean(c.styleSample);
      note = c.styleNote ? '已记录' : '';
    } else if (row.key === 'emotion') {
      done = Boolean(c.emotionalCurve);
      note = c.emotionalCurve ? '已确认' : '';
    } else if (row.key === 'ending') {
      done = Boolean(c.endingTaste);
      note = c.endingTaste ? '已确认' : '';
    } else if (row.key === 'outlineConfirm') {
      done = Boolean(c.outlineConfirmed) || Boolean(state.liveOutline?.complete);
      note = c.outlineConfirmed ? '已确认' : state.liveOutline?.complete ? '已成形，待确认' : '';
    } else {
      done = Boolean(c[row.key]);
      note = c[row.key] ? '已确认' : '';
    }
    return { ...row, done, note };
  });
}

export function renderChecklist(state) {
  const rows = checklistOf(state);
  const done = rows.filter((r) => r.done).length;
  const line = '─'.repeat(46);
  const out = [line, 'Stylotrace 需求访谈 · 确认清单', line];
  for (const r of rows) {
    const mark = r.done ? '✓' : '…';
    const extra = r.note ? `（${r.note}）` : '';
    out.push(`${mark} ${r.label}${extra}${r.done ? '' : ' — 待确认'}`);
  }
  out.push(line);
  out.push(
    `进度: ${done}/${rows.length}${rows.some((r) => !r.required) ? '（* 可选维度，用户连续两次说"你决定"可跳过）' : ''}`,
  );
  return out.join('\n');
}

function remainingOf(state) {
  const rows = checklistOf(state);
  const remain = rows.filter((r) => !r.done);
  const coreMissing = remain.filter((r) => r.required);
  return {
    all: remain.map((r) => r.label),
    core: coreMissing.map((r) => r.label),
    coreCount: coreMissing.length,
  };
}

/**
 * 单步访谈：应用用户最新回答，返回下一个问题 + 清单 + 进度 + 风格进度。
 * 与 clarifyStep 共享同一个状态机；只多包一层"用户可见的结构化视图"。
 */
export async function interviewStep(cfg, wsDir, { lastInput = '' } = {}) {
  const workspace = ws.ensureWorkspace(wsDir);
  const r = await clarifyStep(cfg, workspace, { lastInput });
  const state = ws.readState(workspace);
  const remaining = remainingOf(state);
  return {
    ...r,
    checklist: checklistOf(state),
    remaining,
    ready: Boolean(r.ready),
    done:
      remaining.coreCount === 0 &&
      Boolean(state.confirmed?.styleSample) &&
      (Boolean(state.confirmed?.outlineConfirmed) || Boolean(state.liveOutline?.complete)),
    blueprint: state.blueprint,
    summary: renderChecklist(state),
    style: styleProgress(workspace),
  };
}

/** 打包确认清单 + 进展 + 剩余步骤（不消耗 LLM，随时可看）。 */
export async function interviewSummary(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const state = ws.readState(workspace);
  const remaining = remainingOf(state);
  const progress = styleProgress(workspace);
  const lines = [];
  lines.push(renderChecklist(state));
  lines.push('');
  if (Object.keys(state.confirmed || {}).length) {
    lines.push('已确认内容:');
    for (const [k, v] of Object.entries(state.confirmed || {})) {
      if (k === 'arguments') {
        (v || []).forEach((a, i) => lines.push(`  · 论点${i + 1} — ${a}`));
      } else if (k === 'styleNote' || k === 'styleSampleFile') {
        continue;
      } else if (k !== 'styleSample') {
        lines.push(`  · ${k} — ${v}`);
      }
    }
  }
  if ((state.materials || []).length) {
    lines.push('素材:');
    for (const m of state.materials) lines.push(`  ✓ ${m}`);
  }
  if (Object.keys(state.blueprint || {}).length) {
    lines.push('');
    lines.push('整篇文章蓝图:');
    lines.push(renderBlueprint(state));
  }
  lines.push('');
  lines.push(
    `风格档案: write 已学 ${progress.write.learned}/${progress.write.total} 维 · read ${progress.read.learned}/${progress.read.total} 维`,
  );
  const top = progress.write.top.slice(0, 3);
  if (top.length) {
    lines.push('最近学到的风格信号:');
    for (const t of top) {
      lines.push(
        `  · ${t.dim} → ${t.value}（置信 ${(t.confidence * 100).toFixed(0)}%${t.evidence?.length ? '，依据: ' + t.evidence.slice(-1)[0] : ''}）`,
      );
    }
  }
  lines.push('');
  if (remaining.coreCount === 0) {
    lines.push(`剩余: 核心需求已齐，可进入大纲（stylotrace outline）。`);
    lines.push(
      '下一步: 确认大纲后运行 stylotrace write，写完 stylotrace redteam，交付前跑 stylotrace audience。',
    );
  } else {
    lines.push(`剩余核心: ${remaining.core.join('、')}`);
    lines.push(
      '下一步: 继续回答访谈问题（stylotrace interview），或逐条回答（stylotrace clarify --once）。',
    );
  }
  return lines.join('\n');
}

export async function interviewInteractive(cfg, wsDir) {
  const workspace = ws.ensureWorkspace(wsDir);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  const LOW_WILL = /没(有|什么)?更多|你决定|你自己决定|就这样|先这样|可以了|够了|你看着办/;
  let lowWill = 0;
  let lastInput = '';
  console.log(
    'Stylotrace 需求访谈（每轮一个问题；回答完会更新确认清单；随时说"你决定"跳过可选维度）\n',
  );
  try {
    while (true) {
      const next = await interviewStep(cfg, workspace, { lastInput });
      console.log('\n' + next.summary + '\n');
      if (next.done || next.stop) {
        console.log(
          next.done ? '✓ 访谈完成，需求已结构化确认。' : '访谈结束（用户低意愿或素材未齐）。',
        );
        break;
      }
      if (!next.question) break;
      let prompt = `\n${next.question}`;
      if (next.recommendation) prompt += `\n我的建议: ${next.recommendation}`;
      if (next.options?.length)
        prompt += `\n选项: ${next.options.map((o, i) => `${'ABC'[i]}. ${o}`).join('  ')}`;
      const answer = await ask(prompt + '\n> ');
      if (LOW_WILL.test(answer)) lowWill += 1;
      else lowWill = 0;
      if (lowWill >= 2 && next.ready) {
        // 用户连续两次低意愿且核心已齐 → 记下"用户主动终止"，直接收工
        const state = ws.readState(workspace);
        state.summary = '访谈完成（用户低意愿，跳过可选维度）';
        state.nextStep = '运行 stylotrace outline';
        ws.writeState(workspace, state);
        break;
      }
      lastInput = answer;
    }
  } finally {
    rl.close();
  }
  console.log('\n' + (await interviewSummary(cfg, wsDir)));
  return ws.readState(workspace);
}
