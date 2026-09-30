import { AlertOctagon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

function classes(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(' ');
}

function ids(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(' ') || undefined;
}

/**
 * A Settings section: one config page. The h2 heading and a muted description
 * sit above the section's rows, inside one panel; the page's keycap number is
 * drawn by CSS, so it never joins the heading's accessible name. The heading
 * takes focus when the section is reached from the navigation. `id` is the
 * link target other pages and the navigation use.
 */
export function SettingsSection({
  id,
  title,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} className={classes('settings-section', className)} aria-labelledby={headingId}>
      <header className="settings-section-head">
        <h2 id={headingId} tabIndex={-1}>
          {title}
        </h2>
        {description && <p>{description}</p>}
      </header>
      <div className="settings-card">{children}</div>
    </section>
  );
}

/**
 * One setting as a challenge-response row: LABEL ······ CONTROL, with the
 * description as a hint underneath. The DOM keeps label, then description,
 * then control (the order a screen reader reads); the grid places them, and
 * the dotted leader is an empty element, never text.
 * Pass `htmlFor` when the control is a single form element; otherwise the
 * label gets `labelId` so a group of controls can reference it.
 */
export function SettingRow({
  label,
  description,
  htmlFor,
  labelId,
  descriptionId,
  className,
  id,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  labelId?: string;
  descriptionId?: string;
  className?: string;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <div className={classes('setting-row', className)} id={id}>
      <div className="setting-text">
        {htmlFor ? (
          <label className="setting-label" htmlFor={htmlFor} id={labelId}>
            {label}
          </label>
        ) : (
          <span className="setting-label" id={labelId}>
            {label}
          </span>
        )}
        {description && (
          <div className="setting-description" id={descriptionId}>
            {description}
          </div>
        )}
      </div>
      {children != null && (
        <>
          <span className="lead" aria-hidden="true" />
          <div className="setting-control">{children}</div>
        </>
      )}
    </div>
  );
}

export function NumericSetting({
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  integer = false,
  disabled = false,
  onCommit,
  onDraftChange,
}: {
  label: string;
  description?: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  /** Whole numbers only. A fraction is invalid rather than rounded on save, so the field never shows what was not saved. */
  integer?: boolean;
  disabled?: boolean;
  onCommit: (value: number) => Promise<void | boolean>;
  /** The valid value being typed, or null when the draft is empty, out of range or abandoned. */
  onDraftChange?: (value: number | null) => void;
}) {
  const id = useId();
  const inputId = `${id}-input`;
  const descriptionId = description ? `${id}-description` : undefined;
  const suffixId = suffix ? `${id}-suffix` : undefined;
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const cancelBlur = useRef(false);
  // A saved value arriving from a snapshot replaces the draft; typing does not.
  const [committed, setCommitted] = useState(value);
  if (committed !== value) {
    setCommitted(value);
    setDraft(String(value));
  }
  const inRange = (text: string) => {
    const number = Number(text);
    return (
      text.trim() !== '' &&
      Number.isFinite(number) &&
      number >= min &&
      number <= max &&
      (!integer || Number.isInteger(number))
    );
  };
  const parsed = Number(draft);
  const valid = inRange(draft);
  const commit = async () => {
    if (cancelBlur.current) {
      cancelBlur.current = false;
      return;
    }
    if (!valid) {
      setDraft(String(value));
      onDraftChange?.(null);
      return;
    }
    if (parsed === value || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      if ((await onCommit(parsed)) === false) throw new Error('Save failed');
    } catch {
      setDraft(String(value));
      onDraftChange?.(null);
      setError('This value could not be saved. Try again.');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  const input = (
    <input
      id={inputId}
      aria-describedby={ids(descriptionId, suffixId)}
      aria-invalid={!valid || undefined}
      disabled={disabled || saving}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      className="fld num"
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        onDraftChange?.(inRange(next) ? Number(next) : null);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelBlur.current = true;
          setDraft(String(value));
          onDraftChange?.(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
  return (
    <SettingRow
      className="numeric-setting"
      label={label}
      htmlFor={inputId}
      description={description}
      descriptionId={descriptionId}
    >
      {suffix ? (
        <div className="input-suffix">
          {input}
          <span id={suffixId}>{suffix}</span>
        </div>
      ) : (
        input
      )}
      {error && <SettingError>{error}</SettingError>}
    </SettingRow>
  );
}

/** A save that failed: the warning icon and the words, under the control. */
export function SettingError({ children }: { children: ReactNode }) {
  return (
    <small className="setting-error" role="alert">
      <AlertOctagon aria-hidden="true" />
      {children}
    </small>
  );
}

export function SelectSetting({
  label,
  description,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  description?: ReactNode;
  value: string | number;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  const selectId = `${id}-select`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <SettingRow label={label} htmlFor={selectId} description={description} descriptionId={descriptionId}>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.value)}
        className="fld"
      >
        {children}
      </select>
    </SettingRow>
  );
}

/**
 * A switch row. The whole row toggles; the switch is a lamp and the state
 * written as On or Off, never colour alone. The control cell is the key face
 * itself; the native checkbox inside it keeps the switch role and takes
 * focus, and the face shows the ring.
 */
export function ToggleRow({
  title,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <label className={classes('setting-row', 'toggle-row', disabled && 'is-disabled')}>
      <span className="setting-text">
        <strong className="setting-label">{title}</strong>
        <span className="setting-description" id={descriptionId}>
          {description}
        </span>
      </span>
      <span className="lead" aria-hidden="true" />
      <span className="setting-control toggle-control sw">
        <input
          type="checkbox"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          aria-describedby={descriptionId}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="sw-lamp" aria-hidden="true" />
        <span className="toggle-state" aria-hidden="true">
          {checked ? 'On' : 'Off'}
        </span>
      </span>
    </label>
  );
}

/**
 * The two columns of rows a wide section is laid out in (one column when the
 * section is narrow). Plain elements, so the rows stay direct JSX children.
 */
export function SettingColumns({ children }: { children: ReactNode }) {
  return <div className="setting-cols">{children}</div>;
}

/** Full-width content inside a section panel, such as a list or a table. */
export function SettingBlock({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={classes('setting-block', className)}>{children}</div>;
}

/** A quiet footnote row at the end of a section panel. */
export function SettingNote({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={classes('setting-note', className)}>{children}</div>;
}

export function hourOptions(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index).map((hour) => (
    <option value={hour} key={hour}>
      {String(hour).padStart(2, '0')}:00
    </option>
  ));
}
