/* A4 print-done tests: Print (single) and Print all complete the order(s)
   immediately — inventory deducts and History logs at print time, with no
   "Complete from sheet" step and no printed-but-not-completed state.
   - Single print (covered): one entry, stock deducted once, pick cleared.
   - Single print (short): "Print anyway" sheet; Go back prints nothing.
   - Print all: all lines completed at once, queue cleared, single view.
   - One toast UNDO after a print removes the entry/entries entirely
     (spliced out of History) and restores the stock — unlike the History
     tab's Undo, which marks the entry undone and keeps it.
   - Hand pack still completes at the end, as before.
   Run: node tests/test-printdone.mjs */
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8917;
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

  async function pickPack(craft, kits) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), craft);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(200);
  }
  async function queueFirst(craft, kits) {
    await pickPack(craft, kits);
    await page.click("#btn-pack-queue");
    await sleep(250);
  }
  async function queueAdd(craft, kits) {
    await pickPack(craft, kits);
    await page.click("#btn-queue-add");
    await sleep(250);
  }
  async function toastUndo() {
    await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
    await sleep(600);
  }
  async function sheetOpen() { return page.$eval("#sheet-backdrop", e => !e.hidden); }
  async function sheetPrimary() { await page.click("#sheet-primary"); await sleep(300); }
  async function sheetCancel() { await page.click("#sheet-cancel"); await sleep(300); }
  async function reloadApp() {
    await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
    await sleep(700);
    await page.evaluate(() => { window.print = () => {}; });
  }

  /* ---- 1. Single Print (covered) completes immediately ---- */
  await pickPack("Hafrashat Challah", 6);
  await page.click("#btn-pack-print");
  await sleep(400);
  eq(await page.$eval("#print-area", e => e.textContent.includes("Hafrashat Challah")), true, "single print: sheet printed");
  eq(remote.history.length, 1, "single print: one History entry at print time");
  eq(remote.history[0].title, "Packed Hafrashat Challah — 6 kits (HCB-6)", "single print: entry title");
  eq(remote.inventory["heat-gun"].qty, 99, "single print: stock deducted once");
  eq(await page.$eval("#pack-kits", e => e.value), "", "single print: pick cleared");
  eq(await page.$eval("#pack-single-actions", e => e.hidden), true, "single print: single actions hidden with no pick");
  await toastUndo();
  eq(remote.history.length, 0, "print UNDO: entry spliced out of History entirely");
  eq(remote.inventory["heat-gun"].qty, 100, "print UNDO: stock restored");

  /* ---- 2. Single Print (short): Go back prints nothing; Print anyway completes ---- */
  remote.inventory["heat-gun"].qty = 0;
  await reloadApp();
  await pickPack("Hafrashat Challah", 6);
  await page.click("#btn-pack-print");
  await sleep(300);
  eq(await sheetOpen(), true, "short print: shortage sheet opens");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "Print anyway", "short print: primary is Print anyway");
  await sheetCancel();
  eq(remote.history.length, 0, "short print Go back: nothing recorded");
  eq(remote.inventory["heat-gun"].qty, 0, "short print Go back: nothing deducted");
  await page.click("#btn-pack-print");
  await sleep(300);
  await sheetPrimary(); /* Print anyway */
  await sleep(400);
  eq(remote.history.length, 1, "Print anyway: entry recorded");
  eq(remote.inventory["heat-gun"].qty, -1, "Print anyway: stock deducted even when short");
  await toastUndo();
  eq(remote.history.length, 0, "Print anyway UNDO: entry spliced out");
  eq(remote.inventory["heat-gun"].qty, 0, "Print anyway UNDO: stock restored to 0");
  remote.inventory["heat-gun"].qty = 100;
  await reloadApp();

  /* ---- 3. Print all completes every line at once, one UNDO removes all ---- */
  await queueFirst("Blooming Mirrors", 6);
  await queueAdd("Tambourines", 12);
  await queueAdd("Hafrashat Challah", 18);
  await page.click("#btn-queue-print");
  await sleep(400);
  eq((await page.$$eval("#print-area .print-page", els => els.length)), 3, "print all: three sheets");
  eq(remote.history.length, 3, "print all: three entries at print time");
  eq(JSON.stringify(remote.history.map(h => h.title)), JSON.stringify([
    "Packed Hafrashat Challah — 18 kits (HCB-18)",
    "Packed Tambourines — 12 kits (TAM-12)",
    "Packed Blooming Mirrors — 6 kits (BM-6)"
  ]), "print all: entries newest first");
  eq(remote.inventory["heat-gun"].qty, 99, "print all: HCB-18 deducted once");
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 0, "print all: queue cleared");
  eq(await page.$eval("#pack-queue-actions", e => e.hidden), true, "print all: back to single view (queue actions hidden)");
  await toastUndo();
  eq(remote.history.length, 0, "print all UNDO: all three entries spliced out");
  eq(remote.inventory["heat-gun"].qty, 100, "print all UNDO: stock restored");

  /* ---- 4. Print all still runs the shortage guard first ---- */
  remote.inventory["scissors"].qty = 5;
  await reloadApp();
  await queueFirst("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(await sheetOpen(), true, "print all shortage: guard sheet opens");
  eq((await page.$eval("#sheet-extra", e => e.textContent)).includes("Scissors"), true, "print all shortage: Scissors named");
  await sheetPrimary(); /* Start anyway */
  await sleep(400);
  eq(remote.history.length, 2, "print all Start anyway: both entries recorded");
  eq(remote.inventory["scissors"].qty, 5 - 12 - 6, "print all Start anyway: stock deducted once per line");
  await toastUndo();
  eq(remote.history.length, 0, "print all shortage UNDO: entries spliced out");
  remote.inventory["scissors"].qty = 100;
  await reloadApp();

  /* ---- 5. Hand pack still completes at the end, not at any print ---- */
  await pickPack("Hafrashat Challah", 6);
  await page.click("#btn-pack-hand");
  await sleep(200);
  eq(remote.history.length, 0, "hand pack: nothing recorded before Complete");
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* Mark all */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary"); /* Subtract from inventory */
  await sleep(600);
  eq(remote.history.length, 1, "hand pack: one entry after Complete");
  eq(remote.inventory["heat-gun"].qty, 99, "hand pack: stock deducted at Complete");
  eq(await page.$eval("#pack-sku", e => e.textContent), "HCB-6", "hand pack: pick stays after Complete (unchanged behavior)");

  /* ---- 6. History-tab Undo still MARKS undone (does not splice) ---- */
  await page.click('[data-tab="history"]');
  await sleep(300);
  /* The hand-pack left its pick behind, so leaving Pack prompted — Discard
     it; the pick is done with and History must be clean for the undo. */
  eq(await sheetOpen(), true, "hand-pack pick prompts on the way to History");
  await sheetCancel();
  await sleep(300);
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(300);
  await sheetPrimary(); /* Undo this entry? */
  await sleep(600);
  eq(remote.history.length, 1, "history undo: entry kept (marked undone, not spliced)");
  eq(remote.history[0].undone, true, "history undo: entry marked undone");
  eq(remote.inventory["heat-gun"].qty, 100, "history undo: stock restored");
  eq(await page.$$eval(".history-entry .btn-reprint", els => els.length), 0, "no Reprint yet (Batch C scope, A5)");

  console.log(failures ? "PRINTDONE TESTS FAILED (" + failures + ")" : "all printdone tests passed (" + passes + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
