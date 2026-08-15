import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

async function git(cwd, args, timeout = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return {
      ok: true,
      stdout: (stdout || '').trim(),
      stderr: (stderr || '').trim(),
    };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || err.message || '').toString().trim(),
      code: err.code,
    };
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getGitStatus(projectPath, { fetchRemote = false } = {}) {
  const abs = path.resolve(projectPath);
  if (!(await pathExists(path.join(abs, '.git')))) {
    return {
      hasGit: false,
      error: '不是 Git 仓库',
    };
  }

  if (fetchRemote) {
    await git(abs, ['fetch', '--quiet', 'origin'], 60000);
  }

  const [branch, remote, porcelain, upstream, aheadBehind] = await Promise.all([
    git(abs, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(abs, ['remote', 'get-url', 'origin']),
    git(abs, ['status', '--porcelain']),
    git(abs, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(abs, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
  ]);

  const dirtyFiles = porcelain.ok && porcelain.stdout
    ? porcelain.stdout.split(/\r?\n/).filter(Boolean)
    : [];

  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok && aheadBehind.stdout) {
    const [b, a] = aheadBehind.stdout.split(/\s+/).map(Number);
    behind = Number.isFinite(b) ? b : 0;
    ahead = Number.isFinite(a) ? a : 0;
  }

  return {
    hasGit: true,
    branch: branch.ok ? branch.stdout : null,
    remoteUrl: remote.ok ? remote.stdout : null,
    upstream: upstream.ok ? upstream.stdout : null,
    dirty: dirtyFiles.length > 0,
    dirtyCount: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, 40),
    ahead,
    behind,
    clean: dirtyFiles.length === 0 && ahead === 0,
    fetched: Boolean(fetchRemote),
  };
}

function formatCommitMessage(template) {
  const now = new Date();
  const date = now.toISOString().slice(0, 19).replace('T', ' ');
  return String(template || 'chore: sync {date}')
    .replaceAll('{date}', date)
    .replaceAll('{iso}', now.toISOString());
}

/**
 * Sync local repo to GitHub:
 * - optional autoCommit of all changes
 * - push current branch to origin (no force)
 */
export async function syncToGithub(projectPath, options = {}) {
  const abs = path.resolve(projectPath);
  const pullFirst = options.pullFirst !== false;
  const status = await getGitStatus(abs, { fetchRemote: true });
  if (!status.hasGit) {
    return { ok: false, error: status.error || '不是 Git 仓库', status };
  }
  if (!status.remoteUrl) {
    return { ok: false, error: '未配置 origin 远程仓库', status };
  }

  const steps = [];
  const autoCommit = Boolean(options.autoCommit);
  const message = formatCommitMessage(options.commitMessage);

  if (status.dirty) {
    if (!autoCommit) {
      return {
        ok: false,
        error: `有 ${status.dirtyCount} 个未提交变更。请勾选「自动提交」或先手动 commit。`,
        status,
        steps,
      };
    }

    const add = await git(abs, ['add', '-A']);
    steps.push({ step: 'add', ...add });
    if (!add.ok) {
      return { ok: false, error: add.stderr || 'git add 失败', status, steps };
    }

    const commit = await git(abs, ['commit', '-m', message]);
    steps.push({ step: 'commit', ...commit });
    if (!commit.ok) {
      const nothing =
        /nothing to commit/i.test(commit.stdout + commit.stderr) ||
        /no changes added/i.test(commit.stdout + commit.stderr);
      if (!nothing) {
        return { ok: false, error: commit.stderr || commit.stdout || 'git commit 失败', status, steps };
      }
    }
  }

  // refresh ahead/behind after possible commit
  let current = await getGitStatus(abs);
  if (pullFirst && current.behind > 0) {
    const pull = await git(abs, ['pull', '--rebase', '--autostash', 'origin', current.branch || 'HEAD'], 180000);
    steps.push({ step: 'pull-rebase', ...pull });
    if (!pull.ok) {
      return {
        ok: false,
        error: pull.stderr || pull.stdout || '远程有新提交，自动 pull --rebase 失败，请手动处理冲突',
        status: await getGitStatus(abs),
        steps,
      };
    }
    current = await getGitStatus(abs);
  }

  const branch = current.branch || status.branch || 'HEAD';
  const pushArgs = current.upstream
    ? ['push', 'origin', 'HEAD']
    : ['push', '-u', 'origin', 'HEAD'];

  const push = await git(abs, pushArgs, 180000);
  steps.push({ step: 'push', ...push });
  if (!push.ok) {
    return {
      ok: false,
      error: push.stderr || push.stdout || 'git push 失败（请检查本机 GitHub 登录/SSH）',
      status: await getGitStatus(abs, { fetchRemote: true }),
      steps,
      branch,
    };
  }

  const after = await getGitStatus(abs);
  return {
    ok: true,
    message: `已推送到 origin（${after.branch || branch}）`,
    status: after,
    steps,
    branch: after.branch || branch,
    committed: Boolean(status.dirty && autoCommit),
  };
}

export function normalizeGithubSync(input = {}, prev = {}) {
  const interval = Number(input.intervalMinutes ?? prev.intervalMinutes ?? 60);
  return {
    enabled: Boolean(input.enabled ?? prev.enabled ?? false),
    intervalMinutes: Math.min(24 * 60, Math.max(5, Number.isFinite(interval) ? interval : 60)),
    autoCommit: input.autoCommit != null ? Boolean(input.autoCommit) : prev.autoCommit !== false,
    commitMessage: String(input.commitMessage ?? prev.commitMessage ?? 'chore: auto sync {date}'),
    lastRunAt: input.lastRunAt ?? prev.lastRunAt ?? null,
    lastOk: input.lastOk ?? prev.lastOk ?? null,
    lastMessage: input.lastMessage ?? prev.lastMessage ?? '',
    nextRunAt: input.nextRunAt ?? prev.nextRunAt ?? null,
  };
}

export async function getCommitHistory(projectPath, { limit = 20 } = {}) {
  const abs = path.resolve(projectPath);
  if (!(await pathExists(path.join(abs, '.git')))) {
    return { hasGit: false, commits: [], error: '不是 Git 仓库' };
  }
  const n = Math.min(50, Math.max(1, Number(limit) || 20));
  const format = ['%H', '%h', '%an', '%ae', '%cI', '%s'].join('%x1f') + '%x1e';
  const res = await git(abs, ['log', `-n${n}`, `--pretty=format:${format}`]);
  if (!res.ok) {
    const msg = res.stderr || res.stdout || '读取提交历史失败';
    // brand-new repo with zero commits
    if (/does not have any commits yet/i.test(msg)) {
      return { hasGit: true, commits: [], empty: true };
    }
    return { hasGit: true, commits: [], error: msg };
  }
  const commits = (res.stdout || '')
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, shortHash, author, email, date, subject] = chunk.split('\x1f');
      return { hash, shortHash, author, email, date, subject };
    });
  return { hasGit: true, commits };
}

async function runCmd(command, args, cwd, timeout = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || '').toString().trim(),
      stderr: (err.stderr || err.message || '').toString().trim(),
      code: err.code,
    };
  }
}

export async function createGithubRepo(projectPath, options = {}) {
  const abs = path.resolve(projectPath);
  const name = String(options.name || path.basename(abs)).trim();
  const isPrivate = options.private !== false;
  const description = String(options.description || '').trim();
  const push = options.push !== false;
  const steps = [];

  if (!(await pathExists(path.join(abs, '.git')))) {
    const init = await git(abs, ['init', '-b', 'main']);
    steps.push({ step: 'git-init', ...init });
    if (!init.ok) {
      return { ok: false, error: init.stderr || 'git init 失败', steps };
    }
  }

  const status = await getGitStatus(abs);
  if (status.remoteUrl) {
    return {
      ok: false,
      error: `已有 origin：${status.remoteUrl}`,
      status,
      steps,
    };
  }

  const ghCheck = await runCmd('gh', ['auth', 'status'], abs, 20000);
  steps.push({ step: 'gh-auth', ok: ghCheck.ok, stderr: ghCheck.stderr, stdout: ghCheck.stdout });
  if (!ghCheck.ok) {
    return {
      ok: false,
      error:
        '本机未登录 GitHub CLI（gh）。请先安装 gh 并执行 `gh auth login`，或手动在 GitHub 建仓后添加 origin。',
      steps,
      needGhAuth: true,
    };
  }

  const args = [
    'repo',
    'create',
    name,
    isPrivate ? '--private' : '--public',
    '--source=.',
    '--remote=origin',
  ];
  if (description) args.push('--description', description);
  if (push) args.push('--push');

  const created = await runCmd('gh', args, abs, 180000);
  steps.push({ step: 'gh-repo-create', ...created });
  if (!created.ok) {
    return {
      ok: false,
      error: created.stderr || created.stdout || 'gh repo create 失败',
      steps,
    };
  }

  const after = await getGitStatus(abs, { fetchRemote: true });
  return {
    ok: true,
    message: created.stdout || `已创建 GitHub 仓库 ${name}`,
    status: after,
    steps,
    name,
    private: isPrivate,
  };
}

