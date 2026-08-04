/**
 * SKU code decoding (spec section 8).
 *
 * Positional and stable across all 136 hardware SKUs:
 *
 *   K2I1 31 USA SI 10 FAS
 *   │    │  │   │  │  └─ suffix / variant
 *   │    │  │   │  └──── option flags   <-- NOT a quantity or pack size
 *   │    │  │   └─────── sensor variant: SI | SS | DI
 *   │    │  └─────────── region
 *   │    └────────────── storage: 31 = 100 hours, 32 = 200 hours
 *   └─────────────────── model family
 *
 * The point of this module is to render "D-215 · 100 h · US" in the picker so nobody has
 * to read B3E231USASI0210S by eye.
 *
 * It deliberately does NOT export anything that turns a SKU into a quantity. The old
 * automation derived a "pack factor" from the digits after USASI, which are option flags:
 * sibling SKUs B3E231USASI0000S / 0010S / 0100S would yield 0, 10 and 100 for physically
 * comparable single cameras. Quantity comes from OrderItem.Quantity, never from the code.
 */

const MODEL_FAMILIES = {
  K1E1: 'D-210',
  K1E2: 'D-210',
  K0E1: 'D-211',
  K0E2: 'D-211',
  K2I1: 'D-215',
  'DRI-': 'D-410',
  B2E2: 'D-430',
  DRI4: 'D-430',
  B3E1: 'D-450',
  B3E2: 'D-450',
  B3E3: 'D-450',
  DEB4: 'D-470 / D-475',
  DE81: 'D-810',
};

const STORAGE = {
  31: '100 hours',
  32: '200 hours',
};

const REGIONS = {
  USA: 'United States',
  CAN: 'Canada',
  MEX: 'Mexico',
  IND: 'India',
  EUK: 'Europe / UK',
  AUS: 'Australia',
  NWZ: 'New Zealand',
  MEA: 'Middle East / Africa',
};

const SENSOR_VARIANTS = {
  SI: 'Single, internal',
  SS: 'Single, external',
  DI: 'Dual, with DMS',
};

const SUFFIXES = {
  S: 'Standard',
  'S-R': 'Refurbished',
  N: 'No mount',
  AMZ: 'Amazon',
  FAS: 'FAS',
};

/**
 * @param {string} code a ProductCode such as 'K2I131USASI10FAS'
 * @returns {{ code: string, model: string|null, storage: string|null, region: string|null,
 *            regionCode: string|null, sensor: string|null, optionFlags: string|null,
 *            suffix: string|null, summary: string, decoded: boolean }}
 */
export function decodeSku(code) {
  const raw = String(code ?? '').trim();
  const unknown = {
    code: raw,
    model: null,
    storage: null,
    region: null,
    regionCode: null,
    sensor: null,
    optionFlags: null,
    suffix: null,
    summary: raw,
    decoded: false,
  };
  if (raw.length < 12) return unknown;

  const familyKey = raw.slice(0, 4).toUpperCase();
  const storageKey = raw.slice(4, 6);
  const regionKey = raw.slice(6, 9).toUpperCase();
  const sensorKey = raw.slice(9, 11).toUpperCase();
  const rest = raw.slice(11);

  const model = MODEL_FAMILIES[familyKey] ?? null;
  const storage = STORAGE[storageKey] ?? null;
  const regionCode = REGIONS[regionKey] ? regionKey : null;
  const region = REGIONS[regionKey] ?? null;
  const sensor = SENSOR_VARIANTS[sensorKey] ?? null;

  // Option flags are the leading digits of the remainder; the suffix is what follows.
  const split = rest.match(/^(\d*)(.*)$/);
  const optionFlags = split?.[1] || null;
  const suffixRaw = split?.[2] || null;
  const suffix = suffixRaw ? (SUFFIXES[suffixRaw.toUpperCase()] ?? suffixRaw) : null;

  if (!model && !storage && !region) return unknown;

  const summary = [model, storage, region, sensor && sensorKey, suffix]
    .filter(Boolean)
    .join(' · ');

  return {
    code: raw,
    model,
    storage,
    region,
    regionCode,
    sensor,
    optionFlags,
    suffix,
    summary: summary || raw,
    decoded: Boolean(model || storage || region),
  };
}

/**
 * Rank catalog entries against a free-text query over both the raw code and its decoded
 * meaning, so "D-450 200 hours canada" matches B3E232CANSI....
 */
export function scoreSkuMatch(product, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 1;

  const decoded = decodeSku(product.ProductCode);
  const haystack = [
    product.ProductCode,
    product.Product_SKU__c,
    product.Name,
    product.Device_Type__c,
    product.IDMS_Device_Type__c,
    product.Family,
    decoded.model,
    decoded.storage,
    decoded.region,
    decoded.sensor,
    decoded.suffix,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Every whitespace-separated term must appear somewhere. Hyphens are noise in practice
  // ("D450" should find "D-450"), so compare a de-hyphenated copy too.
  const flat = haystack.replace(/-/g, '');
  const terms = q.split(/\s+/);
  let score = 0;
  for (const term of terms) {
    const bare = term.replace(/-/g, '');
    if (haystack.includes(term) || flat.includes(bare)) score += 1;
    else return 0;
  }
  if (String(product.ProductCode ?? '').toLowerCase() === q) score += 10;
  return score;
}
