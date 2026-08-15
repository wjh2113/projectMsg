import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { projectIdFromPath } from './store.js';

const MAX_LOG_LINES = 800;
const processes = new Map(); // id -> { child, script, command, startedAt, logs, exitCode, exitedAt }

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPackageScripts(projectPath) {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

export async function resolveDevCommand(projectPath, preferredScript = null) {
  const abs = path.resolve(projectPath);
  const scripts = await readPackageScripts(abs);
  const preferred = preferredScript
    ? [preferredScript]
    : ['dev', 'start', 'serve', 'preview'];
  const script = preferred.find((s) => scripts[s]) || (preferredScript && scripts[preferredScript] ? preferredScript : null);
  if (!script || !scripts[script]) {
    return {
      ok: false,
      error: preferredScript
        ? `未找到 package.json 脚本「${preferredScript}」`
        : '未找到 package.json 中的 dev/start/serve/preview 脚本',
      scripts: Object.keys(scripts),
    };
  }
  const isWin = process.platform === 'win32';
  return {
    ok: true,
    script,
    command: isWin ? 'npm.cmd' : 'npm',
    args: ['run', script],
    scripts: Object.keys(scripts),
  };
}

function pushLog(entry, chunk, stream) {
  const text = chunk.toString('utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') continue;
    entry.logs.push({
      t: new Date().toISOString(),
      stream,
      line,
    });
  }
  if (entry.logs.length > MAX_LOG_LINES) {
    entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
  }
}

function publicStatus(id, entry) {
  if (!entry) {
    return { id, running: false };
  }
  return {
    id,
    running: Boolean(entry.child && !entry.child.killed && entry.exitCode == null),
    pid: entry.child?.pid || null,
    script: entry.script,
    command: `${entry.command} ${(entry.args || []).join(' ')}`.trim(),
    startedAt: entry.startedAt,
    exitedAt: entry.exitedAt || null,
    exitCode: entry.exitCode,
    logCount: entry.logs.length,
  };
}

export function getProcessStatus(projectId) {
  return publicStatus(projectId, processes.get(projectId));
}

export function listProcessStatuses() {
  return [...processes.keys()].map((id) => getProcessStatus(id));
}

export function getProcessLogs(projectId, { since = 0 } = {}) {
  const entry = processes.get(projectId);
  if (!entry) return { id: projectId, running: false, logs: [], next: 0 };
  const start = Math.max(0, Number(since) || 0);
  return {
    id: projectId,
    ...publicStatus(projectId, entry),
    logs: entry.logs.slice(start),
    next: entry.logs.length,
  };
}

async function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
}

export async function startProjectProcess(projectPath, options = {}) {
  const abs = path.resolve(projectPath);
  const id = projectIdFromPath(abs);
  const existing = processes.get(id);
  if (existing?.child && existing.exitCode == null) {
    return { ok: true, alreadyRunning: true, status: publicStatus(id, existing) };
  }

  if (!(await pathExists(path.join(abs, 'package.json')))) {
    const err = new Error('项目没有 package.json，无法启动 npm 脚本');
    err.status = 400;
    throw err;
  }

  const scriptName = options.script ? String(options.script).trim() : null;
  const cmd = await resolveDevCommand(abs, scriptName);
  if (!cmd.ok) {
    const err = new Error(cmd.error);
    err.status = 400;
    throw err;
  }

  const isWin = process.platform === 'win32';
  const child = spawn(cmd.command, cmd.args, {
    cwd: abs,
    env: { ...process.env, FORCE_COLOR: '0' },
    windowsHide: true,
    // Windows: spawning npm.cmd without shell can throw EINVAL
    shell: isWin,
    detached: !isWin,
  });

  const entry = {
    child,
    script: cmd.script,
    command: cmd.command,
    args: cmd.args,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    logs: [
      {
        t: new Date().toISOString(),
        stream: 'system',
        line: `启动 ${cmd.command} ${cmd.args.join(' ')} (pid ${child.pid})`,
      },
    ],
  };
  processes.set(id, entry);

  child.stdout?.on('data', (buf) => pushLog(entry, buf, 'stdout'));
  child.stderr?.on('data', (buf) => pushLog(entry, buf, 'stderr'));
  child.on('error', (err) => {
    pushLog(entry, `进程错误: ${err.message}\n`, 'system');
    entry.exitCode = 1;
    entry.exitedAt = new Date().toISOString();
  });
  child.on('exit', (code, signal) => {
    entry.exitCode = code;
    entry.exitedAt = new Date().toISOString();
    pushLog(
      entry,
      `进程结束 code=${code ?? 'null'} signal=${signal || 'none'}\n`,
      'system',
    );
  });

  return { ok: true, status: publicStatus(id, entry) };
}

export async function stopProjectProcess(projectPath) {
  const abs = path.resolve(projectPath);
  const id = projectIdFromPath(abs);
  const entry = processes.get(id);
  if (!entry?.child || entry.exitCode != null) {
    return { ok: true, alreadyStopped: true, status: publicStatus(id, entry) };
  }

  pushLog(entry, '正在停止进程…\n', 'system');
  const pid = entry.child.pid;
  await killProcessTree(pid);
  // give exit handler a moment
  await new Promise((r) => setTimeout(r, 300));
  if (entry.exitCode == null) {
    try {
      entry.child.kill('SIGKILL');
    } catch {
      // ignore
    }
    entry.exitCode = -1;
    entry.exitedAt = new Date().toISOString();
  }
  return { ok: true, status: publicStatus(id, entry) };
}

export async function attachRuntimeStatuses(projects) {
  return projects.map((p) => ({
    ...p,
    runtime: getProcessStatus(p.id),
  }));
}
