/* Clear-all tests: a small "Clear all" button on Packing (queue) and Bulk,
   shown only when the list has 2+ items, kept away from Print all /
   Record all, always confirming first ("Clear all N crafts?", Clear in
   red, Cancel filled). A printed or started queue says so in the confirm.
   Run: node tests/test-clearall.mjs */
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
const PORT = 8912;
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
let remoteSha = "sha-c1";
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
        remoteSha = "sha-c" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  await page.evaluate(() => { window.print = () => {}; });

  async function tab(name) { await page.click(`[data-tab="${name}"]`); await sleep(300); }
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
  async function bulkAdd(craftName, kits) {
    await page.evaluate(name => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="bulk"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.click("#btn-bulk-add");
    await sleep(250);
  }
  async function queueLines() { return page.$$eval("#pack-queue .queue-line", els => els.length); }
  async function bulkLines() { return page.$$eval("#bulk-lines .hand-line", els => els.length); }
  async function queueClearHidden() { return page.$eval("#btn-queue-clear", e => e.hidden); }
  async function bulkClearHidden() { return page.$eval("#btn-bulk-clear", e => e.hidden); }

  /* ---- 1. Queue Clear all appears only at 2+ lines ---- */
  eq(await queueClearHidden(), true, "queue clear: hidden with an empty queue");
  await queueAdd("The Cakery", 36);
  eq(await queueClearHidden(), true, "queue clear: hidden with 1 line");
  await queueAdd("Tambourines", 12);
  eq(await queueClearHidden(), false, "queue clear: shown with 2 lines");

  /* ---- 2. Cancel keeps the queue; Clear empties it (and storage) ---- */
  await page.click("#btn-queue-clear");
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Clear all 2 crafts?", "queue clear: confirm names the count");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "Clear", "queue clear: primary is Clear");
  eq(await page.$eval("#sheet-primary", e => e.classList.contains("danger")), true, "queue clear: Clear is red (danger)");
  eq(await page.$eval("#sheet-cancel", e => e.textContent + "|" + e.classList.contains("btn-primary")), "Cancel|true", "queue clear: Cancel is the filled default");
  await page.click("#sheet-cancel");
  await sleep(200);
  eq(await queueLines(), 2, "queue clear Cancel: queue intact");
  await page.click("#btn-queue-clear");
  await sleep(300);
  await page.click("#sheet-primary");
  await sleep(300);
  eq(await queueLines(), 0, "queue clear Clear: queue empty");
  eq(await page.evaluate(() => localStorage.getItem("alooma.packqueue.v1")), "[]", "queue clear Clear: persisted queue empty");
  eq(await queueClearHidden(), true, "queue clear Clear: button hides again");

  /* ---- 3. A printed queue says so in the confirm ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-print");
  await sleep(300);
  await page.click("#btn-queue-clear");
  await sleep(300);
  eq((await page.$eval("#sheet-summary", e => e.textContent)).includes("printed"), true, "queue clear printed: confirm says lines were printed");
  await page.click("#sheet-primary");
  await sleep(300);
  eq(await queueLines(), 0, "queue clear printed: Clear empties a printed queue");

  /* ---- 4. A started hand-pack walk says so, and clearing ends the walk ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await page.click("#btn-queue-hand");
  await sleep(300);
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "Craft 1 of 2", "walk setup: Craft 1 of 2");
  await page.click("#btn-queue-clear");
  await sleep(300);
  eq((await page.$eval("#sheet-summary", e => e.textContent)).includes("hand-packing"), true, "queue clear walk: confirm says a walk is in progress");
  await page.click("#sheet-primary");
  await sleep(300);
  eq(await queueLines(), 0, "queue clear walk: queue empty");
  eq(await page.$eval("#pack-queue-progress", e => e.textContent), "", "queue clear walk: walk ended");

  /* ---- 5. Bulk Clear all: visibility, Cancel keeps, Clear empties ---- */
  await tab("bulk");
  eq(await bulkClearHidden(), true, "bulk clear: hidden with an empty list");
  await bulkAdd("The Cakery", 12);
  eq(await bulkClearHidden(), true, "bulk clear: hidden with 1 line");
  await bulkAdd("Tambourines", 18);
  eq(await bulkClearHidden(), false, "bulk clear: shown with 2 lines");
  await page.click("#btn-bulk-clear");
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Clear all 2 crafts?", "bulk clear: confirm names the count");
  await page.click("#sheet-cancel");
  await sleep(200);
  eq(await bulkLines(), 2, "bulk clear Cancel: list intact");
  await page.click("#btn-bulk-clear");
  await sleep(300);
  await page.click("#sheet-primary");
  await sleep(300);
  eq(await bulkLines(), 0, "bulk clear Clear: list empty");
  eq(await bulkClearHidden(), true, "bulk clear Clear: button hides again");

  console.log(fail ? "CLEARALL TESTS FAILED (" + fail + ")" : "all clearall tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
