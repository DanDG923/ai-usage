import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FlyoutApp } from './components/TrayFlyout';
// Read for its design tokens only; every flyout style lives in flyout.css.
import './professional.css';
import './flyout.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlyoutApp />
  </StrictMode>,
);
