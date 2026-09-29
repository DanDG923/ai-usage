import { ChevronRight } from 'lucide-react';
import { Fragment, useId, useRef, useState } from 'react';
import type { Settings, Snapshot } from '../../types';
import { AllowanceChanges } from './AllowanceChanges';
import { budgetPreview } from './budget-preview';
import { ForecastExcludedDates } from './ForecastExcludedDates';
import { NumericSetting, SettingColumns, SettingNote, SettingRow, SettingsSection, hourOptions } from './fields';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ForecastSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  const { settings } = snapshot;
  const id = useId();
  const [savingDays, setSavingDays] = useState(false);
  const daySavePending = useRef(false);
  // The reserve being typed, previewed before it is saved. A newly saved
  // reserve from the snapshot replaces it.
  const [reserveDraft, setReserveDraft] = useState<number | null>(null);
  const [savedReserve, setSavedReserve] = useState(settings.reservePercent);
  if (savedReserve !== settings.reservePercent) {
    setSavedReserve(settings.reservePercent);
    setReserveDraft(null);
  }
  const preview = budgetPreview(snapshot, Math.round(reserveDraft ?? settings.reservePercent ?? 0));
  const toggleDay = async (index: number) => {
    // The snapshot is the last saved selection. Until the next one arrives,
    // another whole-array write would overwrite the first change.
    if (daySavePending.current) return;
    daySavePending.current = true;
    setSavingDays(true);
    try {
      await update({
        activeDays: settings.activeDays.includes(index)
          ? settings.activeDays.filter((day) => day !== index)
          : [...settings.activeDays, index],
      });
    } finally {
      daySavePending.current = false;
      setSavingDays(false);
    }
  };
  return (
    <SettingsSection
      id="forecast"
      title="Forecast"
      description="Tell AI Usage when you normally work and how much allowance you prefer to keep back."
    >
      <SettingColumns>
        <div className="setting-col">
          <SettingRow
            label="Active hours"
            labelId={`${id}-hours`}
            description="The part of each active day when you normally use Codex and Claude. Forecasts and daily budgets expect use in these hours."
          >
            <div className="hours-range" role="group" aria-labelledby={`${id}-hours`}>
              <select
                aria-label="Active day starts"
                value={settings.activeStartHour}
                onChange={(event) => update({ activeStartHour: Number(event.target.value) })}
                className="fld"
              >
                {hourOptions(0, 23)}
              </select>
              <span aria-hidden="true">to</span>
              <select
                aria-label="Active day ends"
                value={settings.activeEndHour}
                onChange={(event) => update({ activeEndHour: Number(event.target.value) })}
                className="fld"
              >
                {hourOptions(1, 24)}
              </select>
            </div>
          </SettingRow>
          <SettingRow label="Active days" description="Days that count as active in forecasts and daily budgets.">
            <div className="day-picker" role="group" aria-label="Active days" aria-busy={savingDays}>
              {DAY_NAMES.map((day, index) => {
                const active = settings.activeDays.includes(index);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={active}
                    disabled={savingDays}
                    className={active ? 'btn btn-on' : 'btn'}
                    onClick={() => toggleDay(index)}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
          </SettingRow>
          <NumericSetting
            label="Keep in reserve"
            description={
              <>
                <span>Allowance to leave untouched at each reset. Daily budgets stop short of it.</span>
                <span className="budget-preview" aria-live="polite" aria-atomic="true">
                  {preview.length > 0 ? (
                    <>
                      <span className="budget-preview-lead">Daily budgets now:</span>
                      {preview.map((entry, index) => (
                        <Fragment key={entry.id}>
                          {index > 0 && (
                            <span className="budget-preview-sep" aria-hidden="true">
                              ·
                            </span>
                          )}
                          <span className="budget-preview-item">
                            <span className={`swatch ${entry.id}`} aria-hidden="true" />
                            {entry.name} <strong>{entry.label}</strong>
                          </span>
                        </Fragment>
                      ))}
                      <span>per active day</span>
                    </>
                  ) : (
                    'Daily budgets appear here once a forecast has learned enough and active hours remain before its reset.'
                  )}
                </span>
              </>
            }
            value={settings.reservePercent}
            min={0}
            max={50}
            step={1}
            suffix="% of allowance"
            integer
            onDraftChange={setReserveDraft}
            onCommit={(value) => update({ reservePercent: value })}
          />
          <details className="inline-advanced">
            <summary>
              <ChevronRight aria-hidden="true" />
              Forecast model defaults
            </summary>
            <div className="inline-advanced-body">
              <NumericSetting
                label="New-source fallback"
                description="The hourly pace assumed until a source has enough history of its own."
                value={settings.forecastFallbackRate}
                min={0.05}
                max={100}
                step={0.05}
                suffix="% / hour"
                onCommit={(value) => update({ forecastFallbackRate: value })}
              />
              <SettingNote>
                History is weighted by recency, hour, weekday, and current momentum. Codex, Claude, and Fable learn
                independently; the heavier case uses the busy end of each source’s observed pattern.
              </SettingNote>
            </div>
          </details>
        </div>
        <div className="setting-col">
          <ForecastExcludedDates snapshot={snapshot} update={update} />
          <AllowanceChanges snapshot={snapshot} update={update} />
        </div>
      </SettingColumns>
    </SettingsSection>
  );
}
