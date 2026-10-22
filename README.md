# Alooma — Warehouse Packing Helper

A standalone packing aid for one warehouse. No order feed — everything is entered by hand.
Live site: https://stainlesssteel770.github.io/alooma/

## How it works

- **Viewers** open the link and see current status. No sign-in, no access code.
- **The editor** connects once per device (Settings → paste a GitHub token). The token is
  saved only in that device's browser storage — never in this repo — and can be removed
  any time with **Settings → Disconnect token**.
- All data lives in [`data.json`](data.json) in this repo. Every change (received, packed,
  hand-packed, count fix) is committed to that file through the GitHub API, so every device
  sees the same current status. History inside `data.json` logs every change and supports
  edit + undo. Export/import backup lives in Settings.

## Pages

- **Packing** — pick a craft, type the number of kits (orders are multiples of 6), print a
  4×6 packing sheet for a thermal label printer (with a blank `Order ID` line), open the
  on-screen pack list (digital checklist), and hit **Completed packing** to subtract the
  craft's items from inventory. One craft at a time, one sheet per craft.
- **Hand-packed** — for orders packed by hand off a label: craft + kits, subtracts the same items.
- **Inventory** — everything starts at 0. Receive stock, fix counts, set a low-stock warning
  level per item (shown when an item is at or below it). Prints a 4×6 current-inventory
  report and a 4×6 count sheet (`Item | Should be | Counted`); counted numbers are typed
  back in via **Enter counted numbers**.
- **History** — every change with date and amounts; any entry can be edited or undone.
- **Settings** — GitHub token connect/disconnect, export/import backup.

## Quantity rules (per 6 kits, from the old site + owner, 2026-10-22)

Most lines are qty-per-6-kits from the recipe tables in `logic.js`. Two special rules:

- **Heat gun** and **Wood burning cream** (Hafrashat Challah): 1 per 3 batches —
  6–18 kits = 1, 24–36 = 2, 42–54 = 3 — `ceil(kits / 18)`.
- **JCA Clay Trays** alternate: one tray per 6 kits split A, B, A, B… (6 kits = A1, 12 = A1+B1,
  18 = A2+B1, 24 = A2+B2, 30 = A3+B2). Tambourines use 1 large-square tray per 6 kits.
  JCA Instructions brochure is 2 per 6 kits (confirmed — every other brochure is 6).

Shared items (Scissors, Tacky Glue, Permanent Markers) are counted once in inventory,
not per craft. Distinct items are never merged (toothpicks ≠ wooden picks, parchment
paper ≠ parchment circle, Clay Tray A ≠ B).

## Tests

- `node tests/test-logic.js` — quantity logic: CAK-18 deductions match the old site exactly,
  tier rule, tray alternation, pack/receive/undo/edit arithmetic (71 checks).
- `node tests/test-ui.mjs` — drives the real page and real buttons in headless Chrome with
  the GitHub API mocked (connect, receive, threshold, complete pack, undo, hand-pack,
  count entry, edit, prints, disconnect — 32 checks).
- `node tests/check-print.mjs` — renders the prints to PDF and verifies the page size is
  exactly 4×6 in.

## Making an editor token (one time)

GitHub → profile → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate. Repository access: only `alooma`. Permissions →
Contents: **Read and write**. Paste it into the site under Settings on each device
you want to edit from.
