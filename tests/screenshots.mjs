/* Screenshots of the changed screens at 390px, for batch reports.
   Runs against a LOCAL copy with seeded sample data and a mocked GitHub
   API — never the live data. Output: ./screenshots/*.jpg
   Run: node tests/screenshots.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
/* Portable browser loading: full `puppeteer` if installed (CI installs it);
   otherwise the sandbox's puppeteer-core + chrome-headless-shell. */
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "screenshots");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8913;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const b64d = s => Buffer.from(s, "base64").toString("utf8");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
for (const k of Object.keys(remoteData.inventory)) remoteData.inventory[k].qty = 240;
remoteData.inventory["scissors"].qty = 1218;
remoteData.inventory["tree-mirror"] = { qty: 36, threshold: 40 };
remoteData.inventory["heart-jewelry-box"] = { qty: 54, threshold: 24 };
remoteData.inventory["heat-gun"] = { qty: 4, threshold: 2 };
remoteData.inventory["mi-name-label"] = { qty: 0, threshold: 12 };
/* v2 batch A shots: parchment at 0 makes CAK-18 short by exactly one item;
   a past scissors delivery of 50 makes a 480 delivery flag as 10x usual */
remoteData.inventory["parchment-circle"] = { qty: 0, threshold: null };
remoteData.history = [{ id: "hseed", ts: "2026-10-22T14:00:00.000Z", type: "received", title: "Received 50 × Scissors", effects: [{ item: "scissors", delta: 50 }], item: "scissors", amount: 50, undone: false }];
let remoteSha = "sha-1", putCount = 0;

import http from "http";
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
const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
if (EXE) launchOpts.executablePath = EXE;
const browser = await puppeteer.launch(launchOpts);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  page.on("dialog", async d => { await d.accept(); });
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.startsWith("https://api.github.com/user")) return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "editor" }) });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "GET") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remoteData)) }) });
      if (req.method() === "PUT") { putCount++; const body = JSON.parse(req.postData()); remoteData = JSON.parse(b64d(body.content)); remoteSha = "sha-" + putCount; return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) }); }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  const shot = async name => { await page.screenshot({ path: path.join(OUT, name), type: "jpeg", quality: 74 }); console.log("shot", name); };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await page.type("#gh-token", "fake-token-for-screenshots");
  await page.click("#btn-connect");
  await sleep(700);

  /* Packing, fresh: nothing pre-selected (A1), button says why (A4) */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("pack-fresh.jpg");

  /* Packing with Cakery + 18 chosen: blue selected card (A2), named button (A3) */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("pack-selected.jpg");

  /* Confirm sheet: Hand pack path; v2 A5 check-all asks first, then Complete.
     v2 A2: this order is short (parchment at 0) so the sheet shows the red block */
  await page.click("#btn-mode-hand");
  await sleep(200);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* Mark all */
  await sleep(200);
  await page.evaluate(() => document.querySelector("#pack-checklist").scrollIntoView());
  await sleep(200);
  await shot("handpack.jpg");
  await page.click("#btn-complete-pack");
  await sleep(400);
  await shot("pack-confirm-sheet.jpg");
  await page.click("#sheet-primary");
  await sleep(800);

  /* History with the pack entry + Undo toast */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  await shot("history.jpg");

  /* Bulk import tab: queue the same CAK-18 as a hand-packed order */
  await page.evaluate(() => document.querySelector('[data-tab="bulk"]').click());
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="18"]');
  await sleep(200);
  await page.evaluate(() => document.querySelector("#btn-bulk-add").click());
  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot("bulk.jpg");

  /* Inventory with an item panel open */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(300);
  await page.evaluate(() => { document.querySelector('.inv-item[data-item="heart-jewelry-box"] .inv-main').click(); });
  await sleep(300);
  await page.evaluate(() => { document.querySelector('.inv-item[data-item="heart-jewelry-box"]').scrollIntoView({ block: "center" }); });
  await sleep(200);
  await shot("inventory.jpg");

  /* Receive-delivery form (B4) */
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click("#btn-delivery");
  await sleep(300);
  await shot("delivery.jpg");
  /* v2 A3: the delivery confirm sheet, with the 10x-usual flag on scissors */
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "480"; });
  await page.click("#btn-apply-delivery");
  await sleep(400);
  await shot("delivery-sheet.jpg");
  await page.click("#sheet-cancel");
  await sleep(200);
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(500);
  await shot("settings.jpg");

  /* Offline state (A6): second page, data requests blocked */
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page2.setRequestInterception(true);
  page2.on("request", req => {
    const url = req.url();
    if (url.includes("api.github.com") || url.includes("data.json")) return req.abort();
    req.continue();
  });
  await page2.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(600);
  await page2.screenshot({ path: path.join(OUT, "offline.jpg"), type: "jpeg", quality: 74 });
  console.log("shot offline.jpg");
  console.log("screenshots done; mock PUTs:", putCount);
} finally {
  await browser.close();
  server.close();
}
