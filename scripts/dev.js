#!/usr/bin/env node
// Voidly 一键开发启动脚本
// 用法: npm run dev [-- --no-react] [-- --no-watch] [-- --no-window] [-- --now]
// 作用:
//   1) 关闭 CodeBuddy 的 safe-delete 拦截（否则 rimraf 批量删 out/ 会失败）
//   2) 清理上一次 dev.js 留下的进程树（watch-client / watch-extensions / tsup / scope-tailwind / nodemon / esbuild watch）
//   3) 后台启动 npm run watch 编译 VS Code 核心（gulp，低于正常优先级，编译期间 UI 不卡）
//   4) 后台启动 React watch（scope-tailwind + tsup，独立子进程）
//   5) 等 watch 首轮编译静默 + 自检内置扩展产物后，打开 Voidly Dev 窗口（隔离 user-data / extensions）
//   6) Ctrl+C 优雅清理所有子进程
// 改完代码后，在窗口内按 Ctrl+R 即可重载（watch 会自动重编译）。
//
// 改进点（相对旧版）:
//   - 同时跑 react watch，改 React 代码不再需要手动 npm run buildreact
//   - 清理进程时一并杀 tsup / scope-tailwind / nodemon / esbuild watch，避免产物被旧 watch 覆盖
//   - electron 窗口等 watch 首轮编译静默后再启动，避免开在半成品 out/ 上（启动 Error / 卡顿的根源）
//   - 开窗前自动扫描内置扩展的 main 产物，缺失的自动单独重编（此前 json-language-features 静默失败 2 个多月）
//   - watch 进程树降到 BelowNormal 优先级，编译满核时编辑器照常流畅
//   - Ctrl+C 退出时清理所有子进程，不残留
//   - 支持 --no-react / --no-watch / --no-window / --now（不等编译，立即开窗，适合手动确认过产物的场景）

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
const openNow = flag('--now'); // 不等编译静默，立即开窗

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
      try { spawnSync('pkill', ['-f', p], { stdio: 'ignore' }); } catch (_) { }
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
    } catch (_) { }
  });
  children.length = 0;
}
process.on('SIGINT', () => { killAllChildren(); process.exit(0); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(0); });
process.on('exit', killAllChildren);

// ---------- 编译进程降优先级（Windows） ----------
// watch 全量编译会吃满所有核，把编辑器 UI 拖卡（用户感知为「启动/打开文件卡顿」）。
// 这里把 watch 进程树整体降到 BelowNormal：编译期间前台交互永远优先，编译只在空闲核上跑。
function lowerTreePriority(pid, label) {
  if (!isWin) return; // 非 Windows 平台暂不处理（可按需加 nice）
  // 从 pid 出发沿 ParentProcessId 收集整棵子树，再统一降级。
  const ps =
    `$all = Get-CimInstance Win32_Process; ` +
    `$ids = New-Object System.Collections.Generic.HashSet[uint32]; ` +
    `[void]$ids.Add(${pid}); ` +
    `for ($i = 0; $i -lt 8; $i++) { ` +
    `  $next = $all | Where-Object { $ids.Contains([uint32]$_.ParentProcessId) -and -not $ids.Contains([uint32]$_.ProcessId) }; ` +
    `  if (-not $next) { break }; ` +
    `  $next | ForEach-Object { [void]$ids.Add([uint32]$_.ProcessId) } ` +
    `}; ` +
    `$n = 0; ` +
    `$all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object { ` +
    `  try { (Get-Process -Id $_.ProcessId -EA Stop).PriorityClass = 'BelowNormal'; $n++ } catch {} ` +
    `}; ` +
    `"lowered=$n"`;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    const m = (r.stdout || '').match(/lowered=(\d+)/);
    if (m && parseInt(m[1], 10) > 0) console.log(`  已将 ${label} 进程树 ${m[1]} 个进程降为 BelowNormal 优先级`);
  } catch (_) { /* 降级失败不影响启动 */ }
}

// ---------- 等待首轮编译静默 ----------
// 原逻辑只等 90s 的关键文件出现，而核心全量编译要 30-60 分钟，窗口会开在半成品 out/ 上
// （启动 Error、扩展全挂），且编译继续满核跑 → 用户感知「启动/打开文件卡」。
// 这里改为轮询产物指纹（文件数 + 总字节 + 最新 mtime），连续几轮不变即认为首轮编译结束。
const FINGERPRINT_DIRS = [
  path.join(root, 'out'),
  path.join(root, 'extensions'),
];

function fingerprintDirs(dirs) {
  let count = 0, bytes = 0, maxMtime = 0;
  const stack = [...dirs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node_modules 体积大且与编译产物无关，跳过
        if (e.name === 'node_modules' || e.name === '.bin') continue;
        stack.push(p);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          count++; bytes += st.size;
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        } catch (_) { /* 文件可能刚被删 */ }
      }
    }
  }
  return `${count}:${bytes}:${Math.round(maxMtime)}`;
}

// ---------- 等待首轮编译完成 ----------
// 原逻辑只等 90s 的关键文件出现，而核心全量编译要几分钟到几十分钟，窗口会开在半成品 out/ 上
// （启动 Error、扩展全挂），且编译继续满核跑 → 用户感知「启动/打开文件卡」。
//
// 判定首选日志标记（npm-run-all 输出，ANSI 着色需容忍）：
//   [watch-client    ] Finished compilation with N errors   ← 核心首轮（注意 api-proposal-names 是并行小任务，要排除）
//   [watch-extensions] Finished compilation extensions ...  ← 扩展首轮（每个扩展 out 会先 clean 再全量重建）
// 日志采集失效时（watch_run.log 恒空），退回产物指纹静默检测。
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function watchLogFirstPassDone(watchLog) {
  let text = '';
  try { text = fs.readFileSync(watchLog, 'utf8'); } catch (_) { return { core: false, ext: false, hasContent: false }; }
  let core = false, ext = false;
  for (const raw of text.split(/\r?\n/)) {
    const l = stripAnsi(raw);
    if (!core && l.startsWith('[watch-client') && /Finished compilation (?!api-proposal-names)/.test(l)) core = true;
    if (!ext && l.startsWith('[watch-extensions') && /Finished compilation/.test(l)) ext = true;
  }
  return { core, ext, hasContent: text.length > 0 };
}

function waitForCompileQuiescence(timeoutMs = 45 * 60_000, pollMs = 6_000, stableRounds = 3, minWaitMs = 90_000) {
  // 指纹兜底：watch（gulp/tsb）从启动到开始产出有 1-2 分钟纯读入期，期间指纹一动不动，
  // 会误判为"已静默"，因此至少观察 minWaitMs 且指纹连续多轮不变才放行。
  return new Promise((resolve) => {
    const start = Date.now();
    let lastFp = null, stable = 0, sawActivity = false, lastProgress = 0;
    const tick = () => {
      const fp = fingerprintDirs(FINGERPRINT_DIRS);
      if (fp === lastFp) stable++; else { if (lastFp !== null) sawActivity = true; stable = 0; }
      lastFp = fp;

      const elapsedMs = Date.now() - start;
      const elapsed = Math.round(elapsedMs / 1000);
      if (elapsedMs >= minWaitMs && stable >= stableRounds) {
        console.log(`  产物已静默（${elapsed}s，${fp.split(':')[0]} 个文件，${sawActivity ? '检测到过编译活动' : '全程无产物变化'}）`);
        return resolve(true);
      }
      // 每 30s 报一次进度，避免用户以为卡死而反复重启（越重启越编不完）
      if (elapsed - lastProgress >= 30) {
        lastProgress = elapsed;
        console.log(`  编译中... ${elapsed}s，产物 ${fp.split(':')[0]} 个文件 / ${Math.round(fp.split(':')[1] / 1048576)}MB`);
      }
      if (elapsedMs > timeoutMs) {
        console.log(`  [warn] 等待编译静默超时（${Math.round(timeoutMs / 60000)} 分钟），直接开窗`);
        return resolve(false);
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function waitForFirstPass(watchLog, timeoutMs = 45 * 60_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastProgress = 0;
    const tick = () => {
      const { core, ext, hasContent } = watchLogFirstPassDone(watchLog);
      if (core && ext) {
        console.log(`  首轮编译完成（${Math.round((Date.now() - start) / 1000)}s，核心 + 内置扩展均已完成）`);
        return resolve(true);
      }
      const elapsedMs = Date.now() - start;
      const elapsed = Math.round(elapsedMs / 1000);
      // 日志始终无内容 = 日志采集失效（回归），退回指纹静默检测
      if (elapsedMs > 120_000 && !hasContent) {
        console.log('  [warn] watch_run.log 无输出（日志采集失效），退回产物指纹检测');
        waitForCompileQuiescence(timeoutMs - elapsedMs).then(resolve);
        return;
      }
      if (elapsed - lastProgress >= 30) {
        lastProgress = elapsed;
        console.log(`  编译中... ${elapsed}s（核心${core ? ' ✓' : '进行中'} / 扩展${ext ? ' ✓' : '进行中'}）`);
      }
      if (elapsedMs > timeoutMs) {
        console.log(`  [warn] 等待首轮编译超时（${Math.round(timeoutMs / 60000)} 分钟），直接开窗`);
        return resolve(false);
      }
      setTimeout(tick, 3000);
    };
    tick();
  });
}

// ---------- 内置扩展产物自检 + 自动修复 ----------
// watch-extensions 的某个工程在首轮并行编译时可能静默失败（reporter 吞错、emitError=false），
// 之后它一直 watch 也不会自动补编 → 扩展激活报 "Cannot find module ..."，每次启动刷 9 条错误。
// 这里扫描每个内置扩展 package.json 的 main 是否存在于磁盘，缺失的用单工程任务补编。
// 注意 main 是 require 语义（不带 .js），检查时必须尝试补 .js / .node / /index.js。
function mainExists(dirPath, main) {
  for (const c of [main, main + '.js', main + '.node', main + '/index.js']) {
    try { if (fs.statSync(path.join(dirPath, c)).isFile()) return true; } catch (_) { }
  }
  return false;
}

function scanBrokenBuiltins() {
  const broken = [];
  const extRoot = path.join(root, 'extensions');
  let dirs = [];
  try { dirs = fs.readdirSync(extRoot); } catch (_) { return broken; }
  for (const dir of dirs) {
    const dirPath = path.join(extRoot, dir);
    let st; try { st = fs.statSync(dirPath); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')); } catch (_) { continue; }
    if (!pkg.main) continue;
    if (!mainExists(dirPath, pkg.main)) broken.push({ dir, main: pkg.main });
  }
  return broken;
}

function repairBrokenBuiltins() {
  const broken = scanBrokenBuiltins();
  if (broken.length === 0) {
    console.log('  内置扩展产物自检通过');
    return;
  }

  console.log(`  发现 ${broken.length} 个内置扩展缺少 main 产物: ${broken.map(b => b.dir).join(', ')}`);

  for (const { dir, main } of broken) {
    const dirPath = path.join(root, 'extensions', dir);
    // esbuild 型扩展（有 esbuild.js）的产物由 esbuild watcher 产出，单独跑 tsc 任务补不出来，只能报告。
    if (fs.existsSync(path.join(dirPath, 'esbuild.js'))) {
      console.log(`  [warn] ${dir} 依赖 esbuild watcher 产出，跳过 tsc 补编（建议重启 npm run dev）`);
      continue;
    }
    // 找该扩展下所有 tsconfig（排除 node_modules），换算成 gulp 任务名：
    // build/gulpfile.extensions.js 的规则是相对 extensions/ 的路径把 / 换成 -。
    // 只跑 outDir 覆盖缺失 main 的子工程，避免无关子工程（webview preview 等）陪跑。
    const tsconfigs = [];
    const stack = [dirPath];
    while (stack.length) {
      const d = stack.pop();
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name === 'tsconfig.json') tsconfigs.push(p);
      }
    }
    for (const ts of tsconfigs) {
      // 只跑 outDir 覆盖缺失 main 的子工程（默认 outDir = tsconfig 所在目录），
      // 避免无关子工程（webview preview 等）陪跑；client/server 双工程也只补缺 main 的那一个。
      let outDir = path.dirname(ts);
      try {
        const tsCfg = JSON.parse(fs.readFileSync(ts, 'utf8'));
        if (tsCfg.compilerOptions && tsCfg.compilerOptions.outDir) {
          outDir = path.resolve(path.dirname(ts), tsCfg.compilerOptions.outDir);
        }
      } catch (_) { }
      const covered = [main, main + '.js', main + '/index.js'].some((c) => {
        const relToOut = path.relative(outDir, path.resolve(dirPath, c));
        return relToOut && !relToOut.startsWith('..') && !path.isAbsolute(relToOut);
      });
      if (!covered) continue;
      const rel = path.relative(path.join(root, 'extensions'), path.dirname(ts)).replace(/\\/g, '/');
      if (rel.startsWith('..')) continue;
      const taskName = `compile-extension:${rel.replace(/\//g, '-')}`;
      console.log(`  补编 ${taskName} ...`);
      try {
        const r = spawnSync(
          process.execPath,
          ['--max-old-space-size=8192', path.join(root, 'node_modules', 'gulp', 'bin', 'gulp.js'), taskName],
          { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 5 * 60_000 },
        );
        if (r.status !== 0) {
          const errTail = (r.stderr || r.stdout || '').split(/\r?\n/).filter(l => /Error|error TS/.test(l)).slice(0, 3).join(' | ');
          console.log(`  [warn] ${taskName} 退出码 ${r.status}${errTail ? '：' + errTail : ''}`);
        }
      } catch (_) { /* 单个失败继续下一个 */ }
    }
  }

  const remaining = scanBrokenBuiltins();
  if (remaining.length === 0) {
    console.log('  补编完成，内置扩展产物自检通过');
  } else {
    console.log(`  [warn] 仍有 ${remaining.length} 个扩展缺产物（不影响启动的可忽略）: ${remaining.map(b => b.dir).join(', ')}`);
  }
}

// ---------- 3) 启动 VS Code 核心 watch（gulp watch-client + watch-extensions） ----------
const watchLog = path.join(root, 'watch_run.log');
let watchProcess = null;
if (!skipWatch) {
  console.log(`[2/5] 启动 npm run watch（日志 → watch_run.log）`);
  // 日志直写 fd（与 void_runtime.log 同款）：2026-11 实测 cmd 内联重定向 `> log 2>&1` 恒为 0 字节，
  // fd 方式反而一直正常，坑位 4 的结论已反转。
  const watchFd = fs.openSync(watchLog, 'w');
  // 注意：不要加 detached:true —— 2026-11 实测（矩阵复现）detached 会导致整棵进程树的
  // stdout/stderr 无论如何都写不进文件（fd 和 cmd 内联重定向都是 0 字节）；去掉 detached 后
  // fd 方式正常。Ctrl+C 清理由 killAllChildren(taskkill /T) 兜底，不依赖 detached 语义。
  watchProcess = spawn('npm run watch', {
    cwd: root,
    env: watchEnv,
    stdio: ['ignore', watchFd, watchFd],
    detached: false,
    shell: true,
  });
  registerChild(watchProcess, 'npm run watch');
  // npm-run-all 异步拉起 watch-client / watch-extensions 子树，跑两次保证后启动的 gulp/tsc 也被覆盖
  setTimeout(() => lowerTreePriority(watchProcess.pid, 'npm run watch'), 5000);
  setTimeout(() => lowerTreePriority(watchProcess.pid, 'npm run watch'), 20000);
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
  console.log(`[3/5] 启动 React watch（日志 → watch_react.log）`);
  // 注意：build.js 用 import.meta.url，必须用 node 直接跑（不能走 npm run watchreact，因为 cd 链有引号坑）
  // 也不走 cross-spawn npx（npx 在 detached 子进程里静默失败），用 node 直调本地 .bin 上级路径。
  // env 需要显式带上 node_modules/.bin（build.js 里 spawn scope-tailwind 时用）。
  const reactBin = path.join(root, 'node_modules', '.bin');
  // Windows 的 env 键是 'Path'（{...process.env} 展开后大小写敏感，读 .PATH 会得到 undefined）
  const basePath = watchEnv.Path || watchEnv.PATH || '';
  const reactEnv = { ...watchEnv };
  delete reactEnv.PATH;
  delete reactEnv.Path;
  reactEnv.Path = `${reactBin}${path.delimiter}${basePath}`;
  // 同 watch：不加 detached（否则日志 0 字节，见上），Ctrl+C 由 killAllChildren 兜底
  const reactFd = fs.openSync(reactLog, 'w');
  reactWatchProcess = spawn('node build.js --watch', {
    cwd: reactCwd,
    env: reactEnv,
    stdio: ['ignore', reactFd, reactFd],
    detached: false,
    shell: true,
  });
  registerChild(reactWatchProcess, 'react watch (scope-tailwind + tsup)');
  setTimeout(() => lowerTreePriority(reactWatchProcess.pid, 'react watch'), 4000);
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

function waitForFiles(files, timeoutMs = 300_000, pollMs = 1000) {
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
    return new Promise(() => { });
  }

  console.log(`[4/5] 等待 watch 关键产物生成（最长 5 分钟）...`);
  await waitForFiles(KEY_FILES);

  // 等首轮编译静默后再开窗：窗口开在半成品 out/ 上是「启动 Error / 卡顿」的根源。
  // 全量编译 30-60 分钟，固定等待不现实，这里检测产物指纹连续稳定才认为编译完成。
  if (skipWatch) {
    console.log('[4/5] --no-watch 模式，跳过编译等待');
  } else if (openNow) {
    console.log('[4/5] --now 模式，跳过编译等待（窗口可能在编译完成前打开）');
  } else {
    console.log('[4/5] 等待首轮编译完成（核心 + 内置扩展；全量需几分钟到几十分钟，急用可 Ctrl+C 后 npm run dev -- --now）...');
    await waitForFirstPass(watchLog);
  }

  // 开窗前自检内置扩展产物，静默缺失的当场补编，避免启动后刷 "Cannot find module" 错误
  console.log('[5/5] 内置扩展产物自检...');
  repairBrokenBuiltins();

  console.log('启动 Voidly Dev 窗口');
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
  await new Promise(() => { });
})();
