import { Component, type ReactNode } from 'react';

/** The fallback is a plain component so its markup can be rendered on its own. */
export function ErrorFallback({ message }: { message: string }) {
  return (
    <div className="app-shell">
      <main className="page">
        <section className="panel status-panel error-fallback" role="alert">
          <h1>AI Usage hit a rendering error</h1>
          <p>{message}</p>
          <button className="refresh-button" onClick={() => window.location.reload()}>
            Reload dashboard
          </button>
        </section>
      </main>
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

  render() {
    return this.state.message == null ? this.props.children : <ErrorFallback message={this.state.message} />;
  }
}
