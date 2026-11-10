/**
 * The Flight Deck mark: a fuel tape with a trace running into it. The
 * glareshield and the tray flyout size it through their own class.
 */
export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3h5v18h-5z M14 12h5 M3.5 16l4.5-5 3 3 3.5-4.5" />
    </svg>
  );
}
