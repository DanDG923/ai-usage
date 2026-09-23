import { dateTimeLabel, relativeTime } from '../../lib';

/**
 * "4 min ago" measured from the snapshot rather than the wall clock, so the
 * label matches the data it sits beside. The exact instant stays
 * machine-readable in dateTime and appears on hover.
 */
export function RelativeTime({ value, nowMs }: { value: string; nowMs: number }) {
  return (
    <time dateTime={value} title={dateTimeLabel(value)}>
      {relativeTime(value, nowMs)}
    </time>
  );
}
