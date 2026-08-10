// 文体库：公文/合同等公式化内容的"结构骨架 + 行文规范"。
// 写作时按文体注入大纲与写作提示词，让公式化内容不靠模型临场发挥，而是按既定范式产出。
// 个人写作库（library.js）在此基础上叠加"这类文体你个人的写法"，两者互补。
import { contentBudget } from './budget.js';

export const GENRES = {
  公文: {
    aliases: ['公文', '红头文件', '通知', '请示', '函', '批复', '意见', '纪要', '决定', '公告'],
    skeleton: [
      '标题（发文机关+事由+文种）',
      '主送机关',
      '开头缘由（背景/依据）',
      '主体事项（分条列项）',
      '结尾要求（特此通知/妥否请批示）',
      '落款（机关+日期）',
    ],
    rules: [
      '一文一事，结构固定，语言庄重平实，少用文学修辞',
      '事项用"一、二、三"分条列项，条与条不重叠',
      '称谓规范：本机关、贵单位、你单位；结尾按文种用固定语',
      '日期用全称数字（2026年8月7日），落款单位全称',
    ],
    forbidden: ['口语化表达', '第一人称主观抒情', '网络用语', '比喻堆砌'],
  },
  请示: {
    aliases: ['请示', '申请'],
    skeleton: [
      '标题（关于××的请示）',
      '主送机关（一个，不越级多头）',
      '请示缘由（背景/依据/必要性）',
      '请示事项（具体明确、可批复）',
      '结尾（妥否，请批示）',
      '落款（机关+成文日期）',
    ],
    rules: [
      '一文一事；一事一请，不夹带其他事项',
      '主送机关只能写一个，不抄送下级',
      '缘由充分但克制，事项表述清楚到可直接批复',
      '结尾固定语：妥否，请批示',
    ],
    forbidden: ['多头主送', '夹带报告事项', '模糊数字与时限'],
  },
  批复: {
    aliases: ['批复'],
    skeleton: [
      '标题（关于××的批复）',
      '主送机关（来文单位）',
      '批复依据（你单位《××》收悉）',
      '批复意见（同意/不同意+理由，分条列项）',
      '执行要求',
      '落款（机关+成文日期）',
    ],
    rules: [
      '针对来文事项逐条表态，不答非所问',
      '不同意时必须说明理由，不简单否定',
      '结尾固定语：此复',
    ],
    forbidden: ['超出请示范围的答复', '含糊表态（"原则上同意"需附条件）'],
  },
  函: {
    aliases: ['函', '公函', '商洽函', '答复函'],
    skeleton: [
      '标题（××关于××的函）',
      '主送机关',
      '正文（缘由+事项+恳请/答复）',
      '结尾（特此函达/盼复）',
      '落款（机关+成文日期）',
    ],
    rules: [
      '语气平等协商，用"贵单位/你单位"，不居高临下',
      '事项单一、明确，需要答复的写清时限',
      '结尾固定语：特此函达；盼复',
    ],
    forbidden: ['命令式语气', '多个互不相关的事项'],
  },
  通报: {
    aliases: ['通报'],
    skeleton: [
      '标题（关于××的通报）',
      '主送机关',
      '通报缘由（背景/目的）',
      '通报事项（情况/表彰/批评，事实清楚）',
      '分析与要求（分条）',
      '落款',
    ],
    rules: ['事实叙述与评价分开，先事实后定性', '表彰/批评都有依据，点名到具体单位个人'],
    forbidden: ['无事实依据的评价', '情绪化用语'],
  },
  公告: {
    aliases: ['公告'],
    skeleton: ['标题（发文机关+事由+公告）', '正文（发布事项，分条）', '落款（机关+日期）'],
    rules: ['面向公众发布重大事项', '事项表述完整，含时间地点对象', '语言庄重简练'],
    forbidden: ['日常事务用公告（应用通告/通知）', '口语化表达'],
  },
  通告: {
    aliases: ['通告'],
    skeleton: [
      '标题（关于××的通告）',
      '通告缘由（目的/依据）',
      '通告事项（分条列项）',
      '执行要求与时限',
      '落款',
    ],
    rules: ['在一定范围内公布应遵守或周知的事项', '每条事项明确对象、时间、地点、要求'],
    forbidden: ['与公告混用', '没有执行时限'],
  },
  意见: {
    aliases: ['意见'],
    skeleton: [
      '标题（关于××的意见）',
      '主送机关',
      '总体要求/指导原则',
      '主要意见（分条）',
      '组织实施',
      '落款',
    ],
    rules: ['对重要问题提出见解和处理办法', '意见分条，条与条不重叠，导向明确'],
    forbidden: ['空泛号召', '无实施路径的原则表述'],
  },
  决定: {
    aliases: ['决定'],
    skeleton: ['标题（关于××的决定）', '决定缘由', '决定事项（分条）', '执行要求', '落款'],
    rules: ['对重要事项作出决策安排', '决定事项明确到责任与时限', '措辞庄重肯定，不留歧义'],
    forbidden: ['与通知混用（一般部署用通知）', '模糊表述'],
  },
  决议: {
    aliases: ['决议'],
    skeleton: ['标题（会议名称+关于××的决议）', '会议信息（时间地点议题）', '决议事项（分条）', '落实要求'],
    rules: ['经会议讨论通过的重大决策事项', '决议事项表述严谨，逐条明确'],
    forbidden: ['未讨论通过的事项', '个人意见'],
  },
  命令: {
    aliases: ['命令', '令'],
    skeleton: ['标题（发布机关+命令）', '主送机关', '命令事项', '执行要求', '签署（机关+日期）'],
    rules: ['公布法规、宣布重大强制性措施、任免奖惩', '语气庄重、无协商余地', '签署机关与成文日期'],
    forbidden: ['日常事项用命令', '口语化'],
  },
  公报: {
    aliases: ['公报', '新闻公报'],
    skeleton: ['标题（发布机关+事项+公报）', '发布主体/时间', '事项（分条）', '结语'],
    rules: ['公布重要决定或重大事件情况', '事实陈述准确，时间数据可查'],
    forbidden: ['推测性表述', '未核实数据'],
  },
  议案: {
    aliases: ['议案'],
    skeleton: [
      '标题（关于××的议案）',
      '主送机关（人民代表大会等）',
      '案由（提出背景与必要性）',
      '方案（分条，可操作）',
      '结语（请审议）',
      '提案人与日期',
    ],
    rules: ['由法定主体在会议期间提出', '案由充分、方案具体可审议', '一事一案'],
    forbidden: ['日常建议用议案', '无具体方案的案由'],
  },
  合同: {
    aliases: ['合同', '协议书', '协议', '契约', '条款'],
    skeleton: [
      '合同名称',
      '当事人（甲方/乙方全称+证件/统一社会信用代码）',
      '鉴于条款（缔约目的）',
      '标的与价款',
      '履行期限与方式',
      '权利义务',
      '违约责任',
      '争议解决（仲裁/诉讼）',
      '其他约定',
      '签署页（盖章+日期）',
    ],
    rules: [
      '条款用"第一条、第二条"编号，表述精确无歧义',
      '金额同时写大写与小写（人民币壹万元整 / ¥10,000）',
      '关键定义先行，责任条款明确"应当/不得"边界',
      '签署信息完整：名称、地址、联系人、账户、盖章、日期',
    ],
    forbidden: ['模糊词（尽量/大概/差不多）', '单方义务', '无违约责任条款'],
  },
  通知: {
    aliases: ['通知', '通告', '公告'],
    skeleton: [
      '标题（关于××的通知）',
      '主送对象',
      '通知缘由（目的/依据）',
      '通知事项（分条）',
      '执行要求',
      '落款日期',
    ],
    rules: ['事项清楚、时限明确、责任到人', '语言简洁直接，不用寒暄'],
    forbidden: ['客套话', '歧义时间（"尽快"需配明确时限）'],
  },
  会议纪要: {
    aliases: ['会议纪要', '纪要', '会议记录'],
    skeleton: [
      '会议名称+时间地点',
      '参会人员',
      '会议议题',
      '议定事项（分条，含责任人与时限）',
      '主持人/记录人',
    ],
    rules: ['只记"议定"不记"过程闲聊"', '每条决议：事项+责任人+完成时限'],
    forbidden: ['主观评价', '未形成结论的内容'],
  },
  报告: {
    aliases: ['报告', '汇报', '工作总结', '调研报告', '可行性报告'],
    skeleton: ['标题', '摘要/结论先行', '背景与现状', '分析与问题', '对策建议（分条）', '结语'],
    rules: ['结论先行，数据支撑', '分节有逻辑递进，不做散文式铺陈'],
    forbidden: ['空泛形容词（显著提升/极大改善）而无数据'],
  },
  议论文: {
    aliases: ['议论文', '评论', '时评', '论说文'],
    skeleton: [
      '引论（现象/问题/观点）',
      '本论（2-3个分论点，每个=论点+论据+论证）',
      '驳论或深化',
      '结论（回扣观点+价值升华）',
    ],
    rules: [
      '论点鲜明，首段亮出',
      '论据具体（事例/数据/引文），不空喊',
      '论证有推进，段落间有逻辑连接词',
    ],
    forbidden: ['口号堆砌', '观点摇摆', '以举例代替论证'],
  },
  散文: {
    aliases: ['散文', '随笔', '抒情文'],
    skeleton: [
      '起（一个具体场景/物件/瞬间）',
      '承（由此展开的联想与细节）',
      '转（情绪或认识的转折）',
      '合（余味收束，不点破）',
    ],
    rules: ['从具体物象进入，拒绝空泛抒情', '细节大于道理', '结尾留白'],
    forbidden: ['排比堆砌', '强行升华', 'AI 腔套话'],
  },
  演讲稿: {
    aliases: ['演讲稿', '发言稿', '致辞', '讲话'],
    skeleton: [
      '称呼与开场（点题/共情）',
      '主体（2-3个层次，每层有故事或数据）',
      '高潮（核心主张）',
      '结尾（呼告/期望/致谢）',
    ],
    rules: ['口语化但不失庄重', '层次用"首先/其次/最后"或场景切换推进', '每段有具体的人、事、引文'],
    forbidden: ['书面长句', '无对象感的空话'],
  },
  记叙文: {
    aliases: ['记叙文', '叙事', '回忆录'],
    skeleton: ['时间地点人物缘起', '经过（有细节、有波折）', '结果', '感触（点到即止）'],
    rules: ['一条主线贯穿，详略得当', '关键场景有画面（动作/声音/颜色）'],
    forbidden: ['流水账', '结尾强行说教'],
  },
  学术论文: {
    aliases: ['学术论文', '论文', '期刊论文', '学位论文', '毕业论文'],
    skeleton: [
      '标题（观点鲜明，不加副题修饰）',
      '摘要（目的/方法/结果/结论，150-300 字）',
      '关键词（3-5 个，分号分隔）',
      '引言（问题背景+研究缺口+本文贡献）',
      '方法/文献综述（可复现、有出处）',
      '结果与讨论（数据说话，与已有研究对话）',
      '结论（回扣问题，不引入新内容）',
      '参考文献（GB/T 7714 或 APA 规范）',
    ],
    rules: [
      '摘要四要素齐全：目的-方法-结果-结论',
      '每处论断要么有引用、要么有数据支撑',
      '语言客观克制，避免第一人称主观抒情',
      '图表编号规范：表 1、图 1，文中先见后注',
    ],
    forbidden: ['无出处的断言', '抒情化表达', '结论超出数据支持的范围'],
  },
  新闻稿: {
    aliases: ['新闻稿', '新闻通稿', '通稿', '消息', '报道'],
    skeleton: [
      '标题（主标题+可选副题，实题为主）',
      '导语（5W1H：何时/何地/何人/何事/为何，一段说完）',
      '主体（倒金字塔：最重要→次重要→背景）',
      '背景与细节（引语、数字、现场）',
      '结尾（回扣或展望，不抒情）',
    ],
    rules: [
      '导语一段内交代 5W1H，读者只看导语也能知道发生了什么',
      '事实先于评价；引语有明确出处（"××表示"）',
      '数字精确到可查证的程度',
    ],
    forbidden: ['文学化开头', '无出处的评价', '第一人称主观评论'],
  },
  邮件: {
    aliases: ['邮件', '电子邮件', '邮件正文', '商务邮件'],
    skeleton: [
      '主题行（动作+对象+期限，如"请审阅：Q3 报告（8月15日前）"）',
      '称呼（按关系：尊敬的××/××老师/各位）',
      '正文（目的先行→必要背景→具体请求/行动项）',
      '结尾（致谢+下一步约定）',
      '落款（姓名+职务+联系方式）',
    ],
    rules: ['第一段说清"为什么写这封邮件"', '行动项明确：谁、做什么、什么时候', '正文可扫读：短段+编号'],
    forbidden: ['无主题或主题含糊', '一大段无结构正文', '情绪化措辞'],
  },
  视频脚本: {
    aliases: ['视频脚本', '分镜', '口播稿', '短视频脚本', '视频文案'],
    skeleton: [
      '标题与时长（平台+目标时长）',
      '开头钩子（3 秒抓住：悬念/反差/问题）',
      '主体（3-4 个信息点，每点=画面+台词）',
      '高潮/反转',
      '结尾（CTA：关注/评论/行动）',
      '【旁白/画面/字幕】分列，便于制作',
    ],
    rules: [
      '每条镜头行以【画面】【旁白】【字幕】标记开头，可直接进剪辑',
      '口播稿按 4 字/秒估算时长，控制在目标时长内',
      '开场三秒必须有钩子',
    ],
    forbidden: ['无平台感的空话', '超过时长的注水台词', '画面与台词脱节'],
  },
  小说: {
    aliases: ['小说', '故事', '短篇小说', '欧亨利', '欧亨利式'],
    skeleton: [
      '开场（人物/场景/一个不寻常的细节）',
      '冲突建立（愿望+阻碍，埋伏笔）',
      '发展（误会/巧合/必然，细节回收）',
      '高潮/反转（意外但合理的转折，欧亨利式收束）',
      '结局（余味/回扣，不解释太满）',
    ],
    rules: [
      '反转必须"意外却合理"：伏笔在前文可见，收束时读者恍然大悟',
      '人物动机驱动情节，不用巧合硬圆',
      '细节即伏笔：前文埋的点，后文要回收',
    ],
    forbidden: ['为反转而反转（无伏笔）', '机械降神', '结局说教'],
  },
};

/** GB/T 9704-2012《党政机关公文格式》排版规范（导出 docx 时按此排版）。 */
export const GB9704 = {
  standard: 'GB/T 9704-2012 党政机关公文格式',
  page: 'A4；版心：上白边 37mm、下白边 35mm、左白边 28mm、右白边 26mm',
  fonts: {
    head: '发文机关标志：红色小标宋体（2号）',
    title: '标题：2号小标宋体，居中，回行时词意完整',
    body: '正文：3号仿宋_GB2312，首行缩进 2 字符，行距 28 磅',
    h1: '一级标题（一、）：3号黑体',
    h2: '二级标题（（一））：3号楷体_GB2312',
    h3: '三级标题（1.）：3号仿宋_GB2312加粗',
    seal: '发文机关署名+成文日期：右空四字，成文日期用阿拉伯数字',
    pageNum: '页码：4号半角宋体阿拉伯数字，一字线左右各一字',
  },
  components: [
    '版头：发文机关标志、发文字号、签发人、红色分隔线',
    '主体：标题、主送机关、正文、附件说明、发文机关署名、成文日期、印章、附注、附件',
    '版记：抄送机关、印发机关和印发日期、页码',
  ],
};

/** 是否属于党政机关公文（导出 docx 时自动套用 GB/T 9704 排版）。 */
export function isOfficialGenre(name) {
  return [
    '公文',
    '通知',
    '会议纪要',
    '请示',
    '批复',
    '函',
    '通报',
    '公告',
    '通告',
    '意见',
    '决定',
    '决议',
    '命令',
    '公报',
    '议案',
    '报告',
  ].includes(name);
}

const CATEGORY_MAP = {
  公文: [
    '公文',
    '通知',
    '会议纪要',
    '请示',
    '批复',
    '函',
    '通报',
    '公告',
    '通告',
    '意见',
    '决定',
    '决议',
    '命令',
    '公报',
    '议案',
  ],
  议论文: ['议论文'],
  散文: ['散文'],
  演讲稿: ['演讲稿'],
  记叙文: ['记叙文'],
  学术论文: ['学术论文'],
  新闻稿: ['新闻稿'],
  邮件: ['邮件'],
  视频脚本: ['视频脚本'],
  报告: ['报告'],
  合同: ['合同'],
};

/** 从用户话语/标题中检测文体，返回 GENRES 的键名或 null。 */
export function detectGenre(text) {
  const t = String(text || '');
  // 先匹配文体名本身（通知/合同/议论文…），避免被"公文"的别名抢先
  for (const [name] of Object.entries(GENRES)) {
    if (t.includes(name)) return name;
  }
  for (const [name, g] of Object.entries(GENRES)) {
    if (g.aliases.some((a) => a !== name && t.includes(a))) return name;
  }
  // 常见句式："写一份关于××的通知/合同/请示…"
  const m = t.match(/关于[^，。；\s]{1,20}的([一-龥]{2,4})/);
  if (m) {
    for (const [name, g] of Object.entries(GENRES)) {
      if (g.aliases.includes(m[1])) return name;
    }
  }
  return null;
}

/** 把文体映射到个人写作库的分类（library.js 用）。 */
export function genreToCategory(genre) {
  if (!genre) return '';
  for (const [cat, names] of Object.entries(CATEGORY_MAP)) {
    if (names.includes(genre)) return cat;
  }
  return genre;
}

/** 注入提示词的文体规范摘要（限量，避免污染上下文）。 */
export function genreBrief(name) {
  const g = GENRES[name];
  if (!g) return '';
  const lines = [
    `文体：${name}（公式化文体，按范式产出）`,
    `结构骨架：${g.skeleton.join(' → ')}`,
    `行文规范：${g.rules.join('；')}`,
    `禁用：${g.forbidden.join('、')}`,
  ];
  if (isOfficialGenre(name)) {
    lines.push(
      `公文排版（${GB9704.standard}）：${GB9704.fonts.title}；${GB9704.fonts.body}；${GB9704.fonts.h1}；${GB9704.fonts.h2}`,
    );
  }
  return lines.join('\n');
}

export function genreNames() {
  return Object.keys(GENRES);
}

/**
 * 文体驱动的动态澄清蓝图：每类文体有自己的"必问/可选维度"，
 * 不再用同一套 9 项框死所有写作（欧亨利式故事要伏笔/反转，公文要事项/主送，
 * 论文要论点×N，散文不要论点）。
 * 字段 key 与 clarify 状态机对齐：list 字段（materials/arguments/items）计数收集。
 */
export function genreBlueprint(name, opts = {}) {
  const b = contentBudget({
    genre: name,
    targetWords: Number(opts.targetWords) || 0,
  });
  // 目标字数必问：篇幅决定素材要备多少、大纲要拆几节——长文注水的第一道闸门。
  // 素材/论点/事项下限随篇幅动态放大（如 3000 字 → 素材 ≥8 条、论点 ≥3 个）。
  const F = (fields) => {
    const scaled = fields.map((f) => {
      if (f.key === 'materials' && f.count) {
        const n = Math.max(f.count, b.materialsMin);
        return { ...f, count: n, label: f.label.replace(/≥\d+/, `≥${n}`) };
      }
      if (f.key === 'argument' && f.count && b.argumentsMin > 0) {
        const n = Math.max(f.count, b.argumentsMin);
        return { ...f, count: n, label: f.label.replace(/≥\d+/, `≥${n}`) };
      }
      if (f.key === 'items' && f.count && b.itemsMin > 0) {
        const n = Math.max(f.count, b.itemsMin);
        return { ...f, count: n, label: f.label.replace(/≥\d+/, `≥${n}`) };
      }
      return f;
    });
    const out = [...scaled];
    out.splice(1, 0, {
      key: 'targetWords',
      label: `目标字数（${b.label}）`,
      required: true,
    });
    return out;
  };
  switch (name) {
    case '议论文':
    case '学术论文':
    case '报告':
      return F([
        { key: 'topic', label: '主题/研究问题', required: true },
        { key: 'stance', label: '立场/研究结论', required: true },
        { key: 'audience', label: '读者与场合', required: true },
        { key: 'materials', label: '论据/文献/数据（≥2 条）', required: true, count: 2, list: 'materials' },
        { key: 'theme', label: '核心论点/贡献', required: true },
        { key: 'argument', label: '支撑论点（≥2 个）', required: true, count: 2, list: 'arguments' },
        { key: 'known', label: '已知共识/现状（可选）', required: false },
        { key: 'gap', label: '研究缺口/核心张力（可选）', required: false },
        { key: 'method', label: '方法与证据（可选）', required: false },
        { key: 'limitation', label: '局限/边界（可选）', required: false },
        { key: 'ending', label: '结论姿态', required: false },
        { key: 'styleSample', label: '风格底稿（同文体旧稿）', required: false },
      ]);
    case '公文':
    case '通知':
    case '会议纪要':
    case '请示':
    case '批复':
    case '函':
    case '通报':
    case '公告':
    case '通告':
    case '意见':
    case '决定':
    case '决议':
    case '命令':
    case '公报':
    case '议案':
      return F([
        { key: 'topic', label: '事由/文种事项', required: true },
        { key: 'recipient', label: '主送/对象', required: true },
        { key: 'basis', label: '依据/缘由', required: true },
        { key: 'items', label: '事项要点（≥1 条）', required: true, count: 1, list: 'items' },
        { key: 'styleSample', label: '范本/惯例（可选）', required: false },
      ]);
    case '合同':
      return F([
        { key: 'topic', label: '合同类型', required: true },
        { key: 'recipient', label: '当事人（甲乙双方）', required: true },
        { key: 'items', label: '标的/价款/履行/违约/争议解决条款要点', required: true, count: 2, list: 'items' },
        { key: 'styleSample', label: '范本/惯例（可选）', required: false },
      ]);
    case '新闻稿':
      return F([
        { key: 'topic', label: '事件/主题', required: true },
        { key: 'recipient', label: '发布对象/媒体', required: true },
        { key: 'materials', label: '事实素材 5W1H（≥3 条）', required: true, count: 3, list: 'materials' },
        { key: 'stance', label: '报道角度/目的', required: true },
        { key: 'ending', label: '结尾落点（回扣/展望）', required: false },
        { key: 'styleSample', label: '风格底稿（同文体）', required: false },
      ]);
    case '邮件':
      return F([
        { key: 'topic', label: '邮件主题', required: true },
        { key: 'recipient', label: '收件人与关系', required: true },
        { key: 'stance', label: '写这封邮件的目的', required: true },
        { key: 'materials', label: '背景/要点（≥1 条）', required: true, count: 1, list: 'materials' },
        { key: 'styleSample', label: '风格底稿（可选）', required: false },
      ]);
    case '视频脚本':
      return F([
        { key: 'topic', label: '选题/主题', required: true },
        { key: 'recipient', label: '平台与观众', required: true },
        { key: 'stance', label: '目的/CTA', required: true },
        { key: 'materials', label: '素材/画面点（≥2 条）', required: true, count: 2, list: 'materials' },
        { key: 'emotion', label: '节奏/情绪曲线', required: false },
        { key: 'ending', label: '结尾 CTA/钩子', required: false },
        { key: 'styleSample', label: '风格底稿（可选）', required: false },
      ]);
    case '小说':
      return F([
        { key: 'topic', label: '故事主题', required: true },
        { key: 'stance', label: '想表达的核心倾向', required: true },
        { key: 'recipient', label: '读者与题材定位', required: true },
        { key: 'materials', label: '人物/场景/素材（≥2 条）', required: true, count: 2, list: 'materials' },
        { key: 'plot', label: '情节架构（伏笔/冲突/反转设计）', required: true },
        { key: 'character', label: '角色（谁、想要什么、怕什么）', required: false },
        { key: 'emotion', label: '情感曲线', required: false },
        { key: 'ending', label: '结局/反转落点', required: false },
        { key: 'styleSample', label: '风格底稿（可选）', required: false },
      ]);
    default:
      // 散文/记叙文/演讲稿/通用：不要"论点"这种议论文专属维度。
      return F([
        { key: 'topic', label: '主题', required: true },
        { key: 'stance', label: '立场/目的', required: true },
        { key: 'audience', label: '读者与场合', required: true },
        { key: 'materials', label: '具体素材（≥2 条）', required: true, count: 2, list: 'materials' },
        { key: 'theme', label: '核心立意', required: true },
        { key: 'emotion', label: '情感曲线', required: false },
        { key: 'ending', label: '结尾姿态', required: false },
        { key: 'styleSample', label: '风格底稿（同文体旧稿）', required: false },
      ]);
  }
}
