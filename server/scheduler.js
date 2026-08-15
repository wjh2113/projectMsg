import { getProjectsMeta, saveProjectsMeta } from './store.js';
import { syncToGithub, normalizeGithubSync } from './git.js';

let timer = null;
let running = false;

function computeNextRun(fromIso, intervalMinutes) {
  const base = fromIso ? new Date(fromIso).getTime() : Date.now();
  const next = base + intervalMinutes * 60 * 1000;
  return new Date(Math.max(next, Date.now() + 1000)).toISOString();
}

async function runDueJobs() {
  if (running) return;
  running = true;
  try {
    const metaMap = await getProjectsMeta();
    let dirty = false;
    const now = Date.now();

    for (const [id, meta] of Object.entries(metaMap)) {
      const sync = normalizeGithubSync(meta.githubSync || {});
      if (!sync.enabled) continue;
      if (!meta.path) continue;

      const due = !sync.nextRunAt || new Date(sync.nextRunAt).getTime() <= now;
      if (!due) continue;

      let result;
      try {
        result = await syncToGithub(meta.path, {
          autoCommit: sync.autoCommit,
          commitMessage: sync.commitMessage,
        });
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }

      const lastRunAt = new Date().toISOString();
      metaMap[id] = {
        ...meta,
        githubSync: {
          ...sync,
          lastRunAt,
          lastOk: Boolean(result.ok),
          lastMessage: result.ok ? result.message : result.error || 'failed',
          nextRunAt: computeNextRun(lastRunAt, sync.intervalMinutes),
        },
      };
      dirty = true;
      console.log(
        `[scheduler] ${meta.path} => ${result.ok ? 'ok' : 'fail'}: ${
          result.ok ? result.message : result.error
        }`,
      );
    }

    if (dirty) await saveProjectsMeta(metaMap);
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (timer) return;
  // first tick after short delay, then every minute
  setTimeout(() => {
    runDueJobs();
  }, 5000);
  timer = setInterval(runDueJobs, 60 * 1000);
  console.log('[scheduler] github sync scheduler started (tick=60s)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function scheduleProjectSync(id, absPath, githubSyncInput) {
  const metaMap = await getProjectsMeta();
  const prev = metaMap[id] || { path: absPath };
  const sync = normalizeGithubSync(githubSyncInput, prev.githubSync || {});
  if (sync.enabled && !sync.nextRunAt) {
    sync.nextRunAt = computeNextRun(null, sync.intervalMinutes);
  }
  if (!sync.enabled) {
    sync.nextRunAt = null;
  }
  metaMap[id] = {
    ...prev,
    path: absPath,
    githubSync: sync,
  };
  await saveProjectsMeta(metaMap);
  return metaMap[id];
}

export { runDueJobs, computeNextRun };
