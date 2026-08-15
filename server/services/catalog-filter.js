/**
 * Narrowing the serialized product catalog to one product family.
 *
 * Filtering is on **`Product_Series__c` — the org's "L3 Product Series"** — because it is the only
 * field that names a product line exactly: `DHUB`, `DMS`, `VBUS`, `D810`, `HAPTIC`, and the
 * D-series that make up Driveri. `Device_Type__c` cannot do this job: it calls every Driveri model
 * *and* Octo `Driveri`, so the two families are indistinguishable under it.
 *
 * Driveri is declared as "every `L1_Product_Family__c = Device` except series `D810`" rather than a
 * list of its seven current series. The D-series gain models regularly, and a list would silently
 * omit each new one — a SKU missing from its own family, with nothing to indicate it. The exclusion
 * of D810 is what keeps Driveri and Octo disjoint while together covering every device.
 *
 * The one behaviour every path preserves: **this never returns an empty catalog because a rule
 * matched nothing.** A rule goes stale the moment the org renames a series, and hiding every SKU
 * would stop the operator working, where showing too many only costs them a search. Falling back is
 * always the cheaper failure.
 */

/**
 * @param {Array<object>} products  rows as `fetchSerializedCatalog` returns them
 * @param {string|null} family      the family selected in the picker
 * @param {object} filters          `catalogFilters` from config/profiles.json
 * @returns {{products: Array<object>, total: number, filterApplied: boolean, reason: string|null}}
 */
export function filterCatalogByFamily(products, family, filters = {}) {
  const all = Array.isArray(products) ? products : [];
  const unfiltered = (reason) => ({ products: all, total: all.length, filterApplied: false, reason });

  if (!family) return unfiltered(null);

  const rule = filters?.[family];
  // An absent rule and one that matched nothing are different claims, and are reported separately:
  // the first means nobody has said what this family covers, the second that the org holds no such
  // product. Only one of them is a config problem.
  if (!rule || !hasCriteria(rule)) return unfiltered('no-filter-declared');

  if (!all.length) return { products: [], total: 0, filterApplied: false, reason: 'empty-catalog' };

  const matched = all.filter((p) => matches(p, rule));
  if (!matched.length) return unfiltered('no-matches');

  return { products: matched, total: all.length, filterApplied: true, reason: null };
}

/**
 * Every L3 series a family rule positively names.
 *
 * The catalog query is `Product_Serialized__c = 'Yes'`, which is right for almost everything —
 * but not for Haptic. Its only product, `ACCAM1HAPTICMDL` "Haptic Feedback Module", is active and
 * flagged **`Product_Serialized__c = 'No'`**, while this app mints a `serial_number` series for it
 * and loads it through a verified `Haptic_Initial_Load.csv`. The org's flag and the sheets
 * disagree, and the sheets are what the Apex parser has actually accepted.
 *
 * So the query widens to exactly the series a family rule names — and nothing else. Dropping the
 * serialized filter outright would pull in 555 more products that no template can load.
 *
 * `excludeSeries` deliberately does not contribute: naming a series to keep *out* is not a reason
 * to fetch it.
 */
export function declaredSeries(filters) {
  const out = new Set();
  for (const rule of Object.values(filters ?? {})) {
    if (!rule || typeof rule !== 'object') continue;
    for (const s of Array.isArray(rule.series) ? rule.series : []) {
      if (s) out.add(String(s));
    }
  }
  return [...out];
}

const CRITERIA = ['series', 'excludeSeries', 'l1Family', 'category', 'deviceType'];

function hasCriteria(rule) {
  return CRITERIA.some((k) => Array.isArray(rule[k]) && rule[k].length);
}

function matches(product, rule) {
  // Each positive criterion must hold. A row missing the field a rule names can never satisfy it —
  // unclassified is not universal, and the nine seriesless products in this org must not leak into
  // every family.
  if (!satisfies(rule.series, product.productSeries)) return false;
  if (!satisfies(rule.l1Family, product.l1Family)) return false;
  if (!satisfies(rule.category, product.productCategory)) return false;
  if (!satisfies(rule.deviceType, product.deviceType)) return false;

  if (Array.isArray(rule.excludeSeries) && rule.excludeSeries.length) {
    if (product.productSeries && includesLoosely(rule.excludeSeries, product.productSeries)) {
      return false;
    }
  }

  return true;
}

function satisfies(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  if (!value) return false;
  return includesLoosely(list, value);
}

/** The org spells series in its own case; a rule written `dhub` should not quietly match nothing. */
function includesLoosely(list, value) {
  const wanted = String(value).toLowerCase();
  return list.some((entry) => String(entry).toLowerCase() === wanted);
}
