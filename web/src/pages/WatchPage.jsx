import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, PageHead, Segmented, Sheet, Stat, SyncStatusBadge, Spinner } from '../components/ui.jsx';

/**
 * Polling view.
 *
 * A *_SYNC_FAILED is a terminal answer, not a reason to keep waiting — roughly a third of
 * initial loads fail in this org, so failure is surfaced the moment it appears and the poll
 * stops as soon as every device has settled either way.
 *
 * Which stages can be watched comes from the life cycle model, not a list here: an operation is
 * pollable when `config/lifecycle.json` knows its Sync_Status__c base. Four operations carry a
 * mailbox and no known status, and waiting on those would hang for the full timeout.
 *
 * A settled stage is not the end. The same devices carry on through the chart, so the panel at
 * the bottom answers the question that actually follows: what moves them next, and is it mine.
 */
export default function WatchPage({ runId, run, refreshRun, goto, onError }) {
  const [stage, setStage] = React.useState('initialLoad');
  const [poll, setPoll] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [model, setModel] = React.useState(null);
  const [position, setPosition] = React.useState(null);

  React.useEffect(() => {
    api.lifecycle().then(setModel).catch(() => setModel(null));
  }, []);

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

  const loadPosition = React.useCallback(() => {
    api
      .runLifecycle(runId)
      .then(setPosition)
      .catch(() => setPosition(null));
  }, [runId]);

  React.useEffect(loadPosition, [loadPosition]);

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

  const stages = pollableStages(model);
  const stageMeta = stages.find((s) => s.id === stage) ?? { id: stage, label: stage, success: null };
  const snapshot = poll?.snapshot;
  const sendsForStage = Object.values(run.sends ?? {}).filter((s) => s.operation === stage && s.ok);
  const unitCount = run.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.deviceCount, 0), 0);

  const act = async (fn, key) => {
    setBusy(key);
    try {
      await fn();
      await load();
      await refreshRun();
      loadPosition();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead eyebrow="Step 06 · Convergence" title="Watch">
        <p>
          Polling <code>Asset.Sync_Status__c</code> for the {unitCount} unit(s) in this run across{' '}
          {run.groups.length} famil{run.groups.length === 1 ? 'y' : 'ies'}. Polling continues
          server-side — closing this page does not stop it.
        </p>
      </PageHead>

      <Sheet
        eyebrow="Stage"
        title={stageMeta.label}
        live={Boolean(poll?.running)}
        actions={
          <>
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
                className="btn quiet small"
                disabled={busy}
                onClick={() => act(() => api.stopPoll(runId, stage), 'stop')}
              >
                Stop
              </button>
            ) : null}
          </>
        }
      >
        <Segmented
          label="Stage"
          value={stage}
          onChange={setStage}
          options={stages.map((s) => ({
            value: s.id,
            label: s.label,
            title: s.movesTo ? `Moves the device to ${s.movesTo}` : 'Does not change the stage',
            done: Object.values(run.sends ?? {}).some((x) => x.operation === s.id && x.ok),
          }))}
        />

        {sendsForStage.length === 0 ? (
          <p className="small" style={{ color: 'var(--warn)', marginTop: '0.8rem', marginBottom: 0 }}>
            The {stageMeta.label.toLowerCase()} email has not been sent from this run yet — there
            may be nothing to watch.
          </p>
        ) : (
          <p className="prose small" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
            Sent to <span className="mono">{sendsForStage[0].to}</span> at{' '}
            {new Date(sendsForStage[0].sentAt).toLocaleTimeString()} · waiting for{' '}
            <span className="mono">{stageMeta.success ?? 'a status this operation does not write'}</span>
          </p>
        )}
      </Sheet>

      {snapshot ? (
        <>
          <Sheet>
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
                <span className="value" style={{ fontSize: '0.95rem', paddingTop: '0.35rem' }}>
                  <StateBadge state={snapshot.state} running={poll.running} />
                </span>
                <span className="label">
                  {snapshot.lastPolledAt
                    ? `polled ${new Date(snapshot.lastPolledAt).toLocaleTimeString()}`
                    : 'not polled yet'}
                </span>
              </div>
            </div>
          </Sheet>

          {snapshot.anyFailed ? (
            <Callout tone="fail" title={`${snapshot.failedDeviceIds.length} device(s) failed to sync`}>
              <code>*_SYNC_FAILED</code> is terminal — these will not recover on their own. Around a
              third of initial loads fail in this org. Re-allocate ids for the failed devices and
              send again, or investigate the asset records directly.
              <div className="mono small" style={{ marginTop: '0.45rem' }}>
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

          {/* The eyebrow is uppercased, so it must not carry literal field names — those are
              set in the prose below, in their own case. */}
          <Sheet eyebrow="Sync status and stage" title="Per device" live={Boolean(poll?.running)}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="raw">device_id</th>
                    <th>Sync status</th>
                    <th>Life cycle stage</th>
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
                      <td>
                        <StageCell stage={row.stage} idmsStatus={row.idmsStatus} />
                      </td>
                      <td className="small">{row.assetStatus ?? '—'}</td>
                      <td className="mono small">
                        {row.cpqOrderNumber ?? <span className="faint">unattached</span>}
                      </td>
                      <td className="small muted">
                        {row.lastModifiedDate ? new Date(row.lastModifiedDate).toLocaleTimeString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
              The sync status says whether the load landed; the stage says where the device now is.
              They move separately — a device can be at <span className="mono">_SYNC_SUCCESS</span>{' '}
              and not have changed stage yet. An unattached device is normal at this stage: the{' '}
              <code>CPQ_Order__c</code> lookup is set by the wizard, not by either email.
            </p>
          </Sheet>
        </>
      ) : (
        <Sheet>
          {poll?.running ? (
            <Spinner label="Waiting for the first reading…" />
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              No polling data yet for this stage.
            </p>
          )}
        </Sheet>
      )}

      {position?.stages?.rows ? <NextStep position={position} goto={goto} /> : null}

      {run.result ? <ResultCard run={run} runId={runId} /> : null}
    </>
  );
}

/**
 * The stages that can actually be watched, ordered along the chart.
 *
 * Falls back to the two operations that were hard-coded here before the model existed, so a
 * failed lifecycle fetch degrades to the old behaviour rather than an empty control.
 */
function pollableStages(model) {
  // A partial or unexpected payload must not take the page down — polling is the one screen
  // that has to keep working while the org is being flaky.
  if (!model?.operations?.length || !model?.stages?.length) {
    return [
      { id: 'initialLoad', label: 'Initial load', success: 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS', movesTo: null },
      { id: 'shipmentUpdate', label: 'Shipment update', success: 'SHIPMENT_UPDATE_SYNC_SUCCESS', movesTo: null },
    ];
  }

  const order = new Map(model.stages.map((s, i) => [s.code, i]));
  return model.operations
    .filter((o) => o.syncStatus)
    .map((o) => ({
      id: o.id,
      label: o.label,
      success: `${o.syncStatus}_SYNC_SUCCESS`,
      movesTo: o.movement ? model.stages.find((s) => s.code === o.movement.to[0])?.label ?? null : null,
      rank: o.movement ? order.get(o.movement.to[0]) ?? 99 : 99,
    }))
    .sort((a, b) => a.rank - b.rank);
}

function StageCell({ stage, idmsStatus }) {
  if (!stage) {
    return <span className="faint small mono">{idmsStatus ?? '—'}</span>;
  }
  if (stage.absent) return <Badge tone="muted">no stage yet</Badge>;
  if (!stage.known) {
    return (
      <Badge tone="warn" title="This code is not on the DLCM chart">
        {stage.code ?? stage.label} not mapped
      </Badge>
    );
  }
  return (
    <span className="nowrap">
      <span className="mono faint small">{stage.code}</span>{' '}
      <span className="small">{stage.label}</span>
    </span>
  );
}

/**
 * What happens to these devices next.
 *
 * The honest answer is usually "nothing you can do" — most of the chart is driven by the
 * Installer App, the customer, or the order integration. Saying so is the point: it is the
 * difference between the app looking stuck and the app being finished with its part.
 */
function NextStep({ position, goto }) {
  const { position: pos, stages } = position;
  const next = position.next ?? { mine: [], theirs: [] };

  return (
    <Sheet
      eyebrow={`${position.deviceCount} device(s) · ${position.read === 'live' ? 'stage read from the org' : 'stage unavailable'}`}
      title={pos ? `Now at ${pos.label}` : 'Split across stages'}
      actions={
        <>
          {pos ? <Badge tone="info">stage {pos.code}</Badge> : <Badge tone="warn">no single next step</Badge>}
          <button className="btn quiet small" onClick={() => goto('lifecycle')}>
            See the chart
          </button>
        </>
      }
    >
      {!pos ? (
        <>
          <div className="stat-row" style={{ marginBottom: '0.9rem' }}>
            {stages.rows.map((r) => (
              <Stat
                key={r.key}
                value={r.count}
                label={r.known ? `${r.code} ${r.label}` : r.label}
                tone={r.known ? undefined : 'warn'}
              />
            ))}
          </div>
          <Callout tone="warn" title="These devices are not all in the same stage">
            No next step is suggested while they disagree. Act on one stage at a time — a send
            aimed at the majority leaves the rest behind without saying so.
          </Callout>
        </>
      ) : null}

      {next.mine.length ? (
        <>
          <span className="eyebrow" style={{ marginBottom: '0.5rem' }}>
            Your next step
          </span>
          {next.mine.map((step) => (
            <div className="lc-next" key={step.operation}>
              <div style={{ minWidth: 0 }}>
                <div className="lc-next-head">
                  <strong>{step.operationLabel}</strong>
                  <span className="muted small">→ {step.toLabel}</span>
                  {step.alreadySent ? <Badge tone="ok">sent</Badge> : null}
                  {!step.sendable ? <Badge tone="warn">no sheet yet</Badge> : null}
                </div>
                <div className="muted small">
                  {step.label}
                  {step.sendable
                    ? ' — same devices, same ids, one more email.'
                    : ' — this operation has a mailbox but no CSV format yet.'}
                </div>
              </div>
              <button
                className={`btn ${step.sendable && !step.alreadySent ? '' : 'secondary'} small`}
                onClick={() => goto('review')}
              >
                {step.alreadySent ? 'Already sent — review' : 'Go to Review & send'}
              </button>
            </div>
          ))}
        </>
      ) : pos ? (
        <Callout tone="ok" title={`Nothing for you to send from ${pos.label}`}>
          Every arrow out of this stage belongs to another system
          {next.theirs.length ? ` — ${[...new Set(next.theirs.map((t) => t.actor))].join(', ')}` : ''}. The
          devices stay here until one of them acts. Your part of the chain is done.
        </Callout>
      ) : null}

      {next.theirs.length ? (
        <div style={{ marginTop: '0.9rem' }}>
          <span className="eyebrow" style={{ marginBottom: '0.4rem' }}>
            Waiting on others
          </span>
          <ul className="lc-trans">
            {next.theirs.map((t) => (
              <li key={t.label + t.to}>
                <span className="lc-trans-stage mono">
                  {t.to} {t.toLabel}
                </span>
                <span className="lc-trans-label">{t.label}</span>
                <span className="muted small nowrap">{t.actor}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Sheet>
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
    <Sheet
      eyebrow={`Finalised ${new Date(run.result.finalisedAt).toLocaleString()}`}
      title="Loaded device ids"
      actions={
        <>
          <button className="btn secondary small" onClick={() => navigator.clipboard?.writeText(ids.join('\n'))}>
            Copy {ids.length}
          </button>
          <a className="btn small" href={api.resultTextUrl(runId)}>
            Download
          </a>
        </>
      }
    >
      <p className="prose small">
        Reached{' '}
        <span className="mono">
          {run.result.stage === 'shipmentUpdate'
            ? 'SHIPMENT_UPDATE_SYNC_SUCCESS'
            : 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS'}
        </span>
        . These ids exist in the org whether or not this app remembers them.
      </p>
      <pre className="hex">{ids.length ? ids.join('\n') : 'none'}</pre>
      {run.result.failedDeviceIds?.length ? (
        <>
          <h3 style={{ marginTop: '1rem', color: 'var(--fail)' }}>Failed</h3>
          <pre className="hex">{run.result.failedDeviceIds.join('\n')}</pre>
        </>
      ) : null}
    </Sheet>
  );
}
