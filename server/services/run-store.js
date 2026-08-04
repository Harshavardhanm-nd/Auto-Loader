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
  return run;
}

export function updateRun(runId, mutate) {
  const run = getRun(runId);
  const next = mutate(run) ?? run;
  next.updatedAt = new Date().toISOString();
  writeJson(runFile(runId), next);
  return next;
}

export function appendEvent(runId, event, detail = null) {
  return updateRun(runId, (run) => {
    run.events.push({ at: new Date().toISOString(), event, detail });
    return run;
  });
}

export function listRuns({ limit = 50 } = {}) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(RUNS_DIR, f), null))
    .filter(Boolean)
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
      .map(([key, s]) => ({ key, operation: s.operation, family: s.family, to: s.to, sentAt: s.sentAt })),
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
 * Store one generated file. Keyed by "<operation>:<family>" rather than by template id,
 * because the same family can hold a generated file for several operations at once and each
 * one is a separate email.
 */
export function saveArtifact(runId, key, artifact) {
  const dir = runOutputDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  // Two operations can produce the same filename (Haptic sheets carry no tracking id), so the
  // key namespaces the file on disk.
  const file = path.join(dir, `${key.replace(/[:/]/g, '_')}__${artifact.filename}`);
  fs.writeFileSync(file, artifact.buffer);

  updateRun(runId, (run) => {
    run.artifacts[key] = {
      key,
      template: artifact.template,
      filename: artifact.filename,
      uploadAs: artifact.uploadAs,
      rowCount: artifact.rowCount,
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
    header: meta.header,
    buffer: fs.readFileSync(meta.path),
    path: meta.path,
  };
}
