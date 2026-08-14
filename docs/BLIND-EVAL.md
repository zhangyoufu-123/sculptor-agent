# 第三方盲评收集流程（把"像你"变成可发表的硬结论）

> 目标：让 10–20 个不知情的读者判断"哪篇更像作者本人"，用精确二项检验给出显著性。
> 工具已就绪，你只需要"找人"；下面四步跑完自动出结论。

## 第 1 步：生成盲评对（本地，一次）

```bash
cd /Users/wallace/Documents/Codex/2026-08-04/bang/sculptor-agent/agent
node bin/sculptor.js experiment run \
  --topic "写一篇关于夏天离别的散文" \
  --genre 散文 \
  --words 600 \
  --authors "作者本人=/path/to/你的旧稿.md" \
  /path/to/workspace
```

生成 `blind.json`（随机顺序的 A/B 盲评对：一篇是 Stylotrace 按你风格写的，一篇是你本人的真文）。

## 第 2 步：导出问卷（一次）

```bash
node bin/sculptor.js experiment blind <run目录> --out blind-survey.md
```

把 `blind-survey.md` 转成问卷/表格发给读者。每人只回答："哪篇更像作者 A？A 还是 B"。

## 第 3 步：回收答案（你找人，我定格式）

把所有人的回答整理成 CSV（表头必须是这三列）：

```csv
pairIndex,choice,correct
1,A,true
2,B,false
3,A,true
```

- `choice`：读者选的 A / B（无法判断写 `none`，会当作无效作答剔除）
- `correct`：读者是否选对了"作者本人的那篇"（`true`/`false`/`1`/`0`）

## 第 4 步：自动统计（一次）

```bash
node bin/sculptor.js experiment blind-stats answers.csv
```

自动输出：有效作答数、命中数、命中率、精确二项 p 值（H0 命中率 50%）、Wilson 95% 置信区间、Cohen's h 效应量，以及"显著 / 未达显著"结论。

## 判定标准（写进论文）

- 命中率显著高于 50%（p<0.05）→ 论文"第三方盲评"从"未完成"改为"已完成"，附 p 值与 CI。
- 未达显著 → 如实保留"样本不足"，并扩大样本量。
- 建议样本：≥20 人、≥10 对，可显著提高检出能力。
