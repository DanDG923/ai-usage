import type { ReactNode } from 'react';
import {
  dateTimeLabel,
  displayedRemaining,
  durationLabel,
  isEstimated,
  percent,
  primaryWindow,
  quotaWindows,
  resetDistance,
  shortDate,
  timeLabel,
  whenLabel,
  windowLabel,
} from '../lib';
import type { Quota, QuotaWindow } from '../types';
import { ForecastChart } from './Charts';

export type QuotaKind = 'codex' | 'claude' | 'fable';

type Props = {
  kind: QuotaKind;
  quota: Quota | null;
  /** The snapshot clock; keeps run-out labels deterministic for a render. */
  nowMs: number;
  resetCredits?: number;
  /** Replaces the plan label in the subtitle, e.g. Fable's measurement source. */
  measurement?: string;
  /** Extra footer lines, e.g. Fable's local-activity and staleness notes. */
  notes?: ReactNode[];
  /** Shown instead of the generic empty state when no window exists. */
  emptyText?: string;
};

const NAMES: Record<QuotaKind, string> = { codex: 'Codex', claude: 'Claude', fable: 'Fable 5' };
const STATE_WORD: Record<string, string> = {
  safe: 'On track',
  watch: 'Watch',
  risk: 'At risk',
  critical: 'Critical',
  unknown: 'Learning',
};

function planLabel(planType: string | null) {
  const trimmed = planType?.trim();
  if (!trimmed) return 'Allowance';
  const lower = trimmed.toLowerCase();
  return lower === 'pro' ? 'ChatGPT Pro' : lower === 'max' ? 'Claude Max' : trimmed;
}

function sentence(text: string) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** "this week's allowance" or "this 5-hour window". */
function windowNoun(minutes: number | null) {
  const label = windowLabel(minutes);
  return label === 'weekly' ? "this week's allowance" : `this ${label} window`;
}

function readingLabel(current: QuotaWindow, nowMs: number) {
  const time = timeLabel(current.observedAt, nowMs);
  if (current.provenance === 'manual-official') return `Manual observation ${time}`;
  if (current.provenance === 'derived-tokens') return `Local estimate ${time}`;
  if (current.provenance === 'preview') return `Preview reading ${time}`;
  return `Official reading ${time}`;
}

export function QuotaCard({ kind, quota, nowMs, resetCredits = 0, measurement, notes = [], emptyText }: Props) {
  const name = NAMES[kind];
  const current = primaryWindow(quota);
  if (!quota || !current) {
    return (
      <article className="qc unknown" aria-label={`${name} allowance`}>
        <div className="qc-head">
          <div className="qc-title">
            <h2>{name}</h2>
            <span>Allowance</span>
          </div>
        </div>
        <h3 className="qc-empty-title">Waiting for a first observation</h3>
        <p className="qc-empty-text">
          {emptyText ||
            'Refresh the automatic sources. If the provider still exposes no allowance, an official percentage can be added as an optional fallback in Settings.'}
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
  const estimated = Boolean(f.currentIsEstimated && f.estimatedCurrentRemaining != null);
  const remaining = Math.max(0, Math.min(100, displayedRemaining(current)));
  const used = Math.round(100 - remaining);
  const expected = f.expectedRemaining == null ? null : Math.max(0, Math.min(remaining, f.expectedRemaining));
  const expectedUse = expected == null ? 0 : Math.round(remaining - expected);
  const spare = expected == null ? Math.round(remaining) : Math.round(expected);
  const heavyMark = f.heavyRemaining == null ? null : Math.max(0, Math.min(100, 100 - f.heavyRemaining));
  const runsOut = f.exhaustsAt
    ? {
        label: whenLabel(f.exhaustsAt, nowMs),
        detail: `${durationLabel(Date.parse(f.exhaustsAt), Date.parse(current.resetsAt))} before reset`,
        tone: 'hot',
      }
    : f.heavyExhaustsAt
      ? { label: 'Not expected', detail: `heavier case ${whenLabel(f.heavyExhaustsAt, nowMs)}`, tone: 'warm' }
      : f.expectedRemaining == null
        ? { label: 'Learning', detail: 'more observations needed', tone: '' }
        : { label: 'After reset', detail: 'on both projections', tone: '' };
  const paceRatio = f.safePace > 0 ? f.recentPace / f.safePace : f.recentPace > 0 ? Number.POSITIVE_INFINITY : 0;
  const paceTone = paceRatio <= 1 ? '' : paceRatio <= 1.2 ? 'warm' : 'hot';
  const reserve = f.reservePercent ?? 0;
  const subtitle = `${sentence(measurement || planLabel(current.planType))} · ${sentence(windowLabel(current.windowMinutes))}`;
  const barLabel = `${estimated ? 'approximately ' : ''}${Math.round(remaining)}% of the allowance left: ${used}% used${
    expected == null ? '' : `, ${expectedUse}% expected before reset, ${spare}% spare`
  }`;
  return (
    <article className={`qc ${f.state}`} aria-label={`${name} allowance`}>
      <div className="qc-head">
        <div className="qc-title">
          <h2>{name}</h2>
          <span title={subtitle}>{subtitle}</span>
        </div>
        <span className={`state-pill ${f.state}`}>{STATE_WORD[f.state] || f.state}</span>
      </div>
      <div className="qc-figure">
        <b>
          {estimated ? '~' : ''}
          {Math.round(remaining)}%
        </b>
        <span>of {windowNoun(current.windowMinutes)} left</span>
      </div>
      {f.expired ? (
        <p className="qc-empty-text">This window has reset. Waiting for the next official observation.</p>
      ) : (
        <div>
          <div className="allowance-bar" role="img" aria-label={barLabel}>
            <div className="ab-used" style={{ width: `${used}%` }} />
            {expected != null && <div className="ab-expected" style={{ width: `${expectedUse}%` }} />}
            <div className="ab-spare" />
            {heavyMark != null && <div className="ab-heavy" style={{ left: `${heavyMark}%` }} />}
          </div>
          <div className="allowance-key" aria-hidden="true">
            <span className="k-used">
              <i />
              {used}% used
            </span>
            {expected != null && (
              <span className="k-expected">
                <i />
                {expectedUse}% expected before reset
              </span>
            )}
            <span className="k-spare">
              <i />
              {spare}% spare
            </span>
            {heavyMark != null && (
              <span className="k-heavy">
                <i />
                heavier case
              </span>
            )}
          </div>
        </div>
      )}
      <dl className="qc-rows">
        <div>
          <dt>Resets</dt>
          <dd>
            <b>{dateTimeLabel(current.resetsAt)}</b>
            <small>in {resetDistance(current.resetsAt)}</small>
          </dd>
        </div>
        <div>
          <dt>Expected at reset</dt>
          <dd>
            {f.expectedRemaining == null ? (
              <>
                <b>Learning</b>
                <small>more observations needed</small>
              </>
            ) : (
              <>
                <b>{percent(f.expectedRemaining)} left</b>
                <small>heavier case {percent(f.heavyRemaining)}</small>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Runs out</dt>
          <dd className={runsOut.tone}>
            <b>{runsOut.label}</b>
            <small>{runsOut.detail}</small>
          </dd>
        </div>
        {!f.expired && (
          <div>
            <dt>Recent pace</dt>
            <dd className={paceTone}>
              <b>{percent(f.recentPace, 2)}/h</b>
              <small>
                safe up to {percent(f.safePace, 2)}/h{reserve > 0 ? `, keeping ${Math.round(reserve)}% back` : ''}
              </small>
            </dd>
          </div>
        )}
      </dl>
      <div className="qc-chart">
        <div className="qc-chart-head">
          <span>Forecast to reset</span>
          <div className="chart-key" aria-hidden="true">
            <span className="k-observed">
              <i />
              Observed
            </span>
            <span className="k-expected">
              <i />
              Expected
            </span>
            <span className="k-heavy">
              <i />
              Heavier
            </span>
          </div>
        </div>
        <ForecastChart forecast={f} />
      </div>
      <footer className="qc-foot">
        <span className="qc-learn">
          <span>
            {f.learnedSamples
              ? `Learned from ${f.learnedDays} days · ${Math.round(f.confidence * 100)}% confidence`
              : 'The learner is warming up'}
          </span>
          <span>
            {f.currentIsEstimated ? `last official ${percent(current.remainingPercent)} · ` : ''}
            {readingLabel(current, nowMs)}
          </span>
        </span>
        {kind === 'codex' && resetCredits > 0 && (
          <span className="credit">
            {resetCredits} reset credit{resetCredits === 1 ? '' : 's'} banked, never redeemed automatically
          </span>
        )}
        {secondaryWindows.map((entry) => (
          <span key={entry.bucketId}>
            Also active: {entry.bucketName || windowLabel(entry.windowMinutes)} · {isEstimated(entry) ? '~' : ''}
            {percent(displayedRemaining(entry))} left · {STATE_WORD[entry.forecast.state] || entry.forecast.state} ·
            resets in {resetDistance(entry.resetsAt)} ({shortDate(entry.resetsAt)})
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
