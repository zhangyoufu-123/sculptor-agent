// 模拟 LLM 服务器：OpenAI 兼容 /v1/chat/completions，按提示词类型返回固定但真实的响应。
// 用途：离线全链路测试，不消耗真实 API。
const CLARIFY_QUESTIONS = [
  {
    question: '关于北大红楼，你想写的主题具体是什么？',
    recommendation: '一句话先定个方向，比如"百年历久"四个字背后的那栋楼',
    options: [],
  },
  {
    question: '这篇打算写多长？',
    recommendation: '比如"大约一千字"或"三千字左右"——篇幅决定素材要备多少、大纲要拆几节',
    options: [],
  },
  {
    question: '写完这篇发言稿，你想让读者相信什么？',
    recommendation: '比如"历史不是橱窗里的展品，而是可以站进去的现场"',
    options: [],
  },
  {
    question: '这篇文章主要给谁看？',
    recommendation: '老师、同学还是家长？这决定信息密度和语气',
    options: [],
  },
  {
    question: '有没有具体的经历、画面或数据可以用进去？',
    recommendation: '一个小场景就很好，细节比观点更难得',
    options: [],
  },
  { question: '还有没有别的具体素材？', recommendation: '再多一条，论证才有血肉', options: [] },
  {
    question: '这篇文章的立意是什么？用一句话说清核心意思。',
    recommendation: '立意是全文的心脏，比如"历史不是展品，而是可以站进去的现场"',
    options: [],
  },
  {
    question: '围绕立意，你的第一个支撑论点是什么？',
    recommendation: '论点要能展开成一段',
    options: [],
  },
  { question: '第二个支撑论点呢？', recommendation: '和第一个有区分度，不要重复', options: [] },
  {
    question: '读者读完，情绪上应该经历怎样的曲线？',
    recommendation: '比如"先好奇，再触动，最后安宁"',
    options: [],
  },
  {
    question: '结尾你想停在什么姿态上？',
    recommendation: '比如"必胜的决心/赴死的意志/心安则上/留白"',
    options: [],
  },
  {
    question:
      '你以前写过类似这样的文章吗？有同文体的旧稿或片段的话，发我一段，我把它记成你的风格底稿。',
    recommendation: '300 字以上的旧稿最理想；没有的话说"没有"即可，我边写边学',
    options: ['没有，先写吧'],
  },
];

const OUTLINE = {
  title: '百年历久，北大红楼',
  sections: [
    {
      heading: '一、站在门口',
      function: '铺垫',
      thesis: '现场感来自具体的人，而非抽象的时间',
      words: 300,
      keyPoints: ['在红楼门口停留', '想象百年前的脚步声'],
      materials: ['门口的石阶', '红砖墙'],
    },
    {
      heading: '二、窗前的停顿',
      function: '细节',
      thesis: '每一个细节都是过去的证词',
      words: 300,
      keyPoints: ['一扇窗', '窗台积灰', '历史藏在缝隙里'],
      materials: ['窗', '木地板的声音'],
    },
    {
      heading: '三、百年之后',
      function: '升华',
      thesis: '历史从不缺席，只等人走进去',
      words: 300,
      keyPoints: ['自己也是历史的一环', '走出红楼'],
      materials: ['纪念牌', '回望'],
    },
  ],
};

const SECTIONS = [
  `在当今社会，站在北大红楼的门口，我感到历史像旧朝宫人一样沉默。不是所有的门都通向过去，而是每一扇窗都看着我们。石阶被无数双脚磨得光滑，我低头看，仿佛能听见百年前青年的脚步声。`,
  `沿着木梯向上，脚步像旧朝宫人踏过回廊，声音在空旷里散开。近年来，人们总说历史很远，其实它就藏在窗台积灰的缝隙里。我停在一扇窗前，想象曾经有人在这里把一页纸翻来覆去。`,
  `离开时我回头看，那栋楼像旧朝宫人一样站在原地。总而言之，历史从不缺席，只等一个人走进去，把百年前的脚步声重新踩亮。`,
];

// 同一内容的三套风格变体：验证"风格注入真的改变写法"（克制/口语/豪迈）。
const STYLE_VARIANTS = {
  restrained: [
    `门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。`,
    `木梯窄。每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。过去不说话，可它留了痕迹。`,
    `回头。楼还在。暮色里，红砖暗下去。纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。`,
  ],
  casual: [
    `你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。`,
    `上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。那时候我就想，一百年前是不是也有人站这儿，翻着纸，叹口气，把纸往兜里一揣。`,
    `出来的时候我回头瞅了一眼，那楼还杵在那儿，跟个大闷罐似的。纪念牌上写着什么百年征程，我念了一遍，突然觉得那话不是给墙看的，是给咱这些走进去又出来的人看的。历史这东西吧，你走进去过，它就沾你身上了，洗都洗不掉。`,
  ],
  grand: [
    `风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，他跨过门槛的瞬间，历史便从纸面站起，成为人。`,
    `木梯向上，每一步都像擂鼓，在空旷的穹顶下回荡。窗台积灰，灰上刻着细痕，那是无数只手在暗夜中摸索过的证明。我抚过窗棂，仿佛触到一百年前同一扇窗前跳动的心脏。人们说历史很远，可它就在这灰里、这木纹里，等着一个敢走进去的人，把它重新点燃。`,
    `离去时我回头，那栋楼如巨人般立在暮色里，红砖似烧透的炭火。纪念牌上的字，我逐字读过：百年征程，波澜壮阔。历史从不缺席，它只等一个人走进去，把沉睡的脚步声唤醒，再带着那团火，走进属于自己的时代。`,
  ],
};

// 风格化扩写续段（句长结构刻意不同，用于验证最终成稿风格可区分）。
const STYLE_CONT = {
  restrained: `石阶旧了。风从门里出来。历史不响。我站了一会儿。没有进去。后来进去了。楼里暗。光从窗缝进来，落在灰上。灰很厚。厚到像时间自己落下来。我伸手，又缩回。有些东西不该惊动。楼梯响了一声。像有人。回头看，没有人。只有我的影子。离开时，门在身后合上。声音很轻。像什么被放回原处。我走在街上，步子慢下来。楼在身后，越来越远。可它在我心里，越来越近。近到能听见一百年前那声脚步。`,
  casual: `说真的，走进那楼之前我还挺紧张，怕自己像个游客一样瞎转。结果一进去就忘了紧张，光顾着看那窗台了，灰厚得跟棉被似的。我寻思，这灰底下是不是还压着谁写的纸条啊？楼里安安静静的，就我自己的脚步声，噔噔噔，跟敲鼓似的。有一块地板还翘着，一踩就响，吓我一跳。出来的时候太阳都斜了，那楼在身后立着，像送客的老头儿。我回头挥了挥手，也不知道跟谁。反正那一下午，挺值。`,
  grand: `当我终于迈过那道门槛，历史便从沉寂中苏醒，如潮水般漫过脚踝。每一级木梯都在应和我的脚步，仿佛百年前的先辈在暗处列队注视。窗台上积着经年的灰，那不是尘埃，是无数个被折叠的日夜。我抬手，让光线从指缝穿过，看见时间在空气里缓缓流动。那一刻，个人与历史不再隔着玻璃，而是同一条河流里的两朵浪花。走出大门，回望，那栋楼在暮色中巍然不动，如一座未熄的烽火台。我知道，走进去的那一刻，我已经成了它的一部分，而它，也成了我的一部分。`,
};

const EXPANDED_SECTIONS = [
  `站在北大红楼的门口，我先看见了石阶。它被无数双脚磨得光滑，边角却还锋利，像一本被翻旧的书。我蹲下来，手指按在青灰的砖缝上，砖缝里嵌着细碎的砂砾和一片干枯的槐叶。门是深红色的，漆面剥落的地方露出底下的灰白，那颜色让我想起祖父抽屉里的旧信封。我想象百年前的那个早晨，一个穿长衫的青年也是这样站在门口，他攥着几张纸，掌心微微出汗。他走进去的时候，门槛被他的布鞋蹭出一道浅浅的痕迹。风从门里出来，带着木头的旧气。我在门口站了很久，久到门卫多看了我两眼，才忽然明白：这栋楼从来不是橱窗里的展品，它一直在等人走进去，把纸上的名字重新站成一个人。后来我又想，历史并不只在课本的年份里，它也在门槛被磨低的弧度里，在门轴每一次吱呀的声响里，在每一个路过的人停下来看的那一眼里。我们把目光放进去，历史就从墙上的字，变成了脚下能踩到的东西。`,
  `沿着木梯向上，每一步都踩出低沉的响声，那声音在空旷的走廊里散开，又折回来，像有人在身后跟着，却始终没有脚步声落在我肩上。二楼西侧有一扇窗，窗台积着灰，灰上有一道道细痕，像是有人用指甲划过。窗玻璃泛着旧绿，透过它，外面的树影被压得扁扁的。我忽然想，一百年前，是不是也有一个人站在这扇窗前，把一页纸翻来覆去，最后叹一口气，把纸折进口袋？木地板在脚下微微发颤，我停住，听见自己的呼吸被放大成整个走廊的节拍。人们总说历史很远，其实它就藏在窗台积灰的缝隙里，藏在你方才踩过的那一级石阶的磨损里。我试着不去想那些宏大的词语，只记下此刻看见的：灰的走向、光的斜度、木纹的深浅。这些细小的东西没有被写进任何课本，却比任何结论都更接近真实。`,
  `离开时我回头，那栋楼还站在原地，红砖在暮色里暗下去，像一块烧了很久的炭。纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚。我默念了一遍，忽然觉得那句话不是写给墙的，是写给每一个走出去又回头的人。历史从不缺席，它只等一个人走进去，把百年前的脚步声重新踩亮，然后带着那点亮光，走进自己的时代。走出大门，晚风迎面，街上的灯一盏接一盏亮起来。我把刚才在楼里站过的那一小段时间揣在怀里，像揣着一颗还温着的炭。也许我写不出什么大道理，但至少我知道了：有些地方，走进去和没走进去，是不一样的。`,
];

const EXPANDED_MORE = [
  `这些念头被我放回原处，像把一件旧外套挂回衣架。离开前，那扇门又被我看了一眼。门还是那扇门，眼光却已经不一样了。所谓走进历史，未必是去读那些被写下的结论，更多是让自己成为那个正在读的人：脚踩在石阶上，手按在砖缝里，眼睛落在某个具体的角落，然后允许自己安静地站一会儿。这一会儿里没有宏大的词，只有风、灰、木头的味道，和一句没有说出口的"原来在这里"。它被我带走，就成了我的一部分。后来很多次路过这栋楼，我都只是远远地看一眼，不再进去。每次看见那扇深红色的门，那个早晨就会回来，连同门槛边那个像刚刚学会认字的人。历史大概就是这样，不必天天挂在嘴边，只要在心里留下一道印子，就再也忘不掉了。`,
  `第二次走这条走廊，我放慢了脚步。墙上的木框里挂着旧照片，照片里的人穿着不同的衣服，目光却都看向同一个方向。他们曾经在这里站过，说过话，翻过纸页，也许还争论过什么。走廊尽头有一块地板微微翘起，踩上去会发出响声，像某种回应。记忆并不只是大脑里的东西，它也会留在木头的纹理里，留在门把手的包浆里，等一个愿意停下来的人去认出它。指尖划过那块翘起的地板，像是和一百年前的某个人打了个照面。他那天说了什么，做了什么，已经无从知道，能抓住的只有这声地板响。也许历史就是这样，给每个后来者留一点可以触摸的痕迹，让"过去"不至于只是一个空洞的名词。`,
  `那枚还温着的炭被带回住处，放在窗台上，让它慢慢凉。夜很深，楼里的灯已经熄了，暮色里的轮廓却还在，像一句没写完的话。第二天清晨再路过那条街，红砖楼立在晨光里，像刚刚醒来的样子。门卫还是那个门卫，门口的树还是那棵树，有些东西却已经不一样了：那栋楼被我走进过，也走进过我。历史最朴素的样子大概就是这样——它不靠陈列，也不靠纪念，只靠被一个人真正地走过一遍，然后在他身上留下痕迹。这痕迹后来带进了日常：上课时多看一眼窗外的树，路过旧楼时放慢脚步，和别人讲起那座红楼时，说的不再只是它有多老，而是我曾在那里站了很久，久到把一段时光站成了自己的。`,
];

const RESTYLED_SECTIONS = [
  `风从红楼门口灌进来，像一声长啸。石阶被磨亮了一百年，我踏上去，觉得每一步都踩在雷声上。门推开，木轴吱呀，像是旧朝的人替我们留着这扇门。`,
  `沿着木梯往上，脚步放得很重，像战鼓。窗台积灰，我用指腹一抹，灰尘里露出木纹，像一道年轮。窗外树影被风压弯，我忽然想，百年前那个人也站在这里，把一页纸读了三遍。`,
  `离开时回头，那栋楼立在暮色里，红砖像烧红的铁。纪念牌上写着：百年征程波澜壮阔，百年初心历久弥坚。我念了一遍，觉得那不是给墙看的，是给每一个走进去又回头的人看的。历史从不等候，只等人走进去，把百年前的脚步声重新踩亮。`,
];

const FIXED_TEXT = `站在北大红楼的门口，我感到历史沉默。门不一定通向过去，窗却看着我们。沿着木梯向上，脚步像旧朝宫人踏过回廊，声音在空旷里散开。人们总说历史很远，其实它就藏在窗台积灰的缝隙里，藏在你方才踩过的那一级石阶的磨损里。

离开时我回头，那栋楼还站在原地。

历史从不缺席。它只等一个人走进去，把百年前的脚步声重新踩亮。`;

const DISSECT = {
  stance: '想让读者相信历史是可走进的现场，而非橱窗里的展品',
  limits: '作者没有亲历现场，全靠想象补足；"遗憾"本身可以成为感性入口',
  perplexity: '"像旧朝宫人"的重复使用透出对历史拟人化的渴望，也暴露了想象力的边界',
  povs: {
    reader: '第三段最打动人，第二段稍显重复',
    insider: '作为当事人，我觉得石阶那一段被一笔带过了',
    opponent: '我会反问：历史的"沉默"真的能靠比喻传达到吗',
  },
  styleDelivery: '开头最像作者本人；"总而言之"是滑回 AI 腔的一处',
  suggestions: [
    '删掉重复的比喻，保留最有力的一次',
    '把"遗憾"写成一段，而不是绕过去',
    '结尾再留一句余味',
  ],
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
    else if (!has(/^targetWords:/m)) q = CLARIFY_QUESTIONS[1];
    else if (!has(/^stance:/m)) q = CLARIFY_QUESTIONS[2];
    else if (!has(/^audience:/m)) q = CLARIFY_QUESTIONS[3];
    else if (materialCount < 3) q = CLARIFY_QUESTIONS[materialCount === 0 ? 4 : 5];
    else if (!has(/^theme:/m)) q = CLARIFY_QUESTIONS[6];
    else if (argCount < 2) q = CLARIFY_QUESTIONS[argCount === 0 ? 7 : 8];
    else if (!has(/^emotionalCurve:/m)) q = CLARIFY_QUESTIONS[9];
    else if (!has(/^endingTaste:/m)) q = CLARIFY_QUESTIONS[10];
    else if (!has(/^styleSample:/m)) q = CLARIFY_QUESTIONS[11];
    else {
      // 全部字段确认完 → 模拟 LLM"从对话总结出大纲并宣布成形"（presentation artifact）。
      q = {
        question: null,
        recommendation: null,
        options: [],
        stop: true,
        outlineUpdate: { title: OUTLINE.title, sections: OUTLINE.sections },
        outlineComplete: true,
      };
    }
    // 蓝图增量：模拟 LLM 从回答里读出"整篇文章"的结构信息，随澄清逐步合并进 state.blueprint
    return JSON.stringify({
      ...q,
      stop: Boolean(q.stop),
      blueprintUpdate: {
        article: '一篇把百年历史走成现场的散文式发言稿',
        tension: '过去与当下之间的隔阂如何被一个人走进去打破',
        readerTakeaway: '历史不是展品，而是可以站进去的现场',
        skeleton: ['从门口写起', '窗前的停顿', '百年之后'],
      },
    });
  }
  if (userMsg.includes('读者辩论主持人')) {
    return JSON.stringify({
      exchanges: [
        { persona: '老教师', reply: '挑剔编辑说得对，结尾确实需要具体的人来兜住。' },
        { persona: '挑剔评论家', reply: '年轻作家提到的 AI 味问题我同意，论点推进比文采更重要。' },
        { persona: '年轻作家', reply: '我补充：开头三行留人，中段细节再实一点。' },
      ],
      consensus: [
        { point: '结尾落到具体的人身上，不要只讲道理', quote: '历史从不缺席' },
        { point: '去掉重复句式与 AI 套话', quote: '' },
      ],
      disputes: [
        { topic: '结尾姿态', views: ['老教师认为要笃定收束', '评论家认为留白更好'] },
      ],
      priority: [
        { action: '重写结尾，落到具体的人与场景', quote: '历史从不缺席', why: '三位读者都提到了结尾' },
        { action: '清掉 AI 套话', quote: '', why: '年轻作家对 AI 味最敏感' },
      ],
    });
  }
  if (userMsg.includes('风格适配师')) {
    return JSON.stringify({
      voice: '句子长短交错，克制内敛，先写具体物象再收情绪',
      rhythm: '短句收束、长句铺陈细节，节奏疏密有致',
      vocabulary: '多用时间词（百年/当年/如今）与具体名词（石阶/窗台/灰）',
      imagery: '用历史物象承载情感（旧朝宫人/磨光的石阶）',
      sentencePatterns: ['以具体场景起笔', '关键句用短句独立成段'],
      doNot: ['AI 套话', '同一个比喻用两次', '空泛口号'],
      representativeSentence: '历史从不缺席，它只等一个人走进去。',
      editPairs: [{ original: '历史从不缺席', changed: '历史从不等候，只等人走进去' }],
    });
  }
  if (userMsg.includes('事实核查员')) {
    return JSON.stringify({
      items: [
        { text: '1987年', type: 'year', supported: 'verify', reason: '需要核对具体年份与出处' },
        { text: '《光明日报》', type: 'quote', supported: 'common', reason: '报刊名，风险低' },
        { text: '三百多座', type: 'number', supported: 'verify', reason: '数字需要查证' },
      ],
      summary: '两处数字/年代需核对，一处常识性低风险',
    });
  }
  if (userMsg.includes('校对员')) {
    return JSON.stringify({
      items: [
        { text: '帐号', issue: '应为「账号」', type: 'typo', suggestion: '账号', severity: 'high' },
        { text: '迫不急待', issue: '应为「迫不及待」', type: 'typo', suggestion: '迫不及待', severity: 'mid' },
      ],
      summary: '发现 2 处错别字',
    });
  }
  if (userMsg.includes('第一读者') && userMsg.includes('【文章】')) {
    const name = userMsg.match(/你是「(.+?)」/)?.[1] || '读者';
    const firstLine = (userMsg.match(/【文章】\n([\s\S]*?)\n\n输出严格 JSON/) || [])[1] || '';
    const at = firstLine.slice(0, 20) || '开头';
    return JSON.stringify({
      impression: `我是${name}，第一次读这篇：开头有现场感，中段我停了一下来确认那个细节，结尾留下的余味比较清楚。`,
      moments: [
        { at, thought: '这里让我停下来想了想。' },
        { at: firstLine.slice(-20) || '结尾', thought: '结尾这里我记住了。' },
      ],
      advice: '最打动我的是具体场景；抽象的道理再少一点我会更信。',
    });
  }
  if (userMsg.includes('提取写作风格') && userMsg.includes('14 维')) {
    const dimensions =
      /豪迈|激昂|澎湃|有气势|大气|磅礴/.test(userMsg)
        ? {
            temperature: { value: '情绪昂扬', confidence: 0.7, evidence: ['样本情绪饱满'] },
            sentencePreference: { value: '长句铺陈', confidence: 0.65, evidence: ['句长有气势'] },
            imageryTendency: { value: '宏大意象', confidence: 0.75, evidence: ['潮水/烽火台'] },
          }
        : /口语|亲切|像聊天|生活化/.test(userMsg)
          ? {
              temperature: { value: '亲切松弛', confidence: 0.7, evidence: ['口语化表达'] },
              languageRegister: { value: '口语化', confidence: 0.8, evidence: ['像朋友聊天'] },
            }
          : {
              temperature: { value: '中性平稳', confidence: 0.5, evidence: ['未显式要求方向'] },
              sentencePreference: { value: '长短交错', confidence: 0.5, evidence: ['节奏自然'] },
            };
    return JSON.stringify({
      dimensions,
      associations: ['地坛', '落日', '节日'],
      techniques: ['以景写情', '平静审视'],
      attentionFocus: { 生命: 0.8, 死亡: 0.7, 苦难: 0.6 },
    });
  }
  if (userMsg.includes('风格提炼师') && userMsg.includes('对话发言')) {
    // 按注入的方向词返回对应维度（否则固定的"克制"会把方向覆盖掉）。
    const writeStyle =
      /豪迈|激昂|澎湃|有气势|大气|磅礴/.test(userMsg)
        ? {
            temperature: { value: '情绪昂扬', confidence: 0.75, evidence: '用户要求更豪迈' },
            emotionalSpectrum: { value: '情感浓度高', confidence: 0.7, evidence: '豪迈大气' },
            sentencePreference: { value: '长句铺陈', confidence: 0.6, evidence: '有气势' },
          }
        : /口语|亲切|像聊天|生活化/.test(userMsg)
          ? {
              languageRegister: { value: '口语化', confidence: 0.8, evidence: '像朋友聊天' },
              temperature: { value: '亲切松弛', confidence: 0.7, evidence: '口语' },
            }
          : {
              temperature: { value: '中性平稳', confidence: 0.5, evidence: '未显式要求方向' },
              sentencePreference: { value: '长短交错', confidence: 0.5, evidence: '节奏自然' },
            };
    return JSON.stringify({
      writeStyle,
      readStyle: {
        emotionalCurve: { value: '平静→心酸→空落→余味', confidence: 0.8, evidence: '用户确认的情感曲线' },
        endingTaste: { value: '环境回望、余味收束', confidence: 0.75, evidence: '首尾呼应' },
      },
      associations: ['银杏', '葡萄藤', '戈多', '等待'],
      techniques: ['物象承载情感', '暗喻不点破', '叠词与反问'],
      preferences: ['结尾留白不点破', '过程先于结论', '感觉瞬间替代实物直陈'],
      writeReadGap: '想写克制低气压的私人告别，读者需要最后一点亮的余味',
    });
  }
  if (userMsg.includes('写作方法分析师')) {
    return JSON.stringify({
      structure: '通常从一个具体场景切入，中段铺细节，结尾收束不点破。',
      voice: '句子长短交错，多用具体名词，语气克制、有画面感。',
      devices: '善用比喻与留白，关键处引原文原话。',
      pitfalls: '容易在结尾滑向空泛抒情或排比堆砌。',
      example: '历史从不等候，只等人走进去。',
    });
  }
  if (userMsg.includes('提纲设计师')) return JSON.stringify(OUTLINE);
  if (userMsg.includes('大纲评审师')) {
    return JSON.stringify({
      score: 0.82,
      strengths: ['论点挂载齐', '素材有分配', '节与节有推进'],
      issues: [],
      revisedOutline: null,
    });
  }
  if (userMsg.includes('风格保真评估师')) {
    return JSON.stringify({
      score: 0.78,
      dims: {
        sentencePreference: { score: 0.6, note: '句长与作者样本接近' },
        imageryTendency: { score: 0.85, note: '意象贴合作者旧稿' },
      },
      matched: [{ at: '历史从不等候', note: '收束方式像作者本人' }],
      drifted: [],
      advice: ['保留现有物象，少用抽象判断'],
    });
  }
  if (userMsg.includes('⟦待修改⟧') && userMsg.includes('修改指令')) {
    return '那扇窗没有开口，却什么都知道。';
  }
  if (userMsg.includes('【内容要点提取】')) {
    return JSON.stringify({
      keyPoints: ['石阶被磨亮了一百年', '历史从不缺席，只等一个人走进去', '百年征程波澜壮阔'],
    });
  }
  if (userMsg.includes('【主题提炼】')) {
    const m = userMsg.match(/用户开局说了：(.+?)\n/);
    const startsCommand = /^(开始|写吧|开写|你看着办|随便|帮我写$|写吧$)/.test(String(m ? m[1] : ''));
    const raw = String(m ? m[1] : '')
      .replace(
        /^(好|可以|行)?\s*(我)?(想|要|打算|希望)?\s*(帮我|麻烦|请)?\s*(写一?[篇份个]?|创作|起草|来[一篇份个]?|整[一篇份个]?)?\s*(关于|一篇|一份|一个|的)?\s*/,
        '',
      )
      .replace(/[，。！？、\s]+$/, '');
    return JSON.stringify({ topic: !startsCommand && raw.length >= 4 ? raw.slice(0, 40) : '' });
  }
  if (userMsg.includes('【中译英】')) {
    return 'The stone steps have been polished for a hundred years. History never disappears; it only waits for someone to walk in.';
  }
  if (userMsg.includes('【英译中】')) {
    return '石阶被磨亮了一百年。历史从不缺席，它只等一个人走进去。';
  }
  if (userMsg.includes('【信息点核对】')) {
    return JSON.stringify({ kept: ['石阶被磨亮了一百年', '历史从不缺席，只等一个人走进去'], lost: [], drifted: [] });
  }
  if (userMsg.includes('修订者') && userMsg.includes('【原文】')) {
    // 红队修复：保留完整篇幅，只清 AI 套话（模拟真实模型"只改问题、不删内容"）。
    const m = userMsg.match(/【原文】\n([\s\S]*?)\n\n要求：/);
    let cleaned = m ? m[1] : FIXED_TEXT;
    cleaned = cleaned
      .replace(/在当今社会[，,]?/g, '')
      .replace(/近年来[，,]?/g, '')
      .replace(/总而言之[，,]?/g, '')
      .replace(/众所周知[，,]?/g, '');
    // 重复比喻 → 轮换不同意象，避免修出一个新的重复
    let metaIdx = 0;
    cleaned = cleaned.replace(/像旧朝宫人/g, () => {
      const pool = ['像一位旧人', '像一段旧事', '像一块旧砖'];
      return pool[metaIdx++ % pool.length];
    });
    // 长稿：清理后保篇幅（红队只改问题不删内容）；短稿：返回结构完整的干净文本（能过审计）。
    if (cleaned.replace(/\s/g, '').length >= 200) return cleaned.trim();
    return FIXED_TEXT;
  }
  if (userMsg.includes('感性解剖师')) return JSON.stringify(DISSECT);
  if (userMsg.includes('整体重写') && userMsg.includes('【新风格方向】')) {
    // restyle：按节返回"重写后"的正文（复用长样本，长度与风格都达标）
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    return RESTYLED_SECTIONS[idx >= 0 ? idx : 0];
  }
  if (userMsg.includes('预设改写')) {
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    const pool = [...SECTIONS, ...RESTYLED_SECTIONS];
    return pool[idx >= 0 ? idx % pool.length : 0];
  }
  if (userMsg.includes('当前字数') && userMsg.includes('目标字数')) {
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    const i = idx >= 0 ? idx : 0;
    // 一次扩写即给足篇幅；且扩写也按风格走，避免风格差异被扩写抹平。
    if (/豪迈|大气|恢弘|雄浑/.test(userMsg)) return `${STYLE_VARIANTS.grand[i]}\n\n${STYLE_CONT.grand}`;
    if (/口语|亲切|像说话|自然|口语化/.test(userMsg)) return `${STYLE_VARIANTS.casual[i]}\n\n${STYLE_CONT.casual}`;
    if (/克制|留白|内敛|简洁|短句/.test(userMsg)) return `${STYLE_VARIANTS.restrained[i]}\n\n${STYLE_CONT.restrained}`;
    return `${EXPANDED_SECTIONS[i]}\n\n${EXPANDED_MORE[i]}`;
  }
  if (userMsg.includes('写作者')) {
    const match = userMsg.match(/【本节】(.+?)（/);
    const heading = match ? match[1].trim() : '一、站在门口';
    const idx = OUTLINE.sections.findIndex((s) => s.heading === heading);
    const i = idx >= 0 ? idx : 0;
    // 按注入的风格方向返回不同变体，验证"风格真的有区别"
    if (/豪迈|大气|恢弘|雄浑/.test(userMsg)) return STYLE_VARIANTS.grand[i];
    if (/口语|亲切|像说话|自然|口语化/.test(userMsg)) return STYLE_VARIANTS.casual[i];
    if (/克制|留白|内敛|简洁|短句/.test(userMsg)) return STYLE_VARIANTS.restrained[i];
    return SECTIONS[idx >= 0 ? idx : 0];
  }
  if (userMsg.trim() === 'ping') return 'pong';
  return '（mock 无法识别）';
}
