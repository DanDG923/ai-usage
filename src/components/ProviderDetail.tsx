import { AlertTriangle, CheckCircle2, ChevronRight, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { dailyBudget, paceLabel, scheduleOf } from '../budget';
import { currentCycleFor } from '../cycle-match';
import { dateTimeLabel, dayDate, money, percent, relativeTime, resetDistance, shortDate, whenLabel } from '../lib';
import { providerViews, type ProviderId, type ProviderView } from '../provider-view';
import type { CycleRow, Settings, Snapshot } from '../types';
import { RunwayChart } from './Charts';
import { DailyBudgetStrip } from './DailyBudgetStrip';
import { ProviderOutcomes, SessionWindows } from './ProviderSummary';
import { StatePill } from './StatePill';
import { TokenCapacity } from './TokenCapacity';
import '../overview.css';

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
    const endedEarly = row.endsAt && Math.abs(Date.parse(row.endsAt) - Date.parse(row.resetsAt)) > 60_000;
    return (
      <tr key={`${row.resetsAt}:${row.windowMinutes}`}>
        <td>
          <strong>{dayDate(row.endsAt ?? row.resetsAt)}</strong>
          {endedEarly && <small>Reset early</small>}
        </td>
        <td>
          <span className="cycle-meter" role="img" aria-label={`${percent(row.peakUsedPercent)} of the allowance used`}>
            <i className="used" style={{ width: bar(row.peakUsedPercent) }} />
          </span>
        </td>
        <td className="num">{percent(row.peakUsedPercent)}</td>
        <td className="num">{money(row.cost, snapshot.costs.currency)}</td>
        <td className="forecast-outcome ended">Ended</td>
      </tr>
    );
  };
  return (
    <div className="table-scroll compact-table-scroll">
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
                  className="cycle-meter"
                  role="img"
                  aria-label={`${percent(current.peakUsedPercent)} used so far${expectedUsed == null ? '' : `; ${percent(expectedUsed)} expected by reset`}`}
                >
                  {heavyUsed != null && <i className="heavier" style={{ width: bar(heavyUsed) }} />}
                  {expectedUsed != null && <i className="expected" style={{ width: bar(expectedUsed) }} />}
                  <i className="used" style={{ width: bar(current.peakUsedPercent) }} />
                </span>
              ) : (
                <span className="cycle-meter empty" aria-hidden="true" />
              )}
            </td>
            <td className="num">{quota && current ? percent(current.peakUsedPercent) : '—'}</td>
            <td className="num">{quota && current ? money(current.cost, snapshot.costs.currency) : '—'}</td>
            <td className={`forecast-outcome ${forecast?.state ?? 'unknown'}`}>
              {!quota
                ? 'Awaiting current reading'
                : forecast?.expectedRemaining == null
                  ? 'Learning'
                  : `${percent(forecast.expectedRemaining)} expected at reset`}
            </td>
          </tr>
          {past.map(pastRow)}
        </tbody>
      </table>
    </div>
  );
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
  onDraft: (percent: number | null) => void;
  onSaveReserve?: (percent: number) => Promise<boolean> | void;
  onOpenSettings?: (section: string) => void;
}) {
  const saved = Math.round(Number(snapshot.settings.reservePercent) || 0);
  const setDraft = onDraft;
  const reserve = draft ?? saved;
  const nowMs = Date.parse(snapshot.generatedAt);
  const budget = dailyBudget(view.current, snapshot.settings, nowMs, reserve);
  const reset = view.resetAt ? whenLabel(view.resetAt, nowMs) : 'the';
  if (!budget) {
    return (
      <section className="panel planner-panel" aria-labelledby="planner-heading">
        <h2 id="planner-heading">Daily budget</h2>
        <p className="panel-note">
          A daily budget needs a forecast with enough history and at least one full active day before the reset. The
          runway still shows what is expected to remain.
        </p>
      </section>
    );
  }
  const fits = budget.expectedFits && (budget.heavier == null || budget.heavierFits);
  const expectedOver = !budget.expectedFits;
  const tone = fits ? 'safe' : expectedOver ? 'critical' : 'risk';
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
        ? `At the heavier pace you would dip into your ${reserve}% reserve before the reset.`
        : heavyEnds
          ? `At the heavier pace ${view.name} runs out ${whenLabel(heavyEnds, nowMs)}, ${gapBeforeReset(heavyEnds, view.resetAt)}.`
          : 'At the heavier pace the allowance would be used up before the reset.';
  return (
    <section className="panel planner-panel" aria-labelledby="planner-heading">
      <h2 id="planner-heading">Daily budget</h2>
      <p className="panel-note">
        How much {view.name} you can use per active day and still reach the {reset} reset.
      </p>
      <p className="planner-figure">
        <strong>{paceLabel(budget.budget)}</strong> <span>per active day</span>
      </p>
      <DailyBudgetStrip budget={budget} provider={view.id} />
      <div className="planner-reserve">
        <div>
          <label htmlFor="planner-reserve">Keep in reserve</label>
          <output htmlFor="planner-reserve">{reserve}% of the allowance</output>
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
        <div className="planner-scale" aria-hidden="true">
          <span>0%</span>
          <span>25%</span>
          <span>50%</span>
        </div>
      </div>
      <div className={`planner-verdict ${tone}`}>
        {fits ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <div>
          <strong>{verdictTitle}</strong>
          <span>{verdictText}</span>
        </div>
      </div>
      {draft != null && draft !== saved && (
        <div className="planner-save">
          <span>
            Trying {draft}%. Forecasts still use {saved}%.
          </span>
          {onSaveReserve && (
            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                if ((await onSaveReserve(draft)) !== false) setDraft(null);
              }}
            >
              Use {draft}% for all forecasts
            </button>
          )}
          <button type="button" className="text-button" onClick={() => setDraft(null)}>
            Reset
          </button>
        </div>
      )}
      <p className="panel-note">
        {Math.round(budget.activeHoursLeft)} active hours left · {scheduleSummary(snapshot.settings)}. Use outside
        active hours counts too.{' '}
        {onOpenSettings && (
          <button type="button" className="text-button" onClick={() => onOpenSettings('forecast')}>
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
  const nowMs = Date.parse(snapshot.generatedAt);

  if (!view) {
    return (
      <main
        className="page detail-page"
        id="panel-overview"
        role="tabpanel"
        aria-labelledby="tab-overview"
        tabIndex={-1}
      >
        <section className="panel status-panel">
          <h1>This subscription is hidden</h1>
          <p>Show it again under Settings → Subscriptions. Its saved history is kept.</p>
          <button type="button" className="secondary-button" onClick={onBack}>
            Back to Overview
          </button>
        </section>
      </main>
    );
  }

  const forecast = view.current && !view.expired ? view.current.forecast : null;
  const related =
    view.id === 'fable'
      ? views.find((entry) => entry.id === 'claude')
      : view.id === 'claude'
        ? views.find((entry) => entry.id === 'fable' && entry.current)
        : undefined;
  const source = view.source;

  return (
    <main className="page detail-page" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" tabIndex={-1}>
      <header className={`detail-head ${view.id}`}>
        <div className="detail-title">
          <span className={`swatch ${view.id}`} aria-hidden="true" />
          <h1>{view.name}</h1>
          <StatePill
            state={view.state}
            label={view.expired ? 'Needs reading' : view.current ? undefined : 'Learning'}
          />
          <p>{view.subtitle}</p>
        </div>
        {view.current && !view.expired && view.remaining != null ? (
          <dl className="detail-figures">
            <div>
              <dt>Left now</dt>
              <dd className="big">
                {view.estimated ? '~' : ''}
                {Math.round(view.remaining)}%
              </dd>
            </div>
            <div>
              <dt>Expected at reset</dt>
              <dd className="big">
                {forecast?.exhaustsAt
                  ? 'Runs out'
                  : view.expectedRemaining == null
                    ? '—'
                    : percent(view.expectedRemaining)}
              </dd>
            </div>
            <div>
              <dt>Heavier week</dt>
              <dd className={forecast?.heavyExhaustsAt ? 'risk' : undefined}>
                {forecast?.heavyExhaustsAt
                  ? `Runs out ${whenLabel(forecast.heavyExhaustsAt, nowMs)}`
                  : view.heavyRemaining == null
                    ? 'Learning'
                    : `Leaves ${percent(view.heavyRemaining)}`}
              </dd>
            </div>
            <div>
              <dt>Resets</dt>
              <dd title={`in ${resetDistance(view.resetAt)}`}>{dateTimeLabel(view.resetAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="detail-waiting">
            {view.expired
              ? 'The last allowance window ended. Waiting for a new provider reading.'
              : 'Waiting for the provider’s first allowance observation.'}
          </p>
        )}
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {view.current && !view.expired && (
            <section className="panel runway-panel" aria-labelledby="runway-heading">
              <div className="panel-heading">
                <div>
                  <h2 id="runway-heading">This {windowNoun(view)}’s runway</h2>
                  <p>
                    Use so far, then the expected path and a heavier-week range to the reset. Hover to read any hour.
                  </p>
                </div>
                {forecast && view.heavyRemaining != null && (
                  <button
                    type="button"
                    className="toggle-chip"
                    aria-pressed={showHeavy}
                    onClick={() => setShowHeavy((value) => !value)}
                  >
                    Heavier-week range
                  </button>
                )}
              </div>
              <div className="runway-key" role="group" aria-label="Chart key">
                <span>
                  <i className={`key-observed ${view.id}`} aria-hidden="true" />
                  Observed
                </span>
                <span>
                  <i className={`key-expected ${view.id}`} aria-hidden="true" />
                  Expected
                </span>
                {showHeavy && (
                  <span>
                    <i className={`key-band ${view.id}`} aria-hidden="true" />
                    Heavier-week range
                  </span>
                )}
                <span>
                  <i className="key-inactive" aria-hidden="true" />
                  Outside active hours
                </span>
              </div>
              <RunwayChart
                view={view}
                schedule={schedule}
                size="full"
                showHeavy={showHeavy}
                reserve={reserveDraft ?? savedReserve}
              />
              <ProviderOutcomes view={view} nowMs={nowMs} />
            </section>
          )}

          {view.secondaryWindows.length > 0 && (
            <section className="panel" aria-labelledby="windows-heading">
              <div className="panel-heading compact-heading">
                <h2 id="windows-heading">Other windows</h2>
              </div>
              <SessionWindows view={view} nowMs={nowMs} />
            </section>
          )}

          <section className="panel recent-cycles-panel" aria-labelledby="cycles-heading">
            <div className="panel-heading compact-heading">
              <div>
                <h2 id="cycles-heading">Past {windowNoun(view)}s</h2>
                <p>
                  Peak share of the allowance used in each window, and what those tokens are worth at today’s prices.
                </p>
              </div>
            </div>
            <CycleTable view={view} snapshot={snapshot} />
          </section>

          <TokenCapacity snapshot={snapshot} provider={view.id} />
        </div>

        <aside className="detail-aside" aria-label={`${view.name} planning and evidence`}>
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

          {related && (
            <section className="panel related-panel" aria-labelledby="related-heading">
              <h2 id="related-heading">Related allowance</h2>
              <p className="panel-note">
                {view.id === 'fable'
                  ? 'Fable 5 has its own weekly limit within your Claude plan.'
                  : 'Fable 5 has a separate weekly limit inside this plan.'}
              </p>
              <button
                type="button"
                className="related-row"
                onClick={() => onOpenProvider?.(related.id)}
                disabled={!onOpenProvider}
              >
                <span className={`swatch ${related.id}`} aria-hidden="true" />
                <span className="related-name">
                  <strong>{related.name}</strong>
                  {related.remaining != null && <span> · {Math.round(related.remaining)}% left</span>}
                </span>
                <StatePill state={related.state} />
                <ChevronRight aria-hidden="true" />
              </button>
            </section>
          )}

          <section className="panel evidence-panel" aria-labelledby="evidence-heading">
            <h2 id="evidence-heading">Evidence</h2>
            <dl>
              <dt>Reading</dt>
              <dd>{provenanceLabel(view.provenance)}</dd>
              <dt>Last reading</dt>
              <dd>
                {view.current ? (
                  <time dateTime={view.current.observedAt} title={shortDate(view.current.observedAt)}>
                    {relativeTime(view.current.observedAt, nowMs)}
                  </time>
                ) : (
                  'None yet'
                )}
              </dd>
              {source && (
                <>
                  <dt>Last scan</dt>
                  <dd>
                    {source.last_attempt_at ? (
                      <time dateTime={source.last_attempt_at} title={shortDate(source.last_attempt_at)}>
                        {relativeTime(source.last_attempt_at, nowMs)}
                      </time>
                    ) : (
                      'Not yet'
                    )}
                    {' · '}
                    {source.status}
                  </dd>
                  <dt>Last good</dt>
                  <dd>{source.last_success_at ? shortDate(source.last_success_at) : 'Not yet'}</dd>
                </>
              )}
              {forecast && forecast.learnedDays > 0 && (
                <>
                  <dt>Learned from</dt>
                  <dd>
                    {forecast.learnedDays} day{forecast.learnedDays === 1 ? '' : 's'} ·{' '}
                    {percent(forecast.confidence * 100)} confidence
                  </dd>
                </>
              )}
            </dl>
            {view.notes.length > 0 && (
              <ul className="evidence-notes">
                {view.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {source?.status_detail && <p className="panel-note">{source.status_detail}</p>}
            <div className="local-assurance">
              <ShieldCheck aria-hidden="true" />
              <span>Calculated on this PC from your own records.</span>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
