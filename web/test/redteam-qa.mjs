// 红队 QA：多文体 + 对抗输入，全走真实 Web HTTP 处理器（mock LLM）。
// 目标：任何输入都不 500、不死循环、能走到交付或给出合理兜底。
import http from 'node:http';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-redteam-'));
process.env.STYLOTRACE_MOCK_LLM = '1';
process.env.STYLOTRACE_WEB_DATA = TMP;

let handler = null;
http.createServer = (h) => { handler = h; return { listen() {} }; };
await import(pathToFileURL(path.join(REPO, 'web', 'server.mjs')).href);

function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res._headers = {};
  res.writeHead = (c, h) => { res.statusCode = c; res._headers = h || {}; };
  res._body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}
function call(urlStr, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method; req.url = urlStr; req.headers = { host: 'localhost' };
    const res = fakeRes();
    const timer = setTimeout(() => reject(new Error(`timeout ${method} ${urlStr}`)), 90000);
    res.on('finish', () => { clearTimeout(timer); resolve(res); });
    res.on('error', (e) => { clearTimeout(timer); reject(e); });
    handler(req, res);
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  });
}
const j = (r) => JSON.parse(r._body());

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
};

function makeUser(p) {
  const u = {
    materials: [...(p.materials || [])],
    arguments: [...(p.arguments || [])],
    academic: [...(p.academic || [])],
    qCount: 0,
    negCount: 0,
    willCount: 0,
  };
  return {
    answer(q) {
      u.qCount += 1;
      if (p.behavior === 'negator' && /立意|中心|核心/.test(q) && u.negCount < 5) {
        u.negCount += 1;
        return '不不不，不是这样，我要的是更硬一点的感觉';
      }
      if (p.behavior === 'impatient' && u.qCount > 6 && u.willCount < 2) {
        u.willCount += 1;
        return '你决定';
      }
      if (p.behavior === 'jump' && u.qCount === 1) return '直接写吧';
      if (/已经记过/.test(q)) return '你决定';
      if (/打磨|大纲重新呈现/.test(q)) return '不用改了，开始写作';
      if (/大纲|开始写作/.test(q)) return '可以，就是这样';
      if (/字数|多长|篇幅/.test(q)) return p.target || '八百字';
      if (/主题|写什么|想写/.test(q)) return p.topic || '关于日常的观察';
      if (/相信|立场|目的|希望读者/.test(q)) return p.stance || '让读者有共鸣';
      if (/读者|给谁|听众/.test(q)) return p.audience || '普通读者';
      if (/素材|经历|画面|数据|细节|引文/.test(q)) {
        if (u.materials.length) return u.materials.shift();
        u.extra = (u.extra || 0) + 1;
        return `第 ${u.extra} 个具体场景：傍晚的操场边，风把落叶卷成一团，路灯刚亮。`;
      }
      if (/论点|支撑|论证|观点/.test(q)) {
        if (u.arguments.length) return u.arguments.shift();
        u.argExtra = (u.argExtra || 0) + 1;
        return `第 ${u.argExtra} 个支撑论点：具体细节比抽象结论更可信。`;
      }
      if (/立意|中心|核心/.test(q)) return p.theme || '日常里藏着值得写下来的瞬间';
      if (/情绪|情感|曲线/.test(q)) return p.emotion || '平静里有一点起伏';
      if (/结尾|收尾|姿态/.test(q)) return p.ending || '收束得干脆一点';
      if (/风格|旧稿|写过/.test(q)) return p.style || '没有旧稿，先写吧';
      if (/事项|要点|条款/.test(q)) return p.items || '按要点组织';
      if (/要点/.test(q)) return '第一层写眼前的物，第二层写心里的滋味';
      if (/还差「/.test(q)) return u.academic.shift() || '跳过';
      if (/主送|对象|当事人/.test(q)) return p.recipient || '全体师生';
      if (/依据|缘由/.test(q)) return p.basis || '依据上级有关要求';
      if (/情节|伏笔|反转/.test(q)) return p.plot || '先铺垫，再转折，最后回收';
      if (/角色|人物|主角/.test(q)) return p.character || '主角：想要什么、怕什么';
      return p.defaultAnswer || '就按这个方向写吧';
    },
  };
}

async function runSession(name, startTopic, profile = {}, { expectDeliver = true, expectGenre = '' } = {}) {
  const user = makeUser({ ...profile, name });
  const start = j(await call('/api/start', 'POST', { topic: startTopic }));
  const sid = start.sessionId;
  let kind = start.kind;
  let curQ = String(start.question || '');
  let questions = 0;
  let httpErrors = 0;
  let guard = 0;
  while (kind !== 'deliver' && guard < 50) {
    let msg = '';
    if (kind === 'ask') msg = user.answer(curQ);
    else if (kind === 'confirm_outline') msg = '可以';
    const r = await call('/api/step', 'POST', { sessionId: sid, message: msg });
    if (r.statusCode !== 200) httpErrors += 1;
    const body = JSON.parse(r._body());
    kind = body.kind;
    if (body.question) {
      questions += 1;
      curQ = body.question;
    }
    guard += 1;
  }
  const ctx = j(await call(`/api/context?sessionId=${sid}`));
  const draft = j(await call(`/api/draft?sessionId=${sid}`));
  const tr = j(await call(`/api/transcript?sessionId=${sid}`));
  const res = {
    name, kind, questions, httpErrors,
    sections: ctx.outline?.sections?.length || 0,
    chars: (draft.text || '').replace(/\s/g, '').length,
    entries: tr.entries?.length || 0,
    genre: ctx.confirmed?.genre || '',
    arguments: (ctx.confirmed?.arguments || []).length,
    materials: (ctx.materials || []).length,
  };
  check(`[${name}] 全程无 HTTP 500`, res.httpErrors === 0, `${res.httpErrors} 个错误`);
  check(`[${name}] 不死循环（≤50 步收束）`, guard < 50, `步数=${guard}`);
  check(`[${name}] 全程一次一问`, questions <= 40, `${questions} 问`);
  if (expectDeliver) {
    check(`[${name}] 完整交付`, res.kind === 'deliver', `kind=${res.kind}`);
    check(`[${name}] 成稿非空（≥150 字）`, res.chars >= 150, `${res.chars} 字`);
    check(`[${name}] 对话记录完整（≥10 条）`, res.entries >= 10, `${res.entries} 条`);
  }
  if (expectGenre) {
    check(`[${name}] 文体识别=${expectGenre}`, res.genre.includes(expectGenre), res.genre);
  }
  return res;
}

const rows = [];
console.log('═══ 多文体全流程 ═══');
rows.push(await runSession('论文·学术', '写一篇关于生成式人工智能对高中生写作影响的学术论文', {
  target: '两千字左右', stance: '论证AI辅助写作对个性化表达的利弊', audience: '高中生、老师、评委',
  materials: ['某调研显示70%高中生用过AI写作工具', '作文平均分提升但同质化严重', '教育部相关政策文件', '我校高二备课组教学案例', '同题写作对比数据', '学生真实反馈'],
  theme: 'AI是助手不是代笔，关键在风格意识',
  arguments: ['AI降低写作门槛但挤占个性化空间', '风格向量与个人语料可缓解同质化'],
  emotion: '先客观，再给出立场', ending: '平衡引导',
  academic: ['已有研究多聚焦作弊风险', '缺少风格层面的实证', '对比实验加文本指标', '样本量小'],
}, { expectGenre: '学术论文' }));
rows.push(await runSession('公文·通知', '写一份关于暑期安全工作的通知', {
  target: '六百字', stance: '让师生都重视安全', audience: '全体师生',
  materials: ['暑假临近，溺水与诈骗风险上升'],
  recipient: '全体师生', basis: '依据上级关于加强暑期安全工作的通知要求',
  items: '防溺水、防诈骗、值班安排、开学前自查',
}, { expectGenre: '通知' }));
rows.push(await runSession('合同·软件采购', '起草一份软件采购合同', {
  target: '一千五百字', recipient: '甲方：××科技有限公司，乙方：××软件公司',
  items: '标的与价款、交付与验收、付款方式、违约责任、争议解决',
}, { expectGenre: '合同' }));
rows.push(await runSession('新闻稿·科技节', '写一篇关于学校科技节的新闻稿', {
  target: '八百字', stance: '展示学生创新成果，激发科学热情', audience: '校内外师生家长',
  materials: ['科技节于本周三开幕', '全校32个班级参赛', '学生作品包括机器人、编程与科学实验'],
  ending: '回扣展望',
}, { expectGenre: '新闻稿' }));
rows.push(await runSession('发言稿·国旗下讲话', '写一份国旗下讲话的发言稿', {
  target: '八百字', stance: '让同学们珍惜时间，脚踏实地', audience: '全校师生',
  materials: ['期中考试刚结束', '一位学长每天早到十分钟的故事'],
  ending: '落到具体行动',
}, { expectGenre: '演讲稿' }));
rows.push(await runSession('小说·寻找声音的男孩', '写一篇短篇小说，关于一个寻找声音的男孩', {
  target: '三千字', stance: '失去与找回，都是成长', audience: '喜欢故事的年轻读者',
  materials: ['男孩住在一个安静到没有回声的小镇', '老琴师有一把缺了弦的琴'],
  plot: '三幕：离家→遇见老琴师→把声音还给村庄', character: '男孩：想找回声音，怕被当成怪人',
}, { expectGenre: '小说' }));
rows.push(await runSession('议论文·读书之用', '写一篇关于读书之用的议论文', {
  target: '一千二百字', stance: '读书是把自己活得更开阔的方式', audience: '老师与同学',
  materials: ['一本旧书被翻烂的边角', '朋友因为读书改变选择的故事'],
  theme: '读书之用，在于让人拥有选择的自由',
  arguments: ['读书提供参照系', '读书训练判断力'],
}, { expectGenre: '议论文' }));
rows.push(await runSession('视频脚本·美食探店', '写一个美食探店视频脚本', {
  target: '一千字', stance: '让观众隔着屏幕也想吃', audience: '短视频平台用户',
  materials: ['巷子深处的老面馆', '老板凌晨四点开始熬汤'],
  emotion: '先馋，再暖', ending: '结尾钩子：明早六点去排队',
}, { expectGenre: '视频脚本' }));

console.log('\n═══ 对抗输入 ═══');
rows.push(await runSession('对抗·超长输入', '写一篇散文', {
  target: '八百字', behavior: 'none',
  materials: ['这是一段很长的素材。' + '（重复细节）' .repeat(600)],
}));
rows.push(await runSession('对抗·乱码/emoji', '🦋 写一篇关于#夏天的散文 🍉', {
  target: '六百字', stance: '就是那种风一吹人就松了的感觉', audience: '自己',
  materials: ['傍晚的风', '🍉 西瓜最中间那块'],
  theme: '夏天过去了人就空了那么一下',
}));
rows.push(await runSession('对抗·疯狂否定', '写一篇关于爷爷的散文', {
  target: '一千字', behavior: 'negator',
  materials: ['爷爷修了一辈子自行车', '他把修好的车擦得锃亮'],
}));
rows.push(await runSession('对抗·数字滥用', '写一篇议论文', {
  target: '9999999字', behavior: 'impatient',
  stance: '多写点', audience: '老师',
  materials: ['一条素材'],
}));
rows.push(await runSession('对抗·跳跃回答', '写一篇关于夏天的散文', {
  target: '六百字', behavior: 'jump',
  materials: ['傍晚的风'],
}));
rows.push(await runSession('对抗·极短输入', '写', {
  target: '五百字', stance: '随便', audience: '自己', materials: ['一点风'],
}));

// 空输入：不应崩溃，应持续给问题（无答案无法交付，属预期）
{
  const start = j(await call('/api/start', 'POST', { topic: '写一篇散文' }));
  const sid = start.sessionId;
  let kind = start.kind;
  let ok = true;
  let gotQuestion = Boolean(start.question);
  for (let i = 0; i < 8 && kind !== 'deliver'; i++) {
    const r = await call('/api/step', 'POST', { sessionId: sid, message: '' });
    if (r.statusCode !== 200) ok = false;
    const body = JSON.parse(r._body());
    kind = body.kind;
    if (body.question) gotQuestion = true;
  }
  check('[对抗·空输入] 不崩溃且持续给出问题', ok && gotQuestion && kind === 'ask', `kind=${kind}`);
}

console.log('\n=== 红队矩阵 ===');
console.log('场景 | 步数 | 问数 | 文体 | 大纲 | 字数 | 论点 | 素材 | 记录');
for (const r of rows) {
  console.log(`${r.name} | ${r.kind} | ${r.questions} | ${r.genre || '-'} | ${r.sections}节 | ${r.chars} | ${r.arguments} | ${r.materials} | ${r.entries}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✓ 红队 QA 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
