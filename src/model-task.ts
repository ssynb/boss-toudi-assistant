/** 每次独立只读线程只开放一个结果工具；工具接受结果不等于回合成功。 */
import type { CodexClient } from './codex.ts';

export async function modelTask<T>(opts: {
  codex: CodexClient; signal: AbortSignal; instructions: string; input: unknown;
  tool: string; description: string; schema: object; read: (value: unknown) => T;
}): Promise<T> {
  opts.signal.throwIfAborted();
  let accepted: { value: T } | null = null;
  let active = true;
  try {
    const result = await opts.codex.runTurn({
      developerInstructions: opts.instructions, input: JSON.stringify(opts.input), signal: opts.signal,
      tools: [{ name: opts.tool, description: opts.description, inputSchema: opts.schema, async handle(args) {
        if (!active || opts.signal.aborted || accepted) return { success: false, text: '本轮已结束或结果已接收' };
        accepted = { value: opts.read(args) };
        return { success: true, text: '结果已接收，请结束本轮。' };
      } }],
    });
    opts.signal.throwIfAborted();
    if (result.status === 'interrupted') throw new DOMException('已停止', 'AbortError');
    if (result.status === 'failed') throw new Error(result.error ?? '模型运行失败');
    if (!accepted) throw new Error('模型未提交有效结果');
    return (accepted as { value: T }).value;
  } finally { active = false; }
}
