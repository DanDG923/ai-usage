import type { ReactNode } from 'react';
import { useState } from 'react';

export function NumericSetting({
  label,
  value,
  min,
  max,
  step,
  suffix,
  disabled = false,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  // A saved value arriving from a snapshot replaces the draft; typing does not.
  const [committed, setCommitted] = useState(value);
  if (committed !== value) {
    setCommitted(value);
    setDraft(String(value));
  }
  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  const commit = () => {
    if (!valid) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) void onCommit(parsed);
  };
  const input = (
    <input
      aria-label={label}
      disabled={disabled}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
  return (
    <label>
      <span>{label}</span>
      {suffix ? (
        <div className="input-suffix">
          {input}
          <span>{suffix}</span>
        </div>
      ) : (
        input
      )}
    </label>
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i />
    </label>
  );
}

export function SectionHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  /** Optional right-hand content, e.g. a note or a control. */
  aside?: ReactNode;
}) {
  return (
    <div className="panel-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {aside && <div className="panel-aside">{aside}</div>}
    </div>
  );
}

export function hourOptions(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index).map((hour) => (
    <option value={hour} key={hour}>
      {String(hour).padStart(2, '0')}:00
    </option>
  ));
}
