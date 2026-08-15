import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatTime } from './api.js';
import { STATUS_MAP } from './constants.js';

const VIEWS = [
  { id: 'source', label: '本地源码' },
  { id: 'local', label: '本地服务' },
  { id: 'remote', label: '远端服务器' },
];

function StatusDot({ live }) {
  const cls = live === true ? 'live' : live === false ? 'down' : 'unknown';
  const title = live === true ? '可访问' : live === false ? '无响应' : '未探测';
  return <span className={`live-dot ${cls}`} title={title} />;
}

function SettingsDrawer({ settings, onClose, onSaved }) {
  const [rootsText, setRootsText] = useState((settings.scanRoots || []).join('\n'));
  const [scanDepth, setScanDepth] = useState(String(settings.scanDepth || 1));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      const scanRoots = rootsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (!scanRoots.length) throw new Error('至少保留一个扫描根目录');
      const next = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ scanRoots, scanDepth: Number(scanDepth) || 1 }),
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
          <h2>扫描设置</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <label>
          扫描深度
          <input
            type="number"
            min="1"
            max="4"
            value={scanDepth}
            onChange={(e) => setScanDepth(e.target.value)}
          />
        </label>
        <label>
          本机扫描根目录（每行一个）
          <textarea
            rows={8}
            value={rootsText}
            onChange={(e) => setRootsText(e.target.value)}
            placeholder={'D:\\VSworkspace\n/Users/you/Projects'}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="button" className="primary" disabled={saving} onClick={save}>
          {saving ? '保存中…' : '保存'}
        </button>
      </aside>
    </div>
  );
}

function SourceView({ projects, query, onQuery, onRefresh, loading }) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (p.status === 'trashed') return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.path || '').toLowerCase().includes(q) ||
        (p.notes || '').toLowerCase().includes(q)
      );
    });
  }, [projects, query]);

  return (
    <section className="panel">
      <div className="panel-toolbar">
        <input
          className="search"
          type="search"
          placeholder="搜索项目名 / 路径…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <button type="button" className="primary" disabled={loading} onClick={onRefresh}>
          {loading ? '扫描中…' : '刷新扫描'}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>路径</th>
              <th>状态</th>
              <th>技术栈</th>
              <th>文档</th>
              <th>最近活动</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  没有匹配的本地源码项目
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.nodeName ? <div className="subtle">{p.nodeName}</div> : null}
                  </td>
                  <td className="mono path">{p.path}</td>
                  <td>
                    <span className={`badge status-${p.status}`}>
                      {STATUS_MAP[p.status] || p.status}
                    </span>
                  </td>
                  <td>
                    <div className="tags">
                      {(p.stack || []).map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                      {p.hasGit ? <span className="tag">git</span> : null}
                      {p.missing ? <span className="tag warn">缺失</span> : null}
                    </div>
                  </td>
                  <td>
                    {[p.hasReadme && 'README', p.hasAgents && 'AGENTS', p.hasMakemoney && 'makemoney']
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td className="subtle">{formatTime(p.lastCommitAt || p.mtime)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LocalServiceView({ projects, onUpdated, probing }) {
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [gitMap, setGitMap] = useState({});

  const rows = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.status !== 'trashed' &&
          (p.port || p.url || p.remoteUrl || p.runtime?.running || p.hasGit),
      ),
    [projects],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      await Promise.all(
        rows.slice(0, 40).map(async (p) => {
          if (!p.hasGit) return;
          try {
            const g = await api(`/api/projects/${encodeURIComponent(p.id)}/git`);
            if (!cancelled) next[p.id] = g;
          } catch {
            if (!cancelled) next[p.id] = { error: 'git 状态读取失败' };
          }
        }),
      );
      if (!cancelled) setGitMap((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  async function toggleRuntime(p, start) {
    setBusyId(p.id);
    setError('');
    try {
      const result = await api(
        `/api/projects/${encodeURIComponent(p.id)}/runtime/${start ? 'start' : 'stop'}`,
        { method: 'POST', body: '{}' },
      );
      onUpdated?.({ id: p.id, runtime: result.status });
    } catch (err) {
      setError(`${p.name}: ${err.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function syncGithub(p) {
    setBusyId(`sync-${p.id}`);
    setError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(p.id)}/github-sync`, {
        method: 'POST',
        body: JSON.stringify({ autoCommit: true }),
      });
      if (result.project) onUpdated?.(result.project);
      const g = await api(`/api/projects/${encodeURIComponent(p.id)}/git`);
      setGitMap((m) => ({ ...m, [p.id]: g }));
    } catch (err) {
      setError(`${p.name}: ${err.message}`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="panel">
      <p className="hint">
        本机端口探活{probing ? '（探测中）' : ''}、进程启停与 GitHub 同步状态。
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>端口 / 网址</th>
              <th>探活</th>
              <th>本地进程</th>
              <th>GitHub</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  暂无带端口或 Git 的本地服务
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const openUrl = p.url || (p.port ? `http://localhost:${p.port}` : '');
                const git = gitMap[p.id];
                const running = Boolean(p.runtime?.running);
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <div className="subtle">{STATUS_MAP[p.status] || p.status}</div>
                    </td>
                    <td className="mono">
                      {p.port != null ? `:${p.port}` : '—'}
                      {openUrl ? (
                        <div>
                          <a href={openUrl} target="_blank" rel="noreferrer">
                            {openUrl.replace(/^https?:\/\//, '')}
                          </a>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <StatusDot live={p.health?.live} />
                      {p.health?.ms != null ? (
                        <span className="subtle"> {p.health.ms}ms</span>
                      ) : null}
                    </td>
                    <td>
                      {running ? (
                        <span className="tag ok">运行中{p.runtime?.script ? ` · ${p.runtime.script}` : ''}</span>
                      ) : (
                        <span className="subtle">未运行</span>
                      )}
                    </td>
                    <td>
                      {p.remoteUrl ? (
                        <div>
                          <a href={p.remoteUrl} target="_blank" rel="noreferrer" className="mono">
                            {p.remoteUrl.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')}
                          </a>
                          <div className="subtle">
                            {git?.error
                              ? git.error
                              : git
                                ? `${git.branch || '—'} · ${git.dirty ? `未提交 ${git.dirtyCount}` : '干净'}${
                                    git.ahead ? ` · ahead ${git.ahead}` : ''
                                  }${git.behind ? ` · behind ${git.behind}` : ''}`
                                : '读取中…'}
                          </div>
                        </div>
                      ) : (
                        <span className="subtle">无 origin</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {running ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyId === p.id}
                            onClick={() => toggleRuntime(p, false)}
                          >
                            停止
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyId === p.id || p.missing}
                            onClick={() => toggleRuntime(p, true)}
                          >
                            启动
                          </button>
                        )}
                        {p.remoteUrl ? (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busyId === `sync-${p.id}`}
                            onClick={() => syncGithub(p)}
                          >
                            同步
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RemoteView({ projects, onOpenServers, servers }) {
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [prechecks, setPrechecks] = useState({});

  const deployed = useMemo(
    () =>
      projects.filter(
        (p) =>
          p.status !== 'trashed' &&
          (p.deploy?.serverId || p.status === 'deployed' || p.deploy?.lastDeployAt),
      ),
    [projects],
  );

  const serverMap = useMemo(
    () => Object.fromEntries((servers || []).map((s) => [s.id, s])),
    [servers],
  );

  async function runPrecheck(p) {
    setBusyId(p.id);
    setError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(p.id)}/deploy/precheck`, {
        method: 'POST',
        body: JSON.stringify({ deploy: p.deploy || {} }),
      });
      setPrechecks((m) => ({ ...m, [p.id]: result }));
    } catch (err) {
      setError(`${p.name}: ${err.message}`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <section className="panel">
      <div className="panel-toolbar">
        <p className="hint">远端云服务器与各项目部署状态。</p>
        <button type="button" className="ghost" onClick={onOpenServers}>
          管理服务器
        </button>
      </div>
      {error && <p className="error">{error}</p>}

      <h3>已登记服务器</h3>
      <div className="card-grid">
        {(servers || []).length === 0 ? (
          <p className="empty">尚未添加云服务器。点右上角「管理服务器」。</p>
        ) : (
          servers.map((s) => (
            <article key={s.id} className="card">
              <header>
                <strong>{s.name}</strong>
                <span className="tag">{s.provider}</span>
              </header>
              <p className="mono">
                {s.username}@{s.host}:{s.port || 22}
              </p>
              <p className="subtle">{s.notes || '无备注'}</p>
            </article>
          ))
        )}
      </div>

      <h3>项目部署状态</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>目标服务器</th>
              <th>远端路径</th>
              <th>公网</th>
              <th>上次部署</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {deployed.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty">
                  还没有配置部署的项目
                </td>
              </tr>
            ) : (
              deployed.map((p) => {
                const srv = serverMap[p.deploy?.serverId] || null;
                const pre = prechecks[p.id];
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <div className="subtle">{STATUS_MAP[p.status] || p.status}</div>
                    </td>
                    <td>{srv ? `${srv.name} (${srv.host})` : p.deploy?.serverId || '—'}</td>
                    <td className="mono">{p.deploy?.remotePath || '—'}</td>
                    <td className="mono">
                      {p.deploy?.url || p.url ? (
                        <a href={p.deploy?.url || p.url} target="_blank" rel="noreferrer">
                          {(p.deploy?.url || p.url).replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {p.deploy?.lastDeployAt ? (
                        <span>
                          {p.deploy.lastOk === false ? '失败' : '成功'} ·{' '}
                          {formatTime(p.deploy.lastDeployAt)}
                        </span>
                      ) : (
                        <span className="subtle">尚未部署</span>
                      )}
                      {pre ? (
                        <div className="subtle">
                          预检 {pre.ok ? '通过' : '未通过'}
                          {(pre.checks || [])
                            .filter((c) => !c.ok)
                            .map((c) => ` · ${c.id}`)
                            .join('')}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyId === p.id || !p.deploy?.serverId}
                        onClick={() => runPrecheck(p)}
                      >
                        预检
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServersDrawer({ onClose, onChanged }) {
  const [servers, setServers] = useState([]);
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: 22,
    username: 'root',
    privateKeyPath: '',
    provider: 'other',
    notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api('/api/servers');
    setServers(data.servers || []);
    onChanged?.(data.servers || []);
  }, [onChanged]);

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, [load]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/api/servers', {
        method: 'POST',
        body: JSON.stringify({ ...form, authMethod: 'key' }),
      });
      setForm({
        name: '',
        host: '',
        port: 22,
        username: 'root',
        privateKeyPath: '',
        provider: 'other',
        notes: '',
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    if (!window.confirm('删除这台服务器？')) return;
    await api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await load();
  }

  async function test(id) {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/servers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
        body: '{}',
      });
      window.alert(r.output || '连接成功');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-header">
          <h2>云服务器</h2>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        {error && <p className="error">{error}</p>}
        <div className="form-grid">
          <label>
            名称
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
          </label>
          <label>
            主机
            <input value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
          </label>
          <label>
            端口
            <input
              type="number"
              value={form.port}
              onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) || 22 }))}
            />
          </label>
          <label>
            用户
            <input
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </label>
          <label className="full">
            私钥路径
            <input
              value={form.privateKeyPath}
              onChange={(e) => setForm((f) => ({ ...f, privateKeyPath: e.target.value }))}
              placeholder="~/.ssh/id_ed25519"
            />
          </label>
        </div>
        <button type="button" className="primary" disabled={busy} onClick={save}>
          添加服务器
        </button>
        <ul className="server-list">
          {servers.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <div className="mono subtle">
                  {s.username}@{s.host}:{s.port}
                </div>
              </div>
              <div className="row-actions">
                <button type="button" className="ghost" onClick={() => test(s.id)}>
                  测试
                </button>
                <button type="button" className="ghost" onClick={() => remove(s.id)}>
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('source');
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState({ scanRoots: [], llm: {} });
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showServers, setShowServers] = useState(false);
  const [meta, setMeta] = useState({ scannedAt: null, roots: [], node: null });

  const probeAll = useCallback(async (list) => {
    setProbing(true);
    try {
      const payload = await api('/api/projects/probe', {
        method: 'POST',
        body: JSON.stringify({
          projects: list.map((p) => ({ id: p.id, url: p.url, port: p.port })),
        }),
      });
      const map = Object.fromEntries((payload.results || []).map((r) => [r.id, r]));
      setProjects((prev) => prev.map((p) => ({ ...p, health: map[p.id] || p.health || null })));
    } catch {
      // ignore probe errors
    } finally {
      setProbing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectsPayload, settingsPayload, serversPayload] = await Promise.all([
        api('/api/projects'),
        api('/api/settings'),
        api('/api/servers').catch(() => ({ servers: [] })),
      ]);
      setProjects(projectsPayload.projects || []);
      setMeta({
        scannedAt: projectsPayload.scannedAt,
        roots: projectsPayload.roots || [],
        node: projectsPayload.node || null,
      });
      setSettings(settingsPayload);
      setServers(serversPayload.servers || []);
      probeAll(projectsPayload.projects || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [probeAll]);

  useEffect(() => {
    load();
  }, [load]);

  function onUpdated(updated) {
    setProjects((prev) =>
      prev.map((p) => (p.id === updated.id ? { ...p, ...updated, health: updated.health || p.health } : p)),
    );
  }

  const activeCount = projects.filter((p) => p.status !== 'trashed').length;
  const liveCount = projects.filter((p) => p.health?.live === true).length;
  const remoteCount = projects.filter((p) => p.deploy?.serverId || p.status === 'deployed').length;

  return (
    <div className="app simple">
      <header className="topbar">
        <div>
          <p className="brand">ProjectMsg</p>
          <h1>项目管理</h1>
          <p className="subtitle">
            {loading
              ? '正在扫描…'
              : `${activeCount} 个项目 · 运行中 ${liveCount} · 已配部署 ${remoteCount}`}
            {meta.node?.name ? ` · ${meta.node.name}` : ''}
            {meta.scannedAt ? ` · ${formatTime(meta.scannedAt)}` : ''}
          </p>
        </div>
        <div className="top-actions">
          <button type="button" className="ghost" onClick={() => setShowSettings(true)}>
            扫描设置
          </button>
          <button type="button" className="primary" disabled={loading} onClick={load}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>

      <nav className="view-tabs" aria-label="主视图">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={view === v.id ? 'active' : ''}
            onClick={() => setView(v.id)}
          >
            {v.label}
            {v.id === 'source' ? ` ${activeCount}` : null}
            {v.id === 'local' ? ` ${liveCount}` : null}
            {v.id === 'remote' ? ` ${(servers || []).length}` : null}
          </button>
        ))}
      </nav>

      {error && <p className="error banner">{error}</p>}

      {view === 'source' && (
        <SourceView
          projects={projects}
          query={query}
          onQuery={setQuery}
          onRefresh={load}
          loading={loading}
        />
      )}
      {view === 'local' && (
        <LocalServiceView projects={projects} onUpdated={onUpdated} probing={probing} />
      )}
      {view === 'remote' && (
        <RemoteView
          projects={projects}
          servers={servers}
          onOpenServers={() => setShowServers(true)}
        />
      )}

      {showSettings && (
        <SettingsDrawer
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(next) => {
            setSettings(next);
            load();
          }}
        />
      )}
      {showServers && (
        <ServersDrawer
          onClose={() => setShowServers(false)}
          onChanged={setServers}
        />
      )}
    </div>
  );
}
