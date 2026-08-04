import React from 'react';

export function Badge({ tone = 'muted', children }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Callout({ tone = 'info', title, children }) {
  return (
    <div className={`callout ${tone === 'info' ? '' : tone}`}>
      {title ? <strong>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Stat({ value, label, tone }) {
  return (
    <div className="stat">
      <span className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
      <span className="label">{label}</span>
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <Callout tone="fail" title={error.needsReconnect ? 'Salesforce session needs reconnecting' : 'Something went wrong'}>
      <div style={{ whiteSpace: 'pre-wrap' }}>{error.message}</div>
      {onDismiss ? (
        <div className="btn-row" style={{ marginTop: '0.5rem' }}>
          <button className="btn secondary small" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
    </Callout>
  );
}

/** Sync_Status__c rendered by meaning rather than by raw string. */
export function SyncStatusBadge({ status }) {
  if (!status) return <Badge tone="muted">no asset yet</Badge>;
  if (status.endsWith('_SYNC_FAILED')) return <Badge tone="fail">{status}</Badge>;
  if (status.endsWith('_SYNC_SUCCESS')) return <Badge tone="ok">{status}</Badge>;
  return <Badge tone="warn">{status}</Badge>;
}

export function Spinner({ label }) {
  return (
    <span className="muted small">
      <span className="dot muted pulse" style={{ marginRight: '0.4rem' }} />
      {label}
    </span>
  );
}

export function useAsync(fn, deps, { immediate = true } = {}) {
  const [state, setState] = React.useState({ loading: immediate, data: null, error: null });
  const fnRef = React.useRef(fn);
  fnRef.current = fn;

  const run = React.useCallback(async (...args) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current(...args);
      setState({ loading: false, data, error: null });
      return data;
    } catch (error) {
      setState({ loading: false, data: null, error });
      throw error;
    }
  }, []);

  React.useEffect(() => {
    if (immediate) run().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, run, setState };
}
