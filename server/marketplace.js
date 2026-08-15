import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { initStore } from './store.js';
import { chatCompletion } from './llm.js';

const STORE_PRESETS = [
  { id: 'app_store', label: 'Apple App Store' },
  { id: 'google_play', label: 'Google Play' },
  { id: 'microsoft_store', label: 'Microsoft Store' },
  { id: 'chrome_web_store', label: 'Chrome Web Store' },
  { id: 'github_releases', label: 'GitHub Releases' },
  { id: 'testflight', label: 'TestFlight' },
  { id: 'other', label: '其他' },
];

const LISTING_STATUSES = ['draft', 'review', 'listed', 'rejected', 'delisted'];

const PRICING_MODELS = [
  { id: 'free', label: '免费' },
  { id: 'freemium', label: '免费+增值' },
  { id: 'paid', label: '一次性付费' },
  { id: 'subscription', label: '订阅制' },
  { id: 'usage_based', label: '按量计费' },
  { id: 'hybrid', label: '混合模式' },
  { id: 'other', label: '其他' },
];

const BILLING_PERIODS = [
  { id: 'none', label: '无' },
  { id: 'one_time', label: '一次性' },
  { id: 'monthly', label: '月付' },
  { id: 'yearly', label: '年付' },
  { id: 'usage', label: '按用量' },
];

const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'HKD'];

function numOrNull(v, fallback = null) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function emptyPlatformOps() {
  return {
    pricing: {
      model: 'free',
      price: null,
      currency: 'CNY',
      billingPeriod: 'none',
      tiersNote: '',
    },
    usage: {
      downloads: null,
      activeUsers: null,
      dau: null,
      mau: null,
      period: '',
      notes: '',
    },
    winRate: {
      conversionRate: null,
      trialToPaid: null,
      dealWinRate: null,
      leads: null,
      wins: null,
      notes: '',
    },
    promotion: {
      strategy: '',
      channels: '',
      budget: null,
      currency: 'CNY',
    },
    cost: {
      listingFee: null,
      adsSpend: null,
      opsSpend: null,
      otherSpend: null,
      currency: 'CNY',
      notes: '',
    },
    storeMetrics: null,
  };
}

function emptyRecord(projectPath = '') {
  return {
    path: projectPath,
    listings: [],
    feedback: [],
    platforms: [],
    iterationPlan: {
      content: '',
      generatedAt: null,
      model: null,
      basedOnFeedbackCount: 0,
    },
    commercialPlan: {
      content: '',
      generatedAt: null,
      model: null,
      sourceFile: null,
      basedOnMakemoney: false,
    },
    devProgressNotes: '',
    updatedAt: null,
  };
}

export async function getMarketplaceMap() {
  await initStore();
  const { rows } = await query('SELECT project_id, data FROM marketplace');
  const map = {};
  for (const row of rows) map[row.project_id] = row.data || {};
  return map;
}

export async function saveMarketplaceMap(map) {
  await initStore();
  for (const [projectId, data] of Object.entries(map || {})) {
    await query(
      `INSERT INTO marketplace (project_id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (project_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [projectId, JSON.stringify(data || {})],
    );
  }
  return map;
}

export async function getProjectMarketplace(projectId, projectPath = '') {
  await initStore();
  const { rows } = await query('SELECT data FROM marketplace WHERE project_id = $1', [projectId]);
  const record = rows[0]?.data || emptyRecord(projectPath);
  if (!rows[0]?.data && projectPath) {
    record.path = projectPath;
  }
  return {
    ...emptyRecord(projectPath),
    ...record,
    listings: Array.isArray(record.listings) ? record.listings : [],
    feedback: Array.isArray(record.feedback) ? record.feedback : [],
    platforms: Array.isArray(record.platforms)
      ? record.platforms.map((p) => normalizePlatform(p))
      : [],
    iterationPlan: {
      ...emptyRecord().iterationPlan,
      ...(record.iterationPlan || {}),
    },
    commercialPlan: {
      ...emptyRecord().commercialPlan,
      ...(record.commercialPlan || {}),
    },
  };
}

export async function saveProjectMarketplace(projectId, patch = {}, projectPath = '') {
  const prev = await getProjectMarketplace(projectId, projectPath);
  const next = {
    ...prev,
    path: projectPath || prev.path || '',
    listings: Array.isArray(patch.listings) ? patch.listings : prev.listings || [],
    feedback: Array.isArray(patch.feedback) ? patch.feedback : prev.feedback || [],
    platforms: Array.isArray(patch.platforms)
      ? patch.platforms.map((p) => normalizePlatform(p))
      : prev.platforms || [],
    iterationPlan:
      patch.iterationPlan && typeof patch.iterationPlan === 'object'
        ? { ...prev.iterationPlan, ...patch.iterationPlan }
        : prev.iterationPlan || emptyRecord().iterationPlan,
    commercialPlan:
      patch.commercialPlan && typeof patch.commercialPlan === 'object'
        ? { ...prev.commercialPlan, ...patch.commercialPlan }
        : prev.commercialPlan || emptyRecord().commercialPlan,
    devProgressNotes:
      patch.devProgressNotes != null ? String(patch.devProgressNotes) : prev.devProgressNotes || '',
    updatedAt: new Date().toISOString(),
  };
  await initStore();
  // Ensure parent project row exists for FK
  await query(
    `INSERT INTO projects (id, path, name, meta, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [projectId, projectPath || prev.path || projectId, (projectPath || prev.path || '').split(/[/\\]/).pop() || projectId],
  );
  await query(
    `INSERT INTO marketplace (project_id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (project_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [projectId, JSON.stringify(next)],
  );
  return next;
}

function mergeSection(base, input = {}) {
  return { ...base, ...(input && typeof input === 'object' ? input : {}) };
}

export function normalizePlatform(input = {}, prev = null) {
  const blank = emptyPlatformOps();
  const store = String(input.store || prev?.store || 'other');
  const preset = STORE_PRESETS.find((s) => s.id === store);
  const pricingIn = mergeSection(blank.pricing, { ...prev?.pricing, ...input.pricing });
  const usageIn = mergeSection(blank.usage, { ...prev?.usage, ...input.usage });
  const winIn = mergeSection(blank.winRate, { ...prev?.winRate, ...input.winRate });
  const promoIn = mergeSection(blank.promotion, { ...prev?.promotion, ...input.promotion });
  const costIn = mergeSection(blank.cost, { ...prev?.cost, ...input.cost });

  const pricingModel = PRICING_MODELS.some((m) => m.id === pricingIn.model)
    ? pricingIn.model
    : 'other';
  const billingPeriod = BILLING_PERIODS.some((b) => b.id === pricingIn.billingPeriod)
    ? pricingIn.billingPeriod
    : 'none';

  const cost = {
    listingFee: numOrNull(costIn.listingFee),
    adsSpend: numOrNull(costIn.adsSpend),
    opsSpend: numOrNull(costIn.opsSpend),
    otherSpend: numOrNull(costIn.otherSpend),
    currency: String(costIn.currency || promoIn.currency || 'CNY'),
    notes: String(costIn.notes || ''),
  };
  const costTotal =
    (cost.listingFee || 0) + (cost.adsSpend || 0) + (cost.opsSpend || 0) + (cost.otherSpend || 0);

  // Auto fill dealWinRate from wins/leads when provided
  let dealWinRate = numOrNull(winIn.dealWinRate);
  const leads = numOrNull(winIn.leads);
  const wins = numOrNull(winIn.wins);
  if ((dealWinRate == null || Number.isNaN(dealWinRate)) && leads != null && leads > 0 && wins != null) {
    dealWinRate = Math.round((wins / leads) * 1000) / 10;
  }

  return {
    id: prev?.id || input.id || randomUUID(),
    store,
    storeName: String(input.storeName || prev?.storeName || preset?.label || store),
    pricing: {
      model: pricingModel,
      price: numOrNull(pricingIn.price),
      currency: String(pricingIn.currency || 'CNY'),
      billingPeriod,
      tiersNote: String(pricingIn.tiersNote || ''),
    },
    usage: {
      downloads: numOrNull(usageIn.downloads),
      activeUsers: numOrNull(usageIn.activeUsers),
      dau: numOrNull(usageIn.dau),
      mau: numOrNull(usageIn.mau),
      period: String(usageIn.period || ''),
      notes: String(usageIn.notes || ''),
    },
    winRate: {
      conversionRate: numOrNull(winIn.conversionRate),
      trialToPaid: numOrNull(winIn.trialToPaid),
      dealWinRate,
      leads,
      wins,
      notes: String(winIn.notes || ''),
    },
    promotion: {
      strategy: String(promoIn.strategy || ''),
      channels: String(promoIn.channels || ''),
      budget: numOrNull(promoIn.budget),
      currency: String(promoIn.currency || cost.currency || 'CNY'),
    },
    cost: {
      ...cost,
      total: Math.round(costTotal * 100) / 100,
    },
    storeMetrics:
      input.storeMetrics && typeof input.storeMetrics === 'object'
        ? input.storeMetrics
        : prev?.storeMetrics || null,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeListing(input = {}, prev = null) {
  const store = String(input.store || prev?.store || 'other');
  const preset = STORE_PRESETS.find((s) => s.id === store);
  return {
    id: prev?.id || input.id || randomUUID(),
    store,
    storeName: String(input.storeName || prev?.storeName || preset?.label || store),
    url: String(input.url || prev?.url || ''),
    status: LISTING_STATUSES.includes(input.status)
      ? input.status
      : prev?.status || 'draft',
    listedAt: input.listedAt ?? prev?.listedAt ?? null,
    version: String(input.version ?? prev?.version ?? ''),
    notes: String(input.notes ?? prev?.notes ?? ''),
    lastStoreSyncAt: input.lastStoreSyncAt ?? prev?.lastStoreSyncAt ?? null,
    storeMetrics:
      input.storeMetrics && typeof input.storeMetrics === 'object'
        ? input.storeMetrics
        : prev?.storeMetrics || null,
  };
}

export function normalizeFeedback(input = {}, prev = null) {
  return {
    id: prev?.id || input.id || randomUUID(),
    source: String(input.source || prev?.source || 'manual'),
    author: String(input.author ?? prev?.author ?? ''),
    rating:
      input.rating === '' || input.rating == null
        ? prev?.rating ?? null
        : Number(input.rating),
    content: String(input.content ?? prev?.content ?? ''),
    url: String(input.url ?? prev?.url ?? ''),
    externalId: String(input.externalId ?? prev?.externalId ?? ''),
    createdAt: input.createdAt || prev?.createdAt || new Date().toISOString(),
    sentiment: input.sentiment || prev?.sentiment || null,
  };
}

function parseGithubRemote(remoteUrl) {
  if (!remoteUrl) return null;
  // https://github.com/owner/repo.git or git@github.com:owner/repo.git
  const https = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!https) return null;
  return { owner: https[1], repo: https[2] };
}

export async function fetchGithubFeedback(remoteUrl, { limit = 30 } = {}) {
  const parsed = parseGithubRemote(remoteUrl);
  if (!parsed) {
    const err = new Error('未识别到 GitHub remote，无法拉取 Issues');
    err.status = 400;
    throw err;
  }

  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues?state=all&per_page=${Math.min(100, limit)}&sort=updated`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'project-msg-marketplace',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `GitHub API ${res.status}`;
    if (res.status === 404) {
      msg =
        'GitHub 仓库不存在或为私有仓库（未认证无法读取 Issues）。可手动添加反馈，或稍后接入 GitHub Token。';
    } else {
      msg = `${msg}: ${text.slice(0, 200)}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const issues = await res.json();
  // exclude PRs
  return (Array.isArray(issues) ? issues : [])
    .filter((i) => !i.pull_request)
    .map((i) =>
      normalizeFeedback({
        source: 'github',
        author: i.user?.login || '',
        content: `#${i.number} ${i.title}\n${(i.body || '').slice(0, 2000)}`.trim(),
        url: i.html_url,
        externalId: String(i.number),
        createdAt: i.created_at || i.updated_at,
        sentiment: i.state === 'closed' ? 'neutral' : null,
      }),
    );
}

export async function importGithubFeedback(projectId, remoteUrl, projectPath = '') {
  const incoming = await fetchGithubFeedback(remoteUrl);
  const record = await getProjectMarketplace(projectId, projectPath);
  const byExternal = new Map(
    (record.feedback || [])
      .filter((f) => f.source === 'github' && f.externalId)
      .map((f) => [f.externalId, f]),
  );

  let added = 0;
  let updated = 0;
  const merged = [...(record.feedback || [])];
  for (const item of incoming) {
    const existing = byExternal.get(item.externalId);
    if (existing) {
      const idx = merged.findIndex((f) => f.id === existing.id);
      if (idx >= 0) {
        merged[idx] = normalizeFeedback(item, existing);
        updated += 1;
      }
    } else {
      merged.unshift(item);
      added += 1;
    }
  }

  const saved = await saveProjectMarketplace(
    projectId,
    { feedback: merged },
    projectPath,
  );
  return { added, updated, total: saved.feedback.length, record: saved };
}

export async function generateIterationPlan({
  projectName,
  status,
  progress,
  listings,
  feedback,
  platforms,
  devProgressNotes,
  aiSummary,
}) {
  const system =
    '你是产品迭代与增长顾问。根据应用商店上架、用户反馈、各平台定价/用量/赢率/推广与成本，用简洁中文输出「后续迭代计划」。' +
    '结构固定：1) 反馈主题聚类 2) 各平台经营要点（定价/转化/成本）3) 优先级 P0/P1/P2 事项 4) 本迭代建议范围 5) 风险与依赖。不要编造数据中没有的内容。';

  const user = [
    `项目：${projectName}`,
    `开发状态：${status || '—'}`,
    `进展：${progress ?? '—'}%`,
    devProgressNotes ? `开发进展备注：${devProgressNotes}` : '',
    aiSummary ? `已有 AI 项目说明摘要：\n${String(aiSummary).slice(0, 1500)}` : '',
    '',
    '上架情况：',
    JSON.stringify(listings || [], null, 2),
    '',
    '各平台运营（定价/用量/赢率/推广/成本）：',
    JSON.stringify(
      (platforms || []).slice(0, 12).map((p) => ({
        store: p.storeName || p.store,
        pricing: p.pricing,
        usage: p.usage,
        winRate: p.winRate,
        promotion: {
          strategy: String(p.promotion?.strategy || '').slice(0, 400),
          channels: p.promotion?.channels,
          budget: p.promotion?.budget,
        },
        cost: p.cost,
      })),
      null,
      2,
    ),
    '',
    '用户反馈（含 GitHub）：',
    JSON.stringify(
      (feedback || []).slice(0, 40).map((f) => ({
        source: f.source,
        author: f.author,
        rating: f.rating,
        content: String(f.content || '').slice(0, 500),
        createdAt: f.createdAt,
      })),
      null,
      2,
    ),
  ]
    .filter(Boolean)
    .join('\n');

  return chatCompletion({ system, user, temperature: 0.35 });
}

export async function generateCommercialPlan({
  projectName,
  status,
  makemoney,
  readme,
  platforms,
  listings,
  aiSummary,
}) {
  const hasMakemoney = Boolean(makemoney?.content?.trim());
  const system = hasMakemoney
    ? '你是商业化顾问。优先依据项目中的 makemoney.md（商业化方案文档）做分析，用简洁中文输出。' +
      '结构固定：1) 方案摘要 2) 目标用户与价值主张 3) 变现模式与定价建议 4) 获客/推广路径 5) 关键里程碑 6) 风险与缺口（相对文档原文，勿编造）。' +
      '若文档信息不足，明确指出缺什么，不要假装文档写过。'
    : '你是商业化顾问。项目缺少 makemoney.md，只能依据有限的上架/平台运营与 README 做「草案级」商业化建议。' +
      '开头必须明确写：未找到 makemoney.md，以下为草案。结构：1) 现状判断 2) 建议的变现模式 3) 定价草案 4) 获客方向 5) 建议补写进 makemoney.md 的内容清单。不要编造不存在的数据。';

  const user = [
    `项目：${projectName}`,
    `开发状态：${status || '—'}`,
    aiSummary ? `已有 AI 项目说明摘要：\n${String(aiSummary).slice(0, 1200)}` : '',
    '',
    hasMakemoney
      ? `【优先来源】makemoney.md（${makemoney.name}）：\n${String(makemoney.content).slice(0, 28000)}`
      : '【优先来源】未找到 makemoney.md（已尝试项目根目录与 docs/）。',
    '',
    '已登记上架：',
    JSON.stringify(listings || [], null, 2),
    '',
    '已登记平台运营（定价/用量/赢率/推广/成本）：',
    JSON.stringify(
      (platforms || []).slice(0, 12).map((p) => ({
        store: p.storeName || p.store,
        pricing: p.pricing,
        usage: p.usage,
        winRate: p.winRate,
        promotion: {
          strategy: String(p.promotion?.strategy || '').slice(0, 300),
          channels: p.promotion?.channels,
          budget: p.promotion?.budget,
        },
        cost: p.cost,
      })),
      null,
      2,
    ),
    !hasMakemoney && readme?.content
      ? `\nREADME 摘录（辅助）：\n${String(readme.content).slice(0, 6000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await chatCompletion({ system, user, temperature: 0.35 });
  return {
    ...result,
    basedOnMakemoney: hasMakemoney,
    sourceFile: hasMakemoney ? makemoney.name : null,
  };
}

export function marketplaceSummary(record) {
  const listings = record?.listings || [];
  const feedback = record?.feedback || [];
  const platforms = record?.platforms || [];
  const listed = listings.filter((l) => l.status === 'listed').length;
  const totalCost = platforms.reduce((sum, p) => sum + (Number(p.cost?.total) || 0), 0);
  const withWin = platforms
    .map((p) => numOrNull(p.winRate?.dealWinRate ?? p.winRate?.conversionRate))
    .filter((n) => n != null);
  const avgWinRate =
    withWin.length > 0
      ? Math.round((withWin.reduce((a, b) => a + b, 0) / withWin.length) * 10) / 10
      : null;
  return {
    listingCount: listings.length,
    listedCount: listed,
    feedbackCount: feedback.length,
    githubFeedbackCount: feedback.filter((f) => f.source === 'github').length,
    platformCount: platforms.length,
    totalCost,
    avgWinRate,
    hasIterationPlan: Boolean(record?.iterationPlan?.content),
    hasCommercialPlan: Boolean(record?.commercialPlan?.content),
    commercialBasedOnMakemoney: Boolean(record?.commercialPlan?.basedOnMakemoney),
    stores: [
      ...new Set([
        ...listings.map((l) => l.storeName || l.store),
        ...platforms.map((p) => p.storeName || p.store),
      ]),
    ],
  };
}

export async function attachMarketplaceSummaries(projects) {
  const map = await getMarketplaceMap();
  return projects.map((p) => {
    const record = map[p.id];
    return {
      ...p,
      marketplace: record ? marketplaceSummary(record) : marketplaceSummary(emptyRecord()),
    };
  });
}

export async function syncStoreData(projectId, projectPath, options = {}) {
  const { parseStoreUrl, fetchStoreMetrics, applyMetricsToPlatform, metricsToFeedbackItems } =
    await import('./storeSync.js');

  const record = await getProjectMarketplace(projectId, projectPath);
  const listings = [...(record.listings || [])];
  const platforms = [...(record.platforms || [])];
  const feedback = [...(record.feedback || [])];

  let listing = null;
  let platform = null;
  if (options.listingId) {
    listing = listings.find((l) => l.id === options.listingId) || null;
  }
  if (options.platformId) {
    platform = platforms.find((p) => p.id === options.platformId) || null;
  }

  const url =
    options.url ||
    listing?.url ||
    platform?.storeMetrics?.url ||
    '';
  const parsed =
    parseStoreUrl(url) ||
    (options.store && options.appId
      ? { store: options.store, appId: options.appId, country: options.country || 'us', url }
      : null) ||
    (listing?.store && options.appId
      ? { store: listing.store, appId: options.appId, country: options.country || 'us', url }
      : null);

  if (!parsed) {
    const err = new Error(
      '请提供可识别的商店链接（App Store / Google Play / Chrome Web Store），或 appId + store',
    );
    err.status = 400;
    throw err;
  }

  const metrics = await fetchStoreMetrics(parsed);

  // Update or create platform ops row for this store
  let platformIdx = platforms.findIndex(
    (p) => p.id === options.platformId || (p.store === metrics.store && !options.platformId),
  );
  if (platformIdx < 0) {
    platforms.push(
      normalizePlatform(
        applyMetricsToPlatform(
          {
            store: metrics.store,
            storeName: metrics.name || metrics.store,
          },
          metrics,
        ),
      ),
    );
    platformIdx = platforms.length - 1;
  } else {
    platforms[platformIdx] = normalizePlatform(
      applyMetricsToPlatform(platforms[platformIdx], metrics),
      platforms[platformIdx],
    );
  }

  // Update listing version / sync stamp if matched
  let listingIdx = listings.findIndex((l) => l.id === options.listingId);
  if (listingIdx < 0) {
    listingIdx = listings.findIndex((l) => l.store === metrics.store && (!url || l.url === url || !l.url));
  }
  if (listingIdx >= 0) {
    listings[listingIdx] = normalizeListing(
      {
        ...listings[listingIdx],
        url: listings[listingIdx].url || metrics.url,
        version: metrics.version || listings[listingIdx].version,
        lastStoreSyncAt: metrics.syncedAt,
        storeMetrics: {
          rating: metrics.rating,
          ratingCount: metrics.ratingCount,
          downloads: metrics.downloads,
          downloadsText: metrics.downloadsText,
          source: metrics.source,
          syncedAt: metrics.syncedAt,
          note: metrics.downloadsNote,
        },
      },
      listings[listingIdx],
    );
  }

  // Merge reviews into feedback (dedupe by source+externalId)
  const incoming = metricsToFeedbackItems(metrics).map((f) => normalizeFeedback(f));
  let added = 0;
  let updated = 0;
  for (const item of incoming) {
    if (!item.externalId) {
      feedback.unshift(item);
      added += 1;
      continue;
    }
    const idx = feedback.findIndex(
      (f) => f.source === item.source && f.externalId && f.externalId === item.externalId,
    );
    if (idx >= 0) {
      feedback[idx] = normalizeFeedback(item, feedback[idx]);
      updated += 1;
    } else {
      feedback.unshift(item);
      added += 1;
    }
  }

  const saved = await saveProjectMarketplace(
    projectId,
    { listings, platforms, feedback },
    projectPath,
  );

  return {
    metrics,
    addedFeedback: added,
    updatedFeedback: updated,
    platform: platforms[platformIdx],
    record: saved,
  };
}

export {
  STORE_PRESETS,
  LISTING_STATUSES,
  PRICING_MODELS,
  BILLING_PERIODS,
  CURRENCIES,
  emptyRecord,
  emptyPlatformOps,
};
