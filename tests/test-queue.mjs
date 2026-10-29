/* Queue tests (brief item 1): multi-craft packing queue on the Packing tab.
   Add lines -> Print all (one job, one craft per page, queue order) ->
   Complete per line (own History entry, SKU, deduction) -> Undo one.
   Hand pack all walks the checklists in order. Combined shortage and
   duplicate-craft rules are enforced at Print all / Hand pack all only.
   Run: node tests/test-queue.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8909;
let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "data-print.json"), "utf8"));
function resetRemote() {
  Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 100, threshold: null }; });
  remoteData.history = [];
  if (remoteData.settings && remoteData.settings.features) { remoteData.settings.features.boxes = false; remoteData.settings.features.bins = false; }
}
resetRemote();
let remoteSha = "sha-q1";
let putCount = 0;
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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 90000 });
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR " + e.message));
  /* A3: reloads while a walk/queue is restored correctly raise the
     browser's own leave prompt — accept it, never fight the guard. */
  page.on("dialog", (d) => d.accept());
  page.on("console", m => { if (m.type() === "error") console.log("CONSOLE-ERROR " + m.text()); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "alooma", login: "testeditor" }));
  });
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.startsWith("https://api.github.com/user") && req.method() === "GET") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "testeditor" }) });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "GET") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remoteData)) }) });
      if (req.method() === "PUT") {
        putCount++;
        const body = JSON.parse(req.postData());
        remoteData = JSON.parse(b64d(body.content));
        remoteSha = "sha-q" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);

  /* Queue mode: the first line enters it via the Queue button (the pick
     becomes line 1); later lines use Add. The picker never folds now, so
     real clicks work throughout. */
  async function queueFirst(craftName, kits) {
    await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.click("#btn-pack-queue");
    await sleep(250);
  }
  async function addLine(craftName, kits) {
    await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.click("#btn-queue-add");
    await sleep(250);
  }
  async function queueLines() {
    return page.$$eval("#pack-queue .queue-line", els => els.map(e => ({
      text: e.textContent.replace(/\s+/g, " ").trim(),
      dup: e.classList.contains("dup")
    })));
  }
  async function sheetVisible() {
    return page.$eval("#sheet-backdrop", e => !e.hidden);
  }
  async function sheetPrimary() {
    await page.click("#sheet-primary");
    await sleep(300);
  }
  async function sheetCancel() {
    await page.click("#sheet-cancel");
    await sleep(300);
  }
  async function reloadApp() {
    await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
  }

  /* ---- 1. Print all: 3 crafts, one job, queue order — and it COMPLETES ---- */
  await queueFirst("The Cakery", 36);
  await addLine("Tambourines", 12);
  await addLine("Hafrashat Challah", 18);
  const q1 = await queueLines();
  eq(q1.length, 3, "queue: 3 lines present");
  eq(q1.every(l => l.text.includes("kits")), true, "queue: lines show craft + kits");
  /* Item 4: Print all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-print");
  await sleep(300);
  const sections = await page.$$eval("#print-area .print-page", els => els.map(e => e.querySelector(".label-title").textContent));
  eq(sections, ["The Cakery", "Tambourines", "Hafrashat Challah"], "Print all: one job, one section per craft, queue order kept");
  const subtitles = await page.$$eval("#print-area .print-page .label-sub", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
  eq(subtitles, ["Total kits: 36 · Order ID: ____________ Packed by: ________ · Date: ________", "Total kits: 12 · Order ID: ____________ Packed by: ________ · Date: ________", "Total kits: 18 · Order ID: ____________ Packed by: ________ · Date: ________"], "Print all: each section keeps its own kit count");
  eq((await queueLines()).length, 0, "Print all: the queue clears — printing completed every line");
  eq(remoteData.history.length, 3, "Print all: 3 History entries at print time (A4)");
  eq(remoteData.history.map(h => h.title), [
    "Packed Hafrashat Challah — 18 kits (HCB-18)",
    "Packed Tambourines — 12 kits (TAM-12)",
    "Packed The Cakery — 36 kits (CAK-36)"
  ], "Print all: entries carry the right SKUs (newest first)");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 64, "deduction: CAK-36 took 36 Heart Jewelry Boxes (100 -> 64)");
  eq(remoteData.inventory["scissors"].qty, 82, "deduction: shared Scissors across the queue (CAK 12 + TAM 6 = 18, 100 -> 82)");
  /* A4: the print toast's UNDO splices every entry out of History (unlike
     History's own Undo, which marks entries undone) and restores stock. */
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(600);
  eq(remoteData.history.length, 0, "Print all UNDO: every entry spliced out of History");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 100, "Print all UNDO: stock restored");
  eq(remoteData.inventory["scissors"].qty, 100, "Print all UNDO: shared stock restored");

  /* ---- 2. Hand pack all walks the checklists in order ---- */
  await queueFirst("Blooming Mirrors", 6);
  await addLine("Tambourines", 12);
  await addLine("Judaic Clay-Art", 6);
  /* Item 4: Hand pack all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(300);
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 1 of 3", "Hand pack all: first craft opens with its position");
  async function completeChecklist() {
    await page.click("#btn-check-all");
    await sleep(250);
    await sheetPrimary(); /* "Mark all" confirm */
    await sleep(250);
    await page.click("#btn-complete-pack");
    await sleep(300);
    await sheetPrimary(); /* subtract confirm */
    await sleep(400);
  }
  await completeChecklist();
  /* Item 7: the hand-pack toast keeps the whole (SKU) unbroken — the
     parens sit inside the toast-sku span (Polish item 3 moved the SKU
     out of the ellipsized message; the span still holds it whole). */
  eq(await page.$eval("#toast .toast-sku", e => e.textContent.trim()), "(BM-6)", "item7: hand-pack toast (SKU) unbroken with parens inside the span");
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 2 of 3", "Hand pack all: completing craft 1 opens craft 2 automatically");
  await completeChecklist();
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 3 of 3", "Hand pack all: completing craft 2 opens craft 3 automatically");
  await completeChecklist();
  eq((await queueLines()).length, 0, "Hand pack all: last Complete returns to an empty Packing tab");
  eq(remoteData.history.length, 3, "Hand pack all: 3 entries (the print job was undone out of History)");
  eq(remoteData.history.slice(0, 3).map(h => h.title), [
    "Hand packed Judaic Clay-Art — 6 kits (JCA-6)",
    "Hand packed Tambourines — 12 kits (TAM-12)",
    "Hand packed Blooming Mirrors — 6 kits (BM-6)"
  ], "Hand pack all: newest entries are the walked crafts, newest first");
  /* Fix-round item 13: walked entries are type hand-packed and offer no
     Reprint in History (the gate is type === "packed"). */
  eq(remoteData.history.slice(0, 3).map(h => h.type), ["hand-packed", "hand-packed", "hand-packed"], "Hand pack all: walked entries are type hand-packed");
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  eq(await page.evaluate(() => [...document.querySelectorAll(".history-entry")].filter(el => el.textContent.includes("Hand packed")).every(el => !el.querySelector(".btn-reprint"))), true, "Hand pack all: hand entries offer no Reprint");
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);
  /* Undo one entry from History (via the confirm sheet): the BM-6 entry
     (third in newest-first order). Undo marks it undone and reverses its
     effects exactly — the entry stays in History, it is not deleted. */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  await page.evaluate(() => document.querySelectorAll(".history-entry .btn-undo")[2].click());
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Undo this entry?", "undo uses the confirm sheet");
  await sheetPrimary();
  await sleep(400);
  eq(remoteData.history.length, 3, "undo keeps the entry in History (marked undone, not deleted)");
  eq(remoteData.history[2].undone, true, "undo marks the BM-6 entry undone");
  eq(remoteData.inventory["heat-gun"].qty, 100, "undo restores the deducted stock (BM-6 heat gun 99 -> 100)");
  /* Batch C item 10: undoing a walked line restores the line and steps
     the walk back to it — the app auto-switches to Pack for the walk. */
  eq(await page.$eval("#tab-pack", e => e.classList.contains("active")), true, "walk undo: History undo auto-switches to the Pack tab");
  eq((await queueLines()).length, 1, "walk undo: the BM-6 line is back in the queue");
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 1 of 1", "walk undo: the walk steps back to Craft 1 of 1");
  eq(await page.$eval("#pack-sku", e => e.textContent), "BM-6", "walk undo: the restored BM-6 line is loaded");
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);

  /* ---- 3. Combined shortage across the queue is caught before starting ---- */
  remoteData.inventory["scissors"].qty = 5;
  remoteSha = "sha-q-short";
  await reloadApp();
  /* The item-10 restored BM-6 line persists on-device across the reload;
     drop it so the shortage section starts from its own clean queue. */
  while ((await queueLines()).length) {
    await page.evaluate(() => { document.querySelector("#pack-queue .queue-remove").click(); });
    await sleep(200);
  }
  eq((await queueLines()).length, 0, "shortage: restored walk line removed before starting");
  await queueFirst("The Cakery", 36);
  await addLine("Tambourines", 12);
  /* Item 4: Print all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(await sheetVisible(), true, "shortage: Print all stops at a confirm sheet");
  const sheetText = await page.$eval("#sheet-backdrop", e => e.textContent);
  eq(sheetText.includes("Scissors") && sheetText.includes("18"), true, "shortage: sheet names Scissors with the combined need (CAK 12 + TAM 6 = 18)");
  await sheetCancel();
  await sleep(300);
  eq(await page.$$eval("#print-area .print-page", els => els.length), 0, "shortage: cancelling prints nothing");
  eq((await queueLines()).length, 2, "shortage: cancelling keeps the queue intact");
  /* Clear the queue before the duplicate section (lines persist on-device).
     Remove one at a time, re-querying: each remove re-renders the list, so
     a bulk click on the old node list would hit detached nodes. */
  while ((await queueLines()).length) {
    await page.evaluate(() => { document.querySelector("#pack-queue .queue-remove").click(); });
    await sleep(200);
  }
  eq((await queueLines()).length, 0, "queue: lines can be removed before starting");

  /* ---- 4. Duplicates: silent while adding, pop-up at Print all ---- */
  resetRemote();
  remoteSha = "sha-q-dup";
  await reloadApp();
  await queueFirst("The Cakery", 12);
  await addLine("The Cakery", 18);
  eq(await sheetVisible(), false, "duplicates: no warning while adding the second Cakery line");
  /* Item 4: Print all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(await sheetVisible(), true, "duplicates: Print all shows the pop-up");
  const dupText = await page.$eval("#sheet-backdrop", e => e.textContent);
  eq(dupText.includes("Multiple of the same craft detected") && dupText.includes("x2") && dupText.includes("12 kits + 18 kits"), true, "duplicates: pop-up names the craft, count and kit amounts");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "YES", "duplicates: YES is the primary button");
  eq(await page.$eval("#sheet-primary", e => e.classList.contains("success")), true, "duplicates: YES is green (Batch C item 3)");
  eq(await page.$eval("#sheet-cancel", e => e.textContent), "NO", "duplicates: NO is the cancel button");
  eq(await page.$eval("#sheet-cancel", e => e.classList.contains("danger")), true, "duplicates: NO is red (Batch C item 3)");
  await sheetCancel(); /* NO */
  await sleep(300);
  eq(await sheetVisible(), false, "duplicates: NO closes the pop-up");
  eq(await page.$$eval("#print-area .print-page", els => els.length), 0, "duplicates: NO prints nothing");
  eq((await queueLines()).filter(l => l.dup).length, 2, "duplicates: NO highlights both duplicate lines");
  await page.click("#btn-queue-print");
  await sleep(300);
  await sheetPrimary(); /* YES */
  await sleep(300);
  const dupSections = await page.$$eval("#print-area .print-page .label-sub", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
  eq(dupSections, ["Total kits: 12 · Order ID: ____________ Packed by: ________ · Date: ________", "Total kits: 18 · Order ID: ____________ Packed by: ________ · Date: ________"], "duplicates: YES keeps two separate sheets, never merged");
  eq((await queueLines()).length, 0, "duplicates: YES completes both lines — the queue clears");
  eq(remoteData.history.slice(0, 2).map(h => h.title), [
    "Packed The Cakery — 18 kits (CAK-18)",
    "Packed The Cakery — 12 kits (CAK-12)"
  ], "duplicates: YES gives two separate entries and SKUs (newest first)");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(600);
  eq(remoteData.history.length, 0, "duplicates: print UNDO removes both entries");

  /* ---- Retest item 1: the queue-actions row must obey [hidden]. ----
     .queue-actions{display:flex} used to beat the UA hidden rule, so
     the row showed on fresh screens (7 buttons at once). Verified at
     390x664 with screenshots in ./screenshots/ (uploaded as evidence). */
  await page.setViewport({ width: 390, height: 664 });
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  async function rowVisible(id) {
    return await page.evaluate(id => {
      var el = document.getElementById(id);
      if (!el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }, id);
  }
  const SHOT = path.join(ROOT, "screenshots");
  fs.mkdirSync(SHOT, { recursive: true });
  eq(await rowVisible("pack-queue-actions"), false, "item1: fresh screen hides the queue row");
  eq(await rowVisible("pack-single-actions"), false, "item1: fresh screen hides the single row");
  await page.screenshot({ path: path.join(SHOT, "queue-row-fresh.jpg"), type: "jpeg", quality: 74 });
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming Mirrors")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
  await sleep(200);
  eq(await rowVisible("pack-single-actions"), true, "item1: single row appears once craft + kits are chosen");
  eq(await rowVisible("pack-queue-actions"), false, "item1: queue row still hidden with a pick but no Queue tap");
  await page.screenshot({ path: path.join(SHOT, "queue-row-picked.jpg"), type: "jpeg", quality: 74 });
  await page.click("#btn-pack-queue");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), true, "item1: queue row appears in Queue mode");
  eq(await rowVisible("pack-single-actions"), false, "item1: single row hides in Queue mode");
  eq(await page.$eval("#pack-queue-count", e => e.textContent), "1", "item1: queue holds the picked line");
  await page.screenshot({ path: path.join(SHOT, "queue-row-queuemode.jpg"), type: "jpeg", quality: 74 });
  /* Run 1 failed here only: at 390x664 Done's in-flow bottom was 654
     of 664, its center (616) under the tab bar's top edge (605), so
     the tap hit the tab bar — same interception family as the toast
     lesson. Fold-in fix: the row is pinned above the tab bar, so a
     plain first-paint tap must land. Probe the geometry (Node-side
     log, since page console is not forwarded) and assert it. */
  const doneDiag = await page.evaluate(() => {
    var b = document.getElementById("btn-queue-done");
    var r = b.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var top = document.elementFromPoint(cx, cy);
    var tabs = document.getElementById("tabs");
    var tr = tabs ? tabs.getBoundingClientRect() : null;
    return { doneTop: Math.round(r.top), doneBottom: Math.round(r.bottom), doneCenterY: Math.round(cy), topEl: top ? (top.id || top.className || top.tagName) : null, tabsTop: tr ? Math.round(tr.top) : null, hidden: document.getElementById("pack-queue-actions").hidden };
  });
  console.log("ITEM1-DIAG before Done click: " + JSON.stringify(doneDiag));
  /* Fold-in: the row is pinned above the tab bar, so Done must be
     tappable on first paint with a plain tap — no scrolling. */
  eq(doneDiag.topEl, "btn-queue-done", "item1: Done itself is on top at first paint");
  eq(doneDiag.doneBottom <= doneDiag.tabsTop, true, "item1: Done sits above the tab bar on first paint");
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), true, "item4: Done leaves the saved-queue row visible");
  eq(await rowVisible("btn-queue-add"), false, "item4: Add hides after Done");
  eq(await rowVisible("btn-queue-done"), false, "item4: Done hides after Done");
  eq(await rowVisible("btn-queue-print"), true, "item4: Print all appears after Done");
  eq(await rowVisible("btn-queue-hand"), true, "item4: Hand pack all appears after Done");
  eq(await page.$eval("#pack-queue-count", e => e.textContent), "1", "item1: Done keeps the saved queue");
  await page.screenshot({ path: path.join(SHOT, "queue-row-done.jpg"), type: "jpeg", quality: 74 });

  /* ---- Item 1 fold-in: pinned row at 390x844, first paint, plain tap ---- */
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming Mirrors")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
  await sleep(200);
  await page.click("#btn-pack-queue");
  await sleep(300);
  const d844 = await page.evaluate(() => {
    var b = document.getElementById("btn-queue-done");
    var r = b.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var top = document.elementFromPoint(cx, cy);
    var tabs = document.getElementById("tabs");
    var tr = tabs ? tabs.getBoundingClientRect() : null;
    return { doneBottom: Math.round(r.bottom), doneCenterY: Math.round(cy), topEl: top ? (top.id || top.className || top.tagName) : null, tabsTop: tr ? Math.round(tr.top) : null };
  });
  console.log("ITEM1-DIAG 844 before Done click: " + JSON.stringify(d844));
  eq(d844.topEl, "btn-queue-done", "item1-844: Done itself is on top at first paint");
  eq(d844.doneBottom <= d844.tabsTop, true, "item1-844: Done sits above the tab bar on first paint");
  await page.screenshot({ path: path.join(SHOT, "queue-row-queuemode-844.jpg"), type: "jpeg", quality: 74 });
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), true, "item4-844: Done leaves the saved-queue row visible");
  eq(await rowVisible("btn-queue-add"), false, "item4-844: Add hides after Done");
  eq(await rowVisible("btn-queue-done"), false, "item4-844: Done hides after Done");
  eq(await rowVisible("btn-queue-print"), true, "item4-844: Print all appears after Done");
  eq(await rowVisible("btn-queue-hand"), true, "item4-844: Hand pack all appears after Done");
  eq(await page.$eval("#pack-queue-count", e => e.textContent), "1", "item1-844: Done keeps the saved queue");
  await page.screenshot({ path: path.join(SHOT, "queue-row-done-844.jpg"), type: "jpeg", quality: 74 });

  /* ---- Item 1 fold-in: during a walk the row unpins (static) so it
     never covers the sticky Complete bar, which shares its band. ---- */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="12"]').click(); });
  await sleep(200);
  /* Polish item 5: the pick above entered Queue mode (a saved queue was
     waiting), so Add — not the hidden single-actions Queue button —
     adds this pick as line 2. */
  await page.click("#btn-queue-add");
  await sleep(300);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 2, "item1-walk: two lines queued");
  /* Item 4: Hand pack all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(500);
  const walkPos = await page.evaluate(() => {
    var el = document.getElementById("pack-queue-actions");
    return { cls: el.className, pos: getComputedStyle(el).position };
  });
  eq(walkPos.cls.includes("walking"), true, "item1-walk: row carries the walking class");
  eq(walkPos.pos, "static", "item1-walk: row unpins during the walk");
  eq(await rowVisible("btn-queue-done"), true, "item4-walk: Done stays visible mid-walk from saved state");
  /* The walk table is long, so Done is scrolled to center first — a
     user scrolls to it too; only the first-paint queue taps above are
     required to land without scrolling. */
  await page.evaluate(() => { document.getElementById("btn-queue-done").scrollIntoView({ block: "center" }); });
  await sleep(150);
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), true, "item4-walk: Done ends the walk but the saved row stays");
  eq(await rowVisible("btn-queue-print"), true, "item4-walk: Print all stays after ending the walk");
  eq(await rowVisible("btn-queue-hand"), true, "item4-walk: Hand pack all stays after ending the walk");

  /* ---- Item 2: sheets cap at viewport height, content scrolls,
     buttons stay pinned. Forced overflow: every item at 0, three
     full lines queued, so the shortage sheet is far taller than the
     viewport at 1366x900 and at 390x664. ---- */
  async function sheetGeom() {
    return await page.evaluate(() => {
      var sh = document.querySelector(".sheet");
      var sr = document.querySelector(".sheet-scroll");
      var pr = document.getElementById("sheet-primary").getBoundingClientRect();
      var cr = document.getElementById("sheet-cancel").getBoundingClientRect();
      return { sheetBottom: Math.round(sh.getBoundingClientRect().bottom), scrollH: sr.scrollHeight, clientH: sr.clientHeight, primBottom: Math.round(pr.bottom), cancelBottom: Math.round(cr.bottom), H: window.innerHeight };
    });
  }
  await page.setViewport({ width: 1366, height: 900 });
  Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k].qty = 0; });
  remoteSha = "sha-q-item2";
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  await queueFirst("Tambourines", 36);
  await addLine("The Cakery", 36);
  await addLine("Blooming Mirrors", 36);
  /* Item 4: Print all lives in the saved state, not in Queue mode. */
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-print");
  await sleep(400);
  eq(await sheetVisible(), true, "item2: Print all stops at the shortage sheet");
  eq(await page.$eval("#sheet-title", e => e.textContent.includes("Items short")), true, "item2: the sheet is the shortage sheet");
  const g900 = await sheetGeom();
  eq(g900.sheetBottom <= g900.H, true, "item2-1366x900: sheet fits the viewport");
  eq(g900.scrollH > g900.clientH, true, "item2-1366x900: content overflows, so it must scroll");
  eq(g900.primBottom <= g900.H && g900.cancelBottom <= g900.H, true, "item2-1366x900: both buttons inside the viewport");
  const scrolled900 = await page.evaluate(() => {
    var sr = document.querySelector(".sheet-scroll");
    sr.scrollTop = sr.scrollHeight;
    return sr.scrollTop;
  });
  eq(scrolled900 > 0, true, "item2-1366x900: the scroll area actually moves");
  await page.screenshot({ path: path.join(SHOT, "sheet-overflow-desktop.jpg"), type: "jpeg", quality: 74 });
  await sheetCancel();
  eq(await sheetVisible(), false, "item2: Go back closes the sheet");
  eq((await queueLines()).length, 3, "item2: Go back keeps the queue intact");
  await page.setViewport({ width: 390, height: 664 });
  await sleep(300);
  await page.click("#btn-queue-print");
  await sleep(400);
  eq(await sheetVisible(), true, "item2-390x664: shortage sheet opens");
  const g664 = await sheetGeom();
  eq(g664.sheetBottom <= g664.H, true, "item2-390x664: sheet fits the viewport");
  eq(g664.scrollH > g664.clientH, true, "item2-390x664: content overflows, so it must scroll");
  eq(g664.primBottom <= g664.H && g664.cancelBottom <= g664.H, true, "item2-390x664: both buttons inside the viewport");
  await page.screenshot({ path: path.join(SHOT, "sheet-overflow-phone.jpg"), type: "jpeg", quality: 74 });
  await sheetCancel();

  /* ---- Item 6: a manually typed kits value shows in the dropdown ---- */
  await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Tambourines");
  await page.evaluate(() => document.querySelector("#pack-kits-plus").click());
  await sleep(150);
  await page.evaluate(() => { const i = document.querySelector("#pack-kits"); i.focus(); i.value = "42"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(200);
  /* Polish item 5: this section runs in the saved state, and the pick
     above already entered Queue mode — so Add appends the pick. */
  await page.click("#btn-queue-add");
  await sleep(250);
  const lines6 = await page.$$eval("#pack-queue .queue-line", els => els.map(e => ({
    sel: e.querySelector(".queue-kits") ? e.querySelector(".queue-kits").value : null,
    text: e.textContent.replace(/\s+/g, " ").trim()
  })));
  const tam42 = lines6[lines6.length - 1];
  eq(tam42.sel, "42", "item6: the dropdown shows the typed 42, not 6");
  eq(tam42.text.includes("TAM-42"), true, "item6: the line still holds TAM-42");
  /* Force a re-render (change the pick) and confirm nothing silently changed. */
  await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Blooming Mirrors");
  await sleep(250);
  const lines6b = await page.$$eval("#pack-queue .queue-line", els => els.map(e => ({
    sel: e.querySelector(".queue-kits") ? e.querySelector(".queue-kits").value : null,
    text: e.textContent.replace(/\s+/g, " ").trim()
  })));
  const tam42b = lines6b[lines6b.length - 1];
  eq(tam42b.sel, "42", "item6: the dropdown still shows 42 after a re-render");
  eq(tam42b.text.includes("TAM-42"), true, "item6: the line still holds TAM-42 after a re-render");

  /* Retest item 2: Add to queue scrolls to the TOP (craft + kit chips). */
  await page.setViewport({ width: 390, height: 664 });
  /* Polish item 5: a pick with a saved queue enters Queue mode, so
     queueFirst's Queue tap needs a fresh queue — drop item 6's lines. */
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Blooming Mirrors", 6);
  /* queueFirst's Queue tap clears the pick, so re-pick before Add —
     without a pick the Add button is disabled and the click is a
     no-op (run 1 failed here on exactly that). */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
  await page.evaluate(() => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="12"]`).click(); });
  await sleep(150);
  const beforeAdd = (await queueLines()).length;
  /* Scroll to the bottom first, so a scroll-to-top is observable. */
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(200);
  await page.click("#btn-queue-add");
  await sleep(300);
  eq((await queueLines()).length, beforeAdd + 1, "item2: Add queued the line (not a no-op click)");
  const topGeo = await page.evaluate(() => {
    const cr = document.querySelector("#pack-crafts").getBoundingClientRect();
    const ch = document.querySelector("#pack-chips").getBoundingClientRect();
    return { craftsTop: Math.round(cr.top), chipsTop: Math.round(ch.top), vh: window.innerHeight };
  });
  eq(topGeo.craftsTop >= 0 && topGeo.craftsTop <= 120, true, "item2: crafts grid at the top after Add (top=" + topGeo.craftsTop + ")");
  eq(topGeo.chipsTop > 0 && topGeo.chipsTop < topGeo.vh, true, "item2: kit chips in view after Add (top=" + topGeo.chipsTop + ")");

  /* Retest item 3: a manual-count Add closes the manual box and resets
     the picker to the default chips. */
  await page.setViewport({ width: 390, height: 664 });
  /* Polish item 5: a pick with a saved queue enters Queue mode, so
     queueFirst's Queue tap needs a fresh queue — drop item 2's lines. */
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Tambourines", 12);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming Mirrors")).click());
  await page.click("#pack-kits-plus");
  await sleep(200);
  await page.evaluate(() => { const f = document.querySelector("#pack-kits"); f.focus(); f.value = "42"; f.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(250);
  await page.click("#btn-queue-add");
  await sleep(300);
  const manualGeo = await page.evaluate(() => ({
    manualHidden: document.querySelector("#pack-kits-manual").hidden,
    chipsHidden: document.querySelector("#pack-chips").hidden,
    fieldVal: document.querySelector("#pack-kits").value
  }));
  eq(manualGeo.manualHidden, true, "item3: manual box closes after a manual-count Add");
  eq(manualGeo.chipsHidden, false, "item3: chips return after a manual-count Add");
  eq(manualGeo.fieldVal, "", "item3: kits field clears after Add");
  eq((await queueLines()).some(l => l.text.includes("BM-42")), true, "item3: the manual-count line queued as BM-42");

  /* Retest item 4: Queue mode shows only Add + Done; after Done, the
     saved queue shows only Print all + Hand pack all, and they survive
     a reload while the queue has lines. */
  await page.setViewport({ width: 390, height: 664 });
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Blooming Mirrors", 6);
  eq(await rowVisible("btn-queue-add"), true, "item4: Add shows in Queue mode");
  eq(await rowVisible("btn-queue-done"), true, "item4: Done shows in Queue mode");
  eq(await rowVisible("btn-queue-print"), false, "item4: Print all hidden in Queue mode");
  eq(await rowVisible("btn-queue-hand"), false, "item4: Hand pack all hidden in Queue mode");
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), true, "item4: saved-queue row visible after Done");
  eq(await rowVisible("btn-queue-add"), false, "item4: Add hidden after Done");
  eq(await rowVisible("btn-queue-done"), false, "item4: Done hidden after Done");
  eq(await rowVisible("btn-queue-print"), true, "item4: Print all visible after Done");
  eq(await rowVisible("btn-queue-hand"), true, "item4: Hand pack all visible after Done");
  await reloadApp();
  eq((await queueLines()).length, 1, "item4: saved queue survives reload");
  eq(await rowVisible("pack-queue-actions"), true, "item4: saved-queue row visible after reload");
  eq(await rowVisible("btn-queue-print"), true, "item4: Print all still there after reload");
  eq(await rowVisible("btn-queue-hand"), true, "item4: Hand pack all still there after reload");

  /* Retest item 5: queue cards keep the X in a fixed right column,
     and craft picker rows wrap names inside their own column —
     checked at 360, 375 and 390 with all 6 crafts. */
  await page.setViewport({ width: 390, height: 664 });
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Miniature Interiors")).click());
  await page.evaluate(() => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="36"]`).click(); });
  await sleep(150);
  /* Polish item 5: item 4's saved line is still queued, so this pick
     already entered Queue mode — Add, not the hidden Queue button,
     puts the second card in for the geometry loop. */
  await page.click("#btn-queue-add");
  await sleep(300);
  for (const w of [360, 375, 390]) {
    await page.setViewport({ width: w, height: 664 });
    await reloadApp();
    await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
    await sleep(300);
    const geo = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("#pack-crafts .craft-btn")].map(b => {
        const r = b.getBoundingClientRect();
        return { top: Math.round(r.top), h: Math.round(r.height), over: b.scrollWidth > b.clientWidth };
      });
      const cards = [...document.querySelectorAll("#pack-queue .queue-line")].map(c => {
        const cr = c.getBoundingClientRect();
        const x = c.querySelector(".queue-remove").getBoundingClientRect();
        return { cy: (cr.top + cr.bottom) / 2, xy: (x.top + x.bottom) / 2, xLeft: Math.round(x.left), cRight: Math.round(cr.right), xTop: Math.round(x.top), xBottom: Math.round(x.bottom), cTop: Math.round(cr.top), cBottom: Math.round(cr.bottom) };
      });
      return { btns, cards };
    });
    eq(geo.btns.length, 6, "item5-" + w + ": all 6 crafts shown");
    eq(geo.btns.every(b => !b.over), true, "item5-" + w + ": no picker button overflows");
    const rows = {};
    geo.btns.forEach(b => { (rows[b.top] = rows[b.top] || []).push(b.h); });
    eq(Object.values(rows).every(hs => hs.every(h => Math.abs(h - hs[0]) <= 1)), true, "item5-" + w + ": same-row buttons share a height");
    eq(geo.cards.length >= 2, true, "item5-" + w + ": queue cards present");
    geo.cards.forEach((c, i) => {
      eq(Math.abs(c.xy - c.cy) <= 6, true, "item5-" + w + ": card " + i + " X vertically centred");
      eq(c.xLeft >= c.cRight - 60, true, "item5-" + w + ": card " + i + " X in the right column");
      eq(c.xTop >= c.cTop && c.xBottom <= c.cBottom, true, "item5-" + w + ": card " + i + " X never on its own line");
    });
  }

  /* Fix-round (batch c): the hand-pack Complete toast shows the full
     title, wrapping to 2 lines max, with the UNDO button fully on
     screen — at 390x844 and 360x740. */
  async function completeWalkToast() {
    await page.click("#btn-check-all");
    await sleep(250);
    await sheetPrimary(); /* "Mark all" confirm */
    await sleep(250);
    await page.click("#btn-complete-pack");
    await sleep(300);
    await sheetPrimary(); /* subtract confirm */
    await sleep(600);
  }
  /* Fix-round (batch c): one measurement for the new toast rule — the
     message wraps to 2 lines max with the full title visible (the last
     word renders inside the message box, so nothing is clamped away),
     nothing overflows horizontally, the SKU stays one line, and the
     UNDO button stays fully on screen. On the old one-line CSS this
     fails two ways: msgOver (run-1 sw=278 > cw=239) and toast width
     (phone margins were 8px, ~95.6% of the viewport). */
  async function measureToast() {
    return await page.evaluate(() => {
      const t = document.querySelector("#toast");
      if (!t || t.hidden) return null;
      const m = document.querySelector("#toast .toast-msg");
      const s = document.querySelector("#toast .toast-sku");
      const b = document.querySelector("#toast button");
      const out = { toastW: Math.round(t.getBoundingClientRect().width), vw: window.innerWidth, vh: window.innerHeight, msg: m ? m.textContent : "", lines: 0, lastWord: false, msgOver: false, sku: s ? s.textContent : null, skuLines: 0, skuOver: false, undo: null };
      if (m) {
        const r = document.createRange(); r.selectNodeContents(m);
        out.lines = new Set([...r.getClientRects()].map(x => Math.round(x.top))).size;
        out.msgOver = m.scrollWidth > m.clientWidth + 1;
        const tn = m.firstChild;
        if (tn && tn.nodeType === 3) {
          const txt = tn.textContent; const sp = txt.lastIndexOf(" ");
          const lw = document.createRange(); lw.setStart(tn, sp + 1); lw.setEnd(tn, txt.length);
          const rects = [...lw.getClientRects()]; const mr = m.getBoundingClientRect();
          out.lastWord = rects.length > 0 && rects[0].bottom <= mr.bottom + 1;
        }
      }
      if (s) {
        const r2 = document.createRange(); r2.selectNodeContents(s);
        out.skuLines = new Set([...r2.getClientRects()].map(x => Math.round(x.top))).size;
        out.skuOver = s.scrollWidth > s.clientWidth;
      }
      if (b) { const br = b.getBoundingClientRect(); out.undo = { left: Math.round(br.left), right: Math.round(br.right), top: Math.round(br.top), bottom: Math.round(br.bottom), h: Math.round(br.height) }; }
      return out;
    });
  }
  function toastAsserts(toast, size, titlePart, sku, label) {
    eq(!!toast, true, label + ": toast present at " + size);
    if (!toast) return;
    eq(toast.lines <= 2, true, label + ": message wraps to at most 2 lines at " + size + " (lines=" + toast.lines + ")");
    eq(toast.lastWord, true, label + ": full title visible at " + size + " (last word rendered)");
    eq(toast.msgOver, false, label + ": message does not overflow at " + size);
    eq(toast.msg.includes(titlePart), true, label + ": title present at " + size);
    eq(toast.sku && toast.sku.trim(), sku, label + ": SKU is " + sku + " at " + size);
    eq(toast.skuLines, 1, label + ": SKU is one line at " + size);
    eq(toast.skuOver, false, label + ": SKU does not overflow at " + size);
    eq(!!toast.undo, true, label + ": Undo button present at " + size);
    if (toast.undo) {
      eq(toast.undo.left >= 0 && toast.undo.right <= toast.vw && toast.undo.top >= 0 && toast.undo.bottom <= toast.vh, true, label + ": Undo fully on screen at " + size);
      eq(toast.undo.h >= 40 && toast.undo.h <= 56, true, label + ": Undo is one line at " + size + " (h=" + toast.undo.h + ")");
    }
    eq(toast.toastW <= Math.round(toast.vw * 0.92) + 1, true, label + ": toast at most 92% wide at " + size + " (w=" + toast.toastW + " vw=" + toast.vw + ")");
  }
  await page.setViewport({ width: 390, height: 844 });
  /* Item-2's section left every item at 0 — without stock, Hand stops
     at the shortage sheet and no walk starts (run 1 threw on the
     hidden check-all for exactly that). */
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Blooming Mirrors", 6);
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(300);
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 1 of 1", "item6: walk opens on craft 1 of 1");
  await completeWalkToast();
  const toast6 = await measureToast();
  toastAsserts(toast6, "390x844", "Hand packed Blooming Mirrors — 6 kits", "(BM-6)", "item6");
  await page.setViewport({ width: 360, height: 740 });
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Miniature Interiors", 6);
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(300);
  await completeWalkToast();
  const toast6b = await measureToast();
  toastAsserts(toast6b, "360x740", "Hand packed Miniature Interiors — 6 kits", "(MI-6)", "item6");

  /* Retest item 7: the picked "Add MI-36" fits one line in the pinned
     row, as do Print all / Hand pack all in the saved state. */
  for (const w of [360, 375, 390]) {
    await page.setViewport({ width: w, height: 664 });
    await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
    await reloadApp();
    await queueFirst("Miniature Interiors", 36);
    /* queueFirst's Queue tap clears the pick, so re-pick for the
       picked-state Add label. */
    await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Miniature Interiors")).click());
    await page.evaluate(() => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="36"]`).click(); });
    await sleep(200);
    /* Line count from distinct text tops — button height alone can't
       prove one line (padding + min-height dominate it), and raw rect
       count splits at the nowrap span even on one line. */
    const addGeo = await page.evaluate(() => {
      const b = document.querySelector("#btn-queue-add");
      if (!b) return null;
      const r = document.createRange();
      r.selectNodeContents(b);
      const tops = [...r.getClientRects()].map(x => Math.round(x.top));
      return { lines: [...new Set(tops)].length, over: b.scrollWidth > b.clientWidth };
    });
    eq(!!addGeo, true, "item7-" + w + ": picked Add button present");
    eq(addGeo && addGeo.lines, 1, "item7-" + w + ": picked Add is one line");
    eq(addGeo && !addGeo.over, true, "item7-" + w + ": picked Add does not overflow");
    await page.click("#btn-queue-done");
    await sleep(300);
    const savedGeo = await page.evaluate(() => {
      return ["btn-queue-print", "btn-queue-hand"].map(id => {
        const b = document.querySelector("#" + id);
        if (!b) return null;
        const r = document.createRange();
        r.selectNodeContents(b);
        const tops = [...r.getClientRects()].map(x => Math.round(x.top));
        return { lines: [...new Set(tops)].length, over: b.scrollWidth > b.clientWidth };
      });
    });
    eq(savedGeo.every(g => g && g.lines === 1), true, "item7-" + w + ": Print all / Hand pack all are one line");
    eq(savedGeo.every(g => g && !g.over), true, "item7-" + w + ": Print all / Hand pack all do not overflow");
  }

  /* Polish item 2: picker rows equal height at 360/375/390, selected
     or not. The old layout failed this live: Miniature Interiors
     wrapped at 375 (80 vs 64px), and selecting it grew the card to
     82px as the tick stole width from the name. */
  for (const w of [360, 375, 390]) {
    await page.setViewport({ width: w, height: 664 });
    await page.evaluate(() => localStorage.removeItem("alooma.packqueue.v1"));
    await reloadApp();
    await page.waitForSelector("#pack-crafts .craft-btn");
    await sleep(300);
    const plain = await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].map(b => Math.round(b.getBoundingClientRect().height)));
    eq(plain.length, 6, "polish2-" + w + ": six craft buttons");
    eq(Math.max(...plain) - Math.min(...plain) <= 1, true, "polish2-" + w + ": all picker rows equal height unselected (" + plain.join(",") + ")");
    const miPlain = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#pack-crafts .craft-btn")].find(x => x.textContent.includes("Miniature Interiors"));
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    });
    await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Miniature Interiors")).click());
    await sleep(300);
    const sel = await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].map(b => Math.round(b.getBoundingClientRect().height)));
    eq(Math.max(...sel) - Math.min(...sel) <= 1, true, "polish2-" + w + ": all picker rows equal height selected (" + sel.join(",") + ")");
    const miSel = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#pack-crafts .craft-btn")].find(x => x.textContent.includes("Miniature Interiors"));
      return b ? Math.round(b.getBoundingClientRect().height) : 0;
    });
    eq(Math.abs(miSel - miPlain) <= 1, true, "polish2-" + w + ": selecting Miniature Interiors does not change its height (" + miPlain + " -> " + miSel + ")");
  }

  /* Polish item 1: Clay name is one line on the hand-pack checklist at
     360/375/390 — with bins on, as on Mark's phone (the bin tag may sit
     on its own line; the name itself must not wrap). */
  remoteData.settings.features.bins = true;
  remoteData.settings.bins = remoteData.settings.bins || {};
  remoteData.settings.bins["colored-clay-tool-tray"] = "B3";
  for (const w of [360, 375, 390]) {
    await page.setViewport({ width: w, height: 664 });
    await page.evaluate(() => localStorage.removeItem("alooma.packqueue.v1"));
    await reloadApp();
    await page.waitForSelector("#pack-crafts .craft-btn");
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming Mirrors")).click());
    await sleep(200);
    await page.evaluate(() => document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click());
    await sleep(200);
    await page.evaluate(() => document.querySelector("#btn-pack-hand").scrollIntoView({block: "center"}));
    await page.click("#btn-pack-hand");
    await page.waitForFunction(() => document.querySelectorAll("#pack-table tbody tr").length > 0, { timeout: 15000 });
    const clay = await page.evaluate(() => {
      const el = [...document.querySelectorAll("#pack-table .row-name")].find(s => s.textContent === "Clay Tray + 6 Picks");
      if (!el) return null;
      const tops = [...new Set([...el.getClientRects()].map(r => Math.round(r.top)))];
      /* Full unwrapped width of the name, measured on a hidden nowrap
         clone inside the same cell (so it inherits the cell's font).
         Reported in the assertion label: on failure the numbers ride
         along, so the next fix is data-driven, not another guess. */
      const clone = el.cloneNode(true);
      clone.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;";
      el.parentElement.appendChild(clone);
      const full = Math.round(clone.getBoundingClientRect().width);
      clone.remove();
      const td = el.closest("td");
      const cs = getComputedStyle(td);
      const table = document.querySelector("#pack-table");
      return { tops: tops.length, over: el.scrollWidth > el.clientWidth, text: el.textContent,
        full: full, cell: Math.round(td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)),
        table: table ? Math.round(table.getBoundingClientRect().width) : 0,
        doc: document.documentElement.clientWidth };
    });
    eq(!!clay, true, "polish1-" + w + ": Clay row present on the BM-6 checklist");
    if (clay) {
      eq(clay.text, "Clay Tray + 6 Picks", "polish1-" + w + ": Clay name text");
      eq(clay.tops, 1, "polish1-" + w + ": Clay name is one line (full " + clay.full + " cell-content " + clay.cell + " table " + clay.table + " doc " + clay.doc + ")");
      eq(clay.over, false, "polish1-" + w + ": Clay name does not overflow");
    }
  }

  /* Fix-round (batch c): the Complete toast shows the full title,
     wrapping to 2 lines max, with the SKU intact and UNDO on screen
     at 360x740. Same check for the print toast's bare SKU. */
  await page.setViewport({ width: 360, height: 740 });
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Blooming Mirrors", 6);
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(300);
  await completeWalkToast();
  const toast3 = await measureToast();
  toastAsserts(toast3, "360x740", "Hand packed Blooming Mirrors — 6 kits", "(BM-6)", "polish3");
  /* Print toast, same mechanism, bare SKU (no parens). */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming Mirrors")).click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector("#btn-pack-print").scrollIntoView({block: "center"}));
  await page.click("#btn-pack-print");
  await page.waitForFunction(() => { const s = document.querySelector("#toast .toast-sku"); return s && !document.querySelector("#toast").hidden; }, { timeout: 15000 });
  const toast3p = await page.evaluate(() => {
    const s = document.querySelector("#toast .toast-sku");
    return s ? { text: s.textContent, tops: [...new Set([...s.getClientRects()].map(r => Math.round(r.top)))].length,
      over: s.scrollWidth > s.clientWidth } : null;
  });
  eq(!!toast3p, true, "polish3: Print toast has a SKU span at 360");
  if (toast3p) {
    eq(toast3p.text.trim(), "BM-6", "polish3: Print toast SKU is BM-6 at 360");
    eq(toast3p.tops, 1, "polish3: Print toast SKU is one line at 360");
    eq(toast3p.over, false, "polish3: Print toast SKU does not overflow at 360");
  }

  /* Polish item 4: a queue card's SKU never breaks across lines —
     "CAK-18" stays whole at 360/375/390, and the card itself stays
     inside the viewport. */
  for (const w of [360, 375, 390]) {
    await page.setViewport({ width: w, height: 664 });
    await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
    await reloadApp();
    await queueFirst("The Cakery", 18);
    const sku4 = await page.evaluate(() => {
      const el = [...document.querySelectorAll("#pack-queue .nowrap")].find(s => s.textContent === "CAK-18");
      if (!el) return null;
      const row = el.closest(".queue-line");
      return { tops: [...new Set([...el.getClientRects()].map(r => Math.round(r.top)))].length,
        over: el.scrollWidth > el.clientWidth,
        rowR: row ? Math.round(row.getBoundingClientRect().right) : 0 };
    });
    eq(!!sku4, true, "polish4-" + w + ": queue card has a CAK-18 nowrap span");
    if (sku4) {
      eq(sku4.tops, 1, "polish4-" + w + ": queue card SKU is one line");
      eq(sku4.over, false, "polish4-" + w + ": queue card SKU does not overflow");
      eq(sku4.rowR <= w, true, "polish4-" + w + ": queue card stays inside the viewport (right=" + sku4.rowR + ")");
    }
  }

  /* Polish item 5: a saved queue plus a pick shows only the queue-mode
     set (Add + Done) — never the single-actions row on top of the
     saved row — and Done returns to just Print all + Hand pack all. */
  await page.setViewport({ width: 390, height: 664 });
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Blooming Mirrors", 6);
  await addLine("Tambourines", 12);
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Miniature Interiors")).click());
  await sleep(200);
  await page.evaluate(() => document.querySelector('.kits-chip[data-for="pack"][data-kits="36"]').click());
  await sleep(300);
  const pick5 = await page.evaluate(() => {
    const single = document.querySelector("#pack-single-actions");
    const btns = [...document.querySelectorAll("#pack-queue-actions button")].filter(b => !b.hidden && b.getBoundingClientRect().height > 0);
    return { singleHidden: single ? single.hidden : null, texts: btns.map(b => b.textContent.trim()) };
  });
  eq(pick5.singleHidden, true, "polish5: single-actions hidden with a saved queue + pick");
  eq(pick5.texts.length, 2, "polish5: exactly 2 queue-row buttons with a saved queue + pick (" + pick5.texts.join("|") + ")");
  eq(pick5.texts.includes("Done"), true, "polish5: Done among the queue-row buttons");
  eq(pick5.texts.some(t => t.startsWith("Add")), true, "polish5: Add among the queue-row buttons");
  await page.click("#btn-queue-done");
  await sleep(300);
  const done5 = await page.evaluate(() => {
    const single = document.querySelector("#pack-single-actions");
    const btns = [...document.querySelectorAll("#pack-queue-actions button")].filter(b => !b.hidden && b.getBoundingClientRect().height > 0);
    const checks = [...document.querySelectorAll("#pack-crafts .craft-check")].map(c => c.textContent);
    return { singleHidden: single ? single.hidden : null, texts: btns.map(b => b.textContent.trim()),
      anyChecked: checks.some(c => c !== "") };
  });
  eq(done5.singleHidden, true, "polish5: single-actions still hidden after Done (pick cleared)");
  eq(done5.texts.length, 2, "polish5: exactly 2 queue-row buttons after Done (" + done5.texts.join("|") + ")");
  eq(done5.texts.includes("Print all"), true, "polish5: Print all visible after Done");
  eq(done5.texts.includes("Hand pack all"), true, "polish5: Hand pack all visible after Done");
  eq(done5.anyChecked, false, "polish5: no craft stays picked after Done");

  /* ---- Fix 1: hand-pack ticks are durable per order ---- */
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); localStorage.removeItem("alooma.handticks.v1"); });
  await reloadApp();
  await queueFirst("Hafrashat Challah", 6);
  await addLine("Hafrashat Challah", 6);
  const qids = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]").map(l => l.uid));
  eq(qids.length, 2, "fix1: two queue lines stored");
  eq(new Set(qids).size, 2, "fix1: two identical lines get distinct uids");
  await page.click("#btn-queue-done");
  await sleep(300);
  await page.click("#btn-queue-hand");
  await sleep(400);
  /* two identical lines raise the duplicate-craft sheet — confirm it was intentional */
  async function acceptDupSheet() {
    const t = await page.$eval("#sheet-backdrop", e => !e.hidden ? document.querySelector("#sheet-title").textContent : "").catch(() => "");
    if (t === "Multiple of the same craft detected") { await page.click("#sheet-primary"); await sleep(400); }
  }
  await acceptDupSheet();
  const ticked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#pack-table tbody input[type=checkbox]")];
    if (boxes.length < 2) return -1;
    boxes[0].click(); boxes[1].click();
    return boxes.filter(b => b.checked).length;
  });
  await sleep(300);
  eq(ticked, 2, "fix1: 2 boxes ticked");
  const ht1 = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.handticks.v1") || "{}"));
  eq(Object.keys(ht1), [qids[0]], "fix1: ticks stored under the first line's uid");
  eq(ht1[qids[0]].length, 2, "fix1: 2 ticked item ids stored");
  await reloadApp();
  const qidsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]").map(l => l.uid));
  eq(qidsAfter, qids, "fix1: queue uids survive reload");
  await page.click("#btn-queue-hand");
  await sleep(400);
  await acceptDupSheet();
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-table tbody input[type=checkbox]")].filter(b => b.checked).length), 2, "fix1: the same 2 ticks come back after reload");
  eq(remoteData.inventory["wood-board"].qty, 100, "fix1: stock unchanged by ticking + reload");
  await page.click("#btn-check-all");
  await sleep(250);
  await sheetPrimary(); /* "Mark all" confirm */
  await sleep(250);
  await page.click("#btn-complete-pack");
  await sleep(300);
  await sheetPrimary(); /* subtract confirm */
  await sleep(500);
  const ht2 = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.handticks.v1") || "{}"));
  eq(ht2[qids[0]], undefined, "fix1: completed line's ticks cleared");
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-table tbody input[type=checkbox]")].filter(b => b.checked).length), 0, "fix1: second identical order starts unticked");
  eq(remoteData.history.length, 1, "fix1: exactly 1 history entry after reload + complete");
  eq(remoteData.history[0].type, "hand-packed", "fix1: the entry is hand-packed");

  /* ---- Fix 5: queue mode button reads Cancel when empty, Done with lines ---- */
  resetRemote();
  await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
  await reloadApp();
  await queueFirst("Tambourines", 6);
  eq(await page.$eval("#btn-queue-done", e => e.textContent), "Done", "fix5: button reads Done with 1 line");
  await page.evaluate(() => { const b = document.querySelector("#pack-queue .queue-remove"); if (b) b.click(); });
  await sleep(300);
  eq(await page.$eval("#btn-queue-done", e => e.textContent), "Cancel", "fix5: button reads Cancel once the queue is empty");
  const histBefore = remoteData.history.length;
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await page.$eval("#pack-queue-actions", e => e.hidden), true, "fix5: Cancel leaves queue mode for the normal Packing screen");
  eq(remoteData.history.length, histBefore, "fix5: Cancel changes no stock or History");
  await queueFirst("Tambourines", 6);
  await addLine("Blooming Mirrors", 6);
  eq(await page.$eval("#btn-queue-done", e => e.textContent), "Done", "fix5: Done with 2 lines");
  await page.click("#btn-queue-done");
  await sleep(300);
  const savedBtns = await page.$$eval("#pack-queue-actions button", els => els.filter(b => !b.hidden).map(b => b.textContent.trim()));
  eq(savedBtns.includes("Print all") && savedBtns.includes("Hand pack all"), true, "fix5: Done with orders shows Print all / Hand pack all as today");

  console.log(fail ? "QUEUE TESTS FAILED (" + fail + ")" : "all queue tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
