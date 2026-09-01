import { BrainCircuit, Hexagon, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  displayedRemaining,
  durationLabel,
  isEstimated,
  percent,
  primaryWindow,
  quotaWindows,
  resetDistance,
  shortDate,
  whenLabel,
  windowLabel,
} from '../lib';
import type { Quota } from '../types';
import { ForecastChart } from './Charts';
import { Gauge, PaceBullet } from './Gauge';

export type QuotaKind = 'codex' | 'claude' | 'fable';

type Props = {
  kind: QuotaKind;
  quota: Quota | null;
  /** The snapshot clock; keeps run-out labels deterministic for a render. */
  nowMs: number;
  resetCredits?: number;
  /** Replaces the plan label in the eyebrow, e.g. Fable's measurement source. */
  measurement?: string;
  /** Extra footer lines, e.g. Fable's local-activity and staleness notes. */
  notes?: ReactNode[];
  /** Shown instead of the generic empty state when no window exists. */
  emptyText?: string;
};

const NAMES: Record<QuotaKind, string> = { codex: 'Codex', claude: 'Claude', fable: 'Fable 5' };
const ICONS: Record<QuotaKind, typeof Hexagon> = { codex: Hexagon, claude: BrainCircuit, fable: Sparkles };

function planLabel(planType: string | null) {
  const trimmed = planType?.trim();
  if (!trimmed) return 'Allowance';
  const lower = trimmed.toLowerCase();
  return lower === 'pro' ? 'ChatGPT Pro' : lower === 'max' ? 'Claude Max' : trimmed;
}

export function QuotaCard({ kind, quota, nowMs, resetCredits = 0, measurement, notes = [], emptyText }: Props) {
  const name = NAMES[kind];
  const Icon = ICONS[kind];
  const current = primaryWindow(quota);
  if (!quota || !current) {
    return (
      <article className="qc unknown" aria-label={`${name} allowance`}>
        <div className="qc-head">
          <span className={`provider-icon ${kind}`}>
            <Icon aria-hidden="true" />
          </span>
          <span className="eyebrow">{name} · Allowance</span>
        </div>
        <h2 className="qc-empty-title">Waiting for a first observation</h2>
        <p className="qc-empty-text">
          {emptyText ||
            'Refresh the automatic sources. If the provider still exposes no allowance, an official percentage can be added as an optional fallback in Data & settings.'}
        </p>
        {notes.map((note, index) => (
          <div key={index} className="qc-note">
            {note}
          </div>
        ))}
      </article>
    );
  }
  const secondaryWindows = quotaWindows(quota).filter((entry) => !entry.forecast.expired && entry !== current);
  const f = current.forecast;
  const risky = f.state === 'risk' || f.state === 'critical';
  const headline = f.expired ? (
    'This allowance window has reset.'
  ) : f.expectedRemaining == null ? (
    'Learning your usage pattern.'
  ) : risky ? (
    <>
      May reach the limit with only <em>~{Math.round(f.expectedRemaining)}% expected to spare</em>.
    </>
  ) : (
    <>
      Lasts to reset with <em>~{Math.round(f.expectedRemaining)}% to spare</em>.
    </>
  );
  const summary = f.expired
    ? 'Waiting for the next official observation before forecasting the new window.'
    : f.heavyRemaining == null
      ? 'More observations will sharpen the estimate.'
      : f.heavyRemaining <= 0
        ? 'Your heavier learned pattern may use the full allowance before reset.'
        : `Even a heavier week than usual leaves ${Math.round(f.heavyRemaining)}%.`;
  const runsOut = f.exhaustsAt
    ? {
        label: whenLabel(f.exhaustsAt, nowMs),
        detail: `${durationLabel(Date.parse(f.exhaustsAt), Date.parse(current.resetsAt))} before reset`,
        tone: 'hot',
      }
    : f.heavyExhaustsAt
      ? { label: 'Not expected', detail: `heavier pattern: ${whenLabel(f.heavyExhaustsAt, nowMs)}`, tone: 'warm' }
      : f.expectedRemaining == null
        ? { label: '—', detail: 'learning', tone: '' }
        : { label: 'After reset', detail: 'on both projections', tone: '' };
  return (
    <article className={`qc ${f.state}`} aria-label={`${name} allowance`}>
      <div className="qc-head">
        <span className={`provider-icon ${kind}`}>
          <Icon aria-hidden="true" />
        </span>
        <span className="eyebrow">
          {name} · {measurement || planLabel(current.planType)} ·{' '}
          {current.bucketName || windowLabel(current.windowMinutes)}
        </span>
        <span className={`state-pill ${f.state}`}>
          {risky ? <TriangleAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          {f.state === 'unknown' ? 'Learning' : f.state}
        </span>
      </div>
      <div className="qc-hero">
        <Gauge
          remaining={displayedRemaining(current)}
          expected={f.expectedRemaining}
          state={f.state}
          estimated={Boolean(f.currentIsEstimated && f.estimatedCurrentRemaining != null)}
        />
        <div className="qc-answer">
          <p className="answer">
            {headline} <span>{summary}</span>
          </p>
          <div className="qc-facts">
            <div>
              <span>Resets</span>
              <b>{resetDistance(current.resetsAt)}</b>
              <small>{shortDate(current.resetsAt)}</small>
            </div>
            <div>
              <span>Expected at reset</span>
              <b>{percent(f.expectedRemaining)}</b>
              <small>heavier end: {percent(f.heavyRemaining)}</small>
            </div>
            <div className={`runout ${runsOut.tone}`}>
              <span>Runs out</span>
              <b>{runsOut.label}</b>
              <small>{runsOut.detail}</small>
            </div>
          </div>
        </div>
      </div>
      {!f.expired && <PaceBullet forecast={f} />}
      <ForecastChart forecast={f} />
      <footer className="qc-foot">
        <span>
          {f.learnedSamples
            ? `${f.learnedSamples} samples · ${f.learnedDays} learned days · ${Math.round(f.confidence * 100)}% confidence`
            : 'The learner is warming up'}
        </span>
        {kind === 'codex' && resetCredits > 0 && (
          <span className="credit">
            {resetCredits} reset credit{resetCredits === 1 ? '' : 's'} banked · never auto-redeemed
          </span>
        )}
        <span>
          {f.currentIsEstimated ? `last observed ${percent(current.remainingPercent)} · ` : ''}observed{' '}
          {shortDate(current.observedAt)} · {current.provenance.replaceAll('-', ' ')}
        </span>
        {secondaryWindows.map((entry) => (
          <span key={entry.bucketId}>
            Also active · {entry.bucketName || windowLabel(entry.windowMinutes)} · {isEstimated(entry) ? '~' : ''}
            {percent(displayedRemaining(entry))} {isEstimated(entry) ? 'estimated ' : ''}left · {entry.forecast.state} ·
            resets {resetDistance(entry.resetsAt)}
          </span>
        ))}
        {notes.map((note, index) => (
          <span key={`note-${index}`} className="qc-note">
            {note}
          </span>
        ))}
      </footer>
    </article>
  );
}
