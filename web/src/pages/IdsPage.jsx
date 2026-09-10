import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Explainer, PageHead, Sheet, Stat } from '../components/ui.jsx';

/**
 * Generated ids, per family and per series.
 *
 * Each family numbers its hardware differently, so a run can hold several parallel series at
 * once — Octo alone mints five, plus two prefix-plus-counter pseudo-MACs. Ids come from a
 * persisted counter so each block is contiguous and auditable, and are still checked against
 * the org before anything is sent.
 */
/** Gathers every series the operator switched to "one id per asset" into the shape
 *  `POST /:id/allocate` expects: `{ [family]: { [seriesName]: string[] } }` — one value per
 *  unit, in the same order the auto-generated block would have used. `manualIds[key]` already
 *  holds nothing but committed values (one Add = one entry, always appended), so there is no
 *  parsing to do here — just a count that must reach `total`. */
function collectManualSeries(cursors, run, manualOn, manualIds) {
  const manualSeries = {};
  for (const c of cursors ?? []) {
    const group = run.groups.find((g) => g.family === c.family);
    if (!group) continue;
    const total = group.lines.reduce((n, l) => n + l.deviceCount, 0);
    for (const name of Object.keys(c.series)) {
      const key = `${c.templateId}:${name}`;
      if (!manualOn[key]) continue;
      const values = manualIds[key] ?? [];
      if (values.length !== total) {
        throw new Error(
          `${c.familyLabel} "${name}": ${values.length} of ${total} id(s) entered — add the rest before allocating.`
        );
      }
      manualSeries[c.family] = { ...(manualSeries[c.family] ?? {}), [name]: values };
    }
  }
  return manualSeries;
}

export default function IdsPage({ runId, run, refreshRun, goto, onError }) {
  const [busy, setBusy] = React.useState(null);
  const [cursors, setCursors] = React.useState(null);
  const [checkResult, setCheckResult] = React.useState(null);
  const [allocation, setAllocation] = React.useState(null);
  const [resetResult, setResetResult] = React.useState(null);
  const [setToInputs, setSetToInputs] = React.useState({});
  // Manual per-asset ids: keyed the same way as setToInputs (`${templateId}:${seriesName}`).
  // manualOn toggles a series into "operator supplies every value" mode. One box + Add handles
  // any count without growing the page: manualIds[key] is the list already committed (kept in
  // state so it can be sent to /allocate, but never rendered id-by-id — once allocation runs,
  // the values show up in the generated-ids table below anyway, so redisplaying them here would
  // just be the same list twice). manualDraft[key] is whatever is typed but not yet added.
  const [manualOn, setManualOn] = React.useState({});
  const [manualIds, setManualIds] = React.useState({});
  const [manualDraft, setManualDraft] = React.useState({});

  const addManualId = (key) => {
    const value = (manualDraft[key] ?? '').trim();
    if (!value) return;
    setManualIds((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), value] }));
    setManualDraft((prev) => ({ ...prev, [key]: '' }));
  };

  const undoManualId = (key) =>
    setManualIds((prev) => ({ ...prev, [key]: (prev[key] ?? []).slice(0, -1) }));

  React.useEffect(() => {
    if (runId) api.cursors(runId).then((d) => setCursors(d.cursors)).catch(() => setCursors(null));
  }, [runId, run?.idGeneration?.allocatedAt]);

  if (!run) return <p className="muted">Loading run…</p>;

  const totalUnits = run.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.deviceCount, 0), 0);
  const hasIds = run.groups.some((g) => g.lines.some((l) => (l.generatedRows ?? []).length > 0));

  const act = async (fn, key) => {
    setBusy(key);
    try {
      const result = await fn();
      await refreshRun();
      return result;
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHead eyebrow="Step 04 · Serial blocks" title="Ids">
        <Explainer>
          <p>
            One contiguous block per series, from a persisted counter. Every numeric series is
            checked against <code>Asset.Name</code>; the prefixed pseudo-MACs are not, since they
            are not asset names. Switch a series to "one id per asset" below to type in every
            value yourself instead — each is used exactly as entered and never advances that
            series' counter.
          </p>
        </Explainer>
      </PageHead>

      <Sheet>
        <div className="card-row">
          <div className="stat-row">
            <Stat value={totalUnits} label="Units" />
            <Stat value={run.groups.length} label="Families" />
            {run.idGeneration ? (
              <Stat
                value={run.idGeneration.allocations.reduce((n, a) => n + a.attempts, 0)}
                label="Allocation attempts"
              />
            ) : null}
          </div>
          <div className="spacer" />
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy === 'allocate'}
              onClick={() =>
                act(() => {
                  const manualSeries = collectManualSeries(cursors, run, manualOn, manualIds);
                  return api.allocate(runId, manualSeries).then(setAllocation);
                }, 'allocate')
              }
            >
              {busy === 'allocate' ? 'Allocating…' : hasIds ? 'Re-allocate' : 'Allocate ids'}
            </button>
            {hasIds ? (
              <button
                className="btn secondary"
                disabled={busy === 'check'}
                onClick={() => act(() => api.checkIds(runId).then(setCheckResult), 'check')}
              >
                {busy === 'check' ? 'Checking…' : 'Check availability'}
              </button>
            ) : null}
            <button
              className="btn quiet small"
              disabled={busy === 'reset'}
              onClick={() =>
                act(async () => {
                  const result = await api.resetCursors(runId);
                  setCursors((await api.cursors(runId)).cursors);
                  setResetResult(result);
                }, 'reset')
              }
              title="Seed every series back to its template's sample start"
            >
              Reset counters
            </button>
          </div>
        </div>
      </Sheet>

      {allocation?.warning ? (
        <Callout tone="warn" title="Not verified against the org">
          {allocation.warning}
        </Callout>
      ) : null}

      {resetResult ? (
        <Callout tone="ok" title={`${resetResult.series.length} series seeded back to its sample start`}>
          Each descriptor's <code>sampleStart</code> came from a sheet that was already loaded, so
          these ids are expected to be taken — allocation steps over the batch rather than
          stopping on it.
          <div className="mono small" style={{ marginTop: '0.45rem' }}>
            {resetResult.series.map((s) => `${s.seriesName} → ${s.next}`).join(' · ')}
          </div>
        </Callout>
      ) : null}

      {checkResult ? (
        checkResult.free ? (
          <Callout tone="ok" title={`All ${checkResult.checked} ids are free`}>
            No <code>Asset.Name</code> in the org matches any id in this run.
          </Callout>
        ) : (
          <Callout tone="fail" title={`${checkResult.taken.length} id(s) are already taken`}>
            These exist as assets and will make the load fail. Re-allocate to move past them.
            <div className="mono small" style={{ marginTop: '0.45rem' }}>
              {checkResult.taken.slice(0, 12).join(', ')}
            </div>
          </Callout>
        )
      ) : null}

      {run.idGeneration?.allocations?.some((a) => a.manualCollisions?.length) ? (
        <Callout tone="fail" title="A manually-set id already exists in the org">
          These were typed in on this page, not minted from a counter, so allocation could not
          step past them — re-check the value before generating or sending.
          {run.idGeneration.allocations
            .filter((a) => a.manualCollisions?.length)
            .map((a) => (
              <div key={a.family} className="mono small" style={{ marginTop: '0.45rem' }}>
                {a.familyLabel}: {a.manualCollisions.join(', ')}
              </div>
            ))}
        </Callout>
      ) : null}

      {cursors?.length ? (
        <Sheet eyebrow="Persisted counters" title="Next value per series">
          <Explainer>
            <p className="prose small">
              Held in <code>data/counters.json</code>, keyed <code>env:templateId:series</code>.
            </p>
          </Explainer>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Family</th>
                  <th>Series</th>
                  <th>Type</th>
                  <th>Next</th>
                  <th>Set to…</th>
                  <th>Manual ids</th>
                </tr>
              </thead>
              <tbody>
                {cursors.flatMap((c) => {
                  const group = run.groups.find((g) => g.family === c.family);
                  const total = group ? group.lines.reduce((n, l) => n + l.deviceCount, 0) : 0;
                  return Object.entries(c.series).flatMap(([name, info]) => {
                    const key = `${c.templateId}:${name}`;
                    const rows = [
                      <tr key={key}>
                        <td className="small">{c.familyLabel}</td>
                        <td className="mono small">{name}</td>
                        <td className="small muted">
                          {info.type}
                          {info.digits ? ` ${info.digits}d` : ''}
                        </td>
                        <td className="mono">{info.next}</td>
                        <td>
                          {info.type === 'numeric' ? (
                            <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                              <input
                                className="mono small"
                                style={{ width: '15ch', padding: '2px 4px', fontSize: '0.8em' }}
                                placeholder={info.next}
                                disabled={manualOn[key]}
                                value={setToInputs[key] ?? ''}
                                onChange={(e) =>
                                  setSetToInputs((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                              />
                              <button
                                className="btn quiet small"
                                disabled={!setToInputs[key] || manualOn[key] || busy === `set:${key}`}
                                onClick={() =>
                                  act(async () => {
                                    await api.setCursor(runId, c.templateId, name, setToInputs[key].trim());
                                    setSetToInputs((prev) => ({ ...prev, [key]: '' }));
                                    setCursors((await api.cursors(runId)).cursors);
                                  }, `set:${key}`)
                                }
                              >
                                Set
                              </button>
                            </span>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                        <td>
                          {info.type === 'numeric' ? (
                            <label className="small muted" style={{ display: 'flex', gap: '4px', alignItems: 'center', whiteSpace: 'nowrap' }}>
                              <input
                                type="checkbox"
                                checked={Boolean(manualOn[key])}
                                onChange={(e) =>
                                  setManualOn((prev) => ({ ...prev, [key]: e.target.checked }))
                                }
                              />
                              One id per asset
                            </label>
                          ) : (
                            <span className="muted small">—</span>
                          )}
                        </td>
                      </tr>,
                    ];
                    if (manualOn[key]) {
                      const values = manualIds[key] ?? [];
                      const done = values.length >= total;
                      rows.push(
                        <tr key={`${key}:manual`}>
                          <td colSpan={6}>
                            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                              <input
                                className="mono small"
                                style={{ width: '18ch', padding: '2px 4px', fontSize: '0.8em' }}
                                placeholder={done ? 'all entered' : `#${values.length + 1}`}
                                disabled={done}
                                value={manualDraft[key] ?? ''}
                                onChange={(e) =>
                                  setManualDraft((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    addManualId(key);
                                  }
                                }}
                              />
                              <button
                                className="btn quiet small"
                                disabled={done || !(manualDraft[key] ?? '').trim()}
                                onClick={() => addManualId(key)}
                              >
                                Add
                              </button>
                              <button
                                type="button"
                                className="btn quiet small"
                                disabled={values.length === 0}
                                onClick={() => undoManualId(key)}
                                title="Remove the last entry"
                              >
                                Undo last
                              </button>
                              <span className="small" style={{ color: done ? 'var(--muted)' : 'var(--warn)' }}>
                                {values.length} of {total} entered
                              </span>
                            </div>
                            <p className="muted small" style={{ margin: '0.3rem 0 0' }}>
                              One <code>{name}</code> at a time, in unit order, used exactly as
                              typed — never stored back to the counter. Once allocated they show
                              up in the generated ids below, so nothing is listed twice here.
                            </p>
                          </td>
                        </tr>
                      );
                    }
                    return rows;
                  });
                })}
              </tbody>
            </table>
          </div>
        </Sheet>
      ) : null}

      {hasIds
        ? run.groups.map((group) => (
            <GroupIds
              key={group.family}
              group={group}
              allocation={run.idGeneration?.allocations?.find((a) => a.family === group.family)}
              taken={checkResult?.taken ?? []}
            />
          ))
        : null}

      {hasIds ? (
        <div className="btn-row">
          <button
            className="btn"
            disabled={busy === 'generate'}
            onClick={() =>
              act(async () => {
                await api.generate(runId, run.operation);
                // Land on the operation these files were just written for, rather than on
                // whatever Review happened to show last.
                goto('review', { operation: run.operation });
              }, 'generate')
            }
          >
            {busy === 'generate' ? 'Generating…' : 'Generate CSV files →'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function GroupIds({ group, allocation, taken }) {
  const rows = group.lines.flatMap((line) =>
    (line.generatedRows ?? []).map((generated) => ({ sku: line.sku, generated }))
  );
  if (!rows.length) return null;

  const seriesNames = Object.keys(rows[0].generated);
  const takenSet = new Set(taken);
  const range = allocation?.ranges?.[group.primarySeries];

  return (
    <Sheet
      eyebrow={`${rows.length} unit(s) · ${seriesNames.length} series`}
      title={group.familyLabel}
      actions={
        range ? (
          <span className="muted small">
            {group.primarySeries}{' '}
            <span className="mono">
              {range.from}–{range.to}
            </span>
          </span>
        ) : null
      }
    >
      {allocation?.collisions?.length ? (
        <p className="muted small">
          Skipped past {allocation.collisions.length} existing id(s); the block below is clean.
        </p>
      ) : null}

      {allocation?.manualSeries?.length ? (
        <p className="muted small">
          {allocation.manualSeries.join(', ')} set manually, one value per asset — not from a
          counter.
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>SKU</th>
              {seriesNames.map((n) => (
                <th key={n} className="raw">
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="num faint">{i + 1}</td>
                <td className="mono small">{row.sku}</td>
                {seriesNames.map((n) => (
                  <td key={n} className="mono">
                    {row.generated[n]}
                    {takenSet.has(row.generated[n]) ? <Badge tone="fail">taken</Badge> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
