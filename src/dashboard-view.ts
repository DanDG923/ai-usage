import type { Tab } from './components/Header';

type DashboardView = { tab: Tab; days: number; costQuery: string };
const KEY = 'ai-usage-dashboard-view';

export function readDashboardView(): DashboardView {
  const fallback: DashboardView = { tab: 'overview', days: 30, costQuery: '' };
  if (!window.aiUsage) return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved || !['overview', 'activity', 'costs', 'settings'].includes(saved.tab)) return fallback;
    return {
      tab: saved.tab,
      days: [7, 30, 90].includes(saved.days) ? saved.days : 30,
      costQuery: typeof saved.costQuery === 'string' ? saved.costQuery.slice(0, 2000) : '',
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
