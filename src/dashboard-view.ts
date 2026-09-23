import type { Tab } from './components/Header';
import type { ProviderId } from './provider-view';

type DashboardView = { tab: Tab; days: number; costQuery: string; provider?: ProviderId | null };
const KEY = 'ai-usage-dashboard-view';
const PROVIDERS: ProviderId[] = ['codex', 'claude', 'fable'];

export function readDashboardView(): DashboardView {
  const fallback: DashboardView = { tab: 'overview', days: 30, costQuery: '', provider: null };
  if (!window.aiUsage) return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved || !['overview', 'activity', 'costs', 'settings'].includes(saved.tab)) return fallback;
    return {
      tab: saved.tab,
      days: [7, 30, 90].includes(saved.days) ? saved.days : 30,
      costQuery: typeof saved.costQuery === 'string' ? saved.costQuery.slice(0, 2000) : '',
      // A provider page only exists inside the Overview.
      provider: saved.tab === 'overview' && PROVIDERS.includes(saved.provider) ? saved.provider : null,
    };
  } catch {
    return fallback;
  }
}

export function saveDashboardView(view: DashboardView): boolean {
  // If storage is unavailable, keep the renderer so its view is not lost.
  if (view.costQuery.length > 2000) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
    return true;
  } catch {
    return false;
  }
}
