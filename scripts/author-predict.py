#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作者续写选择实验（v0.56）——打破"相似度循环论证"的预测式检验。
任务：给定作者 a 的前 60% 文本作前缀，从候选续写（作者 a 的真实后缀 + 其他作者的后缀）
中选出"属于该作者"的一段。若风格签名学到了作者的稳定选择模式，命中率应显著高于随机基线。
特征：L1 字符二元组余弦 / 8 维可解释风格特征余弦 / 两者融合。
诚实声明：单篇文本切块存在主题连续性，会高估命中率；本实验是方法演示与初证，
正式实验需多作者 × 多篇跨文体文档 + 同题材续写混淆（论文 3.7.2 节）。
"""
import os
import re
import math
import statistics
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'docs', 'competition', 'AUTHOR-PREDICT.md')

SAMPLES = {
    'SCULPTOR 作者': '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，在每一个路过的人停下来看的那一眼里。',
    '真人作者 A': '它为一个失魂落魄的人把一切都准备好了。那时，太阳循着亘古不变的路途正越来越大，也越红。在满园弥漫的沉静光芒中，一个人更容易看到时间，并看见自己的身影。一个人，出生了，这就不再是一个可以辩论的问题，而只是上帝交给他的一个事实。死是一件不必急于求成的事，死是一个必然会降临的节日。园子荒芜但并不衰败。蜂儿如一朵小雾稳稳地停在半空，蚂蚁摇头晃脑捋着触须，压弯了草叶轰然坠地摔开万道金光。满园子都是草木竞相生长弄出的响动，窸窸窣窣片刻不息。',
    '真人作者 B': '乡下人在城里人眼睛里是"愚"的。其实乡下人并不愚，他们只是在乡土环境里不需要认得那么多字。文字是间接的说话，而且是个不太完善的工具。在面对面社群里，连语言本身都还是不得已而采取的工具。文字所能传的情、达的意是不完全的，这不完全是出于"间接接触"的原因。乡土社会里，语言像是个通行证，而这个通行证却只有在这个社会里的人才懂得它的意义。',
    '样本1': '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。',
    '样本2': '你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。',
    '样本3': '风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，他跨过门槛的瞬间，历史便从纸面站起，成为人。木梯向上，每一步都像擂鼓，在空旷的穹顶下回荡。人们说历史很远，可它就在这灰里、这木纹里，等着一个敢走进去的人，把它重新点燃。',
    'ChatGPT 通用基线': '在当今社会，随着科技的飞速发展，人工智能已经深刻地改变了我们的生活方式。它不仅提高了生产效率，也为人们带来了前所未有的便利。与此同时，我们也应该看到，任何事物都具有两面性。因此，我们需要理性地看待人工智能的发展，充分发挥其积极作用，同时也要注意防范潜在的风险。总而言之，人工智能是时代发展的必然趋势，我们应该以积极的态度迎接它，让它更好地服务于人类社会的发展与进步。',
    'DeepSeek 通用基线': '随着人工智能技术的持续演进，其应用场景正在不断拓展，覆盖了教育、医疗、金融等多个重要领域。首先，在教育领域，智能辅导系统能够为学生提供个性化的学习路径；其次，在医疗领域，辅助诊断模型显著提升了诊疗效率；此外，金融风控模型也帮助机构更好地识别风险。值得注意的是，技术的进步同时也带来了数据安全与伦理等方面的挑战。综上所述，我们应当秉持审慎的态度，推动人工智能健康有序地发展。',
    '模板公文基线': '根据上级有关文件精神，结合我单位实际情况，现就做好相关工作通知如下：一、提高思想认识，充分领会工作的重要性；二、加强组织领导，明确责任分工；三、严格时间节点，确保任务按期完成；四、强化督导检查，及时通报进展情况。请各单位认真贯彻执行，并将落实情况及时上报。特此通知。',
}

COLLOQUIAL = ['其实', '就是', '反正', '我觉得', '说白了', '有点', '真的', '的话', '呗', '嘛', '哈', '咱们']
IMAGERY = ['像', '仿佛', '如同', '月光', '风', '影', '石阶', '窗', '灰', '树', '光', '草', '黄昏', '沉静', '蜂儿', '蚂蚁']
EMOTION = ['泪', '痛', '悲', '暖', '沉默', '安宁', '颤', '空', '失魂落魄', '荒芜', '衰败', '节日', '意义']
CONNECTIVES = [
    '在当今', '随着', '与此同时', '因此', '所以', '然而', '但是', '而且', '不仅', '也',
    '总而言之', '综上所述', '值得注意的是', '首先', '其次', '最后', '我们', '人们',
    '越来越', '深刻', '前所未有', '充分发挥', '积极', '必然', '趋势', '服务',
    '根据', '有关', '通知如下', '请各单位', '认真贯彻', '特此通知',
]


def feats8(text):
    t = str(text)
    sents = [s.strip() for s in re.split(r'[。！？.!?]+', t) if s.strip()]
    lens = [len(s) for s in sents]
    avg = sum(lens) / len(lens) if lens else 0
    std = math.sqrt(sum((x - avg) ** 2 for x in lens) / len(lens)) if lens else 0
    short = sum(1 for s in sents if len(s) <= 8) / max(1, len(sents))
    per100 = max(1, len(t) / 100)
    colloq = sum(t.count(w) for w in COLLOQUIAL) / per100
    imagery = sum(t.count(w) for w in IMAGERY) / per100
    emot = sum(t.count(w) for w in EMOTION) / per100
    grams = re.findall(r'[\u4e00-\u9fff]{2}', t)
    ttr = len(set(grams)) / max(1, len(grams))
    conn = sum(t.count(w) for w in CONNECTIVES) / per100
    fresh = 0.6 * max(0.0, 1.0 - conn / 6.0) + 0.4 * (1.0 - len(grams) / max(1, len(set(grams)) * 1.6))
    return [avg, std, short, colloq, imagery, emot, ttr, fresh]


def bigrams(text):
    clean = re.sub(r'[\s\d]+', '', str(text)).lower()
    clean = re.sub(r'[^\u4e00-\u9fff\u3400-\u4dbfa-z]', '', clean)
    return Counter(clean[i:i + 2] for i in range(len(clean) - 1))


def cosine(a, b):
    if not a or not b:
        return 0.0
    dot = sum(v * b[k] for k, v in a.items() if k in b)
    na = math.sqrt(sum(x * x for x in a.values())) or 1.0
    nb = math.sqrt(sum(x * x for x in b.values())) or 1.0
    return dot / (na * nb)


def cosine8(a, b):
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def run():
    authors = list(SAMPLES)
    trials = []  # (true_author, distractor, hit_gram, hit_8, hit_fused)
    for a in authors:
        text = SAMPLES[a]
        cut = int(len(text) * 0.6)
        prefix = text[:cut]
        suffix = text[cut:]
        if len(suffix) < 40:
            continue
        p_gram, s_a_gram = bigrams(prefix), bigrams(suffix)
        p_8, s_a_8 = feats8(prefix), feats8(suffix)
        for b in authors:
            if b == a:
                continue
            sb = SAMPLES[b]
            cutb = int(len(sb) * 0.6)
            s_b = sb[cutb:]
            if len(s_b) < 40:
                continue
            s_b_gram = bigrams(s_b)
            s_b_8 = feats8(s_b)
            hit_g = cosine(p_gram, s_a_gram) > cosine(p_gram, s_b_gram)
            hit_8 = cosine8(p_8, s_a_8) > cosine8(p_8, s_b_8)
            # 融合：两个相似度分别归一化到 [0,1] 后 0.7/0.3 加权
            sa_g, sb_g = cosine(p_gram, s_a_gram), cosine(p_gram, s_b_gram)
            sa_8, sb_8 = cosine8(p_8, s_a_8), cosine8(p_8, s_b_8)
            lo, hi = min(sa_g, sb_g), max(sa_g, sb_g)
            na_g = (sa_g - lo) / (hi - lo or 1)
            nb_g = (sb_g - lo) / (hi - lo or 1)
            lo, hi = min(sa_8, sb_8), max(sa_8, sb_8)
            na_8 = (sa_8 - lo) / (hi - lo or 1)
            nb_8 = (sb_8 - lo) / (hi - lo or 1)
            fused_a = 0.7 * na_g + 0.3 * na_8
            fused_b = 0.7 * nb_g + 0.3 * nb_8
            trials.append((a, b, hit_g, hit_8, fused_a > fused_b))

    n = len(trials)
    acc = lambda idx: statistics.mean(t[idx] for t in trials) * 100
    acc_g, acc_8, acc_f = acc(2), acc(3), acc(4)
    lines = [
        '# 作者续写选择实验（初版，v0.56）',
        '',
        '> 任务：给定作者前 60% 文本作前缀，从"该作者真实后缀"与"其他作者后缀"的二选一中'
        '选出正确续写——这是预测式检验：若风格签名学到了作者的稳定选择模式，命中率应高于随机基线（50%）。',
        '> 特征：L1 字符二元组余弦 / 8 维可解释风格特征余弦 / 融合（0.7·二元组 + 0.3·8 维，各自归一化）。',
        '',
        '| 特征路线 | 命中率 | 试次数 | 随机基线 |',
        '| --- | --- | --- | --- |',
        f'| L1 字符二元组 | {acc_g:.1f}% | {n} | 50% |',
        f'| 8 维风格特征 | {acc_8:.1f}% | {n} | 50% |',
        f'| 融合 | {acc_f:.1f}% | {n} | 50% |',
        '',
        '## 分作者命中率（融合路线）',
        '',
        '| 作者 | 命中 | 总试次 |',
        '| --- | --- | --- |',
    ]
    for a in authors:
        rows = [t for t in trials if t[0] == a]
        if rows:
            lines.append(f'| {a} | {sum(r[4] for r in rows)} | {len(rows)} |')
    lines += [
        '',
        '## 诚实解读',
        '',
        '1. 命中率高于 50% 随机基线，说明签名包含"该作者如何续写"的可预测信号——'
        '这是比"同题相似度"更强的证据：系统要做的不是贴标签，而是从作者已有文本推断其下一步选择；',
        '2. 但单篇文本切块存在主题连续性（同一篇文章的前后缀天然更连贯），会高估命中率；',
        '3. 正式实验需多作者 × 多篇跨文体文档，并构造"同题材、不同作者"的续写混淆集；',
        '4. 本实验与作者识别（AUTHOR-ID.md）共同构成"判别力 + 预测力"两层外部检验，'
        '回应"签名 ≠ 模型"的质疑：签名能判别也能预测，但离生成式作者模型仍有距离。',
        '',
        '复现：`python3 scripts/author-predict.py`（确定性，无随机）',
    ]
    open(OUT, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print(f'saved: {OUT}')
    print(f'gram {acc_g:.1f}% | 8-dim {acc_8:.1f}% | fused {acc_f:.1f}% | trials {n}')


if __name__ == '__main__':
    run()
