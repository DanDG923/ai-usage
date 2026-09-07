import { useRef, useState } from 'react';
import type { Settings, Snapshot } from '../../types';
import { ForecastExcludedDates } from './ForecastExcludedDates';
import { NumericSetting, SectionHeading, hourOptions } from './fields';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ForecastSection({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const { settings } = snapshot;
  const [savingDays, setSavingDays] = useState(false);
  const daySavePending = useRef(false);
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
    <section id="schedule" className="panel settings-section">
      <SectionHeading
        title="Forecast"
        description="Tell AI Usage when you normally work and how much allowance you prefer to keep back."
      />
      <div className="settings-fields">
        <label>
          <span>Active day starts</span>
          <select
            value={settings.activeStartHour}
            onChange={(event) => update({ activeStartHour: Number(event.target.value) })}
          >
            {hourOptions(0, 23)}
          </select>
        </label>
        <label>
          <span>Active day ends</span>
          <select
            value={settings.activeEndHour}
            onChange={(event) => update({ activeEndHour: Number(event.target.value) })}
          >
            {hourOptions(1, 24)}
          </select>
        </label>
      </div>
      <div className="day-picker" role="group" aria-label="Active days" aria-busy={savingDays}>
        {DAY_NAMES.map((day, index) => {
          const active = settings.activeDays.includes(index);
          return (
            <button
              key={day}
              aria-pressed={active}
              disabled={savingDays}
              className={active ? 'active' : ''}
              onClick={() => toggleDay(index)}
            >
              {day}
            </button>
          );
        })}
      </div>
      <div className="settings-fields budget-fields">
        <NumericSetting
          label="Keep in reserve"
          value={settings.reservePercent}
          min={0}
          max={50}
          step={1}
          suffix="% of allowance"
          onCommit={(value) => update({ reservePercent: Math.round(value) })}
        />
      </div>
      <details className="inline-advanced">
        <summary>Forecast model defaults</summary>
        <div className="inline-advanced-body">
          <NumericSetting
            label="New-source fallback"
            value={settings.forecastFallbackRate}
            min={0.05}
            max={100}
            step={0.05}
            suffix="% / hour"
            onCommit={(value) => update({ forecastFallbackRate: value })}
          />
          <p>
            History is weighted by recency, hour, weekday, and current momentum. Codex, Claude, and Fable 5 learn
            independently; the heavier case uses the busy end of each source’s observed pattern.
          </p>
        </div>
      </details>
      <ForecastExcludedDates snapshot={snapshot} update={update} />
    </section>
  );
}
