/**
 * Public store metrics sync (no publisher credentials).
 * - App Store: iTunes Lookup + customer reviews RSS
 * - Google Play: public details page embedded data
 * Exact lifetime downloads are NOT published by Apple; Play only exposes ranges (e.g. 10M+).
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseInstallRange(text) {
  if (!text) return { downloads: null, downloadsText: '' };
  const raw = String(text).trim();
  const m = raw.match(/([\d.,]+)\s*([KMB])?\+?/i);
  if (!m) return { downloads: null, downloadsText: raw };
  let n = Number(String(m[1]).replace(/,/g, ''));
  if (!Number.isFinite(n)) return { downloads: null, downloadsText: raw };
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') n *= 1_000;
  if (unit === 'M') n *= 1_000_000;
  if (unit === 'B') n *= 1_000_000_000;
  return { downloads: Math.round(n), downloadsText: raw.includes('+') ? `${raw}` : `${raw}+` };
}

export function parseStoreUrl(input = '') {
  const url = String(input || '').trim();
  if (!url) return null;

  // App Store: apps.apple.com/.../id123  or itunes.apple.com/.../id123
  const apple = url.match(
    /(?:apps|itunes)\.apple\.com\/(?:([a-z]{2})\/)?(?:app\/)?(?:[^/]+\/)?id(\d+)/i,
  );
  if (apple) {
    return {
      store: 'app_store',
      appId: apple[2],
      country: (apple[1] || 'us').toLowerCase(),
      url,
    };
  }

  // Google Play
  const play = url.match(/play\.google\.com\/store\/apps\/details\?[^#]*id=([a-zA-Z0-9._]+)/i);
  if (play) {
    const country = (url.match(/[?&]gl=([a-z]{2})/i) || [])[1] || 'us';
    return {
      store: 'google_play',
      appId: play[1],
      country: country.toLowerCase(),
      url,
    };
  }

  // Chrome Web Store
  const chrome = url.match(/chromewebstore\.google\.com\/detail\/(?:[^/]+\/)?([a-z]{32})/i);
  if (chrome) {
    return {
      store: 'chrome_web_store',
      appId: chrome[1],
      country: 'us',
      url,
    };
  }

  // bare numeric => App Store id
  if (/^\d{6,}$/.test(url)) {
    return { store: 'app_store', appId: url, country: 'us', url: `https://apps.apple.com/app/id${url}` };
  }

  // bare package name => Play
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(url)) {
    return {
      store: 'google_play',
      appId: url,
      country: 'us',
      url: `https://play.google.com/store/apps/details?id=${url}`,
    };
  }

  return null;
}

async function fetchText(url, { accept = '*/*', retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: accept,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} fetching ${url}`);
        err.status = res.status;
        throw err;
      }
      return res.text();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
    }
  }
  const cause = lastErr?.cause?.message || lastErr?.cause?.code || lastErr?.message || 'unknown';
  const err = new Error(`拉取商店页面失败：${cause}`);
  err.status = 502;
  err.cause = lastErr;
  throw err;
}

async function fetchJson(url) {
  const text = await fetchText(url, { accept: 'application/json' });
  return JSON.parse(text);
}

export async function fetchAppStoreMetrics({ appId, country = 'us' } = {}) {
  const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`;
  const data = await fetchJson(lookupUrl);
  const app = Array.isArray(data.results) ? data.results[0] : null;
  if (!app) {
    const err = new Error(`App Store 未找到应用 id=${appId}（country=${country}）`);
    err.status = 404;
    throw err;
  }

  let reviews = [];
  try {
    const rssUrl = `https://itunes.apple.com/${country}/rss/customerreviews/id=${appId}/sortBy=mostRecent/json`;
    const rss = await fetchJson(rssUrl);
    const entries = rss?.feed?.entry;
    const list = Array.isArray(entries) ? entries : [];
    // first entry is often the app itself
    reviews = list
      .filter((e) => e?.['im:rating'])
      .slice(0, 25)
      .map((e) => ({
        externalId: String(e.id?.label || e.id || ''),
        author: e.author?.name?.label || e.author?.name || '',
        rating: Number(e['im:rating']?.label || e['im:rating'] || 0) || null,
        title: e.title?.label || e.title || '',
        content: e.content?.label || e.content || '',
        createdAt: e.updated?.label || e.updated || null,
        url: e.link?.attributes?.href || e.link?.href || '',
      }));
  } catch {
    // RSS often empty/blocked — ignore
  }

  return {
    store: 'app_store',
    appId: String(appId),
    country,
    name: app.trackName || app.trackCensoredName || '',
    version: app.version || '',
    rating: num(app.averageUserRating),
    ratingCount: num(app.userRatingCount),
    ratingCurrent: num(app.averageUserRatingForCurrentVersion),
    ratingCountCurrent: num(app.userRatingCountForCurrentVersion),
    price: num(app.price),
    currency: app.currency || 'USD',
    downloads: null,
    downloadsText: '',
    downloadsNote: 'App Store 不公开下载量；仅同步评分与评论',
    url: app.trackViewUrl || `https://apps.apple.com/${country}/app/id${appId}`,
    reviews,
    source: 'itunes_lookup',
    syncedAt: new Date().toISOString(),
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchGooglePlayMetrics({ appId, country = 'us' } = {}) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&hl=en&gl=${encodeURIComponent(country)}`;
  const html = await fetchText(url, { accept: 'text/html' });

  if (/We're sorry|not found|item not found/i.test(html) && !/itemprop="name"|og:title/i.test(html)) {
    const err = new Error(`Google Play 未找到应用 ${appId}`);
    err.status = 404;
    throw err;
  }

  const name =
    (html.match(/property="og:title"\s+content="([^"]+)"/i)?.[1] || '')
      .replace(/\s*-\s*Apps on Google Play.*/i, '')
      .trim() ||
    (html.match(/<title>([^|<]+)/i)?.[1] || '').replace(/ - Apps on Google Play.*/i, '').trim() ||
    appId;

  let rating = null;
  const ratedAria =
    html.match(/aria-label="Rated\s+([\d.]+)\s+stars?\s+out of five stars"/i) ||
    html.match(/itemprop="starRating"[\s\S]{0,200}?aria-label="Rated\s+([\d.]+)/i);
  if (ratedAria) rating = num(ratedAria[1]);
  if (rating == null) {
    const ratingMatch =
      html.match(/itemprop="ratingValue"\s+content="([\d.]+)"/i) ||
      html.match(/class="TT9eCd"[^>]*>\s*([\d.]+)/i);
    if (ratingMatch) rating = num(ratingMatch[1]);
  }

  let ratingCount = null;
  const reviewsLabel = html.match(/class="g1rdde">\s*([\d.,]+\s*[KMB]?)\s*reviews?\s*</i);
  if (reviewsLabel) {
    ratingCount = parseInstallRange(reviewsLabel[1]).downloads;
  }
  if (ratingCount == null) {
    const countMatch =
      html.match(/itemprop="ratingCount"\s+content="(\d+)"/i) ||
      html.match(/([\d,]+)\s+reviews?/i);
    if (countMatch) ratingCount = num(String(countMatch[1]).replace(/,/g, ''));
  }

  let downloadsText = '';
  const installBlock =
    html.match(/class="ClM7O">\s*([\d.,]+\s*[KMB]?\+)\s*<\/div>\s*<div class="g1rdde">\s*Downloads/i) ||
    html.match(/>\s*([\d.,]+\s*[KMB]?\+)\s*<[^>]*>\s*Downloads/i) ||
    html.match(/Downloads<\/div><div[^>]*>\s*([\d.,]+\s*[KMB]?\+)/i);
  if (installBlock) downloadsText = installBlock[1].replace(/\s+/g, '');

  const { downloads } = parseInstallRange(downloadsText);

  const version =
    html.match(/Current Version.*?>([\d.]+)</is)?.[1] ||
    html.match(/\[["'](\d+\.\d+(?:\.\d+)?)["']\]/)?.[1] ||
    '';

  const reviews = [];
  const reviewBlocks = [
    ...html.matchAll(
      /itemprop="review".*?itemprop="author".*?content="([^"]*)".*?itemprop="ratingValue".*?content="([\d.]+)".*?itemprop="description".*?>([^<]+)/gis,
    ),
  ];
  for (const m of reviewBlocks.slice(0, 15)) {
    reviews.push({
      externalId: `play-${appId}-${reviews.length}-${String(m[3]).slice(0, 24)}`,
      author: m[1] || '',
      rating: num(m[2]),
      title: '',
      content: (m[3] || '').trim(),
      createdAt: null,
      url: '',
    });
  }

  return {
    store: 'google_play',
    appId,
    country,
    name,
    version: version || '',
    rating,
    ratingCount,
    ratingCurrent: rating,
    ratingCountCurrent: ratingCount,
    price: null,
    currency: 'USD',
    downloads,
    downloadsText: downloadsText || '',
    downloadsNote: downloadsText
      ? `Google Play 公开下载量为区间下限估算（页面显示 ${downloadsText}）`
      : '未能从页面解析下载量区间（页面结构可能变化）',
    url,
    reviews,
    source: 'google_play_public',
    syncedAt: new Date().toISOString(),
  };
}

export async function fetchChromeWebStoreMetrics({ appId } = {}) {
  const url = `https://chromewebstore.google.com/detail/${encodeURIComponent(appId)}`;
  const html = await fetchText(url, { accept: 'text/html' });
  const name =
    (html.match(/<title>([^|<]+)/i)?.[1] || '').replace(/\s*-\s*Chrome Web Store.*/i, '').trim() ||
    appId;
  let rating = null;
  const rm = html.match(/([\d.]+)\s*star/i) || html.match(/ratingValue"\s*:\s*"?([\d.]+)"?/i);
  if (rm) rating = num(rm[1]);
  let ratingCount = null;
  const cm = html.match(/([\d,]+)\s*ratings?/i);
  if (cm) ratingCount = num(String(cm[1]).replace(/,/g, ''));
  let downloads = null;
  let downloadsText = '';
  const um = html.match(/([\d.,]+\+?)\s*users?/i);
  if (um) {
    downloadsText = um[1];
    downloads = parseInstallRange(um[1]).downloads;
  }
  return {
    store: 'chrome_web_store',
    appId,
    country: 'us',
    name,
    version: '',
    rating,
    ratingCount,
    ratingCurrent: rating,
    ratingCountCurrent: ratingCount,
    price: 0,
    currency: 'USD',
    downloads,
    downloadsText,
    downloadsNote: downloadsText ? `Chrome Web Store 用户数：${downloadsText}` : '',
    url,
    reviews: [],
    source: 'chrome_web_store_public',
    syncedAt: new Date().toISOString(),
  };
}

export async function fetchStoreMetrics(parsed) {
  if (!parsed?.store || !parsed?.appId) {
    const err = new Error('无法识别商店链接，请填写 App Store / Google Play / Chrome Web Store 链接');
    err.status = 400;
    throw err;
  }
  if (parsed.store === 'app_store') {
    return fetchAppStoreMetrics(parsed);
  }
  if (parsed.store === 'google_play') {
    return fetchGooglePlayMetrics(parsed);
  }
  if (parsed.store === 'chrome_web_store') {
    return fetchChromeWebStoreMetrics(parsed);
  }
  const err = new Error(`暂不支持自动同步：${parsed.store}（可继续手填）`);
  err.status = 400;
  throw err;
}

export function applyMetricsToPlatform(platform, metrics) {
  const period = new Date().toISOString().slice(0, 7);
  const usageNotes = [
    platform.usage?.notes,
    metrics.downloadsNote,
    metrics.rating != null ? `商店评分 ${metrics.rating}${metrics.ratingCount != null ? `（${metrics.ratingCount}）` : ''}` : '',
    metrics.version ? `商店版本 ${metrics.version}` : '',
  ]
    .filter(Boolean)
    .join('；');

  return {
    ...platform,
    store: metrics.store || platform.store,
    storeName: platform.storeName || metrics.name || platform.store,
    pricing:
      metrics.price != null
        ? {
            ...platform.pricing,
            model: metrics.price > 0 ? platform.pricing?.model || 'paid' : platform.pricing?.model || 'free',
            price: metrics.price,
            currency: metrics.currency || platform.pricing?.currency || 'USD',
          }
        : platform.pricing,
    usage: {
      ...platform.usage,
      downloads: metrics.downloads != null ? metrics.downloads : platform.usage?.downloads ?? null,
      period: platform.usage?.period || period,
      notes: usageNotes,
    },
    storeMetrics: {
      rating: metrics.rating,
      ratingCount: metrics.ratingCount,
      ratingCurrent: metrics.ratingCurrent,
      ratingCountCurrent: metrics.ratingCountCurrent,
      downloads: metrics.downloads,
      downloadsText: metrics.downloadsText || '',
      version: metrics.version || '',
      name: metrics.name || '',
      url: metrics.url || '',
      source: metrics.source,
      syncedAt: metrics.syncedAt,
      note: metrics.downloadsNote || '',
    },
  };
}

export function metricsToFeedbackItems(metrics) {
  return (metrics.reviews || [])
    .filter((r) => r.content || r.title)
    .map((r) => ({
      source: metrics.store === 'app_store' ? 'app_store' : metrics.store === 'google_play' ? 'google_play' : 'other',
      author: r.author || '',
      rating: r.rating,
      content: [r.title, r.content].filter(Boolean).join('\n').trim(),
      url: r.url || metrics.url || '',
      externalId: r.externalId || '',
      createdAt: r.createdAt || metrics.syncedAt,
      sentiment: null,
    }));
}

export { parseInstallRange };
