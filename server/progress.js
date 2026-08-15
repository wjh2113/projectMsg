import fs from 'node:fs/promises';
import path from 'node:path';

const STATUS_BASE = {
  planning: 12,
  developing: 38,
  on_github: 68,
  deployed: 92,
  paused: 22,
  archived: 100,
  trashed: 0,
};

async function readReadmeSnippet(projectPath) {
  for (const name of ['README.md', 'readme.md', 'AGENTS.md']) {
    try {
      const raw = await fs.readFile(path.join(projectPath, name), 'utf8');
      return raw.slice(0, 40000);
    } catch {
      // continue
    }
  }
  return '';
}

function todoScore(readme) {
  if (!readme) return { score: 0, total: 0, done: 0 };
  const lines = readme.split(/\r?\n/);
  let total = 0;
  let done = 0;
  for (const line of lines) {
    if (/^\s*[-*]\s*\[[ xX]\]/.test(line)) {
      total += 1;
      if (/^\s*[-*]\s*\[[xX]\]/.test(line)) done += 1;
    }
  }
  if (total === 0) return { score: 0, total: 0, done: 0 };
  return { score: Math.round((done / total) * 12), total, done };
}

function isDeployedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    return true;
  } catch {
    return false;
  }
}

function recentCommitBoost(lastCommitAt) {
  if (!lastCommitAt) return { score: 0, days: null };
  const t = new Date(lastCommitAt).getTime();
  if (!Number.isFinite(t)) return { score: 0, days: null };
  const days = (Date.now() - t) / (24 * 3600 * 1000);
  if (days <= 3) return { score: 12, days };
  if (days <= 14) return { score: 8, days };
  if (days <= 45) return { score: 4, days };
  return { score: 0, days };
}

/**
 * Estimate progress 0-100 from disk/git/meta signals.
 * Does not overwrite manual progress; callers decide which to display.
 */
export async function estimateProgress(project, meta = {}) {
  const reasons = [];
  const status = meta.status || project.status || 'planning';
  let score = STATUS_BASE[status] ?? 20;
  reasons.push(`状态 ${status} → ${score}`);

  if (project.packageName || Object.keys(project.scripts || {}).length) {
    score += 6;
    reasons.push('有 package.json +6');
  }
  if (project.hasGit) {
    score += 5;
    reasons.push('有 Git +5');
  }
  if (project.remoteUrl) {
    score += 12;
    reasons.push('有 GitHub remote +12');
  }
  if (project.hasReadme || project.hasAgents) {
    score += 4;
    reasons.push('有文档 +4');
  }

  const recent = recentCommitBoost(project.lastCommitAt);
  if (recent.score) {
    score += recent.score;
    reasons.push(`近 ${Math.round(recent.days)} 天有提交 +${recent.score}`);
  }

  const url = meta.url || project.url || '';
  if (isDeployedUrl(url) || status === 'deployed') {
    score += 10;
    reasons.push('存在非本地部署地址 +10');
  }

  let todos = { score: 0, total: 0, done: 0 };
  if (project.path && project.exists !== false) {
    try {
      const readme = await readReadmeSnippet(project.path);
      todos = todoScore(readme);
      if (todos.total > 0) {
        score += todos.score;
        reasons.push(`README 勾选 ${todos.done}/${todos.total} +${todos.score}`);
      }
    } catch {
      // ignore
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    estimatedProgress: score,
    progressBreakdown: reasons,
    todoStats: todos,
  };
}

export async function attachEstimates(projects, metaMap = {}) {
  return Promise.all(
    projects.map(async (p) => {
      const meta = metaMap[p.id] || metaMap[p.path] || {};
      const est = await estimateProgress(p, { ...meta, status: p.status, url: p.url });
      const manualProgress = meta.progress;
      const hasManual = manualProgress != null && manualProgress !== '';
      return {
        ...p,
        estimatedProgress: est.estimatedProgress,
        progressBreakdown: est.progressBreakdown,
        todoStats: est.todoStats,
        progress: hasManual ? Number(manualProgress) : est.estimatedProgress,
        progressSource: hasManual ? 'manual' : 'auto',
      };
    }),
  );
}
