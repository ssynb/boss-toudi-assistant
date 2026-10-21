# 核心修改索引

- 改 HTTP/UI 接口：先改 `contracts.ts`，通知 UI 维护者；路由在 `server.ts`，禁止增加平行接口说明文件。
- 改审批、恢复、去重：读 `state.ts` 与 `executor.ts`。SQLite 写前记账是发送的授权边界，模型线程恢复不能代替它。
- 改模型工具：读 `codex.ts`、`advisor.ts`、`search-plan.ts` 与 `discovery.ts`。动作原文只能来自最新用户消息，额度来自联系账本；模型回合正常结束才启动任务。线程 ID 校验与整次工具串行队列不可移到提示词；Codex 版本升级要重跑越权测试。
- 改站点交互：读 `boss.ts`、`boss-chat.ts`、`browser.ts`、`browser-responses.ts`、`cloak.ts`、`command.ts`。历史完成以绑定当前会话的成功响应为准，DOM 只核对当前身份与新到消息；观察失效不能沿用旧的零消息证明。Cloak 官方 wrapper 在隔离环境里运行，不加载个人 key、不回退普通 Chrome。真实核验范围与未验边界见 `../docs/architecture.md`。
- 改输入保存：`resume.ts` 只做校验/解码，`state.ts` 把原始字节与输入/批准变更同事务落库；不能恢复分散上传或确认入口。本地文件不是 BOSS 站点附件。
- 改发现计时：SQLite 是状态与时间的唯一来源，stopping 不等于已经结束；在途工具结束前不能填写 finishedAt。

- 改调研或求职对话：读 `research.ts`、`advisor.ts`、`model-task.ts`；方向逐项保存，模型只提交结果。任务互斥覆盖认证预检查，停止等在途读取结束；持久化与中断恢复归 `state.ts`。
