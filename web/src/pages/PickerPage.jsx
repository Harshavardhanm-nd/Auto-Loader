import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Stat } from '../components/ui.jsx';

/**
 * Family and SKU picker.
 *
 * Each family is a separate CSV and a separate email — every send carries exactly one
 * attachment, so a Driveri batch and a Haptic batch cannot share a message even when they go
 * to the same mailbox. Picking two families here produces two files and two sends.
 *
 * Two counts per line, deliberately separate:
 *   Order qty  — how many serials a wizard upload needs. From OrderItem, read-only.
 *   Batch size — how many units to load. Free; a manufacturer batch need not match an order.
 */
export default function PickerPage({ env, setup, setRunId, goto, onError }) {
  const [families, setFamilies] = React.useState(null);
  const [templates, setTemplates] = React.useState([]);
  const [catalog, setCatalog] = React.useState(null);
  const [search, setSearch] = React.useState('');
  const [groups, setGroups] = React.useState([]);
  const [activeFamily, setActiveFamily] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const operation = setup.operation ?? 'initialLoad';

  React.useEffect(() => {
    Promise.all([api.families(env), api.templates(), api.products(env).catch(() => null)])
      .then(([fam, tpl, products]) => {
        setFamilies(fam);
        setTemplates(tpl.templates);
        setCatalog(products);
        const first = fam.families.find((f) => f.operations.some((o) => o.operation === operation));
        setActiveFamily((current) => current ?? first?.family ?? null);
      })
      .catch(onError);
  }, [env, operation, onError]);

  const supported = React.useMemo(
    () =>
      (families?.families ?? []).filter((f) => f.operations.some((o) => o.operation === operation)),
    [families, operation]
  );

  const templateFor = (family) =>
    templates.find((t) => t.family === family && t.operation === operation);

  const group = groups.find((g) => g.family === activeFamily);
  const activeTemplate = activeFamily ? templateFor(activeFamily) : null;

  /** Catalog rows relevant to the active family, matched loosely on the family's own SKU. */
  const results = React.useMemo(() => {
    if (!catalog || !activeTemplate) return [];
    const term = search.trim().toLowerCase();
    return catalog.products
      .filter((p) => {
        if (!term) return true;
        const hay = [p.productCode, p.productSku, p.name, p.decoded?.model, p.decoded?.region]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return term.split(/\s+/).every((t) => hay.includes(t));
      })
      .slice(0, 120);
  }, [catalog, activeTemplate, search]);

  const ensureGroup = (family) => {
    setGroups((current) => {
      if (current.some((g) => g.family === family)) return current;
      const template = templateFor(family);
      return [
        ...current,
        {
          family,
          familyLabel: template?.familyLabel ?? family,
          templateId: template?.id,
          defaultSku: template?.defaults?.sku_number ?? null,
          lines: [],
        },
      ];
    });
  };

  const addLine = (family, sku, name = null) => {
    ensureGroup(family);
    setGroups((current) =>
      current.map((g) => {
        if (g.family !== family) return g;
        if (g.lines.some((l) => l.sku === sku)) return g;
        const onOrder = setup.order?.serializedLines?.find((l) => l.sku === sku);
        const quantity = onOrder?.quantity ?? 0;
        return {
          ...g,
          lines: [...g.lines, { sku, name, quantity, deviceCount: Math.max(quantity, 1), onOrder: Boolean(onOrder) }],
        };
      })
    );
  };

  const totalUnits = groups.reduce(
    (n, g) => n + g.lines.reduce((m, l) => m + Number(l.deviceCount || 0), 0),
    0
  );
  const requiredSerials = groups.reduce(
    (n, g) => n + g.lines.reduce((m, l) => m + (l.onOrder ? l.quantity : 0), 0),
    0
  );
  const usableGroups = groups.filter((g) => g.lines.length > 0);

  const create = async () => {
    setBusy(true);
    try {
      const { run } = await api.createRun({
        env,
        operation,
        trackingId: setup.trackingId,
        orderNumber: setup.order?.orderNumber,
        groups: usableGroups.map((g) => ({
          family: g.family,
          lines: g.lines.map((l) => ({
            sku: l.sku,
            name: l.name,
            quantity: l.quantity,
            deviceCount: Number(l.deviceCount),
          })),
        })),
      });
      setRunId(run.runId);
      goto('ids');
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Families &amp; SKUs</h1>
        <p>
          Each family is its own CSV and its own email. Pick as many as this batch covers —{' '}
          <span className="mono">{operation}</span> for tracking id{' '}
          <span className="mono">{setup.trackingId}</span>.
        </p>
      </div>

      {supported.length === 0 && families ? (
        <Callout tone="warn" title={`No family has a "${operation}" template`}>
          Only some families support every operation — Haptic has a data update, VBUS and DMS have
          initial load only. Go back and pick a different operation.
        </Callout>
      ) : null}

      <div className="card">
        <h2>Family</h2>
        <div className="btn-row" style={{ marginBottom: '0.5rem' }}>
          {supported.map((f) => {
            const picked = groups.find((g) => g.family === f.family)?.lines.length ?? 0;
            const op = f.operations.find((o) => o.operation === operation);
            return (
              <button
                key={f.family}
                className={`btn ${activeFamily === f.family ? '' : 'secondary'} small`}
                onClick={() => {
                  setActiveFamily(f.family);
                  ensureGroup(f.family);
                }}
                title={op?.to ?? ''}
              >
                {f.label}
                {picked ? ` · ${picked}` : ''}
                {op && !op.ready ? ' ⚠' : ''}
              </button>
            );
          })}
        </div>

        {activeTemplate ? (
          <div className="table-wrap">
            <table>
              <tbody>
                <tr>
                  <th>Template</th>
                  <td className="small">
                    {activeTemplate.label}{' '}
                    {activeTemplate.usable ? (
                      <Badge tone="ok">verified</Badge>
                    ) : (
                      <Badge tone="warn">{activeTemplate.status}</Badge>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Derived from</th>
                  <td className="mono small">{activeTemplate.sourceTemplate}</td>
                </tr>
                <tr>
                  <th>Shape</th>
                  <td className="small">
                    {activeTemplate.columnCount} columns ·{' '}
                    {activeTemplate.bytes.bom ? 'BOM' : 'no BOM'} ·{' '}
                    {activeTemplate.bytes.lineEnding === '\r\n' ? 'CRLF' : 'LF'} ·{' '}
                    {activeTemplate.bytes.trailingNewline ? 'trailing newline' : 'no trailing newline'}
                  </td>
                </tr>
                <tr>
                  <th>Mints</th>
                  <td className="mono small">
                    {Object.keys(activeTemplate.series).length
                      ? Object.entries(activeTemplate.series)
                          .map(([n, d]) => `${n} (${d.type === 'prefixed' ? d.prefix + 'N' : d.digits + 'd'})`)
                          .join(', ')
                      : 'nothing — acts on ids from an earlier run'}
                  </td>
                </tr>
                <tr>
                  <th>Filename</th>
                  <td className="mono small">
                    {activeTemplate.filenamePattern.replace('{trackingId}', setup.trackingId ?? '…')}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}

        {activeTemplate?.notes?.length ? (
          <details style={{ marginTop: '0.6rem' }}>
            <summary className="muted small" style={{ cursor: 'pointer' }}>
              {activeTemplate.notes.length} note(s) on this template
            </summary>
            <ul className="small muted" style={{ marginTop: '0.4rem' }}>
              {activeTemplate.notes.map((n) => (
                <li key={n} style={{ marginBottom: '0.3rem' }}>
                  {n}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {activeTemplate ? (
        <div className="card">
          <div className="card-row" style={{ marginBottom: '0.75rem' }}>
            <h2 style={{ margin: 0 }}>SKUs for {activeTemplate.familyLabel}</h2>
            <div className="spacer" />
            <div style={{ flex: '1 1 240px' }}>
              <input
                type="text"
                value={search}
                placeholder="search the catalog, or add the template SKU below"
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {activeTemplate.defaults?.sku_number ? (
            <div className="btn-row" style={{ marginBottom: '0.75rem' }}>
              <button
                className="btn small"
                onClick={() => addLine(activeFamily, activeTemplate.defaults.sku_number, activeTemplate.familyLabel)}
              >
                Add {activeTemplate.defaults.sku_number}
              </button>
              <span className="muted small">the SKU this template's sheet uses</span>
            </div>
          ) : null}

          {catalog === null ? (
            <p className="muted small">
              Catalog unavailable — connect to Salesforce to search it, or use the template SKU above.
            </p>
          ) : (
            <div className="picker-results">
              {results.length === 0 ? (
                <p className="muted small" style={{ padding: '0.75rem' }}>
                  Nothing matches that.
                </p>
              ) : (
                results.map((p) => {
                  const picked = group?.lines.some((l) => l.sku === p.productCode);
                  const onOrder = setup.order?.serializedLines?.some((l) => l.sku === p.productCode);
                  return (
                    <div className="picker-row" key={p.id}>
                      <div style={{ minWidth: 0 }}>
                        <div className="code">
                          {p.productCode} {onOrder ? <Badge tone="info">on order</Badge> : null}
                        </div>
                        <div className="decoded">
                          {p.decoded?.decoded ? p.decoded.summary : <span className="muted">code not decodable</span>}
                        </div>
                        <div className="name">{p.name}</div>
                      </div>
                      <button
                        className={`btn ${picked ? 'secondary' : ''} small`}
                        disabled={picked}
                        onClick={() => addLine(activeFamily, p.productCode, p.name)}
                      >
                        {picked ? 'Added' : 'Add'}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      ) : null}

      {usableGroups.length ? (
        <div className="card">
          <h2>This run</h2>
          {usableGroups.map((g) => (
            <div key={g.family} style={{ marginBottom: '1rem' }}>
              <h3>
                {g.familyLabel}{' '}
                <span className="muted small">
                  → one CSV, one email ({templateFor(g.family)?.filenamePattern.replace('{trackingId}', setup.trackingId ?? '…')})
                </span>
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th className="num">Order qty</th>
                      <th className="num">Batch size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map((line, i) => (
                      <tr key={line.sku}>
                        <td className="mono">{line.sku}</td>
                        <td className="num">
                          {line.onOrder ? line.quantity : <span className="muted">not on order</span>}
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            min={Math.max(line.quantity, 1)}
                            value={line.deviceCount}
                            onChange={(e) => {
                              const value = e.target.value;
                              setGroups((current) =>
                                current.map((cg) =>
                                  cg.family === g.family
                                    ? {
                                        ...cg,
                                        lines: cg.lines.map((l, j) => (j === i ? { ...l, deviceCount: value } : l)),
                                      }
                                    : cg
                                )
                              );
                            }}
                          />
                        </td>
                        <td>
                          <button
                            className="btn secondary small"
                            onClick={() =>
                              setGroups((current) =>
                                current.map((cg) =>
                                  cg.family === g.family
                                    ? { ...cg, lines: cg.lines.filter((_, j) => j !== i) }
                                    : cg
                                )
                              )
                            }
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="stat-row" style={{ marginBottom: '1rem' }}>
            <Stat value={usableGroups.length} label="Files / emails" />
            <Stat value={totalUnits} label="Units to load" />
            {setup.order ? (
              <>
                <Stat
                  value={requiredSerials}
                  label="Serials covered"
                  tone={requiredSerials === setup.order.requiredSerialTotal ? undefined : 'warn'}
                />
                <Stat value={setup.order.requiredSerialTotal} label="Order needs" />
              </>
            ) : null}
          </div>

          {setup.order && requiredSerials !== setup.order.requiredSerialTotal ? (
            <Callout tone="warn" title="Wizard upload will not cover the whole order">
              The order needs {setup.order.requiredSerialTotal} serial(s) but the lines picked
              account for {requiredSerials}. Uploading fewer sets the order to{' '}
              <strong>Partially Shipped</strong>, which hides the "Load Asset &amp; Ship Order"
              button and dead-ends the flow.
            </Callout>
          ) : null}

          {usableGroups.some((g) => !templateFor(g.family)?.usable) ? (
            <Callout tone="warn" title="Some families have an unconfirmed template">
              Those files will not be generated or sent until their descriptor is marked verified.
            </Callout>
          ) : null}
        </div>
      ) : null}

      <div className="btn-row">
        <button className="btn" disabled={busy || usableGroups.length === 0} onClick={create}>
          {busy ? 'Creating run…' : 'Generate ids →'}
        </button>
      </div>
    </>
  );
}
