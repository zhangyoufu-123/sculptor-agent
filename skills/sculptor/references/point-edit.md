# 深度定点修改协议（Point Edit）

## 目标

用户能触及文章/项目的每一个小点：选中一个词、一句、一段，要求修改——AI 只改那一点，不改其他地方，并把修改吸收进风格档案。这解决"AI 工具改起来只能整段重来"的问题。

## 定位（Locate）

用户给出目标时，先定位到具体节点：

1. **文本层**：哪个句子/哪个词（引用原文）。
2. **结构层**：它属于哪一节、承担什么功能（铺垫/转折/细节/收束）。
3. **生成层**：这个位置的输出受哪个参数/维度影响（语气温度？句式？节奏？意象？）。
4. **风格层**：这次修改会更新 write-style 还是 read-style 的哪个维度。

定位结果向用户复述一句："我改的是第二段结尾那句，让它更收一些。"——用户确认或纠正后再动手。

## 修改意图捕获（Intent）

动手前明确用户要什么：

- 改哪里（原文引用）
- 改成什么（目标方向或示例）
- 为什么改（感受、节奏、语气、事实？）

如果意图不明，用追问协议问一次（带建议），不问第二次。

## 局部修改（Act）

- **只改目标节点**。结构、其他段落、其他句子保持不动。
- 修改后立即对该节点跑一次 anti-ai.md 局部检查。
- 如果修改牵动前后衔接，只调整衔接处，不做多余重写。

## 吸收进风格档案（Learn）

每次定点修改都记入 vault：

- write-style：语言层改动（用词、句式、语气）→ 更新对应维度 + 提高置信度。
- read-style：结构层改动（节奏、信息密度、段落功能）→ 更新对应维度。
- 修改频率高的维度 = 用户敏感维度，后续写作重点遵守。

用工具落地（零依赖 Node CLI）：

```bash
node scripts/sculptor.mjs absorb .sculptor/vault edit.json
```

深度定点修改（选中一句 → 只改那一句）：

```bash
sculptor point-edit "选中的原句" "修改指令" --dir 项目目录
# 支持"引用"粘贴格式：
#   sculptor point-edit "〔Sculptor 引用〕《选中的原句》" "修改指令" --dir 项目目录
```

point-edit 会在项目 .md 文件里精确定位原文（同句多处出现时报错要求指定文件），
只改写目标区间（越界即中止不写盘），并把修改吸收进 write/read 风格档案。
macOS 用户可安装 `extras/Sculptor 引用服务.workflow`，右键菜单一键触发。

edit.json 格式：

```json
{
  "target": "第二段结尾句",
  "original": "那扇窗沉默地注视着一切。",
  "changed": "那扇窗没有开口，却什么都知道。",
  "intent": "太文艺了，收一点，留白",
  "evidence": "用户原话：这句太文艺了",
  "writeDims": {
    "temperature": { "value": "更克制", "delta": 0.2 },
    "imageryTendency": { "value": "减少拟人意象", "delta": 0.15 }
  },
  "readDims": {
    "pacing": { "value": "更紧凑", "delta": 0.1 }
  }
}
```

每次 absorb 会：更新 write/read-style 对应维度与置信度、追加证据、写入 `vault/edits.jsonl`。

## 常见修改类型速查

| 用户说 | 改哪 | 吸收到 |
| --- | --- | --- |
| "这句太文艺了" | 意象密度/语气温度 | write-style.temperature, imageryTendency |
| "这段读起来很平" | 节奏/段落功能 | read-style.pacing |
| "这里像 AI 写的" | 句式/黑名单 | write-style + anti-ai 检查 |
| "顺序不对，先讲案例" | 结构/时间处理 | read-style.infoDensity, structure |
| "结尾太满，留白" | 结尾模式 | write-style.endingPattern |
