# Sculptor API 安全与逻辑审计报告（旧版 Web 原型存档）

> 存档来源：已废弃的 `zhangyoufu-123/sculptor` 仓库（sculptor-demo，第一代 Web 原型，
> Next.js 14 + Tiptap + Supabase 脚手架，全 Mock 模式）。删除远程库前抢救留存。

---

# Sculptor API 安全与逻辑审计报告

> 审计日期: 2026-07-28 · Commit: 9ae113a · 6 API 端点 · 0 硬编码密钥

## 一、API Key 安全性 — ✅ 全部通过

### 1.1 密钥存储

| 检查项 | 状态 | 说明 |
|--------|------|------|
| .env.local 被 .gitignore 排除 | ✅ | `.gitignore` 第2行: `.env*.local` |
| .env.local 未提交到 git | ✅ | `git ls-files .env*` 仅 `.env.local.example` |
| 无硬编码 API Key | ✅ | `grep API_KEY\|sk-\|Bearer` 源代码返回 0 结果 |
| 无 NEXT_PUBLIC_ 服务端 Key | ✅ | `grep NEXT_PUBLIC_` 源代码返回 0 结果 |
| .env.local.example 为模板 | ✅ | 所有值均为占位符 `your-*-here` |

### 1.2 密钥使用范围

- `DEEPSEEK_API_KEY`: 仅在 `.env.local` 中定义，未被任何 `.ts/.tsx` 文件引用
- 当前所有 API 端点为纯 Mock 模式，不调用外部 AI 服务
- 无 Supabase/数据库连接，`NEXT_PUBLIC_SUPABASE_*` 为占位符

**结论**: 无安全风险。密钥管理符合最佳实践。

## 二、API 调用与数据传递

### 2.1 userId / documentId 追踪

| 端点 | userId | documentId | 状态 |
|------|--------|------------|------|
| `/api/agent/architect` | ❌ | ❌ | 单用户 MVP，无隔离需求 |
| `/api/agent/write` | ❌ | ❌ | 同上 |
| `/api/agent/ghost` | ❌ | ❌ | 同上 |
| `/api/coordinator/process` | ❌ | ❌ | 同上 |
| `/api/coordinator/query` | ❌ | ❌ | 同上 |
| `/api/output/preview` | ❌ | ❌ | 同上 |

**评估**: 当前为单用户本地 MVP 阶段，无多用户隔离需求。`projectId` 在 Store 中硬编码为
`"project-default-01"`。若未来需要多用户支持，需在请求体中增加 `userId` 字段。

### 2.2 主题一致性追踪

| 检查项 | 状态 | 位置 |
|--------|------|------|
| 首页 anchor 写入 localStorage | ✅ | `app/page.tsx:128` |
| Workspace mount 读取 anchor | ✅ | `app/workspace/page.tsx:221` |
| Architect API 使用 anchor | ✅ | `app/api/agent/architect/route.ts:201` |
| 体裁检测动态注入 topic | ✅ | `deep_question: \`关于「${topic}」...\`` |
| 旧主题不会泄漏 | ✅ | mount 时 `runtimeState: null` |
| 改题目后选项重置 | ✅ | `app/workspace/page.tsx:65` |

### 2.3 死数据检查

- 无硬编码标题覆盖用户输入
- `"未命名"` 仅在 `anchor?.trim()` 为空时作为兜底，不覆盖真实输入
- 无 `process.env.XXX` 注入到 Prompt 中

## 三、AI 选项多样性

### 3.1 选项生成机制

当前实现：**静态硬编码选项**（非 LLM 动态生成）

```typescript
// app/api/agent/architect/route.ts:48
choices: [
  { id: "A", label: "一个具体的时刻", brief: "..." },
  { id: "B", label: "反复出现的日常", brief: "..." },
  { id: "C", label: "一种说不清的感觉", brief: "..." },
]
```

| 检查项 | 状态 |
|--------|------|
| A/B/C 三个选项明显不同 | ✅ |
| 每个选项有独特 narrative_cost | ✅ |
| 选项基于当前 topic 动态注入 | ✅ (deep_question 注入 topic) |
| 改题目后选项跟随新 topic | ✅ (getSteps 重新生成) |
| 5 个步骤各有独立选项集 | ✅ (ESSAY/FICTION 各 5 组) |

### 3.2 选项渲染

| 检查项 | 状态 | 代码位置 |
|--------|------|----------|
| `opt.id` 绑定到点击事件 | ✅ | `workspace/page.tsx:93` |
| `opt.title` 渲染为选项标签 | ✅ | `workspace/page.tsx:94` |
| `opt.cost` 渲染为说明文字 | ✅ | `workspace/page.tsx:95` |
| 深色主题可见 | ✅ | gold 色文字 + 暖色背景 |
| hover 动画 | ✅ | translateY(-1px) + 边框变色 |

### 3.3 Ghost Agent 风格约束传递

**发现问题**: Ghost Agent 解析了 `styleProfile`（第20-21行）但未应用。

```typescript
// app/api/agent/ghost/route.ts:20-21
const bans = styleProfile?.lexical_dna?.banned_phrases || [];  // 提取了
const rhythm = styleProfile?.rhythm_and_syntax?.sentence_length_preference || "中短句";  // 提取了

// 但后续逻辑未使用 bans 和 rhythm！
// 建议: 至少过滤 ghostPool 中匹配 banned_phrases 的候选项
```

**严重程度**: 一般（不影响功能，但风格约束链路断裂）

## 四、修复清单

### 4.1 Ghost Agent 风格约束应用

```diff
// app/api/agent/ghost/route.ts
     let suggestion = ghostPool[Math.floor(Math.random() * ghostPool.length)];

    // 过滤禁用词: 如果候选项包含 banned phrase, 重新选择
    if (bans.length > 0 && bans.some((b: string) => suggestion.includes(b))) {
      const clean = ghostPool.filter((g) => !bans.some((b: string) => g.includes(b)));
      if (clean.length > 0) suggestion = clean[Math.floor(Math.random() * clean.length)];
    }
```

### 4.2 无其他待修复项

所有安全检查和逻辑一致性检查均已通过。

## 五、最佳实践总结

1. **API Key**: 永远存 `.env.local`，`.gitignore` 必须包含 `.env*.local`
2. **Prompt 多样性**: 每个选项必须有独特的 `cost` 说明，帮助用户决策
3. **前端渲染**: 选项格式用统一的 `{ id, title, cost }`，与 API 返回一致
4. **风格约束**: Ghost/Literary Agent 必须实际应用解析出的约束（非仅解析）
5. **主题一致性**: mount 时原子化重置所有状态，确保 anchor 为唯一真相来源
