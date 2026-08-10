/* Sculptor Studio · 视图路由与写作工作台
   设计标准：所有视图切换统一走 showView()（同一条 viewIn 动画），
   阶段（stage）与视图（view）一一映射；会话/作品/风格/知识库由侧栏导航统一入口。 */
const $ = (id) => document.getElementById(id);

const VIEWS = ['home', 'sessions', 'session', 'outline', 'draft', 'report', 'persona', 'knowledge', 'works'];
const STAGES = ['home', 'clarify', 'outline', 'write', 'audit', 'deliver'];
const NAVS = ['home', 'sessions', 'works', 'persona', 'knowledge'];
const CRUMB = {
  home: '启程', sessions: '项目', session: '写作', outline: '大纲',
  draft: '成稿', report: '审计', persona: '风格肖像', knowledge: '知识库', works: '作品库',
};

let sessionId = null;
let sessionMeta = null;
let busy = false;
let currentView = 'home';
let currentStage = 'home';
let workCtx = null; // 作品弹层 { sessionId, file }

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
  if (!keepStage && ['home', 'sessions', 'works', 'persona', 'knowledge'].includes(name)) setStage('home');
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

async function apiGet(pathname) {
  const r = await fetch(pathname);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiPost(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function apiDelete(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
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
  div.innerHTML = `<div class="working"><span class="spinner"></span>${esc(label)}</div>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

function renderAsk(r) {
  let html = esc(r.question || '');
  if (r.knowledgeSuggestion) html += `<div class="hint">${esc(r.knowledgeSuggestion)}</div>`;
  if (r.dataSuggestion) html += `<div class="hint">${esc(r.dataSuggestion)}</div>`;
  if (r.recommendSuggestion) html += `<div class="hint">${esc(r.recommendSuggestion)}</div>`;
  if (r.recommendation) html += `<div class="rec">我的建议 · ${esc(r.recommendation)}</div>`;
  if (r.options && r.options.length) {
    html += `<div class="options">${r.options.map((o, i) => `<button class="opt" data-opt="${esc(o)}">${'ABC'[i]}. ${esc(o)}</button>`).join('')}</div>`;
  }
  const el = addMsg('bot', html);
  el.querySelectorAll('.opt').forEach((b) => {
    b.addEventListener('click', () => { $('input').value = b.dataset.opt; send(); });
  });
}

function renderOutline(r) {
  const o = r && r.outline ? r.outline : r;
  if (!o || !o.sections) return;
  $('outlineTitle').textContent = `《${o.title || '未命名'}》`;
  $('outlineBody').innerHTML = o.sections.map((s, i) => `
    <div class="sec">
      <span class="no">${['一', '二', '三', '四', '五', '六', '七', '八'][i] || i + 1}</span>
      <span class="fn">${esc(s.function || '')}</span>
      <span class="txt">${esc(s.heading)}${s.thesis ? `<br><span style="color:var(--ink-2);font-size:13px">${esc(s.thesis)}</span>` : ''}</span>
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

function renderDraft(text, { title } = {}) {
  const titleMatch = text.match(/^# (.+)$/m);
  $('draftTitle').textContent = titleMatch ? titleMatch[1] : title || '成稿';
  $('draftPaper').innerHTML = mdToHtml(text);
  $('draftEditor').value = text;
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
    body.innerHTML =
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px">` +
      metric('句长标准差', m.sentenceLengthStddev ?? '—', '真人参考 ≥ 8', m.sentenceLengthStddev >= 8 ? 'ok' : 'warn') +
      metric('段落变异系数', m.paragraphCv ?? '—', '真人参考 ≥ 0.35', m.paragraphCv >= 0.35 ? 'ok' : 'warn') +
      metric('句首去重率', (m.sentenceStartDedup ?? 0) + '%', '真人参考 ≥ 75%', m.sentenceStartDedup >= 75 ? 'ok' : 'warn') +
      metric('词汇二元 TTR', m.bigramTtr ?? '—', '真人参考 ≥ 0.70', m.bigramTtr >= 0.7 ? 'ok' : 'warn') +
      metric('黑名单/重复', `${m.blacklistHits || 0} / ${m.repeatedMetaphors || 0} / ${m.repeatedPatterns || 0}`, '套话 / 重复比喻 / 句式复用') +
      `</div>` +
      `<div class="report-list"><h3>审计结论</h3><ul>${issues || '<li>未发现硬伤（黑名单 0 · 硬失败 0）</li>'}</ul></div>`;
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
}

async function send() {
  const text = $('input').value.trim() || $('seedInput').value.trim();
  if (!text || busy) return;
  if (!sessionId) {
    addMsg('user', esc(text));
    busy = true; $('send').disabled = true; $('seedSend').disabled = true;
    const w = addWorking('正在理解你的想法…');
    try {
      const r = await apiPost('/api/start', { topic: text });
      sessionId = r.sessionId;
      if (r.meta) applyMeta(r.meta);
      showView('session', { keepStage: true });
      setStage('clarify');
      w.remove();
      await handleStep(r);
    } catch (e) {
      w.remove(); addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
    }
    busy = false; $('send').disabled = false; $('seedSend').disabled = false;
    $('input').value = ''; $('seedInput').value = '';
    refreshRecent();
    return;
  }
  addMsg('user', esc(text));
  busy = true; $('send').disabled = true;
  const w = addWorking('Sculptor 正在思考…');
  try {
    const r = await apiPost('/api/step', { sessionId, message: text });
    w.remove();
    await handleStep(r);
  } catch (e) {
    w.remove(); addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
  }
  busy = false; $('send').disabled = false;
  $('input').value = '';
}

async function resumeSession(id) {
  try {
    const metaData = await apiGet(`/api/session?sessionId=${id}`);
    sessionId = id;
    applyMeta(metaData.meta);
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
        setStage('outline'); // 大纲视图已在 replay 时渲染，不要覆盖
      } else {
        showView('session', { keepStage: true });
        const stageMap = { clarify: 'clarify', plan: 'outline', write: 'write', redteam: 'audit', deliver: 'deliver' };
        setStage(stageMap[metaData.meta.phase] || 'clarify');
      }
    }
    refreshRecent();
  } catch (e) {
    toast('恢复会话失败：' + e.message);
  }
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
            apiPost('/api/session', { sessionId: id, title: title.trim() })
              .then(() => { toast('已改名'); renderSessions(); })
              .catch((e) => toast(e.message));
          }
          return;
        }
        if (act === 'del') {
          if (confirm(`删除项目「${card.querySelector('h3').textContent}」？该操作不可恢复。`)) {
            apiDelete('/api/session', { sessionId: id })
              .then(() => { toast('已删除'); if (sessionId === id) sessionId = null; renderSessions(); refreshRecent(); })
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

async function refreshRecent() {
  try {
    const { sessions } = await apiGet('/api/sessions');
    const recent = sessions.slice(0, 4);
    $('recentWrap').hidden = !recent.length;
    $('recentList').innerHTML = recent.map((s) => `
      <button class="recent-chip" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join('');
    $('recentList').querySelectorAll('.recent-chip').forEach((b) => {
      b.addEventListener('click', () => resumeSession(b.dataset.id));
    });
  } catch { /* 静默：非关键 */ }
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

    // 风格维度（write 14 + read 7）
    const dims = [];
    for (const [k, d] of Object.entries(s.write?.dimensions || {})) dims.push({ k, d, group: 'write' });
    for (const [k, d] of Object.entries(s.read?.structure || {})) dims.push({ k, d, group: 'read' });
    const learned = dims.filter((x) => (x.d?.confidence || 0) >= 0.6).length;
    $('styleDims').innerHTML = dims.length
      ? dims.map((x) => dimCard(x.k, x.d)).join('')
      : '<div class="empty">还没有维度信号——对话越多，维度越清晰。</div>';

    // 复合风格向量
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
async function renderKnowledge() {
  if (!sessionId) {
    toast('请先打开或创建一个项目');
    showView('sessions');
    renderSessions();
    return;
  }
  const wrap = $('knowledgeList');
  wrap.innerHTML = '<div class="working"><span class="spinner"></span>读取知识库…</div>';
  try {
    const { entries } = await apiGet(`/api/knowledge?sessionId=${sessionId}`);
    if (!entries.length) {
      wrap.innerHTML = '<div class="empty">知识库还是空的。<br>在对话里提到《书名》、去过的地方、认同的理论，它会归纳收录——只收你确认过的。</div>';
      return;
    }
    wrap.innerHTML = entries.map((e) => `
      <div class="kb-card">
        <h3>${esc(e.title)}</h3>
        <div class="kb-tags">
          <span class="chip">${esc(e.type || 'book')}</span>
          ${(e.tags || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
        </div>
        ${e.note ? `<div class="kb-note">${esc(e.note.slice(0, 160))}</div>` : ''}
        <div class="kb-meta">来源 ${esc(e.source || 'user-stated')} · 置信 ${Math.round((e.confidence || 0) * 100)}% · 用过 ${e.usageCount || 0} 次 · ${fmtDate(e.createdAt)}</div>
        <div class="ops" style="margin-top:10px"><button class="icon-btn danger" data-id="${esc(e.id)}" data-title="${esc(e.title)}">删除</button></div>
      </div>`).join('');
    wrap.querySelectorAll('[data-id]').forEach((b) => {
      b.addEventListener('click', () => {
        if (confirm(`从知识库删除「${b.dataset.title}」？`)) {
          apiDelete('/api/knowledge', { sessionId, id: b.dataset.id })
            .then(() => { toast('已删除'); renderKnowledge(); })
            .catch((e) => toast(e.message));
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/* ── 作品库 ───────────────────────────────────────── */
async function renderWorks() {
  const wrap = $('worksBody');
  wrap.innerHTML = '<div class="working"><span class="spinner"></span>读取作品库…</div>';
  try {
    const { works } = await apiGet('/api/works');
    if (!works.length) {
      wrap.innerHTML = '<div class="empty">作品库还是空的。<br>完成一篇写作后，成稿会自动归档并按文体分类。</div>';
      return;
    }
    const groups = {};
    for (const w of works) {
      (groups[w.category || '未分类'] = groups[w.category || '未分类'] || []).push(w);
    }
    wrap.innerHTML = Object.entries(groups).map(([cat, list]) => `
      <div class="work-group">
        <h3>${esc(cat)} · ${list.length} 篇</h3>
        <div class="work-list">
          ${list.map((w) => `
            <div class="work-card" data-sid="${esc(w.sessionId)}" data-file="${esc(w.file)}">
              <h4>${esc(w.title)}</h4>
              <div class="meta">${esc(w.sessionTitle || '')} · ${fmtDate(w.ts)}${w.draftOnly ? ' · 进行中' : ''}</div>
            </div>`).join('')}
        </div>
      </div>`).join('');
    wrap.querySelectorAll('.work-card').forEach((card) => {
      card.addEventListener('click', () => openWork(card.dataset.sid, card.dataset.file));
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function openWork(sid, file) {
  try {
    const { text, title } = await apiGet(`/api/work?sessionId=${sid}&file=${encodeURIComponent(file)}`);
    workCtx = { sessionId: sid, file };
    $('workModalTitle').textContent = title || '作品';
    $('workModalPaper').innerHTML = mdToHtml(text);
    $('workModal').hidden = false;
  } catch (e) {
    toast('打开作品失败：' + e.message);
  }
}

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
    showView(n);
  });
});
$('newSessionBtn').addEventListener('click', () => showView('home'));

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
    setDraftMode('preview');
  } catch (e) { toast(e.message); }
});
$('draftExportMd').addEventListener('click', () => downloadExport(sessionId, 'md'));
$('draftExportDocx').addEventListener('click', () => downloadExport(sessionId, 'docx'));
$('draftExportPptx').addEventListener('click', () => downloadExport(sessionId, 'pptx'));

$('personaRefresh').addEventListener('click', renderPersona);
$('knowledgeRefresh').addEventListener('click', renderKnowledge);
$('worksRefresh').addEventListener('click', renderWorks);

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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('workModal').hidden = true;
});

/* ── 初始化 ───────────────────────────────────────── */
refreshRecent();
