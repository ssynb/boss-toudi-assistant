# boss 投递助手

macOS / Windows 本地项目：用自己的 Codex 账号搜索 BOSS 直聘岗位、生成招呼草案，**整批核对批准后**才执行联系动作。

当前后端已实现，界面由 `public/` 单独开发。**尚未完成真实账号端到端验收，不应视为可直接批量投递的成品。** 没有 `public/index.html` 时首页会提示界面未就绪。

## 安装与启动

需要 Node.js **24.11.0 或更高版本**，推荐当前 Node 24 LTS。下载：[nodejs.org](https://nodejs.org/)。不需要 Docker、Python 或全局安装 Codex。

```sh
npm ci
npm run setup
npm start
```

打开终端显示的地址（默认 `http://127.0.0.1:4318`）。也可以让自己的 Codex 读取本仓库的 `AGENTS.md` 后执行以上命令。

`setup` 检查 Node、Codex、agent-browser、浏览器和数据目录。没有可用 Chrome 时，会用 agent-browser 从官方渠道下载 Chrome for Testing。项目不下载或打包 CloakBrowser。

## 使用流程

1. 在本应用里登录 Codex：打开官方 ChatGPT 授权链接。凭据由 Codex 自己保存，应用不读取、复制或展示 `auth.json`。本应用与其他 Codex 客户端使用不同的登录目录，需要单独登录一次。
2. 填写资料、城市、岗位关键词、薪资下限和目标数量。
3. 上传本地简历（txt / md / pdf / docx，≤10 MB）。txt/md 自动读取 UTF-8 正文；pdf/docx 先安全保存原文件，**请另行粘贴正文并确认与简历一致**。不自动解析 PDF 或 Word，不执行文件内容。
4. 打开应用专属浏览器，在 BOSS 上本人登录、完成验证码或实名验证。不会接管日常 Chrome，不绕过风控。
5. 开始发现，核对整批目标和每条招呼原文。可以改稿、移除目标，然后批准当前版本。
6. 开始执行。暂停后不再开始新的外部步骤；已经发出的内容不会撤回。

### 本地简历 ≠ BOSS 附件简历

上传到本应用的文件只用于匹配岗位，不会自动上传到 BOSS。

默认**不发简历**。开启发简历时，须填写并确认 BOSS 上已有附件的文件名，连同整批目标一起批准。当前真实站点的发简历入口是否直接发送尚未验证，因此适配器不会自动点击这个入口；只有已经显示、能核对附件名的确认对话框才可能继续。完整附件发送流程仍待受授权的真实账号验证。

### 状态与防重

- 「立即沟通」可能触发站点自动招呼，**也必须批准后才能点**。
- 打开会话、发送招呼、发送简历分别记录，不把打开会话称作已投简历。
- 已联系过或结果未确认的岗位不会再次联系。
- 每个外部步骤先记账，再操作；崩溃时进行中的步骤重启后变为「未确认」，不自动重试。
- 修改资料、条件、简历、招呼或附件设置会使旧批准失效。执行中禁止修改；发现期间也需先停止再修改。
- 页面结构、当前会话对象或发送结果无法核实时停止，不猜测成功。

## 数据与配置

数据只保存在本机，不进入 Git：

| 系统 | 默认目录 |
|---|---|
| macOS | `~/Library/Application Support/boss-toudi-assistant` |
| Windows | `%APPDATA%\boss-toudi-assistant` |

目录包含求职资料、简历文件、联系账本、专属浏览器登录态和独立 Codex 登录。**不要提交、上传或分享这个目录**。模型匹配需要将已确认的简历正文、岗位文本发送给用户登录的 Codex 服务，本地存储不等于离线推理。

可选环境变量：`PORT` 更改端口；`BOSS_DATA_DIR` 指定数据目录；`BOSS_BROWSER_PATH` 指定浏览器可执行文件（不承诺第三方浏览器兼容性）。不要把数据目录设置在仓库内。

服务仅监听回环地址，检查 Host、Origin、浏览器请求来源与专用请求头，不提供跨域访问。它不防御本机同一用户权限下的恶意程序。

## 验证范围

```sh
npm run check
```

测试包含真实 Codex app-server 进程连接本地假模型、真实 Chrome 打开本地页面、HTTP 安全边界、上传、批准失效、暂停与崩溃去重；**不消耗真实模型额度，不联系任何 HR**。

已在 macOS arm64 + Node 24.11.0 / 26.9.0 运行。Windows CI 配置会实际运行同一套测试（包括 Codex 与 Chrome），但当前尚未推送触发 CI，不能声称 Windows 已验证。CI 也不替代 Windows 用户桌面登录测试。

真实 BOSS 只读访问遇到安全验证，未由代理完成验证。登录后的岗位/聊天 DOM、真实模型调用、真实发送均待本人登录及明确授权测试目标后验收。

## Codex 接入与许可

固定使用 `@openai/codex@0.163.0` 的 app-server，属于官方标注的 experimental 接口；不承诺长期兼容或官方生产支持。应用只给模型搜索、读详情、提交草案三个受控工具，外部写操作由应用执行器处理。命令、文件修改、权限申请等模型审批请求全部拒绝。

[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server.md) 写明 “The app-server command and WebSocket transport are experimental and aren't supported for production workloads.” 认证章节还写明已有 local/open-source 应用可继续使用，推荐迁移到 Sign in with ChatGPT，并明确 “App-server authentication has never been permitted for commercial or hosted services.” 这些是上游原文约束，不构成本项目对具体商业场景的法律判断。ChatGPT 登录不是通用 API key，不承诺套餐额度与模型可用性。

本项目源代码 MIT。Codex 和 agent-browser 各自为 Apache-2.0；Chrome 下载遵守其自身条款。依赖许可不会因本项目采用 MIT 而改变。

开发接口与模块索引见 [AGENTS.md](AGENTS.md)。
