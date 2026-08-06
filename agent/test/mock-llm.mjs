// 模拟 LLM 服务器：OpenAI 兼容 /v1/chat/completions，按提示词类型返回固定但真实的响应。
// 用途：离线全链路测试，不消耗真实 API。
const CLARIFY_QUESTIONS = [
  { question: '关于北大红楼，你想写的主题具体是什么？', recommendation: '一句话先定个方向，比如"百年历久"四个字背后的那栋楼', options: [] },
  { question: '写完这篇发言稿，你想让读者相信什么？立场是什么？', recommendation: '比如"历史不是橱窗里的展品，而是可以站进去的现场"', options: [] },
  { question: '这篇文章主要给谁看？读者是谁？', recommendation: '老师、同学还是家长？这决定信息密度和语气', options: [] },
  { question: '有没有具体的经历、画面或数据可以用进去？', recommendation: '一个小场景就很好，细节比观点更难得', options: [] },
  { question: '还有没有别的具体素材？', recommendation: '再多一条，论证才有血肉', options: [] },
  { question: '这篇文章的立意是什么？用一句话说清核心意思。', recommendation: '立意是全文的心脏，比如"历史不是展品，而是可以站进去的现场"', options: [] },
  { question: '围绕立意，你的第一个支撑论点是什么？', recommendation: '论点要能展开成一段', options: [] },
  { question: '第二个支撑论点呢？', recommendation: '和第一个有区分度，不要重复', options: [] },
  { question: '读者读完，情绪上应该经历怎样的曲线？', recommendation: '比如"先好奇，再触动，最后安宁"', options: [] },
  { question: '结尾你想停在什么姿态上？', recommendation: '比如"必胜的决心/赴死的意志/心安则上/留白"', options: [] },
];

const OUTLINE = {
  title: '百年历久，北大红楼',
  sections: [
    { heading: '一、站在门口', function: '铺垫', thesis: '现场感来自具体的人，而非抽象的时间', words: 300, keyPoints: ['在红楼门口停留', '想象百年前的脚步声'], materials: ['门口的石阶', '红砖墙'] },
    { heading: '二、窗前的停顿', function: '细节', thesis: '每一个细节都是过去的证词', words: 300, keyPoints: ['一扇窗', '窗台积灰', '历史藏在缝隙里'], materials: ['窗', '木地板的声音'] },
    { heading: '三、百年之后', function: '升华', thesis: '历史从不缺席，只等人走进去', words: 300, keyPoints: ['自己也是历史的一环', '走出红楼'], materials: ['纪念牌', '回望'] },
  ],
};

const SECTIONS = [
  `在当今社会，站在北大红楼的门口，我感到历史像旧朝宫人一样沉默。不是所有的门都通向过去，而是每一扇窗都看着我们。石阶被无数双脚磨得光滑，我低头看，仿佛能听见百年前青年的脚步声。`,
  `沿着木梯向上，脚步像旧朝宫人踏过回廊，声音在空旷里散开。近年来，人们总说历史很远，其实它就藏在窗台积灰的缝隙里。我停在一扇窗前，想象曾经有人在这里把一页纸翻来覆去。`,
  `离开时我回头看，那栋楼像旧朝宫人一样站在原地。总而言之，历史从不缺席，只等一个人走进去，把百年前的脚步声重新踩亮。`,
];

const EXPANDED_SECTIONS = [
  `站在北大红楼的门口，我先看见了石阶。它被无数双脚磨得光滑，边角却还锋利，像一本被翻旧的书。我蹲下来，手指按在青灰的砖缝上，砖缝里嵌着细碎的砂砾和一片干枯的槐叶。门是深红色的，漆面剥落的地方露出底下的灰白，那颜色让我想起祖父抽屉里的旧信封。我想象百年前的那个早晨，一个穿长衫的青年也是这样站在门口，他攥着几张纸，掌心微微出汗。他走进去的时候，门槛被他的布鞋蹭出一道浅浅的痕迹。风从门里出来，带着木头的旧气。我在门口站了很久，久到门卫多看了我两眼，才忽然明白：这栋楼从来不是橱窗里的展品，它一直在等人走进去，把纸上的名字重新站成一个人。`,
  `沿着木梯向上，每一步都踩出低沉的响声，那声音在空旷的走廊里散开，又折回来，像有人在身后跟着，却始终没有脚步声落在我肩上。二楼西侧有一扇窗，窗台积着灰，灰上有一道道细痕，像是有人用指甲划过。窗玻璃泛着旧绿，透过它，外面的树影被压得扁扁的。我忽然想，一百年前，是不是也有一个人站在这扇窗前，把一页纸翻来覆去，最后叹一口气，把纸折进口袋？木地板在脚下微微发颤，我停住，听见自己的呼吸被放大成整个走廊的节拍。人们总说历史很远，其实它就藏在窗台积灰的缝隙里，藏在你方才踩过的那一级石阶的磨损里。`,
  `离开时我回头，那栋楼还站在原地，红砖在暮色里暗下去，像一块烧了很久的炭。纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚。我默念了一遍，忽然觉得那句话不是写给墙的，是写给每一个走出去又回头的人。历史从不缺席，它只等一个人走进去，把百年前的脚步声重新踩亮，然后带着那点亮光，走进自己的时代。`,
];

const FIXED_TEXT = `站在北大红楼的门口，我感到历史沉默。门不一定通向过去，窗却看着我们。沿着木梯向上，脚步像旧朝宫人踏过回廊，声音在空旷里散开。人们总说历史很远，其实它就藏在窗台积灰的缝隙里，藏在你方才踩过的那一级石阶的磨损里。

离开时我回头，那栋楼还站在原地。

历史从不缺席。它只等一个人走进去，把百年前的脚步声重新踩亮。`;

const DISSECT = {
  stance: '想让读者相信历史是可走进的现场，而非橱窗里的展品',
  limits: '作者没有亲历现场，全靠想象补足；"遗憾"本身可以成为感性入口',
  perplexity: '"像旧朝宫人"的重复使用透出对历史拟人化的渴望，也暴露了想象力的边界',
  povs: { reader: '第三段最打动人，第二段稍显重复', insider: '作为当事人，我觉得石阶那一段被一笔带过了', opponent: '我会反问：历史的"沉默"真的能靠比喻传达到吗' },
  styleDelivery: '开头最像作者本人；"总而言之"是滑回 AI 腔的一处',
  suggestions: ['删掉重复的比喻，保留最有力的一次', '把"遗憾"写成一段，而不是绕过去', '结尾再留一句余味'],
};

export function respond(messages) {
  const userMsg = (messages || []).map((m) => m.content || '').join('\n');
  if (userMsg.includes('追问设计师')) {
    // 无状态：从上下文推断还缺什么（跨进程/跨调用都可靠）
    const ctx = userMsg.match(/【完整上下文】\n([\s\S]*?)\n【用户刚说】/)?.[1] || '';
    const has = (re) => re.test(ctx);
    const materialCount = (ctx.match(/^素材:/gm) || []).length;
    const argCount = (ctx.match(/^argument:/gm) || []).length;
    let q;
    if (!has(/^topic:/m)) q = CLARIFY_QUESTIONS[0];
    else if (!has(/^stance:/m)) q = CLARIFY_QUESTIONS[1];
    else if (!has(/^audience:/m)) q = CLARIFY_QUESTIONS[2];
    else if (materialCount < 2) q = CLARIFY_QUESTIONS[materialCount === 0 ? 3 : 4];
    else if (!has(/^theme:/m)) q = CLARIFY_QUESTIONS[5];
    else if (argCount < 2) q = CLARIFY_QUESTIONS[argCount === 0 ? 6 : 7];
    else if (!has(/^emotionalCurve:/m)) q = CLARIFY_QUESTIONS[8];
    else if (!has(/^endingTaste:/m)) q = CLARIFY_QUESTIONS[9];
    else q = { question: null, recommendation: null, options: [], stop: true };
    return JSON.stringify({ ...q, stop: Boolean(q.stop) });
  }
  if (userMsg.includes('提纲设计师')) return JSON.stringify(OUTLINE);
  if (userMsg.includes('⟦待修改⟧') && userMsg.includes('修改指令')) {
    return '那扇窗没有开口，却什么都知道。';
  }
  if (userMsg.includes('修订者') && userMsg.includes('【原文】')) return FIXED_TEXT;
  if (userMsg.includes('感性解剖师')) return JSON.stringify(DISSECT);
  if (userMsg.includes('当前字数') && userMsg.includes('目标字数')) {
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    return EXPANDED_SECTIONS[idx >= 0 ? idx : 0];
  }
  if (userMsg.includes('写作者')) {
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    return SECTIONS[idx >= 0 ? idx : 0];
  }
  if (userMsg.trim() === 'ping') return 'pong';
  return '（mock 无法识别）';
}
