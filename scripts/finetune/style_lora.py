#!/usr/bin/env python3
"""Panza 式本地 LoRA 训练：用 Sculptor 生成的 JSONL 数据集（Reverse Instructions 风格）
对一个小型开源模型做参数高效微调，让模型学会"这位作者怎么写"。

用法:
  sculptor style-adapter --dataset                       # 先生成数据集
  python3 scripts/finetune/style_lora.py \\
      --dataset vault/style-adapter-dataset.jsonl \\
      --model Qwen/Qwen2.5-1.5B-Instruct \\
      --out ./lora-out \\
      --epochs 1

依赖（按需安装，不影响 Sculptor 本体）:
  pip install torch transformers peft datasets accelerate

设计依据: Panza（arXiv:2407.10994）—— <100 样本 + PeFT + RAG；
数据里的"修改对"即作者偏好对（WritingPreferenceBench 同源思想）。
"""
import argparse
import json
import os
import sys


def load_dataset(path):
    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if "messages" in r:
                records.append(r)
            elif "prompt" in r and "completion" in r:
                records.append(
                    {
                        "messages": [
                            {"role": "user", "content": r["prompt"]},
                            {"role": "assistant", "content": r["completion"]},
                        ]
                    }
                )
    return records


def dry_run(dataset):
    bad = 0
    for i, r in enumerate(dataset):
        msgs = r.get("messages") or []
        if len(msgs) < 2 or not msgs[-1].get("content"):
            bad += 1
            print(f"  [bad record {i}] {str(r)[:80]}")
    total_chars = sum(len(m.get("content", "")) for r in dataset for m in r.get("messages", []))
    print(f"数据校验: {len(dataset)} 条记录，{total_chars} 字，坏记录 {bad} 条")
    return bad == 0 and len(dataset) > 0


def train(args):
    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer
    except ImportError as e:
        print(
            f"缺少依赖: {e}\n"
            "请安装: pip install torch transformers peft datasets accelerate\n"
            "（这是可选的本地训练路径，不影响 Sculptor 本体）"
        )
        sys.exit(1)

    dataset = load_dataset(args.dataset)
    if not dry_run(dataset):
        sys.exit(1)
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def fmt(record):
        text = tokenizer.apply_chat_template(
            record["messages"], tokenize=False, add_generation_prompt=False
        )
        enc = tokenizer(text, truncation=True, max_length=args.max_length)
        enc["labels"] = enc["input_ids"].copy()
        return enc

    hf = Dataset.from_list(dataset).map(fmt, remove_columns=["messages"])
    model = AutoModelForCausalLM.from_pretrained(
        args.model, trust_remote_code=True, torch_dtype=torch.bfloat16
    )
    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()
    os.makedirs(args.out, exist_ok=True)
    training_args = TrainingArguments(
        output_dir=args.out,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.accumulate,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        logging_steps=5,
        save_strategy="epoch",
        report_to=[],
        bf16=True,
    )
    Trainer(model=model, args=training_args, train_dataset=hf, tokenizer=tokenizer).train()
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    print(f"LoRA 适配器已保存到 {args.out}")
    print("用法示例（推理时合并风格）:")
    print(
        f"  from peft import PeftModel; m = PeftModel.from_pretrained(base, '{args.out}')"
    )


def main():
    p = argparse.ArgumentParser(description="Panza 式本地 LoRA 风格微调")
    p.add_argument("--dataset", required=True, help="Sculptor 生成的 JSONL 数据集")
    p.add_argument("--model", default="Qwen/Qwen2.5-1.5B-Instruct", help="基础模型")
    p.add_argument("--out", default="./lora-out", help="适配器输出目录")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora-r", type=int, default=8)
    p.add_argument("--lora-alpha", type=int, default=16)
    p.add_argument("--accumulate", type=int, default=4)
    p.add_argument("--max-length", type=int, default=1024)
    p.add_argument("--dry-run", action="store_true", help="只校验数据集，不训练")
    args = p.parse_args()
    dataset = load_dataset(args.dataset)
    if not dry_run(dataset):
        sys.exit(1)
    if args.dry_run:
        return
    train(args)


if __name__ == "__main__":
    main()
