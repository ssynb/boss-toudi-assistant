/** 唯一浏览器来源：官方 CloakBrowser 无 key 免费版；缺失、许可或平台问题均阻塞，不回退 Chrome。 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BinaryInfo } from 'cloakbrowser';
import { systemEnvironment } from './process-env.ts';
import { AppError } from './errors.ts';

const execute = promisify(execFile);
const RUNTIME = fileURLToPath(new URL('./cloak-runtime.ts', import.meta.url));
export const CLOAK_LICENSE_URL = 'https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md';
const SUPPORTED = new Set(['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64']);
const INSTALL_TIMEOUT_MS = 12 * 60_000;
const INSPECT_TIMEOUT_MS = 15_000;

export interface CloakRuntime extends BinaryInfo {
  args: string[];
}

export function defaultCloakCache(): string {
  return path.join(os.homedir(), '.boss-toudi-assistant', 'cloakbrowser');
}

export function requireCloakPlatform(platform: string = process.platform, arch: string = process.arch): void {
  if (!SUPPORTED.has(`${platform}-${arch}`)) throw new AppError('browser_not_ready', `CloakBrowser 0.6.3 不支持 ${platform}/${arch}，不会替换成 Chrome`);
}

function environment(cacheDir: string): NodeJS.ProcessEnv {
  const home = path.join(cacheDir, 'runtime-home');
  return { ...systemEnvironment(), HOME: home, USERPROFILE: home, CLOAKBROWSER_CACHE_DIR: path.resolve(cacheDir), CLOAKBROWSER_AUTO_UPDATE: 'false' };
}

async function inspect(cacheDir: string, install = false): Promise<CloakRuntime> {
  requireCloakPlatform();
  const env = environment(cacheDir);
  if (install) env.BOSS_CLOAK_LICENSE_ACCEPTED = process.env.BOSS_CLOAK_LICENSE_ACCEPTED;
  try {
    const { stdout } = await execute(process.execPath, [RUNTIME, install ? 'install' : 'inspect'], {
      env, windowsHide: true, timeout: install ? INSTALL_TIMEOUT_MS : INSPECT_TIMEOUT_MS,
    });
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as CloakRuntime;
  } catch (error) {
    const e = error as Error & { stderr?: string };
    throw new AppError('browser_not_ready', `CloakBrowser 检查/安装失败：${e.stderr?.trim() || e.message}`);
  }
}

/** 只检查已安装的免费版；共享缓存只读取这个版本的二进制，不调用全局 wrapper 或读取许可证。 */
export async function resolveCloak(cacheDir: string = defaultCloakCache()): Promise<CloakRuntime> {
  const info = await inspect(cacheDir);
  let binaryPath = info.binaryPath;
  let binaryDir = info.cacheDir;
  if (!info.installed) {
    binaryDir = path.join(os.homedir(), '.cloakbrowser', path.basename(info.cacheDir));
    binaryPath = path.join(binaryDir, path.relative(info.cacheDir, info.binaryPath));
  }
  if (!fs.existsSync(binaryPath)) {
    throw new AppError('browser_not_ready', `CloakBrowser 未安装（需要官方免费版 ${info.version}）。请先阅读 ${CLOAK_LICENSE_URL}；由本人确认许可后运行 npm run setup -- --install-cloak。不自动下载或使用普通 Chrome。`);
  }
  if (!fs.statSync(binaryPath).isFile()) throw new AppError('browser_not_ready', 'CloakBrowser 缓存中的可执行文件无效');
  fs.accessSync(binaryPath, fs.constants.X_OK);
  // Windows GUI 可执行文件不依赖 --version 输出作就绪判断，实际进程由浏览器接缝验收核实。
  if (process.platform !== 'win32') {
    const { stdout } = await execute(binaryPath, ['--version'], { env: environment(cacheDir), windowsHide: true, timeout: INSPECT_TIMEOUT_MS });
    const chromiumVersion = info.version.split('.').slice(0, 4).join('.');
    if (!stdout.includes(chromiumVersion)) throw new AppError('browser_not_ready', `CloakBrowser 二进制版本与缓存版本 ${info.version} 不符`);
  }
  return { ...info, installed: true, binaryPath, cacheDir: binaryDir };
}

/** 此函数从不替用户作许可决定；仅在用户单独设置精确许可版本后允许官方下载。 */
export async function installCloak(cacheDir: string = defaultCloakCache()): Promise<void> {
  requireCloakPlatform();
  if (process.env.BOSS_CLOAK_LICENSE_ACCEPTED !== '1.3') {
    throw new AppError('browser_not_ready', `需要用户本人阅读并确认 CloakBrowser 二进制许可（Binary License v1.3）：${CLOAK_LICENSE_URL}。确认后设置 BOSS_CLOAK_LICENSE_ACCEPTED=1.3，再运行 npm run setup -- --install-cloak；本次未下载。`);
  }
  await inspect(cacheDir, true);
}

/** 每个独立 profile 固定 fingerprint seed，不因 CLI 命令或服务重启不断改变指纹。 */
export function profileArgs(runtime: CloakRuntime, profileDir: string): string[] {
  const generated = runtime.args.find(a => /^--fingerprint=\d+$/.test(a));
  if (!generated) throw new AppError('browser_not_ready', 'CloakBrowser wrapper 没有提供 fingerprint seed');
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const file = path.join(profileDir, 'boss-fingerprint.seed');
  try {
    fs.writeFileSync(file, generated.split('=')[1]!, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const seed = fs.readFileSync(file, 'utf8');
  if (!/^\d+$/.test(seed)) throw new AppError('browser_not_ready', '独立 profile 的 CloakBrowser seed 无效，未启动浏览器');
  return runtime.args.map(a => a.startsWith('--fingerprint=') ? `--fingerprint=${seed}` : a);
}
