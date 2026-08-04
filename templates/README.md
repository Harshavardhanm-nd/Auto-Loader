# CSV templates

One `*.json` **template descriptor** per real CSV template in
`~/BSG/DL Template`. Each descriptor fully defines one format — column order, byte rules,
filename pattern, the id series it mints, and where every column's value comes from. The
generator reads these; it has no format knowledge of its own.

Every descriptor's `sourceTemplate` names the sheet it was derived from, and
`npm test` regenerates each sheet from its descriptor and asserts **byte equality** with
the original file. Adding a format is a JSON drop-in.

## The 13 templates

| Family | Operation | Cols | BOM | Trailing NL | Source sheet |
|---|---|---|---|---|---|
| Driveri (Bagheera3) | initial load | 28 | no | no | `Initial Load_B3E110005.csv` |
| Driveri (Bagheera3) | shipment update | 28 | no | no | `Shipment Update Load_B3E110005.csv` |
| Octo (D-810) | initial load | 32 | no | yes | `Octo Initial Load NAZ110001.csv` |
| Octo (D-810) | shipment update | 32 | no | yes | `Octo Update Load NAZ110001.csv` |
| Driveri Hub | initial load | 17 | yes | yes | `DHUB_Initial_Load_RTS120011.csv` |
| DMS Camera | initial load | 17 | yes | no | `DMS_IntialLoad RTS120014.csv` |
| Haptic | initial load | 18 | yes | no | `Haptic_Initial_Load.csv` |
| Haptic | shipment update | 18 | yes | no | `Haptic_Shipment_Update.csv` |
| Haptic | data update | 18 | yes | no | `Haptic_Data_Update.csv` |
| VBUS | initial load | 16 | yes | yes | `VBUS_Initial_Load RTS120013.csv` |
| any | received at 3PL | 5 | yes | no | `Received Load NDA110043.csv` |
| any | wizard upload | 2 | no | no | `order_load.csv` |
| any | wizard upload | 2 | yes | no | `partner_order_load.csv` |

**All 15 source sheets use CRLF. Not one contains a bare LF.** BOM presence and trailing
newline vary between sheets of the *same logical format* — `order_load.csv` has no BOM while
`partner_order_load.csv` does; DHUB ends with a newline while DMS does not. That pattern is
what you would expect if it simply reflects whether a sheet was last saved by Excel
("CSV UTF-8" adds a BOM) or by a plain editor, which means neither is what the parser gates
on. Each descriptor nonetheless reproduces its own sheet's bytes exactly, so generated output
is indistinguishable from a file that has already been accepted.

## Descriptor shape

```jsonc
{
  "id": "driveri-initial-load",
  "family": "driveri",
  "operation": "initialLoad",      // initialLoad | shipmentUpdate | dataUpdate | received | wizardUpload
  "kind": "device",                // device | accessory | operation | wizard-upload
  "status": "verified",            // verified | awaiting-template
  "sourceTemplate": "Initial Load_B3E110005.csv",
  "bytes": { "bom": false, "lineEnding": "\r\n", "trailingNewline": false },
  "filenamePattern": "Initial Load_{trackingId}.csv",
  "dateFormat": "YYYY-MM-DD",      // optional; defaults to YYYY-MM-DD
  "series": {                      // id series this template mints, one block each
    "device_id": { "type": "numeric", "digits": 11, "sampleStart": "22600379190" },
    "wifi_mac":  { "type": "prefixed", "prefix": "1c:ce:51:b1:05:c", "sampleStart": "7" }
  },
  "defaults": { "product_type": "Bagheera3" },   // seeds every field.* column
  "columns": [ { "name": "device_id(required)", "source": "generated.device_id", "required": true } ]
}
```

### Column `source` values

| Source | Meaning |
|---|---|
| `generated.<series>` | Per-row value from a series this template declares |
| `existing.device_id` | A device id from an **earlier** run (received, wizard uploads) |
| `field.<name>` | Run-level value, seeded from `defaults`, editable in the UI |
| `trackingId` | The run's shipment tracking id |
| `line.<field>` | From the picked catalog line (`sku`, `quantity`) |
| `today` | Current date in the template's `dateFormat` |
| `const:<value>` | Literal |
| `empty` | Always blank |

### Series types

- `numeric` — `sampleStart` plus an offset, zero-padded to `digits`. Checked against
  `Asset.Name` before use.
- `prefixed` — `prefix` plus a decimal counter. Used for Octo's `wifi_mac` / `bt_mac`, which
  look like MAC addresses but are a fixed prefix plus a counter (`…05:c7`, `…05:c8`, …
  `…05:c16`) rather than hex arithmetic. Not collision-checked, since these are not asset
  names.

### `status`

- `verified` — derived from a real accepted sheet and round-trip tested. Usable.
- `awaiting-template` — a scaffold. **The server refuses to generate or send it** and the UI
  says what is missing.

## Per-sheet quirks preserved deliberately

- **`Wired_Speaker _SKU(required)`** — the Octo header really does have a space before
  `_SKU`. Reproduced byte for byte.
- **`DMS_IntialLoad {trackingId}.csv`** — "Initial" is misspelled in the source filename.
  Kept, so generated files match what the mail parser has been receiving.
- **Octo tracking column vs filename** — the Octo initial-load sheet carries `NA` in
  `shipment_tracking_id` while its *filename* carries `NAZ110001`. The column is therefore a
  field defaulting to `NA`, and only the filename uses the run's tracking id. Haptic behaves
  the same way.
- **Haptic filenames carry no tracking id** at all (`Haptic_Initial_Load.csv`).

## Quirks deliberately NOT reproduced

- **`Initial Load_B3E110005.csv` rows 6–10** have `system_pn`, `invoice_number` and
  `po_number` incrementing (`901-1-02282`→`02287`, `INV010101`→`010106`,
  `POUS724`→`POUS729`). A part number and an invoice number do not vary per unit — this is
  Excel autofill contamination. Held constant.
- **`Haptic_Data_Update.csv`** ends with a row of bare commas, an empty Excel row.
- **`Octo Initial Load` row 1** has single-space values in six columns where rows 2–10 are
  empty. Written as empty.

## Where the process spec and the real sheets disagree

The spec document was written from the old automation's code. Where it conflicts with these
sheets, the sheets win — they are what has actually been accepted.

| Spec says | Sheets show |
|---|---|
| Initial load is **LF** with a trailing newline | **CRLF**, trailing newline varies |
| Wizard upload **requires** a BOM | `order_load.csv` has none |
| `sim_serial` == `device_imei` per row | Three distinct series, offset by 10 |
| `shipment_tracking_id` is the Salesforce OrderNumber | A separate tracking id (`B3E110005`, `RTS120011`, …) or literally `NA` |
| One initial-load format, one accessory format | Six families, five operations, 13 formats |
