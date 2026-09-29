import { useEffect, useId, useRef, useState } from 'react';
import type { Settings, Snapshot } from '../../types';
import {
  NumericSetting,
  SettingColumns,
  SettingError,
  SettingNote,
  SettingRow,
  SettingsSection,
  ToggleRow,
} from './fields';

export const SUBSCRIPTION_FEES_NOTE =
  'With a monthly fee set, the Overview compares the period’s API-equivalent value with the fees for the same number of days. Leave a fee at zero to hide the comparison. Fees are compared, never charged.';

export const CLAUDE_FREE_RESETS_NOTE =
  'Claude’s Usage settings can offer a free reset, for example to try a new model. No Claude API reports it, so record it here to see it on the Claude card. It hides itself after the expiry date and is never counted as allowance.';

/** A day the settings store accepts: a real yyyy-mm-dd date from 2020 to 2100. */
function isStorableDate(value: string) {
  if (!/^(?:20\d{2}|2100)-\d{2}-\d{2}$/.test(value) || value < '2020-01-01') return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The last day a recorded Claude free reset can be claimed, saved as soon as
 * the field holds a whole day or is emptied. It keeps its own draft, so typing
 * a date one part at a time is not reset to the saved day between keystrokes.
 */
function FreeResetExpiry({
  value,
  disabled,
  onCommit,
}: {
  value: string | null;
  disabled: boolean;
  onCommit: (value: string | null) => Promise<void | boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value ?? '');
  const [error, setError] = useState('');
  const latestSave = useRef(0);
  // Saves still on their way, and the date the latest of them asked for.
  const [pending, setPending] = useState(0);
  const requested = useRef(value);
  // The saved date as of the latest render, which a failed save restores.
  const saved = useRef(value);
  useEffect(() => {
    saved.current = value;
    if (!pending) requested.current = value;
  }, [value, pending]);
  // A saved value arriving from a snapshot replaces the draft. Typing does not,
  // and neither does an earlier save landing while a later one is on its way:
  // it would put back a day the user has already typed past.
  const [committed, setCommitted] = useState(value);
  if (committed !== value) {
    setCommitted(value);
    if (!pending) setDraft(value ?? '');
  }
  const change = async (next: string) => {
    setDraft(next);
    // A date input reports '' once emptied and while a date is incomplete, and
    // years such as 0002 while one is typed digit by digit; only days are saved.
    const day = next === '' ? null : isStorableDate(next) ? next : undefined;
    // Compared with the last day asked for, not the saved one: retyping the
    // saved day while another save is on its way must still be sent.
    if (day === undefined || day === requested.current) return;
    // Typing a day can send two saves in a row; only the latest may roll back.
    const attempt = ++latestSave.current;
    requested.current = day;
    setPending((count) => count + 1);
    setError('');
    try {
      if ((await onCommit(day)) === false) throw new Error('Save failed');
    } catch {
      if (attempt !== latestSave.current) return;
      requested.current = saved.current;
      setDraft(saved.current ?? '');
      setError('This date could not be saved. Try again.');
    } finally {
      setPending((count) => count - 1);
    }
  };
  return (
    <SettingRow label="Expires on" htmlFor={id} description="Optional. Leave empty if Claude shows no expiry.">
      <div className="date-setting">
        <input
          id={id}
          type="date"
          min="2020-01-01"
          max="2100-12-31"
          value={draft}
          disabled={disabled}
          onChange={(event) => void change(event.target.value)}
          className="fld"
        />
        {value && (
          <button type="button" className="btn" disabled={disabled} onClick={() => void change('')}>
            Clear
          </button>
        )}
      </div>
      {error && <SettingError>{error}</SettingError>}
    </SettingRow>
  );
}

export function SubscriptionsSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  const { settings } = snapshot;
  const showCodex = settings.showCodexSubscription !== false;
  const showClaude = settings.showClaudeSubscription !== false;
  return (
    <SettingsSection
      id="subscriptions"
      title="Subscriptions"
      description="Choose which subscriptions appear in your allowance views and alerts. You can show them again at any time."
    >
      <SettingColumns>
        <div className="setting-col">
          <ToggleRow
            title="Show Codex"
            description="Codex allowances, forecasts, and reminders."
            checked={showCodex}
            onChange={(checked) => void update({ showCodexSubscription: checked })}
          />
          <ToggleRow
            title="Show Claude"
            description="Claude allowances, including Fable, forecasts, and reminders."
            checked={showClaude}
            onChange={(checked) => void update({ showClaudeSubscription: checked })}
          />
          {(showCodex || showClaude) && (
            <div
              id="subscription-fees"
              className="setting-group"
              role="group"
              aria-labelledby="subscription-fees-heading"
              aria-describedby="subscription-fees-note"
            >
              <div className="setting-group-head">
                <h3 id="subscription-fees-heading" tabIndex={-1}>
                  Monthly fees
                </h3>
                <p id="subscription-fees-note">{SUBSCRIPTION_FEES_NOTE}</p>
              </div>
              {showCodex && (
                <NumericSetting
                  label="Codex subscription (USD per month)"
                  value={Number(settings.codexPlanUsdPerMonth) || 0}
                  min={0}
                  max={100_000}
                  step={1}
                  suffix="USD"
                  onCommit={(value) => update({ codexPlanUsdPerMonth: value })}
                />
              )}
              {showClaude && (
                <NumericSetting
                  label="Claude subscription (USD per month)"
                  value={Number(settings.claudePlanUsdPerMonth) || 0}
                  min={0}
                  max={100_000}
                  step={1}
                  suffix="USD"
                  onCommit={(value) => update({ claudePlanUsdPerMonth: value })}
                />
              )}
            </div>
          )}
        </div>
        <div className="setting-col">
          {showClaude && (
            <div
              id="claude-free-resets"
              className="setting-group"
              role="group"
              aria-labelledby="claude-free-resets-heading"
              aria-describedby="claude-free-resets-note"
            >
              <div className="setting-group-head">
                <h3 id="claude-free-resets-heading" tabIndex={-1}>
                  Claude free resets
                </h3>
                <p id="claude-free-resets-note">{CLAUDE_FREE_RESETS_NOTE}</p>
              </div>
              <NumericSetting
                label="Free resets available"
                value={Number(settings.claudeFreeResets) || 0}
                min={0}
                max={10}
                step={1}
                integer
                onCommit={(value) =>
                  update(
                    value === 0 ? { claudeFreeResets: 0, claudeFreeResetsExpireOn: null } : { claudeFreeResets: value },
                  )
                }
              />
              <FreeResetExpiry
                value={settings.claudeFreeResetsExpireOn ?? null}
                disabled={!(Number(settings.claudeFreeResets) > 0)}
                onCommit={(value) => update({ claudeFreeResetsExpireOn: value })}
              />
            </div>
          )}
        </div>
      </SettingColumns>
      <SettingNote>
        Hiding a subscription keeps its saved history and cost totals. Background collection is unchanged.
      </SettingNote>
    </SettingsSection>
  );
}
