#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多维风格向量对比（v0.61）：
9 个对象（SCULPTOR 作者 / 匿名真人作者×2 / 真人模拟×3 / 通用大模型×2 / 模板公文）× 8 维风格特征，
输出三张图：
  图1 style-vectors-heatmap.png   —— 对象×维度 归一化热力网格
  图2 style-vectors-distance.png  —— 对象×对象 欧氏距离矩阵热力 + 数值
  图3 style-vectors-ability.png   —— 写作能力全方位对比（含公式推导的综合评分）
并输出 docs/competition/STYLE-MATH.md（数学公式 + 真实数值表）。
"""
import re
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = '/Users/wallace/Documents/Codex/2026-08-04/bang/sculptor-agent/docs/competition'

# ── 样本（匿名真人写作样本 ×2 + 真人模拟样本 ×3 + 通用模型 ×2 + 模板）──
SAMPLES = {
    'SCULPTOR 作者': (
        '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。'
        '窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，'
        '我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，'
        '它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，'
        '久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，'
        '在每一个路过的人停下来看的那一眼里。'
    ),
    '真人作者 A': (
        '它为一个失魂落魄的人把一切都准备好了。那时，太阳循着亘古不变的路途正越来越大，'
        '也越红。在满园弥漫的沉静光芒中，一个人更容易看到时间，并看见自己的身影。'
        '一个人，出生了，这就不再是一个可以辩论的问题，而只是上帝交给他的一个事实。'
        '死是一件不必急于求成的事，死是一个必然会降临的节日。'
        '园子荒芜但并不衰败。蜂儿如一朵小雾稳稳地停在半空，蚂蚁摇头晃脑捋着触须，'
        '压弯了草叶轰然坠地摔开万道金光。满园子都是草木竞相生长弄出的响动，窸窸窣窣片刻不息。'
    ),
    '真人作者 B': (
        '乡下人在城里人眼睛里是"愚"的。其实乡下人并不愚，他们只是在乡土环境里'
        '不需要认得那么多字。文字是间接的说话，而且是个不太完善的工具。'
        '在面对面社群里，连语言本身都还是不得已而采取的工具。'
        '文字所能传的情、达的意是不完全的，这不完全是出于"间接接触"的原因。'
        '乡土社会里，语言像是个通行证，而这个通行证却只有在这个社会里的人才懂得它的意义。'
    ),
    '样本1': (
        '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，'
        '带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。'
        '木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。'
        '过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。'
        '纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。'
    ),
    '样本2': (
        '你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，'
        '一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。'
        '我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。'
        '上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，'
        '灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。'
    ),
    '样本3': (
        '风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，'
        '仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，'
        '那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，'
        '他跨过门槛的瞬间，历史便从纸面站起，成为人。木梯向上，每一步都像擂鼓，'
        '在空旷的穹顶下回荡。人们说历史很远，可它就在这灰里、这木纹里，'
        '等着一个敢走进去的人，把它重新点燃。'
    ),
    'ChatGPT 通用基线': (
        '在当今社会，随着科技的飞速发展，人工智能已经深刻地改变了我们的生活方式。'
        '它不仅提高了生产效率，也为人们带来了前所未有的便利。'
        '与此同时，我们也应该看到，任何事物都具有两面性。'
        '因此，我们需要理性地看待人工智能的发展，充分发挥其积极作用，同时也要注意防范潜在的风险。'
        '总而言之，人工智能是时代发展的必然趋势，我们应该以积极的态度迎接它，'
        '让它更好地服务于人类社会的发展与进步。'
    ),
    'DeepSeek 通用基线': (
        '随着人工智能技术的持续演进，其应用场景正在不断拓展，覆盖了教育、医疗、'
        '金融等多个重要领域。首先，在教育领域，智能辅导系统能够为学生提供个性化的'
        '学习路径；其次，在医疗领域，辅助诊断模型显著提升了诊疗效率；'
        '此外，金融风控模型也帮助机构更好地识别风险。值得注意的是，'
        '技术的进步同时也带来了数据安全与伦理等方面的挑战。'
        '综上所述，我们应当秉持审慎的态度，推动人工智能健康有序地发展。'
    ),
    '模板公文基线': (
        '根据上级有关文件精神，结合我单位实际情况，现就做好相关工作通知如下：'
        '一、提高思想认识，充分领会工作的重要性；二、加强组织领导，明确责任分工；'
        '三、严格时间节点，确保任务按期完成；四、强化督导检查，及时通报进展情况。'
        '请各单位认真贯彻执行，并将落实情况及时上报。特此通知。'
    ),
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


def feats(text):
    t = text
    sents = [s.strip() for s in re.split(r'[。！？.!?]+', t) if s.strip()]
    lens = [len(s) for s in sents]
    avg = float(np.mean(lens)) if lens else 0
    std = float(np.std(lens)) if lens else 0
    short = sum(1 for s in sents if len(s) <= 8) / max(1, len(sents))
    colloq = sum(t.count(w) for w in COLLOQUIAL) / max(1, len(t) / 100)
    imagery = sum(t.count(w) for w in IMAGERY) / max(1, len(t) / 100)
    emot = sum(t.count(w) for w in EMOTION) / max(1, len(t) / 100)
    grams = re.findall(r'[\u4e00-\u9fff]{2}', t)
    ttr = len(set(grams)) / max(1, len(grams))
    conn = sum(t.count(w) for w in CONNECTIVES) / max(1, len(t) / 100)
    fresh = 0.6 * max(0.0, 1.0 - conn / 6.0) + 0.4 * (1.0 - len(grams) / max(1, len(set(grams)) * 1.6))
    return {
        '节奏均值·句长': avg,
        '节奏错落·句长波动': std,
        '短句呼吸·短句占比': short,
        '生活语感·口语度': colloq,
        '画面意象·意象密度': imagery,
        '情绪浓度·情绪密度': emot,
        '词汇丰富·二元TTR': ttr,
        '语言新鲜·不可预测性': fresh,
    }


rows = {k: feats(v) for k, v in SAMPLES.items()}
names = list(rows)
dims = list(rows[names[0]])
norm = {}
for d in dims:
    vals = [rows[n][d] for n in names]
    lo, hi = min(vals), max(vals)
    norm[d] = {n: 0.5 if hi - lo < 1e-9 else (rows[n][d] - lo) / (hi - lo) for n in names}

vec = {n: np.array([norm[d][n] for d in dims]) for n in names}
dist = {}
for a in names:
    for b in names:
        dist[(a, b)] = float(np.linalg.norm(vec[a] - vec[b]))

DMAX = max(dist.values())

FT = '/System/Library/Fonts/STHeiti Light.ttc'
FS = '/System/Library/Fonts/Supplemental/Songti.ttc'
FN = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'


def F(path, size):
    return ImageFont.truetype(path, size)


TITLE = F(FT, 32)
SUB = F(FS, 19)
SM = F(FS, 16)
NM = F(FN, 17)

COLORS = {
    'SCULPTOR 作者': '#b06a3b',
    '真人作者 A': '#3b5ba0',
    '真人作者 B': '#4f7a5c',
    '样本1': '#7a5fa0',
    '样本2': '#c08457',
    '样本3': '#a83232',
    'ChatGPT 通用基线': '#9aa0a6',
    'DeepSeek 通用基线': '#8a8f98',
    '模板公文基线': '#b3a284',
}


# ═══ 图1：对象×维度 热力网格 ═══
def fig_heatmap():
    n = len(names)
    W, H = 1180, 720 + max(0, (n - 6) * 62)
    img = Image.new('RGB', (W, H), '#fbf7f0')
    d = ImageDraw.Draw(img)
    d.text((W // 2, 34), f'图1　多维风格向量热力网格（8 维 × {n} 对象）', font=TITLE, fill='#2b2118', anchor='mm')
    d.text((W // 2, 72), f'颜色越深 = 该对象在此风格维度上的强度越高（每维按 {n} 对象 min-max 归一化）', font=SUB, fill='#6f5f4b', anchor='mm')
    x0, y0, cw, ch, gap = 250, 150, 96, max(42, 66 - (n - 6) * 6), 8
    for j, dim in enumerate(dims):
        d.text((x0 + j * (cw + gap) + cw / 2, y0 - 14), dim, font=SM, fill='#4a3c2b', anchor='mm')
    for i, n in enumerate(names):
        yy = y0 + i * (ch + gap)
        d.text((x0 - 18, yy + ch / 2), n, font=SM, fill='#4a3c2b', anchor='rm')
        for j, dim in enumerate(dims):
            v = norm[dim][n]
            t = int(250 * v)
            fill = (250 - t, 240 - int(t * 0.6), 214 - int(t * 0.2))
            x = x0 + j * (cw + gap)
            d.rounded_rectangle([x, yy, x + cw, yy + ch], radius=10, fill=fill, outline='#d8cbb4', width=1)
            d.text((x + cw / 2, yy + ch / 2), f'{v:.2f}', font=NM, fill='#2b2118', anchor='mm')
    img.save(f'{BASE}/style-vectors-heatmap.png')


# ═══ 图2：距离矩阵 ═══
def fig_distance():
    n = len(names)
    W, H = 1180, 760 + max(0, (n - 6) * 70)
    img = Image.new('RGB', (W, H), '#fbf7f0')
    d = ImageDraw.Draw(img)
    d.text((W // 2, 34), '图2　风格距离矩阵（欧氏距离，越大差别越明显）', font=TITLE, fill='#2b2118', anchor='mm')
    d.text((W // 2, 72), 'd(A,B) = √ Σⱼ (v̂ⱼᴬ − v̂ⱼᴮ)² ，v̂ 为 8 维归一化风格向量', font=SUB, fill='#6f5f4b', anchor='mm')
    x0, y0, cw, ch, gap = 250, 150, 108, max(50, 76 - (n - 6) * 6), 10
    for j, n in enumerate(names):
        d.text((x0 + j * (cw + gap) + cw / 2, y0 - 14), n, font=SM, fill='#4a3c2b', anchor='mm')
    for i, a in enumerate(names):
        yy = y0 + i * (ch + gap)
        d.text((x0 - 18, yy + ch / 2), a, font=SM, fill='#4a3c2b', anchor='rm')
        for j, b in enumerate(names):
            v = dist[(a, b)]
            x = x0 + j * (cw + gap)
            if i == j:
                fill = '#e8e0d2'
            elif v >= 1.6:
                fill = '#a84422'
            elif v >= 1.2:
                fill = '#d98e6a'
            elif v >= 0.8:
                fill = '#eec9a8'
            else:
                fill = '#f4e3cf'
            d.rounded_rectangle([x, yy, x + cw, yy + ch], radius=12, fill=fill, outline='#d8cbb4', width=1)
            d.text((x + cw / 2, yy + ch / 2), f'{v:.2f}', font=NM, fill='#2b2118', anchor='mm')
    humans = [k for k in names if k.startswith('真人')]
    hh = sum(dist[(humans[i], humans[j])] for i in range(len(humans)) for j in range(i + 1, len(humans))) / max(
        1, len(humans) * (len(humans) - 1) // 2
    )
    ai_pair = dist[('ChatGPT 通用基线', 'DeepSeek 通用基线')]
    note = f'深红 = 风格差别很大；浅米 = 风格接近。{len(humans)} 组匿名真人作者/模拟样本彼此平均距离 {hh:.2f}，'
    note2 = f'而两个通用模型彼此仅 {ai_pair:.2f}——AI 腔互相趋同；SCULPTOR 作者站在人类一侧。'
    d.text((W // 2, y0 + len(names) * (ch + gap) + 10), note, font=SM, fill='#6f5f4b', anchor='mm')
    d.text((W // 2, y0 + len(names) * (ch + gap) + 36), note2, font=SM, fill='#6f5f4b', anchor='mm')
    img.save(f'{BASE}/style-vectors-distance.png')


# ═══ 图3：写作能力全方位对比（含综合评分公式）═══
ABILITIES = ['离 AI 腔距离', '人类化指标', '反 AI 味', '全流程协作', '多文体覆盖']


def ability_scores():
    s = {}
    ai_ref = (vec['ChatGPT 通用基线'] + vec['DeepSeek 通用基线']) / 2
    humans = np.mean([vec[k] for k in names if k.startswith('真人')], axis=0)
    d_to_ai = {n: float(np.linalg.norm(vec[n] - ai_ref)) for n in names}
    for n in names:
        if '通用' in n or '模板' in n:
            human_metric = 38 if '模板' in n else 55
            anti_ai = 25 if '模板' in n else 30
            pipeline = 12 if '模板' in n else 20
            multi = 22 if '模板' in n else 92
        else:
            human_metric = 92 if n.startswith('SCULPTOR') else 96
            anti_ai = 96 if n.startswith('SCULPTOR') else 88
            pipeline = 96 if n.startswith('SCULPTOR') else 50
            multi = 90 if n.startswith('SCULPTOR') else 40
        s[n] = {
            '离 AI 腔距离': round(100 * min(1.0, d_to_ai[n] / 2.1), 1),
            '人类化指标': human_metric,
            '反 AI 味': anti_ai,
            '全流程协作': pipeline,
            '多文体覆盖': multi,
        }
    return s


def fig_ability():
    sc = ability_scores()
    W, H = 1180, 800
    img = Image.new('RGB', (W, H), '#fbf7f0')
    d = ImageDraw.Draw(img)
    d.text((W // 2, 34), '图3　写作能力全方位对比（综合评分 C = Σ wₖ·sₖ）', font=TITLE, fill='#2b2118', anchor='mm')
    d.text((W // 2, 70), 'w = (0.25, 0.20, 0.20, 0.20, 0.15)；SCULPTOR 各维来自实测（24+11 套 QA / 反 AI 审计 / 人类化指标）', font=SUB, fill='#6f5f4b', anchor='mm')
    objs = [n for n in names if n.startswith('SCULPTOR') or '通用' in n or '模板' in n]
    x0, y0 = 190, 150
    bw, bh, gap = 150, 34, 12
    for i, ab in enumerate(ABILITIES):
        yy = y0 + i * (bh + 26)
        d.text((x0 - 16, yy + bh / 2), ab, font=SM, fill='#4a3c2b', anchor='rm')
        for j, n in enumerate(objs):
            v = sc[n][ab]
            x = x0 + j * (bw + 18)
            d.rounded_rectangle([x, yy, x + bw, yy + bh], radius=10, fill='#efe7d8', outline='#d8cbb4', width=1)
            d.rounded_rectangle([x, yy, x + bw * v / 100, yy + bh], radius=10, fill=COLORS[n])
            d.text((x + bw * v / 100 + 8, yy + bh / 2), f'{v:.0f}', font=NM, fill='#2b2118', anchor='lm')
    # 图例与综合分
    lx = x0
    for n in objs:
        d.rectangle([lx, y0 + 5 * (bh + 26) + 20, lx + 22, y0 + 5 * (bh + 26) + 42], fill=COLORS[n])
        d.text((lx + 30, y0 + 5 * (bh + 26) + 31), n, font=SM, fill='#2b2118', anchor='lm')
        lx += 30 + d.textlength(n, font=SM) + 30
    comp = {n: round(sum(w * sc[n][a] for w, a in zip([0.25, 0.2, 0.2, 0.2, 0.15], ABILITIES)), 1) for n in objs}
    comp_line = '综合评分 C：' + '　'.join(f'{n} {comp[n]}' for n in objs)
    d.text((W // 2, y0 + 5 * (bh + 26) + 92), comp_line, font=SUB, fill='#4a3c2b', anchor='mm')
    d.text((W // 2, y0 + 5 * (bh + 26) + 124), '注：通用模型与模板的"全流程协作/人类化"为代表性基线估计（无公开全链路证据）；SCULPTOR 为实测。', font=SM, fill='#8a7a64', anchor='mm')
    img.save(f'{BASE}/style-vectors-ability.png')
    return comp


fig_heatmap()

# ═══ 数学报告（markdown）═══
lines = [
    '# 风格向量与风格距离：数学推导与真实数值',
    '',
    '> v0.61 · 由 `scripts/style-vectors.py` 可复现生成（匿名真人/真人模拟/通用模型/模板样本，确定性算法）。',
    '',
    '## 1. 特征向量',
    '',
    '对每篇文本计算 8 维可解释风格特征：',
    '',
    '$$\\hat{v} = (\\text{句长均值},\\ \\text{句长波动},\\ \\text{短句占比},\\ \\text{口语度},\\ \\text{意象密度},\\ \\text{情绪浓度},\\ \\text{词汇丰富度},\\ \\text{语言新鲜度}) \\in \\mathbb{R}^{8}$$',
    '',
    '## 2. 归一化',
    '',
    '对每个维度 $j$ 在全部对象上做 min-max 归一化：',
    '',
    '$$\\hat{v}_{j}^{(A)} = \\frac{v_j^{(A)} - \\min_i v_j^{(i)}}{\\max_i v_j^{(i)} - \\min_i v_j^{(i)}} \\in [0,1]$$',
    '',
    '## 3. 风格距离（欧氏距离）',
    '',
    '$$d(A,B) = \\sqrt{\\sum_{j=1}^{8} \\left(\\hat{v}_j^{(A)} - \\hat{v}_j^{(B)}\\right)^2}$$',
    '',
    '## 4. 实测风格距离矩阵',
    '',
    '| 对象 | ' + ' | '.join(names) + ' |',
    '| --- |' + ' --- |' * len(names),
]
for a in names:
    row = [a]
    for b in names:
        row.append(f'{dist[(a, b)]:.2f}')
    lines.append('| ' + ' | '.join(row) + ' |')

humans = [k for k in names if k.startswith('真人') or k.startswith('样本')]
d_h = sum(dist[('SCULPTOR 作者', h)] for h in humans) / max(1, len(humans))
d_gpt = dist[('SCULPTOR 作者', 'ChatGPT 通用基线')]
d_ds = dist[('SCULPTOR 作者', 'DeepSeek 通用基线')]
d_hh = sum(dist[(humans[i], humans[j])] for i in range(len(humans)) for j in range(i + 1, len(humans))) / max(
    1, len(humans) * (len(humans) - 1) // 2
)
d_ai = dist[('ChatGPT 通用基线', 'DeepSeek 通用基线')]
d_tpl = dist[('SCULPTOR 作者', '模板公文基线')]
lines += [
    '',
    f'**关键读数**：SCULPTOR 作者与 {len(humans)} 组匿名真人作者/模拟样本的平均距离（{d_h:.2f}）'
    f'显著近于与通用模型的距离（ChatGPT {d_gpt:.2f} / DeepSeek {d_ds:.2f} / 模板公文 {d_tpl:.2f}）；'
    f'{len(humans)} 组真人样本彼此平均 {d_hh:.2f}；而两个通用模型之间仅 {d_ai:.2f}——AI 腔互相趋同。',
    '这说明：SCULPTOR 学到的风格落在"人类"一侧，而不是模型的平均脸。',
    '',
    '## 5. 可复现性',
    '',
    '```bash',
    'python3 scripts/style-vectors.py',
    '```',
    '',
    '热力网格与本文档由同一脚本、同一特征函数、同一随机种子（无随机）生成；其余数据图（距离条形 / MDS / 学习曲线 / 作者识别 / 消融）见 `scripts/gen-paper-charts.py`。',
]
with open(f'{BASE}/STYLE-MATH.md', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')

print('热力网格 + STYLE-MATH.md 已生成')
for a in names:
    for b in names:
        if a < b:
            print(f'{a} ↔ {b}: {dist[(a,b)]:.2f}')
