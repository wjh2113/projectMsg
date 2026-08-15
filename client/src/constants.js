export const STATUSES = [
  { id: 'planning', label: '规划中' },
  { id: 'developing', label: '开发中' },
  { id: 'on_github', label: '已到 GitHub' },
  { id: 'deployed', label: '已部署' },
  { id: 'paused', label: '暂停' },
  { id: 'archived', label: '归档' },
];

export const TRASH_STATUS = { id: 'trashed', label: '回收站' };
export const WORK_STATUSES = STATUSES;
export const ALL_STATUSES = [...STATUSES, TRASH_STATUS];
export const STATUS_MAP = Object.fromEntries(ALL_STATUSES.map((s) => [s.id, s.label]));

export const THEMES = [
  { id: 'luxury', label: '暗黑奢华' },
  { id: 'neu', label: '新拟物' },
  { id: 'minimal', label: '极简' },
  { id: 'classic', label: '初始' },
];

export const THEME_MAP = Object.fromEntries(THEMES.map((t) => [t.id, t.label]));

export const LISTING_STATUS_LABELS = {
  draft: '草稿',
  review: '审核中',
  listed: '已上架',
  rejected: '已拒审',
  delisted: '已下架',
};

export const FEEDBACK_SOURCES = [
  { id: 'manual', label: '手动录入' },
  { id: 'github', label: 'GitHub' },
  { id: 'app_store', label: 'App Store' },
  { id: 'google_play', label: 'Google Play' },
  { id: 'other', label: '其他' },
];

export const STORE_SYNCABLE = new Set(['app_store', 'google_play', 'chrome_web_store']);

export const PRICING_MODEL_LABELS = {
  free: '免费',
  freemium: '免费+增值',
  paid: '一次性付费',
  subscription: '订阅制',
  usage_based: '按量计费',
  hybrid: '混合模式',
  other: '其他',
};

export const EMPTY_PLATFORM_FORM = {
  store: 'google_play',
  storeName: '',
  pricingModel: 'freemium',
  price: '',
  currency: 'CNY',
  billingPeriod: 'monthly',
  tiersNote: '',
  downloads: '',
  activeUsers: '',
  dau: '',
  mau: '',
  usagePeriod: '',
  usageNotes: '',
  conversionRate: '',
  trialToPaid: '',
  dealWinRate: '',
  leads: '',
  wins: '',
  winNotes: '',
  promoStrategy: '',
  promoChannels: '',
  promoBudget: '',
  listingFee: '',
  adsSpend: '',
  opsSpend: '',
  otherSpend: '',
  costNotes: '',
};
