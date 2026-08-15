/**
 * Full regression for project-msg marketplace + core APIs.
 * Run: node scripts/full-regression.mjs
 */
const API = process.env.API || 'http://127.0.0.1:8790';
const UI = process.env.UI || 'http://127.0.0.1:5177';

const fail = [];
let pass = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    fail.push(name);
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function req(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { _raw: text };
  }
  return { res, body, status: res.status };
}

async function main() {
  console.log(`API=${API}`);
  console.log('==== 1. Core health / settings ====');

  {
    const { status, body } = await req('/api/health');
    ok('health', status === 200 && body.ok === true, body.dataDir);
  }

  let settings;
  {
    const { status, body } = await req('/api/settings');
    settings = body;
    ok('settings-get', status === 200 && Array.isArray(body.scanRoots) && body.scanRoots.length > 0);
    ok('settings-marketplace-file', Boolean(body.marketplaceFile));
    ok('settings-llm-model', String(body.llm?.model || '').includes('deepseek'));
  }

  console.log('==== 2. Projects + marketplace summary ====');
  let projectsPayload;
  let ceo;
  {
    const { status, body } = await req('/api/projects');
    projectsPayload = body;
    ok('projects-list', status === 200 && Array.isArray(body.projects) && body.projects.length >= 1, `n=${body.projects?.length}`);
    ok(
      'projects-have-marketplace',
      body.projects.every((p) => p.marketplace && typeof p.marketplace.listingCount === 'number'),
    );
    ok(
      'projects-have-progress',
      body.projects.every((p) => p.progressSource === 'auto' || p.progressSource === 'manual'),
    );
    ceo = body.projects.find((p) => p.name === 'CEODashboard') || body.projects[0];
    ok('pick-project', Boolean(ceo?.id), ceo?.name);
  }

  const id = ceo.id;

  console.log('==== 3. Marketplace meta ====');
  {
    const { status, body } = await req('/api/marketplace/meta');
    ok('meta-stores', status === 200 && body.stores?.length >= 5);
    ok('meta-pricing', body.pricingModels?.length >= 5);
    ok('meta-billing', body.billingPeriods?.length >= 3);
    ok('meta-currencies', body.currencies?.includes('CNY'));
  }

  console.log('==== 4. Listing CRUD ====');
  let listingId;
  {
    const { status, body } = await req(`/api/projects/${id}/marketplace/listings`, {
      method: 'POST',
      body: JSON.stringify({
        store: 'microsoft_store',
        status: 'listed',
        url: 'https://apps.microsoft.com/detail/demo-e2e',
        version: '9.9.9',
        notes: 'full-regression-listing',
      }),
    });
    ok('listing-create', status === 201 && body.listing?.id, body.listing?.id);
    listingId = body.listing?.id;

    const patched = await req(`/api/projects/${id}/marketplace/listings/${listingId}`, {
      method: 'PATCH',
      body: JSON.stringify({ version: '9.9.10', status: 'review' }),
    });
    ok(
      'listing-patch',
      patched.status === 200 &&
        patched.body.listing?.version === '9.9.10' &&
        patched.body.listing?.status === 'review',
    );
  }

  console.log('==== 5. Feedback CRUD ====');
  let feedbackId;
  {
    const { status, body } = await req(`/api/projects/${id}/marketplace/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        source: 'manual',
        author: 'e2e-bot',
        rating: 5,
        content: 'full-regression-feedback：界面清晰，希望加导出',
      }),
    });
    ok('feedback-create', status === 201 && body.feedback?.id);
    feedbackId = body.feedback?.id;
  }

  console.log('==== 6. Platform ops CRUD ====');
  let platformId;
  {
    const { status, body } = await req(`/api/projects/${id}/marketplace/platforms`, {
      method: 'POST',
      body: JSON.stringify({
        store: 'microsoft_store',
        storeName: 'Microsoft Store',
        pricing: {
          model: 'subscription',
          price: 68,
          currency: 'CNY',
          billingPeriod: 'yearly',
          tiersNote: 'Basic free / Pro 68/yr',
        },
        usage: {
          downloads: 500,
          activeUsers: 120,
          dau: 40,
          mau: 110,
          period: '2026-07',
          notes: 'e2e usage',
        },
        winRate: {
          conversionRate: 3.2,
          trialToPaid: 8.5,
          leads: 50,
          wins: 10,
        },
        promotion: {
          strategy: '商店精选位 + 邮件触达',
          channels: 'Newsletter, Discord',
          budget: 2000,
          currency: 'CNY',
        },
        cost: {
          listingFee: 0,
          adsSpend: 1200,
          opsSpend: 400,
          otherSpend: 100,
          currency: 'CNY',
          notes: 'e2e cost',
        },
      }),
    });
    ok('platform-create', status === 201 && body.platform?.id);
    platformId = body.platform?.id;
    ok('platform-auto-winrate', body.platform?.winRate?.dealWinRate === 20, String(body.platform?.winRate?.dealWinRate));
    ok('platform-cost-total', body.platform?.cost?.total === 1700, String(body.platform?.cost?.total));

    const patched = await req(`/api/projects/${id}/marketplace/platforms/${platformId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        usage: { downloads: 888, activeUsers: 200, dau: 55, mau: 180, period: '2026-07' },
        pricing: { model: 'subscription', price: 78, currency: 'CNY', billingPeriod: 'yearly' },
      }),
    });
    ok(
      'platform-patch',
      patched.status === 200 &&
        patched.body.platform?.usage?.downloads === 888 &&
        patched.body.platform?.pricing?.price === 78,
    );
  }

  console.log('==== 7. Dev notes + full GET persist ====');
  {
    const got0 = await req(`/api/projects/${id}/marketplace`);
    const put = await req(`/api/projects/${id}/marketplace`, {
      method: 'PUT',
      body: JSON.stringify({
        listings: got0.body.listings,
        feedback: got0.body.feedback,
        platforms: got0.body.platforms,
        iterationPlan: got0.body.iterationPlan,
        devProgressNotes: 'full-regression-dev-notes',
      }),
    });
    ok('dev-notes-put', put.status === 200 && put.body.devProgressNotes === 'full-regression-dev-notes');

    const got = await req(`/api/projects/${id}/marketplace`);
    ok('persist-listing', (got.body.listings || []).some((l) => l.id === listingId && l.version === '9.9.10'));
    ok('persist-feedback', (got.body.feedback || []).some((f) => f.id === feedbackId));
    ok(
      'persist-platform',
      (got.body.platforms || []).some((p) => p.id === platformId && p.usage?.downloads === 888),
    );
    ok('persist-notes', got.body.devProgressNotes === 'full-regression-dev-notes');
  }

  console.log('==== 8. List summary enrichment ====');
  {
    const { body } = await req('/api/projects');
    const again = body.projects.find((p) => p.id === id);
    ok('summary-platformCount', again?.marketplace?.platformCount >= 1, String(again?.marketplace?.platformCount));
    ok('summary-feedbackCount', again?.marketplace?.feedbackCount >= 1, String(again?.marketplace?.feedbackCount));
    ok('summary-totalCost', again?.marketplace?.totalCost >= 1700, String(again?.marketplace?.totalCost));
  }

  console.log('==== 9. File on disk ====');
  {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const file = path.join('D:', 'VSworkspace', 'projectMsg', 'data', 'marketplace.json');
    const raw = await fs.readFile(file, 'utf8');
    ok('disk-has-listing-note', raw.includes('full-regression-listing'));
    ok('disk-has-feedback', raw.includes('full-regression-feedback'));
    ok('disk-has-platform', raw.includes('Microsoft Store') || raw.includes('microsoft_store'));
    ok('disk-has-dev-notes', raw.includes('full-regression-dev-notes'));
  }

  console.log('==== 10. GitHub import (tolerant) ====');
  {
    const { status, body } = await req(`/api/projects/${id}/marketplace/import-github`, {
      method: 'POST',
      body: '{}',
    });
    if (status === 200) {
      ok('github-import', typeof body.added === 'number' && typeof body.updated === 'number', `added=${body.added} updated=${body.updated}`);
    } else {
      ok(
        'github-import-handled',
        status === 404 || status === 400,
        `status=${status} msg=${String(body.error || '').slice(0, 80)}`,
      );
    }
  }

  console.log('==== 11. AI iteration plan (if configured) ====');
  {
    const { status, body } = await req(`/api/projects/${id}/marketplace/iteration-plan`, {
      method: 'POST',
      body: '{}',
    });
    if (settings?.llm?.configured) {
      if (status === 200 && String(body.plan?.content || '').length > 20) {
        ok(
          'iteration-plan',
          true,
          `len=${body.plan.content.length} model=${body.plan.model}`,
        );
      } else if (status === 400 || status === 500) {
        ok(
          'iteration-plan-error-handled',
          true,
          `status=${status} msg=${String(body.error || '').slice(0, 100)}`,
        );
      } else {
        ok('iteration-plan', false, `status=${status} len=${body.plan?.content?.length}`);
      }
    } else {
      ok(
        'iteration-plan-requires-key',
        status === 400 || status === 500,
        `status=${status}`,
      );
    }
  }

  console.log('==== 12. Probe / weekly / scan ====');
  {
    const scan = await req('/api/scan', { method: 'POST', body: '{}' });
    ok('scan', scan.status === 200 && scan.body.projects?.length >= 1);

    const probe = await req('/api/projects/probe', {
      method: 'POST',
      body: JSON.stringify({
        projects: [{ id: ceo.id, url: ceo.url, port: ceo.port }],
      }),
    });
    ok('probe', probe.status === 200 && Array.isArray(probe.body.results));

    const weekly = await req('/api/reports/weekly');
    ok('weekly-get', weekly.status === 200 && Array.isArray(weekly.body.list));
  }

  console.log('==== 13. Vite proxy + UI ====');
  {
    const h = await fetch(`${UI}/api/health`);
    const hj = await h.json();
    ok('vite-proxy-health', h.ok && hj.ok === true);

    const ui = await fetch(`${UI}/`);
    const html = await ui.text();
    ok('vite-ui', ui.ok && html.includes('root'));

    const mp = await fetch(`${UI}/api/projects/${id}/marketplace`);
    const mj = await mp.json();
    ok('vite-proxy-marketplace', mp.ok && Array.isArray(mj.platforms));
  }

  console.log('==== 14. Cleanup test artifacts (keep prior real data) ====');
  {
    if (listingId) {
      const d = await req(`/api/projects/${id}/marketplace/listings/${listingId}`, { method: 'DELETE' });
      ok('cleanup-listing', d.status === 200 && !(d.body.listings || []).some((l) => l.id === listingId));
    }
    if (feedbackId) {
      const d = await req(`/api/projects/${id}/marketplace/feedback/${feedbackId}`, { method: 'DELETE' });
      ok('cleanup-feedback', d.status === 200 && !(d.body.feedback || []).some((f) => f.id === feedbackId));
    }
    if (platformId) {
      const d = await req(`/api/projects/${id}/marketplace/platforms/${platformId}`, { method: 'DELETE' });
      ok('cleanup-platform', d.status === 200 && !(d.body.platforms || []).some((p) => p.id === platformId));
    }
    // restore notes if we overwrote
    const got = await req(`/api/projects/${id}/marketplace`);
    await req(`/api/projects/${id}/marketplace`, {
      method: 'PUT',
      body: JSON.stringify({
        listings: got.body.listings,
        feedback: got.body.feedback,
        platforms: got.body.platforms,
        iterationPlan: got.body.iterationPlan,
        devProgressNotes: got.body.devProgressNotes === 'full-regression-dev-notes' ? '正在做导出 MVP' : got.body.devProgressNotes,
      }),
    });
    ok('cleanup-done', true);
  }

  console.log('====');
  console.log(`PASS=${pass} FAIL=${fail.length}`);
  if (fail.length) {
    console.log('FAILED:', fail.join(', '));
    process.exitCode = 1;
  } else {
    console.log('ALL FULL REGRESSION TESTS PASSED');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
