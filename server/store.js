import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, ROOT, ensureSchema, query } from './db.js';

export { ROOT, DATA_DIR };
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
export const MARKETPLACE_PATH = path.join(DATA_DIR, 'marketplace.json');
export const NODE_FILE = path.join(DATA_DIR, 'node.json');

const DEFAULT_LLM = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-v4-flash',
  enabled: false,
};

const THEMES = new Set(['luxury', 'neu', 'minimal', 'classic']);

const DEFAULT_SETTINGS = {
  scanRoots: ['D:\\VSworkspace'],
  scanDepth: 1,
  theme: 'luxury',
  llm: { ...DEFAULT_LLM },
  servers: [],
};

let ready = null;

export async function initStore() {
  if (ready) return ready;
  ready = (async () => {
    await ensureSchema();
    await ensureLocalNode();
    await maybeMigrateFromJson();
    return true;
  })();
  return ready;
}

function envLlmOverrides(base) {
  const next = { ...base };
  if (process.env.LLM_API_KEY) next.apiKey = String(process.env.LLM_API_KEY);
  if (process.env.LLM_BASE_URL) next.baseUrl = String(process.env.LLM_BASE_URL).replace(/\/$/, '');
  if (process.env.LLM_MODEL) next.model = String(process.env.LLM_MODEL);
  if (process.env.LLM_ENABLED != null && process.env.LLM_ENABLED !== '') {
    next.enabled = /^(1|true|yes|on)$/i.test(String(process.env.LLM_ENABLED));
  }
  return next;
}

function normalizeLlm(input = {}, prev = {}) {
  const base = { ...DEFAULT_LLM, ...prev, ...input };
  return envLlmOverrides({
    provider: String(base.provider || 'deepseek'),
    baseUrl: String(base.baseUrl || DEFAULT_LLM.baseUrl).replace(/\/$/, ''),
    apiKey: typeof base.apiKey === 'string' ? base.apiKey : '',
    model: String(base.model || DEFAULT_LLM.model),
    enabled: Boolean(base.enabled),
  });
}

export function publicLlm(llm) {
  const key = llm?.apiKey || '';
  const enabled = Boolean(llm?.enabled && key);
  return {
    provider: llm?.provider || 'deepseek',
    baseUrl: llm?.baseUrl || DEFAULT_LLM.baseUrl,
    model: llm?.model || DEFAULT_LLM.model,
    enabled,
    configured: enabled,
    hasKey: Boolean(key),
    apiKeyMasked: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
  };
}

function normalizeScanRoots(roots, fallback) {
  const cleaned = (Array.isArray(roots) ? roots : [])
    .map((r) => String(r).trim())
    .filter(Boolean);
  if (cleaned.length > 0) return cleaned;
  const fb = (Array.isArray(fallback) ? fallback : [])
    .map((r) => String(r).trim())
    .filter(Boolean);
  return fb.length > 0 ? fb : [...DEFAULT_SETTINGS.scanRoots];
}

function normalizeScanDepth(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(4, Math.max(1, Math.round(n)));
}

function normalizeServersInSettings(list, fallback = []) {
  if (!Array.isArray(list)) return Array.isArray(fallback) ? fallback : [];
  return list
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: String(s.id || ''),
      name: String(s.name || ''),
      provider: String(s.provider || 'other'),
      host: String(s.host || '').trim(),
      port: Number(s.port) > 0 ? Math.round(Number(s.port)) : 22,
      username: String(s.username || 'root'),
      authMethod: s.authMethod === 'agent' ? 'agent' : 'key',
      privateKeyPath: String(s.privateKeyPath || ''),
      notes: String(s.notes || ''),
      createdAt: s.createdAt || null,
      updatedAt: s.updatedAt || null,
    }))
    .filter((s) => s.host && s.id);
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

/** Legacy JSON helpers kept for migration / marketplace import paths */
export async function readJson(filePath, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  return readJsonFile(filePath, fallback);
}

export async function writeJson(filePath, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const text = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.copyFile(tmp, filePath);
  } finally {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
  }
}

export async function ensureLocalNode() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let local = await readJsonFile(NODE_FILE, null);
  const hostname = os.hostname();
  const role = String(process.env.NODE_ROLE || local?.role || 'hub').toLowerCase() === 'agent'
    ? 'agent'
    : 'hub';
  const id = String(process.env.NODE_ID || local?.id || randomUUID());
  const name = String(process.env.NODE_NAME || local?.name || hostname || 'local');
  const scanDepth = normalizeScanDepth(
    process.env.SCAN_DEPTH || local?.scanDepth,
    DEFAULT_SETTINGS.scanDepth,
  );

  local = {
    id,
    name,
    hostname,
    role,
    scanDepth,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(NODE_FILE, local);

  await query(
    `INSERT INTO nodes (id, name, hostname, role, scan_roots, scan_depth, last_seen_at, meta, updated_at)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, NOW(), '{}'::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       hostname = EXCLUDED.hostname,
       role = EXCLUDED.role,
       scan_depth = EXCLUDED.scan_depth,
       last_seen_at = NOW(),
       updated_at = NOW()`,
    [id, name, hostname, role, scanDepth],
  );
  return local;
}

export async function getLocalNode() {
  await initStore();
  return ensureLocalNode();
}

async function maybeMigrateFromJson() {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM projects');
  if ((rows[0]?.n || 0) > 0) return;

  const settingsJson = await readJsonFile(SETTINGS_PATH, null);
  const projectsJson = await readJsonFile(PROJECTS_PATH, null);
  const marketplaceJson = await readJsonFile(MARKETPLACE_PATH, null);
  const reportsJson = await readJsonFile(path.join(DATA_DIR, 'reports.json'), null);
  if (!settingsJson && !projectsJson) return;

  console.log('[store] migrating JSON → PostgreSQL…');
  const node = await ensureLocalNode();

  if (settingsJson) {
    const llm = normalizeLlm(settingsJson.llm || {}, {});
    // Prefer env key; strip migrating key into env-only if present
    await query(
      `UPDATE settings SET
         theme = $1,
         scan_roots = $2::jsonb,
         scan_depth = $3,
         llm = $4::jsonb,
         servers = $5::jsonb,
         updated_at = NOW()
       WHERE id = 1`,
      [
        THEMES.has(settingsJson.theme) ? settingsJson.theme : 'luxury',
        JSON.stringify(normalizeScanRoots(settingsJson.scanRoots, DEFAULT_SETTINGS.scanRoots)),
        normalizeScanDepth(settingsJson.scanDepth ?? process.env.SCAN_DEPTH, 1),
        JSON.stringify({
          ...llm,
          apiKey: process.env.LLM_API_KEY ? '' : llm.apiKey,
        }),
        JSON.stringify(normalizeServersInSettings(settingsJson.servers || [], [])),
      ],
    );
    await query(
      `UPDATE nodes SET scan_roots = $2::jsonb, scan_depth = $3, updated_at = NOW() WHERE id = $1`,
      [
        node.id,
        JSON.stringify(normalizeScanRoots(settingsJson.scanRoots, DEFAULT_SETTINGS.scanRoots)),
        normalizeScanDepth(settingsJson.scanDepth ?? process.env.SCAN_DEPTH, 2),
      ],
    );
  }

  if (projectsJson && typeof projectsJson === 'object') {
    for (const [id, meta] of Object.entries(projectsJson)) {
      if (!meta || typeof meta !== 'object') continue;
      const abs = String(meta.path || '').trim();
      if (!abs) continue;
      const name = path.basename(abs);
      await query(
        `INSERT INTO projects (id, node_id, path, name, meta, scan_snapshot, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET
           node_id = EXCLUDED.node_id,
           path = EXCLUDED.path,
           name = EXCLUDED.name,
           meta = EXCLUDED.meta,
           updated_at = NOW()`,
        [id, node.id, abs, name, JSON.stringify(meta)],
      );
    }
  }

  if (marketplaceJson && typeof marketplaceJson === 'object') {
    for (const [projectId, data] of Object.entries(marketplaceJson)) {
      if (!data || typeof data !== 'object') continue;
      await query(
        `INSERT INTO marketplace (project_id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (project_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [projectId, JSON.stringify(data)],
      );
    }
  }

  const weekly = Array.isArray(reportsJson?.weekly) ? reportsJson.weekly : [];
  for (const report of weekly) {
    if (!report?.id) continue;
    await query(
      `INSERT INTO reports (id, type, content, model, project_count, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, NOW()))
       ON CONFLICT (id) DO NOTHING`,
      [
        report.id,
        report.type || 'weekly',
        report.content || '',
        report.model || null,
        report.projectCount || 0,
        JSON.stringify(report),
        report.createdAt || null,
      ],
    );
  }

  await query(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES ('migrated_from_json', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ at: new Date().toISOString() })],
  );
  console.log('[store] JSON migration done');
}

export async function getSettings() {
  await initStore();
  const { rows } = await query('SELECT * FROM settings WHERE id = 1');
  const row = rows[0] || {};
  const node = await ensureLocalNode();
  const settings = {
    scanRoots: normalizeScanRoots(row.scan_roots, DEFAULT_SETTINGS.scanRoots),
    scanDepth: normalizeScanDepth(row.scan_depth, DEFAULT_SETTINGS.scanDepth),
    theme: THEMES.has(row.theme) ? row.theme : DEFAULT_SETTINGS.theme,
    llm: normalizeLlm(row.llm || {}, {}),
    servers: normalizeServersInSettings(row.servers, DEFAULT_SETTINGS.servers),
    nodeId: node.id,
    nodeName: node.name,
    nodeRole: node.role,
  };
  return settings;
}

export async function saveSettings(next) {
  await initStore();
  const prev = await getSettings();
  const theme =
    next.theme != null && THEMES.has(String(next.theme)) ? String(next.theme) : prev.theme;

  const scanRoots = Object.prototype.hasOwnProperty.call(next, 'scanRoots')
    ? normalizeScanRoots(next.scanRoots, prev.scanRoots)
    : prev.scanRoots;

  const scanDepth = Object.prototype.hasOwnProperty.call(next, 'scanDepth')
    ? normalizeScanDepth(next.scanDepth, prev.scanDepth)
    : prev.scanDepth;

  const servers = Object.prototype.hasOwnProperty.call(next, 'servers')
    ? normalizeServersInSettings(next.servers, prev.servers)
    : prev.servers;

  let llm = prev.llm;
  if (Object.prototype.hasOwnProperty.call(next, 'llm')) {
    llm = normalizeLlm(
      {
        ...(next.llm || {}),
        apiKey:
          next.llm && Object.prototype.hasOwnProperty.call(next.llm, 'apiKey')
            ? next.llm.apiKey === '' || next.llm.apiKey == null
              ? prev.llm.apiKey
              : next.llm.apiKey
            : prev.llm.apiKey,
      },
      prev.llm,
    );
  }

  // Persist llm without env-injected key when env owns the secret
  const llmToStore = {
    ...llm,
    apiKey: process.env.LLM_API_KEY ? '' : llm.apiKey,
  };

  await query(
    `UPDATE settings SET
       theme = $1,
       scan_roots = $2::jsonb,
       scan_depth = $3,
       llm = $4::jsonb,
       servers = $5::jsonb,
       updated_at = NOW()
     WHERE id = 1`,
    [theme, JSON.stringify(scanRoots), scanDepth, JSON.stringify(llmToStore), JSON.stringify(servers)],
  );

  const node = await ensureLocalNode();
  await query(
    `UPDATE nodes SET scan_roots = $2::jsonb, scan_depth = $3, last_seen_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [node.id, JSON.stringify(scanRoots), scanDepth],
  );

  return getSettings();
}

export async function getProjectsMeta() {
  await initStore();
  const { rows } = await query('SELECT id, path, node_id, meta FROM projects');
  const map = {};
  for (const row of rows) {
    map[row.id] = {
      ...(row.meta || {}),
      path: row.path,
      nodeId: row.node_id || null,
    };
  }
  return map;
}

export async function saveProjectsMeta(meta) {
  await initStore();
  const node = await ensureLocalNode();
  for (const [id, value] of Object.entries(meta || {})) {
    if (!value || typeof value !== 'object') continue;
    const abs = String(value.path || pathFromProjectId(id) || '').trim();
    if (!abs) continue;
    const nodeId = value.nodeId || node.id;
    const { path: _p, nodeId: _n, ...rest } = value;
    await query(
      `INSERT INTO projects (id, node_id, path, name, meta, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
         node_id = EXCLUDED.node_id,
         path = EXCLUDED.path,
         name = EXCLUDED.name,
         meta = EXCLUDED.meta,
         updated_at = NOW()`,
      [id, nodeId, abs, path.basename(abs), JSON.stringify({ ...rest, path: abs, nodeId })],
    );
  }
  return meta;
}

export async function upsertProjectRow({ id, nodeId, absPath, name, meta, scanSnapshot }) {
  await initStore();
  await query(
    `INSERT INTO projects (id, node_id, path, name, meta, scan_snapshot, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), COALESCE($6::jsonb, '{}'::jsonb), NOW())
     ON CONFLICT (id) DO UPDATE SET
       node_id = EXCLUDED.node_id,
       path = EXCLUDED.path,
       name = COALESCE(EXCLUDED.name, projects.name),
       meta = CASE WHEN $5::jsonb IS NULL THEN projects.meta ELSE EXCLUDED.meta END,
       scan_snapshot = CASE WHEN $6::jsonb IS NULL THEN projects.scan_snapshot ELSE EXCLUDED.scan_snapshot END,
       updated_at = NOW()`,
    [
      id,
      nodeId || null,
      absPath,
      name || path.basename(absPath),
      meta ? JSON.stringify(meta) : null,
      scanSnapshot ? JSON.stringify(scanSnapshot) : null,
    ],
  );
}

export async function listProjectRows() {
  await initStore();
  const { rows } = await query(
    `SELECT p.*, n.name AS node_name, n.hostname AS node_hostname, n.role AS node_role
     FROM projects p
     LEFT JOIN nodes n ON n.id = p.node_id
     ORDER BY p.name ASC NULLS LAST, p.path ASC`,
  );
  return rows;
}

export function projectIdFromPath(absPath, nodeId = null) {
  const resolved = path.resolve(String(absPath));
  if (nodeId) {
    return Buffer.from(`${nodeId}|${resolved}`).toString('base64url');
  }
  return Buffer.from(resolved).toString('base64url');
}

export function pathFromProjectId(id) {
  const raw = Buffer.from(id, 'base64url').toString('utf8');
  const pipe = raw.indexOf('|');
  if (pipe > 0) return raw.slice(pipe + 1);
  return raw;
}

export function nodeIdFromProjectId(id) {
  const raw = Buffer.from(id, 'base64url').toString('utf8');
  const pipe = raw.indexOf('|');
  if (pipe > 0) return raw.slice(0, pipe);
  return null;
}

export { DEFAULT_LLM, DEFAULT_SETTINGS, THEMES, normalizeScanDepth };
