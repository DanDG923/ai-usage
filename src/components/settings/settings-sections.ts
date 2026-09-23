import { HEALTHY_SOURCE_STATUSES } from '../../lib';
import type { Snapshot, Source } from '../../types';

/**
 * The Settings page's sections in page order. The section navigation, the
 * scroll-spy and the search all read this list, so a new section only needs an
 * entry here and a matching slot in Settings.tsx.
 */
export type SettingsSectionId =
  'subscriptions' | 'sources' | 'forecast' | 'alerts' | 'pricing' | 'storage' | 'appearance' | 'manual' | 'diagnostics';

export type SettingsSectionMeta = {
  id: SettingsSectionId;
  title: string;
  /** Advanced sections live in the closing disclosure and a separate navigation group. */
  advanced?: boolean;
  /** Words people search for that the section itself does not print. */
  keywords: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: 'subscriptions',
    title: 'Subscriptions',
    keywords: 'plans monthly fees value hide show free resets banked expiry',
  },
  { id: 'sources', title: 'Sources', keywords: 'collectors connections connected status refresh interval helper' },
  { id: 'forecast', title: 'Forecast', keywords: 'schedule working hours active days daily budget reserve' },
  { id: 'alerts', title: 'Alerts', keywords: 'notifications notify tray digest snooze startup login' },
  {
    id: 'pricing',
    title: 'API pricing',
    keywords: 'currency exchange rate prices catalogue catalog cost unpriced models',
  },
  {
    id: 'storage',
    title: 'Data & backups',
    keywords: 'storage database backup restore export csv summary files folder',
  },
  {
    id: 'appearance',
    title: 'Appearance & updates',
    keywords: 'theme dark light mode colour color memory rendering graphics version update release',
  },
  { id: 'manual', title: 'Manual observation', advanced: true, keywords: 'advanced reading record percentage' },
  {
    id: 'diagnostics',
    title: 'Diagnostics',
    advanced: true,
    keywords: 'advanced debug troubleshooting collector latency',
  },
];

export const ADVANCED_GROUP_LABEL = 'Advanced';

// Older or friendlier names other pages may link to.
const TARGET_ALIASES: Record<string, string> = {
  schedule: 'forecast',
  fees: 'subscription-fees',
  'plan-fees': 'subscription-fees',
  backups: 'storage',
  data: 'storage',
  export: 'storage',
  updates: 'appearance',
  theme: 'appearance',
  advanced: 'manual',
};

/** Resolves a link target such as "#schedule" or "fees" to the element id on the Settings page. */
export function resolveSettingsTarget(target: string | null | undefined) {
  const key = String(target ?? '')
    .replace(/^#/, '')
    .trim();
  return TARGET_ALIASES[key] ?? key;
}

/** Lower-cased, accent-free, single-spaced text with typographic quotes folded to plain ones. */
export function normalizeSearchText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchTerms(query: string) {
  return normalizeSearchText(query).split(' ').filter(Boolean);
}

/**
 * True when every word of the query appears somewhere in the text, in any
 * order and case. An empty query matches everything.
 */
export function matchesQuery(text: string, query: string) {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const haystack = normalizeSearchText(text);
  return terms.every((term) => haystack.includes(term));
}

/**
 * The sections whose title, keywords or rendered text match the query.
 * `texts` holds each section's visible text; a section without text is
 * matched on its title and keywords alone.
 */
export function matchingSections(
  texts: Partial<Record<SettingsSectionId, string>>,
  query: string,
  sections: readonly SettingsSectionMeta[] = SETTINGS_SECTIONS,
) {
  const matches = new Set<SettingsSectionId>();
  for (const section of sections) {
    const text = [
      section.title,
      section.keywords,
      section.advanced ? ADVANCED_GROUP_LABEL : '',
      texts[section.id] ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    if (matchesQuery(text, query)) matches.add(section.id);
  }
  return matches;
}

// Healthy statuses are the ones the Sources list draws with a green dot; the
// attention statuses are the ones every consumer treats as stale data (see
// electron/store.cjs setSourceStatus).
const ATTENTION_STATUSES = new Set(['error', 'stale', 'degraded']);

export type SourcesBadge = { tone: 'ok' | 'warn' | 'neutral'; label: string; connected: number; attention: number };

/** "3 connected", or "1 needs attention" as soon as any source is failing or serving cached data. */
export function sourcesBadge(sources: readonly Pick<Source, 'status'>[]): SourcesBadge {
  const connected = sources.filter((source) => HEALTHY_SOURCE_STATUSES.has(source.status)).length;
  const attention = sources.filter((source) => ATTENTION_STATUSES.has(source.status)).length;
  if (attention > 0) {
    return {
      tone: 'warn',
      label: `${attention} ${attention === 1 ? 'needs' : 'need'} attention`,
      connected,
      attention,
    };
  }
  return { tone: connected > 0 ? 'ok' : 'neutral', label: `${connected} connected`, connected, attention };
}

/**
 * Detected models without a catalogue price, counted once per model name the
 * way the API pricing table lists them.
 */
export function unpricedModelCount(snapshot: Pick<Snapshot, 'costs' | 'priceCatalog'>) {
  const priced = new Set(snapshot.priceCatalog.map((row) => row.model.toLowerCase()));
  const models = new Set<string>();
  for (const entry of snapshot.costs.unpricedModels ?? []) {
    const model = entry.model.toLowerCase();
    if (!priced.has(model)) models.add(model);
  }
  return models.size;
}
