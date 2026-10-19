/**
 * 本地 HTTP 服务：只监听 127.0.0.1，托管 public/ 并提供 src/contracts.ts 描述的 /api。
 *
 * 本机防护（每个请求）：Host 必须是本服务的回环地址与端口（挡 DNS 重绑定）；
 * 带 Origin 时必须同源；Sec-Fetch-Site 只接受 same-origin/none；/api 还要求 X-Boss-Local: 1。
 * 不返回任何 CORS 头，预检请求一律拒绝。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_HEADER, LOCAL_HEADER_VALUE, RESUME_MAX_BYTES, type ApiError, type ErrorCode } from './contracts.ts';
import { App, type AppOptions } from './app.ts';
import { AppError } from './errors.ts';

const JSON_MAX_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 25_000;
export const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface ServerOptions extends AppOptions {
  port: number;
  publicDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  app: App;
  close(): Promise<void>;
}

type Handler = (app: App, body: Body, params: string[]) => unknown;

interface Body {
  json(): unknown;
  raw: Buffer;
  fileName: string;
}

const ROUTES: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/state$/, () => null],
  ['POST', /^\/api\/codex\/login$/, (a) => a.login()],
  ['POST', /^\/api\/codex\/logout$/, (a) => a.logout()],
  ['PUT', /^\/api\/profile$/, (a, b) => a.setProfile(b.json() as never)],
  ['PUT', /^\/api\/criteria$/, (a, b) => a.setCriteria(b.json() as never)],
  ['POST', /^\/api\/resume\/file$/, (a, b) => a.uploadResume(b.fileName, b.raw)],
  ['PUT', /^\/api\/resume\/text$/, (a, b) => a.setResumeText(b.json() as never)],
  ['DELETE', /^\/api\/resume$/, (a) => a.deleteResume()],
  ['POST', /^\/api\/browser\/open$/, (a) => a.openBrowser()],
  ['POST', /^\/api\/discovery\/start$/, (a) => a.startDiscovery()],
  ['POST', /^\/api\/discovery\/stop$/, (a) => a.stopDiscovery()],
  ['PATCH', /^\/api\/batch$/, (a, b) => a.patchBatch(b.json() as never)],
  ['PATCH', /^\/api\/batch\/targets\/([\w-]+)$/, (a, b, p) => a.patchTarget(p[0]!, b.json() as never)],
  ['POST', /^\/api\/batch\/approve$/, (a, b) => a.approve((b.json() as { version: number }).version)],
  ['POST', /^\/api\/batch\/start$/, (a) => a.startBatch()],
  ['POST', /^\/api\/batch\/pause$/, (a) => a.pauseBatch()],
];

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const app = new App(opts);
  const publicDir = path.resolve(opts.publicDir ?? DEFAULT_PUBLIC_DIR);
  let allowedHosts: string[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      const err = e instanceof AppError ? e : new AppError('internal', e instanceof Error ? e.message : String(e));
      if (!res.headersSent) sendError(res, err.code, err.message);
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const isApi = url.pathname.startsWith('/api/');
    if (!isSameOrigin(req, allowedHosts) || (isApi && (req.method === 'OPTIONS' || req.headers[LOCAL_HEADER] !== LOCAL_HEADER_VALUE))) {
      await drain(req, 0);
      return sendError(res, 'forbidden', '只接受本机页面的请求');
    }
    if (!isApi) return serveStatic(publicDir, url.pathname, req, res);
    if (req.method === 'GET' && url.pathname === '/api/events') return streamEvents(app, req, res);

    for (const [method, pattern, handler] of ROUTES) {
      const m = pattern.exec(url.pathname);
      if (!m || method !== req.method) continue;
      const isUpload = url.pathname === '/api/resume/file';
      const raw = await drain(req, isUpload ? RESUME_MAX_BYTES : JSON_MAX_BYTES);
      const body: Body = {
        raw,
        fileName: decodeHeader(req.headers['x-file-name']),
        json() {
          try {
            return JSON.parse(raw.toString('utf8'));
          } catch {
            throw new AppError('bad_request', '请求体不是有效 JSON');
          }
        },
      };
      await handler(app, body, m.slice(1));
      return sendJson(res, 200, await app.getState());
    }
    await drain(req, 0);
    sendError(res, 'not_found', '接口不存在');
  }

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    app,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}

function isSameOrigin(req: http.IncomingMessage, allowedHosts: string[]): boolean {
  const host = req.headers.host ?? '';
  if (!allowedHosts.includes(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** 读完请求体；超过上限时继续读完但丢弃，最后报 413。 */
async function drain(req: http.IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max && max > 0) throw new AppError('file_too_large', '请求体过大');
  return Buffer.concat(chunks);
}

function decodeHeader(v: string | string[] | undefined): string {
  try {
    return decodeURIComponent(typeof v === 'string' ? v : '');
  } catch {
    return '';
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, code: ErrorCode, message: string): void {
  const status = new AppError(code, message).status;
  sendJson(res, status, { error: { code, message } } satisfies ApiError);
}

function streamEvents(app: App, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
  const changed = () => res.write('event: changed\ndata: {}\n\n');
  const log = (e: unknown) => res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  app.on('changed', changed);
  app.on('log', log);
  changed();
  req.on('close', () => {
    clearInterval(heartbeat);
    app.off('changed', changed);
    app.off('log', log);
  });
}

function serveStatic(publicDir: string, pathname: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 'not_found', '不存在');
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return sendError(res, 'bad_request', '路径无效');
  }
  const file = path.resolve(publicDir, `.${rel}`);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendError(res, 'not_found', pathname === '/' ? '界面文件尚未就绪（public/index.html）' : '文件不存在');
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(file).pipe(res);
}
