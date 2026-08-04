import React from 'react';
import { api } from './api.js';
import { Badge, ErrorBanner } from './components/ui.jsx';
import ConnectPage from './pages/ConnectPage.jsx';
import SetupPage from './pages/SetupPage.jsx';
import PickerPage from './pages/PickerPage.jsx';
import IdsPage from './pages/IdsPage.jsx';
import ReviewPage from './pages/ReviewPage.jsx';
import WatchPage from './pages/WatchPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';

const STEPS = [
  { id: 'connect', label: 'Connect', needs: () => true },
  { id: 'setup', label: 'Setup', needs: (s) => s.connected },
  { id: 'skus', label: 'Families & SKUs', needs: (s) => Boolean(s.setup.trackingId) },
  { id: 'ids', label: 'Ids', needs: (s) => Boolean(s.runId) },
  { id: 'review', label: 'Review & send', needs: (s) => Boolean(s.runId) },
  { id: 'watch', label: 'Watch', needs: (s) => Boolean(s.runId) },
  { id: 'history', label: 'History', needs: () => true },
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
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Auto Loader
          <small>device &amp; accessory loads</small>
        </div>

        <div className="env-switch">
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
              {e.ready ? '' : ' ⚠'}
            </button>
          ))}
        </div>

        <nav className="nav">
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
                <span className={`step-num ${done ? 'step-done' : ''}`}>{done ? '✓' : i + 1}</span>
                {step.label}
              </button>
            );
          })}
        </nav>

        <div className="session-chip">
          <div className="line">
            <span className={`dot ${connected ? 'ok' : 'muted'}`} />
            {connected ? `SF: ${session.salesforce.username ?? 'connected'}` : 'Salesforce: not connected'}
          </div>
          <div className="line">
            <span className={`dot ${session?.smtp?.configured ? 'ok' : 'muted'}`} />
            {session?.smtp?.configured ? `Mail: ${session.smtp.user}` : 'Mail: not configured'}
          </div>
          {run ? (
            <div className="line">
              <span className="dot info" />
              <span className="mono" style={{ fontSize: 10 }}>
                {run.trackingId} · {run.groups.length} family
                {run.groups.length === 1 ? '' : 's'}
              </span>
            </div>
          ) : null}
          {activeEnv && !activeEnv.ready ? (
            <div className="line">
              <Badge tone="fail">{activeEnv.label} unusable</Badge>
            </div>
          ) : activeEnv?.pendingPipelines?.length ? (
            <div className="line">
              <Badge tone="warn">{activeEnv.pendingPipelines.length} pipeline(s) unsent-able</Badge>
            </div>
          ) : null}
        </div>

        <div className="spacer" />

        <div style={{ padding: '0 0.5rem' }}>
          <button className="btn secondary small" style={{ width: '100%' }} onClick={() => startNewRun()}>
            New run
          </button>
        </div>
      </aside>

      <main className="main">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {page === 'connect' ? <ConnectPage {...shared} /> : null}
        {page === 'setup' ? <SetupPage {...shared} /> : null}
        {page === 'skus' ? <PickerPage {...shared} /> : null}
        {page === 'ids' ? <IdsPage {...shared} /> : null}
        {page === 'review' ? <ReviewPage {...shared} /> : null}
        {page === 'watch' ? <WatchPage {...shared} /> : null}
        {page === 'history' ? <HistoryPage {...shared} /> : null}
      </main>
    </div>
  );
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
