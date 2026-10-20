# 核心修改索引

- 改 HTTP/UI 接口：先改 `contracts.ts`，通知 UI 维护者；路由在 `server.ts`，禁止增加平行接口说明文件。
- 改审批、恢复、去重：读 `state.ts` 与 `executor.ts`。SQLite 写前记账是发送的授权边界，模型线程恢复不能代替它。
- 改模型工具：读 `codex.ts` 与 `discovery.ts`。线程 ID 校验与整次工具串行队列不可移到提示词；Codex 版本升级要重跑越权测试。
- 改站点交互：读 `boss.ts`、`browser.ts`、`cloak.ts`、`command.ts`。Cloak 官方 wrapper 在隔离环境里运行，不加载个人 key，不允许普通浏览器回退。岗位入口与已有会话身份已做只读核验；完整首批仅对方消息可判本方零消息；真正零记录、多页合并及真实发送未验，边界见 `../docs/architecture.md`。不把缺少元素当作「没有发送过」。
- 改输入保存：`resume.ts` 只做校验/解码，`state.ts` 把原始字节与输入/批准变更同事务落库；不能恢复分散上传或确认入口。本地文件不是 BOSS 站点附件。
- 改发现计时：SQLite 是状态与时间的唯一来源，stopping 不等于已经结束；在途工具结束前不能填写 finishedAt。
