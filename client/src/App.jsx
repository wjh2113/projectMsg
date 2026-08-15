import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatTime } from './api.js';
import {
  ALL_STATUSES,
  EMPTY_PLATFORM_FORM,
  FEEDBACK_SOURCES,
  LISTING_STATUS_LABELS,
  PRICING_MODEL_LABELS,
  STATUS_MAP,
  STORE_SYNCABLE,
  THEME_MAP,
  THEMES,
  TRASH_STATUS,
  WORK_STATUSES,
} from './constants.js';

function fmtMoney(n, currency = 'CNY') {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return `${currency} ${Number(n).toLocaleString('zh-CN')}`;
}

function fmtPct(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  return `${n}%`;
}

function ThemeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3a9 9 0 1 0 0 18c.8 0 1.4-.7 1.1-1.4-.3-.6.1-1.3.8-1.3H16a4 4 0 0 0 0-8h-.5c-.7 0-1.1-.7-.8-1.3.3-.7-.3-1.4-1.1-1.4A9 9 0 0 0 12 3Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="7.5" cy="11" r="1.1" fill="currentColor" />
      <circle cx="10" cy="7.5" r="1.1" fill="currentColor" />
      <circle cx="14.2" cy="7.8" r="1.1" fill="currentColor" />
      <circle cx="8.2" cy="14.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

function ThemePicker({ theme, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`theme-picker ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="theme-picker-trigger ghost"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`风格：${THEME_MAP[theme] || theme}`}
        title={`风格：${THEME_MAP[theme] || theme}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ThemeIcon />
      </button>
      {open ? (
        <ul className="theme-picker-menu" role="listbox" aria-label="风格设计">
          {THEMES.map((t) => (
            <li key={t.id} role="option" aria-selected={theme === t.id}>
              <button
                type="button"
                className={theme === t.id ? 'active' : ''}
                onClick={() => {
                  onChange(t.id);
                  setOpen(false);
                }}
              >
                <span className={`theme-swatch theme-swatch-${t.id}`} aria-hidden="true" />
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function applyTheme(theme) {
  const allowed = new Set(['luxury', 'neu', 'minimal', 'classic']);
  const next = allowed.has(theme) ? theme : 'luxury';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('projectmsg-theme', next);
  } catch {
    // ignore
  }
  return next;
}

function SettingsPanel({ settings, onClose, onSaved }) {
  const [rootsText, setRootsText] = useState((settings.scanRoots || []).join('\n'));
  const [scanDepth, setScanDepth] = useState(String(settings.scanDepth || 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    setRootsText((settings.scanRoots || []).join('\n'));
    setScanDepth(String(settings.scanDepth || 1));
  }, [settings.scanRoots, settings.scanDepth]);

  async function save() {
    setSaving(true);
    setError('');
    setSavedMsg('');
    try {
      const scanRoots = rootsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (scanRoots.length === 0) {
        throw new Error('至少保留一个扫描根目录，否则无法发现项目');
      }
      const next = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ scanRoots, scanDepth: Number(scanDepth) || 1 }),
      });
      setRootsText((next.scanRoots || []).join('\n'));
      setScanDepth(String(next.scanDepth || 1));
      setSavedMsg(
        `已保存到 PostgreSQL · ${next.scanRoots?.length || 0} 个根目录 · 深度 ${next.scanDepth}` +
          (next.nodeName ? ` · 节点 ${next.nodeName}` : ''),
      );
      onSaved(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>扫描根目录</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <p className="hint">每行一个本机绝对路径（或 UNC 网络路径）。其他电脑请运行 agent 上报各自路径。</p>
        <p className="hint mono data-path">
          存储：PostgreSQL · 本机节点 {settings.nodeName || settings.nodeId || '—'}
          {settings.listen ? ` · 监听 ${settings.listen.host}:${settings.listen.port}` : ''}
        </p>
        <label>
          扫描深度（1=仅子目录，2+=嵌套 monorepo）
          <input
            type="number"
            min="1"
            max="4"
            value={scanDepth}
            onChange={(e) => setScanDepth(e.target.value)}
          />
        </label>
        <textarea
          className="roots-input"
          rows={10}
          value={rootsText}
          onChange={(e) => setRootsText(e.target.value)}
          placeholder={'D:\\VSworkspace\nD:\\Projects\n\\\\other-pc\\share\\code'}
        />
        {error && <p className="error">{error}</p>}
        {savedMsg && <p className="hint success-hint" style={{ whiteSpace: 'pre-wrap' }}>{savedMsg}</p>}
        <div className="drawer-actions">
          <button type="button" className="primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存根目录'}
          </button>
        </div>
      </aside>
    </div>
  );
}

function LlmPanel({ settings, onClose, onSaved }) {
  const llm = settings.llm || {};
  const [form, setForm] = useState({
    baseUrl: llm.baseUrl || 'https://api.deepseek.com',
    model: llm.model || 'deepseek-v4-flash',
    apiKey: '',
    enabled: Boolean(llm.enabled),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = {
        llm: {
          provider: 'deepseek',
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim() || 'deepseek-v4-flash',
          enabled: form.enabled,
        },
      };
      if (form.apiKey.trim()) {
        body.llm.apiKey = form.apiKey.trim();
      }
      const next = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      onSaved(next);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>大模型配置</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <p className="hint">
          配置 DeepSeek（默认 deepseek-v4-flash）。API Key 持久化保存在本地 settings.json，不会上传到其他服务。
        </p>
        <section className="section">
          <label>
            Base URL
            <input
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <label>
            模型
            <input
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="deepseek-v4-flash"
            />
          </label>
          <label>
            API Key {llm.configured ? `（已配置：${llm.apiKeyMasked}）` : '（未配置）'}
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={llm.configured ? '留空则保留原 Key' : 'sk-...'}
              autoComplete="off"
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            启用 AI 项目解读
          </label>
        </section>
        {error && <p className="error">{error}</p>}
        <div className="drawer-actions">
          <button type="button" className="primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </aside>
    </div>
  );
}

const EMPTY_SERVER_FORM = {
  id: '',
  name: '',
  provider: 'aliyun',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'key',
  privateKeyPath: '',
  notes: '',
};

function ServersPanel({ onClose, onChanged }) {
  const [servers, setServers] = useState([]);
  const [providers, setProviders] = useState([]);
  const [ssh, setSsh] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_SERVER_FORM });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const load = useCallback(async () => {
    const data = await api('/api/servers');
    setServers(data.servers || []);
    setProviders(data.providers || []);
    setSsh(data.ssh || null);
    onChanged?.(data.servers || []);
    return data;
  }, [onChanged]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  function fill(s) {
    setForm({
      id: s.id,
      name: s.name || '',
      provider: s.provider || 'aliyun',
      host: s.host || '',
      port: s.port || 22,
      username: s.username || 'root',
      authMethod: s.authMethod || 'key',
      privateKeyPath: s.privateKeyPath || '',
      notes: s.notes || '',
    });
  }

  function resetForm() {
    setForm({ ...EMPTY_SERVER_FORM });
  }

  async function save() {
    setBusy('save');
    setError('');
    setInfo('');
    try {
      const payload = {
        ...form,
        port: Number(form.port) || 22,
      };
      if (form.id) {
        await api(`/api/servers/${encodeURIComponent(form.id)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/servers', { method: 'POST', body: JSON.stringify(payload) });
      }
      await load();
      resetForm();
      setInfo('服务器已保存');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(id) {
    setBusy(`del-${id}`);
    setError('');
    try {
      await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
      if (form.id === id) resetForm();
      setInfo('已删除服务器');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function test(id) {
    setBusy(`test-${id}`);
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/servers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        body: '{}',
      });
      setInfo(`连接成功：${result.output || 'ok'}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>云服务器（SSH）</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <p className="hint">
          通用 SSH 目标，可用于阿里云 / 京东云 ECS。部署走 GitHub push → 服务器 git pull → pm2/systemd。
          私钥只存在本机 settings.json。
        </p>
        <p className="hint mono">
          OpenSSH：{ssh?.ok ? ssh.version || ssh.bin : '未检测到，请安装 Windows OpenSSH 客户端'}
        </p>
        {error && <p className="error">{error}</p>}
        {info && <p className="hint success-hint">{info}</p>}

        <h3>已保存服务器</h3>
        {servers.length === 0 ? (
          <p className="hint">暂无服务器，请在下方添加</p>
        ) : (
          <ul className="mp-list">
            {servers.map((s) => (
              <li key={s.id} className="mp-item">
                <div className="mp-item-head">
                  <strong>{s.name}</strong>
                  <span className="tag">
                    {providers.find((p) => p.id === s.provider)?.label || s.provider}
                  </span>
                </div>
                <p className="mono">
                  {s.username}@{s.host}:{s.port}
                </p>
                <div className="mp-item-actions">
                  <div className="mp-inline-actions">
                    <button type="button" className="ghost" disabled={Boolean(busy)} onClick={() => fill(s)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => test(s.id)}
                    >
                      {busy === `test-${s.id}` ? '测试中…' : '测试连接'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => remove(s.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3>{form.id ? '编辑服务器' : '添加服务器'}</h3>
        <div className="mp-form">
          <label>
            名称
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="生产-阿里云"
            />
          </label>
          <label>
            云厂商（标签）
            <select
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            >
              {(providers.length
                ? providers
                : [
                    { id: 'aliyun', label: '阿里云' },
                    { id: 'jdcloud', label: '京东云' },
                    { id: 'other', label: '其他' },
                  ]
              ).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            主机
            <input
              value={form.host}
              onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
              placeholder="1.2.3.4 或 ecs.xxx.com"
            />
          </label>
          <label>
            端口
            <input
              type="number"
              value={form.port}
              onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
            />
          </label>
          <label>
            用户名
            <input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </label>
          <label>
            认证
            <select
              value={form.authMethod}
              onChange={(e) => setForm((f) => ({ ...f, authMethod: e.target.value }))}
            >
              <option value="key">私钥文件</option>
              <option value="agent">ssh-agent / 默认密钥</option>
            </select>
          </label>
          <label className="full">
            私钥路径（本机）
            <input
              value={form.privateKeyPath}
              onChange={(e) => setForm((f) => ({ ...f, privateKeyPath: e.target.value }))}
              placeholder="C:\Users\你\.ssh\id_rsa"
              disabled={form.authMethod !== 'key'}
            />
          </label>
          <label className="full">
            备注
            <input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </label>
          <div className="drawer-actions full">
            {form.id ? (
              <button type="button" className="ghost" onClick={resetForm}>
                取消编辑
              </button>
            ) : null}
            <button type="button" className="primary" disabled={busy === 'save'} onClick={save}>
              {busy === 'save' ? '保存中…' : form.id ? '更新服务器' : '添加服务器'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function DeployPanel({ project, onUpdated }) {
  const [servers, setServers] = useState([]);
  const [serverInfo, setServerInfo] = useState(null);
  const [form, setForm] = useState({
    serverId: '',
    remotePath: '',
    branch: 'main',
    pushBeforeDeploy: true,
    installCmd: 'npm ci || npm install',
    buildCmd: '',
    processManager: 'pm2',
    pm2Name: project.name || '',
    pm2StartCmd: 'npm start',
    systemdUnit: '',
    customRestartCmd: '',
    port: '',
    url: '',
  });
  const [publicUrl, setPublicUrl] = useState('');
  const [job, setJob] = useState({ running: false, logs: [] });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const logRef = useRef(null);

  const selectedServer =
    servers.find((s) => s.id === form.serverId) || serverInfo || null;
  const previewUrl =
    (form.url && String(form.url).trim()) ||
    (selectedServer?.host && form.port
      ? `http://${selectedServer.host}:${form.port}`
      : publicUrl || '');

  const load = useCallback(async () => {
    const [srv, dep] = await Promise.all([
      api('/api/servers'),
      api(`/api/projects/${encodeURIComponent(project.id)}/deploy`),
    ]);
    setServers(srv.servers || []);
    setServerInfo(dep.server || null);
    const d = dep.deploy || {};
    setForm({
      serverId: d.serverId || '',
      remotePath: d.remotePath || '',
      branch: d.branch || 'main',
      pushBeforeDeploy: d.pushBeforeDeploy !== false,
      installCmd: d.installCmd ?? 'npm ci || npm install',
      buildCmd: d.buildCmd || '',
      processManager: d.processManager || 'pm2',
      pm2Name: d.pm2Name || project.name || '',
      pm2StartCmd: d.pm2StartCmd || 'npm start',
      systemdUnit: d.systemdUnit || '',
      customRestartCmd: d.customRestartCmd || '',
      port: d.port ?? '',
      url: d.url || '',
      lastDeployAt: d.lastDeployAt,
      lastOk: d.lastOk,
      lastMessage: d.lastMessage,
    });
    setPublicUrl(dep.publicUrl || d.url || '');
    setJob(dep.job || { running: false, logs: [] });
  }, [project.id, project.name]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  useEffect(() => {
    if (!job.running) return undefined;
    const t = setInterval(() => {
      api(`/api/projects/${encodeURIComponent(project.id)}/deploy/logs`)
        .then(setJob)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [job.running, project.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job.logs]);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function payloadFromForm() {
    return {
      ...form,
      port: form.port === '' || form.port == null ? null : Number(form.port),
    };
  }

  async function saveConfig() {
    setBusy('save');
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/deploy`, {
        method: 'PUT',
        body: JSON.stringify(payloadFromForm()),
      });
      setForm((f) => ({
        ...f,
        ...result.deploy,
        port: result.deploy?.port ?? '',
      }));
      setPublicUrl(result.publicUrl || result.deploy?.url || '');
      if (result.projectPatch) onUpdated?.(result.projectPatch);
      else onUpdated?.({ id: project.id, deploy: result.deploy });
      setInfo('部署配置已保存');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runPrecheck() {
    setBusy('precheck');
    setError('');
    setInfo('');
    try {
      const payload = payloadFromForm();
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/deploy/precheck`, {
        method: 'POST',
        body: JSON.stringify({ deploy: payload }),
      });
      const lines = (result.checks || []).map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.id}: ${c.message}`);
      setInfo(`预检${result.ok ? '通过' : '未通过'}\n${lines.join('\n')}`);
      if (!result.ok) setError('预检未通过，请先修复后再部署');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runDeploy() {
    setBusy('deploy');
    setError('');
    setInfo('');
    try {
      const payload = payloadFromForm();
      await api(`/api/projects/${encodeURIComponent(project.id)}/deploy`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setJob({ running: true, logs: [], startedAt: new Date().toISOString() });
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/deploy`, {
        method: 'POST',
        body: JSON.stringify({ deploy: payload, autoCommit: true }),
      });
      setJob(result.job || { running: false, logs: [] });
      setForm((f) => ({
        ...f,
        ...(result.deploy || {}),
        port: result.deploy?.port ?? f.port,
      }));
      setPublicUrl(result.publicUrl || result.deploy?.url || '');
      if (result.projectPatch) onUpdated?.(result.projectPatch);
      setInfo(
        result.publicUrl
          ? `部署完成 · ${result.publicUrl}`
          : result.message || '部署完成',
      );
    } catch (err) {
      setError(err.message);
      try {
        const j = await api(`/api/projects/${encodeURIComponent(project.id)}/deploy/logs`);
        setJob(j);
      } catch {
        // ignore
      }
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="section">
      <p className="hint">
        流程：本机推送 GitHub → SSH 到服务器 git pull → install/build → pm2 或 systemd 重启。
        请先在顶部「云服务器」里添加 SSH 目标；服务器需能访问该 GitHub 仓库。
      </p>
      {error && <p className="error">{error}</p>}
      {info && <p className="hint success-hint">{info}</p>}

      {(previewUrl || form.port) && (
        <div className="deploy-access-card">
          <div className="deploy-access-label">线上访问</div>
          <div className="deploy-access-row">
            <span className="subtle">网址</span>
            {previewUrl ? (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="mono">
                {previewUrl}
              </a>
            ) : (
              <span className="mono">—</span>
            )}
          </div>
          <div className="deploy-access-row">
            <span className="subtle">端口</span>
            <span className="mono">{form.port || '—'}</span>
          </div>
          {selectedServer?.host ? (
            <div className="deploy-access-row">
              <span className="subtle">主机</span>
              <span className="mono">{selectedServer.host}</span>
            </div>
          ) : null}
        </div>
      )}

      <div className="mp-form">
        <label>
          目标服务器
          <select value={form.serverId} onChange={(e) => setField('serverId', e.target.value)}>
            <option value="">请选择…</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host})
              </option>
            ))}
          </select>
        </label>
        <label>
          远端目录
          <input
            value={form.remotePath}
            onChange={(e) => setField('remotePath', e.target.value)}
            placeholder="/var/www/my-app"
          />
        </label>
        <label>
          分支
          <input value={form.branch} onChange={(e) => setField('branch', e.target.value)} />
        </label>
        <label>
          对外端口
          <input
            type="number"
            min="1"
            max="65535"
            value={form.port}
            onChange={(e) => setField('port', e.target.value)}
            placeholder="3000"
          />
        </label>
        <label className="full">
          线上 URL（可空，空则用 http://主机:端口）
          <input
            value={form.url}
            onChange={(e) => setField('url', e.target.value)}
            placeholder={
              selectedServer?.host && form.port
                ? `http://${selectedServer.host}:${form.port}`
                : 'https://example.com'
            }
          />
        </label>
        <label className="full checkbox-row">
          <input
            type="checkbox"
            checked={form.pushBeforeDeploy}
            onChange={(e) => setField('pushBeforeDeploy', e.target.checked)}
          />
          部署前先推送到 GitHub
        </label>
        <label className="full">
          安装命令
          <input
            value={form.installCmd}
            onChange={(e) => setField('installCmd', e.target.value)}
            placeholder="npm ci || npm install"
          />
        </label>
        <label className="full">
          构建命令（可空）
          <input
            value={form.buildCmd}
            onChange={(e) => setField('buildCmd', e.target.value)}
            placeholder="npm run build"
          />
        </label>
        <label>
          进程管理
          <select
            value={form.processManager}
            onChange={(e) => setField('processManager', e.target.value)}
          >
            <option value="pm2">pm2</option>
            <option value="systemd">systemd</option>
            <option value="custom">自定义命令</option>
            <option value="none">仅同步代码</option>
          </select>
        </label>
        {form.processManager === 'pm2' ? (
          <>
            <label>
              pm2 名称
              <input value={form.pm2Name} onChange={(e) => setField('pm2Name', e.target.value)} />
            </label>
            <label>
              pm2 启动命令
              <input
                value={form.pm2StartCmd}
                onChange={(e) => setField('pm2StartCmd', e.target.value)}
                placeholder="npm start"
              />
            </label>
          </>
        ) : null}
        {form.processManager === 'systemd' ? (
          <label>
            systemd unit
            <input
              value={form.systemdUnit}
              onChange={(e) => setField('systemdUnit', e.target.value)}
              placeholder="myapp.service"
            />
          </label>
        ) : null}
        {form.processManager === 'custom' ? (
          <label className="full">
            自定义重启命令
            <input
              value={form.customRestartCmd}
              onChange={(e) => setField('customRestartCmd', e.target.value)}
            />
          </label>
        ) : null}
      </div>

      <div className="drawer-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost" disabled={Boolean(busy)} onClick={saveConfig}>
          {busy === 'save' ? '保存中…' : '保存配置'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={Boolean(busy) || !form.serverId}
          onClick={runPrecheck}
        >
          {busy === 'precheck' ? '预检中…' : '部署预检'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={Boolean(busy) || job.running || !form.serverId || !form.remotePath}
          onClick={runDeploy}
        >
          {busy === 'deploy' || job.running ? '部署中…' : '推送并部署'}
        </button>
      </div>

      {form.lastDeployAt ? (
        <p className="hint">
          上次：{form.lastOk === false ? '失败' : form.lastOk ? '成功' : '—'} ·{' '}
          {formatTime(form.lastDeployAt)}
          {form.lastMessage ? ` · ${form.lastMessage}` : ''}
        </p>
      ) : null}

      <h3>部署日志</h3>
      <pre className="runtime-log" ref={logRef}>
        {(job.logs || []).length === 0
          ? '尚无日志'
          : job.logs.map((l) => `[${l.stream}] ${l.line}`).join('\n')}
      </pre>
    </section>
  );
}

function MarketplacePanel({ project, llmReady, onChanged }) {
  const [meta, setMeta] = useState({ stores: [], listingStatuses: [] });
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [listingForm, setListingForm] = useState({
    store: 'app_store',
    storeName: '',
    url: '',
    status: 'listed',
    version: '',
    listedAt: '',
    notes: '',
  });
  const [feedbackForm, setFeedbackForm] = useState({
    source: 'manual',
    author: '',
    rating: '',
    content: '',
    url: '',
  });
  const [devNotes, setDevNotes] = useState('');
  const [platformForm, setPlatformForm] = useState({ ...EMPTY_PLATFORM_FORM });
  const [editingPlatformId, setEditingPlatformId] = useState(null);
  const [makemoney, setMakemoney] = useState(null);
  const [showMakemoney, setShowMakemoney] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [m, r, mm] = await Promise.all([
        api('/api/marketplace/meta'),
        api(`/api/projects/${encodeURIComponent(project.id)}/marketplace`),
        api(`/api/projects/${encodeURIComponent(project.id)}/makemoney`).catch(() => null),
      ]);
      setMeta(m);
      setRecord(r);
      setDevNotes(r.devProgressNotes || '');
      setMakemoney(mm);
      return r;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    load().then((r) => {
      if (!cancelled && r) onChanged?.(r);
    });
    return () => {
      cancelled = true;
    };
    // only reload when project changes; avoid onChanged identity loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function addListing() {
    setBusy('listing');
    setError('');
    setInfo('');
    try {
      const preset = (meta.stores || []).find((s) => s.id === listingForm.store);
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/marketplace/listings`, {
        method: 'POST',
        body: JSON.stringify({
          ...listingForm,
          storeName: listingForm.storeName || preset?.label || listingForm.store,
          listedAt: listingForm.listedAt || null,
        }),
      });
      setRecord(result.record);
      onChanged?.(result.record);
      setListingForm({
        store: 'app_store',
        storeName: '',
        url: '',
        status: 'listed',
        version: '',
        listedAt: '',
        notes: '',
      });
      setInfo('已添加上架记录');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removeListing(listingId) {
    setBusy(`del-l-${listingId}`);
    setError('');
    try {
      const saved = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/listings/${encodeURIComponent(listingId)}`,
        { method: 'DELETE' },
      );
      setRecord(saved);
      onChanged?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function addFeedback() {
    if (!feedbackForm.content.trim()) {
      setError('请填写反馈内容');
      return;
    }
    setBusy('feedback');
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/marketplace/feedback`, {
        method: 'POST',
        body: JSON.stringify({
          ...feedbackForm,
          rating: feedbackForm.rating === '' ? null : Number(feedbackForm.rating),
        }),
      });
      setRecord(result.record);
      onChanged?.(result.record);
      setFeedbackForm({ source: 'manual', author: '', rating: '', content: '', url: '' });
      setInfo('已添加反馈');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removeFeedback(feedbackId) {
    setBusy(`del-f-${feedbackId}`);
    setError('');
    try {
      const saved = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/feedback/${encodeURIComponent(feedbackId)}`,
        { method: 'DELETE' },
      );
      setRecord(saved);
      onChanged?.(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function importGithub() {
    setBusy('github');
    setError('');
    setInfo('');
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/import-github`,
        { method: 'POST', body: '{}' },
      );
      setRecord(result.record);
      onChanged?.(result.record);
      setInfo(`已同步 GitHub Issues：新增 ${result.added}，更新 ${result.updated}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function syncStore({ listingId, platformId, url } = {}) {
    const key = listingId
      ? `sync-l-${listingId}`
      : platformId
        ? `sync-p-${platformId}`
        : 'sync-store';
    setBusy(key);
    setError('');
    setInfo('');
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/sync-store`,
        {
          method: 'POST',
          body: JSON.stringify({ listingId, platformId, url }),
        },
      );
      setRecord(result.record);
      onChanged?.(result.record);
      const m = result.metrics || {};
      const parts = [
        m.name || m.appId || '商店数据',
        m.rating != null ? `评分 ${m.rating}` : null,
        m.ratingCount != null ? `${m.ratingCount} 评` : null,
        m.downloadsText || (m.downloads != null ? `下载≈${m.downloads}` : null),
        `评论 +${result.addedFeedback || 0}/更${result.updatedFeedback || 0}`,
      ].filter(Boolean);
      setInfo(`已从商店同步：${parts.join(' · ')}${m.downloadsNote ? `（${m.downloadsNote}）` : ''}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function listingSyncUrl(listing) {
    return listing?.url || '';
  }

  function platformSyncUrl(platform) {
    if (platform?.storeMetrics?.url) return platform.storeMetrics.url;
    const match = (record?.listings || []).find(
      (l) => l.store === platform?.store && l.url,
    );
    return match?.url || '';
  }

  async function saveDevNotes() {
    setBusy('notes');
    setError('');
    setInfo('');
    try {
      const saved = await api(`/api/projects/${encodeURIComponent(project.id)}/marketplace`, {
        method: 'PUT',
        body: JSON.stringify({
          listings: record?.listings,
          feedback: record?.feedback,
          platforms: record?.platforms,
          iterationPlan: record?.iterationPlan,
          commercialPlan: record?.commercialPlan,
          devProgressNotes: devNotes,
        }),
      });
      setRecord(saved);
      onChanged?.(saved);
      setInfo('开发进展已保存');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function setPf(key, value) {
    setPlatformForm((f) => ({ ...f, [key]: value }));
  }

  function fillPlatformForm(p) {
    setEditingPlatformId(p.id);
    setPlatformForm({
      store: p.store || 'other',
      storeName: p.storeName || '',
      pricingModel: p.pricing?.model || 'free',
      price: p.pricing?.price ?? '',
      currency: p.pricing?.currency || 'CNY',
      billingPeriod: p.pricing?.billingPeriod || 'none',
      tiersNote: p.pricing?.tiersNote || '',
      downloads: p.usage?.downloads ?? '',
      activeUsers: p.usage?.activeUsers ?? '',
      dau: p.usage?.dau ?? '',
      mau: p.usage?.mau ?? '',
      usagePeriod: p.usage?.period || '',
      usageNotes: p.usage?.notes || '',
      conversionRate: p.winRate?.conversionRate ?? '',
      trialToPaid: p.winRate?.trialToPaid ?? '',
      dealWinRate: p.winRate?.dealWinRate ?? '',
      leads: p.winRate?.leads ?? '',
      wins: p.winRate?.wins ?? '',
      winNotes: p.winRate?.notes || '',
      promoStrategy: p.promotion?.strategy || '',
      promoChannels: p.promotion?.channels || '',
      promoBudget: p.promotion?.budget ?? '',
      listingFee: p.cost?.listingFee ?? '',
      adsSpend: p.cost?.adsSpend ?? '',
      opsSpend: p.cost?.opsSpend ?? '',
      otherSpend: p.cost?.otherSpend ?? '',
      costNotes: p.cost?.notes || '',
    });
  }

  function resetPlatformForm() {
    setEditingPlatformId(null);
    setPlatformForm({ ...EMPTY_PLATFORM_FORM });
  }

  function buildPlatformPayload() {
    const preset = (meta.stores || []).find((s) => s.id === platformForm.store);
    return {
      store: platformForm.store,
      storeName: platformForm.storeName || preset?.label || platformForm.store,
      pricing: {
        model: platformForm.pricingModel,
        price: platformForm.price === '' ? null : Number(platformForm.price),
        currency: platformForm.currency,
        billingPeriod: platformForm.billingPeriod,
        tiersNote: platformForm.tiersNote,
      },
      usage: {
        downloads: platformForm.downloads === '' ? null : Number(platformForm.downloads),
        activeUsers: platformForm.activeUsers === '' ? null : Number(platformForm.activeUsers),
        dau: platformForm.dau === '' ? null : Number(platformForm.dau),
        mau: platformForm.mau === '' ? null : Number(platformForm.mau),
        period: platformForm.usagePeriod,
        notes: platformForm.usageNotes,
      },
      winRate: {
        conversionRate:
          platformForm.conversionRate === '' ? null : Number(platformForm.conversionRate),
        trialToPaid: platformForm.trialToPaid === '' ? null : Number(platformForm.trialToPaid),
        dealWinRate: platformForm.dealWinRate === '' ? null : Number(platformForm.dealWinRate),
        leads: platformForm.leads === '' ? null : Number(platformForm.leads),
        wins: platformForm.wins === '' ? null : Number(platformForm.wins),
        notes: platformForm.winNotes,
      },
      promotion: {
        strategy: platformForm.promoStrategy,
        channels: platformForm.promoChannels,
        budget: platformForm.promoBudget === '' ? null : Number(platformForm.promoBudget),
        currency: platformForm.currency,
      },
      cost: {
        listingFee: platformForm.listingFee === '' ? null : Number(platformForm.listingFee),
        adsSpend: platformForm.adsSpend === '' ? null : Number(platformForm.adsSpend),
        opsSpend: platformForm.opsSpend === '' ? null : Number(platformForm.opsSpend),
        otherSpend: platformForm.otherSpend === '' ? null : Number(platformForm.otherSpend),
        currency: platformForm.currency,
        notes: platformForm.costNotes,
      },
    };
  }

  async function savePlatform() {
    setBusy('platform');
    setError('');
    setInfo('');
    try {
      const payload = buildPlatformPayload();
      let result;
      if (editingPlatformId) {
        result = await api(
          `/api/projects/${encodeURIComponent(project.id)}/marketplace/platforms/${encodeURIComponent(editingPlatformId)}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
      } else {
        result = await api(`/api/projects/${encodeURIComponent(project.id)}/marketplace/platforms`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setRecord(result.record);
      onChanged?.(result.record);
      const wasEditing = Boolean(editingPlatformId);
      resetPlatformForm();
      setInfo(wasEditing ? '平台运营已更新' : '已添加平台运营记录');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removePlatform(platformId) {
    setBusy(`del-p-${platformId}`);
    setError('');
    try {
      const saved = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/platforms/${encodeURIComponent(platformId)}`,
        { method: 'DELETE' },
      );
      setRecord(saved);
      onChanged?.(saved);
      if (editingPlatformId === platformId) resetPlatformForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runIterationPlan() {
    setBusy('plan');
    setError('');
    setInfo('');
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/iteration-plan`,
        { method: 'POST', body: '{}' },
      );
      setRecord(result.record);
      onChanged?.(result.record);
      setInfo('迭代计划已生成并保存');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function runCommercialPlan() {
    setBusy('commercial');
    setError('');
    setInfo('');
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(project.id)}/marketplace/commercial-plan`,
        { method: 'POST', body: '{}' },
      );
      setRecord(result.record);
      onChanged?.(result.record);
      if (result.makemoney) setMakemoney((prev) => prev || { ...result.makemoney });
      setInfo(
        result.plan?.basedOnMakemoney
          ? `商业化分析已生成（基于 ${result.plan.sourceFile || 'makemoney.md'}）`
          : '未找到 makemoney.md，已生成草案级商业化建议',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (loading) return <p className="hint">加载上架与反馈数据…</p>;

  const listings = record?.listings || [];
  const feedback = record?.feedback || [];
  const plan = record?.iterationPlan || {};
  const commercial = record?.commercialPlan || {};

  return (
    <section className="section marketplace-panel">
      <p className="hint">
        登记应用商店上架、各平台定价/用量/赢率/推广与成本、用户反馈（含 GitHub）。商业化分析优先读取项目内{' '}
        <span className="mono">makemoney.md</span>，再调用 AI。MVP 写入{' '}
        <span className="mono">data/marketplace.json</span>。
      </p>
      {error && <p className="error">{error}</p>}
      {info && <p className="hint success-hint">{info}</p>}

      <h3>商业化方案（makemoney.md）</h3>
      {makemoney ? (
        <>
          <p className="hint mono">
            {makemoney.path || makemoney.name}
            {makemoney.size != null ? ` · ${Math.round((makemoney.size || 0) / 1024)} KB` : ''}
            {makemoney.truncated ? ' · 已截断' : ''}
          </p>
          <button type="button" className="ghost" onClick={() => setShowMakemoney((v) => !v)}>
            {showMakemoney ? '收起原文' : '查看 makemoney.md 原文'}
          </button>
          {showMakemoney && makemoney.content ? (
            <pre className="readme-view">{makemoney.content}</pre>
          ) : null}
        </>
      ) : (
        <p className="hint">
          未找到 <span className="mono">makemoney.md</span>
          （根目录或 docs/）。可先补文档再分析；无文档时 AI 仅生成草案。
        </p>
      )}
      <div className="drawer-actions" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={busy === 'commercial' || !llmReady}
          onClick={runCommercialPlan}
        >
          {busy === 'commercial'
            ? '分析中…'
            : llmReady
              ? makemoney
                ? '基于 makemoney.md 生成商业化分析'
                : 'AI 生成商业化草案'
              : '请先配置 DeepSeek'}
        </button>
      </div>
      {commercial.content ? (
        <>
          <pre className="ai-summary">{commercial.content}</pre>
          <p className="hint">
            {commercial.model || ''} · {formatTime(commercial.generatedAt)}
            {commercial.basedOnMakemoney
              ? ` · 来源 ${commercial.sourceFile || 'makemoney.md'}`
              : ' · 无 makemoney.md（草案）'}
          </p>
        </>
      ) : (
        <p className="hint">尚未生成商业化分析</p>
      )}

      <h3>应用商店上架</h3>
      <p className="hint">
        填写 App Store / Google Play / Chrome Web Store 链接后，可一键同步公开评分、评论与下载区间（App Store
        不提供下载量）。
      </p>
      {listings.length === 0 ? (
        <p className="hint">暂无上架记录</p>
      ) : (
        <ul className="mp-list">
          {listings.map((l) => (
            <li key={l.id} className="mp-item">
              <div className="mp-item-head">
                <strong>{l.storeName || l.store}</strong>
                <span className="tag">{LISTING_STATUS_LABELS[l.status] || l.status}</span>
                {l.version ? <span className="subtle">v{l.version}</span> : null}
              </div>
              {l.url ? (
                <a href={l.url} target="_blank" rel="noreferrer" className="mono">
                  {l.url}
                </a>
              ) : null}
              {l.storeMetrics ? (
                <p className="hint">
                  商店：
                  {l.storeMetrics.rating != null ? `★ ${l.storeMetrics.rating}` : '无评分'}
                  {l.storeMetrics.ratingCount != null ? `（${l.storeMetrics.ratingCount}）` : ''}
                  {l.storeMetrics.downloadsText
                    ? ` · 下载 ${l.storeMetrics.downloadsText}`
                    : l.storeMetrics.downloads != null
                      ? ` · 下载≈${l.storeMetrics.downloads}`
                      : ''}
                  {l.lastStoreSyncAt ? ` · 同步于 ${formatTime(l.lastStoreSyncAt)}` : ''}
                </p>
              ) : null}
              {l.notes ? <p className="mp-notes">{l.notes}</p> : null}
              <div className="mp-item-actions">
                <span className="subtle">{l.listedAt ? `上架 ${l.listedAt}` : ''}</span>
                <div className="mp-inline-actions">
                  {STORE_SYNCABLE.has(l.store) && listingSyncUrl(l) ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => syncStore({ listingId: l.id, url: listingSyncUrl(l) })}
                    >
                      {busy === `sync-l-${l.id}` ? '同步中…' : '从商店同步'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === `del-l-${l.id}`}
                    onClick={() => removeListing(l.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mp-form">
        <label>
          商店
          <select
            value={listingForm.store}
            onChange={(e) => setListingForm((f) => ({ ...f, store: e.target.value }))}
          >
            {(meta.stores || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          自定义名称（可选）
          <input
            value={listingForm.storeName}
            onChange={(e) => setListingForm((f) => ({ ...f, storeName: e.target.value }))}
            placeholder="留空用预设名"
          />
        </label>
        <label>
          状态
          <select
            value={listingForm.status}
            onChange={(e) => setListingForm((f) => ({ ...f, status: e.target.value }))}
          >
            {(meta.listingStatuses || Object.keys(LISTING_STATUS_LABELS)).map((s) => (
              <option key={s} value={s}>
                {LISTING_STATUS_LABELS[s] || s}
              </option>
            ))}
          </select>
        </label>
        <label>
          商店链接
          <input
            type="url"
            value={listingForm.url}
            onChange={(e) => setListingForm((f) => ({ ...f, url: e.target.value }))}
            placeholder="https://..."
          />
        </label>
        <label>
          版本
          <input
            value={listingForm.version}
            onChange={(e) => setListingForm((f) => ({ ...f, version: e.target.value }))}
            placeholder="1.0.0"
          />
        </label>
        <label>
          上架日期
          <input
            type="date"
            value={listingForm.listedAt || ''}
            onChange={(e) => setListingForm((f) => ({ ...f, listedAt: e.target.value }))}
          />
        </label>
        <label className="full">
          备注
          <input
            value={listingForm.notes}
            onChange={(e) => setListingForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>
        <button type="button" className="primary" disabled={busy === 'listing'} onClick={addListing}>
          {busy === 'listing' ? '添加中…' : '添加上架'}
        </button>
      </div>

      <h3>平台运营（定价 / 用量 / 赢率 / 推广 / 成本）</h3>
      {(record?.platforms || []).length === 0 ? (
        <p className="hint">暂无平台运营数据。可按商店分别登记定价模式与经营指标。</p>
      ) : (
        <ul className="mp-list">
          {(record.platforms || []).map((p) => (
            <li key={p.id} className="mp-item">
              <div className="mp-item-head">
                <strong>{p.storeName || p.store}</strong>
                <span className="tag">
                  {PRICING_MODEL_LABELS[p.pricing?.model] || p.pricing?.model || '—'}
                </span>
                {p.pricing?.price != null ? (
                  <span className="subtle">
                    {fmtMoney(p.pricing.price, p.pricing.currency)}
                    {p.pricing.billingPeriod && p.pricing.billingPeriod !== 'none'
                      ? ` / ${p.pricing.billingPeriod}`
                      : ''}
                  </span>
                ) : null}
              </div>
              <dl className="meta-grid mp-ops-grid">
                <div>
                  <dt>用量</dt>
                  <dd>
                    下载 {p.usage?.downloads ?? '—'} · 活跃 {p.usage?.activeUsers ?? '—'}
                    <br />
                    DAU {p.usage?.dau ?? '—'} · MAU {p.usage?.mau ?? '—'}
                    {p.usage?.period ? ` · ${p.usage.period}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>赢率</dt>
                  <dd>
                    转化 {fmtPct(p.winRate?.conversionRate)} · 试用转付费{' '}
                    {fmtPct(p.winRate?.trialToPaid)}
                    <br />
                    成交赢率 {fmtPct(p.winRate?.dealWinRate)}
                    {p.winRate?.leads != null
                      ? ` · ${p.winRate.wins ?? 0}/${p.winRate.leads} 单`
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>推广</dt>
                  <dd className="wrap">
                    {p.promotion?.strategy || '—'}
                    {p.promotion?.channels ? (
                      <>
                        <br />
                        <span className="subtle">渠道：{p.promotion.channels}</span>
                      </>
                    ) : null}
                    {p.promotion?.budget != null ? (
                      <>
                        <br />
                        <span className="subtle">
                          预算 {fmtMoney(p.promotion.budget, p.promotion.currency)}
                        </span>
                      </>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>成本投入</dt>
                  <dd>
                    合计 {fmtMoney(p.cost?.total, p.cost?.currency)}
                    <br />
                    <span className="subtle">
                      上架 {fmtMoney(p.cost?.listingFee, p.cost?.currency)} · 广告{' '}
                      {fmtMoney(p.cost?.adsSpend, p.cost?.currency)} · 运营{' '}
                      {fmtMoney(p.cost?.opsSpend, p.cost?.currency)} · 其他{' '}
                      {fmtMoney(p.cost?.otherSpend, p.cost?.currency)}
                    </span>
                  </dd>
                </div>
              </dl>
              {p.pricing?.tiersNote ? <p className="mp-notes">档位：{p.pricing.tiersNote}</p> : null}
              {p.storeMetrics ? (
                <p className="hint">
                  商店同步：
                  {p.storeMetrics.name ? `${p.storeMetrics.name} · ` : ''}
                  {p.storeMetrics.rating != null ? `★ ${p.storeMetrics.rating}` : '无评分'}
                  {p.storeMetrics.ratingCount != null ? `（${p.storeMetrics.ratingCount}）` : ''}
                  {p.storeMetrics.downloadsText
                    ? ` · ${p.storeMetrics.downloadsText}`
                    : ''}
                  {p.storeMetrics.syncedAt ? ` · ${formatTime(p.storeMetrics.syncedAt)}` : ''}
                </p>
              ) : null}
              <div className="mp-item-actions">
                <span className="subtle">{formatTime(p.updatedAt)}</span>
                <div className="mp-inline-actions">
                  {STORE_SYNCABLE.has(p.store) && platformSyncUrl(p) ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        syncStore({ platformId: p.id, url: platformSyncUrl(p) })
                      }
                    >
                      {busy === `sync-p-${p.id}` ? '同步中…' : '从商店同步'}
                    </button>
                  ) : null}
                  <button type="button" className="ghost" onClick={() => fillPlatformForm(p)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === `del-p-${p.id}`}
                    onClick={() => removePlatform(p.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mp-form mp-platform-form">
        <p className="hint full">
          {editingPlatformId ? '正在编辑平台运营记录' : '新增平台运营记录'}
          {editingPlatformId ? (
            <>
              {' · '}
              <button type="button" className="linkish" onClick={resetPlatformForm}>
                取消编辑
              </button>
            </>
          ) : null}
        </p>
        <label>
          平台
          <select value={platformForm.store} onChange={(e) => setPf('store', e.target.value)}>
            {(meta.stores || []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          自定义名称
          <input
            value={platformForm.storeName}
            onChange={(e) => setPf('storeName', e.target.value)}
            placeholder="可选"
          />
        </label>
        <label>
          定价模式
          <select
            value={platformForm.pricingModel}
            onChange={(e) => setPf('pricingModel', e.target.value)}
          >
            {(meta.pricingModels || Object.entries(PRICING_MODEL_LABELS).map(([id, label]) => ({ id, label }))).map(
              (m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          价格
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.price}
            onChange={(e) => setPf('price', e.target.value)}
          />
        </label>
        <label>
          币种
          <select value={platformForm.currency} onChange={(e) => setPf('currency', e.target.value)}>
            {(meta.currencies || ['CNY', 'USD']).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          计费周期
          <select
            value={platformForm.billingPeriod}
            onChange={(e) => setPf('billingPeriod', e.target.value)}
          >
            {(meta.billingPeriods || [
              { id: 'none', label: '无' },
              { id: 'monthly', label: '月付' },
              { id: 'yearly', label: '年付' },
              { id: 'one_time', label: '一次性' },
            ]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="full">
          档位说明
          <input
            value={platformForm.tiersNote}
            onChange={(e) => setPf('tiersNote', e.target.value)}
            placeholder="如：免费版 + Pro ¥28/月 + Team ¥98/月"
          />
        </label>

        <label>
          下载量
          <input
            type="number"
            min="0"
            value={platformForm.downloads}
            onChange={(e) => setPf('downloads', e.target.value)}
          />
        </label>
        <label>
          活跃用户
          <input
            type="number"
            min="0"
            value={platformForm.activeUsers}
            onChange={(e) => setPf('activeUsers', e.target.value)}
          />
        </label>
        <label>
          DAU
          <input
            type="number"
            min="0"
            value={platformForm.dau}
            onChange={(e) => setPf('dau', e.target.value)}
          />
        </label>
        <label>
          MAU
          <input
            type="number"
            min="0"
            value={platformForm.mau}
            onChange={(e) => setPf('mau', e.target.value)}
          />
        </label>
        <label>
          统计周期
          <input
            value={platformForm.usagePeriod}
            onChange={(e) => setPf('usagePeriod', e.target.value)}
            placeholder="2026-07"
          />
        </label>
        <label>
          用量备注
          <input
            value={platformForm.usageNotes}
            onChange={(e) => setPf('usageNotes', e.target.value)}
          />
        </label>

        <label>
          转化率 %
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={platformForm.conversionRate}
            onChange={(e) => setPf('conversionRate', e.target.value)}
          />
        </label>
        <label>
          试用→付费 %
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={platformForm.trialToPaid}
            onChange={(e) => setPf('trialToPaid', e.target.value)}
          />
        </label>
        <label>
          成交赢率 %
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={platformForm.dealWinRate}
            onChange={(e) => setPf('dealWinRate', e.target.value)}
            placeholder="可留空，由赢单/线索推算"
          />
        </label>
        <label>
          线索数
          <input
            type="number"
            min="0"
            value={platformForm.leads}
            onChange={(e) => setPf('leads', e.target.value)}
          />
        </label>
        <label>
          赢单数
          <input
            type="number"
            min="0"
            value={platformForm.wins}
            onChange={(e) => setPf('wins', e.target.value)}
          />
        </label>
        <label>
          赢率备注
          <input value={platformForm.winNotes} onChange={(e) => setPf('winNotes', e.target.value)} />
        </label>

        <label className="full">
          推广策略
          <textarea
            rows={2}
            value={platformForm.promoStrategy}
            onChange={(e) => setPf('promoStrategy', e.target.value)}
            placeholder="如：ASO 关键词 + 社群裂变 + KOL 评测"
          />
        </label>
        <label>
          推广渠道
          <input
            value={platformForm.promoChannels}
            onChange={(e) => setPf('promoChannels', e.target.value)}
            placeholder="小红书, Twitter, 邮件…"
          />
        </label>
        <label>
          推广预算
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.promoBudget}
            onChange={(e) => setPf('promoBudget', e.target.value)}
          />
        </label>

        <label>
          上架费用
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.listingFee}
            onChange={(e) => setPf('listingFee', e.target.value)}
          />
        </label>
        <label>
          广告投入
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.adsSpend}
            onChange={(e) => setPf('adsSpend', e.target.value)}
          />
        </label>
        <label>
          运营投入
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.opsSpend}
            onChange={(e) => setPf('opsSpend', e.target.value)}
          />
        </label>
        <label>
          其他成本
          <input
            type="number"
            min="0"
            step="0.01"
            value={platformForm.otherSpend}
            onChange={(e) => setPf('otherSpend', e.target.value)}
          />
        </label>
        <label className="full">
          成本备注
          <input
            value={platformForm.costNotes}
            onChange={(e) => setPf('costNotes', e.target.value)}
          />
        </label>

        <button type="button" className="primary" disabled={busy === 'platform'} onClick={savePlatform}>
          {busy === 'platform' ? '保存中…' : editingPlatformId ? '更新平台运营' : '添加平台运营'}
        </button>
      </div>

      <h3>用户反馈</h3>
      <div className="drawer-actions" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="primary"
          disabled={busy === 'github' || !project.remoteUrl}
          onClick={importGithub}
          title={!project.remoteUrl ? '无 GitHub remote' : ''}
        >
          {busy === 'github' ? '拉取中…' : '从 GitHub 拉取 Issues'}
        </button>
      </div>
      {feedback.length === 0 ? (
        <p className="hint">暂无反馈</p>
      ) : (
        <ul className="mp-list">
          {feedback.map((f) => (
            <li key={f.id} className="mp-item">
              <div className="mp-item-head">
                <span className="tag">{FEEDBACK_SOURCES.find((s) => s.id === f.source)?.label || f.source}</span>
                {f.author ? <strong>{f.author}</strong> : null}
                {f.rating != null && !Number.isNaN(f.rating) ? (
                  <span className="subtle">{f.rating}★</span>
                ) : null}
                <span className="subtle">{formatTime(f.createdAt)}</span>
              </div>
              <pre className="mp-feedback">{f.content}</pre>
              {f.url ? (
                <a href={f.url} target="_blank" rel="noreferrer">
                  原文
                </a>
              ) : null}
              <div className="mp-item-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy === `del-f-${f.id}`}
                  onClick={() => removeFeedback(f.id)}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mp-form">
        <label>
          来源
          <select
            value={feedbackForm.source}
            onChange={(e) => setFeedbackForm((f) => ({ ...f, source: e.target.value }))}
          >
            {FEEDBACK_SOURCES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          作者
          <input
            value={feedbackForm.author}
            onChange={(e) => setFeedbackForm((f) => ({ ...f, author: e.target.value }))}
          />
        </label>
        <label>
          评分（可选）
          <input
            type="number"
            min="1"
            max="5"
            value={feedbackForm.rating}
            onChange={(e) => setFeedbackForm((f) => ({ ...f, rating: e.target.value }))}
          />
        </label>
        <label>
          链接
          <input
            type="url"
            value={feedbackForm.url}
            onChange={(e) => setFeedbackForm((f) => ({ ...f, url: e.target.value }))}
          />
        </label>
        <label className="full">
          内容
          <textarea
            rows={3}
            value={feedbackForm.content}
            onChange={(e) => setFeedbackForm((f) => ({ ...f, content: e.target.value }))}
            placeholder="用户意见 / 差评要点 / 功能请求…"
          />
        </label>
        <button type="button" className="primary" disabled={busy === 'feedback'} onClick={addFeedback}>
          {busy === 'feedback' ? '添加中…' : '添加反馈'}
        </button>
      </div>

      <h3>开发进展</h3>
      <label>
        进展备注（功能完成度、阻塞项、下周计划等）
        <textarea rows={4} value={devNotes} onChange={(e) => setDevNotes(e.target.value)} />
      </label>
      <button type="button" className="primary" disabled={busy === 'notes'} onClick={saveDevNotes}>
        {busy === 'notes' ? '保存中…' : '保存进展'}
      </button>
      <p className="hint">
        项目整体进度条仍在「编辑」页；此处记录上架/反馈语境下的开发进展说明。
      </p>

      <h3>后续迭代计划（AI）</h3>
      <p className="hint">根据上架情况 + 反馈 + 进展备注生成优先级建议。</p>
      <button
        type="button"
        className="primary"
        disabled={busy === 'plan' || !llmReady}
        onClick={runIterationPlan}
      >
        {busy === 'plan' ? '分析中…' : llmReady ? 'AI 生成迭代计划' : '请先配置 DeepSeek'}
      </button>
      {plan.content ? (
        <>
          <pre className="ai-summary">{plan.content}</pre>
          <p className="hint">
            {plan.model || ''} · {formatTime(plan.generatedAt)} · 基于 {plan.basedOnFeedbackCount ?? 0}{' '}
            条反馈
          </p>
        </>
      ) : (
        <p className="hint">尚未生成迭代计划</p>
      )}
    </section>
  );
}

function SyncFailBanner({ failures, onOpen, onDismiss }) {
  if (!failures?.length) return null;
  return (
    <div className="alert-banner sync-fail">
      <div>
        <strong>定时 GitHub 同步失败 {failures.length} 项</strong>
        <ul>
          {failures.slice(0, 5).map((f) => (
            <li key={f.id}>
              <button type="button" className="linkish" onClick={() => onOpen?.(f.id)}>
                {f.name}
              </button>
              <span className="subtle">
                {' '}
                · {formatTime(f.lastRunAt)} · {f.lastMessage}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="ghost" onClick={onDismiss}>
        知道了
      </button>
    </div>
  );
}

function RuntimePanel({ project, onUpdated }) {
  const [runtime, setRuntime] = useState(project.runtime || null);
  const [script, setScript] = useState('');
  const [logs, setLogs] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const nextRef = useRef(0);

  const refresh = useCallback(async () => {
    const r = await api(`/api/projects/${encodeURIComponent(project.id)}/runtime`);
    setRuntime(r);
    if (!script && r.availableScript) setScript(r.availableScript);
    return r;
  }, [project.id, script]);

  useEffect(() => {
    let cancelled = false;
    nextRef.current = 0;
    setLogs([]);
    refresh().catch((err) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await api(
          `/api/projects/${encodeURIComponent(project.id)}/runtime/logs?since=${nextRef.current}`,
        );
        if (cancelled) return;
        if (data.logs?.length) {
          setLogs((prev) => [...prev, ...data.logs].slice(-800));
        }
        nextRef.current = data.next || nextRef.current;
        setRuntime((r) => ({
          ...(r || {}),
          running: data.running,
          pid: data.pid,
          script: data.script,
          startedAt: data.startedAt,
          exitCode: data.exitCode,
        }));
      } catch {
        // ignore poll errors
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [project.id]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function start() {
    setBusy('start');
    setError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/runtime/start`, {
        method: 'POST',
        body: JSON.stringify({ script: script || undefined }),
      });
      setRuntime(result.status);
      onUpdated?.({ id: project.id, runtime: result.status });
      nextRef.current = 0;
      setLogs([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function stop() {
    setBusy('stop');
    setError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/runtime/stop`, {
        method: 'POST',
        body: '{}',
      });
      setRuntime(result.status);
      onUpdated?.({ id: project.id, runtime: result.status });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const running = Boolean(runtime?.running);

  return (
    <section className="section">
      <h3>本地 Dev 服务</h3>
      <p className="hint">可选任意 package.json 脚本；默认优先 `dev` → `start` → `serve` → `preview`。</p>
      {error && <p className="error">{error}</p>}
      <label>
        启动脚本
        <select value={script} onChange={(e) => setScript(e.target.value)} disabled={running}>
          {(runtime?.scripts || []).length === 0 ? (
            <option value="">—</option>
          ) : (
            (runtime.scripts || []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))
          )}
        </select>
      </label>
      <dl className="meta-grid">
        <div>
          <dt>状态</dt>
          <dd>{running ? '运行中' : '未运行'}</dd>
        </div>
        <div>
          <dt>脚本</dt>
          <dd className="mono">{runtime?.script || script || runtime?.availableScript || '—'}</dd>
        </div>
        <div>
          <dt>PID</dt>
          <dd className="mono">{runtime?.pid ?? '—'}</dd>
        </div>
        <div>
          <dt>启动时间</dt>
          <dd>{formatTime(runtime?.startedAt)}</dd>
        </div>
      </dl>
      <div className="drawer-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="primary" disabled={busy || running} onClick={start}>
          {busy === 'start' ? '启动中…' : '一键启动'}
        </button>
        <button type="button" className="danger-btn" disabled={busy || !running} onClick={stop}>
          {busy === 'stop' ? '停止中…' : '停止'}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setLogs([]);
            nextRef.current = 0;
          }}
        >
          清空日志视图
        </button>
      </div>
      {runtime?.resolveError ? <p className="hint">{runtime.resolveError}</p> : null}
      <pre className="runtime-log" ref={logRef}>
        {logs.length === 0
          ? '（暂无日志）'
          : logs.map((l) => `[${l.stream}] ${l.line}`).join('\n')}
      </pre>
    </section>
  );
}

function DetailPanel({ project, onClose, onUpdated, llmReady }) {
  const [form, setForm] = useState({
    status: project.status,
    progress: project.progress ?? 0,
    url: project.manual?.url || project.url || '',
    port: project.manual?.port ?? project.port ?? '',
    notes: project.notes || '',
    docsText: (project.docs || [])
      .map((d) => `${d.title || ''}|${d.url || ''}`)
      .join('\n'),
  });
  const syncDefault = project.githubSync || {};
  const [gitForm, setGitForm] = useState({
    autoCommit: syncDefault.autoCommit !== false,
    commitMessage: syncDefault.commitMessage || 'chore: sync {date}',
    enabled: Boolean(syncDefault.enabled),
    intervalMinutes: syncDefault.intervalMinutes || 60,
  });
  const [detail, setDetail] = useState(null);
  const [gitStatus, setGitStatus] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [commits, setCommits] = useState([]);
  const [loadingCommits, setLoadingCommits] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [tab, setTab] = useState('info');
  const [repoForm, setRepoForm] = useState({
    name: project.name || '',
    private: true,
    description: '',
    push: true,
  });
  const [mpSummary, setMpSummary] = useState(project.marketplace || null);

  const handleMarketplaceChanged = useCallback(
    (record) => {
      const platforms = record?.platforms || [];
      const totalCost = platforms.reduce((sum, p) => sum + (Number(p.cost?.total) || 0), 0);
      const withWin = platforms
        .map((p) => p.winRate?.dealWinRate ?? p.winRate?.conversionRate)
        .filter((n) => n != null && !Number.isNaN(Number(n)))
        .map(Number);
      const summary = {
        listingCount: record?.listings?.length || 0,
        listedCount: (record?.listings || []).filter((l) => l.status === 'listed').length,
        feedbackCount: record?.feedback?.length || 0,
        githubFeedbackCount: (record?.feedback || []).filter((f) => f.source === 'github').length,
        platformCount: platforms.length,
        totalCost,
        avgWinRate:
          withWin.length > 0
            ? Math.round((withWin.reduce((a, b) => a + b, 0) / withWin.length) * 10) / 10
            : null,
        hasIterationPlan: Boolean(record?.iterationPlan?.content),
        hasCommercialPlan: Boolean(record?.commercialPlan?.content),
        commercialBasedOnMakemoney: Boolean(record?.commercialPlan?.basedOnMakemoney),
        stores: [
          ...new Set([
            ...(record?.listings || []).map((l) => l.storeName || l.store),
            ...platforms.map((p) => p.storeName || p.store),
          ]),
        ],
      };
      setMpSummary(summary);
      onUpdated({ id: project.id, marketplace: summary });
    },
    [onUpdated, project.id],
  );

  useEffect(() => {
    setForm({
      status: project.status,
      progress: project.progress ?? 0,
      url: project.manual?.url || '',
      port: project.manual?.port ?? '',
      notes: project.notes || '',
      docsText: (project.docs || [])
        .map((d) => `${d.title || ''}|${d.url || ''}`)
        .join('\n'),
    });
    const s = project.githubSync || {};
    setGitForm({
      autoCommit: s.autoCommit !== false,
      commitMessage: s.commitMessage || 'chore: sync {date}',
      enabled: Boolean(s.enabled),
      intervalMinutes: s.intervalMinutes || 60,
    });
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDetail(true);
    setError('');
    setInfo('');
    setRepoForm((f) => ({ ...f, name: project.name || f.name }));
    Promise.all([
      api(`/api/projects/${encodeURIComponent(project.id)}`),
      api(`/api/projects/${encodeURIComponent(project.id)}/git?fetch=1`).catch(() => null),
      api(`/api/projects/${encodeURIComponent(project.id)}/commits?limit=20`).catch(() => null),
    ])
      .then(([d, g, c]) => {
        if (cancelled) return;
        setDetail(d);
        setGitStatus(g);
        setCommits(c?.commits || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.name]);

  async function reloadCommits() {
    setLoadingCommits(true);
    try {
      const c = await api(`/api/projects/${encodeURIComponent(project.id)}/commits?limit=20`);
      setCommits(c.commits || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingCommits(false);
    }
  }

  async function createRepo() {
    if (!window.confirm(`在 GitHub 创建仓库「${repoForm.name}」并关联 origin？`)) return;
    setCreatingRepo(true);
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/github-create`, {
        method: 'POST',
        body: JSON.stringify(repoForm),
      });
      if (result.project) {
        onUpdated(result.project);
        setDetail((d) => (d ? { ...d, ...result.project } : d));
      }
      if (result.status) setGitStatus(result.status);
      setInfo(result.message || 'GitHub 仓库已创建');
      await reloadCommits();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreatingRepo(false);
    }
  }

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setGitField(key, value) {
    setGitForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const docs = form.docsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [title, ...rest] = line.split('|');
          return { title: title.trim(), url: rest.join('|').trim() };
        })
        .filter((d) => d.url);

      const updated = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: form.status,
          progress: Number(form.progress) || 0,
          url: form.url,
          port: form.port === '' ? null : Number(form.port),
          notes: form.notes,
          docs,
        }),
      });
      onUpdated(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function markVoid() {
    if (!window.confirm(`确认将「${project.name}」标记作废并移入回收站？\n磁盘上的项目文件不会删除。`)) {
      return;
    }
    setVoiding(true);
    setError('');
    setInfo('');
    try {
      const updated = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'trashed' }),
      });
      onUpdated(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
      setForm((f) => ({ ...f, status: 'trashed' }));
      setInfo('已标记作废，项目已进入回收站');
      setTab('info');
    } catch (err) {
      setError(err.message);
    } finally {
      setVoiding(false);
    }
  }

  async function restoreFromTrash() {
    setRestoring(true);
    setError('');
    setInfo('');
    try {
      const updated = await api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ restore: true }),
      });
      onUpdated(updated);
      setDetail((d) => (d ? { ...d, ...updated } : d));
      setForm((f) => ({ ...f, status: updated.status }));
      setInfo(`已从回收站恢复为「${STATUS_MAP[updated.status] || updated.status}」`);
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  }

  async function runSummarize() {
    setSummarizing(true);
    setError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/summarize`, {
        method: 'POST',
        body: '{}',
      });
      onUpdated(result.project);
      setDetail((d) => (d ? { ...d, ...result.project } : d));
      setTab('ai');
    } catch (err) {
      setError(err.message);
    } finally {
      setSummarizing(false);
    }
  }

  async function runGithubSync() {
    setSyncing(true);
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/github-sync`, {
        method: 'POST',
        body: JSON.stringify({
          autoCommit: gitForm.autoCommit,
          commitMessage: gitForm.commitMessage,
        }),
      });
      if (result.project) onUpdated(result.project);
      setGitStatus(result.status || null);
      setInfo(result.message || '已更新到 GitHub');
      setDetail((d) => (d && result.project ? { ...d, ...result.project } : d));
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  async function saveSchedule() {
    setSavingSchedule(true);
    setError('');
    setInfo('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/github-schedule`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: gitForm.enabled,
          intervalMinutes: Number(gitForm.intervalMinutes) || 60,
          autoCommit: gitForm.autoCommit,
          commitMessage: gitForm.commitMessage,
        }),
      });
      if (result.project) {
        onUpdated(result.project);
        setDetail((d) => (d ? { ...d, ...result.project } : d));
      }
      setInfo(
        gitForm.enabled
          ? `已开启定时同步，约每 ${gitForm.intervalMinutes} 分钟一次（需保持中台服务运行）`
          : '已关闭定时同步',
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSchedule(false);
    }
  }

  const current = detail || project;
  const readme = detail?.readme;
  const syncInfo = current.githubSync || {};

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <div>
            <h2>{project.name}</h2>
            <p className="mono path">{project.path}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="detail-tabs">
          <button type="button" className={tab === 'info' ? 'chip active' : 'chip'} onClick={() => setTab('info')}>
            项目信息
          </button>
          <button type="button" className={tab === 'readme' ? 'chip active' : 'chip'} onClick={() => setTab('readme')}>
            README
          </button>
          <button type="button" className={tab === 'github' ? 'chip active' : 'chip'} onClick={() => setTab('github')}>
            GitHub
          </button>
          <button type="button" className={tab === 'run' ? 'chip active' : 'chip'} onClick={() => setTab('run')}>
            运行
            {project.runtime?.running || current.runtime?.running ? ' ●' : ''}
          </button>
          <button type="button" className={tab === 'deploy' ? 'chip active' : 'chip'} onClick={() => setTab('deploy')}>
            部署
            {current.deploy?.lastOk ? ' ✓' : current.deploy?.lastOk === false ? ' !' : ''}
          </button>
          <button
            type="button"
            className={tab === 'marketplace' ? 'chip active' : 'chip'}
            onClick={() => setTab('marketplace')}
          >
            上架反馈
            {mpSummary?.feedbackCount || mpSummary?.listingCount
              ? ` (${(mpSummary.listedCount || 0) + (mpSummary.feedbackCount || 0)})`
              : ''}
          </button>
          <button type="button" className={tab === 'ai' ? 'chip active' : 'chip'} onClick={() => setTab('ai')}>
            AI 解读
          </button>
          <button type="button" className={tab === 'edit' ? 'chip active' : 'chip'} onClick={() => setTab('edit')}>
            编辑
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {info && <p className="hint success-hint">{info}</p>}

        {tab === 'info' && (
          <section className="section readonly">
            <h3>概览</h3>
            {loadingDetail && <p className="hint">正在读取项目文件…</p>}
            {(current.deploy?.url ||
              current.deploy?.port ||
              (current.status === 'deployed' && current.url)) && (
              <div className="deploy-access-card">
                <div className="deploy-access-label">线上部署</div>
                <div className="deploy-access-row">
                  <span className="subtle">网址</span>
                  {current.deploy?.url || current.url ? (
                    <a
                      href={current.deploy?.url || current.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {current.deploy?.url || current.url}
                    </a>
                  ) : (
                    <span className="mono">—</span>
                  )}
                </div>
                <div className="deploy-access-row">
                  <span className="subtle">端口</span>
                  <span className="mono">
                    {current.deploy?.port ?? current.port ?? '—'}
                  </span>
                </div>
                {current.deploy?.lastDeployAt ? (
                  <div className="deploy-access-row">
                    <span className="subtle">上次部署</span>
                    <span>
                      {current.deploy.lastOk === false ? '失败' : '成功'} ·{' '}
                      {formatTime(current.deploy.lastDeployAt)}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
            <dl className="meta-grid">
              <div>
                <dt>状态</dt>
                <dd>{STATUS_MAP[current.status] || current.status}</dd>
              </div>
            <div>
              <dt>进展</dt>
              <dd>
                {current.progress ?? 0}%
                <span className="subtle">
                  {' '}
                  · {current.progressSource === 'manual' ? '手填' : '自动估算'}
                  {current.estimatedProgress != null && current.progressSource === 'manual'
                    ? `（估算 ${current.estimatedProgress}%）`
                    : ''}
                </span>
              </dd>
            </div>
            <div>
              <dt>服务探测</dt>
              <dd>
                {current.health?.live === true
                  ? `运行中${current.health.ms != null ? ` · ${current.health.ms}ms` : ''}`
                  : current.health?.live === false
                    ? `未响应${current.health.error ? ` · ${current.health.error}` : ''}`
                    : '未探测'}
              </dd>
            </div>
              <div>
                <dt>包名</dt>
                <dd className="mono">{current.packageName || '—'}</dd>
              </div>
              <div>
                <dt>端口</dt>
                <dd className="mono">
                  {current.port ?? '—'}
                  {current.portSource ? ` (${current.portSource})` : ''}
                </dd>
              </div>
              <div>
                <dt>网址</dt>
                <dd className="wrap">
                  {current.url ? (
                    <a href={current.url} target="_blank" rel="noreferrer">
                      {current.url}
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>技术栈</dt>
                <dd>{(current.stack || []).join(', ') || '—'}</dd>
              </div>
              <div>
                <dt>上架 / 反馈</dt>
                <dd>
                  {mpSummary?.listedCount || 0} 店上架 · {mpSummary?.platformCount || 0} 平台运营 ·{' '}
                  {mpSummary?.feedbackCount || 0} 条反馈
                  {mpSummary?.totalCost > 0 ? ` · 成本 ${mpSummary.totalCost}` : ''}
                  {mpSummary?.hasIterationPlan ? ' · 有迭代计划' : ''}
                </dd>
              </div>
              <div>
                <dt>Git 远程</dt>
                <dd className="mono wrap">{current.remoteUrl || '—'}</dd>
              </div>
              <div>
                <dt>最近提交</dt>
                <dd>{formatTime(current.lastCommitAt)}</dd>
              </div>
              <div>
                <dt>目录修改</dt>
                <dd>{formatTime(current.mtime)}</dd>
              </div>
              <div>
                <dt>文档文件</dt>
                <dd>
                  {(detail?.docFiles || []).map((f) => f.name).join(', ') ||
                    [current.hasReadme && 'README', current.hasAgents && 'AGENTS'].filter(Boolean).join(', ') ||
                    '—'}
                </dd>
              </div>
            </dl>
            {current.notes ? (
              <div className="notes-block">
                <h3>备注</h3>
                <p>{current.notes}</p>
              </div>
            ) : null}
            {current.status === 'trashed' ? (
              <div className="notes-block trash-banner">
                <h3>回收站</h3>
                <p>
                  已作废
                  {current.trashedAt ? ` · ${formatTime(current.trashedAt)}` : ''}
                  {current.statusBeforeTrash
                    ? ` · 作废前：${STATUS_MAP[current.statusBeforeTrash] || current.statusBeforeTrash}`
                    : ''}
                </p>
                <button type="button" className="primary" disabled={restoring} onClick={restoreFromTrash}>
                  {restoring ? '恢复中…' : '从回收站恢复'}
                </button>
              </div>
            ) : (
              <div className="notes-block">
                <button type="button" className="danger-btn" disabled={voiding} onClick={markVoid}>
                  {voiding ? '处理中…' : '标记作废并移入回收站'}
                </button>
                <p className="hint">作废后从主列表隐藏，可在「回收站」查看与恢复。不删除磁盘文件。</p>
              </div>
            )}
            {current.aiSummary ? (
              <div className="notes-block">
                <h3>已保存的 AI 解读</h3>
                <pre className="ai-summary">{current.aiSummary}</pre>
                <p className="hint">
                  {current.aiSummaryModel || ''} · {formatTime(current.aiSummaryAt)}
                </p>
              </div>
            ) : null}
          </section>
        )}

        {tab === 'readme' && (
          <section className="section">
            <h3>{readme?.name || 'README'}</h3>
            {loadingDetail ? (
              <p className="hint">读取中…</p>
            ) : readme ? (
              <>
                <p className="hint mono">
                  {readme.path} · {Math.round((readme.size || 0) / 1024)} KB
                  {readme.truncated ? ' · 已截断' : ''}
                </p>
                <pre className="readme-view">{readme.content}</pre>
              </>
            ) : (
              <p className="hint">未找到 README.md / AGENTS.md</p>
            )}
          </section>
        )}

        {tab === 'github' && (
          <section className="section">
            <h3>更新到 GitHub</h3>
            {loadingDetail ? (
              <p className="hint">读取 Git 状态…</p>
            ) : !gitStatus?.hasGit ? (
              <p className="hint">当前目录不是 Git 仓库。可先「一键建仓」自动 git init + 创建 GitHub 仓库。</p>
            ) : (
              <>
                <dl className="meta-grid">
                  <div>
                    <dt>分支</dt>
                    <dd className="mono">{gitStatus.branch || '—'}</dd>
                  </div>
                  <div>
                    <dt>远程</dt>
                    <dd className="mono wrap">{gitStatus.remoteUrl || '—'}</dd>
                  </div>
                  <div>
                    <dt>未提交</dt>
                    <dd>{gitStatus.dirty ? `${gitStatus.dirtyCount} 个文件` : '无'}</dd>
                  </div>
                  <div>
                    <dt>相对远程</dt>
                    <dd>
                      ahead {gitStatus.ahead || 0} / behind {gitStatus.behind || 0}
                    </dd>
                  </div>
                </dl>
                {gitStatus.dirtyFiles?.length > 0 && (
                  <pre className="readme-view">{gitStatus.dirtyFiles.join('\n')}</pre>
                )}
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={gitForm.autoCommit}
                    onChange={(e) => setGitField('autoCommit', e.target.checked)}
                  />
                  有本地改动时自动 git add + commit
                </label>
                <label>
                  提交说明（支持 {'{date}'}）
                  <input
                    value={gitForm.commitMessage}
                    onChange={(e) => setGitField('commitMessage', e.target.value)}
                  />
                </label>
                <button type="button" className="primary" disabled={syncing || !gitStatus.remoteUrl} onClick={runGithubSync}>
                  {syncing ? '推送中…' : '立即更新到 GitHub'}
                </button>
                <p className="hint">不会 force push。需本机已登录 GitHub（HTTPS 凭据或 SSH）。</p>
              </>
            )}

            {!gitStatus?.remoteUrl && (
              <>
                <h3>一键建 GitHub 仓</h3>
                <p className="hint">依赖本机已安装并登录 `gh`（`gh auth login`）。默认私有仓并 push。</p>
                <label>
                  仓库名
                  <input
                    value={repoForm.name}
                    onChange={(e) => setRepoForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </label>
                <label>
                  描述
                  <input
                    value={repoForm.description}
                    onChange={(e) => setRepoForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={repoForm.private}
                    onChange={(e) => setRepoForm((f) => ({ ...f, private: e.target.checked }))}
                  />
                  私有仓库
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={repoForm.push}
                    onChange={(e) => setRepoForm((f) => ({ ...f, push: e.target.checked }))}
                  />
                  创建后立即 push
                </label>
                <button type="button" className="primary" disabled={creatingRepo || !repoForm.name} onClick={createRepo}>
                  {creatingRepo ? '创建中…' : '创建 GitHub 仓库'}
                </button>
              </>
            )}

            <h3>提交历史</h3>
            <button type="button" className="ghost" disabled={loadingCommits} onClick={reloadCommits}>
              {loadingCommits ? '刷新中…' : '刷新提交'}
            </button>
            {commits.length === 0 ? (
              <p className="hint">暂无提交记录（新仓库可能还没有任何 commit）</p>
            ) : (
              <ul className="commit-timeline">
                {commits.map((c) => (
                  <li key={c.hash || c.shortHash}>
                    <div className="commit-head">
                      <span className="mono">{c.shortHash}</span>
                      <span className="subtle">{formatTime(c.date)}</span>
                    </div>
                    <div className="commit-subject">{c.subject}</div>
                    <div className="subtle">{c.author}</div>
                  </li>
                ))}
              </ul>
            )}

            <h3>后台定时同步</h3>
            <p className="hint">中台服务保持运行时，按间隔自动推送。配置写入 data/projects.json。</p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={gitForm.enabled}
                onChange={(e) => setGitField('enabled', e.target.checked)}
              />
              启用定时推送到 GitHub
            </label>
            <label>
              间隔（分钟，最少 5）
              <input
                type="number"
                min="5"
                max="1440"
                value={gitForm.intervalMinutes}
                onChange={(e) => setGitField('intervalMinutes', e.target.value)}
              />
            </label>
            <button type="button" className="primary" disabled={savingSchedule} onClick={saveSchedule}>
              {savingSchedule ? '保存中…' : '保存定时设置'}
            </button>
            {(syncInfo.lastRunAt || syncInfo.nextRunAt) && (
              <dl className="meta-grid">
                <div>
                  <dt>上次运行</dt>
                  <dd>
                    {formatTime(syncInfo.lastRunAt)}
                    {syncInfo.lastOk == null ? '' : syncInfo.lastOk ? ' · 成功' : ' · 失败'}
                  </dd>
                </div>
                <div>
                  <dt>下次计划</dt>
                  <dd>{syncInfo.enabled ? formatTime(syncInfo.nextRunAt) : '—'}</dd>
                </div>
                <div>
                  <dt>上次结果</dt>
                  <dd className="wrap">{syncInfo.lastMessage || '—'}</dd>
                </div>
              </dl>
            )}
          </section>
        )}

        {tab === 'run' && <RuntimePanel project={current} onUpdated={onUpdated} />}

        {tab === 'deploy' && <DeployPanel project={current} onUpdated={onUpdated} />}

        {tab === 'marketplace' && (
          <MarketplacePanel
            project={current}
            llmReady={llmReady}
            onChanged={handleMarketplaceChanged}
          />
        )}

        {tab === 'ai' && (
          <section className="section">
            <h3>DeepSeek 项目解读</h3>
            <p className="hint">基于 README 与扫描元信息生成摘要，并持久化写入 data/projects.json。</p>
            <button
              type="button"
              className="primary"
              disabled={summarizing || !llmReady}
              onClick={runSummarize}
            >
              {summarizing ? '生成中…' : llmReady ? '用 DeepSeek Flash 解读' : '请先配置 API Key'}
            </button>
            {(current.aiSummary || detail?.aiSummary) && (
              <>
                <pre className="ai-summary">{current.aiSummary || detail?.aiSummary}</pre>
                <p className="hint">
                  {(current.aiSummaryModel || detail?.aiSummaryModel) || ''} ·{' '}
                  {formatTime(current.aiSummaryAt || detail?.aiSummaryAt)}
                </p>
              </>
            )}
          </section>
        )}

        {tab === 'edit' && (
          <section className="section">
            <h3>可编辑（持久化）</h3>
            <label>
              状态
              <select
                value={form.status === 'trashed' ? 'trashed' : form.status}
                onChange={(e) => setField('status', e.target.value)}
                disabled={current.status === 'trashed'}
              >
                {WORK_STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
                {current.status === 'trashed' ? (
                  <option value="trashed">回收站（已作废）</option>
                ) : null}
              </select>
            </label>
            {current.status === 'trashed' ? (
              <p className="hint">项目已在回收站。请先恢复后再改状态，或使用上方「从回收站恢复」。</p>
            ) : null}
            <label>
              进展 ({form.progress}%)
              <input
                type="range"
                min="0"
                max="100"
                value={form.progress}
                onChange={(e) => setField('progress', e.target.value)}
              />
              <span className="hint">
                未手填时按 Git/文档/部署信号自动估算
                {project.estimatedProgress != null ? `（当前估算 ${project.estimatedProgress}%）` : ''}
                ；拖动滑条后会保存为手动值。
              </span>
            </label>
            <label>
              端口（覆盖自动推断）
              <input
                type="number"
                value={form.port}
                placeholder={project.detectedPort ? String(project.detectedPort) : ''}
                onChange={(e) => setField('port', e.target.value)}
              />
            </label>
            <label>
              网址
              <input
                type="url"
                value={form.url}
                placeholder={project.detectedPort ? `http://localhost:${project.detectedPort}` : ''}
                onChange={(e) => setField('url', e.target.value)}
              />
            </label>
            <label>
              文档链接（每行：标题|URL）
              <textarea
                rows={4}
                value={form.docsText}
                onChange={(e) => setField('docsText', e.target.value)}
                placeholder="README|https://..."
              />
            </label>
            <label>
              备注
              <textarea rows={3} value={form.notes} onChange={(e) => setField('notes', e.target.value)} />
            </label>
            <button type="button" className="primary" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存到 data/projects.json'}
            </button>
            {current.status !== 'trashed' ? (
              <button type="button" className="danger-btn" disabled={voiding} onClick={markVoid}>
                {voiding ? '处理中…' : '标记作废并移入回收站'}
              </button>
            ) : (
              <button type="button" className="primary" disabled={restoring} onClick={restoreFromTrash}>
                {restoring ? '恢复中…' : '从回收站恢复'}
              </button>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

function ProjectRow({ project, onOpen }) {
  const openUrl = project.url || (project.port ? `http://localhost:${project.port}` : '');
  const live = project.health?.live;
  return (
    <tr
      className={project.missing ? 'missing' : undefined}
      onClick={() => onOpen(project)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(project);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <td>
        <div className="name-cell">
          <span
            className={`live-dot ${live === true ? 'live' : live === false ? 'down' : 'unknown'}`}
            title={
              live === true
                ? `运行中${project.health?.ms != null ? ` · ${project.health.ms}ms` : ''}`
                : live === false
                  ? '未响应'
                  : '未探测'
            }
          />
          <span className={`status-dot status-${project.status}`} />
          <div>
            <div className="name">{project.name}</div>
            <div className="mono subtle path-line">{project.path}</div>
          </div>
        </div>
      </td>
      <td>
        <span className={`badge status-${project.status}`}>{STATUS_MAP[project.status] || project.status}</span>
      </td>
      <td>
        <div className="progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(100, Number(project.progress) || 0)}%` }} />
          </div>
          <span>
            {project.progress ?? 0}%
            <span className="subtle"> · {project.progressSource === 'manual' ? '手填' : '估算'}</span>
          </span>
        </div>
      </td>
      <td className="mono">
        {project.port ?? '—'}
        {project.portSource && !project.manual?.port ? <span className="subtle"> · auto</span> : null}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {openUrl ? (
          <a href={openUrl} target="_blank" rel="noreferrer">
            {openUrl.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          '—'
        )}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {(project.docs || []).length === 0 ? (
          '—'
        ) : (
          <div className="doc-links">
            {project.docs.map((d, i) => (
              <a key={`${d.url}-${i}`} href={d.url} target="_blank" rel="noreferrer">
                {d.title || d.url}
              </a>
            ))}
          </div>
        )}
      </td>
      <td>
        <div className="stack-tags">
          {(project.stack || []).map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
          {project.hasGit && project.remoteUrl ? <span className="tag">github</span> : null}
          {project.nodeName ? (
            <span className="tag" title={project.nodeHostname || project.nodeId}>
              {project.local === false ? `远端·${project.nodeName}` : project.nodeName}
            </span>
          ) : null}
          {project.githubSync?.enabled ? <span className="tag">定时同步</span> : null}
          {project.deploy?.url || (project.status === 'deployed' && project.url) ? (
            <span className="tag" title={project.deploy?.url || project.url}>
              线上
              {project.deploy?.port || project.port
                ? ` :${project.deploy?.port || project.port}`
                : ''}
            </span>
          ) : null}
          {project.runtime?.running ? <span className="tag">dev 运行中</span> : null}
          {project.marketplace?.listedCount > 0 ? (
            <span className="tag">上架 {project.marketplace.listedCount}</span>
          ) : null}
          {project.marketplace?.platformCount > 0 ? (
            <span className="tag">运营 {project.marketplace.platformCount}</span>
          ) : null}
          {project.marketplace?.feedbackCount > 0 ? (
            <span className="tag">反馈 {project.marketplace.feedbackCount}</span>
          ) : null}
          {project.marketplace?.hasIterationPlan ? <span className="tag">迭代计划</span> : null}
          {project.marketplace?.hasCommercialPlan ? (
            <span className="tag">
              {project.marketplace.commercialBasedOnMakemoney ? '商业化' : '商业草案'}
            </span>
          ) : null}
          {project.hasMakemoney ? <span className="tag">makemoney</span> : null}
          {project.aiSummary ? <span className="tag">ai</span> : null}
          {project.missing ? <span className="tag warn">缺失</span> : null}
          {project.status === 'trashed' ? <span className="tag warn">已作废</span> : null}
        </div>
      </td>
      <td className="subtle">{formatTime(project.lastCommitAt || project.mtime)}</td>
    </tr>
  );
}

function KanbanBoard({ projects, onOpen, onStatusChange }) {
  const [draggingId, setDraggingId] = useState(null);

  return (
    <div className="kanban">
      {WORK_STATUSES.map((s) => {
        const col = projects.filter((p) => p.status === s.id);
        return (
          <div
            key={s.id}
            className={`kanban-col status-${s.id}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/project-id') || draggingId;
              if (id) onStatusChange(id, s.id);
              setDraggingId(null);
            }}
          >
            <header className="kanban-col-head">
              <span>{s.label}</span>
              <span className="subtle">{col.length}</span>
            </header>
            <div className="kanban-col-body">
              {col.map((p) => (
                <article
                  key={p.id}
                  className="kanban-card"
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(p.id);
                    e.dataTransfer.setData('text/project-id', p.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => onOpen(p)}
                >
                  <div className="kanban-card-top">
                    <span
                      className={`live-dot ${
                        p.health?.live === true ? 'live' : p.health?.live === false ? 'down' : 'unknown'
                      }`}
                    />
                    <strong>{p.name}</strong>
                  </div>
                  <div className="progress">
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(100, Number(p.progress) || 0)}%` }}
                      />
                    </div>
                    <span>{p.progress ?? 0}%</span>
                  </div>
                  <div className="subtle mono path-line">{p.port ? `:${p.port}` : p.url || '—'}</div>
                  {(p.marketplace?.listedCount > 0 || p.marketplace?.feedbackCount > 0) && (
                    <div className="subtle">
                      {p.marketplace.listedCount > 0 ? `上架 ${p.marketplace.listedCount}` : ''}
                      {p.marketplace.listedCount > 0 && p.marketplace.feedbackCount > 0 ? ' · ' : ''}
                      {p.marketplace.feedbackCount > 0 ? `反馈 ${p.marketplace.feedbackCount}` : ''}
                    </div>
                  )}
                </article>
              ))}
              {col.length === 0 && <p className="kanban-empty">拖拽到此处</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WeeklyPanel({ open, onClose, llmReady }) {
  const [report, setReport] = useState(null);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    api('/api/reports/weekly')
      .then((d) => {
        setReport(d.latest);
        setList(d.list || []);
      })
      .catch(() => {});
  }, [open]);

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const next = await api('/api/reports/weekly', { method: 'POST', body: '{}' });
      setReport(next);
      setList((prev) => [next, ...prev.filter((r) => r.id !== next.id)].slice(0, 20));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <div>
            <h2>AI 周报</h2>
            <p className="hint">汇总各项目状态、提交活跃度与健康探测，生成中文周报并写入 PostgreSQL。</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <button type="button" className="primary" disabled={loading || !llmReady} onClick={generate}>
          {loading ? '生成中…' : llmReady ? '生成本周周报' : '请先启用大模型并配置 API Key'}
        </button>
        {error && <p className="error">{error}</p>}
        {list.length > 1 ? (
          <div className="filters" style={{ marginTop: 12 }}>
            {list.map((r) => (
              <button
                key={r.id}
                type="button"
                className={report?.id === r.id ? 'chip active' : 'chip'}
                onClick={() => setReport(r)}
              >
                {formatTime(r.createdAt)}
              </button>
            ))}
          </div>
        ) : null}
        {report ? (
          <section className="section">
            <p className="hint">
              {report.model} · {formatTime(report.createdAt)} · {report.projectCount} 个项目
            </p>
            <pre className="ai-summary">{report.content}</pre>
          </section>
        ) : (
          <p className="hint">还没有周报，点击上方生成。</p>
        )}
      </aside>
    </div>
  );
}

function NodesPanel({ onClose }) {
  const [nodes, setNodes] = useState([]);
  const [local, setLocal] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/nodes');
      setNodes(data.nodes || []);
      setLocal(data.local || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function remove(id) {
    if (!window.confirm('删除该节点？其上报的项目快照会保留，但节点记录将移除。')) return;
    try {
      const data = await api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setNodes(data.nodes || []);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <div>
            <h2>扫描节点（多机）</h2>
            <p className="hint">
              本机作为 hub 监听局域网。其他电脑安装同一仓库后执行：
              <code>HUB_URL=http://本机IP:8800 npm run agent</code>
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          本机：{local?.name || '—'} · {local?.hostname || ''} · {local?.id}
        </p>
        <button type="button" className="ghost" disabled={loading} onClick={load}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>角色</th>
              <th>主机</th>
              <th>根目录</th>
              <th>深度</th>
              <th>最近在线</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <td>
                  {n.name} {n.online ? <span className="tag">在线</span> : <span className="tag warn">离线</span>}
                </td>
                <td>{n.role}</td>
                <td className="mono">{n.hostname || '—'}</td>
                <td className="mono">{(n.scanRoots || []).join('; ') || '—'}</td>
                <td>{n.scanDepth}</td>
                <td>{formatTime(n.lastSeenAt)}</td>
                <td>
                  {n.role !== 'hub' && n.id !== local?.id ? (
                    <button type="button" className="ghost" onClick={() => remove(n.id)}>
                      删除
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </aside>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState({ projects: [], scannedAt: null, roots: [] });
  const [settings, setSettings] = useState({ scanRoots: [], llm: {} });
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [syncFailures, setSyncFailures] = useState([]);
  const [syncAlertDismissed, setSyncAlertDismissed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [showNodes, setShowNodes] = useState(false);
  const [showWeekly, setShowWeekly] = useState(false);
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem('projectmsg-view') === 'kanban' ? 'kanban' : 'list';
    } catch {
      return 'list';
    }
  });
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem('projectmsg-theme');
      if (saved === 'neu' || saved === 'minimal' || saved === 'classic') return saved;
      return 'luxury';
    } catch {
      return 'luxury';
    }
  });

  const mergeHealth = useCallback((projects, results) => {
    const map = Object.fromEntries((results || []).map((r) => [r.id, r]));
    return projects.map((p) => ({ ...p, health: map[p.id] || p.health || null }));
  }, []);

  const probeAll = useCallback(
    async (projects) => {
      setProbing(true);
      try {
        const payload = await api('/api/projects/probe', {
          method: 'POST',
          body: JSON.stringify({
            projects: projects.map((p) => ({ id: p.id, url: p.url, port: p.port })),
          }),
        });
        setData((prev) => ({
          ...prev,
          projects: mergeHealth(prev.projects, payload.results),
        }));
      } catch {
        // probe failures shouldn't block UI
      } finally {
        setProbing(false);
      }
    },
    [mergeHealth],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectsPayload, settingsPayload, alertsPayload] = await Promise.all([
        api('/api/projects'),
        api('/api/settings'),
        api('/api/alerts/github-sync').catch(() => ({ failures: [] })),
      ]);
      setData(projectsPayload);
      setSettings(settingsPayload);
      setSyncFailures(alertsPayload.failures || []);
      setSyncAlertDismissed(false);
      if (settingsPayload.theme) {
        setTheme(applyTheme(settingsPayload.theme));
      }
      setSelected((prev) => {
        if (!prev) return null;
        return projectsPayload.projects.find((p) => p.id === prev.id) || null;
      });
      probeAll(projectsPayload.projects);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [probeAll]);

  useEffect(() => {
    const timer = setInterval(() => {
      api('/api/alerts/github-sync')
        .then((a) => {
          setSyncFailures(a.failures || []);
        })
        .catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    load();
  }, [load]);

  async function changeTheme(nextTheme) {
    const applied = applyTheme(nextTheme);
    setTheme(applied);
    try {
      const next = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ theme: applied }),
      });
      setSettings(next);
    } catch (err) {
      setError(err.message);
    }
  }

  function setView(mode) {
    setViewMode(mode);
    try {
      localStorage.setItem('projectmsg-view', mode);
    } catch {
      // ignore
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data.projects || []).filter((p) => {
      if (statusFilter === 'all') {
        if (p.status === 'trashed') return false;
      } else if (statusFilter === 'trashed') {
        if (p.status !== 'trashed') return false;
      } else if (p.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (p.packageName || '').toLowerCase().includes(q) ||
        (p.notes || '').toLowerCase().includes(q) ||
        (p.aiSummary || '').toLowerCase().includes(q)
      );
    });
  }, [data.projects, query, statusFilter]);

  const counts = useMemo(() => {
    const active = (data.projects || []).filter((p) => p.status !== 'trashed');
    const c = { all: active.length, trashed: 0 };
    for (const s of WORK_STATUSES) c[s.id] = 0;
    for (const p of data.projects || []) {
      c[p.status] = (c[p.status] || 0) + 1;
    }
    return c;
  }, [data.projects]);

  const liveCount = useMemo(
    () =>
      (data.projects || []).filter((p) => p.status !== 'trashed' && p.health?.live === true).length,
    [data.projects],
  );

  function onUpdated(updated) {
    setData((prev) => ({
      ...prev,
      projects: prev.projects.map((p) =>
        p.id === updated.id ? { ...p, ...updated, health: p.health } : p,
      ),
    }));
    setSelected((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
  }

  async function onStatusChange(id, status) {
    if (status === 'trashed') {
      const proj = data.projects.find((p) => p.id === id);
      if (
        !window.confirm(
          `确认将「${proj?.name || '该项目'}」标记作废并移入回收站？\n磁盘上的项目文件不会删除。`,
        )
      ) {
        return;
      }
    }
    try {
      const updated = await api(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      onUpdated(updated);
    } catch (err) {
      setError(err.message);
    }
  }

  const llmReady = Boolean(settings.llm?.configured);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">ProjectMsg</p>
          <h1>项目管理中台</h1>
          <p className="subtitle">
            {loading
              ? '正在扫描本机项目目录…'
                : data.roots?.length
                ? `扫描根目录 ${data.roots.length} 个 · ${counts.all} 个项目${
                    counts.trashed ? ` · 回收站 ${counts.trashed}` : ''
                  }`
                : '配置扫描根目录后刷新'}
            {!loading && data.scannedAt ? ` · ${formatTime(data.scannedAt)}` : ''}
            {!loading ? ` · 运行中 ${liveCount}${probing ? '（探测中）' : ''}` : ''}
            {!loading && settings.dataDir ? ` · 持久化 ${settings.dataDir}` : ''}
          </p>
        </div>
        <div className="top-actions">
          <div className="theme-switch" role="group" aria-label="视图切换">
            <button
              type="button"
              className={viewMode === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
            >
              列表
            </button>
            <button
              type="button"
              className={viewMode === 'kanban' ? 'active' : ''}
              onClick={() => setView('kanban')}
            >
              看板
            </button>
          </div>
          <ThemePicker theme={theme} onChange={changeTheme} />
          <button type="button" className="ghost" onClick={() => setShowWeekly(true)}>
            AI 周报
          </button>
          <button type="button" className="ghost" onClick={() => setShowLlm(true)}>
            大模型配置
          </button>
          <button type="button" className="ghost" onClick={() => setShowServers(true)}>
            云服务器
          </button>
          <button type="button" className="ghost" onClick={() => setShowNodes(true)}>
            多机节点
          </button>
          <button type="button" className="ghost" onClick={() => setShowSettings(true)}>
            根目录设置
          </button>
          <button type="button" className="primary" disabled={loading} onClick={load}>
            {loading ? '扫描中…' : '刷新扫描'}
          </button>
        </div>
      </header>

      {!syncAlertDismissed && (
        <SyncFailBanner
          failures={syncFailures}
          onDismiss={() => setSyncAlertDismissed(true)}
          onOpen={(id) => {
            const p = data.projects.find((x) => x.id === id);
            if (p) setSelected(p);
          }}
        />
      )}

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="搜索名称 / 路径 / 备注 / AI 解读…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filters">
          <button
            type="button"
            className={statusFilter === 'all' ? 'chip active' : 'chip'}
            onClick={() => setStatusFilter('all')}
          >
            全部 {counts.all}
          </button>
          {WORK_STATUSES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={statusFilter === s.id ? `chip active status-${s.id}` : 'chip'}
              onClick={() => setStatusFilter(s.id)}
            >
              {s.label} {counts[s.id] || 0}
            </button>
          ))}
          <button
            type="button"
            className={statusFilter === 'trashed' ? 'chip active status-trashed' : 'chip'}
            onClick={() => {
              setStatusFilter('trashed');
              setView('list');
            }}
          >
            回收站 {counts.trashed || 0}
          </button>
        </div>
      </div>

      {error && <p className="error banner">{error}</p>}

      {viewMode === 'kanban' && statusFilter !== 'trashed' ? (
        <KanbanBoard projects={filtered} onOpen={setSelected} onStatusChange={onStatusChange} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>项目</th>
                <th>状态</th>
                <th>进展</th>
                <th>端口</th>
                <th>网址</th>
                <th>文档</th>
                <th>标签</th>
                <th>最近活动</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && !loading ? (
                <tr>
                  <td colSpan={8} className="empty">
                    没有匹配的项目。检查扫描根目录或放宽筛选。
                  </td>
                </tr>
              ) : (
                filtered.map((p) => <ProjectRow key={p.id} project={p} onOpen={setSelected} />)
              )}
            </tbody>
          </table>
        </div>
      )}

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(next) => {
            setSettings(next);
            // rescan with newly persisted roots
            load();
          }}
        />
      )}

      {showLlm && (
        <LlmPanel
          settings={settings}
          onClose={() => setShowLlm(false)}
          onSaved={(next) => setSettings(next)}
        />
      )}

      {showServers && (
        <ServersPanel
          onClose={() => setShowServers(false)}
          onChanged={(servers) => setSettings((s) => ({ ...s, servers }))}
        />
      )}

      {showNodes && <NodesPanel onClose={() => setShowNodes(false)} />}

      <WeeklyPanel open={showWeekly} onClose={() => setShowWeekly(false)} llmReady={llmReady} />

      {selected && (
        <DetailPanel
          project={selected}
          onClose={() => setSelected(null)}
          onUpdated={onUpdated}
          llmReady={llmReady}
        />
      )}
    </div>
  );
}
