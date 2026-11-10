import { foldsInto, subscriptionVisible } from '../electron/dashboard-decision.mjs';
import { dailyBudget, paceLabel, type DailyBudget } from './budget';
import {
  STATE_WORD,
  allowanceWindowLabel,
  dateTimeLabel,
  percent,
  quotaWindows,
  sourceLabel,
  verdictSentence,
  whenLabel,
} from './lib';
import { hasProjection, visibleQuotas, type ProviderId, type ProviderView } from './provider-view';
import type { ForecastState, QuotaWindow, Snapshot } from './types';

/*
 * The verdict as the Overview's status line and the tray flyout's annunciator
 * read it. Both start from the same backend verdict and the same provider
 * views, and share the rules here: when nothing can be assessed yet, how the
 * verdict is worded, and which allowance window (with its daily budget) it is
 * about. Each surface then words its own line; nothing here draws anything.
 */

/** The parts of a snapshot the verdict is read from; the tray flyout's snapshot carries them too. */
type VerdictSource = Pick<Snapshot, 'dashboardVerdict' | 'settings' | 'quotas' | 'sources'>;

/** No shown allowance has a current reading, so there is nothing to assess yet. */
export function awaitingReadings(views: ProviderView[]) {
  return views.every((view) => !view.current || view.expired);
}

/** The backend verdict as a sentence. Hidden subscriptions are never named as on track. */
export function shownVerdictSentence(snapshot: VerdictSource) {
  return verdictSentence(snapshot.dashboardVerdict, visibleQuotas(snapshot), snapshot.sources);
}

export type VerdictFocus = {
  view: ProviderView;
  /** The window the verdict names, which may be a shorter session beside the headline allowance. */
  window: QuotaWindow;
  label: string;
  /** Null when the forecast supports no budget; dailyBudget declines windows under a day. */
  budget: DailyBudget | null;
};

/**
 * The allowance a verdict is about: the backend verdict's first affected
 * window that is still shown (else that provider's headline window), with its
 * budget when the forecast supports one.
 */
export function verdictFocus(
  views: ProviderView[],
  snapshot: Pick<Snapshot, 'dashboardVerdict' | 'settings'>,
  nowMs: number,
): VerdictFocus | null {
  if (snapshot.dashboardVerdict.state === 'safe') return null;
  for (const detail of snapshot.dashboardVerdict.details ?? []) {
    if (detail.state === 'safe') continue;
    const view = views.find((entry) => entry.id === detail.sourceId);
    if (!view?.current) continue;
    const window =
      quotaWindows(view.quota).find((entry) => entry.bucketId === detail.bucketId && !entry.forecast.expired) ??
      view.current;
    const secondary = window.bucketId !== view.current.bucketId;
    return {
      view,
      window,
      label: secondary ? `${view.name} ${allowanceWindowLabel(window)}` : view.name,
      budget: dailyBudget(window, snapshot.settings, nowMs),
    };
  }
  return null;
}

export type Insight = {
  tone: 'neutral' | 'good' | 'warm' | 'hot';
  title: string;
  detail: string;
  /** The allowance window the insight is about, when it is about one. */
  about?: { provider: ProviderId; bucketId: string };
};

function names(views: ProviderView[]) {
  return views.map((view) => view.name).join(', ');
}

// Every active window earns its own line: the weekly headline and any shorter
// session window are separate allowances with separate resets.
function windowInsights(
  provider: ProviderId,
  name: string,
  window: QuotaWindow,
  nowMs: number,
  riskPace: number,
  included: string | null = null,
): Insight[] {
  const forecast = window.forecast;
  const about = { provider, bucketId: window.bucketId };
  if (forecast.expired) return [];
  // Fable draws on this window: one event, named once, with Fable included.
  if (included) {
    return windowInsights(provider, name, window, nowMs, riskPace).map((row) => ({
      ...row,
      title: `${row.title}, ${included} included`,
      detail: `${row.detail} Every Claude model shares this weekly limit.`,
    }));
  }
  if (forecast.exhaustsAt) {
    return [
      {
        tone: 'hot',
        title: `${name} is expected to run out`,
        detail: `${whenLabel(forecast.exhaustsAt, nowMs)}, before its ${dateTimeLabel(window.resetsAt)} reset.`,
        about,
      },
    ];
  }
  if (forecast.heavyExhaustsAt) {
    return [
      {
        tone: 'warm',
        title: `${name} could run out under heavier usage`,
        detail: `Expected usage leaves ${percent(forecast.expectedRemaining)}; the heavier case reaches zero ${whenLabel(forecast.heavyExhaustsAt, nowMs)}.`,
        about,
      },
    ];
  }
  // A risk pace set below 1.05 opens the note too: the verdict already calls it a risk.
  if (forecast.paceRatio > Math.min(1.05, riskPace)) {
    // With no safe pace left the ratio is a placeholder, not a multiple.
    if (forecast.safePace <= 0) {
      return [
        {
          tone: 'warm',
          title: `${name} has no safe pace left`,
          detail: 'Nothing above the reserve is left for active use before the reset.',
          about,
        },
      ];
    }
    // Two decimals near 1×, where one would round 1.03× down to "1.0×".
    const multiple = forecast.paceRatio.toFixed(forecast.paceRatio < 1.1 ? 2 : 1);
    // Warm only past the pace the user treats as a risk (Settings → Alerts),
    // the same line the verdict and its alerts use.
    const tone = forecast.paceRatio > riskPace ? 'warm' : 'neutral';
    if (forecast.paceRatio <= 1) {
      return [
        {
          tone,
          title: `${name} is near its safe pace`,
          detail: `${multiple}× the sustainable pace, past the ${riskPace}× you treat as a risk.`,
          about,
        },
      ];
    }
    const reduction = Math.max(0, Math.round((1 - 1 / forecast.paceRatio) * 100));
    return [
      {
        tone,
        title: `${name} is above its safe pace`,
        detail: `${multiple}× the sustainable pace. Reduce active usage by about ${reduction}% to return to plan.`,
        about,
      },
    ];
  }
  return [];
}

/** What is worth knowing about each shown allowance, most pressing first. */
export function overviewInsights(views: ProviderView[], snapshot: Snapshot, nowMs: number): Insight[] {
  const rows: Insight[] = [];
  // When the Claude weekly limit, not Fable's own, drives Fable's forecast,
  // Fable's lines are Claude's: they are reported there, not twice.
  const fable = views.find((view) => view.id === 'fable')?.current ?? null;
  const claudeWindows = views.find((view) => view.id === 'claude')?.quota?.windows ?? [];
  const host = fable ? claudeWindows.find((window) => foldsInto(fable, window)) : undefined;
  const riskPace = Number(snapshot.settings.paceRiskThreshold) || 1.2;
  for (const view of views) {
    const forecast = view.current?.forecast;
    if (!view.current || !forecast || forecast.expired) continue;
    const folded = view.id === 'fable' && host != null;
    const included = (window: QuotaWindow) =>
      view.id === 'claude' && host?.bucketId === window.bucketId ? sourceLabel('fable') : null;
    if (!folded)
      rows.push(...windowInsights(view.id, view.name, view.current, nowMs, riskPace, included(view.current)));
    for (const window of view.secondaryWindows) {
      rows.push(
        ...windowInsights(
          view.id,
          `${view.name} ${allowanceWindowLabel(window)}`,
          window,
          nowMs,
          riskPace,
          included(window),
        ),
      );
    }
    if (view.stale) {
      rows.push({
        tone: 'warm',
        title: `${view.name} needs a current reading`,
        detail: 'The displayed balance is projected from the last successful local observation.',
      });
    }
  }
  // A plan without a Fable allowance has no Fable reading to wait for.
  const missing = views.filter(
    (view) =>
      (!view.current || view.current.forecast.expired) && !(view.id === 'fable' && snapshot.fableApplies === false),
  );
  const learning = views.filter((view) => view.current && !view.current.forecast.expired && !hasProjection(view));
  if (missing.length) {
    rows.push({
      tone: 'neutral',
      title: `Waiting for ${names(missing)} allowance readings`,
      detail:
        'Refresh the local sources or check their setup. These allowances cannot be assessed until a current observation is available.',
    });
  }
  if (learning.length) {
    rows.push({
      tone: 'neutral',
      title: `${names(learning)} forecasts are still learning`,
      detail: 'A balance is available, but there is not enough evidence to say how much will remain at reset.',
    });
  }
  // Banked and free resets appear on their provider's card instead.
  const severity = { hot: 0, warm: 1, neutral: 2, good: 3 };
  return rows.sort((a, b) => severity[a.tone] - severity[b.tone]);
}

/**
 * The Overview's status line and the notes under it.
 *
 * The Master Caution lozenge fills for act-now states (at risk, critical) and
 * is outlined for advisory ones (watch, on track); anything short of a full
 * assessment (waiting, learning, stale evidence, a partial all-clear) is the
 * `unknown` tone, which stays neutral and dashed, never green.
 */
export function overviewStatus(snapshot: Snapshot, views: ProviderView[], nowMs: number) {
  const verdict = shownVerdictSentence(snapshot);
  // A plan without a Fable allowance has no Fable evidence to wait for.
  const unknown = views.filter(
    (view) => !hasProjection(view) && !(view.id === 'fable' && snapshot.fableApplies === false),
  );
  const waiting = awaitingReadings(views);
  // Every assessed allowance is on track, but some have no forecast yet: a
  // partial all-clear, which stays neutral rather than green.
  const partial = !waiting && snapshot.dashboardVerdict.state === 'safe' && unknown.length > 0;
  const focus = waiting ? null : verdictFocus(views, snapshot, nowMs);
  const needsEvidence = unknown.length > 0;
  const tone: ForecastState = waiting || partial ? 'unknown' : snapshot.dashboardVerdict.state;
  return {
    tone,
    word: waiting
      ? 'Awaiting data'
      : tone === 'unknown'
        ? !partial && snapshot.dashboardVerdict.label.startsWith('Allowance check needs current data')
          ? 'Needs reading'
          : 'Learning'
        : STATE_WORD[tone],
    headline: waiting ? 'Waiting for allowance readings' : partial ? 'Available allowances on track' : verdict.headline,
    /** The allowance the status line is about and its action opens. */
    focus,
    /** The focus when it has a budget and a reset to plan towards. */
    guidance: focus?.budget && focus.window.resetsAt ? { ...focus, budget: focus.budget } : null,
    /** Some shown allowance has no forecast yet; the secondary line then says which. */
    needsEvidence,
    secondary: needsEvidence
      ? `${names(unknown)} ${unknown.length === 1 ? 'needs' : 'need'} more evidence before all allowances can be assessed.`
      : verdict.secondary,
    /** A Refresh could help: an allowance lacks a forecast or shows a stale reading. */
    needsReadings: needsEvidence || views.some((view) => view.stale),
    // The status line already states its window; list everything else once.
    attention: overviewInsights(views, snapshot, nowMs).filter(
      (row) =>
        !(
          focus &&
          row.about &&
          row.about.provider === focus.view.id &&
          row.about.bucketId === focus.window.bucketId &&
          (row.tone === 'hot' || row.tone === 'warm')
        ),
    ),
  };
}

/**
 * The period's API-equivalent value of each visible subscription with a fee,
 * as a multiple of those fees. A plan that is hidden or has no fee is left out
 * of both sides, so its usage is never credited to another plan's fee.
 */
export function subscriptionValue(snapshot: Pick<Snapshot, 'settings' | 'costs'>) {
  const settings = snapshot.settings;
  const plans = (
    [
      ['codex', settings.codexPlanUsdPerMonth],
      ['claude', settings.claudePlanUsdPerMonth],
    ] as const
  ).filter(([id, fee]) => subscriptionVisible(settings, id) && Number(fee) > 0);
  if (!plans.length) return null;
  const monthlyUsd = plans.reduce((sum, [, fee]) => sum + Number(fee), 0);
  const fees = monthlyUsd * (Number(settings.usdToCurrency) || 1) * (snapshot.costs.periodDays / (365.25 / 12));
  const value = snapshot.costs.chart.reduce((sum, day) => sum + plans.reduce((total, [id]) => total + day[id], 0), 0);
  // Only unpriced usage of a counted plan makes its value a lower bound. Costs
  // file every source other than Codex under Claude, and so does this.
  const lowerBound = snapshot.costs.unpricedModels.some(
    (entry) => entry.tokens > 0 && plans.some(([id]) => (id === 'codex') === (entry.sourceId === 'codex')),
  );
  return { fees, multiple: value / fees, lowerBound, only: plans.length === 1 ? sourceLabel(plans[0][0]) : null };
}

/**
 * The flyout annunciator's tone: a forecast state, as the Overview's
 * annunciator takes them, or failure when the allowances could not be read at
 * all. Unknown is the neutral dashed lozenge: waiting or learning.
 */
export type FlyoutVerdictTone = ForecastState | 'failure';
export type FlyoutVerdict = { tone: FlyoutVerdictTone; headline: string; detail: string };

/** The tray flyout's verdict line: the same verdict in a glance, with one line of detail. */
export function flyoutVerdict(snapshot: VerdictSource, views: ProviderView[], snapshotMs: number): FlyoutVerdict {
  if (!views.length) {
    return {
      tone: 'unknown',
      headline: 'No subscriptions shown',
      detail: 'Choose subscriptions in Settings to see their allowances here.',
    };
  }
  if (awaitingReadings(views)) {
    return {
      tone: 'unknown',
      headline: 'Waiting for allowance readings',
      detail: 'They appear after the next refresh.',
    };
  }
  const verdict = snapshot.dashboardVerdict;
  if (verdict.state === 'safe') return { tone: 'safe', headline: 'All allowances on track', detail: '' };
  const sentence = shownVerdictSentence(snapshot);
  let detail = sentence.secondary;
  // One line has room for one provider's budget: it is given only when every
  // affected window belongs to the same one.
  const affected = verdict.details.filter((entry) => entry.state !== 'safe');
  if (new Set(affected.map((entry) => entry.sourceId)).size === 1) {
    const budget = verdictFocus(views, snapshot, snapshotMs)?.budget;
    if (budget && budget.budget > 0) detail = `Stay under ${paceLabel(budget.budget)} a day to reach the reset.`;
  }
  return { tone: verdict.state, headline: sentence.headline, detail };
}
