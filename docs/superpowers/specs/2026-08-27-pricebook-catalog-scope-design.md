# Pricebook scoping and Not-for-Sale filtering in the product catalog

Design, 2026-08-27. Verified against the **testing** sandbox on 2026-08-27; staging could not be
read (see "The staging gap" below, which is the main risk this design manages).

## The requirement, as given

1. Products should be scoped by pricebook: choose a pricebook first, then display its products.
2. Display a product only if "Not for Sale" is unticked / false.

## What the org actually says

Two things turned up while checking field names that change what the requirement can mean. Both are
recorded here because either one, implemented literally, would break a real load.

### The "Not for Sale" flag is commercial, and this app is not selling anything

The field is `Not_for_Sales__c` on `Product2` — plural *Sales*. It is a checkbox: among active
products in testing, 604 are `false` and 128 are `true`.

The problem is which products carry it:

| Series | ProductCode | `Not_for_Sales__c` | Why it matters |
|---|---|---|---|
| VBUS | `VDI2L001` | **true** | The SKU on the real accepted VBUS initial-load sheet — `vbus-initial-load.json`'s recorded default, and the SKU in the 100-row byte test |
| VBUS | `ACCVR4NVHDATARDR` | true | |
| DHUB | `ACCDR2DHUBXV2` | true | |
| D210 | `K1E131AUSSI00YAS-R` + 9 more | true | All `-R`, i.e. refurbished |
| D215 | `K2I131CANSI10YAS-R` + 8 more | true | All refurbished or `EI` variants |

"Not for Sale" means *do not quote or sell this item*. It does not mean *do not ship it*. Refurbished
units, warranty replacements and end-of-life stock are all things this app legitimately loads and
nobody sells. Requirement 2 applied as a hard filter makes the VBUS initial load unpickable.

**Decision: hide non-sellable SKUs by default, with a visible toggle to show them** — the same shape
as the existing `Show all N` escape hatch, and for the same reason recorded in `CLAUDE.md`: the
picker must never leave the operator facing a list it will not let them get past.

### Pricebook scoping is not a pure narrowing

Standard Price Book holds **210** active serialized entries against the picker's current ~170, and
includes series no `catalogFilters` rule covers at all: `AT700`, `TT603`, `KFOB`, `SPEAKER`, `DR-20`,
`DR-40`, and nine `EXCAM-*` variants. So a pricebook changes the population in both directions
rather than only shrinking it, and cannot be reasoned about as a filter on top of today's catalog
without saying which filter wins.

Per-book counts in testing:

| Pricebook | Active serialized entries | …and `Not_for_Sales__c = false` |
|---|---|---|
| Standard Price Book | 210 | 148 |
| Netradyne CPQ | 148 | 99 |
| India Sales | 20 | 14 |

Feasibility is fine, though: every family this app loads has its SKUs present in at least one
pricebook, and Haptic's `ACCAM1HAPTICMDL` is in 8 of them despite being flagged
`Product_Serialized__c = 'No'` in testing. Pricebook scoping does not lose Haptic.

Testing holds 24 pricebooks: 18 active, 6 inactive, 1 standard.

## Decisions

| Question | Decision |
|---|---|
| Non-sellable SKUs | Hidden by default, with a `Show non-sellable` toggle |
| Filter precedence | Family rules narrow first; pricebook narrows within the family |
| Persistence | View filter only — never written to the run, never reaches a CSV |
| Which books offered | The 18 `IsActive` books, standard first |
| Default selection | "All price books" (today's behaviour); the operator opts in to a book |

The last is a deliberately loose reading of "choose pricebook first". Defaulting to Standard Price
Book would silently change which SKUs are on offer the first time anyone opens the page, because
Standard's serialized population differs from today's catalog. The selector is presented first in
reading order; it is not a mandatory gate.

## Approach

**Two cached queries, both filters pure and in memory.**

Rejected alternatives:

- **A single semi-join SOQL per book** (`Product2 WHERE Id IN (SELECT Product2Id FROM
  PricebookEntry …)` plus a `Not_for_Sales__c = false` clause). One query, but the cache key becomes
  `env:pricebook:sellability`, so every toggle and every book switch is a fresh round trip against
  an 860k-row org, and the filtering moves into SOQL where it cannot be unit-tested.
- **Sourcing the catalog from `PricebookEntry` instead of `Product2`.** Closest to the literal
  requirement, but `fieldsOn(env, 'Product2')` would no longer describe the FROM object, so the
  field-intersection guard that exists *because* of the staging `L1_Product_Family__c` outage would
  stop applying cleanly. Highest exposure to the one failure mode this codebase has already suffered.

The chosen approach keeps `Not_for_Sales__c` inside the existing `has()` intersection in
`buildCatalogSoql`, so an org missing the field simply does not name it rather than failing the whole
query.

## Server design

All SOQL stays in `sf-client.js`; all narrowing stays pure in `catalog-filter.js`. This follows the
existing split and keeps every new decision testable with plain objects.

### `services/sf-client.js`

- Append `{ api: 'Not_for_Sales__c' }` to `CATALOG_FIELDS` — **optional**, not `required`, so it
  passes through the same `has()` filter as every other custom field.
- Map it onto each catalog row as `notForSale`, using the tri-state rule below.
- `fetchPricebooks(env)` —
  `SELECT Id, Name, IsActive, IsStandard FROM Pricebook2 WHERE IsActive = true ORDER BY IsStandard DESC, Name`.
- `fetchPricebookProductIds(env, pricebookId)` —
  `SELECT Product2Id FROM PricebookEntry WHERE Pricebook2Id = '<id>' AND IsActive = true`,
  returning a `Set` of ids. Id-only, so the URL stays far inside `QUERY_URL_LIMIT`, and `query()`'s
  existing pagination covers a book larger than one page.

`pricebookId` is interpolated into SOQL, so it is validated as a Salesforce id
(`/^[a-zA-Z0-9]{15,18}$/`) and refused otherwise — the same reasoning as `safeSeries`: a value that
could terminate the literal is dropped rather than escaped.

### `services/catalog-filter.js`

Two pure functions beside `filterCatalogByFamily`:

- `filterCatalogByPricebook(products, memberIds)` — intersection on `product.id`. A `null` or empty
  `memberIds` returns every product with `applied: false` and a reason, never an empty list.
- `filterCatalogBySellability(products, { includeNonSellable })` — drops rows whose `notForSale`
  is exactly `true`. Rows with `notForSale === null` are **never** dropped.

Both return `{ products, total, applied, reason }`, matching `filterCatalogByFamily`'s existing shape
so the route can compose them uniformly. `filterCatalogBySellability` additionally returns
`hidden` (how many rows it dropped) and `unknown` (`true` when any input row had
`notForSale === null`), because the UI has to report both and neither can be recovered from
`total` alone once two other filters have already run.

### `routes/catalog.js`

- New `GET /api/catalog/pricebooks?env=` → `{ pricebooks: [{ id, name, isStandard }] }`.
- `GET /api/catalog/products` accepts `pricebookId` and `includeNonSellable`. Both are query strings,
  so `includeNonSellable` is read as `=== 'true'`, matching the existing `refresh` parameter.

Narrowing order is **family → pricebook → sellability**. Each filter therefore reports counts
relative to what the filter before it passed through: `sellability.hidden` is the number hidden
*within the chosen family and book*, not across the org. This is what makes the UI note
(`18 hidden as Not for Sale`) true of the table the operator is looking at.

`catalogTotal` keeps its current meaning — the catalog before **any** narrowing — so `Show all N`
continues to mean "drop every filter", not "drop only the family rule".

The response reports each narrowing separately rather than collapsing them into one flag, because
with three filters stacked the UI has to be able to say *which* one emptied the table:

```
{
  total, catalogTotal, family, filterApplied, filterReason,   // unchanged
  pricebook:   { id, name, applied, reason },
  sellability: { applied, hidden, unknown },
  counts, products
}
```

### Caching

`catalogCache` stays keyed by `env` and unchanged — one `Product2` query per org, as today. Two new
caches on the same 10-minute TTL:

| Cache | Key |
|---|---|
| pricebook list | `env` |
| pricebook membership | `env:pricebookId` |

Because `notForSale` is a field on the row, toggling `includeNonSellable` re-filters in memory and
issues **no query at all**.

### Two degradation rules

Both are existing precedent in this codebase, not new inventions.

**`notForSale` is `null`, not `false`, when the describe does not report the field.** The sellability
filter then hides nothing and reports `unknown: true`. An unknown must never manufacture a
conclusion — the same rule `positionInChain` follows when it cannot place a sync status. Worst case
the picker shows too much, which costs a search; the alternative shows nothing, which stops the run.

**A failed or empty membership query falls back to unscoped**, with the reason reported verbatim —
never an empty table. This is `filterCatalogByFamily`'s existing contract and the reason `showAll`
exists.

### The staging gap

`Not_for_Sales__c` is confirmed on `Product2` in **testing** only. The staging describe was
unreadable on 2026-08-27 (expired session), so its presence there is **unverified**.

This is the specific risk the design is built around. `CLAUDE.md` records that
`L1_Product_Family__c` does not exist on `Product2` in staging, and because SOQL is all-or-nothing on
its SELECT list, naming it failed the *entire* catalog query and the picker showed nothing for every
family. Routing `Not_for_Sales__c` through `has()` means the worst case in staging is that the flag
cannot be read and nothing is hidden — reported, not silent.

**Action before release:** re-run the describe against staging and record the result here.

## UI design

A new `Sheet` titled `Price book` above the existing `Family` sheet in `PickerPage.jsx`, so reading
order matches "choose the book, then see the products".

### The selector control, and one departure from a documented rule

`CLAUDE.md` states `Segmented` is "every *pick one of these*", and there is no `<select>` anywhere in
the app today. But `Segmented` renders a flat row of buttons, and 18 books — including
`Partner Price Book - Teletrac North America` — are unusable that way.

**Decision: introduce a native `<select>`,** styled to match existing form controls, and amend
`CLAUDE.md` to record the boundary: `Segmented` for small mutually-exclusive sets the app itself
defines; a select for long lists the org supplies.

### Notes and escape hatches live in `CatalogScope`

`CatalogScope` already owns "which narrowing applied, why, and how to get past it". It gains two
lines beside the family one, rather than sibling components — otherwise three filters would each
explain themselves in a different voice:

- `18 hidden as Not for Sale` + a `Show non-sellable` button, mirroring `Show all N`.
- When a book narrowed the list: `Showing the 6 Driveri devices in Standard Price Book`.

### Two wording rules

- **Pricebook names are literal org values.** `Standard Price Book` keeps its own case and never
  becomes a `Sheet` eyebrow; the eyebrow stays `Catalog`. Re-casing a value the org owns is the class
  of error this app exists to prevent.
- **When the flag cannot be read, say so.** The note must not render `0 hidden`, which would falsely
  claim every product is sellable.

Per the Explainer rules: these are live data and conditional state, so they do not fold.

## Testing

All new logic is pure and runs offline, consistent with the rest of the suite. No Salesforce-dependent
tests are added; the probes used to verify field names stay out of the repo.

**`services/catalog-filter.test.js`** (extends the existing 34):

- membership intersection keeps only products in the book
- `null` / empty membership falls back to every product with `applied: false`
- sellability drops `notForSale === true`
- sellability keeps `notForSale === false`
- **sellability keeps `notForSale === null` and reports `unknown`** — the staging guard
- `includeNonSellable: true` keeps everything and reports `applied: false`
- family → pricebook → sellability compose without either losing the other's reason

**`services/catalog-query.test.js`** (extends the existing 12):

- `Not_for_Sales__c` is named when the describe reports it
- it is **not** named when the describe omits it
- its absence does not disturb the serialized gate or the series widening
- `IsActive = true` is still never dropped

**`routes/catalog.js`**: an invalid `pricebookId` is refused rather than interpolated.

## Out of scope

`csv-builder.js`, the run shape, and the send path are untouched. The pricebook is a view filter and
never reaches a generated file, so byte contracts and the nine descriptors currently under byte
verification are unaffected.

Not addressed here: whether the `Not_for_Sales__c = true` SKUs this app loads (`VDI2L001`,
`ACCDR2DHUBXV2`, `ACCVR4NVHDATARDR`) should have that flag cleared in Salesforce. That is an org data
question for the maintainer, not a code change. The toggle keeps them reachable either way.
