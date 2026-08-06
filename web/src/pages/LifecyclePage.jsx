import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, PageHead, Sheet, Stat } from '../components/ui.jsx';
import LifecycleMap from '../components/LifecycleMap.jsx';

/**
 * The device life cycle.
 *
 * Two questions, in this order: where are this run's devices, and what moves them next. The map
 * is the index; the panels underneath are the answer. When there is no run it is the reference
 * chart on its own, which is the form it takes most of the time.
 */
export default function LifecyclePage({ env, runId, run, goto, onError }) {
  const [model, setModel] = React.useState(null);
  const [position, setPosition] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.lifecycle().then(setModel).catch(onError);
  }, [onError]);

  const loadPosition = React.useCallback(() => {
    if (!runId) {
      setPosition(null);
      return;
    }
    setBusy(true);
    api
      .runLifecycle(runId)
      .then(setPosition)
      .catch(() => setPosition(null))
      .finally(() => setBusy(false));
  }, [runId]);

  React.useEffect(loadPosition, [loadPosition]);

  // Same guard as Watch: an unexpected payload degrades to the loading state rather than
  // taking the page down.
  if (!model?.stages?.length) return <p className="muted">Loading the life cycle…</p>;

  const counts = Object.fromEntries((position?.stages?.rows ?? []).filter((r) => r.known).map((r) => [r.code, r.count]));
  const current = position?.position?.known ? position.position.code : null;
  const stage = selected !== null ? model.stages.find((s) => s.code === selected) : null;

  return (
    <>
      <PageHead eyebrow="Device life cycle" title="Life cycle">
        <p>
          A device walks this graph. <code>{model.stageField}</code> on the Asset carries the stage
          as a numeric code, and every arrow is either something you send a CSV for or something
          another system does. {model.transitions.filter((t) => t.operation).length} of{' '}
          {model.transitions.length} transitions are yours.
        </p>
      </PageHead>

      {position?.read === 'unavailable' && runId ? (
        <Callout tone="warn" title="Stage not read from the org">
          {position.readError ?? 'Salesforce was not reachable.'} The chart below is the model; the
          device positions on it are missing.
        </Callout>
      ) : null}

      <Sheet
        eyebrow={runId ? `Run ${run?.trackingId ?? runId}` : 'Reference chart'}
        title={runId ? 'Where these devices are' : 'The stage graph'}
        actions={
          runId ? (
            <button className="btn secondary small" disabled={busy} onClick={loadPosition}>
              {busy ? 'Reading…' : 'Re-read stages'}
            </button>
          ) : null
        }
      >
        <div className="lc-legend">
          <span className="lc-key">
            <span className="lc-swatch lc-swatch-op" /> you send this
          </span>
          <span className="lc-key">
            <span className="lc-swatch lc-swatch-ext" /> another system
          </span>
          <span className="lc-key">
            <span className="lc-swatch lc-swatch-ic" /> {model.accounts.installCheck.label}
          </span>
          <span className="lc-key">
            <span className="lc-swatch lc-swatch-cust" /> {model.accounts.customer.label}
          </span>
        </div>

        <LifecycleMap
          lifecycle={model}
          counts={counts}
          selected={selected}
          onSelect={setSelected}
          currentCode={current}
        />

        <p className="prose small" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
          Click a stage for what enters and leaves it. Dashed arrows carry their label on hover —
          they are not yours to send.
        </p>
      </Sheet>

      {stage ? <StageDetail stage={stage} model={model} position={position} /> : null}

      {position?.stages?.rows ? <RunPosition position={position} goto={goto} /> : null}

      <OperationLadder model={model} />

      {model.uncertainties.length ? (
        <Sheet eyebrow="Read off the chart, not confirmed" title={`${model.uncertainties.length} inferred arrow(s)`}>
          <p className="prose small">
            These endpoints were ambiguous on the flow chart. Each is one line in{' '}
            <code>config/lifecycle.json</code> — correcting one there corrects it everywhere.
          </p>
          <ul className="lc-uncertain">
            {model.uncertainties.map((u) => (
              <li key={u.key}>
                <span className="mono small">
                  {u.from ?? 'entry'} → {u.to}
                </span>{' '}
                <strong>{u.label}</strong>
                <div className="muted small">{u.why}</div>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </>
  );
}

function StageDetail({ stage, model, position }) {
  const into = model.transitions.filter((t) => t.to === stage.code);
  const out = model.transitions.filter((t) => t.from === stage.code);
  const here = (position?.devices ?? []).filter((d) => d.stage.code === stage.code);

  return (
    <Sheet
      eyebrow={`Stage ${stage.code} · ${model.accounts[stage.account].label}`}
      title={stage.label}
      actions={
        <>
          {stage.terminal ? <Badge tone="fail">terminal</Badge> : null}
          {here.length ? <Badge tone="info">{here.length} device(s) here</Badge> : null}
        </>
      }
    >
      {stage.note ? <p className="prose small">{stage.note}</p> : null}

      <div className="lc-cols">
        <div>
          <span className="eyebrow">Arrives from</span>
          <TransitionList list={into} field="from" model={model} />
        </div>
        <div>
          <span className="eyebrow">Leaves for</span>
          <TransitionList list={out} field="to" model={model} />
        </div>
      </div>

      {here.length ? (
        <div style={{ marginTop: '1rem' }}>
          <span className="group-label" style={{ marginBottom: '0.4rem' }}>
            device_id
          </span>
          <pre className="hex">{here.map((d) => d.deviceId).join('\n')}</pre>
        </div>
      ) : null}
    </Sheet>
  );
}

function TransitionList({ list, field, model }) {
  if (!list.length) return <p className="muted small">Nothing.</p>;
  return (
    <ul className="lc-trans">
      {list.map((t) => {
        const other = t[field];
        const stage = model.stages.find((s) => s.code === other);
        return (
          <li key={t.key + t.label} className={t.operation ? 'is-mine' : ''}>
            <span className="lc-trans-stage mono">{other === null ? 'entry' : `${other} ${stage?.label ?? ''}`}</span>
            <span className="lc-trans-label">{t.label}</span>
            {t.operation ? (
              <Badge tone="info">{t.operationLabel}</Badge>
            ) : (
              <span className="muted small nowrap">{t.actor}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The run's own position, and the one decision it implies. */
function RunPosition({ position, goto }) {
  const { stages, position: pos } = position;
  const next = position.next ?? { mine: [], theirs: [] };
  const split = !pos;

  return (
    <Sheet
      eyebrow={`${position.deviceCount} device(s) · read ${position.read}`}
      title={pos ? `All at ${pos.label}` : 'Split across stages'}
      actions={pos ? <Badge tone="info">stage {pos.code}</Badge> : <Badge tone="warn">no single next step</Badge>}
    >
      <div className="stat-row" style={{ marginBottom: '1rem' }}>
        {stages.rows.map((r) => (
          <Stat
            key={r.key}
            value={r.count}
            label={r.known ? `${r.code} ${r.label}` : r.label}
            tone={r.known ? undefined : 'warn'}
          />
        ))}
      </div>

      {split ? (
        <Callout tone="warn" title="These devices are not in the same stage">
          The next step is different for each group, so none is suggested. Act on one stage at a
          time — a send aimed at the majority leaves the rest behind without saying so.
        </Callout>
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
                  {!step.pollable ? <Badge tone="muted">not watchable</Badge> : null}
                </div>
                <div className="muted small">{step.label}</div>
                {step.uncertain ? <div className="small" style={{ color: 'var(--warn)' }}>Inferred arrow — see below.</div> : null}
              </div>
              <button
                className={`btn ${step.sendable ? '' : 'secondary'} small`}
                onClick={() => goto('review')}
                title={
                  step.sendable
                    ? `Generate and send ${step.operationLabel} for these devices`
                    : 'No CSV format exists for this operation yet — it has a mailbox but no sheet'
                }
              >
                {step.sendable ? 'Go to Review & send' : 'Open anyway'}
              </button>
            </div>
          ))}
        </>
      ) : pos ? (
        <Callout tone="ok" title="Nothing for you to send from here">
          Everything that moves a device out of {pos.label} belongs to another system. It stays put
          until one of them acts.
        </Callout>
      ) : null}

      {next.theirs.length ? (
        <div style={{ marginTop: '1rem' }}>
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

/** Every operation, placed on the chart. The sequence, as a table. */
function OperationLadder({ model }) {
  const moving = model.operations.filter((o) => o.movement);
  const other = model.operations.filter((o) => !o.movement);

  return (
    <Sheet eyebrow="Operations, placed on the chart" title="What each send does">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Moves</th>
              <th>Sheet</th>
              <th className="raw">Sync_Status__c</th>
            </tr>
          </thead>
          <tbody>
            {moving.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.label}
                  {o.movement.uncertain ? <Badge tone="warn">inferred</Badge> : null}
                </td>
                <td className="small">
                  <span className="mono">{o.movement.from.map((f) => (f === null ? '—' : f)).join(' / ')}</span>
                  {' → '}
                  <span className="mono">{o.movement.to.join(' / ')}</span>
                  <div className="faint">
                    {o.movement.from
                      .map((f) => (f === null ? 'no Asset yet' : model.stages.find((s) => s.code === f)?.label))
                      .join(' / ')}
                    {' → '}
                    {o.movement.to.map((t) => model.stages.find((s) => s.code === t)?.label).join(' / ')}
                  </div>
                </td>
                <td>
                  {o.hasTemplate ? (
                    <Badge tone="ok">{o.templateCount} template(s)</Badge>
                  ) : (
                    <Badge tone="warn">none yet</Badge>
                  )}
                </td>
                <td className="mono small">{o.syncStatus ?? <span className="faint">not watchable</span>}</td>
              </tr>
            ))}
            {other.map((o) => (
              <tr key={o.id}>
                <td>{o.label}</td>
                <td className="small muted">{o.stagePreserving ? 'no stage change' : 'not on the chart'}</td>
                <td>
                  {o.hasTemplate ? (
                    <Badge tone="ok">{o.templateCount} template(s)</Badge>
                  ) : (
                    <Badge tone="warn">none yet</Badge>
                  )}
                </td>
                <td className="mono small">{o.syncStatus ?? <span className="faint">not watchable</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
        An operation can be fully modelled and still unsendable — four have a mailbox but no sheet,
        so the chart knows where they go and the app still cannot get them there.
      </p>
    </Sheet>
  );
}
