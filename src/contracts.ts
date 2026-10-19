/**
 * 前后端合同的唯一事实源：public/ 的 UI 只依赖本文件描述的 HTTP 接口与数据形状。
 * 本文件只含类型与常量，Node 可直接加载；改动它即改动合同，需同步通知 UI 维护者。
 *
 * 传输约定
 * - 服务只监听 127.0.0.1。UI 由同一服务静态托管，所有请求用相对路径（如 `/api/state`）。
 * - 每个 /api 请求（含 GET 与事件流）都必须带请求头 `X-Boss-Local: 1`；
 *   服务同时校验 Host 与 Origin，不返回任何 CORS 头。浏览器的 EventSource 不能带自定义头，
 *   因此事件流用 `fetch()` 读取响应体流（text/event-stream 格式）。
 * - JSON 请求体 `Content-Type: application/json`。失败统一返回 `ApiError` 与 4xx/5xx。
 */

export const LOCAL_HEADER = 'x-boss-local';
export const LOCAL_HEADER_VALUE = '1';

/** 定制招呼每段上限（字）。 */
export const GREETING_MAX_CHARS = 200;
/** 简历文件上限（字节）。 */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
/** 允许上传的简历扩展名；txt/md 自动读取正文，pdf/docx 只保存文件，正文由用户粘贴并确认。 */
export const RESUME_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'] as const;
export type ResumeExtension = (typeof RESUME_EXTENSIONS)[number];

export type ErrorCode =
  | 'bad_request'
  | 'forbidden' // Host/Origin/X-Boss-Local 校验未通过
  | 'not_found'
  | 'batch_running' // 批次执行中，禁止修改具体要求、简历、批次或开始新的发现
  | 'stale_version' // 批准时提交的 version 与当前批次不符
  | 'not_approvable' // 批次不满足批准条件（无目标、简历投递未确认等）
  | 'not_startable' // 批次未处于有效批准状态
  | 'resume_unconfirmed' // 发现前需要已确认的简历正文
  | 'codex_signed_out'
  | 'browser_not_ready' // 浏览器未打开或停在登录/安全验证页
  | 'busy' // 已有发现任务在运行
  | 'file_too_large'
  | 'unsupported_file'
  | 'internal';

export interface ApiError {
  error: { code: ErrorCode; message: string };
}

// ---------- 读：GET /api/state 返回 AppState ----------

export interface AppState {
  doctor: DoctorCheck[];
  codex: CodexState;
  browser: BrowserState;
  /** 唯一可编辑求职要求，AI 提取结果仅用于本轮发现。 */
  requirements: string;
  resume: ResumeState;
  discovery: DiscoveryState;
  /** 当前批次；从未发现过时为 null。新的发现会替换非执行中的批次，已联系记录另行保存不丢失。 */
  batch: Batch | null;
  /** 历史上已联系或结果未确认的岗位数（全局去重账本），发现时自动排除。 */
  contactedCount: number;
}

export interface DoctorCheck {
  id: 'node' | 'codex' | 'agentBrowser' | 'browser' | 'dataDir';
  ok: boolean;
  detail: string;
}

export interface CodexState {
  /** 本应用独立 Codex 目录下是否已用 ChatGPT 账号登录；与用户其他 Codex 客户端的登录互不共享。 */
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** 登录进行中时给出官方授权链接，UI 让用户在系统浏览器中打开。 */
  pendingLoginUrl: string | null;
  error: string | null;
}

export type BrowserPage =
  | 'closed' // 浏览器未打开
  | 'unknown'
  | 'loggedOut' // BOSS 登录页或未登录
  | 'verify' // BOSS 安全验证/验证码页：用户本人在浏览器窗口完成
  | 'ready'; // 已登录且不在验证页

export interface BrowserState {
  page: BrowserPage;
  url: string | null;
}

export interface ResumeFileMeta {
  fileName: string;
  extension: ResumeExtension;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

/**
 * 本地简历。只用于让模型判断岗位匹配和写招呼语；它不会被上传到 BOSS，
 * 也不是 BOSS 上的「附件简历」（见 ResumeDelivery）。
 */
export interface ResumeState {
  /** 本地保存的原始文件元数据；未上传为 null。文件保存在本机数据目录，不入 Git。 */
  file: ResumeFileMeta | null;
  /** 交给模型的简历正文。txt/md 上传后自动填入；pdf/docx 需用户粘贴。 */
  text: string;
  textSource: 'file' | 'pasted' | null;
  /** 用户已确认 text 与自己的简历一致；未确认不能开始发现。 */
  textConfirmed: boolean;
}

export interface DiscoveryState {
  /** 缺关键条件时的问题；在同一个具体要求框补充并保存后清除，再重新开始发现。 */
  questions: string[];
  status: 'idle' | 'running' | 'stopping';
  /** 最近一次发现的结果或失败原因（人话）。 */
  message: string | null;
}

// ---------- 批次与执行账本 ----------

/**
 * draft     草案：可编辑，未批准，执行器不会做任何联系动作。
 * approved  已批准：批准绑定 version；之后任何改稿、具体要求/简历/附件设置的修改都会退回 draft。
 * running   执行中：拒绝一切修改（batch_running）。
 * paused    已暂停：用户暂停，或遇到登录/验证/结果未确认而自动停下；批准仍有效时可继续，修改则退回 draft。
 * done      全部目标处理完毕。
 */
export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'done';

/**
 * todo      未开始
 * inflight  正在进行（已先记账再动手）；进程意外退出后重启会变为 unknown
 * done      已在页面上核实完成
 * skipped   不需要做（如站点已自动发出默认招呼、此前已联系过、未批准发简历）
 * failed    已核实没有发生（如找不到按钮、附件名不符而未点确认），可在新批次重新批准后再试
 * unknown   结果无法核实：永不自动重试，需用户自己去 BOSS 查看
 */
export type StepState = 'todo' | 'inflight' | 'done' | 'skipped' | 'failed' | 'unknown';

export interface TargetSteps {
  /** 点「立即沟通」打开会话。站点可能因此自动发送默认招呼语，所以它本身就算联系 HR。 */
  contact: StepState;
  /** 发送本目标的定制招呼原文；站点已自动发出招呼时为 skipped。 */
  greeting: StepState;
  /** 在会话页点「发简历」发送 BOSS 上已有的附件简历；未批准发简历时为 skipped。 */
  resume: StepState;
}

/** 已从岗位页取得并在目标会话核实的身份；与联系完成状态同事务保存。 */
export interface ContactIdentity {
  jobId: string;
  recruiterUrl: string;
}

export interface Target {
  /** 老记录可能缺失；缺失时禁止恢复发送，不能用当前页面反推原批准对象。 */
  contactIdentity?: ContactIdentity;
  id: string;
  /** BOSS 岗位 id，全局去重键。 */
  jobId: string;
  /** 以下四项取自 BOSS 页面，不由模型编写。 */
  company: string;
  title: string;
  salary: string;
  url: string;
  /** 模型给出的匹配理由。 */
  reason: string;
  /** 将发送的定制招呼原文，逐字发送，≤ GREETING_MAX_CHARS。 */
  greeting: string;
  /** 用户从本批移除；移除的目标不执行。 */
  removed: boolean;
  steps: TargetSteps;
  /** 最近一步的页面证据或失败原话。 */
  evidence: string;
  updatedAt: string;
}

/**
 * 发简历设置。默认不发。发送的是用户在 BOSS 网站上已有的「附件简历」，
 * 不是本地上传的文件；开启前用户须填写 BOSS 上显示的附件名并勾选确认。
 * 执行时在 BOSS 的发简历对话框里核对附件名，不一致则不发送（该步骤记为 failed）。
 */
export interface ResumeDelivery {
  enabled: boolean;
  /** BOSS 网站「附件简历」列表里显示的文件名。 */
  bossAttachmentName: string;
  /** 用户确认：已在 BOSS 上核对，要发送的是这个站点附件。修改附件名会清除确认。 */
  bossAttachmentConfirmed: boolean;
}

export interface Batch {
  id: string;
  /** 在当前数据库内跨批次单调递增；替换批次或修改时 +1，批准时必须提交当前 version。 */
  version: number;
  status: BatchStatus;
  resumeDelivery: ResumeDelivery;
  targets: Target[];
  /** 自动暂停的原因（人话）；用户暂停或正常时为 null。 */
  stopReason: string | null;
  createdAt: string;
}

// ---------- 写接口（请求体类型；成功均返回最新 AppState） ----------

/**
 * POST /api/codex/login            无体；开始 ChatGPT 登录，结果见 codex.pendingLoginUrl
 * POST /api/codex/logout           无体
 * PUT  /api/requirements           RequirementsRequest（替代 profile/criteria，旧接口删除）
 * POST /api/resume/file            原始文件字节作请求体；请求头 X-File-Name 为 encodeURIComponent(文件名)
 * PUT  /api/resume/text            ResumeTextRequest
 * DELETE /api/resume               删除本地简历文件与正文
 * POST /api/browser/open           打开本应用独立 profile 的浏览器到 BOSS（用户自行登录/验证）
 * POST /api/discovery/start        需：Codex 已登录、简历已确认、浏览器 ready、批次不在执行
 * POST /api/discovery/stop
 * PATCH /api/batch                 BatchPatch
 * PATCH /api/batch/targets/:id     TargetPatch
 * POST /api/batch/approve          ApproveRequest
 * POST /api/batch/start            从 approved 或仍有效批准的 paused 开始/继续
 * POST /api/batch/pause            当前 inflight 步骤收尾后停下，不再开始新动作
 *
 * 具体要求、简历、批次的任何修改：批次 running 时返回 batch_running；
 * 否则若批次为 approved/paused，状态退回 draft、version +1（旧批准失效）。
 */
export interface RequirementsRequest {
  /** 具体要求自由文本，最多 10000 字；空白可以保存，发现时须补充。 */
  text: string;
}

export interface ResumeTextRequest {
  text: string;
  /** 用户勾选「这段文字与我的简历一致」。 */
  confirmed: boolean;
}

export interface BatchPatch {
  resumeDelivery?: Partial<ResumeDelivery>;
}

export interface TargetPatch {
  greeting?: string;
  removed?: boolean;
}

export interface ApproveRequest {
  version: number;
}

// ---------- 事件：GET /api/events（fetch 读取，text/event-stream） ----------

/** `event: changed` 无数据，UI 收到后重新 GET /api/state；`event: log` 数据为 LogEvent。 */
export type EventName = 'changed' | 'log';

export interface LogEvent {
  at: string;
  text: string;
}
