# 核心修改索引

- 改 HTTP/UI 接口：先改 `contracts.ts`，通知 UI 维护者；路由在 `server.ts`，禁止增加平行接口说明文件。
- 改审批、恢复、去重：读 `state.ts` 与 `executor.ts`。SQLite 写前记账是发送的授权边界，模型线程恢复不能代替它。
- 改模型工具：读 `codex.ts` 与 `discovery.ts`。线程 ID 校验与整次工具串行队列不可移到提示词；Codex 版本升级要重跑越权测试。
- 改站点交互：读 `boss.ts`、`browser.ts`。当前真实登录后 DOM 未验证，不确定时停下，不把缺少元素当作「没有发送过」。
- 改上传：`resume.ts` 只保存本地文件，不能把它当作 BOSS 站点附件；上传与正文确认属于不同事实。
