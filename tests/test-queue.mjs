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

  async function addLine(craftName, kits) {
    /* Programmatic clicks for the picker: it folds once a craft + valid kits
       are chosen, so real clicks would miss hidden chips. The queue buttons
       themselves live outside the picker and get real clicks. */
    await page.evaluate(() => { document.querySelector("#btn-pack-change").click(); });
    await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.click("#btn-queue-add");
    await sleep(250);
  }
  async function queueLines() {
    return page.$$eval("#pack-queue .queue-line", els => els.map(e => ({
      text: e.textContent.replace(/\s+/g, " ").trim(),
      dup: e.classList.contains("dup"),
      hasComplete: !!e.querySelector(".queue-complete")
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

  /* ---- 1. Print all: 3 crafts, one job, queue order, per-line Complete ---- */
  await addLine("The Cakery", 36);
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
  const qAfterPrint = await queueLines();
  eq(qAfterPrint.every(l => l.hasComplete), true, "Print all: every line now offers its own Complete");
  /* Complete each line in order */
  for (let i = 0; i < 3; i++) {
    await page.click("#pack-queue .queue-line .queue-complete");
    await sleep(300);
    await sheetPrimary();
    await sleep(400);
  }
  eq(remoteData.history.length, 3, "Print all + Complete each: 3 History entries");
  eq(remoteData.history.map(h => h.title), [
    "Packed The Cakery — 36 kits (CAK-36)",
    "Packed Tambourines — 12 kits (TAM-12)",
    "Packed Hafrashat Challah — 18 kits (HCB-18)"
  ], "Print all: entries carry the right SKUs");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 64, "deduction: CAK-36 took 36 Heart Jewelry Boxes (100 -> 64)");
  eq(remoteData.inventory["scissors"].qty, 82, "deduction: shared Scissors across the queue (CAK 12 + TAM 6 = 18, 100 -> 82)");
  eq((await queueLines()).length, 0, "queue: completed lines leave the queue");
  /* Undo one entry from History */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Undo this entry?", "undo uses the confirm sheet");
  await sheetPrimary();
  await sleep(400);
  eq(remoteData.history.length, 2, "undo removes one entry");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 100, "undo restores the deducted stock");
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);

  /* ---- 2. Hand pack all walks the checklists in order ---- */
  await addLine("Blooming Mirrors", 6);
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
  eq(remoteData.history.length, 5, "Hand pack all: 3 more entries (2 kept + 3 new)");

  /* ---- 3. Combined shortage across the queue is caught before starting ---- */
  remoteData.inventory["scissors"].qty = 5;
  remoteSha = "sha-q-short";
  await reloadApp();
  await addLine("The Cakery", 36);
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
  /* Clear the queue before the duplicate section (lines persist on-device) */
  await page.evaluate(() => { document.querySelectorAll("#pack-queue .queue-remove").forEach(b => b.click()); });
  await sleep(300);
  eq((await queueLines()).length, 0, "queue: lines can be removed before starting");

  /* ---- 4. Duplicates: silent while adding, pop-up at Print all ---- */
  resetRemote();
  remoteSha = "sha-q-dup";
  await reloadApp();
  await addLine("The Cakery", 12);
  await addLine("The Cakery", 18);
  eq(await sheetVisible(), false, "duplicates: no warning while adding the second Cakery line");
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(await sheetVisible(), true, "duplicates: Print all shows the pop-up");
  const dupText = await page.$eval("#sheet-backdrop", e => e.textContent);
  eq(dupText.includes("Multiple of the same craft detected") && dupText.includes("x2") && dupText.includes("12 kits + 18 kits"), true, "duplicates: pop-up names the craft, count and kit amounts");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "YES", "duplicates: YES is the primary button");
  eq(await page.$eval("#sheet-cancel", e => e.textContent), "NO", "duplicates: NO is the cancel button");
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
  for (let i = 0; i < 2; i++) {
    await page.click("#pack-queue .queue-line .queue-complete");
    await sleep(300);
    await sheetPrimary();
    await sleep(400);
  }
  eq(remoteData.history.map(h => h.title).slice(-2), [
    "Packed The Cakery — 12 kits (CAK-12)",
    "Packed The Cakery — 18 kits (CAK-18)"
  ], "duplicates: YES gives two separate entries and SKUs");

  console.log(fail ? "QUEUE TESTS FAILED (" + fail + ")" : "all queue tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
