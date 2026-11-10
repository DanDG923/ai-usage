// The shared stylesheets load here: the cascade layer order first, then the
// Flight Deck foundation (tokens, fonts, element defaults, the shell and the
// shared components), the instruments, and the session and model window rows
// that the Overview and the provider page both draw. Each page's own
// stylesheet, in styles/pages/, is imported by its component (Activity and
// Costs: costs-activity-shared.css then their own; Overview: overview.css;
// ProviderDetail: provider.css; Settings and ClaudeSetup: settings.css).
// Which stylesheet wins is set by styles/layers.css, not by the order here.
import './styles/layers.css';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/charts.css';
import './styles/windows.css';
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
