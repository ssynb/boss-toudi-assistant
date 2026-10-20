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

/** 每批目标上限，与 BOSS 每日主动沟通上限一致；用户在具体要求里写数量，AI 提取时不超过它。 */
export const MAX_BATCH_TARGETS = 150;
/** 定制招呼每段上限（字）。 */
export const GREETING_MAX_CHARS = 200;
/** 简历文件上限（字节）。 */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
/** 允许上传的简历扩展名；txt/md 自动读取正文，无法解析的 pdf/docx 由用户补充正文，统一保存即确认。 */
export const RESUME_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'] as const;
export type ResumeExtension = (typeof RESUME_EXTENSIONS)[number];

export type ErrorCode =
  | 'bad_request'
  | 'forbidden' // Host/Origin/X-Boss-Local 校验未通过
  | 'not_found'
  | 'batch_running' // 批次执行中，禁止修改具体要求、简历、批次或开始新的发现
  | 'stale_version' // 批准时提交的 version 与当前批次不符
  | 'not_approvable' // 批次不满足批准条件（如没有保留目标）
  | 'not_startable' // 批次未处于有效批准状态
  | 'inputs_incomplete' // 保存缺少无法解析文件的正文，或发现前缺少具体要求/有效简历正文
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
 * 本地简历。只用于让模型判断岗位匹配和写招呼语；它不会被上传到 BOSS。
 * BOSS 附件简历要等双方沟通后由用户本人在站点发送，本应用不发附件。
 */
export interface ResumeState {
  /** 本地保存的原始文件元数据；未上传为 null。文件保存在本机数据目录，不入 Git。 */
  file: ResumeFileMeta | null;
  /** 上次统一保存的匹配正文。txt/md 保存时自动读取；无法解析的 pdf/docx 需用户补充。 */
  text: string;
  textSource: 'file' | 'pasted' | null;
}

/**
 * 发现区只需一个操作按钮：idle 时开始，running 时停止，stopping 时禁用并等待结束事件。
 * 耗时 = (finishedAt ?? 当前时间) - startedAt；没有 startedAt 时不显示。
 * 时间随服务端状态持久化，刷新/重新连接不会重置；服务重启发现未终结任务时标记 idle、中断原因，
 * finishedAt 记为检测到中断的恢复时间，而不是声称已知实际崩溃时刻。
 * UI 可用本地定时器更新显示，不向后端轮询计时；状态变更仍由现有 SSE 通知。
 */

export interface DiscoveryState {
  /** 后端记录的本轮开始时间（ISO 8601），从未开始为 null；接受新的开始请求才更新，校验失败不改变。 */
  startedAt: string | null;
  /** 后端记录的结束时间（ISO 8601）；运行/正在停止时为 null，完成、停止或失败后固定保留。 */
  finishedAt: string | null;
  /** 缺关键条件时的问题；在同一个具体要求框补充并保存后清除，再重新开始发现。 */
  questions: string[];
  status: 'idle' | 'running' | 'stopping';
  /** 本轮是否自动投递：发现生成草案后立即视为已批准并执行，不经人工审核。 */
  autoSend: boolean;
  /** 最近一次发现的结果或失败原因（人话）。 */
  message: string | null;
}

// ---------- 批次与执行账本 ----------

/**
 * draft     草案：可编辑，未批准，执行器不会做任何联系动作。
 * approved  已批准：批准绑定 version；之后任何改稿、具体要求/简历的修改都会退回 draft。
 * running   执行中：拒绝一切修改（batch_running）。
 * paused    已暂停：用户暂停，或遇到登录/验证/结果未确认而自动停下；批准仍有效时可继续，修改则退回 draft。
 * done      全部目标处理完毕。
 */
export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'done';

/**
 * todo      未开始
 * inflight  正在进行（已先记账再动手）；进程意外退出后重启会变为 unknown
 * done      已在页面上核实完成
 * skipped   不需要做（如站点已自动发出默认招呼、此前已联系过）
 * failed    已核实没有发生（如找不到沟通按钮），可在新批次重新批准后再试
 * unknown   结果无法核实：永不自动重试，需用户自己去 BOSS 查看
 */
export type StepState = 'todo' | 'inflight' | 'done' | 'skipped' | 'failed' | 'unknown';

export interface TargetSteps {
  /** 点「立即沟通」打开会话。站点可能因此自动发送默认招呼语，所以它本身就算联系 HR。 */
  contact: StepState;
  /** 发送本目标的定制招呼原文；站点已自动发出招呼时为 skipped。 */
  greeting: StepState;
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
  /** 用户从本批移除；移除的目标不执行，UI 不再列出。 */
  removed: boolean;
  steps: TargetSteps;
  /** 最近一步的页面证据或失败原话。 */
  evidence: string;
  updatedAt: string;
}

export interface Batch {
  id: string;
  /** 在当前数据库内跨批次单调递增；替换批次或修改时 +1，批准时必须提交当前 version。 */
  version: number;
  status: BatchStatus;
  targets: Target[];
  /** 自动暂停的原因（人话）；用户暂停或正常时为 null。 */
  stopReason: string | null;
  createdAt: string;
}

// ---------- 写接口（请求体类型；成功均返回最新 AppState） ----------

/**
 * POST /api/codex/login            无体；开始 ChatGPT 登录，结果见 codex.pendingLoginUrl
 * POST /api/codex/logout           无体
 * PUT  /api/inputs                 SaveInputsRequest：唯一资料保存入口，成功返回最新 AppState
 *                                 删除旧 /api/requirements、/api/resume/file、/api/resume/text、DELETE /api/resume，不保留兼容写入口
 * POST /api/browser/open           打开本应用独立 profile 的浏览器到 BOSS（用户自行登录/验证）
 * POST /api/discovery/start        StartDiscoveryRequest（可省略请求体，即不自动投递）；需：Codex 已登录、已保存的简历正文/具体要求非空、批次不在执行；实际搜索前才要求浏览器 ready
 * POST /api/discovery/stop
 * PATCH /api/batch/targets/:id     TargetPatch
 * POST /api/batch/approve          ApproveRequest
 * POST /api/batch/start            从 approved 或仍有效批准的 paused 开始/继续
 * POST /api/batch/pause            当前 inflight 步骤收尾后停下，不再开始新动作
 *
 * 具体要求、简历、批次的任何修改：批次 running 时返回 batch_running；
 * 否则若批次为 approved/paused，状态退回 draft、version +1（旧批准失效）。
 */
/**
 * 统一保存：文件选择、编辑正文和删除文件仅改变 UI 本地草稿，不调用任何上传/删除接口。
 * 点击一次保存才提交本请求，保存即确认这些输入可用于匹配，没有独立确认勾选或接口。
 *
 * requirements、简历文件/正文/元数据与旧批准失效必须原子生效；任一校验或存储失败则全部保持原样。
 * 批次 running 返回 batch_running，发现 running/stopping 返回 busy，均不得修改任何已保存数据或批准。
 * 成功清除澄清问题，使未完成批次的旧批准失效并递增一次版本；不改变上轮发现时间。
 * 保存不是对外投递批准；整批批准仍是独立安全步骤。
 */
export interface SaveInputsRequest {
  /** 唯一具体要求自由文本，最多 10000 字；可保存空草稿，但开始发现前必须非空。 */
  requirements: string;
  resume: {
    /**
     * 省略：保留已保存文件；null：删除已保存文件；对象：用本次文件替换。
     * 无论哪种操作，旧文件在整个提交成功前始终有效；文件与正文不会分两次提交。
     */
    file?: { fileName: string; base64: string } | null;
    /**
     * string：使用用户提供的正文（最多 50000 字），不能沿用未审阅的新文件对应旧正文。
     * null：替换 txt/md 时自动读 UTF-8 正文；保留文件时保留原正文；删除文件时也删除正文。
     * 替换无法解析的 pdf/docx 时必须提供非空正文，否则整次保存返回 inputs_incomplete。
     * 文件存在但没有有效正文时保存失败；无文件可保存空正文，但不能开始发现。
     * 新选 txt/md 的 UI 默认传 null，无需用户手抄或额外确认；新选 pdf/docx 不自动携带旧文件的正文。
     */
    text: string | null;
  };
}

/** base64 只接受标准 RFC 4648 编码（含所需填充），不含 data: URL 前缀；解码后上限 RESUME_MAX_BYTES。 */
export const INPUTS_MAX_BYTES = 4 * Math.ceil(RESUME_MAX_BYTES / 3) + 512 * 1024;

/**
 * autoSend=true：点击开始即批准本轮 AI 生成的整批草案，发现结束后立即执行联系与招呼，不再停下审核。
 * 停止发现、需要澄清或没有生成草案时不会执行；执行中仍可暂停，遇到验证/登录/结果未确认照常停下。
 */
export interface StartDiscoveryRequest {
  autoSend: boolean;
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
