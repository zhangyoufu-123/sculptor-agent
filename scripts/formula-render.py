#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数学公式渲染（v0.51）：把 STYLE-MATH 的核心公式渲染成 PNG。
环境无 LaTeX/matplotlib，用 PIL + Unicode 数学符号渲染（√ Σ ² ̂ ₘₐₓ ∈ ℝ⁸ 等），
供论文/文档嵌入。用法: python3 scripts/formula-render.py
"""
from PIL import Image, ImageDraw, ImageFont

OUT = '/Users/wallace/Documents/Codex/2026-08-04/bang/stylotrace/docs/competition'
FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'

FORMULAS = [
    ('formula-vector.png',
     'v = (μ_len, σ_len, ρ_short, c_col, i_img, e_emo, t_ttr, f_fresh)  ∈  ℝ⁸',
     '特征向量：8 维可解释风格特征'),
    ('formula-norm.png',
     'v̂ⱼ = ( vⱼ − minᵢ vⱼ⁽ⁱ⁾ )  /  ( maxᵢ vⱼ⁽ⁱ⁾ − minᵢ vⱼ⁽ⁱ⁾ )   ∈  [0, 1]',
     '逐维 min-max 归一化'),
    ('formula-distance.png',
     'd(A, B) = √ ( Σⱼ ( vⱼᴬ − vⱼᴮ )² )',
     '风格距离：8 维归一化向量的欧氏距离'),
    ('formula-score.png',
     'C = 0.25·s₁ + 0.20·s₂ + 0.20·s₃ + 0.20·s₄ + 0.15·s₅',
     '写作能力综合评分（加权求和）'),
]

for fname, expr, caption in FORMULAS:
    f = ImageFont.truetype(FONT, 52)
    fcap = ImageFont.truetype(FONT, 26)
    pad = 34
    # 先量宽
    tmp = Image.new('RGB', (10, 10))
    td = ImageDraw.Draw(tmp)
    w = td.textlength(expr, font=f)
    W = int(w) + pad * 2
    H = 150
    img = Image.new('RGB', (W, H), '#fbf7f0')
    d = ImageDraw.Draw(img)
    d.text((pad, 18), expr, font=f, fill='#2b2118')
    d.text((pad, 108), caption, font=fcap, fill='#8a7a64')
    img.save(f'{OUT}/{fname}')
    print('saved', fname, img.size)
