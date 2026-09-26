import {
  AlertOctagon,
  AlertTriangle,
  ChevronRight,
  CircleDashed,
  Hourglass,
  Info,
  Layers,
  RefreshCw,
} from 'lucide-react';
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
  type ExtraUsageState,
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
        <Info aria-hidden="true" />
        <span>
          <span>
            <strong>{window.bucketName}:</strong> Heavy usage before an early reset has less influence on the expected
            forecast.
          </span>
          <small>Recorded usage is kept; the heavier case still includes it.</small>
        </span>
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
        <strong>{`${isEstimated(window) ? '~' : ''}${Math.round(remaining)}%`}</strong>
        <span>{allowanceWindowLabel(window)}</span>
        <small title={dateTimeLabel(window.resetsAt)}>
          {`${outlook} · resets in ${resetDistance(window.resetsAt)}`}
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
          <summary>
            <ChevronRight aria-hidden="true" />
            Separate model allowances
          </summary>
          <p>These apply only to the named model and are separate from your main Codex allowance.</p>
          {modelWindows.map(renderWindow)}
        </details>
      )}
    </>
  );
}

/**
 * Fable's limit sits inside the Claude weekly pool: every model's use shrinks
 * the pool, and Fable can never use more than is left of it. Says which of
 * the two is the tighter one, with both figures.
 */
export function SharedPoolRow({
  view,
  nowMs,
  extraUsage = null,
}: {
  view: ProviderView;
  nowMs: number;
  /** The extra-usage setting from the last Refresh, which decides what reaching the week means. */
  extraUsage?: ExtraUsageState | null;
}) {
  const pool = view.current?.sharedPool;
  if (pool?.status !== 'applied' || view.expired) return null;
  const limitedNow = pool.binding === 'pool';
  const limitedLater = !limitedNow && pool.bindingAtReset === 'pool';
  const claude = `Claude weekly ${percent(pool.poolRemaining)} left`;
  let title: string;
  let detail: string | null = null;
  if (limitedNow && pool.usableRemaining <= 0) {
    title = 'Claude weekly limit reached';
    const reset = whenLabel(pool.pool.resetsAt, nowMs);
    detail =
      extraUsage?.state === 'on'
        ? 'Fable continues with every other Claude model on extra usage at API rates (on at your last Refresh).'
        : extraUsage
          ? `Fable is paused with every other Claude model until ${reset}.`
          : `Fable pauses with every other Claude model until ${reset} unless extra usage is on. Press Refresh to check.`;
  } else if (limitedNow) {
    title = 'Capped by Claude weekly';
    detail = `${claude} = ${percent(pool.usableRemaining)} of the Fable limit. Fable limit itself: ${percent(pool.capRemaining)} left.`;
  } else if (limitedLater) {
    title = 'Claude weekly will cap Fable before reset';
    const own =
      pool.cap.expectedRemaining == null
        ? ''
        : `; Fable’s own limit would leave ${percent(pool.cap.expectedRemaining)}`;
    detail =
      pool.pool.expectedRemaining == null
        ? `${claude}, shared by every Claude model.`
        : `Expected to fall to ${percent(pool.pool.expectedRemaining)} (= ${percent(Math.min(100, pool.pool.expectedRemaining / pool.share))} of Fable) by ${whenLabel(pool.pool.resetsAt, nowMs)}${own}.`;
  } else {
    title = `Within Claude weekly (${percent(pool.poolRemaining)} left)`;
  }
  return (
    <p className={`provider-pool${limitedNow || limitedLater ? ' limited' : ''}`}>
      <Layers aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </p>
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
    return (
      <p className="provider-learning">
        <CircleDashed aria-hidden="true" />
        <span>Learning from recent usage before it forecasts the reset.</span>
      </p>
    );
  }
  return (
    <dl className="provider-outcomes">
      <div>
        <dt>Expected at reset</dt>
        <dd className={forecast.exhaustsAt ? 'critical' : undefined}>
          {forecast.exhaustsAt && <AlertOctagon aria-hidden="true" />}
          <span>
            {forecast.exhaustsAt
              ? `Runs out ${whenLabel(forecast.exhaustsAt, nowMs)}`
              : `${percent(view.expectedRemaining)} left`}
          </span>
        </dd>
      </div>
      {view.heavyRemaining != null && (
        <div>
          <dt>Heavier week</dt>
          <dd className={forecast.heavyExhaustsAt ? 'risk' : undefined}>
            {forecast.heavyExhaustsAt && <AlertTriangle aria-hidden="true" />}
            <span>
              {forecast.heavyExhaustsAt
                ? `Runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`
                : `Leaves ${percent(view.heavyRemaining)}`}
            </span>
          </dd>
        </div>
      )}
    </dl>
  );
}

/** The card's heading: the provider's swatch, name and plan, and its state as an icon and a word. */
function CardHead({ view, pill }: { view: ProviderView; pill: React.ReactNode }) {
  return (
    <header className="provider-card-head">
      <span className={`swatch lg ${view.id}`} aria-hidden="true" />
      <div>
        <h2>{view.name}</h2>
        <span title={view.subtitle}>{view.subtitle}</span>
      </div>
      {pill}
    </header>
  );
}

export function ProviderSummary({
  view,
  nowMs,
  settings = DEFAULT_SCHEDULE,
  banked = null,
  extraUsage = null,
  onOpen,
}: {
  view: ProviderView;
  nowMs: number;
  settings?: ScheduleSettings;
  /** Banked or free resets for this provider, shown in the card's spare space. */
  banked?: BankedResets | null;
  /** Fable only: whether extra usage was on at the last Refresh. */
  extraUsage?: ExtraUsageState | null;
  onOpen?: () => void;
}) {
  const { activeDays, activeStartHour, activeEndHour } = settings;
  const schedule = useMemo(
    () => scheduleOf({ activeDays, activeStartHour, activeEndHour }),
    [activeDays, activeStartHour, activeEndHour],
  );

  if (!view.current || view.remaining == null) {
    const last = view.expired && view.current ? Math.max(0, Math.min(100, view.current.remainingPercent)) : null;
    return (
      <article className={`provider-card pnl ${view.id} unknown`} aria-label={`${view.name} allowance`}>
        <CardHead
          view={view}
          pill={<StatePill state="unknown" label={view.expired ? 'Needs reading' : 'Learning'} />}
        />
        <p className="provider-empty">
          {view.expired
            ? 'The last allowance window ended. Waiting for a new provider reading.'
            : 'Waiting for the provider’s first allowance observation.'}
        </p>
        {view.current && last != null && (
          <>
            <dl className="provider-meta">
              <div className="cr">
                <dt>Last observed</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{`${percent(view.current.remainingPercent)} before reset`}</dd>
              </div>
              <div className="cr">
                <dt>Window ended</dt>
                <span className="lead" aria-hidden="true" />
                <dd>{dateTimeLabel(view.current.resetsAt)}</dd>
              </div>
            </dl>
            {/* History only: a grey bar in a dashed well, never a current balance. */}
            <div
              className="provider-history"
              role="img"
              aria-label={`History only: last observed ${percent(view.current.remainingPercent)} remaining before the window ended ${dateTimeLabel(view.current.resetsAt)}. Not a live balance.`}
            >
              <i style={{ width: `${last.toFixed(2)}%` }} />
            </div>
          </>
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
  // The reserve the forecasts keep, drawn as the bingo line across runway and tape.
  const reserve = Math.max(0, Math.min(90, view.current.forecast.reservePercent ?? settings.reservePercent ?? 0));
  return (
    <article className={`provider-card pnl ${view.id} ${view.state}`} aria-label={`${view.name} allowance`}>
      <CardHead view={view} pill={<StatePill state={view.state} />} />
      <div className="provider-card-figures">
        <div className="provider-left">
          <span className="lbl">{view.poolLimited ? 'Usable now' : 'Left now'}</span>
          <p>
            <strong>{`${view.estimated ? '~' : ''}${Math.round(view.remaining)}%`}</strong>
            <span>{[view.poolLimited ? 'usable' : 'left', ...(view.estimated ? ['estimated'] : [])].join(' · ')}</span>
          </p>
        </div>
        <div className="provider-reset">
          <span className="lbl">Resets</span>
          <strong title={dateTimeLabel(view.resetAt)}>{whenLabel(view.resetAt, nowMs)}</strong>
          <span>{`in ${resetDistance(view.resetAt)}`}</span>
        </div>
      </div>
      <RunwayChart view={view} schedule={schedule} size="compact" reserve={reserve} />
      <ProviderOutcomes view={view} nowMs={nowMs} />
      {/* Below the runway, so every card's runway sits at the same height. */}
      <SharedPoolRow view={view} nowMs={nowMs} extraUsage={extraUsage} />
      {budget && (
        <DailyBudgetStrip
          budget={budget}
          provider={view.id}
          note={
            view.current.sharedPool?.status === 'applied' && view.current.sharedPool.bindingAtReset === 'pool'
              ? 'Set by Claude weekly, in Fable terms: every Claude model draws on it.'
              : null
          }
        />
      )}
      {banked && <BankedResetsRow banked={banked} />}
      {view.stale && (
        <p className="provider-stale">
          <RefreshCw aria-hidden="true" />
          <span>Projected from the last successful reading. A fresh reading is due.</span>
        </p>
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
