import { OctagonAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The fallback is a plain component so its markup can be rendered on its own.
 * Inside the dashboard it replaces only the page that failed, so the
 * glareshield stays usable; the raw message is kept verbatim for reporting.
 */
export function ErrorFallback({ message }: { message: string }) {
  return (
    <div className="state-stage">
      <section className="state-panel is-error error-fallback" role="alert">
        <span className="state-panel-icon">
          <OctagonAlert aria-hidden="true" />
        </span>
        <div className="state-panel-body">
          <h1>AI Usage hit a rendering error</h1>
          <p className="state-panel-message">{message}</p>
          <button type="button" className="btn btn-p" onClick={() => window.location.reload()}>
            Reload dashboard
          </button>
        </div>
      </section>
    </div>
  );
}

type State = { message: string | null };

// React 19 still has no hook for catching render errors; this class is the
// only way to keep one broken component from blanking the whole window.
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Dashboard rendering failed', error);
    void window.aiUsage
      ?.reportRendererError?.({ message: error.message, componentStack: info.componentStack ?? '' })
      .catch(() => {});
  }

  render() {
    return this.state.message == null ? this.props.children : <ErrorFallback message={this.state.message} />;
  }
}
