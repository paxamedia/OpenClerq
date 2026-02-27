/**
 * Collapsible section with smooth expand/collapse.
 */
import { useState } from 'react';

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  badge,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: string | number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="collapsible-section">
      <button
        type="button"
        className="collapsible-section__header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="collapsible-section__title">{title}</span>
        {badge != null && <span className="collapsible-section__badge">{badge}</span>}
        <span className="collapsible-section__chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="collapsible-section__content">{children}</div>}
    </section>
  );
}
