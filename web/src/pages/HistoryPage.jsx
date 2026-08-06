import React from 'react';
import { api } from '../api.js';
import { Badge, PageHead, Sheet } from '../components/ui.jsx';

/**
 * Run history. Device ids that were emailed exist in the org whether or not this app
 * remembers them, so every run is kept until explicitly deleted — this is the record of what
 * was loaded, and the fastest way to answer "what were the ids from that run last Tuesday".
 */
export default function HistoryPage({ setRunId, goto, onError }) {
  const [runs, setRuns] = React.useState(null);

  const load = React.useCallback(() => {
    api
      .runs()
      .then((data) => setRuns(data.runs))
      .catch(onError);
  }, [onError]);

  React.useEffect(load, [load]);

  return (
    <>
      <PageHead eyebrow="Record" title="History">
        <p>
          Every run, with the device ids it loaded. Deleting a record here removes this app's copy
          only — whatever was emailed stays in Salesforce.
        </p>
      </PageHead>

      {runs === null ? (
        <p className="muted">Loading…</p>
      ) : runs.length === 0 ? (
        <Sheet>
          <p className="muted small" style={{ margin: 0 }}>
            No runs yet. Start one from Connect and it will be recorded here.
          </p>
        </Sheet>
      ) : (
        <Sheet eyebrow={`${runs.length} run(s)`} title="Loaded to date">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Env</th>
                  <th>Operation</th>
                  <th>Tracking</th>
                  <th>Order</th>
                  <th>Families &amp; lines</th>
                  <th className="num">Units</th>
                  <th>Status</th>
                  <th>Sent</th>
                  <th className="num">Loaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <td className="mono small">
                      {run.runId}
                      <div className="faint">{new Date(run.createdAt).toLocaleString()}</div>
                    </td>
                    <td className="small">{run.env}</td>
                    <td className="small">{run.operation}</td>
                    <td className="mono small">{run.trackingId}</td>
                    <td className="mono small">{run.orderNumber ?? <span className="faint">none</span>}</td>
                    <td className="small">
                      {run.groups.map((g) => (
                        <div key={g.family}>
                          <span className="muted">{g.familyLabel}:</span>{' '}
                          <span className="mono">
                            {g.lines.map((l) => `${l.sku} ×${l.deviceCount}`).join(', ')}
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className="num">{run.unitCount}</td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="small">
                      {run.sends.length ? (
                        run.sends.map((s) => (
                          <div key={s.key} title={s.to}>
                            <Badge tone="ok">
                              {s.operation}/{s.family}
                            </Badge>
                          </div>
                        ))
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                    <td className="num">
                      {run.loadedDeviceIds.length}
                      {run.failedDeviceIds.length ? (
                        <div style={{ color: 'var(--fail)' }}>{run.failedDeviceIds.length} failed</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="btn-row">
                        <button
                          className="btn secondary small"
                          onClick={() => {
                            setRunId(run.runId);
                            goto('watch');
                          }}
                        >
                          Open
                        </button>
                        <a className="btn small" href={api.resultTextUrl(run.runId)}>
                          Ids
                        </a>
                        <button
                          className="btn quiet small"
                          onClick={async () => {
                            if (
                              window.confirm(
                                `Delete the local record of ${run.runId}? The devices it loaded stay in Salesforce — only this app's record and its generated files are removed.`
                              )
                            ) {
                              await api.deleteRun(run.runId);
                              load();
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Sheet>
      )}
    </>
  );
}

function StatusBadge({ status }) {
  const tones = {
    completed: 'ok',
    'initial-load-done': 'ok',
    'completed-with-failures': 'fail',
    'initial-load-partial': 'fail',
    sent: 'info',
    'files-generated': 'muted',
    'ids-allocated': 'muted',
    draft: 'muted',
  };
  return <Badge tone={tones[status] ?? 'muted'}>{status}</Badge>;
}
