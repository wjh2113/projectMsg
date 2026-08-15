import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { getGitStatus, syncToGithub } from './git.js';
import { getServer } from './servers.js';
import { getProjectsMeta, saveProjectsMeta } from './store.js';

const execFileAsync = promisify(execFile);
const MAX_LOG_LINES = 500;
const jobs = new Map(); // projectId -> job state

export function emptyDeployConfig() {
  return {
    serverId: '',
    remotePath: '',
    branch: 'main',
    pushBeforeDeploy: true,
    installCmd: 'npm ci || npm install',
    buildCmd: '',
    processManager: 'pm2', // pm2 | systemd | custom | none
    pm2Name: '',
    pm2StartCmd: 'npm start',
    systemdUnit: '',
    customRestartCmd: '',
    port: null,
    url: '',
    lastDeployAt: null,
    lastOk: null,
    lastMessage: '',
  };
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Prefer explicit URL; otherwise http://host:port from server + deploy.port */
export function resolveDeployPublicUrl(deploy, server) {
  const explicit = String(deploy?.url || '').trim();
  if (explicit) return explicit;
  const port = numOrNull(deploy?.port);
  const host = String(server?.host || '').trim();
  if (host && port) return `http://${host}:${port}`;
  return '';
}

export function normalizeDeployConfig(input = {}, prev = null) {
  const blank = emptyDeployConfig();
  const base = { ...blank, ...(prev || {}), ...(input || {}) };
  const pm = ['pm2', 'systemd', 'custom', 'none'].includes(base.processManager)
    ? base.processManager
    : 'pm2';
  return {
    serverId: String(base.serverId || ''),
    remotePath: String(base.remotePath || '').trim(),
    branch: String(base.branch || 'main').trim() || 'main',
    pushBeforeDeploy: base.pushBeforeDeploy !== false,
    installCmd: String(base.installCmd ?? blank.installCmd),
    buildCmd: String(base.buildCmd ?? ''),
    processManager: pm,
    pm2Name: String(base.pm2Name || '').trim(),
    pm2StartCmd: String(base.pm2StartCmd || 'npm start').trim() || 'npm start',
    systemdUnit: String(base.systemdUnit || '').trim(),
    customRestartCmd: String(base.customRestartCmd || '').trim(),
    port: numOrNull(base.port),
    url: String(base.url || '').trim(),
    lastDeployAt: base.lastDeployAt ?? prev?.lastDeployAt ?? null,
    lastOk: base.lastOk ?? prev?.lastOk ?? null,
    lastMessage: String(base.lastMessage ?? prev?.lastMessage ?? ''),
  };
}

function pushLog(job, line, stream = 'out') {
  if (!job) return;
  const text = String(line ?? '').replace(/\r\n/g, '\n');
  for (const part of text.split('\n')) {
    if (part === '') continue;
    job.logs.push({ t: new Date().toISOString(), stream, line: part });
  }
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runLocal(cmd, args, { timeout = 120000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: (stdout || '').toString(), stderr: (stderr || '').toString() };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || err.message || '').toString(),
      code: err.code,
    };
  }
}

async function resolveSshBin() {
  const candidates = process.platform === 'win32' ? ['ssh.exe', 'ssh'] : ['ssh'];
  for (const c of candidates) {
    const r = await runLocal(c, ['-V'], { timeout: 5000 });
    if (/OpenSSH/i.test(r.stderr + r.stdout) || r.ok) return c;
  }
  return process.platform === 'win32' ? 'ssh.exe' : 'ssh';
}

export async function sshExec(server, remoteCommand, { timeout = 600000, onChunk } = {}) {
  if (!server?.host) {
    const err = new Error('服务器主机地址为空');
    err.status = 400;
    throw err;
  }
  if (server.authMethod === 'key' && !server.privateKeyPath) {
    const err = new Error('请配置 SSH 私钥路径（或改用 agent 认证）');
    err.status = 400;
    throw err;
  }
  if (server.privateKeyPath) {
    try {
      await fs.access(server.privateKeyPath);
    } catch {
      const err = new Error(`SSH 私钥不存在：${server.privateKeyPath}`);
      err.status = 400;
      throw err;
    }
  }

  const sshBin = await resolveSshBin();
  const args = [
    '-p',
    String(server.port || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=20',
  ];
  if (server.privateKeyPath) {
    args.push('-i', server.privateKeyPath);
  }
  args.push(`${server.username}@${server.host}`, remoteCommand);

  return new Promise((resolve) => {
    const child = spawn(sshBin, args, {
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // ignore
      }
      settled = true;
      resolve({ ok: false, stdout, stderr: `${stderr}\nSSH 超时`, code: 'TIMEOUT' });
    }, timeout);

    child.stdout.on('data', (buf) => {
      const t = buf.toString('utf8');
      stdout += t;
      onChunk?.(t, 'out');
    });
    child.stderr.on('data', (buf) => {
      const t = buf.toString('utf8');
      stderr += t;
      onChunk?.(t, 'err');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err.message || err), code: err.code });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function buildRemoteScript(deploy, { remoteUrl, defaultPm2Name }) {
  const remotePath = deploy.remotePath;
  const branch = deploy.branch || 'main';
  const pm2Name = deploy.pm2Name || defaultPm2Name || 'app';
  const lines = [
    'set -e',
    `REMOTE_PATH=${shellSingleQuote(remotePath)}`,
    `BRANCH=${shellSingleQuote(branch)}`,
    `REPO_URL=${shellSingleQuote(remoteUrl)}`,
    'mkdir -p "$REMOTE_PATH"',
    'cd "$REMOTE_PATH"',
    'if [ ! -d .git ]; then',
    '  if [ "$(ls -A . 2>/dev/null | wc -l)" -gt 0 ]; then',
    '    echo "远端目录非空且不是 Git 仓库，请换空目录或先手工初始化" >&2',
    '    exit 2',
    '  fi',
    '  echo "==> git clone"',
    '  git clone --branch "$BRANCH" "$REPO_URL" .',
    'else',
    '  echo "==> git fetch / pull"',
    '  git remote set-url origin "$REPO_URL" || true',
    '  git fetch origin',
    '  git checkout "$BRANCH"',
    '  git pull --ff-only origin "$BRANCH"',
    'fi',
  ];

  if (deploy.installCmd && deploy.installCmd.trim()) {
    lines.push('echo "==> install"', deploy.installCmd.trim());
  }
  if (deploy.buildCmd && deploy.buildCmd.trim()) {
    lines.push('echo "==> build"', deploy.buildCmd.trim());
  }

  if (deploy.processManager === 'pm2') {
    lines.push(
      `PM2_NAME=${shellSingleQuote(pm2Name)}`,
      `PM2_START=${shellSingleQuote(deploy.pm2StartCmd || 'npm start')}`,
      'echo "==> pm2 restart"',
      'if command -v pm2 >/dev/null 2>&1; then',
      '  if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then',
      '    pm2 restart "$PM2_NAME" --update-env',
      '  else',
      '    # shell-start: e.g. "npm start" or "node server.js"',
      '    pm2 start bash --name "$PM2_NAME" -- -lc "$PM2_START"',
      '  fi',
      '  pm2 save || true',
      'else',
      '  echo "未安装 pm2，请先在服务器执行: npm i -g pm2" >&2',
      '  exit 3',
      'fi',
    );
  } else if (deploy.processManager === 'systemd') {
    if (!deploy.systemdUnit) {
      throw Object.assign(new Error('使用 systemd 时请填写 unit 名称'), { status: 400 });
    }
    lines.push(
      `UNIT=${shellSingleQuote(deploy.systemdUnit)}`,
      'echo "==> systemctl restart"',
      'sudo systemctl daemon-reload || true',
      'sudo systemctl restart "$UNIT"',
      'sudo systemctl --no-pager --full status "$UNIT" || true',
    );
  } else if (deploy.processManager === 'custom') {
    if (!deploy.customRestartCmd) {
      throw Object.assign(new Error('自定义重启命令为空'), { status: 400 });
    }
    lines.push('echo "==> custom restart"', deploy.customRestartCmd.trim());
  } else {
    lines.push('echo "==> skip process restart"');
  }

  lines.push('echo "==> done"');
  return lines.join('\n');
}

export function getDeployJob(projectId) {
  const job = jobs.get(projectId);
  if (!job) {
    return { running: false, logs: [], startedAt: null, exitedAt: null, ok: null, message: '' };
  }
  return {
    running: Boolean(job.running),
    logs: job.logs.slice(-200),
    startedAt: job.startedAt,
    exitedAt: job.exitedAt,
    ok: job.ok,
    message: job.message || '',
  };
}

export async function testServerConnection(serverId) {
  const server = await getServer(serverId);
  if (!server) {
    const err = new Error('服务器不存在');
    err.status = 404;
    throw err;
  }
  const result = await sshExec(server, 'echo ok && uname -a && whoami', { timeout: 30000 });
  if (!result.ok) {
    const err = new Error(result.stderr || result.stdout || 'SSH 连接失败');
    err.status = 502;
    throw err;
  }
  return {
    ok: true,
    output: (result.stdout || '').trim(),
    server: { id: server.id, name: server.name, host: server.host },
  };
}

/** Preflight checks before a destructive deploy. */
export async function precheckDeploy(projectId, projectPath, deployInput = {}) {
  const metaMap = await getProjectsMeta();
  const prev = metaMap[projectId] || { path: projectPath };
  const deploy = normalizeDeployConfig(deployInput || prev.deploy || {}, prev.deploy || {});
  const checks = [];

  if (!deploy.serverId) {
    checks.push({ id: 'server', ok: false, message: '未选择目标服务器' });
  } else {
    const server = await getServer(deploy.serverId);
    if (!server) {
      checks.push({ id: 'server', ok: false, message: '目标服务器不存在' });
    } else {
      try {
        const conn = await testServerConnection(deploy.serverId);
        checks.push({ id: 'ssh', ok: true, message: conn.output.slice(0, 200) });
        if (deploy.remotePath) {
          const quoted = deploy.remotePath.replace(/'/g, `'\"'\"'`);
          const ls = await sshExec(
            server,
            `if [ -d '${quoted}' ]; then echo DIR_OK; elif [ -e '${quoted}' ]; then echo EXISTS_NOT_DIR; else echo MISSING; fi`,
            { timeout: 30000 },
          );
          const out = (ls.stdout || '').trim();
          checks.push({
            id: 'remotePath',
            ok: out.includes('DIR_OK') || out.includes('MISSING'),
            message:
              out.includes('DIR_OK')
                ? '远端目录已存在'
                : out.includes('MISSING')
                  ? '远端目录不存在（部署时将创建）'
                  : out.includes('EXISTS_NOT_DIR')
                    ? '远端路径存在但不是目录'
                    : ls.stderr || out || '无法探测远端路径',
          });
        } else {
          checks.push({ id: 'remotePath', ok: false, message: '未填写 remotePath' });
        }
        if (deploy.processManager === 'pm2') {
          const pm2 = await sshExec(server, 'command -v pm2 >/dev/null && echo PM2_OK || echo PM2_MISSING', {
            timeout: 20000,
          });
          const ok = (pm2.stdout || '').includes('PM2_OK');
          checks.push({
            id: 'pm2',
            ok,
            message: ok ? '远端已安装 pm2' : '远端未找到 pm2（部署可能失败）',
          });
        }
      } catch (err) {
        checks.push({ id: 'ssh', ok: false, message: String(err.message || err) });
      }
    }
  }

  const gitStatus = await getGitStatus(projectPath);
  checks.push({
    id: 'git',
    ok: Boolean(gitStatus.hasGit && gitStatus.remoteUrl),
    message: gitStatus.hasGit
      ? gitStatus.remoteUrl
        ? `origin: ${gitStatus.remoteUrl}`
        : '缺少 origin remote'
      : '不是 Git 仓库',
  });

  const ok = checks.every((c) => c.ok);
  return { ok, checks, deploy, publicUrl: resolveDeployPublicUrl(deploy, deploy.serverId ? await getServer(deploy.serverId) : null) };
}

export async function deployProject(projectId, projectPath, options = {}) {
  const existing = jobs.get(projectId);
  if (existing?.running) {
    const err = new Error('该项目正在部署中');
    err.status = 409;
    throw err;
  }

  const metaMap = await getProjectsMeta();
  const prev = metaMap[projectId] || { path: projectPath };
  const deploy = normalizeDeployConfig(options.deploy || prev.deploy || {}, prev.deploy || {});

  if (options.skipPrecheck !== true) {
    const pre = await precheckDeploy(projectId, projectPath, deploy);
    if (!pre.ok) {
      const failed = pre.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.message}`);
      const err = new Error(`部署预检失败 — ${failed.join('；')}`);
      err.status = 400;
      err.precheck = pre;
      throw err;
    }
  }

  if (!deploy.serverId) {
    const err = new Error('请先选择目标服务器');
    err.status = 400;
    throw err;
  }
  if (!deploy.remotePath) {
    const err = new Error('请填写服务器上的项目目录 remotePath');
    err.status = 400;
    throw err;
  }

  const server = await getServer(deploy.serverId);
  if (!server) {
    const err = new Error('目标服务器不存在，请先在设置中添加');
    err.status = 404;
    throw err;
  }

  const gitStatus = await getGitStatus(projectPath);
  if (!gitStatus.hasGit || !gitStatus.remoteUrl) {
    const err = new Error('项目需要 GitHub remote（origin）才能远端 git pull');
    err.status = 400;
    throw err;
  }

  const job = {
    running: true,
    logs: [],
    startedAt: new Date().toISOString(),
    exitedAt: null,
    ok: null,
    message: '',
  };
  jobs.set(projectId, job);
  pushLog(job, `开始部署 → ${server.name} (${server.host})`);

  try {
    if (deploy.pushBeforeDeploy !== false) {
      pushLog(job, '==> 本地推送到 GitHub');
      const sync = await syncToGithub(projectPath, {
        autoCommit: options.autoCommit !== false,
        commitMessage: options.commitMessage || 'chore: deploy {date}',
      });
      pushLog(job, sync.message || sync.error || (sync.ok ? 'GitHub 已同步' : 'GitHub 同步结束'));
      if (!sync.ok) {
        throw new Error(sync.error || sync.message || '推送到 GitHub 失败，已中止部署');
      }
    } else {
      pushLog(job, '跳过本地 GitHub 推送');
    }

    const branch = deploy.branch || gitStatus.branch || 'main';
    deploy.branch = branch;
    const script = buildRemoteScript(deploy, {
      remoteUrl: gitStatus.remoteUrl,
      defaultPm2Name: pathBasename(projectPath),
    });

    pushLog(job, '==> SSH 远端执行');
    const remote = await sshExec(server, `bash -lc ${shellSingleQuote(script)}`, {
      timeout: 15 * 60 * 1000,
      onChunk: (chunk, stream) => pushLog(job, chunk, stream),
    });

    if (!remote.ok) {
      throw new Error(
        (remote.stderr || remote.stdout || `SSH 退出码 ${remote.code}`).slice(0, 800),
      );
    }

    const publicUrl = resolveDeployPublicUrl(deploy, server);
    const publicPort = numOrNull(deploy.port);
    job.ok = true;
    job.message = publicUrl
      ? `部署成功：${server.name} · ${publicUrl}`
      : `部署成功：${server.name} · ${deploy.remotePath}`;
    pushLog(job, job.message);
    if (publicUrl) pushLog(job, `访问地址：${publicUrl}`);
    if (publicPort) pushLog(job, `对外端口：${publicPort}`);

    const nextDeploy = normalizeDeployConfig(
      {
        ...deploy,
        url: publicUrl || deploy.url,
        port: publicPort,
        lastDeployAt: new Date().toISOString(),
        lastOk: true,
        lastMessage: job.message,
      },
      deploy,
    );
    const nextMeta = {
      ...prev,
      path: projectPath,
      deploy: nextDeploy,
      status: options.markDeployed === false ? prev.status : 'deployed',
      url: publicUrl || prev.url || '',
      port: publicPort != null ? publicPort : prev.port ?? null,
    };
    metaMap[projectId] = nextMeta;
    await saveProjectsMeta(metaMap);

    job.running = false;
    job.exitedAt = new Date().toISOString();
    return {
      ok: true,
      message: job.message,
      deploy: nextDeploy,
      publicUrl,
      publicPort,
      server: { id: server.id, name: server.name, host: server.host },
      job: getDeployJob(projectId),
      projectPatch: {
        id: projectId,
        status: nextMeta.status,
        url: nextMeta.url,
        port: nextMeta.port,
        deploy: nextDeploy,
      },
    };
  } catch (err) {
    job.ok = false;
    job.message = String(err.message || err);
    pushLog(job, `失败：${job.message}`, 'err');
    job.running = false;
    job.exitedAt = new Date().toISOString();

    const nextDeploy = normalizeDeployConfig(
      {
        ...deploy,
        lastDeployAt: new Date().toISOString(),
        lastOk: false,
        lastMessage: job.message,
      },
      deploy,
    );
    metaMap[projectId] = { ...prev, path: projectPath, deploy: nextDeploy };
    await saveProjectsMeta(metaMap);

    const out = new Error(job.message);
    out.status = err.status || 500;
    out.deploy = nextDeploy;
    out.job = getDeployJob(projectId);
    throw out;
  }
}

function pathBasename(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  return parts.filter(Boolean).pop() || 'app';
}

export async function testSshBinary() {
  const bin = await resolveSshBin();
  const r = await runLocal(bin, ['-V'], { timeout: 5000 });
  return {
    bin,
    ok: /OpenSSH/i.test(r.stderr + r.stdout) || r.ok,
    version: (r.stderr || r.stdout || '').trim().slice(0, 120),
  };
}
