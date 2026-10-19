import http from 'node:http';

/** 本地假 Responses 端点：替代 OpenAI，按请求顺序回放脚本化的模型输出，并记录 Codex 发出的请求体。 */
export type MockItem =
  | { type: 'message'; text: string }
  | { type: 'function_call'; name: string; args: unknown }
  | { type: 'exec'; js: string };

export interface MockModel {
  baseUrl: string;
  requests: Array<{ tools?: unknown[]; input: unknown[] }>;
  close(): void;
}

export async function startMockModel(script: MockItem[][]): Promise<MockModel> {
  const requests: MockModel['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end('{}');
        return;
      }
      requests.push(JSON.parse(body));
      const n = requests.length;
      const items = script[n - 1] ?? [{ type: 'message', text: '完成' }];
      const id = `resp_${n}`;
      const events: unknown[] = [{ type: 'response.created', response: { id } }];
      items.forEach((it, i) => events.push({ type: 'response.output_item.done', item: toItem(it, `${n}_${i}`) }));
      events.push({
        type: 'response.completed',
        response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } },
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() };
}

function toItem(it: MockItem, id: string) {
  if (it.type === 'message') return { type: 'message', role: 'assistant', id: `m${id}`, content: [{ type: 'output_text', text: it.text }] };
  if (it.type === 'function_call') return { type: 'function_call', id: `fc${id}`, call_id: `call${id}`, name: it.name, arguments: JSON.stringify(it.args) };
  return { type: 'custom_tool_call', id: `ct${id}`, call_id: `ccall${id}`, name: 'exec', input: it.js };
}

/** 写入独立 Codex 目录的 config.toml，让本应用的 Codex 走假模型端点（无需登录）。 */
export function mockProviderToml(baseUrl: string, model: string): string {
  return [
    'model_provider = "mock"',
    `model = "${model}"`,
    '[model_providers.mock]',
    'name = "mock"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
}
