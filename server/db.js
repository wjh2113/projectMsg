import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');

let pool = null;

export function getDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is required. Copy .env.example to .env and set postgres://user:pass@host:5432/projectmsg',
    );
  }
  return url;
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error', err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT,
  role TEXT NOT NULL DEFAULT 'hub',
  base_url TEXT,
  scan_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
  scan_depth INT NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  theme TEXT NOT NULL DEFAULT 'luxury',
  scan_roots JSONB NOT NULL DEFAULT '[]'::jsonb,
  scan_depth INT NOT NULL DEFAULT 1,
  llm JSONB NOT NULL DEFAULT '{}'::jsonb,
  servers JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  name TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  scan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_node_path_uidx
  ON projects (COALESCE(node_id, ''), path);

CREATE INDEX IF NOT EXISTS projects_node_id_idx ON projects (node_id);

CREATE TABLE IF NOT EXISTS marketplace (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'weekly',
  content TEXT,
  model TEXT,
  project_count INT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports (created_at DESC);
`;

export async function ensureSchema() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await query(SCHEMA_SQL);
  await query(
    `INSERT INTO settings (id, theme, scan_roots, scan_depth, llm, servers)
     VALUES (1, 'luxury', '["D:\\\\VSworkspace"]'::jsonb, 1, '{}'::jsonb, '[]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
