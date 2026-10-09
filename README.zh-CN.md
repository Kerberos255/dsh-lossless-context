# DSH 无损上下文（LCM）

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

为 DSH 原生上下文压缩增加**分层摘要、来源 DAG 和原文检索**。所谓“无损”是指**原始会话日志仍由 DSH 保存，且可追溯来源**，并不代表模型摘要永远不会遗漏细节。

## 主要功能

- 保留原生 Session Log，压缩提交与取消继续由 DSH 事务负责。
- 将选定旧上下文按事件与工具调用配对安全地拆成摘要叶，再合并成可检索的来源 DAG。
- 提供 `lcm_grep`、`lcm_describe`、`lcm_expand`、`lcm_expand_query`，按当前会话范围检索和展开原文。
- 使用实际模型的上下文窗口、Token Meter 与输出上限计算预算；截断仅有界重试，失败不提交不完整摘要。
- 可以空闲预生成摘要叶，不提前替换正式上下文。
- 可选在主人身份已核验、Dream 交接已完成后，自动轮转符合条件的 Discord/飞书私聊 Session。

## 安装与启用

依赖 DSH 原生 Agent、Session、压缩和模型服务，具体要求见 [package.json](package.json)。

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-lossless-context
```

在「设置 → 插件 → 无损上下文」启用后，**还需将目标 Agent 预设的压缩后端选为 `dsh-lossless-context/agent`**；其他预设不会被自动改写。更新插件代码或切换预设组成后重启相应客户端或会话。

## 工作流程

```text
DSH 原生 Session 事件
    ↓ 原生压缩引擎选择旧上下文
分块叶摘要 → 多层合并 → 来源 DAG
    ↓ 只有原生提交成功才应用摘要
当前会话压缩检查点 + 可追溯来源索引
    ↓
lcm_grep / expand 按序号还原相关原文
```

索引保存摘要、来源事件序号和检索词，不额外维护完整聊天历史副本。修改配置会使当前复用缓存失效；原始历史仍在 DSH。

## 模型、轮转及安全边界

- 关闭 LCM 时回退原生 Basic 压缩；关闭自动压缩不阻止用户手动执行官方 compact。
- 预算由当前模型能力决定；模型元数据缺失会拒绝猜测，摘要超过上限或取消时不删除输入。
- 复用已完成的摘要叶可减少重复计算，但真实耗时与质量要用实际模型测试；单靠合成事件 benchmark 无法证明压缩质量。
- 自动轮转仅针对通过 Channel Core 主人核验的私聊，并要求 Dream 完成可校验交接。桌面、群聊、身份不明或有待处理消息的 Session 不会被擅自切换。
- 轮转保留旧历史和来源；任务中断、外部改动或身份冲突时保持原绑定。

配置模板：[config.example.json](config.example.json) · 测试：`npm test` · [变更记录](CHANGELOG.md) · [安全说明](SECURITY.md)。

相关：[Dream 与长期记忆](https://github.com/Kerberos255/dsh-memory-dreaming) · [Channel Core](https://github.com/Kerberos255/dsh-channel-core)。

许可证：[MIT](LICENSE)。
