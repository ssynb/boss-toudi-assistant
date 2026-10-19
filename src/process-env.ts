/** 子进程只继承系统运行环境，不继承 API key、NODE_OPTIONS 或 agent-browser/Codex 的隐式配置。 */
export function systemEnvironment(): NodeJS.ProcessEnv {
  const names = new Set([
    'path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'tmpdir',
    'home', 'userprofile', 'appdata', 'localappdata', 'lang', 'lc_all', 'tz',
    'http_proxy', 'https_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir',
    'display', 'wayland_display', 'xdg_runtime_dir',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key.toLowerCase())));
}
