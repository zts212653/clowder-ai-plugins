import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Host } from './types.js';

const apiSource = 'packages/api/src/domains/plugin/host-surface/plugin-neutral-host.ts';
const webSource = 'packages/web/src/app/layout.tsx';
const platforms: Readonly<Record<string, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

async function hasLocalFile(root: string, path: string) {
  const file = join(root, path);
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile()) return false;
  const resolved = await realpath(file).catch(() => undefined);
  if (!resolved) return false;
  const within = relative(root, resolved);
  return within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within);
}

export async function diagnosticEnvironment(
  environment: Awaited<ReturnType<NonNullable<Host['runtimeInfo']>['get']>>,
  project: string,
  launch = {
    entrypoint: process.argv[1],
    desktopRoot: process.env.CAT_CAFE_DESKTOP_STARTUP_ID ? process.env.CAT_CAFE_RUNTIME_ROOT : undefined,
  },
) {
  // A thread worker reports its own bootstrap as argv[1]. Both entries identify
  // the running API tree independently of the selected project.
  const entrypoint = launch.entrypoint ?? '';
  const entry = /[\\/]packages[\\/]api[\\/](src|dist)[\\/](?:index(?:\.desktop)?|domains[\\/]plugin[\\/]execution-worker[\\/]bootstrap)\.(?:js|ts)$/i.exec(entrypoint);
  const [runtimeRoot, desktopRoot, selectedRoot] = await Promise.all([
    entry && isAbsolute(entrypoint)
      ? realpath(resolve(entrypoint.slice(0, entry.index + 1))).catch(() => undefined) : undefined,
    launch.desktopRoot && isAbsolute(launch.desktopRoot)
      ? realpath(launch.desktopRoot).catch(() => undefined) : undefined,
    realpath(project).catch(() => undefined),
  ]);
  // An Agent may inherit the marker when it launches a second API from source.
  const desktopStarted = runtimeRoot !== undefined && runtimeRoot === desktopRoot;
  const [packaged, runningSource, selectedSource] = await Promise.all([
    desktopStarted && runtimeRoot ? Promise.all([
      hasLocalFile(runtimeRoot, 'desktop-dist/resources/app.asar'),
      hasLocalFile(runtimeRoot, 'app.asar'),
    ]).then(results => results.some(Boolean)) : false,
    desktopStarted && runtimeRoot ? hasLocalFile(runtimeRoot, apiSource) : false,
    selectedRoot ? Promise.all([hasLocalFile(selectedRoot, apiSource), hasLocalFile(selectedRoot, webSource)])
      .then(results => results.every(Boolean)) : false,
  ]);
  const platform = platforms[environment.platform];
  const logParent = dirname(environment.logDirectory);
  const desktopLogRoot = desktopStarted && basename(environment.logDirectory) === 'api' &&
    basename(logParent) === 'logs' && basename(dirname(logParent)) === 'data' ? logParent : undefined;
  let deployment = '未能核实';
  if (desktopStarted) {
    if (packaged) deployment = '桌面安装版（已核实打包资源）';
    else if (runningSource) deployment = '桌面源码版';
    else deployment = '桌面启动（安装形态未能核实）';
  } else if (runtimeRoot) {
    deployment = entry?.[1]?.toLowerCase() === 'src' ? 'Web 源码启动' : 'Web 编译产物启动';
  }
  return {
    desktopLogRoot,
    runtimeRoot,
    selectedRoot,
    facts: [
      `Clowder ${environment.version}`,
      `宿主系统：${platform ? `${platform} (${environment.platform})` : environment.platform} · ${environment.architecture} · Node ${environment.nodeVersion}`,
      `运行形态：${deployment}`,
      ...(desktopStarted && !desktopLogRoot ? ['桌面启动日志：当前实例使用非标准 API 日志布局，未推断桌面日志目录。'] : []),
      selectedSource
        ? '源码：所选项目检测到 Clowder API 和 Web 源码标记，版本对应关系待核实。'
        : selectedRoot
          ? '源码：所选项目未发现 Clowder 源码。可根据本次日志、版本和操作现象继续分析。'
          : '源码：无法核验所选项目。可根据本次日志、版本和操作现象继续分析。',
    ].join('\n'),
    async guide() {
      const general = await readFile(new URL('../assets/diagnostics/triage.md', import.meta.url), 'utf8');
      const mode = desktopStarted ? 'desktop' : runtimeRoot ? 'web' : undefined;
      if (!mode) return general.trim();
      const route = await readFile(new URL(`../assets/diagnostics/${mode}.md`, import.meta.url), 'utf8');
      return `${general.trim()}\n\n${route.trim()}`;
    },
  };
}
