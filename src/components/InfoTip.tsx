import { Info } from 'lucide-react';
import { useId, useState } from 'react';

/**
 * A small "what does this mean" affordance. The explanation is always in the
 * DOM for assistive technology (linked by aria-describedby) and is shown on
 * hover, focus, or click for everyone else.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={`info-tip${open ? ' open' : ''}`}>
      <button
        type="button"
        className="info-tip-button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <Info />
      </button>
      <span role="tooltip" id={id} className="info-tip-body">
        {children}
      </span>
    </span>
  );
}

export const API_EQUIVALENT_EXPLAINER =
  'The tracked tokens repriced at today’s API list prices, per model, as if every call had been billed by the token. It is a comparison, not an invoice: subscription fees, tool and web-search charges, taxes, regular Claude desktop and web chats, and work done on other devices are not included. Price coverage describes recorded tokens only, not how much of your account activity was captured. Editing a price reprices all displayed history.';
