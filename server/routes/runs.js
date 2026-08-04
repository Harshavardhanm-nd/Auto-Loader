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
import { allocateSeries, describeCursors, resetCursor, primarySeriesOf } from '../services/id-generator.js';
import { buildCsv, planGeneratedRows, planWizardRows, planExistingRows } from '../services/csv-builder.js';
import {
  findTakenDeviceIds,
  fetchOrder,
  fetchAssetsByDeviceId,
  fetchAssetsByTrackingId,
} from '../services/sf-client.js';
import { readSession } from '../services/sf-session.js';
import { sendMail, buildEml, describeSmtp } from '../services/mailer.js';
import { startPolling, stopPolling, pollOnce, isPolling } from '../services/poller.js';
import {
  validateArtifact,
  validateIdsFree,
  validateWizardRowCount,
  validateSerialsShipped,
  validateSendTarget,
  summariseChecks,
  artifactPreview,
} from '../services/validator.js';
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

function groupTemplate(group, operation) {
  return findTemplate(group.family, operation);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

runsRouter.get('/', (req, res) => {
  res.json({ runs: listRuns({ limit: Number(req.query.limit) || 50 }) });
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

runsRouter.post('/:runId/cursors/reset', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const { family } = req.body ?? {};
    for (const group of run.groups) {
      if (family && group.family !== family) continue;
      const template = getTemplate(group.templateId);
      for (const [name, def] of Object.entries(template.series ?? {})) {
        resetCursor(run.env, group.templateId, name, def);
      }
    }
    res.json({ reset: true });
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

/** The primary ids this run minted, which is what polling watches. */
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

runsRouter.post('/:runId/generate', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    const operation = req.body?.operation ?? run.operation;
    if (!loadOperations()[operation]) throw new Error(`Unknown operation "${operation}".`);

    const built = [];
    const blocked = [];

    // A family-independent operation produces ONE file for the whole run, not one per family.
    // The received sheet is identical across families and lists every device id in the run.
    if (isSharedOperation(operation)) {
      const template = findTemplate(SHARED_FAMILY, operation);
      const ids = runDeviceIds(run);
      if (!ids.length) throw new Error('Allocate ids before generating this operation.');

      const artifact = buildCsv(template, {
        trackingId: run.trackingId,
        fields: run.sharedFields ?? {},
        rows: planExistingRows(ids),
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

      const rows = template.reusesExistingDevices
        ? planExistingRows(runDeviceIds(run))
        : planGeneratedRows(group.lines);

      const artifact = buildCsv(template, {
        trackingId: run.trackingId,
        fields: group.fields,
        rows,
      });
      built.push(saveArtifact(run.runId, artifactKey(operation, group.family), artifact));
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
    const alreadySent = Object.values(run.sends ?? {}).some((s) => s?.ok);
    groups.org = [validateIdsFree({ takenIds: taken, checked, alreadySent })];

    for (const group of run.groups) {
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

    const previous = run.sends?.[key];
    if (previous?.ok && !force) {
      throw new Error(
        `${artifact.filename} was already sent to ${previous.to} at ${previous.sentAt}. ` +
          'Re-sending the same file to the same mailbox is a double load. Pass force to override.'
      );
    }

    const result = await sendMail(run.env, {
      to: dl.to,
      subject: dl.subject,
      body: dl.body,
      attachment: { filename: artifact.filename, content: artifact.buffer },
    });

    const updated = updateRun(run.runId, (r) => {
      r.sends[key] = {
        ok: true,
        operation,
        family,
        to: dl.to,
        subject: dl.subject,
        dlSource: `${dl.source}["${dl.key}"]`,
        filename: artifact.filename,
        rowCount: artifact.rowCount,
        messageId: result.messageId,
        smtpResponse: result.response,
        sentItems: result.sentItems,
        sentAt: new Date().toISOString(),
      };
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
    res.json(startPolling(run.runId, req.params.stage, { deviceIds: runDeviceIds(run), ...(req.body ?? {}) }));
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
    res.json(await pollOnce(run.runId, req.params.stage, runDeviceIds(run)));
  } catch (err) {
    next(err);
  }
});

runsRouter.get('/:runId/poll/:stage', (req, res, next) => {
  try {
    const run = getRun(req.params.runId);
    res.json({
      stage: req.params.stage,
      running: isPolling(run.runId, req.params.stage),
      snapshot: run.polling?.[req.params.stage] ?? null,
      result: run.result ?? null,
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
      operations: Object.entries(operations).map(([id, meta]) => {
        const shared = isSharedOperation(id);

        // A shared operation is reported as a single row, since it produces one file for the
        // whole run rather than one per family.
        const rows = shared
          ? [buildRow(SHARED_FAMILY, 'Any family', id, all, run)]
          : run.groups.map((group) => buildRow(group.family, group.familyLabel, id, all, run));

        return {
          id,
          label: meta.label,
          needsMail: meta.needsMail,
          shared,
          families: rows,
          anySupported: rows.some((f) => f.supported),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});
