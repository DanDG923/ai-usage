import { useEffect, useRef, useState } from 'react';
import { LOCALE } from '../../lib';
import type { Settings, Snapshot } from '../../types';

const dateFormatter = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' });

// One formatter per zone, kept for the life of the page: this runs on every
// render of the section, which includes each keystroke in the date field.
const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

function localDate(timezone: string) {
  let formatter = localDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    localDateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dateLabel(date: string) {
  return dateFormatter.format(new Date(`${date}T12:00:00Z`));
}

export function ForecastExcludedDates({
  snapshot,
  update,
}: {
  snapshot: Snapshot;
  update: (patch: Partial<Settings>) => Promise<void | boolean>;
}) {
  const today = localDate(snapshot.timezone);
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const dateInput = useRef<HTMLInputElement>(null);
  const removing = useRef<string | null>(null);
  const dates = snapshot.settings.forecastExcludedDates;
  // Reverse a copy: the renderer's ES2022 target does not expose toReversed.
  // oxlint-disable-next-line unicorn/no-array-reverse
  const latestFirst = [...dates].reverse();
  const alreadyIgnored = dates.includes(date);
  const atLimit = dates.length >= 366;

  useEffect(() => {
    if (saving || !removing.current) return;
    if (!dates.includes(removing.current)) dateInput.current?.focus();
    removing.current = null;
  }, [dates, saving]);

  const save = async (next: string[]) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      if ((await update({ forecastExcludedDates: next })) === false) throw new Error('Save failed');
    } catch {
      setError('The ignored dates could not be saved. Try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="forecast-exclusions" aria-labelledby="forecast-exclusions-heading">
      <h3 id="forecast-exclusions-heading">Ignored forecast days</h3>
      <p id="forecast-exclusions-help">
        Exclude an unusual day from the patterns learned for Codex, Claude, and Fable. Recorded usage, costs, and your
        current allowance stay intact. You can include the day again at any time.
      </p>
      <form
        className="settings-fields forecast-exclusion-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (date && date <= today && !alreadyIgnored && !atLimit) void save([...dates, date].sort());
        }}
      >
        <label>
          <span>Day to ignore</span>
          <input
            ref={dateInput}
            type="date"
            min="2020-01-01"
            max={today}
            required
            value={date}
            disabled={saving}
            aria-describedby="forecast-exclusions-help forecast-exclusions-timezone"
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={saving || !date || date > today || alreadyIgnored || atLimit}
        >
          {alreadyIgnored ? 'Already ignored' : 'Ignore day'}
        </button>
      </form>
      <p id="forecast-exclusions-timezone" className="forecast-exclusion-note">
        Dates use {snapshot.timezone}. Usage intervals crossing an ignored day are also left out of learning.
      </p>
      <p role="status" className="forecast-exclusion-note">
        {dates.length === 0
          ? 'No days ignored.'
          : `${dates.length} ${dates.length === 1 ? 'day' : 'days'} ignored.${atLimit ? ' Include a day again before adding another.' : ''}`}
      </p>
      {dates.length > 0 && (
        <ul className="forecast-exclusion-list" aria-label="Ignored forecast days">
          {latestFirst.map((ignored) => {
            const label = dateLabel(ignored);
            return (
              <li key={ignored}>
                <time dateTime={ignored}>{label}</time>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  aria-label={`Include ${label} in forecasts again`}
                  onClick={() => {
                    if (inFlight.current) return;
                    removing.current = ignored;
                    void save(dates.filter((item) => item !== ignored));
                  }}
                >
                  Include again
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
