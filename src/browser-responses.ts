/**
 * 只读观察单个标签页对某个接口的响应：经 CDP 订阅网络事件，只取正文，不发起或改写请求。
 * URL 与正文只留在内存里交给调用方，错误信息不带 URL，避免把查询参数里的凭据写进日志。
 */

const TIMEOUT_MS = 15_000;
const QUEUE_LIMIT = 100;
const CLOSED = '响应观察已关闭';
const DISCONNECTED = '浏览器页面已断开，响应观察结束';

export type ResponseObservation =
  | { kind: 'response'; revision: number; url: string; status: number; body: unknown }
  | { kind: 'failed'; revision: number; url: string; error: string };

export interface ResponseWatch {
  /** 已开启的目标请求序号；观察结束后抛出终止错误。 */
  readonly revision: number;
  /** 按完成顺序返回下一个响应；关闭、断开、超时或队列溢出后拒绝。 */
  next(): Promise<ResponseObservation>;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  // CDP 事件参数随 method 变化，在各分支内按协议字段读取。
  params?: any;
  result?: any;
  error?: { message: string };
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function endpointOf(url: string): string {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
}

/** 附着到 targetId 对应的标签页；Network.enable 成功回复后开始接收新请求，之前发起的请求一律忽略。 */
export async function watchResponses(cdpUrl: string, targetId: string, endpoint: string): Promise<ResponseWatch> {
  if (!/^https?:$/.test(new URL(endpoint).protocol) || endpointOf(endpoint) !== endpoint) {
    throw new Error('观察的接口必须是不带查询参数的 http(s) origin+pathname');
  }
  const ws = new WebSocket(cdpUrl);
  const watch = new CdpResponseWatch(ws, endpoint);
  await watch.attach(targetId);
  return watch;
}

class CdpResponseWatch implements ResponseWatch {
  readonly #ws: WebSocket;
  readonly #endpoint: string;
  #sessionId = '';
  /**
   * Network.enable 应答之后才接收网络事件；应答前发起的请求不属于本次观察。
   * 同一数据块里的多条消息连续派发、中间不跑微任务，所以在收到应答的消息处理里同步开启。
   */
  #armed = false;
  #enableId = 0;
  #lastId = 0;
  #revision = 0;
  readonly #pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  /** 观察开启后发起、尚未完成的目标请求。 */
  readonly #requests = new Map<string, { url: string; revision: number; status?: number }>();
  readonly #ready: Promise<ResponseObservation>[] = [];
  readonly #waiters: ((observation: Promise<ResponseObservation>) => void)[] = [];
  readonly #ended = Promise.withResolvers<never>();
  #failure: Error | null = null;
  #shutdown: Promise<void> | null = null;

  constructor(ws: WebSocket, endpoint: string) {
    this.#ws = ws;
    this.#endpoint = endpoint;
    this.#ended.promise.catch(() => {});
    ws.addEventListener('message', event => this.#onMessage(String(event.data)));
    ws.addEventListener('close', () => void this.#end(new Error(DISCONNECTED)));
  }

  async attach(targetId: string): Promise<void> {
    try {
      await withTimeout(new Promise((resolve, reject) => {
        this.#ws.addEventListener('open', resolve, { once: true });
        this.#ws.addEventListener('error', () => reject(new Error('无法连接浏览器调试端口')), { once: true });
      }), '连接浏览器调试端口超时');
      this.#sessionId = (await this.#send('Target.attachToTarget', { targetId, flatten: true }, false)).sessionId;
      const enabled = this.#send('Network.enable', {});
      this.#enableId = this.#lastId;
      await enabled;
    } catch (error) {
      await this.#end(error as Error);
      throw error;
    }
  }

  get revision(): number {
    if (this.#failure) throw this.#failure;
    return this.#revision;
  }

  async next(): Promise<ResponseObservation> {
    if (this.#failure) throw this.#failure;
    const item = this.#ready.shift() ?? new Promise<ResponseObservation>(resolve => this.#waiters.push(resolve));
    try {
      return await withTimeout(Promise.race([item, this.#ended.promise]), '等待接口响应超时');
    } catch (error) {
      await this.#end(error as Error);
      throw this.#failure;
    }
  }

  close(): Promise<void> {
    return this.#end(new Error(CLOSED));
  }

  #send(method: string, params: object, scoped = true): Promise<any> {
    if (this.#ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(DISCONNECTED));
    const id = ++this.#lastId;
    const result = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#ws.send(JSON.stringify({ id, method, params, ...(scoped ? { sessionId: this.#sessionId } : {}) }));
    // 浏览器不再应答说明连接已不可靠：整个观察以超时终止，由 #end 拒绝本命令与所有等待。
    const timer = setTimeout(() => void this.#end(new Error(`浏览器调试命令 ${method} 超时`)), TIMEOUT_MS);
    return result.finally(() => { clearTimeout(timer); this.#pending.delete(id); });
  }

  #onMessage(raw: string): void {
    const message = JSON.parse(raw) as CdpMessage;
    if (message.id !== undefined) {
      const call = this.#pending.get(message.id);
      if (message.id === this.#enableId && !message.error) this.#armed = true;
      if (message.error) call?.reject(new Error(`浏览器调试命令失败：${message.error.message}`));
      else call?.resolve(message.result);
      return;
    }
    if (this.#failure || !this.#sessionId) return;
    if (message.method === 'Target.detachedFromTarget' && message.params.sessionId === this.#sessionId) {
      void this.#end(new Error(DISCONNECTED));
      return;
    }
    if (this.#armed && message.sessionId === this.#sessionId) this.#onNetwork(message.method, message.params);
  }

  #onNetwork(method: string | undefined, params: any): void {
    const { requestId } = params ?? {};
    if (method === 'Network.requestWillBeSent') return this.#onRequest(requestId, params.request.url, Boolean(params.redirectResponse));
    const request = this.#requests.get(requestId);
    if (!request) return;
    if (method === 'Network.responseReceived') request.status = params.response.status;
    if (method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') return;
    this.#requests.delete(requestId);
    if (method === 'Network.loadingFailed') this.#push(Promise.resolve({ kind: 'failed', revision: request.revision, url: request.url, error: params.errorText }));
    else this.#push(this.#readBody(requestId, request.url, request.status, request.revision));
  }

  #onRequest(requestId: string, url: string, redirected: boolean): void {
    const matches = endpointOf(url) === this.#endpoint;
    // 重定向沿用原 requestId；起点不是本次观察内的目标请求时不追认。
    if (redirected) {
      if (!this.#requests.has(requestId)) return;
      if (matches) this.#requests.set(requestId, { url, revision: ++this.#revision });
      else this.#requests.delete(requestId);
      return;
    }
    if (!matches) return;
    if (this.#requests.size >= QUEUE_LIMIT) return void this.#end(new Error(`进行中的接口请求超过上限 ${QUEUE_LIMIT}`));
    this.#requests.set(requestId, { url, revision: ++this.#revision });
  }

  async #readBody(requestId: string, url: string, status: number | undefined, revision: number): Promise<ResponseObservation> {
    if (status === undefined) return { kind: 'failed', revision, url, error: '请求结束但没有收到响应头' };
    let text: string;
    try {
      const result = await this.#send('Network.getResponseBody', { requestId });
      text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
    } catch (error) {
      return { kind: 'failed', revision, url, error: `响应正文不可读：${(error as Error).message}` };
    }
    try {
      return { kind: 'response', revision, url, status, body: JSON.parse(text) };
    } catch {
      return { kind: 'failed', revision, url, error: `响应正文不是 JSON（HTTP ${status}）` };
    }
  }

  #push(observation: Promise<ResponseObservation>): void {
    const waiter = this.#waiters.shift();
    if (waiter) return waiter(observation);
    if (this.#ready.length >= QUEUE_LIMIT) return void this.#end(new Error(`未读取的接口响应超过上限 ${QUEUE_LIMIT}`));
    this.#ready.push(observation);
  }

  /** 首个终止原因生效；拒绝所有等待后解除附着并关闭连接。 */
  #end(reason: Error): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#failure = reason;
    this.#ended.reject(reason);
    for (const call of this.#pending.values()) call.reject(reason);
    this.#pending.clear();
    this.#requests.clear();
    this.#ready.length = 0;
    this.#waiters.length = 0;
    this.#shutdown = this.#release();
    return this.#shutdown;
  }

  async #release(): Promise<void> {
    if (this.#sessionId && this.#ws.readyState === WebSocket.OPEN) {
      // 解除失败或无应答时页面已不可靠；随后关闭连接时浏览器也会释放该连接的全部会话。
      // 终止后的命令超时不会再触发 #end，需在此单独限时。
      await withTimeout(this.#send('Target.detachFromTarget', { sessionId: this.#sessionId }, false), '解除附着超时').catch(() => {});
    }
    if (this.#ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.#ws.addEventListener('close', resolve, { once: true }));
    this.#ws.close();
    // 已发出关闭帧后没有更多可做的动作；不让无响应的握手无限阻塞调用方。
    await withTimeout(closed, '关闭浏览器调试连接超时').catch(() => {});
  }
}
