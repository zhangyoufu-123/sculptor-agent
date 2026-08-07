#!/usr/bin/env python3
"""markdown → PDF（reportlab + 内置中文 CID 字体 STSong-Light，无需系统字体）。
用法: write_pdf.py <in.md> <out.pdf>
"""
import re
import sys

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))


def esc(s):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", s)
    return s


def styles():
    body = ParagraphStyle(
        "body",
        fontName="STSong-Light",
        fontSize=11,
        leading=19,
        spaceAfter=7,
        firstLineIndent=22,
    )
    h1 = ParagraphStyle("h1", parent=body, fontSize=17, leading=26, spaceBefore=10, spaceAfter=8, firstLineIndent=0)
    h2 = ParagraphStyle("h2", parent=body, fontSize=14, leading=22, spaceBefore=8, spaceAfter=6, firstLineIndent=0)
    h3 = ParagraphStyle("h3", parent=body, fontSize=12, leading=20, spaceBefore=6, spaceAfter=4, firstLineIndent=0)
    quote = ParagraphStyle("quote", parent=body, leftIndent=18, textColor="#555555", firstLineIndent=0)
    return {"h1": h1, "h2": h2, "h3": h3, "body": body, "quote": quote}


def main():
    md, out = sys.argv[1], sys.argv[2]
    st = styles()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        leftMargin=25 * mm,
        rightMargin=25 * mm,
        topMargin=25 * mm,
        bottomMargin=25 * mm,
        title="Sculptor 文稿",
    )
    flow = []
    in_list = []
    for raw in open(md, encoding="utf-8"):
        line = raw.rstrip("\n")
        if not line.strip():
            if in_list:
                flow.append(Spacer(1, 4))
                in_list = []
            continue
        h = re.match(r"^(#{1,6})\s+(.+)$", line)
        if h:
            flow.append(Paragraph(esc(h.group(2)), st[f"h{min(len(h.group(1)), 3)}"]))
            continue
        if line.startswith("> "):
            flow.append(Paragraph(esc(line[2:]), st["quote"]))
            continue
        if re.match(r"^[-*] ", line):
            flow.append(Paragraph("• " + esc(line[2:]), st["body"]))
            in_list.append(True)
            continue
        flow.append(Paragraph(esc(line), st["body"]))
    if in_list:
        flow.append(Spacer(1, 4))
    doc.build(flow)
    print(out)


if __name__ == "__main__":
    main()
