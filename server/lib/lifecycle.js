/**
 * The device life cycle (DLCM), read from `config/lifecycle.json`.
 *
 * A device walks a stage graph. `IDMS_Status__c` on the Asset carries the stage as a numeric
 * code; every legal move between stages is a transition, and each transition is driven either
 * by **an operation this app can send** or by **somebody else entirely** — the Installer App,
 * the customer, the order integration, the network activating a sim.
 *
 * That split is the whole point of modelling it. The app can tell you the next thing *you* do,
 * and it can tell you that the next thing is not yours to do — which is the more common answer.
 * It stays advisory: a stage read is a snapshot of a value another system owns, so nothing here
 * blocks a send. It warns.
 *
 * Codes run -2..14 in the org; the chart draws -2..12. An unmodelled code is reported as
 * unmapped rather than guessed at.
 */

import path from 'node:path';
import { CONFIG_DIR, readJson } from './paths.js';

let cache = null;

/** Parsed once — the file is static and read on nearly every request. */
export function loadLifecycle() {
  if (!cache) {
    const raw = readJson(path.join(CONFIG_DIR, 'lifecycle.json'));
    cache = index(raw);
  }
  return cache;
}

/** Test seam: drop the parse cache. */
export function resetLifecycleCache() {
  cache = null;
}

function index(raw) {
  const stages = raw.stages.map((s) => ({ ...s, terminal: Boolean(s.terminal) }));
  const byCode = new Map(stages.map((s) => [s.code, s]));
  const byId = new Map(stages.map((s) => [s.id, s]));

  const transitions = raw.transitions.map((t, i) => ({
    ...t,
    key: `${t.from ?? 'entry'}->${t.to}`,
    index: i,
    operation: t.driver?.kind === 'operation' ? t.driver.operation : null,
    external: t.driver?.kind === 'external',
  }));

  for (const t of transitions) {
    if (t.from !== null && !byCode.has(t.from)) {
      throw new Error(`lifecycle.json: transition ${t.key} leaves unknown stage ${t.from}`);
    }
    if (!byCode.has(t.to)) {
      throw new Error(`lifecycle.json: transition ${t.key} enters unknown stage ${t.to}`);
    }
  }

  return {
    stageField: raw.stageField,
    accounts: raw.accounts,
    stages,
    transitions,
    byCode,
    byId,
    operationRoles: stripComments(raw.operationRoles),
    syncStatus: stripComments(raw.syncStatus),
    // Operations that run at a stage without moving the device. Deliberately not in `transitions`:
    // a self-loop there truncates operationChain(), which is what this change repairs. The filter
    // guards against malformed entries (e.g., a bare $comment) after stripping documentation keys.
    stageSteps: (raw.stageSteps ?? []).map(stripComments).filter((s) => s.operation),
  };
}

function stripComments(node) {
  return Object.fromEntries(Object.entries(node ?? {}).filter(([k]) => !k.startsWith('$')));
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * A raw IDMS_Status__c value as a stage.
 *
 * The field arrives from SOQL as a string, a number, or null depending on the picklist, and a
 * device that has never synced has no value at all. Each of those is a different answer and
 * they are kept distinct: `known` means we can place it on the chart.
 */
export function classifyStage(idmsStatus) {
  if (idmsStatus === null || idmsStatus === undefined || idmsStatus === '') {
    return { known: false, absent: true, code: null, label: 'no stage yet', stage: null };
  }

  const code = Number(idmsStatus);
  if (!Number.isFinite(code)) {
    return { known: false, absent: false, code: null, label: String(idmsStatus), stage: null };
  }

  const stage = loadLifecycle().byCode.get(code);
  if (!stage) {
    return {
      known: false,
      absent: false,
      unmapped: true,
      code,
      label: `stage ${code}`,
      stage: null,
    };
  }
  return { known: true, absent: false, code, label: stage.label, stage };
}

export function stageByCode(code) {
  return loadLifecycle().byCode.get(Number(code)) ?? null;
}

export function stageById(id) {
  return loadLifecycle().byId.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function transitionsFrom(code) {
  const from = code === null ? null : Number(code);
  return loadLifecycle().transitions.filter((t) => t.from === from);
}

export function transitionsInto(code) {
  return loadLifecycle().transitions.filter((t) => t.to === Number(code));
}

/** Every transition an operation drives. More than one for Move To Dead, which has three. */
export function transitionsFor(operation) {
  return loadLifecycle().transitions.filter((t) => t.operation === operation);
}

/**
 * What an operation does to a device, or null when it does not move one.
 *
 * `from` is a list because Move To Dead is reachable from three stages. `null` inside it means
 * "no stage at all" — an initial load acts on a device that does not exist yet.
 */
export function operationMovement(operation) {
  const moves = transitionsFor(operation);
  if (!moves.length) return null;
  return {
    operation,
    from: moves.map((t) => t.from),
    to: [...new Set(moves.map((t) => t.to))],
    labels: [...new Set(moves.map((t) => t.label))],
    uncertain: moves.some((t) => t.uncertain),
  };
}

export function operationRole(operation) {
  return loadLifecycle().operationRoles[operation] ?? null;
}

/**
 * The operations this app sends, in the order a device meets them, walked from the entry of the
 * graph: initialLoad → shipmentUpdate → received.
 *
 * Derived rather than listed, so it stays true if a transition is corrected in lifecycle.json.
 * The walk stops where the chain leaves this app's hands — after Received at 3PL every arrow is
 * driven by the customer, the installer or the network, so there is no "next" of ours to order.
 *
 * This is what lets polling tell a device that has run *ahead* of the stage being watched from
 * one that is still *behind* it. Both look identical otherwise: each carries some `_SYNC_SUCCESS`.
 */
export function operationChain() {
  const model = loadLifecycle();
  if (!model.operationChainCache) {
    const nextFrom = (stage) =>
      model.transitions.find((t) => t.from === stage && t.operation);

    const chain = [];
    const seen = new Set();
    for (let step = nextFrom(null); step && !seen.has(step.operation); step = nextFrom(step.to)) {
      seen.add(step.operation);
      chain.push(step.operation);
    }
    model.operationChainCache = chain;
  }
  return model.operationChainCache;
}

/**
 * Which operation wrote a given `Sync_Status__c` base, e.g. SHIPMENT_UPDATE → shipmentUpdate.
 * The `$comment` entry in the map holds an array, so only string values are real.
 */
export function operationForSyncBase(base) {
  const model = loadLifecycle();
  if (!model.syncBaseCache) {
    model.syncBaseCache = Object.fromEntries(
      Object.entries(model.syncStatus)
        .filter(([, value]) => typeof value === 'string')
        .map(([operation, value]) => [value, operation])
    );
  }
  return model.syncBaseCache[base] ?? null;
}

/** Sync_Status__c base, or null when no status is known for this operation. */
export function syncStatusBase(operation) {
  return loadLifecycle().syncStatus[operation] ?? null;
}

/** Operations whose convergence can actually be polled. */
export function pollableOperations() {
  return Object.keys(loadLifecycle().syncStatus);
}

// ---------------------------------------------------------------------------
// "What happens next"
// ---------------------------------------------------------------------------

/**
 * The next steps from a stage, split by who owns them.
 *
 * `mine` is what the operator can do here: an operation with a transition out of this stage.
 * `theirs` is everything waiting on another system, which is most of the chart — surfacing it
 * is what stops the app from looking stuck when it is simply not its turn.
 */
export function nextFrom(code) {
  const out = transitionsFrom(code);
  return {
    mine: out.filter((t) => t.operation).map(describe),
    theirs: out.filter((t) => t.external).map(describe),
  };
}

function describe(t) {
  const target = stageByCode(t.to);
  return {
    label: t.label,
    to: t.to,
    toLabel: target?.label ?? `stage ${t.to}`,
    operation: t.operation,
    actor: t.driver?.actor ?? null,
    uncertain: t.uncertain ?? null,
    note: t.note ?? null,
  };
}

/**
 * Where a set of devices sits, as counts per stage.
 *
 * Ordered by the chart's own reading order so the result reads like a progress bar rather than
 * an arbitrary histogram, and so a run that has split across stages is obvious at a glance.
 */
export function summariseStages(idmsValues) {
  const { stages } = loadLifecycle();
  const order = new Map(stages.map((s, i) => [s.code, i]));

  const buckets = new Map();
  for (const value of idmsValues) {
    const c = classifyStage(value);
    const bucketKey = c.known ? String(c.code) : c.absent ? 'absent' : `unmapped:${c.code ?? c.label}`;
    const bucket =
      buckets.get(bucketKey) ??
      {
        key: bucketKey,
        code: c.code,
        label: c.label,
        known: c.known,
        absent: Boolean(c.absent),
        unmapped: Boolean(c.unmapped),
        account: c.stage?.account ?? null,
        count: 0,
      };
    bucket.count += 1;
    buckets.set(bucketKey, bucket);
  }

  const rows = [...buckets.values()].sort((a, b) => {
    if (a.known && b.known) return order.get(a.code) - order.get(b.code);
    if (a.known) return -1;
    if (b.known) return 1;
    return a.key.localeCompare(b.key);
  });

  return {
    total: idmsValues.length,
    rows,
    // A run is "together" while every device shares a stage. Once it splits, the next step is
    // no longer a single answer, and the UI has to say so rather than pick one.
    unanimous: rows.filter((r) => r.count > 0).length === 1 ? rows[0] : null,
  };
}

/**
 * Whether an operation makes sense for the stages a set of devices is actually in.
 *
 * Deliberately forgiving. It reports, it does not judge: a device may legitimately have moved
 * between the read and the send, `initialLoad` acts on devices that do not exist yet, and a
 * stage-preserving operation is valid everywhere. Only a device sitting in a stage the
 * operation has no transition out of counts as a mismatch.
 */
export function checkOperationAgainstStages(operation, idmsValues) {
  const movement = operationMovement(operation);
  const role = operationRole(operation);

  if (!movement) {
    return {
      applicable: false,
      reason: role?.stagePreserving
        ? `${operation} does not move a device between stages, so any stage is valid for it.`
        : `${operation} has no transition on the DLCM chart, so its stages cannot be checked.`,
      mismatched: [],
      ok: [],
    };
  }

  const allowed = new Set(movement.from);
  const mismatched = [];
  const ok = [];

  idmsValues.forEach(({ deviceId, idmsStatus }) => {
    const c = classifyStage(idmsStatus);
    // A device with no Asset yet is the normal state for an initial load and is never a
    // mismatch — the collision check is what covers that case.
    if (c.absent) {
      if (allowed.has(null)) ok.push({ deviceId, ...c });
      else mismatched.push({ deviceId, ...c, why: 'no Asset record yet' });
      return;
    }
    if (!c.known) {
      mismatched.push({ deviceId, ...c, why: `stage ${c.code ?? c.label} is not on the chart` });
      return;
    }
    if (allowed.has(c.code)) ok.push({ deviceId, ...c });
    else mismatched.push({ deviceId, ...c, why: `is at ${c.label}` });
  });

  const fromLabels = movement.from.map((f) =>
    f === null ? 'no Asset yet' : stageByCode(f)?.label ?? `stage ${f}`
  );

  return {
    applicable: true,
    movement,
    fromLabels,
    toLabels: movement.to.map((t) => stageByCode(t)?.label ?? `stage ${t}`),
    mismatched,
    ok,
  };
}

/**
 * The chart, shaped for the client: stages with their layout slot, transitions with their
 * driver resolved, and which operations are drivable from here.
 */
export function describeLifecycle(operations = {}) {
  const model = loadLifecycle();

  return {
    stageField: model.stageField,
    accounts: model.accounts,
    stages: model.stages.map((s) => ({
      code: s.code,
      id: s.id,
      label: s.label,
      account: s.account,
      terminal: s.terminal,
      note: s.note ?? null,
      layout: s.layout,
      out: transitionsFrom(s.code).length,
    })),
    transitions: model.transitions.map((t) => ({
      key: t.key,
      from: t.from,
      to: t.to,
      label: t.label,
      operation: t.operation,
      operationLabel: t.operation ? operations[t.operation]?.label ?? t.operation : null,
      actor: t.driver?.actor ?? null,
      external: t.external,
      route: t.route ?? null,
      enter: t.enter ?? null,
      note: t.note ?? null,
      uncertain: t.uncertain ?? null,
    })),
    operations: Object.entries(operations).map(([id, meta]) => {
      const movement = operationMovement(id);
      const role = operationRole(id);
      return {
        id,
        label: meta.label,
        needsMail: meta.needsMail !== false,
        movement,
        stagePreserving: Boolean(role?.stagePreserving),
        unmapped: Boolean(role?.unmapped) || (!movement && !role?.stagePreserving),
        note: role?.note ?? null,
        syncStatus: syncStatusBase(id),
      };
    }),
    uncertainties: model.transitions
      .filter((t) => t.uncertain)
      .map((t) => ({ key: t.key, label: t.label, from: t.from, to: t.to, why: t.uncertain })),
  };
}
