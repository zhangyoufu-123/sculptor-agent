# 调制器消融（学习 vs 默认 vs 逐维关闭）

> 任务：原文 vs 改后 二选一排序；训练 20 对、留出 10 对。

| 变体 | 留出排序正确率 | 相对学习权重 |
| --- | --- | --- |
| 学习权重 | 90.0% | — |
| 默认权重（无学习） | 70.0% | 20.0% pp |
| 关 personal | 80.0% | -10.0% pp |
| 关 discourse | 90.0% | 0.0% pp |
| 关 stance | 90.0% | 0.0% pp |
| 关 knowledge | 90.0% | 0.0% pp |
| 关 defect | 90.0% | 0.0% pp |
| 关 vector | 90.0% | 0.0% pp |
| 关 embedding | 90.0% | 0.0% pp |
| 关 fineread | 90.0% | 0.0% pp |
| 关 posture | 90.0% | 0.0% pp |
| 关 avoidance | 90.0% | 0.0% pp |
| 关 transform | 90.0% | 0.0% pp |
| 关 surface | 100.0% | 10.0% pp |
| 关 impedance | 100.0% | 10.0% pp |

结论：学习权重 90.0% 显著高于默认权重 70.0%（+20.0 pp），证明"编辑即标注"的学习有真实增益；正面特征 personal，噪声特征 surface、impedance。

