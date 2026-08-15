import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProjectsMeta, getSettings, projectIdFromPath, getLocalNode } from './store.js';

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!(await pathExists(pkgPath))) return null;
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectStack(pkg, dirHas) {
  const tags = new Set();
  const deps = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  };
  if (deps.vite || dirHas.viteConfig) tags.add('vite');
  if (deps.next) tags.add('next');
  if (deps.express) tags.add('express');
  if (deps.react) tags.add('react');
  if (deps['@nestjs/core']) tags.add('nestjs');
  if (!pkg && dirHas.git) tags.add('git');
  return [...tags];
}

function extractPortFromText(text) {
  if (!text) return null;
  const patterns = [
    /--port[=\s]+(\d{2,5})/i,
    /-p\s+(\d{2,5})\b/,
    /\bPORT\s*[=:]\s*(\d{2,5})\b/i,
    /\bport\s*:\s*(\d{2,5})\b/i,
    /listen\([^)]*?(\d{2,5})/,
    /localhost:(\d{2,5})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const port = Number(m[1]);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return null;
}

async function inferPort(dir, pkg) {
  const scripts = pkg?.scripts || {};
  for (const key of ['dev', 'start', 'serve']) {
    const port = extractPortFromText(scripts[key]);
    if (port) return { port, source: `scripts.${key}` };
  }

  for (const name of ['.env', '.env.local', '.env.development']) {
    const envPath = path.join(dir, name);
    if (!(await pathExists(envPath))) continue;
    try {
      const raw = await fs.readFile(envPath, 'utf8');
      const line = raw.split(/\r?\n/).find((l) => /^\s*PORT\s*=/.test(l));
      if (line) {
        const port = extractPortFromText(line);
        if (port) return { port, source: name };
      }
    } catch {
      // ignore
    }
  }

  for (const name of [
    'vite.config.js',
    'vite.config.ts',
    'vite.config.mjs',
    'client/vite.config.js',
    'client/vite.config.ts',
    'web/vite.config.js',
    'frontend/vite.config.js',
  ]) {
    const cfg = path.join(dir, name);
    if (!(await pathExists(cfg))) continue;
    try {
      const raw = await fs.readFile(cfg, 'utf8');
      const port = extractPortFromText(raw);
      if (port) return { port, source: name };
    } catch {
      // ignore
    }
  }

  for (const name of ['server/index.js', 'src/server.js', 'index.js', 'server.js']) {
    const file = path.join(dir, name);
    if (!(await pathExists(file))) continue;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const m = raw.match(/process\.env\.PORT\)?\s*\|\|\s*(\d{2,5})/);
      if (m) return { port: Number(m[1]), source: name };
      const port = extractPortFromText(raw);
      if (port) return { port, source: name };
    } catch {
      // ignore
    }
  }

  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next) return { port: 3000, source: 'next-default' };
    if (deps.vite) return { port: 5173, source: 'vite-default' };
  }

  return { port: null, source: null };
}

async function getGitInfo(dir) {
  const gitDir = path.join(dir, '.git');
  if (!(await pathExists(gitDir))) {
    return { hasGit: false, remoteUrl: null, lastCommitAt: null };
  }

  let remoteUrl = null;
  let lastCommitAt = null;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      timeout: 5000,
      windowsHide: true,
    });
    remoteUrl = stdout.trim() || null;
  } catch {
    // no origin
  }

  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%cI'], {
      cwd: dir,
      timeout: 5000,
      windowsHide: true,
    });
    lastCommitAt = stdout.trim() || null;
  } catch {
    // empty repo
  }

  return { hasGit: true, remoteUrl, lastCommitAt };
}

async function getMtime(dir) {
  try {
    const st = await fs.stat(dir);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

async function inspectProject(absPath) {
  const name = path.basename(absPath);
  const exists = await pathExists(absPath);
  if (!exists) {
    return {
      id: projectIdFromPath(absPath),
      name,
      path: absPath,
      exists: false,
      missing: true,
      hasGit: false,
      remoteUrl: null,
      lastCommitAt: null,
      packageName: null,
      scripts: {},
      detectedPort: null,
      portSource: null,
      hasReadme: false,
      hasAgents: false,
      hasMakemoney: false,
      stack: [],
      mtime: null,
    };
  }

  const pkg = await readPackageJson(absPath);
  const hasGit = await pathExists(path.join(absPath, '.git'));
  const hasReadme = await pathExists(path.join(absPath, 'README.md'));
  const hasAgents = await pathExists(path.join(absPath, 'AGENTS.md'));
  const hasMakemoney =
    (await pathExists(path.join(absPath, 'makemoney.md'))) ||
    (await pathExists(path.join(absPath, 'MakeMoney.md'))) ||
    (await pathExists(path.join(absPath, 'MAKEMONEY.md'))) ||
    (await pathExists(path.join(absPath, 'docs', 'makemoney.md')));
  const hasViteConfig =
    (await pathExists(path.join(absPath, 'vite.config.js'))) ||
    (await pathExists(path.join(absPath, 'vite.config.ts'))) ||
    (await pathExists(path.join(absPath, 'vite.config.mjs')));

  if (!pkg && !hasGit && !hasReadme) {
    return {
      id: projectIdFromPath(absPath),
      name,
      path: absPath,
      exists: true,
      missing: false,
      hasGit: false,
      remoteUrl: null,
      lastCommitAt: null,
      packageName: null,
      scripts: {},
      detectedPort: null,
      portSource: null,
      hasReadme: false,
      hasAgents: false,
      hasMakemoney: false,
      stack: [],
      mtime: await getMtime(absPath),
      weakMatch: true,
    };
  }

  const [{ port, source }, git, mtime] = await Promise.all([
    inferPort(absPath, pkg),
    getGitInfo(absPath),
    getMtime(absPath),
  ]);

  return {
    id: projectIdFromPath(absPath),
    name,
    path: absPath,
    exists: true,
    missing: false,
    hasGit: git.hasGit,
    remoteUrl: git.remoteUrl,
    lastCommitAt: git.lastCommitAt,
    packageName: pkg?.name || null,
    scripts: pkg?.scripts || {},
    detectedPort: port,
    portSource: source,
    hasReadme,
    hasAgents,
    hasMakemoney,
    stack: detectStack(pkg, { viteConfig: hasViteConfig, git: hasGit }),
    mtime,
  };
}

function defaultMeta(scanned) {
  let status = 'planning';
  if (scanned.hasGit && scanned.remoteUrl) status = 'on_github';
  else if (scanned.hasGit || scanned.packageName) status = 'developing';

  return {
    status,
    progress: status === 'on_github' ? 80 : status === 'developing' ? 30 : 0,
    url: '',
    port: null,
    docs: [],
    notes: '',
  };
}

function mergeProject(scanned, meta = {}) {
  const base = defaultMeta(scanned);
  const manual = meta || {};
  const port = manual.port ?? scanned.detectedPort ?? null;
  const url =
    manual.url ||
    (port ? `http://localhost:${port}` : '') ||
    '';

  return {
    ...scanned,
    status: manual.status || base.status,
    progress: manual.progress ?? base.progress,
    url,
    port,
    docs: Array.isArray(manual.docs) ? manual.docs : [],
    notes: manual.notes || '',
    aiSummary: manual.aiSummary || '',
    aiSummaryAt: manual.aiSummaryAt || null,
    aiSummaryModel: manual.aiSummaryModel || null,
    statusBeforeTrash: manual.statusBeforeTrash || null,
    trashedAt: manual.trashedAt || null,
    trashReason: manual.trashReason || '',
    githubSync: manual.githubSync || {
      enabled: false,
      intervalMinutes: 60,
      autoCommit: true,
      commitMessage: 'chore: auto sync {date}',
      lastRunAt: null,
      lastOk: null,
      lastMessage: '',
      nextRunAt: null,
    },
    deploy: manual.deploy || null,
    manual: {
      status: manual.status ?? null,
      progress: manual.progress ?? null,
      url: manual.url || '',
      port: manual.port ?? null,
      docs: Array.isArray(manual.docs) ? manual.docs : [],
      notes: manual.notes || '',
      aiSummary: manual.aiSummary || '',
      aiSummaryAt: manual.aiSummaryAt || null,
      aiSummaryModel: manual.aiSummaryModel || null,
      githubSync: manual.githubSync || null,
      deploy: manual.deploy || null,
      statusBeforeTrash: manual.statusBeforeTrash || null,
      trashedAt: manual.trashedAt || null,
      trashReason: manual.trashReason || '',
    },
  };
}

async function listCandidateDirs(root, depth = 1) {
  const resolved = path.resolve(root);
  if (!(await pathExists(resolved))) return [];

  const maxDepth = Math.min(4, Math.max(1, Number(depth) || 1));
  const out = [];

  async function walk(dir, level) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      out.push(full);
      if (level < maxDepth) {
        await walk(full, level + 1);
      }
    }
  }

  await walk(resolved, 1);
  return out;
}

export async function scanProjects({ localOnly = false } = {}) {
  const settings = await getSettings();
  const metaMap = await getProjectsMeta();
  const node = await getLocalNode();
  const byId = new Map();

  const depth = settings.scanDepth || 1;
  const candidateLists = await Promise.all(
    (settings.scanRoots || []).map((root) => listCandidateDirs(root, depth)),
  );
  const candidates = [...new Set(candidateLists.flat().map((d) => path.resolve(d)))];

  const scannedList = await Promise.all(candidates.map((dir) => inspectProject(dir)));
  for (const scanned of scannedList) {
    if (!scanned || scanned.weakMatch) continue;
    // Local hub keeps legacy path-only ids for compatibility
    const id = scanned.id;
    const meta = metaMap[id] || metaMap[scanned.path] || {};
    const merged = mergeProject(scanned, {
      ...meta,
      nodeId: meta.nodeId || node.id,
    });
    merged.nodeId = node.id;
    merged.nodeName = node.name;
    merged.nodeHostname = node.hostname;
    merged.nodeRole = node.role;
    merged.local = true;
    byId.set(id, merged);
  }

  // Manual-only / missing projects stored in meta (local paths)
  for (const [key, meta] of Object.entries(metaMap)) {
    if (byId.has(key)) continue;
    const abs = path.resolve(meta.path || key);
    // skip remote-node-only rows when scanning disk
    if (meta.nodeId && meta.nodeId !== node.id) continue;
    if ([...byId.values()].some((p) => path.resolve(p.path) === abs && p.nodeId === node.id)) {
      continue;
    }
    const scanned = await inspectProject(abs);
    if (!scanned) continue;
    const merged = mergeProject(scanned, { ...meta, nodeId: node.id });
    merged.nodeId = node.id;
    merged.nodeName = node.name;
    merged.nodeHostname = node.hostname;
    merged.nodeRole = node.role;
    merged.local = !scanned.missing;
    byId.set(scanned.id, merged);
  }

  if (!localOnly) {
    // Merge remote agent snapshots from DB
    const { listProjectRows } = await import('./store.js');
    const rows = await listProjectRows();
    for (const row of rows) {
      if (!row.node_id || row.node_id === node.id) continue;
      if (byId.has(row.id)) continue;
      const snap = row.scan_snapshot || {};
      const meta = { ...(row.meta || {}), path: row.path, nodeId: row.node_id };
      const scanned = {
        id: row.id,
        name: row.name || path.basename(row.path),
        path: row.path,
        exists: snap.exists !== false,
        missing: Boolean(snap.missing),
        hasGit: Boolean(snap.hasGit),
        remoteUrl: snap.remoteUrl || null,
        lastCommitAt: snap.lastCommitAt || null,
        packageName: snap.packageName || null,
        scripts: snap.scripts || {},
        detectedPort: snap.detectedPort ?? null,
        portSource: snap.portSource || null,
        hasReadme: Boolean(snap.hasReadme),
        hasAgents: Boolean(snap.hasAgents),
        hasMakemoney: Boolean(snap.hasMakemoney),
        stack: snap.stack || [],
        mtime: snap.mtime || row.updated_at || null,
      };
      const merged = mergeProject(scanned, meta);
      merged.nodeId = row.node_id;
      merged.nodeName = row.node_name || null;
      merged.nodeHostname = row.node_hostname || null;
      merged.nodeRole = row.node_role || 'agent';
      merged.local = false;
      merged.fromAgent = true;
      byId.set(row.id, merged);
    }
  }

  const projects = [...byId.values()];
  projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return {
    scannedAt: new Date().toISOString(),
    roots: settings.scanRoots || [],
    scanDepth: depth,
    node: {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      role: node.role,
    },
    projects,
  };
}

export { mergeProject, inspectProject, defaultMeta, listCandidateDirs };
