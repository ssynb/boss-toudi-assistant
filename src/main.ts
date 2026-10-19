/**
 * 命令行入口。
 *   node src/main.ts         启动本地服务（PORT 默认 4318）
 *   node src/main.ts setup   环境检查；缺浏览器时用 agent-browser 从官方渠道下载 Chrome for Testing
 */
import { defaultDataDir } from './app.ts';
import { runAgentBrowser } from './browser.ts';
import { runDoctor } from './doctor.ts';
import { startServer } from './server.ts';

const DEFAULT_PORT = 4318;
const dataDir = defaultDataDir();
const browserPath = process.env.BOSS_BROWSER_PATH || undefined;

async function setup(): Promise<void> {
  let checks = await runDoctor(dataDir, browserPath);
  if (!browserPath && checks.find((c) => c.id === 'browser')?.ok === false) {
    console.log('未找到可用的 Chrome，正在用 agent-browser 下载 Chrome for Testing…');
    const r = await runAgentBrowser(['install'], { inherit: true });
    if (r.code !== 0) console.error(`浏览器安装失败（退出码 ${r.code}）`);
    checks = await runDoctor(dataDir, browserPath);
  }
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

async function serve(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const server = await startServer({ dataDir, port, browserPath });
  console.log(`boss 投递助手已启动：${server.url}`);
  console.log(`数据目录：${dataDir}`);
  const stop = () => void server.close().then(
    () => process.exit(0),
    (error: unknown) => { console.error('关闭失败：', error); process.exit(1); },
  );
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

await (process.argv[2] === 'setup' ? setup() : serve());
