# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user app that replaces the manual CSV-and-email steps of the Netradyne device
fulfilment flow: pick product families/SKUs/quantities, generate byte-exact CSVs, email each one
to the right distribution list, watch Salesforce Assets converge, hand back the ids that loaded.

Salesforce is **read-only** here (`server/services/sf-client.js` has no writes). The only way
anything changes in the org is an email with a CSV attached — which is why the destination mailbox
and the CSV bytes are the two things the code guards hardest.

## Read this first: the suite is red and three guards are off

This file was accurate at `e5c790d`. Five merges landed after it (the Octo, RMA Returned and DEAD
work, `b78af52`…`20912a9`) without updating the tests or the docs, and the sections below have been
re-checked against `20912a9`. Three of the app's own safety mechanisms are currently not doing their
job. None of them will announce itself, so know about them before you change anything nearby:

1. **`operationChain()` is truncated to `[initialLoad, dataUpdate]`** by a self-loop added to
   `config/lifecycle.json`, so the ahead/behind reasoning that stops a device being reported as
   loaded is disabled for `shipmentUpdate` and `received`. Fails conservatively today, but only
   because a numeric fallback happens to cover it. See "Known defect" under the life cycle section.
2. **16 of 19 templates have no byte-level verification** — seven point at source sheets that do not
   exist, ten fail on a stale test helper. Any change to `csv-builder.js` or a descriptor is
   unverified. See "Test state".
3. **`faultyReturned` and `rmaReturned` route to the identical testing mailbox**, and no test catches
   it because the assertion that would throws earlier. See "Routing".

The counts in this file (19 descriptors, 27 transitions, 153 tests) are what the repo actually holds;
`README.md` and `templates/README.md` still describe 13 templates and are not reliable on numbers.

## Commands

```bash
npm install                  # deps + the Chromium that drives the Salesforce/Outlook logins
npm run dev                  # server :4317 (node --watch) + Vite UI :5317 (proxies /api), opens browser
npm run dev:server           # server only
npm test                     # 153 tests in 3 files — see "Test state" below, 45 currently fail
npm run build && npm start   # single-process production mode on :4317 (Express serves dist/)
```

Single test file / single test:

```bash
node --test server/lib/config.test.js          # 18 tests, 12 pass / 6 fail — DL routing, mailbox confusability
node --test server/lib/lifecycle.test.js       # 51 tests, 45 pass / 6 fail — stage graph, classify, next-step
node --test server/services/templates.test.js  # 84 tests, 51 pass / 33 fail
node --test --test-name-pattern "byte contract" server/services/templates.test.js
```

Node's runner prints its tallies with an `ℹ` prefix (`ℹ tests 69`), not TAP `#`, so grep for `ℹ`.

### Test state — 45 failures are pre-existing, not yours. But six of them are a real bug.

**All three test files currently fail.** The suite was last green at `e5c790d`; the five merges
after it (`b78af52`…`20912a9`, the Octo/RMA/DEAD work) broke it and the tests were not updated.
Before debugging a failure, place it in one of these four buckets:

**1. `lifecycle.test.js` — 6 failures. This is a live defect, not stale tests.** See
"The `dataUpdate` self-loop truncates the operation chain" below. Do not "fix" these by editing
the assertions; they are correctly reporting that `operationChain()` no longer reaches
`shipmentUpdate` or `received`.

**2. `config.test.js` — 6 failures, all expected consequences of deliberate routing changes.**
The tests encode the old routing table and nobody updated them:
- `dataUpdate` was given initialLoad's mailbox in both environments (it was `REPLACE_ME` before),
  so the "no two operations share an address" and "placeholder blocks only its own pipeline"
  assertions now trip. This sharing is intentional — see "Routing" below.
- `octo-update-load` was renamed to `octo-data-update` and re-declared as `operation: dataUpdate`,
  so `updateLoad` now has **no template in any family** and the two Octo tests naming
  `updateLoad`/`shipmentUpdate` are asserting against a layout that no longer exists.
- The mailbox-only list moved from `[deviceDead, faultyReturned, nonRepairable, undoDead]` to
  `[faultyReturned, nonRepairable, undoDead, updateLoad]` — `deviceDead` gained `device-dead.json`,
  `updateLoad` lost its sheet.

**3. `templates.test.js` — 16 failures: seven descriptors point at source sheets that do not
exist.** It regenerates each real DL sheet from its descriptor and asserts byte equality, reading
from `~/BSG/DL Template` (override with `DL_TEMPLATE_DIR`). The folder holds 15 sheets. These
`sourceTemplate` values are not among them, so header + bytes hard-fail with ENOENT:

| Descriptor(s) | Declared `sourceTemplate` |
|---|---|
| `octo-initial-load`, `octo-data-update`, `octo-shipment-update` | `Octo Shipment update.csv` |
| `dhub-shipment-update` | `DHUB_Shipment_Load_02.csv` |
| `dms-shipment-update` | `DMS_Shipment_Update_01.csv` |
| `vbus-shipment-update` | `VBUS_Initial_Load RTS120013 (4) 1 (1).csv` |
| `rma-returned` | `Retured_RMA.csv` |

Two things worth noticing. All three Octo descriptors name **one** sheet — a shipment-update sheet —
even for initial load and data update, while the folder does contain `Octo Initial Load
NAZ110001.csv` and `Octo Update Load NAZ110001.csv`. The likeliest reading is that the
`sourceTemplate` values are wrong, not that the sheets are missing. Separately, `device-dead.json`
declares **no `sourceTemplate` at all** yet carries `status: "verified"` — it has never been checked
against a real sheet, so "verified" overstates it. The skip guard is **folder-level only**: a
missing individual sheet is not skipped.

**4. `templates.test.js` — the remaining failures: the harness never caught up with `line.sku`.**
`rowsFromSamples` (line 39) builds rows as `{ generated, line: {} }`, but 14 descriptors read
`sku_number` from `line.sku`. Every round-trip and builder test using that helper throws
`Template column "sku_number": line.sku is not available`. Production is unaffected —
`planGeneratedRows`/`planWizardRows` attach the real line. One more stale test rides along here:
`every filename placeholder is one the builder can fill` asserts `p === 'trackingId'`, but
`renderFilename` has supported `{family}` since `33792d3`. It fails on `device-dead` (alphabetically
first) and so never reaches `received-load`, which uses `{family}` legitimately.

**Only 3 of the 19 descriptors now have complete byte-level verification** — `haptic-data-update`,
`order-load` and `partner-order-load`. It was 4 of 16; `received-load` lost its round-trip test to
bucket 4. **Treat any change to `csv-builder.js` or a descriptor as unverified**, and prefer fixing
`rowsFromSamples` first — one helper restores coverage on ten descriptors at once.

Also check for `skipped` in the summary: on a machine without the sheet folder the whole suite
self-skips and reports green. Node counts `describe` blocks alongside tests in its `✖` list, so the
failing-name list looks longer than 45.

## Architecture

Two processes in dev, one in prod. `server/` is ESM Node + Express; `web/` is React 18 + Vite with
no router and no state library — `web/src/App.jsx` holds all shared state and switches on a `page`
string, passing one `shared` prop bag to each page. `web/src/api.js` is the only place that talks
HTTP.

### The look, and the two rules it enforces

Pale blue `#EFFAFD` field, white surfaces, deep navy ink, royal blue `#4A8BDF`, eggplant `#A0006D`.
Three roles kept deliberately apart: **navy** is structure and the primary action (headings, filled
buttons), **royal blue** is interaction (links, focus, selection, the operator's own path on the
life cycle map), **eggplant** is the highlight, used sparingly — where you are *right now*: the
active step marker, the current stage ring, the run's state cell, the rule under a page title.

Royal blue appears literally at `#4A8BDF` wherever it is a fill, a stroke or a large shape.
`--accent` is the same hue deepened to clear 4.5:1 for small text and thin borders; `#4A8BDF` as
body text is 3.0:1 and would fail.

Every colour and face comes from tokens at the top of `web/src/styles.css`, under two themes set on
`<html data-theme>`: `light` (default) and `dark`, picked in the rail and remembered in
`localStorage`. Light is the default deliberately, so the palette never depends on an OS setting.
Plus Jakarta Sans carries display and UI — set very bold and tight for headings; **IBM Plex Mono is
reserved for data that has to align**: ids, filenames, byte counts, hex, sync statuses. Both load
from Google Fonts in `web/index.html` and fall back to system faces offline. Pages hard-code no
colour — `var(--ok|--warn|--fail|--accent)` are the only vars referenced inline.

The life cycle map borrows the palette's own logic: Install Check stages are royal blue, Customer
stages eggplant, which is also what the two account types mean.

Shared document primitives are in `web/src/components/ui.jsx`: `PageHead` (step marker, title,
double rule), `Sheet` (panel with a ruled head, `live` adds the polling scanline), `Segmented`
(every "pick one of these"), `KeyValue`, `Explainer`, plus `Badge` / `Callout` / `Stat` / `Field`.

**Explanation folds; state does not.** Every screen's reasoning lives in an `<Explainer>` — a native
`<details>`, closed by default, **at most one per panel**. Native because it needs no state and the
browser's find-in-page still reaches the text while collapsed. What goes in it is prose that reads
the same on every visit. What must stay visible, and is the distinction to apply when adding
anything:

- **`Callout`s never fold.** They are conditional state — session expired, MFA prompt, login failed,
  a pipeline with no mailbox. Folding one hides the thing you have to act on.
- **Live data never folds**, even when it is written as a sentence: Watch's "sent to *X* at *Y*,
  waiting for *Z*", its "this is a snapshot, click Refresh" staleness warning, Picker's "catalog
  unavailable" fallback, the per-stage notes on the Life cycle page.
- **Instructions that prevent a bad load never fold** — Review's "the row count must equal the
  order's serialized quantity" is invariant #1 wearing a sentence.
- **Affordances never fold**: without "click a stage", the life cycle chart reads as a picture.

Eyebrows are labels, not slogans. `Step 03 · Manifest`, `Routing`, `Catalog`, `Stage` — a noun
phrase or a step marker, or a live value (`Stage 4`, `12 run(s) · Testing`). Ten eyebrows that were
sentences (`The only way the org changes`, `One family, one file, one email`) were removed; each sat
above a title that already said what the panel was. The persistent
`Runbar` in `App.jsx` shows the same seven fields on every page and starts them as `—`, so the strip
doubles as the progress record.

**Operation and Units follow the page, not the run.** Review and Watch each own an operation
selector and report it up through `setActiveOperation`; `goto` clears it, so a page without one
falls back to the run's own operation. Units counts the devices in that operation's *generated
file* when one exists — a shipment update raised for a subset reads as that subset — and the run's
planned total before anything is generated. The tooltip always says which of the two you are
reading, because the numbers legitimately differ.

- **Eyebrow labels are uppercased; literal strings are not.** A filename, a column name like
  `device_id`, a config path, or a status like `INITIAL_DEVICE_LOAD_SYNC_FAILED` keeps its own
  case — use `.group-label`, `th.raw`, or `<Field raw>`, and never pass one to a `Sheet`'s
  `eyebrow`. Re-casing a value the Apex parser cares about misreports it, which is exactly the
  class of error this app exists to prevent.
- **The destination mailbox is the loudest thing on Review** (`.dest`). It is the only marker of
  which operation a file represents, so it outranks the filename and the byte counts. The
  send-without-review button is `danger outline`, not a solid block — a red slab beside the safe
  action pulls the eye toward the send you did not want.
- **The send button carries the whole lifecycle**, in place: `Compose in Outlook` → `Working…` →
  `Awaiting your Send…` → `✓ Sent`. It stays busy through the Sent Items confirmation, not just
  the compose, because a compose-and-stop is still in flight until then and a live button invites
  a second click that composes the same file again. `Awaiting your Send…` matters most: without it
  the card reverts to its idle label the moment the compose window opens, reading as "nothing
  happened" while a real message sits open in Outlook. Re-send carries the same states — a
  re-compose over an already-sent file is the same flow.
- **A composed-but-unsent message lives on the run**, as `run.pendingCompose`, not in page state.
  It is a real email sitting open in Outlook; holding that fact in a component means a refresh or
  a trip to another page silently loses it. The panel offering "check Sent Items" and "discard" is
  rendered from the run, so it survives navigation and a server restart. It is cleared by a
  recorded send, a confirmation, or discarding the window — and **never** written into `run.sends`,
  since a compose-and-stop is not a send and recording it would arm the duplicate guard against
  the real send that has not happened yet.

### The run pipeline

A **run** is one trip through the flow, keyed by a user-supplied `trackingId` (not a Salesforce
OrderNumber). Every step writes the run to `data/runs/<runId>.json`, so a refresh, restart, or
mid-poll session expiry never loses ids that were already sent — those exist in the org whether or
not this app remembers them.

```
POST /api/runs                  create: normalise groups, resolve optional order
POST /api/runs/:id/allocate     mint id blocks per (env, template, series), collision-check
POST /api/runs/:id/check-ids    collision-check without minting
POST /api/runs/:id/generate     build CSV bytes per group, persist to data/output/<runId>/
GET  /api/runs/:id/validate     graded checks: blocker | warning
POST /api/runs/:id/send         one email per family, exactly one attachment
POST /api/runs/:id/send/confirm record a compose-and-stop send after the operator sent it
POST /api/runs/:id/mail/close   discard a composed-but-unsent Outlook window
POST /api/runs/:id/poll/:stage/start   server-side Asset polling until every unit settles
POST /api/runs/:id/poll/:stage/stop    stop the loop, keep the snapshot
POST /api/runs/:id/poll/:stage/once    one pass, no loop — what the view tabs refresh with
GET  /api/runs/:id/poll/:stage  the stored snapshot, re-scored at read time
GET  /api/runs/:id/lifecycle    where the devices are on the DLCM chart, and what moves them next
GET  /api/runs/:id/operations   which operations are available on this run, and why not
GET  /api/runs/:id/assets       this run's Assets, plus every Asset sharing its trackingId
GET  /api/runs/:id/result       the headline answer: the ids this run loaded
GET  /api/runs/:id/preview/:key | /download/:key | /eml   generated bytes, as text, file, or message
GET  /api/catalog/lifecycle     the stage graph itself, with every operation placed on it
GET  /api/catalog/templates     descriptors as the UI sees them, incl. mailbox-only operations
```

`/assets` is the one read that deliberately looks *outside* the run: `allForTrackingId` answers
"what else is attached to this order number", which is how a device loaded by an earlier run under
the same tracking id becomes visible. `counts.attachedToOrder` is the subset carrying a `cpqOrderId`.

`GET /api/runs?env=` scopes the History page to one environment, filtered **before** the limit so
a 50-run page is 50 runs of that org. Testing and staging ids are indistinguishable by eye — a
10-digit hub id looks the same from either — so the two histories are never interleaved.

Cursors are inspectable and editable per run: `GET /:id/cursors`, `POST /:id/cursors/set`
(`{templateId, seriesName, value}` — numeric series only, refuses to exceed the declared digit
width) and `POST /:id/cursors/reset`. The Ids page exposes `set` as a "Set to…" box per series;
it is the escape hatch for when the org and `data/counters.json` have drifted apart.

A run holds **groups**; one group = one product family = one template = one CSV = one email. Two
families never share a message even when they route to the same mailbox. Artifacts and sends are
keyed `"<operation>:<family>"` because one family can hold files for several operations at once.

Ids are minted **once**, from the family's initial-load template, and reused by every later
operation on the same devices — a shipment update that invented fresh ids would update nothing.

### Chaining: one run walks several operations, over a shrinking subset of its own devices

`POST /:id/generate` accepts an optional `deviceIds` array, and every row planner honours it —
generated rows are filtered on their primary series, existing-device rows on the id itself. The
Watch page is what produces those subsets: it polls a stage, then offers the *next* operation over
exactly the rows that settled. The eligibility filters live in `WatchPage.jsx:212-290`:

```
initialLoad polled    → IDMS -2 + INITIAL_DEVICE_LOAD_SYNC_SUCCESS or DATA_UPDATE_SYNC_SUCCESS,
                         every accessory synced → offer shipmentUpdate, or the family's owed
                                                   step first (Octo → dataUpdate)
dataUpdate polled      → IDMS -2 + DATA_UPDATE_SYNC_SUCCESS (if owed) or either status (if not),
                         every accessory synced → offer shipmentUpdate
shipmentUpdate polled  → IDMS -1 + SHIPMENT_UPDATE_SYNC_SUCCESS               → offer received at 3PL
rmaReturned polled     → IDMS 7                                               → offer Mark Dead
```

Note the first two lines: since `73fe338` a device may reach shipment-update eligibility from
*either* initial load or data update — the point of the Octo detour, since Octo needs the data
correction before shipping and other families skip it. Requiring the device to specifically carry
`DATA_UPDATE_SYNC_SUCCESS`, rather than either status, is scoped to `stage === 'dataUpdate'` alone
(`WatchPage.jsx:265`). Applying it on the initial-load tab too — which is what the plan first
specified — leaves an Octo run with zero eligible rows there: those devices carry
`INITIAL_DEVICE_LOAD_SYNC_SUCCESS`, not the data-update status, and `eligibleRows` gates the
selection checkboxes, so no eligible rows means no way to select anything and no hand-off at all.
The initial-load tab reroutes instead: `getNextOperation` sends an Octo selection to `dataUpdate`,
not `shipmentUpdate`, because the family owes that step first — see the life cycle section below.
A device that has actually reached `DATA_UPDATE_SYNC_SUCCESS` never forces the question on the
initial-load tab anyway — it is already `aheadOfStage` relative to `initialLoad` and split out of
that tab's snapshot before `eligibleRows` runs. `eligibleRows` picks the first non-empty of the
three lists, so only one hand-off is ever offered at a time.

This is why a partially-failed load is not a dead end: the ~⅓ that fail stay behind while the rest
move on, on the same ids. Generating for a subset must never re-allocate — it filters rows that
were already minted, which is exactly the property the `deviceIds` filter is protecting.

### The Watch page's two kinds of tab

Watch shows two categorically different things in one tab strip, and confusing them is easy:

- **Stage tabs** — one per pollable operation (`initialLoad`, `dataUpdate`, `shipmentUpdate`,
  `received`, `rmaReturned`: the five keys in `lifecycle.json`'s `syncStatus` map). These have a real
  server-side poll loop, their own snapshot on the run, start/stop/once controls, and the
  ahead/behind split.
- **Asset-view tabs** — `Shipped Active`, `Installed`, `RMA Pending`, `RMA Initiated`, `DEAD`
  (`ASSET_VIEW_TABS`, `WatchPage.jsx:656`). These are **read-only client-side filters over the
  `initialLoad` snapshot** — `filterViewRows` switches on `idmsStatus` and `syncStatus`, and the tab
  refreshes with `pollOnce(runId, 'initialLoad')`. They are not stages, cannot be polled, and have no
  snapshot of their own. A device only appears in one if it is in this run's initial-load device pool.

**Selecting any Watch tab re-reads the org.** The two calls are not interchangeable and the
difference is the whole design: `GET /poll/:stage` returns the **stored snapshot from disk** —
instant, and as old as whatever last queried Salesforce — while `POST /poll/:stage/once` **queries
Salesforce** and writes a new one. Every tab used to do only the first, which is why "Refresh from
org" was effectively mandatory. Activation now does both: it renders the snapshot immediately, then
tops it up in the background and swaps the rows in, so a tab is current without a second click.
Three things suppress the live read, each for its own reason — a server-side poll loop is already
running for that stage and would be raced; the snapshot is newer than `REFRESH_IF_OLDER_THAN_MS`
(15s), so comparing tabs costs one query rather than one per click; or the effect was torn down,
in which case a late response must not land on the tab you moved to. The buttons ignore the
threshold.

**An automatic refresh never raises the error banner.** `onError` is right for a button you pressed
and wrong for a read you did not ask for — an expired session would otherwise shout on every tab
click. A failed top-up degrades to the snapshot plus `could not reach Salesforce · showing
<time>`. That timestamp is not decoration: once refreshing is automatic, it is the only thing
separating fresh rows from a silently failed read, so **any surface that auto-refreshes must show
when it last succeeded.**

The filters, since the mapping is not otherwise written down: `shippedActive` is
`NEW_ORDER_FULFILMENT`/`_SYNC_FAILED`, or IDMS 2 with `_SYNC_SUCCESS`; `installed` is IDMS 4;
`rmaPending` is IDMS 10; `rmaInitiated` is IDMS 5 *excluding* anything already carrying a
`FAULTY_DEVICE_RECEIVED_AT_REPAIR_PARTNER` status; `deadView` is
`NON_REPAIRABLE_BY_REPAIR_PARTNER`/`_SYNC_FAILED`, or `_SYNC_SUCCESS` with IDMS 9.

Only `rmaInitiated` and `deadView` are selectable (`selectable`, `WatchPage.jsx:699`) — they feed the
`rmaReturned` and `deviceDead` generates. The other three views are informational. `DEAD` is
rendered last in the strip deliberately, after the `rmaReturned` stage tab, so the destructive
operation is not adjacent to the ordinary ones.

### Everything format-specific lives in `templates/*.json`

19 descriptors, nominally one per real accepted sheet — though seven now name a sheet that is not
in the folder, so read "Test state" bucket 3 before trusting one. A descriptor owns the column list
and order, each column's value `source`, the byte contract (`bom`, `lineEnding`, `trailingNewline`),
the filename pattern, and the id series it mints. `csv-builder.js` has no knowledge of any
particular format; `validator.js` checks against the descriptor's own declared contract, not a
global rule. Adding a format is a JSON drop-in — see `templates/README.md` for the schema and the
per-sheet quirks.

**Both READMEs are stale on counts.** `templates/README.md` still says "The 13 templates" and
"All 15 source sheets"; `README.md` claims "All 13 headers" and "All 13 byte contracts" match. The
six descriptors added since (`octo-initial-load`, `octo-shipment-update`, `octo-data-update`,
`device-dead`, `rma-returned`, plus the three shipment-update sheets from `33792d3`) are in neither
table, and the byte-contract claim is no longer true — see "Test state".

The families are `driveri`, `dhub`, `dms`, `haptic`, `vbus`, `octo`, plus `shared` for the four
family-agnostic sheets (`received-load`, `order-load`, `partner-order-load`, `device-dead`,
`rma-returned`). Octo arrived after `e5c790d` and is the only family carrying all three of
initial load, data update and shipment update.

`octo-update-load.json` was **renamed** to `octo-data-update.json` and its `operation` changed from
`updateLoad` to `dataUpdate`. That leaves **`updateLoad` with no template in any family** — it is
now a mailbox-only operation, and any code or test still expecting an `updateLoad` sheet is wrong.

Column `source` values are `field.<name>` (shared across the run), `line.<name>` (per SKU line),
`existing.<name>`, `generated.<series>`, `const`, and date helpers. **`sku_number` reads
`line.sku`, not `field.sku_number`** — changed in `33792d3` so one run can carry several SKUs.
15 of the 19 descriptors do this. Any planner that produces rows must therefore attach the line:
`planGeneratedRows`/`planWizardRows` do, `planExistingRows(deviceIds)` defaults `line` to `{}`,
which is only safe because the templates it serves don't reference `line.sku` — the four that
don't are exactly `received-load`, `partner-order-load`, `device-dead` and `rma-returned`. Adding
`line.sku` to any of those four breaks generation at runtime, not just in tests.

There are **four** row planners in `csv-builder.js`, not three: `planGeneratedRows`,
`planWizardRows`, `planExistingRows` and `planDeadRows`. The last takes
`{deviceId, deviceType}` pairs and is the only one that writes a second `existing.*` column —
`device_type`, resolved at generate time from the Asset's `Device_Category__c` through
`resolveDeadDeviceType` (`runs.js:88`), which maps org spellings onto the sheet's vocabulary
(`DRIVER-I` → `Driveri`, `WIRELESS` → `WIRELESS_ALERT_BUTTON`) and **defaults to `HAPTIC` when the
category is absent**. That default is a guess about a physical device; check it before relying on a
Dead file for a mixed batch.

Filenames were standardised in `33792d3` to `<Operation>_<Family>_{trackingId}.csv`
(`Initial_Load_Driveri_B3E110005.csv`). `{family}` is a placeholder `buildCsv` fills from its
`family` argument, used by `received-load`, whose pattern is `Received_At_3PL_{family}_{trackingId}.csv`;
for a shared operation across a mixed run the route passes the **first group's** family, uppercased.

**Two descriptors break that convention by omitting `{trackingId}`**: `device-dead` is
`Dead_{family}.csv` and `rma-returned` is `RMA_Returned_{family}.csv`. Artifacts live under
`data/output/<runId>/`, so this does not collide *across* runs — but within one run two Dead files
for different device subsets share a name, and the invariant below ("a new descriptor whose pattern
collides with an existing one will silently overwrite") applies directly.

`status: "awaiting-template"` means the server refuses to generate or send it. No descriptor
currently carries it — all 19 say `verified` — but the mechanism is live in `isTemplateUsable`.
Treat `verified` on `device-dead` sceptically: it has no `sourceTemplate`, so nothing has ever been
byte-checked against a real sheet.

Three operations (`nonRepairable`, `faultyReturned`, `undoDead`) have a mailbox and no sheet at all,
so they surface as mailbox-only — and `updateLoad` joined them when its sheet was re-pointed at
`dataUpdate`. `deviceDead` left that list by gaining `device-dead.json`.

### Routing lives in `config/environments.json`

Per-environment Salesforce endpoint plus `distributionLists.byOperation` / `.byFamilyOperation`.
Resolution prefers a `"<family>:<operation>"` override, else the operation-level address, and
returns *which rule matched* so the UI can show it. Any value starting with `REPLACE_ME` blocks
sending **for that pipeline only** — an unconfirmed address is safe to leave in the file. Add a
family-specific mailbox only when it differs from the shared one.

Note `initialLoad` and `updateLoad` share testing's mailbox by design (the DL is named "Initial
Load & Update Load"), and staging's `asset_markdead_` / `asset_markundodead_` differ by one word.
`server/lib/config.test.js` asserts these cannot be confused in either direction.

**`dataUpdate` now shares `initialLoad`'s mailbox in both environments.** It was `REPLACE_ME` in
both until the Octo work; it is now `Asset-Shipped-From-MFR-Testing` in testing and
`assets_shipped_from_vvdn` in staging. That makes three operations on one testing address
(`initialLoad`, `updateLoad`, `dataUpdate`) and is what two of the `config.test.js` failures are
about — the test's allowlist still expects two.

**`faultyReturned` and `rmaReturned` are byte-identical addresses in testing** — both are
`assets_returned_to_vvdn@b1m859pz…apex.sandbox.salesforce.com`, same local part *and* same host.
This is not currently asserted anywhere: the "no two operations share an address" test throws on the
`Asset-Shipped-From-MFR-Testing` group first and never reaches this one. Either they are genuinely
one Apex handler and the pairing should be declared deliberate, or one of the two addresses is a
copy-paste and a Faulty Returned sheet is landing in the RMA Returned handler. **Resolve this before
sending either operation** — it is exactly the class of error the local-part matching exists to
catch, and nothing in the suite is guarding it today.

`rmaReturned` is configured in testing only; staging carries
`REPLACE_ME_no_rma_returned_DL_supplied_for_staging`, which blocks that one pipeline and nothing
else. Testing's `deviceDead` was also re-pointed, from `assets_non_repairable_at_repair_center` to
`asset_markdead_emailservice`, so both environments now agree on the local part for marking a device
dead — the "confirm they are the same operation" caveat that used to sit on this entry is resolved.
Its label changed from "Mark dead" to `DEAD`.

### The constant columns live in `config/profiles.json`

Three things the UI would otherwise have to ask for on every run:

- **`profiles`** — named presets for the 12 constant Format A columns (`product_type`,
  `system_pn`, `manufacturing_partner`, `po_number`, …). One preset today, `us-namz-akela`,
  which is `default`. These sit behind an "advanced" disclosure because they don't vary per run
  in the testing sandbox.
- **`picklists`** — Active values read off the Asset describe. The app re-reads them live when
  connected to Salesforce and falls back to this file offline, so an edit here only affects the
  disconnected case.
- **`orderStatus`** — the four status buckets, and the reason `Confirmed` is never a filter:
  `completeStatuses` (`Activated`), `acceptOnReadOnly`, `neverWrite`, and `blockedStatuses`
  (`Partially Shipped`, which drives the warning on Review).
- **`catalogFilters`** — which serialized-catalog rows the Families & SKUs picker shows per family.
  Applied server-side by `services/catalog-filter.js` via `GET /api/catalog/products?family=`.

**Filter on `Product_Series__c` — the org's "L3 Product Series".** It is the only field that names
a product line exactly (`DHUB`, `DMS`, `VBUS`, `D810`, `HAPTIC`, and the D-series). **Do not reach
for `Device_Type__c`**: it calls every Driveri model *and* Octo `Driveri`, so it cannot tell the two
families apart — the reason `fetchSerializedCatalog` now also selects `Product_Series__c`,
`Product_Category__c` (L2) and `L1_Product_Family__c`.

Verified against testing 2026-08-15, of 170 catalog rows:

| Family | Rule | Rows |
|---|---|---|
| `driveri` | `l1Family: [Device]`, `excludeSeries: [D810]` | 135 |
| `octo` | `series: [D810]` | 2 |
| `dhub` / `dms` / `vbus` | `series: [DHUB] / [DMS] / [VBUS]` | 2 / 2 / 3 |
| `haptic` | `series: [HAPTIC]` | 1 |

Two decisions worth keeping:

- **Driveri is "every device except D810", not a list of its seven series.** The D-series gain
  models regularly and a list would silently omit each new one — a SKU missing from its own family
  with nothing to indicate it. Excluding D810 is what keeps Driveri and Octo disjoint while
  together covering every device: 135 + 2 = 137.
- **The catalog is not purely `Product_Serialized__c = 'Yes'`.** Haptic's only product,
  `ACCAM1HAPTICMDL` "Haptic Feedback Module", is **active and flagged `Product_Serialized__c =
  'No'`** in the org, while all three Haptic descriptors mint a `serial_number` series and load it
  through a verified `Haptic_Initial_Load.csv`. The org's flag and the sheets disagree, and **the
  sheets win** — they are what the Apex parser accepted. So `fetchSerializedCatalog` takes
  `includeSeries` and widens to exactly the series a family rule names (`declaredSeries`), which
  today adds one row. Dropping the serialized filter instead would pull in 555 products no template
  can load. Each row carries `serialized`, so the flag is reported rather than assumed.

A rule that matches nothing still falls back to the whole catalog, and the message claims only what
is certain — *"no serialized product in this org belongs to X"* — because a stale rule and a
genuinely empty series are indistinguishable from the code.

**The filter never returns an empty catalog because a rule matched nothing.** A rule goes stale the
moment the org renames a series, and hiding every SKU would stop the operator working where showing
too many only costs a search. The picker always offers "show all", and resets it when the family
changes. `server/services/catalog-filter.test.js` pins all of this — the no-overlap property, the
new-model case, and both fallbacks.

### The device life cycle lives in `config/lifecycle.json`

The DLCM stage graph: 14 stages and 26 transitions, keyed on `IDMS_Status__c` — a numeric code
`-2..14` on the Asset. The chart draws `-2..12`; 13 and 14 exist in the org and are deliberately
**not** modelled, so an unknown code is reported as unmapped rather than guessed at.

The split that matters is *who drives each arrow*. Eight transitions are an operation this app
sends (`initialLoad`, `shipmentUpdate`, `received`, `rmaReturned`, `undoDead`, and `deviceDead` from
each of stages 12, 7 and 8); the other eighteen belong to the Installer App, the customer, the
network activating a sim, the order integration. The chain the operator actually walks is three of
them, on the same devices and the same ids:

```
(no Asset) --initialLoad--> -2 Pre-Production --shipmentUpdate--> -1 Shipped From Vendor
           --received--> 1 New --> everything after this belongs to somebody else
```

`server/lib/lifecycle.js` is the only reader. `STAGE_EXPECTATIONS` in `sf-client.js` is *derived*
from the file's `syncStatus` map, so making an operation pollable is one line here rather than two
places to keep in step. An operation absent from that map cannot be watched at all — the UI says so
instead of waiting 30 minutes for a status the integration never writes.

A stage tab shows **only the devices currently at that stage**. `splitByStagePosition` peels off
the rows marked `aheadOfStage`, and the Watch page hides them behind a notice naming where each
one went. `rescoreSnapshot` re-derives that mark on every read rather than trusting what was
stamped at poll time — a snapshot is written once and read many times, so anything decided when it
was taken is frozen at whatever the code understood that day, and a snapshot predating the field
would quietly opt out of the split forever. `syncStatus` is the fact; everything else is
interpretation, and interpretation belongs at read time. Both sides are tallied by the same `tallyRows`, so the headline counts always describe
the rows underneath them. A tab can legitimately read zero — every device it covered has moved on
— and the notice says so rather than leaving a bare empty table. "Show everything that was sent"
restores the full set: that is the record of what the email carried, and it must stay reachable.

`operationChain()` walks the graph from its entry to get `[initialLoad, shipmentUpdate, received]`
— derived, not listed, so a corrected transition moves it. Polling needs this because **on the
Asset a device ahead of the watched stage and one behind it look identical**: each carries some
`_SYNC_SUCCESS`. Counting any terminal status as done reported devices as loaded that had never
had the operation applied. `positionInChain` resolves the device's own status back to its operation
and compares positions; only `ahead` or `at` counts as done. `unknown` (an off-chain operation, or
a status this app does not model) is treated as not-ahead — it can under-report a success, never
invent one. Rows from snapshots predating the distinction carry no `aheadOfStage` and keep the old
reading rather than being re-judged wrongly.

**Stage steps are operations that run at a stage without moving the device.** They live in
`stageSteps` in `config/lifecycle.json`, deliberately *not* in `transitions`: `operationChain()`
walks the graph taking the first arrow out of each stage, so a self-loop sends it straight back and
truncates the chain. That is exactly what a `-2 → -2` `dataUpdate` transition did until 2026-08-15 —
the chain became `[initialLoad, dataUpdate]`, and the ahead/behind guard was silently off for
`shipmentUpdate` and `received`. Six `lifecycle.test.js` assertions were reporting it the whole time.

Two orders come out of this, and they are not interchangeable:

- `operationChain()` — the movement chain, `[initialLoad, shipmentUpdate, received]`.
- `pollingOrder()` — the same with stage steps spliced in at their `before`,
  `[initialLoad, dataUpdate, shipmentUpdate, received]`. **`positionInChain` (`sf-client.js:685`)
  uses this one**: a device carrying `DATA_UPDATE_SYNC_SUCCESS` is somewhere real, and an order
  that omits the step reads it as `unknown`, which is then treated as not-done.

No family is involved in the order. Position depends on which operation last wrote the sync status,
and a family with no data-update sheet never produces that status. Family decides only whether a
step is *required*: `requiredStepsBefore(operation, family)` reads `requiredFor`, and Octo owes a
data update before shipment update. **The check is per group, not per run** — `groups.every(g =>
g.family === 'octo')` read a mixed run as non-Octo and skipped the block for its Octo devices.

Only `haptic` and `octo` have a data-update sheet, so it is required for Octo, optional for Haptic,
and impossible for the rest.

**That per-group fix does not reach every Octo check, and the gap is a limit, not a feature.**
Whether to withhold "Received at 3PL" once a shipment update lands is a separate decision, in
`WatchPage.jsx`'s `handoff`, and it still reads `runFamilies.includes('octo')` — the run's families,
not each device's own. A run holding both Octo and non-Octo groups therefore withholds that
hand-off from every device in it, where only the Octo ones should actually carry on past shipment
update. Scoping it per device needs a browser-side device-id → family map, which this change does
not build. Withholding is the safer half of that gap: a send not offered is a click away, a send
offered wrongly is an email that has already gone.

**An Octo device is held back until its related assets are synced** — every entry in
`row.accessories` present and at a `_SYNC_SUCCESS`. Per device, not per run: the batch's successes
still move on, which is the same rule a partially-failed load has always followed. A device with no
accessories recorded has nothing to wait on; absence of a record is not evidence of an unsynced part.

That accessory data is fetched after the stage split has already run, and has to be threaded through
it by hand. `GET /:runId/poll/:stage` (`runs.js:1046`) calls `scopeSnapshot()` first, which runs
`splitByStagePosition` and builds `snapshot.atStage` from the row objects as they stand at that
instant. The Octo block that follows maps over `snapshot.rows` to attach `accessories`
(`runs.js:1066-1101`), and a `.map()` builds new objects — `atStage.rows` was already set from the
old ones and kept pointing at them. The Watch page reads
`{ ...fullSnapshot, ...fullSnapshot.atStage }`, so `rows` is the un-enriched array: a run measured
before the fix showed `atStage` at 4 rows, with accessories attached to 0 of them. Because
`accessoriesComplete`'s `.every()` over an empty list is `true`, the completeness gate silently
passed every device whenever any device on the run was ahead of or behind the watched stage — the
ordinary case, not an edge one. The fix (`runs.js:1108-1117`) re-maps `atStage.rows` through the
same enrichment once it exists. `movedOn` and `notYet` never needed this: `splitByStagePosition`
already reduces them to `{deviceId, syncStatus, stage}`, nothing left on them to enrich. The lesson
generalises past Octo: anything that enriches rows after `scopeSnapshot` has to be propagated onto
`atStage.rows` by hand, or it stays invisible to the UI.

Two things this deliberately does not do:

- **Stage never blocks a send.** `validateDeviceStages` is a `warning`, always. The stage is
  written by another system and can move between the read and the send; refusing on it would
  invent a new way to be stuck. What it does catch is the shipment update aimed at devices already
  past Shipped From Vendor — accepted by the org, changes nothing.
- **A split run gets no suggestion.** "What's next" is only answered when every device shares a
  stage. Acting on the majority would leave the rest behind silently.

Five arrows were ambiguous on the source chart and carry an `uncertain` note explaining the reading
taken. They are listed in the UI on the Life cycle page; correcting one is a one-line edit here.
There were six: the `5 → 7` arrow was resolved from an `external` "Received by Netradyne" guess into
the `rmaReturned` operation, which is how RMA Returned became a sendable, pollable step.

### Server layout

| File | Role |
|---|---|
| `server/routes/runs.js` | ~1440 lines, the whole pipeline; most behaviour changes land here |
| `server/routes/auth.js` | SF login/MFA/manual-sid, Outlook sign-in, forget-browser |
| `server/routes/catalog.js` | families, templates, picklists, profiles, lifecycle, order lookup |
| `server/lib/bytes.js` | BOM/CRLF primitives, `assertCsvBytes`, hex dump, Excel serial repair |
| `server/lib/config.js` | loads config + templates, DL resolution, `REPLACE_ME` detection |
| `server/lib/lifecycle.js` | DLCM stage graph, `classifyStage`, next-step and stage-check logic |
| `server/lib/paths.js` | all disk locations; `writeSecret` (0600) for anything sensitive |
| `services/sf-session.js` | Playwright login, sid capture, silent refresh from browser profile |
| `services/session-audit.js` | boot-time liveness check of every stored Salesforce + Outlook session |
| `services/sf-client.js` | every SOQL read; `classifySyncStatus`; `summarisePolling` |
| `services/id-generator.js` | series allocation against persisted counters, `setCursor`/`resetCursor` |
| `services/sku-decoder.js` | positional SKU decoding — no quantity ever comes out of this |
| `services/csv-builder.js` | descriptor-driven generation, four row planners |
| `services/validator.js` | pre-send checks, graded blocker/warning |
| `services/mailer.js` | transport dispatch (outlook-web \| smtp), `.eml` fallback |
| `services/outlook-web-service.js` | compose, attach, Send, Sent-Items confirmation |
| `services/poller.js` | server-side polling loop, writes snapshots into the run |
| `services/run-store.js` | run JSON + generated bytes on disk |

## Invariants — breaking any of these costs a real device load

- **Never derive a quantity from a SKU.** `sku-decoder.js` is positional decoding only. Batch size
  (units to load) and order quantity (serials a wizard upload needs) are two separate counts and
  stay separate; conflating them produces a `Partially Shipped` order that hides the "Load Asset &
  Ship Order" button and dead-ends the flow.
- **Ids come from persisted counters** (`data/counters.json`, keyed `env:templateId:series`), never
  a random reroll. On collision the cursor advances past the hit — forward progress only. Numeric
  series refuse to overflow their declared digit width. `POST /:id/cursors/set` is the one
  sanctioned way to move a cursor by hand, and it enforces the same digit ceiling.
- **Every `sampleStart` is an id that is already loaded.** It was copied from a sheet the parser
  accepted, so a fresh counter always opens on a collision — usually against the whole batch that
  sheet belonged to (the DHUB start `4011301001` sits under 37 consecutive live assets). The
  allocator therefore probes `count + 250` ids per attempt and takes the first free run inside that
  span; probing only `count` made it crawl forward `count` at a time and exhaust its 8 attempts
  still inside the batch. Any change here must keep the probe wider than the block it allocates.
- **A failed allocation still persists its cursor.** The ground it rejected is genuinely occupied,
  so the next attempt must resume past it. Discarding the cursor on failure — which is what
  `finish()`-only persistence did — made every retry re-walk the same collisions and fail
  identically, with `data/counters.json` never gaining an entry at all.
- **The collision query returns only values that were asked about.** It checks candidates against
  `Asset.Name`, `SIM_Serial__c` and `Device_IMEI__c`, but a matched Asset also carries its own
  values in the other two fields; returning those told the allocator to skip ids nobody had taken.
- **A candidate id is taken if it appears in *any* field a minted series can land in** —
  `COLLISION_FIELDS` in `sf-client.js`: `Name`, `SIM_Serial__c`, `Device_IMEI__c`, `Wifi_Mac__c`.
  Driveri mints three series offset by 10, so a device_id colliding with somebody else's sim_serial
  is a real collision; checking `Name` alone let it through (widened in `33792d3`). **`Wifi_Mac__c`
  was added on 2026-08-15 after it rejected a real VBUS load**: the org already held
  `Wifi_Mac__c = 1100928221` on a device loaded in May, the query never asked about that field, and
  the run minted the same mac again — *"Following VBUSs Data have duplicate Values. macId(required)
  1100928221 1100401222<>1100401221"*. The signature of this class of bug is **two series of one
  run moving differently**: the serial advanced past its collision because it lives in `Name`,
  which was checked, while the mac stayed on its `sampleStart`.

  A series whose values land in a field absent from that list is allocated blind, so adding a
  series means deciding where its values land. `collision-fields.test.js` walks every descriptor
  and fails if a series has no field mapped to it. Octo's `wired_speaker_serial` and
  `native_cam_serial` become Assets in their own right and so are covered by `Name`. The chunk size
  is derived from the field count rather than fixed, because each field adds an `OR … IN (…)` clause
  and the request has to stay under Salesforce's ~8 KB URL limit.
- **Artifacts are written to `data/output/<runId>/` under their own filename**, no key prefix
  (changed in `33792d3`). The old `<key>__<filename>` namespacing existed because two operations
  could produce the same name; the `<Operation>_<Family>_{trackingId}` convention is now what keeps
  them apart. A new descriptor whose pattern collides with an existing one will silently overwrite.
  `device-dead` (`Dead_{family}.csv`) and `rma-returned` (`RMA_Returned_{family}.csv`) already leave
  `{trackingId}` out, so two generates for different device subsets overwrite each other inside one
  run's output directory.
- **Byte contracts are per template.** All 15 source sheets are CRLF; BOM and trailing newline vary
  *within* one logical format. Don't unify them.
- **`escapeField` refuses** commas/quotes/newlines rather than quoting — no column in any format
  legitimately contains them, so it's caller data corruption.
- **Mailbox matching is on the local part**, not the domain. Every testing address is
  `@netradyne.com` and staging's are all Apex email services on one host suffix.
- **A send is only recorded after the message is found in Sent Items.** Compose-and-stop
  (`awaitingYourSend`) is explicitly *not* a send — recording it would arm the duplicate-send guard
  against the real send that hasn't happened. `mail.autoSend` is `false` by default.
- **A device may not be loaded twice for the same operation** — that, not key reuse, is what the
  duplicate guard exists for. `duplicateSendReason` compares the file's `deviceIds` against every
  send for that `"<operation>:<family>"`, current and superseded. Half a batch pushed to shipment
  update and then the other half is two legitimate emails to one mailbox; keying the guard on the
  pair alone refused the second as a repeat. Regenerating a key for a different device set moves
  the old send record into `run.sendHistory[key]` — archived, never dropped, because those devices
  are in the org and the guard still needs their ids. When either side's list is unknown (records
  predating `deviceIds`) it falls back to refusing any second send for the key: a blocked
  legitimate send is recoverable, a silent double load is not. Re-sends read the stored bytes from
  disk; regenerating would allocate new ids.
- **`*_SYNC_FAILED` is terminal**, immediately. ~⅓ of initial loads fail in this org, so failure is
  an ordinary outcome, not something to wait out. `_SYNC_SUCCESS`/`_SYNC_FAILED` are written by the
  integration and are **not** picklist values — they cannot be driven off Asset metadata.
- **No order is ever found by `Status = 'Confirmed'`** — no Order in these sandboxes has ever had
  it. Status is displayed and used for the `Partially Shipped` warning, never as a search filter.
- **No `sim_serial == device_imei` check.** The process spec demands it; every real Driveri sheet
  uses three distinct series offset by 10, and the sheets are what the parser accepted.

Nothing in this app is wired to an LLM, deliberately. Keep models out of id generation, byte
formatting, quantity arithmetic and the send decision.

## Sessions and credentials

There are no credentials in `.env` or in config. Salesforce username/password are typed into the UI
per attempt and live in process memory only; Outlook credentials are never handled by this app at
all.

| | Persisted to | Renewal |
|---|---|---|
| Salesforce sid | `data/sessions/<env>.json` (0600) | any 401 → silent re-mint from the browser profile, retry once |
| Salesforce browser profile | `data/browser/<env>/` (0700) | survives weeks; carries "remember this device" |
| Outlook | `outlook-auth.json` in the repo root (0600) | Playwright storage state, reused headless |

The Salesforce login runs **headless by default**. The driver reports each step, parks at
`awaiting-mfa` when the org asks to verify identity — the code is typed into the Connect page, not
into a browser — and only shows a window when it has to. Two escapes keep that from dead-ending:
an SSO attempt with no credentials is forced headed (handing over an invisible window means
nothing), and any background attempt that stalls on an unrecognised screen offers
`POST /api/auth/login/:attemptId/reveal`, which relaunches the same attempt visibly. Playwright
cannot toggle a live context, so reveal closes and relaunches onto the page it had reached; the
persistent profile is what carries the progress across.

**The login page is identifier-first** (verified against both sandboxes 2026-08-14): `#username`
plus `#Login` ("Log In to Sandbox"), and **no password field at all** until that is submitted.
`stepOnce` handles the two pages; don't assume one form carries both. The submit click is capped at
`MAX_ADVANCE_CLICKS`, because clearing the wait counter on every click once made the give-up ceiling
unreachable — a login page always has a visible submit button to find again — so a page that never
yielded a password field was re-posted every ~2.7s for the full 15-minute TTL and the stall timer
never fired.

**Verification screens are per-method, and each names its code box differently.** The one this org
challenges with is the authenticator app, at
`/_ui/identity/verification/method/TotpVerificationUi`, whose input is
`<input type="text" id="tc" name="tc" maxlength="6" autocomplete="off">` (observed 2026-08-15).
None of the original six `mfaCode` selectors matched it — the id is `tc`, not `tc-verification-code`,
and `autocomplete="off"` rules out the `one-time-code` entry — so the driver drove the credentials
correctly and then stalled on the one screen it exists to stop at, handing over the browser on every
login. `findVerificationCodeInput` now falls back to "the short text input on a
`/_ui/identity/verification/` page" so the next method Salesforce adds does not repeat this. Keep
that fallback narrow: this is the branch that *parks* the driver waiting for the operator, so a
false positive hangs the login until its TTL rather than merely failing to drive a step.

**A stall writes what it saw.** `data/diagnostics/sf-login-stall-<env>-<time>.json` records the URL,
title, visible text and every visible control's attributes, plus a screenshot, and the path comes
back on the attempt as `stallDiagnostic`. It records no field values — a typed password or code must
never reach disk. Without it, "Salesforce is showing a step this app does not recognise" was the
entirety of the evidence.

Silent refresh is serialised per environment — Chromium locks a profile directory exclusively, and
parallel 401s would otherwise fight over it. Session records are *nulled, not deleted*, on expiry
so the UI can say "expired, try Renew" rather than "not connected". Only explicit user actions
(Disconnect, Forget this browser, Forget on the Mail card, deleting a run) remove anything.

SMTP is dead in this tenant (`535 5.7.139` = SMTP AUTH disabled), so `mail.transport` defaults to
`outlook-web`. The nodemailer path is kept for the day it's re-enabled; switching transports is a
one-line change in `config/environments.json`.

Errors carry `needsReconnect` when the name is `SalesforceSessionExpiredError` /
`SalesforceNotConnectedError`; the UI reacts structurally to that flag rather than to the message.

### Sessions are audited at boot, because existing on disk is not the same as working

`describeSession` reports `connected: true` for any record holding a sid, and `describeOutlook`
reports `signedIn: true` for any `outlook-auth.json`. Neither is a liveness check, so a server
started the morning after opens on two green cards that may both be stale — and the thing that
discovers it is whatever real work the operator started.

`auditSessions()` runs once after `listen`, **not awaited**: the Outlook leg launches a browser and
can take half a minute, and nothing about serving the UI needs to wait for it. Salesforce needs no
special handling — `verifyConnection` goes through the ordinary request path, which already
re-mints from the browser profile on a 401, retries once, and retires the record if that fails, so
one call per environment leaves the stored state correct and the UI reads the truth on its next
poll. Outlook has no equivalent recovery, so its verdict is recorded for display rather than acted
on, and **the storage state is never deleted** — an expired one still records which account was
used, and discarding it takes the Forget decision away from the operator.

`GET /api/auth/session` carries the verdict as `startupCheck`; `POST /api/auth/session/audit`
re-runs it. Audits are serialised — two headless Chromiums would contend for one profile directory.
`STARTUP_SESSION_CHECK` is `all` (default), `salesforce` (skip the slow Outlook leg), or `off`.

## Environment variables (all optional, all non-secret)

`PORT` (4317) · `DEFAULT_ENV` (testing) · `HEADLESS` (true — the SF login runs in the background;
set `false` to watch it) · `STARTUP_SESSION_CHECK` (`all` | `salesforce` | `off`) ·
`DL_TEMPLATE_DIR` · `OUTLOOK_AUTH_STATE_PATH` (borrow an existing session file) ·
`OUTLOOK_WEB_URL` / `OUTLOOK_SENT_ITEMS_URL` · `OUTLOOK_{AUTH_WAIT,HYDRATION,SEND_ENABLE,SEND_CONFIRM,SENT_VERIFY}_MS`.

Outlook redirects to `outlook.cloud.microsoft` in this tenant, so Sent Items is resolved from
whatever host the session lands on rather than a hardcoded URL. Failed sends write a screenshot and
Outlook's own banner text to `data/diagnostics/`.

## Further reading, in priority order

1. `README.md` — the operational story, including what is still missing (three mailboxes, four CSV
   formats) and the hard-won Outlook DOM details.
2. `templates/README.md` — descriptor schema, the 13 formats, source-sheet defects reproduced or
   deliberately not.
3. `device-load-and-shipment-process.md` — the original process spec. **Where it disagrees with the
   real sheets, the sheets win** — they are what the Apex parser has actually accepted. Both
   READMEs table the disagreements.
