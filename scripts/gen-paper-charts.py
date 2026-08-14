#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""论文数据图（matplotlib 重制版，v1.2）：用真实实验数据画清晰对比图，替代旧的 PIL 手绘图。
全部数据来源：
  - 风格距离 / 热力网格 / MDS：9 类文本的 8 维特征（与 style-vectors.py 同一特征函数）
  - 学习曲线：docs/competition/learning-curve.json（scripts/experiments/rsa-learning-curve.mjs 生成）
  - 作者识别：AUTHOR-ID-v2.md（90.3 / 76.4 / 46.3）
  - 调制器消融：MODULATOR-ABLATION.md（学习=默认=100% 饱和；关 personal 掉到 90%）
用法：python3 scripts/gen-paper-charts.py
"""
import json
import os
import re

import numpy as np

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "competition")

# ── 中文字体 ─────────────────────────────────────────────
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
HUMAN = "#3f8f5f"
MODEL = "#c05f5f"
OTHER = "#b39b6b"
ACCENT = "#a45f2f"
BLUE = "#3d6a8f"


# ── 9 类文本（与 style-vectors.py 完全一致）────────────────
SAMPLES = {
    "Stylotrace 作者": (
        "那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。"
        "窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，"
        "我想起课本里那句“破晓的号角”，忽然明白历史不是摆在玻璃柜里的展品，"
        "它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，"
        "久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，"
        "在每一个路过的人停下来看的那一眼里。"
    ),
    "真人作者 A": (
        "它为一个失魂落魄的人把一切都准备好了。那时，太阳循着亘古不变的路途正越来越大，"
        "也越红。在满园弥漫的沉静光芒中，一个人更容易看到时间，并看见自己的身影。"
        "一个人，出生了，这就不再是一个可以辩论的问题，而只是上帝交给他的一个事实。"
        "死是一件不必急于求成的事，死是一个必然会降临的节日。"
        "园子荒芜但并不衰败。蜂儿如一朵小雾稳稳地停在半空，蚂蚁摇头晃脑捋着触须，"
        "压弯了草叶轰然坠地摔开万道金光。满园子都是草木竞相生长弄出的响动，窸窸窣窣片刻不息。"
    ),
    "真人作者 B": (
        "乡下人在城里人眼睛里是“愚”的。其实乡下人并不愚，他们只是在乡土环境里"
        "不需要认得那么多字。文字是间接的说话，而且是个不太完善的工具。"
        "在面对面社群里，连语言本身都还是不得已而采取的工具。"
        "文字所能传的情、达的意是不完全的，这不完全是出于“间接接触”的原因。"
        "乡土社会里，语言像是个通行证，而这个通行证却只有在这个社会里的人才懂得它的意义。"
    ),
    "样本1": (
        "门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，"
        "带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。"
        "木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。"
        "过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。"
        "纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。"
    ),
    "样本2": (
        "你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，"
        "一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。"
        "我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。"
        "上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，"
        "灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。"
    ),
    "样本3": (
        "风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，"
        "仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，"
        "那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，"
        "他跨过门槛的瞬间，历史便从纸面站起，成为人。木梯向上，每一步都像擂鼓，"
        "在空旷的穹顶下回荡。人们说历史很远，可它就在这灰里、这木纹里，"
        "等着一个敢走进去的人，把它重新点燃。"
    ),
    "ChatGPT 通用基线": (
        "在当今社会，随着科技的飞速发展，人工智能已经深刻地改变了我们的生活方式。"
        "它不仅提高了生产效率，也为人们带来了前所未有的便利。"
        "与此同时，我们也应该看到，任何事物都具有两面性。"
        "因此，我们需要理性地看待人工智能的发展，充分发挥其积极作用，同时也要注意防范潜在的风险。"
        "总而言之，人工智能是时代发展的必然趋势，我们应该以积极的态度迎接它，"
        "让它更好地服务于人类社会的发展与进步。"
    ),
    "DeepSeek 通用基线": (
        "随着人工智能技术的持续演进，其应用场景正在不断拓展，覆盖了教育、医疗、"
        "金融等多个重要领域。首先，在教育领域，智能辅导系统能够为学生提供个性化的"
        "学习路径；其次，在医疗领域，辅助诊断模型显著提升了诊疗效率；"
        "此外，金融风控模型也帮助机构更好地识别风险。值得注意的是，"
        "技术的进步同时也带来了数据安全与伦理等方面的挑战。"
        "综上所述，我们应当秉持审慎的态度，推动人工智能健康有序地发展。"
    ),
    "模板公文基线": (
        "根据上级有关文件精神，结合我单位实际情况，现就做好相关工作通知如下："
        "一、提高思想认识，充分领会工作的重要性；二、加强组织领导，明确责任分工；"
        "三、严格时间节点，确保任务按期完成；四、强化督导检查，及时通报进展情况。"
        "请各单位认真贯彻执行，并将落实情况及时上报。特此通知。"
    ),
}

COLLOQUIAL = ["其实", "就是", "反正", "我觉得", "说白了", "有点", "真的", "的话", "呗", "嘛", "哈", "咱们"]
IMAGERY = ["像", "仿佛", "如同", "月光", "风", "影", "石阶", "窗", "灰", "树", "光", "草", "黄昏", "沉静", "蜂儿", "蚂蚁"]
EMOTION = ["泪", "痛", "悲", "暖", "沉默", "安宁", "颤", "空", "失魂落魄", "荒芜", "衰败", "节日", "意义"]
CONNECTIVES = [
    "在当今", "随着", "与此同时", "因此", "所以", "然而", "但是", "而且", "不仅", "也",
    "总而言之", "综上所述", "值得注意的是", "首先", "其次", "最后", "我们", "人们",
    "越来越", "深刻", "前所未有", "充分发挥", "积极", "必然", "趋势", "服务",
    "根据", "有关", "通知如下", "请各单位", "认真贯彻", "特此通知",
]


def feats(text):
    sents = [s.strip() for s in re.split(r"[。！？.!?]+", text) if s.strip()]
    lens = [len(s) for s in sents]
    avg = float(np.mean(lens)) if lens else 0
    std = float(np.std(lens)) if lens else 0
    short = sum(1 for s in sents if len(s) <= 8) / max(1, len(sents))
    colloq = sum(text.count(w) for w in COLLOQUIAL) / max(1, len(text) / 100)
    imagery = sum(text.count(w) for w in IMAGERY) / max(1, len(text) / 100)
    emot = sum(text.count(w) for w in EMOTION) / max(1, len(text) / 100)
    grams = re.findall(r"[\u4e00-\u9fff]{2}", text)
    ttr = len(set(grams)) / max(1, len(grams))
    conn = sum(text.count(w) for w in CONNECTIVES) / max(1, len(text) / 100)
    fresh = 0.6 * max(0.0, 1.0 - conn / 6.0) + 0.4 * (1.0 - len(grams) / max(1, len(set(grams)) * 1.6))
    return {
        "句长均值": avg,
        "句长波动": std,
        "短句占比": short,
        "口语度": colloq,
        "意象密度": imagery,
        "情绪浓度": emot,
        "词汇丰富度": ttr,
        "语言新鲜度": fresh,
    }


def style_data():
    names = list(SAMPLES)
    rows = {n: feats(t) for n, t in SAMPLES.items()}
    dims = list(rows[names[0]])
    norm = {}
    for d in dims:
        vals = [rows[n][d] for n in names]
        lo, hi = min(vals), max(vals)
        norm[d] = {n: 0.5 if hi - lo < 1e-9 else (rows[n][d] - lo) / (hi - lo) for n in names}
    vec = {n: np.array([norm[d][n] for d in dims]) for n in names}
    dist = {n: float(np.linalg.norm(vec["Stylotrace 作者"] - vec[n])) for n in names}
    return names, dims, rows, norm, vec, dist


def save(fig, name):
    fig.savefig(os.path.join(OUT, name), dpi=200, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("saved", name)


def fig_learning_curve():
    src = os.path.join(OUT, "learning-curve.json")
    rows = [r for r in json.load(open(src, encoding="utf-8")) if r.get("trained")]
    ns = [r["n"] for r in rows]
    margin = [r["holdoutMargin"] for r in rows]
    cos = [r.get("weightCos", 0) for r in rows]
    fig, ax1 = plt.subplots(figsize=(8, 4.8))
    ax1.plot(ns, margin, "-o", color=ACCENT, lw=2, label="留出得分边距")
    ax1.set_xlabel("编辑对数量 n", color=INK)
    ax1.set_ylabel("留出得分边距", color=ACCENT)
    ax1.tick_params(axis="y", labelcolor=ACCENT)
    ax1.grid(axis="y", alpha=0.25, ls="--")
    ax2 = ax1.twinx()
    ax2.plot(ns, cos, "-s", color=BLUE, lw=2, label="权重稳定性（cos）")
    ax2.set_ylabel("权重稳定性（与 n=30 的余弦）", color=BLUE)
    ax2.tick_params(axis="y", labelcolor=BLUE)
    ax2.set_ylim(0.8, 1.02)
    ax1.set_title("从修改中学习：留出得分边距与权重稳定性随编辑对数量变化", color=INK, fontsize=13)
    ax1.annotate("n≈15–20 进入平台", xy=(17.5, 0.55), xytext=(9, 0.62),
                 arrowprops=dict(arrowstyle="->", color=MUTED), color=MUTED)
    save(fig, "learning-curve.png")


def fig_style_distance():
    names, _, _, _, _, dist = style_data()
    human = ["真人作者 A", "真人作者 B", "样本1", "样本2", "样本3"]
    models = ["ChatGPT 通用基线", "DeepSeek 通用基线"]
    other = ["模板公文基线"]
    order = human + models + other
    vals = [dist[n] for n in order]
    labels = [n.replace(" 通用基线", "").replace("真人作者 ", "真人 ") for n in order]
    colors = [HUMAN] * len(human) + [MODEL] * len(models) + [OTHER] * len(other)
    fig, ax = plt.subplots(figsize=(8, 5.2))
    bars = ax.barh(labels[::-1], vals[::-1], color=colors[::-1])
    for b, v in zip(bars, vals[::-1]):
        ax.text(b.get_width() + 0.02, b.get_y() + b.get_height() / 2, f"{v:.2f}",
                va="center", ha="left", color=INK, fontsize=10)
    ax.axvline(0.96, color=ACCENT, ls="--", lw=1)
    ax.text(0.96, -0.5, "5 组真人样本均值 0.96", color=ACCENT, fontsize=9, va="bottom")
    ax.set_xlabel("与 Stylotrace 作者的 8 维归一化欧氏距离（越小越接近）")
    ax.set_title("Stylotrace 到各对象的风格距离", color=INK, fontsize=13)
    ax.set_xlim(0, max(vals) * 1.18)
    ax.grid(axis="x", alpha=0.25, ls="--")
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "style-distance-bars.png")


def fig_heatmap():
    names, dims, _, norm, _, _ = style_data()
    M = np.array([[norm[d][n] for d in dims] for n in names])
    fig, ax = plt.subplots(figsize=(9, 6))
    im = ax.imshow(M, cmap="YlOrBr", aspect="auto")
    ax.set_xticks(range(len(dims)), dims, rotation=30, ha="right", color=INK)
    ax.set_yticks(range(len(names)), names, color=INK)
    for i in range(len(names)):
        for j in range(len(dims)):
            ax.text(j, i, f"{M[i, j]:.2f}", ha="center", va="center", color="#2b2118", fontsize=8)
    fig.colorbar(im, ax=ax, fraction=0.03, label="归一化强度")
    ax.set_title("9 类文本的 8 维风格特征（逐维 min-max 归一化）", color=INK, fontsize=13)
    save(fig, "style-vectors-heatmap.png")


def fig_mds():
    names, _, _, _, vec, _ = style_data()
    D = np.array([[float(np.linalg.norm(vec[a] - vec[b])) for b in names] for a in names])
    n = len(names)
    J = np.eye(n) - np.ones((n, n)) / n
    B = -0.5 * J @ (D ** 2) @ J
    w, V = np.linalg.eigh(B)
    idx = np.argsort(w)[::-1][:2]
    coords = V[:, idx] * np.sqrt(np.maximum(w[idx], 0))
    dhat = np.sqrt(((coords[:, None, :] - coords[None, :, :]) ** 2).sum(-1))
    stress = float(np.sqrt(((dhat - D) ** 2).sum() / (D ** 2).sum()))
    fig, ax = plt.subplots(figsize=(8, 6))
    human_idx = [i for i, n in enumerate(names) if n in ("真人作者 A", "真人作者 B", "样本1", "样本2", "样本3")]
    model_idx = [i for i, n in enumerate(names) if "通用基线" in n]
    tmpl_idx = [i for i, n in enumerate(names) if n == "模板公文基线"]
    ax.scatter(coords[human_idx, 0], coords[human_idx, 1], c=HUMAN, s=90, label="真人/模拟样本")
    ax.scatter(coords[model_idx, 0], coords[model_idx, 1], c=MODEL, s=90, label="通用模型")
    ax.scatter(coords[tmpl_idx, 0], coords[tmpl_idx, 1], c=OTHER, s=90, label="模板公文")
    ax.scatter(coords[0, 0], coords[0, 1], c=ACCENT, s=160, marker="*", label="Stylotrace 作者")
    for i, n in enumerate(names):
        label = n.replace(" 通用基线", "").replace("真人作者 ", "真人 ")
        ax.annotate(label, (coords[i, 0], coords[i, 1]), textcoords="offset points",
                    xytext=(8, 6), fontsize=9, color=INK)
    ax.set_title(f"风格建模空间：9 类文本的 MDS 投影（Stress-1 = {stress:.3f}）", color=INK, fontsize=13)
    ax.legend(frameon=False, loc="best")
    ax.set_xlabel("MDS 维度 1")
    ax.set_ylabel("MDS 维度 2")
    ax.grid(alpha=0.2, ls="--")
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "style-space.png")


def fig_author_id():
    labels = ["字符二元组 TF-IDF（基线）", "词级文体计量（本系统）", "字符 n-gram（旧）"]
    vals = [0.903, 0.764, 0.463]
    colors = [MODEL, HUMAN, OTHER]
    fig, ax = plt.subplots(figsize=(7.5, 3.6))
    bars = ax.barh(labels[::-1], vals[::-1], color=colors[::-1])
    for b, v in zip(bars, vals[::-1]):
        ax.text(b.get_width() + 0.01, b.get_y() + b.get_height() / 2, f"{v*100:.1f}%",
                va="center", ha="left", color=INK)
    ax.set_xlim(0, 1.0)
    ax.set_title("作者识别准确率（n=180 块级归属）", color=INK, fontsize=13)
    ax.grid(axis="x", alpha=0.25, ls="--")
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "author-id-bars.png")


def fig_ablation():
    # 真实消融：学习=默认=100% 饱和；关 personal 掉到 90%；其余 12 维无边际影响
    labels = ["学习权重", "默认权重（无学习）", "关闭 personal", "关闭其余 12 维（逐一）"]
    vals = [100.0, 100.0, 90.0, 100.0]
    colors = [HUMAN, OTHER, ACCENT, "#c9c2b2"]
    fig, ax = plt.subplots(figsize=(7.5, 3.8))
    bars = ax.barh(labels[::-1], vals[::-1], color=colors[::-1])
    for b, v in zip(bars, vals[::-1]):
        ax.text(b.get_width() + 0.5, b.get_y() + b.get_height() / 2, f"{v:.0f}%",
                va="center", ha="left", color=INK)
    ax.set_xlim(0, 112)
    ax.set_title("调制器逐维消融：留出排序正确率", color=INK, fontsize=13)
    ax.set_xlabel("正确率（%）；学习与默认均饱和到 100%，仅 personal 有实质贡献")
    ax.grid(axis="x", alpha=0.25, ls="--")
    ax.spines[["top", "right"]].set_visible(False)
    save(fig, "ablation-bars.png")


if __name__ == "__main__":
    fig_learning_curve()
    fig_style_distance()
    fig_heatmap()
    fig_mds()
    fig_author_id()
    fig_ablation()
    print("done")
