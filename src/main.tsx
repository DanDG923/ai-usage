// Global tokens and base styles load first, so page stylesheets imported by
// components (overview.css, settings.css, pages.css) can refine them.
import './professional.css';
import './tasks.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
