#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风格建模空间（MDS 投影）可复现生成（v0.61）。
对 9 类文本的风格距离矩阵做经典 MDS 降维到 2D，报告 Kruskal Stress-1，
并重绘 docs/competition/style-space.png（人类与机器分域可视化）。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'docs', 'competition', 'style-space.png')
FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc'

labels = ['Stylotrace', '真人A', '真人B', '样本1', '样本2', '样本3', 'ChatGPT', 'DeepSeek', '模板公文']
D = np.array([
    [0.00, 1.07, 1.32, 0.90, 1.10, 0.41, 1.24, 1.10, 1.68],
    [1.07, 0.00, 1.46, 1.28, 1.42, 0.93, 1.50, 1.43, 1.98],
    [1.32, 1.46, 0.00, 1.47, 1.15, 1.50, 1.43, 1.37, 1.91],
    [0.90, 1.28, 1.47, 0.00, 1.27, 1.05, 1.51, 1.51, 1.73],
    [1.10, 1.42, 1.15, 1.27, 0.00, 1.10, 1.74, 1.65, 2.20],
    [0.41, 0.93, 1.50, 1.05, 1.10, 0.00, 1.44, 1.31, 1.88],
    [1.24, 1.50, 1.43, 1.51, 1.74, 1.44, 0.00, 0.47, 1.35],
    [1.10, 1.43, 1.37, 1.51, 1.65, 1.31, 0.47, 0.00, 1.20],
    [1.68, 1.98, 1.91, 1.73, 2.20, 1.88, 1.35, 1.20, 0.00],
], dtype=float)
n = D.shape[0]
J = np.eye(n) - np.ones((n, n)) / n
B = -0.5 * J @ (D ** 2) @ J
w, V = np.linalg.eigh(B)
idx = np.argsort(w)[::-1][:2]
coords = V[:, idx] * np.sqrt(np.maximum(w[idx], 0))
# Kruskal Stress-1：拟合 2D 距离 vs 原距离
X = coords
dhat = np.sqrt(((X[:, None, :] - X[None, :, :]) ** 2).sum(-1))
stress = float(np.sqrt(((dhat - D) ** 2).sum() / (D ** 2).sum()))

if coords[3, 0] < coords[0, 0]:
    coords[:, 0] = -coords[:, 0]
if coords[0, 1] > coords[3, 1]:
    coords[:, 1] = -coords[:, 1]

def f(sz):
    return ImageFont.truetype(FONT, sz)

W, H = 1500, 1000
img = Image.new('RGB', (W, H), 'white')
d = ImageDraw.Draw(img)
d.text((W / 2, 52), f'风格建模空间：9 类文本的 MDS 投影（Stress-1 = {stress:.3f}）',
       font=f(40), fill='#1a2333', anchor='mm')
x0, x1, y0, y1 = 140, W - 140, 130, H - 90
xs, ys = coords[:, 0], coords[:, 1]
xr, yr = xs.max() - xs.min(), ys.max() - ys.min()
pad = max(xr, yr) * 0.18
def px(i): return x0 + (xs[i] - xs.min() + pad) / (xr + 2 * pad) * (x1 - x0)
def py(i): return y1 - (ys[i] - ys.min() + pad) / (yr + 2 * pad) * (y1 - y0)
pts = [(px(i), py(i)) for i in range(n)]
for gx in range(7):
    xx = x0 + (x1 - x0) * gx / 6
    d.line([xx, y0, xx, y1], fill='#e8edf2', width=1)
for gy in range(6):
    yy = y0 + (y1 - y0) * gy / 5
    d.line([x0, yy, x1, yy], fill='#e8edf2', width=1)
d.line([x0, y1, x1, y1], fill='#5c6b7a', width=2)
d.line([x0, y0, x0, y1], fill='#5c6b7a', width=2)
d.text(((x0 + x1) / 2, y1 + 38), 'MDS 维度 1（风格主成分）', font=f(24), fill='#5c6b7a', anchor='mm')
d.text((x0 - 46, (y0 + y1) / 2), 'MDS 维度 2', font=f(24), fill='#5c6b7a', anchor='rm')
groups = [
    ([0, 1, 2, 3, 4, 5], '#8fb8e8', '#2f6fb0', '人类侧（Stylotrace 与匿名真人作者/模拟样本同域）'),
    ([6, 7], '#f2b8b8', '#c0504d', '通用模型（AI 腔趋同域）'),
    ([8], '#d8d8d8', '#8a8a8a', '模板公文（机械域）'),
]
for gidx, gcol, gout, glabel in groups:
    gx = [pts[i][0] for i in gidx]; gy = [pts[i][1] for i in gidx]
    cx = sum(gx) / len(gx); cy = sum(gy) / len(gy)
    sx = (max(gx) - min(gx)) / 2 + 60; sy = (max(gy) - min(gy)) / 2 + 60
    d.ellipse([cx - sx, cy - sy, cx + sx, cy + sy], outline=gout, width=3)
    d.text((cx, cy), glabel, font=f(22), fill=gout, anchor='mm')
for i in range(n):
    r = 22 if i == 0 else 15
    col = '#2f6fb0' if i <= 5 else ('#c0504d' if i in (6, 7) else '#8a8a8a')
    d.ellipse([pts[i][0] - r, pts[i][1] - r, pts[i][0] + r, pts[i][1] + r], fill=col)
    d.text((pts[i][0], pts[i][1] - r - 18), labels[i] + ('（本系统）' if i == 0 else ''),
           font=f(26), fill='#1a2333', anchor='mm')
d.text((W / 2, H - 38),
       f'Stress-1 = {stress:.3f}（<0.15 为良好拟合）· 距离矩阵见 STYLE-MATH.md',
       font=f(25), fill='#33415c', anchor='mm')
img.save(OUT)
print(f'saved: {OUT}')
print(f'Stress-1 = {stress:.3f}')
