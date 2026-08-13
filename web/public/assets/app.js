/* Sculptor Studio · 视图路由与写作工作台（v0.27 大改）
   三栏工作台：左侧导航 / 主区视图 / 右侧 Agent 上下文面板（实时理解、清单、素材、风格进度）。
   设计标准：所有视图切换统一走 showView()（同一条 viewIn 动画）；阶段条状态规范不变。 */
const $ = (id) => document.getElementById(id);

const VIEWS = ['home', 'sessions', 'session', 'outline', 'draft', 'report', 'persona', 'knowledge', 'works', 'tools'];
const STAGES = ['home', 'clarify', 'outline', 'write', 'audit', 'deliver'];
const NAVS = ['home', 'sessions', 'works', 'persona', 'knowledge', 'tools'];
const CRUMB = {
  home: '启程', sessions: '项目', session: '写作', outline: '大纲',
  draft: '成稿', report: '审计', persona: '风格肖像', knowledge: '知识库', works: '作品库', tools: '工具',
};

let sessionId = null;
let sessionMeta = null;
let busy = false;
let currentView = 'home';
let currentStage = 'home';
let contextVisible = false;
let lastPanelStage = '';
let outlineEdits = [];
let worksCache = [];
let worksCat = '';
let kbCache = [];
let kbType = '';
let workCtx = null;
let outlineGraphMode = false; // 大纲图谱（v0.48，P2 可视化）：只读卡片流，列表模式保留编辑
let worksCompareMode = false; // 作品对比（v0.48，P2）：选两篇并排看人类化指标
let worksCompareSel = [];
let prevOutlineCount = 0; // 实时大纲节数快照：每轮对比，变了就给用户可见的"更新"反馈

const DIM_CN = {
  temperature: '语气温度', sentencePreference: '句式偏好', modifierDensity: '修饰密度',
  languageRegister: '语域', emotionalSpectrum: '情感频谱', narrativePerspective: '叙述视角',
  imageryTendency: '意象倾向', rhythm: '节奏', rhetoricalDevices: '修辞手法',
  dialogueRatio: '对话比例', timeHandling: '时间处理', endingPattern: '结尾模式',
  criticalStance: '批判姿态', vocabularyCharacter: '词汇特色',
  pacing: '节奏', infoDensity: '信息密度', emotionalCurve: '情感曲线',
  openingTaste: '开篇口味', endingTaste: '结尾口味', frictionTolerance: '摩擦容忍',
  formatPreference: '格式偏好',
};

/* ── 视图切换（统一标准） ─────────────────────────── */
function showView(name, { keepStage = false } = {}) {
  if (!VIEWS.includes(name)) name = 'home';
  VIEWS.forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('is-active', v === name);
  });
  document.body.dataset.view = name;
  currentView = name;
  NAVS.forEach((n) => {
    const el = document.querySelector(`.nav-item[data-nav="${n}"]`);
    if (el) el.classList.toggle('is-active', n === name);
  });
  $('crumb').textContent = CRUMB[name] || 'Sculptor';
  if (!keepStage && ['home', 'sessions', 'works', 'persona', 'knowledge', 'tools'].includes(name)) setStage('home');
  updateContextVisibility();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── 阶段条（统一标准） ───────────────────────────── */
function setStage(stage) {
  if (!STAGES.includes(stage)) stage = 'home';
  currentStage = stage;
  STAGES.forEach((s) => {
    const btn = document.querySelector(`.stage-item[data-stage="${s}"]`);
    if (!btn) return;
    const idx = STAGES.indexOf(s);
    const cur = STAGES.indexOf(stage);
    btn.classList.toggle('active', s === stage);
    btn.classList.toggle('done', idx < cur);
  });
}

/* ── 通用 ─────────────────────────────────────────── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function machineId() {
  let id = localStorage.getItem('sculptor.machineId');
  if (!id) {
    id = 'm-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('sculptor.machineId', id);
  }
  return id;
}

function apiHeaders(extra = {}) {
  return { 'X-Machine-Id': machineId(), ...extra };
}

async function apiGet(pathname) {
  const r = await fetch(pathname, { headers: apiHeaders() });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiPost(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiPatch(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'PATCH',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiDelete(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'DELETE',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function downloadExport(sid, fmt, file) {
  const q = new URLSearchParams({ sessionId: sid, fmt });
  if (file) q.set('file', file);
  const a = document.createElement('a');
  a.href = `/api/export?${q.toString()}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ── 右侧伴随工作台（实时大纲 / 写作手写区 / 上下文） ── */
function updateContextVisibility() {
  const show = ['session', 'outline', 'draft', 'report'].includes(currentView) && sessionId && contextVisible;
  $('contextPanel').hidden = !show;
  $('contextToggle').classList.toggle('is-active', show);
  document.body.classList.toggle('panel-open', show);
}

function ctxSection(title, body) {
  return `<div class="ctx-sec"><h4>${esc(title)}</h4>${body}</div>`;
}

function setPanelTab(tab) {
  if (!['outline', 'draft', 'context', 'modulator'].includes(tab)) tab = 'outline';
  document.querySelectorAll('#panelTabs .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  ['outline', 'draft', 'context', 'modulator'].forEach((t) => {
    const el = $(`pane-${t}`);
    if (el) el.classList.toggle('is-active', t === tab);
  });
}

function defaultTabFor(stage) {
  if (['write', 'revise', 'redteam', 'quality', 'style_fix', 'audience', 'deliver', 'rewrite_gaps'].includes(stage)) return 'draft';
  return 'outline';
}

function readOutlineEdits() {
  return [...document.querySelectorAll('#pane-outline .ol-edit')].map((r) => {
    const i = Number(r.dataset.i);
    return {
      ...(outlineEdits[i] || {}),
      heading: r.querySelector('.ol-head')?.value.trim() || '未命名节',
      function: r.querySelector('.ol-fn')?.value.trim() || '',
      words: Number(r.querySelector('.ol-words')?.value) > 0 ? Number(r.querySelector('.ol-words').value) : 0,
      keyPoints: (r.querySelector('.ol-points-edit')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 6),
    };
  });
}

function collectOutlineEdits() {
  return { title: $('olTitle')?.value.trim() || '', sections: readOutlineEdits() };
}

function renderOutlinePane(c) {
  const pane = $('pane-outline');
  const stage = c.stage || c.phase || '';
  const editable = !['write', 'revise', 'redteam', 'quality', 'style_fix', 'audience', 'deliver', 'rewrite_gaps'].includes(stage);
  const lo = c.liveOutline || { title: '', sections: [], complete: false };
  const secs = lo.sections || [];
  const parts = [];
  // 状态条：只表达"确认/成形/讨论中"，不再展示完成度百分比与机器状态徽章。
  const statusBits = [];
  if (c.outlineConfirmed) statusBits.push(['大纲已确认', 'ok']);
  else if (lo.complete) statusBits.push(['大纲已成形 · AI 已从对话总结', 'gold']);
  else statusBits.push([`讨论中 · AI 正在从对话里总结大纲${secs.length ? `（已 ${secs.length} 部分）` : ''}`, '']);
  if (c.checklist?.length) {
    const done = c.checklist.filter((x) => x.done).length;
    statusBits.push([`清单 ${done}/${c.checklist.length}`, '']);
  }
  parts.push(`<div class="ol-status">${statusBits.map(([t, cls]) => `<span class="chip ${cls}">${esc(t)}</span>`).join('')}</div>`);
  parts.push(ctxSection('大纲标题', `<input class="ol-title" id="olTitle" value="${esc(lo.title || '')}" ${editable ? '' : 'disabled'} placeholder="文章标题（可改）" />`));
  if (!secs.length) {
    // 大纲还没成形时，先把"AI 已捕捉到什么"实时摆出来，让生长过程可见
    const got = [];
    const cf = c.confirmed || {};
    if (cf.genre) got.push(`文体 ${cf.genre}`);
    if (cf.topic) got.push(`主题 ${cf.topic}`);
    if (cf.stance) got.push(`立场 ${cf.stance}`);
    if (cf.theme) got.push(`立意 ${cf.theme}`);
    if (cf.audience) got.push(`读者 ${cf.audience}`);
    if (Array.isArray(c.materials) && c.materials.length) got.push(`素材 ${c.materials.length} 条`);
    const chipHtml = got.length
      ? `<div class="capture-chips">${got.map((g) => `<span class="capture-chip">${esc(g)}</span>`).join('')}</div>`
      : '';
    parts.push(ctxSection(
      '实时大纲',
      `<div class="ctx-line">大纲会随我们的讨论由 AI 总结成形——你只管聊，我来归纳。</div>${chipHtml}`,
    ));
  } else {
    outlineEdits = secs.map((s) => ({ ...s }));
    parts.push(`<div class="ol-view-toggle">
      <button class="seg-btn ${!outlineGraphMode ? 'is-active' : ''}" id="olViewList">列表</button>
      <button class="seg-btn ${outlineGraphMode ? 'is-active' : ''}" id="olViewGraph">图谱</button>
    </div>`);
    // 卷级分组（v0.42）：parts 只是展示分组，节列表与编辑索引仍是扁平的
    const groupParts = lo.parts && Array.isArray(lo.parts) && lo.parts.length ? lo.parts : null;
    const idxByHead = new Map(secs.map((s, i) => [s.heading, i]));
    if (outlineGraphMode) {
      // 大纲图谱（v0.48）：卷→节 卡片连线，点击卡片定位到草稿对应节（只读）
      const node = (s, i) => `
        <button class="ol-node ${s.status === 'ready' ? 'ok' : s.status === 'needs' ? 'gold' : ''}" data-i="${i}" title="点击定位到草稿对应节">
          <span class="ol-node-no">${i + 1}</span>
          <span class="ol-node-main"><b>${esc(s.heading || '未命名节')}</b><em>${esc(s.function || '')}</em>${s.thesis ? `<i>${esc(s.thesis)}</i>` : ''}</span>
          <span class="ol-node-side">${s.words || ''} 字 <span class="dot ${s.status === 'ready' ? 'ok' : s.status === 'needs' ? 'gold' : ''}">${s.status === 'ready' ? '✓' : s.status === 'needs' ? '…' : '○'}</span></span>
        </button>`;
      const rail = (secIdxs) => `<div class="ol-rail">${secIdxs.map((i) => node(secs[i], i)).join('')}</div>`;
      let railHtml = '';
      if (groupParts) {
        railHtml = groupParts
          .map((p) => {
            const idxs = (p.sections || []).map((h) => idxByHead.get(h)).filter((i) => i !== undefined);
            if (!idxs.length) return '';
            return `<div class="ol-part-head">${esc(p.title)}</div>${rail(idxs)}`;
          })
          .join('');
        const covered = new Set(groupParts.flatMap((p) => p.sections || []).map((h) => idxByHead.get(h)));
        const rest = secs.map((_, i) => i).filter((i) => !covered.has(i));
        if (rest.length) railHtml += `<div class="ol-part-head">未分组</div>${rail(rest)}`;
      } else {
        railHtml = rail(secs.map((_, i) => i));
      }
      parts.push(ctxSection(`大纲图谱 · ${secs.length} 节${groupParts ? ` · ${groupParts.length} 卷` : ''}（点击卡片定位到草稿）`, railHtml));
    } else {
    const rowHtml = (s, i) => `
      <div class="ol-edit" data-i="${i}">
        <div class="ol-edit-row">
          <span class="ol-no">${i + 1}</span>
          <input class="ol-head" value="${esc(s.heading)}" ${editable ? '' : 'disabled'} placeholder="部分标题" />
          <input class="ol-fn" value="${esc(s.function || '')}" ${editable ? '' : 'disabled'} placeholder="作用" />
          <input class="ol-words" type="number" min="0" step="50" value="${s.words || ''}" ${editable ? '' : 'disabled'} placeholder="字数" />
        </div>
        <textarea class="ol-points-edit" rows="${Math.max(1, (s.keyPoints || []).length)}" ${editable ? '' : 'disabled'} placeholder="要点（每行一条）">${esc((s.keyPoints || []).join('\n'))}</textarea>
        ${s.thesis ? `<div class="ol-thesis">${esc(s.thesis)}</div>` : ''}
        ${s.notes ? `<div class="ol-thesis">${esc(s.notes)}</div>` : ''}
        ${editable ? `<div class="ol-tools"><button class="icon-btn" data-act="up">↑</button><button class="icon-btn" data-act="down">↓</button><button class="icon-btn danger" data-act="del">删</button></div>` : ''}
      </div>`;
    const chunks = [];
    const covered = new Set();
    if (groupParts) {
      for (const p of groupParts) {
        const idxs = (p.sections || []).map((h) => idxByHead.get(h)).filter((i) => i !== undefined);
        if (!idxs.length) continue;
        chunks.push(`<div class="ol-part">${esc(p.title || '')}</div>`);
        for (const i of idxs) {
          chunks.push(rowHtml(secs[i], i));
          covered.add(i);
        }
      }
      for (let i = 0; i < secs.length; i++) if (!covered.has(i)) chunks.push(rowHtml(secs[i], i));
    } else {
      secs.forEach((s, i) => chunks.push(rowHtml(s, i)));
    }
    const rows = chunks.join('');
    const editActions = editable
      ? `<div class="ol-actions">
          <button class="icon-btn" id="olAdd">＋ 新增一部分</button>
          <button class="btn btn-gold btn-sm" id="olSave">保存大纲</button>
        </div>`
      : '';
    parts.push(ctxSection(`实时大纲 · AI 总结${secs.length ? ` · ${secs.length} 部分${groupParts ? ` · ${groupParts.length} 卷` : ''}` : ''}${editable ? '（可直接编辑）' : '（写作中只读）'}`, `${rows}${editActions}`));
    }
  }
  // 明确的"开始写作"确认点：AI 已总结成形或已有内容时即可拍板
  if (editable && !c.outlineConfirmed && (lo.complete || secs.length >= 1)) {
    const label = lo.complete ? '大纲完成，开始写作' : '先开始写作（可随时调整）';
    parts.push(`<div class="ctx-sec start-sec"><div class="ctx-line">大纲是 AI 从我们对话里总结出来的——你可以直接拍板开始写作，写作中仍可调整。</div><button class="btn btn-gold btn-block" id="olStartWrite">${esc(label)}</button></div>`);
  } else if (c.outlineConfirmed) {
    parts.push(`<div class="ctx-sec start-sec"><div class="ctx-line">✅ 大纲已确认${c.progress?.total ? ` · 写作进度 ${c.progress.done}/${c.progress.total} 部分` : ''}</div></div>`);
  } else if (!editable && c.progress?.total) {
    parts.push(ctxSection('写作进度', `<div class="progress"><i style="width:${Math.round((c.progress.done / c.progress.total) * 100)}%"></i></div><div class="ctx-line">已写 ${c.progress.done}/${c.progress.total} 部分</div>`));
  }
  const writingNow = c.stage === 'write' && !c.hasDraft;
  parts.push(ctxSection(
    '给 Sculptor 的建议',
    `<textarea class="suggest" id="outlineSuggest" rows="2" placeholder="${writingNow ? '写作进行中，写完再提修改意见…' : '直接说：哪一节要改、往哪个方向改…'}"></textarea>
     <button class="btn btn-gold btn-sm" id="suggestSend" ${writingNow ? 'disabled' : ''}>发送建议</button>`,
  ));
  pane.innerHTML = parts.join('');
  $('suggestSend')?.addEventListener('click', () => {
    const v = $('outlineSuggest').value.trim();
    if (!v) return;
    $('outlineSuggest').value = '';
    submitChat(v);
  });
  $('olAdd')?.addEventListener('click', () => {
    outlineEdits = readOutlineEdits();
    outlineEdits.push({ heading: `新的一节${outlineEdits.length + 1}`, function: '待定', words: 0, thesis: '', keyPoints: [] });
    renderOutlinePane({ ...c, liveOutline: { ...lo, sections: outlineEdits } });
  });
  $('olSave')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/outline', { sessionId, outline: collectOutlineEdits() });
      toast('大纲已保存，AI 会按它继续');
      refreshPanel();
    } catch (e) { toast(e.message); }
  });
  $('olViewList')?.addEventListener('click', () => { outlineGraphMode = false; renderOutlinePane(c); });
  $('olViewGraph')?.addEventListener('click', () => { outlineGraphMode = true; renderOutlinePane(c); });
  document.querySelectorAll('#pane-outline .ol-node').forEach((b) =>
    b.addEventListener('click', () => gotoDraftSection(Number(b.dataset.i))),
  );
  $('olStartWrite')?.addEventListener('click', () => submitChat('大纲完成，开始写作'));
  document.querySelectorAll('#pane-outline .ol-tools [data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.closest('.ol-edit').dataset.i);
      const act = btn.dataset.act;
      outlineEdits = readOutlineEdits();
      if (act === 'up' && i > 0) [outlineEdits[i - 1], outlineEdits[i]] = [outlineEdits[i], outlineEdits[i - 1]];
      if (act === 'down' && i < outlineEdits.length - 1) [outlineEdits[i + 1], outlineEdits[i]] = [outlineEdits[i], outlineEdits[i + 1]];
      if (act === 'del') outlineEdits.splice(i, 1);
      renderOutlinePane({ ...c, liveOutline: { ...lo, sections: outlineEdits } });
    });
  });
}

/* ── 大纲图谱 → 草稿定位（v0.48）：点节卡片跳到草稿对应节并选中标题 ── */
function gotoDraftSection(i) {
  setPanelTab('draft');
  const ta = $('paneDraftText');
  if (!ta) return;
  const heading = outlineEdits[i]?.heading;
  const idx = heading ? ta.value.indexOf(`## ${heading}`) : -1;
  if (idx >= 0) {
    ta.focus();
    ta.setSelectionRange(idx, idx + heading.length + 3);
    const line = ta.value.slice(0, idx).split('\n').length;
    ta.scrollTop = Math.max(0, (line - 3) * 18);
  } else {
    ta.focus();
  }
}

function renderPaneDraft(c) {
  const pane = $('pane-draft');
  const hasContent = c.hasDraft || c.progress?.total > 0;
  if (!hasContent) {
    pane.innerHTML = ctxSection('写作手写区', '<div class="ctx-line">大纲确认并开始写作后，这里会出现草稿编辑区——你可以一边看 AI 写，一边亲手改。</div>');
    return;
  }
  let html = '';
  if (c.progress?.total) {
    html += ctxSection('写作进度', `<div class="progress"><i style="width:${Math.round((c.progress.done / c.progress.total) * 100)}%"></i></div><div class="ctx-line">已写 ${c.progress.done}/${c.progress.total} 节</div>`);
  }
  html += ctxSection(
    '手写草稿',
    `<textarea class="draft-edit" id="paneDraftText" rows="14" placeholder="在这里亲手改稿，改完点保存；保存会写回草稿文件。"></textarea>
     <div class="draft-quick" id="paneDraftQuick" hidden>
       <div class="draft-quick-sel" id="paneDraftQuickSel"></div>
       <div class="draft-quick-actions">
         <button class="btn btn-ghost btn-sm" data-act="润色这句，保持原意">润色</button>
         <button class="btn btn-ghost btn-sm" data-act="把这段扩写得更丰满，保留原意和细节">扩写</button>
         <button class="btn btn-ghost btn-sm" data-act="把这段浓缩得更精炼，保留核心信息">缩写</button>
         <button class="btn btn-ghost btn-sm" data-act="更口语化一点">更口语</button>
         <button class="btn btn-ghost btn-sm" data-act="更克制一点，减少修饰">更克制</button>
         <button class="btn btn-ghost btn-sm" data-act="调整这句的节奏，长句短句错落">节奏</button>
       </div>
     </div>
     <div id="paneDraftCands" class="draft-cands" hidden></div>
     <div id="paneDraftHist" class="draft-hist" hidden></div>
     <div class="draft-edit-bar"><span class="char-count" id="paneDraftChars"></span>
       <button class="btn btn-gold btn-sm" id="paneDraftSave">保存修改</button>
       <button class="btn btn-ghost btn-sm" id="paneDraftView">查看成稿</button>
       <button class="icon-btn" id="paneDraftVersions" title="版本历史与回滚">版本</button>
       <button class="icon-btn" id="paneDraftFocus" title="专注模式（Esc 退出）">专注</button>
     </div>
     <div class="draft-edit-bar">
       <button class="icon-btn" id="paneDraftMd">导出 md</button>
       <button class="icon-btn" id="paneDraftDocx">导出 docx</button>
       <button class="icon-btn" id="paneDraftPptx">导出 pptx</button>
       <button class="btn btn-gold btn-sm" id="paneDraftPointEdit">AI 改写选中</button>
     </div>`,
  );
  // 实时洞察卡（v0.45）：字数进度 + 最近风格脉搏 + 节奏迷你曲线
  html += ctxSection('AI 洞察 · 实时', `<div id="paneInsights"><div class="ctx-line">读取中…</div></div>`);
  if (c.outline?.sections?.length) {
    html += ctxSection('大纲参考', c.outline.sections.map((s, i) => `<div class="ol-ref"><span>${i + 1}.</span>${esc(s.heading)}<em>${esc(s.function || '')}</em></div>`).join(''));
  }
  pane.innerHTML = html;
  if (c.hasDraft) {
    apiGet(`/api/draft?sessionId=${sessionId}`).then((d) => {
      const ta = $('paneDraftText');
      if (ta && d.text) {
        ta.value = d.text;
        $('paneDraftChars').textContent = `${d.text.replace(/\s/g, '').length} 字`;
      }
    }).catch(() => {});
  }
  const ta = $('paneDraftText');
  if (ta) {
    ta.addEventListener('input', () => {
      const n = ta.value.replace(/\s/g, '').length;
      $('paneDraftChars').textContent = `${n} 字`;
      renderInsights(c, n);
    });
    // 选区 AI 工具栏（v0.45）：选中文字即出现快捷动作
    const refreshQuick = () => {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
      const q = $('paneDraftQuick');
      if (!q) return;
      if (sel) {
        $('paneDraftQuickSel').textContent = `已选中：${sel.slice(0, 36)}${sel.length > 36 ? '…' : ''}`;
        q.hidden = false;
      } else {
        q.hidden = true;
      }
    };
    ta.addEventListener('mouseup', refreshQuick);
    ta.addEventListener('keyup', refreshQuick);
    ta.addEventListener('blur', () => { const q = $('paneDraftQuick'); if (q) q.hidden = true; });
  }
  $('paneDraftSave')?.addEventListener('click', async () => {
    try {
      await apiPost('/api/save-draft', { sessionId, text: ta.value });
      toast('草稿已保存');
    } catch (e) { toast(e.message); }
  });
  $('paneDraftView')?.addEventListener('click', async () => {
    try {
      const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
      if (d.text) renderDraft(d.text);
    } catch (e) { toast(e.message); }
  });
  $('paneDraftMd')?.addEventListener('click', () => downloadExport(sessionId, 'md'));
  $('paneDraftDocx')?.addEventListener('click', () => downloadExport(sessionId, 'docx'));
  $('paneDraftPptx')?.addEventListener('click', () => downloadExport(sessionId, 'pptx'));
  $('paneDraftPointEdit')?.addEventListener('click', async () => {
    const ta = $('paneDraftText');
    if (!ta) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    if (!sel) {
      toast('先在草稿里选中要改写的句子，再点「AI 改写选中」');
      return;
    }
    const inst = window.prompt('怎么改？例如：更口语化一点 / 再克制一点 / 加一个具体细节', '更口语化一点');
    if (!inst) return;
    try {
      // 先落盘当前草稿，保证选中原文与文件一致，再让 AI 只改这一句
      await apiPost('/api/save-draft', { sessionId, text: ta.value });
      const r = await apiPost('/api/point-edit', { sessionId, quote: sel, instruction: inst });
      toast(`已改写「${sel.slice(0, 12)}…」并吸收进风格档案`);
      const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
      if (d.text) {
        ta.value = d.text;
        $('paneDraftChars').textContent = `${d.text.replace(/\s/g, '').length} 字`;
      }
      refreshPanel();
      if (r.writeUpdated || r.readUpdated) {
        const w = await apiGet(`/api/style?sessionId=${sessionId}`);
        toast(`风格档案已更新（write +${r.writeUpdated || 0} · read +${r.readUpdated || 0}）`);
      }
    } catch (e) {
      toast(e.message);
    }
  });
  // 选区快捷动作（v0.46）：先生成 3 个候选 → 用户选一个应用（Sudowrite History 式）
  document.querySelectorAll('#paneDraftQuick [data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
      if (!sel) {
        toast('先在草稿里选中文字');
        return;
      }
      const inst = btn.dataset.act;
      const box = $('paneDraftCands');
      if (!box) return;
      box.hidden = false;
      box.innerHTML = '<div class="working"><span class="spinner"></span>生成 3 个改写候选…</div>';
      try {
        await apiPost('/api/save-draft', { sessionId, text: ta.value });
        const r = await apiPost('/api/rewrite', { sessionId, quote: sel, instruction: inst });
        box.innerHTML =
          `<div class="cands-head">「${esc(inst)}」 · 选一个应用（改动会吸收进风格档案）</div>` +
          `<div class="cands">${r.candidates
            .map(
              (c, i) =>
                `<button class="btn btn-ghost btn-sm cand" data-c="${esc(c)}"><b>候选 ${i + 1}</b><span class="cand-text">${esc(c.slice(0, 52))}${c.length > 52 ? '…' : ''}</span></button>`,
            )
            .join('')}<button class="btn btn-gold btn-sm" id="candRetry">换一个</button><button class="btn btn-ghost btn-sm" id="candCancel">取消</button></div>`;
        box.querySelectorAll('.cand').forEach((b) =>
          b.addEventListener('click', async () => {
            try {
              await apiPost('/api/point-edit', {
                sessionId,
                quote: sel,
                instruction: inst,
                replacement: b.dataset.c,
              });
              toast('已应用候选，并吸收进风格档案');
              box.hidden = true;
              const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
              if (d.text) {
                ta.value = d.text;
                $('paneDraftChars').textContent = `${d.text.replace(/\s/g, '').length} 字`;
              }
              refreshPanel();
            } catch (e) {
              toast(e.message);
            }
          }),
        );
        $('candRetry')?.addEventListener('click', () => btn.click());
        $('candCancel')?.addEventListener('click', () => { box.hidden = true; });
      } catch (e) {
        box.innerHTML = `<div class="ctx-line">${esc(e.message)}</div>`;
      }
    });
  });
  // 版本历史与回滚（v0.46）：每次 AI 写改自动留存快照，可一键回退
  $('paneDraftVersions')?.addEventListener('click', async () => {
    const box = $('paneDraftHist');
    if (!box) return;
    box.hidden = false;
    try {
      const h = await apiGet(`/api/history?sessionId=${sessionId}`);
      if (!h.entries?.length) {
        box.innerHTML = '<div class="ctx-line">（还没有版本快照：每次 AI 写作/修改会自动留存）</div>';
        return;
      }
      box.innerHTML =
        `<div class="cands-head">版本历史（1=最新；回滚前会先存当前版）</div>` +
        h.entries
          .map(
            (e, i) =>
              `<div class="hist-row"><span>${i + 1}</span><em>${esc(e.reason || '')}</em><small>${esc((e.ts || '').slice(11, 19))} · ${e.chars || 0} 字</small><button class="btn btn-ghost btn-sm" data-i="${i + 1}">回滚</button></div>`,
          )
          .join('');
      box.querySelectorAll('[data-i]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            const rr = await apiPost('/api/rollback', { sessionId, index: Number(b.dataset.i) });
            toast(`已回滚到版本 ${b.dataset.i}（${rr.reason || ''}）`);
            box.hidden = true;
            const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
            if (d.text) {
              ta.value = d.text;
              $('paneDraftChars').textContent = `${d.text.replace(/\s/g, '').length} 字`;
            }
            refreshPanel();
          } catch (e) {
            toast(e.message);
          }
        }),
      );
    } catch (e) {
      box.innerHTML = `<div class="ctx-line">${esc(e.message)}</div>`;
    }
  });
  $('paneDraftFocus')?.addEventListener('click', () => toggleFocus(true));
  renderInsights(c, 0);
}

/* ── 专注模式（v0.46）：隐藏侧栏与伴随面板，只剩正文；Esc 退出 ── */
function toggleFocus(on) {
  document.body.classList.toggle('focus-mode', Boolean(on));
  let h = $('focusHint');
  if (on) {
    if (!h) {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div id="focusHint" class="focus-hint">专注模式 · Esc 退出</div>';
      h = wrap.firstChild;
      document.body.appendChild(h);
    }
    h.hidden = false;
  } else if (h) {
    h.hidden = true;
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.body.classList.contains('focus-mode')) toggleFocus(false);
  else if (document.body.classList.contains('split-mode')) toggleSplit(false);
});

/* ── 并排伴随模式（v0.47）：写作时聊天与手写区同时可见（NovelCrafter split）── */
let splitUserClosed = false;
function toggleSplit(on) {
  document.body.classList.toggle('split-mode', Boolean(on));
  const btn = $('panelSplit');
  if (btn) btn.classList.toggle('is-active', Boolean(on));
}
function ensureSplitBtn() {
  if ($('panelSplit')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<button class="icon-btn" id="panelSplit" title="并排：聊天与手写区同时可见（Esc 退出）">并排</button>';
  const btn = wrap.firstChild;
  const anchor = $('contextToggle');
  if (anchor?.parentNode) anchor.parentNode.insertBefore(btn, anchor);
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('split-mode');
    splitUserClosed = !next;
    toggleSplit(next);
    if (next) setPanelTab('draft');
  });
}

/* ── 实时洞察（v0.45）：字数/脉搏/节奏，可视化但克制 ── */
const PULSE_CN = { clarify: '澄清', outline: '大纲', write: '写作', correction: '修改', redteam: '审计' };
async function renderInsights(c, knownChars) {
  const box = $('paneInsights');
  if (!box) return;
  try {
    const d = knownChars ? null : await apiGet(`/api/draft?sessionId=${sessionId}`);
    const chars = knownChars || (d?.text || '').replace(/\s/g, '').length;
    const target = Number(c.targetWords) || 0;
    const pct = target ? Math.min(100, Math.round((chars / target) * 100)) : 0;
    let html = `<div class="insight-row"><span class="insight-label">字数</span><b>${chars}</b>${target ? `/${target}（${pct}%）` : ''}`;
    html += `<div class="progress" style="margin:4px 0 0"><i style="width:${pct}%"></i></div></div>`;
    const pulses = Array.isArray(c.pulses) ? c.pulses.slice(-3) : [];
    if (pulses.length) {
      html += `<div class="insight-row"><span class="insight-label">脉搏</span>${pulses
        .map((p) => `<span class="pulse-chip">${PULSE_CN[p.phase] || p.phase} ${p.score != null ? (p.score * 100).toFixed(0) : ''}分</span>`)
        .join(' ')}<div class="ctx-line">${esc(pulses[pulses.length - 1].suggestion || pulses[pulses.length - 1].summary || '')}</div></div>`;
    }
    try {
      const cv = await apiGet(`/api/curve?sessionId=${sessionId}`);
      if (cv.sections?.length) {
        const bar = (v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(Math.max(0, v || 0) / 12.5))];
        html += `<div class="insight-row"><span class="insight-label">节奏</span><div class="curve-mini">${cv.sections
          .map((s) => `<div class="curve-mini-row"><span title="${esc(s.section)}">${esc(s.section.slice(0, 8))}</span><i>${bar(s.tension)}${bar(s.density)}${bar(s.emotion)}</i></div>`)
          .join('')}</div></div>`;
      }
    } catch {}
    box.innerHTML = html;
  } catch {
    box.innerHTML = '<div class="ctx-line">（尚无成稿可洞察）</div>';
  }
}

function renderPaneContext(c) {
  const pane = $('pane-context');
  const parts = [];
  if (c.checklist?.length) {
    const done = c.checklist.filter((x) => x.done).length;
    parts.push(ctxSection(
      `确认清单 ${done}/${c.checklist.length}`,
      c.checklist.map((x) => `<div class="ctx-row ${x.done ? 'done' : ''}"><span>${x.done ? '✓' : '…'}</span>${esc(x.label)}</div>`).join(''),
    ));
  }
  const b = c.blueprint;
  if (b && (b.article || b.tension || b.skeleton?.length)) {
    const lines = [];
    if (b.article) lines.push(`整篇 · ${b.article}`);
    if (b.tension) lines.push(`张力 · ${b.tension}`);
    if (b.readerTakeaway) lines.push(`读者带走 · ${b.readerTakeaway}`);
    if (b.skeleton?.length) lines.push(`结构 · ${b.skeleton.join(' → ')}`);
    if (b.corrections?.length) lines.push(`待吸收修正 · ${b.corrections.slice(-3).join('；')}`);
    parts.push(ctxSection('整篇蓝图', lines.map((l) => `<div class="ctx-line">${esc(l)}</div>`).join('')));
  }
  if (c.intent?.summary) {
    let h = `<div class="ctx-intent">${esc(c.intent.summary)}</div>`;
    if (c.intent.coreNeed) h += `<div class="ctx-core">核心诉求 · ${esc(c.intent.coreNeed)}</div>`;
    if (c.intent.risks?.length) h += `<div class="ctx-risk">风险 · ${esc(c.intent.risks.join('；'))}</div>`;
    parts.push(ctxSection('我的理解', h));
  }
  if (c.materials?.length) {
    parts.push(ctxSection(`素材 ×${c.materials.length}`, c.materials.map((m) => `<div class="ctx-material">${esc(m.slice(0, 90))}</div>`).join('')));
  }
  // 种子与红线（v0.59）：用户主动给出的高价值信息，当轮可见、后续兑现
  if (c.seeds?.length || c.constraints?.length) {
    const seedHtml = (c.seeds || [])
      .map((s) => `<div class="ctx-row"><span class="vchip">${esc(s.type || 'seed')}${s.confirmed ? '✓' : '·'}</span>${esc(s.text)}</div>`)
      .join('');
    const conHtml = (c.constraints || [])
      .map((x) => `<div class="ctx-row"><span class="vchip">红线</span>${esc(x)}</div>`)
      .join('');
    parts.push(ctxSection('种子与红线（你主动给的，AI 已当轮接住）', seedHtml + conHtml));
  }
  // 思想脉络（v0.43/0.45 可视化）：AI 理解到的用户主张/前提/推理/来源
  if (c.thinking) {
    const lines = c.thinking
      .split('\n')
      .filter(Boolean)
      .map((l) => `<div class="ctx-line think">${esc(l)}</div>`)
      .join('');
    parts.push(ctxSection('思想脉络', lines || '<div class="ctx-line">（AI 正在从你的发言里归纳）</div>'));
  }
  // 多模态输入：上传 md/txt/docx/xlsx/图片 → 提取成素材
  parts.push(ctxSection(
    '素材上传',
    `<div class="ctx-line">支持 md / txt / docx / xlsx / 图片 / 音频（本机可解析时）。上传后自动进入素材。</div>
     <input type="file" id="ctxUploadInput" hidden />
     <button class="btn btn-gold btn-sm" id="ctxUploadBtn">上传素材文件</button>`,
  ));
  // RAG：待检索 / 联网检索 / 资料回灌（补齐检索闭环）
  const ragPending = c.rag?.pendingRequests || 0;
  const ragDirect = c.rag?.direct
    ? `已配置联网检索（${c.rag.provider || '自定义端点'}）`
    : '未配置检索端点，可手动粘贴资料回灌';
  parts.push(ctxSection(
    `资料检索（RAG）${ragPending ? ` · ${ragPending} 项待检索` : ''}`,
    `<div class="ctx-line">${esc(ragDirect)}</div>
     <textarea class="suggest" id="ragText" rows="3" placeholder="把搜到的资料/引文/数据粘贴到这里，AI 会回灌进素材并自动补进缺口节…"></textarea>
     <div style="display:flex;gap:8px;margin-top:6px">
       <button class="btn btn-gold btn-sm" id="ragIngest">回灌资料</button>
       <button class="icon-btn" id="ragSearch">联网检索（若已配置）</button>
     </div>`,
  ));
  const sp = c.styleProgress || {};
  const dimBar = (learned, total) =>
    `<div class="mini-bar"><i style="width:${total ? Math.round(((learned || 0) / total) * 100) : 0}%"></i></div>`;
  let styleHtml = `<div class="ctx-line">write ${sp.write?.learned || 0}/${sp.write?.total || 14} 维${dimBar(sp.write?.learned, sp.write?.total)}read ${sp.read?.learned || 0}/${sp.read?.total || 7} 维${dimBar(sp.read?.learned, sp.read?.total)}</div>`;
  const topDims = (sp.write?.top || []).slice(0, 3);
  if (topDims.length) {
    styleHtml += topDims
      .map(
        (t) =>
          `<div class="ctx-row"><span>${esc(t.dim)}</span>${esc(t.value || '')}<em>${((t.confidence || 0) * 100).toFixed(0)}%</em></div>`,
      )
      .join('');
  }
  if (c.styleNote) styleHtml += `<div class="ctx-line">风格底稿 · ${esc(c.styleNote)}</div>`;
  parts.push(ctxSection('风格进度', styleHtml));
  if (c.answerLevels?.length) {
    const stats = Object.entries(c.answerStats || {})
      .filter(([, n]) => n)
      .map(([k, n]) => `<span class="vchip">${k}×${n}</span>`)
      .join('');
    const recent = c.answerLevels.map((a) => `<div class="ctx-row"><span>L${a.level}</span>${esc(a.sample)}</div>`).join('');
    parts.push(ctxSection('回答层次（L0–L5）', `<div class="vector-chips">${stats}</div>${recent}`));
  }
  if (!parts.length) {
    parts.push('<div class="empty">还没有上下文——开始对话后，这里会实时显示 Sculptor 的理解、素材与风格进度。</div>');
  }
  pane.innerHTML = parts.join('');
  $('ctxUploadBtn')?.addEventListener('click', () => $('ctxUploadInput')?.click());
  $('ctxUploadInput')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await apiPost('/api/upload', {
          sessionId,
          filename: f.name,
          dataBase64: String(reader.result || ''),
        });
        toast(
          r.kind === 'text'
            ? `已提取 ${r.file}（${r.text?.length || 0} 字预览）`
            : `已上传 ${r.file}：${r.hint || '未提取为文本'}`,
        );
        refreshPanel();
      } catch (err) {
        toast(err.message);
      }
    };
    reader.readAsDataURL(f);
  });
  $('ragIngest')?.addEventListener('click', async () => {
    const t = $('ragText')?.value.trim();
    if (!t) {
      toast('先粘贴要回灌的资料');
      return;
    }
    try {
      const r = await apiPost('/api/rag/ingest', { sessionId, text: t });
      toast(`已回灌 ${r.ingested} 条资料，自动补进素材`);
      $('ragText').value = '';
      refreshPanel();
    } catch (err) {
      toast(err.message);
    }
  });
  $('ragSearch')?.addEventListener('click', async () => {
    try {
      const r = await apiPost('/api/rag/search', { sessionId });
      toast(`联网检索完成，回灌 ${r.ingested} 组结果`);
      refreshPanel();
    } catch (err) {
      toast(err.message);
    }
  });
}

const MOD_LABELS = {
  personal: '笔迹接近度',
  surface: '句法节奏',
  discourse: '话语习惯',
  stance: '立场红线',
  knowledge: '知识呼应',
  defect: 'AI 腔回避',
  impedance: '节奏调制',
  vector: '风格方向',
  embedding: '语义原型',
  fineread: '深层清单',
  posture: '姿态健康度',
  avoidance: '个人回避',
  transform: '改迹贴合',
};

async function renderModulatorPane() {
  const pane = $('pane-modulator');
  if (!pane || !sessionId) return;
  try {
    const m = await apiGet(`/api/modulator?sessionId=${sessionId}`);
    const modeTxt = m.trained ? '已学习（作者偏好对训练）' : '默认权重（编辑对不足）';
    let html = `<div class="ctx-sec"><h4>改迹调制 · ${modeTxt}</h4>
      <p class="ctx-note">编辑对 ${m.pairs} 条 · 正例 ${m.positives} 条</p></div>`;
    if (m.breakdown && Array.isArray(m.breakdown.contributions)) {
      const rows = m.breakdown.contributions
        .map((c) => {
          const label = MOD_LABELS[c.feature] || c.feature;
          const sign = c.contrib >= 0 ? '+' : '';
          const bar = Math.min(100, Math.max(0, Math.abs(c.contrib) * 100));
          return `<div class="mod-row">
            <span class="mod-name">${esc(label)}</span>
            <span class="mod-bar"><i style="width:${bar.toFixed(0)}%"></i></span>
            <span class="mod-val">${sign}${c.contrib.toFixed(2)}</span>
          </div>`;
        })
        .join('');
      html += `<div class="ctx-sec"><h4>为什么选它</h4>
        <p class="ctx-note">${esc(m.breakdown.rationale || '各信号均衡，没有明显的主导选择')}</p></div>
        <div class="ctx-sec"><h4>十三维贡献分解</h4>${rows}</div>`;
    } else {
      html += `<div class="ctx-sec"><h4>十三维贡献分解</h4>
        <p class="ctx-note">成稿后即可看到每维贡献与"为什么选它"。</p></div>`;
    }
    if (m.lastDecode && Array.isArray(m.lastDecode.edits) && m.lastDecode.edits.length) {
      const tags = m.lastDecode.edits
        .map((e) => (e === 'concretize' ? '具体化拟改' : `删「${esc(e)}」`))
        .join('、');
      html += `<div class="ctx-sec"><h4>本节拟改（${m.lastDecode.section || '正文'}）</h4>
        <p class="ctx-note">${tags}</p></div>`;
    }
    pane.innerHTML = html;
  } catch (e) {
    pane.innerHTML = `<div class="ctx-sec"><h4>改迹调制</h4><p class="ctx-note">加载失败</p></div>`;
  }
}

async function refreshPanel() {
  if (!sessionId) return;
  try {
    const c = await apiGet(`/api/context?sessionId=${sessionId}`);
    $('contextStatus').textContent = `${c.status || ''}${c.outline?.sections?.length ? ` · 大纲 ${c.outline.sections.length} 节` : ''}${c.progress?.total ? ` · 写作 ${c.progress.done}/${c.progress.total}` : ''}`;
    renderOutlinePane(c);
    renderPaneDraft(c);
    renderPaneContext(c);
    renderModulatorPane();
    const stageKey = c.stage || c.phase || '';
    if (stageKey !== lastPanelStage) {
      setPanelTab(defaultTabFor(stageKey));
      // 进入写作/修订/审计/交付阶段 → 自动开并排（用户手动关过后不再自动开）
      if (
        !splitUserClosed &&
        ['write', 'revise', 'redteam', 'quality', 'style_fix', 'audience', 'deliver', 'rewrite_gaps'].includes(stageKey) &&
        !document.body.classList.contains('split-mode')
      ) {
        toggleSplit(true);
        setPanelTab('draft');
      }
      lastPanelStage = stageKey;
    }
  } catch { /* 面板非关键，失败静默 */ }
}

/* ── 聊天渲染 ─────────────────────────────────────── */
function addMsg(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${html}</div>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

function addWorking(label) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `<div class="working"><span class="spinner"></span><span class="working-label">${esc(label)}</span></div>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

/** 长思考时的动态提示（v0.57）：轮换"正在做什么"，避免看起来像卡死。 */
function spinWorking(w) {
  const hints = ['正在理解你这句话…', '正在更新实时大纲…', '正在想下一个问题…', '快好了…'];
  let i = 0;
  return setInterval(() => {
    const el = w?.querySelector('.working-label');
    if (el) el.textContent = hints[i++ % hints.length];
  }, 6000);
}

function renderAsk(r) {
  let html = esc(r.question || '');
  if (r.checklist && r.checklist.length) {
    const done = r.checklist.filter((c) => c.done).length;
    html += `<div class="hint">清单 ${done}/${r.checklist.length}：${r.checklist
      .map((c) => `${c.done ? '✓' : '…'} ${esc(c.label)}`)
      .join(' · ')}</div>`;
  }
  if (r.knowledgeSuggestion) html += `<div class="hint">${esc(r.knowledgeSuggestion)}</div>`;
  if (r.dataSuggestion) html += `<div class="hint">${esc(r.dataSuggestion)}</div>`;
  if (r.searchSuggestion) html += `<div class="hint">🔎 ${esc(r.searchSuggestion)}</div>`;
  if (r.recommendSuggestion) html += `<div class="hint">${esc(r.recommendSuggestion)}</div>`;
  if (r.recommendation) html += `<div class="rec">我的建议 · ${esc(r.recommendation)}</div>`;
  if (r.options && r.options.length) {
    html += `<div class="options">${r.options.map((o, i) => `<button class="opt" data-opt="${esc(o)}">${'ABC'[i]}. ${esc(o)}</button>`).join('')}</div>`;
  }
  // 对话内联实时大纲：即使不看右侧面板，用户也能在对话里看到大纲逐步成形
  const lo = r.liveOutline || null;
  if (lo && Array.isArray(lo.sections) && lo.sections.length) {
    const rows = lo.sections
      .map(
        (s, i) =>
          `<div class="mo-row"><span class="mo-no">${i + 1}</span><b>${esc(s.heading || '未命名节')}</b>${s.thesis ? `<i>${esc(s.thesis)}</i>` : ''}${s.words ? `<em>${s.words}字</em>` : ''}</div>`,
      )
      .join('');
    html += `<div class="mini-outline"><div class="mo-head">📋 实时大纲 · AI 正在从对话里总结<span class="mo-meta">${lo.complete ? '已成形' : '继续生长中'}</span></div>${rows}</div>`;
  } else if (r.checklist?.length) {
    // 大纲还没成形时，至少让用户看到"AI 已捕捉/还差什么"的实时进度
    const got = r.checklist.filter((c) => c.done).map((c) => c.label.replace(/（.*?）/, '')).join('、');
    html += `<div class="mini-outline dim"><div class="mo-head">🧩 我正在建立大纲 · 已捕捉：${esc(got || '开始收集')}</div><div class="mo-row muted">大纲会在对话中由我逐步总结成形——右侧面板会实时更新</div></div>`;
  }
  if (r.warn) html += `<div class="hint warn">${esc(r.warn)}</div>`;
  const el = addMsg('bot', html);
  el.querySelectorAll('.opt').forEach((b) => {
    b.addEventListener('click', () => { $('input').value = b.dataset.opt; send(); });
  });
}

function renderOutline(r) {
  const o = r && r.outline ? r.outline : r;
  if (!o || !o.sections) return;
  const pct = r.progress?.percent;
  $('outlineTitle').textContent = `《${o.title || '未命名'}》${typeof pct === 'number' ? ` · 大纲完成度 ${pct}%` : ''}`;
  $('outlineBody').innerHTML = o.sections.map((s, i) => `
    <div class="sec">
      <span class="no">${['一', '二', '三', '四', '五', '六', '七', '八'][i] || i + 1}</span>
      <span class="fn">${esc(s.function || '')}</span>
      ${s.status ? `<span class="badge ${s.status === 'ready' ? 'ok' : s.status === 'needs' ? 'gold' : ''}">${s.status === 'ready' ? '✓ 可写' : s.status === 'needs' ? '… 待补' : '○ 未定型'}</span>` : ''}
      <span class="txt">${esc(s.heading)}${s.thesis ? `<br><span style="color:var(--ink-2);font-size:13px">${esc(s.thesis)}</span>` : ''}</span>
      ${(s.missing || []).length ? `<div style="padding:4px 0 0 34px">${s.missing.map((m) => `<span class="miss">缺${esc(m)}</span>`).join('')}</div>` : ''}
    </div>`).join('');
  showView('outline', { keepStage: true });
  setStage('outline');
}

function mdToHtml(md) {
  return esc(md)
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .split(/\n\n+/)
    .map((p) => {
      const t = p.trim();
      if (!t) return '';
      if (/^<h/.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function updateDraftChars(text) {
  const n = String(text || '').replace(/\s/g, '').length;
  $('draftChars').textContent = n ? `${n} 字` : '';
}

function renderDraft(text, { title } = {}) {
  const titleMatch = text.match(/^# (.+)$/m);
  $('draftTitle').textContent = titleMatch ? titleMatch[1] : title || '成稿';
  $('draftPaper').innerHTML = mdToHtml(text);
  $('draftEditor').value = text;
  updateDraftChars(text);
  setDraftMode('preview');
  showView('draft', { keepStage: true });
  setStage('deliver');
}

function setDraftMode(mode) {
  const edit = mode === 'edit';
  $('draftPaper').hidden = edit;
  $('draftEditor').hidden = !edit;
  $('draftSave').hidden = !edit;
  document.querySelectorAll('#draftMode .seg-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === mode);
  });
}

async function renderReport() {
  showView('report', { keepStage: true });
  setStage('audit');
  const body = $('reportBody');
  body.innerHTML = '<div class="working"><span class="spinner"></span>生成审计报告…</div>';
  try {
    const data = await apiGet(`/api/report?sessionId=${sessionId}`);
    const m = data.metrics || {};
    const metric = (label, value, note, cls) => `
      <div class="metric ${cls || ''}">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
        <div class="note">${note}</div>
      </div>`;
    const issues = (data.issues || []).map((x) => `<li><span class="tag">·</span>${esc(x)}</li>`).join('');
    const rt = data.roundtrip || null;
    let rtHtml = '';
    if (rt?.skipped) {
      rtHtml = `<div class="ctx-line">回译校验未运行：${esc(rt.reason || '已跳过')}</div>`;
    } else if (rt) {
      const mark = rt.verdict === 'pass' ? '✓ 信息完整' : '⚠ 需要修订';
      rtHtml = `<div class="ctx-line">交付时已自动回译校验：${mark}（保留 ${rt.kept || 0} · 丢失 ${rt.lost || 0} · 漂移 ${rt.drifted || 0}）</div>`;
    }
    let curveHtml = '';
    try {
      const cv = await apiGet(`/api/curve?sessionId=${sessionId}`);
      if (cv.sections?.length) {
        const bar = (v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(Math.max(0, v || 0) / 12.5))];
        const rows = cv.sections
          .map(
            (s) =>
              `<div class="curve-row"><div class="curve-label">${esc(s.section)}</div><div class="curve-bars">` +
              `<span class="bar">张力 ${s.tension} ${bar(s.tension)}</span>` +
              `<span class="bar">密度 ${s.density} ${bar(s.density)}</span>` +
              `<span class="bar">情绪 ${s.emotion} ${bar(s.emotion)}</span>` +
              `<span class="bar">节奏 ${s.pacing} ${bar(s.pacing)}</span></div></div>`,
          )
          .join('');
        curveHtml = `<div class="report-list"><h3>节奏曲线（张力 / 密度 / 情绪 / 节奏）</h3>${rows}<div class="ctx-line" style="margin-top:6px">分值 0–100，供二次编辑参考；CLI 可运行 <code>sculptor curve</code></div></div>`;
      }
    } catch {}
    // 伏笔回收时间线（v0.47，P2 可视化）：已回收 → 未回收（悬空）
    let consHtml = '';
    try {
      const cc = await apiGet(`/api/consistency?sessionId=${sessionId}`);
      if (cc.total > 0) {
        const rec = (cc.recovered || [])
          .map(
            (i) =>
              `<div class="curve-mini-row"><span class="ok">✓ ${esc(i.section || '后文')}</span><span class="cand-text">${esc(i.clue.slice(0, 44))}${i.clue.length > 44 ? '…' : ''}</span></div>`,
          )
          .join('');
        const unre = (cc.unrecovered || [])
          .map(
            (i) =>
              `<div class="curve-mini-row"><span class="warn">○ ${esc(i.planted || '前文')}</span><span class="cand-text">${esc(i.clue.slice(0, 44))}${i.clue.length > 44 ? '…' : ''}（未回收）</span></div>`,
          )
          .join('');
        consHtml = `<div class="report-list"><h3>伏笔回收 · ${cc.recovered?.length || 0}/${cc.total}</h3>${
          rec || '<div class="ctx-line">全部已回收 ✓</div>'
        }${unre}</div>`;
      }
    } catch {}
    body.innerHTML =
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">` +
      metric('句长标准差', m.sentenceLengthStddev ?? '—', '真人参考 ≥ 8', m.sentenceLengthStddev >= 8 ? 'ok' : 'warn') +
      metric('段落变异系数', m.paragraphCv ?? '—', '真人参考 ≥ 0.35', m.paragraphCv >= 0.35 ? 'ok' : 'warn') +
      metric('句首去重率', (m.sentenceStartDedup ?? 0) + '%', '真人参考 ≥ 75%', m.sentenceStartDedup >= 75 ? 'ok' : 'warn') +
      metric('词汇二元 TTR', m.bigramTtr ?? '—', '真人参考 ≥ 0.70', m.bigramTtr >= 0.7 ? 'ok' : 'warn') +
      metric('黑名单/重复', `${m.blacklistHits || 0} / ${m.repeatedMetaphors || 0} / ${m.repeatedPatterns || 0}`, '套话 / 重复比喻 / 句式复用') +
      `</div>` +
      `<div class="report-list"><h3>审计结论</h3><ul>${issues || '<li>未发现硬伤（黑名单 0 · 硬失败 0）</li>'}</ul></div>` +
      curveHtml +
      consHtml +
      `<div class="report-list"><h3>内容保真 · 回译校验</h3>${rtHtml}<div id="rtResult"></div>
       <button class="btn btn-gold btn-sm" id="rtRun">运行回译校验（中译英→回译→信息点核对）</button></div>`;
    $('rtRun')?.addEventListener('click', async () => {
      const btn = $('rtRun');
      btn.disabled = true;
      btn.textContent = '回译校验中…（约需 4 次模型调用）';
      try {
        const r = await apiPost('/api/roundtrip', { sessionId });
        const verdictHtml =
          r.verdict === 'pass'
            ? '<div class="ctx-line" style="color:var(--ok)">✓ 信息完整、风格稳定</div>'
            : '<div class="ctx-line" style="color:#9c4b24">⚠ 需要修订（信息有丢失或漂移）</div>';
        $('rtResult').innerHTML =
          verdictHtml +
          `<pre class="rt-report">${esc(r.report || '')}</pre>`;
      } catch (e) {
        $('rtResult').innerHTML = `<div class="ctx-line">${esc(e.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = '运行回译校验（中译英→回译→信息点核对）';
      }
    });
  } catch (e) {
    body.innerHTML = `<div class="report-list"><h3>审计报告</h3><ul><li>${esc(e.message)}</li></ul></div>`;
  }
}

/* ── 会话流程 ─────────────────────────────────────── */
function applyMeta(meta) {
  sessionMeta = meta;
  $('sessionTitle').textContent = meta.title || '写作';
  $('sessionPill').textContent = meta.title || '未选择项目';
  $('sessionPill').title = meta.title || '';
  const chip = $('sessionChip');
  if (meta.category || meta.status) {
    chip.hidden = false;
    chip.textContent = [meta.category, meta.status].filter(Boolean).join(' · ');
    chip.className = `chip ${meta.status === '已交付' ? 'ok' : 'gold'}`;
  } else chip.hidden = true;
  $('sessionSub').textContent = meta.hasDraft
    ? `已进行到「${meta.status}」阶段${meta.styleNote ? ` · 风格底稿：${meta.styleNote}` : ''}`
    : `进度：${meta.confirmed || 0} 项已确认 · ${meta.materials || 0} 条素材${meta.styleNote ? ` · 风格底稿：${meta.styleNote}` : ''}`;
  const stageMap = { clarify: 'clarify', plan: 'outline', write: 'write', redteam: 'audit', deliver: 'deliver' };
  setStage(stageMap[meta.phase] || 'clarify');
}

async function handleStep(r) {
  if (r.meta) applyMeta(r.meta);
  if (r.kind === 'ask') {
    setStage('clarify');
    renderAsk(r);
  } else if (r.kind === 'confirm_outline') {
    addMsg('bot', esc(r.message || ''));
    renderOutline(r);
  } else if (r.kind === 'working') {
    const p = r.phase || '';
    if (['write', 'revise', 'rewrite'].includes(p)) { setStage('write'); $('sessionTitle').textContent = '写作 · 逐节推进'; }
    else if (['redteam', 'quality'].includes(p)) setStage('audit');
    addMsg('bot', esc(r.message || ''));
    if (r.progress) $('sessionSub').textContent = `进度 ${r.progress.done}/${r.progress.total} 节`;
  } else if (r.kind === 'deliver') {
    addMsg('bot', esc(r.message || ''));
    const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
    if (d.text) renderDraft(d.text);
  } else {
    addMsg('bot', esc(r.message || '（完成）'));
  }
  refreshPanel();
  // 实时大纲更新反馈：节数增长 → 右侧面板自动可见、切到大纲标签并高亮闪烁，
  // 让"大纲随对话逐步成形"这件事肉眼可见。
  const outlineCount = r.liveOutline?.sections?.length || 0;
  if (outlineCount > prevOutlineCount) {
    prevOutlineCount = outlineCount;
    contextVisible = true;
    updateContextVisibility();
    setPanelTab('outline');
    const pane = $('pane-outline');
    if (pane) {
      pane.classList.remove('ol-flash');
      void pane.offsetWidth;
      pane.classList.add('ol-flash');
      setTimeout(() => pane.classList.remove('ol-flash'), 1500);
    }
    toast(`📋 实时大纲更新到 ${outlineCount} 部分`);
  } else if (r.kind === 'ask' && outlineCount === 0) {
    prevOutlineCount = 0;
  }
}

async function submitChat(text) {
  const msg = String(text || '').trim();
  if (!sessionId || !msg || busy) return;
  addMsg('user', esc(msg));
  busy = true; $('send').disabled = true;
  const w = addWorking('Sculptor 正在思考…');
  const spin = spinWorking(w);
  try {
    const r = await apiPost('/api/step', { sessionId, message: msg });
    w.remove();
    await handleStep(r);
  } catch (e) {
    w.remove(); addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
  } finally {
    clearInterval(spin);
  }
  busy = false; $('send').disabled = false;
}

async function send() {
  const text = $('input').value.trim() || $('seedInput').value.trim();
  if (!text || busy) return;
  if (!sessionId) {
    busy = true; $('send').disabled = true; $('seedSend').disabled = true;
    // 先切到会话视图，让用户立刻看到进度（而不是在首页干等/无反馈）
    showView('session', { keepStage: true });
    setStage('clarify');
    $('sessionTitle').textContent = '正在理解你的想法…';
    addMsg('user', esc(text));
    const w = addWorking('正在理解你的想法…');
    const spin = spinWorking(w);
    try {
      const r = await apiPost('/api/start', { topic: text });
      sessionId = r.sessionId;
      if (r.meta) applyMeta(r.meta);
      contextVisible = true;
      updateContextVisibility();
      w.remove();
      await handleStep(r);
    } catch (e) {
      w.remove();
      addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
    } finally {
      clearInterval(spin);
    }
    busy = false; $('send').disabled = false; $('seedSend').disabled = false;
    $('input').value = ''; $('seedInput').value = '';
    renderDash();
    return;
  }
  $('input').value = '';
  submitChat(text);
}

async function resumeSession(id) {
  try {
    const metaData = await apiGet(`/api/session?sessionId=${id}`);
    sessionId = id;
    applyMeta(metaData.meta);
    contextVisible = true;
    updateContextVisibility();
    setPanelTab('outline');
    const t = await apiGet(`/api/transcript?sessionId=${id}`);
    $('chat').innerHTML = '';
    let sawDraft = false;
    let lastBotKind = '';
    for (const e of t.entries || []) {
      if (e.role === 'user') {
        addMsg('user', esc(e.text));
      } else if (e.role === 'bot') {
        lastBotKind = e.kind || lastBotKind;
        if (e.kind === 'confirm_outline' && e.outline) {
          addMsg('bot', esc(e.text || ''));
          renderOutline({ outline: e.outline });
        } else if (e.kind === 'deliver') {
          addMsg('bot', esc(e.text || ''));
          const d = await apiGet(`/api/draft?sessionId=${id}`);
          if (d.text) { sawDraft = true; renderDraft(d.text); }
        } else {
          addMsg('bot', esc(e.text || ''));
        }
      }
    }
    if (!sawDraft) {
      if (lastBotKind === 'confirm_outline') {
        setStage('outline');
      } else {
        showView('session', { keepStage: true });
        const stageMap = { clarify: 'clarify', plan: 'outline', write: 'write', redteam: 'audit', deliver: 'deliver' };
        setStage(stageMap[metaData.meta.phase] || 'clarify');
      }
    }
    refreshPanel();
    renderDash();
  } catch (e) {
    toast('恢复会话失败：' + e.message);
  }
}

/* ── 首页 Dashboard ───────────────────────────────── */
async function renderDash() {
  try {
    const o = await apiGet('/api/overview');
    let html = [
      ['项目', o.sessions], ['作品', o.works], ['草稿', o.drafts], ['知识条目', o.knowledge],
    ].map(([label, n]) => `<div class="stat-card"><div class="stat-num">${n}</div><div class="stat-label">${label}</div></div>`).join('');
    const cats = Object.entries(o.byCat || {});
    if (cats.length) {
      html += `<div class="stat-card wide"><div class="stat-num small">${cats.map(([c, n]) => `${esc(c)} ${n}`).join(' · ')}</div><div class="stat-label">作品分类</div></div>`;
    }
    $('dashStats').innerHTML = html;
    const recent = o.recent || [];
    $('dashRecent').hidden = !recent.length;
    $('recentList').innerHTML = recent.map((s) => `
      <button class="recent-chip" data-id="${esc(s.id)}">${esc(s.title)}<span class="chip">${esc(s.status || '')}</span></button>`).join('');
    $('recentList').querySelectorAll('.recent-chip').forEach((b) => {
      b.addEventListener('click', () => resumeSession(b.dataset.id));
    });
  } catch { /* 静默 */ }
}

/* ── 项目列表 ─────────────────────────────────────── */
async function renderSessions() {
  const wrap = $('sessionList');
  wrap.innerHTML = '<div class="working"><span class="spinner"></span>加载项目…</div>';
  try {
    const { sessions } = await apiGet('/api/sessions');
    if (!sessions.length) {
      wrap.innerHTML = '<div class="empty">还没有项目。<br>从「开始写作」说出你的第一个念头吧。</div>';
      return;
    }
    wrap.innerHTML = sessions.map((s) => `
      <div class="session-card" data-id="${esc(s.id)}">
        <h3>${esc(s.title)}</h3>
        <div class="meta">${[s.category, s.status, fmtDate(s.updatedAt)].filter(Boolean).join(' · ')}</div>
        <div class="meta prog">
          ${s.genre ? `<span class="vchip">${esc(s.genre)}</span>` : ''}
          ${typeof s.sections === 'number' ? `<span class="vchip">大纲 ${s.sections} 节</span>` : ''}
          ${typeof s.materials === 'number' ? `<span class="vchip">素材 ${s.materials} 条</span>` : ''}
          ${typeof s.confirmed === 'number' ? `<span class="vchip">已确认 ${s.confirmed} 项</span>` : ''}
          ${s.styleNote ? `<span class="vchip">风格底稿 ✓</span>` : ''}
        </div>
        <div class="ops">
          <button class="icon-btn" data-act="open">继续</button>
          <button class="icon-btn" data-act="rename">改名</button>
          <button class="icon-btn danger" data-act="del">删除</button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('.session-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        const id = card.dataset.id;
        if (act === 'rename') {
          const title = prompt('新标题：', card.querySelector('h3').textContent);
          if (title && title.trim()) {
            apiPatch('/api/session', { sessionId: id, title: title.trim() })
              .then(() => { toast('已改名'); renderSessions(); renderDash(); })
              .catch((e) => toast(e.message));
          }
          return;
        }
        if (act === 'del') {
          if (confirm(`删除项目「${card.querySelector('h3').textContent}」？该操作不可恢复。`)) {
            apiDelete('/api/session', { sessionId: id })
              .then(() => { toast('已删除'); if (sessionId === id) { sessionId = null; sessionMeta = null; } renderSessions(); renderDash(); })
              .catch((e) => toast(e.message));
          }
          return;
        }
        resumeSession(id);
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ── 风格肖像 ─────────────────────────────────────── */
function dimCard(k, d) {
  const conf = Math.max(0, Math.min(1, Number(d?.confidence) || 0));
  const val = d?.value || '';
  const ev = Array.isArray(d?.evidence) ? d.evidence[0] : (d?.evidence || '');
  return `
    <div class="dim-card">
      <div class="dim-head"><span class="dim-name">${esc(DIM_CN[k] || k)}</span><span class="dim-conf">${(conf * 100).toFixed(0)}%</span></div>
      <div class="dim-value">${esc(val) || '—'}</div>
      <div class="bar ${conf < 0.6 ? 'low' : ''}"><i style="width:${Math.max(conf * 100, 4)}%"></i></div>
      ${ev ? `<div class="dim-ev">${esc(ev)}</div>` : ''}
    </div>`;
}

function drawRadar(dims) {
  const canvas = $('styleRadar');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2 + 8;
  const R = Math.min(w, h) / 2 - 46;
  const entries = Object.entries(dims || {}).filter(([, d]) => d && (d.confidence || 0) > 0);
  ctx.clearRect(0, 0, w, h);
  if (entries.length < 3) {
    ctx.fillStyle = '#8a7a62';
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('信号不足——多聊几轮、多写几篇后再画雷达', cx, cy);
    $('radarNote').textContent = '';
    return;
  }
  const n = entries.length;
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  for (let ring = 1; ring <= 4; ring++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = angle(i % n);
      const r = (R * ring) / 4;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = '#e4d8c2';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.font = '11px "PingFang SC", sans-serif';
  ctx.fillStyle = '#8a7a62';
  ctx.textAlign = 'center';
  entries.forEach(([, d], i) => {
    const a = angle(i);
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#e4d8c2';
    ctx.stroke();
    const label = (DIM_CN[entries[i][0]] || entries[i][0]).slice(0, 4);
    ctx.fillText(label, cx + (R + 18) * Math.cos(a), cy + (R + 18) * Math.sin(a) + 3);
  });
  ctx.beginPath();
  entries.forEach(([, d], i) => {
    const a = angle(i);
    const r = R * Math.max(0, Math.min(1, d.confidence || 0));
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(192,91,45,0.16)';
  ctx.fill();
  ctx.strokeStyle = '#c05b2d';
  ctx.lineWidth = 2;
  ctx.stroke();
  entries.forEach(([, d], i) => {
    const a = angle(i);
    const r = R * Math.max(0, Math.min(1, d.confidence || 0));
    ctx.beginPath();
    ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#c05b2d';
    ctx.fill();
  });
  const learned = entries.filter(([, d]) => (d.confidence || 0) >= 0.6).length;
  $('radarNote').textContent = `${entries.length} 个维度有信号 · ${learned} 个置信 ≥ 60% · 越接近外圈越确定`;
}

async function renderPersona() {
  if (!sessionId) {
    toast('请先打开或创建一个项目');
    showView('sessions');
    renderSessions();
    return;
  }
  const body = $('personaBody');
  body.innerHTML = '<div class="working"><span class="spinner"></span>读取风格数据…</div>';
  try {
    const s = await apiGet(`/api/style?sessionId=${sessionId}`);
    const p = s.persona;
    $('personaTitle').textContent = sessionMeta ? `${sessionMeta.title} · 风格肖像` : '风格肖像';
    const fields = [
      ['perspective', '叙述视角'], ['lexicon', '词汇偏好'], ['syntax', '句式习惯'],
      ['emotion', '情感表达'], ['values', '价值观倾向'], ['patterns', '套路与盲区'],
      ['reference', '引用习惯'], ['identification', '与读者的共鸣'],
    ];
    let html = '';
    if (p) {
      html += `<div class="persona-hero"><div class="p-title">总评 · ${p.updatedAt ? fmtDate(p.updatedAt) : ''}</div><div class="p-text">${esc(p.summary || '（样本还不足，继续写几篇后我会更懂你）')}</div></div>`;
      for (const [k, label] of fields) {
        if (!p[k]) continue;
        html += `<div class="persona-card"><div class="p-title">${label}</div><div class="p-text">${esc(p[k])}</div></div>`;
      }
      if (p.fallback) html += `<div class="persona-card"><div class="p-title">说明</div><div class="p-text">当前为确定性兜底侧写：素材越充足，肖像越具体。继续写作、补充知识库后会自动刷新。</div></div>`;
    } else {
      html = `<div class="empty">风格肖像尚未生成。<br>完成一次写作（澄清 → 大纲 → 成稿）后，它会从你的旧稿、修改记录、知识库里侧写出来。</div>`;
    }
    body.innerHTML = html;
    drawRadar(s.write?.dimensions);

    const dims = [];
    for (const [k, d] of Object.entries(s.write?.dimensions || {})) dims.push({ k, d, group: 'write' });
    for (const [k, d] of Object.entries(s.read?.structure || {})) dims.push({ k, d, group: 'read' });
    const learned = dims.filter((x) => (x.d?.confidence || 0) >= 0.6).length;
    $('styleDims').innerHTML = dims.length
      ? dims.map((x) => dimCard(x.k, x.d)).join('')
      : '<div class="empty">还没有维度信号——对话越多，维度越清晰。</div>';

    const vs = s.vectorSummary || {};
    const topDims = Array.isArray(vs.topDims) ? vs.topDims : [];
    const px = s.vector?.perplexity || {};
    const lf = s.vector?.learnedFrom || {};
    $('vectorChips').innerHTML = `
      <div class="vector-panel">
        <h3>复合风格向量（四层：连续向量 · 动态维度 · 困惑度签名 · 偏好对）</h3>
        <div class="vector-chips">
          ${topDims.length ? topDims.map((d) => `<span class="vchip">${esc(d.label || d)} · ${esc(d.weight ?? '')}</span>`).join('') : '<span class="vchip">尚未积累足够向量</span>'}
        </div>
      </div>`;
    const writeLf = s.write?.learnedFrom || {};
    $('styleMeta').innerHTML = `
      <div class="style-meta">
        <h3>采集进度</h3>
        <div class="meta-grid">
          <div class="meta-item"><div class="label">write 维度</div><div class="value">${learned}/${dims.length} 维置信 ≥ 60%</div></div>
          <div class="meta-item"><div class="label">风格信号</div><div class="value">${lf.signals || 0} 次（澄清 ${lf.clarify || 0} · 写作 ${lf.write || 0} · 修改 ${lf.edit || 0} · 方向 ${lf.direction || 0}）</div></div>
          <div class="meta-item"><div class="label">困惑度签名</div><div class="value">${px.samples || 0} 次采样 · 均值 ${px.mean ?? '—'} · 峰值 ${px.max ?? '—'}</div></div>
          <div class="meta-item"><div class="label">样本</div><div class="value">旧稿 ${writeLf.samples || 0} · 修改 ${writeLf.edits || 0}</div></div>
          ${s.styleNote ? `<div class="meta-item"><div class="label">你的风格自述</div><div class="value">${esc(s.styleNote)}</div></div>` : ''}
        </div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ── 知识库 ───────────────────────────────────────── */
function applyKnowledgeFilter() {
  const q = ($('knowledgeSearch').value || '').trim().toLowerCase();
  const list = kbCache.filter((e) => {
    const hitQ = !q || (e.title || '').toLowerCase().includes(q) || (e.note || '').toLowerCase().includes(q);
    const hitT = !kbType || e.type === kbType;
    return hitQ && hitT;
  });
  const types = [...new Set(kbCache.map((e) => e.type || 'book'))];
  $('knowledgeFilter').innerHTML =
    `<button class="chip-btn ${!kbType ? 'is-active' : ''}" data-t="">全部</button>` +
    types.map((t) => `<button class="chip-btn ${kbType === t ? 'is-active' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('');
  $('knowledgeFilter').querySelectorAll('[data-t]').forEach((b) => {
    b.addEventListener('click', () => { kbType = b.dataset.t; applyKnowledgeFilter(); });
  });
  if (!list.length) {
    $('knowledgeList').innerHTML = '<div class="empty">没有匹配的条目。</div>';
    return;
  }
  $('knowledgeList').innerHTML = list.map((e) => `
    <div class="kb-card">
      <h3>${esc(e.title)}</h3>
      <div class="kb-tags">
        <span class="chip">${esc(e.type || 'book')}</span>
        ${(e.tags || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
      </div>
      ${e.note ? `<div class="kb-note">${esc(e.note.slice(0, 160))}</div>` : ''}
      <div class="kb-meta">来源 ${esc(e.source || 'user-stated')} · 置信 ${Math.round((e.confidence || 0) * 100)}% · 用过 ${e.usageCount || 0} 次 · ${fmtDate(e.createdAt)}</div>
      <div class="ops" style="margin-top:10px"><button class="icon-btn danger" data-session="${esc(e.sessionId || sessionId || '')}" data-id="${esc(e.id)}" data-title="${esc(e.title)}">删除</button></div>
    </div>`).join('');
  $('knowledgeList').querySelectorAll('[data-id]').forEach((b) => {
    b.addEventListener('click', () => {
      if (confirm(`从知识库删除「${b.dataset.title}」？`)) {
        apiDelete('/api/knowledge', { sessionId: b.dataset.session || sessionId, id: b.dataset.id })
          .then(() => { toast('已删除'); renderKnowledge(); renderDash(); })
          .catch((e) => toast(e.message));
      }
    });
  });
}

async function renderKnowledge() {
  $('knowledgeList').innerHTML = '<div class="working"><span class="spinner"></span>读取知识库…</div>';
  try {
    const { entries } = await apiGet('/api/knowledge');
    kbCache = entries;
    if (!entries.length) {
      $('knowledgeFilter').innerHTML = '';
      $('knowledgeList').innerHTML = '<div class="empty">知识库还是空的。<br>在对话里提到看过的书/视频（如B站）、新闻、去过的地方、认同的观点，AI 会筛选收录。</div>';
      return;
    }
    applyKnowledgeFilter();
  } catch (e) {
    $('knowledgeList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ── 作品库 ───────────────────────────────────────── */
function applyWorksFilter() {
  const q = ($('worksSearch').value || '').trim().toLowerCase();
  const list = worksCache.filter((w) => {
    const hitQ = !q || (w.title || '').toLowerCase().includes(q) || (w.sessionTitle || '').toLowerCase().includes(q);
    const hitC = !worksCat || w.category === worksCat;
    return hitQ && hitC;
  });
  const cats = [...new Set(worksCache.map((w) => w.category || '未分类'))];
  $('worksFilter').innerHTML =
    `<button class="chip-btn ${!worksCat ? 'is-active' : ''}" data-c="">全部</button>` +
    cats.map((c) => `<button class="chip-btn ${worksCat === c ? 'is-active' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $('worksFilter').querySelectorAll('[data-c]').forEach((b) => {
    b.addEventListener('click', () => { worksCat = b.dataset.c; applyWorksFilter(); });
  });
  if (!list.length) {
    $('worksBody').innerHTML = '<div class="empty">没有匹配的作品。</div>';
    return;
  }
  const groups = {};
  for (const w of list) (groups[w.category || '未分类'] = groups[w.category || '未分类'] || []).push(w);
  $('worksBody').innerHTML = Object.entries(groups).map(([cat, items]) => `
    <div class="work-group">
      <h3>${esc(cat)} · ${items.length} 篇</h3>
      <div class="work-list">
        ${items.map((w) => `
          <div class="work-card ${worksCompareMode ? 'selectable' : ''}" data-sid="${esc(w.sessionId)}" data-file="${esc(w.file)}">
            <h4>${esc(w.title)}</h4>
            <div class="meta">${esc(w.sessionTitle || '')} · ${w.chars ? `${w.chars} 字 · ` : ''}${fmtDate(w.ts)}${w.draftOnly ? ' · 进行中' : ''}</div>
            ${worksCompareMode ? '' : `<div class="ops">
              <button class="icon-btn" data-op="continue">继续</button>
              <button class="icon-btn" data-op="rename">改名</button>
              <button class="icon-btn danger" data-op="del">删除</button>
            </div>`}
          </div>`).join('')}
      </div>
    </div>`).join('');
  $('worksBody').querySelectorAll('.work-card').forEach((card) => {
    card.querySelectorAll('[data-op]').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const sid = card.dataset.sid;
        const file = card.dataset.file;
        const op = btn.dataset.op;
        const title = card.querySelector('h4').textContent;
        if (op === 'rename') {
          const t = prompt('新标题：', title);
          if (t && t.trim()) {
            await apiPost('/api/work', { sessionId: sid, file, title: t.trim() }).catch((e) => toast(e.message));
            renderWorks();
          }
        } else if (op === 'del') {
          if (confirm(`从作品库删除「${title}」？`)) {
            await apiDelete('/api/work', { sessionId: sid, file }).catch((e) => toast(e.message));
            toast('已删除');
            renderWorks();
          }
        } else if (op === 'continue') {
          // 继续：把这篇作品导入为当前会话的草稿（无会话则新建）
          try {
            const { text } = await apiGet(`/api/work?sessionId=${sid}&file=${encodeURIComponent(file)}`);
            if (!sessionId) {
              const r = await apiPost('/api/start', { topic: title || '导入作品' });
              sessionId = r.sessionId;
              contextVisible = true;
              updateContextVisibility();
            }
            const imp = await apiPost('/api/import-draft', { sessionId, title: title || '导入作品', text });
            toast(`已导入草稿（${imp.chars} 字），可审计/导出/继续改写`);
            await resumeSession(sessionId);
            showView('draft');
            renderDraft(text, { title: imp.title });
          } catch (e) {
            toast('继续失败：' + e.message);
          }
        }
      });
    });
    card.addEventListener('click', () => {
      if (worksCompareMode) {
        const key = `${card.dataset.sid}|${card.dataset.file}`;
        const idx = worksCompareSel.findIndex((x) => x.key === key);
        if (idx >= 0) {
          worksCompareSel.splice(idx, 1);
          card.classList.remove('selected');
        } else {
          if (worksCompareSel.length >= 2) {
            const removed = worksCompareSel.shift();
            document.querySelectorAll('#worksBody .work-card').forEach((c) => {
              if (`${c.dataset.sid}|${c.dataset.file}` === removed.key) c.classList.remove('selected');
            });
          }
          worksCompareSel.push({
            key,
            sid: card.dataset.sid,
            file: card.dataset.file,
            title: card.querySelector('h4')?.textContent || '',
          });
          card.classList.add('selected');
        }
        if (worksCompareSel.length === 2) renderWorksCompare();
      } else {
        openWork(card.dataset.sid, card.dataset.file);
      }
    });
  });
}

/* ── 多作品对比（v0.48，P2）：两篇作品的人类化指标并排 ── */
async function renderWorksCompare() {
  const [x, y] = worksCompareSel;
  $('worksBody').innerHTML = '<div class="working"><span class="spinner"></span>对比两篇作品…</div>';
  try {
    const r = await apiGet(
      `/api/works/compare?sessionId=${encodeURIComponent(x.sid)}&file=${encodeURIComponent(x.file)}` +
        `&sessionId2=${encodeURIComponent(y.sid)}&file2=${encodeURIComponent(y.file)}`,
    );
    const num = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));
    const pct = (v) => (v == null ? '—' : `${v}%`);
    const metric = (label, a, b, note) =>
      `<tr><td>${label}${note ? `<small>${note}</small>` : ''}</td><td>${a}</td><td>${b}</td></tr>`;
    $('worksBody').innerHTML = `
      <div class="compare-head">
        <button class="btn btn-ghost btn-sm" id="compareBack">← 返回作品库</button>
        <div class="compare-titles"><b>${esc(x.title)}</b><span>vs</span><b>${esc(y.title)}</b></div>
      </div>
      <table class="compare-table">
        <tr><th>指标（真人参考区间）</th><th>作品 A</th><th>作品 B</th></tr>
        ${metric('字数', r.a.chars, r.b.chars)}
        ${metric('句长标准差（≥8）', num(r.a.sentenceLengthStddev), num(r.b.sentenceLengthStddev))}
        ${metric('段落变异系数（≥0.35）', num(r.a.paragraphCv), num(r.b.paragraphCv))}
        ${metric('句首去重率（≥75%）', pct(r.a.sentenceStartDedup), pct(r.b.sentenceStartDedup))}
        ${metric('词汇二元 TTR（≥0.70）', num(r.a.bigramTtr), num(r.b.bigramTtr))}
        ${metric('黑名单 / 重复比喻 / 句式复用', `${r.a.blacklistHits || 0} / ${r.a.repeatedMetaphors || 0} / ${r.a.repeatedPatterns || 0}`, `${r.b.blacklistHits || 0} / ${r.b.repeatedMetaphors || 0} / ${r.b.repeatedPatterns || 0}`)}
      </table>`;
    $('compareBack')?.addEventListener('click', () => {
      worksCompareSel = [];
      applyWorksFilter();
    });
  } catch (e) {
    $('worksBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function renderWorks() {
  $('worksBody').innerHTML = '<div class="working"><span class="spinner"></span>读取作品库…</div>';
  try {
    const { works } = await apiGet('/api/works');
    worksCache = works;
    if (!works.length) {
      $('worksFilter').innerHTML = '';
      $('worksBody').innerHTML = '<div class="empty">作品库还是空的。<br>完成一篇写作后，成稿会自动归档并按文体分类。</div>';
      return;
    }
    applyWorksFilter();
  } catch (e) {
    $('worksBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function openWork(sid, file) {
  try {
    const { text, title } = await apiGet(`/api/work?sessionId=${sid}&file=${encodeURIComponent(file)}`);
    workCtx = { sessionId: sid, file };
    $('workModalTitle').textContent = title || '作品';
    $('workModalPaper').innerHTML = mdToHtml(text);
    $('workAnnPanel').hidden = true;
    $('workModal').hidden = false;
  } catch (e) {
    toast('打开作品失败：' + e.message);
  }
}

/* ── 批注（v0.61）：选段批注 → 落库 → 查看/删除 → 一键 AI 按批注修改 ── */
let annFloat = null;

async function renderAnnPanel(file, sid, listId, titleId) {
  if (!sid) return;
  const el = $(listId);
  try {
    const list = await annListFor(sid, file);
    if (!list.length) {
      el.innerHTML = '<div class="empty">还没有批注。在正文里选中一段文字，就会出现批注入口。</div>';
    } else {
      el.innerHTML = list
        .map(
          (a) => `
      <div class="ann-item ${a.status === 'done' ? 'done' : ''}" data-id="${esc(a.id)}">
        <div class="ann-quote">“${esc(a.quote)}”</div>
        <div class="ann-comment">${esc(a.comment)}</div>
        <div class="ann-meta">${a.status === 'done' ? '已应用 ✓' : '待处理'} · ${fmtDate(a.ts)}</div>
        <div class="ops"><button class="icon-btn" data-op="jump">定位</button><button class="icon-btn danger" data-op="del">删除</button></div>
      </div>`,
        )
        .join('');
    }
    if (titleId) $(titleId).textContent = `批注（${list.length}）`;
    el.querySelectorAll('[data-op]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const item = b.closest('.ann-item');
        const id = item.dataset.id;
        if (b.dataset.op === 'del') {
          apiDelete('/api/annotations', { sessionId: sid, id })
            .then(() => { toast('批注已删除'); renderAnnPanel(file, sid, listId, titleId); })
            .catch((e) => toast(e.message));
        } else {
          annJump(item.querySelector('.ann-quote').textContent.replace(/^“|”$/g, ''));
        }
      });
    });
  } catch {
    el.innerHTML = '<div class="empty">批注读取失败</div>';
  }
}

async function annListFor(sid, file) {
  const q = new URLSearchParams({ sessionId: sid });
  if (file) q.set('file', file);
  const r = await apiGet(`/api/annotations?${q.toString()}`);
  return r.annotations || [];
}

function annJump(quote) {
  const container = document.querySelector('#draftPaper:not([hidden]), #workModalPaper:not([hidden])');
  if (!container) return;
  const nodes = [...container.querySelectorAll('p, h1, h2, h3, li')];
  const p = nodes.find((x) => (x.textContent || '').includes(quote));
  if (p) {
    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    p.classList.remove('ann-flash');
    void p.offsetWidth;
    p.classList.add('ann-flash');
    setTimeout(() => p.classList.remove('ann-flash'), 1500);
  } else {
    toast('原文中找不到该片段（可能已被修改）');
  }
}

function hideAnnInput() {
  if (annFloat) { annFloat.remove(); annFloat = null; }
}

function showAnnInput(x, y, sid, file, quote) {
  hideAnnInput();
  const card = document.createElement('div');
  card.className = 'ann-input';
  card.style.left = Math.min(x, window.innerWidth - 300) + 'px';
  card.style.top = Math.min(y, window.innerHeight - 170) + 'px';
  card.innerHTML = `
    <div class="ann-input-quote">“${esc(quote.slice(0, 80))}”</div>
    <textarea rows="3" placeholder="写批注，例如：这段太 AI 腔，改成短句；这句公式渲染有问题…"></textarea>
    <div class="ops"><button class="btn btn-gold btn-sm" id="annInputSave">保存批注</button><button class="btn btn-ghost btn-sm" id="annInputCancel">取消</button></div>`;
  document.body.appendChild(card);
  card.querySelector('#annInputSave').addEventListener('click', async () => {
    const comment = card.querySelector('textarea').value.trim();
    if (!comment) { toast('批注内容不能为空'); return; }
    try {
      await apiPost('/api/annotations', { sessionId: sid, file, quote, comment });
      toast('批注已保存');
      hideAnnInput();
      if (file === 'draft.md' && !$('annPanel').hidden) renderAnnPanel('draft.md', sid, 'annList', 'annTitle');
      else if ($('workAnnPanel') && !$('workAnnPanel').hidden && workCtx) renderAnnPanel(workCtx.file, workCtx.sessionId, 'workAnnList');
    } catch (e) { toast(e.message); }
  });
  card.querySelector('#annInputCancel').addEventListener('click', hideAnnInput);
  annFloat = card;
}

document.addEventListener('mouseup', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideAnnInput(); return; }
  const text = String(sel.toString() || '').trim();
  const node = sel.anchorNode;
  const container = node && node.nodeType === 3 ? node.parentElement : node;
  const inDraft = container && container.closest('#draftPaper');
  const inWork = container && container.closest('#workModalPaper');
  if ((!inDraft && !inWork) || text.length < 2) { hideAnnInput(); return; }
  const sid = sessionId || (workCtx && workCtx.sessionId) || '';
  const file = inDraft ? 'draft.md' : (workCtx && workCtx.file) || '';
  if (!sid || !file) { hideAnnInput(); return; }
  showAnnInput(e.clientX + 8, e.clientY + 14, sid, file, text);
});

$('draftAnn')?.addEventListener('click', async () => {
  const show = $('annPanel').hidden;
  $('annPanel').hidden = !show;
  if (show && sessionId) renderAnnPanel('draft.md', sessionId, 'annList', 'annTitle');
});
$('annClose')?.addEventListener('click', () => { $('annPanel').hidden = true; });
$('annApply')?.addEventListener('click', async () => {
  try {
    const r = await apiPost('/api/annotations/apply', { sessionId });
    toast(`已应用 ${r.applied.length} 条${r.failed.length ? `，失败 ${r.failed.length} 条` : ''}`);
    if (r.applied.length) {
      const d = await apiGet(`/api/draft?sessionId=${sessionId}`);
      if (d.text) renderDraft(d.text);
    }
    renderAnnPanel('draft.md', sessionId, 'annList', 'annTitle');
  } catch (e) { toast(e.message); }
});
$('workModalAnn')?.addEventListener('click', async () => {
  if (!workCtx) return;
  const show = $('workAnnPanel').hidden;
  $('workAnnPanel').hidden = !show;
  if (show) renderAnnPanel(workCtx.file, workCtx.sessionId, 'workAnnList');
});
$('workAnnClose')?.addEventListener('click', () => { $('workAnnPanel').hidden = true; });

/* ── 事件绑定 ─────────────────────────────────────── */
$('send').addEventListener('click', send);
$('seedSend').addEventListener('click', send);
$('seedInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('seedInput').addEventListener('input', () => {
  $('seedSend').disabled = busy || !$('seedInput').value.trim();
});
$('input').addEventListener('input', () => {
  $('send').disabled = busy || !$('input').value.trim();
});
$('draftEditor').addEventListener('input', () => {
  updateDraftChars($('draftEditor').value);
});
document.querySelectorAll('.seed').forEach((b) => {
  b.addEventListener('click', () => {
    $('seedInput').value = b.dataset.t;
    $('seedSend').disabled = false;
    send();
  });
});
document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => {
    const n = b.dataset.nav;
    if (n === 'sessions') renderSessions();
    if (n === 'works') renderWorks();
    if (n === 'persona') renderPersona();
    if (n === 'knowledge') renderKnowledge();
    if (n === 'tools') renderTools();
    showView(n);
  });
});
$('newSessionBtn').addEventListener('click', () => showView('home'));

$('contextToggle').addEventListener('click', () => {
  contextVisible = !contextVisible;
  updateContextVisibility();
  if (contextVisible) refreshPanel();
});
$('contextClose').addEventListener('click', () => {
  contextVisible = false;
  updateContextVisibility();
});
document.querySelectorAll('#panelTabs .tab').forEach((b) => {
  b.addEventListener('click', () => setPanelTab(b.dataset.tab));
});
$('worksSearch').addEventListener('input', applyWorksFilter);
$('knowledgeSearch').addEventListener('input', applyKnowledgeFilter);

$('outlineConfirm').addEventListener('click', () => {
  $('input').value = '可以，就是这样';
  showView('session', { keepStage: true });
  setStage('write');
  send();
});
$('outlineEdit').addEventListener('click', () => {
  showView('session', { keepStage: true });
  $('input').placeholder = '说出要改哪里，它会调整大纲…';
  $('input').focus();
});
$('draftAudit').addEventListener('click', renderReport);
$('reportBack').addEventListener('click', () => showView('draft', { keepStage: true }));
$('draftBack').addEventListener('click', () => { showView('session', { keepStage: true }); setStage('write'); });

document.querySelectorAll('#draftMode .seg-btn').forEach((b) => {
  b.addEventListener('click', () => setDraftMode(b.dataset.mode));
});
$('draftSave').addEventListener('click', async () => {
  try {
    await apiPost('/api/save-draft', { sessionId, text: $('draftEditor').value });
    toast('已保存修改');
    $('draftPaper').innerHTML = mdToHtml($('draftEditor').value);
    updateDraftChars($('draftEditor').value);
    setDraftMode('preview');
  } catch (e) { toast(e.message); }
});
$('draftExportMd').addEventListener('click', () => downloadExport(sessionId, 'md'));
$('draftExportDocx').addEventListener('click', () => downloadExport(sessionId, 'docx'));
$('draftExportPptx').addEventListener('click', () => downloadExport(sessionId, 'pptx'));

$('personaRefresh').addEventListener('click', renderPersona);
$('knowledgeRefresh').addEventListener('click', renderKnowledge);
$('worksRefresh').addEventListener('click', renderWorks);
$('worksImport')?.addEventListener('click', () => $('worksImportInput')?.click());
$('worksImportInput')?.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const dataBase64 = await fileToBase64(f);
    const r = await apiPost('/api/works/import', {
      sessionId: sessionId || '',
      filename: f.name,
      dataBase64,
      title: f.name.replace(/\.(md|txt|docx)$/i, ''),
    });
    toast(`已导入 ${r.parts} 个部分，进入作品库`);
    renderWorks();
  } catch (err) {
    toast('导入失败：' + err.message);
  }
});
$('worksSync')?.addEventListener('click', async () => {
  try {
    const r = await apiPost('/api/works/sync', {});
    toast(`同步完成，新归档 ${r.synced} 篇`);
    renderWorks();
  } catch (err) {
    toast('同步失败：' + err.message);
  }
});

$('workModalClose').addEventListener('click', () => { $('workModal').hidden = true; });
$('workModal').addEventListener('click', (e) => {
  if (e.target === $('workModal')) $('workModal').hidden = true;
});
$('workModalExportMd').addEventListener('click', () => {
  if (workCtx) downloadExport(workCtx.sessionId, 'md', workCtx.file);
});
$('workModalExportDocx').addEventListener('click', () => {
  if (workCtx) downloadExport(workCtx.sessionId, 'docx', workCtx.file);
});

document.querySelectorAll('.stage-item').forEach((b) => {
  b.addEventListener('click', () => {
    const s = b.dataset.stage;
    if (s === 'home') { showView('home'); setStage('home'); return; }
    if (!sessionId) { toast('请先打开或创建一个项目'); return; }
    const map = { clarify: 'session', outline: 'outline', write: 'session', audit: 'report', deliver: 'draft' };
    setStage(s);
    if (s === 'audit') renderReport();
    else showView(map[s] || 'session', { keepStage: true });
  });
});

/* ── 工具：学术规范审计 / 文档翻译 / 文档重写 ─────────── */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function toolSessionId() {
  return $('normSession').value || sessionId || '';
}

async function renderTools() {
  try {
    const { sessions } = await apiGet('/api/sessions');
    const sel = $('normSession');
    sel.innerHTML = '';
    for (const s of sessions) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.title || s.id}（${s.id.slice(0, 8)}）`;
      sel.appendChild(o);
    }
    if (!sessions.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（暂无项目：先创建并完成写作）';
      sel.appendChild(o);
    }
  } catch (e) { toast(e.message); }
}

function toolLinks(session, files) {
  if (!files || !files.length) return '<p class="session-sub">（无产物）</p>';
  return files
    .map(
      (f) =>
        `<a class="btn btn-ghost" href="/api/doc/download?sessionId=${encodeURIComponent(session)}&file=${encodeURIComponent(f)}" download>下载 ${f.split('/').pop()}</a>`,
    )
    .join(' ');
}

$('normRun').addEventListener('click', async () => {
  const sid = toolSessionId();
  if (!sid) { toast('请先选择项目'); return; }
  $('normResult').innerHTML = '<p class="session-sub">审计中…（LLM 深审可能需要一点时间）</p>';
  try {
    const r = await apiPost('/api/norm', { sessionId: sid });
    const rows = (r.items || [])
      .map(
        (i) =>
          `<tr><td>${esc(i.severity)}</td><td>${esc(i.type)}</td><td>${esc(i.evidence)}</td><td>${esc(i.issue)}</td><td>${esc(i.suggestion)}</td></tr>`,
      )
      .join('');
    $('normResult').innerHTML =
      `<p><b>综合评分：${r.score ?? '—'}/100</b>（LLM 模式：${r.llmMode}${r.reason ? '，' + esc(r.reason) : ''}）</p>` +
      `<p class="session-sub">${esc(r.summary || '')}</p>` +
      (rows ? `<table class="qa-table"><thead><tr><th>级别</th><th>类型</th><th>证据</th><th>问题</th><th>建议</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="session-sub">未发现确定性问题。</p>');
  } catch (e) {
    $('normResult').innerHTML = `<p style="color:#c0504d">${esc(e.message)}</p>`;
  }
});

$('trRun').addEventListener('click', async () => {
  const f = $('trFile').files[0];
  if (!f) { toast('请先选择要翻译的文档'); return; }
  $('trResult').innerHTML = '<p class="session-sub">翻译中…（原意解读 → 逐块翻译 → 回填格式）</p>';
  try {
    const dataBase64 = await fileToBase64(f);
    const r = await apiPost('/api/doc/translate', {
      sessionId: toolSessionId(),
      filename: f.name,
      dataBase64,
      lang: $('trLang').value.trim() || 'en',
    });
    const it = r.interpretation || {};
    $('trResult').innerHTML =
      `<p><b>状态：${r.ok ? '成功' : '未完成'}</b>${r.mode === 'docx-block' ? `（docx 块级回填，run 级格式保留：块 ${r.blocks ?? '—'} / 替换 ${r.replaced ?? '—'}${r.missing?.length ? ` / 未覆盖 ${r.missing.length}` : ''}）` : ''}</p>` +
      (it.intent ? `<p class="session-sub">原意解读：意图「${esc(it.intent)}」｜语气「${esc(it.tone)}」｜文体「${esc(it.genre)}」｜易损点「${esc((it.pitfalls || []).join('、'))}」</p>` : '') +
      (r.roundtrip ? `<p class="session-sub">回译校验：保留 ${r.roundtrip.kept ?? '—'} / 丢失 ${r.roundtrip.lost ?? '—'} / 漂移 ${r.roundtrip.drifted ?? '—'}</p>` : '') +
      (r.reason ? `<p style="color:#c0504d">${esc(r.reason)}</p>` : '') +
      `<p>${toolLinks(toolSessionId(), r.files)}</p>`;
  } catch (e) {
    $('trResult').innerHTML = `<p style="color:#c0504d">${esc(e.message)}</p>`;
  }
});

$('rsRun').addEventListener('click', async () => {
  const f = $('rsFile').files[0];
  if (!f) { toast('请先选择要重写的文档'); return; }
  $('rsResult').innerHTML = '<p class="session-sub">重写中…</p>';
  try {
    const dataBase64 = await fileToBase64(f);
    const r = await apiPost('/api/doc/restyle', {
      sessionId: toolSessionId(),
      filename: f.name,
      dataBase64,
      style: $('rsStyle').value.trim(),
    });
    $('rsResult').innerHTML =
      `<p><b>状态：${r.ok ? '成功' : '未完成'}</b>${r.mode === 'docx-block' ? `（docx 块级回填，run 级格式保留：块 ${r.blocks ?? '—'} / 替换 ${r.replaced ?? '—'}${r.missing?.length ? ` / 未覆盖 ${r.missing.length}` : ''}）` : ''}</p>` +
      (r.summary ? `<p class="session-sub">${esc(r.summary)}</p>` : '') +
      (r.reason ? `<p style="color:#c0504d">${esc(r.reason)}</p>` : '') +
      `<p>${toolLinks(toolSessionId(), r.files)}</p>`;
  } catch (e) {
    $('rsResult').innerHTML = `<p style="color:#c0504d">${esc(e.message)}</p>`;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('workModal').hidden = true;
    if (contextVisible && ['session', 'outline', 'draft', 'report'].includes(currentView)) {
      contextVisible = false;
      updateContextVisibility();
    }
  }
});

/* ── 初始化 ───────────────────────────────────────── */
renderDash();
ensureSplitBtn();
$('worksCompare')?.addEventListener('click', () => {
  worksCompareMode = !worksCompareMode;
  worksCompareSel = [];
  $('worksCompare').classList.toggle('is-active', worksCompareMode);
  applyWorksFilter();
});

// 实时伴随：面板每 4 秒自动刷新一次，让大纲/进度在讨论与写作中"自己长大"。
let panelRefreshing = false;
setInterval(() => {
  if (document.hidden || panelRefreshing) return;
  if (!contextVisible || !sessionId) return;
  if (!['session', 'outline', 'draft', 'report'].includes(currentView)) return;
  panelRefreshing = true;
  refreshPanel().finally(() => {
    panelRefreshing = false;
  });
}, 4000);
