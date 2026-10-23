/* Offline queue test (v3 E4): edits made with no signal are stored as
   ACTIONS on the device and, on reconnect, re-applied on top of the
   latest repo data — both sides kept in stock and History. An exact
   count whose item also changed remotely is the only thing that stops
   and asks. Also: the service worker + snapshot let the app open fully
   offline. Run: node tests/test-offline-queue.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8913;

let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 50; i++) { if (await fn()) return; await sleep(150); }
  fail++; console.log("FAIL timeout waiting: " + label);
}

let online = true, shaN = 1, putCount = 0;
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k].qty = 0; remote.inventory[k].threshold = null; });
remote.inventory["scissors"].qty = 200;
let remoteSha = "sha-1";
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const b64d = s => Buffer.from(s, "base64").toString("utf8");

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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && !online) return req.abort();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() || "{}");
        if (body.sha !== remoteSha) return req.respond({ status: 409, headers: CORS, contentType: "application/json", body: JSON.stringify({ message: "conflict" }) });
        const data = JSON.parse(b64d(body.content));
        Object.keys(remote).forEach(k => delete remote[k]);
        Object.assign(remote, data);
        remoteSha = "sha-" + (++shaN);
        putCount++;
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(700);
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "Editor", "E4: editor connected from localStorage");

  /* ---- Go offline: hand-pack BM-6 and receive 50 tambourines ---- */
  online = false;
  await page.evaluate(() => document.querySelector('[data-tab="bulk"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("Blooming")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="6"]');
  await sleep(150);
  await page.click("#btn-bulk-add");
  await sleep(200);
  await page.click("#btn-bulk-record");
  await sleep(300);
  await page.click("#sheet-primary");
  await sleep(600);
  const queue1 = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.queue.v1") || "[]"));
  eq(queue1.length, 1, "E4: offline hand-pack queued as one action");
  eq(putCount, 0, "E4: nothing reached the repo while offline");
  eq(await page.$eval("#save-status", e => e.textContent.includes("Offline") && e.textContent.includes("1 change waiting")), true, "E4: header counts the waiting change");

  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(200);
  await page.evaluate(() => { if (document.querySelector("#delivery-entry").hidden) document.querySelector("#btn-delivery").click(); });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="tambourines"]').value = "50"; });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(600);
  const queue2 = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.queue.v1") || "[]"));
  eq(queue2.length, 2, "E4: offline delivery queued as a second action");
  eq(await page.$eval("#save-status", e => e.textContent.includes("2 changes waiting")), true, "E4: header counts both waiting changes");

  /* ---- Meanwhile, someone else delivers 100 tambourines online ---- */
  remote.inventory["tambourines"].qty += 100;
  remote.history.unshift({ id: "their-1", ts: new Date().toISOString(), type: "received", title: "Received 100 × Tambourines", effects: [{ item: "tambourines", delta: 100 }], item: "tambourines", amount: 100, undone: false });
  remoteSha = "sha-theirs";

  /* ---- Back online: both sides must land ---- */
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => remote.inventory["tambourines"].qty === 150, "merged tambourines reach 150");
  eq(remote.inventory["tambourines"].qty, 150, "E4: my +50 and their +100 are BOTH in stock");
  eq(remote.inventory["tree-mirror"].qty, -6, "E4: my offline hand-pack deduction landed too");
  eq(remote.history.some(h => h.type === "hand-packed"), true, "E4: my pack is in History");
  eq(remote.history.some(h => h.type === "received" && h.item === "tambourines" && h.amount === 50), true, "E4: my delivery is in History");
  eq(remote.history.some(h => h.id === "their-1"), true, "E4: their delivery is still in History (no overwrite)");
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.queue.v1") || "[]").length), 0, "E4: queue drained after sync");
  eq(await page.$eval("#save-status", e => e.textContent), "Saved · now", "E4: header back to Saved");

  /* ---- Count conflict: my exact count vs their change ---- */
  online = false;
  await page.evaluate(() => { if (document.querySelector("#count-entry").hidden) document.querySelector("#btn-enter-counts").click(); });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#count-entry-list input[data-item="scissors"]').value = "190"; });
  await page.click("#btn-apply-counts");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(600);
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.queue.v1") || "[]").length), 1, "E4: offline count queued");
  remote.inventory["scissors"].qty = 210;
  remote.history.unshift({ id: "their-2", ts: new Date().toISOString(), type: "count-fix", title: "Count fix Scissors: 197 → 210", effects: [{ item: "scissors", delta: 13 }], item: "scissors", counted: 210, undone: false });
  remoteSha = "sha-theirs2";
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(async () => (await page.$eval("#sheet-title", e => e.textContent)).includes("Count conflict"), "conflict sheet appears");
  eq(await page.$eval("#sheet-summary", e => e.textContent.includes("190") && e.textContent.includes("210")), true, "E4: the sheet shows both numbers (mine 190, theirs 210)");
  await page.click("#sheet-primary"); /* Use my count (190) */
  await waitFor(() => remote.inventory["scissors"].qty === 190, "my count lands");
  eq(remote.inventory["scissors"].qty, 190, "E4: my count stands after I pick it");
  eq(remote.inventory["tambourines"].qty, 150, "E4: resolving the conflict overwrote nothing else");
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.queue.v1") || "[]").length), 0, "E4: queue drained after the conflict resolves");

  /* ---- Service worker + snapshot: the app opens with no signal ---- */
  await waitFor(async () => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => !!r).catch(() => false)), "service worker registered");
  eq(await page.evaluate(() => caches.keys().then(k => k.includes("alooma-shell-v1"))), true, "E4: app shell is cached");
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await sleep(1200);
  eq(await page.evaluate(() => document.body.classList.contains("load-failed")), false, "E4: offline reopen does NOT hit the empty state");
  eq(await page.$eval("#tab-inventory", e => getComputedStyle(e).display !== "none" || e.classList.contains("active")), true, "E4: inventory renders offline from the snapshot");
  eq(await page.$eval("#save-status", e => e.textContent.includes("Offline")), true, "E4: header says Offline on the snapshot");
  await page.setOfflineMode(false);

  console.log(pass + " passed, " + fail + " failed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
