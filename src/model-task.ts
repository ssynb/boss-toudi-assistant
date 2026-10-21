/** 回合只选择一个结果；工具接受结果不等于回合成功，完成前不执行任何任务动作。 */
import type { CodexClient } from './codex.ts';

type ResultTool<T> = { tool: string; description: string; schema: object; read: (value: unknown) => T };
type Context = { codex: CodexClient; signal: AbortSignal; instructions: string; input: unknown };

export function modelTask<T>(opts: Context & ResultTool<T>): Promise<T> {
  return modelAction({ ...opts, tools: [opts] });
}

export async function modelAction<T>(opts: Context & { tools: ResultTool<T>[] }): Promise<T> {
  opts.signal.throwIfAborted();
  let accepted: { value: T } | null = null;
  let active = true;
  try {
    const result = await opts.codex.runTurn({
      developerInstructions: opts.instructions, input: JSON.stringify(opts.input), signal: opts.signal,
      tools: opts.tools.map(tool => ({ name: tool.tool, description: tool.description, inputSchema: tool.schema, async handle(args) {
        if (!active || opts.signal.aborted || accepted) return { success: false, text: '本轮已结束或结果已接收，请结束回合' };
        accepted = { value: tool.read(args) };
        return { success: true, text: '结果已接收，请结束本轮。' };
      } })),
    });
    opts.signal.throwIfAborted();
    if (result.status === 'interrupted') throw new DOMException('已停止', 'AbortError');
    if (result.status === 'failed') throw new Error(result.error ?? '模型运行失败');
    if (!accepted) throw new Error('模型未提交有效结果');
    return (accepted as { value: T }).value;
  } finally { active = false; }
}
