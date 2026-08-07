#!/usr/bin/env python3
"""markdown → docx（标题/段落/列表/引用）。用法: write_docx.py <in.md> <out.docx>"""
import re
import sys

from docx import Document


def main():
    md, out = sys.argv[1], sys.argv[2]
    doc = Document()
    for raw in open(md, encoding="utf-8"):
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        h = re.match(r"^(#{1,6})\s+(.+)$", line)
        if h:
            doc.add_heading(h.group(2), level=min(len(h.group(1)), 4))
        elif line.lstrip().startswith(("- ", "* ")):
            doc.add_paragraph(line.lstrip()[2:], style="List Bullet")
        elif line.startswith("> "):
            doc.add_paragraph(line[2:], style="Intense Quote")
        else:
            doc.add_paragraph(line)
    doc.save(out)
    print(out)


if __name__ == "__main__":
    main()
