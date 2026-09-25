import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FlyoutApp } from './components/TrayFlyout';
import type { FlyoutBridge } from './types';
// The Flight Deck tokens, fonts, element defaults and the shared keys and
// annunciator; the flyout's own layout lives in flyout.css.
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './flyout.css';

const root = createRoot(document.getElementById('root')!);

function render(bridge?: FlyoutBridge) {
  root.render(
    <StrictMode>
      <FlyoutApp bridge={bridge} />
    </StrictMode>,
  );
}

// Demo data is a browser-preview adapter only, guarded as in App.tsx: Electron
// always has window.aiUsageFlyout (from the flyout preload), so an installed
// flyout can never show demo figures. The adapter loads on demand.
const isBrowserPreview = !window.aiUsageFlyout && window.location.protocol !== 'file:';
if (isBrowserPreview) {
  void import('./flyout-preview').then(({ previewFlyoutBridge }) => render(previewFlyoutBridge()));
} else {
  render();
}
