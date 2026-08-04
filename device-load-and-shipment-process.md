# Initial Load & Shipment Update — process spec

A build spec for a local app that replaces the manual CSV-and-email steps of the
Netradyne device fulfilment flow: pick SKUs and quantities in a UI, generate the exact
files, send them, and watch Salesforce converge.

Everything here was read out of this repo's implementation and verified against the
**testing sandbox** (`netradyne--testing`) on 2026-08-04. Values marked **verified**
came from live queries; values marked **inferred** are the code's intent and are called
out where the org disagrees with it. Read [Traps](#9-traps-verified-against-the-org)
before you hard-code any quantity logic — two things the current automation believes
are not true in this org.

---

## 1. What the flow actually is

Two independent CSV-over-email pipelines feed an external device-management system
(IDMS/BSG), which writes back to Salesforce asynchronously. Nothing in the flow is a
Salesforce API call — a mailbox is the integration surface.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PIPELINE 1 — INITIAL LOAD          creates Asset records from nothing   │
│                                                                          │
│  Initial Load CSV  ──email──▶  Asset-Shipped-From-MFR-Testing@          │
│  (28 cols, N devices)                       │                            │
│                                             ▼                            │
│                             IDMS provisions devices, creates Assets      │
│                                             │                            │
│              Asset.Sync_Status__c:  INITIAL_DEVICE_LOAD                  │
│                                  →  INITIAL_DEVICE_LOAD_SYNC_SUCCESS     │
│                                  (or INITIAL_DEVICE_LOAD_SYNC_FAILED)    │
└─────────────────────────────────────────────────────────────────────────┘
                                             │  same CSV, second mailbox
┌────────────────────────────────────────────▼────────────────────────────┐
│ PIPELINE 2 — SHIPMENT UPDATE       marks existing Assets as shipped     │
│                                                                          │
│  same CSV        ──email──▶  Asset_Shipment_Update_Testing@             │
│                                             ▼                            │
│              Asset.Sync_Status__c:  SHIPMENT_UPDATE                      │
│                                  →  SHIPMENT_UPDATE_SYNC_SUCCESS         │
│                                  (or SHIPMENT_UPDATE_SYNC_FAILED)        │
└─────────────────────────────────────────────────────────────────────────┘
                                             │
┌────────────────────────────────────────────▼────────────────────────────┐
│ PIPELINE 3 — LOAD ASSET & SHIP ORDER    attaches serials to the Order   │
│                        (Salesforce UI wizard, not email)                │
│                                                                          │
│  Serialized Assets CSV (SKU,Serial_Number) uploaded in the wizard        │
│         → Apex parses it → sets Asset.CPQ_Order__c → Order ships         │
└─────────────────────────────────────────────────────────────────────────┘
```

**The link between a device and an order is a string, not a lookup.** The Initial Load
CSV's `shipment_tracking_id` column is set to the **Salesforce OrderNumber**
(e.g. `00033958`), and that lands in `Asset.Shipment_Tracking_Id__c`. Pipeline 3 is what
sets the real `Asset.CPQ_Order__c` lookup. So a device can exist, be shipped, and be
findable by order number while still not being attached to the Order record.

---

## 2. Two file formats — do not mix them up

| | **A. Initial Load CSV** | **B. Serialized Assets CSV** |
|---|---|---|
| Purpose | create/ship devices via email | attach serials to an Order in the wizard |
| Columns | 28 (see §3) | exactly 2: `SKU,Serial_Number` |
| Header | `device_id(required),product_type(required),…` | `SKU,Serial_Number` — **no space after the comma** |
| BOM | **none** | **required** (`EF BB BF`) |
| Line endings | `LF` | `CRLF` |
| Trailing newline | yes | yes |
| Filename | `Initial_Load_<OrderNumber>.csv` | `Load Order <OrderNumber>.csv`, uploaded as `LoadUploadfile.csv` |
| Row count | N devices (see §7) | must equal the serialized line quantity |
| Consumer | IDMS mail parser | Salesforce Apex |
| Repo generator | `utils/initial-load-outlook.js` → `buildInitialLoadCsv()` | `utils/serialized-assets-csv.js` |

Format B is byte-strict because a Salesforce Apex parser reads it. The repo enforces this
in `assertApexSafeCsvBytes()` and will refuse a file that lacks the BOM. Verified bytes:

```
$ xxd "Testdata/Load Order 00033958.csv"
00000000: efbb bf53 4b55 2c53 6572 6961 6c5f 4e75  ...SKU,Serial_Nu
00000010: 6d62 6572 0d0a 4b32 4931 3331 5553 4153  mber..K2I131USAS
00000020: 4931 3046 4153 2c32 3332 3539 3737 3630  I10FAS,232597760
00000030: 3834 0d0a                                84..
        ^^^^ BOM          ^^^^ CRLF
```

`Testdata/Serialized_Assets.csv` in this repo is **LF with no BOM** — it is a stale
sample, not a valid template. Do not copy it.

### Format B rules the app must enforce

- Header exactly `SKU,Serial_Number`. `SKU, Serial_Number` is rejected.
- `Serial_Number` is an integer string: no thousands separators, no decimal point, no
  scientific notation. Excel is the usual culprit — it turns `23259776084` into
  `2.32598E+10` or `23259776084.0`. The repo's `formatSerialNumberForCsv()` repairs
  `\d+\.0+` and rejects anything else non-integer.
- `SKU` must not contain spaces.
- One row per serialized unit; every row repeats the same SKU.

---

## 3. Format A — the 28 columns

Template: `Testdata/Initial Load_B3E110005.csv`. Column order is positional — the parser
is driven by the header row, but keep the order as-is.

Legend: **Vary** = the app generates per device · **Pick** = user choice in your UI ·
**Const** = safe to hold constant for sandbox runs · **Empty** = left blank by the
working template.

| # | Column | Req | Role | Verified sample |
|---|---|---|---|---|
| 0 | `device_id(required)` | ✅ | **Vary** | `22513161408` |
| 1 | `product_type(required)` | ✅ | **Pick** | `AKELA` |
| 2 | `sku_number` | | **Pick** | `K2I131USASI10FAS` |
| 3 | `model_number` | | **Pick** | `D-450` |
| 4 | `sim_serial` | | **Vary** | `22600378301` |
| 5 | `device_imei` | | **Vary** | `22600378301` (same as `sim_serial`) |
| 6 | `sdcard_serial` | | Empty | |
| 7 | `sdcard_size` | | Empty | |
| 8 | `wifi_mac` | | Empty | |
| 9 | `hw_version` | | Empty | |
| 10 | `os_version` | | Empty | |
| 11 | `ota_version` | | Empty | |
| 12 | `owner_username` | | Empty | |
| 13 | `device_region(required)` | ✅ | **Pick** | `US` |
| 14 | `registration_key` | | Empty | |
| 15 | `shipment_tracking_id(required)` | ✅ | **Vary** — set to OrderNumber | `00033958` |
| 16 | `shipment_vendor` | | Const | `CHR` |
| 17 | `batch_number` | | Const | `Batch 03` |
| 18 | `bt_mac` | | Empty | |
| 19 | `service_provider(required)` | ✅ | Const | `TMOIOTSS` |
| 20 | `system_pn(required)` | ✅ | Const | `901-1-02282` |
| 21 | `device_category(required)` | ✅ | **Pick** | `NAMZ` |
| 22 | `manufacturing_partner` | | Const | `VVDN` |
| 23 | `shipment_to_3pl` | | Const | `DCL` |
| 24 | `invoice_number` | | Const | `INV010101` |
| 25 | `po_number` | | Const | `POUS724` |
| 26 | `D2C_Sales_Order#` | | Empty | |
| 27 | `D2C_shipped_date_(YYYY-MM-DD)` | | **Vary** — today | `2026-08-04` |

Only 6 of the 28 columns are marked required by the header, and the automation only ever
rewrites 6: `device_id`, `sim_serial`, `device_imei`, `sku_number`,
`shipment_tracking_id`, and the D2C date. Everything else is inherited verbatim from the
template's first data row.

**Picklist-backed columns** — validate the user's choice against these
(`Asset` object describe, active values, **verified**):

- `product_type` (14): `AKELA`, `BAGHEERA`, `AKELA_INDIA`, `BAGHEERA_INDIA`,
  `BAGHEERA_RND`, `KRAIT`, `KRAIT_INDIA`, `BAGHEERA2`, `KRAIT2`, `KRAIT_GLOBAL`,
  `KRAIT2_GLOBAL`, `BAGHEERA3_GLOBAL`, `BAGHEERA2_GLOBAL`, `MOWGLI`
- `device_category` (3): `NAMZ`, `AMZ`, `US Relay Program`

**Date format trap:** the column is named `(YYYY-MM-DD)` and the code writes
`new Date().toISOString().slice(0,10)` → `2026-08-04`, but the shipped template's own
sample row contains `01/04/26`. Follow the header, not the sample.

---

## 4. Email transport

Both emails are plain, one CSV attachment, no HTML needed. Constants live in
`utils/initial-load-outlook.js`.

| | Initial Load | Shipment Update |
|---|---|---|
| To | `Asset-Shipped-From-MFR-Testing@netradyne.com` | `Asset_Shipment_Update_Testing@netradyne.com` |
| Subject | `Initial Load File` | `Shipment Update` |
| Body | `Please find the attached updated Initial Load CSV.` | `Please find the attached Initial Load CSV for shipment update processing.` |
| Attachment | `Initial_Load_<OrderNumber>.csv` | the **same file**, unchanged |

The two addresses differ only in their local part and both are `@netradyne.com`, so
match on the local part when verifying — the repo does exactly this
(`toRecipientPatterns()`) because matching the domain alone would accept the wrong
mailbox. Pipeline 2 re-sends the identical CSV; nothing in the file distinguishes an
initial load from a shipment update. **The destination mailbox is the only thing that
selects the operation.** Send to the wrong one and you get a silent no-op or a
double-load.

Your app should send over SMTP/Graph rather than driving Outlook Web, which is what this
repo does out of necessity (`services/outlook-email-service.js`, no SMTP available).
Sending is only half the job: confirm the message landed in **Sent Items** before
declaring success. This repo learned that the hard way — a compose window closing looks
identical whether the mail was transmitted or discarded.

---

## 5. The Asset state machine

`Asset.Sync_Status__c` is the field to watch. Its picklist declares only **base** action
names; the integration writes the `_SYNC_SUCCESS` / `_SYNC_FAILED` variants, which are
*not* picklist members. Do not build your UI from the picklist metadata — you will miss
every terminal state.

```
   (no Asset yet)
         │  Initial Load email
         ▼
  INITIAL_DEVICE_LOAD ─────────────▶ INITIAL_DEVICE_LOAD_SYNC_SUCCESS
         │                                        │
         └──────────▶ INITIAL_DEVICE_LOAD_SYNC_FAILED     │ Shipment Update email
                                                  ▼
                              SHIPMENT_UPDATE ──▶ SHIPMENT_UPDATE_SYNC_SUCCESS
                                     │
                                     └──────────▶ SHIPMENT_UPDATE_SYNC_FAILED
```

Live distribution, assets created in the **last 30 days** (verified):

| Status | Count |
|---|---|
| `SHIPMENT_UPDATE_SYNC_SUCCESS` | 333 |
| `INITIAL_DEVICE_LOAD_SYNC_SUCCESS` | 159 |
| `NEW_ORDER_FULFILMENT_SYNC_SUCCESS` | 123 |
| **`INITIAL_DEVICE_LOAD_SYNC_FAILED`** | **80** |
| `SHIPMENT_UPDATE_SYNC_FAILED` | 9 |

**~⅓ of initial loads fail.** Any polling UI that only waits for success will hang for
its full timeout on a third of runs. Treat `*_SYNC_FAILED` as terminal, surface it
immediately, and let the user retry that device. The automation in this repo polls for
30 minutes at 20-second intervals and only then reports a soft failure — don't copy that
if you can detect `_SYNC_FAILED` on the first poll that shows it.

Other statuses you will see on devices that have been through more of their lifecycle:
`NEW_ORDER_FULFILMENT*`, `ORDER_WARRANTY_DATA_UPDATE*`, `DEVICE_RECEIVED_AT_3PL*`,
`DATA_UPDATE*`, `REFURBISHED_*`, `MANUALLY_SYNCED`, `NOT_APPLICABLE`, `ACCOUNT_CONFLICT`.
The full base picklist is 21 values; each can carry the two suffixes.

Related fields worth reading in the same query: `IDMS_Status__c` (numeric code, `-2`…`14`),
`Asset.Status` (`Purchased`/`Shipped`/`Installed`/`Registered`/`Obsolete`/`Dead`),
`OTA_Version__c`, `SKU_Number__c`, `Service_Provider__c`, `Device_Category__c`,
`Shipped_to_3PL_Partner__c`, `Received_Date__c`, `NetSuite_PO_Number__c`,
`Vendor_Invoice_Number__c`, `CPQ_Order__c`.

---

## 6. Polling queries

Authenticate with the `sid` cookie as a Bearer token against
`https://netradyne--testing.sandbox.my.salesforce.com/services/data/v61.0`. (This repo
uses `v58.0` in the older email utilities and `v61.0` in the newer ones; either works.)

**Have my devices arrived, and where are they?**

```sql
SELECT Id, Name, Sync_Status__c, IDMS_Status__c, Shipment_Tracking_Id__c,
       CPQ_Order__c, CPQ_Order__r.OrderNumber, SKU_Number__c, CreatedDate
FROM   Asset
WHERE  Name IN ('22513161408','22513161409')
ORDER BY CreatedDate DESC
```

`Asset.Name` **is** the `device_id`. That is the join key for everything.

**Everything for one order, including devices not yet attached:**

```sql
SELECT Name, Sync_Status__c, CPQ_Order__c
FROM   Asset
WHERE  Shipment_Tracking_Id__c = '00033958'
```

**Is a device_id already taken?** Run this *before* generating, or the load fails:

```sql
SELECT Name FROM Asset WHERE Name IN ('22513161408', …)
```

**What does the order need?**

```sql
SELECT Quantity, Product2.ProductCode, Product2.Product_Serialized__c
FROM   OrderItem
WHERE  OrderId = '801U800000mSeJsIAK'
```

---

## 7. ID generation

From `buildInitialLoadCsv()`. Both series are **sequential from a random start**, which
matters: IDMS appears to tolerate contiguous blocks, and the automation retries the whole
block if any member collides.

| | Base | Range | Result |
|---|---|---|---|
| `device_id` | `20000000000` | `+0 … 9999999990` | 11 digits, starts with `2` |
| `sim_serial` / `device_imei` | `22600000000` | `+0 … 999999990` | 11 digits |

Algorithm, up to 30 attempts:

1. Pick a random `devStart` and `simStart` in the ranges above.
2. Build `[start, start+1, …, start+N-1]` for both series.
3. Query `Asset.Name IN (…)` for **both** series. Any hit → discard the whole block and
   retry (not just the colliding member).
4. `sim_serial` and `device_imei` get the **same** value per row.

For an app, prefer a persisted counter over random-plus-collision-check: it is
deterministic, gives you contiguous audit-friendly blocks, and needs one existence query
instead of up to 30.

---

## 8. SKU catalog and quantity

**165 active serialized products**, **136** of them `Family = 'Hardware'`. The flag is
`Product2.Product_Serialized__c = 'Yes'` — that, not the family or the name, is what
decides whether a line needs device serials. Distribution across active products
(verified): `Yes` 165, `No` 208, `null` 292.

The catalog for your picker:

```sql
SELECT ProductCode, Product_SKU__c, Name, Device_Type__c, IDMS_Device_Type__c, Family
FROM   Product2
WHERE  IsActive = true AND Product_Serialized__c = 'Yes'
ORDER BY ProductCode
```

### Decoding a SKU code

Positional, and it holds across all 136 hardware SKUs — **verified** by cross-checking
every code against its product name:

```
K2I1 31 USA SI 10 FAS
│    │  │   │  │  └─ suffix / variant (S, S-R = refurbished, N = no mount, AMZ, …)
│    │  │   │  └──── option flags  ← NOT a quantity. See trap §9.3.
│    │  │   └─────── sensor variant: SI · SS · DI (DI = with DMS)
│    │  └─────────── region: USA CAN MEX IND EUK AUS NWZ MEA
│    └────────────── storage: 31 = 100 hours, 32 = 200 hours
└─────────────────── model family (chars 0–3)
```

Chars 4–5 mean the same thing in every family — `31` → 100 h, `32` → 200 h — so you can
render "D-450 · 200 h · Canada" from the code alone. Model families present:

| Prefix | Model | | Prefix | Model |
|---|---|---|---|---|
| `K1E1` `K1E2` | D-210 | | `B2E2` | D-430 |
| `K0E1` `K0E2` | D-211 | | `DRI4` | D-430 |
| `K2I1` | D-215 | | `B3E1` `B3E2` `B3E3` | D-450 |
| `DRI-` | D-410 | | `DEB4` | D-470 / D-475 |
| | | | `DE81` | D-810 |

The SKU the whole regression flow uses is `K2I131USASI10FAS` →
`K2I1`+`31` = **D-215, 100 hours**, US, SI — matching its name
*"Driveri D-215 100 Hours supporting VBUSv1"*. Note the storage came from chars 4–5, so
the `10` later in the code is an option flag with no relation to hours or quantity.

### What the order/device counts actually are

Measured across four completed orders (`00033946`–`48`, `00033958`) — all identical,
all **verified**:

| | Value |
|---|---|
| Serialized order line | `K2I131USASI10FAS` × **1** |
| Assets created by the Initial Load email (`Shipment_Tracking_Id__c`) | **5** |
| Assets attached to the Order (`CPQ_Order__c`) | **1** |
| End state of the other 4 | `SHIPMENT_UPDATE_SYNC_SUCCESS`, unattached |

So there are **two different counts** and your UI should model them separately:

- **Initial Load row count** — free. It is a batch of devices arriving from the
  manufacturer. It does not have to relate to any order.
- **Serialized Assets CSV row count** — must equal the serialized line quantity on the
  order (here 1). Upload fewer and the order goes **`Partially Shipped`**, which
  *hides the "Load Asset & Ship Order" button* and dead-ends the flow. The automation
  has to hunt for a different order when it hits this.

---

## 9. Traps (verified against the org)

Four things that will cost you a day each if you take the existing automation at face
value.

**1. `Status = 'Confirmed'` matches nothing.** `resolveConfirmedOrder()` and TC15's
auto-discovery both run
`SELECT … FROM Order WHERE Status = 'Confirmed' ORDER BY CreatedDate DESC LIMIT 1` and
throw *"No Confirmed orders found"*. **No Order in this sandbox has ever had that
status.** Stored values, with counts (verified):

`Activated` 26636 · `Cancelled` 1090 · `Received` 309 · `Ready to Ship` 218 ·
`Draft` 211 · `Sent to Fulfillment` 112 · `Returned` 36 · `In Transit` 16 ·
`Back-ordered` 5 · `Partially Shipped` 5 · `Partially Received` 4 · `Ordered` 3 ·
`Delivered` 3

A finished order in this flow is **`Activated`**. `Ordered` and `Delivered` are not in
the active picklist but exist on records, so accept them when reading and never write
them.

**2. There is no `Shipped` status either.** TC19 tests `/partially shipped|^shipped$/i`;
only `Partially Shipped` can ever match. Gate your "already shipped" logic on
`Activated`.

**3. The pack-factor heuristic is wrong.** TC15 computes devices-needed as
`Quantity × packFactorFromSku(code)`, where `packFactorFromSku` pulls the digits after
`USASI`:

```js
String(code).match(/USASI(\d+)/i)   // 'K2I131USASI10FAS' → 10
```

Those digits are **option flags, not a pack size** (§8). The catalog proves it — sibling
SKUs `B3E231USASI0000S`, `B3E231USASI0010S`, `B3E231USASI0100S` would yield pack factors
0, 10 and 100 for physically comparable single cameras, and storage capacity is already
encoded in chars 4–5. For `K2I131USASI10FAS` the
heuristic asks for 10 devices where the order needs **1**. Every measured run used the
default of 5 devices instead, so this branch is not firing in practice — but do not port
the formula. **Take the quantity from `OrderItem.Quantity` on lines where
`Product2.Product_Serialized__c = 'Yes'`.**

**4. `Testdata/Serialized_Assets.csv` is not a usable template** — LF, no BOM. Generate
format B from scratch every time; never ship a checked-in sample as the upload.

---

## 10. What the app should do

### Data model

```jsonc
{
  "order":   { "orderNumber": "00033958", "orderId": "801U800000mSeJsIAK" },
  "profile": {                       // §3 Const + Pick columns, saved as presets
    "product_type": "AKELA", "model_number": "D-450", "device_region": "US",
    "device_category": "NAMZ", "service_provider": "TMOIOTSS",
    "system_pn": "901-1-02282", "shipment_vendor": "CHR", "batch_number": "Batch 03",
    "manufacturing_partner": "VVDN", "shipment_to_3pl": "DCL",
    "invoice_number": "INV010101", "po_number": "POUS724"
  },
  "lines": [                         // one per SKU the user picks
    { "sku": "K2I131USASI10FAS", "serialized": true, "quantity": 1, "deviceCount": 5 }
  ],
  "devices": [                       // generated, editable, exportable
    { "device_id": "22513161408", "sim_serial": "22600378301",
      "device_imei": "22600378301", "sync_status": null }
  ]
}
```

Ship the 12 profile fields as **named presets** (e.g. "US / NAMZ / AKELA"). They are
constant across every run in this sandbox, so they belong behind an "advanced" disclosure
rather than in the main flow.

### Screens

1. **Order** — enter or search an OrderNumber; show its serialized lines and quantities
   straight from `OrderItem`. This is where you replace the guesswork in §9.3.
2. **SKUs** — searchable picker over the serialized catalog, decoding the SKU structure
   from §8 into model / region / storage so the user is not reading `B3E231USASI0210S`
   by eye. Quantity per line, with the required-serials total shown live.
3. **Devices** — the generated ID table, editable, with a "check availability" button
   that runs the §7 collision query before anything is sent.
4. **Review & send** — run the §11 checklist, show the exact bytes that will go out
   (hex for format B), then send.
5. **Watch** — poll §6, one row per device, with `_SYNC_FAILED` surfaced loudly and
   retryable per device.

### Where AI actually helps

Be selective — most of this pipeline is deterministic and should stay that way. Do not
put a model between the app and the CSV bytes; §2 and §3 are a hard spec and a
hallucinated column ends the run.

Worth it:

- **Failure triage.** Take a `_SYNC_FAILED` asset plus its field values and explain the
  likely cause in plain language. This is the biggest win: ~⅓ of loads fail (§5) and
  the failure reason is currently nowhere in the UI.
- **SKU search in natural language.** "D-450 200 hours for Canada, dash mount" →
  candidate ProductCodes, using the §8 decoding. Good use of a model: fuzzy input,
  verifiable output, and the user confirms before anything is generated.
- **Order-vs-CSV reconciliation.** Explain in words why a count mismatch will produce
  `Partially Shipped` before the user sends.
- **Importing a messy spreadsheet** a manufacturer emailed, mapping arbitrary columns
  onto the 28 in §3 — then showing the mapping for confirmation.

Keep out of: ID generation, byte formatting, quantity arithmetic, and the send decision.
Deterministic code, validated by the §11 checklist.

---

## 11. Pre-send validation checklist

Enforce all of these in the app; each one corresponds to a real failure mode above.

**Format A (Initial Load)**

- [ ] 28 columns, header byte-identical to the template
- [ ] No BOM; `LF` endings; trailing newline
- [ ] All 6 required columns non-empty on every row
- [ ] `shipment_tracking_id` == the target OrderNumber on every row
- [ ] `device_id` unique within the file **and** absent from `Asset.Name` in the org
- [ ] `sim_serial` == `device_imei` per row
- [ ] `product_type` and `device_category` are valid picklist values (§3)
- [ ] D2C date is `YYYY-MM-DD`

**Format B (Serialized Assets)**

- [ ] Header exactly `SKU,Serial_Number` — no space, no BOM-less write
- [ ] BOM `EF BB BF` present; `CRLF` endings; trailing newline
- [ ] Every `Serial_Number` is digits only — no `.0`, no `E+`, no separators
- [ ] Row count == serialized quantity on the order
- [ ] Every serial exists as an `Asset.Name` at `SHIPMENT_UPDATE_SYNC_SUCCESS`
- [ ] Order has **zero** existing CSV files attached (the wizard is confused by stale
      ones — the automation purges to 0 first, see `purgeSerializedAssetsFilesUntilClear`)

**Send**

- [ ] Correct mailbox for the intended operation — matched on local part, not domain
- [ ] Exactly one attachment
- [ ] Confirmed in Sent Items before reporting success

---

## 12. Reference — where this lives in the repo

| Concern | File |
|---|---|
| Initial Load CSV build, both emails, `tc15-state.json` | `utils/initial-load-outlook.js` |
| Format B build/validate/byte-check | `utils/serialized-assets-csv.js` |
| Order file attachments: list, purge, upload, header verify | `utils/sf-order-files.js` |
| Outlook session (MFA once, then stored state) | `services/outlook-session-manager.js` |
| Outlook send | `services/outlook-email-service.js` |
| Load Asset wizard, order status via API | `pages/OrderPage.js` |
| Flow orchestration TC15–TC19 | `tests/specs/comprehensive-flow.spec.js` |
| Format A template | `Testdata/Initial Load_B3E110005.csv` |
| Cross-run state (order, device IDs, CSV path) | `Testdata/tc15-state.json` |

Test-case → pipeline mapping: **TC15** send Initial Load · **TC16** poll for
`INITIAL_DEVICE_LOAD_SYNC_SUCCESS` · **TC17** validate assets · **TC18** send Shipment
Update, poll for `SHIPMENT_UPDATE_SYNC_SUCCESS` · **TC19** Load Asset & Ship Order wizard.

---

*Verified against `netradyne--testing` on 2026-08-04. The sandbox is refreshed
periodically — re-run the queries in §6 and §8 before trusting the counts. The traps in
§9 are properties of this org's configuration, not of the code, so confirm them again
after any refresh.*
