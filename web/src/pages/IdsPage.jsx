import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, PageHead, Sheet, Stat } from '../components/ui.jsx';

/**
 * Generated ids, per family and per series.
 *
 * Each family numbers its hardware differently, so a run can hold several parallel series at
 * once — Octo alone mints five, plus two prefix-plus-counter pseudo-MACs. Ids come from a
 * persisted counter so each block is contiguous and auditable, and are still checked against
 * the org before anything is sent.
 */
export default function IdsPage({ runId, run, refreshRun, goto, onError }) {
  const [busy, setBusy] = React.useState(null);
  const [cursors, setCursors] = React.useState(null);
  const [checkResult, setCheckResult] = React.useState(null);
  const [allocation, setAllocation] = React.useState(null);

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
        <p>
          One contiguous block per series, from a persisted counter. Every numeric series is
          checked against <code>Asset.Name</code>; the prefixed pseudo-MACs are not, since they
          are not asset names.
        </p>
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
              onClick={() => act(() => api.allocate(runId).then(setAllocation), 'allocate')}
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
                  await api.resetCursors(runId);
                  setCursors((await api.cursors(runId)).cursors);
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

      {cursors?.length ? (
        <Sheet eyebrow="Persisted counters" title="Next value per series">
          <p className="prose small">
            Held in <code>data/counters.json</code>, keyed <code>env:templateId:series</code>.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Family</th>
                  <th>Series</th>
                  <th>Type</th>
                  <th>Next</th>
                </tr>
              </thead>
              <tbody>
                {cursors.flatMap((c) =>
                  Object.entries(c.series).map(([name, info]) => (
                    <tr key={`${c.family}:${name}`}>
                      <td className="small">{c.familyLabel}</td>
                      <td className="mono small">{name}</td>
                      <td className="small muted">
                        {info.type}
                        {info.digits ? ` ${info.digits}d` : ''}
                      </td>
                      <td className="mono">{info.next}</td>
                    </tr>
                  ))
                )}
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
                goto('review');
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
