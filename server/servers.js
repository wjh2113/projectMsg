import { randomUUID } from 'node:crypto';
import { getSettings, saveSettings } from './store.js';

const PROVIDERS = [
  { id: 'aliyun', label: '阿里云' },
  { id: 'jdcloud', label: '京东云' },
  { id: 'other', label: '其他 / 自建' },
];

const AUTH_METHODS = ['key', 'agent'];

export function emptyServer() {
  return {
    id: randomUUID(),
    name: '',
    provider: 'aliyun',
    host: '',
    port: 22,
    username: 'root',
    authMethod: 'key',
    privateKeyPath: '',
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeServer(input = {}, prev = null) {
  const provider = PROVIDERS.some((p) => p.id === input.provider)
    ? input.provider
    : prev?.provider || 'other';
  const authMethod = AUTH_METHODS.includes(input.authMethod)
    ? input.authMethod
    : prev?.authMethod || 'key';
  const port = Number(input.port ?? prev?.port ?? 22);
  return {
    id: prev?.id || input.id || randomUUID(),
    name: String(input.name ?? prev?.name ?? '').trim() || String(input.host || prev?.host || '未命名服务器'),
    provider,
    host: String(input.host ?? prev?.host ?? '').trim(),
    port: Number.isFinite(port) && port > 0 ? Math.round(port) : 22,
    username: String(input.username ?? prev?.username ?? 'root').trim() || 'root',
    authMethod,
    privateKeyPath: String(input.privateKeyPath ?? prev?.privateKeyPath ?? '').trim(),
    notes: String(input.notes ?? prev?.notes ?? ''),
    createdAt: prev?.createdAt || input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function publicServer(server) {
  if (!server) return null;
  return {
    ...server,
    privateKeyPath: server.privateKeyPath
      ? `${server.privateKeyPath.slice(0, 4)}…${server.privateKeyPath.slice(-8)}`
      : '',
    privateKeyConfigured: Boolean(server.privateKeyPath),
    // full path only for internal deploy; UI gets masked — keep raw for edit via separate endpoint
  };
}

/** For settings UI edit forms — returns real privateKeyPath (local-only). */
export function serverForEdit(server) {
  if (!server) return null;
  return { ...server };
}

export function normalizeServers(list = []) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => normalizeServer(s)).filter((s) => s.host);
}

export async function listServers() {
  const settings = await getSettings();
  return normalizeServers(settings.servers || []);
}

export async function getServer(serverId) {
  const servers = await listServers();
  return servers.find((s) => s.id === serverId) || null;
}

export async function saveServers(servers) {
  const normalized = normalizeServers(servers);
  await saveSettings({ servers: normalized });
  return listServers();
}

export async function upsertServer(input) {
  const servers = await listServers();
  const idx = input.id ? servers.findIndex((s) => s.id === input.id) : -1;
  const saved =
    idx >= 0 ? normalizeServer(input, servers[idx]) : normalizeServer(input);
  if (!saved.host) {
    const err = new Error('请填写服务器主机地址');
    err.status = 400;
    throw err;
  }
  if (saved.authMethod === 'key' && !saved.privateKeyPath) {
    const err = new Error(
      process.platform === 'win32'
        ? '密钥认证请填写本机私钥路径，例如 C:\\Users\\你\\.ssh\\id_ed25519'
        : '密钥认证请填写本机私钥路径，例如 ~/.ssh/id_ed25519',
    );
    err.status = 400;
    throw err;
  }
  if (idx >= 0) servers[idx] = saved;
  else servers.push(saved);
  await saveServers(servers);
  return saved;
}

export async function removeServer(serverId) {
  const servers = await listServers();
  const next = servers.filter((s) => s.id !== serverId);
  await saveServers(next);
  return next;
}

export { PROVIDERS, AUTH_METHODS };
