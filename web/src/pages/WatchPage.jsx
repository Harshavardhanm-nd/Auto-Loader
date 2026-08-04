import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Stat, SyncStatusBadge, Spinner } from '../components/ui.jsx';

const STAGES = [
  { id: 'initialLoad', label: 'Initial load', success: 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS' },
  { id: 'shipmentUpdate', label: 'Shipment update', success: 'SHIPMENT_UPDATE_SYNC_SUCCESS' },
];

/**
 * Polling view.
 *
 * A *_SYNC_FAILED is a terminal answer, not a reason to keep waiting — roughly a third of
 * initial loads fail in this org, so failure is surfaced the moment it appears and the poll
 * stops as soon as every device has settled either way.
 */
export default function WatchPage({ runId, run, refreshRun, onError }) {
  const [stage, setStage] = React.useState('initialLoad');
  const [poll, setPoll] = React.useState(null);
  const [busy, setBusy] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      setPoll(await api.poll(runId, stage));
    } catch (err) {
      onError(err);
    }
  }, [runId, stage, onError]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Mirror the server's polling loop while it is running.
  React.useEffect(() => {
    if (!poll?.running) return undefined;
    const timer = setInterval(() => {
      load();
      refreshRun().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [poll?.running, load, refreshRun]);

  if (!run) return <p className="muted">Loading run…</p>;

  const snapshot = poll?.snapshot;
  const stageMeta = STAGES.find((s) => s.id === stage);
  const sendsForStage = Object.values(run.sends ?? {}).filter((s) => s.operation === stage && s.ok);
  const unitCount = run.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.deviceCount, 0), 0);

  const act = async (fn, key) => {
    setBusy(key);
    try {
      await fn();
      await load();
      await refreshRun();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Watch</h1>
        <p>
          Polling <code>Asset.Sync_Status__c</code> for the {unitCount} unit(s) in this run across{' '}
          {run.groups.length} famil{run.groups.length === 1 ? 'y' : 'ies'}. Polling continues
          server-side — closing this page does not stop it.
        </p>
      </div>

      <div className="card">
        <div className="btn-row">
          {STAGES.map((s) => (
            <button
              key={s.id}
              className={`btn ${stage === s.id ? '' : 'secondary'} small`}
              onClick={() => setStage(s.id)}
            >
              {s.label}
            </button>
          ))}
          <div className="spacer" />
          <div className="btn-row">
            <button
              className="btn small"
              disabled={busy || poll?.running}
              onClick={() => act(() => api.startPoll(runId, stage), 'start')}
            >
              {poll?.running ? 'Polling…' : 'Start polling'}
            </button>
            <button
              className="btn secondary small"
              disabled={busy}
              onClick={() => act(() => api.pollOnce(runId, stage), 'once')}
            >
              Refresh now
            </button>
            {poll?.running ? (
              <button
                className="btn secondary small"
                disabled={busy}
                onClick={() => act(() => api.stopPoll(runId, stage), 'stop')}
              >
                Stop
              </button>
            ) : null}
          </div>
        </div>

        {sendsForStage.length === 0 ? (
          <p className="small" style={{ color: 'var(--warn)', marginTop: '0.6rem', marginBottom: 0 }}>
            The {stageMeta.label.toLowerCase()} email has not been sent from this run yet — there
            may be nothing to watch.
          </p>
        ) : (
          <p className="muted small" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
            Sent to <span className="mono">{sendsForStage[0].to}</span> at{' '}
            {new Date(sendsForStage[0].sentAt).toLocaleTimeString()} · waiting for{' '}
            <span className="mono">{stageMeta.success}</span>
          </p>
        )}
      </div>

      {snapshot ? (
        <>
          <div className="card">
            <div className="stat-row">
              <Stat value={snapshot.counts?.total ?? 0} label="Devices" />
              <Stat value={snapshot.counts?.succeeded ?? 0} label="Succeeded" tone="ok" />
              <Stat
                value={snapshot.counts?.failed ?? 0}
                label="Failed"
                tone={snapshot.counts?.failed ? 'fail' : undefined}
              />
              <Stat value={snapshot.counts?.waiting ?? 0} label="Waiting" tone="warn" />
              <div className="spacer" />
              <div className="stat">
                <span className="value" style={{ fontSize: '0.95rem' }}>
                  <StateBadge state={snapshot.state} running={poll.running} />
                </span>
                <span className="label">
                  {snapshot.lastPolledAt
                    ? `polled ${new Date(snapshot.lastPolledAt).toLocaleTimeString()}`
                    : 'not polled yet'}
                </span>
              </div>
            </div>
          </div>

          {snapshot.anyFailed ? (
            <Callout tone="fail" title={`${snapshot.failedDeviceIds.length} device(s) failed to sync`}>
              <code>*_SYNC_FAILED</code> is terminal — these will not recover on their own. Around a
              third of initial loads fail in this org. Re-allocate ids for the failed devices and
              send again, or investigate the asset records directly.
              <div className="mono small" style={{ marginTop: '0.4rem' }}>
                {snapshot.failedDeviceIds.join(', ')}
              </div>
            </Callout>
          ) : null}

          {snapshot.state === 'timed-out' ? (
            <Callout tone="warn" title="Polling timed out">
              {snapshot.reason}
            </Callout>
          ) : null}
          {snapshot.state === 'interrupted' ? (
            <Callout tone="warn" title="Polling stopped early">
              {snapshot.reason} The devices were still sent — reconnect and refresh to pick up
              where this left off.
            </Callout>
          ) : null}
          {snapshot.lastError ? (
            <Callout tone="warn" title="Last poll errored">
              {snapshot.lastError}
            </Callout>
          ) : null}

          <div className="card">
            <h2>Per device</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>device_id</th>
                    <th>Sync status</th>
                    <th>IDMS</th>
                    <th>Asset status</th>
                    <th>Attached order</th>
                    <th>Last change</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.rows ?? []).map((row) => (
                    <tr key={row.deviceId}>
                      <td className="mono">{row.deviceId}</td>
                      <td>
                        {row.present ? (
                          <SyncStatusBadge status={row.syncStatus} />
                        ) : (
                          <Badge tone="muted">no asset yet</Badge>
                        )}
                      </td>
                      <td className="num small muted">{row.idmsStatus ?? '—'}</td>
                      <td className="small">{row.assetStatus ?? '—'}</td>
                      <td className="mono small">
                        {row.cpqOrderNumber ?? <span className="muted">unattached</span>}
                      </td>
                      <td className="small muted">
                        {row.lastModifiedDate ? new Date(row.lastModifiedDate).toLocaleTimeString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: '0.6rem' }}>
              An unattached device is normal at this stage. The <code>CPQ_Order__c</code> lookup is
              set by the wizard, not by either email — until then the only link to the order is the
              tracking id string.
            </p>
          </div>
        </>
      ) : (
        <div className="card">
          {poll?.running ? <Spinner label="Waiting for the first reading…" /> : <p className="muted small">No polling data yet for this stage.</p>}
        </div>
      )}

      {run.result ? <ResultCard run={run} runId={runId} /> : null}
    </>
  );
}

function StateBadge({ state, running }) {
  if (running) return <Badge tone="info">polling</Badge>;
  const tones = {
    settled: 'ok',
    'timed-out': 'warn',
    interrupted: 'warn',
    stopped: 'muted',
    waiting: 'warn',
  };
  return <Badge tone={tones[state] ?? 'muted'}>{state ?? 'idle'}</Badge>;
}

function ResultCard({ run, runId }) {
  const ids = run.result.loadedDeviceIds ?? [];
  return (
    <div className="card">
      <div className="card-row" style={{ marginBottom: '0.6rem' }}>
        <h2 style={{ margin: 0 }}>Loaded device ids</h2>
        <div className="spacer" />
        <div className="btn-row">
          <button
            className="btn secondary small"
            onClick={() => navigator.clipboard?.writeText(ids.join('\n'))}
          >
            Copy {ids.length}
          </button>
          <a className="btn secondary small" style={{ textDecoration: 'none' }} href={api.resultTextUrl(runId)}>
            Download
          </a>
        </div>
      </div>
      <p className="muted small">
        Reached {run.result.stage === 'shipmentUpdate' ? 'SHIPMENT_UPDATE_SYNC_SUCCESS' : 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS'} ·
        finalised {new Date(run.result.finalisedAt).toLocaleString()}
      </p>
      <pre className="hex">{ids.length ? ids.join('\n') : 'none'}</pre>
      {run.result.failedDeviceIds?.length ? (
        <>
          <h3 style={{ marginTop: '0.9rem', color: 'var(--fail)' }}>Failed</h3>
          <pre className="hex">{run.result.failedDeviceIds.join('\n')}</pre>
        </>
      ) : null}
    </div>
  );
}
