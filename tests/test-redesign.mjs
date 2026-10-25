/* Batch B redesign tests (brief items 5, 6, 7, 4, 11 + 5e Names).
   Failing-first: the old picker folds, has a stepper, mode buttons and
   Packed-by/Counted-by fields — every section below fails on it. */
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8915;
let failures = 0, passes = 0;
function ok(v, name) { if (v) { passes++; } else { failures++; console.log("FAIL " + name); } }
function eq(a, b, name) { if (a === b) { passes++; } else { failures++; console.log("FAIL " + name + "\n  expected " + JSON.stringify(b) + "\n  got      " + JSON.stringify(a)); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXE = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k].qty = 100; remote.inventory[k].threshold = null; });
remote.settings = { features: { boxes: false, bins: false, bulkTab: true } };
let remoteSha = "sha-1";
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const b64d = s => Buffer.from(s, "base64").toString("utf8");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(ROOT, rel === "/" ? "index.html" : rel.replace(/^\/+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 664 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  page.on("dialog", d => d.accept());
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    console.log("REQ-LOG " + req.method() + " " + url);
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }, body: "" });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() || "{}");
        if (body.sha !== remoteSha) return req.respond({ status: 409, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ message: "conflict" }) });
        const data = JSON.parse(b64d(body.content));
        Object.keys(remote).forEach(k => delete remote[k]);
        Object.assign(remote, data);
        remoteSha = "sha-2";
        return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
      return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(700);
  await page.evaluate(() => { window.print = () => {}; });
  /* Seed guard: with bulkTab on, Bulk must be visible from the first render.
     (If this fails, the load itself didn't apply the seed — it is not a
     mid-run flip.) */
  eq(await page.$eval('[data-tab="bulk"]', e => !e.hidden), true, "seed: Bulk tab visible at load when bulkTab is on");
  /* Which data loaded? Seed sets every qty to 100; the live fallback does not. */
  await tab("inventory"); await sleep(300);
  console.log("LOAD-DIAG firstQty=" + await page.evaluate(() => { const el = document.querySelector(".inv-qty"); return el ? el.textContent.trim() : "?"; }) + " saveStatus=" + await page.evaluate(() => { const el = document.querySelector("#save-status"); return el ? el.textContent.trim() : "?"; }));
  await tab("pack"); await sleep(300);
  async function tab(name) {
    try {
      await page.click(`[data-tab="${name}"]`);
    } catch (e) {
      /* Diagnostic: a tab button with no box means applyTabAccess hid it —
         dump the actual button states instead of guessing. */
      const dump = await page.evaluate(() => [...document.querySelectorAll("#tabs button")].map(b => {
        const r = b.getBoundingClientRect();
        return b.getAttribute("data-tab") + ":hidden=" + b.hidden + ":rect=" + Math.round(r.width) + "x" + Math.round(r.height) + ":active=" + b.classList.contains("active");
      }).join(" | "));
      console.log("TAB-CLICK-FAILED " + name + " :: " + dump + " :: sheetOpen=" + await page.$eval("#sheet-backdrop", x => !x.hidden).catch(() => "?"));
      throw e;
    }
    await sleep(300);
    /* A3 (Batch B): switching tabs with unsaved work prompts Discard /
       Stay — this suite always discards, so a prompt must not stall it. */
    const prompted = await page.evaluate(() => {
      const bd = document.querySelector("#sheet-backdrop");
      return bd && !bd.hidden && document.querySelector("#sheet-title").textContent.includes("Unsaved");
    });
    if (prompted) { await page.click("#sheet-cancel"); await sleep(300); }
  }
  async function packCraft(name) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
    await sleep(150);
  }
  async function packChip(k) {
    await page.evaluate(v => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${v}"]`).click(); }, k);
    await sleep(150);
  }
  const vis = sel => page.$eval(sel, e => !!(e.offsetWidth || e.offsetHeight)).catch(() => false);
  const txt = sel => page.$eval(sel, e => e.textContent.trim()).catch(() => null);

  /* ---- 5e first (fresh tab, no pick to disturb): Names live in Settings ---- */
  await tab("settings");
  eq(await vis("#set-packed-by"), true, "5e: Settings has a Packed-by name field");
  eq(await vis("#set-counted-by"), true, "5e: Settings has a Counted-by name field");
  await page.evaluate(() => { const i = document.querySelector("#set-packed-by"); i.value = "Dina"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.evaluate(() => { const i = document.querySelector("#set-counted-by"); i.value = "Dina"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(200);
  eq(await page.evaluate(() => localStorage.getItem("alooma.packedby.v1")), "Dina", "5e: Packed-by name remembered per device");
  eq(await page.evaluate(() => localStorage.getItem("alooma.countedby.v1")), "Dina", "5e: Counted-by name remembered per device");
  await tab("pack");
  eq(await page.evaluate(() => !!document.querySelector("#pack-by")), false, "5e: no Packed-by field on Packing");
  eq(await page.evaluate(() => !!document.querySelector("#count-by")), false, "5e: no Counted-by field on the count form");

  /* ---- 5a: chips 6..36 + a "+" chip; no stepper by default ---- */
  eq(await page.$$eval("#pack-chips .kits-chip[data-kits]", els => els.map(e => e.getAttribute("data-kits")).join(",")), "6,12,18,24,30,36", "5a: quick-pick chips are 6, 12, 18, 24, 30, 36");
  eq(await vis("#pack-kits-plus"), true, "5a: a '+' chip follows 36");
  eq(await page.evaluate(() => !!document.querySelector("#pack-minus") || !!document.querySelector("#pack-plus")), false, "5a: no -/+ stepper on Packing by default");
  eq(await vis("#pack-kits-manual"), false, "5a: manual number box hidden until '+'");
  await page.evaluate(() => document.querySelector("#pack-kits-plus").click());
  await sleep(200);
  eq(await vis("#pack-kits-manual"), true, "5a: '+' swaps chips for a manual number box");
  eq(await vis("#pack-chips"), false, "5a: chips hide while the manual box shows");
  eq(await vis("#pack-kits-chips"), true, "5a: manual box offers a way back to chips");
  await page.evaluate(() => document.querySelector("#pack-kits-chips").click());
  await sleep(200);
  eq(await vis("#pack-chips"), true, "5a: back button restores chips");

  /* ---- 5b: nothing in the action area until craft AND kits ---- */
  eq(await vis("#pack-single-actions"), false, "5b: no action buttons before any choice");
  await packCraft("Blooming Mirrors");
  eq(await vis("#pack-single-actions"), false, "5b: craft alone still shows no buttons");

  /* ---- 5c + 6: both chosen -> exactly Queue / Print / Hand pack, picker stays open ---- */
  await packChip(12);
  eq(await vis("#pack-single-actions"), true, "5c: action row appears once both are chosen");
  eq(await page.$$eval("#pack-single-actions .btn", els => els.map(e => e.textContent.trim()).join("|")), "Queue|Print|Hand pack", "5c: exactly Queue, Print, Hand pack");
  eq(await vis("#pack-picker"), true, "6: picker stays open after a choice");
  eq(await page.evaluate(() => !!document.querySelector("#pack-picker-summary") && !document.querySelector("#pack-picker-summary").hidden), false, "6: no collapsed summary line");
  eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 1, "6: chosen craft stays highlighted");
  eq(await page.$$eval("#pack-chips .kits-chip.selected", els => els.map(e => e.getAttribute("data-kits")).join(",")), "12", "6: chosen chip stays highlighted");

  /* ---- 7: changing craft then kits updates highlights, picker never snaps shut ---- */
  await packCraft("Tambourines");
  await packChip(18);
  eq(await page.$eval("#pack-crafts .craft-btn.selected", e => e.textContent.includes("Tambourines")), true, "7: new craft highlights");
  eq(await page.$$eval("#pack-chips .kits-chip.selected", els => els.map(e => e.getAttribute("data-kits")).join(",")), "18", "7: new chip highlights");
  eq(await vis("#pack-picker"), true, "7: picker still open after changing both");
  eq(await txt("#pack-sku"), "TAM-18", "7: SKU follows the new pick");
  await page.evaluate(() => document.querySelector("#pack-kits-plus").click());
  await sleep(150);
  await page.evaluate(() => { const i = document.querySelector("#pack-kits"); i.focus(); i.value = "120"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(200);
  /* Batch C item 12: typing above 96 kits asks first — the confirm is
     guarded so the suite fails red (not crashes) on old code, where no
     sheet opens. */
  const largeOpen7 = await page.evaluate(() => {
    const bd = document.querySelector("#sheet-backdrop");
    return bd && !bd.hidden && document.querySelector("#sheet-title").textContent.includes("Large order");
  });
  eq(largeOpen7, true, "7: typing 120 opens the large-order confirm");
  if (largeOpen7) { await page.click("#sheet-primary"); await sleep(200); }
  eq(await page.$eval("#pack-kits", e => e.value), "120", "7: manual box types 120 (no collapse at 12)");
  await page.evaluate(() => document.querySelector("#pack-kits-chips").click());
  await sleep(150);

  /* ---- 5d: Queue mode works like Bulk ---- */
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-pack-queue");
  await sleep(300);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 1, "5d: current pick becomes the first queue line");
  eq(await page.evaluate(() => !!document.querySelector("#pack-queue .queue-line") && document.querySelector("#pack-queue .queue-line").textContent.includes("BM-6")), true, "5d: first line is BM-6");
  eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 0, "5d: picker clears for the next line");
  eq(await vis("#pack-single-actions"), false, "5d: single buttons hide in Queue mode");
  await packCraft("Tambourines");
  await packChip(12);
  await page.click("#btn-queue-add");
  await sleep(250);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 2, "5d: Add builds the list underneath");
  eq(await vis("#btn-queue-print"), true, "5d: Print all offered at the bottom");
  eq(await vis("#btn-queue-hand"), true, "5d: Hand pack all offered at the bottom");
  eq(await vis("#btn-queue-done"), true, "5d: Done leaves Queue mode");
  /* No duplicate prompt while adding (Batch C moves it to Print/Hand pack all) */
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-queue-add");
  await sleep(250);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 3, "5d: no duplicate prompt while adding");
  eq(await page.evaluate(() => document.querySelector("#sheet-backdrop").hidden), true, "5d: no sheet opened while adding");
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await vis("#pack-single-actions"), false, "5d: Done returns to single view (no pick, no buttons)");
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 3, "5d: Done keeps the saved queue");
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]").length), 3, "5d: saved queue persists");

  /* ---- 4: Clear all lives in the list header row, visible without scrolling ---- */
  const qHead = await page.evaluate(() => {
    const b = document.querySelector("#btn-queue-clear");
    if (!b || b.hidden) return "hidden";
    const head = b.closest("#pack-queue-head");
    const r = b.getBoundingClientRect();
    return { inHead: !!head, headText: head ? head.textContent.trim() : null, inView: r.bottom <= window.innerHeight };
  });
  eq(qHead !== "hidden" && qHead.inHead && qHead.headText.includes("Queue (3)") && qHead.inView, true, "4: Queue Clear all sits in the 'Queue (3)' header row, on screen (" + JSON.stringify(qHead) + ")");
  await tab("bulk");
  await page.evaluate(n => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), "Blooming Mirrors");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="bulk"][data-kits="6"]').click(); });
  await sleep(150);
  await page.click("#btn-bulk-add");
  await sleep(250);
  await page.evaluate(n => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), "Tambourines");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="bulk"][data-kits="12"]').click(); });
  await sleep(150);
  await page.click("#btn-bulk-add");
  await sleep(250);
  const bHead = await page.evaluate(() => {
    const b = document.querySelector("#btn-bulk-clear");
    if (!b || b.hidden) return "hidden";
    const head = b.closest("#bulk-lines-head");
    const r = b.getBoundingClientRect();
    const nav = document.querySelector("#tabs").getBoundingClientRect();
    return { inHead: !!head, headText: head ? head.textContent.trim() : null, inView: r.bottom <= nav.top };
  });
  eq(bHead !== "hidden" && bHead.inHead && bHead.headText.includes("Orders (2)") && bHead.inView, true, "4: Bulk Clear all sits in the 'Orders (2)' header row, on screen (" + JSON.stringify(bHead) + ")");

  /* ---- 5e (print): the saved name prints on the sheet ---- */
  await tab("pack");
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-pack-print");
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector("#print-area").textContent.includes("Packed by: Dina")), true, "5e: printed sheet carries the saved Packed-by name");

  /* ---- 11: during a walk, single buttons hide and the table clears the bar ---- */
  /* Section 4's Bulk detour Discarded the saved queue under A3, so rebuild
     the 5d shape first; the BM-6 below then makes 4 lines with BM-6 x3. */
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-pack-queue");
  await sleep(300);
  await packCraft("Tambourines");
  await packChip(12);
  await page.click("#btn-queue-add");
  await sleep(250);
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-queue-add");
  await sleep(250);
  await page.click("#btn-queue-done");
  await sleep(300);
  await packCraft("Blooming Mirrors");
  await packChip(6);
  await page.click("#btn-pack-queue");
  await sleep(300);
  /* Center the Hand button before the real click: a minimal scroll can park
     it under the fixed bottom nav, and the click would then hit a tab
     button and open the A3 leave prompt instead of starting the walk. */
  await page.evaluate(() => document.querySelector("#btn-queue-hand").scrollIntoView({ block: "center" }));
  await sleep(200);
  await page.click("#btn-queue-hand");
  await sleep(400);
  /* The queue holds BM-6 three times, so the duplicate check fires first. */
  const dupOpen = await page.evaluate(() => {
    const bd = document.querySelector("#sheet-backdrop");
    return bd && !bd.hidden && document.querySelector("#sheet-title").textContent.includes("Multiple of the same craft");
  });
  if (dupOpen) { await page.click("#sheet-primary"); await sleep(400); }
  console.log("WALK-DIAG dupOpen=" + dupOpen + " progress=" + JSON.stringify(await txt("#pack-queue-progress")) + " lines=" + await page.$$eval("#pack-queue .queue-line", els => els.length) + " sheetTitle=" + await page.evaluate(() => { const t = document.querySelector("#sheet-title"); return t ? t.textContent : "?"; }) + " sheetHidden=" + await page.evaluate(() => { const bd = document.querySelector("#sheet-backdrop"); return bd ? bd.hidden : "?"; }) + " handDisabled=" + await page.evaluate(() => { const b = document.querySelector("#btn-queue-hand"); return b ? b.disabled : "?"; }));
  eq(await txt("#pack-queue-progress"), "Craft 1 of 4", "11: walk starts at Craft 1 of 4");
  eq(await vis("#pack-single-actions"), false, "11: single buttons hidden during the walk");
  eq(await vis("#btn-queue-add"), false, "11: queue Add hidden during the walk");
  eq(await vis("#btn-queue-print"), false, "11: Print all hidden during the walk");
  eq(await vis("#btn-queue-hand"), false, "11: Hand pack all hidden during the walk");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(300);
  const tblOk = await page.evaluate(() => {
    const rows = document.querySelectorAll("#pack-table tbody tr");
    if (!rows.length) return "no rows";
    const last = rows[rows.length - 1].getBoundingClientRect();
    const bar = document.querySelector("#tab-pack .action-bar");
    const nav = document.querySelector("#tabs").getBoundingClientRect();
    const barTop = bar ? bar.getBoundingClientRect().top : Infinity;
    return last.bottom <= Math.min(barTop, nav.top) + 1;
  });
  eq(tblOk, true, "11: pack table's last row clears the sticky bar and nav at bottom scroll");

  /* ---- 10: walk undo restores stock + the queue line, steps back ---- */
  /* The walk sits at Craft 1 of 4 (BM-6 loaded). Complete it, then undo
     from the toast: stock returns, the line returns, the walk steps back. */
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* Mark all */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary"); /* Subtract from inventory */
  await sleep(600);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 3, "10: completing the first line removes it from the queue");
  eq(await txt("#pack-queue-progress"), "Craft 2 of 4", "10: walk advances to Craft 2 of 4");
  /* Baseline is 94, not 100: section 5e already printed one BM-6 (100-6).
     This completion takes it to 88; the toast undo returns it to 94. */
  eq(remote.inventory["tree-mirror"].qty, 88, "10: BM-6 deducted 6 tree mirrors");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(600);
  eq(remote.inventory["tree-mirror"].qty, 94, "10: toast undo restores the stock");
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 4, "10: toast undo restores the queue line");
  eq(await txt("#pack-queue-progress"), "Craft 1 of 4", "10: walk steps back to Craft 1 of 4");
  eq(await txt("#pack-sku"), "BM-6", "10: walk steps back to the restored BM-6 line");
  /* Two entries: this walk entry (undone, kept) plus section 5e's print. */
  eq(remote.history.length, 2, "10: the undone entry stays in History");
  eq(remote.history[0].undone, true, "10: the undone entry is marked undone");
  /* Finish the walk, then undo its last entry from History: the line
     comes back and the walk steps back to it, on the Pack tab. The loop
     guards on lines remaining so it can't crash on old code (where the
     toast undo above doesn't restore the line, leaving fewer to finish). */
  for (let c = 0; c < 4; c++) {
    if (!(await page.$$eval("#pack-queue .queue-line", els => els.length))) break;
    await page.click("#btn-check-all");
    await sleep(200);
    await page.click("#sheet-primary"); /* Mark all */
    await sleep(200);
    await page.click("#btn-complete-pack");
    await sleep(250);
    await page.click("#sheet-primary"); /* Subtract from inventory */
    await sleep(600);
  }
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 0, "10: finishing the walk empties the queue");
  await tab("history");
  await sleep(300);
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(300);
  await page.click("#sheet-primary"); /* Undo this entry? */
  await sleep(600);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 1, "10: History undo restores the finished line");
  eq(await page.$eval("#tab-pack", e => e.classList.contains("active")), true, "10: History undo steps back to the Pack tab");
  eq(await txt("#pack-queue-progress"), "Craft 1 of 1", "10: restored walk is Craft 1 of 1");
  eq(await txt("#pack-sku"), "BM-6", "10: restored line is the last BM-6");

  /* ---- 12: manual kits validation on the Pack manual box ---- */
  /* Leave the restored walk first (Done is only clickable while walking;
     the guard keeps this crash-free on old code, where the walk above
     never restored and Done is hidden). */
  if (await vis("#btn-queue-done")) {
    await page.evaluate(() => document.querySelector("#btn-queue-done").scrollIntoView({ block: "center" }));
    await sleep(200);
    await page.click("#btn-queue-done");
    await sleep(300);
  }
  await packCraft("Blooming Mirrors");
  await page.evaluate(() => document.querySelector("#pack-kits-plus").click());
  await sleep(150);
  async function typePackKits(v) {
    await page.evaluate(x => { const i = document.querySelector("#pack-kits"); i.focus(); i.value = x; i.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await sleep(250);
  }
  async function sheetIsOpen() { return page.$eval("#sheet-backdrop", e => !e.hidden); }
  await typePackKits("6.5");
  eq(await txt("#pack-error"), "Kits must be a whole number — decimals aren't allowed.", "12: decimals rejected, not silently treated as 6");
  eq(await vis("#pack-single-actions"), false, "12: no action buttons for a decimal kits value");
  await typePackKits("0");
  eq(await txt("#pack-error"), "Kits must be at least 6.", "12: zero rejected with 'must be at least 6'");
  eq(await vis("#pack-single-actions"), false, "12: no action buttons for zero kits");
  /* Item 5: large orders ask on blur/submit, never while typing;
     threshold 240 (was 96). */
  await typePackKits("300");
  eq(await sheetIsOpen(), false, "12: no sheet while typing a large value");
  await page.evaluate(() => document.querySelector("#pack-kits").blur());
  await sleep(250);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Large order", "12: kits above 240 ask on blur");
  eq(await page.$eval("#sheet-summary", e => e.textContent.includes("300 kits")), true, "12: large-order sheet names the amount");
  if (await sheetIsOpen()) { await page.click("#sheet-cancel"); await sleep(250); }
  /* Go back restores the focus-time value: the box was empty when first
     focused (the helper keeps focus across typings, so no re-focus
     fires) — "" is the correct previous value here, not "0". */
  eq(await page.$eval("#pack-kits", e => e.value), "", "12: Go back reverts to the previous value");
  await typePackKits("300");
  await page.evaluate(() => document.querySelector("#pack-kits").blur());
  await sleep(250);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Large order", "12: retyping asks again after Go back");
  if (await sheetIsOpen()) { await page.click("#sheet-primary"); await sleep(250); }
  eq(await page.$eval("#pack-kits", e => e.value), "300", "12: confirming keeps the large value");
  eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "12: confirming closes the sheet");
  eq(await vis("#pack-single-actions"), true, "12: action buttons appear for a confirmed large order");
  /* Boundary: exactly 240 does not ask. */
  await typePackKits("240");
  await page.evaluate(() => document.querySelector("#pack-kits").blur());
  await sleep(250);
  eq(await sheetIsOpen(), false, "12: exactly 240 does not ask");
  eq(await page.$eval("#pack-kits", e => e.value), "240", "12: 240 stays in the box");
  /* Submit path: a large value set without focus asks when submitted. */
  await page.evaluate(() => { const i = document.querySelector("#pack-kits"); i.value = "300"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(250);
  eq(await sheetIsOpen(), false, "12: unfocused large value asks nothing until submitted");
  await page.click("#btn-pack-queue");
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Large order", "12: submitting a large order asks first");
  await page.click("#sheet-primary");
  await sleep(300);
  eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "12: submitting confirm closes the sheet");
  eq(await vis("#pack-queue-actions"), true, "12: submitting confirm enters queue mode");

  console.log("REDESIGN TESTS: " + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
} finally {
  await browser.close().catch(() => {});
  server.close();
}
