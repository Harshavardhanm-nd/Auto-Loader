import React from 'react';
import { api } from '../api.js';
import { Badge, Callout, Explainer, PageHead, Segmented, Sheet, Stat, SyncStatusBadge, Spinner } from '../components/ui.jsx';

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

/**
 * How current a snapshot has to be for selecting a tab to accept it as-is.
 *
 * Short enough that a tab is effectively always live, long enough that moving between tabs to
 * compare them costs one query rather than one per click. The "Refresh now" / "Refresh from org"
 * buttons ignore it — pressing those means "I do not care how recent it is, ask again".
 */
const REFRESH_IF_OLDER_THAN_MS = 15_000;
export default function WatchPage({
  runId,
  run,
  refreshRun,
  goto,
  onError,
  pendingOperation,
  setPendingOperation,
  setActiveOperation,
}) {
  const [stage, setStage] = React.useState('initialLoad');
  const [poll, setPoll] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [selected, setSelected] = React.useState(new Set());
  // Devices that have gone on to a later operation are hidden by default: this tab is about the
  // devices at this stage. The send's own record is one click away, never lost.
  const [model, setModel] = React.useState(null);
  const [position, setPosition] = React.useState(null);

  // Asset-status view tabs — read-only filtered views of the initial-load device pool.
  const [viewPoll, setViewPoll] = React.useState(null);
  const [viewBusy, setViewBusy] = React.useState(false);
  // Why the automatic top-up did not land, shown inline beside the snapshot's age. Never a banner —
  // see the activation effect below.
  const [refreshError, setRefreshError] = React.useState(null);
  const [orderProcessingCsv, setOrderProcessingCsv] = React.useState(null);
  const [showCsvPreview, setShowCsvPreview] = React.useState(false);
  const [csvFilename, setCsvFilename] = React.useState('');
  const isViewTab = ASSET_VIEW_TAB_IDS.has(stage);

  React.useEffect(() => {
    api.lifecycle().then(setModel).catch(() => setModel(null));
  }, []);

  /**
   * Open on the tab the page we came from was showing, once, then clear it.
   *
   * Arriving from Review with Shipment update selected should land on the Shipment update tab, not
   * reset to Initial load. Validated against this page's own strip rather than trusted: Review can
   * be showing an operation that is not watchable at all — `deviceDead` has a sheet and a mailbox
   * but no sync status, so there is no tab to select — and silently selecting a tab that does not
   * exist would render an empty stage with no way back to it.
   */
  React.useEffect(() => {
    if (!pendingOperation) return;
    if (!model) return; // wait for the stage list, so the check below can actually be made
    const selectable =
      ASSET_VIEW_TAB_IDS.has(pendingOperation) ||
      pollableStages(model).some((s) => s.id === pendingOperation);
    if (selectable) {
      setStage(pendingOperation);
      setSelected(new Set());
    }
    setPendingOperation(null);
  }, [pendingOperation, setPendingOperation, model]);

  // The stage being watched is the operation on screen, so the Runbar counts its devices.
  React.useEffect(() => {
    setActiveOperation(stage);
  }, [stage, setActiveOperation]);

  // The stage whose rows this tab shows. Every asset view is a filter over the initial-load pool,
  // so they all read that stage's snapshot rather than one of their own.
  const pollStage = isViewTab ? 'initialLoad' : stage;
  // A boolean rather than the run itself, so the activation effect below does not re-run —
  // and re-query Salesforce — every time the run object is refreshed.
  const hasAllocatedIds = Boolean(run?.idGeneration?.allocatedAt);

  /** Re-read the stored snapshot. Cheap — this is disk, not Salesforce. */
  const load = React.useCallback(async () => {
    try {
      setPoll(await api.poll(runId, stage));
    } catch (err) {
      onError(err);
    }
  }, [runId, stage, onError]);

  /**
   * Ask Salesforce for this tab's stage, then reload the snapshot that writes.
   *
   * This is the one that costs a query, and the only thing that makes a tab current — `load`
   * re-reads whatever was last written to disk, however old that is.
   */
  const refreshFromOrg = React.useCallback(async () => {
    setViewBusy(true);
    setRefreshError(null);
    try {
      await api.pollOnce(runId, pollStage);
      const fresh = await api.poll(runId, pollStage);
      if (isViewTab) setViewPoll(fresh);
      else setPoll(fresh);
      await refreshRun().catch(() => {});
    } catch (err) {
      onError(err);
    } finally {
      setViewBusy(false);
    }
  }, [runId, pollStage, isViewTab, onError, refreshRun]);

  /**
   * Selecting a tab shows its stored snapshot straight away, then quietly brings it up to date.
   *
   * Both halves matter. Drawing the snapshot first keeps tab switching instant — waiting on
   * Salesforce before rendering anything would trade a stale tab for a slow one. Following it with
   * a live read is what removes the second click: before this, every tab opened on whatever the
   * last poll happened to write, and "Refresh from org" was not optional so much as mandatory.
   *
   * Three things suppress the live read, each for its own reason:
   *
   *   - a server-side poll loop is already running for this stage, and is querying every few
   *     seconds anyway — a second request races it for no new information;
   *   - the snapshot is newer than REFRESH_IF_OLDER_THAN_MS, so flipping between tabs costs one
   *     query rather than one per click;
   *   - the effect has been torn down because you moved on, in which case a late response must not
   *     land: it belongs to a tab you are no longer looking at, and would overwrite the rows of
   *     the one you are.
   *
   * A failure here is deliberately not routed to `onError`. The page's error banner is right for a
   * button you pressed and wrong for a refresh you did not ask for — an expired session would
   * otherwise raise one on every tab click. It degrades to the snapshot plus the stamp saying how
   * old it is, which is the honest reading.
   */
  React.useEffect(() => {
    let cancelled = false;
    const setSnapshot = isViewTab ? setViewPoll : setPoll;

    (async () => {
      let current;
      try {
        current = await api.poll(runId, pollStage);
      } catch (err) {
        if (!cancelled) onError(err);
        return;
      }
      if (cancelled) return;
      setSnapshot(current);
      setRefreshError(null);

      if (current?.running) return;
      // Nothing to ask the org about until ids exist. The server refuses this with a 400 ("this
      // run has no allocated ids yet"), so without the guard a draft run fires a request that
      // cannot succeed every time a tab is opened.
      if (!hasAllocatedIds) return;
      const polledAt = current?.snapshot?.lastPolledAt;
      if (polledAt && Date.now() - new Date(polledAt).getTime() < REFRESH_IF_OLDER_THAN_MS) return;

      setViewBusy(true);
      try {
        await api.pollOnce(runId, pollStage);
        const fresh = await api.poll(runId, pollStage);
        if (!cancelled) setSnapshot(fresh);
      } catch (err) {
        if (!cancelled) setRefreshError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setViewBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, pollStage, isViewTab, hasAllocatedIds, onError]);

  /**
   * Where an operation leaves the devices, read off the chart rather than written out here.
   *
   * `deviceDead` has three arrows in the graph and they all land on the same stage, so taking the
   * first is safe. An operation the model does not know returns null and the hand-off simply omits
   * the arrow rather than guessing at a destination.
   */
  const nextStageLabel = React.useCallback(
    (operation) => {
      const move = (model?.transitions ?? []).find((t) => t.operation === operation);
      if (!move) return null;
      return (model?.stages ?? []).find((s) => s.code === move.to)?.label ?? null;
    },
    [model]
  );

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
  const fullSnapshot = poll?.snapshot;
  // Always show only at-stage rows; devices that have moved further appear under their own tab.
  const snapshot = fullSnapshot?.atStage
    ? { ...fullSnapshot, ...fullSnapshot.atStage }
    : fullSnapshot;
  const sendsForStage = Object.values(run.sends ?? {}).filter((s) => s.operation === stage && s.ok);
  const unitCount = run.groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.deviceCount, 0), 0);

  /** Families in this run, deduplicated. A run may hold several. */
  const runFamilies = [...new Set((run.groups ?? []).map((g) => g.family).filter(Boolean))];

  /**
   * The stage step some family in this run must finish before `operation`, or null.
   *
   * Checked per group rather than per run: the rule this replaces was
   * `groups.every(g => g.family === 'octo')`, which read a mixed-family run as non-Octo and
   * skipped the step for its Octo devices.
   */
  const stepRequiredBefore = (operation) =>
    (model?.stageSteps ?? []).find(
      (s) => s.before === operation && (s.requiredFor ?? []).some((f) => runFamilies.includes(f))
    ) ?? null;

  /**
   * Is a related asset synced?
   *
   * `present` false means the accessory has no Asset in the org yet, and a null sync status means
   * the integration has written nothing — both are reasons to wait, not to proceed.
   */
  const accessorySynced = (a) => Boolean(a?.present) && /_SYNC_SUCCESS$/.test(a?.syncStatus ?? '');

  /**
   * A device is complete when it and every accessory recorded against it are synced.
   *
   * Per device, not per run: the four devices whose speakers landed move on while the one that
   * failed is held back. A device with no accessories recorded has nothing to wait on — absence of
   * a record is not evidence of an unsynced part. A snapshot taken before accessories were captured
   * carries none, and must keep its old reading rather than being judged incomplete.
   */
  const accessoriesComplete = (r) => (r.accessories ?? []).every(accessorySynced);

  /** Devices held back only by an accessory, so the notice can name what is missing. */
  const heldByAccessory = (snapshot?.rows ?? []).filter(
    (r) => (r.accessories ?? []).length > 0 && !accessoriesComplete(r)
  );

  // Rows eligible for shipment update: at Pre-Production and fully synced. A family that owes a
  // stage step first (Octo owes its data update) is only eligible to leave the *data-update* tab
  // for shipment update once that step's own success status is on the device — an initial-load
  // success is not enough to skip it. This is scoped to `stage === 'dataUpdate'` rather than
  // applied everywhere: on the initial-load tab a device that owes the step is never offered
  // shipment update in the first place (`getNextOperation` below routes it to the owed operation
  // instead), so requiring DATA_UPDATE_SYNC_SUCCESS there as well only withheld the very first
  // hand-off Octo needs, without withholding anything real — a device that has actually reached
  // DATA_UPDATE_SYNC_SUCCESS is aheadOfStage relative to the initial-load tab and is not in this
  // snapshot at all.
  const owesBeforeShipment = stepRequiredBefore('shipmentUpdate');
  const shipmentEligibleRows = (snapshot?.rows ?? []).filter((r) => {
    if (stage !== 'initialLoad' && stage !== 'dataUpdate') return false;
    if (Number(r.idmsStatus) !== -2) return false;
    if (!accessoriesComplete(r)) return false;
    if (stage === 'dataUpdate' && owesBeforeShipment) return r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS';
    return (
      r.syncStatus === 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS' ||
      r.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS'
    );
  });

  // Rows eligible for received at 3PL: IDMS -1 + shipment update synced.
  const receivedEligibleRows = (snapshot?.rows ?? []).filter(
    (r) =>
      stage === 'shipmentUpdate' &&
      Number(r.idmsStatus) === -1 &&
      r.syncStatus === 'SHIPMENT_UPDATE_SYNC_SUCCESS'
  );

  // Rows eligible for Mark Dead: IDMS 7 (Returned RMA) in the rmaReturned poll tab.
  const deadEligibleRows = (snapshot?.rows ?? []).filter(
    (r) => stage === 'rmaReturned' && Number(r.idmsStatus) === 7
  );

  // Rows on the received tab that have synced — used for the order-processing CSV only.
  const receivedSyncedRows = (snapshot?.rows ?? []).filter(
    (r) => stage === 'received' && r.syncStatus === 'DEVICE_RECEIVED_AT_3PL_SYNC_SUCCESS'
  );

  const eligibleRows =
    shipmentEligibleRows.length > 0
      ? shipmentEligibleRows
      : receivedEligibleRows.length > 0
      ? receivedEligibleRows
      : deadEligibleRows.length > 0
      ? deadEligibleRows
      : receivedSyncedRows;


  const toggleSelect = (deviceId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(deviceId) ? next.delete(deviceId) : next.add(deviceId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (eligibleRows.length > 0 && eligibleRows.every((r) => selected.has(r.deviceId))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(eligibleRows.map((r) => r.deviceId)));
    }
  };

  const getNextOperation = () => {
    if (stage === 'dataUpdate') return 'shipmentUpdate';
    // A family that owes a step before shipment update is sent to that step first. The rule is in
    // config/lifecycle.json, not here — this reads it.
    const owed = stepRequiredBefore('shipmentUpdate');
    if (stage === 'initialLoad' && owed) return owed.operation;
    return 'shipmentUpdate';
  };

  const sendToNextOperation = async () => {
    const operation = getNextOperation();
    const busyKey = `${operation}Gen`;
    const operationLabel = operation === 'dataUpdate' ? 'Data Update' : 'Shipment Update';

    setBusy(busyKey);
    try {
      const result = await api.generate(runId, operation, [...selected]);
      // `blocked` names families the operation could not be written for — a mixed run whose
      // non-Octo groups have no data-update sheet, say. Navigating without saying so tells the
      // operator every ticked device was covered when some were skipped.
      if (result?.blocked?.length) {
        const families = result.blocked.map((b) => b.familyLabel ?? b.family).join(', ');
        onError(new Error(`Nothing was written for ${families}. ${result.blocked[0].message}`));
      }
      await refreshRun();
      goto('review', { operation });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const sendToShipmentUpdate = sendToNextOperation;

  const sendToReceived = async () => {
    setBusy('receivedGen');
    try {
      await api.generate(runId, 'received', [...selected]);
      await refreshRun();
      goto('review', { operation: 'received' });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const sendToRmaReturned = async () => {
    setBusy('rmaReturnedGen');
    try {
      await api.generate(runId, 'rmaReturned', [...selected]);
      await refreshRun();
      goto('review', { operation: 'rmaReturned' });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  const sendToDeviceDead = async () => {
    setBusy('deviceDeadGen');
    try {
      await api.generate(runId, 'deviceDead', [...selected]);
      await refreshRun();
      goto('review', { operation: 'deviceDead' });
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  };

  /**
   * The hand-off this stage offers for the ticked devices: which operation, what to call it, and
   * what pressing it does.
   *
   * Computed here rather than inside the JSX so the "your next step" panel below can tell which
   * operation is already being offered above it and not announce the same one twice. It was
   * previously a three-way ternary whose middle branch built a button element purely to test
   * whether it was truthy, then rendered a second identical one, with a stray console.log between
   * them — same order of precedence, now stated once.
   */
  const handoff = (() => {
    // Read from the run's families rather than `groups.every(...)`, which called a mixed run
    // non-Octo and offered Received at 3PL to its Octo devices — the same per-run mistake
    // `stepRequiredBefore` above exists to correct.
    //
    // Still not per *device*: a run holding both Octo and Driveri groups withholds Received at 3PL
    // from all of them, where only the Octo ones should carry on past it. Scoping eligibility by
    // each device's own family needs the browser to map device id -> family, which this change does
    // not do. Erring toward withholding is the safe half of that: a send not offered is a click
    // away, a send offered wrongly is an email.
    if (deadEligibleRows.length > 0) {
      return {
        operation: 'deviceDead',
        operationLabel: 'Mark Dead',
        description: 'Non-repairable at the repair partner — same devices, same ids.',
        actionLabel: 'Move to Dead',
        busyKey: 'deviceDeadGen',
        onClick: sendToDeviceDead,
      };
    }
    if (receivedEligibleRows.length > 0) {
      return {
        operation: 'received',
        operationLabel: 'Received at 3PL',
        description: 'Same devices, same ids, one more email.',
        actionLabel: 'Send to Received at 3PL',
        busyKey: 'receivedGen',
        onClick: sendToReceived,
      };
    }
    const nextOp = getNextOperation();
    const nextOpLabel = nextOp === 'dataUpdate' ? 'Data Update' : 'Shipment Update';
    return {
      operation: nextOp,
      operationLabel: nextOpLabel,
      description: 'Same devices, same ids, one more email.',
      actionLabel: `Generate ${nextOpLabel} CSV`,
      busyKey: `${nextOp}Gen`,
      onClick: sendToNextOperation,
    };
  })();

  // Toggle a single device in the rmaInitiated view tab selection.
  const toggleRmaSelect = (deviceId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(deviceId) ? next.delete(deviceId) : next.add(deviceId);
      return next;
    });
  };

  const toggleRmaSelectAll = (rows) => {
    if (rows.length > 0 && rows.every((r) => selected.has(r.deviceId))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.deviceId)));
    }
  };

  const buildOrderProcessingCsv = (deviceIds) => {
    const deviceSkuMap = new Map();
    for (const group of run.groups) {
      for (const line of group.lines) {
        for (const generated of (line.generatedRows ?? [])) {
          const id = generated[group.primarySeries];
          if (id != null) deviceSkuMap.set(String(id), line.sku);
        }
      }
    }
    const csvRows = deviceIds.map((id) => {
      const sku = deviceSkuMap.get(String(id)) ?? '';
      return `${sku},${id}`;
    });
    return `SKU,Serial_Number\r\n${csvRows.join('\r\n')}`;
  };

  const generateOrderProcessingCsv = () => {
    const content = buildOrderProcessingCsv([...selected]);
    const trackingId = run.setup?.trackingId ?? runId;
    const base = csvFilename.trim() || `Order_Processing_${trackingId}`;
    const filename = base.endsWith('.csv') ? base : `${base}.csv`;
    setOrderProcessingCsv({ content, filename });
    setShowCsvPreview(false);
  };

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
        <Explainer>
          <p>
            Polling <code>Asset.Sync_Status__c</code> for the {unitCount} unit(s) in this run across{' '}
            {run.groups.length} famil{run.groups.length === 1 ? 'y' : 'ies'}. Polling continues
            server-side — closing this page does not stop it.
          </p>
        </Explainer>
      </PageHead>

      <Sheet
        eyebrow="Stage"
        title={stageMeta.label}
        live={Boolean(!isViewTab && poll?.running)}
        actions={
          !isViewTab ? (
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
                disabled={busy || viewBusy}
                onClick={refreshFromOrg}
              >
                {viewBusy ? 'Refreshing…' : 'Refresh now'}
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
          ) : (
            <button className="btn secondary small" disabled={viewBusy} onClick={refreshFromOrg}>
              {viewBusy ? 'Refreshing…' : 'Refresh from org'}
            </button>
          )
        }
      >
        <Segmented
          label="Stage"
          value={stage}
          onChange={(v) => { setStage(v); setSelected(new Set()); setOrderProcessingCsv(null); setShowCsvPreview(false); setCsvFilename(''); }}
          options={[
            ...stages.filter((s) => s.id !== 'rmaReturned').map((s) => ({
              value: s.id,
              label: s.label,
              title: s.movesTo ? `Moves the device to ${s.movesTo}` : 'Does not change the stage',
              done: Object.values(run.sends ?? {}).some((x) => x.operation === s.id && x.ok),
            })),
            ...ASSET_VIEW_TABS.filter((t) => t.id !== 'deadView').map((t) => ({ value: t.id, label: t.label, title: t.title })),
            // rmaReturned poll tab placed after rmaInitiated view tab
            ...stages.filter((s) => s.id === 'rmaReturned').map((s) => ({
              value: s.id,
              label: s.label,
              title: s.movesTo ? `Moves the device to ${s.movesTo}` : 'Does not change the stage',
              done: Object.values(run.sends ?? {}).some((x) => x.operation === s.id && x.ok),
            })),
            // Dead view tab placed after rmaReturned
            { value: 'deadView', label: 'DEAD', title: 'Non-Repairable by Repair Partner sync status' },
          ]}
        />

        {!isViewTab && sendsForStage.length === 0 ? (
          <p className="small" style={{ color: 'var(--warn)', marginTop: '0.8rem', marginBottom: 0 }}>
            The {stageMeta.label.toLowerCase()} email has not been sent from this run yet — there
            may be nothing to watch.
          </p>
        ) : !isViewTab ? (
          <p className="prose small" style={{ marginTop: '0.8rem', marginBottom: 0 }}>
            Sent to <span className="mono">{sendsForStage[0].to}</span> at{' '}
            {new Date(sendsForStage[0].sentAt).toLocaleTimeString()} · waiting for{' '}
            <span className="mono">{stageMeta.success ?? 'a status this operation does not write'}</span>
          </p>
        ) : null}
      </Sheet>

      {isViewTab ? (
        <ViewTabContent
          stage={stage}
          viewPoll={viewPoll}
          viewBusy={viewBusy}
          refreshError={refreshError}
          selected={selected}
          onToggle={toggleRmaSelect}
          onToggleAll={toggleRmaSelectAll}
        />
      ) : null}

      {stage === 'rmaInitiated' && selected.size > 0 ? (
        <Sheet>
          <NextStepAction
            operationLabel="RMA Returned"
            toLabel={nextStageLabel('rmaReturned')}
            description="Faulty devices received back at the repair partner — same devices, same ids."
            count={selected.size}
            busy={busy === 'rmaReturnedGen'}
            onClick={sendToRmaReturned}
            actionLabel="Send to RMA Returned"
          />
        </Sheet>
      ) : null}

      {stage === 'deadView' && selected.size > 0 ? (
        <Sheet>
          <NextStepAction
            operationLabel="Mark Dead"
            toLabel={nextStageLabel('deviceDead')}
            description="Non-repairable at the repair partner — same devices, same ids."
            count={selected.size}
            busy={busy === 'deviceDeadGen'}
            onClick={sendToDeviceDead}
            actionLabel="Move to Dead"
          />
        </Sheet>
      ) : null}

      {!isViewTab && snapshot ? (
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
                <span className="label" title={refreshError ?? undefined}>
                  {viewBusy
                    ? 'checking Salesforce…'
                    : refreshError
                      ? `could not reach Salesforce${
                          snapshot.lastPolledAt
                            ? ` · showing ${new Date(snapshot.lastPolledAt).toLocaleTimeString()}`
                            : ''
                        }`
                      : snapshot.lastPolledAt
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
          {fullSnapshot?.notYet?.length > 0 ? (
            <Callout tone="muted" title={`${fullSnapshot.notYet.length} device(s) not yet at this stage`}>
              These devices carry an earlier operation&apos;s sync status — the{' '}
              {stageMeta.label.toLowerCase()} email has not been processed for them yet. They will
              appear here once the integration writes a{' '}
              <code>{stageMeta.label.toUpperCase().replace(/ /g, '_')}</code> status.
              <div className="mono small" style={{ marginTop: '0.45rem' }}>
                {fullSnapshot.notYet.map((r) => r.deviceId).join(', ')}
              </div>
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
                    {eligibleRows.length > 0 ? (
                      <th style={{ width: '2rem' }}>
                        <input
                          type="checkbox"
                          title="Select all eligible"
                          checked={eligibleRows.every((r) => selected.has(r.deviceId))}
                          onChange={toggleSelectAll}
                        />
                      </th>
                    ) : null}
                    <th className="raw">device_id</th>
                    <th>Sync status</th>
                    <th>IDMS Status</th>
                    <th>IDMS No</th>
                    <th>Asset status</th>
                    <th>Attached order</th>
                    <th>Last change</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshot.rows ?? []).map((row) => {
                    const eligible =
                      (stage === 'initialLoad' &&
                        Number(row.idmsStatus) === -2 &&
                        row.syncStatus === 'INITIAL_DEVICE_LOAD_SYNC_SUCCESS') ||
                      (stage === 'dataUpdate' &&
                        Number(row.idmsStatus) === -2 &&
                        row.syncStatus === 'DATA_UPDATE_SYNC_SUCCESS') ||
                      (stage === 'shipmentUpdate' &&
                        Number(row.idmsStatus) === -1 &&
                        row.syncStatus === 'SHIPMENT_UPDATE_SYNC_SUCCESS') ||
                      (stage === 'rmaReturned' && Number(row.idmsStatus) === 7) ||
                      (stage === 'received' && row.syncStatus === 'DEVICE_RECEIVED_AT_3PL_SYNC_SUCCESS');
                    return (
                      <React.Fragment key={row.deviceId}>
                        <tr>
                          {eligibleRows.length > 0 ? (
                            <td>
                              {eligible ? (
                                <input
                                  type="checkbox"
                                  checked={selected.has(row.deviceId)}
                                  onChange={() => toggleSelect(row.deviceId)}
                                />
                              ) : null}
                            </td>
                          ) : null}
                          <td className="mono">{row.deviceId}</td>
                          <td>
                            {row.present ? (
                              <SyncStatusBadge status={row.syncStatus} />
                            ) : (
                              <Badge tone="muted">no asset yet</Badge>
                            )}
                          </td>
                          <td className="small">
                            <IdmsStatusLabel stage={row.stage} />
                          </td>
                          <td className="mono small">{row.idmsStatus ?? '—'}</td>
                          <td className="small">{row.assetStatus ?? '—'}</td>
                          <td className="mono small">
                            {row.cpqOrderNumber ?? <span className="faint">unattached</span>}
                          </td>
                          <td className="small muted">
                            {row.lastModifiedDate ? new Date(row.lastModifiedDate).toLocaleTimeString() : '—'}
                          </td>
                        </tr>
                        {row.accessories && row.accessories.length > 0 ? (
                          row.accessories.map((acc, idx) => (
                            <tr key={`${row.deviceId}-acc-${idx}`} style={{ backgroundColor: 'rgba(74, 139, 223, 0.05)' }}>
                              {eligibleRows.length > 0 ? <td /> : null}
                              <td className="mono small" style={{ paddingLeft: '2.5rem' }}>
                                {acc.serialId}
                              </td>
                              <td>
                                {acc.present ? (
                                  <SyncStatusBadge status={acc.syncStatus} />
                                ) : (
                                  <Badge tone="muted">no asset yet</Badge>
                                )}
                              </td>
                              <td className="small">
                                <span style={{ fontSize: '0.85rem', fontStyle: 'italic', color: 'var(--accent)' }}>
                                  {acc.type}
                                </span>
                              </td>
                              <td className="mono small">{acc.stage?.code ?? '—'}</td>
                              <td className="small">{acc.assetStatus ?? '—'}</td>
                              <td className="small faint">—</td>
                              <td className="small muted">—</td>
                            </tr>
                          ))
                        ) : null}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Explainer>
              <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
                The sync status says whether the load landed; the stage says where the device now is.
                They move separately — a device can be at <span className="mono">_SYNC_SUCCESS</span>{' '}
                and not have changed stage yet. An unattached device is normal at this stage: the{' '}
                <code>CPQ_Order__c</code> lookup is set by the wizard, not by either email.
              </p>
            </Explainer>
          </Sheet>

          {heldByAccessory.length ? (
            <Callout
              tone="warn"
              title={`${heldByAccessory.length} device(s) waiting on a related asset`}
            >
              <ul style={{ margin: '0.2rem 0 0', paddingLeft: '1.1rem' }}>
                {heldByAccessory.map((r) => (
                  <li key={r.deviceId} className="small">
                    <span className="mono">{r.deviceId}</span> —{' '}
                    {(r.accessories ?? [])
                      .filter((a) => !accessorySynced(a))
                      .map((a) => `${a.type} ${a.serialId}${a.present ? '' : ' (no asset yet)'}`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {selected.size > 0 && handoff && stage !== 'received' ? (
            <Sheet>
              <NextStepAction
                operationLabel={handoff.operationLabel}
                toLabel={nextStageLabel(handoff.operation)}
                description={handoff.description}
                count={selected.size}
                busy={busy === handoff.busyKey}
                onClick={handoff.onClick}
                actionLabel={handoff.actionLabel}
              />
            </Sheet>
          ) : null}

          {selected.size > 0 && (stage === 'shipmentUpdate' || stage === 'received') ? (
            <Sheet>
              <div className="lc-next">
                <div style={{ minWidth: 0 }}>
                  <div className="lc-next-head">
                    <strong>Assets for Order Processing</strong>
                    <Badge tone="info">
                      {selected.size} device{selected.size !== 1 ? 's' : ''} selected
                    </Badge>
                  </div>
                  <div className="muted small">Generate a SKU / Serial_Number CSV for order processing.</div>
                  <div style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <label className="small" style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>Enter File Name</label>
                    <input
                      className="mono small"
                      style={{ width: '22ch', padding: '2px 6px', fontSize: '0.8em' }}
                      placeholder={`Order_Processing_${run.setup?.trackingId ?? runId}.csv`}
                      value={csvFilename}
                      onChange={(e) => setCsvFilename(e.target.value)}
                    />
                    <span className="muted small">.csv added if omitted</span>
                  </div>
                </div>
                <button className="btn secondary" onClick={generateOrderProcessingCsv}>
                  Generate CSV
                </button>
              </div>
            </Sheet>
          ) : null}

          {orderProcessingCsv ? (
            <Sheet
              eyebrow="Assets for Order Processing"
              title={orderProcessingCsv.filename}
              actions={
                <>
                  <button
                    className="btn secondary small"
                    onClick={() => setShowCsvPreview((v) => !v)}
                  >
                    {showCsvPreview ? 'Hide preview' : 'Preview'}
                  </button>
                  <button
                    className="btn small"
                    onClick={() => {
                      const blob = new Blob([orderProcessingCsv.content], { type: 'text/csv' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = orderProcessingCsv.filename;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download
                  </button>
                </>
              }
            >
              {showCsvPreview ? (() => {
                const lines = orderProcessingCsv.content.split(/\r?\n/).filter(Boolean);
                const [headerLine, ...dataLines] = lines;
                const headers = headerLine.split(',');
                return (
                  <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
                    <table style={{ fontSize: '0.78rem' }}>
                      <thead>
                        <tr>{headers.map((h) => <th key={h} className="raw">{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {dataLines.map((line, i) => (
                          <tr key={i}>
                            {line.split(',').map((cell, j) => (
                              <td key={j} className="mono">{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })() : null}
            </Sheet>
          ) : null}
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

      {position?.stages?.rows ? <NextStep
          position={position}
          goto={goto}
          // Suppressed while the hand-off above is already offering it, so one step is not
          // announced twice in the same layout — once with a button and once without.
          offeredAbove={selected.size > 0 ? handoff?.operation : null}
        /> : null}

      {run.result ? <ResultCard run={run} runId={runId} /> : null}
    </>
  );
}

const ASSET_VIEW_TABS = [
  { id: 'shippedActive', label: 'Shipped Active', title: 'NEW_ORDER_FULFILMENT or IDMS 2 + success' },
  { id: 'installed',     label: 'Installed',      title: 'IDMS status 4' },
  { id: 'rmaPending',    label: 'RMA Pending',    title: 'IDMS status 10' },
  { id: 'rmaInitiated',  label: 'RMA Initiated',  title: 'IDMS status 5' },
  { id: 'deadView',      label: 'DEAD',           title: 'Non-Repairable by Repair Partner sync status' },
];
const ASSET_VIEW_TAB_IDS = new Set(ASSET_VIEW_TABS.map((t) => t.id));

function filterViewRows(rows, tab) {
  if (!rows) return [];
  switch (tab) {
    case 'shippedActive':
      return rows.filter(
        (r) =>
          r.syncStatus === 'NEW_ORDER_FULFILMENT' ||
          r.syncStatus === 'NEW_ORDER_FULFILMENT_SYNC_FAILED' ||
          (Number(r.idmsStatus) === 2 && r.syncStatus === 'NEW_ORDER_FULFILMENT_SYNC_SUCCESS'),
      );
    case 'installed':  return rows.filter((r) => Number(r.idmsStatus) === 4);
    case 'rmaPending': return rows.filter((r) => Number(r.idmsStatus) === 10);
    case 'rmaInitiated':
      return rows.filter(
        (r) =>
          Number(r.idmsStatus) === 5 &&
          r.syncStatus !== 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER' &&
          r.syncStatus !== 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_SUCCESS' &&
          r.syncStatus !== 'FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER_SYNC_FAILED',
      );
    case 'deadView':
      return rows.filter(
        (r) =>
          r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER' ||
          r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER_SYNC_FAILED' ||
          (r.syncStatus === 'NON_REPAIRABLE_BY_REPAIR_PARTNER_SYNC_SUCCESS' && Number(r.idmsStatus) === 9),
      );
    default: return [];
  }
}

function ViewTabContent({
  stage,
  viewPoll,
  viewBusy,
  refreshError,
  selected = new Set(),
  onToggle,
  onToggleAll,
}) {
  const rows = filterViewRows(viewPoll?.snapshot?.rows, stage);
  const tabMeta = ASSET_VIEW_TABS.find((t) => t.id === stage);
  const selectable = stage === 'rmaInitiated' || stage === 'deadView';

  if (viewBusy && !viewPoll) return <Sheet><Spinner label="Loading…" /></Sheet>;
  if (!viewPoll?.snapshot) {
    return (
      <Sheet>
        <p className="muted small" style={{ margin: 0 }}>
          No initial-load snapshot yet — select Initial Load and start polling first, or click{' '}
          <strong>Refresh from org</strong> above.
        </p>
      </Sheet>
    );
  }
  if (rows.length === 0) {
    return (
      <Sheet>
        <p className="muted small" style={{ margin: 0 }}>
          No devices in the <strong>{tabMeta?.label}</strong> state for this run.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet eyebrow={tabMeta?.label} title={`${rows.length} device${rows.length !== 1 ? 's' : ''}`}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {selectable ? (
                <th style={{ width: '2rem' }}>
                  <input
                    type="checkbox"
                    title="Select all"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.deviceId))}
                    onChange={() => onToggleAll(rows)}
                  />
                </th>
              ) : null}
              <th className="raw">device_id</th>
              <th>Sync status</th>
              <th>IDMS Status</th>
              <th>IDMS No</th>
              <th>Asset status</th>
              <th>Attached order</th>
              <th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.deviceId}>
                {selectable ? (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(row.deviceId)}
                      onChange={() => onToggle(row.deviceId)}
                    />
                  </td>
                ) : null}
                <td className="mono">{row.deviceId}</td>
                <td>
                  {row.present ? (
                    <SyncStatusBadge status={row.syncStatus} />
                  ) : (
                    <Badge tone="muted">no asset yet</Badge>
                  )}
                </td>
                <td className="small"><IdmsStatusLabel stage={row.stage} /></td>
                <td className="mono small">{row.idmsStatus ?? '—'}</td>
                <td className="small">{row.assetStatus ?? '—'}</td>
                <td className="mono small">
                  {row.cpqOrderNumber ?? <span className="faint">unattached</span>}
                </td>
                <td className="small muted">
                  {row.lastModifiedDate
                    ? new Date(row.lastModifiedDate).toLocaleTimeString()
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The instruction to press Refresh used to live here. Selecting the tab now does that, so
          what is left to say is how current these rows are — without a stamp, an automatic refresh
          that quietly failed is indistinguishable from one that worked. */}
      <p className="prose small" style={{ marginTop: '0.7rem', marginBottom: 0 }}>
        {stage === 'rmaInitiated'
          ? 'Select devices to generate the RMA Returned CSV. '
          : stage === 'deadView'
          ? 'Devices flagged Non-Repairable by Repair Partner. '
          : ''}
        <Freshness poll={viewPoll} busy={viewBusy} error={refreshError} />
      </p>
    </Sheet>
  );
}

/**
 * How current the rows on screen are, and — if the automatic read failed — that it did.
 *
 * The whole point of refreshing on tab activation is that nobody has to think about it, which is
 * exactly why a silent failure would be worse here than before: previously stale data meant you
 * had not pressed the button, and now it means nothing visible at all unless this says so.
 */
function Freshness({ poll, busy, error }) {
  if (busy) return <span className="muted">Checking Salesforce…</span>;

  const at = poll?.snapshot?.lastPolledAt;
  const stamp = at ? new Date(at).toLocaleTimeString() : null;

  if (error) {
    return (
      <span style={{ color: 'var(--warn)' }}>
        Could not reach Salesforce{stamp ? ` — showing the snapshot from ${stamp}` : ''}. The
        Refresh button retries.
      </span>
    );
  }
  return <span className="muted">{stamp ? `Read from Salesforce at ${stamp}.` : 'Not read yet.'}</span>;
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

  // The payload is already in the order a device meets these — `operationOrder` on the server puts
  // the polling chain first, stage steps included. This used to re-sort by the stage an operation
  // moves the device *to*, which a stage step does not have: `dataUpdate` fell to the `?? 99`
  // default and rendered last, after Received at 3PL, when it runs *before* the shipment update.
  // Ordering it here again would be a second opinion for Review's selector to disagree with.
  return model.operations
    .filter((o) => o.syncStatus)
    .map((o) => ({
      id: o.id,
      label: o.label,
      success: `${o.syncStatus}_SYNC_SUCCESS`,
      movesTo: o.movement ? model.stages.find((s) => s.code === o.movement.to[0])?.label ?? null : null,
    }));
}

function IdmsStatusLabel({ stage }) {
  if (!stage) return <span className="faint">—</span>;
  if (stage.absent) return <Badge tone="muted">no stage yet</Badge>;
  if (!stage.known) return <Badge tone="warn" title="Not on the DLCM chart">unmapped</Badge>;
  return <span>{stage.label}</span>;
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
function NextStep({ position, goto, offeredAbove = null }) {
  const { position: pos, stages } = position;
  const next = position.next ?? { mine: [], theirs: [] };
  // The hand-off panel above already offers this operation, with the ticked devices attached.
  // Listing it again here would announce one step twice in the same layout.
  const mine = next.mine.filter((step) => step.operation !== offeredAbove);

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

      {mine.length ? (
        <>
          <span className="eyebrow" style={{ marginBottom: '0.5rem' }}>
            Your next step
          </span>
          {mine.map((step) => (
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
              {/* No button here. This panel says what comes next; the hand-off above is what does
                  it, and it carries the ticked devices with it. A second route to Review that took
                  no selection would send the whole run when you meant a subset — the two looked
                  interchangeable and were not. */}
              {step.alreadySent ? <Badge tone="ok">sent</Badge> : null}
            </div>
          ))}
        </>
      ) : /* `next.mine`, not the filtered `mine`: an empty list because the hand-off above is
            already offering the step is not the same as having nothing to send, and claiming
            "your part of the chain is done" over a live send button would be simply false. */
      pos && next.mine.length === 0 ? (
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

/**
 * The hand-off from one stage to the next, in the same shape the life cycle panel uses for
 * "your next step": what the operation is, where it moves the devices, and one button.
 *
 * There were four of these written out separately — RMA Returned, Dead, Received at 3PL and the
 * next operation in the chain — each a bare button beside a "N devices selected" count, and each
 * looking like a different kind of thing to the operator. They are the same thing: take the ticked
 * devices and carry them to the next step.
 *
 * The count is a badge rather than a sentence because the number is the part that matters — this
 * generates for **exactly** the ticked devices, so a hand-off raised for a subset carries that
 * subset and no more. Ticking the header checkbox is how you send them all.
 */
function NextStepAction({ operationLabel, toLabel, description, count, busy, onClick, actionLabel }) {
  return (
    <div className="lc-next">
      <div style={{ minWidth: 0 }}>
        <div className="lc-next-head">
          <strong>{operationLabel}</strong>
          {toLabel ? <span className="muted small">→ {toLabel}</span> : null}
          <Badge tone="info">
            {count} device{count !== 1 ? 's' : ''} selected
          </Badge>
        </div>
        <div className="muted small">{description}</div>
      </div>
      <button className="btn" disabled={busy} onClick={onClick}>
        {busy ? 'Generating…' : actionLabel}
      </button>
    </div>
  );
}
