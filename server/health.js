import http from 'node:http';
import https from 'node:https';

function probeUrl(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      finish({ ok: false, status: null, ms: 0, error: 'invalid url' });
      return;
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'project-msg-probe/0.1', Accept: '*/*' },
      },
      (res) => {
        res.resume();
        finish({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          live: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          ms: Date.now() - started,
          error: null,
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, live: false, status: null, ms: Date.now() - started, error: 'timeout' });
    });
    req.on('error', (err) => {
      finish({
        ok: false,
        live: false,
        status: null,
        ms: Date.now() - started,
        error: err.code || err.message,
      });
    });
    req.end();
  });
}

export async function probeProject(project) {
  const targets = [];
  if (project.url) targets.push(project.url);
  else if (project.port) targets.push(`http://127.0.0.1:${project.port}`);

  if (targets.length === 0) {
    return {
      id: project.id,
      probed: false,
      live: null,
      status: null,
      ms: null,
      url: null,
      error: 'no url/port',
    };
  }

  const url = targets[0];
  const result = await probeUrl(url);
  return {
    id: project.id,
    probed: true,
    live: Boolean(result.live),
    status: result.status,
    ms: result.ms,
    url,
    error: result.error,
  };
}

export async function probeProjects(projects) {
  const list = Array.isArray(projects) ? projects : [];
  const results = await Promise.all(list.map((p) => probeProject(p)));
  return {
    probedAt: new Date().toISOString(),
    results,
  };
}
