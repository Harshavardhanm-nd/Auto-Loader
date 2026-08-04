/**
 * Byte-level CSV primitives.
 *
 * The two formats in this flow have opposite byte rules and one of them is read by a
 * Salesforce Apex parser that rejects the wrong bytes outright (spec section 2):
 *
 *   Format A (Initial Load)     no BOM, LF,   trailing newline
 *   Format B (Serialized Assets)   BOM, CRLF, trailing newline
 *
 * Everything that writes a CSV in this app goes through here so the rules live in one
 * place and can be asserted before a send.
 */

export const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
export const LF = '\n';
export const CRLF = '\r\n';

/**
 * Join rows into a Buffer honouring an explicit byte contract.
 *
 * @param {string[]} rows            already-escaped CSV lines, header first
 * @param {object}   byteRules
 * @param {boolean}  byteRules.bom
 * @param {string}   byteRules.lineEnding
 * @param {boolean}  byteRules.trailingNewline
 * @returns {Buffer}
 */
export function encodeCsv(rows, { bom, lineEnding, trailingNewline }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('encodeCsv: rows must be a non-empty array');
  }
  if (lineEnding !== LF && lineEnding !== CRLF) {
    throw new Error(`encodeCsv: lineEnding must be LF or CRLF, got ${JSON.stringify(lineEnding)}`);
  }
  let text = rows.join(lineEnding);
  if (trailingNewline) text += lineEnding;
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([BOM, body]) : body;
}

/**
 * Escape one field for CSV. Kept deliberately minimal: none of the columns in either
 * format legitimately contain a comma, quote or newline, so rather than quietly quoting
 * we treat those characters as a bug in the caller's data and refuse.
 */
export function escapeField(value, columnName = 'field') {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    throw new Error(
      `escapeField: ${columnName} contains a comma, quote or newline (${JSON.stringify(s)}). ` +
        'No column in either format may contain these; fix the source value.'
    );
  }
  return s;
}

export function buildRow(values, columnNames = []) {
  return values.map((v, i) => escapeField(v, columnNames[i] ?? `col${i}`)).join(',');
}

export function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

/**
 * Detect line endings actually present in a buffer.
 * @returns {{ crlf: number, bareLf: number, bareCr: number }}
 */
export function lineEndingStats(buf) {
  let crlf = 0;
  let bareLf = 0;
  let bareCr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        crlf++;
        i++;
      } else {
        bareCr++;
      }
    } else if (buf[i] === 0x0a) {
      bareLf++;
    }
  }
  return { crlf, bareLf, bareCr };
}

/**
 * Assert a buffer matches its declared byte contract. Throws with a precise reason.
 *
 * This is the guard the old automation called assertApexSafeCsvBytes(); it is applied to
 * BOTH formats here, since Format A silently misbehaving is just as expensive as Format B
 * being rejected.
 */
export function assertCsvBytes(buf, { bom, lineEnding, trailingNewline }, label = 'csv') {
  const problems = [];

  if (bom && !hasBom(buf)) problems.push('missing required BOM (EF BB BF)');
  if (!bom && hasBom(buf)) problems.push('has a BOM but this format must not have one');

  const { crlf, bareLf, bareCr } = lineEndingStats(buf);
  if (lineEnding === CRLF) {
    if (bareLf > 0) problems.push(`${bareLf} bare LF line ending(s); CRLF required throughout`);
    if (crlf === 0) problems.push('no CRLF line endings found');
  } else {
    if (crlf > 0) problems.push(`${crlf} CRLF line ending(s); LF required throughout`);
    if (bareLf === 0) problems.push('no LF line endings found');
  }
  if (bareCr > 0) problems.push(`${bareCr} bare CR byte(s)`);

  const endsWithNewline = buf.length > 0 && buf[buf.length - 1] === 0x0a;
  if (trailingNewline && !endsWithNewline) problems.push('missing trailing newline');
  if (!trailingNewline && endsWithNewline) problems.push('unexpected trailing newline');

  if (problems.length) {
    throw new Error(`${label}: byte contract violated — ${problems.join('; ')}`);
  }
  return true;
}

/**
 * xxd-style hex dump, for the Review screen's byte preview. The spec pins Format B's
 * exact opening bytes, so showing them is how a user confirms a send is safe.
 */
export function hexDump(buf, maxBytes = 512) {
  const slice = buf.subarray(0, maxBytes);
  const lines = [];
  for (let off = 0; off < slice.length; off += 16) {
    const chunk = slice.subarray(off, off + 16);
    const hex = [];
    for (let i = 0; i < 16; i += 2) {
      const a = chunk[i];
      const b = chunk[i + 1];
      if (a === undefined) hex.push('    ');
      else if (b === undefined) hex.push(a.toString(16).padStart(2, '0') + '  ');
      else hex.push(a.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0'));
    }
    const ascii = Array.from(chunk)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(`${off.toString(16).padStart(8, '0')}: ${hex.join(' ').padEnd(39)}  ${ascii}`);
  }
  if (buf.length > maxBytes) lines.push(`… ${buf.length - maxBytes} more byte(s)`);
  return lines.join('\n');
}

/**
 * Repair and validate a serial number destined for Format B.
 *
 * Excel is the usual source of corruption: it renders 23259776084 as 2.32598E+10 or
 * 23259776084.0. A trailing .000 is a safe repair; anything else non-integer is a hard
 * error, because guessing at a serial number is worse than failing.
 */
export function formatSerialNumberForCsv(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new Error('serial number is empty');
  if (/^\d+$/.test(raw)) return raw;

  const trailingZeroDecimal = raw.match(/^(\d+)\.0+$/);
  if (trailingZeroDecimal) return trailingZeroDecimal[1];

  if (/e\+?\d+$/i.test(raw)) {
    throw new Error(
      `serial number "${raw}" is in scientific notation — Excel has already destroyed ` +
        'precision. Re-export the source with the column formatted as Text.'
    );
  }
  if (/[,\s]/.test(raw)) {
    throw new Error(`serial number "${raw}" contains separators or whitespace`);
  }
  throw new Error(`serial number "${raw}" is not an integer string`);
}
