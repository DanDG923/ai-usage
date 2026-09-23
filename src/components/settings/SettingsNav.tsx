import { useEffect, useRef } from 'react';
import {
  ADVANCED_GROUP_LABEL,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  type SettingsSectionMeta,
  type SourcesBadge,
} from './settings-sections';

export function SettingsNav({
  active,
  matches,
  sources,
  unpriced,
  onNavigate,
}: {
  active: SettingsSectionId;
  /** Sections matching the current search, or null when nothing is being searched. */
  matches: ReadonlySet<SettingsSectionId> | null;
  sources: SourcesBadge;
  unpriced: number;
  onNavigate: (id: SettingsSectionId) => void;
}) {
  const navRef = useRef<HTMLElement>(null);

  // As a horizontal strip, keep the highlighted entry in view. Only the strip
  // scrolls: moving the page here would cancel a smooth section scroll.
  useEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!nav || !link || nav.scrollWidth <= nav.clientWidth + 1) return;
    const strip = nav.getBoundingClientRect();
    const entry = link.getBoundingClientRect();
    if (entry.left < strip.left || entry.right > strip.right) {
      nav.scrollLeft += entry.left - strip.left - (strip.width - entry.width) / 2;
    }
  }, [active]);

  const badge = (id: SettingsSectionId) => {
    if (id === 'sources') {
      return (
        <span className={`settings-nav-status ${sources.tone}`}>
          <span className="sr-only">, </span>
          {sources.label}
        </span>
      );
    }
    if (id === 'pricing' && unpriced > 0) {
      return (
        <span className="settings-nav-chip">
          <span className="sr-only">, </span>
          {unpriced} unpriced
        </span>
      );
    }
    return null;
  };

  const item = (section: SettingsSectionMeta) => {
    const dimmed = matches ? !matches.has(section.id) : false;
    return (
      <li key={section.id}>
        <a
          href={`#${section.id}`}
          className={dimmed ? 'is-dimmed' : undefined}
          aria-current={active === section.id ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(section.id);
          }}
        >
          <span className="settings-nav-label">{section.title}</span>
          {badge(section.id)}
          {dimmed && <span className="sr-only"> (no matches)</span>}
        </a>
      </li>
    );
  };

  return (
    <nav ref={navRef} className="settings-nav" aria-label="Settings sections">
      <ul>{SETTINGS_SECTIONS.filter((section) => !section.advanced).map(item)}</ul>
      <p className="settings-nav-group" id="settings-nav-advanced">
        {ADVANCED_GROUP_LABEL}
      </p>
      <ul aria-labelledby="settings-nav-advanced">
        {SETTINGS_SECTIONS.filter((section) => section.advanced).map(item)}
      </ul>
    </nav>
  );
}
