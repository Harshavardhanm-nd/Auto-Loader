/**
 * Pre-send validation.
 *
 * Every check is reported individually rather than collapsed into one pass/fail, because
 * each corresponds to a distinct real failure mode and the user needs to know which one they
 * are looking at. Checks are graded:
 *
 *   blocker — the send is refused
 *   warning — the send is allowed but flagged
 *
 * Nothing here hard-codes a format. The rules come from the template descriptor, which was
 * derived from a sheet the parser has accepted. Two consequences worth calling out:
 *
 *   - Line endings and BOM are checked against the template's own declared contract, not a
 *     single global rule. The real sheets are all CRLF but disagree on the BOM even within
 *     one logical format.
 *   - There is no sim_serial == device_imei check. The process spec demands it, but every
 *     real Driveri sheet uses three distinct series offset by 10.
 */

import { hasBom, lineEndingStats, hexDump, CRLF } from '../lib/bytes.js';
import { checkOperationAgainstStages } from '../lib/lifecycle.js';
import { validateRows, primarySeriesOf } from './id-generator.js';

const OK = 'pass';
const FAIL = 'fail';
const SKIP = 'skipped';

function check(id, label, status, detail, severity = 'blocker') {
  return { id, label, status, detail: detail ?? null, severity };
}

function splitCsv(buffer, template) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const lines = text.split(template.bytes.lineEnding);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { header: lines[0] ?? '', dataLines: lines.slice(1) };
}

// ---------------------------------------------------------------------------
// Structure and bytes — applies to every template
// ---------------------------------------------------------------------------

export function validateArtifact({ template, artifact, trackingId, fields, generatedRows }) {
  const checks = [];
  const { buffer } = artifact;
  const { header, dataLines } = splitCsv(buffer, template);
  const expectedHeader = template.columns.map((c) => c.name).join(',');
  const columnCount = template.columns.length;

  checks.push(
    header === expectedHeader
      ? check('header', `Header matches ${template.sourceTemplate} (${columnCount} columns)`, OK)
      : check(
          'header',
          `Header matches ${template.sourceTemplate} (${columnCount} columns)`,
          FAIL,
          `Expected:\n${expectedHeader}\nGot:\n${header}`
        )
  );

  const widths = new Set(dataLines.map((l) => l.split(',').length));
  checks.push(
    widths.size === 1 && widths.has(columnCount)
      ? check('width', `Every row has ${columnCount} fields`, OK)
      : check('width', `Every row has ${columnCount} fields`, FAIL, `Field counts present: ${[...widths].join(', ')}`)
  );

  // Byte contract, per the template's own declaration.
  const wantCrlf = template.bytes.lineEnding === CRLF;
  const { crlf, bareLf, bareCr } = lineEndingStats(buffer);
  const problems = [];
  if (template.bytes.bom && !hasBom(buffer)) problems.push('missing the BOM this template declares');
  if (!template.bytes.bom && hasBom(buffer)) problems.push('has a BOM but this template declares none');
  if (wantCrlf && bareLf > 0) problems.push(`${bareLf} bare LF ending(s); CRLF declared`);
  if (wantCrlf && crlf === 0) problems.push('no CRLF endings found');
  if (!wantCrlf && crlf > 0) problems.push(`${crlf} CRLF ending(s); LF declared`);
  if (bareCr > 0) problems.push(`${bareCr} bare CR byte(s)`);
  const endsNewline = buffer[buffer.length - 1] === 0x0a;
  if (template.bytes.trailingNewline && !endsNewline) problems.push('missing trailing newline');
  if (!template.bytes.trailingNewline && endsNewline) problems.push('unexpected trailing newline');

  const contract = [
    template.bytes.bom ? 'BOM' : 'no BOM',
    wantCrlf ? 'CRLF' : 'LF',
    template.bytes.trailingNewline ? 'trailing newline' : 'no trailing newline',
  ].join(', ');
  checks.push(
    problems.length === 0
      ? check('bytes', `Bytes match the declared contract (${contract})`, OK)
      : check('bytes', `Bytes match the declared contract (${contract})`, FAIL, problems.join('; '))
  );

  // Required columns non-empty on every row.
  const requiredIdx = template.columns
    .map((c, i) => (c.required ? { name: c.name, i } : null))
    .filter(Boolean);
  const emptyRequired = [];
  dataLines.forEach((line, rowIdx) => {
    const fieldsInRow = line.split(',');
    for (const { name, i } of requiredIdx) {
      if (!fieldsInRow[i] || fieldsInRow[i].trim() === '') emptyRequired.push(`row ${rowIdx + 1}: ${name}`);
    }
  });
  checks.push(
    emptyRequired.length === 0
      ? check('required', `All ${requiredIdx.length} required column(s) non-empty on every row`, OK)
      : check(
          'required',
          `All ${requiredIdx.length} required column(s) non-empty on every row`,
          FAIL,
          emptyRequired.slice(0, 10).join('; ')
        )
  );

  // Tracking id, where the template puts it in a column.
  const trackingIdx = template.columns.findIndex((c) => c.source === 'trackingId');
  if (trackingIdx >= 0) {
    const wrong = dataLines
      .map((line, i) => ({ value: line.split(',')[trackingIdx], row: i + 1 }))
      .filter((r) => r.value !== trackingId);
    checks.push(
      wrong.length === 0
        ? check('tracking', `${template.columns[trackingIdx].name} == ${trackingId} on every row`, OK)
        : check(
            'tracking',
            `${template.columns[trackingIdx].name} == ${trackingId} on every row`,
            FAIL,
            wrong.slice(0, 5).map((r) => `row ${r.row}: "${r.value}"`).join('; ')
          )
    );
  }

  // Generated series: declared width, prefix and uniqueness of the primary id.
  const series = template.series ?? {};
  if (Object.keys(series).length && generatedRows?.length) {
    const primary = primarySeriesOf(template);
    const rowProblems = validateRows(generatedRows, series, primary);
    const names = Object.keys(series).join(', ');
    checks.push(
      rowProblems.length === 0
        ? check('series', `Generated series well-formed and ${primary} unique (${names})`, OK)
        : check(
            'series',
            `Generated series well-formed and ${primary} unique (${names})`,
            FAIL,
            rowProblems.slice(0, 10).join('; ')
          )
    );
  }

  // Date columns follow the format the template declares.
  const dateIdx = template.columns
    .map((c, i) => (c.source === 'today' ? i : -1))
    .filter((i) => i >= 0);
  if (dateIdx.length) {
    const format = template.dateFormat ?? 'YYYY-MM-DD';
    const pattern = {
      'YYYY-MM-DD': /^\d{4}-\d{2}-\d{2}$/,
      'DD/MM/YY': /^\d{2}\/\d{2}\/\d{2}$/,
      'DD-MM-YYYY': /^\d{2}-\d{2}-\d{4}$/,
      'MM/DD/YY': /^\d{2}\/\d{2}\/\d{2}$/,
    }[format];
    const bad = new Set();
    for (const i of dateIdx) {
      for (const line of dataLines) {
        const value = line.split(',')[i];
        if (value && pattern && !pattern.test(value)) bad.add(`${template.columns[i].name}="${value}"`);
      }
    }
    checks.push(
      bad.size === 0
        ? check('dates', `Date column(s) formatted as ${format}`, OK)
        : check('dates', `Date column(s) formatted as ${format}`, FAIL, [...bad].slice(0, 6).join(', '))
    );
  }

  // Columns the descriptor marks as constrained.
  const constraintProblems = [];
  template.columns.forEach((column, i) => {
    if (!column.noSpaces && !column.integerOnly) return;
    for (const [rowIdx, line] of dataLines.entries()) {
      const value = line.split(',')[i] ?? '';
      if (column.noSpaces && /\s/.test(value)) {
        constraintProblems.push(`row ${rowIdx + 1}: ${column.name} contains a space`);
      }
      if (column.integerOnly && !/^\d+$/.test(value)) {
        constraintProblems.push(`row ${rowIdx + 1}: ${column.name} "${value}" is not digits only`);
      }
    }
  });
  if (template.columns.some((c) => c.noSpaces || c.integerOnly)) {
    checks.push(
      constraintProblems.length === 0
        ? check('constraints', 'Constrained columns are digits-only / space-free as declared', OK)
        : check(
            'constraints',
            'Constrained columns are digits-only / space-free as declared',
            FAIL,
            constraintProblems.slice(0, 10).join('; ')
          )
    );
  }

  return checks;
}

/** The org-collision half of the id check, which needs a live connection. */
export function validateIdsFree({ takenIds, checked, alreadySent }) {
  if (alreadySent) {
    return check(
      'collision',
      'Ids absent from Asset.Name in the org',
      SKIP,
      'This file has already been sent, so its ids exist in the org by design.',
      'warning'
    );
  }
  if (!checked) {
    return check(
      'collision',
      'Ids absent from Asset.Name in the org',
      SKIP,
      'Not connected to Salesforce — the collision check did not run. The load will fail for any id already taken.',
      'warning'
    );
  }
  return takenIds.length === 0
    ? check('collision', 'Ids absent from Asset.Name in the org', OK)
    : check(
        'collision',
        'Ids absent from Asset.Name in the org',
        FAIL,
        `Already taken: ${takenIds.slice(0, 10).join(', ')}${takenIds.length > 10 ? ` (+${takenIds.length - 10} more)` : ''}`
      );
}

/**
 * Are these devices in a stage this operation can act on?
 *
 * A **warning**, never a blocker, and deliberately so. `IDMS_Status__c` is written by another
 * system: a device can move between this read and the send, an initial load acts on devices that
 * have no Asset yet, and the whole chart is full of transitions other actors drive. Refusing a
 * send on a stage read would invent a new way to be stuck.
 *
 * What it does buy is the mistake that costs a real load: sending a shipment update for devices
 * that are already past Shipped From Vendor, which the org accepts and which changes nothing.
 */
export function validateDeviceStages({ operation, deviceStages, checked }) {
  const label = 'Devices are in a stage this operation moves';

  if (!checked) {
    return check(
      'stage',
      label,
      SKIP,
      'Not connected to Salesforce — the life cycle stage was not read.',
      'warning'
    );
  }

  const result = checkOperationAgainstStages(operation, deviceStages);

  if (!result.applicable) {
    return check('stage', label, SKIP, result.reason, 'warning');
  }

  const movement = `${result.fromLabels.join(' / ')} → ${result.toLabels.join(' / ')}`;

  if (result.mismatched.length === 0) {
    return check('stage', label, OK, `${movement} · ${result.ok.length} device(s) in place`, 'warning');
  }

  const shown = result.mismatched
    .slice(0, 8)
    .map((m) => `${m.deviceId}: ${m.why}`)
    .join('\n');

  return check(
    'stage',
    label,
    FAIL,
    `This operation moves ${movement}.\n` +
      `${result.mismatched.length} of ${deviceStages.length} device(s) are not in a stage it moves:\n${shown}` +
      (result.mismatched.length > 8 ? `\n(+${result.mismatched.length - 8} more)` : '') +
      '\nSending anyway is accepted by the org and will not move them.',
    'warning'
  );
}

/** Wizard uploads only: the row count must equal what the order asked for. */
export function validateWizardRowCount({ artifact, template, requiredSerialTotal }) {
  const { dataLines } = splitCsv(artifact.buffer, template);
  return dataLines.length === requiredSerialTotal
    ? check('rowcount', `Row count == serialized quantity on the order (${requiredSerialTotal})`, OK)
    : check(
        'rowcount',
        `Row count == serialized quantity on the order (${requiredSerialTotal})`,
        FAIL,
        `File has ${dataLines.length} row(s). ` +
          (dataLines.length < requiredSerialTotal
            ? 'Uploading fewer sets the order to Partially Shipped, which hides the "Load Asset & Ship Order" button and dead-ends the flow.'
            : 'Uploading more than the line quantity will be rejected.')
      );
}

/** Every serial in a wizard upload must already be a shipped asset. */
export function validateSerialsShipped({ artifact, template, assetStates }) {
  if (!assetStates) {
    return check(
      'assets',
      'Every serial exists as an Asset at SHIPMENT_UPDATE_SYNC_SUCCESS',
      SKIP,
      'Not checked — run the shipment update and let polling settle first.',
      'warning'
    );
  }
  const { dataLines } = splitCsv(artifact.buffer, template);
  const serialIdx = template.columns.findIndex((c) => c.source === 'existing.device_id');
  const notReady = [];
  for (const line of dataLines) {
    const serial = line.split(',')[serialIdx];
    const state = assetStates[serial];
    if (!state) notReady.push(`${serial}: no Asset record`);
    else if (state !== 'SHIPMENT_UPDATE_SYNC_SUCCESS') notReady.push(`${serial}: ${state}`);
  }
  return notReady.length === 0
    ? check('assets', 'Every serial exists as an Asset at SHIPMENT_UPDATE_SYNC_SUCCESS', OK)
    : check(
        'assets',
        'Every serial exists as an Asset at SHIPMENT_UPDATE_SYNC_SUCCESS',
        FAIL,
        notReady.slice(0, 10).join('; ')
      );
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * The mailbox is matched on its LOCAL PART. Matching the domain alone would happily accept
 * the wrong mailbox — every address in this flow is @netradyne.com, and the mailbox is the
 * only thing that distinguishes one operation from another.
 */
export function validateSendTarget({ environment, template, dl, recipient, attachmentCount, blockers }) {
  const checks = [];
  const pipeline = `${template.familyLabel} ${template.operation}`;

  if (!dl) {
    checks.push(
      check('dl', `Mailbox configured for ${pipeline}`, FAIL, 'This operation does not send mail.')
    );
    return checks;
  }

  const [expectedLocal, expectedDomain] = String(dl.to).toLowerCase().split('@');
  const [actualLocal, actualDomain] = String(recipient ?? '').toLowerCase().split('@');

  checks.push(
    expectedLocal === actualLocal && expectedDomain === actualDomain
      ? check(
          'mailbox',
          `Correct mailbox for ${pipeline} (matched on local part)`,
          OK,
          `${dl.to}  ← resolved from ${dl.source}["${dl.key}"]`
        )
      : check(
          'mailbox',
          `Correct mailbox for ${pipeline} (matched on local part)`,
          FAIL,
          `Expected ${dl.to}, got ${recipient}. The mailbox is the only thing that selects the ` +
            'operation — the wrong one is a silent no-op or a double load.'
        )
  );

  checks.push(
    attachmentCount === 1
      ? check('attachment', 'Exactly one attachment', OK)
      : check('attachment', 'Exactly one attachment', FAIL, `${attachmentCount} attachment(s)`)
  );

  checks.push(
    blockers.length === 0
      ? check('config', `${environment.label} is configured for this pipeline`, OK)
      : check(
          'config',
          `${environment.label} is configured for this pipeline`,
          FAIL,
          `Still placeholders in config/environments.json: ${blockers.join(', ')}. ` +
            'Sending is blocked until these are real values.'
        )
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export function summariseChecks(groups) {
  const all = Object.values(groups).flat();
  const blockers = all.filter((c) => c.status === FAIL && c.severity === 'blocker');
  const warnings = all.filter(
    (c) => (c.status === FAIL && c.severity === 'warning') || c.status === SKIP
  );
  return {
    groups,
    counts: {
      total: all.length,
      passed: all.filter((c) => c.status === OK).length,
      failed: all.filter((c) => c.status === FAIL).length,
      skipped: all.filter((c) => c.status === SKIP).length,
    },
    blockers,
    warnings,
    canSend: blockers.length === 0,
  };
}

/**
 * Why sending this file would be a double load, or null if it is genuinely new.
 *
 * The thing worth preventing is a *device* being loaded twice, not a key being reused. Half a
 * batch pushed to shipment update, then the other half, is two different files to the same
 * mailbox and both must go — the guard used to key on "<operation>:<family>" alone and refused
 * the second as a repeat of the first, with no way past it but force.
 *
 * So the test is whether any device in this file has already been sent for this operation,
 * counting superseded sends as well as the current one. When either side's device list is
 * unknown — records written before artifacts carried ids — it falls back to the old, blunt
 * answer: a send record for this key means blocked. Refusing a legitimate send is recoverable;
 * a silent double load is not.
 *
 * @param {object} args
 * @param {object} [args.currentSend]  run.sends[key], if the current file has been sent
 * @param {object[]} [args.archivedSends]  run.sendHistory[key] — sends superseded by regeneration
 * @param {object} args.artifact       the file about to go out
 */
export function duplicateSendReason({ currentSend, archivedSends = [], artifact }) {
  const priorSends = [...archivedSends, ...(currentSend?.ok ? [currentSend] : [])];
  if (!priorSends.length) return null;

  const scopeKnown = artifact.deviceIds?.length && priorSends.every((s) => s.deviceIds?.length);
  if (!scopeKnown) {
    // Say plainly that this is uncertainty, not a detected repeat. Claiming "the same file was
    // already sent" when the file demonstrably covers different devices sends the operator
    // looking for a duplicate that does not exist, and makes forcing feel reckless when it is
    // in fact the right call.
    const latest = priorSends[priorSends.length - 1];
    return (
      `${artifact.filename} was sent to ${latest.to} at ${latest.sentAt}, and that record does ` +
      'not list which devices it carried — so this cannot be checked for overlap. If this file ' +
      'covers devices that have not been sent for this operation, force it; if it repeats any ' +
      'of them, do not.'
    );
  }

  const alreadySent = new Set(priorSends.flatMap((s) => s.deviceIds).map(String));
  const repeats = artifact.deviceIds.filter((id) => alreadySent.has(String(id)));
  if (!repeats.length) return null;

  return (
    `${repeats.length} device(s) in ${artifact.filename} were already sent for this operation: ` +
    `${repeats.slice(0, 8).join(', ')}${repeats.length > 8 ? ` (+${repeats.length - 8} more)` : ''}. ` +
    'Loading them again is a double load. Pass force to override.'
  );
}

export function artifactPreview(artifact, maxBytes = 512) {
  return {
    filename: artifact.filename,
    uploadAs: artifact.uploadAs,
    template: artifact.template,
    rowCount: artifact.rowCount,
    byteLength: artifact.buffer.length,
    hex: hexDump(artifact.buffer, maxBytes),
    text: artifact.buffer.toString('utf8').slice(0, 4000),
  };
}
