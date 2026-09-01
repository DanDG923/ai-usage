import { Clock3, Database, PiggyBank } from 'lucide-react';
import type { Settings, Snapshot } from '../../types';
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
  return (
    <section id="schedule" className="panel settings-section">
      <SectionHeading
        eyebrow="Behaviour model"
        title="Learned forecast"
        description="History is weighted by recency, hour, weekday, and current momentum. Active hours define when future use is likely, not a flat burn rate."
        icon={Clock3}
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
        <NumericSetting
          label="New-source fallback"
          value={settings.forecastFallbackRate}
          min={0.05}
          max={100}
          step={0.05}
          suffix="% / hour"
          onCommit={(value) => update({ forecastFallbackRate: value })}
        />
      </div>
      <div className="day-picker" role="group" aria-label="Active days">
        {DAY_NAMES.map((day, index) => {
          const active = settings.activeDays.includes(index);
          return (
            <button
              key={day}
              aria-pressed={active}
              className={active ? 'active' : ''}
              onClick={() =>
                update({
                  activeDays: active ? settings.activeDays.filter((d) => d !== index) : [...settings.activeDays, index],
                })
              }
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
      <div className="learning-note">
        <PiggyBank aria-hidden="true" />
        <span>
          <strong>Budget mode</strong>
          The reserve is the share of each allowance you want untouched at reset, for example to keep the weekend free.
          The safe pace spends only what is above it, and a projection that would eat into it is shown as a watch state.
          The forecast itself still reports what will actually happen.
        </span>
      </div>
      <div className="learning-note">
        <Database aria-hidden="true" />
        <span>
          <strong>Three independent learners</strong>
          Codex, overall Claude, and Fable 5 build their own history. The heavier forecast uses the busy end of each
          source's real observed pattern.
        </span>
      </div>
    </section>
  );
}
