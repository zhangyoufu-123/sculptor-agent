// 生态位感知（Observer）：检测任务是否落在 Sculptor 的写作生态位，
// 并生成"轻量提议"。主动，但可拒绝；被拒即完全退让。
// 这是"主动触发"的确定性依据：宿主 AI 用 probe 判断该不该让 Sculptor 介入。

const POSITIVE = [
  {
    re: /演讲稿|发言稿|作文|文章|散文|小说|故事|读后感|观后感|游记|报告|论文|文案|视频脚本|解说词|致辞|悼词|序言/,
    weight: 3,
    label: '长文写作',
  },
  {
    re: /文献|引用|参考文献|查资料|数据支撑|资料查证|GB\/T ?7714|APA|学术规范|论证严密/,
    weight: 2.5,
    label: '学术/数据',
  },
  {
    re: /润色|改写|重写|文笔|风格|像.*写的|要有我的风格|AI味|假大空|读起来|通顺/,
    weight: 2.5,
    label: '风格/质量',
  },
  { re: /大纲|立意|论点|结构|分几段|怎么展开|升华|素材/, weight: 2, label: '写作结构' },
  { re: /改一下|这句|这段|哪一句|哪一段|这里/, weight: 2, label: '定点修改' },
  { re: /公文|通知|请示|批复|函|纪要|报告|方案|合同|协议|致辞/, weight: 2, label: '公文/文书' },
];

const NEGATIVE = [
  { re: /代码|函数|bug|接口|报错|部署|git|数据库|sql|脚本|编译|调试/, weight: 3, label: '编程' },
  { re: /翻译|总结|摘要|转写|提取关键/, weight: 2, label: '翻译/摘要' },
  { re: /^你好$|^在吗$|^谢谢$|^再见$|^好的$/, weight: 1.5, label: '闲聊' },
];

export function probeTask(text) {
  const t = String(text || '').trim();
  if (!t)
    return {
      triggered: false,
      confidence: 0,
      reasons: [],
      negatives: [],
      entry: 'none',
      offer: '',
    };
  let score = 0;
  const reasons = [];
  for (const p of POSITIVE) {
    if (p.re.test(t)) {
      score += p.weight;
      reasons.push(p.label);
    }
  }
  let neg = 0;
  const negatives = [];
  for (const n of NEGATIVE) {
    if (n.re.test(t)) {
      neg += n.weight;
      negatives.push(n.label);
    }
  }
  const isPointEdit = reasons.includes('定点修改');
  const triggered = (score - neg >= 2 && neg < 2) || (isPointEdit && neg === 0);
  const confidence = Number(Math.max(0, Math.min(1, (score - neg) / 5)).toFixed(2));
  const entry = !triggered
    ? 'none'
    : isPointEdit
      ? 'point-edit'
      : reasons.includes('学术/数据')
        ? 'academic'
        : reasons.includes('公文/文书')
          ? 'official'
          : reasons.includes('长文写作')
            ? 'creative'
            : reasons.includes('风格/质量')
              ? 'style'
              : reasons.includes('写作结构')
                ? 'outline'
                : 'clarify';
  const suggest = triggered
    ? isPointEdit
      ? 'point-edit'
      : 'agent'
    : '';
  const offer = triggered
    ? `这是${reasons.join('、')}任务，Sculptor 可以承接（从 ${entry} 起步：${
        entry === 'academic'
          ? '按学术规范澄清研究问题/论点/文献数据，写带引用与参考文献的论文'
          : entry === 'official'
            ? '按公文/文书范式澄清事由/对象/依据/事项，产出规范文稿'
            : entry === 'creative'
              ? '先澄清立意与论点再成稿'
              : entry === 'outline'
                ? '先搭立意-论点-节结构'
                : entry === 'point-edit'
                  ? '只改你选中的那一处'
                  : '先提取你的风格'
      }）。要我接手吗？一句话即可，不接也没关系。`
    : '';
  return { triggered, confidence, reasons, negatives, entry, suggest, offer };
}
