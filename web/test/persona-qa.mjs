// 十种用户说法 QA：每个 persona 是"按问题动态作答的模拟用户"（语气/素材池/行为钩子），
// 全链路跑到交付，断言体验指标并输出矩阵。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylotrace-persona-'));
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

// ── 模拟用户：按问题动态作答 ───────────────────────────
function makeUser(profile) {
  const p = {
    materials: [...(profile.materials || [])],
    arguments: [...(profile.arguments || [])],
    qCount: 0,
    targetAsked: 0,
    negatedTheme: false,
    willCount: 0,
    ...profile,
  };
  return {
    answer(q) {
      p.qCount += 1;
      // 行为钩子：不耐烦派在核心字段齐后连续两次"你决定"
      if (p.persona === 'impatient' && p.qCount > 7 && p.willCount < 2) {
        p.willCount += 1;
        return '你决定';
      }
      if (p.persona === 'minimal' && p.qCount > 7 && p.willCount < 2) {
        p.willCount += 1;
        return '你决定';
      }
      // 学术派兜底逃生：素材凑不齐时连续两次"你决定"放行进大纲（写作时补全）。
      if (p.persona === 'academic' && p.qCount > 15 && p.willCount < 2) {
        p.willCount += 1;
        return '你决定';
      }
      // 否定派：立意问题给出否定式回答（接住 L4 修正信号）
      if (p.persona === 'negator' && /立意|中心|核心/.test(q) && !p.negatedTheme) {
        p.negatedTheme = true;
        return '不不不，不是温柔，是那种硬邦邦的固执里有一点软';
      }
      // 确认/打磨题优先：问题文本里嵌着大纲正文（含 结尾/要点/素材 等字样），
      // 必须先按"确认/打磨"判定，否则会被维度关键词带偏。
      if (/打磨|大纲重新呈现/.test(q)) return '不用改了，开始写作';
      if (/大纲|开始写作/.test(q)) return '可以，就是这样';
      if (/字数|多长|篇幅/.test(q)) {
        p.targetAsked += 1;
        if (p.persona === 'emotional' && p.targetAsked === 1) return '没有具体字数，写多少算多少';
        return p.target;
      }
      if (/主题|写什么|想写/.test(q)) return p.topic || p.defaultAnswer || '就按这个方向写吧';
      if (/相信|立场|目的|希望读者/.test(q)) return p.stance || p.defaultAnswer || '就按这个方向写吧';
      if (/读者|给谁|听众/.test(q)) return p.audience || p.defaultAnswer || '就按这个方向写吧';
      if (/素材|经历|画面|数据|细节|引文/.test(q)) return p.materials.shift() || p.fallbackMaterial || '还有一个具体的小场景，先不细说。';
      if (/立意|中心|核心/.test(q)) return p.theme || p.defaultAnswer || '就按这个方向写吧';
      if (/论点|支撑|论证|观点/.test(q)) return p.arguments.shift() || p.fallbackArgument || '再补一个支撑论点：具体细节比抽象结论更可信。';
      if (/情绪|情感|曲线/.test(q)) return p.emotion || '情绪上先平静后有点起伏';
      if (/结尾|收尾|姿态/.test(q)) return p.ending || '收束得干脆一点';
      if (/风格|旧稿|写过/.test(q)) return p.style;
      if (/要点/.test(q)) return p.gapAnswer || '第一层写眼前的物，第二层写心里的滋味';
      if (/打磨/.test(q)) return '不用改了，开始写作';
      if (/事项|要点|条款/.test(q)) return p.items || '按分条列项组织要点';
      if (/主送|对象|当事人/.test(q)) return p.recipient || '全体师生';
      if (/依据|缘由/.test(q)) return p.basis || '依据上级有关要求';
      return p.defaultAnswer || '就按这个方向写吧';
    },
  };
}

const PROFILES = [
  {
    name: 'P1 详细派·散文',
    persona: 'detailed',
    start: '写一篇关于北大红楼的散文，百年历久',
    topic: '百年历久的北大红楼',
    target: '大约一千字', stance: '让读者感到历史可以走进去', audience: '老师和同学',
    materials: ['我在门口站了很久，想象百年前的脚步声', '二楼有扇窗，窗台积灰', '纪念牌上写着百年征程'],
    theme: '历史不是展品，而是可以站进去的现场',
    arguments: ['现场感来自具体的人，而非抽象的时间', '每一个细节都是过去的证词'],
    emotion: '先好奇，再触动，最后安宁', ending: '停在心安则上',
    style: '史铁生在文中将地坛视为宿命的等待，于荒芜与辉煌的落日中体悟个体生命的流逝。',
    firstQHint: '多长',
  },
  {
    name: 'P2 极简派·夏天', persona: 'minimal',
    start: '夏天', topic: '夏天的风', target: '五六百字',
    stance: '就是那种风一吹人就松了的感觉', audience: '自己',
    materials: ['操场边的风，吹起旧练习册的纸页', '风里有汗味和青草味'],
    theme: '夏天的风是青春散场的味道', arguments: [],
    emotion: '平静里有一点怅然', ending: '留白',
    style: '没有旧稿，先写吧',
    firstQHint: '主题',
  },
  {
    name: 'P3 不耐烦派·敷衍配合', persona: 'impatient',
    start: '随便写篇散文吧', topic: '傍晚的风', target: '八百字',
    stance: '让读者觉得凉快', audience: '同学',
    materials: ['傍晚的风', '树影', '风一停人就安静下来'],
    theme: '风一停，人就忽然安静下来', arguments: [],
    emotion: '凉快又有点空', ending: '自然收住',
    style: '没有，赶紧写吧',
    firstQHint: '主题',
  },
  {
    name: 'P4 健谈跑题派·高中', persona: 'talkative',
    start: '写一篇散文，关于我的高中', topic: '我的高中', target: '一千字以内',
    stance: '把那种日子过去了就再也回不去的感觉留下来', audience: '自己和以后的同学',
    materials: [
      '其实我不太会写，就是想把那种感觉留下来。我们班在三楼，走廊尽头那扇窗能看见操场，下午第三节体育课的光会斜斜地打在窗台上。',
      '高一那年冬天，窗台上积了雪，我偷偷在雪上写字。',
      '对了，我们班主任特别有意思，他总说"你们现在觉得漫长，以后会觉得一眨眼"。这个能写进去吗。',
    ],
    theme: '那种日子过去了就再也回不去', arguments: [],
    emotion: '先具体，再怅然', ending: '回望收束',
    style: '没有旧稿',
    firstQHint: '多长',
  },
  {
    name: 'P5 命令式·公文通知', persona: 'official',
    start: '写一份关于暑期安全工作的通知', topic: '暑期安全工作的通知', target: '六百字',
    stance: '让师生都重视安全', audience: '全体师生',
    materials: ['暑假临近，溺水与诈骗风险上升'],
    theme: '', arguments: [], emotion: '', ending: '',
    style: '参照往年的通知',
    recipient: '全体师生', basis: '依据上级关于加强暑期安全工作的通知要求',
    items: '防溺水、防诈骗、值班安排、开学前自查',
    firstQHint: '多长',
  },
  {
    name: 'P6 学术派·论文', persona: 'academic',
    start: '写一篇关于生成式人工智能对高中生写作影响的学术论文', topic: '生成式人工智能对高中生写作的影响',
    target: '两千字左右', stance: '论证AI辅助写作对个性化表达的利弊', audience: '高中生、老师、评委',
    materials: [
      '某调研显示70%高中生用过AI写作工具',
      '作文平均分提升但同质化严重',
      '教育部关于加强中小学人工智能教育的政策文件',
      '我校高二语文备课组的教学案例',
      '一次同题写作的对比数据',
      '学生对AI修改建议的真实反馈',
    ],
    theme: 'AI是助手不是代笔，关键在风格意识',
    arguments: ['AI降低写作门槛但挤占个性化空间', '风格向量与个人语料可缓解同质化'],
    emotion: '先客观，再给出立场', ending: '平衡引导',
    style: '没有旧稿，按学术规范写',
    firstQHint: '多长',
  },
  {
    name: 'P7 否定派·爷爷', persona: 'negator',
    start: '写一篇关于爷爷的散文', topic: '爷爷', target: '一千字',
    stance: '让读者感到那种沉默的固执里有一点软', audience: '自己',
    materials: ['爷爷修了一辈子自行车，工具箱很旧', '他从不说话，但会把修好的车擦得锃亮'],
    theme: '硬邦邦的固执里有一点软', arguments: [],
    emotion: '克制', ending: '落在工具箱上',
    style: '没有旧稿',
    firstQHint: '多长',
  },
  {
    name: 'P8 口语化派·夏天朋友圈', persona: 'casual',
    start: '整一篇夏天的散文，主打凉快又有味道', topic: '夏天的散文，凉快又有味道',
    target: '六百字吧', stance: '就是那种风一吹人就松了的感觉', audience: '发朋友圈那种',
    materials: ['傍晚操场边的风', '树上知了叫得人发困', '风里有汗味和青草味'],
    theme: '夏天过去了人就空了那么一下', arguments: [],
    emotion: '松一下再空一下', ending: '留个余味',
    style: '没有，就按我说话这味儿写',
    firstQHint: '多长',
  },
  {
    name: 'P9 双语术语派·产品发布', persona: 'bilingual',
    start: '写一份产品发布会的发言稿，强调UX和deliverable', topic: '产品发布会发言稿',
    target: '八百字', stance: '让听众相信我们交付的不只是功能，是体验', audience: '开发者、产品经理、投资人',
    materials: ['我们重构了onboarding，把转化率提升了30%', '新增了dashboard和API'],
    theme: '好的产品是让人感觉不到设计的存在', arguments: [],
    emotion: '专业但热忱', ending: '发布倒计时收束',
    style: '没有旧稿',
    firstQHint: '多长',
  },
  {
    name: 'P10 情感倾诉派·外婆', persona: 'emotional',
    start: '我想写一篇纪念我外婆的散文', topic: '纪念外婆', target: '八百字吧',
    stance: '让读到的人想起自己家那个老人', audience: '自己和家人',
    materials: ['她的小院，栀子花，还有那把蒲扇', '她总是把西瓜最中间那块留给我', '外婆走了以后，院子里的栀子花再没人管'],
    theme: '人走了，花还开着', arguments: [],
    emotion: '平静里蓄着泪', ending: '回到栀子花',
    style: '没有旧稿',
    firstQHint: '多长',
  },
];

async function runPersona(profile) {
  const user = makeUser(profile);
  const start = j(await call('/api/start', 'POST', { topic: profile.start }));
  const sid = start.sessionId;
  const questions = [];
  let kind = start.kind;
  const firstQ = String(start.question || '');
  let guard = 0;
  while (kind !== 'deliver' && guard < 45) {
    const q = kind === 'ask' ? String(start.question || '') : '';
    const nextQ = q || (guard === 0 ? firstQ : '');
    let msg = '';
    if (guard === 0 && kind === 'ask') {
      // 首轮已由 /api/start 拿到问题，直接答
      msg = user.answer(firstQ);
    } else if (kind === 'ask') {
      msg = user.answer(nextQ);
    } else if (kind === 'confirm_outline') {
      msg = '可以';
    }
    const r = j(await call('/api/step', 'POST', { sessionId: sid, message: msg }));
    kind = r.kind;
    if (r.question) questions.push(r.question);
    if (kind === 'ask') start.question = r.question;
    guard += 1;
  }
  const ctx = j(await call(`/api/context?sessionId=${sid}`));
  const draft = j(await call(`/api/draft?sessionId=${sid}`));
  const st = j(await call(`/api/style?sessionId=${sid}`));
  const tr = j(await call(`/api/transcript?sessionId=${sid}`));
  const wd = Object.values(st.write?.dimensions || {}).filter((d) => (d.confidence || 0) > 0).length;
  const rd = Object.values(st.read?.structure || {}).filter((d) => (d.confidence || 0) > 0).length;
  const res = {
    name: profile.name,
    questions: questions.length,
    firstQ,
    kind,
    sections: ctx.outline?.sections?.length || 0,
    chars: (draft.text || '').replace(/\s/g, '').length,
    wd, rd,
    entries: tr.entries?.length || 0,
    genre: ctx.confirmed?.genre || '',
    arguments: (ctx.confirmed?.arguments || []).length,
    qMarksMax: Math.max(0, ...questions.map((q) => (q.match(/[？?]/g) || []).length)),
    materials: (ctx.materials || []).length,
  };
  check(`[${profile.name}] 完整交付`, res.kind === 'deliver', `kind=${res.kind}`);
  check(`[${profile.name}] 问题数合理（4–26）`, res.questions >= 4 && res.questions <= 26, `${res.questions} 问`);
  check(`[${profile.name}] 大纲 ≥3 节`, res.sections >= 3, `${res.sections} 节`);
  check(`[${profile.name}] 成稿非空（≥150 字）`, res.chars >= 150, `${res.chars} 字`);
  check(`[${profile.name}] 风格已采集（write≥1）`, res.wd >= 1, `write ${res.wd} 维`);
  check(`[${profile.name}] 对话记录完整（≥10 条）`, res.entries >= 10, `${res.entries} 条`);
  check(`[${profile.name}] 全程一次一问`, res.qMarksMax <= 1, `最多 ${res.qMarksMax} 个问号`);
  if (profile.firstQHint) {
    check(`[${profile.name}] 首问符合预期（${profile.firstQHint}）`, new RegExp(profile.firstQHint).test(res.firstQ), firstQ.slice(0, 24));
  }
  return res;
}

const rows = [];
for (const p of PROFILES) rows.push(await runPersona(p));

console.log('\n=== 十种用户说法矩阵 ===');
console.log('用户类型 | 问数 | 首问 | 大纲 | 字数 | write/read | 记录 | 文体 | 论点 | 素材');
for (const r of rows) {
  console.log(
    `${r.name} | ${r.questions} | ${r.firstQ.slice(0, 10)} | ${r.sections}节 | ${r.chars} | ${r.wd}/${r.rd} | ${r.entries} | ${r.genre || '-'} | ${r.arguments} | ${r.materials}`,
  );
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✓ 十种用户说法 QA 全部通过' : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
