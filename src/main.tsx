import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function FatalScreen({ title, error }: { title: string; error: unknown }) {
  return (
    <div
      style={{
        minHeight: '100%',
        boxSizing: 'border-box',
        padding: '24px',
        background: '#111111',
        color: '#f5f5f5',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      <div style={{ maxWidth: '960px', margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: '18px' }}>{title}</h1>
        <p style={{ margin: '12px 0 0', color: '#c7c7c7', fontSize: '13px' }}>
          Mini-Term failed during startup. The captured error is shown below.
        </p>
        <pre
          style={{
            marginTop: '16px',
            padding: '16px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: '#1b1b1b',
            border: '1px solid #333333',
            borderRadius: '8px',
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          {formatError(error)}
        </pre>
      </div>
    </div>
  );
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: unknown | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error('Root render failed', error);
  }

  render() {
    if (this.state.error) {
      return <FatalScreen title="Render Error" error={this.state.error} />;
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root container');
}

const root = ReactDOM.createRoot(rootElement);

function renderFatal(title: string, error: unknown) {
  root.render(
    <React.StrictMode>
      <FatalScreen title={title} error={error} />
    </React.StrictMode>,
  );
}

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

document.addEventListener('keydown', (event) => {
  if (event.key.startsWith('F') && !Number.isNaN(Number(event.key.slice(1)))) {
    event.preventDefault();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'i') {
    event.preventDefault();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  console.error('Unhandled window error', event.error ?? event.message);
  renderFatal('Startup Error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection', event.reason);
  renderFatal('Unhandled Promise Rejection', event.reason);
});

void import('./App')
  .then(({ App }) => {
    root.render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  })
  .catch((error) => {
    console.error('Failed to load App', error);
    renderFatal('Failed To Load App', error);
  });
