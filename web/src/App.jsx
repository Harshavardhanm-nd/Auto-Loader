import React from 'react';
import { api } from './api.js';
import { Badge, ErrorBanner, Segmented } from './components/ui.jsx';
import ConnectPage from './pages/ConnectPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import PickerPage from './pages/PickerPage.jsx';
import IdsPage from './pages/IdsPage.jsx';
import ReviewPage from './pages/ReviewPage.jsx';
import WatchPage from './pages/WatchPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import LifecyclePage from './pages/LifecyclePage.jsx';

/**
 * Connect → Watch is a real sequence, so those steps are numbered. History is
 * not step 7 — it is a different mode, and sits apart in the rail.
 */
const STEPS = [
  { id: 'connect', label: 'Connect', needs: () => true },
  { id: 'setup', label: 'Setup', needs: (s) => s.connected },
  { id: 'skus', label: 'Families & SKUs', needs: (s) => Boolean(s.setup.trackingId) },
  { id: 'ids', label: 'Ids', needs: (s) => Boolean(s.runId) },
  { id: 'review', label: 'Review & send', needs: (s) => Boolean(s.runId) },
  { id: 'watch', label: 'Watch', needs: (s) => Boolean(s.runId) },
];

/**
 * Not steps. The life cycle is the device's state, not a stage of this run, and history is a
 * record — numbering either of them would claim they come after Watch.
 */
const ASIDE = [
  { id: 'lifecycle', label: 'Life cycle', mark: '◇' },
  { id: 'history', label: 'History', mark: '≡' },
];

const EMPTY_SETUP = { operation: 'initialLoad', trackingId: '', orderNumber: '', order: null };

export default function App() {
  const [env, setEnv] = React.useState('testing');
  const [environments, setEnvironments] = React.useState([]);
  const [session, setSession] = React.useState(null);
  const [page, setPage] = React.useState('connect');
  const [setup, setSetup] = React.useState(EMPTY_SETUP);
  const [runId, setRunId] = React.useState(null);
  const [run, setRun] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [reviewOperation, setReviewOperation] = React.useState(null);
  const [theme, setTheme] = useTheme();

  const refreshSession = React.useCallback(
    async (which = env) => {
      try {
        setSession(await api.session(which));
      } catch (err) {
        setError(err);
      }
    },
    [env]
  );

  React.useEffect(() => {
    api
      .environments()
      .then((data) => {
        setEnvironments(data.environments);
        setEnv((current) => (data.environments.some((e) => e.name === current) ? current : data.default));
      })
      .catch(setError);
  }, []);

  React.useEffect(() => {
    refreshSession(env);
  }, [env, refreshSession]);

  const refreshRun = React.useCallback(
    async (id = runId) => {
      if (!id) return null;
      const { run: fresh } = await api.run(id);
      setRun(fresh);
      return fresh;
    },
    [runId]
  );

  React.useEffect(() => {
    if (runId) refreshRun(runId).catch(setError);
  }, [runId, refreshRun]);

  const handleError = React.useCallback((err) => {
    setError(err);
    if (err?.needsReconnect) {
      setSession((s) => (s ? { ...s, salesforce: { ...s.salesforce, connected: false } } : s));
      setPage('connect');
    }
  }, []);

  const connected = Boolean(session?.salesforce?.connected);
  const navState = { connected, setup, runId };
  const activeEnv = environments.find((e) => e.name === env);

  const goto = (id) => {
    setError(null);
    setPage(id);
  };

  // Clearing run state lands on Setup, but only when there is a session to query with —
  // otherwise Setup would immediately 401 on its recent-orders lookup.
  const startNewRun = (options = {}) => {
    setSetup(EMPTY_SETUP);
    setRunId(null);
    setRun(null);
    setReviewOperation(null);
    goto((options.connected ?? connected) ? 'setup' : 'connect');
  };

  const shared = {
    env,
    activeEnv,
    session,
    refreshSession,
    setup,
    setSetup,
    runId,
    setRunId,
    run,
    refreshRun,
    goto,
    onError: handleError,
    startNewRun,
    reviewOperation,
    setReviewOperation,
  };

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <ContainerMark />
          <span>
            <span className="mark">Auto Loader</span>
            <span className="eyebrow sub">Device ledger</span>
          </span>
        </div>

        <div className="env-switch" role="group" aria-label="Environment">
          {environments.map((e) => (
            <button
              key={e.name}
              aria-pressed={e.name === env}
              onClick={() => {
                // Sessions are per environment, so a switch always returns to Connect.
                setEnv(e.name);
                startNewRun({ connected: false });
              }}
              title={
                e.ready
                  ? `${e.instanceUrl}${e.pendingPipelines?.length ? ` — ${e.pendingPipelines.length} pipeline(s) awaiting a mailbox` : ''}`
                  : `Salesforce endpoint not configured: ${e.salesforceUnconfigured.join(', ')}`
              }
            >
              {e.label}
              {e.ready ? null : <span className="seg-flag" aria-hidden="true" />}
            </button>
          ))}
        </div>

        <div className="rail-section">
          <span className="eyebrow">Load sequence</span>
          <nav className="nav" aria-label="Load sequence">
            {STEPS.map((step, i) => {
              const enabled = step.needs(navState);
              const done = stepIsDone(step.id, navState, run);
              return (
                <button
                  key={step.id}
                  aria-current={page === step.id}
                  disabled={!enabled}
                  onClick={() => goto(step.id)}
                >
                  <span className={`step-num ${done ? 'step-done' : ''}`}>
                    {done ? '✓' : String(i + 1).padStart(2, '0')}
                  </span>
                  {step.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="rail-divider" />

        <nav className="nav nav-aside" aria-label="Records">
          {ASIDE.map((item) => (
            <button key={item.id} aria-current={page === item.id} onClick={() => goto(item.id)}>
              <span className="step-num">{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        <div className="session-chip">
          <div className="line">
            <span className={`dot ${connected ? 'ok' : 'muted'}`} />
            <span>{connected ? `SF · ${session.salesforce.username ?? 'connected'}` : 'Salesforce · not connected'}</span>
          </div>
          <div className="line">
            <span className={`dot ${session?.smtp?.configured ? 'ok' : 'muted'}`} />
            <span>
              {session?.smtp?.transport === 'outlook-web'
                ? 'Mail · Outlook web'
                : session?.smtp?.configured
                  ? `Mail · ${session.smtp.user}`
                  : 'Mail · not configured'}
            </span>
          </div>
          {activeEnv && !activeEnv.ready ? (
            <div className="line">
              <Badge tone="fail">{activeEnv.label} unusable</Badge>
            </div>
          ) : activeEnv?.pendingPipelines?.length ? (
            <div className="line">
              <Badge tone="warn">{activeEnv.pendingPipelines.length} without a mailbox</Badge>
            </div>
          ) : null}
        </div>

        <div className="theme-switch">
          <Segmented
            className="wide"
            label="Appearance"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>

        <div style={{ padding: '0 0.4rem' }}>
          <button className="btn secondary small" style={{ width: '100%', justifyContent: 'center' }} onClick={() => startNewRun()}>
            New run
          </button>
        </div>
      </aside>

      <main className="main">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        <Runbar env={activeEnv?.label ?? env} setup={setup} run={run} />

        <div className="doc" key={page}>
          {page === 'connect' ? <ConnectPage {...shared} /> : null}
          {page === 'setup' ? <SetupPage {...shared} /> : null}
          {page === 'skus' ? <PickerPage {...shared} /> : null}
          {page === 'ids' ? <IdsPage {...shared} /> : null}
          {page === 'review' ? <ReviewPage {...shared} /> : null}
          {page === 'watch' ? <WatchPage {...shared} /> : null}
          {page === 'lifecycle' ? <LifecyclePage {...shared} /> : null}
          {page === 'history' ? <HistoryPage {...shared} /> : null}
        </div>
      </main>
    </div>
  );
}

/**
 * The run's identity, in the same seven fields on every page. Cells start empty
 * and fill in as the run takes shape, so the strip is also the progress record.
 */
function Runbar({ env, setup, run }) {
  const units = run
    ? run.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + Number(l.deviceCount || 0), 0), 0)
    : null;

  const cells = [
    ['Environment', env],
    ['Operation', humanise(run?.operation ?? setup.operation)],
    ['Tracking id', run?.trackingId ?? setup.trackingId ?? null],
    ['Order', run?.order?.orderNumber ?? setup.order?.orderNumber ?? null],
    ['Families', run ? run.groups.length : null],
    ['Units', units],
    ['State', runState(run)],
  ];

  return (
    <div className="runbar">
      {cells.map(([label, value], i) => (
        <div className={`cell${i === cells.length - 1 && run ? ' is-live' : ''}`} key={label}>
          <span className="eyebrow">{label}</span>
          <span className={`v${value === null || value === '' ? ' empty' : ''}`} title={value ? String(value) : undefined}>
            {value === null || value === '' ? '—' : value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * An isometric container — the unit this whole app moves, and the shape language of the
 * palette it is drawn in: royal blue faces, one eggplant.
 */
function ContainerMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
      <path d="M16 3 28 9.9 16 16.8 4 9.9z" fill="var(--brand-soft)" />
      <path d="M4 9.9 16 16.8 16 30 4 23.1z" fill="var(--brand)" />
      <path d="M28 9.9 28 23.1 16 30 16 16.8z" fill="var(--highlight)" />
    </svg>
  );
}

/** camelCase operation ids are the only label the client has for them. */
function humanise(id) {
  if (!id) return null;
  const spaced = id.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Derived from the same run fields the rail's step marks read. */
function runState(run) {
  if (!run) return null;
  if (run.result?.finalisedAt) {
    return run.result.failedDeviceIds?.length ? 'Part failed' : 'Complete';
  }
  if (Object.values(run.sends ?? {}).some((s) => s?.ok)) return 'Sent';
  if (Object.keys(run.artifacts ?? {}).length) return 'Files ready';
  if (run.idGeneration) return 'Ids allocated';
  return 'Draft';
}

/** Light is the default so the palette is never at the mercy of an OS setting. */
function useTheme() {
  const [theme, setTheme] = React.useState(() => {
    try {
      // Anything stored under the previous palette's names falls back to light.
      const saved = localStorage.getItem('autoloader.theme');
      return saved === 'light' || saved === 'dark' ? saved : 'light';
    } catch {
      return 'light';
    }
  });

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('autoloader.theme', theme);
    } catch {
      /* private mode — the choice just does not persist */
    }
  }, [theme]);

  return [theme, setTheme];
}

function stepIsDone(stepId, navState, run) {
  switch (stepId) {
    case 'connect':
      return navState.connected;
    case 'setup':
      return Boolean(navState.setup.trackingId);
    case 'skus':
      return Boolean(navState.runId);
    case 'ids':
      return Boolean(run?.idGeneration);
    case 'review':
      return Object.values(run?.sends ?? {}).some((s) => s?.ok);
    case 'watch':
      return Boolean(run?.result?.finalisedAt);
    default:
      return false;
  }
}
