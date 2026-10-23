/* UI tests: drive the REAL page and REAL buttons in headless Chrome.
   The GitHub API is mocked at the network layer so editor flows (connect,
   save-per-change, disconnect) run end to end without a real token.
   Run: node tests/test-ui.mjs   (needs the steady testbed's puppeteer-core) */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
/* Portable browser loading: full `puppeteer` if installed (CI installs it);
   otherwise the sandbox's puppeteer-core + chrome-headless-shell.
   Override with PUPPETEER_CORE_PATH / CHROME_PATH. */
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8907;

let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* In-memory "GitHub repo": starts as the shipped data.json */
let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
let remoteSha = "sha-1";
let putCount = 0;
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
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: CORS, body: "" });
    }
    if (url.startsWith("https://api.github.com/user") && req.method() === "GET") {
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "testeditor" }) });
    }
    if (url.includes("api.github.com/repos/") && url.includes("/contents/data.json")) {
      if (req.method() === "GET") {
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remoteData)) }) });
      }
      if (req.method() === "PUT") {
        putCount++;
        const body = JSON.parse(req.postData());
        remoteData = JSON.parse(b64d(body.content));
        remoteSha = "sha-" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, contentType: "application/json", body: "{}" });
    req.continue();
  });
  page.on("dialog", async d => { await d.accept(testDialogAnswer); });
  let testDialogAnswer = "";
  globalThis.__setDialog = v => { testDialogAnswer = v; };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(400);

  /* Viewer mode by default */
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "starts view-only");
  /* Regression (2026-10-22): the empty toast must be truly hidden on load —
     .toast{display:flex} used to override [hidden] and render a black pill */
  eq(await page.$eval("#toast", e => getComputedStyle(e).display), "none", "toast hidden on load (no floating pill)");
  eq(await page.$eval("#toast", e => { e.hidden = false; const d = getComputedStyle(e).display; e.hidden = true; return d; }), "flex", "toast displays when shown");
  eq(await page.$$eval("#pack-crafts .craft-btn", els => els.length), 6, "6 craft buttons");
  /* Batch A1: NOTHING pre-selected — no craft, no kits, buttons disabled with the reason inside */
  eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 0, "A1: no craft pre-selected on Packing");
  eq(await page.$$eval("#hand-crafts .craft-btn.selected", els => els.length), 0, "A1: no craft pre-selected on Hand-packed");
  eq(await page.$eval("#pack-sku", e => e.textContent), "—", "A1: no SKU until craft+kits chosen");
  eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Choose a craft|true", "A1/A4: Complete disabled, reason inside button");
  eq(await page.$eval("#btn-record-hand", e => e.textContent + "|" + e.disabled), "Choose a craft|true", "A1/A4: Record disabled, reason inside button");
  eq(await page.$$eval("#pack-table tbody tr", els => els.length), 0, "A1: no pack list before choosing");

  /* Choose The Cakery + 18 kits -> the pack list appears */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await sleep(150);
  eq(await page.$eval("#btn-complete-pack", e => e.textContent), "Choose kits", "A4: after craft, reason becomes Choose kits");
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  eq(await page.$eval("#pack-sku", e => e.textContent), "CAK-18", "SKU CAK-18 after choosing craft+kits");
  const packRows = await page.$$eval("#pack-table tbody tr", trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim()).join("|")));
  eq(packRows.length, 19, "CAK pack list 19 rows");
  eq(packRows.find(r => r.includes("Heart Jewelry Box")), "|Heart Jewelry Box|18|0", "CAK18 heart box row");
  eq(packRows.find(r => r.includes("Poster stands")), "|Poster stands (for quotes)|9|0", "CAK18 poster stands row");

  /* Connect with a (mock) token */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await page.type("#gh-token", "fake-token-for-test");
  await page.click("#btn-connect");
  await sleep(600);
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "Editor — @testeditor", "connected as editor");
  const ls = await page.evaluate(() => localStorage.getItem("alooma.editor.v1"));
  eq(JSON.parse(ls).login, "testeditor", "editor saved on this device only (localStorage)");

  /* Receive: 200 scissors via the new item panel (tap item -> Receive -> qty -> Add) */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(200);
  await page.evaluate(() => {
    document.querySelector('.inv-item[data-item="scissors"] .inv-main').click();
  });
  await sleep(250);
  await page.evaluate(() => {
    const row = document.querySelector('.inv-item[data-item="scissors"]');
    row.querySelector(".inv-panel-input").value = "200";
    row.querySelector(".inv-panel-go").click();
  });
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 200, "receive committed to (mock) repo");
  eq(remoteData.history[0].type, "received", "receive logged in history data");

  /* Threshold: open panel, switch to Warning mode, set 250 -> badge shows */
  await page.evaluate(() => {
    const row = document.querySelector('.inv-item[data-item="scissors"]');
    if (!row.querySelector(".inv-panel")) row.querySelector(".inv-main").click();
  });
  await sleep(250);
  await page.evaluate(() => {
    document.querySelector('.inv-item[data-item="scissors"] .seg button[data-mode="warning"]').click();
  });
  await sleep(250);
  await page.evaluate(() => {
    const row = document.querySelector('.inv-item[data-item="scissors"]');
    row.querySelector(".inv-panel-input").value = "250";
    row.querySelector(".inv-panel-go").click();
  });
  await sleep(600);
  eq(remoteData.inventory["scissors"].threshold, 250, "threshold saved via panel");
  eq(await page.$$eval('.inv-item[data-item="scissors"] .low-badge', els => els.length), 1, "low-stock badge at qty<=threshold");

  /* Target-size audit (editor, inventory panel open): nothing interactive under 44px */
  const smallTargets = await page.evaluate(() =>
    [...document.querySelectorAll('#tab-inventory button, #tab-inventory input:not([type="checkbox"])')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ tag: el.tagName + "." + el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter(x => x.h < 44));
  eq(smallTargets.length, 0, "inventory: no interactive element under 44px (found: " + JSON.stringify(smallTargets.slice(0, 4)) + ")");

  /* Complete CAK-18 (Batch A): reason counts down, printing unlocks, sheet confirms */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Check 19 more|true", "A4: disabled reason counts unchecked items");
  await page.evaluate(() => { window.print = () => {}; });
  await page.click("#btn-print-sheet");
  await sleep(200);
  eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Complete CAK-18|false", "A4: printing the sheet unlocks Complete for this order");
  await page.click("#btn-check-all");
  await sleep(150);
  eq(await page.$eval("#pack-progress", e => e.textContent), "19 of 19 checked", "check-all progress text");
  eq(await page.$eval("#btn-complete-pack", e => e.disabled), false, "complete enabled after check-all");
  const smallPack = await page.evaluate(() =>
    [...document.querySelectorAll('#tab-pack button, #tab-pack input:not([type="checkbox"])')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ tag: el.tagName + "." + el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter(x => x.h < 44));
  eq(smallPack.length, 0, "pack: no interactive element under 44px (found: " + JSON.stringify(smallPack.slice(0, 4)) + ")");
  await page.click("#btn-complete-pack");
  await sleep(250);
  eq(await page.$eval("#sheet-title", e => e.textContent), "The Cakery", "A5: confirm sheet shows craft name");
  eq(await page.$eval("#sheet-sub", e => e.textContent), "18 kits · CAK-18", "A5: sheet shows kits + SKU");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "Subtract from inventory", "A5: sheet primary label");
  await page.click("#sheet-primary");
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 194, "CAK-18 deducted 6 scissors (200->194)");
  eq(remoteData.inventory["heart-jewelry-box"].qty, -18, "CAK-18 deducted 18 heart boxes");
  eq(remoteData.history[0].type, "packed", "pack logged");

  /* Undo the pack from History (via the confirm sheet): inventory restored exactly */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(250);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Undo this entry?", "A5: undo uses the confirm sheet, not a pop-up");
  await page.click("#sheet-primary");
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 200, "undo pack restored scissors");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 0, "undo pack restored heart boxes");
  eq(remoteData.history.find(h => h.type === "packed").undone, true, "entry marked undone");

  /* Hand-packed HCB 18: heat gun 1 (tier: up to and including 18 = 1), wood board 18 */
  await page.evaluate(() => document.querySelector('[data-tab="hand"]').click());
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll("#hand-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat")).click();
    document.querySelector("#hand-kits").value = "18";
    document.querySelector("#hand-kits").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  eq(await page.$eval("#hand-sku", e => e.textContent), "HCB-18", "hand SKU HCB-18");
  eq(await page.$eval("#btn-record-hand", e => e.textContent + "|" + e.disabled), "Record HCB-18|false", "A3: Record button names the order");
  await page.click("#btn-record-hand");
  await sleep(250);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Hafrashat Challah", "A5: hand-packed confirm sheet shows craft");
  await page.click("#sheet-primary");
  await sleep(600);
  eq(remoteData.inventory["heat-gun"].qty, -1, "hand-packed HCB-18 heat gun tier = 1");
  eq(remoteData.inventory["wood-burning-cream"].qty, -1, "hand-packed HCB-18 wood cream tier = 1");
  eq(remoteData.inventory["wood-board"].qty, -18, "hand-packed HCB-18 wood board 18");

  /* Count fix via Enter counts: scissors counted 190 */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(200);
  await page.click("#btn-enter-counts");
  await sleep(200);
  await page.evaluate(() => {
    const inp = document.querySelector('#count-entry-list input[data-item="scissors"]');
    inp.value = "190";
    document.querySelector("#btn-apply-counts").click();
  });
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 190, "count entry set scissors to 190");
  eq(remoteData.history[0].type, "count-fix", "count fix logged");

  /* Edit that count-fix entry via the sheet's number field: counted 195 */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector(".history-entry .btn-edit").click());
  await sleep(250);
  eq(await page.$eval("#sheet-input-label", e => e.textContent), "Counted number", "A5: edit sheet has a proper number field");
  await page.evaluate(() => { document.querySelector("#sheet-input").value = "195"; });
  await page.click("#sheet-primary");
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 195, "edit count-fix to 195 applied exactly");

  /* Print areas: pack sheet has Order ID line; inventory report grouped, shared once */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(150);
  const packPrint = await page.evaluate(() => {
    window.print = () => {};
    document.querySelector("#btn-print-sheet").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq(packPrint.includes("Order ID:"), true, "packing sheet has Order ID line");
  eq(packPrint.includes("CAK-18"), true, "packing sheet shows SKU");
  const invPrint = await page.evaluate(() => {
    document.querySelector('[data-tab="inventory"]').click();
    document.querySelector("#btn-print-inventory").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq((invPrint.match(/Scissors/g) || []).length, 1, "inventory report lists Scissors once");
  eq(invPrint.includes("Shared items"), true, "inventory report has Shared group");
  eq(invPrint.includes("Order ID:"), false, "inventory report has NO Order ID line (fixed)");
  const countPrint = await page.evaluate(() => {
    document.querySelector("#btn-print-count").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq(countPrint.includes("Should be") && countPrint.includes("Counted"), true, "count sheet has Should be / Counted columns");

  /* Batch B: picker folds (B1), solid action bar (B2), inventory filters + print menu (B3), receive delivery (B4) */
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  eq(await page.$eval("#pack-picker-summary", e => e.hidden), false, "B1: picker folded into summary line after choosing");
  eq(await page.$eval("#pack-summary-text", e => e.textContent), "The Cakery · 18 kits", "B1: summary line names craft + kits");
  eq(await page.$eval("#pack-picker", e => e.hidden), true, "B1: full picker hidden once folded");
  const firstRowTop = await page.evaluate(() => Math.round(document.querySelector("#pack-table tbody tr").getBoundingClientRect().top + window.scrollY));
  console.log("B1 measured: first pack row top =", firstRowTop, "px");
  eq(firstRowTop < 460, true, "B1: first pack row near the top (was ~857px before B1)");
  await page.click("#btn-pack-change");
  await sleep(200);
  eq(await page.$eval("#pack-picker", e => e.hidden), false, "B1: Change reopens the picker");
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  eq(await page.$eval("#pack-picker", e => e.hidden), true, "B1: picking again re-folds the picker");
  eq(await page.$eval("#btn-print-sheet", e => e.textContent.trim()), "🖨 Print", "B2: print button is one short label");
  const barBg = await page.evaluate(() => getComputedStyle(document.querySelector("#tab-pack .action-bar")).backgroundColor);
  eq(barBg, "rgb(255, 255, 255)", "B2: action bar is solid white, not see-through");
  const btnH = await page.$eval("#btn-print-sheet", e => Math.round(e.getBoundingClientRect().height));
  eq(btnH <= 52, true, "B2: action buttons fit one line (height " + btnH + "px)");

  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(250);
  eq(await page.$eval("#all-count", e => e.textContent), "62", "B3: All filter shows the live total");
  const expLow = Object.keys(remoteData.inventory).filter(id => { const r = remoteData.inventory[id]; return r.threshold !== null && r.threshold !== undefined && r.qty <= r.threshold; }).length;
  const expOut = Object.values(remoteData.inventory).filter(r => r.qty === 0).length;
  eq(await page.$eval("#low-count", e => e.textContent), String(expLow), "B3: Low filter count matches the data");
  eq(await page.$eval("#out-count", e => e.textContent), String(expOut), "B3: Out filter count matches the data");
  await page.click("#btn-lowfilter");
  await sleep(200);
  const visLow = await page.$$eval(".inv-item", els => els.filter(e => e.style.display !== "none").length);
  eq(visLow, expLow, "B3: Low filter shows only low items");
  await page.click("#btn-filter-all");
  await sleep(200);
  eq(await page.$eval("#btn-print-inventory", e => e.offsetParent === null), true, "B3: print options live inside the Print menu");
  await page.click("#btn-print-menu");
  await sleep(150);
  eq(await page.$eval("#print-menu", e => e.hidden), false, "B3: Print menu opens");

  const putsBefore = putCount;
  await page.click("#btn-delivery");
  await sleep(250);
  await page.evaluate(() => {
    document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "50";
    document.querySelector('#delivery-entry-list input[data-item="wood-board"]').value = "18";
  });
  await page.click("#btn-apply-delivery");
  await sleep(700);
  eq(remoteData.inventory["scissors"].qty, 245, "B4: delivery added 50 scissors (195->245)");
  eq(remoteData.inventory["wood-board"].qty, 0, "B4: delivery added 18 wood boards (-18->0)");
  eq(remoteData.history[0].type, "received", "B4: newest History entry is a delivery receive");
  eq(remoteData.history[1].type, "received", "B4: second History entry is the other delivered item");
  eq(putCount, putsBefore + 1, "B4: the whole delivery saved with ONE repo write");

  /* Disconnect: back to view-only, token gone from this device */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(150);
  await page.click("#btn-disconnect");
  await sleep(600);
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "disconnect returns to view-only");
  eq(await page.evaluate(() => localStorage.getItem("alooma.editor.v1")), null, "token removed from device on disconnect");

  /* Export produces the current data */
  eq(remoteData.inventory["scissors"].qty, 195, "final remote scissors = 195 (receive 200, count 190, edit 195)");

  console.log(pass + " passed, " + fail + " failed; mock-repo PUTs: " + putCount);
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
