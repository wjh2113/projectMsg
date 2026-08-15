/**
 * Lightweight scan agent for other PCs on the LAN.
 * Scans local roots and pushes snapshots to the hub PostgreSQL via HTTP API.
 *
 * Usage on a secondary machine:
 *   NODE_ROLE=agent HUB_URL=http://hub-ip:8800 npm run agent
 */
import 'dotenv/config';
import os from 'node:os';
import {
  getLocalNode,
  getSettings,
  initStore,
  projectIdFromPath,
  saveSettings,
} from './store.js';
import { scanProjects } from './scanner.js';

const HUB_URL = String(process.env.HUB_URL || '').replace(/\/$/, '');
const INTERVAL_MS = Math.max(30_000, Number(process.env.AGENT_INTERVAL_MS) || 120_000);
const TOKEN = String(process.env.AGENT_TOKEN || '').trim();

async function hubFetch(pathname, options = {}) {
  if (!HUB_URL) throw new Error('HUB_URL is required for agent mode');
  const res = await fetch(`${HUB_URL}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-Agent-Token': TOKEN } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `hub ${res.status}`);
  return data;
}

async function pushOnce() {
  await initStore();
  const node = await getLocalNode();
  const settings = await getSettings();
  const payload = await scanProjects({ localOnly: true });

  const projects = payload.projects.map((p) => {
    const id = projectIdFromPath(p.path, node.id);
    return {
      id,
      path: p.path,
      name: p.name,
      meta: {
        status: p.status,
        progress: p.manual?.progress ?? null,
        url: p.manual?.url || '',
        port: p.manual?.port ?? null,
        docs: p.docs || [],
        notes: p.notes || '',
        aiSummary: p.aiSummary || '',
        nodeId: node.id,
      },
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
    };
  });

  await hubFetch('/api/nodes/sync', {
    method: 'POST',
    body: JSON.stringify({
      node: {
        id: node.id,
        name: node.name,
        hostname: os.hostname(),
        role: 'agent',
        scanRoots: settings.scanRoots,
        scanDepth: settings.scanDepth,
        baseUrl: process.env.AGENT_BASE_URL || '',
      },
      projects,
      scannedAt: payload.scannedAt,
    }),
  });

  console.log(
    `[agent] pushed ${projects.length} projects from ${node.name} → ${HUB_URL} @ ${new Date().toISOString()}`,
  );
}

async function main() {
  if (!HUB_URL) {
    console.error('Set HUB_URL=http://<hub-lan-ip>:8800');
    process.exit(1);
  }
  process.env.NODE_ROLE = 'agent';
  await initStore();
  // Ensure depth from env
  if (process.env.SCAN_DEPTH) {
    await saveSettings({ scanDepth: Number(process.env.SCAN_DEPTH) });
  }
  console.log(`[agent] hub=${HUB_URL} interval=${INTERVAL_MS}ms host=${os.hostname()}`);
  await pushOnce();
  setInterval(() => {
    pushOnce().catch((err) => console.error('[agent]', err.message || err));
  }, INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
