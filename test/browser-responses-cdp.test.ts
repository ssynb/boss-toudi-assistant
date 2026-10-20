import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { watchResponses } from '../src/browser-responses.ts';

const ENDPOINT = 'https://www.zhipin.com/wapi/list';

function frame(opcode: number, payload: Buffer): Buffer {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length]) : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

type Send = (message: object) => void;
type Script = (method: string, id: number, params: any, send: Send) => void;

/** 每个请求的完整事件序列，sessionId 固定为替身附着返回的 S。 */
function requestEvents(requestId: string, url: string): object[] {
  return [
    { method: 'Network.requestWillBeSent', sessionId: 'S', params: { requestId, request: { url } } },
    { method: 'Network.responseReceived', sessionId: 'S', params: { requestId, response: { status: 200 } } },
    { method: 'Network.loadingFinished', sessionId: 'S', params: { requestId } },
  ];
}

/** 最小 CDP 替身：自动应答附着与解除附着，其余命令交给 script，用于真实浏览器无法稳定复现的时序。 */
function fakeBrowser(script: Script): Promise<{ url: string; methods: string[]; closed: Promise<void>; stop: () => void }> {
  const methods: string[] = [];
  let socketClosed: () => void = () => {};
  const closed = new Promise<void>(resolve => { socketClosed = resolve; });
  const sockets: Duplex[] = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket: Duplex) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sockets.push(socket);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (message: object) => socket.write(frame(1, Buffer.from(JSON.stringify(message))));
    socket.on('close', () => socketClosed());
    socket.on('data', (chunk: Buffer) => {
      for (let at = 0; at < chunk.length;) {
        const opcode = chunk[at]! & 0x0f;
        let length = chunk[at + 1]! & 0x7f;
        let offset = at + 2;
        if (length === 126) { length = chunk.readUInt16BE(offset); offset += 2; }
        const mask = chunk.subarray(offset, offset + 4);
        const payload = Buffer.from(chunk.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]!));
        at = offset + 4 + length;
        if (opcode === 8) { socket.end(frame(8, payload)); return; }
        const { id, method, params } = JSON.parse(payload.toString());
        methods.push(method);
        if (method === 'Target.attachToTarget') send({ id, result: { sessionId: 'S' } });
        else if (method === 'Target.detachFromTarget') send({ id, result: {} });
        else script(method, id, params, send);
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/x`, methods, closed,
    stop: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  })));
}

test('读取正文超时拒绝等待，并解除附着、关闭调试连接', { timeout: 40_000 }, async () => {
  // 推送一次已完成的目标请求，但永不回复读取正文命令。
  const browser = await fakeBrowser((method, id, _params, send) => {
    if (method !== 'Network.enable') return;
    send({ id, result: {} });
    for (const event of requestEvents('R', `${ENDPOINT}?page=1`)) send(event);
  });
  try {
    const watch = await watchResponses(browser.url, 'T', ENDPOINT);
    await assert.rejects(watch.next(), /超时/);
    assert.ok(browser.methods.includes('Network.getResponseBody'));
    assert.ok(browser.methods.includes('Target.detachFromTarget'));
    await browser.closed;
  } finally {
    browser.stop();
  }
});

test('Network.enable 应答之前发起的请求即使之后完成也不收', async () => {
  const [early, ...earlyRest] = requestEvents('E', `${ENDPOINT}?page=early`);
  const browser = await fakeBrowser((method, id, params, send) => {
    if (method === 'Network.getResponseBody') return send({ id, result: { body: JSON.stringify({ requestId: params.requestId }), base64Encoded: false } });
    if (method !== 'Network.enable') return;
    send(early!);
    send({ id, result: {} });
    for (const event of [...earlyRest, ...requestEvents('A', `${ENDPOINT}?page=armed`)]) send(event);
  });
  try {
    const watch = await watchResponses(browser.url, 'T', ENDPOINT);
    try {
      assert.deepEqual(await watch.next(), { kind: 'response', url: `${ENDPOINT}?page=armed`, status: 200, body: { requestId: 'A' } });
    } finally {
      await watch.close();
    }
  } finally {
    browser.stop();
  }
});
