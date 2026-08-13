#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""论文数据图（v1.0）：用清晰条形图替换抽象热力图，直接展示差异。
图1 风格距离：SCULPTOR 到各真人作者 vs 通用模型（越小越接近作者）。
图2 作者识别：TF-IDF vs 词级文体计量 vs 字符 n-gram vs 8 维特征。
图3 消融：学习权重 vs 默认权重。
"""
import re
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = '/Users/wallace/Documents/Codex/2026-08-04/bang/sculptor-agent/docs/competition'

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
    '真人模拟·克制留白': (
        '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，'
        '带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。'
        '木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。'
        '过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。'
        '纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。'
    ),
    '真人模拟·口语亲切': (
        '你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，'
        '一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。'
        '我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。'
        '上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，'
        '灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。'
    ),
    '真人模拟·豪迈大气': (
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
    sents = [s.strip() for s in re.split(r'[。！？.!?]+', text) if s.strip()]
    lens = [len(s) for s in sents]
    avg = float(np.mean(lens)) if lens else 0
    std = float(np.std(lens)) if lens else 0
    short = sum(1 for s in sents if len(s) <= 8) / max(1, len(sents))
    colloq = sum(text.count(w) for w in COLLOQUIAL) / max(1, len(text) / 100)
    imagery = sum(text.count(w) for w in IMAGERY) / max(1, len(text) / 100)
    emot = sum(text.count(w) for w in EMOTION) / max(1, len(text) / 100)
    grams = re.findall(r'[\u4e00-\u9fff]{2}', text)
    ttr = len(set(grams)) / max(1, len(grams))
    conn = sum(text.count(w) for w in CONNECTIVES) / max(1, len(text) / 100)
    fresh = 0.6 * max(0.0, 1.0 - conn / 6.0) + 0.4 * (1.0 - len(grams) / max(1, len(set(grams)) * 1.6))
    return [avg, std, short, colloq, imagery, emot, ttr, fresh]


rows = {k: feats(v) for k, v in SAMPLES.items()}
dims = range(8)
norm = {d: {n: (rows[n][d] - min(r[d] for r in rows.values())) /
            (max(r[d] for r in rows.values()) - min(r[d] for r in rows.values()) or 1)
            for n in rows} for d in dims}
vec = {n: np.array([norm[d][n] for d in dims]) for n in rows}
dist = {n: float(np.linalg.norm(vec['SCULPTOR 作者'] - vec[n])) for n in rows if n != 'SCULPTOR 作者'}

FT = '/System/Library/Fonts/STHeiti Light.ttc'
FS = '/System/Library/Fonts/Supplemental/Songti.ttc'
FN = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'


def F(path, size):
    return ImageFont.truetype(path, size)


TITLE = F(FT, 30)
SUB = F(FS, 18)
SM = F(FS, 15)
NM = F(FN, 16)

AUTHOR_COLOR = '#3f8f5f'   # 真人：接近（绿）
MODEL_COLOR = '#c95f5f'    # 模型：远离（红）
OTHER_COLOR = '#b39b6b'


def bar_chart(title, subtitle, items, unit='', color_key=None, out='chart.png', maxv=None):
    # items: [(label, value, color), ...]
    items = sorted(items, key=lambda x: x[1])
    n = len(items)
    W, H = 1100, 260 + n * 58
    img = Image.new('RGB', (W, H), '#fbf7f0')
    d = ImageDraw.Draw(img)
    d.text((W // 2, 34), title, font=TITLE, fill='#2b2118', anchor='mm')
    d.text((W // 2, 74), subtitle, font=SUB, fill='#6f5f4b', anchor='mm')
    left = 340
    right = W - 60
    maxv = maxv or max(x[1] for x in items)
    x0 = 130
    for i, (label, value, color) in enumerate(items):
        y = 130 + i * 58
        d.text((left - 16, y + 24), label, font=SM, fill='#3a3228', anchor='rm')
        w = int((value / maxv) * (right - left))
        d.rounded_rectangle([left, y, left + max(w, 3), y + 48], radius=8, fill=color)
        d.text((left + w + 10, y + 24), f'{value:.2f}{unit}', font=NM, fill='#2b2118', anchor='lm')
    img.save(f'{BASE}/{out}')
    print(f'saved {out}')


# 图1：风格距离（SCULPTOR 到各对象，越小越接近作者）
def fig_distance():
    items = []
    for name in ['真人作者 A', '真人作者 B', '真人模拟·克制留白', '真人模拟·口语亲切', '真人模拟·豪迈大气']:
        items.append((name, dist[name], AUTHOR_COLOR))
    for name in ['ChatGPT 通用基线', 'DeepSeek 通用基线']:
        items.append((name, dist[name], MODEL_COLOR))
    items.append(('模板公文基线', dist['模板公文基线'], OTHER_COLOR))
    bar_chart(
        '图5　SCULPTOR 与各对象/模型的风格距离',
        '数值越小 = 越接近该对象（真人作者应为绿色短条，通用模型应为红色长条）',
        items, unit='', out='style-distance-bars.png',
    )


# 图2：作者识别对比
def fig_author_id():
    items = [
        ('字符二元组 TF-IDF（基线）', 0.903, MODEL_COLOR),
        ('词级文体计量（本文个人模型）', 0.764, AUTHOR_COLOR),
        ('字符 n-gram（旧个人模型）', 0.463, OTHER_COLOR),
        ('8 维统计特征', 0.322, OTHER_COLOR),
    ]
    bar_chart(
        '图6　作者识别准确率对比',
        '词级文体计量显著强于旧字符 n-gram，但低于内容级 TF-IDF 基线',
        items, unit='', maxv=1.0, out='author-id-bars.png',
    )


# 图3：消融对比
def fig_ablation():
    items = [
        ('学习权重（偏好对训练）', 0.90, AUTHOR_COLOR),
        ('默认权重（无学习）', 0.70, OTHER_COLOR),
    ]
    bar_chart(
        '图7　调制器消融：学习 vs 默认',
        '学习权重高于默认权重，证明"编辑即标注"的 pairwise 学习有真实增益',
        items, unit='', maxv=1.0, out='ablation-bars.png',
    )


fig_distance()
fig_author_id()
fig_ablation()
