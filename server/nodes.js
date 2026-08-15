import os from 'node:os';
import { query } from './db.js';
import { ensureLocalNode, normalizeScanDepth } from './store.js';

export async function listNodes() {
  const { rows } = await query(
    `SELECT id, name, hostname, role, base_url, scan_roots, scan_depth, last_seen_at, meta, created_at, updated_at
     FROM nodes
     ORDER BY role ASC, name ASC`,
  );
  return rows.map(publicNode);
}

export function publicNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    role: row.role,
    baseUrl: row.base_url || '',
    scanRoots: Array.isArray(row.scan_roots) ? row.scan_roots : [],
    scanDepth: normalizeScanDepth(row.scan_depth, 1),
    lastSeenAt: row.last_seen_at || null,
    meta: row.meta || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    online:
      row.last_seen_at &&
      Date.now() - new Date(row.last_seen_at).getTime() < 5 * 60 * 1000,
  };
}

export async function getNode(id) {
  const { rows } = await query('SELECT * FROM nodes WHERE id = $1', [id]);
  return publicNode(rows[0]);
}

export async function upsertNode(input = {}) {
  const local = await ensureLocalNode();
  const id = String(input.id || '').trim() || local.id;
  const name = String(input.name || input.hostname || os.hostname() || id).trim();
  const hostname = String(input.hostname || '').trim() || null;
  const role = String(input.role || 'agent').toLowerCase() === 'hub' ? 'hub' : 'agent';
  const scanRoots = Array.isArray(input.scanRoots)
    ? input.scanRoots.map((r) => String(r).trim()).filter(Boolean)
    : [];
  const scanDepth = normalizeScanDepth(input.scanDepth, 1);
  const baseUrl = String(input.baseUrl || '').trim();
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};

  await query(
    `INSERT INTO nodes (id, name, hostname, role, base_url, scan_roots, scan_depth, last_seen_at, meta, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), $8::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       hostname = COALESCE(EXCLUDED.hostname, nodes.hostname),
       role = EXCLUDED.role,
       base_url = EXCLUDED.base_url,
       scan_roots = EXCLUDED.scan_roots,
       scan_depth = EXCLUDED.scan_depth,
       last_seen_at = NOW(),
       meta = EXCLUDED.meta,
       updated_at = NOW()`,
    [id, name, hostname, role, baseUrl, JSON.stringify(scanRoots), scanDepth, JSON.stringify(meta)],
  );
  return getNode(id);
}

export async function touchNode(id, patch = {}) {
  const scanRoots = Array.isArray(patch.scanRoots)
    ? JSON.stringify(patch.scanRoots.map((r) => String(r).trim()).filter(Boolean))
    : null;
  const scanDepth =
    patch.scanDepth != null ? normalizeScanDepth(patch.scanDepth, 1) : null;
  await query(
    `UPDATE nodes SET
       last_seen_at = NOW(),
       scan_roots = COALESCE($2::jsonb, scan_roots),
       scan_depth = COALESCE($3, scan_depth),
       updated_at = NOW()
     WHERE id = $1`,
    [id, scanRoots, scanDepth],
  );
  return getNode(id);
}

export async function removeNode(id) {
  const local = await ensureLocalNode();
  if (id === local.id) {
    const err = new Error('不能删除本机节点');
    err.status = 400;
    throw err;
  }
  await query('DELETE FROM nodes WHERE id = $1', [id]);
  return listNodes();
}
