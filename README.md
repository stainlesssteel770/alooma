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

- **Packing** — pick a craft, type the number of kits (orders are multiples of 6), then
  choose a path: **Print** — print a 4×6 packing sheet for a thermal label printer (with a
  blank `Order ID` line) and hit **Complete** when the order is packed (printing unlocks
  it); or **Hand pack** — the on-screen pack list (digital checklist) appears, check items
  off, then **Complete**. Either way the craft's items come off inventory.
- **Bulk import** — for orders already packed by hand off a label: queue each craft + kit
  amount and record them all at once (one save; each order still lands in History as its
  own entry).
- **Inventory** — everything starts at 0. Receive stock, fix counts, set a low-stock warning
  level per item (shown when an item is at or below it). Prints a 4×6 current-inventory
  report and a 4×6 count sheet (`Item | Should be | Counted`); counted numbers are typed
  back in via **Enter counted numbers**.
- **History** — every change with date and amounts; any entry can be edited or undone.
- **Settings** — GitHub sign-in or token connect/disconnect, export/import backup.
  A device that isn't connected is **view-only**: it sees only the Inventory and History
  tabs (tap the "View only" badge in the header to reach the connect screen).

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
  tier rule, tray alternation, pack/receive/undo/edit arithmetic, plus the Batch C settings model — box-rule matching and placeholder bins (88 checks).
- `node tests/test-ui.mjs` — drives the real page and real buttons in headless Chrome with
  the GitHub API mocked (Batch A: nothing pre-selected, disabled-button reasons, print
  unlocks Complete, in-app confirm sheet for Complete/Record/Undo/Edit; plus connect,
  item-panel receive + warning, count entry, prints, tap-target sizes, disconnect; Batch B: picker fold + first-row position, solid action bar, inventory filters + print menu, receive delivery in one save; Batch C: feature toggles off = today's screens, box rule + per-order override + printed BOXES line, bin labels + panel Bin mode + bin sort; corrected flow: view-only tab gating + badge connect door, checklist only under Hand pack, Bulk import tab batch recorded in one save — 137 checks).
- `node tests/test-offline.mjs` — blocks the data load and verifies the single
  "Can't reach the stock data" empty state and that Retry recovers (9 checks).
- `node tests/check-print.mjs` — renders the prints to PDF and verifies the page size is
  exactly 4×6 in and the page count equals the content (no blank labels).
- `node tests/test-a11y.mjs` — runs axe-core over all five tabs and fails on any
  serious or critical accessibility violation (Batch C: 0 on every tab).
- `node tests/screenshots.mjs` — captures the main screens at 390px for batch reports.

The same suites run on GitHub's machines: Actions tab → **Tests** → Run workflow
(manual trigger, read-only, no secrets — every suite uses sample data and a mocked
API). Screenshots and print PDFs are attached to each run as artifacts.

## Making an editor token (one time)

GitHub → profile → Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate. Repository access: only `alooma`. Permissions →
Contents: **Read and write**. Paste it into the site under Settings on each device
you want to edit from.
