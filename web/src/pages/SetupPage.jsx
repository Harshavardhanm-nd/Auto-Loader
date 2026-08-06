import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Field, PageHead, Segmented, Sheet, Stat } from '../components/ui.jsx';

/**
 * What this run is: which operation, which tracking id, and optionally which order.
 *
 * The order is optional on purpose. An initial load is a batch of devices arriving from a
 * manufacturer and does not have to relate to any order — the real template sheets carry
 * tracking ids like B3E110005 or literally NA, not Salesforce order numbers. An order is only
 * needed when a wizard upload has to match its serialized line quantity.
 */
export default function SetupPage({ env, setup, setSetup, goto, onError }) {
  const [families, setFamilies] = React.useState(null);
  const [recent, setRecent] = React.useState(null);
  const [orderBusy, setOrderBusy] = React.useState(false);

  React.useEffect(() => {
    api.families(env).then(setFamilies).catch(onError);
    api.recentOrders(env).then((d) => setRecent(d.orders)).catch(() => setRecent([]));
  }, [env, onError]);

  const operation = setup.operation ?? 'initialLoad';
  const mailOperations = (families?.operations ?? []).filter((o) => o.needsMail);

  const lookupOrder = async (orderNumber) => {
    setOrderBusy(true);
    try {
      const { order } = await api.order(env, orderNumber);
      setSetup((s) => ({ ...s, order, orderNumber: order.orderNumber }));
    } catch (err) {
      onError(err);
    } finally {
      setOrderBusy(false);
    }
  };

  return (
    <>
      <PageHead eyebrow="Step 02 · Run identity" title="Setup">
        <p>
          Pick the operation and the tracking id this run is for. The tracking id goes into the
          CSV and into the filename, so it is required even when no order is involved.
        </p>
      </PageHead>

      <Sheet eyebrow="Decides template and mailbox" title="Operation">
        <p className="prose small">
          The destination mailbox is the only thing that tells the parser which operation you
          mean — the CSV bytes are the same. Choosing here decides which template and which
          mailbox get used.
        </p>
        <Segmented
          label="Operation"
          value={operation}
          onChange={(id) => setSetup((s) => ({ ...s, operation: id }))}
          options={mailOperations.map((op) => ({ value: op.id, label: op.label }))}
        />
      </Sheet>

      <Sheet eyebrow="Goes into the CSV and the filename" title="Tracking id">
        <div style={{ maxWidth: '26rem' }}>
          <Field label="shipment_tracking_id" raw hint="e.g. B3E110005, RTS120011, or NA">
            <div className="input-row">
              <input
                className="mono"
                type="text"
                style={{ flex: '1 1 auto' }}
                value={setup.trackingId ?? ''}
                placeholder="B3E110005"
                onChange={(e) => setSetup((s) => ({ ...s, trackingId: e.target.value.trim() }))}
              />
              {setup.order ? (
                <button
                  className="btn secondary small"
                  onClick={() => setSetup((s) => ({ ...s, trackingId: s.order.orderNumber }))}
                >
                  Use order number
                </button>
              ) : null}
            </div>
          </Field>
        </div>
        <p className="prose small" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          Some families put <code>NA</code> in this column at initial load and only carry a real
          value at shipment update — the Haptic and Octo sheets both do. The filename still uses
          whatever you enter here.
        </p>
      </Sheet>

      <Sheet
        eyebrow="Only for a wizard upload"
        title={
          <>
            Order <Badge tone="muted">optional</Badge>
          </>
        }
        actions={
          setup.order ? (
            <button
              className="btn secondary small"
              onClick={() => setSetup((s) => ({ ...s, order: null, orderNumber: '' }))}
            >
              Clear
            </button>
          ) : null
        }
      >
        <p className="prose small">
          Only needed if this run has to produce a wizard upload matching an order's serialized
          quantity. Skip it for a plain manufacturer batch.
        </p>

        <div className="card-row">
          <div style={{ flex: '0 0 200px' }}>
            <Field label="Order number">
              <input
                className="mono"
                type="text"
                value={setup.orderNumber ?? ''}
                placeholder="00033958"
                onChange={(e) => setSetup((s) => ({ ...s, orderNumber: e.target.value.trim() }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && setup.orderNumber) lookupOrder(setup.orderNumber);
                }}
              />
            </Field>
          </div>
          <button
            className="btn secondary"
            disabled={orderBusy || !setup.orderNumber}
            onClick={() => lookupOrder(setup.orderNumber)}
          >
            {orderBusy ? 'Looking up…' : 'Look up'}
          </button>
        </div>

        {setup.order ? <OrderDetail order={setup.order} /> : null}

        {!setup.order && recent?.length ? (
          <details style={{ marginTop: '0.9rem' }}>
            <summary className="eyebrow" style={{ cursor: 'pointer' }}>
              Recent orders
            </summary>
            <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Account</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {recent.slice(0, 12).map((o) => (
                    <tr key={o.orderId}>
                      <td className="mono">{o.orderNumber}</td>
                      <td>
                        <OrderStatusBadge status={o.status} />
                      </td>
                      <td className="small">{o.accountName ?? '—'}</td>
                      <td>
                        <button className="btn secondary small" onClick={() => lookupOrder(o.orderNumber)}>
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </Sheet>

      {families ? <MailboxSummary families={families} operation={operation} /> : null}

      <div className="btn-row">
        <button className="btn" disabled={!setup.trackingId} onClick={() => goto('skus')}>
          Pick families &amp; SKUs →
        </button>
      </div>
    </>
  );
}

function OrderDetail({ order }) {
  return (
    <>
      {order.statusFlags?.blockedReason ? (
        <Callout tone="fail" title={`Order is ${order.status}`}>
          {order.statusFlags.blockedReason}
        </Callout>
      ) : null}

      <div className="stat-row" style={{ margin: '1.1rem 0' }}>
        <Stat value={order.serializedLines.length} label="Serialized lines" />
        <Stat value={order.requiredSerialTotal} label="Serials the order needs" />
        <Stat value={order.lines.length - order.serializedLines.length} label="Non-serialized" />
      </div>

      {order.serializedLines.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Decoded</th>
                <th>Product</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {order.serializedLines.map((line) => (
                <tr key={line.orderItemId}>
                  <td className="mono">{line.sku ?? '—'}</td>
                  <td className="small muted">{line.decoded?.decoded ? line.decoded.summary : '—'}</td>
                  <td className="small">{line.name}</td>
                  <td className="num">{line.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Callout tone="warn" title="No serialized lines on this order">
          Nothing here is flagged <code>Product_Serialized__c = 'Yes'</code>, so there is no
          wizard upload to make. An initial load against it still works.
        </Callout>
      )}
    </>
  );
}

function MailboxSummary({ families, operation }) {
  const rows = families.families
    .flatMap((f) => f.operations.filter((o) => o.operation === operation).map((o) => ({ family: f.label, ...o })))
    .filter((r) => r.needsMail);

  if (!rows.length) {
    return (
      <Callout tone="warn" title="No family supports this operation">
        None of the templates cover <code>{operation}</code>.
      </Callout>
    );
  }

  const notReady = rows.filter((r) => !r.ready);

  return (
    <Sheet eyebrow="Routing" title="Where this operation sends">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Family</th>
              <th>Mailbox</th>
              <th>Resolved from</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.family}>
                <td>{r.family}</td>
                <td className="mono small">{r.to ?? '—'}</td>
                <td className="mono small muted">{r.dlSource ?? '—'}</td>
                <td>{r.ready ? <Badge tone="ok">ready</Badge> : <Badge tone="warn">not configured</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notReady.length ? (
        <p className="small" style={{ color: 'var(--warn)', marginTop: '0.7rem', marginBottom: 0 }}>
          {notReady.length} pipeline(s) still have placeholder addresses in{' '}
          <code>config/environments.json</code>. You can generate and download their files, but
          sending is blocked.
        </p>
      ) : null}
    </Sheet>
  );
}

function OrderStatusBadge({ status }) {
  if (status === 'Activated') return <Badge tone="ok">{status}</Badge>;
  if (status === 'Partially Shipped') return <Badge tone="fail">{status}</Badge>;
  if (status === 'Cancelled' || status === 'Returned') return <Badge tone="muted">{status}</Badge>;
  return <Badge tone="info">{status}</Badge>;
}
