# 开发入口

- 前后端接口只改 `src/contracts.ts`，没有独立的 API 文档镜像。`public/` 由 UI 维护者独占；后端维护者不改该目录。
- 后端职责与验收边界见 [docs/architecture.md](docs/architecture.md)；修改核心时读 [src/AGENTS.md](src/AGENTS.md)，修改测试时读 [test/AGENTS.md](test/AGENTS.md)。
- `npm ci` 安装，`npm run setup` 检查环境/安装 Chrome，`npm start` 启动；`npm run typecheck` 与 `npm test` 验证。
- Node 原生执行 TypeScript，不生成 JS，不增加前端打包器；只写可擦除 TS 语法。

# 不可越过的边界

模型只能搜索、读详情和提交草案，不能获得通用浏览器动作或 shell。所有联系动作（包括可能自动招呼的「立即沟通」）都由执行器在批次获批后执行。未知结果不重试，崩溃恢复以 SQLite 账本为准，不以模型会话为准。

真实 BOSS 测试限只读；验证码/实名由用户本人完成。真实联系须另外明确批准测试目标。不要读取或复制用户的 auth.json，也不要输出凭据。调查材料 `.research/` 不入库。不要把其他项目的实现或个人数据复制到本仓库。

当前验收测试锁：`9519043` 的 `test/`，以及 `9860e67` 的暂停边界测试。需求未变时不得修改这些断言使实现过关。
