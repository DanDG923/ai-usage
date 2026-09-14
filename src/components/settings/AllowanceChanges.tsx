import { useRef, useState } from 'react';
import { LOCALE } from '../../lib';
import type { AllowanceChange, Settings, Snapshot } from '../../types';

const SOURCE_LABELS: Record<AllowanceChange['source'], string> = {
  claude: 'Claude (including Fable 5)',
  codex: 'Codex',
};
const MAX_CHANGES = 24;
const DEFAULT_PREVIOUS_PERCENT = '150';

// One formatter per zone for the life of the page; this renders on every keystroke.
const instantFormatters = new Map<string, Intl.DateTimeFormat>();

function instantFormatter(timezone: string) {
  let formatter = instantFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
    instantFormatters.set(timezone, formatter);
  }
  return formatter;
}

// The datetime-local input speaks wall-clock time; the setting stores an
// instant. The renderer runs in the system zone the snapshot reports, so the
// input's own parsing turns one into the other.
function localDateTime(timezone: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function toInstant(value: string) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function AllowanceChanges({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void>;
}) {
  const now = localDateTime(snapshot.timezone);
  const [source, setSource] = useState<AllowanceChange['source']>('claude');
  const [at, setAt] = useState(now);
  const [previous, setPrevious] = useState(DEFAULT_PREVIOUS_PERCENT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const changes = snapshot.settings.allowanceChanges;
  // Reverse a copy: the renderer's ES2022 target does not expose toReversed.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const latestFirst = [...changes].reverse();
  const instant = toInstant(at);
  const percent = Number(previous);
  const percentValid = previous.trim() !== '' && Number.isFinite(percent) && percent >= 1 && percent <= 10_000;
  const noChange = percentValid && percent === 100;
  const duplicate = instant != null && changes.some((entry) => entry.source === source && entry.at === instant);
  const atLimit = changes.length >= MAX_CHANGES;
  const canRecord = !saving && instant != null && at <= now && percentValid && !noChange && !duplicate && !atLimit;

  const save = async (next: AllowanceChange[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      await update({ allowanceChanges: next });
    } catch {
      setError('The allowance changes could not be saved. Try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="forecast-exclusions allowance-changes" aria-labelledby="allowance-changes-heading">
      <h3 id="allowance-changes-heading">Allowance changes</h3>
      <p id="allowance-changes-help">
        Record when a subscription’s allowance changed size, for example when a promotional boost ended. Readings taken
        before the change are rescaled to the current allowance, so the jump at the change is not learned as usage and
        earlier weeks stay comparable for pace and token capacity. Recorded usage, costs, and the provider’s own
        percentages are unchanged.
      </p>
      <form
        className="settings-fields forecast-exclusion-controls allowance-change-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRecord && instant) void save([...changes, { source, at: instant, previousAllowancePercent: percent }]);
        }}
      >
        <label>
          <span>Subscription</span>
          <select
            value={source}
            disabled={saving}
            onChange={(event) => setSource(event.target.value as AllowanceChange['source'])}
          >
            {Object.entries(SOURCE_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Changed at</span>
          <input
            type="datetime-local"
            min="2020-01-01T00:00"
            max={now}
            required
            value={at}
            disabled={saving}
            aria-describedby="allowance-changes-help allowance-changes-note"
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
        <label>
          <span>Allowance before the change</span>
          <div className="input-suffix">
            <input
              type="number"
              min={1}
              max={10_000}
              step={1}
              required
              value={previous}
              disabled={saving}
              aria-invalid={previous.trim() !== '' && (!percentValid || noChange)}
              onChange={(event) => setPrevious(event.target.value)}
            />
            <span>% of the one after</span>
          </div>
        </label>
        <button className="secondary-button" type="submit" disabled={!canRecord}>
          {duplicate ? 'Already recorded' : 'Record change'}
        </button>
      </form>
      <p id="allowance-changes-note" className="forecast-exclusion-note">
        Choose a time after the last reading on the old allowance and before the first reading on the new one. A boost
        of 50% that has ended means the earlier allowance was 150% of the one that replaced it. Each entry compares the
        allowance before it with the allowance after it, so it stays right if the allowance changes again. Times use{' '}
        {snapshot.timezone}.
      </p>
      <p role="status" className="forecast-exclusion-note">
        {changes.length === 0
          ? 'No allowance changes recorded.'
          : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} recorded.${atLimit ? ' Remove a change before adding another.' : ''}`}
        {noChange ? ' An allowance of 100% is not a change.' : ''}
      </p>
      {changes.length > 0 && (
        <ul className="forecast-exclusion-list" aria-label="Recorded allowance changes">
          {latestFirst.map((change) => {
            const when = instantFormatter(snapshot.timezone).format(new Date(change.at));
            const label = `${SOURCE_LABELS[change.source]}, ${when}`;
            return (
              <li key={`${change.source}|${change.at}`}>
                <span>
                  <strong>{SOURCE_LABELS[change.source]}</strong> <time dateTime={change.at}>{when}</time>, previously{' '}
                  {change.previousAllowancePercent}% of the allowance that followed
                </span>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  aria-label={`Remove the allowance change for ${label}`}
                  onClick={() => {
                    if (inFlight.current) return;
                    void save(changes.filter((entry) => entry !== change));
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
