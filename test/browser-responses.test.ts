import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Browser } from '../src/browser.ts';
import { tempDir } from './helpers.ts';

const ENDPOINT_PATH = '/wapi/list';
let held: http.ServerResponse | null = null;
let heldArrived: () => void = () => {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://local');
  const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>本地响应页</title>');
  if (url.pathname === '/wapi/other') return json(200, { code: 0, zpData: { other: true } });
  if (url.pathname !== ENDPOINT_PATH) return res.writeHead(404).end();
  const kind = url.searchParams.get('kind');
  if (kind === 'hold') { held = res; heldArrived(); return; }
  if (kind === 'error') return json(500, { code: 5, message: '业务失败' });
  if (kind === 'drop') return req.socket.destroy();
  if (kind === 'broken') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"code":0,');
  return json(200, { code: 0, zpData: { page: url.searchParams.get('page'), list: url.searchParams.get('page') === '1' ? [] : [{ id: 'b' }] } });
});

let origin = '';
let endpoint = '';
const browser = new Browser({ profileDir: path.join(tempDir('boss-responses-'), 'profile'), headed: false, namespace: `responses-${process.pid}` });

/** 在页面内按顺序发起请求，等全部结束（成功或失败）再返回。 */
async function pageFetch(paths: string[]): Promise<void> {
  await browser.eval(`(window.fetchDone = false, (async () => { for (const p of ${JSON.stringify(paths)}) await fetch(p).then(r => r.text()).catch(() => {}); window.fetchDone = true; })(), true)`);
  await browser.waitFor('window.fetchDone === true');
}

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  endpoint = origin + ENDPOINT_PATH;
  await browser.open(origin + '/');
});

after(async () => {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('只按精确 origin+pathname 返回观察后发起的多页响应，成功空数组保留原样', async () => {
  const watch = await browser.watchResponses(endpoint);
  try {
    await pageFetch(['/wapi/other?page=1', `${ENDPOINT_PATH}?page=1`, `${ENDPOINT_PATH}/extra?page=1`, `${ENDPOINT_PATH}?page=2&secret=s`]);
    assert.deepEqual(await watch.next(), { kind: 'response', url: `${endpoint}?page=1`, status: 200, body: { code: 0, zpData: { page: '1', list: [] } } });
    assert.deepEqual(await watch.next(), { kind: 'response', url: `${endpoint}?page=2&secret=s`, status: 200, body: { code: 0, zpData: { page: '2', list: [{ id: 'b' }] } } });
  } finally {
    await watch.close();
  }
});

test('HTTP/业务失败原样交给调用方，网络失败与不可读正文显式 failed', async () => {
  const watch = await browser.watchResponses(endpoint);
  try {
    await pageFetch([`${ENDPOINT_PATH}?kind=error`, `${ENDPOINT_PATH}?kind=drop`, `${ENDPOINT_PATH}?kind=broken`]);
    assert.deepEqual(await watch.next(), { kind: 'response', url: `${endpoint}?kind=error`, status: 500, body: { code: 5, message: '业务失败' } });
    const dropped = await watch.next();
    assert.equal(dropped.kind, 'failed');
    assert.equal(dropped.url, `${endpoint}?kind=drop`);
    const broken = await watch.next();
    assert.equal(broken.kind, 'failed');
    assert.equal(broken.url, `${endpoint}?kind=broken`);
  } finally {
    await watch.close();
  }
});

test('观察开启前已完成或已发起的请求不混入', async () => {
  await pageFetch([`${ENDPOINT_PATH}?page=old`]);
  const arrived = new Promise<void>(resolve => { heldArrived = resolve; });
  await browser.eval(`(window.heldDone = false, fetch('${ENDPOINT_PATH}?kind=hold').then(r => r.text()).finally(() => { window.heldDone = true; }), true)`);
  await arrived;
  const watch = await browser.watchResponses(endpoint);
  try {
    held!.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, zpData: { page: 'held' } }));
    await browser.waitFor('window.heldDone === true');
    await pageFetch([`${ENDPOINT_PATH}?page=new`]);
    const observed = await watch.next();
    assert.equal(observed.kind === 'response' && observed.url, `${endpoint}?page=new`);
  } finally {
    await watch.close();
  }
});

test('关闭会拒绝正在等待和之后的 next', async () => {
  const watch = await browser.watchResponses(endpoint);
  const waiting = watch.next();
  await watch.close();
  await assert.rejects(waiting, /关闭/);
  await assert.rejects(watch.next(), /关闭/);
  await watch.close();
});

test('等待超时拒绝并结束观察', async () => {
  const watch = await browser.watchResponses(endpoint);
  try {
    await assert.rejects(watch.next(), /超时/);
    await pageFetch([`${ENDPOINT_PATH}?page=late`]);
    await assert.rejects(watch.next(), /超时/);
  } finally {
    await watch.close();
  }
});

test('未消费响应超过队列上限时明确失败', async () => {
  const watch = await browser.watchResponses(endpoint);
  try {
    await pageFetch(Array.from({ length: 500 }, (_, i) => `${ENDPOINT_PATH}?page=${i + 2}`));
    await assert.rejects(watch.next(), /上限/);
  } finally {
    await watch.close();
  }
});

test('浏览器断开时拒绝等待', async () => {
  const watch = await browser.watchResponses(endpoint);
  const waiting = watch.next();
  await browser.close();
  await assert.rejects(waiting, /断开/);
});
