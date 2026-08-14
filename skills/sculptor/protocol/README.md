# Stylotrace 协议层

两个文件是 Stylotrace 与宿主之间的接口：

- `state.json` — 当前工作流状态（玻璃面板数据源）。Stylotrace 每次关键动作后更新，宿主/UI 可读取渲染。
- `requests.jsonl` — 反向请求队列（Stylotrace → 主体 Agent）。Stylotrace 需要用户补充信息、读图、转录时追加一条；宿主处理后在原条目写回 `result` 与 `status`。

首次使用时从模板初始化：

```bash
cp protocol/state.template.json protocol/state.json
touch protocol/requests.jsonl
```
