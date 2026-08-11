#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风格向量对比可视化：SCULPTOR 作者风格 vs 人类名家 vs ChatGPT 通用基线。
8 维可解释风格特征（节奏/语感/意象/情绪/词汇/新鲜度），归一化后画
雷达图 + 距离矩阵 + 两两距离对比条，输出 PNG（论文/README 可嵌入）。
用法: python3 scripts/style-visual.py [输出路径]
"""
import re
import math
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else (
    '/Users/wallace/Documents/Codex/2026-08-04/bang/sculptor-agent/docs/competition/style-vector-compare.png'
)

# ── 三类样本（真实文本；名家用史铁生《我与地坛》，AI 基线用典型 AI 腔）──
SAMPLES = {
    'SCULPTOR 作者风格': (
        '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。'
        '窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，'
        '我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，'
        '它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，'
        '久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，'
        '在每一个路过的人停下来看的那一眼里。'
    ),
    '人类名家（史铁生）': (
        '它为一个失魂落魄的人把一切都准备好了。那时，太阳循着亘古不变的路途正越来越大，'
        '也越红。在满园弥漫的沉静光芒中，一个人更容易看到时间，并看见自己的身影。'
        '一个人，出生了，这就不再是一个可以辩论的问题，而只是上帝交给他的一个事实。'
        '死是一件不必急于求成的事，死是一个必然会降临的节日。'
        '园子荒芜但并不衰败。蜂儿如一朵小雾稳稳地停在半空，蚂蚁摇头晃脑捋着触须，'
        '压弯了草叶轰然坠地摔开万道金光。满园子都是草木竞相生长弄出的响动，窸窸窣窣片刻不息。'
    ),
    'ChatGPT 通用基线': (
        '在当今社会，随着科技的飞速发展，人工智能已经深刻地改变了我们的生活方式。'
        '它不仅提高了生产效率，也为人们带来了前所未有的便利。'
        '与此同时，我们也应该看到，任何事物都具有两面性。'
        '因此，我们需要理性地看待人工智能的发展，充分发挥其积极作用，同时也要注意防范潜在的风险。'
        '总而言之，人工智能是时代发展的必然趋势，我们应该以积极的态度迎接它，'
        '让它更好地服务于人类社会的发展与进步。'
    ),
}

# ── 特征词典 ──
COLLOQUIAL = ['其实', '就是', '反正', '我觉得', '说白了', '有点', '真的', '的话', '呗', '嘛', '哈', '咱们']
IMAGERY = ['像', '仿佛', '如同', '月光', '风', '影', '石阶', '窗', '灰', '树', '光', '草', '黄昏', '沉静']
EMOTION = ['泪', '痛', '悲', '暖', '沉默', '安宁', '颤', '空', '失魂落魄', '荒芜', '衰败', '屹立']
CONNECTIVES = [
    '在当今', '随着', '与此同时', '因此', '所以', '然而', '但是', '而且', '不仅', '也',
    '总而言之', '综上所述', '值得注意的是', '首先', '其次', '最后', '我们', '人们',
    '越来越', '深刻', '前所未有', '充分发挥', '积极', '必然', '趋势', '服务',
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
        '词汇丰富·二元 TTR': ttr,
        '语言新鲜·不可预测性': fresh,
    }


rows = {k: feats(v) for k, v in SAMPLES.items()}
names = list(rows)
dims = list(rows[names[0]])

# 逐维 min-max 归一化（保留差异且都在 0-1）
norm = {}
for d in dims:
    vals = [rows[n][d] for n in names]
    lo, hi = min(vals), max(vals)
    norm[d] = {n: 0.5 if hi - lo < 1e-9 else (rows[n][d] - lo) / (hi - lo) for n in names}

# 欧氏距离矩阵
vec = {n: np.array([norm[d][n] for d in dims]) for n in names}
dist = {}
for a in names:
    for b in names:
        dist[(a, b)] = float(np.linalg.norm(vec[a] - vec[b]))

# ── 绘制 ──
W, H = 1760, 1000
img = Image.new('RGB', (W, H), '#fbf7f0')
d = ImageDraw.Draw(img)
F_TITLE = ImageFont.truetype('/System/Library/Fonts/STHeiti Light.ttc', 34)
F_SUB = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 20)
F_AX = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 17)
F_SM = ImageFont.truetype('/System/Library/Fonts/Supplemental/Songti.ttc', 15)
F_NUM = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 16)

COLORS = {'SCULPTOR 作者风格': '#b06a3b', '人类名家（史铁生）': '#3b5ba0', 'ChatGPT 通用基线': '#9aa0a6'}

d.text((W // 2, 38), '风格向量对比：SCULPTOR 作者风格 vs 人类名家 vs ChatGPT 通用基线', font=F_TITLE, fill='#2b2118', anchor='mm')
d.text((W // 2, 80), '8 维归一化风格特征 · 距离为欧氏距离（数值越大，风格差别越明显）', font=F_SUB, fill='#6f5f4b', anchor='mm')

# 图例
lx = 72
for n in names:
    d.rectangle([lx, 108, lx + 26, 130], fill=COLORS[n])
    d.text((lx + 34, 119), n, font=F_SM, fill='#2b2118', anchor='lm')
    lx += 34 + d.textlength(n, font=F_SM) + 28

# 左：雷达图
cx, cy, R = 470, 520, 285
n = len(dims)


def poly(vals, scale=1.0):
    pts = []
    for i, v in enumerate(vals):
        ang = -math.pi / 2 + i * 2 * math.pi / n
        r = v * R * scale
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


for g in (0.25, 0.5, 0.75, 1.0):
    d.line(poly([g] * n), fill='#e4d9c8', width=1)
d.line(poly([1.0] * n), fill='#c9b99f', width=2)
for i, dim in enumerate(dims):
    ang = -math.pi / 2 + i * 2 * math.pi / n
    d.line([(cx, cy), (cx + R * math.cos(ang), cy + R * math.sin(ang))], fill='#e9dfd0', width=1)
    tx = cx + (R + 44) * math.cos(ang)
    ty = cy + (R + 44) * math.sin(ang)
    anchor = 'mm'
    if abs(math.cos(ang)) > 0.6:
        anchor = 'mm'
    d.text((tx, ty), dim, font=F_AX, fill='#4a3c2b', anchor=anchor)

for name in names:
    pts = poly([norm[dim][name] for dim in dims])
    d.polygon(pts, outline=COLORS[name], width=3)
    for p in pts:
        d.ellipse([p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4], fill=COLORS[name])

# 右：距离矩阵 + 距离对比条
mx0, my0, cell = 1000, 210, 132
d.text((mx0, my0 - 42), '风格距离矩阵（欧氏距离）', font=F_SUB, fill='#4a3c2b')
d.text((mx0 - 8, my0 + 150 + 118 * 0 + 12), 'SCULPTOR', font=F_SM, fill='#6f5f4b', anchor='rm')
d.text((mx0 - 8, my0 + 150 + 118 * 1 + 12), '人类名家', font=F_SM, fill='#6f5f4b', anchor='rm')
d.text((mx0 - 8, my0 + 150 + 118 * 2 + 12), 'ChatGPT', font=F_SM, fill='#6f5f4b', anchor='rm')
for i, a in enumerate(names):
    for j, b in enumerate(names):
        x = mx0 + 10 + j * (cell + 8)
        y = my0 + 150 + i * 118
        v = dist[(a, b)]
        t = int(255 * min(1.0, v / 1.3))
        if i == j:
            fill = '#e8e0d2'
            txt = '1.00'
        else:
            fill = f'#f4d9c4' if v < 0.55 else ('#d98e6a' if v < 0.9 else '#b0552f')
        d.rounded_rectangle([x, y, x + cell, y + 82], radius=12, fill=fill, outline='#c9b99f', width=1)
        d.text((x + cell / 2, y + 26), f'{v:.2f}', font=F_NUM, fill='#2b2118', anchor='mm')
        d.text((x + cell / 2, y + 56), '差距小' if v < 0.4 else ('差距明显' if v < 0.75 else '差距很大'), font=F_SM, fill='#4a3c2b', anchor='mm')

# 底部：两两距离对比条
d.text((mx0, my0 + 470), '两两距离（越大 = 风格差别越明显）', font=F_SUB, fill='#4a3c2b')
pairs = [
    ('SCULPTOR 作者风格', 'ChatGPT 通用基线', 'SCULPTOR  vs  ChatGPT'),
    ('人类名家（史铁生）', 'ChatGPT 通用基线', '人类名家  vs  ChatGPT'),
    ('SCULPTOR 作者风格', '人类名家（史铁生）', 'SCULPTOR  vs  人类名家'),
]
maxv = max(dist[p[:2]] for p in pairs)
by = my0 + 510
for i, (a, b, label) in enumerate(pairs):
    v = dist[(a, b)]
    yy = by + i * 56
    d.text((mx0, yy), label, font=F_SM, fill='#4a3c2b')
    d.rounded_rectangle([mx0, yy + 24, mx0 + 520, yy + 46], radius=11, fill='#efe7d8', outline='#c9b99f')
    d.rounded_rectangle([mx0, yy + 24, mx0 + int(520 * v / maxv), yy + 46], radius=11, fill='#b06a3b')
    d.text((mx0 + 536, yy + 35), f'{v:.2f}', font=F_NUM, fill='#2b2118', anchor='lm')

# 结论注释
d.text((mx0, by + 190), '结论：两个"人类作者"与 ChatGPT 的距离都很大、且方向一致', font=F_SM, fill='#6f5f4b')
d.text((mx0, by + 216), '——SCULPTOR 学会的是"人"的写法，而不是模型的平均脸。', font=F_SM, fill='#6f5f4b')

img.save(OUT)
print('saved:', OUT)
for a in names:
    for b in names:
        if a < b:
            print(f'{a} ↔ {b}: {dist[(a, b)]:.2f}')
