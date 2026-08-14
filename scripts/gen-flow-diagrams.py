#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""论文流程示意图（matplotlib 重制版）：系统总览 / RAG 供给闭环 / 澄清协议。
旧图为手绘静态 PNG，文字拥挤重叠；本脚本用固定网格坐标画盒线与箭头，保证可读。
用法：python3 scripts/gen-flow-diagrams.py
"""
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "competition")

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
]
_font_path = next((p for p in _FONT_CANDIDATES if os.path.exists(p)), None)
if _font_path:
    font_manager.fontManager.addfont(_font_path)
    _name = font_manager.FontProperties(fname=_font_path).get_name()
    plt.rcParams["font.family"] = _name
plt.rcParams["axes.unicode_minus"] = False

INK = "#2b2118"
MUTED = "#6f5f4b"
BOX = "#f6efe2"
EDGE = "#a45f2f"
BLUE = "#3d6a8f"
GREEN = "#3f8f5f"


def box(ax, x, y, w, h, text, fc=BOX, ec=INK, fs=11, weight="normal"):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02",
                                linewidth=1.2, edgecolor=ec, facecolor=fc))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs,
            color=INK, weight=weight, wrap=True)


def arrow(ax, p0, p1, style="-", color=INK, lw=1.6):
    ax.add_patch(FancyArrowPatch(p0, p1, arrowstyle="-|>", mutation_scale=16,
                                 linestyle=style, color=color, linewidth=lw))


def new_ax(w, h):
    fig, ax = plt.subplots(figsize=(w, h))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 10)
    ax.axis("off")
    return fig, ax


def fig_architecture():
    fig, ax = new_ax(11, 7)
    ax.set_title("Stylotrace 系统总览：数据流（实线）· 控制流（点线）· 学习/更新流（虚线）",
                 fontsize=13, color=INK, pad=12)
    # 主流程
    stages = [("澄清", "主张/前提\n推理/来源"), ("大纲", "实时大纲\n节级规划"),
              ("写作", "逐节生成\n候选调制"), ("审计", "姿态层\n反 AI 味"), ("交付", "导出/归档\n个人 skill")]
    x0, y0, w, h, gap = 0.35, 5.8, 1.45, 1.5, 0.55
    xs = [x0 + i * (w + gap) for i in range(5)]
    for x, (t, s) in zip(xs, stages):
        box(ax, x, y0, w, h, t + "\n" + s, ec=INK, fs=10)
    for i in range(4):
        arrow(ax, (xs[i] + w, y0 + h / 2), (xs[i + 1], y0 + h / 2), "-")
    # 风格/知识/检索三源
    box(ax, 0.35, 1.2, 1.45, 1.3, "风格签名\n四层 + 调制器", ec=EDGE, fs=9)
    box(ax, 4.05, 1.2, 1.45, 1.3, "个人知识库\nPKB + 检索", ec=BLUE, fs=9)
    box(ax, 7.8, 1.2, 1.45, 1.3, "写作资产\n作品/批注", ec=GREEN, fs=9)
    arrow(ax, (1.1, 2.5), (1.1, y0), "--", EDGE)
    arrow(ax, (4.8, 2.5), (4.8, y0), "--", BLUE)
    arrow(ax, (8.5, 2.5), (8.5, y0), "--", GREEN)
    # 学习/更新流（虚线，从审计回写风格）
    arrow(ax, (6.55, y0), (1.9, y0 - 0.55), ":", MUTED)
    ax.text(4.2, y0 - 0.95, "修改监督 / 预测误差 → 增量更新签名与权重", ha="center", fontsize=9, color=MUTED)
    save(fig, "architecture.png")


def fig_rag_loop():
    fig, ax = new_ax(10.5, 6.5)
    ax.set_title("RAG 供给闭环：触发 → 排队 → 检索 → 回灌 → 缺口节重写 → 重审计",
                 fontsize=13, color=INK, pad=12)
    cx, cy, r = 5, 5.2, 2.4
    nodes = [("触发", 0), ("排队", 60), ("检索", 120), ("回灌", 180), ("缺口节重写", 240), ("重审计", 300)]
    import math
    for name, deg in nodes:
        x = cx + r * math.cos(math.radians(deg - 90))
        y = cy + r * math.sin(math.radians(deg - 90))
        box(ax, x - 0.75, y - 0.42, 1.5, 0.84, name, ec=INK, fs=10)
    # 环线箭头（顺时针）
    for i in range(len(nodes)):
        d0 = nodes[i][1] - 90
        d1 = nodes[(i + 1) % len(nodes)][1] - 90
        x0 = cx + (r + 0.85) * math.cos(math.radians(d0))
        y0 = cy + (r + 0.85) * math.sin(math.radians(d0))
        x1 = cx + (r + 0.85) * math.cos(math.radians(d1))
        y1 = cy + (r + 0.85) * math.sin(math.radians(d1))
        ax.add_patch(FancyArrowPatch((x0, y0), (x1, y1), connectionstyle="arc3,rad=0.32",
                                     arrowstyle="-|>", mutation_scale=14, color=EDGE, lw=1.5))
    ax.text(cx, cy, "去重 · 宿主代检\n缓存 + 素材注入", ha="center", va="center", fontsize=10, color=MUTED)
    save(fig, "rag-loop.png")


def fig_clarify_flow():
    fig, ax = new_ax(10.5, 4.2)
    ax.set_title("澄清协议：响应推理链（主张 → 前提 → 概括 → 确认 → 入库 → 追问）",
                 fontsize=13, color=INK, pad=12)
    steps = ["主张", "前提", "概括", "确认", "入库", "追问"]
    x0, y0, w, h, gap = 0.4, 3.2, 1.25, 1.15, 0.42
    xs = [x0 + i * (w + gap) for i in range(6)]
    for x, s in zip(xs, steps):
        box(ax, x, y0, w, h, s, ec=INK, fs=11)
    for i in range(5):
        arrow(ax, (xs[i] + w, y0 + h / 2), (xs[i + 1], y0 + h / 2), "-")
    # 外溢优先回环
    box(ax, 5.1, 0.8, 2.0, 0.9, "外溢优先：当轮接住\n深挖 → 入档", ec=GREEN, fs=9)
    arrow(ax, (6.1, 1.7), (6.1, y0), ":", GREEN)
    ax.text(2.0, 0.85, "一次一问 + 建议 + A/B/C", fontsize=9, color=MUTED)
    save(fig, "clarify-flow.png")


def save(fig, name):
    fig.savefig(os.path.join(OUT, name), dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("saved", name)


if __name__ == "__main__":
    fig_architecture()
    fig_rag_loop()
    fig_clarify_flow()
    print("done")
