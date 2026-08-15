import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {
  ROOT,
  DATA_DIR,
  getSettings,
  saveSettings,
  getProjectsMeta,
  saveProjectsMeta,
  projectIdFromPath,
  pathFromProjectId,
  publicLlm,
  initStore,
  getLocalNode,
  upsertProjectRow,
} from './store.js';
import { scanProjects, inspectProject, mergeProject } from './scanner.js';
import { readProjectDocs, readMakemoney } from './docs.js';
import { summarizeProject } from './llm.js';
import { getGitStatus, syncToGithub, normalizeGithubSync, getCommitHistory, createGithubRepo } from './git.js';
import { startScheduler, scheduleProjectSync, computeNextRun } from './scheduler.js';
import { probeProjects } from './health.js';
import { attachEstimates } from './progress.js';
import { generateWeeklyReport, getLatestWeeklyReport, listWeeklyReports } from './report.js';
import {
  STORE_PRESETS,
  LISTING_STATUSES,
  PRICING_MODELS,
  BILLING_PERIODS,
  CURRENCIES,
  getProjectMarketplace,
  saveProjectMarketplace,
  normalizeListing,
  normalizeFeedback,
  normalizePlatform,
  importGithubFeedback,
  generateIterationPlan,
  generateCommercialPlan,
  attachMarketplaceSummaries,
  syncStoreData,
} from './marketplace.js';
import {
  startProjectProcess,
  stopProjectProcess,
  getProcessStatus,
  getProcessLogs,
  resolveDevCommand,
  attachRuntimeStatuses,
} from './process.js';
import {
  PROVIDERS as SERVER_PROVIDERS,
  listServers,
  getServer,
  upsertServer,
  removeServer,
} from './servers.js';
import {
  normalizeDeployConfig,
  emptyDeployConfig,
  resolveDeployPublicUrl,
  deployProject,
  getDeployJob,
  testServerConnection,
  testSshBinary,
  precheckDeploy,
} from './deploy.js';
import { listNodes, upsertNode, removeNode, touchNode, getNode } from './nodes.js';

const PORT = Number(process.env.PORT) || 8800;
const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const AGENT_TOKEN = String(process.env.AGENT_TOKEN || '').trim();
const app = express();

app.use(express.json({ limit: '8mb' }));

function requireAgentToken(req, res, next) {
  if (!AGENT_TOKEN) return next();
  const token = String(req.headers['x-agent-token'] || req.body?.token || '').trim();
  if (token !== AGENT_TOKEN) {
    return res.status(401).json({ error: 'Invalid agent token' });
  }
  return next();
}

await initStore();

app.get('/api/health', async (_req, res) => {
  try {
    const node = await getLocalNode();
    res.json({
      ok: true,
      dataDir: DATA_DIR,
      database: Boolean(process.env.DATABASE_URL),
      host: HOST,
      port: PORT,
      node,
      hostname: os.hostname(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/settings', async (_req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      scanRoots: settings.scanRoots,
      scanDepth: settings.scanDepth,
      theme: settings.theme,
      llm: publicLlm(settings.llm),
      servers: settings.servers || [],
      nodeId: settings.nodeId,
      nodeName: settings.nodeName,
      nodeRole: settings.nodeRole,
      dataDir: DATA_DIR,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      listen: { host: HOST, port: PORT },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const settings = await saveSettings(body);
    res.json({
      scanRoots: settings.scanRoots,
      scanDepth: settings.scanDepth,
      theme: settings.theme,
      llm: publicLlm(settings.llm),
      servers: settings.servers || [],
      nodeId: settings.nodeId,
      nodeName: settings.nodeName,
      nodeRole: settings.nodeRole,
      dataDir: DATA_DIR,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      listen: { host: HOST, port: PORT },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

async function persistLocalScan(payload) {
  const node = await getLocalNode();
  for (const p of payload.projects || []) {
    if (p.nodeId && p.nodeId !== node.id) continue;
    if (p.fromAgent) continue;
    const meta = {
      status: p.status,
      progress: p.manual?.progress ?? null,
      url: p.manual?.url || '',
      port: p.manual?.port ?? null,
      docs: p.docs || [],
      notes: p.notes || '',
      aiSummary: p.aiSummary || '',
      aiSummaryAt: p.aiSummaryAt || null,
      aiSummaryModel: p.aiSummaryModel || null,
      githubSync: p.githubSync || null,
      deploy: p.deploy || null,
      trashReason: p.trashReason || '',
      statusBeforeTrash: p.statusBeforeTrash || null,
      trashedAt: p.trashedAt || null,
      path: p.path,
      nodeId: node.id,
    };
    await upsertProjectRow({
      id: p.id,
      nodeId: node.id,
      absPath: p.path,
      name: p.name,
      meta,
      scanSnapshot: {
        exists: p.exists,
        missing: p.missing,
        hasGit: p.hasGit,
        remoteUrl: p.remoteUrl,
        lastCommitAt: p.lastCommitAt,
        packageName: p.packageName,
        scripts: p.scripts,
        detectedPort: p.detectedPort,
        portSource: p.portSource,
        hasReadme: p.hasReadme,
        hasAgents: p.hasAgents,
        hasMakemoney: p.hasMakemoney,
        stack: p.stack,
        mtime: p.mtime,
      },
    });
  }
}

async function buildProjectsPayload() {
  const payload = await scanProjects();
  await persistLocalScan(payload);
  const metaMap = await getProjectsMeta();
  payload.projects = await attachEstimates(payload.projects, metaMap);
  payload.projects = await attachMarketplaceSummaries(payload.projects);
  payload.projects = await attachRuntimeStatuses(payload.projects);
  return payload;
}

async function enrichProject(scanned, meta) {
  const merged = mergeProject(scanned, meta || {});
  const [withEst] = await attachEstimates([merged], { [merged.id]: meta || {} });
  return withEst;
}

app.get('/api/projects', async (_req, res) => {
  try {
    res.json(await buildProjectsPayload());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/scan', async (_req, res) => {
  try {
    res.json(await buildProjectsPayload());
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/probe', async (req, res) => {
  try {
    let projects = req.body?.projects;
    if (!Array.isArray(projects) || projects.length === 0) {
      const payload = await buildProjectsPayload();
      projects = payload.projects.map((p) => ({
        id: p.id,
        url: p.url,
        port: p.port,
      }));
    }
    res.json(await probeProjects(projects));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/reports/weekly', async (_req, res) => {
  try {
    res.json({
      latest: await getLatestWeeklyReport(),
      list: await listWeeklyReports(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/reports/weekly', async (_req, res) => {
  try {
    const payload = await buildProjectsPayload();
    // attach last known health if client sent none — probe quickly for weekly context
    const probed = await probeProjects(
      payload.projects.map((p) => ({ id: p.id, url: p.url, port: p.port })),
    );
    const byId = Object.fromEntries(probed.results.map((r) => [r.id, r]));
    const withHealth = payload.projects.map((p) => ({ ...p, health: byId[p.id] || null }));
    const report = await generateWeeklyReport(withHealth);
    res.status(201).json(report);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const metaMap = await getProjectsMeta();
    const meta = metaMap[req.params.id] || metaMap[absPath] || {};
    const scanned = await inspectProject(absPath);
    if (!scanned) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const docs = await readProjectDocs(absPath);
    res.json({
      ...mergeProject(scanned, meta),
      readme: docs.readme,
      makemoney: docs.makemoney
        ? {
            name: docs.makemoney.name,
            path: docs.makemoney.path,
            size: docs.makemoney.size,
            mtime: docs.makemoney.mtime,
            truncated: docs.makemoney.truncated,
            content: docs.makemoney.content,
          }
        : null,
      docFiles: docs.docs.map(({ content, ...rest }) => ({
        ...rest,
        preview: (content || '').slice(0, 500),
      })),
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/makemoney', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const file = await readMakemoney(absPath);
    if (!file) {
      return res.status(404).json({ error: 'makemoney.md not found' });
    }
    res.json(file);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/readme', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const docs = await readProjectDocs(absPath);
    if (!docs.readme) {
      return res.status(404).json({ error: 'README not found' });
    }
    res.json(docs.readme);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const body = req.body || {};
    const absPath = path.resolve(String(body.path || '').trim());
    if (!absPath || absPath === path.resolve('')) {
      return res.status(400).json({ error: 'path is required' });
    }

    const scanned = await inspectProject(absPath);
    if (!scanned || scanned.missing) {
      return res.status(400).json({ error: 'Path does not exist or is not reachable' });
    }

    const id = projectIdFromPath(absPath);
    const metaMap = await getProjectsMeta();
    const existing = metaMap[id] || {};
    metaMap[id] = {
      ...existing,
      path: absPath,
      status: body.status || existing.status || 'planning',
      progress: body.progress ?? existing.progress ?? 0,
      url: body.url ?? existing.url ?? '',
      port: body.port ?? existing.port ?? null,
      docs: Array.isArray(body.docs) ? body.docs : existing.docs || [],
      notes: body.notes ?? existing.notes ?? '',
      aiSummary: existing.aiSummary || '',
      aiSummaryAt: existing.aiSummaryAt || null,
      aiSummaryModel: existing.aiSummaryModel || null,
    };
    await saveProjectsMeta(metaMap);
    res.status(201).json(await enrichProject(scanned, metaMap[id]));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch('/api/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let absPath;
    try {
      absPath = pathFromProjectId(id);
    } catch {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const metaMap = await getProjectsMeta();
    const prev = metaMap[id] || { path: absPath };
    const body = req.body || {};

    const next = {
      ...prev,
      path: absPath,
    };

    if ('status' in body) next.status = body.status;
    if ('progress' in body) next.progress = body.progress;
    if ('url' in body) next.url = body.url;
    if ('port' in body) next.port = body.port === '' || body.port == null ? null : Number(body.port);
    if ('docs' in body) next.docs = Array.isArray(body.docs) ? body.docs : [];
    if ('notes' in body) next.notes = body.notes;
    if ('aiSummary' in body) next.aiSummary = body.aiSummary;
    if ('aiSummaryAt' in body) next.aiSummaryAt = body.aiSummaryAt;
    if ('aiSummaryModel' in body) next.aiSummaryModel = body.aiSummaryModel;
    if ('trashReason' in body) next.trashReason = String(body.trashReason || '');

    // 作废 → 回收站；从回收站恢复时清掉作废元数据
    if ('status' in body) {
      if (body.status === 'trashed' && prev.status !== 'trashed') {
        next.statusBeforeTrash = prev.status || 'planning';
        next.trashedAt = new Date().toISOString();
        if (!('trashReason' in body)) next.trashReason = prev.trashReason || '';
      } else if (body.status !== 'trashed' && prev.status === 'trashed') {
        next.statusBeforeTrash = null;
        next.trashedAt = null;
        next.trashReason = '';
      }
    }

    // 显式恢复：不传新状态时回到作废前状态
    if (body.restore === true && prev.status === 'trashed') {
      next.status = prev.statusBeforeTrash || 'planning';
      next.statusBeforeTrash = null;
      next.trashedAt = null;
      next.trashReason = '';
    }

    if ('githubSync' in body && body.githubSync && typeof body.githubSync === 'object') {
      const sync = normalizeGithubSync(body.githubSync, prev.githubSync || {});
      if (sync.enabled) {
        sync.nextRunAt =
          sync.nextRunAt && new Date(sync.nextRunAt).getTime() > Date.now()
            ? sync.nextRunAt
            : computeNextRun(null, sync.intervalMinutes);
      } else {
        sync.nextRunAt = null;
      }
      next.githubSync = sync;
    }

    if ('deploy' in body && body.deploy && typeof body.deploy === 'object') {
      next.deploy = normalizeDeployConfig(body.deploy, prev.deploy || {});
    }

    metaMap[id] = next;
    await saveProjectsMeta(metaMap);

    const scanned = await inspectProject(absPath);
    if (!scanned) {
      return res.json(
        await enrichProject(
          {
            id,
            name: path.basename(absPath),
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
            stack: [],
            mtime: null,
          },
          next,
        ),
      );
    }

    res.json(await enrichProject(scanned, next));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/summarize', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const metaMap = await getProjectsMeta();
    const meta = metaMap[id] || { path: absPath };
    const scanned = await inspectProject(absPath);
    if (!scanned || scanned.missing) {
      return res.status(404).json({ error: 'Project not found on disk' });
    }

    const docs = await readProjectDocs(absPath);
    const result = await summarizeProject({
      name: scanned.name,
      projectPath: absPath,
      readme: docs.readme,
      meta: {
        status: meta.status,
        notes: meta.notes,
        url: meta.url,
        port: meta.port ?? scanned.detectedPort,
      },
    });

    metaMap[id] = {
      ...meta,
      path: absPath,
      aiSummary: result.text,
      aiSummaryAt: new Date().toISOString(),
      aiSummaryModel: result.model,
    };
    await saveProjectsMeta(metaMap);

    res.json({
      project: mergeProject(scanned, metaMap[id]),
      summary: result.text,
      model: result.model,
      usage: result.usage,
      readmeName: docs.readme?.name || null,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/git', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const fetchRemote = String(req.query.fetch || '') === '1';
    const status = await getGitStatus(absPath, { fetchRemote });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/github-sync', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const body = req.body || {};
    const metaMap = await getProjectsMeta();
    const prev = metaMap[id] || { path: absPath };
    const syncCfg = normalizeGithubSync(prev.githubSync || {});

    const result = await syncToGithub(absPath, {
      autoCommit: body.autoCommit != null ? Boolean(body.autoCommit) : syncCfg.autoCommit,
      commitMessage: body.commitMessage || syncCfg.commitMessage,
    });

    const lastRunAt = new Date().toISOString();
    metaMap[id] = {
      ...prev,
      path: absPath,
      githubSync: {
        ...syncCfg,
        lastRunAt,
        lastOk: Boolean(result.ok),
        lastMessage: result.ok ? result.message : result.error || 'failed',
        nextRunAt: syncCfg.enabled
          ? computeNextRun(lastRunAt, syncCfg.intervalMinutes)
          : syncCfg.nextRunAt,
      },
    };
    // If manual sync succeeded and project was developing, bump toward on_github
    if (result.ok && (!prev.status || prev.status === 'developing' || prev.status === 'planning')) {
      metaMap[id].status = 'on_github';
    }
    await saveProjectsMeta(metaMap);

    const scanned = await inspectProject(absPath);
    res.status(result.ok ? 200 : 400).json({
      ...result,
      project: scanned ? mergeProject(scanned, metaMap[id]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.put('/api/projects/:id/github-schedule', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const saved = await scheduleProjectSync(id, absPath, req.body || {});
    const scanned = await inspectProject(absPath);
    res.json({
      githubSync: saved.githubSync,
      project: scanned ? mergeProject(scanned, saved) : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/alerts/github-sync', async (_req, res) => {
  try {
    const metaMap = await getProjectsMeta();
    const failures = [];
    for (const [id, meta] of Object.entries(metaMap)) {
      const sync = meta.githubSync || {};
      if (!sync.enabled) continue;
      if (sync.lastOk === false) {
        failures.push({
          id,
          name: path.basename(meta.path || id),
          path: meta.path || '',
          lastRunAt: sync.lastRunAt || null,
          lastMessage: sync.lastMessage || '同步失败',
          nextRunAt: sync.nextRunAt || null,
        });
      }
    }
    failures.sort((a, b) => String(b.lastRunAt || '').localeCompare(String(a.lastRunAt || '')));
    res.json({ count: failures.length, failures });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/commits', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const limit = Number(req.query.limit) || 20;
    res.json(await getCommitHistory(absPath, { limit }));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/github-create', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const body = req.body || {};
    const result = await createGithubRepo(absPath, {
      name: body.name,
      private: body.private,
      description: body.description,
      push: body.push,
    });

    if (result.ok) {
      const metaMap = await getProjectsMeta();
      const prev = metaMap[id] || { path: absPath };
      metaMap[id] = {
        ...prev,
        path: absPath,
        status:
          !prev.status || prev.status === 'planning' || prev.status === 'developing'
            ? 'on_github'
            : prev.status,
      };
      await saveProjectsMeta(metaMap);
      const scanned = await inspectProject(absPath);
      return res.json({
        ...result,
        project: scanned ? mergeProject(scanned, metaMap[id]) : null,
      });
    }
    res.status(400).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/runtime', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const cmd = await resolveDevCommand(absPath);
    res.json({
      ...getProcessStatus(req.params.id),
      availableScript: cmd.ok ? cmd.script : null,
      scripts: cmd.scripts || [],
      resolveError: cmd.ok ? null : cmd.error,
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/runtime/logs', async (req, res) => {
  try {
    pathFromProjectId(req.params.id);
    const since = Number(req.query.since) || 0;
    res.json(getProcessLogs(req.params.id, { since }));
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/runtime/start', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const result = await startProjectProcess(absPath, {
      script: req.body?.script || null,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/runtime/stop', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const result = await stopProjectProcess(absPath);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.get('/api/marketplace/meta', (_req, res) => {
  res.json({
    stores: STORE_PRESETS,
    listingStatuses: LISTING_STATUSES,
    pricingModels: PRICING_MODELS,
    billingPeriods: BILLING_PERIODS,
    currencies: CURRENCIES,
  });
});

app.get('/api/projects/:id/marketplace', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.put('/api/projects/:id/marketplace', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const body = req.body || {};
    const listings = Array.isArray(body.listings)
      ? body.listings.map((l) => normalizeListing(l))
      : undefined;
    const feedback = Array.isArray(body.feedback)
      ? body.feedback.map((f) => normalizeFeedback(f))
      : undefined;
    const platforms = Array.isArray(body.platforms)
      ? body.platforms.map((p) => normalizePlatform(p))
      : undefined;
    const saved = await saveProjectMarketplace(
      req.params.id,
      {
        listings,
        feedback,
        platforms,
        iterationPlan: body.iterationPlan,
        commercialPlan: body.commercialPlan,
        devProgressNotes: body.devProgressNotes,
      },
      absPath,
    );
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/listings', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const listing = normalizeListing(req.body || {});
    const listings = [...(record.listings || []), listing];
    const saved = await saveProjectMarketplace(req.params.id, { listings }, absPath);
    res.status(201).json({ listing, record: saved });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch('/api/projects/:id/marketplace/listings/:listingId', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const idx = (record.listings || []).findIndex((l) => l.id === req.params.listingId);
    if (idx < 0) return res.status(404).json({ error: 'Listing not found' });
    const listings = [...record.listings];
    listings[idx] = normalizeListing(req.body || {}, listings[idx]);
    const saved = await saveProjectMarketplace(req.params.id, { listings }, absPath);
    res.json({ listing: listings[idx], record: saved });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/projects/:id/marketplace/listings/:listingId', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const listings = (record.listings || []).filter((l) => l.id !== req.params.listingId);
    const saved = await saveProjectMarketplace(req.params.id, { listings }, absPath);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/platforms', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const platform = normalizePlatform(req.body || {});
    const platforms = [...(record.platforms || []), platform];
    const saved = await saveProjectMarketplace(req.params.id, { platforms }, absPath);
    res.status(201).json({ platform, record: saved });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.patch('/api/projects/:id/marketplace/platforms/:platformId', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const idx = (record.platforms || []).findIndex((p) => p.id === req.params.platformId);
    if (idx < 0) return res.status(404).json({ error: 'Platform ops not found' });
    const platforms = [...record.platforms];
    platforms[idx] = normalizePlatform(req.body || {}, platforms[idx]);
    const saved = await saveProjectMarketplace(req.params.id, { platforms }, absPath);
    res.json({ platform: platforms[idx], record: saved });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/projects/:id/marketplace/platforms/:platformId', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const platforms = (record.platforms || []).filter((p) => p.id !== req.params.platformId);
    const saved = await saveProjectMarketplace(req.params.id, { platforms }, absPath);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/feedback', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const item = normalizeFeedback(req.body || {});
    const feedback = [item, ...(record.feedback || [])];
    const saved = await saveProjectMarketplace(req.params.id, { feedback }, absPath);
    res.status(201).json({ feedback: item, record: saved });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/projects/:id/marketplace/feedback/:feedbackId', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const record = await getProjectMarketplace(req.params.id, absPath);
    const feedback = (record.feedback || []).filter((f) => f.id !== req.params.feedbackId);
    const saved = await saveProjectMarketplace(req.params.id, { feedback }, absPath);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/import-github', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const scanned = await inspectProject(absPath);
    const remoteUrl = req.body?.remoteUrl || scanned?.remoteUrl;
    if (!remoteUrl) {
      return res.status(400).json({ error: '项目没有 GitHub remote，无法拉取 Issues' });
    }
    const result = await importGithubFeedback(req.params.id, remoteUrl, absPath);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/sync-store', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const body = req.body || {};
    const result = await syncStoreData(req.params.id, absPath, {
      url: body.url,
      listingId: body.listingId,
      platformId: body.platformId,
      store: body.store,
      appId: body.appId,
      country: body.country,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/iteration-plan', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const metaMap = await getProjectsMeta();
    const meta = metaMap[id] || {};
    const scanned = await inspectProject(absPath);
    const record = await getProjectMarketplace(id, absPath);

    const result = await generateIterationPlan({
      projectName: scanned?.name || path.basename(absPath),
      status: meta.status || scanned?.status,
      progress: meta.progress,
      listings: record.listings,
      feedback: record.feedback,
      platforms: record.platforms,
      devProgressNotes: record.devProgressNotes,
      aiSummary: meta.aiSummary,
    });

    const iterationPlan = {
      content: result.text,
      generatedAt: new Date().toISOString(),
      model: result.model,
      basedOnFeedbackCount: (record.feedback || []).length,
    };
    const saved = await saveProjectMarketplace(id, { iterationPlan }, absPath);
    res.json({
      plan: iterationPlan,
      record: saved,
      usage: result.usage,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/marketplace/commercial-plan', async (req, res) => {
  try {
    const { id } = req.params;
    const absPath = pathFromProjectId(id);
    const metaMap = await getProjectsMeta();
    const meta = metaMap[id] || {};
    const scanned = await inspectProject(absPath);
    const record = await getProjectMarketplace(id, absPath);
    const docs = await readProjectDocs(absPath);

    const result = await generateCommercialPlan({
      projectName: scanned?.name || path.basename(absPath),
      status: meta.status || scanned?.status,
      makemoney: docs.makemoney,
      readme: docs.readme,
      platforms: record.platforms,
      listings: record.listings,
      aiSummary: meta.aiSummary,
    });

    const commercialPlan = {
      content: result.text,
      generatedAt: new Date().toISOString(),
      model: result.model,
      sourceFile: result.sourceFile,
      basedOnMakemoney: Boolean(result.basedOnMakemoney),
    };
    const saved = await saveProjectMarketplace(id, { commercialPlan }, absPath);
    res.json({
      plan: commercialPlan,
      makemoney: docs.makemoney
        ? { name: docs.makemoney.name, path: docs.makemoney.path, size: docs.makemoney.size }
        : null,
      record: saved,
      usage: result.usage,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.get('/api/servers', async (_req, res) => {
  try {
    const [servers, ssh] = await Promise.all([listServers(), testSshBinary()]);
    res.json({ servers, providers: SERVER_PROVIDERS, ssh });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/servers', async (req, res) => {
  try {
    const saved = await upsertServer(req.body || {});
    res.status(201).json({ server: saved, servers: await listServers() });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.put('/api/servers/:id', async (req, res) => {
  try {
    const saved = await upsertServer({ ...(req.body || {}), id: req.params.id });
    res.json({ server: saved, servers: await listServers() });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/servers/:id', async (req, res) => {
  try {
    const servers = await removeServer(req.params.id);
    res.json({ servers });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/servers/:id/test', async (req, res) => {
  try {
    const result = await testServerConnection(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.get('/api/projects/:id/deploy', async (req, res) => {
  try {
    const absPath = pathFromProjectId(req.params.id);
    const metaMap = await getProjectsMeta();
    const prev = metaMap[req.params.id] || {};
    const deploy = normalizeDeployConfig(prev.deploy || emptyDeployConfig());
    const server = deploy.serverId ? await getServer(deploy.serverId) : null;
    const publicUrl = resolveDeployPublicUrl(deploy, server);
    res.json({
      deploy,
      publicUrl,
      publicPort: deploy.port,
      job: getDeployJob(req.params.id),
      server: server
        ? { id: server.id, name: server.name, host: server.host, provider: server.provider }
        : null,
      defaults: emptyDeployConfig(),
      path: absPath,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.put('/api/projects/:id/deploy', async (req, res) => {
  try {
    const id = req.params.id;
    const absPath = pathFromProjectId(id);
    const metaMap = await getProjectsMeta();
    const prev = metaMap[id] || { path: absPath };
    let deploy = normalizeDeployConfig(req.body || {}, prev.deploy || {});
    const server = deploy.serverId ? await getServer(deploy.serverId) : null;
    const publicUrl = resolveDeployPublicUrl(deploy, server);
    if (publicUrl && !deploy.url) {
      deploy = normalizeDeployConfig({ ...deploy, url: publicUrl }, deploy);
    }
    const next = {
      ...prev,
      path: absPath,
      deploy,
    };
    if (publicUrl) next.url = publicUrl;
    if (deploy.port != null) next.port = deploy.port;
    metaMap[id] = next;
    await saveProjectsMeta(metaMap);
    res.json({
      deploy,
      publicUrl: publicUrl || deploy.url || '',
      publicPort: deploy.port,
      projectId: id,
      projectPatch: {
        id,
        url: next.url,
        port: next.port,
        deploy,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/deploy', async (req, res) => {
  try {
    const id = req.params.id;
    const absPath = pathFromProjectId(id);
    const body = req.body || {};
    const metaMap = await getProjectsMeta();
    const prev = metaMap[id] || { path: absPath };
    const deploy = normalizeDeployConfig(
      { ...(prev.deploy || {}), ...(body.deploy || body) },
      prev.deploy || {},
    );
    // persist config before running
    metaMap[id] = { ...prev, path: absPath, deploy };
    await saveProjectsMeta(metaMap);

    const result = await deployProject(id, absPath, {
      deploy,
      autoCommit: body.autoCommit !== false,
      commitMessage: body.commitMessage,
      markDeployed: body.markDeployed !== false,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      error: String(err.message || err),
      deploy: err.deploy || null,
      job: err.job || getDeployJob(req.params.id),
    });
  }
});

app.get('/api/projects/:id/deploy/logs', async (req, res) => {
  try {
    res.json(getDeployJob(req.params.id));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/projects/:id/deploy/precheck', async (req, res) => {
  try {
    const id = req.params.id;
    const absPath = pathFromProjectId(id);
    const metaMap = await getProjectsMeta();
    const prev = metaMap[id] || {};
    const deploy = normalizeDeployConfig(
      { ...(prev.deploy || {}), ...(req.body?.deploy || req.body || {}) },
      prev.deploy || {},
    );
    res.json(await precheckDeploy(id, absPath, deploy));
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err), precheck: err.precheck || null });
  }
});

app.get('/api/nodes', async (_req, res) => {
  try {
    res.json({ nodes: await listNodes(), local: await getLocalNode() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/nodes', async (req, res) => {
  try {
    const node = await upsertNode(req.body || {});
    res.status(201).json({ node, nodes: await listNodes() });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.delete('/api/nodes/:id', async (req, res) => {
  try {
    const nodes = await removeNode(req.params.id);
    res.json({ nodes });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

app.post('/api/nodes/sync', requireAgentToken, async (req, res) => {
  try {
    const body = req.body || {};
    const nodeInput = body.node || {};
    if (!nodeInput.id) {
      return res.status(400).json({ error: 'node.id is required' });
    }
    const node = await upsertNode({
      id: nodeInput.id,
      name: nodeInput.name,
      hostname: nodeInput.hostname,
      role: 'agent',
      scanRoots: nodeInput.scanRoots,
      scanDepth: nodeInput.scanDepth,
      baseUrl: nodeInput.baseUrl,
    });
    await touchNode(node.id, {
      scanRoots: nodeInput.scanRoots,
      scanDepth: nodeInput.scanDepth,
    });

    let upserted = 0;
    for (const p of body.projects || []) {
      if (!p?.id || !p?.path) continue;
      const prevMeta = (await getProjectsMeta())[p.id] || {};
      const meta = {
        ...prevMeta,
        ...(p.meta || {}),
        path: p.path,
        nodeId: node.id,
      };
      await upsertProjectRow({
        id: p.id,
        nodeId: node.id,
        absPath: p.path,
        name: p.name || path.basename(p.path),
        meta,
        scanSnapshot: p.scanSnapshot || {},
      });
      upserted += 1;
    }

    res.json({
      ok: true,
      node,
      upserted,
      scannedAt: body.scannedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/api/nodes/:id', async (req, res) => {
  try {
    const node = await getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    res.json({ node });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

async function serveClient() {
  const dist = path.join(ROOT, 'client', 'dist');
  try {
    await fs.access(path.join(dist, 'index.html'));
  } catch {
    console.log('[project-msg] no client/dist yet — use npm run dev (Vite on :5177)');
    return;
  }

  app.use(express.static(dist));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

await serveClient();

app.listen(PORT, HOST, () => {
  const localUrl = `http://127.0.0.1:${PORT}`;
  console.log(`[project-msg] API ${localUrl} (bind ${HOST}:${PORT})`);
  console.log(`[project-msg] LAN: http://<this-pc-ip>:${PORT}`);
  console.log(`[project-msg] data ${DATA_DIR}`);
  console.log(`[project-msg] db ${process.env.DATABASE_URL ? 'postgres' : 'MISSING DATABASE_URL'}`);
  startScheduler();
});
