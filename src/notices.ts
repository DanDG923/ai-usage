import { sourceLabel } from './lib';
import type { Bridge } from './types';

/**
 * How a notice is drawn, chosen by whoever publishes it rather than read back
 * from its wording: a failure is the warning red and stays until dismissed, a
 * refresh that fell back to cached data is caution amber, the update-busy
 * notice is neutral, and every other confirmation is an ok check.
 */
export type NoticeTone = 'ok' | 'caution' | 'busy' | 'warning';

export type Notice = { text: string; tone: NoticeTone };

type RefreshResult = Awaited<ReturnType<Bridge['refresh']>>;
type HelperRemoval = Awaited<ReturnType<Bridge['uninstallClaudeHelper']>>['result'];

/** The notice after a requested refresh: unavailable sources or a failed backup are failures. */
export function refreshNotice(result: Pick<RefreshResult, 'backupError' | 'collectors'>): Notice {
  const collectors = Object.entries(result.collectors || {});
  const failures = collectors.filter(([, collector]) => collector?.error);
  const warnings = collectors.filter(([, collector]) => collector?.warning && !collector?.error);
  const backup = result.backupError ? ` Scheduled backup failed: ${result.backupError}` : '';
  const names = (entries: typeof collectors) => entries.map(([source]) => sourceLabel(source)).join(' and ');
  if (failures.length)
    return {
      text: `Refresh completed with ${names(failures)} unavailable. Check Sources for details.${backup}`,
      tone: 'warning',
    };
  if (warnings.length)
    return {
      text: `Refresh completed using fallback data for ${names(warnings)}. Check Sources for details.${backup}`,
      tone: backup ? 'warning' : 'caution',
    };
  return { text: `All supported local sources refreshed.${backup}`, tone: backup ? 'warning' : 'ok' };
}

/**
 * The notice after the Claude status-line helper is disabled. A helper script
 * that is still in use is left on disk but no longer referenced: the helper
 * is off all the same, so that is still a confirmation, not a failure.
 */
export function helperRemovedNotice(result: HelperRemoval): Notice {
  const leftover =
    result.managed && !result.helperScriptRemoved
      ? ' The helper script is still in use and could not be deleted; it is no longer referenced.'
      : '';
  return {
    text: result.restoredPreviousStatusLine
      ? `Claude allowance helper disabled and your previous status line restored. Fully restart Claude.${leftover}`
      : result.statusLineRemoved
        ? `Claude allowance helper disabled and its status line removed. Fully restart Claude.${leftover}`
        : 'Claude’s status line is not the one this app installed, so nothing was changed.',
    tone: 'ok',
  };
}
