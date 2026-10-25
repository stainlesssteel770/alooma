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

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
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
  await page.click("#btn-queue-print");
  await sleep(300);
  const sections = await page.$$eval("#print-area .print-page", els => els.map(e => e.querySelector(".label-title").textContent));
  eq(sections, ["The Cakery", "Tambourines", "Hafrashat Challah"], "Print all: one job, one section per craft, queue order kept");
  const subtitles = await page.$$eval("#print-area .print-page .label-sub", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
  eq(subtitles, ["Total kits: 36 Order ID: ____________", "Total kits: 12 Order ID: ____________", "Total kits: 18 Order ID: ____________"], "Print all: each section keeps its own kit count");
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
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 2 of 3", "Hand pack all: completing craft 1 opens craft 2 automatically");
  await completeChecklist();
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 3 of 3", "Hand pack all: completing craft 2 opens craft 3 automatically");
  await completeChecklist();
  eq((await queueLines()).length, 0, "Hand pack all: last Complete returns to an empty Packing tab");
  eq(remoteData.history.length, 3, "Hand pack all: 3 entries (the print job was undone out of History)");
  eq(remoteData.history.slice(0, 3).map(h => h.title), [
    "Packed Judaic Clay-Art — 6 kits (JCA-6)",
    "Packed Tambourines — 12 kits (TAM-12)",
    "Packed Blooming Mirrors — 6 kits (BM-6)"
  ], "Hand pack all: newest entries are the walked crafts, newest first");
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
  eq(dupSections, ["Total kits: 12 Order ID: ____________", "Total kits: 18 Order ID: ____________"], "duplicates: YES keeps two separate sheets, never merged");
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
  await page.click("#btn-queue-done");
  await sleep(300);
  eq(await rowVisible("pack-queue-actions"), false, "item1: Done hides the queue row again");
  eq(await page.$eval("#pack-queue-count", e => e.textContent), "1", "item1: Done keeps the saved queue");
  await page.screenshot({ path: path.join(SHOT, "queue-row-done.jpg"), type: "jpeg", quality: 74 });

  console.log(fail ? "QUEUE TESTS FAILED (" + fail + ")" : "all queue tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
