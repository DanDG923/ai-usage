import { ChevronRight } from 'lucide-react';

/**
 * Progressive disclosure for caveats and method notes. The one-line summary
 * stays on the page beside the numbers; the full explanation is one click
 * away. It stays in the DOM, so browser find-in-page can still reveal it, but
 * screen readers only reach it once the disclosure is opened.
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
    <details className={className ? `caveat-disclosure ${className}` : 'caveat-disclosure'}>
      <summary>
        <ChevronRight aria-hidden="true" />
        {summary}
      </summary>
      <div className="caveat-body">{children}</div>
    </details>
  );
}
