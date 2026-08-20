import express from 'express';
import {
  createRun,
  getRun,
  updateRun,
  listRuns,
  summariseRun,
  appendEvent,
  saveArtifact,
  loadArtifact,
  deleteRun,
} from '../services/run-store.js';
import { allocateSeries, describeCursors, resetCursor, setCursor, primarySeriesOf } from '../services/id-generator.js';
import { buildCsv, planGeneratedRows, planWizardRows, planExistingRows, planDeadRows } from '../services/csv-builder.js';
import {
  findTakenDeviceIds,
  fetchOrder,
  fetchAssetsByDeviceId,
  fetchAssetsByTrackingId,
  tallyRows,
  rescoreSnapshot,
  splitByStagePosition,
} from '../services/sf-client.js';
import { readSession } from '../services/sf-session.js';
import { deliver, buildEml, describeSmtp } from '../services/mailer.js';
import { checkSentItems, closeOutlook } from '../services/outlook-web-service.js';
import { startPolling, stopPolling, pollOnce, isPolling } from '../services/poller.js';
import {
  validateArtifact,
  validateIdsFree,
  validateDeviceStages,
  validateWizardRowCount,
  validateSerialsShipped,
  validateSendTarget,
  duplicateSendReason,
  summariseChecks,
  artifactPreview,
} from '../services/validator.js';
import {
  describeLifecycle,
  summariseStages,
  nextFrom,
  operationMovement,
  operationOrder,
  operationRole,
  syncStatusBase,
  classifyStage,
  stageByCode,
} from '../lib/lifecycle.js';
import {
  getEnvironment,
  getTemplate,
  findTemplate,
  loadTemplates,
  loadOperations,
  resolveDistributionList,
  sendBlockers,
  isSharedOperation,
  SHARED_FAMILY,
} from '../lib/config.js';

export const runsRouter = express.Router();

/**
 * A run is a set of groups sharing one tracking id. Each group is one product family, which
 * means one template, one CSV and one email — every send carries exactly one attachment, so
 * families cannot be combined into a single message.
 *
 * Ids are minted once, from the family's initial-load template, and reused by every later
 * operation. A shipment update that invented fresh ids would update nothing.
 */

const artifactKey = (operation, family) => `${operation}:${family}`;

// Allowed "Device Type" values for the Dead CSV, mapped from Asset.Device_Category__c.
const DEAD_DEVICE_TYPE_MAP = {
  HAPTIC: 'HAPTIC',
  DHUB: 'DHUB',
  'D-HUB': 'DHUB',
  DMS: 'DMS',
  VBUS: 'VBUS',
  'V-BUS': 'VBUS',
  DRIVERI: 'Driveri',
  'DRIVER-I': 'Driveri',
  // Octo is the D810 series, and the org's own `Device_Type__c` calls both of its products
  // `Driveri` — the same value it gives D210 through D475 (verified against testing 2026-08-20).
  // The Dead sheet has no OCTO value and does not need one.
  OCTO: 'Driveri',
  WIRELESS_ALERT_BUTTON: 'WIRELESS_ALERT_BUTTON',
  WIRELESS: 'WIRELESS_ALERT_BUTTON',
};

/**
 * The only values the Dead sheet's `Device Type` column accepts.
 *
 * Declared as data rather than left in `device-dead.json`'s prose notes so the resolver can enforce
 * it. That descriptor carries no `sourceTemplate`, so nothing here has ever been byte-checked
 * against a sheet the parser accepted — which is all the more reason to refuse a value we know is
 * outside the list.
 */
export const DEAD_DEVICE_TYPES = new Set([
  'VBUS',
  'DHUB',
  'HAPTIC',
  'WIRELESS_ALERT_BUTTON',
  'Driveri',
  'DMS',
]);

/**
 * The `Device Type` a Dead row carries, from the group's family.
 *
 * Note it is the *family*, not the Asset's `Device_Category__c` — `device-dead.json`'s note and
 * CLAUDE.md both say otherwise and both are stale. The distinction matters: `Device_Category__c`
 * holds region codes (`NAMZ`) on real Assets, so it could not serve this purpose anyway.
 *
 * Refuses rather than guessing, for the same reason `escapeField` refuses a comma instead of
 * quoting it: no family legitimately resolves to something outside the sheet's vocabulary, so an
 * unmapped one is a gap in this map, not data to pass along. It returned its input verbatim until
 * 2026-08-20, which is how `octo` — added to the app after this map was written — spent its whole
 * life emitting the literal string `octo` into a column that does not accept it, silently. A
 * blocked generate is recoverable; a Dead file the parser mishandles is not.
 */
export function resolveDeadDeviceType(family) {
  if (!family) {
    throw new Error(
      'Cannot build a Dead row without knowing the device\'s family — its Device Type would be a guess.',
    );
  }
  const key = String(family).toUpperCase().trim();
  const resolved = DEAD_DEVICE_TYPE_MAP[key];
  if (!resolved) {
    throw new Error(
      `No Dead sheet Device Type is mapped for family "${family}". ` +
        `Add it to DEAD_DEVICE_TYPE_MAP — allowed values are ${[...DEAD_DEVICE_TYPES].join(', ')}.`,
    );
  }
  return resolved;
}

function groupTemplate(group, operation) {
  return findTemplate(group.family, operation);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

runsRouter.get('/', (req, res) => {
  res.json({
    runs: listRuns({
      limit: Number(req.query.limit) || 50,
      // Omit `env` to list every environment; the History page always names one.
      env: req.query.env || null,
    }),
  });
});

runsRouter.post('/', async (req, res, next) => {
  try {
    const { env = 'testing', operation = 'initialLoad', trackingId, orderNumber, groups, notes } = req.body ?? {};

    if (!Array.isArray(groups) || groups.length === 0) throw new Error('Pick at least one family and SKU.');
    if (!trackingId || !String(trackingId).trim()) {
      throw new Error(
        'A shipment tracking id is required — it goes in the CSV and in the filename (e.g. B3E110005).'
      );
    }
    if (!loadOperations()[operation]) throw new Error(`Unknown operation "${operation}".`);

    // The order is optional: an initial load is a batch arriving from a manufacturer and does
    // not have to relate to any order. It is only needed for the wizard upload's row count.
    let order = null;
    if (orderNumber) {
      const found = await fetchOrder(env, orderNumber);
      order = {
        orderNumber: found.orderNumber,
        orderId: found.orderId,
        status: found.status,
        accountName: found.accountName,
        requiredSerialTotal: found.requiredSerialTotal,
        statusFlags: found.statusFlags,
        serializedLines: found.serializedLines,
      };
    }

    const normalisedGroups = groups.map((group) => {
      const template = groupTemplate(group, operation);
      const lines = (group.lines ?? []).map((line) => {
        const fromOrder = order?.serializedLines?.find((l) => l.sku === line.sku);
        const quantity = fromOrder ? fromOrder.quantity : Number(line.quantity ?? 0);
        const batchSize = Number(line.deviceCount ?? Math.max(quantity, 1));

        if (!line.sku) throw new Error(`${template.familyLabel}: every line needs a SKU.`);
        if (!Number.isInteger(batchSize) || batchSize < 1) {
          throw new Error(`${line.sku}: batch size must be a positive integer.`);
        }
        if (fromOrder && batchSize < quantity) {
          throw new Error(
            `${line.sku}: batch size ${batchSize} is below the order quantity ${quantity}. ` +
              'The wizard upload needs one serial per ordered unit.'
          );
        }
        return {
          sku: line.sku,
          name: line.name ?? fromOrder?.name ?? null,
          // Two different counts, deliberately separate.
          quantity,
          deviceCount: batchSize,
          onOrder: Boolean(fromOrder),
          generatedRows: [],
        };
      });

      if (!lines.length) throw new Error(`${template.familyLabel}: pick at least one SKU.`);

      return {
        family: group.family,
        familyLabel: template.familyLabel,
        kind: template.kind,
        templateId: template.id,
        fields: { ...template.defaults, ...(group.fields ?? {}) },
        lines,
      };
    });

    const run = createRun({
      env,
      operation,
      trackingId: String(trackingId).trim(),
      order,
      groups: normalisedGroups,
      notes,
    });

    res.json({ run });
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    res.json({
      run,
      polling: Object.fromEntries(
        Object.keys(run.polling ?? {}).map((stage) => [stage, isPolling(run.runId, stage)])
      ),
    });
  } catch (err) {
    next(err);
  }
});

runsRouter.delete('/:runId', (req, res, next) => {
  try {
    res.json(deleteRun(req.params.runId));
  } catch (err) {
    next(err);
  }
});

runsRouter.patch('/:runId', (req, res, next) => {
  try {
    const { trackingId, fields, family } = req.body ?? {};
    const updated = updateRun(req.params.runId, (run) => {
      if (trackingId !== undefined) {
        if (!String(trackingId).trim()) throw new Error('Tracking id cannot be blank.');
        run.trackingId = String(trackingId).trim();
        // Filenames and a tracking column both derive from it, so any built file is stale.
        run.artifacts = {};
      }
      if (fields && family) {
        const group = run.groups.find((g) => g.family === family);
        if (!group) throw new Error(`Run has no "${family}" group.`);
        group.fields = { ...group.fields, ...fields };
        run.artifacts = {};
      }
      return run;
    });
    res.json({ run: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Id allocation
// ---------------------------------------------------------------------------

runsRouter.get('/:runId/cursors', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    res.json({
      cursors: run.groups.map((group) => {
        const template = getTemplate(group.templateId);
        return {
          family: group.family,
          familyLabel: group.familyLabel,
          templateId: group.templateId,
          series: describeCursors(run.env, group.templateId, template.series),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/cursors/set', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { templateId, seriesName, value } = req.body ?? {};
    if (!templateId || !seriesName || value == null) throw Object.assign(new Error('templateId, seriesName and value required'), { status: 400 });
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('value must be a non-negative number'), { status: 400 });
    const template = getTemplate(templateId);
    const def = template.series?.[seriesName];
    if (!def) throw Object.assign(new Error(`Unknown series "${seriesName}" on "${templateId}"`), { status: 400 });
    if (def.digits && n > (10 ** def.digits - 1)) throw Object.assign(new Error(`Value exceeds ${def.digits}-digit limit`), { status: 400 });
    setCursor(run.env, templateId, seriesName, n);
    res.json({ set: true, value: n });
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/cursors/reset', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { family } = req.body ?? {};
    // Report what each series was seeded back to. Without this the call looks like a no-op
    // whenever no counter had been persisted yet — the cursor already read sampleStart, and
    // resetting it to sampleStart changed nothing visible.
    const reset = [];
    for (const group of run.groups) {
      if (family && group.family !== family) continue;
      const template = getTemplate(group.templateId);
      for (const [name, def] of Object.entries(template.series ?? {})) {
        reset.push({
          family: group.family,
          templateId: group.templateId,
          seriesName: name,
          next: resetCursor(run.env, group.templateId, name, def),
        });
      }
    }
    res.json({ reset: true, series: reset });
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/allocate', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const connected = Boolean(readSession(run.env));
    const checkTaken = connected ? (ids) => findTakenDeviceIds(run.env, ids) : null;

    const allocations = [];
    const groups = [];

    for (const group of run.groups) {
      const template = getTemplate(group.templateId);
      const total = group.lines.reduce((n, l) => n + l.deviceCount, 0);

      if (!Object.keys(template.series ?? {}).length) {
        // Received and wizard uploads act on ids from an earlier run.
        groups.push(group);
        continue;
      }

      const allocation = await allocateSeries({
        env: run.env,
        templateId: group.templateId,
        series: template.series,
        count: total,
        checkTaken,
      });

      // Hand each line its own contiguous slice, in line order.
      let cursor = 0;
      const lines = group.lines.map((line) => {
        const slice = allocation.rows.slice(cursor, cursor + line.deviceCount);
        cursor += line.deviceCount;
        return { ...line, generatedRows: slice };
      });

      groups.push({ ...group, lines, primarySeries: primarySeriesOf(template) });
      allocations.push({
        family: group.family,
        familyLabel: group.familyLabel,
        count: total,
        attempts: allocation.attempts,
        collisionCheckRan: allocation.checked,
        collisions: allocation.collisions,
        ranges: allocation.ranges,
      });
    }

    const updated = updateRun(run.runId, (r) => {
      r.groups = groups;
      r.idGeneration = { allocatedAt: new Date().toISOString(), allocations };
      // Ids changed, so any built file and any send record are stale.
      r.artifacts = {};
      r.sends = {};
      r.polling = {};
      r.result = null;
      r.status = 'ids-allocated';
      return r;
    });
    appendEvent(run.runId, 'ids.allocated', allocations.map((a) => `${a.family} ×${a.count}`).join(', '));

    res.json({
      run: updated,
      allocations,
      warning: connected
        ? null
        : 'Not connected to Salesforce — ids were NOT checked against Asset.Name. ' +
          'The load will fail for any id already taken.',
    });
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/check-ids', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const ids = collectCheckableIds(run);
    const taken = await findTakenDeviceIds(run.env, ids);
    res.json({ checked: ids.length, taken, free: taken.length === 0 });
  } catch (err) {
    next(err);
  }
});

/** Numeric series values only — the prefixed pseudo-MACs are not asset names. */
function collectCheckableIds(run) {
  const ids = [];
  for (const group of run.groups) {
    const template = getTemplate(group.templateId);
    for (const line of group.lines) {
      for (const row of line.generatedRows ?? []) {
        for (const [name, value] of Object.entries(row)) {
          if (template.series?.[name]?.type !== 'prefixed') ids.push(value);
        }
      }
    }
  }
  return ids;
}

/**
 * The devices a given stage actually acted on.
 *
 * Accumulates across all sends for the stage — current and archived — so a second partial send
 * to the same stage adds to the poll tab rather than replacing it. Falls back to the current
 * artifact when nothing has been sent yet, and to the run's full id set as a last resort.
 */
function stageDeviceIds(run, stage) {
  // Collect ids from every confirmed send for this stage (current + superseded).
  const fromSends = [
    ...Object.entries(run.sends ?? {})
      .filter(([key]) => key.startsWith(`${stage}:`))
      .flatMap(([, send]) => send?.deviceIds ?? []),
    ...Object.entries(run.sendHistory ?? {})
      .filter(([key]) => key.startsWith(`${stage}:`))
      .flatMap(([, history]) =>
        (Array.isArray(history) ? history : [history]).flatMap((s) => s?.deviceIds ?? [])
      ),
  ];
  if (fromSends.length) return [...new Set(fromSends.map(String))];

  // Nothing sent yet — use the current artifact so polling can start before the send.
  const fromFiles = Object.entries(run.artifacts ?? {})
    .filter(([key]) => key.startsWith(`${stage}:`))
    .flatMap(([, artifact]) => artifact.deviceIds ?? []);
  if (fromFiles.length) return [...new Set(fromFiles.map(String))];

  // Only fall back to the full run device list for the initial load — every other operation
  // applies to an operator-selected subset, so an empty result is the correct answer when
  // nothing has been generated or sent for that stage yet.
  return stage === 'initialLoad' ? runDeviceIds(run) : [];
}

/** The primary ids this run minted. */
function runDeviceIds(run) {
  const ids = [];
  for (const group of run.groups) {
    const primary = group.primarySeries ?? primarySeriesOf(getTemplate(group.templateId));
    if (!primary) continue;
    for (const line of group.lines) {
      for (const row of line.generatedRows ?? []) if (row[primary]) ids.push(row[primary]);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

runsRouter.post('/:runId/generate', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const operation = req.body?.operation ?? run.operation;
    if (!loadOperations()[operation]) throw new Error(`Unknown operation "${operation}".`);

    // Optional subset of device ids — used when triggering shipmentUpdate from the Watch page.
    const deviceIdsFilter =
      Array.isArray(req.body?.deviceIds) && req.body.deviceIds.length > 0
        ? new Set(req.body.deviceIds.map(String))
        : null;

    const built = [];
    const blocked = [];

    // Dead operation: shared sheet — Device Type comes from the group family, not SF assets.
    if (operation === 'deviceDead') {
      const template = findTemplate(SHARED_FAMILY, operation);
      const allIds = runDeviceIds(run);
      const ids = deviceIdsFilter ? allIds.filter((id) => deviceIdsFilter.has(String(id))) : allIds;
      if (!ids.length) throw new Error('Select devices at IDMS 7 before generating the Dead CSV.');

      // Build id→family from generatedRows so each device carries its own group's type.
      const idToFamily = new Map();
      for (const group of run.groups) {
        const primary = group.primarySeries ?? primarySeriesOf(getTemplate(group.templateId));
        if (!primary) continue;
        for (const line of group.lines) {
          for (const row of line.generatedRows ?? []) {
            if (row[primary]) idToFamily.set(String(row[primary]), group.family);
          }
        }
      }

      const deviceEntries = ids.map((id) => ({
        deviceId: id,
        deviceType: resolveDeadDeviceType(idToFamily.get(String(id))),
      }));

      const familyLabel = run.groups[0]?.family?.toUpperCase() ?? 'SHARED';
      const artifact = buildCsv(template, {
        trackingId: run.trackingId,
        fields: run.sharedFields ?? {},
        rows: planDeadRows(deviceEntries),
        family: familyLabel,
      });
      built.push(saveArtifact(run.runId, artifactKey(operation, SHARED_FAMILY), artifact));
      appendEvent(run.runId, 'files.generated', artifact.filename);
      const updated = updateRun(run.runId, (r) => { r.status = 'files-generated'; return r; });
      res.json({ run: updated, artifacts: built.map((a) => artifactPreview(a)), blocked });
      return;
    }

    // A family-independent operation produces ONE file for the whole run, not one per family.
    // The received sheet is identical across families and lists every device id in the run.
    if (isSharedOperation(operation)) {
      const template = findTemplate(SHARED_FAMILY, operation);
      const allIds = runDeviceIds(run);
      const ids = deviceIdsFilter ? allIds.filter((id) => deviceIdsFilter.has(String(id))) : allIds;
      if (!ids.length) throw new Error('Allocate ids before generating this operation.');

      // Use the run's family name in the filename; for mixed runs take the first group.
      const familyLabel = run.groups[0]?.family?.toUpperCase() ?? 'SHARED';
      const artifact = buildCsv(template, {
        trackingId: run.trackingId,
        fields: run.sharedFields ?? {},
        rows: planExistingRows(ids),
        family: familyLabel,
      });
      built.push(saveArtifact(run.runId, artifactKey(operation, SHARED_FAMILY), artifact));

      appendEvent(run.runId, 'files.generated', artifact.filename);
      const updated = updateRun(run.runId, (r) => {
        r.status = 'files-generated';
        return r;
      });
      res.json({ run: updated, artifacts: built.map((a) => artifactPreview(a)), blocked });
      return;
    }

    const allAccessories = {};
    for (const group of run.groups) {
      let template;
      try {
        template = findTemplate(group.family, operation);
      } catch (err) {
        blocked.push({ family: group.family, familyLabel: group.familyLabel, message: err.message });
        continue;
      }

      if (template.status !== 'verified') {
        blocked.push({
          family: group.family,
          familyLabel: group.familyLabel,
          template: template.id,
          status: template.status,
          awaiting: template.awaiting ?? null,
          message: `"${template.label}" is not a confirmed format yet, so nothing was written for it.`,
        });
        continue;
      }

      const allDeviceIds = runDeviceIds(run);
      const deviceIds = deviceIdsFilter
        ? allDeviceIds.filter((id) => deviceIdsFilter.has(String(id)))
        : allDeviceIds;
      let rows;
      if (template.reusesExistingDevices) {
        rows = planExistingRows(deviceIds);
      } else {
        const allRows = planGeneratedRows(group.lines);
        // When a subset is requested, keep only rows whose primary id is in the filter.
        if (deviceIdsFilter) {
          const primary = group.primarySeries ?? primarySeriesOf(template);
          rows = allRows.filter((r) => {
            const id = primary ? r.generated[primary] : Object.values(r.generated)[0];
            return deviceIdsFilter.has(String(id));
          });
        } else {
          rows = allRows;
        }
      }

      const artifact = buildCsv(template, {
        trackingId: run.trackingId,
        fields: group.fields,
        rows,
      });
      built.push(saveArtifact(run.runId, artifactKey(operation, group.family), artifact));

      // For Octo initialLoad, store accessory serial mappings for later polling
      if (group.family === 'octo' && operation === 'initialLoad') {
        const primary = group.primarySeries ?? primarySeriesOf(template);
        for (const row of rows) {
          const deviceId = primary ? row.generated[primary] : Object.values(row.generated)[0];
          if (deviceId) {
            allAccessories[deviceId] = {
              wiredSpeaker: row.generated.wired_speaker_serial,
              nativeCam: row.generated.native_cam_serial,
            };
          }
        }
      }
    }

    // The wizard upload is per-run, not per-family: it lists the serials the ORDER needs.
    if (operation === 'initialLoad' && run.order?.requiredSerialTotal > 0) {
      for (const templateId of ['order-load']) {
        const template = getTemplate(templateId);
        const orderLines = run.groups.flatMap((g) => g.lines.filter((l) => l.onOrder && l.quantity > 0));
        if (!orderLines.length) continue;
        const primary =
          run.groups[0]?.primarySeries ?? primarySeriesOf(getTemplate(run.groups[0].templateId));
        const artifact = buildCsv(template, {
          trackingId: run.trackingId,
          rows: planWizardRows(orderLines, primary),
        });
        built.push(saveArtifact(run.runId, artifactKey('wizardUpload', 'shared'), artifact));
      }
    }

    appendEvent(run.runId, 'files.generated', built.map((b) => b.filename).join(', '));
    const updated = updateRun(run.runId, (r) => {
      r.status = 'files-generated';
      if (Object.keys(allAccessories).length > 0) {
        r.accessories ??= {};
        Object.assign(r.accessories, allAccessories);
      }
      return r;
    });

    res.json({ run: updated, artifacts: built.map((a) => artifactPreview(a)), blocked });
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/preview/:key', (req, res, next) => {
  try {
    const artifact = loadArtifact(req.params.runId, req.params.key);
    res.json(artifactPreview(artifact, Number(req.query.maxBytes) || 512));
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/download/:key', (req, res, next) => {
  try {
    const artifact = loadArtifact(req.params.runId, req.params.key);
    const name = req.query.asUpload === 'true' && artifact.uploadAs ? artifact.uploadAs : artifact.filename;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(artifact.buffer);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

runsRouter.get('/:runId/validate', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const environment = getEnvironment(run.env);
    const operation = req.query.operation ?? run.operation;

    const groups = {};

    // Collision check once for the whole run.
    let taken = [];
    let checked = false;
    try {
      const ids = collectCheckableIds(run);
      if (ids.length) {
        taken = await findTakenDeviceIds(run.env, ids);
        checked = true;
      }
    } catch {
      checked = false;
    }
    // Also skip when any artifact exists — ids were minted for this run so finding them in the
    // org is expected at any later operation (shipmentUpdate, received, rmaReturned, …).
    const alreadySent =
      Object.values(run.sends ?? {}).some((s) => s?.ok) ||
      Object.keys(run.artifacts ?? {}).length > 0;
    groups.org = [validateIdsFree({ takenIds: taken, checked, alreadySent })];

    // Life cycle position. Read in the same pass as the collision check, and reported as a
    // warning — the stage is written by another system, so it can move between this read and
    // the send, and refusing on it would invent a new way to be stuck.
    let deviceStages = null;
    try {
      const assets = await fetchAssetsByDeviceId(run.env, runDeviceIds(run));
      const byId = new Map(assets.map((a) => [a.deviceId, a]));
      deviceStages = runDeviceIds(run).map((deviceId) => ({
        deviceId,
        idmsStatus: byId.get(String(deviceId))?.idmsStatus ?? null,
      }));
    } catch {
      deviceStages = null;
    }
    groups.org.push(
      validateDeviceStages({ operation, deviceStages: deviceStages ?? [], checked: Boolean(deviceStages) })
    );

    // A family-independent operation has one artifact for the whole run, keyed to the shared
    // family, so it is validated once rather than per group.
    const targets = isSharedOperation(operation)
      ? [{ family: SHARED_FAMILY, familyLabel: 'Any family', fields: run.sharedFields ?? {}, lines: [] }]
      : run.groups;

    for (const group of targets) {
      const key = artifactKey(operation, group.family);
      if (!run.artifacts?.[key]) continue;

      const template = findTemplate(group.family, operation);
      const artifact = loadArtifact(run.runId, key);
      const generatedRows = group.lines.flatMap((l) => l.generatedRows ?? []);

      const checks = validateArtifact({
        template,
        artifact,
        trackingId: run.trackingId,
        fields: group.fields,
        generatedRows,
      });

      const dl = resolveDistributionList(run.env, group.family, operation);
      if (dl) {
        checks.push(
          ...validateSendTarget({
            environment,
            template,
            dl,
            recipient: dl.to,
            attachmentCount: 1,
            blockers: sendBlockers(run.env, group.family, operation),
          })
        );
      }
      groups[`${group.familyLabel} — ${operation}`] = checks;
    }

    // Wizard upload, if one was generated.
    const wizardKey = artifactKey('wizardUpload', 'shared');
    if (run.artifacts?.[wizardKey]) {
      const template = getTemplate('order-load');
      const artifact = loadArtifact(run.runId, wizardKey);

      let assetStates = null;
      if (run.polling?.shipmentUpdate?.settled) {
        const assets = await fetchAssetsByDeviceId(run.env, runDeviceIds(run)).catch(() => []);
        assetStates = Object.fromEntries(assets.map((a) => [a.deviceId, a.syncStatus]));
      }

      groups['Wizard upload'] = [
        ...validateArtifact({ template, artifact, trackingId: run.trackingId, fields: {}, generatedRows: [] }),
        validateWizardRowCount({ artifact, template, requiredSerialTotal: run.order?.requiredSerialTotal ?? 0 }),
        validateSerialsShipped({ artifact, template, assetStates }),
      ];
    }

    res.json({
      operation,
      ...summariseChecks(groups),
      smtp: describeSmtp(run.env),
      environment: { name: environment.name, label: environment.label },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

runsRouter.post('/:runId/send', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { operation, family, force = false } = req.body ?? {};

    if (!loadOperations()[operation]) throw new Error(`Unknown operation "${operation}".`);
    const dl = resolveDistributionList(run.env, family, operation);
    if (!dl) throw new Error(`"${operation}" does not send mail — it is an in-app upload.`);

    const blockers = sendBlockers(run.env, family, operation);
    if (blockers.length) {
      throw new Error(
        `config/environments.json still has placeholder values for this pipeline ` +
          `(${blockers.join(', ')}). Sending is blocked until they are real.`
      );
    }

    const key = artifactKey(operation, family);
    const artifact = loadArtifact(run.runId, key);

    if (!force) {
      const duplicate = duplicateSendReason({
        currentSend: run.sends?.[key],
        archivedSends: run.sendHistory?.[key] ?? [],
        artifact,
      });
      if (duplicate) throw new Error(duplicate);
    }

    const result = await deliver(
      run.env,
      {
        to: dl.to,
        subject: dl.subject,
        body: dl.body,
        // The Outlook transport attaches from disk; SMTP uses the buffer. Both are provided.
        attachment: { filename: artifact.filename, content: artifact.buffer, path: artifact.path },
      },
      req.body?.autoSend === undefined ? {} : { autoSend: Boolean(req.body.autoSend) }
    );

    // Compose-and-stop is not a send. Recording it as one would let the duplicate-send guard
    // block the real send that has not happened yet, and would show the run as complete.
    if (result.awaitingYourSend) {
      appendEvent(run.runId, 'mail.composed', `${operation}/${family} → ${dl.to} (awaiting your Send)`);
      // Recorded on the run, not just returned. A composed message is a real thing sitting open
      // in Outlook; if that fact lives only in the page's memory it is lost the moment the
      // operator navigates away, and the card goes back to reading "nothing has happened here"
      // while a loaded email waits for a Send nobody is being reminded to press.
      //
      // This is emphatically not a send — `run.sends` stays untouched, so the duplicate guard is
      // not armed against the real send that has not happened yet.
      const composed = updateRun(run.runId, (r) => {
        r.pendingCompose = {
          key,
          operation,
          family,
          filename: artifact.filename,
          to: dl.to,
          subject: dl.subject,
          // Snapshot at compose time — confirmSend uses this so a regeneration between
          // compose and confirm does not corrupt the send record with the new file's ids.
          deviceIds: artifact.deviceIds ?? [],
          rowCount: artifact.rowCount,
          composedAt: new Date().toISOString(),
        };
        return r;
      });
      res.json({
        composedOnly: true,
        transport: result.transport,
        to: dl.to,
        subject: dl.subject,
        filename: artifact.filename,
        checks: result.checks,
        message: result.message,
        run: composed,
      });
      return;
    }

    const updated = updateRun(run.runId, (r) => {
      r.sends[key] = {
        ok: true,
        operation,
        family,
        transport: result.transport,
        to: dl.to,
        subject: dl.subject,
        dlSource: `${dl.source}["${dl.key}"]`,
        filename: artifact.filename,
        rowCount: artifact.rowCount,
        // What this send actually carried. The duplicate guard compares against it, so a later
        // file covering different devices is recognised as a new send rather than a repeat.
        deviceIds: artifact.deviceIds ?? [],
        messageId: result.messageId ?? null,
        smtpResponse: result.response ?? null,
        sentItems: result.sentItems ?? null,
        sentAt: new Date().toISOString(),
      };
      if (r.pendingCompose?.key === key) delete r.pendingCompose;
      r.status = 'sent';
      return r;
    });
    appendEvent(run.runId, 'mail.sent', `${operation}/${family} → ${dl.to} (${artifact.filename})`);

    res.json({
      send: updated.sends[key],
      run: summariseRun(updated),
      // An unconfirmed Sent Items lookup is surfaced rather than swallowed: the message may
      // have gone out, so a blind retry risks a double load.
      sentItemsWarning:
        result.sentItems?.confirmed === true
          ? null
          : result.sentItems?.reason ?? 'Sent Items could not be confirmed.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Record a send you completed by hand in the compose window.
 *
 * It is not taken on trust: Sent Items is checked first, and the send is only recorded if the
 * message is actually there. Otherwise the run would claim a load that never happened, and the
 * polling screen would sit waiting for assets that are never coming.
 */
runsRouter.post('/:runId/send/confirm', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { operation, family, force = false } = req.body ?? {};

    const dl = resolveDistributionList(run.env, family, operation);
    if (!dl) throw new Error(`"${operation}" does not send mail.`);

    const key = artifactKey(operation, family);
    // Use the snapshot captured at compose time when available — the artifact on disk may
    // have been regenerated between compose and confirm, so loadArtifact would return the
    // wrong deviceIds and corrupt the duplicate-send guard for the actual sent file.
    const composed = run.pendingCompose?.key === key ? run.pendingCompose : null;
    const artifact = composed ?? loadArtifact(run.runId, key);

    const sentItems = await checkSentItems({ subject: dl.subject });

    if (sentItems.confirmed !== true && !force) {
      res.json({
        recorded: false,
        sentItems,
        message:
          sentItems.confirmed === false
            ? `"${dl.subject}" is not in Sent Items, so this has not been recorded as sent. ` +
              'Press Send in the compose window first, or force it if you know it went.'
            : `Sent Items could not be checked (${sentItems.reason}). Nothing recorded — force it ` +
              'only if you have confirmed the message in Outlook yourself.',
      });
      return;
    }

    const updated = updateRun(run.runId, (r) => {
      r.sends[key] = {
        ok: true,
        operation,
        family,
        transport: 'outlook-web',
        to: dl.to,
        subject: dl.subject,
        dlSource: `${dl.source}["${dl.key}"]`,
        filename: artifact.filename,
        rowCount: artifact.rowCount,
        // Same as the automatic path: without this the guard cannot tell a later, different
        // file from a repeat of this one.
        deviceIds: artifact.deviceIds ?? [],
        sentItems,
        sentByHand: true,
        forced: sentItems.confirmed !== true,
        sentAt: new Date().toISOString(),
      };
      if (r.pendingCompose?.key === key) delete r.pendingCompose;
      r.status = 'sent';
      return r;
    });
    appendEvent(run.runId, 'mail.sent', `${operation}/${family} → ${dl.to} (sent by hand)`);

    res.json({ recorded: true, send: updated.sends[key], run: summariseRun(updated) });
  } catch (err) {
    next(err);
  }
});

/** Discard a compose window left open from a compose-and-stop that was abandoned. */
runsRouter.post('/:runId/mail/close', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const closed = await closeOutlook();
    // The window is gone, so the message it held is not going to be sent. Leaving the marker
    // behind would keep the card saying "awaiting your Send" for a compose that no longer exists.
    const updated = updateRun(run.runId, (r) => {
      delete r.pendingCompose;
      return r;
    });
    res.json({ ...closed, run: updated });
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/eml', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { operation, family } = req.query;
    const dl = resolveDistributionList(run.env, family, operation);
    if (!dl) throw new Error(`"${operation}" does not send mail.`);

    const artifact = loadArtifact(run.runId, artifactKey(operation, family));
    const eml = buildEml({
      from: describeSmtp(run.env).from,
      to: dl.to,
      subject: dl.subject,
      body: dl.body,
      attachment: { filename: artifact.filename, content: artifact.buffer },
    });

    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${operation}-${family}-${artifact.filename.replace(/\.csv$/, '')}.eml"`
    );
    res.send(eml);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

runsRouter.post('/:runId/poll/:stage/start', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    res.json(
      startPolling(run.runId, req.params.stage, {
        deviceIds: stageDeviceIds(run, req.params.stage),
        ...(req.body ?? {}),
      })
    );
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/poll/:stage/stop', (req, res, next) => {
  try {
    res.json(stopPolling(req.params.runId, req.params.stage));
  } catch (err) {
    next(err);
  }
});

runsRouter.post('/:runId/poll/:stage/once', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    // `finalise` is sent only by the explicit "Refresh from org" button. Watch's background top-up
    // on tab activation omits it, so browsing tabs cannot rewrite the run's headline answer.
    res.json(
      await pollOnce(run.runId, req.params.stage, stageDeviceIds(run, req.params.stage), {
        finalise: req.body?.finalise === true,
      }),
    );
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/poll/:stage', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    let snapshot = scopeSnapshot(run, req.params.stage, run.polling?.[req.params.stage] ?? null);

    // For Octo runs, fetch and add accessory status to snapshot rows.
    // `.some`, not `.every`: `.every` read a mixed run (Octo plus another family) as non-Octo and
    // silently skipped this whole block, so no row ever got `.accessories` and the Task 6 holdback
    // was defeated for every device in that run, Octo included. The enrichment below already
    // narrows to devices with a recorded accessory (`if (!run.accessories[row.deviceId]) return
    // row;`), so `.some` here is safe — a mixed run's non-Octo devices pass through untouched.
    const isOctoRun = run.groups.some((g) => g.family === 'octo');
    if (isOctoRun && run.accessories && snapshot?.rows?.length) {
      try {
        const accessorySerials = [];
        for (const acc of Object.values(run.accessories)) {
          if (acc.wiredSpeaker) accessorySerials.push(acc.wiredSpeaker);
          if (acc.nativeCam) accessorySerials.push(acc.nativeCam);
        }

        if (accessorySerials.length) {
          const accessories = await fetchAssetsByDeviceId(run.env, accessorySerials);
          const byAccessoryId = new Map(accessories.map((a) => [a.deviceId, a]));

          // Add accessories to each row
          snapshot = {
            ...snapshot,
            rows: snapshot.rows.map((row) => {
              if (!run.accessories[row.deviceId]) return row;

              const deviceAccessories = [];
              const acc = run.accessories[row.deviceId];
              if (acc.wiredSpeaker) {
                const accAsset = byAccessoryId.get(String(acc.wiredSpeaker)) ?? null;
                deviceAccessories.push({
                  type: 'Wired Speaker',
                  serialId: acc.wiredSpeaker,
                  present: Boolean(accAsset),
                  // An accessory is an Asset in its own right, so its serial links to its own
                  // record. Null until the Asset exists — `present: false` and no id are the
                  // same fact seen from two sides.
                  assetId: accAsset?.id ?? null,
                  stage: classifyStage(accAsset?.idmsStatus ?? null),
                  syncStatus: accAsset?.syncStatus ?? null,
                  assetStatus: accAsset?.assetStatus ?? null,
                });
              }
              if (acc.nativeCam) {
                const accAsset = byAccessoryId.get(String(acc.nativeCam)) ?? null;
                deviceAccessories.push({
                  type: 'Native Camera',
                  serialId: acc.nativeCam,
                  present: Boolean(accAsset),
                  // An accessory is an Asset in its own right, so its serial links to its own
                  // record. Null until the Asset exists — `present: false` and no id are the
                  // same fact seen from two sides.
                  assetId: accAsset?.id ?? null,
                  stage: classifyStage(accAsset?.idmsStatus ?? null),
                  syncStatus: accAsset?.syncStatus ?? null,
                  assetStatus: accAsset?.assetStatus ?? null,
                });
              }

              return {
                ...row,
                accessories: deviceAccessories.length > 0 ? deviceAccessories : undefined,
              };
            }),
          };

          // The atStage split ran before this enrichment, so `snapshot.atStage.rows` still holds the
          // pre-enrichment row objects — and that is the array the Watch page actually reads, since
          // it spreads `{ ...fullSnapshot, ...fullSnapshot.atStage }` and `rows` is overwritten.
          // Without this, every accessory disappears the moment any device is ahead of or behind the
          // stage, and the completeness gate silently passes everything.
          if (snapshot.atStage?.rows?.length) {
            const enrichedById = new Map(snapshot.rows.map((r) => [String(r.deviceId), r]));
            snapshot = {
              ...snapshot,
              atStage: {
                ...snapshot.atStage,
                rows: snapshot.atStage.rows.map((r) => enrichedById.get(String(r.deviceId)) ?? r),
              },
            };
          }
        }
      } catch (err) {
        // If accessory fetch fails, still return the snapshot without accessories
      }
    }

    res.json({
      stage: req.params.stage,
      running: isPolling(run.runId, req.params.stage),
      snapshot,
      result: run.result ?? null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Trim a stored snapshot to the devices the stage actually covers.
 *
 * A snapshot is written once and read many times, so one taken before the device set was known
 * keeps reporting the whole run every time the page loads — the panel stays wrong until someone
 * happens to poll again. Filtering on read means any stale snapshot corrects itself the moment it
 * is displayed, for every stage, without waiting for a refresh.
 *
 * Only ever removes rows. A device missing from a snapshot cannot be invented here; it appears on
 * the next poll.
 */
function scopeSnapshot(run, stage, snapshot) {
  if (!snapshot?.rows?.length) return snapshot;

  // Order matters: narrow to the devices this stage covers, re-derive each row's position
  // relative to the stage (so a snapshot written before that existed is judged the same way),
  // then split off the ones that have moved on.
  const scope = new Set(stageDeviceIds(run, stage).map(String));
  // If this stage has no device IDs (email not yet sent, no artifact), suppress the snapshot
  // entirely so stale data from a previous poll does not persist on screen.
  if (!scope.size) return null;
  const rows = snapshot.rows.filter((row) => scope.has(String(row.deviceId)));
  const scoped = rows.length === snapshot.rows.length ? snapshot : { ...snapshot, ...tallyRows(rows) };
  return splitByStagePosition(rescoreSnapshot(stage, scoped));
}

// ---------------------------------------------------------------------------
// Life cycle
// ---------------------------------------------------------------------------

/**
 * Where this run's devices are on the DLCM chart, and what moves them next.
 *
 * The stage is read live from the org rather than inferred from what this app has sent, because
 * most of the chart is driven by other systems — the Installer App, the customer, the order
 * integration. What we sent is a poor proxy for where the device is.
 *
 * A read failure is not an error here: the answer degrades to "stage unknown, and here is what
 * this app has sent so far", which is still the useful half.
 */
runsRouter.get('/:runId/lifecycle', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const deviceIds = runDeviceIds(run);
    const operations = loadOperations();

    let assets = null;
    let accessories = null;
    let readError = null;
    try {
      if (deviceIds.length) assets = await fetchAssetsByDeviceId(run.env, deviceIds);

      // For Octo runs, also fetch accessory status
      const isOctoRun = run.groups.some((g) => g.family === 'octo');
      if (isOctoRun && run.accessories) {
        const accessorySerials = [];
        for (const acc of Object.values(run.accessories)) {
          if (acc.wiredSpeaker) accessorySerials.push(acc.wiredSpeaker);
          if (acc.nativeCam) accessorySerials.push(acc.nativeCam);
        }
        if (accessorySerials.length) {
          accessories = await fetchAssetsByDeviceId(run.env, accessorySerials);
        }
      }
    } catch (err) {
      readError = err.message;
    }

    const byDeviceId = new Map((assets ?? []).map((a) => [a.deviceId, a]));
    const byAccessoryId = new Map((accessories ?? []).map((a) => [a.deviceId, a]));
    const raw = [];
    const devices = deviceIds.map((deviceId) => {
      const asset = byDeviceId.get(String(deviceId)) ?? null;
      raw.push(asset?.idmsStatus ?? null);

      const deviceAccessories = [];
      if (run.accessories && run.accessories[deviceId]) {
        const acc = run.accessories[deviceId];
        if (acc.wiredSpeaker) {
          const accAsset = byAccessoryId.get(String(acc.wiredSpeaker)) ?? null;
          deviceAccessories.push({
            type: 'Wired Speaker',
            serialId: acc.wiredSpeaker,
            present: Boolean(accAsset),
            stage: classifyStage(accAsset?.idmsStatus ?? null),
            syncStatus: accAsset?.syncStatus ?? null,
            assetStatus: accAsset?.assetStatus ?? null,
          });
        }
        if (acc.nativeCam) {
          const accAsset = byAccessoryId.get(String(acc.nativeCam)) ?? null;
          deviceAccessories.push({
            type: 'Native Camera',
            serialId: acc.nativeCam,
            present: Boolean(accAsset),
            stage: classifyStage(accAsset?.idmsStatus ?? null),
            syncStatus: accAsset?.syncStatus ?? null,
            assetStatus: accAsset?.assetStatus ?? null,
          });
        }
      }

      return {
        deviceId,
        present: Boolean(asset),
        stage: classifyStage(asset?.idmsStatus ?? null),
        syncStatus: asset?.syncStatus ?? null,
        assetStatus: asset?.assetStatus ?? null,
        cpqOrderNumber: asset?.cpqOrderNumber ?? null,
        lastModifiedDate: asset?.lastModifiedDate ?? null,
        accessories: deviceAccessories.length > 0 ? deviceAccessories : undefined,
      };
    });

    const stages = summariseStages(raw);
    const allTemplates = loadTemplates();

    // The next step is only a single answer while every device shares a stage. A split run gets
    // the stages listed instead of a suggestion, because acting on the majority would leave the
    // rest behind silently.
    const position = stages.unanimous;
    let next = position?.known ? nextFrom(position.code) : { mine: [], theirs: [] };

    // For Octo family, enforce mandatory dataUpdate before shipmentUpdate
    const isOctoRun = run.groups.some((g) => g.family === 'octo');
    const dataUpdateSent = Object.entries(run.sends ?? {}).some(
      ([, s]) => s?.ok && s.operation === 'dataUpdate'
    );
    if (isOctoRun && !dataUpdateSent && position?.code === -2) {
      // Filter to only show dataUpdate, hide shipmentUpdate for Octo until dataUpdate is sent
      next = {
        mine: next.mine.filter((step) => step.operation === 'dataUpdate'),
        theirs: next.theirs,
      };
    }

    res.json({
      runId: run.runId,
      env: run.env,
      read: assets ? 'live' : 'unavailable',
      readError,
      deviceCount: deviceIds.length,
      devices,
      stages,
      position: position
        ? { code: position.code, label: position.label, known: position.known, count: position.count }
        : null,
      next: {
        ...next,
        // What of `mine` this app can actually send today: an operation still needs a template
        // and a configured mailbox, and four of them have a mailbox but no sheet yet.
        mine: next.mine.map((step) => {
          const rows = isSharedOperation(step.operation)
            ? [buildRow(SHARED_FAMILY, 'Any family', step.operation, allTemplates, run)]
            : run.groups.map((g) => buildRow(g.family, g.familyLabel, step.operation, allTemplates, run));
          return {
            ...step,
            operationLabel: operations[step.operation]?.label ?? step.operation,
            families: rows,
            sendable: rows.some((r) => r.supported && r.usable && r.blockers.length === 0),
            alreadySent: rows.length > 0 && rows.every((r) => r.sent),
            pollable: Boolean(syncStatusBase(step.operation)),
          };
        }),
      },
      sent: Object.entries(run.sends ?? {})
        .filter(([, s]) => s?.ok)
        .map(([key, s]) => ({ key, operation: s.operation, family: s.family, sentAt: s.sentAt })),
    });
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/assets', async (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const [byId, byTracking] = await Promise.all([
      fetchAssetsByDeviceId(run.env, runDeviceIds(run)),
      fetchAssetsByTrackingId(run.env, run.trackingId),
    ]);
    res.json({
      thisRun: byId,
      allForTrackingId: byTracking,
      counts: {
        thisRun: byId.length,
        allForTrackingId: byTracking.length,
        attachedToOrder: byTracking.filter((a) => a.cpqOrderId).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** The headline answer: the ids this run loaded. */
runsRouter.get('/:runId/result', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const allocated = runDeviceIds(run);

    const payload = {
      runId: run.runId,
      env: run.env,
      operation: run.operation,
      trackingId: run.trackingId,
      orderNumber: run.order?.orderNumber ?? null,
      status: run.status,
      groups: run.groups.map((g) => ({
        family: g.family,
        familyLabel: g.familyLabel,
        templateId: g.templateId,
        lines: g.lines.map((l) => ({
          sku: l.sku,
          orderQuantity: l.quantity,
          unitsLoaded: l.deviceCount,
          ids: (l.generatedRows ?? []).map((r) => r[g.primarySeries] ?? Object.values(r)[0]),
        })),
      })),
      loadedDeviceIds: run.result?.loadedDeviceIds ?? [],
      failedDeviceIds: run.result?.failedDeviceIds ?? [],
      allocatedDeviceIds: allocated,
      sends: run.sends,
      files: run.artifacts,
    };

    if (req.query.format === 'text') {
      const ids = payload.loadedDeviceIds.length ? payload.loadedDeviceIds : allocated;
      res.setHeader('Content-Type', 'text/plain');
      res.send(ids.join('\n') + '\n');
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

function buildRow(family, familyLabel, operation, allTemplates, run) {
  const template =
    allTemplates.find((t) => t.family === family && t.operation === operation) ??
    (family === SHARED_FAMILY
      ? null
      : allTemplates.find((t) => t.family === SHARED_FAMILY && t.operation === operation));

  const key = artifactKey(operation, family);
  let dl = null;
  let blockers = [];
  if (template) {
    try {
      dl = resolveDistributionList(run.env, family, operation);
      blockers = sendBlockers(run.env, family, operation);
    } catch (err) {
      blockers = [err.message];
    }
  }

  return {
    family,
    familyLabel,
    supported: Boolean(template),
    templateId: template?.id ?? null,
    usable: template?.status === 'verified',
    generated: Boolean(run.artifacts?.[key]),
    sent: Boolean(run.sends?.[key]?.ok),
    to: dl?.to ?? null,
    blockers,
  };
}

/** Which operations this run's families can still do, and what is generated so far. */
runsRouter.get('/:runId/operations', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const operations = loadOperations();
    const all = loadTemplates();

    res.json({
      // Same order Watch's stage tabs use — see `operationOrder`. Review's selector is a sequence,
      // not a flat list, so a stage step has to sit before the operation it precedes.
      operations: operationOrder(Object.keys(operations)).map((id) => {
        const meta = operations[id];
        const shared = isSharedOperation(id);

        // A shared operation is reported as a single row, since it produces one file for the
        // whole run rather than one per family.
        const rows = shared
          ? [buildRow(SHARED_FAMILY, 'Any family', id, all, run)]
          : run.groups.map((group) => buildRow(group.family, group.familyLabel, id, all, run));

        const movement = operationMovement(id);
        const role = operationRole(id);

        return {
          id,
          label: meta.label,
          needsMail: meta.needsMail,
          shared,
          families: rows,
          anySupported: rows.some((f) => f.supported),
          // Where this operation sits on the DLCM chart, so the picker shows a sequence rather
          // than a flat list of ten unrelated sends.
          movement: movement
            ? {
                from: movement.from,
                to: movement.to,
                fromLabels: movement.from.map((f) =>
                  f === null ? 'no Asset yet' : stageByCode(f)?.label ?? `stage ${f}`
                ),
                toLabels: movement.to.map((t) => stageByCode(t)?.label ?? `stage ${t}`),
                uncertain: movement.uncertain,
              }
            : null,
          stagePreserving: Boolean(role?.stagePreserving),
          stageNote: role?.note ?? null,
          pollable: Boolean(syncStatusBase(id)),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});
