#!/usr/bin/env node
// Voidly 一键开发启动脚本
// 用法: npm run dev [-- --no-react] [-- --no-watch] [-- --no-window]
// 作用:
//   1) 关闭 CodeBuddy 的 safe-delete 拦截（否则 rimraf 批量删 out/ 会失败）
//   2) 清理上一次 dev.js 留下的进程树（watch-client / watch-extensions / tsup / scope-tailwind / nodemon / esbuild watch）
//   3) 后台启动 npm run watch 编译 VS Code 核心（gulp）
//   4) 后台启动 React watch（scope-tailwind + tsup，独立子进程）
//   5) 等 watch 产出关键文件后，打开 Voidly Dev 窗口（隔离 user-data / extensions）
//   6) Ctrl+C 优雅清理所有子进程
// 改完代码后，在开发者窗口内按 Ctrl+R 即可重载（watch 会自动重编译）。
//
// 改进点（相对旧版）:
//   - 同时跑 react watch，改 React 代码不再需要手动 npm run buildreact
//   - 清理进程时一并杀 tsup / scope-tailwind / nodemon / esbuild watch，避免产物被旧 watch 覆盖
//   - electron 窗口等 watch 首轮产物出现后再启动，避免黑屏
//   - Ctrl+C 退出时清理所有子进程，不残留
//   - 支持 --no-react / --no-watch / --no-window 跳过对应步骤

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

// ---------- CLI 参数 ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const skipReact = flag('--no-react');
const skipWatch = flag('--no-watch');
const skipWindow = flag('--no-window');

// ---------- 1) 关闭安全删除拦截 ----------
// 子进程通过 env 继承；tsup / scope-tailwind 子进程也会拿到这个值。
process.env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';

const watchEnv = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' };

// ---------- 2) 清理上一次残留的 watch 进程树 ----------
// 命中以下命令行的进程都视为旧 watch，全部杀掉（当前进程除外）。
const WATCH_PATTERNS = [
  'npm(-cli)?\\.js\\s+run\\s+watch',
  'npm-run-all.*watch-client',
  'gulp\\.js\\s+watch-(client|extensions)',
  // React watch 相关
  'build\\.js\\s+--watch',
  'scope-tailwind',
  'tsup\\s+--watch',
  'nodemon.*scope-tailwind',
  'node_modules.*nodemon.*src',
];

function killOldWatch() {
  if (!isWin) {
    WATCH_PATTERNS.forEach((p) => {
      try { spawnSync('pkill', ['-f', p], { stdio: 'ignore' }); } catch (_) {}
    });
    return;
  }
  // Windows：用 PowerShell + CIM 查命令行，taskkill /T 杀进程树
  const psScript =
    `Get-CimInstance Win32_Process | Where-Object { ` +
    `$_.CommandLine -match '${WATCH_PATTERNS.join('|')}' ` +
    `} | ForEach-Object { $_.ProcessId }`;
  const procs = spawnSync('powershell', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
  const ids = (procs.stdout || '')
    .split(/\r?\n/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  if (ids.length === 0) {
    console.log('  无残留 watch 进程');
    return;
  }
  ids.forEach((id) => {
    try {
      spawnSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' });
      console.log(`  已终止旧 watch 进程 PID ${id}`);
    } catch (_) { /* 忽略单个失败 */ }
  });
}

console.log('[1/5] 清理旧的 watch 进程树...');
killOldWatch();

// ---------- 子进程注册表（用于 Ctrl+C 优雅退出） ----------
const children = [];
function registerChild(p, label) {
  p._voidLabel = label;
  children.push(p);
  return p;
}
function killAllChildren() {
  if (children.length === 0) return;
  console.log('\n[dev] 正在清理子进程...');
  children.forEach((p) => {
    try {
      if (isWin) {
        // /T 杀整个进程树，避免 detached 子进程残留
        spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-p.pid, 'SIGKILL'); // 杀进程组
      }
      console.log(`  已清理 ${p._voidLabel} (PID ${p.pid})`);
    } catch (_) {}
  });
  children.length = 0;
}
process.on('SIGINT', () => { killAllChildren(); process.exit(0); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(0); });
process.on('exit', killAllChildren);

// ---------- 3) 启动 VS Code 核心 watch（gulp watch-client + watch-extensions） ----------
let watchProcess = null;
if (!skipWatch) {
  const watchLog = path.join(root, 'watch_run.log');
  const watchOut = fs.openSync(watchLog, 'w');
  console.log(`[2/5] 启动 npm run watch（日志 → watch_run.log）`);
  watchProcess = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'watch'], {
    cwd: root,
    env: watchEnv,
    stdio: ['ignore', watchOut, watchOut],
    detached: true,
    shell: true,
  });
  registerChild(watchProcess, 'npm run watch');
} else {
  console.log('[2/5] 跳过 npm run watch（--no-watch）');
}

// ---------- 4) 启动 React watch（scope-tailwind + tsup） ----------
// 走 build.js --watch：它会同时起 nodemon(scope-tailwind) 和 tsup --watch
// 改 src/**/*.{ts,tsx,css} → scope-tailwind 自动重新生成 src2/ → tsup 自动重生成 out/sidebar-tsx/index.js
let reactWatchProcess = null;
if (!skipReact) {
  const reactCwd = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'void', 'browser', 'react');
  const reactLog = path.join(root, 'watch_react.log');
  const reactOut = fs.openSync(reactLog, 'w');
  console.log(`[3/5] 启动 React watch（日志 → watch_react.log）`);
  // 注意：build.js 用 import.meta.url，必须用 node 直接跑（不能走 npm run watchreact，因为 cd 链有引号坑）
  reactWatchProcess = spawn(isWin ? 'node.exe' : 'node', ['build.js', '--watch'], {
    cwd: reactCwd,
    env: watchEnv,
    stdio: ['ignore', reactOut, reactOut],
    detached: true,
    shell: false,
  });
  registerChild(reactWatchProcess, 'react watch (scope-tailwind + tsup)');
} else {
  console.log('[3/5] 跳过 React watch（--no-react）');
}

// ---------- 5) 等待关键产物存在，再启动 electron 窗口 ----------
// 这一步避免 electron 起来时 out/ 还是空的，要靠 Ctrl+R 重载才看到内容。
const KEY_FILES = [
  // VS Code 核心 entry
  'out/vs/code/electron-main/main.js',
  // React sidebar bundle（如果跳过了 react watch 就不强求）
  ...(skipReact ? [] : ['out/vs/workbench/contrib/void/browser/react/out/sidebar-tsx/index.js']),
];

function waitForFiles(files, timeoutMs = 90_000, pollMs = 1000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const missing = files.filter((f) => {
        try {
          // 文件存在且 > 100 字节才算"有内容"
          const st = fs.statSync(path.join(root, f));
          return st.size < 100;
        } catch (_) { return true; }
      });
      if (missing.length === 0) return resolve(true);
      if (Date.now() > deadline) {
        console.log(`  [warn] 等待超时，仍缺失: ${missing.join(', ')}`);
        return resolve(false);
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}

(async () => {
  if (skipWindow) {
    console.log('[4/5] 跳过等待（--no-window）');
    console.log('[5/5] 跳过启动 Voidly Dev 窗口（--no-window）');
    console.log('\n已启动 watch 进程。Ctrl+C 退出并清理子进程。');
    // 不启动窗口，但保持进程不退出（让 watch 继续跑）
    // 阻塞式等待 SIGINT
    return new Promise(() => {});
  }

  console.log(`[4/5] 等待 watch 产物生成（最长 90s）...`);
  await waitForFiles(KEY_FILES);

  console.log('[5/5] 启动 Voidly Dev 窗口');
  const runLog = path.join(root, 'void_runtime.log');
  const runOut = fs.openSync(runLog, 'w');
  // 跳过 preLaunch（dev 模式不需要重新拉 electron / built-in extensions）
  const env = { ...process.env, VSCODE_SKIP_PRELAUNCH: '1' };
  const electronProc = spawn(
    isWin ? path.join(root, 'scripts', 'code.bat') : './scripts/code.sh',
    ['--user-data-dir', path.join(root, '.tmp', 'user-data'),
     '--extensions-dir', path.join(root, '.tmp', 'extensions')],
    {
      cwd: root,
      env,
      stdio: ['ignore', runOut, runOut],
      detached: true,
      shell: true,
    });
  registerChild(electronProc, 'Voidly Dev 窗口');

  console.log('');
  console.log('Voidly Dev 已启动。');
  console.log('  - 编译日志:      watch_run.log');
  console.log('  - React 日志:    watch_react.log');
  console.log('  - 运行日志:      void_runtime.log');
  console.log('改完代码后，在窗口内按 Ctrl+R 重载即可。');
  console.log('Ctrl+C 退出会清理所有子进程。');

  // 阻塞，等 SIGINT
  await new Promise(() => {});
})();
