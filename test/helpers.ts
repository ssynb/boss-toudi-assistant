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
