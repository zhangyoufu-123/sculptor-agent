// Sculptor Studio 前端：驱动 REST API，聊天式展示完整写作流程。
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusbar = document.getElementById('statusbar');
const phaseTrack = document.getElementById('phaseTrack');

let sessionId = null;
let busy = false;

function setPhase(p) {
  for (const el of phaseTrack.querySelectorAll('.pt-item')) {
    const k = el.dataset.p;
    el.classList.toggle('active', k === p);
    el.classList.toggle('done', ['clarify', 'outline', 'write', 'review', 'deliver'].indexOf(k) >= 0 && ['clarify', 'outline', 'write', 'review', 'deliver'].indexOf(p) > ['clarify', 'outline', 'write', 'review', 'deliver'].indexOf(k));
  }
}

function addMsg(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble">${html}</div>`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
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
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

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

function renderAsk(r) {
  let html = esc(r.question || '');
  if (r.knowledgeSuggestion) html += `<div class="hint">${esc(r.knowledgeSuggestion)}</div>`;
  if (r.dataSuggestion) html += `<div class="hint">${esc(r.dataSuggestion)}</div>`;
  if (r.recommendation) html += `<div class="rec">我的建议：${esc(r.recommendation)}</div>`;
  if (r.options && r.options.length) {
    html += `<div class="options">${r.options.map((o, i) => `<button class="opt" data-opt="${esc(o)}">${'ABC'[i]}. ${esc(o)}</button>`).join('')}</div>`;
  }
  const msgEl = addMsg('bot', html);
  msgEl.querySelectorAll('.opt').forEach((b) => {
    b.addEventListener('click', () => { input.value = b.dataset.opt; send(); });
  });
}

function renderOutline(r) {
  if (!r.outline) return;
  const secs = (r.outline.sections || []).map((s, i) =>
    `<div class="sec"><span class="fn">${i + 1}. ${esc(s.function || '')}</span><span>${esc(s.heading)}${s.thesis ? ' — ' + esc(s.thesis) : ''}</span></div>`,
  ).join('');
  addMsg('bot', `<div class="outline-card"><h4>《${esc(r.outline.title || '未命名')}》· 大纲</h4>${secs}<div class="meta-line">请确认或提出修改，Sculptor 会按你的意见调整。</div></div>`);
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  if (!sessionId) {
    addMsg('user', esc(text));
    busy = true; sendBtn.disabled = true;
    const w = addWorking('正在理解你的想法，开始澄清…');
    try {
      const r = await api('/api/start', { topic: text });
      sessionId = r.sessionId;
      setPhase('clarify');
      w.remove();
      if (r.kind === 'ask') renderAsk(r);
      else if (r.kind === 'working') { addMsg('bot', esc(r.message || '')); }
    } catch (e) {
      w.remove();
      addMsg('bot', `<span style="color:#a33">${esc(e.message)}</span>`);
    }
    busy = false; sendBtn.disabled = false;
    input.value = '';
    return;
  }
  addMsg('user', esc(text));
  busy = true; sendBtn.disabled = true;
  const w = addWorking('Sculptor 正在思考…');
  try {
    const r = await api('/api/step', { sessionId, message: text });
    w.remove();
    if (r.kind === 'ask') {
      setPhase('clarify');
      renderAsk(r);
    } else if (r.kind === 'confirm_outline') {
      setPhase('outline');
      addMsg('bot', esc(r.message || ''));
      renderOutline(r);
    } else if (r.kind === 'working') {
      const p = r.phase || '';
      if (['write', 'revise', 'redteam', 'quality'].includes(p)) setPhase('write');
      if (p === 'rewrite') setPhase('write');
      if (p === 'deliver') setPhase('deliver');
      addMsg('bot', esc(r.message || ''));
      if (r.progress) statusbar.textContent = `写作进度 ${r.progress.done}/${r.progress.total} 节`;
    } else if (r.kind === 'deliver') {
      setPhase('deliver');
      addMsg('bot', esc(r.message || ''));
      const d = await fetch(`/api/draft?sessionId=${sessionId}`);
      const dd = await d.json();
      if (dd.text) addMsg('bot', `<div class="draft">${mdToHtml(dd.text)}</div><div class="meta-line">成稿已自动归档进个人写作库并沉淀文章圣经。</div>`);
    } else {
      addMsg('bot', esc(r.message || '（完成）'));
    }
  } catch (e) {
    w.remove();
    addMsg('bot', `<span style="color:#a33">${esc(e.message)}</span>`);
  }
  busy = false; sendBtn.disabled = false;
  input.value = '';
}

function mdToHtml(md) {
  return esc(md)
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/\n/g, '<br>');
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', () => {
  sendBtn.disabled = busy || !input.value.trim();
  statusbar.textContent = sessionId ? '正在写作流程中 · 一次一个问题，答完自动推进' : '输入一个念头开始 · 演示模式：单会话';
});
