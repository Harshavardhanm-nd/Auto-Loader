import React from 'react';

/** A stamped mark rather than a pill — status here is a mark on a manifest. */
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

/** `raw` keeps the label's own case — for a label that is a literal column name. */
export function Field({ label, hint, raw = false, children }) {
  return (
    <label className="field">
      <span className={raw ? 'group-label' : undefined}>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** The docket header every page opens with: step marker, title, double rule. */
export function PageHead({ eyebrow, title, children }) {
  return (
    <div className="page-head">
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

/**
 * The reasoning behind a panel, folded away until asked for.
 *
 * This app's screens each carry a paragraph or two explaining why the step works the way it does.
 * That is worth keeping — most of it is hard-won and nowhere else on screen — but read once it is
 * noise, and it pushed the controls that matter below the fold. So it folds.
 *
 * A native `<details>` rather than component state: it needs no re-render, it is keyboard
 * accessible for free, and the browser's own find-in-page still reaches the text while collapsed,
 * which a `hidden` div would not.
 */
export function Explainer({ label = 'How this works', children }) {
  return (
    <details className="explainer">
      <summary>{label}</summary>
      <div className="explainer-body">{children}</div>
    </details>
  );
}

/**
 * A sheet of paper laid on the desk. `title`/`eyebrow`/`actions` render the
 * ruled head; without them the sheet is a plain panel.
 */
export function Sheet({ eyebrow, title, actions, children, className = '', live = false }) {
  const hasHead = Boolean(eyebrow || title || actions);
  return (
    <section className={`sheet ${className}`.trim()}>
      {hasHead ? (
        <header className={`sheet-head${live ? ' scanline' : ''}`}>
          <div className="titles">
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/**
 * One grammar for every "pick one of these" in the app: operation, family,
 * stage, login method, theme.
 *
 * options: [{ value, label, count, flag, done, title, disabled }]
 *   count — a number shown beside the label (SKUs picked, for instance)
 *   flag  — an amber dot: usable, but something about it is not configured
 *   done  — a check: this one has already been through
 */
export function Segmented({ options, value, onChange, label, className = '' }) {
  return (
    <div className={`segmented ${className}`.trim()} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count ? <span className="seg-count">{o.count}</span> : null}
          {o.done ? <span className="seg-done">✓</span> : null}
          {o.flag ? <span className="seg-flag" aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Key/value rows as a printed form. Rows are `[label, value]`; a null value
 * drops the row, so callers can list every field they might show.
 */
export function KeyValue({ rows }) {
  const visible = rows.filter((r) => r && r[1] !== null && r[1] !== undefined);
  if (!visible.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {visible.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <Callout
      tone="fail"
      title={error.needsReconnect ? 'Salesforce session needs reconnecting' : 'Something went wrong'}
    >
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
    <span className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
      <span className="dot info pulse" />
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
