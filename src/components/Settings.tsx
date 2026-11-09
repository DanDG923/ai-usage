import { ChevronRight, Database, Search, SearchX, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useDashboardActions, useDashboardState } from '../app/dashboard';
import '../settings.css';
import type { Settings as SettingsType, Snapshot } from '../types';
import { AlertsSection } from './settings/AlertsSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DiagnosticsSection } from './settings/DiagnosticsSection';
import { ForecastSection } from './settings/ForecastSection';
import { ManualSection } from './settings/ManualSection';
import { PricingSection } from './settings/PricingSection';
import { SettingsNav } from './settings/SettingsNav';
import { SourcesSection } from './settings/SourcesSection';
import { StorageSection } from './settings/StorageSection';
import { SubscriptionsSection } from './settings/SubscriptionsSection';
import {
  elementSearchText,
  revealSettingsTarget,
  settingsSlotOf,
  settingsTargetElement,
} from './settings/settings-dom';
import {
  ADVANCED_GROUP_LABEL,
  SETTINGS_SECTIONS,
  matchesQuery,
  matchingSections,
  sourcesBadge,
  unpricedModelCount,
  type SettingsSectionId,
} from './settings/settings-sections';
import { useScrollSpy } from './settings/useScrollSpy';

const SECTION_IDS = SETTINGS_SECTIONS.map((section) => section.id);
const ADVANCED_IDS = SETTINGS_SECTIONS.filter((section) => section.advanced).map((section) => section.id);

function sameMatches(a: ReadonlySet<SettingsSectionId> | null, b: ReadonlySet<SettingsSectionId> | null) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Settings, as one scrolling page with a section list beside it.
 *
 * `initialSection` (a section id such as "forecast", or a block such as
 * "subscription-fees") is scrolled to and focused when the page opens. A
 * `#section` hash in the address does the same, on arrival or when it changes.
 *
 * The sections take their actions from the dashboard themselves. Sources is
 * the exception: it is also drawn on its own with explicit props, so its
 * helper state and actions are handed to it here.
 */
export function Settings({
  snapshot,
  initialSection,
  onSetupClaude,
}: {
  snapshot: Snapshot;
  initialSection?: string | null;
  /** Opens the Claude setup guide, which App owns. */
  onSetupClaude: () => void;
}) {
  const { updateSettings, installClaudeHelper, uninstallClaudeHelper, claudeCodeMod } = useDashboardActions();
  const helperBusy = useDashboardState((state) => state.helperBusy);
  // Saves can overlap (a toggle, then a field), so they are counted: the
  // first to finish must not clear "Saving locally…" while another runs.
  const [savesInFlight, setSavesInFlight] = useState(0);
  const saving = savesInFlight > 0;
  const update = async (patch: Partial<SettingsType>) => {
    setSavesInFlight((count) => count + 1);
    try {
      return await updateSettings(patch);
    } finally {
      setSavesInFlight((count) => count - 1);
    }
  };

  const [query, setQuery] = useState('');
  // Sections matching the search, or null while nothing is being searched.
  const [matches, setMatches] = useState<ReadonlySet<SettingsSectionId> | null>(null);
  const [initialHash] = useState(() => (typeof window === 'undefined' ? '' : window.location.hash.slice(1)));
  const contentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const openedBySearch = useRef(new Set<HTMLDetailsElement>());
  const { active, select, release } = useScrollSpy(SECTION_IDS, contentRef, endRef);
  const search = query.trim();

  // Search reads the rendered sections, so every label, description and
  // option counts without a separate keyword list to keep in step. It runs
  // from the input's own events, when every section is already in the page.
  const runSearch = useCallback(
    (value: string) => {
      setQuery(value);
      release();
      const root = contentRef.current;
      const term = value.trim();
      const opened = openedBySearch.current;
      const keepOpen = (details: HTMLDetailsElement) => details.contains(document.activeElement);
      if (!term || !root) {
        setMatches(null);
        for (const details of opened) if (!keepOpen(details)) details.open = false;
        opened.clear();
        return;
      }
      const texts: Partial<Record<SettingsSectionId, string>> = {};
      const slots = new Map<SettingsSectionId, HTMLElement>();
      for (const id of SECTION_IDS) {
        const slot = root.querySelector<HTMLElement>(`[data-settings-section="${id}"]`);
        if (!slot) continue;
        slots.set(id, slot);
        texts[id] = elementSearchText(slot);
      }
      const next = matchingSections(texts, term);
      setMatches((current) => (sameMatches(current, next) ? current : next));
      // Open the disclosures around each matching section, and those inside it
      // that hold a match. Only disclosures the search opened are closed again.
      const wanted = new Set<HTMLDetailsElement>();
      for (const [id, slot] of slots) {
        if (!next.has(id)) continue;
        for (let node = slot.parentElement; node && node !== root; node = node.parentElement) {
          if (node instanceof HTMLDetailsElement) wanted.add(node);
        }
        for (const details of slot.querySelectorAll('details')) {
          if (matchesQuery(elementSearchText(details), term)) wanted.add(details);
        }
      }
      for (const details of wanted) {
        if (details.open) continue;
        details.open = true;
        opened.add(details);
      }
      for (const details of opened) {
        if (wanted.has(details) || keepOpen(details)) continue;
        details.open = false;
        opened.delete(details);
      }
    },
    [release],
  );

  const reveal = useCallback(
    (target: string, smooth = true) => {
      const element = settingsTargetElement(target);
      if (!element) return false;
      // A section the search has hidden is shown again before scrolling to it.
      if (settingsSlotOf(element)?.hidden) flushSync(() => runSearch(''));
      const section = settingsSlotOf(element)?.dataset.settingsSection as SettingsSectionId | undefined;
      if (section) select(section);
      return revealSettingsTarget(target, { smooth });
    },
    [runSearch, select],
  );

  useEffect(() => {
    const target = initialSection || initialHash;
    if (!target || !settingsTargetElement(target)) return;
    if (!initialSection) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const frame = requestAnimationFrame(() => reveal(target, false));
    return () => cancelAnimationFrame(frame);
  }, [initialSection, initialHash, reveal]);

  useEffect(() => {
    const onHash = () => {
      if (!reveal(window.location.hash.slice(1))) return;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [reveal]);

  const clearSearch = () => {
    runSearch('');
    searchRef.current?.focus();
  };
  const noMatches = search !== '' && matches !== null && matches.size === 0;
  const matchCount = matches?.size ?? 0;
  const searchStatus = !search
    ? ''
    : noMatches
      ? `No settings match “${search}”`
      : `${matchCount} ${matchCount === 1 ? 'section matches' : 'sections match'} “${search}”`;
  const hiddenBySearch = (id: SettingsSectionId) => (matches ? !matches.has(id) : undefined);
  const slot = (id: SettingsSectionId, content: ReactNode) => (
    <div
      className="settings-slot"
      data-settings-section={id}
      data-current={active === id ? '' : undefined}
      hidden={hiddenBySearch(id)}
    >
      {content}
    </div>
  );

  return (
    <main>
      <div
        className="page settings-page"
        id="panel-settings"
        role="tabpanel"
        aria-labelledby="tab-settings"
        tabIndex={-1}
      >
        <h1 className="sr-only">Settings</h1>
        <header className="settings-lead">
          <p>Preferences for collection, forecasts, alerts, pricing, and your local data.</p>
          <div className="settings-lead-facts">
            <span className="settings-saving" role="status">
              {saving ? 'Saving locally…' : ''}
            </span>
            <span className="badge settings-local">
              <Database aria-hidden="true" />
              Everything stays on this PC
            </span>
          </div>
        </header>
        <div className="settings-layout">
          <div className="settings-sidebar">
            <div className="settings-search" role="search">
              <Search aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search settings"
                aria-describedby="settings-search-status"
                aria-controls="settings-sections"
                placeholder="Search settings"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => runSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape' || !query) return;
                  event.preventDefault();
                  runSearch('');
                }}
                className="fld"
              />
              {query && (
                <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={clearSearch}>
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
            <SettingsNav
              active={active}
              matches={matches}
              sources={sourcesBadge(snapshot.sources)}
              unpriced={unpricedModelCount(snapshot)}
              onNavigate={(id) => void reveal(id)}
            />
          </div>

          <div className="settings-main">
            <p id="settings-search-status" className="sr-only" role="status">
              {searchStatus}
            </p>
            {noMatches && (
              <div className="settings-empty">
                <p>
                  <SearchX aria-hidden="true" />
                  No settings match “{search}”
                </p>
                <button type="button" className="btn" onClick={clearSearch}>
                  Clear search
                </button>
              </div>
            )}

            <div className="settings-content" id="settings-sections" ref={contentRef}>
              {slot('subscriptions', <SubscriptionsSection snapshot={snapshot} update={update} />)}
              {slot(
                'sources',
                <SourcesSection
                  onSetupClaude={onSetupClaude}
                  snapshot={snapshot}
                  update={update}
                  helperBusy={helperBusy}
                  onInstallClaude={installClaudeHelper}
                  onUninstallClaude={uninstallClaudeHelper}
                  onClaudeCodeMod={claudeCodeMod}
                />,
              )}
              {slot('forecast', <ForecastSection snapshot={snapshot} update={update} />)}
              {slot('alerts', <AlertsSection snapshot={snapshot} update={update} />)}
              {slot('pricing', <PricingSection snapshot={snapshot} update={update} />)}
              {slot('storage', <StorageSection snapshot={snapshot} update={update} />)}
              {slot('appearance', <AppearanceSection snapshot={snapshot} update={update} />)}

              <details
                className="settings-disclosure advanced-disclosure"
                hidden={matches ? !ADVANCED_IDS.some((id) => matches.has(id)) : undefined}
              >
                <summary>
                  <ChevronRight aria-hidden="true" />
                  <strong>{ADVANCED_GROUP_LABEL}</strong>
                  <span>— Manual observations and diagnostics</span>
                </summary>
                <div className="settings-disclosure-body">
                  {slot('manual', <ManualSection />)}
                  {slot('diagnostics', <DiagnosticsSection snapshot={snapshot} />)}
                </div>
              </details>
            </div>
            <div className="settings-end" ref={endRef} aria-hidden="true" />
          </div>
        </div>
      </div>
    </main>
  );
}
