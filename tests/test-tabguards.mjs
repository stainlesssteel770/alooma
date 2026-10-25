/* Tab-guard tests (brief item 2): leaving a tab never silently eats work.
   Packing<->Bulk clears unfinished input (no prompt) except a printed /
   started queue, which prompts Leave / Discard. Inventory / History with
   unsaved work prompts Discard / Stay. beforeunload guards reload/close
   with unsaved Inventory/History work or a started queue.
   Run: node tests/test-tabguards.mjs */
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
const PORT = 8910;
let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 100, threshold: null }; });
remoteData.history = [];
if (remoteData.settings && remoteData.settings.features) { remoteData.settings.features.boxes = false; remoteData.settings.features.bins = false; }
let remoteSha = "sha-g1";
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
        remoteSha = "sha-g" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);

  async function tab(name) { await page.click(`[data-tab="${name}"]`); await sleep(300); }
  async function activeTab() { return page.$eval("#tabs button.active", e => e.getAttribute("data-tab")); }
  async function sheetVisible() { return page.$eval("#sheet-backdrop", e => !e.hidden); }
  async function sheetPrimary() { await page.click("#sheet-primary"); await sleep(300); }
  async function sheetCancel() { await page.click("#sheet-cancel"); await sleep(300); }
  async function packSelect(craftName, kits) {
    await page.evaluate(() => { document.querySelector("#btn-pack-change").click(); });
    await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
  }
  async function queueAdd(craftName, kits) {
    await packSelect(craftName, kits);
    await page.click("#btn-queue-add");
    await sleep(250);
  }
  async function queueLines() { return page.$$eval("#pack-queue .queue-line", els => els.length); }
  async function beforeunloadPrevented() {
    return page.evaluate(() => {
      const ev = new Event("beforeunload", { cancelable: true });
      const notCancelled = window.dispatchEvent(ev);
      return !notCancelled;
    });
  }

  /* ---- 1. Single selection clears on Packing -> Bulk, no prompt ---- */
  await packSelect("The Cakery", 18);
  eq(await page.$eval("#pack-sku", e => e.textContent), "CAK-18", "setup: CAK-18 selected");
  await tab("bulk");
  eq(await sheetVisible(), false, "pack->bulk single selection: no prompt");
  eq(await activeTab(), "bulk", "pack->bulk single selection: switched");
  await tab("pack");
  eq(await page.$eval("#pack-kits", e => e.value), "", "pack->bulk: kits cleared on return");
  eq(await page.$eval("#pack-sku", e => e.textContent), "—", "pack->bulk: craft cleared on return");

  /* ---- 2. Un-started queue clears on Packing -> Bulk, no prompt ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  eq(await queueLines(), 2, "setup: 2 queue lines");
  await tab("bulk");
  eq(await sheetVisible(), false, "pack->bulk un-started queue: no prompt");
  await tab("pack");
  eq(await queueLines(), 0, "pack->bulk: un-started queue cleared");

  /* ---- 3. Printed queue prompts; Discard clears and proceeds ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-print");
  await sleep(300);
  await tab("bulk");
  eq(await sheetVisible(), true, "printed queue: leaving Packing prompts");
  eq(await page.$eval("#sheet-summary", e => e.textContent), "You have 2 crafts printed but not completed.", "printed queue: prompt names the count");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "Leave them in the queue", "printed queue: Leave is primary");
  eq(await page.$eval("#sheet-cancel", e => e.textContent), "Discard", "printed queue: Discard is cancel");
  await sheetCancel(); /* Discard */
  eq(await activeTab(), "bulk", "printed queue Discard: proceeds to Bulk");
  await tab("pack");
  eq(await queueLines(), 0, "printed queue Discard: queue cleared");

  /* ---- 4. Printed queue prompts; Leave keeps and proceeds ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-print");
  await sleep(300);
  await tab("bulk");
  eq(await sheetVisible(), true, "printed queue Leave: prompt shown again");
  await sheetPrimary(); /* Leave them in the queue */
  eq(await activeTab(), "bulk", "printed queue Leave: proceeds to Bulk");
  await tab("pack");
  eq(await queueLines(), 2, "printed queue Leave: queue intact on return");
  eq(await page.$$eval("#pack-queue .queue-line .queue-complete", els => els.length), 2, "printed queue Leave: lines still printed");
  /* Clean up: discard the printed queue so later sections start fresh */
  await tab("bulk");
  await sheetCancel();
  await tab("pack");
  eq(await queueLines(), 0, "cleanup: printed queue discarded");

  /* ---- 5. Bulk -> Packing clears bulk input, no prompt ---- */
  await tab("bulk");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="bulk"][data-kits="12"]').click(); });
  await sleep(150);
  await page.click("#btn-bulk-add");
  await sleep(250);
  eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 1, "setup: 1 bulk line");
  await tab("pack");
  eq(await sheetVisible(), false, "bulk->pack: no prompt");
  await tab("bulk");
  eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 0, "bulk->pack: bulk lines cleared");
  eq(await page.$eval("#bulk-kits", e => e.value), "", "bulk->pack: bulk kits cleared");

  /* ---- 6. Inventory panel input dirty: Stay keeps, Discard clears ---- */
  await tab("inventory");
  await page.click(".inv-item .inv-main");
  await sleep(300);
  await page.type(".inv-panel-input", "5");
  await tab("history");
  eq(await sheetVisible(), true, "inventory panel dirty: leaving prompts");
  eq(await page.$eval("#sheet-title", e => e.textContent), "Unsaved changes", "inventory panel dirty: prompt title");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "Stay", "inventory panel dirty: Stay is primary");
  await sheetPrimary(); /* Stay */
  eq(await activeTab(), "inventory", "inventory panel Stay: still on Inventory");
  eq(await page.$eval(".inv-panel-input", e => e.value), "5", "inventory panel Stay: typed value kept");
  await tab("history");
  await sheetCancel(); /* Discard */
  eq(await activeTab(), "history", "inventory panel Discard: proceeds to History");
  await tab("inventory");
  eq(await page.$$eval(".inv-panel-input", els => els.length), 0, "inventory panel Discard: panel closed");

  /* ---- 7. Count entry dirty: Discard clears the numbers ---- */
  await page.click("#btn-enter-counts");
  await sleep(300);
  await page.type("#count-entry-list input[data-item]", "3");
  await tab("history");
  eq(await sheetVisible(), true, "count entry dirty: leaving prompts");
  await sheetCancel(); /* Discard */
  eq(await activeTab(), "history", "count entry Discard: proceeds");
  await tab("inventory");
  eq(await page.$$eval("#count-entry-list input[data-item]", els => els.every(e => e.value === "")), true, "count entry Discard: numbers cleared");

  /* ---- 8. Delivery entry dirty: Stay keeps the numbers ---- */
  await page.click("#btn-delivery");
  await sleep(300);
  await page.type("#delivery-entry-list input[data-item]", "4");
  await tab("history");
  eq(await sheetVisible(), true, "delivery entry dirty: leaving prompts");
  await sheetPrimary(); /* Stay */
  eq(await activeTab(), "inventory", "delivery entry Stay: still on Inventory");
  eq(await page.$eval("#delivery-entry-list input[data-item]", e => e.value), "4", "delivery entry Stay: number kept");
  await tab("history");
  await sheetCancel(); /* Discard */
  eq(await activeTab(), "history", "delivery entry Discard: proceeds");

  /* ---- 9. History edit dirty: Stay restores the edit sheet; Discard drops it ---- */
  await tab("inventory");
  await page.click(".inv-item .inv-main");
  await sleep(300);
  await page.type(".inv-panel-input", "5");
  await page.click(".inv-panel-go");
  await sleep(400);
  eq(remoteData.history.length, 1, "setup: received entry created");
  await tab("history");
  await page.evaluate(() => document.querySelector(".history-entry .btn-edit").click());
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Edit entry", "history edit: sheet opened");
  eq(await page.$eval("#sheet-input", e => e.value), "5", "history edit: input shows the saved amount");
  await page.evaluate(() => { document.querySelector("#sheet-input").value = "9"; });
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click()); /* backdrop blocks real taps; evaluate bypasses it */
  await sleep(300);
  eq(await sheetVisible(), true, "history edit dirty: leaving prompts");
  eq(await page.$eval("#sheet-title", e => e.textContent), "Unsaved changes", "history edit dirty: guard prompt shown");
  await sheetPrimary(); /* Stay: the edit sheet must come back intact */
  eq(await page.$eval("#sheet-title", e => e.textContent), "Edit entry", "history edit Stay: edit sheet restored");
  eq(await page.$eval("#sheet-input", e => e.value), "9", "history edit Stay: changed value restored");
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);
  await sheetCancel(); /* Discard the edit */
  eq(await activeTab(), "pack", "history edit Discard: proceeds to Pack");
  eq(remoteData.history[0].amount, 5, "history edit Discard: entry unchanged");

  /* ---- 10. beforeunload: dirty blocks, clean passes, started queue blocks ---- */
  await tab("inventory");
  await page.click(".inv-item .inv-main");
  await sleep(300);
  await page.type(".inv-panel-input", "5");
  eq(await beforeunloadPrevented(), true, "beforeunload: dirty inventory input blocks close/reload");
  await tab("history");
  await sheetCancel(); /* Discard */
  eq(await beforeunloadPrevented(), false, "beforeunload: clean state passes");
  await tab("pack");
  await queueAdd("The Cakery", 36);
  eq(await beforeunloadPrevented(), false, "beforeunload: un-started queue does not block (it persists)");
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(await beforeunloadPrevented(), true, "beforeunload: printed queue blocks close/reload");

  console.log(fail ? "TABGUARD TESTS FAILED (" + fail + ")" : "all tabguard tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
