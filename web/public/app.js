/* Sculptor Studio · 视图路由与写作流程
   设计标准：所有视图切换统一走 showView()（同一条 viewIn 动画），
   阶段（stage）与视图（view）一一映射，保证"页面切换有标准"。 */
const $ = (id) => document.getElementById(id);

const VIEWS = ['home', 'session', 'outline', 'draft', 'report'];
const STAGES = ['home', 'clarify', 'outline', 'write', 'audit', 'deliver'];

let sessionId = null;
let busy = false;
let currentView = 'home';
let currentStage = 'home';

/* ── 视图切换（统一标准） ─────────────────────────────── */
function showView(name) {
  if (!VIEWS.includes(name)) name = 'home';
  VIEWS.forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('is-active', v === name);
  });
  document.body.dataset.view = name;
  currentView = name;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── 阶段条（统一标准） ───────────────────────────────── */
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

/* ── 聊天渲染 ─────────────────────────────────────────── */
function addMsg(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${html}</div>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

function addWorking(label) {
  const div = document.createElement('div');
  div.className = 'msg bot';
  div.innerHTML = `<div class="working"><span class="spinner"></span>${esc(label)}</div>`;
  $('chat').appendChild(div);
  $('chat').scrollTop = $('chat').scrollHeight;
  return div;
}

/* ── API ──────────────────────────────────────────────── */
async function api(pathname, payload) {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}

/* ── 渲染各阶段 ───────────────────────────────────────── */
function renderAsk(r) {
  let html = esc(r.question || '');
  if (r.knowledgeSuggestion) html += `<div class="hint">${esc(r.knowledgeSuggestion)}</div>`;
  if (r.dataSuggestion) html += `<div class="hint">${esc(r.dataSuggestion)}</div>`;
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
  const o = r.outline;
  if (!o) return;
  $('outlineTitle').textContent = `《${o.title || '未命名'}》`;
  $('outlineBody').innerHTML = (o.sections || []).map((s, i) => `
    <div class="sec">
      <span class="no">${['一','二','三','四','五','六','七','八'][i] || i + 1}</span>
      <span class="fn">${esc(s.function || '')}</span>
      <span class="txt">${esc(s.heading)}${s.thesis ? `<br><span style="color:var(--ink-2);font-size:13px">${esc(s.thesis)}</span>` : ''}</span>
    </div>`).join('');
  showView('outline');
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

function renderDraft(text) {
  const titleMatch = text.match(/^# (.+)$/m);
  $('draftTitle').textContent = titleMatch ? titleMatch[1] : '成稿';
  $('draftPaper').innerHTML = mdToHtml(text);
  showView('draft');
  setStage('deliver');
}

async function renderReport() {
  showView('report');
  setStage('audit');
  const body = $('reportBody');
  body.innerHTML = '<div class="working"><span class="spinner"></span>生成审计报告…</div>';
  try {
    const r = await fetch(`/api/report?sessionId=${sessionId}`);
    const data = await r.json();
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

/* ── 主流程 ───────────────────────────────────────────── */
async function send() {
  const text = $('input').value.trim() || $('seedInput').value.trim();
  if (!text || busy) return;
  if (!sessionId) {
    addMsg('user', esc(text));
    busy = true; $('send').disabled = true; $('seedSend').disabled = true;
    const w = addWorking('正在理解你的想法…');
    try {
      const r = await api('/api/start', { topic: text });
      sessionId = r.sessionId;
      $('sessionTitle').textContent = '写作';
      showView('session'); setStage('clarify');
      w.remove();
      if (r.kind === 'ask') renderAsk(r);
      else if (r.kind === 'working') addMsg('bot', esc(r.message || ''));
    } catch (e) {
      w.remove(); addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
    }
    busy = false; $('send').disabled = false; $('seedSend').disabled = false;
    $('input').value = ''; $('seedInput').value = '';
    return;
  }
  addMsg('user', esc(text));
  busy = true; $('send').disabled = true;
  const w = addWorking('Sculptor 正在思考…');
  try {
    const r = await api('/api/step', { sessionId, message: text });
    w.remove();
    if (r.kind === 'ask') {
      setStage('clarify'); renderAsk(r);
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
      const d = await fetch(`/api/draft?sessionId=${sessionId}`);
      const dd = await d.json();
      if (dd.text) renderDraft(dd.text);
    } else {
      addMsg('bot', esc(r.message || '（完成）'));
    }
  } catch (e) {
    w.remove(); addMsg('bot', `<span style="color:var(--bad)">${esc(e.message)}</span>`);
  }
  busy = false; $('send').disabled = false;
  $('input').value = '';
}

/* ── 事件绑定 ─────────────────────────────────────────── */
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
$('outlineConfirm').addEventListener('click', () => {
  $('input').value = '可以，就是这样';
  showView('session'); setStage('write');
  send();
});
$('outlineEdit').addEventListener('click', () => {
  showView('session');
  $('input').placeholder = '说出要改哪里，它会调整大纲…';
  $('input').focus();
});
$('draftAudit').addEventListener('click', renderReport);
$('reportBack').addEventListener('click', () => showView('draft'));
$('draftBack').addEventListener('click', () => { showView('session'); setStage('write'); });
document.querySelectorAll('.stage-item').forEach((b) => {
  b.addEventListener('click', () => {
    const s = b.dataset.stage;
    if (s === 'home') { showView('home'); setStage('home'); return; }
    if (!sessionId) return;
    const map = { clarify: 'session', outline: 'outline', write: 'session', audit: 'report', deliver: 'draft' };
    setStage(s);
    if (s === 'audit') renderReport();
    else showView(map[s] || 'session');
  });
});
