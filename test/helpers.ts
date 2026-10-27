import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 允许自定义 Host 头的原始请求（fetch 不允许改 Host）。 */
export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

export const LOCAL = { 'x-boss-local': '1' };

export async function api<T = unknown>(base: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(base + pathname, {
    method,
    headers: { ...LOCAL, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}


export const instantReadClock = {
  random: () => 0.5,
  async wait(_milliseconds: number, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); },
};

/** 站点替身模拟导航事件：读JD会开页，紧接着执行同一岗位可复用；切到搜索或会话即离开详情页。 */
export function countedSite(site: import('../src/boss.ts').Site) {
  return (beforeJobOpen: () => void): import('../src/boss.ts').Site => {
    let currentJob: string | null = null;
    return new Proxy(site, {
      get(target, key) {
        if (key === 'jobDetail') return async (card: import('../src/boss.ts').JobCard) => {
          currentJob = null;
          beforeJobOpen();
          const text = await target.jobDetail(card);
          currentJob = card.jobId;
          return text;
        };
        if (key === 'openJob') return async (job: import('../src/contracts.ts').Target) => {
          if (currentJob !== job.jobId) { currentJob = null; beforeJobOpen(); }
          const result = await target.openJob(job);
          currentJob = result.kind === 'canContact' ? job.jobId : null;
          return result;
        };
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['search', 'contact', 'readChat', 'open', 'close'].includes(String(key))) currentJob = null;
          return value.apply(target, args);
        };
      },
    });
  };
}
