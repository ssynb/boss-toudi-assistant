# boss 投递助手

macOS / Windows 本地项目：用自己的 Codex 账号搜索 BOSS 直聘岗位、生成招呼草案，**整批核对批准后**才执行联系动作。

本地中文工作台已提供具体要求、简历和整批审批界面。**尚未完成真实账号端到端验收，不应视为可直接批量投递的成品。**

## 安装与启动

需要 Node.js **24.11.0 或更高版本**，推荐当前 Node 24 LTS。下载：[nodejs.org](https://nodejs.org/)。不需要 Docker、Python 或全局安装 Codex。

```sh
npm ci
npm run setup
npm start
```

打开终端显示的地址（默认 `http://127.0.0.1:4318`）。首次推送发布后，也可以把下面这句话复制给自己的 Codex：

> 请从 https://github.com/ssynb/boss-toudi-assistant 获取源码，阅读 AGENTS.md，检查 Node.js 至少为 24.11.0（不满足时先指导我从 Node 官方渠道安装），然后执行 npm ci、npm run setup、npm start 并告诉我本地访问地址；登录和验证码由我本人完成，不联系任何 HR。

`setup` 检查 Node、Codex、agent-browser、CloakBrowser 和数据目录。**唯一浏览器是 CloakBrowser**，agent-browser 只负责遥控；不探测、安装或回退到普通 Chrome，也不支持自定义可执行文件路径。

### CloakBrowser 安装与许可

固定使用官方 npm wrapper `cloakbrowser@0.6.3`。wrapper 是 MIT，**浏览器二进制是单独的专有许可**，不能把 MIT 当作二进制许可。请本人先阅读 [Binary License v1.3](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md)：dependency listing 允许终端用户从官方渠道直接下载；禁止二进制打包、再分发；latest major 的使用受厂商订阅要求约束。

本实现只接入不需要 key 的免费旧版；不获取 key、不付款、不使用用户全局 bbu 或 CloakBrowser 个人许可证。已有官方免费缓存可直接检查使用；缺失时 `npm run setup` 会明确失败，不自行下载或接受许可。

**仅当本人审阅并同意许可后**，手动运行：

macOS：
```sh
BOSS_CLOAK_LICENSE_ACCEPTED=1.3 npm run setup -- --install-cloak
```

Windows PowerShell：
```powershell
$env:BOSS_CLOAK_LICENSE_ACCEPTED = '1.3'
npm run setup -- --install-cloak
Remove-Item Env:BOSS_CLOAK_LICENSE_ACCEPTED
```

代理不得代填许可确认。官方 wrapper 负责下载、签名与归档校验；项目不打包二进制，也不上传到 CI 缓存或制品。安装后重新运行检查并启动。

| 平台 | 0.6.3 无 key 免费版基线 | 状态 |
|---|---|---|
| macOS arm64 / x64 | 145.0.7632.109.2 | 官方提供两个架构；本机仅 arm64 实测 |
| Windows x64 | 146.0.7680.177.5 | 官方提供，尚未真机/CI 验证 |
| Windows 原生 arm64 | 无 | 明确拒绝，不偷换 Chrome 或承诺 x64 仿真兼容 |

平台依据：[npm 0.6.3](https://www.npmjs.com/package/cloakbrowser/v/0.6.3) 的配置及官方 [145 发布资产](https://github.com/CloakHQ/cloakbrowser/releases/tag/chromium-v145.0.7632.109.2)、[146 发布资产](https://github.com/CloakHQ/cloakbrowser/releases/tag/chromium-v146.0.7680.177.5)。这些版本不是 latest，不能据此声称已获得最新安全更新或能绕过站点验证。

## 使用流程

1. 在本应用里登录 Codex：打开官方 ChatGPT 授权链接。凭据由 Codex 自己保存，应用不读取、复制或展示 `auth.json`。本应用与其他 Codex 客户端使用不同的登录目录，需要单独登录一次。
2. 在唯一的「具体要求」框写下求职要求，例如「上海前端，月薪至少25K，不考虑外包，最多10个」。不需要单独填写姓名、城市或薪资字段。AI 从这段文字提取本轮搜索条件；缺少岗位方向、城市或薪资要求（可明确写不限）时，先显示澄清问题，请仍在这个框补充、保存并重新开始。澄清不要求先登录 BOSS，实际搜索前才需要。
3. 选择本地简历（txt / md / pdf / docx，≤10 MB），和具体要求一起点击一次「保存」。选择、替换或删除文件都先留在本地草稿，未保存不会改变已保存资料或批准。txt/md 保存时自动读取 UTF-8 正文；当前不能自动解析 pdf/docx，请在同一次保存中补充正文。保存即确认用于匹配的输入，没有独立一致性勾选。任一校验或存储失败则全部保持原状。
4. 打开应用专属 CloakBrowser，在 BOSS 上本人登录、完成验证码或实名验证。使用新的 cloak-profile，不复用或导入旧普通浏览器的登录态。不会接管日常浏览器，不绕过风控。
5. 使用同一个按钮开始或停止发现。耗时由服务端开始/结束时间计算，停止后保留，刷新不会重置；「正在停止」期间任务尚未结束，计时仍继续。AI 读取每个候选岗位的实际 JD，结合已保存简历生成理由与招呼，不凭卡片标题编造经历；无法取得 JD 的岗位不进入草案。核对整批目标和每条招呼原文。可以改稿、移除目标，然后批准当前版本。
6. 开始执行。暂停后不再开始新的外部步骤；已经发出的内容不会撤回。

### 本地简历 ≠ BOSS 附件简历

上传到本应用的文件只用于匹配岗位，不会自动上传到 BOSS。

默认**不发简历**。开启发简历时，须填写并确认 BOSS 上已有附件的文件名，连同整批目标一起批准。当前真实站点的发简历入口是否直接发送尚未验证，因此适配器不会自动点击这个入口；只有已经显示、能核对附件名的确认对话框才可能继续。完整附件发送流程仍待受授权的真实账号验证。

### 状态与防重

- 「立即沟通」可能触发站点自动招呼，**也必须批准后才能点**。
- 打开会话、发送招呼、发送简历分别记录，不把打开会话称作已投简历。
- 已联系过或结果未确认的岗位不会再次联系。
- 每个外部步骤先记账，再操作；崩溃时进行中的步骤重启后变为「未确认」，不自动重试。
- 成功保存具体要求/简历，或修改招呼与 BOSS 附件设置，会使旧批准失效；仅选择文件、编辑尚未保存的内容或保存失败不会改变批准。执行中禁止保存；发现及正在停止期间也禁止保存。
- 联系完成时，将已核实的岗位、招聘者身份与联系账本同事务保存。重启后，先只读核对当前会话，再继续尚未开始的招呼或附件步骤，不重复联系。
- 当前会话不是原岗位/招聘者时，剩余步骤保持待执行；请在 BOSS 切回原目标会话，再点击继续。旧记录若缺少已核实身份，会明确提示不能自动继续，请本人到 BOSS 核对并手动完成剩余步骤，不要重新联系。
- 页面结构、当前会话对象或发送结果无法核实时停止，不猜测成功；「未确认」步骤仍然不自动重试。
- 草案版本跨批次递增，旧页面的批准不能授权新批次；附件按完整文件名精确核对，不能用正文包含某个文件名代替。

## 数据与配置

数据只保存在本机，不进入 Git：

| 系统 | 默认目录 |
|---|---|
| macOS | `~/Library/Application Support/boss-toudi-assistant` |
| Windows | `%APPDATA%\boss-toudi-assistant` |

具体要求是唯一持久化的可编辑求职条件；AI 提取结果只用于本轮，不另存一套配置。旧版资料/分散条件入口删除，简历原始字节、匹配正文与联系账本保留，旧条件的批准失效。

具体要求、简历原始字节/正文、发现时间与联系账本统一存于本机 SQLite，原始简历不另存散文件，因此可以在同一事务中保存或删除。旧版磁盘简历先校验并迁入数据库，再清理旧文件；清理失败会明确阻止启动，保留恢复标记，下次启动重试，不丢原始字节。

数据目录还包含专属浏览器登录态和独立 Codex 登录。**不要提交、上传或分享这个目录**。模型匹配需要将具体要求、已保存的简历正文、岗位 JD 发送给用户登录的 Codex 服务，本地存储不等于离线推理。

可选环境变量：`PORT` 更改端口；`BOSS_DATA_DIR` 指定数据目录。不要把数据目录设置在仓库内。CloakBrowser 二进制缓存独立放在 `~/.boss-toudi-assistant/cloakbrowser`，多个独立 profile 共用只读二进制；也可只读使用 `~/.cloakbrowser` 中相应免费旧版的官方二进制，但不读取那里的 key、配置或个人 profile。

服务仅监听回环地址，检查 Host、Origin、浏览器请求来源与专用请求头，不提供跨域访问。它不防御本机同一用户权限下的恶意程序。

## 验证范围

```sh
npm run check
```

测试包含真实 Codex app-server 进程连接本地假模型、真实 CloakBrowser + agent-browser 在本地页完成快照、填入、点击并核实实际可执行路径、HTTP 安全边界、原子保存及真实数据库/文件失败恢复、持久计时、批准失效、暂停与崩溃去重；**不消耗真实模型额度，不联系任何 HR**。

已在 macOS arm64 + Node 24.11.0 / 26.9.0 运行。Windows CI 配置会实际运行同一套测试（包括 Codex 与 CloakBrowser），但当前尚未推送触发 CI，不能声称 Windows 已验证。仓库所有者需先审阅许可并把仓库变量 `CLOAK_BINARY_LICENSE_ACCEPTED` 设置为 `1.3`，CI 才能下载官方二进制；未确认则失败，不跳过冒烟假装通过。CI 也不替代 Windows 用户桌面登录测试。

真实 BOSS 只读访问遇到安全验证，未由代理完成验证。登录后的岗位/聊天 DOM、真实模型调用、真实发送均待本人登录及明确授权测试目标后验收。

## Codex 接入与许可

固定使用 `@openai/codex@0.163.0` 的 app-server，属于官方标注的 experimental 接口；不承诺长期兼容或官方生产支持。应用只给模型提取本轮计划、请求澄清、搜索、读详情和提交草案等受控工具，外部写操作由应用执行器处理。命令、文件修改、权限申请等模型审批请求全部拒绝。

[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server.md) 写明 “The app-server command and WebSocket transport are experimental and aren't supported for production workloads.” 认证章节还写明已有 local/open-source 应用可继续使用，推荐迁移到 Sign in with ChatGPT，并明确 “App-server authentication has never been permitted for commercial or hosted services.” 这些是上游原文约束，不构成本项目对具体商业场景的法律判断。ChatGPT 登录不是通用 API key，不承诺套餐额度与模型可用性。

本项目源代码 MIT。Codex 和 agent-browser 各自为 Apache-2.0；CloakBrowser wrapper 为 MIT、二进制遵守上述单独条款。依赖许可不会因本项目采用 MIT 而改变。

开发接口与模块索引见 [AGENTS.md](AGENTS.md)。

新增依赖的理由：agent-browser 不提供 CloakBrowser 二进制、官方签名校验与指纹参数；标准库也没有厂商的版本/校验协议。复用官方 wrapper 及其 tar 依赖，不另引 Playwright/Puppeteer，不自写二进制下载器。
