/* Byline tests (brief item 3, Batch B: names live in Settings).
   - Packed by / Counted by set in Settings, saved per device on change.
   - No name fields on Packing or the count form anymore.
   - Complete/save never blocked by an empty name; blank lines stay blank.
   - Last name remembered per device (localStorage) across reloads.
   - Stored on the History entry and shown as "— by <name>".
   - Filled before printing, the name replaces the blank on the sheet.
   - Old entries without a name render fine, with no "by" text.
   Run: node tests/test-byline.mjs */
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
const PORT = 8911;
let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 100, threshold: null }; });
/* One old entry, written before bylines existed: no packedBy/countedBy. */
remoteData.history = [{
  id: "hold1", ts: "2026-10-20T10:00:00.000Z", type: "packed",
  title: "Packed The Cakery — 12 kits (CAK-12)",
  effects: [{ item: "scissors", delta: -6 }], undone: false,
  craftId: "cak", kits: 12
}];
if (remoteData.settings && remoteData.settings.features) { remoteData.settings.features.boxes = false; remoteData.settings.features.bins = false; }
let remoteSha = "sha-y1";
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
        remoteSha = "sha-y" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  await page.evaluate(() => { window.print = () => {}; });

  /* A3: prompt-aware — Discard whenever a switch prompts (the dirty state
     here is always already saved or intentionally abandoned). */
  async function tab(name) {
    await page.click(`[data-tab="${name}"]`);
    await sleep(300);
    const prompt = await page.$eval("#sheet-backdrop", e => !e.hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes").catch(() => false);
    if (prompt) { await page.click("#sheet-cancel"); await sleep(300); }
  }
  async function packSelect(craftName, kits) {
    await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
  }
  async function queueFirst(craftName, kits) {
    await packSelect(craftName, kits);
    await page.click("#btn-pack-queue");
    await sleep(250);
  }
  async function queueAdd(craftName, kits) {
    await packSelect(craftName, kits);
    await page.click("#btn-queue-add");
    await sleep(250);
  }
  /* Names save on change (blur) — set the value and fire change. */
  async function setName(id, name) {
    await page.evaluate((sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, id, name);
    await sleep(150);
  }
  async function printAreaText() { return page.$eval("#print-area", e => e.textContent); }

  /* ---- 0. Old entry without a name renders fine, no "by" text ---- */
  await tab("history");
  eq(await page.$$eval(".history-entry", els => els.length), 1, "old entry: one history row");
  eq((await page.$eval(".history-entry", e => e.textContent)).includes("by "), false, "old entry: no byline shown");

  /* ---- 0b. No name fields on Packing or the count form anymore ---- */
  await tab("pack");
  eq(await page.$$eval("#pack-by", els => els.length), 0, "5e: no Packed by field on Packing");
  await tab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(300);
  eq(await page.$$eval("#count-by", els => els.length), 0, "5e: no Counted by field on the count form");
  await page.click("#btn-cancel-counts");
  await sleep(200);

  /* ---- 1. Single print with a name fills the Packed by line ---- */
  await tab("settings");
  await setName("#set-packed-by", "Sara");
  eq(await page.evaluate(() => localStorage.getItem("alooma.packedby.v1")), "Sara", "settings: Packed by saved per device on change");
  await tab("pack");
  await packSelect("The Cakery", 18);
  await page.click("#btn-pack-print");
  await sleep(300);
  eq((await printAreaText()).includes("Packed by: Sara"), true, "single print: name on the Packed by line");
  eq((await printAreaText()).includes("Packed by: ____________________"), false, "single print: blank line replaced, not kept");
  eq(remoteData.history[0].packedBy, "Sara", "single print: packedBy stored on the entry (A4: print completes)");

  /* ---- 2. Single print with an empty name keeps the blank ---- */
  await tab("settings");
  await setName("#set-packed-by", "");
  await tab("pack");
  await packSelect("The Cakery", 18);
  await page.click("#btn-pack-print");
  await sleep(300);
  eq((await printAreaText()).includes("Packed by: ____________________"), true, "single print empty: blank line kept");
  eq(remoteData.history[0].packedBy, undefined, "single print empty: no packedBy stored");

  /* ---- 3. The name is remembered per device across reloads ---- */
  await tab("settings");
  await setName("#set-packed-by", "Sara");
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  await tab("settings");
  eq(await page.$eval("#set-packed-by", e => e.value), "Sara", "reload: Packed by remembered from this device");

  /* ---- 4. Queue Print all carries the name onto every sheet ---- */
  await tab("pack");
  await queueFirst("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-print");
  await sleep(300);
  eq(((await printAreaText()).match(/Packed by: Sara/g) || []).length, 2, "print all: name on both sheets");
  eq(remoteData.history[0].packedBy, "Sara", "print all: newest entry carries packedBy");
  eq(remoteData.history[1].packedBy, "Sara", "print all: second entry carries packedBy");
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 0, "print all: queue cleared");

  /* ---- 5. Count with a name: entries + count sheet carry it ---- */
  await tab("settings");
  eq(await page.$eval("#set-counted-by", e => e.value), "", "count name: Counted by starts empty (nothing remembered yet)");
  await setName("#set-counted-by", "Dina");
  await tab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(300);
  await page.type("#count-entry-list input[data-item]", "90");
  await page.click("#btn-apply-counts");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  eq(remoteData.history[0].type, "count-fix", "count apply: newest entry is a count fix");
  eq(remoteData.history[0].countedBy, "Dina", "count apply: countedBy stored on the entry");
  await tab("history");
  eq((await page.$eval(".history-entry", e => e.textContent)).includes("by Dina"), true, "history: count row shows by Dina");
  await tab("inventory");
  await page.evaluate(() => document.querySelector("#btn-print-count").click());
  await sleep(200);
  eq((await printAreaText()).includes("Counted by: Dina"), true, "count print: name on the Counted by line");

  /* ---- 6. Complete with an empty name is never blocked and stores nothing ---- */
  await tab("settings");
  await setName("#set-packed-by", "");
  await tab("pack");
  await packSelect("Tambourines", 12);
  await page.click("#btn-pack-hand");
  await sleep(200);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* "Mark all" confirm */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  eq(remoteData.history[0].packedBy, undefined, "complete empty: no packedBy stored");
  await tab("history");
  eq((await page.$eval(".history-entry", e => e.textContent)).includes("by "), false, "complete empty: newest row shows no byline");

  console.log(fail ? "BYLINE TESTS FAILED (" + fail + ")" : "all byline tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
