import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, PageHead, Segmented, Sheet } from '../components/ui.jsx';

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

  const send = async (family, { force = false, autoSend } = {}) => {
    setBusy(`send:${family}`);
    setNotice(null);
    try {
      const result = await api.send(runId, { operation: activeOperation, family, force, autoSend });

      // Compose-and-stop: the message is filled in but not sent, so this is not recorded as a
      // send. The user presses Send in Outlook, then confirms here.
      if (result.composedOnly) {
        setNotice({
          tone: 'warn',
          title: `Composed in Outlook — press Send there, then confirm below`,
          body: `${result.filename} → ${result.to}. ${result.message}`,
          confirmFamily: family,
        });
        return;
      }

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

  const confirmSend = async (family, force = false) => {
    setBusy(`confirm:${family}`);
    try {
      const result = await api.confirmSend(runId, { operation: activeOperation, family, force });
      if (!result.recorded) {
        setNotice({
          tone: 'fail',
          title: 'Not recorded as sent',
          body: result.message,
          confirmFamily: family,
          allowForce: true,
        });
        return;
      }
      setNotice({
        tone: 'ok',
        title: `Recorded: sent to ${result.send.to}`,
        body: `${result.send.filename}${result.send.forced ? ' (forced — Sent Items was not confirmed)' : ' — confirmed in Sent Items'}`,
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
      <PageHead eyebrow="Step 05 · Dispatch" title="Review & send">
        <p>
          One file per family, one email each — every send carries exactly one attachment. Tracking
          id <span className="mono">{run.trackingId}</span>
          {run.order ? (
            <>
              {' '}
              · order <span className="mono">{run.order.orderNumber}</span>
            </>
          ) : null}
          .
        </p>
      </PageHead>

      <Sheet
        eyebrow={
          opMeta?.movement
            ? `Moves ${opMeta.movement.fromLabels.join(' / ')} → ${opMeta.movement.toLabels.join(' / ')}`
            : opMeta?.stagePreserving
              ? 'Does not change the life cycle stage'
              : 'Operation'
        }
        title={opMeta?.label ?? 'Pipeline'}
        actions={
          <>
            <button className="btn secondary small" disabled={busy === 'generate'} onClick={generate}>
              {busy === 'generate' ? 'Generating…' : filesForOperation.length ? 'Re-generate' : 'Generate files'}
            </button>
            {filesForOperation.length ? (
              <button className="btn quiet small" disabled={busy === 'validate'} onClick={loadValidation}>
                {busy === 'validate' ? 'Checking…' : 'Re-run checks'}
              </button>
            ) : null}
          </>
        }
      >
        <Segmented
          label="Operation"
          value={activeOperation}
          onChange={(id) => {
            setOperation(id);
            setValidation(null);
            setBlocked([]);
          }}
          options={(operations ?? [])
            .filter((o) => o.anySupported && o.needsMail)
            .map((o) => ({
              value: o.id,
              label: o.label,
              done: o.families.some((f) => f.sent),
              // The stage movement in the tooltip, so the order of the list is not the only
              // hint about which operation follows which.
              title: o.movement
                ? `${o.movement.fromLabels.join(' / ')} → ${o.movement.toLabels.join(' / ')}`
                : o.stagePreserving
                  ? 'Updates data without moving the device'
                  : undefined,
            }))}
        />

        {opMeta ? (
          <div className="table-wrap" style={{ marginTop: '1rem' }}>
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
                    <td className="mono small">{f.to ?? <span className="faint">—</span>}</td>
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
      </Sheet>

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
          {notice.confirmFamily ? (
            <div className="btn-row" style={{ marginTop: '0.65rem' }}>
              <button
                className="btn small"
                disabled={busy === `confirm:${notice.confirmFamily}`}
                onClick={() => confirmSend(notice.confirmFamily, false)}
              >
                {busy === `confirm:${notice.confirmFamily}` ? 'Checking Sent Items…' : "I've sent it — check Sent Items"}
              </button>
              {notice.allowForce ? (
                <button
                  className="btn danger small"
                  onClick={() => {
                    if (window.confirm('Record this as sent without confirming it in Sent Items?')) {
                      confirmSend(notice.confirmFamily, true);
                    }
                  }}
                >
                  Record anyway
                </button>
              ) : null}
            </div>
          ) : null}
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
              onSend={(opts) => send(family, opts)}
              transport={validation?.smtp?.transport}
              autoSendDefault={validation?.smtp?.autoSend}
            />
          );
        })
      )}

      {wizardFile ? (
        <FileCard
          runId={runId}
          artifactKey={wizardFile[0]}
          artifact={wizardFile[1]}
          preview={previews[wizardFile[0]]}
          uploadOnly
          familyLabel="Wizard upload · not emailed"
          note={
            <p className="prose small">
              Upload this in the "Load Asset &amp; Ship Order" wizard once the shipment update has
              settled. It is the only file whose row count must equal the order's serialized
              quantity.
            </p>
          }
        />
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
  transport,
  autoSendDefault,
  note,
}) {
  const [showBytes, setShowBytes] = React.useState(false);
  const outlook = transport === 'outlook-web';

  return (
    <Sheet
      className="file-sheet"
      eyebrow={familyLabel}
      title={artifact.filename}
      actions={
        <>
          <button className="btn quiet small" onClick={() => setShowBytes((v) => !v)}>
            {showBytes ? 'Hide' : 'Show'} bytes
          </button>
          <a className="btn small" href={api.downloadUrl(runId, artifactKey, Boolean(artifact.uploadAs))}>
            Download
          </a>
          {!uploadOnly ? (
            <>
              <a
                className="btn small"
                href={api.emlUrl(runId, operation, family)}
                title="Ready-to-send message, if SMTP is blocked"
              >
                .eml
              </a>
              {alreadySent?.ok ? (
                <>
                  <Badge tone="ok">sent {new Date(alreadySent.sentAt).toLocaleTimeString()}</Badge>
                  <button
                    className="btn danger outline small"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `${artifact.filename} was already sent to ${alreadySent.to}. Sending it again to the same mailbox is a double load. Continue?`
                        )
                      ) {
                        onSend({ force: true });
                      }
                    }}
                  >
                    Re-send
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn small"
                    disabled={!canSend || busy}
                    onClick={() => onSend({ autoSend: false })}
                    title={outlook ? 'Fills the Outlook compose window and stops for you to review' : undefined}
                  >
                    {busy ? 'Working…' : outlook ? 'Compose in Outlook' : 'Send'}
                  </button>
                  {outlook ? (
                    <button
                      className="btn danger outline small"
                      disabled={!canSend || busy}
                      title="Fill the compose window and press Send without review"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Compose AND send ${artifact.filename} to ${to} without reviewing it first?\n\n` +
                              'This is a real device load. Only do this once you have seen the composed message look right at least once.'
                          )
                        ) {
                          onSend({ autoSend: true });
                        }
                      }}
                    >
                      Compose &amp; send
                    </button>
                  ) : null}
                </>
              )}
            </>
          ) : null}
        </>
      }
    >
      {note}

      {/* The mailbox is the only thing that tells the parser which operation this is. */}
      {to ? (
        <div className="dest">
          <span className="eyebrow">To</span>
          <span className="addr mono">{to}</span>
        </div>
      ) : null}

      <div className="file-meta">
        <span>
          <span className="eyebrow">Rows</span>
          <span className="mono tab">{artifact.rowCount}</span>
        </span>
        <span>
          <span className="eyebrow">Bytes</span>
          <span className="mono tab">{artifact.byteLength}</span>
        </span>
        <span>
          <span className="eyebrow">Template</span>
          <span className="mono">{artifact.template}</span>
        </span>
      </div>

      {blockers.length ? (
        <p className="small" style={{ color: 'var(--warn)', margin: '0.6rem 0 0' }}>
          Sending blocked — placeholder config: {blockers.join(', ')}
        </p>
      ) : null}

      {alreadySent?.sentItems && alreadySent.sentItems.confirmed !== true ? (
        <p className="small" style={{ color: 'var(--warn)', margin: '0.6rem 0 0' }}>
          Sent Items: {alreadySent.sentItems.reason ?? 'not confirmed'}
        </p>
      ) : null}

      {showBytes && preview ? (
        <div style={{ marginTop: '0.75rem' }}>
          <pre className="hex">{preview.hex}</pre>
        </div>
      ) : null}
    </Sheet>
  );
}

function Checklist({ validation }) {
  return (
    <Sheet
      eyebrow={`${validation.counts.passed} passed · ${validation.counts.failed} failed · ${validation.counts.skipped} skipped`}
      title="Pre-send checks"
      actions={
        validation.canSend ? (
          <Badge tone="ok">clear to send</Badge>
        ) : (
          <Badge tone="fail">{validation.blockers.length} blocker(s)</Badge>
        )
      }
    >
      {Object.entries(validation.groups).map(([key, checks]) => (
        <div key={key} style={{ marginBottom: '1.1rem' }}>
          <span className={key === 'org' ? 'eyebrow' : 'group-label'} style={{ marginBottom: '0.35rem' }}>
            {key === 'org' ? 'Against the org' : key}
          </span>
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
    </Sheet>
  );
}
