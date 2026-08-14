// 篇幅预算（Word Budget）：把"目标字数"翻译成创作预算——节数、每节字数、素材下限、论点下限。
//
// 长文崩坏（水字数）的根因：素材门槛、节数、每节字数都是硬编码常量，与目标字数完全脱钩——
// 目标 3000 字仍按"素材 ≥2 条、4 节"问，到写作阶段素材用尽，只能空泛扩写注水。
// 本模块让澄清/大纲/评审/写作全部按预算走：
//   - 每节自然容量 ~360 字（短段 1-2 句与长段 4-6 句交替的舒适区间）；
//   - 每 ~350 字至少需要 1 条具体素材（场景/数据/引文/事例），否则该节注定注水；
//   - 议论文/报告每 ~900 字一个支撑论点；公文系事项按篇幅等比。
//
// 目标字数未确认时按文体猜测（genreDefaultWords），写作前必须与用户对齐。

const PER_SECTION_WORDS = 360; // 每节自然容量
const WORDS_PER_MATERIAL = 350; // 每 350 字至少 1 条具体素材
const WORDS_PER_ARGUMENT = 900; // 议论文/报告：每 900 字 1 个支撑论点
const WORDS_PER_ITEM = 600; // 公文系：每 600 字 1 个事项要点

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 → 数值（支持"三千五百""一万""八百"等常见写法）。 */
export function cnNumber(s) {
  let total = 0;
  let cur = 0;
  for (const ch of String(s || '')) {
    if (CN_DIGITS[ch] !== undefined) cur = CN_DIGITS[ch];
    else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch === '千') {
      total += (cur || 1) * 1000;
      cur = 0;
    } else if (ch === '万') {
      total = (total + cur) * 10000;
      cur = 0;
    }
  }
  return total + cur;
}

/** 从用户回答里解析目标字数："3000字左右""大约一千字""5-8千"→ 数值；解析不到返回 0。 */
export function parseTargetWords(text) {
  const t = String(text || '');
  const arabic = t.match(/(\d+(?:\.\d+)?)\s*(万|千|k|w)/i);
  if (arabic) {
    const n = Number(arabic[1]);
    const unit = arabic[2].toLowerCase();
    const mult = unit === '万' || unit === 'w' ? 10000 : 1000;
    return Math.round(n * mult);
  }
  const plain = t.match(/\d{3,6}/);
  if (plain) return Number(plain[0]);
  const cn = cnNumber(t.replace(/[^零一二三四五六七八九十两万千百]/g, ''));
  if (cn >= 100) return cn;
  return 0;
}

/** 无数字时按关键词猜目标字数（用于 LLM 无法解析或用户说"写长一点"）。 */
export function guessTargetWords(text) {
  const t = String(text || '');
  if (/长篇|长文|深度|详细|尽量多|写长|长一点|不少于|至少/.test(t)) return 3000;
  if (/短篇|短文|简短|短一点|精简|精炼|少一点|尽量短/.test(t)) return 800;
  return 0;
}

/** 各文体无明确字数时的默认篇幅。 */
export function genreDefaultWords(genre = '') {
  switch (genre) {
    case '学术论文':
      return 4000;
    case '小说':
      return 3000;
    case '议论文':
      return 1500;
    case '报告':
      return 2500;
    case '视频脚本':
      return 1200;
    case '新闻稿':
      return 1000;
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
      return 800;
    case '邮件':
      return 400;
    case '合同':
      return 2000;
    default:
      return 1200; // 散文/记叙文/演讲稿/通用
  }
}

const OFFICIAL = new Set([
  '公文', '通知', '会议纪要', '请示', '批复', '函', '通报', '公告', '通告',
  '意见', '决定', '决议', '命令', '公报', '议案',
]);

const ARGUMENTATIVE = new Set(['议论文', '学术论文', '报告']);

/**
 * 篇幅预算：目标字数 → 节数 / 每节字数 / 素材下限 / 论点下限 / 事项下限。
 * @param opts { genre, targetWords }
 */
export function contentBudget({ genre = '', targetWords = 0 } = {}) {
  const words = Math.max(300, Math.min(30000, Number(targetWords) || genreDefaultWords(genre)));
  const sections = Math.max(3, Math.min(14, Math.round(words / PER_SECTION_WORDS)));
  const perSection = Math.round(words / sections);
  const materialsMin = Math.max(2, Math.min(24, Math.ceil(words / WORDS_PER_MATERIAL)));
  const argumentsMin = ARGUMENTATIVE.has(genre)
    ? Math.max(2, Math.min(8, Math.ceil(words / WORDS_PER_ARGUMENT)))
    : 0;
  const itemsMin =
    OFFICIAL.has(genre) || genre === '合同'
      ? Math.max(1, Math.min(12, Math.ceil(words / WORDS_PER_ITEM)))
      : 0;
  return {
    words,
    sections,
    perSection,
    materialsMin,
    argumentsMin,
    itemsMin,
    label: `目标 ${words} 字 → 拆 ${sections} 节（每节约 ${perSection} 字）、素材 ≥${materialsMin} 条${argumentsMin ? `、论点 ≥${argumentsMin} 个` : ''}`,
  };
}
