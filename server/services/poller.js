/**
 * Asset sync-status polling.
 *
 * Polling runs server-side and writes each snapshot into the run record, so the UI is free
 * to disconnect, refresh, or be closed entirely without losing the outcome.
 *
 * Timing differs deliberately from the old automation, which polled every 20s for a flat
 * 30 minutes and only then reported a soft failure. Around a third of initial loads fail in
 * this org, so that design spent half an hour on a third of runs before saying anything.
 * Here a *_SYNC_FAILED is terminal the moment it appears, and the poll stops as soon as
 * every device has settled either way.
 */

import { fetchAssetsByDeviceId, summarisePolling } from './sf-client.js';
import { pollingOrder } from '../lib/lifecycle.js';
import { updateRun, getRun, appendEvent } from './run-store.js';

const DEFAULTS = {
  intervalMs: 20_000,
  timeoutMs: 30 * 60 * 1000,
  // The first few polls are fast: IDMS often responds in well under a minute and there is
  // no reason to sit on a 20s tick to notice.
  fastPolls: 6,
  fastIntervalMs: 5_000,
};

/** runId:stage -> controller */
const active = new Map();

function key(runId, stage) {
  return `${runId}:${stage}`;
}

export function isPolling(runId, stage) {
  return active.has(key(runId, stage));
}

export function activePolls() {
  return [...active.values()].map((c) => ({
    runId: c.runId,
    stage: c.stage,
    startedAt: c.startedAt,
    pollCount: c.pollCount,
  }));
}

export function stopPolling(runId, stage) {
  const controller = active.get(key(runId, stage));
  if (!controller) return { stopped: false };
  controller.cancelled = true;
  clearTimeout(controller.timer);
  active.delete(key(runId, stage));
  writeSnapshot(runId, stage, { state: 'stopped', stoppedAt: new Date().toISOString() });
  return { stopped: true };
}

function writeSnapshot(runId, stage, patch) {
  return updateRun(runId, (run) => {
    run.polling[stage] = { ...(run.polling[stage] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    return run;
  });
}

/**
 * Take one reading. Safe to call directly for a manual refresh.
 */
export async function pollOnce(runId, stage, deviceIds = null) {
  const run = getRun(runId);
  const ids = deviceIds ?? run.polling?.[stage]?.deviceIds ?? [];
  if (!ids.length) {
    throw new Error(
      `Nothing to poll for "${stage}" — this run has no allocated ids yet, or none were recorded ` +
        'when polling started.'
    );
  }
  const assets = await fetchAssetsByDeviceId(run.env, ids);
  const summary = summarisePolling(stage, ids, assets);

  writeSnapshot(runId, stage, {
    stage,
    state: summary.settled ? 'settled' : 'waiting',
    counts: summary.counts,
    rows: summary.rows,
    settled: summary.settled,
    anyFailed: summary.anyFailed,
    loadedDeviceIds: summary.loadedDeviceIds,
    failedDeviceIds: summary.failedDeviceIds,
    lastPolledAt: new Date().toISOString(),
  });

  return summary;
}

/**
 * Begin polling until every device settles or the timeout expires.
 * Returns immediately; progress is read from the run record.
 */
export function startPolling(runId, stage, options = {}) {
  const existing = active.get(key(runId, stage));
  if (existing) return { started: false, alreadyRunning: true };

  const cfg = { ...DEFAULTS, ...options };
  const deviceIds = options.deviceIds ?? [];
  if (!deviceIds.length) {
    throw new Error(`Cannot poll "${stage}" — no device ids were supplied. Allocate ids first.`);
  }

  const controller = {
    runId,
    stage,
    startedAt: new Date().toISOString(),
    deadline: Date.now() + cfg.timeoutMs,
    pollCount: 0,
    cancelled: false,
    timer: null,
  };
  active.set(key(runId, stage), controller);

  writeSnapshot(runId, stage, {
    stage,
    state: 'waiting',
    startedAt: controller.startedAt,
    deviceIds,
    counts: { total: deviceIds.length, succeeded: 0, failed: 0, waiting: deviceIds.length, absent: deviceIds.length },
  });
  appendEvent(runId, 'poll.started', `${stage} — ${deviceIds.length} device(s)`);

  const tick = async () => {
    if (controller.cancelled) return;
    controller.pollCount++;

    let summary = null;
    try {
      summary = await pollOnce(runId, stage, deviceIds);
    } catch (err) {
      writeSnapshot(runId, stage, { lastError: err.message });
      // A session expiry should stop the loop rather than hammer a dead session.
      if (err.status === 401) {
        active.delete(key(runId, stage));
        writeSnapshot(runId, stage, { state: 'interrupted', reason: err.message });
        appendEvent(runId, 'poll.interrupted', err.message);
        return;
      }
    }

    if (controller.cancelled) return;

    if (summary?.settled) {
      active.delete(key(runId, stage));
      writeSnapshot(runId, stage, { state: 'settled', settledAt: new Date().toISOString() });
      appendEvent(
        runId,
        'poll.settled',
        `${stage} — ${summary.counts.succeeded} ok, ${summary.counts.failed} failed`
      );
      finaliseResult(runId, stage, summary);
      return;
    }

    if (Date.now() > controller.deadline) {
      active.delete(key(runId, stage));
      writeSnapshot(runId, stage, {
        state: 'timed-out',
        reason: `Still waiting on ${summary?.counts.waiting ?? '?'} device(s) after ${Math.round(cfg.timeoutMs / 60000)} minutes.`,
      });
      appendEvent(runId, 'poll.timeout', stage);
      return;
    }

    const interval = controller.pollCount <= cfg.fastPolls ? cfg.fastIntervalMs : cfg.intervalMs;
    controller.timer = setTimeout(tick, interval);
    controller.timer.unref?.();
  };

  // First reading immediately — a *_SYNC_FAILED that is already visible should surface now.
  controller.timer = setTimeout(tick, 500);
  controller.timer.unref?.();

  return { started: true, stage, deviceCount: deviceIds.length };
}

/**
 * Does a settled poll of `polledStage` supersede the result already recorded for `recordedStage`?
 *
 * The precedence this protects is real: shipment update means "these devices are live and
 * shippable" and outranks initial load's "they exist", so re-reading an earlier stage must not
 * undo it. It was written as `stage === 'shipmentUpdate' || !run.result?.stage`, which says
 * something subtly different — *nothing has been recorded yet* — and that made it a **one-shot
 * latch**. Poll initial load, have a third of the batch fail, fix them, poll again: the second
 * reading was thrown away, `failedDeviceIds` kept the first attempt's ids for ever, and the run
 * went on reporting "Part failed" over devices that had all since succeeded.
 *
 * Rank comes from `pollingOrder()` — the same order `positionInChain` uses — so a corrected
 * transition in `config/lifecycle.json` moves this precedence with it rather than leaving a second
 * opinion hardcoded here.
 *
 * Equal rank is authoritative, and that is the whole fix: a stage's newest reading of itself is
 * the truth about it. An off-chain stage (`rmaReturned`) is absent from the chain and so never
 * overwrites a chain result, but may still refresh its own.
 */
export function supersedesRecordedResult(polledStage, recordedStage) {
  if (!recordedStage) return true;
  if (polledStage === recordedStage) return true;

  const order = pollingOrder();
  const polledRank = order.indexOf(polledStage);
  const recordedRank = order.indexOf(recordedStage);

  // Off the chain: it is not the run's headline answer, so it does not displace one.
  if (polledRank === -1) return false;
  // The recorded result is off-chain but this one is on it — the load chain is the headline.
  if (recordedRank === -1) return true;
  return polledRank >= recordedRank;
}

/**
 * Run statuses a later authoritative poll may overwrite.
 *
 * `initial-load-partial` and `initial-load-done` are here because they were themselves written by
 * a poll of an earlier stage, so a newer poll of that stage is better information. Their absence
 * was the second latch behind the same symptom: the old guard only revised a status that still
 * read `draft` or `sent`, so the first `initial-load-partial` was permanent.
 *
 * `completed` and `completed-with-failures` are deliberately absent. Those come from shipment
 * update, which outranks the earlier stages, and re-reading initial load must not downgrade a run
 * that has since shipped.
 */
export const REVISABLE_STATUSES = new Set([
  'draft',
  'sent',
  'initial-load-partial',
  'initial-load-done',
]);

/** The status a settled stage implies. Deliberately unchanged — only the latch above was wrong. */
function statusForSettledStage(stage, anyFailed) {
  if (stage === 'shipmentUpdate') return anyFailed ? 'completed-with-failures' : 'completed';
  return anyFailed ? 'initial-load-partial' : 'initial-load-done';
}

/**
 * The run's headline answer: which device ids are loaded.
 */
function finaliseResult(runId, stage, summary) {
  updateRun(runId, (run) => {
    if (supersedesRecordedResult(stage, run.result?.stage)) {
      run.result = {
        stage,
        loadedDeviceIds: summary.loadedDeviceIds,
        failedDeviceIds: summary.failedDeviceIds,
        counts: summary.counts,
        finalisedAt: new Date().toISOString(),
      };
    }
    if (stage === 'shipmentUpdate') {
      run.status = statusForSettledStage(stage, summary.anyFailed);
    } else if (REVISABLE_STATUSES.has(run.status)) {
      run.status = statusForSettledStage(stage, summary.anyFailed);
    }
    return run;
  });
}
