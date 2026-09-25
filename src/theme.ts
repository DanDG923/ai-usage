import type { Theme } from './types';

/**
 * Puts the Settings theme on <html> for src/styles/tokens.css: "dark" pins the
 * night palette and "light" pins Daylight, while "system" removes the
 * attribute so the palette follows prefers-color-scheme (Windows). Inside
 * Electron the main process also sets nativeTheme.themeSource from the same
 * setting, so the media query is right before React runs; the attribute is
 * what makes the choice work in the browser preview. Used by the dashboard
 * and by the tray flyout.
 */
export function applyThemeAttribute(theme: Theme | undefined) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  else delete root.dataset.theme;
}
