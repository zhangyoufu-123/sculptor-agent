# 风格持续微调（Panza 式 LoRA）

Sculptor 的持续风格微调分三层，从轻到重：

1. **风格适配卡**（默认，零训练）：`sculptor style-adapter --distill` 把全部旧稿样本、
   个人写作库、亲手修改对压缩成一张 ≤600 字的"风格适配卡"（`vault/style-adapter.md`），
   写作/大纲/重写时最高优先级注入。导演交付时自动蒸馏。
2. **偏好对数据集**（零训练，为微调备料）：`sculptor style-adapter --dataset` 生成
   Reverse Instructions 式 JSONL（Panza 同款）；你的每一次 point-edit 都是一条
   "原文 → 改后"偏好对，天然适合让模型学会你的取舍。
3. **LoRA 微调**（可选训练）：`python3 scripts/finetune/style_lora.py --dataset <jsonl> --model Qwen/Qwen2.5-1.5B-Instruct --out ./lora-out`
   —— 本地 GPU/Colab 上对小模型做参数高效微调（torch + transformers + peft）。
   或者配置 `SCULPTOR_FT_ENDPOINT` + `SCULPTOR_FT_API_KEY` 后跑 `sculptor style-adapter --lora`，
   走 OpenAI 兼容微调接口（上传 `/files` → 创建 `/fine_tuning/jobs`）。

设计依据：Panza（arXiv:2407.10994，<100 样本 + PeFT + RAG）；
修改对即偏好对（WritingPreferenceBench / StyleMC 同源思想）。

## 本地训练示例

```bash
# 1) 生成数据集
sculptor style-adapter --dataset

# 2) 训练（需 torch/transformers/peft/datasets）
python3 scripts/finetune/style_lora.py \
  --dataset vault/style-adapter-dataset.jsonl \
  --model Qwen/Qwen2.5-1.5B-Instruct \
  --out ./lora-out --epochs 1

# 3) 只校验数据（不训练）
python3 scripts/finetune/style_lora.py --dataset vault/style-adapter-dataset.jsonl --dry-run
```

训练出的适配器可挂回任意基于同一底座模型的推理环境；RAG（风格记忆检索）继续并行工作，
两者叠加与 Panza 的"PeFT + RAG"组合一致。
