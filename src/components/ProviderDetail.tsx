import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, EyeOff, Plug } from 'lucide-react';
import { useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { bankedResetsFor } from '../banked-resets';
import { dailyBudget, forecastReserve, paceLabel, scheduleOf } from '../budget';
import { currentCycleFor, cycleEndedEarly } from '../cycle-match';
import {
  capVisible,
  compactNumber,
  extraUsageAtLastRefresh,
  dateTimeLabel,
  dayDate,
  money,
  percent,
  relativeTime,
  resetDistance,
  shortDate,
  whenLabel,
} from '../lib';
import { providerViews, type ProviderId, type ProviderView } from '../provider-view';
import { snapshotNowMs } from '../snapshot-time';
import type { CycleRow, Settings, Snapshot } from '../types';
import { RunwayChart } from './Charts';
import { DailyBudgetStrip } from './DailyBudgetStrip';
import { SessionWindows } from './ProviderSummary';
import { StatePill } from './StatePill';
import { TokenCapacity } from './TokenCapacity';
import '../styles/provider.css';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleSummary(settings: Settings) {
  const days = [...(settings.activeDays ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const hours = `${String(settings.activeStartHour).padStart(2, '0')}:00–${String(settings.activeEndHour).padStart(2, '0')}:00`;
  const dayText = days.length === 7 ? 'every day' : days.map((day) => DAY_NAMES[day]).join(', ') || 'no days';
  return `active ${hours} ${dayText}`;
}

function provenanceLabel(provenance: string) {
  switch (provenance) {
    case 'official':
      return 'Official provider reading';
    case 'manual-official':
      return 'Manual observation';
    case 'derived-tokens':
      return 'Local estimate from recorded tokens';
    case 'unavailable':
      return 'No reading yet';
    case 'preview':
      return 'Example reading (preview data)';
    default:
      return provenance.replace(/-/g, ' ');
  }
}

/** "about 14 hours before the reset", for a run-out ahead of its window's reset. */
export function gapBeforeReset(runsOutAt: string, resetsAt: string | null) {
  const gap = (Date.parse(resetsAt ?? '') - Date.parse(runsOutAt)) / 3_600_000;
  if (!Number.isFinite(gap) || gap < 1) return 'just before the reset';
  if (gap < 48) return `about ${Math.round(gap)} hour${Math.round(gap) === 1 ? '' : 's'} before the reset`;
  return `about ${Math.round(gap / 24)} days before the reset`;
}

function windowNoun(view: ProviderView) {
  const minutes = view.current?.windowMinutes ?? null;
  if (minutes != null && minutes >= 10_080 && minutes < 20_160) return 'week';
  if (minutes != null && minutes >= 40_320) return 'month';
  return 'window';
}

/** Whether the runway draws an expected path, a heavier range and the fuel tape. */
function hasProjection(view: ProviderView) {
  return view.state !== 'unknown' && view.expectedRemaining != null && view.heavyRemaining != null;
}

/** A status value: the tone's icon, then the words, in the tone's colour. */
function Tone({ tone, children }: { tone: 'risk' | 'critical'; children: string }) {
  const Icon = tone === 'critical' ? AlertOctagon : AlertTriangle;
  return (
    <span className={`pd-tone ${tone}`}>
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

/** "Fable 5.1" for claude-fable-5-1, with or without a date snapshot suffix. */
export function fableVersionName(model: string) {
  const match = /^claude-fable-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(model.trim());
  return match ? `Fable ${match[1]}${match[2] ? `.${match[2]}` : ''}` : model;
}

const POOL_UNAVAILABLE: Record<string, string> = {
  'no-weekly-pool': 'Not checked against Claude weekly: there is no Claude weekly reading yet. Press Refresh.',
  'pool-expired': 'Not checked against Claude weekly: its reading is from before the last reset. Press Refresh.',
  'pool-unknown': 'Not checked against Claude weekly: its reading has no usable figure. Press Refresh.',
  'share-inconsistent':
    'Not checked against Claude weekly: the Fable reading is more than twice the Claude weekly use read with it, so the 50% rule does not match these readings.',
};

/**
 * What happens at the limit that binds, from the extra-usage setting the last
 * Refresh reported. When the Claude weekly limit binds, reaching it stops
 * every model, and switching model does not help.
 */
function afterLimitText(view: ProviderView, snapshot: Snapshot, nowMs: number) {
  const pool = view.current?.sharedPool;
  const weeklyBinds = pool?.status === 'applied' && (pool.binding === 'pool' || pool.bindingAtReset === 'pool');
  const extra = extraUsageAtLastRefresh(snapshot);
  const reset = whenLabel(
    (weeklyBinds && pool?.status === 'applied' ? pool.pool.resetsAt : view.resetAt) ?? null,
    nowMs,
  );
  if (!extra) return 'Press Refresh to check whether extra usage is on.';
  const on = extra.state === 'on';
  const when = extra.observedAt ? `, ${dateTimeLabel(extra.observedAt)}` : '';
  const status =
    extra.state === 'used-up'
      ? `Extra usage was on, but its monthly limit was used up at your last Refresh${when}.`
      : `Extra usage was ${on ? 'on' : 'off'} at your last Refresh${when}.`;
  const rule = weeklyBinds
    ? on
      ? 'At the weekly limit, every Claude model moves to extra usage at API rates, Fable included.'
      : `At the weekly limit, every Claude model stops until ${reset}. Switching model will not help.`
    : on
      ? 'At the Fable limit, Fable continues on extra usage at API rates; other Claude models keep using the weekly limit.'
      : `At the Fable limit, Fable stops until ${reset}; other Claude models keep working.`;
  return `${rule} ${status}`;
}

/**
 * Fable's limit is a ceiling inside the Claude weekly limit, not a pool of
 * its own: every model's use shrinks the week, and Fable can never use more
 * than is left of it. Both limits now and at the reset, which one binds, what
 * happens at it, and this device's Fable activity by version.
 */
function ClaudeWeeklyPanel({
  view,
  snapshot,
  nowMs,
  related,
  onOpenProvider,
}: {
  view: ProviderView;
  snapshot: Snapshot;
  nowMs: number;
  related: ProviderView | undefined;
  onOpenProvider?: (provider: ProviderId) => void;
}) {
  const pool = view.current && !view.expired ? view.current.sharedPool : undefined;
  const versions = snapshot.fableActivity?.models ?? [];
  const currency = snapshot.fableActivity?.currency ?? snapshot.settings.currency;
  const atReset = (value: number | null | undefined) => (value == null ? '—' : percent(Math.max(0, value)));
  return (
    <section className="pnl pd-panel pd-related pd-pool" aria-labelledby="related-heading">
      <div className="pd-panel-head">
        <h2 id="related-heading">Claude weekly limit</h2>
        <p>Fable draws on your Claude weekly limit: up to half of it, and never more than is left.</p>
      </div>
      {pool?.status === 'applied' ? (
        <>
          <table className="pd-pool-table">
            <caption className="sr-only">Fable and Claude weekly limits, now and expected at the reset</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Limit</span>
                </th>
                <th scope="col">Now</th>
                <th scope="col">At reset</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Fable limit</th>
                <td>{percent(pool.capRemaining)}</td>
                <td>{atReset(pool.cap.expectedRemaining)}</td>
              </tr>
              <tr>
                <th scope="row">
                  <span className="swatch claude" aria-hidden="true" /> Claude weekly
                  {Math.abs(Date.parse(pool.pool.resetsAt) - Date.parse(view.resetAt ?? '')) > 60_000 && (
                    <small>{` · resets ${whenLabel(pool.pool.resetsAt, nowMs)}`}</small>
                  )}
                </th>
                <td>{percent(pool.poolRemaining)}</td>
                <td>{atReset(pool.pool.expectedRemaining)}</td>
              </tr>
              <tr>
                <th scope="row">Claude weekly, in Fable terms</th>
                <td>{percent(Math.min(100, pool.poolAsFable))}</td>
                <td>
                  {atReset(
                    pool.pool.expectedRemaining == null
                      ? null
                      : Math.min(100, pool.pool.expectedRemaining / pool.share),
                  )}
                </td>
              </tr>
              <tr className="pd-pool-usable">
                <th scope="row">Usable Fable</th>
                <td>{percent(pool.usableRemaining)}</td>
                <td>{view.expectedRemaining == null ? '—' : percent(view.expectedRemaining)}</td>
              </tr>
            </tbody>
          </table>
          <p
            className={`pd-pool-binding${pool.binding === 'pool' || pool.bindingAtReset === 'pool' ? ' limited' : ''}`}
          >
            {pool.binding === 'pool'
              ? 'Limited now by Claude weekly.'
              : pool.bindingAtReset === 'pool'
                ? pool.pool.exhaustsAt
                  ? `Limited by the Fable limit now; Claude weekly is expected to run out ${whenLabel(pool.pool.exhaustsAt, nowMs)} and cap Fable first.`
                  : 'Limited by the Fable limit now; Claude weekly is expected to cap Fable before the reset.'
                : 'Limited by the Fable limit; Claude weekly has room to spare.'}
          </p>
          <p className="pd-detail">1% of Claude weekly = 2% of the Fable limit (Anthropic’s 50% rule).</p>
        </>
      ) : pool?.status === 'unavailable' ? (
        <p className="pd-detail">{POOL_UNAVAILABLE[pool.reason] ?? POOL_UNAVAILABLE['pool-unknown']}</p>
      ) : null}
      {view.current && !view.expired && <p className="pd-detail">{afterLimitText(view, snapshot, nowMs)}</p>}
      {related && (
        <button
          type="button"
          className="pd-related-row"
          onClick={() => onOpenProvider?.(related.id)}
          disabled={!onOpenProvider}
        >
          <span className="pd-related-name">
            <span className={`swatch ${related.id}`} aria-hidden="true" />
            <span>
              <strong>{related.name}</strong>
              {related.remaining != null && (
                <span className="pd-related-left">{` · ${Math.round(related.remaining)}% left`}</span>
              )}
            </span>
          </span>
          <StatePill state={related.state} />
          <ChevronRight aria-hidden="true" />
        </button>
      )}
      {versions.length > 0 && (
        <div className="pd-pool-versions">
          <table className="pd-pool-table">
            <caption>
              Both versions share one Fable limit. This split is this device’s activity this week, not allowance.
            </caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Requests</th>
                <th scope="col">Tokens</th>
                <th scope="col">API-equivalent</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((entry) => (
                <tr key={entry.model}>
                  <th scope="row">{fableVersionName(entry.model)}</th>
                  <td>{compactNumber(entry.requests)}</td>
                  <td>{compactNumber(entry.totalTokens)}</td>
                  <td>{entry.covered ? money(entry.cost, currency) : 'Unpriced'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pd-detail">
            Fable 5.1 cache reads cost less at API prices; Anthropic has not said whether they use less of the limit.
          </p>
        </div>
      )}
    </section>
  );
}

/** Challenge-response row: LABEL ······ VALUE, the leader drawn by CSS. */
function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `cr ${className}` : 'cr'}>
      <dt className="lbl">{label}</dt>
      <span className="lead" aria-hidden="true" />
      <dd>{children}</dd>
    </div>
  );
}

/** Expected and heavier-week outcomes at the reset, as challenge-response rows under the runway. */
function RunwayOutcomes({ view, nowMs }: { view: ProviderView; nowMs: number }) {
  const forecast = view.current?.forecast;
  if (!forecast || view.expectedRemaining == null) {
    return <p className="pd-learning">Learning from recent usage before it forecasts the reset.</p>;
  }
  return (
    <dl className="pd-outcomes">
      <Row label="Expected at reset">
        {forecast.exhaustsAt ? (
          <Tone tone="critical">{`Runs out ${whenLabel(forecast.exhaustsAt, nowMs)}`}</Tone>
        ) : (
          `${percent(view.expectedRemaining)} left`
        )}
      </Row>
      {view.heavyRemaining != null && (
        <Row label="Heavier week">
          {forecast.heavyExhaustsAt ? (
            <Tone tone="risk">{`Runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`}</Tone>
          ) : (
            `Leaves ${percent(view.heavyRemaining)}`
          )}
        </Row>
      )}
    </dl>
  );
}

/** The window in progress, then past windows newest first, each with its peak and value. */
function CycleTable({ view, snapshot }: { view: ProviderView; snapshot: Snapshot }) {
  const quota = view.quota && !view.quota.forecast.expired ? view.quota : null;
  const current = currentCycleFor(view, snapshot);
  const past = (snapshot.cycles[view.id] ?? []).filter((row) => row !== current && !row.current);
  const forecast = quota?.forecast;
  const expectedUsed = forecast?.expectedRemaining == null ? null : 100 - Math.max(0, forecast.expectedRemaining);
  const heavyUsed = forecast?.heavyRemaining == null ? null : 100 - Math.max(0, forecast.heavyRemaining);
  const bar = (used: number) => `${Math.max(0, Math.min(100, used)).toFixed(1)}%`;
  const pastRow = (row: CycleRow) => {
    const endedEarly = cycleEndedEarly(row);
    return (
      <tr key={`${row.resetsAt}:${row.windowMinutes}`}>
        <td>
          <strong>{dayDate(row.endsAt ?? row.resetsAt)}</strong>
          {endedEarly && <small>Reset early</small>}
        </td>
        <td>
          <span className="pd-meter" role="img" aria-label={`${percent(row.peakUsedPercent)} of the allowance used`}>
            <i className="used" style={{ width: bar(row.peakUsedPercent) }} />
          </span>
        </td>
        <td className="num peak">{percent(row.peakUsedPercent)}</td>
        <td className="num">{money(row.cost, snapshot.costs.currency)}</td>
        <td className="forecast-outcome ended">Ended</td>
      </tr>
    );
  };
  return (
    <>
      <div className="pd-table-scroll">
        <table className="cycle-detail-table">
          <thead>
            <tr>
              <th>Window ends</th>
              <th>Allowance used</th>
              <th className="num">Peak used</th>
              <th className="num">API-equivalent</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            <tr className="current">
              <td>
                <strong>{quota ? dateTimeLabel(quota.resetsAt) : view.name}</strong>
                <small>{quota ? `${quota.bucketName} · in progress` : 'Current window'}</small>
              </td>
              <td>
                {quota && current ? (
                  <span
                    className="pd-meter"
                    role="img"
                    aria-label={`${percent(current.peakUsedPercent)} used so far${expectedUsed == null ? '' : `; ${percent(expectedUsed)} expected by reset`}`}
                  >
                    {heavyUsed != null && <i className="heavier" style={{ width: bar(heavyUsed) }} />}
                    {expectedUsed != null && <i className="expected" style={{ width: bar(expectedUsed) }} />}
                    <i className="used" style={{ width: bar(current.peakUsedPercent) }} />
                  </span>
                ) : (
                  <span className="pd-meter empty" aria-hidden="true" />
                )}
              </td>
              <td className="num peak">{quota && current ? percent(current.peakUsedPercent) : '—'}</td>
              <td className="num">{quota && current ? money(current.cost, snapshot.costs.currency) : '—'}</td>
              <td className={`forecast-outcome ${forecast?.state ?? 'unknown'}`}>
                {!quota
                  ? 'Awaiting current reading'
                  : forecast?.expectedRemaining == null
                    ? 'Learning'
                    : quota.sharedPool?.status === 'applied' && quota.sharedPool.cappedAtReset === 'pool'
                      ? `${percent(forecast.expectedRemaining)} usable at reset, capped by Claude weekly`
                      : `${percent(forecast.expectedRemaining)} expected at reset`}
              </td>
            </tr>
            {past.map(pastRow)}
          </tbody>
        </table>
      </div>
      <ul className="pd-bar-key" aria-label="Bar key">
        <li>
          <i className="used" aria-hidden="true" />
          Used
        </li>
        {expectedUsed != null && (
          <li>
            <i className="expected" aria-hidden="true" />
            Expected by reset
          </li>
        )}
        {heavyUsed != null && (
          <li>
            <i className="heavier" aria-hidden="true" />
            Heavier week
          </li>
        )}
        <li>
          <i className="limit" aria-hidden="true" />
          100% of the allowance
        </li>
      </ul>
    </>
  );
}

/** When Claude weekly, not the Fable limit, sets Fable's budget, the figures are that budget in Fable terms. */
export function weeklyBudgetNote(view: ProviderView) {
  const pool = view.current?.sharedPool;
  if (view.id !== 'fable' || pool?.status !== 'applied' || pool.bindingAtReset !== 'pool') return null;
  return 'Set by Claude weekly and counted in Fable terms: each 1% of Claude weekly any model uses removes 2% of Fable.';
}

function Planner({
  view,
  snapshot,
  draft,
  onDraft,
  onSaveReserve,
  onOpenSettings,
}: {
  view: ProviderView;
  snapshot: Snapshot;
  /** A reserve being tried on this page; the page's chart draws it too. */
  draft: number | null;
  onDraft: Dispatch<SetStateAction<number | null>>;
  onSaveReserve?: (percent: number) => Promise<boolean> | void;
  onOpenSettings?: (section: string) => void;
}) {
  const saved = Math.round(Number(snapshot.settings.reservePercent) || 0);
  const setDraft = onDraft;
  const [saving, setSaving] = useState(false);
  const reserve = draft ?? saved;
  const nowMs = snapshotNowMs(snapshot);
  const budget = dailyBudget(view.current, snapshot.settings, nowMs, reserve);
  const reset = view.resetAt ? whenLabel(view.resetAt, nowMs) : 'the';
  if (!budget) {
    return (
      <section className="pnl pd-panel pd-planner" aria-labelledby="planner-heading">
        <div className="pd-panel-head">
          <h2 id="planner-heading">Daily budget</h2>
          <p>
            A daily budget needs a forecast with enough history and at least one full active day before the reset. The
            runway still shows what is expected to remain.
          </p>
        </div>
      </section>
    );
  }
  const fits = budget.expectedFits && (budget.heavier == null || budget.heavierFits);
  const expectedOver = !budget.expectedFits;
  const tone = fits ? 'safe' : expectedOver ? 'critical' : 'risk';
  const VerdictIcon = fits ? CheckCircle2 : expectedOver ? AlertOctagon : AlertTriangle;
  const heavyEnds = view.current?.forecast.heavyExhaustsAt;
  const verdictTitle = fits
    ? 'Fits, even in a heavier week'
    : expectedOver
      ? reserve > 0
        ? 'Even a typical week would dip into the reserve'
        : 'Even a typical week would run out'
      : 'A typical week fits; a heavier one doesn’t';
  const verdictText = fits
    ? `Both paces stay under your budget through the ${reset} reset.`
    : expectedOver
      ? reserve > 0
        ? 'Lower the reserve, or use it more lightly until the reset.'
        : `Use ${view.name} more lightly until the reset to keep some allowance.`
      : reserve > 0
        ? `At the heavier pace you would dip into your ${Math.round(budget.reserve)}% reserve before the reset.`
        : heavyEnds
          ? `At the heavier pace ${view.name} runs out ${whenLabel(heavyEnds, nowMs)}, ${gapBeforeReset(heavyEnds, view.resetAt)}.`
          : 'At the heavier pace the allowance would be used up before the reset.';
  const unsaved = draft != null && draft !== saved;
  return (
    // Releasing the hidden window would discard an unsaved reserve, so the page
    // refuses it while one is shown and while a save is pending. The guard sits
    // on the planner itself: moving the slider back to the saved value during a
    // save hides the unsaved-reserve block before the save has settled.
    <section
      className="pnl pd-panel pd-planner"
      aria-labelledby="planner-heading"
      data-keep-awake={unsaved || saving ? 'true' : undefined}
      aria-busy={saving}
    >
      <div className="pd-panel-head">
        <h2 id="planner-heading">Daily budget</h2>
        <p>
          How much {view.name} you can use per active day and still reach the {reset} reset.
        </p>
      </div>
      <p className="pd-figure">
        <strong>{paceLabel(budget.budget)}</strong> <span>per active day</span>
      </p>
      {weeklyBudgetNote(view) && <p className="pd-detail">{weeklyBudgetNote(view)}</p>}
      <div className="pd-gauge">
        {budget.reserve > 0 && (
          <p className="pd-gauge-label">{`Daily budget, keeping ${Math.round(budget.reserve)}% in reserve`}</p>
        )}
        <DailyBudgetStrip budget={budget} provider={view.id} heading={false} />
      </div>
      <div className="pd-reserve">
        <div className="pd-reserve-head">
          <label htmlFor="planner-reserve">Keep in reserve</label>
          <output htmlFor="planner-reserve">
            <strong>{`${reserve}%`}</strong> of the allowance
          </output>
        </div>
        <input
          id="planner-reserve"
          type="range"
          min={0}
          max={50}
          step={1}
          aria-valuetext={`${reserve}% of the allowance kept in reserve`}
          value={reserve}
          onChange={(event) => setDraft(Number(event.target.value))}
        />
        <div className="pd-scale" aria-hidden="true">
          <span>0%</span>
          <span>25%</span>
          <span>50%</span>
        </div>
      </div>
      <div className={`pd-verdict ${tone}`} role="status">
        <VerdictIcon aria-hidden="true" />
        <div>
          <strong>{verdictTitle}</strong>
          <span>{verdictText}</span>
        </div>
      </div>
      {unsaved && (
        <div className="pd-save">
          <span>{`Trying ${draft}%. Forecasts still use ${saved}%.`}</span>
          <div className="pd-save-keys">
            {onSaveReserve && (
              <button
                type="button"
                className="btn btn-p"
                disabled={saving}
                onClick={async () => {
                  const submitted = draft;
                  setSaving(true);
                  try {
                    // The slider stays live during the save: clear only the
                    // value that was saved, never a newer choice.
                    if ((await onSaveReserve(submitted)) !== false)
                      setDraft((current) => (current === submitted ? null : current));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {`Use ${draft}% for all forecasts`}
              </button>
            )}
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Reset
            </button>
          </div>
        </div>
      )}
      <p className="pd-note">
        {Math.round(budget.activeHoursLeft)} active hours left · {scheduleSummary(snapshot.settings)}. Use outside
        active hours counts too.{' '}
        {onOpenSettings && (
          <button type="button" className="lnk" onClick={() => onOpenSettings('forecast')}>
            Edit schedule
          </button>
        )}
      </p>
    </section>
  );
}

export function ProviderDetail({
  snapshot,
  provider,
  onBack,
  onOpenProvider,
  onOpenSettings,
  onSaveReserve,
}: {
  snapshot: Snapshot;
  provider: ProviderId;
  onBack: () => void;
  onOpenProvider?: (provider: ProviderId) => void;
  onOpenSettings?: (section: string) => void;
  onSaveReserve?: (percent: number) => Promise<boolean> | void;
}) {
  const views = providerViews(snapshot);
  const view = views.find((entry) => entry.id === provider);
  const [showHeavy, setShowHeavy] = useState(true);
  const savedReserve = Math.round(Number(snapshot.settings.reservePercent) || 0);
  const [reserveDraft, setReserveDraft] = useState<number | null>(null);
  const { activeDays, activeStartHour, activeEndHour } = snapshot.settings;
  const schedule = useMemo(
    () => scheduleOf({ activeDays, activeStartHour, activeEndHour }),
    [activeDays, activeStartHour, activeEndHour],
  );
  const nowMs = snapshotNowMs(snapshot);

  if (!view) {
    return (
      <main
        className="page detail-page pd-hidden"
        id="panel-overview"
        role="tabpanel"
        aria-labelledby="tab-overview"
        tabIndex={-1}
      >
        <section className="state-panel">
          <span className="state-panel-icon">
            <EyeOff aria-hidden="true" />
          </span>
          <div className="state-panel-body">
            <h1>This subscription is hidden</h1>
            <p>Show it again under Settings → Subscriptions. Its saved history is kept.</p>
            <button type="button" className="btn" onClick={onBack}>
              Back to Overview
            </button>
          </div>
        </section>
      </main>
    );
  }

  const forecast = view.current && !view.expired ? view.current.forecast : null;
  const projection = Boolean(forecast) && hasProjection(view);
  const related =
    view.id === 'fable'
      ? views.find((entry) => entry.id === 'claude')
      : view.id === 'claude'
        ? views.find((entry) => entry.id === 'fable' && entry.current)
        : undefined;
  const source = view.source;
  const banked = bankedResetsFor(view.id, snapshot, nowMs);

  return (
    <main
      className="page detail-page"
      data-provider={view.id}
      id="panel-overview"
      role="tabpanel"
      aria-labelledby="tab-overview"
      tabIndex={-1}
    >
      <header className={`pnl pd-head ${view.id}`}>
        <div className="pd-title">
          <span className={`swatch ${view.id}`} aria-hidden="true" />
          <div>
            <div className="pd-name">
              <h1>{view.name}</h1>
              <StatePill
                state={view.state}
                label={view.expired ? 'Needs reading' : view.current ? undefined : 'Learning'}
              />
            </div>
            <p>{view.subtitle}</p>
          </div>
        </div>
        {view.current && !view.expired && view.remaining != null ? (
          <dl className="pd-figures">
            <div>
              <dt className="lbl">{view.poolLimited ? 'Usable now' : 'Left now'}</dt>
              <dd className="pd-big">{`${view.estimated ? '~' : ''}${Math.round(view.remaining)}%`}</dd>
              {view.poolLimited && view.current.sharedPool?.status === 'applied' && (
                <dd className="pd-sub">{`Fable limit ${percent(view.current.sharedPool.capRemaining)} left`}</dd>
              )}
            </div>
            <div>
              <dt className="lbl">Expected at reset</dt>
              {forecast?.exhaustsAt ? (
                <dd className="critical">
                  <Tone tone="critical">{`Runs out ${whenLabel(forecast.exhaustsAt, nowMs)}`}</Tone>
                </dd>
              ) : (
                <dd className="pd-big">{view.expectedRemaining == null ? '—' : percent(view.expectedRemaining)}</dd>
              )}
            </div>
            <div>
              <dt className="lbl">Heavier week</dt>
              <dd className={forecast?.heavyExhaustsAt ? 'risk' : undefined}>
                {forecast?.heavyExhaustsAt ? (
                  <Tone tone="risk">{`Runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`}</Tone>
                ) : view.heavyRemaining == null ? (
                  'Learning'
                ) : (
                  `Leaves ${percent(view.heavyRemaining)}`
                )}
              </dd>
            </div>
            <div>
              <dt className="lbl">Resets</dt>
              <dd title={`in ${resetDistance(view.resetAt)}`}>{dateTimeLabel(view.resetAt)}</dd>
              <dd className="pd-sub">{`in ${resetDistance(view.resetAt)}`}</dd>
            </div>
          </dl>
        ) : (
          <div className="pd-waiting">
            <p>
              {view.expired
                ? 'The last allowance window ended. Waiting for a new provider reading.'
                : 'Waiting for the provider’s first allowance observation.'}
            </p>
            {view.expired && view.current && (
              <dl>
                <Row label="Last observed">{`${percent(view.current.remainingPercent)} before reset`}</Row>
                <Row label="Window ended">{dateTimeLabel(view.current.resetsAt)}</Row>
              </dl>
            )}
          </div>
        )}
      </header>

      <div className="pd-grid">
        <div className="pd-main">
          {view.current && !view.expired && (
            <section className="pnl pd-panel pd-runway" aria-labelledby="runway-heading">
              <div className="pd-panel-head has-aside">
                <div>
                  <h2 id="runway-heading">This {windowNoun(view)}’s runway</h2>
                  <p>
                    Use so far, then the expected path and a heavier-week range to the reset. Hover to read any hour.
                  </p>
                </div>
                {forecast && view.heavyRemaining != null && (
                  <button
                    type="button"
                    className={`btn pd-toggle${showHeavy ? ' btn-on' : ''}`}
                    aria-pressed={showHeavy}
                    onClick={() => setShowHeavy((value) => !value)}
                  >
                    Heavier-week range
                  </button>
                )}
              </div>
              <ul className="runway-key" aria-label="Chart key">
                <li>
                  <i className={`key-observed ${view.id}`} aria-hidden="true" />
                  Observed
                </li>
                {projection && (
                  <li>
                    <i className={`key-expected ${view.id}`} aria-hidden="true" />
                    Expected
                  </li>
                )}
                {projection && showHeavy && (
                  <li>
                    <i className={`key-band ${view.id}`} aria-hidden="true" />
                    Heavier-week range
                  </li>
                )}
                {capVisible(view.current) && (
                  <li>
                    <i className="key-cap" aria-hidden="true" />
                    Above the Claude weekly cap: not usable
                  </li>
                )}
                <li>
                  <i className="key-inactive" aria-hidden="true" />
                  Outside active hours
                </li>
                {projection && (
                  <>
                    <li>
                      <i className={`key-tape-reset ${view.id}`} aria-hidden="true" />
                      Left at reset
                    </li>
                    <li>
                      <i className={`key-tape-used ${view.id}`} aria-hidden="true" />
                      Likely used before reset
                    </li>
                  </>
                )}
              </ul>
              <RunwayChart
                view={view}
                schedule={schedule}
                size="full"
                showHeavy={showHeavy}
                reserve={forecastReserve(view.current, reserveDraft ?? savedReserve)}
              />
              <RunwayOutcomes view={view} nowMs={nowMs} />
            </section>
          )}

          {view.secondaryWindows.length > 0 && (
            <section className="pnl pd-panel pd-windows" aria-labelledby="windows-heading">
              <div className="pd-panel-head">
                <h2 id="windows-heading">Other windows</h2>
              </div>
              <SessionWindows view={view} nowMs={nowMs} />
            </section>
          )}

          <section className="pnl pd-panel pd-cycles" aria-labelledby="cycles-heading">
            <div className="pd-panel-head">
              <h2 id="cycles-heading">Past {windowNoun(view)}s</h2>
              <p>Peak share of the allowance used in each window, and what those tokens are worth at today’s prices.</p>
            </div>
            <CycleTable view={view} snapshot={snapshot} />
          </section>
        </div>

        <aside className="pd-aside" aria-label={`${view.name} planning and evidence`}>
          {view.current && !view.expired && (
            <Planner
              view={view}
              snapshot={snapshot}
              draft={reserveDraft}
              onDraft={setReserveDraft}
              onSaveReserve={onSaveReserve}
              onOpenSettings={onOpenSettings}
            />
          )}

          {view.id === 'fable' ? (
            <ClaudeWeeklyPanel
              view={view}
              snapshot={snapshot}
              nowMs={nowMs}
              related={related}
              onOpenProvider={onOpenProvider}
            />
          ) : (
            related && (
              <section className="pnl pd-panel pd-related" aria-labelledby="related-heading">
                <div className="pd-panel-head">
                  <h2 id="related-heading">Related allowance</h2>
                  <p>Fable can use up to half of this weekly limit, and every Claude model draws on the same limit.</p>
                </div>
                <button
                  type="button"
                  className="pd-related-row"
                  onClick={() => onOpenProvider?.(related.id)}
                  disabled={!onOpenProvider}
                >
                  <span className="pd-related-name">
                    <span className={`swatch ${related.id}`} aria-hidden="true" />
                    <span>
                      <strong>{related.name}</strong>
                      {related.remaining != null && (
                        <span className="pd-related-left">{` · ${Math.round(related.remaining)}% ${related.poolLimited ? 'usable' : 'left'}`}</span>
                      )}
                    </span>
                  </span>
                  <StatePill state={related.state} />
                  <ChevronRight aria-hidden="true" />
                </button>
              </section>
            )
          )}

          <section className="pnl pd-panel pd-evidence" aria-labelledby="evidence-heading">
            <div className="pd-evidence-head">
              <h2 id="evidence-heading">Evidence</h2>
              <Plug aria-hidden="true" />
            </div>
            <dl className="pd-rows">
              <Row label="Reading">{provenanceLabel(view.provenance)}</Row>
              <Row label="Last reading">
                {view.current ? (
                  <time
                    dateTime={view.current.evidenceAt ?? view.current.observedAt}
                    title={shortDate(view.current.evidenceAt ?? view.current.observedAt)}
                  >
                    {relativeTime(view.current.evidenceAt ?? view.current.observedAt, nowMs)}
                  </time>
                ) : (
                  'None yet'
                )}
              </Row>
              {source && (
                <>
                  <Row label="Last scan">
                    {source.last_attempt_at ? (
                      <time dateTime={source.last_attempt_at} title={shortDate(source.last_attempt_at)}>
                        {relativeTime(source.last_attempt_at, nowMs)}
                      </time>
                    ) : (
                      'Not yet'
                    )}
                    {` · ${source.status}`}
                  </Row>
                  <Row label="Last good">{source.last_success_at ? shortDate(source.last_success_at) : 'Not yet'}</Row>
                </>
              )}
              {banked && (
                <Row label="Banked resets" className="pd-banked">
                  {banked.label}
                  <small>{banked.note}</small>
                </Row>
              )}
              {forecast && forecast.learnedDays > 0 && (
                <Row label="Learned from">
                  {`${forecast.learnedDays} day${forecast.learnedDays === 1 ? '' : 's'} · ${percent(forecast.confidence * 100)} confidence`}
                </Row>
              )}
            </dl>
            {view.notes.length > 0 && (
              <ul className="pd-notes">
                {view.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {source?.status_detail && <p className="pd-detail">{source.status_detail}</p>}
            <p className="pd-assurance">Calculated on this PC from your own records.</p>
          </section>
        </aside>
      </div>

      <TokenCapacity snapshot={snapshot} provider={view.id} />
    </main>
  );
}
