import { ChevronRight } from 'lucide-react';

/**
 * Progressive disclosure for caveats and method notes: the Deck disclosure
 * (components.css .disclosure), a chevron and a one-line summary. The full
 * explanation stays in the DOM, so browser find-in-page can still reveal it,
 * but screen readers only reach it once the disclosure is opened.
 */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={className ? `disclosure ${className}` : 'disclosure'}>
      <summary>
        <ChevronRight aria-hidden="true" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
