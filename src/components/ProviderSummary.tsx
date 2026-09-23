import { ChevronRight, Hourglass } from 'lucide-react';
import { useMemo } from 'react';
import type { BankedResets } from '../banked-resets';
import { dailyBudget, scheduleOf } from '../budget';
import {
  allowanceWindowLabel,
  dateTimeLabel,
  displayedRemaining,
  isEstimated,
  modelAllowanceName,
  percent,
  quotaWindows,
  resetDistance,
  whenLabel,
} from '../lib';
import type { ProviderView } from '../provider-view';
import type { Settings } from '../types';
import { RunwayChart } from './Charts';
import { DailyBudgetStrip } from './DailyBudgetStrip';
import { StatePill } from './StatePill';

type ScheduleSettings = Pick<Settings, 'activeDays' | 'activeStartHour' | 'activeEndHour' | 'reservePercent'>;

/** The engine's own defaults, for callers that render a card without settings. */
export const DEFAULT_SCHEDULE: ScheduleSettings = {
  activeDays: [1, 2, 3, 4, 5, 6, 0],
  activeStartHour: 8,
  activeEndHour: 22,
  reservePercent: 0,
};

function ForecastAdjustmentNotes({ view }: { view: ProviderView }) {
  // Include a weekly adjustment even when the card headlines a more urgent
  // five-hour window. The bucket label keeps the explanation attached to its forecast.
  return quotaWindows(view.quota).map((window) => {
    const adjustment = window.forecast.resetAdjustment;
    if (window.forecast.expired || !adjustment?.dates.length || adjustment.weight >= 1) return null;
    return (
      <p className="provider-adjustment-note" key={window.bucketId}>
        <strong>{window.bucketName}:</strong> Heavy usage before an early reset has less influence on the expected
        forecast.
        <small>Recorded usage is kept; the heavier case still includes it.</small>
      </p>
    );
  });
}

/**
 * Shorter windows under the headline allowance. A five-hour Claude session can
 * be running warm while the weekly plan is on track; both facts belong on the
 * card, each with its own state.
 */
export function SessionWindows({ view, nowMs }: { view: ProviderView; nowMs: number }) {
  const renderWindow = (window: (typeof view.secondaryWindows)[number]) => {
    const remaining = Math.max(0, Math.min(100, displayedRemaining(window)));
    const expected = window.forecast.expectedRemaining;
    const outlook =
      modelAllowanceName(window) && window.usedPercent === 0 && expected === 100
        ? 'No usage reported in this window'
        : window.forecast.exhaustsAt
          ? `runs out ${whenLabel(window.forecast.exhaustsAt, nowMs)}`
          : expected != null
            ? `${percent(Math.max(0, Math.min(100, expected)))} expected at reset`
            : 'learning';
    return (
      <p className="provider-session" key={window.bucketId}>
        <StatePill state={window.forecast.state} />
        <strong>
          {isEstimated(window) ? '~' : ''}
          {Math.round(remaining)}%
        </strong>
        <span>{allowanceWindowLabel(window)}</span>
        <small title={dateTimeLabel(window.resetsAt)}>
          {outlook} · resets in {resetDistance(window.resetsAt)}
        </small>
      </p>
    );
  };
  const modelWindows = view.secondaryWindows.filter((window) => modelAllowanceName(window));
  return (
    <>
      {view.secondaryWindows.filter((window) => !modelAllowanceName(window)).map(renderWindow)}
      {modelWindows.length > 0 && (
        <details
          className="provider-model-allowances"
          open={modelWindows.some((window) => ['critical', 'risk', 'watch'].includes(window.forecast.state))}
        >
          <summary>Separate model allowances</summary>
          <p>These apply only to the named model and are separate from your main Codex allowance.</p>
          {modelWindows.map(renderWindow)}
        </details>
      )}
    </>
  );
}

/** Resets the provider lets you claim; context only, never counted as allowance. */
export function BankedResetsRow({ banked }: { banked: BankedResets }) {
  return (
    <p className={`provider-banked ${banked.source}`}>
      <Hourglass aria-hidden="true" />
      <span>
        <strong>{banked.label}</strong>
        <small>{banked.note}</small>
      </span>
    </p>
  );
}

/** Expected and heavier-week outcomes at the reset, as words rather than a bar to decode. */
export function ProviderOutcomes({ view, nowMs }: { view: ProviderView; nowMs: number }) {
  const forecast = view.current?.forecast;
  if (!forecast || view.expectedRemaining == null) {
    return <p className="provider-learning">Learning from recent usage before it forecasts the reset.</p>;
  }
  return (
    <dl className="provider-outcomes">
      <div>
        <dt>Expected at reset</dt>
        <dd className={forecast.exhaustsAt ? 'critical' : undefined}>
          {forecast.exhaustsAt
            ? `Runs out ${whenLabel(forecast.exhaustsAt, nowMs)}`
            : `${percent(view.expectedRemaining)} left`}
        </dd>
      </div>
      {view.heavyRemaining != null && (
        <div>
          <dt>Heavier week</dt>
          <dd className={forecast.heavyExhaustsAt ? 'risk' : undefined}>
            {forecast.heavyExhaustsAt
              ? `Runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`
              : `Leaves ${percent(view.heavyRemaining)}`}
          </dd>
        </div>
      )}
    </dl>
  );
}

export function ProviderSummary({
  view,
  nowMs,
  settings = DEFAULT_SCHEDULE,
  banked = null,
  onOpen,
}: {
  view: ProviderView;
  nowMs: number;
  settings?: ScheduleSettings;
  /** Banked or free resets for this provider, shown in the card's spare space. */
  banked?: BankedResets | null;
  onOpen?: () => void;
}) {
  const { activeDays, activeStartHour, activeEndHour } = settings;
  const schedule = useMemo(
    () => scheduleOf({ activeDays, activeStartHour, activeEndHour }),
    [activeDays, activeStartHour, activeEndHour],
  );

  if (!view.current || view.remaining == null) {
    return (
      <article className={`provider-card ${view.id} unknown`} aria-label={`${view.name} allowance`}>
        <header className="provider-card-head">
          <span className={`swatch ${view.id}`} aria-hidden="true" />
          <div>
            <h2>{view.name}</h2>
            <span>{view.subtitle}</span>
          </div>
          <StatePill state="unknown" label={view.expired ? 'Needs reading' : 'Learning'} />
        </header>
        <p className="provider-empty">
          {view.expired
            ? 'The last allowance window ended. Waiting for a new provider reading.'
            : 'Waiting for the provider’s first allowance observation.'}
        </p>
        {view.expired && view.current && (
          <div className="provider-meta">
            <span>Last observed {percent(view.current.remainingPercent)} before reset</span>
            <span>Window ended {dateTimeLabel(view.current.resetsAt)}</span>
          </div>
        )}
        {banked && <BankedResetsRow banked={banked} />}
        {/* Past windows, token capacity and evidence live on the provider page. */}
        {onOpen && (
          <button type="button" className="provider-card-link" onClick={onOpen}>
            {view.name} history and evidence
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </article>
    );
  }

  const budget = dailyBudget(view.current, settings, nowMs);
  return (
    <article className={`provider-card ${view.id} ${view.state}`} aria-label={`${view.name} allowance`}>
      <header className="provider-card-head">
        <span className={`swatch ${view.id}`} aria-hidden="true" />
        <div>
          <h2>{view.name}</h2>
          <span title={view.subtitle}>{view.subtitle}</span>
        </div>
        <StatePill state={view.state} />
      </header>
      <div className="provider-card-figures">
        <p className="provider-left">
          <strong>
            {view.estimated ? '~' : ''}
            {Math.round(view.remaining)}%
          </strong>
          <span>{view.estimated ? 'left · estimated' : 'left'}</span>
        </p>
        <p className="provider-reset" title={dateTimeLabel(view.resetAt)}>
          Resets <strong>{whenLabel(view.resetAt, nowMs)}</strong>
          <span>in {resetDistance(view.resetAt)}</span>
        </p>
      </div>
      <RunwayChart view={view} schedule={schedule} size="compact" />
      <ProviderOutcomes view={view} nowMs={nowMs} />
      {budget && <DailyBudgetStrip budget={budget} provider={view.id} />}
      {banked && <BankedResetsRow banked={banked} />}
      {view.stale && (
        <p className="provider-stale">Projected from the last successful reading. A fresh reading is due.</p>
      )}
      <SessionWindows view={view} nowMs={nowMs} />
      <ForecastAdjustmentNotes view={view} />
      {onOpen && (
        <button type="button" className="provider-card-link" onClick={onOpen}>
          {view.name} details{budget ? ' and daily planner' : ''}
          <ChevronRight aria-hidden="true" />
        </button>
      )}
    </article>
  );
}
