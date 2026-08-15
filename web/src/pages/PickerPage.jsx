import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Explainer, KeyValue, PageHead, Segmented, Sheet, Stat } from '../components/ui.jsx';

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
  // Escape hatch from the family narrowing — see the catalog effect below.
  const [showAll, setShowAll] = React.useState(false);

  const operation = setup.operation ?? 'initialLoad';

  React.useEffect(() => {
    Promise.all([api.families(env), api.templates()])
      .then(([fam, tpl]) => {
        setFamilies(fam);
        setTemplates(tpl.templates);
        const first = fam.families.find((f) => f.operations.some((o) => o.operation === operation));
        setActiveFamily((current) => current ?? first?.family ?? null);
      })
      .catch(onError);
  }, [env, operation, onError]);

  /**
   * The catalog is fetched per family, so choosing a family narrows the table to that family's
   * devices instead of leaving all 169 serialized products on screen.
   *
   * Narrowing happens on the server — the rules live in `config/profiles.json`, because the org
   * has no single field that says which family a product belongs to (Octo is a *model* inside the
   * Driveri device type, not a type of its own). The response says whether the narrowing was
   * actually applied, which is what `showAll` and the note below are reading.
   *
   * `showAll` is not a convenience. A rule goes stale the moment someone renames a device type in
   * Salesforce, and a filter nobody can turn off would hide the SKU this run needs with no way
   * back.
   */
  React.useEffect(() => {
    if (!activeFamily) return;
    let cancelled = false;
    api
      .products(env, showAll ? {} : { family: activeFamily })
      .then((products) => {
        if (!cancelled) setCatalog(products);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [env, activeFamily, showAll]);

  const supported = React.useMemo(
    () =>
      (families?.families ?? []).filter((f) => f.operations.some((o) => o.operation === operation)),
    [families, operation]
  );

  const templateFor = (family) =>
    templates.find((t) => t.family === family && t.operation === operation);

  const group = groups.find((g) => g.family === activeFamily);
  const activeTemplate = activeFamily ? templateFor(activeFamily) : null;

  /**
   * The search box, applied to whatever the server already narrowed to this family.
   *
   * The family narrowing itself is not done here — it is a fact about the org rather than about
   * the text in the box, and doing it server-side keeps one source of truth. This only filters
   * within that.
   */
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
      // Matches the server's own page size, so the count in the scope line above is always the
      // number of rows actually listed. At 120 the two disagreed the moment a family had more
      // than that — Driveri has 135 — which reads as rows having gone missing.
      .slice(0, 200);
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
      <PageHead eyebrow="Step 03 · Manifest" title="Families & SKUs">
        <Explainer>
          <p>
            Each family is its own CSV and its own email. Pick as many as this batch covers —{' '}
            <span className="mono">{operation}</span> for tracking id{' '}
            <span className="mono">{setup.trackingId}</span>.
          </p>
        </Explainer>
      </PageHead>

      {supported.length === 0 && families ? (
        <Callout tone="warn" title={`No family has a "${operation}" template`}>
          Only some families support every operation — Haptic has a data update, VBUS and DMS have
          initial load only. Go back and pick a different operation.
        </Callout>
      ) : null}

      <Sheet title="Family">
        <Segmented
          label="Product family"
          value={activeFamily}
          onChange={(family) => {
            setActiveFamily(family);
            ensureGroup(family);
            // "Show all" belongs to the family you turned it on for. Carrying it across would mean
            // picking a family and still facing the whole catalog, which is the thing this fixes.
            setShowAll(false);
          }}
          options={supported.map((f) => {
            const picked = groups.find((g) => g.family === f.family)?.lines.length ?? 0;
            const op = f.operations.find((o) => o.operation === operation);
            return {
              value: f.family,
              label: f.label,
              count: picked || null,
              flag: Boolean(op && !op.ready),
              title: op && !op.ready ? 'No mailbox configured for this pipeline yet' : op?.to ?? '',
            };
          })}
        />

        {activeTemplate ? (
          <div style={{ marginTop: '1rem' }}>
            <KeyValue
              rows={[
                [
                  'Template',
                  <span className="small">
                    {activeTemplate.label}{' '}
                    {activeTemplate.usable ? (
                      <Badge tone="ok">verified</Badge>
                    ) : (
                      <Badge tone="warn">{activeTemplate.status}</Badge>
                    )}
                  </span>,
                ],
                ['Derived from', <span className="mono small">{activeTemplate.sourceTemplate}</span>],
                [
                  'Shape',
                  <span className="small">
                    {activeTemplate.columnCount} columns · {activeTemplate.bytes.bom ? 'BOM' : 'no BOM'} ·{' '}
                    {activeTemplate.bytes.lineEnding === '\r\n' ? 'CRLF' : 'LF'} ·{' '}
                    {activeTemplate.bytes.trailingNewline ? 'trailing newline' : 'no trailing newline'}
                  </span>,
                ],
                [
                  'Mints',
                  <span className="mono small">
                    {Object.keys(activeTemplate.series).length
                      ? Object.entries(activeTemplate.series)
                          .map(([n, d]) => `${n} (${d.type === 'prefixed' ? d.prefix + 'N' : d.digits + 'd'})`)
                          .join(', ')
                      : 'nothing — acts on ids from an earlier run'}
                  </span>,
                ],
                [
                  'Filename',
                  <span className="mono small">
                    {activeTemplate.filenamePattern.replace('{trackingId}', setup.trackingId ?? '…')}
                  </span>,
                ],
              ]}
            />
          </div>
        ) : null}

        {activeTemplate?.notes?.length ? (
          <details style={{ marginTop: '0.8rem' }}>
            <summary className="eyebrow">{activeTemplate.notes.length} note(s) on this template</summary>
            <ul className="small muted" style={{ marginTop: '0.5rem' }}>
              {activeTemplate.notes.map((n) => (
                <li key={n} style={{ marginBottom: '0.3rem' }}>
                  {n}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Sheet>

      {activeTemplate ? (
        <Sheet
          eyebrow="Catalog"
          title={`SKUs for ${activeTemplate.familyLabel}`}
          actions={
            <div style={{ flex: '1 1 260px', minWidth: '200px' }}>
              <input
                type="text"
                value={search}
                placeholder="Search the catalog"
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
          }
        >
          {activeTemplate.defaults?.sku_number ? (
            <div className="btn-row" style={{ marginBottom: '0.85rem' }}>
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
            <p className="prose small" style={{ marginBottom: 0 }}>
              Catalog unavailable — connect to Salesforce to search it, or use the template SKU above.
            </p>
          ) : (
            <>
              <CatalogScope
                catalog={catalog}
                familyLabel={activeTemplate.familyLabel ?? activeFamily}
                showAll={showAll}
                onToggle={() => setShowAll((v) => !v)}
              />
            <div className="picker-results">
              {results.length === 0 ? (
                <p className="muted small" style={{ padding: '0.85rem', margin: 0 }}>
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
                          {p.decoded?.decoded ? p.decoded.summary : <span className="faint">code not decodable</span>}
                        </div>
                        <div className="name">{p.name}</div>
                      </div>
                      <button
                        className="btn secondary small"
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
            </>
          )}
        </Sheet>
      ) : null}

      {usableGroups.length ? (
        <Sheet title="This run">
          {usableGroups.map((g) => (
            <div key={g.family} style={{ marginBottom: '1.15rem' }}>
              <h3 style={{ marginBottom: '0.5rem' }}>
                {g.familyLabel}{' '}
                <span className="muted small" style={{ fontWeight: 400 }}>
                  → one CSV, one email (
                  {templateFor(g.family)?.filenamePattern.replace('{trackingId}', setup.trackingId ?? '…')})
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
                          {line.onOrder ? line.quantity : <span className="faint">not on order</span>}
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
                            className="btn quiet small"
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

          <div className="stat-row" style={{ marginBottom: '1.1rem' }}>
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
              <strong style={{ display: 'inline' }}>Partially Shipped</strong>, which hides the
              "Load Asset &amp; Ship Order" button and dead-ends the flow.
            </Callout>
          ) : null}

          {usableGroups.some((g) => !templateFor(g.family)?.usable) ? (
            <Callout tone="warn" title="Some families have an unconfirmed template">
              Those files will not be generated or sent until their descriptor is marked verified.
            </Callout>
          ) : null}
        </Sheet>
      ) : null}

      <div className="btn-row">
        <button className="btn" disabled={busy || usableGroups.length === 0} onClick={create}>
          {busy ? 'Creating run…' : 'Generate ids →'}
        </button>
      </div>
    </>
  );
}

/**
 * What the catalog table is currently showing, and how to get out of it.
 *
 * A narrowed table looks exactly like a short catalog, so the count has to say which it is —
 * otherwise "my SKU isn't here" and "this family only has two SKUs" are indistinguishable.
 *
 * `filterApplied: false` covers the two cases where the narrowing could not be trusted, and they
 * are reported differently because the operator can act on one of them:
 *   - `no-filter-declared` — nothing in config says what this family covers. Haptic, today: the
 *     org has no serialized Haptic product at all.
 *   - `no-matches` — a rule exists and matched nothing, which means it has gone stale against the
 *     org rather than that the family is empty.
 */
function CatalogScope({ catalog, familyLabel, showAll, onToggle }) {
  const { total, catalogTotal, filterApplied, filterReason } = catalog;
  const narrowed = filterApplied && !showAll;

  return (
    <div className="btn-row" style={{ marginBottom: '0.7rem', alignItems: 'baseline' }}>
      <span className="muted small">
        {narrowed ? (
          <>
            Showing the <strong>{familyLabel}</strong> devices — {total} of {catalogTotal} products.
          </>
        ) : showAll ? (
          <>Showing all {total} serialized products.</>
        ) : filterReason === 'no-filter-declared' ? (
          <>
            No catalog rule for <strong>{familyLabel}</strong>, so all {total} products are listed.
            Add one under <code>catalogFilters</code> in <code>config/profiles.json</code>.
          </>
        ) : filterReason === 'no-matches' ? (
          // Deliberately not "the rule is stale". It might be — or the org may simply hold no such
          // product, which is Haptic's case: HAPTIC is a real active series with nothing in it.
          // Both look identical from here, so claim only what is certain.
          <>
            No serialized product in this org belongs to <strong>{familyLabel}</strong>. Showing all{' '}
            {total} products rather than an empty table.
          </>
        ) : (
          <>Showing all {total} serialized products.</>
        )}
      </span>
      {filterApplied || showAll ? (
        <button className="btn quiet small" onClick={onToggle}>
          {showAll ? `Back to ${familyLabel} only` : `Show all ${catalogTotal}`}
        </button>
      ) : null}
    </div>
  );
}
