# Auto Loader

A local app that replaces the manual CSV-and-email steps of the Netradyne device fulfilment
flow. Pick product families, SKUs and quantities in a UI; the backend generates the
byte-exact CSVs, emails each one to the right distribution list, watches Salesforce converge,
and hands back the ids that were loaded.

Built from two sources of truth:

- [`device-load-and-shipment-process.md`](./device-load-and-shipment-process.md) — the process
  spec, describing the pipelines and the Salesforce side.
- `~/BSG/DL Template/*.csv` — the 15 real template sheets. **Where these disagree with the
  spec, the sheets win**, because they are what has actually been accepted. The disagreements
  are listed at the bottom of this file.

## Setup

```bash
npm install                     # deps plus the Chromium that drives the Salesforce login
npm run dev                     # server on :4317, UI on :5317 (opens automatically)
```

If `npm install` fails with `EACCES` on `~/.npm/_cacache`, your npm cache has root-owned files
from an old npm bug. Fix it once with `sudo chown -R $(id -u):$(id -g) ~/.npm`, or install with
a different cache: `npm install --cache /tmp/npm-cache`.

```bash
npm test                        # 63 tests: descriptor fidelity, byte contracts, allocation
npm run build && npm start      # single-process production mode on :4317
```

## Credentials

There are none in `.env`, by design.

- **Salesforce** — you type your username and password into the app. It drives a real Chromium
  login; when Salesforce challenges for MFA, the app prompts and you enter the code. Only the
  resulting `sid` session is persisted, to `data/sessions/<env>.json` at mode 0600, and only
  until Salesforce expires it. On the first 401 the session is dropped and you reconnect.
  A "paste a sid instead" escape hatch covers SSO variants the automation cannot drive.
- **SMTP** — username and app password live in the server process for that session only.

`data/` is gitignored in full.

## What it covers

**6 product families × 5 operations = 13 CSV formats**, each derived column-for-column from a
real sheet:

| Family | Operations | Cols | Mints |
|---|---|---|---|
| Driveri (Bagheera3) | initial load, shipment update | 28 | `device_id`, `sim_serial`, `device_imei` |
| Octo (D-810) | initial load, shipment update | 32 | 5 numeric series + 2 pseudo-MACs |
| Driveri Hub | initial load | 17 | `driveri_hub_id` |
| DMS Camera | initial load | 17 | `Serial number` |
| Haptic | initial load, shipment update, **data update** | 18 | `Serial number` |
| VBUS | initial load | 16 | `serialNumber`, `macId` |
| any | **received at 3PL** | 5 | — reuses a prior run's ids |
| any | wizard upload (×2 variants) | 2 | — reuses a prior run's ids |

Accessories are not one format. DMS, Haptic, DHUB and VBUS are each their own template with
their own column names, byte rules and numbering scheme. **Octo is different again**: it
bundles its accessories *inline*, carrying wired-speaker and native-camera SKUs and serials in
four extra columns, so it has no separate accessory file at all.

## The flow

| Screen | What it does |
|---|---|
| **Connect** | Salesforce + SMTP, and every mailbox this environment would send to |
| **Setup** | Operation, tracking id, and an **optional** order |
| **Families & SKUs** | Pick families and quantities; shows each template's shape, byte contract and the ids it will mint |
| **Ids** | Every series' next value and the allocated blocks, with a "check availability" query |
| **Review & send** | Per-family files, hex byte preview, the full checklist, then one send per family |
| **Watch** | One row per unit, `*_SYNC_FAILED` surfaced immediately, polling continues server-side |
| **History** | Every past run and the ids it loaded |

Each family is its own CSV and its own email — every send carries exactly one attachment, so a
Driveri batch and a Haptic batch cannot share a message even when they go to the same mailbox.

## Still needed from you

### 1. Two mailbox addresses

`config/environments.json` has verified addresses for **initial load** and **shipment update**
(from the spec). Two operations are placeholders:

- `dataUpdate` — where does `Haptic_Data_Update.csv` go?
- `received` — where does `Received Load *.csv` go?

Any pipeline whose address still carries `REPLACE_ME_` **can generate and download files but
cannot be sent**. Everything else works meanwhile.

If a family needs a *different* mailbox from the shared one for an operation, add it under
`distributionLists.byFamilyOperation` as `"vbus:initialLoad": { … }`; resolution prefers a
family-specific entry and falls back to the operation-level one. The app shows which rule a
send resolved through, since the mailbox is the only thing that distinguishes one operation
from another.

### 2. Staging configuration

Staging's sandbox URL and both DL addresses are placeholders, so the environment is marked
unusable rather than silently pointing at the wrong org.

### 3. Two judgement calls worth confirming

- **`haptic-shipment-update` date format.** That sheet writes `Manufacturing_Date` and the D2C
  date as `DD/MM/YY` (`20/05/26`), while `Haptic_Initial_Load.csv` writes `YYYY-MM-DD` for the
  same columns. The two sheets contradict each other and the column name says `YYYY-MM-DD`, so
  the descriptor follows the column name. If the parser actually needs `DD/MM/YY`, set
  `"dateFormat": "DD/MM/YY"` in `templates/haptic-shipment-update.json` — one line, no code.
- **Which wizard upload.** Both `order_load.csv` (`SKU,Serial_Number`) and
  `partner_order_load.csv` (`Device_Type,Serial_Number`) exist. The app generates the former;
  `partner-order-load` is ready to use if that is the right one.

## How output correctness is established

`npm test` regenerates each real sheet from its descriptor and compares byte for byte:

- **All 13 headers** match their source sheet exactly.
- **All 13 byte contracts** match — BOM, line endings, trailing newline.
- **Two whole files** (`Shipment Update Load_B3E110005.csv` and the 100-row
  `VBUS_Initial_Load RTS120013.csv`) regenerate **byte-identical**, BOM and all.
- The rest match on every row and column except documented defects in the source sheets, and
  **each exclusion has its own test asserting the defect is real** so a sheet quirk cannot
  quietly become a generator bug.

### Defects found in the source sheets

| Sheet | Defect | Handling |
|---|---|---|
| `Initial Load_B3E110005.csv` | rows 6–10 have `system_pn`, `invoice_number`, `po_number` incrementing (`901-1-02282`→`02287`) | Excel autofill. A part number does not vary per unit — held constant |
| `Octo Initial Load` / `Update Load` | row 1 has literal single spaces in six columns that later rows leave empty | written as empty |
| `Octo Update Load` | accessory serials run …202, …201, …203 | hand-shuffled, not a sequence — emitted in order |
| `Haptic_Data_Update.csv` | trailing row of bare commas | not reproduced |
| `Haptic_Shipment_Update.csv` | dates as `DD/MM/YY` where the sibling sheet uses `YYYY-MM-DD` | follows the column name; see above |

### Quirks preserved deliberately

- **`Wired_Speaker _SKU(required)`** — the Octo header really does have a space before `_SKU`.
- **`DMS_IntialLoad {trackingId}.csv`** — "Initial" is misspelled in the source filename. Kept,
  so generated files match what the mail parser has been receiving.
- **Octo/Haptic tracking column vs filename** — those sheets carry `NA` in the tracking column
  while the *filename* carries a real id. Modelled as two separate things.
- **Haptic filenames carry no tracking id** at all.

## Where the spec and the real sheets disagree

| Spec says | Sheets show | App follows |
|---|---|---|
| Initial load is **LF** with a trailing newline | **CRLF**; trailing newline varies by sheet | the sheets, per template |
| Wizard upload **requires** a BOM (`EF BB BF`) | `order_load.csv` has none; `partner_order_load.csv` does | each template's own bytes |
| `sim_serial` == `device_imei` per row | three distinct series, offset by 10 | the sheets — no equality check |
| `shipment_tracking_id` is the Salesforce OrderNumber | a separate tracking id (`B3E110005`, `RTS120011`) or literally `NA` | a user-supplied tracking id |
| One initial-load format plus one accessory format | 6 families, 5 operations, 13 formats | all 13 |
| 6 required columns in the 28-col format | 7 columns are marked `(required)` | the column names |

All 15 sheets are CRLF and not one contains a bare LF. BOM presence and trailing newline vary
*within* a single logical format, which is what you would expect if they just reflect whether a
sheet was last saved by Excel ("CSV UTF-8" adds a BOM) or a plain editor — so neither is what
the parser gates on. Each descriptor reproduces its own sheet's bytes regardless, so output is
indistinguishable from a file already known to work.

## Other departures from the old automation

**Quantity comes from `OrderItem.Quantity`.** The old `packFactorFromSku()` read the digits
after `USASI` as a pack size; they are option flags. For `K2I131USASI10FAS` it asked for 10
devices where the order needed 1. Nothing here derives a count from a product code.

**Two counts, modelled separately.** *Batch size* is how many units to load — free, it is a
manufacturer batch. *Order quantity* is how many serials a wizard upload needs — fixed by the
order. Uploading fewer sets the order to `Partially Shipped`, which hides the "Load Asset &
Ship Order" button and dead-ends the flow, so the picker warns before you get there.

**The order is optional.** An initial load does not have to relate to any order — the real
sheets prove it, carrying tracking ids rather than order numbers.

**`*_SYNC_FAILED` is terminal.** Roughly a third of initial loads fail in this org. The old
poller waited a flat 30 minutes at 20-second intervals before reporting a soft failure, so it
said nothing for half an hour on a third of runs. Here failure ends the poll for that unit the
moment it appears, and the first few polls are 5 seconds apart.

**No order is ever found by `Status = 'Confirmed'`.** No Order in this sandbox has ever had
that status; a finished order is `Activated`. Status is displayed and used for the
`Partially Shipped` warning, never as a search filter.

**Ids come from persisted counters, not a random reroll.** The old generator picked a random
start and discarded the whole block if any member collided, up to 30 times. Here each
(environment, template, series) has its own counter, so blocks are contiguous and auditable,
and on collision it advances past the highest hit — every retry is forward progress. Series
also refuse to overflow their declared digit width.

**A send is not reported as success until it is in Sent Items.** After SMTP accepts, an IMAP
lookup confirms the message was filed. When it cannot be confirmed the app says so rather than
guessing either way — a blind retry is a double load.

**Re-sending the same file to the same mailbox is blocked** unless explicitly forced, and
re-sends use the bytes stored on disk rather than regenerating (which would allocate new ids).

## Layout

```
config/environments.json     per-env Salesforce endpoint + DL routing by operation and family
config/profiles.json         Asset picklists and order-status facts
templates/*.json            13 descriptors — columns, byte rules, series, filename, sources
templates/README.md          descriptor schema and per-sheet quirks
server/lib/bytes.js          BOM/CRLF/LF primitives, byte-contract assertions, hex dump
server/lib/config.js         config + templates, DL resolution, placeholder detection
server/services/
  sf-session.js              Playwright MFA login, sid capture and storage
  sf-client.js               all Salesforce reads; sync-status classification
  sku-decoder.js             positional SKU decoding (no quantity inference)
  id-generator.js            declarative multi-series allocation with persisted counters
  csv-builder.js             template-driven generation and row planning
  validator.js               pre-send checks, driven off descriptor rules
  mailer.js                  SMTP send, Sent Items confirmation, .eml fallback
  poller.js                  server-side polling loop
  run-store.js               run persistence and generated bytes on disk
  templates.test.js          round-trip fidelity against the real sheets
server/routes/               auth, catalog, runs
web/src/pages/               the seven screens
data/                        runtime only, gitignored: sessions, counters, runs, output
```

## Where a model would help, and where it must not

Nothing here is wired to an LLM. If it is added later, the useful places are failure triage
(explaining a `_SYNC_FAILED` in plain language), natural-language SKU search, and mapping a
manufacturer's messy spreadsheet onto a template's columns for confirmation.

Keep it out of id generation, byte formatting, quantity arithmetic, and the send decision.
Those are a hard spec, and a hallucinated column ends the run.
