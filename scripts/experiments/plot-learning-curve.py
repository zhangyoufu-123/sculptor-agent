#!/usr/bin/env python3
# 学习曲线绘图（v0.68，A3）：读取 learning-curve.json，用 PIL 画双轴折线
# （留出集正确率 + 权重稳定性 vs 编辑对数量），标注拐点。
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'docs', 'competition', 'learning-curve.json')
OUT = os.path.join(ROOT, 'docs', 'competition', 'learning-curve.png')

W, H = 1100, 660
M = 90
img = Image.new('RGB', (W, H), '#fbf7f0')
d = ImageDraw.Draw(img)
try:
    TITLE_FONT = ImageFont.truetype('/System/Library/Fonts/PingFang.ttc', 26)
    LABEL_FONT = ImageFont.truetype('/System/Library/Fonts/PingFang.ttc', 16)
    SUB_FONT = ImageFont.truetype('/System/Library/Fonts/PingFang.ttc', 14)
except OSError:
    TITLE_FONT = LABEL_FONT = SUB_FONT = ImageFont.load_default()

data = json.load(open(SRC, encoding='utf-8'))
rows = [r for r in data if r.get('trained')]
ns = [r['n'] for r in rows]
holdout = [r['holdoutAcc'] * 100 for r in rows]
margin = [r.get('holdoutMargin', 0) * 100 for r in rows]
cos = [r.get('weightCos', 0) * 100 for r in rows]

plot_w, plot_h = W - 2 * M, H - 2 * M
x = lambda v: M + plot_w * (v - min(ns)) / max(1, (max(ns) - min(ns)))
y = lambda v: M + plot_h - plot_h * v / 100

d.rectangle([M, M, M + plot_w, M + plot_h], outline='#c8b89a', width=2)
for g in range(0, 101, 20):
    d.line([M, y(g), M + plot_w, y(g)], fill='#e5dcc8', width=1)
    d.text((M - 8, y(g) - 8), f'{g}%', font=SUB_FONT, fill='#8a7a5f', anchor='rm')
for n in ns:
    d.text((x(n), M + plot_h + 8), str(n), font=SUB_FONT, fill='#8a7a5f', anchor='ma')

def poly(vals, color):
    pts = [(x(ns[i]), y(vals[i])) for i in range(len(vals))]
    d.line(pts, fill=color, width=4)
    for p in pts:
        d.ellipse([p[0] - 5, p[1] - 5, p[0] + 5, p[1] + 5], fill=color)

poly(holdout, '#b3452f')
poly(cos, '#3d6a8f')

d.text((M, 18), '从修改中学习：样本复杂度曲线', font=TITLE_FONT, fill='#3a2f24')
d.text((M, 56), '留出排序正确率（红，左轴）与权重稳定性（蓝，右轴，对 n=30 参考）随编辑对数量变化', font=LABEL_FONT, fill='#5f5342')
d.text((M, M + plot_h + 34), '编辑对数量 n', font=LABEL_FONT, fill='#5f5342')
best_n = ns[margin.index(max(margin))]
d.text(
    (M, M + plot_h + 58),
    f'观察：正确率在极小样本即饱和，而留出得分边距与权重稳定性随 n 单调改善，n≈15–20 进入平台——几十次修改即可学到稳定的作者方向',
    font=SUB_FONT,
    fill='#8a7a5f',
)
img.save(OUT)
print(f'saved: {OUT}')
