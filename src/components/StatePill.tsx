import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Eye, type LucideIcon } from 'lucide-react';
import { STATE_WORD } from '../lib';
import type { ForecastState } from '../types';

/**
 * The icon that goes with each state's word, so a state never rests on colour
 * alone. The pills and the glareshield's source health draw watch as an eye.
 */
export const STATE_ICON: Record<ForecastState, LucideIcon> = {
  safe: CheckCircle2,
  watch: Eye,
  risk: AlertTriangle,
  critical: AlertOctagon,
  unknown: CircleDashed,
};

/**
 * The same table with watch as the warning triangle, as the annunciators (the
 * Overview's status line and the tray flyout) and the Activity source column
 * have always drawn it. The two looks are deliberate; only the table is shared.
 */
export const ALERT_STATE_ICON: Record<ForecastState, LucideIcon> = { ...STATE_ICON, watch: AlertTriangle };

/** A forecast state as an icon and a word, so the state never rests on colour alone. */
export function StatePill({ state, label }: { state: ForecastState; label?: string }) {
  const Icon = STATE_ICON[state] ?? CircleDashed;
  return (
    <span className={`state-pill ${state}`}>
      <Icon aria-hidden="true" />
      {label ?? STATE_WORD[state]}
    </span>
  );
}
