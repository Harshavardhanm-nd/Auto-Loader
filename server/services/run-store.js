/**
 * Run persistence.
 *
 * A "run" is one trip through the flow: an order, the lines picked, the ids generated, the
 * CSVs built, the two emails, and the polling outcome. It is written to disk at every step
 * so a browser refresh, a server restart, or a session expiry mid-poll does not lose the
 * device ids that were already sent — those exist in the org now whether or not this app
 * remembers them.
 *
 * The generated CSV bytes are stored alongside so the exact file that was emailed can be
 * re-downloaded or re-sent without regenerating (which would allocate new ids).
 */

import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR, OUTPUT_DIR, readJson, writeJson } from '../lib/paths.js';
import { getTemplate } from '../lib/config.js';

function runFile(runId) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

function runOutputDir(runId) {
  return path.join(OUTPUT_DIR, runId);
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const suffix = Math.floor(Math.random() * 1e4).toString().padStart(4, '0');
  return `run-${stamp}-${suffix}`;
}

export function createRun({ env, operation, trackingId, order, groups, notes = null }) {
  const runId = newRunId();
  const run = {
    runId,
    env,
    operation,
    trackingId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    notes,
    // Optional: an initial load is a manufacturer batch and need not relate to any order.
    order,
    groups,
    idGeneration: null,
    artifacts: {},
    sends: {},
    polling: {},
    result: null,
    events: [
      {
        at: new Date().toISOString(),
        event: 'run.created',
        detail: `${operation} · tracking ${trackingId}${order ? ` · order ${order.orderNumber}` : ''}`,
      },
    ],
  };
  writeJson(runFile(runId), run);
  return run;
}

export function getRun(runId) {
  const run = readJson(runFile(runId), null);
  if (!run) throw new Error(`Unknown run "${runId}"`);
  return backfillArtifactDeviceIds(runId, run);
}

/**
 * Which column of a template holds the device id — the generated primary series, or the
 * existing id for templates that act on devices an earlier run loaded.
 */
function idColumnIndex(template) {
  const generated = template.columns.findIndex((c) => c.source?.startsWith('generated.'));
  if (generated !== -1) return generated;
  return template.columns.findIndex((c) => c.source === 'existing.device_id');
}

/**
 * Recover `deviceIds` for files generated before artifacts recorded them.
 *
 * Until that field existed, nothing stored which devices a given file covered, so anything
 * needing the answer fell back to the run's full list — which is wrong for any operation raised
 * over a subset, and is what made a one-device shipment update get watched as the whole run.
 *
 * The bytes on disk are the record, so the ids are read back out of them rather than guessed.
 * Safe to parse naively: `escapeField` refuses commas, quotes and newlines outright, so no field
 * in any accepted sheet can contain a delimiter.
 *
 * Repairs are written back once, so this costs nothing on later reads.
 */
function backfillArtifactDeviceIds(runId, run) {
  const artifacts = run.artifacts ?? {};
  let repaired = false;

  for (const artifact of Object.values(artifacts)) {
    if (artifact.deviceIds || !artifact.path) continue;
    try {
      const column = idColumnIndex(getTemplate(artifact.template));
      if (column === -1) continue;
      const text = fs.readFileSync(artifact.path, 'utf8').replace(/^﻿/, '');
      artifact.deviceIds = text
        .split(/\r\n|\n/)
        .slice(1)
        .filter(Boolean)
        .map((line) => line.split(',')[column]?.trim())
        .filter(Boolean);
      repaired = true;
    } catch {
      // The file may have been cleaned up. Leaving deviceIds unset keeps the old whole-run
      // fallback, which is no worse than before.
    }
  }

  if (repaired) {
    run.updatedAt = new Date().toISOString();
    writeJson(runFile(runId), run);
  }
  return run;
}

export function updateRun(runId, mutate) {
  const run = getRun(runId);
  const next = mutate(run) ?? run;
  next.updatedAt = new Date().toISOString();
  writeJson(runFile(runId), next);
  return next;
}

/**
 * How long a send claim is honoured before it is treated as abandoned.
 *
 * Only reached if the process died mid-send, since the handler releases in a `finally`. Long
 * enough to cover a slow Outlook compose plus its Sent Items confirmation (the compose panel
 * alone has been measured at 32s), short enough that a crash does not wedge a pipeline for the
 * rest of the day.
 */
/**
 * Move the current send record for a pipeline into its history, so an overwrite never destroys it.
 *
 * `run.sends[key]` is a single object and stays that way — the duplicate guard, the Watch tabs,
 * the History page and `summariseRun` all read that shape. The full record lives in
 * `run.sendHistory[key]`, oldest first, and `sendsForKey` reads the two back as one list.
 *
 * A send record is the structured evidence that devices reached the org. When 31 emails went out
 * for 10 intended sends on 2026-09-03, each delivery overwrote the last, and the run afterwards
 * showed one send per pipeline; six real loads of the same devices survived only in the event log.
 *
 * `fallbackDeviceIds` matters more than it looks: a record archived without its devices is one the
 * guard can never reason about again, so it refuses every later send for that key on principle —
 * including the legitimate other half of a batch.
 *
 * @returns {boolean} whether there was a record to archive
 */
export function archiveCurrentSend(run, key, { fallbackDeviceIds } = {}) {
  const previous = run.sends?.[key];
  if (!previous) return false;
  run.sendHistory = run.sendHistory ?? {};
  run.sendHistory[key] = [
    ...(run.sendHistory[key] ?? []),
    { ...previous, deviceIds: previous.deviceIds ?? fallbackDeviceIds ?? [] },
  ];
  return true;
}

/** Every send for one pipeline, oldest first: the archived ones, then the current. */
export function sendsForKey(run, key) {
  const current = run?.sends?.[key];
  return [...(run?.sendHistory?.[key] ?? []), ...(current ? [current] : [])];
}

export const SEND_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Take exclusive hold of one `"<operation>:<family>"` pipeline for the duration of a send.
 *
 * This is what actually prevents a double load; the duplicate-send guard alone cannot. That
 * guard reads `run.sends[key]`, then the handler awaits `deliver()` for several seconds, then
 * writes the record — so every request arriving inside that window reads the same "not sent
 * yet" state and passes. A single "Send all" on 2026-09-03 put 31 emails into the org for 10
 * intended sends that way.
 *
 * `updateRun` is a synchronous read-modify-write, so the check and the set here cannot be
 * interleaved by another request on Node's single thread. Returns false if the pipeline is
 * already held, in which case the caller must not send.
 */
export function claimSend(runId, key, { ttlMs = SEND_CLAIM_TTL_MS, now = Date.now() } = {}) {
  let claimed = false;
  updateRun(runId, (run) => {
    run.sending = run.sending ?? {};
    const held = run.sending[key];
    const startedAt = held ? Date.parse(held.startedAt) : NaN;
    // An unparseable timestamp counts as stale rather than holding the pipeline forever.
    const stillHeld = Number.isFinite(startedAt) && now - startedAt < ttlMs;
    if (!stillHeld) {
      run.sending[key] = { startedAt: new Date(now).toISOString() };
      claimed = true;
    }
    return run;
  });
  return claimed;
}

/** Release a pipeline claimed by `claimSend`. Safe to call for a key that is not held. */
export function releaseSend(runId, key) {
  updateRun(runId, (run) => {
    if (run.sending) delete run.sending[key];
    return run;
  });
}

export function appendEvent(runId, event, detail = null) {
  return updateRun(runId, (run) => {
    run.events.push({ at: new Date().toISOString(), event, detail });
    return run;
  });
}

/**
 * Runs, newest first. `env` narrows to one environment — testing and staging are different
 * orgs with different device ids, so mixing their histories invites reading a staging id as
 * a testing one. Filtering happens before the limit, so asking for 50 testing runs returns
 * 50 testing runs rather than whatever survives a mixed cut.
 */
export function listRuns({ limit = 50, env = null } = {}) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(RUNS_DIR, f), null))
    .filter(Boolean)
    .filter((run) => !env || run.env === env)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(summariseRun);
}

export function summariseRun(run) {
  const groups = run.groups ?? [];
  return {
    runId: run.runId,
    env: run.env,
    operation: run.operation,
    trackingId: run.trackingId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    orderNumber: run.order?.orderNumber ?? null,
    unitCount: groups.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.deviceCount, 0), 0),
    groups: groups.map((g) => ({
      family: g.family,
      familyLabel: g.familyLabel,
      lines: g.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, deviceCount: l.deviceCount })),
    })),
    sends: Object.entries(run.sends ?? {})
      .filter(([, s]) => s?.ok)
      .map(([key, s]) => ({
        key,
        operation: s.operation,
        family: s.family,
        to: s.to,
        sentAt: s.sentAt,
        // Emails this pipeline actually produced. >1 means the same devices were loaded twice.
        attempts: sendsForKey(run, key).filter((x) => x?.ok).length,
      })),
    loadedDeviceIds: run.result?.loadedDeviceIds ?? [],
    failedDeviceIds: run.result?.failedDeviceIds ?? [],
  };
}

export function deleteRun(runId) {
  try {
    fs.unlinkSync(runFile(runId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.rmSync(runOutputDir(runId), { recursive: true, force: true });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Artifact bytes on disk
// ---------------------------------------------------------------------------

/**
 * Do two artifacts cover exactly the same devices? Unknown on either side means "assume not the
 * same", which archives the old send record — the cautious direction, since the guard then still
 * has its ids and can catch a repeat.
 */
function sameDeviceSet(a, b) {
  if (!a?.length || !b?.length) return false;
  if (a.length !== b.length) return false;
  const left = new Set(a.map(String));
  return b.every((id) => left.has(String(id)));
}

/**
 * Store one generated file. Keyed by "<operation>:<family>" rather than by template id,
 * because the same family can hold a generated file for several operations at once and each
 * one is a separate email.
 */
export function saveArtifact(runId, key, artifact) {
  const dir = runOutputDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, artifact.filename);
  fs.writeFileSync(file, artifact.buffer);

  updateRun(runId, (run) => {
    // A send record describes one specific file. Regenerating this key for a different set of
    // devices — the second half of a batch pushed forward separately — leaves that record
    // describing something that is no longer on disk, and the duplicate-send guard then reads
    // it as "this file already went" and refuses a send that has never happened.
    //
    // It is archived rather than dropped: those devices are in the org, and the guard needs the
    // full history to still catch a genuine repeat.
    const previousSend = run.sends?.[key];
    if (previousSend?.ok && !sameDeviceSet(previousSend.deviceIds, artifact.deviceIds)) {
      // Last chance to learn what that send carried: the artifact it went out with is still in
      // the run, about to be overwritten below.
      archiveCurrentSend(run, key, { fallbackDeviceIds: run.artifacts?.[key]?.deviceIds });
      delete run.sends[key];
    }

    run.artifacts[key] = {
      key,
      template: artifact.template,
      filename: artifact.filename,
      uploadAs: artifact.uploadAs,
      rowCount: artifact.rowCount,
      // The devices this file covers. Polling and the Review screen read this rather than the
      // run's full device list, so an operation generated for a subset is watched and shown as
      // that subset.
      deviceIds: artifact.deviceIds ?? [],
      byteLength: artifact.buffer.length,
      path: file,
      header: artifact.header,
      writtenAt: new Date().toISOString(),
    };
    return run;
  });

  return { ...artifact, key, path: file };
}

/** Re-read stored bytes. Re-sending must use these, never a fresh generation. */
export function loadArtifact(runId, key) {
  const run = getRun(runId);
  const meta = run.artifacts?.[key];
  if (!meta) {
    throw new Error(
      `Run ${runId} has no generated file for "${key}". Available: ${Object.keys(run.artifacts ?? {}).join(', ') || '(none)'}`
    );
  }
  if (!fs.existsSync(meta.path)) throw new Error(`Generated file is missing from disk: ${meta.path}`);
  return {
    key,
    template: meta.template,
    filename: meta.filename,
    uploadAs: meta.uploadAs,
    rowCount: meta.rowCount,
    // Carried through so the duplicate-send guard can compare this file against what has
    // already gone out. Without it the guard cannot tell two files apart and falls back to
    // refusing any second send for the key.
    deviceIds: meta.deviceIds ?? [],
    header: meta.header,
    buffer: fs.readFileSync(meta.path),
    path: meta.path,
  };
}
