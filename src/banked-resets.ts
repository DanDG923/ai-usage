import { dayDate } from './lib';
import type { ProviderId } from './provider-view';
import type { Snapshot } from './types';

export type BankedResets = {
  count: number;
  label: string;
  note: string;
  /** Where the count comes from: the provider's own report, or the user's record. */
  source: 'provider' | 'manual';
};

function localDayKey(ms: number) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Resets a provider lets you claim, shown on that provider's card. Codex
 * reports its banked credits; Claude offers free resets only in its own Usage
 * settings, so those are the user's record and hide after their expiry date.
 * Neither is ever treated as allowance or assumed spent.
 */
export function bankedResetsFor(
  provider: ProviderId,
  snapshot: Pick<Snapshot, 'settings' | 'resetCredits'>,
  nowMs: number,
): BankedResets | null {
  if (provider === 'codex') {
    const count = Number(snapshot.resetCredits) || 0;
    if (!(count > 0)) return null;
    return {
      count,
      label: `${count} reset credit${count === 1 ? '' : 's'} banked`,
      note: 'Reported by Codex. Never counted as allowance or used automatically.',
      source: 'provider',
    };
  }
  if (provider === 'claude') {
    const count = Number(snapshot.settings.claudeFreeResets) || 0;
    const expiresOn = snapshot.settings.claudeFreeResetsExpireOn ?? null;
    if (!(count > 0) || (expiresOn && localDayKey(nowMs) > expiresOn)) return null;
    const [year, month, day] = (expiresOn ?? '').split('-').map(Number);
    const expiry = expiresOn ? ` Expires ${dayDate(new Date(year, month - 1, day, 12).getTime())}.` : '';
    return {
      count,
      label: `${count} free reset${count === 1 ? '' : 's'} available`,
      note: `Recorded by you; claim it in Claude’s Usage settings.${expiry}`,
      source: 'manual',
    };
  }
  return null;
}
