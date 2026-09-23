import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Eye } from 'lucide-react';
import type { ForecastState } from '../types';

export const STATE_WORD: Record<ForecastState, string> = {
  safe: 'On track',
  watch: 'Watch',
  risk: 'At risk',
  critical: 'Critical',
  unknown: 'Learning',
};

const STATE_ICON = {
  safe: CheckCircle2,
  watch: Eye,
  risk: AlertTriangle,
  critical: AlertOctagon,
  unknown: CircleDashed,
} as const;

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
