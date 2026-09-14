import type { QuotaWindow } from '../src/types';

export type SelectionOptions<T> = { nowMs?: number; isExpired?: (window: T) => boolean };
export type WindowSelection<T> = { primary: T | null; active: T[]; secondary: T[]; expired: T[] };

export function isMainWindow(window: Pick<QuotaWindow, 'bucketId' | 'metadata'> | null | undefined): boolean;
export function isOfficialWindow(window: Pick<QuotaWindow, 'provenance'> | null | undefined): boolean;
export function orderWindows<T extends Partial<QuotaWindow>>(
  windows: T[] | null | undefined,
  options?: SelectionOptions<T>,
): { window: T; index: number; expired: boolean }[];
export function selectDisplayedWindows<T extends Partial<QuotaWindow>>(
  windows: T[] | null | undefined,
  options?: SelectionOptions<T>,
): WindowSelection<T>;
