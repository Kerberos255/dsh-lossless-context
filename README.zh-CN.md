# DSH 无损上下文（LCM）

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

为 DSH 原生上下文压缩增加**分层摘要、来源 DAG 和原文检索**。所谓“无损”是指**原始会话日志仍由 DSH 保存，且可追溯来源**，并不代表模型摘要永远不会遗漏细节。

## 主要功能

- 保留原生 Session Log，压缩提交与取消继续由 DSH 事务负责。
- 将选定旧上下文按事件与工具调用配对安全地拆成摘要叶，再合并成可检索的来源 DAG。
- 提供 `lcm_grep`、`lcm_describe`、`lcm_expand`；`lcm_expand` 已支持按检索词展开，不再单独提供旧的 `lcm_expand_query` 工具。
- 按实际模型上下文窗口、Token Meter、目标摘要长度与输出上限计算预算；超时、截断或模型失败采用有界处理，不提交不完整摘要。
- 可以空闲预生成摘要叶，不提前替换正式上下文。
- 可选在主人身份已核验、Dream 交接已完成后，自动轮转符合条件的 Discord/飞书私聊 Session。

## 任务后压缩与最近原文保留

默认叶摘要**输入**分块为 **24,000 Token**（并非模型输出上限）。只有成功且完整的叶摘要／合并摘要才缓存到本地派生 SQLite，最多保留 7 天、每会话 128 条、全局 512 条、单条 128 KiB。中途失败不会提交残缺压缩结果；之后重试或重启时，仅复用输入内容、模型和摘要策略完全相同的已完成摘要。单次摘要请求默认超时调整为 240 秒，给耗时较长但正常的合并摘要留出余量。


正常压力达到阈值后，等本轮任务结束且 Agent 空闲再执行正式 LCM 压缩；只有执行中即将达到上下文容量极限或供应商已返回溢出错误，才走紧急压缩。两条路径共享 `retainRatio` / `retainTokens` 和模型覆盖规则，例如阈值设为 0.5 时决定压缩时机，原文保留比例设为 0.16 时决定保留预算。

DSH RC.2 原生 `compactNow` 未开放保留预算参数。本插件附带一份 MIT 授权、基于当前官方实现的最小兼容扩展，仅增加该参数，并保留原生的 idle maintenance、工具调用配对、持久化事务、取消和安全写盘。未来升级 DSH 时需要重新核验，见 `native/SOURCE.md`。

传输故障和输出截断分别有限重试，摘要请求超时与输出预算可单独配置；单元测试通过不等于已完成真实模型压缩验收。

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
- 轮转保留旧历史和来源；失败后退避，避免每轮空闲时重复失败；任务中断、外部改动或身份冲突时保持原绑定。

配置模板：[config.example.json](config.example.json) · 测试：`npm test` · [变更记录](CHANGELOG.md) · [安全说明](SECURITY.md)。

相关：[Dream 与长期记忆](https://github.com/Kerberos255/dsh-memory-dreaming) · [Channel Core](https://github.com/Kerberos255/dsh-channel-core)。

许可证：[MIT](LICENSE)。

## 可编辑摘要质量提示词

叶摘要和合并摘要增加默认的内容保留要求，优先保留技术决策、精确路径、配置键、已验证结果及任务进度变化。设置页支持编辑与「恢复默认」。提示词仅补充 DSH 原生压缩规则，不改变工具配对、取消、原始记录保留与完整事务提交。改变摘要策略后不再复用过期的叶摘要缓存。
