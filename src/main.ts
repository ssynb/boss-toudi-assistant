/**
 * 命令行入口。
 *   node src/main.ts         启动本地服务（PORT 默认 4318）
 *   node src/main.ts setup   环境检查；--install-cloak 在用户单独确认许可后下载官方 CloakBrowser
 */
import { defaultDataDir } from './app.ts';
import { installCloak } from './cloak.ts';
import { runDoctor } from './doctor.ts';
import { startServer } from './server.ts';

const DEFAULT_PORT = 4318;
const dataDir = defaultDataDir();

async function setup(): Promise<void> {
  if (process.argv.includes('--install-cloak')) await installCloak();
  const checks = await runDoctor(dataDir);
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`);
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

async function serve(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const server = await startServer({ dataDir, port });
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
