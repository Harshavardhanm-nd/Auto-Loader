import React from 'react';
import { api } from '../api.js';
import { Badge, Callout } from '../components/ui.jsx';

/**
 * Review & send.
 *
 * One file per family, one email each — every send carries exactly one attachment. The
 * destination mailbox is the loudest thing on this screen because it is the only thing that
 * tells the parser which operation a file represents.
 */
export default function ReviewPage({ runId, run, refreshRun, goto, onError }) {
  const [operation, setOperation] = React.useState(null);
  const [operations, setOperations] = React.useState(null);
  const [validation, setValidation] = React.useState(null);
  const [previews, setPreviews] = React.useState({});
  const [busy, setBusy] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [blocked, setBlocked] = React.useState([]);

  const activeOperation = operation ?? run?.operation ?? 'initialLoad';

  const loadOperations = React.useCallback(() => {
    api.operations(runId).then((d) => setOperations(d.operations)).catch(onError);
  }, [runId, onError]);

  React.useEffect(loadOperations, [loadOperations, run?.artifacts, run?.sends]);

  const loadValidation = React.useCallback(async () => {
    setBusy('validate');
    try {
      setValidation(await api.validate(runId, activeOperation));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  }, [runId, activeOperation, onError]);

  React.useEffect(() => {
    if (run?.artifacts && Object.keys(run.artifacts).length) loadValidation();
  }, [loadValidation, run?.artifacts]);

  React.useEffect(() => {
    if (!run?.artifacts) return;
    Object.keys(run.artifacts).forEach((key) => {
      api
        .preview(runId, key)
        .then((p) => setPreviews((current) => ({ ...current, [key]: p })))
        .catch(() => {});
    });
  }, [runId, run?.artifacts]);

  if (!run) return <p className="muted">Loading run…</p>;

  const generate = async () => {
    setBusy('generate');
    setNotice(null);
    try {
      const result = await api.generate(runId, activeOperation);
      setBlocked(result.blocked ?? []);
      await refreshRun();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const send = async (family, force = false) => {
    setBusy(`send:${family}`);
    setNotice(null);
    try {
      const result = await api.send(runId, { operation: activeOperation, family, force });
      setNotice({
        tone: result.sentItemsWarning ? 'warn' : 'ok',
        title: result.sentItemsWarning
          ? `Sent to ${result.send.to} — but not confirmed in Sent Items`
          : `Sent to ${result.send.to} and confirmed in Sent Items`,
        body: result.sentItemsWarning ?? `${result.send.filename} · ${result.send.rowCount} row(s)`,
      });
      await refreshRun();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const opMeta = operations?.find((o) => o.id === activeOperation);
  const filesForOperation = Object.entries(run.artifacts ?? {}).filter(([key]) =>
    key.startsWith(`${activeOperation}:`)
  );
  const wizardFile = Object.entries(run.artifacts ?? {}).find(([key]) => key.startsWith('wizardUpload:'));

  return (
    <>
      <div className="page-head">
        <h1>Review &amp; send</h1>
        <p>
          Tracking id <span className="mono">{run.trackingId}</span>
          {run.order ? (
            <>
              {' '}
              · order <span className="mono">{run.order.orderNumber}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="card">
        <div className="btn-row">
          {(operations ?? [])
            .filter((o) => o.anySupported && o.needsMail)
            .map((o) => (
              <button
                key={o.id}
                className={`btn ${activeOperation === o.id ? '' : 'secondary'} small`}
                onClick={() => {
                  setOperation(o.id);
                  setValidation(null);
                  setBlocked([]);
                }}
              >
                {o.label}
                {o.families.some((f) => f.sent) ? ' ✓' : ''}
              </button>
            ))}
          <div className="spacer" />
          <div className="btn-row">
            <button className="btn secondary small" disabled={busy === 'generate'} onClick={generate}>
              {busy === 'generate' ? 'Generating…' : filesForOperation.length ? 'Re-generate' : 'Generate files'}
            </button>
            {filesForOperation.length ? (
              <button className="btn secondary small" disabled={busy === 'validate'} onClick={loadValidation}>
                {busy === 'validate' ? 'Checking…' : 'Re-run checks'}
              </button>
            ) : null}
          </div>
        </div>

        {opMeta ? (
          <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Family</th>
                  <th>Mailbox</th>
                  <th>Template</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {opMeta.families.map((f) => (
                  <tr key={f.family}>
                    <td className="small">{f.familyLabel}</td>
                    <td className="mono small">{f.to ?? <span className="muted">—</span>}</td>
                    <td className="mono small muted">{f.templateId ?? 'not supported'}</td>
                    <td>
                      {!f.supported ? (
                        <Badge tone="muted">no template</Badge>
                      ) : f.sent ? (
                        <Badge tone="ok">sent</Badge>
                      ) : f.blockers.length ? (
                        <Badge tone="warn">not configured</Badge>
                      ) : f.generated ? (
                        <Badge tone="info">ready</Badge>
                      ) : (
                        <Badge tone="muted">not generated</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {blocked.length ? (
        <Callout tone="warn" title="Some families produced no file">
          {blocked.map((b) => (
            <div key={b.family} style={{ marginBottom: '0.4rem' }}>
              <strong style={{ display: 'inline' }}>{b.familyLabel}</strong> — {b.message}
            </div>
          ))}
        </Callout>
      ) : null}

      {notice ? (
        <Callout tone={notice.tone} title={notice.title}>
          {notice.body}
        </Callout>
      ) : null}

      {filesForOperation.length === 0 ? (
        <Callout tone="warn" title={`No files generated for ${opMeta?.label ?? activeOperation}`}>
          Generate them to review the bytes and send.
        </Callout>
      ) : (
        filesForOperation.map(([key, artifact]) => {
          const family = key.slice(activeOperation.length + 1);
          const familyInfo = opMeta?.families.find((f) => f.family === family);
          return (
            <FileCard
              key={key}
              runId={runId}
              artifactKey={key}
              operation={activeOperation}
              family={family}
              familyLabel={familyInfo?.familyLabel ?? family}
              artifact={artifact}
              preview={previews[key]}
              alreadySent={run.sends?.[key]}
              to={familyInfo?.to}
              blockers={familyInfo?.blockers ?? []}
              canSend={validation?.canSend && !busy && (familyInfo?.blockers?.length ?? 0) === 0}
              busy={busy === `send:${family}`}
              onSend={(force) => send(family, force)}
            />
          );
        })
      )}

      {wizardFile ? (
        <div className="card">
          <h2>Wizard upload</h2>
          <p className="muted small">
            Not emailed. Upload this in the "Load Asset &amp; Ship Order" wizard once the shipment
            update has settled. It is the only file whose row count must equal the order's
            serialized quantity.
          </p>
          <FileCard
            runId={runId}
            artifactKey={wizardFile[0]}
            artifact={wizardFile[1]}
            preview={previews[wizardFile[0]]}
            uploadOnly
          />
        </div>
      ) : null}

      {validation ? <Checklist validation={validation} /> : null}

      <div className="btn-row">
        <button className="btn secondary" onClick={() => goto('watch')}>
          Go to watch →
        </button>
      </div>
    </>
  );
}

function FileCard({
  runId,
  artifactKey,
  operation,
  family,
  familyLabel,
  artifact,
  preview,
  alreadySent,
  to,
  blockers = [],
  canSend,
  busy,
  onSend,
  uploadOnly,
}) {
  const [showBytes, setShowBytes] = React.useState(false);

  return (
    <div className="card">
      <div className="card-row" style={{ marginBottom: '0.5rem' }}>
        <div style={{ minWidth: 0 }}>
          {familyLabel ? <div className="small muted">{familyLabel}</div> : null}
          <div className="mono">{artifact.filename}</div>
          <div className="muted small">
            {artifact.rowCount} row(s) · {artifact.byteLength} bytes · template{' '}
            <span className="mono">{artifact.template}</span>
          </div>
          {to ? (
            <div className="small" style={{ marginTop: '0.3rem' }}>
              → <span className="mono">{to}</span>
            </div>
          ) : null}
        </div>
        <div className="spacer" />
        <div className="btn-row">
          <button className="btn secondary small" onClick={() => setShowBytes((v) => !v)}>
            {showBytes ? 'Hide' : 'Show'} bytes
          </button>
          <a
            className="btn secondary small"
            style={{ textDecoration: 'none' }}
            href={api.downloadUrl(runId, artifactKey, Boolean(artifact.uploadAs))}
          >
            Download
          </a>
          {!uploadOnly ? (
            <>
              <a
                className="btn secondary small"
                style={{ textDecoration: 'none' }}
                href={api.emlUrl(runId, operation, family)}
                title="Ready-to-send message, if SMTP is blocked"
              >
                .eml
              </a>
              {alreadySent?.ok ? (
                <>
                  <Badge tone="ok">sent {new Date(alreadySent.sentAt).toLocaleTimeString()}</Badge>
                  <button
                    className="btn danger small"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${artifact.filename} was already sent to ${alreadySent.to}. Sending it again to the same mailbox is a double load. Continue?`
                        )
                      ) {
                        onSend(true);
                      }
                    }}
                  >
                    Re-send
                  </button>
                </>
              ) : (
                <button className="btn small" disabled={!canSend || busy} onClick={() => onSend(false)}>
                  {busy ? 'Sending…' : 'Send'}
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {blockers.length ? (
        <p className="small" style={{ color: 'var(--warn)', margin: '0.3rem 0 0' }}>
          Sending blocked — placeholder config: {blockers.join(', ')}
        </p>
      ) : null}

      {alreadySent?.sentItems && alreadySent.sentItems.confirmed !== true ? (
        <p className="small" style={{ color: 'var(--warn)', margin: '0.3rem 0 0' }}>
          Sent Items: {alreadySent.sentItems.reason ?? 'not confirmed'}
        </p>
      ) : null}

      {showBytes && preview ? (
        <div style={{ marginTop: '0.6rem' }}>
          <pre className="hex">{preview.hex}</pre>
        </div>
      ) : null}
    </div>
  );
}

function Checklist({ validation }) {
  return (
    <div className="card">
      <div className="card-row" style={{ marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>Pre-send checks</h2>
        <div className="spacer" />
        <span className="muted small">
          {validation.counts.passed} passed · {validation.counts.failed} failed ·{' '}
          {validation.counts.skipped} skipped
        </span>
        {validation.canSend ? <Badge tone="ok">clear to send</Badge> : <Badge tone="fail">{validation.blockers.length} blocker(s)</Badge>}
      </div>

      {Object.entries(validation.groups).map(([key, checks]) => (
        <div key={key} style={{ marginBottom: '1rem' }}>
          <h3 className="small" style={{ color: 'var(--muted)' }}>
            {key === 'org' ? 'Against the org' : key}
          </h3>
          <ul className="checklist">
            {checks.map((c) => (
              <li key={`${key}:${c.id}`}>
                <span className={`mark ${c.status}`}>
                  {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}
                </span>
                <div>
                  <div>
                    {c.label}{' '}
                    {c.status === 'fail' && c.severity === 'warning' ? <Badge tone="warn">warning</Badge> : null}
                    {c.status === 'skipped' ? <Badge tone="warn">not checked</Badge> : null}
                  </div>
                  {c.detail ? <div className="detail">{c.detail}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
