import { buildDashboardVerdict } from '../../electron/dashboard-decision.mjs';
import type { Bridge, Snapshot } from '../types';

/**
 * The part of the desktop bridge the dashboard's store and actions talk to.
 * In the installed app it is window.aiUsage, from the preload; in the browser
 * preview it is a stand-in over the demo data (previewBridge, below).
 */
export type DashboardBridge = Pick<
  Bridge,
  | 'getSnapshot'
  | 'refresh'
  | 'updateSettings'
  | 'updatePrice'
  | 'addManualObservation'
  | 'installClaudeHelper'
  | 'uninstallClaudeHelper'
  | 'getClaudeCodeMod'
  | 'installClaudeCodeMod'
  | 'uninstallClaudeCodeMod'
  | 'createBackup'
  | 'restoreBackup'
  | 'openBackupDirectory'
  | 'exportCsv'
  | 'copySummary'
  | 'snoozeAlerts'
  | 'checkForUpdates'
  | 'onUpdated'
  | 'onNavigate'
  | 'onPrepareSleep'
>;

/**
 * The preview bridge's answer to work only the installed app does. Its
 * message, when it has one, is said as a plain notice in place of the work.
 * Its snapshot, when it has one, is what the preview shows instead: the change
 * is drawn, but nothing was saved, so nothing is confirmed.
 */
export class DesktopOnly extends Error {
  readonly snapshot: Snapshot | undefined;

  constructor(message = '', snapshot?: Snapshot) {
    super(message);
    this.name = 'DesktopOnly';
    this.snapshot = snapshot;
  }
}

/**
 * The browser preview's bridge: the demo snapshot behind the bridge's own
 * interface, as flyout-preview.ts is for the tray flyout. `shown` reads the
 * snapshot on screen, which a change to a setting, a price or the snooze is
 * applied to and shown, unsaved.
 *
 * Everything but the first read is thrown as DesktopOnly rather than returned
 * as a rejected promise, so it takes effect within the call: a change is on
 * screen at once, and a caller's busy flag is set and cleared in one step and
 * never drawn.
 */
export function previewBridge(demo: Snapshot, shown: () => Snapshot | null): DashboardBridge {
  const desktopOnly = (notice = ''): never => {
    throw new DesktopOnly(notice);
  };
  const showOnly = (change: (current: Snapshot) => Snapshot): never => {
    const current = shown();
    throw new DesktopOnly('', current ? change(current) : undefined);
  };
  return {
    // The demo data covers one period and is read once.
    getSnapshot: () => (shown() ? desktopOnly() : Promise.resolve(demo)),
    refresh: () => desktopOnly('The live collectors run in the installed desktop app.'),
    updateSettings: (patch) =>
      showOnly((current) => {
        const next = { ...current, settings: { ...current.settings, ...patch } };
        return { ...next, dashboardVerdict: buildDashboardVerdict(next) };
      }),
    updatePrice: (price) =>
      showOnly((current) => ({
        ...current,
        priceCatalog: current.priceCatalog.map((row) =>
          row.model === price.model
            ? {
                ...row,
                input_usd_per_million: price.inputUsdPerMillion,
                cache_write_usd_per_million: price.cacheWriteUsdPerMillion,
                cache_write_1h_usd_per_million: price.cacheWrite1hUsdPerMillion,
                cache_read_usd_per_million: price.cacheReadUsdPerMillion,
                output_usd_per_million: price.outputUsdPerMillion,
                effective_from: price.effectiveFrom ?? row.effective_from,
                source_url: price.sourceUrl ?? null,
              }
            : row,
        ),
      })),
    addManualObservation: () => desktopOnly('Manual observations are saved by the installed desktop app.'),
    installClaudeHelper: () => desktopOnly(),
    uninstallClaudeHelper: () => desktopOnly(),
    getClaudeCodeMod: () => desktopOnly(),
    installClaudeCodeMod: () => desktopOnly(),
    uninstallClaudeCodeMod: () => desktopOnly(),
    createBackup: () => desktopOnly(),
    restoreBackup: () => desktopOnly('Restoring runs in the installed desktop app.'),
    openBackupDirectory: () => desktopOnly(),
    exportCsv: () => desktopOnly('Exports are written by the installed desktop app.'),
    copySummary: () => desktopOnly('The summary is copied by the installed desktop app.'),
    snoozeAlerts: (hours) =>
      showOnly((current) => ({
        ...current,
        settings: {
          ...current.settings,
          alertsSnoozedUntil: hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
        },
      })),
    checkForUpdates: () => desktopOnly(),
  };
}

/** Where a dashboard gets its bridge from. */
export type BridgeSource = {
  /** The preload's bridge: present in the installed app, and only there. */
  desktop: DashboardBridge | undefined;
  /** Loads the browser preview's bridge; null wherever demo data must never appear. */
  preview: ((shown: () => Snapshot | null) => Promise<DashboardBridge>) | null;
};

// The demo data loads on demand and stays out of the packaged bundle: the
// build keeps it in its own chunk, which only the browser preview requests.
async function loadPreviewBridge(shown: () => Snapshot | null) {
  const { demoSnapshot, sharedPoolDemoSnapshot } = await import('../data/demo');
  const variant = new URLSearchParams(window.location.search).get('demo');
  return previewBridge(variant === 'shared-pool' ? sharedPoolDemoSnapshot() : demoSnapshot, shown);
}

/**
 * The bridge for this window. Demo data is a browser-preview adapter only:
 * Electron always has window.aiUsage, and a packaged page without it (a file:
 * URL whose preload did not run) gets neither, so a failed local read can
 * never masquerade as real usage.
 */
export function bridgeSource(): BridgeSource {
  if (typeof window === 'undefined') return { desktop: undefined, preview: null };
  const isBrowserPreview = !window.aiUsage && window.location.protocol !== 'file:';
  return { desktop: window.aiUsage, preview: isBrowserPreview ? loadPreviewBridge : null };
}
