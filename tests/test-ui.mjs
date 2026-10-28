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
const failList = [];
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; failList.push(label); console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
/* Rerun-2 hardening: a check that throws (missing element, bad
   dereference, undefined helper) used to abort the whole suite and mask
   every later failure. chk turns a throw into a recorded failure, so one
   run shows the full list. */
async function chk(fn, label) {
  try { await fn(); } catch (e) { fail++; failList.push(label + " (threw: " + (e && e.message) + ")"); console.log("FAIL " + label + "\n  threw " + (e && e.message)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* In-memory "GitHub repo": starts as the shipped data.json */
/* The repo's data.json is the user's LIVE warehouse data (since 2026-10-23 he
   uses the app for real), so reset it to a known blank state: the suites
   assert exact quantities and feature-off defaults and must not depend on
   whatever state his real usage left in the file. */
let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 0, threshold: null }; });
remoteData.history = [];
remoteData.settings = { features: { bulkTab: true } };
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

const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 90000 });
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

/* A3: a tab switch with anything chosen or unsaved opens the "Unsaved
   changes" prompt instead of switching. test-ui always takes Discard here:
   the dirty state at every such switch is already saved or intentionally
   abandoned, matching the old silent-clear outcomes. (Defined inside the
   try block: it closes over the block-scoped `page`.) */
async function tab(name) {
  await page.evaluate((n) => document.querySelector('[data-tab="' + n + '"]').click(), name);
  await sleep(200);
  const prompt = await page.$eval("#sheet-backdrop", e => !e.hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes").catch(() => false);
  if (prompt) { await page.click("#sheet-cancel"); await sleep(200); }
}

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(400);

  /* Viewer mode by default */
  await chk(async () => eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "starts view-only"), "starts view-only");
  /* Regression (2026-10-22): the empty toast must be truly hidden on load —
     .toast{display:flex} used to override [hidden] and render a black pill */
  await chk(async () => eq(await page.$eval("#toast", e => getComputedStyle(e).display), "none", "toast hidden on load (no floating pill)"), "toast hidden on load (no floating pill)");
  await chk(async () => eq(await page.$eval("#toast", e => { e.hidden = false; const d = getComputedStyle(e).display; e.hidden = true; return d; }), "flex", "toast displays when shown"), "toast displays when shown");
  await chk(async () => eq(await page.$$eval("#pack-crafts .craft-btn", els => els.length), 6, "6 craft buttons"), "6 craft buttons");
  /* Batch A1: NOTHING pre-selected — no craft, no kits, buttons disabled with the reason inside */
  await chk(async () => eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 0, "A1: no craft pre-selected on Packing"), "A1: no craft pre-selected on Packing");
  await chk(async () => eq(await page.$eval("#pack-single-actions", e => e.hidden), true, "Merge: no Queue / Print / Hand pack choice before craft+kits"), "Merge: no Queue / Print / Hand pack choice before craft+kits");
  await chk(async () => eq(await page.$eval("#pack-sku", e => e.textContent), "—", "A1: no SKU until craft+kits chosen"), "A1: no SKU until craft+kits chosen");
  await chk(async () => eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Choose a craft|true", "A1/A4: Complete disabled, reason inside button"), "A1/A4: Complete disabled, reason inside button");
  await chk(async () => eq(await page.$eval('[data-tab="pack"]', e => e.hidden), true, "View-only: Packing tab hidden"), "View-only: Packing tab hidden");
  await chk(async () => eq(await page.$eval('[data-tab="bulk"]', e => e.hidden), true, "View-only: Bulk import tab hidden"), "View-only: Bulk import tab hidden");
  await chk(async () => eq(await page.$eval('[data-tab="settings"]', e => e.hidden), true, "View-only: Settings tab hidden"), "View-only: Settings tab hidden");
  await chk(async () => eq(await page.$eval('[data-tab="inventory"]', e => e.hidden), false, "View-only: Inventory tab stays visible"), "View-only: Inventory tab stays visible");
  await chk(async () => eq(await page.$eval('[data-tab="history"]', e => e.hidden), false, "View-only: History tab stays visible"), "View-only: History tab stays visible");
  await chk(async () => eq(await page.$eval("#tab-inventory", e => e.classList.contains("active")), true, "View-only: app opens on Inventory"), "View-only: app opens on Inventory");
  await chk(async () => eq(await page.$$eval("#pack-table tbody tr", els => els.length), 0, "A1: no pack list before choosing"), "A1: no pack list before choosing");
  /* v2 A1: calm first screen — action row truly hidden (CSS respects the
     attribute), no red kits error before the field is touched, muted help */
  await chk(async () => eq(await page.$eval("#pack-single-actions", e => getComputedStyle(e).display), "none", "v2 A1: Queue / Print / Hand pack truly hidden before a choice"), "v2 A1: Queue / Print / Hand pack truly hidden before a choice");
  await chk(async () => eq(await page.$eval("#pack-error", e => e.textContent), "", "v2 A1: no red kits error on a fresh screen"), "v2 A1: no red kits error on a fresh screen");
  await chk(async () => eq(await page.$eval("#pack-help", e => !e.hidden && e.textContent.includes("Pick a craft")), true, "v2 A1: muted help line shows instead of the error"), "v2 A1: muted help line shows instead of the error");
  /* (field set via evaluate: the Packing tab itself is hidden in view-only) */
  await page.evaluate(() => { const i = document.querySelector("#pack-kits"); i.value = "7"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await chk(async () => eq(await page.$eval("#pack-error", e => e.textContent.includes("multiples of 6")), true, "v2 A1: kits error appears once the field is touched"), "v2 A1: kits error appears once the field is touched");
  await chk(async () => eq(await page.$eval("#pack-help", e => e.hidden), true, "v2 A1: help line gives way to the error"), "v2 A1: help line gives way to the error");
  await page.evaluate(() => { const i = document.querySelector("#pack-kits"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); });
  /* v2 A4: the disabled primary's label IS the instruction — measure its contrast */
  const disRatio = await page.evaluate(() => {
    const b = document.querySelector("#btn-complete-pack");
    const cs = getComputedStyle(b);
    const lum = rgb => { const p = rgb.match(/[\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]); };
    const l1 = lum(cs.color), l2 = lum(cs.backgroundColor);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  });
  await chk(async () => eq(disRatio >= 4.5, true, "v2 A4: disabled primary contrast >= 4.5:1 (measured " + disRatio + ":1)"), "v2 A4: disabled primary contrast >= 4.5:1 (measured " + disRatio + ":1)");

  /* Connect with a (mock) token — reached by tapping the header badge,
     the view-only door into Settings */
  await page.click("#conn-badge");
  await sleep(200);
  await chk(async () => eq(await page.$eval("#tab-settings", e => e.classList.contains("active")), true, "View-only: badge tap opens Settings to connect"), "View-only: badge tap opens Settings to connect");
  await chk(async () => eq(await page.$eval("#tab-settings details summary", e => Math.round(e.getBoundingClientRect().height) >= 44), true, "v2 C4: 'How to make a token' summary is a 44px target"), "v2 C4: 'How to make a token' summary is a 44px target");
  await page.type("#gh-token", "fake-token-for-test");
  await page.click("#btn-connect");
  await sleep(600);
  await chk(async () => eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "Editor", "v2 C3: badge reads Editor with a check (username lives in Settings only)"), "v2 C3: badge reads Editor with a check (username lives in Settings only)");
  await chk(async () => eq(await page.$eval("#conn-badge", e => Math.round(e.getBoundingClientRect().height)), 44, "v2 C3: badge is a 44px target"), "v2 C3: badge is a 44px target");
  await chk(async () => eq(await page.$eval('[data-tab="pack"]', e => e.hidden), false, "Editor: all tabs appear once connected"), "Editor: all tabs appear once connected");
  const ls = await page.evaluate(() => localStorage.getItem("alooma.editor.v1"));
  await chk(async () => eq(JSON.parse(ls).login, "testeditor", "editor saved on this device only (localStorage)"), "editor saved on this device only (localStorage)");

  /* Choose The Cakery + 18 kits -> rows are computed; nothing shows under
     the Print / Hand pack choice until a path is picked */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await sleep(150);
  await chk(async () => eq(await page.$eval("#btn-complete-pack", e => e.textContent), "Choose kits", "A4: after craft, reason becomes Choose kits"), "A4: after craft, reason becomes Choose kits");
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-sku", e => e.textContent), "CAK-18", "SKU CAK-18 after choosing craft+kits"), "SKU CAK-18 after choosing craft+kits");
  await chk(async () => eq(await page.$eval(".craft-btn.selected", e => getComputedStyle(e).backgroundColor), "rgb(232, 238, 248)", "v2 C1: selected craft uses the one selected style"), "v2 C1: selected craft uses the one selected style");
  await chk(async () => eq(await page.$eval(".kits-chip.selected", e => getComputedStyle(e).backgroundColor), "rgb(232, 238, 248)", "v2 C1: selected kit chip uses the one selected style"), "v2 C1: selected kit chip uses the one selected style");
  await chk(async () => eq(await page.$eval("#pack-order", e => e.hidden), true, "Flow: nothing under Print / Hand pack until a path is picked"), "Flow: nothing under Print / Hand pack until a path is picked");
  const packRows = await page.$$eval("#pack-table tbody tr", trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim()).join("|")));
  await chk(async () => eq(packRows.length, 19, "CAK pack list 19 rows"), "CAK pack list 19 rows");
  await chk(async () => eq(packRows.find(r => r.includes("Heart Jewelry Box")), "|Heart Jewelry Box|18|0", "CAK18 heart box row"), "CAK18 heart box row");
  await chk(async () => eq(packRows.find(r => r.includes("Poster stands")), "|Poster stands (for quotes)|9|0", "CAK18 poster stands row"), "CAK18 poster stands row");

  /* Receive: 200 scissors via the new item panel (tap item -> Receive -> qty -> Add) */
  await tab("inventory");
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
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 200, "receive committed to (mock) repo"), "receive committed to (mock) repo");
  await chk(async () => eq(remoteData.history[0].type, "received", "receive logged in history data"), "receive logged in history data");

  /* Fix-round batch (a) item 6: Receive rejects decimals, huge counts, 0. */
  const hist0 = remoteData.history.length;
  const recvReject = async (v) => {
    await page.evaluate((x) => {
      const row = document.querySelector('.inv-item[data-item="scissors"]');
      if (!row.querySelector(".inv-panel")) row.querySelector(".inv-main").click();
      row.querySelector(".inv-panel-input").value = x;
      row.querySelector(".inv-panel-go").click();
    }, v);
    await sleep(600);
  };
  await recvReject("6.5");
  await chk(async () => eq(await page.evaluate(() => { const b = document.querySelector("#error-banner"); return !b.hidden && b.textContent.includes("1 to 999"); }), true, "(a) Receive decimal rejected with 1-999 message"), "(a) Receive decimal rejected with 1-999 message");
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 200, "(a) decimal receive saved nothing"), "(a) decimal receive saved nothing");
  await recvReject("100000");
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 200, "(a) huge receive saved nothing"), "(a) huge receive saved nothing");
  await recvReject("0");
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 200, "(a) zero receive saved nothing"), "(a) zero receive saved nothing");
  await chk(async () => eq(remoteData.history.length, hist0, "(a) rejected receives logged nothing"), "(a) rejected receives logged nothing");

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
  await chk(async () => eq(remoteData.inventory["scissors"].threshold, 250, "threshold saved via panel"), "threshold saved via panel");
  await chk(async () => eq(await page.$$eval('.inv-item[data-item="scissors"] .low-badge', els => els.length), 1, "low-stock badge at qty<=threshold"), "low-stock badge at qty<=threshold");

  /* Target-size audit (editor, inventory panel open): nothing interactive under 44px */
  const smallTargets = await page.evaluate(() =>
    [...document.querySelectorAll('#tab-inventory button, #tab-inventory input:not([type="checkbox"])')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ tag: el.tagName + "." + el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter(x => x.h < 44));
  await chk(async () => eq(smallTargets.length, 0, "inventory: no interactive element under 44px (found: " + JSON.stringify(smallTargets.slice(0, 4)) + ")"), "inventory: no interactive element under 44px (found: " + JSON.stringify(smallTargets.slice(0, 4)) + ")");

  /* v3 D5: a FIRST delivery (no earlier one to compare with) flags at >5x on hand.
     This block must run HERE, before the Batch B stock-up below gives every
     item a 999 delivery — heat gun still has no delivery history at this
     point. It is set to 150 by count, checked, then restored to 0. */
  const hgBase = remoteData.inventory["heat-gun"].qty;
  const openPanel = async (panel, btn) => page.evaluate((p, b) => { if (document.querySelector(p).hidden) document.querySelector(b).click(); }, panel, btn);
  const closePanel = async (panel, btn) => page.evaluate((p, b) => { if (!document.querySelector(p).hidden) document.querySelector(b).click(); }, panel, btn);
  await openPanel("#count-entry", "#btn-enter-counts");
  await sleep(250);
  await page.evaluate(v => { document.querySelector('#count-entry-list input[data-item="heat-gun"]').value = String(v); }, 150);
  await page.click("#btn-apply-counts");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["heat-gun"].qty, 150, "v3 D5 setup: heat gun counted to 150 with no delivery history"), "v3 D5 setup: heat gun counted to 150 with no delivery history");
  await chk(async () => eq(await page.$eval("#save-status", e => e.textContent), "Saved · now", "v3 D7: save line uses the short form"), "v3 D7: save line uses the short form");
  await closePanel("#count-entry", "#btn-cancel-counts");
  await openPanel("#delivery-entry", "#btn-delivery");
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="heat-gun"]').value = "900"; });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Heat gun +900") && e.textContent.includes("(6× on hand)")), true, "v3 D5: first delivery of 900 on 150 on hand flags (6× on hand)"), "v3 D5: first delivery of 900 on 150 on hand flags (6× on hand)");
  await page.click("#sheet-cancel");
  await sleep(200);
  await chk(async () => eq(remoteData.inventory["heat-gun"].qty, 150, "v3 D5: Edit numbers saved nothing"), "v3 D5: Edit numbers saved nothing");
  await closePanel("#delivery-entry", "#btn-cancel-delivery");
  await openPanel("#count-entry", "#btn-enter-counts");
  await sleep(250);
  await page.evaluate(v => { document.querySelector('#count-entry-list input[data-item="heat-gun"]').value = String(v); }, hgBase);
  await page.click("#btn-apply-counts");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["heat-gun"].qty, hgBase, "v3 D5 cleanup: heat gun restored to " + hgBase), "v3 D5 cleanup: heat gun restored to " + hgBase);
  await closePanel("#count-entry", "#btn-cancel-counts");

  /* Complete CAK-18: reason counts down, Hand pack reveals the checklist.
     A3: the inventory detour discarded the earlier Cakery-18 pick, so
     re-pick it here. */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  await chk(async () => eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Check 19 more|true", "A4: disabled reason counts unchecked items"), "A4: disabled reason counts unchecked items");
  await page.evaluate(() => { window.print = () => {}; });
  await page.click("#btn-pack-hand");
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-order", e => e.hidden), false, "Flow: Hand pack reveals the order area"), "Flow: Hand pack reveals the order area");
  await chk(async () => eq(await page.$eval("#pack-checklist", e => e.hidden), false, "Flow: checklist appears under Hand pack"), "Flow: checklist appears under Hand pack");
  /* v3 E1: the pack-list warning totals the shorts, then lists each one
     with have / need / short, biggest shortage first */
  await chk(async () => eq(await page.$eval("#pack-warning .warn-toggle", e => e.textContent.startsWith("⚠") && e.textContent.includes("items short")), true, "v3 E1: warning toggle totals the short items"), "v3 E1: warning toggle totals the short items");
  await page.click("#pack-warning .warn-toggle");
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-warning .warn-full", e => e.textContent.includes("Heart Jewelry Box: have 0, need 18, short 18")), true, "v3 E1: list shows heart box have/need/short"), "v3 E1: list shows heart box have/need/short");
  await chk(async () => eq(await page.$eval("#pack-warning .warn-full", e => e.textContent.includes("Poster stands (for quotes): have 0, need 9, short 9")), true, "v3 E1: list shows poster stands have/need/short"), "v3 E1: list shows poster stands have/need/short");
  await chk(async () => eq(await page.$eval("#pack-warning .short-list li", e => e.textContent.includes("short 18")), true, "v3 E1: biggest shortage is listed first"), "v3 E1: biggest shortage is listed first");
  await page.click("#btn-check-all");
  await sleep(150);
  await chk(async () => eq(await page.$eval("#sheet-summary", e => e.textContent), "Mark all 19 packed?", "v2 A5: Check all asks first"), "v2 A5: Check all asks first");
  await chk(async () => eq(await page.$eval("#pack-progress", e => e.textContent), "0 of 19 checked", "v2 A5: nothing is checked until the sheet confirms"), "v2 A5: nothing is checked until the sheet confirms");
  await page.click("#sheet-primary");
  await sleep(150);
  await chk(async () => eq(await page.$eval("#pack-progress", e => e.textContent), "19 of 19 checked", "check-all progress text"), "check-all progress text");
  await chk(async () => eq(await page.$eval("#btn-complete-pack", e => e.disabled), false, "complete enabled after check-all"), "complete enabled after check-all");
  const smallPack = await page.evaluate(() =>
    [...document.querySelectorAll('#tab-pack button, #tab-pack input:not([type="checkbox"])')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ tag: el.tagName + "." + el.className, h: Math.round(el.getBoundingClientRect().height) }))
      .filter(x => x.h < 44));
  await chk(async () => eq(smallPack.length, 0, "pack: no interactive element under 44px (found: " + JSON.stringify(smallPack.slice(0, 4)) + ")"), "pack: no interactive element under 44px (found: " + JSON.stringify(smallPack.slice(0, 4)) + ")");
  await page.click("#btn-complete-pack");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "The Cakery", "A5: confirm sheet shows craft name"), "A5: confirm sheet shows craft name");
  await chk(async () => eq(await page.$eval("#sheet-sub", e => e.textContent), "18 kits · CAK-18", "A5: sheet shows kits + SKU"), "A5: sheet shows kits + SKU");
  /* v2 A2: this order IS short (most CAK items sit at 0 here) — the sheet must shout it */
  await chk(async () => eq(await page.$eval("#sheet-extra", e => !e.hidden && e.textContent.includes("items short")), true, "v2 A2: red short block shows on a short order"), "v2 A2: red short block shows on a short order");
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Heart Jewelry Box: have 0, need 18, short 18")), true, "v3 E1: sheet line gives have / need / short"), "v3 E1: sheet line gives have / need / short");
  await chk(async () => eq(/^Subtract anyway \(\d+ short\)$/.test(await page.$eval("#sheet-primary", e => e.textContent)), true, "v2 A2: primary becomes Subtract anyway (N short)"), "v2 A2: primary becomes Subtract anyway (N short)");
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.classList.contains("danger")), true, "v2 A2: primary is the danger outline style"), "v2 A2: primary is the danger outline style");
  await chk(async () => eq(await page.$eval("#sheet-cancel", e => e.textContent + "|" + e.classList.contains("btn-primary")), "Go back|true", "v2 A2: Go back becomes the filled button"), "v2 A2: Go back becomes the filled button");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 194, "CAK-18 deducted 6 scissors (200->194)"), "CAK-18 deducted 6 scissors (200->194)");
  await chk(async () => eq(remoteData.inventory["heart-jewelry-box"].qty, -18, "CAK-18 deducted 18 heart boxes"), "CAK-18 deducted 18 heart boxes");
  await chk(async () => eq(remoteData.history[0].type, "hand-packed", "pack logged"), "pack logged");

  /* Undo the pack from History (via the confirm sheet): inventory restored exactly */
  await tab("history");
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Undo this entry?", "A5: undo uses the confirm sheet, not a pop-up"), "A5: undo uses the confirm sheet, not a pop-up");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 200, "undo pack restored scissors"), "undo pack restored scissors");
  await chk(async () => eq(remoteData.inventory["heart-jewelry-box"].qty, 0, "undo pack restored heart boxes"), "undo pack restored heart boxes");
  await chk(async () => eq(remoteData.history.find(h => h.type === "hand-packed").undone, true, "entry marked undone"), "entry marked undone");

  /* Hand pack on the Packing tab = the checklist: pick HCB-18, tap Hand pack,
     check everything off, Complete. Heat gun 1 (tier: up to 18 = 1), board 18. */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat")).click());
  /* A3: the History detour discarded the CAK-18 pick, so the kits must be
     re-picked here — craft alone leaves the picker with no kits. */
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-sku", e => e.textContent), "HCB-18", "Flow: pack picker set to HCB-18"), "Flow: pack picker set to HCB-18");
  await chk(async () => eq(await page.$eval("#pack-single-actions", e => e.hidden), false, "Flow: Queue / Print / Hand pack appear once craft+kits are chosen"), "Flow: Queue / Print / Hand pack appear once craft+kits are chosen");
  await chk(async () => eq(await page.$eval("#pack-order", e => e.hidden), true, "Flow: a new order starts unchosen — nothing under the choice until a path is tapped"), "Flow: a new order starts unchosen — nothing under the choice until a path is tapped");
  await page.click("#btn-pack-hand");
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-checklist", e => e.hidden), false, "Flow: Hand pack reveals the checklist"), "Flow: Hand pack reveals the checklist");
  await chk(async () => eq(await page.$$eval("#pack-table tbody tr", els => els.length), 7, "Flow: HCB checklist has its 7 items"), "Flow: HCB checklist has its 7 items");
  await page.click("#btn-check-all");
  await sleep(150);
  await page.click("#sheet-primary"); /* v2 A5: confirm check-all */
  await sleep(150);
  await chk(async () => eq(await page.$eval("#btn-complete-pack", e => e.textContent + "|" + e.disabled), "Complete HCB-18|false", "Flow: Complete names the order once all checked"), "Flow: Complete names the order once all checked");
  await page.click("#btn-complete-pack");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Hafrashat Challah", "Flow: checklist Complete uses the confirm sheet"), "Flow: checklist Complete uses the confirm sheet");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["heat-gun"].qty, -1, "hand-pack checklist HCB-18 heat gun tier = 1"), "hand-pack checklist HCB-18 heat gun tier = 1");
  await chk(async () => eq(remoteData.inventory["wood-burning-cream"].qty, -1, "hand-pack checklist HCB-18 wood cream tier = 1"), "hand-pack checklist HCB-18 wood cream tier = 1");
  await chk(async () => eq(remoteData.inventory["wood-board"].qty, -18, "hand-pack checklist HCB-18 wood board 18"), "hand-pack checklist HCB-18 wood board 18");
  await chk(async () => eq(remoteData.history[0].type, "hand-packed", "Flow: checklist completion logs a hand-packed entry"), "Flow: checklist completion logs a hand-packed entry");
  /* Leave the pack tab as later sections expect: Cakery 18 picked */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await sleep(150);

  /* Bulk import tab: queue BM-6 + TAM-12, add-then-remove a JCA-6,
     record the rest in ONE save */
  await tab("bulk");
  await chk(async () => eq(await page.$$eval("#bulk-crafts .craft-btn.selected", els => els.length), 0, "Bulk: no craft pre-selected"), "Bulk: no craft pre-selected");
  await chk(async () => eq(await page.$eval("#btn-bulk-record", e => e.disabled), true, "Bulk: Record all disabled with an empty queue"), "Bulk: Record all disabled with an empty queue");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("Blooming")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="6"]');
  await sleep(200);
  await chk(async () => eq(await page.$eval("#bulk-sku", e => e.textContent), "BM-6", "Bulk: SKU BM-6"), "Bulk: SKU BM-6");
  await chk(async () => eq(await page.$eval("#btn-bulk-add", e => e.textContent + "|" + e.disabled), "Add BM-6|false", "Bulk: Add names the current order"), "Bulk: Add names the current order");
  await page.click("#btn-bulk-add");
  await sleep(200);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 1, "Bulk: first order queued"), "Bulk: first order queued");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="12"]');
  await sleep(200);
  await page.click("#btn-bulk-add");
  await sleep(200);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 2, "Bulk: second order queued"), "Bulk: second order queued");
  await chk(async () => eq(await page.$eval("#btn-bulk-record", e => e.textContent + "|" + e.disabled), "Record all · 2 orders|false", "Bulk: Record all counts the queue"), "Bulk: Record all counts the queue");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("Judaic")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="6"]');
  await sleep(200);
  await page.click("#btn-bulk-add");
  await sleep(200);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 3, "Bulk: third order queued"), "Bulk: third order queued");
  /* A REAL click here, not .click(): the app dismisses an action toast on
     the pointerdown of the user's next control press (so its UNDO button
     can never swallow a click) — a synthetic click fires no pointer
     events, so it would leave the toast sitting on the Record button.
     A hand always produces pointerdown; the test models the hand. */
  await page.click('#bulk-lines [data-remove="2"]');
  await sleep(200);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 2, "Bulk: queued order removed"), "Bulk: queued order removed");
  const putsBeforeBatch = putCount;
  await page.click("#btn-bulk-record");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Record all", "Bulk: batch confirm sheet"), "Bulk: batch confirm sheet");
  await chk(async () => eq(await page.$eval("#sheet-sub", e => e.textContent.includes("BM-6") && e.textContent.includes("TAM-12")), true, "Bulk: sheet names both orders"), "Bulk: sheet names both orders");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(putCount, putsBeforeBatch + 1, "Bulk: the whole batch saved in ONE commit"), "Bulk: the whole batch saved in ONE commit");
  await chk(async () => eq(remoteData.inventory["tree-mirror"].qty, -6, "Bulk: BM-6 deducted 6 tree mirrors"), "Bulk: BM-6 deducted 6 tree mirrors");
  await chk(async () => eq(remoteData.inventory["tambourines"].qty, -12, "Bulk: TAM-12 deducted 12 tambourines"), "Bulk: TAM-12 deducted 12 tambourines");
  await chk(async () => eq(remoteData.history[0].type, "bulk", "Bulk: first batch entry logged as bulk (Batch C A1)"), "Bulk: first batch entry logged as bulk (Batch C A1)");
  await chk(async () => eq(remoteData.history[1].type, "bulk", "Bulk: second batch entry logged as bulk (Batch C A1)"), "Bulk: second batch entry logged as bulk (Batch C A1)");
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 0, "Bulk: queue cleared after recording"), "Bulk: queue cleared after recording");

  /* Batch C item 3: NO prompt while adding — the duplicate check fires at
     Record all only (the old v3 D1 add-time prompt is gone). */
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="18"]');
  await sleep(200);
  await page.click("#btn-bulk-add");
  await sleep(250);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 1, "item3: order queued"), "item3: order queued");
  await chk(async () => eq(await page.$eval("#btn-bulk-add", e => e.textContent), "Pick a craft", "item3: picker cleared after Add"), "item3: picker cleared after Add");
  await chk(async () => eq(await page.$eval("#toast", e => e.textContent.includes("Added CAK-18")), true, "item3: toast confirms the add"), "item3: toast confirms the add");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(200);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 0, "item3: toast Undo un-queues the line"), "item3: toast Undo un-queues the line");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="18"]');
  await sleep(200);
  await page.click("#btn-bulk-add");
  await sleep(250);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 1, "item3: order queued again"), "item3: order queued again");
  await page.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="bulk"][data-kits="18"]');
  await sleep(200);
  await page.click("#btn-bulk-add");
  await sleep(250);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 2, "item3: re-adding queues silently, no prompt while adding"), "item3: re-adding queues silently, no prompt while adding");
  await chk(async () => eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "item3: no sheet opened while adding"), "item3: no sheet opened while adding");
  const histBeforeDup = remoteData.history.length;
  await page.click("#btn-bulk-record");
  await sleep(300);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Multiple of the same craft detected", "item3: Record all opens the duplicate pop-up"), "item3: Record all opens the duplicate pop-up");
  await chk(async () => eq(await page.$eval("#sheet-summary", e => e.textContent.includes("The Cakery x2 (18 kits + 18 kits)") && e.textContent.includes("Was this intentional?")), true, "item3: pop-up names the craft, count and kit amounts"), "item3: pop-up names the craft, count and kit amounts");
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.textContent), "YES", "item3: YES is the primary button"), "item3: YES is the primary button");
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.classList.contains("success")), true, "item3: YES is green"), "item3: YES is green");
  await chk(async () => eq(await page.$eval("#sheet-cancel", e => e.textContent), "NO", "item3: NO is the cancel button"), "item3: NO is the cancel button");
  await chk(async () => eq(await page.$eval("#sheet-cancel", e => e.classList.contains("danger")), true, "item3: NO is red"), "item3: NO is red");
  await page.click("#sheet-cancel");
  await sleep(250);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 2, "item3: NO keeps both lines"), "item3: NO keeps both lines");
  await chk(async () => eq(remoteData.history.length, histBeforeDup, "item3: NO records nothing"), "item3: NO records nothing");
  await page.click("#btn-bulk-record");
  await sleep(300);
  await page.click("#sheet-primary"); /* YES */
  await sleep(300);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Record all", "item3: YES proceeds to the Record all confirm"), "item3: YES proceeds to the Record all confirm");
  await page.click("#sheet-primary"); /* Subtract from inventory */
  await sleep(600);
  await chk(async () => eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 0, "item3: YES + confirm records the batch and clears the list"), "item3: YES + confirm records the batch and clears the list");
  await chk(async () => eq(remoteData.history.length, histBeforeDup + 2, "item3: YES + confirm logs both entries"), "item3: YES + confirm logs both entries");

  /* Count fix via Enter counts: scissors counted 190 */
  await tab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(200);
  await page.evaluate(() => {
    const inp = document.querySelector('#count-entry-list input[data-item="scissors"]');
    inp.value = "190";
    document.querySelector("#btn-apply-counts").click();
  });
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Set 1 count?", "v2 A3: counts open a confirm sheet before saving"), "v2 A3: counts open a confirm sheet before saving");
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Scissors: 179 → 190")), true, "v2 A3: count sheet lists old → new (179 = 200 after batch 1 used 9: BM-6 x3 + TAM-12 x6, and the item-3 dup batch used 12: CAK-18 x6 twice)"), "v2 A3: count sheet lists old → new (179 = 200 after batch 1 used 9: BM-6 x3 + TAM-12 x6, and the item-3 dup batch used 12: CAK-18 x6 twice)");
  await chk(async () => eq(await page.$eval("#sheet-cancel", e => e.textContent), "Edit numbers", "v2 A3: count sheet cancel returns to the numbers"), "v2 A3: count sheet cancel returns to the numbers");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 190, "count entry set scissors to 190"), "count entry set scissors to 190");
  await chk(async () => eq(remoteData.history[0].type, "count-fix", "count fix logged"), "count fix logged");

  /* Edit that count-fix entry via the sheet's number field: counted 195 */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector(".history-entry .btn-edit").click());
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-input-label", e => e.textContent), "Counted number", "A5: edit sheet has a proper number field"), "A5: edit sheet has a proper number field");
  await page.evaluate(() => { document.querySelector("#sheet-input").value = "195"; });
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 195, "edit count-fix to 195 applied exactly"), "edit count-fix to 195 applied exactly");

  /* Print areas: pack sheet has Order ID line; inventory report grouped, shared once.
     A4: printing now completes the order, so print CAK-18 (short here — the
     sheet asks "Print anyway" first), read the sheet, then UNDO the print
     so later sections see untouched stock and History. */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  await page.evaluate(() => { window.print = () => {}; });
  await page.click("#btn-pack-print");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.textContent), "Print anyway", "A4: a short order asks Print anyway before printing"), "A4: a short order asks Print anyway before printing");
  await page.click("#sheet-primary");
  await sleep(300);
  const packPrint = await page.$eval("#print-area", e => e.innerHTML);
  await chk(async () => eq(packPrint.includes("Order ID:"), true, "packing sheet has Order ID line"), "packing sheet has Order ID line");
  await chk(async () => eq(packPrint.includes("Total kits: 18"), true, "packing sheet shows Total kits (desktop brief item 3 subtitle)"), "packing sheet shows Total kits (desktop brief item 3 subtitle)");
  await chk(async () => eq(packPrint.includes("CAK-18"), false, "desktop brief item 3: no SKU line on the packing sheet (matches Mark's mockup)"), "desktop brief item 3: no SKU line on the packing sheet (matches Mark's mockup)");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(600);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 195, "A4: print UNDO restores the stock it deducted"), "A4: print UNDO restores the stock it deducted");
  const invPrint = await page.evaluate(() => {
    document.querySelector('[data-tab="inventory"]').click();
    document.querySelector("#btn-print-inventory").click();
    return document.querySelector("#print-area").innerHTML;
  });
  await chk(async () => eq((invPrint.match(/Scissors/g) || []).length, 1, "inventory report lists Scissors once"), "inventory report lists Scissors once");
  await chk(async () => eq(invPrint.includes("Shared items"), true, "inventory report has Shared group"), "inventory report has Shared group");
  await chk(async () => eq(invPrint.includes("Order ID:"), false, "inventory report has NO Order ID line (fixed)"), "inventory report has NO Order ID line (fixed)");
  const countPrint = await page.evaluate(() => {
    document.querySelector("#btn-print-count").click();
    return document.querySelector("#print-area").innerHTML;
  });
  await chk(async () => eq(countPrint.includes("Should be") && countPrint.includes("Counted"), true, "count sheet has Should be / Counted columns"), "count sheet has Should be / Counted columns");

  /* Batch B: picker never folds (brief 5/6), solid action bar (B2), inventory filters + print menu (B3), receive delivery (B4) */
  await page.setViewport({ width: 390, height: 844 });
  /* Stock up first (via the B4 delivery form) so the pack list shows no shortage warning:
     the B1 measurement is the normal stocked case the spec targets (~300px). */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(250);
  await page.click("#btn-delivery");
  await sleep(250);
  await page.evaluate(() => {
    document.querySelectorAll('#delivery-entry-list input[data-item]').forEach(inp => {
      const id = inp.getAttribute("data-item");
      if (id !== "scissors" && id !== "wood-board") inp.value = "999";
    });
  });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Add 60 items to stock?", "v2 A3: a delivery opens a confirm sheet before saving"), "v2 A3: a delivery opens a confirm sheet before saving");
  await page.click("#sheet-primary");
  await sleep(700);
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  /* A3: the pack -> bulk switch cleared the Cakery-18 selection, so this
     section re-picks it here — and the picker stays open, exactly as the
     Batch B redesign specifies. */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await sleep(150);
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(150);
  await chk(async () => eq(await page.$eval("#pack-picker", e => e.hidden), false, "Batch B: picker stays open after choosing"), "Batch B: picker stays open after choosing");
  await chk(async () => eq(await page.$$eval("#pack-picker-summary", els => els.length), 0, "Batch B: no fold summary element at all"), "Batch B: no fold summary element at all");
  await chk(async () => eq(await page.$eval("#pack-single-actions", e => e.hidden), false, "Batch B: Queue / Print / Hand pack appear once craft+kits are chosen"), "Batch B: Queue / Print / Hand pack appear once craft+kits are chosen");
  await page.click("#btn-pack-hand");
  await sleep(200);
  const firstRow = await page.evaluate(() => { const r = document.querySelector("#pack-table tbody tr").getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height) }; });
  const firstRowTop = firstRow.top;
  console.log("B1 measured: first pack row top =", firstRowTop, "px, height =", firstRow.h);
  const diagTops = await page.evaluate(() => {
    const t = s => { const e = document.querySelector(s); if (!e) return s + ":missing"; const r = e.getBoundingClientRect(); return s + " top=" + Math.round(r.top + window.scrollY) + " h=" + Math.round(r.height) + " disp=" + getComputedStyle(e).display; };
    return [t("#tab-pack"), t("#pack-picker"), t("#pack-warning"), t(".list-head"), t("#pack-table thead"), t(".app-header"), t("main")].join(" | ");
  });
  console.log("B1 diag:", diagTops);
  await chk(async () => eq(firstRow.h > 0, true, "Batch B: first pack row is actually rendered (not a hidden-element measurement)"), "Batch B: first pack row is actually rendered (not a hidden-element measurement)");
  /* No fold anymore: the full picker (craft grid + chips + action row)
     sits above the table, so the first row lands lower than the folded
     ~420px — but still far from the ~857px buried-table case. */
  await chk(async () => eq(firstRowTop < 700, true, "Batch B: first pack row near the top (was ~857px before the fold fix)"), "Batch B: first pack row near the top (was ~857px before the fold fix)");
  /* Switching craft just updates the highlight and SKU — no collapse. */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
  await sleep(150);
  await chk(async () => eq(await page.$eval("#pack-sku", e => e.textContent), "TAM-18", "Batch B: switching craft updates the SKU, picker stays open"), "Batch B: switching craft updates the SKU, picker stays open");
  await chk(async () => eq(await page.$eval("#pack-picker", e => e.hidden), false, "Batch B: picker still open after switching craft"), "Batch B: picker still open after switching craft");
  await chk(async () => eq(await page.$eval("#btn-pack-print", e => e.textContent.trim()), "Print", "B2: print button is one short label"), "B2: print button is one short label");
  const barBg = await page.evaluate(() => getComputedStyle(document.querySelector("#tab-pack .action-bar")).backgroundColor);
  await chk(async () => eq(barBg, "rgb(255, 255, 255)", "B2: action bar is solid white, not see-through"), "B2: action bar is solid white, not see-through");
  const btnH = await page.$eval("#btn-pack-print", e => Math.round(e.getBoundingClientRect().height));
  await chk(async () => eq(btnH <= 52, true, "B2: action buttons fit one line (height " + btnH + "px)"), "B2: action buttons fit one line (height " + btnH + "px)");

  await tab("inventory");
  await chk(async () => eq(await page.$eval("#all-count", e => e.textContent), "62", "B3: All filter shows the live total"), "B3: All filter shows the live total");
  const expLow = Object.keys(remoteData.inventory).filter(id => { const r = remoteData.inventory[id]; return r.threshold !== null && r.threshold !== undefined && r.qty <= r.threshold; }).length;
  const expOut = Object.values(remoteData.inventory).filter(r => r.qty === 0).length;
  await chk(async () => eq(await page.$eval("#low-count", e => e.textContent), String(expLow), "B3: Low filter count matches the data"), "B3: Low filter count matches the data");
  await chk(async () => eq(await page.$eval("#out-count", e => e.textContent), String(expOut), "B3: Out filter count matches the data"), "B3: Out filter count matches the data");
  const c5 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".inv-item")];
    const zero = rows.filter(r => { const q = r.querySelector(".inv-qty"); return q && q.textContent.trim() === "0"; });
    return { zero: zero.length, badged: zero.filter(r => r.querySelector(".out-badge")).length };
  });
  await chk(async () => eq(c5.badged, c5.zero, "v2 C5: every item at 0 wears the Out badge, threshold or not (" + c5.zero + " at 0)"), "v2 C5: every item at 0 wears the Out badge, threshold or not (" + c5.zero + " at 0)");
  await chk(async () => eq(await page.$eval("#btn-delivery", e => e.textContent.trim() + "|" + e.getAttribute("aria-label")), "Receive|Receive delivery", "v3 D2: button reads Receive; full name kept for screen readers"), "v3 D2: button reads Receive; full name kept for screen readers");
  await page.click("#btn-lowfilter");
  await sleep(200);
  const visLow = await page.$$eval(".inv-item", els => els.filter(e => e.style.display !== "none").length);
  await chk(async () => eq(visLow, expLow, "B3: Low filter shows only low items"), "B3: Low filter shows only low items");
  await page.click("#btn-filter-all");
  await sleep(200);
  await chk(async () => eq(await page.$eval("#btn-print-inventory", e => e.offsetParent === null), true, "B3: print options live inside the Print menu"), "B3: print options live inside the Print menu");
  await page.click("#btn-print-menu");
  await sleep(150);
  await chk(async () => eq(await page.$eval("#print-menu", e => e.hidden), false, "B3: Print menu opens"), "B3: Print menu opens");

  const putsBefore = putCount;
  await page.click("#btn-delivery");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#delivery-entry .hint", e => getComputedStyle(e).fontSize), "16px", "v2 C2: panel hint text is 16px"), "v2 C2: panel hint text is 16px");
  await chk(async () => eq(await page.$eval("#btn-delivery", e => getComputedStyle(e).fontSize), "16px", "v2 C2: buttons are 16px"), "v2 C2: buttons are 16px");
  await page.evaluate(() => {
    document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "50";
    document.querySelector('#delivery-entry-list input[data-item="wood-board"]').value = "18";
  });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Add 2 items to stock?", "v2 A3: two-item delivery sheet"), "v2 A3: two-item delivery sheet");
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Scissors +50")), true, "v2 A3: delivery sheet lists each amount"), "v2 A3: delivery sheet lists each amount");
  await page.click("#sheet-primary");
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 245, "B4: delivery added 50 scissors (195->245)"), "B4: delivery added 50 scissors (195->245)");
  await chk(async () => eq(remoteData.inventory["wood-board"].qty, 0, "B4: delivery added 18 wood boards (-18->0)"), "B4: delivery added 18 wood boards (-18->0)");
  await chk(async () => eq(remoteData.history[0].type, "received", "B4: newest History entry is a delivery receive"), "B4: newest History entry is a delivery receive");
  await chk(async () => eq(remoteData.history[1].type, "received", "B4: second History entry is the other delivered item"), "B4: second History entry is the other delivered item");
  await chk(async () => eq(putCount, putsBefore + 1, "B4: the whole delivery saved with ONE repo write"), "B4: the whole delivery saved with ONE repo write");

  /* v2 A3: search filters the delivery form; outlier flag; Edit numbers
     saves nothing; the saved batch has one UNDO that reverses it all */
  await page.click("#btn-delivery");
  await sleep(250);
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = "scissors"; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  await chk(async () => eq(await page.$$eval("#delivery-entry-list .count-row", els => els.filter(e => e.style.display !== "none").length), 1, "v2 A3: search filters the delivery list"), "v2 A3: search filters the delivery list");
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  await chk(async () => eq(await page.$$eval("#delivery-entry-list .count-row", els => els.filter(e => e.style.display !== "none").length), 62, "v2 A3: clearing the search restores all rows"), "v2 A3: clearing the search restores all rows");
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = "SCISSORS"; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  await chk(async () => eq(await page.$$eval("#delivery-entry-list .count-row", els => els.filter(e => e.style.display !== "none").length), 1, "search is case-insensitive: 'SCISSORS' finds the one delivery row"), "search is case-insensitive: 'SCISSORS' finds the one delivery row");
  await chk(async () => eq(await page.$$eval("#inventory-groups .inv-item", els => els.filter(e => e.style.display !== "none").length), 1, "search is case-insensitive: 'SCISSORS' filters the inventory list too"), "search is case-insensitive: 'SCISSORS' filters the inventory list too");
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = "tAcKy GlUe"; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  await chk(async () => eq(await page.$$eval("#inventory-groups .inv-item", els => els.filter(e => e.style.display !== "none").length), 1, "search is case-insensitive: mixed-case 'tAcKy GlUe' matches 'Tacky Glue'"), "search is case-insensitive: mixed-case 'tAcKy GlUe' matches 'Tacky Glue'");
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(150);
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "480"; });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Scissors +480")), true, "v2 A3: delivery sheet lists the big amount"), "v2 A3: delivery sheet lists the big amount");
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("(10× usual)")), true, "v2 A3: 480 after a last delivery of 50 flags as 10× usual"), "v2 A3: 480 after a last delivery of 50 flags as 10× usual");
  const putsBeforeA3 = putCount;
  await page.click("#sheet-cancel"); /* Edit numbers */
  await sleep(200);
  await chk(async () => eq(putCount, putsBeforeA3, "v2 A3: Edit numbers saves nothing"), "v2 A3: Edit numbers saves nothing");
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 245, "v2 A3: stock untouched after Edit numbers"), "v2 A3: stock untouched after Edit numbers");
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await page.click("#sheet-primary"); /* Add to stock */
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 725, "v2 A3: confirmed delivery applied (245 + 480)"), "v2 A3: confirmed delivery applied (245 + 480)");
  await chk(async () => eq(await page.$eval("#toast", e => e.textContent.includes("UNDO")), true, "v2 A3: saved delivery offers UNDO"), "v2 A3: saved delivery offers UNDO");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 245, "v2 A3: UNDO reverses the whole delivery batch"), "v2 A3: UNDO reverses the whole delivery batch");

  /* v2 A3: count flag — a count differing from on-hand by >50% is flagged;
     the batch UNDO reverses counts too */
  await page.click("#btn-enter-counts");
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#count-entry-list input[data-item="scissors"]').value = "100"; });
  await page.click("#btn-apply-counts");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Scissors: 245 → 100") && e.textContent.includes("-59%")), true, "v2 A3: a -59% count is flagged in the sheet"), "v2 A3: a -59% count is flagged in the sheet");
  await page.click("#sheet-primary");
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 100, "v2 A3: confirmed count applied"), "v2 A3: confirmed count applied");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 245, "v2 A3: UNDO reverses the count batch too"), "v2 A3: UNDO reverses the count batch too");

  /* v3 E2: Reorder list — scissors (245 on hand, warning at 250) is on it
     with the default order qty; editing the qty changes the printed list;
     receiving above the level takes it off again (and Undo restores it) */
  await chk(async () => eq(await page.$eval("#btn-reorder", e => e.textContent + "|" + e.disabled), "Reorder · 1|false", "v3 E2: button counts the low items"), "v3 E2: button counts the low items");
  await page.click("#btn-reorder");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#reorder-panel", e => e.hidden), false, "v3 E2: panel opens"), "v3 E2: panel opens");
  await chk(async () => eq(await page.$eval('#reorder-list input[data-item="scissors"]', e => e.value), "255", "v3 E2: default order qty = 2 × level − on hand (500 − 245)"), "v3 E2: default order qty = 2 × level − on hand (500 − 245)");
  await page.evaluate(() => { document.querySelector('#reorder-list input[data-item="scissors"]').value = "300"; });
  await page.evaluate(() => { window.print = () => {}; });
  await page.click("#btn-print-reorder");
  await sleep(250);
  const reorderPrint = await page.$eval("#print-area", e => e.innerHTML);
  await chk(async () => eq(reorderPrint.includes("Reorder list ·") && reorderPrint.includes("Scissors") && reorderPrint.includes("300"), true, "v3 E2: printed list carries the edited qty"), "v3 E2: printed list carries the edited qty");
  await chk(async () => eq(reorderPrint.includes("Order qty ="), false, "desktop brief item 3: no formula text on the printed reorder list (the panel explains it on screen)"), "desktop brief item 3: no formula text on the printed reorder list (the panel explains it on screen)");
  await page.click("#btn-close-reorder");
  await sleep(150);
  await openPanel("#delivery-entry", "#btn-delivery");
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "10"; });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 255, "v3 E2 setup: delivery lands (245 + 10)"), "v3 E2 setup: delivery lands (245 + 10)");
  await chk(async () => eq(await page.$eval("#btn-reorder", e => e.textContent + "|" + e.disabled), "Reorder · 0|true", "v3 E2: back above the level — off the list, button disabled"), "v3 E2: back above the level — off the list, button disabled");
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await sleep(700);
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 245, "v3 E2: UNDO restores 245"), "v3 E2: UNDO restores 245");
  await chk(async () => eq(await page.$eval("#btn-reorder", e => e.textContent), "Reorder · 1", "v3 E2: and it is back on the list"), "v3 E2: and it is back on the list");
  await closePanel("#delivery-entry", "#btn-cancel-delivery");

  /* Reorder settings: the quantity setting beats the formula, and the
     hide-quantities print option lists names only (cleanup restores the
     old behavior so later sections are unaffected) */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(250);
  await chk(async () => eq(await page.$eval("#set-reorder-qty", e => e.value), "", "reorder settings: quantity input empty when unset"), "reorder settings: quantity input empty when unset");
  await chk(async () => eq(await page.$eval("#set-hide-reorder-qtys", e => e.checked), false, "reorder settings: hide-quantities unchecked by default"), "reorder settings: hide-quantities unchecked by default");
  await page.evaluate(() => { const i = document.querySelector("#set-reorder-qty"); i.value = "1000"; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(700);
  await chk(async () => eq(remoteData.settings.reorderQty, 1000, "reorder settings: quantity 1000 saved"), "reorder settings: quantity 1000 saved");
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(250);
  await page.click("#btn-reorder");
  await sleep(250);
  await chk(async () => eq(await page.$eval('#reorder-list input[data-item="scissors"]', e => e.value), "1000", "reorder settings: panel default is the setting, not the formula (was 255)"), "reorder settings: panel default is the setting, not the formula (was 255)");
  await page.click("#btn-close-reorder");
  await sleep(150);
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(250);
  await page.click("#set-hide-reorder-qtys");
  await sleep(700);
  await chk(async () => eq(remoteData.settings.hideReorderQtys, true, "reorder settings: hide-quantities saved"), "reorder settings: hide-quantities saved");
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(250);
  await page.click("#btn-reorder");
  await sleep(250);
  await page.click("#btn-print-reorder");
  await sleep(250);
  const reorderPrintNoQty = await page.$eval("#print-area", e => e.innerHTML);
  await chk(async () => eq(reorderPrintNoQty.includes("Reorder list ·") && reorderPrintNoQty.includes("Shared items") && reorderPrintNoQty.includes("<td>Scissors</td>"), true, "reorder settings: names-only print keeps group + item"), "reorder settings: names-only print keeps group + item");
  await chk(async () => eq(reorderPrintNoQty.includes("Order qty") || reorderPrintNoQty.includes("On hand") || reorderPrintNoQty.includes("Warning level") || reorderPrintNoQty.includes('class="qty"'), false, "reorder settings: names-only print has no quantity columns"), "reorder settings: names-only print has no quantity columns");
  await page.click("#btn-close-reorder");
  await sleep(150);
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(250);
  await page.click("#set-hide-reorder-qtys");
  await page.evaluate(() => { const i = document.querySelector("#set-reorder-qty"); i.value = ""; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(700);
  await chk(async () => eq(remoteData.settings.hideReorderQtys, false, "reorder settings cleanup: hide off again"), "reorder settings cleanup: hide off again");
  await chk(async () => eq(remoteData.settings.reorderQty, null, "reorder settings cleanup: quantity cleared"), "reorder settings cleanup: quantity cleared");
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(250);
  await page.click("#btn-reorder");
  await sleep(250);
  await chk(async () => eq(await page.$eval('#reorder-list input[data-item="scissors"]', e => e.value), "255", "reorder settings cleanup: formula default restored"), "reorder settings cleanup: formula default restored");
  await page.click("#btn-close-reorder");
  await sleep(150);

  /* Install support: manifest + icons make the site installable in
     Chrome on Android (read-only checks; no state touched) */
  await chk(async () => eq(await page.$eval('link[rel="manifest"]', e => e.getAttribute("href")), "manifest.json", "install: manifest linked"), "install: manifest linked");
  await chk(async () => eq(await page.$eval('meta[name="theme-color"]', e => e.getAttribute("content")), "#2457A6", "install: theme color set"), "install: theme color set");
  await chk(async () => eq(await page.$eval('link[rel="apple-touch-icon"]', e => e.getAttribute("href")), "icon-192.png", "install: apple touch icon linked"), "install: apple touch icon linked");
  /* Every read below lives inside chk: a missing manifest or icon must
     record failures, never crash the suite (the first control run died
     on the bare fetch of a 404 manifest). */
  let manifest = null;
  await chk(async () => { manifest = await page.evaluate(() => fetch("manifest.json").then(r => r.json())); }, "install: manifest parses as JSON");
  await chk(async () => eq(manifest && manifest.name, "Alooma", "install: manifest name"), "install: manifest name");
  await chk(async () => eq(manifest && manifest.short_name, "Alooma", "install: manifest short_name"), "install: manifest short_name");
  await chk(async () => eq(manifest && manifest.display, "standalone", "install: manifest display standalone"), "install: manifest display standalone");
  await chk(async () => eq(!!(manifest && manifest.start_url) && !!(manifest && manifest.scope), true, "install: manifest start_url + scope present"), "install: manifest start_url + scope present");
  await chk(async () => { const sizes = (manifest && manifest.icons || []).map(i => i.sizes); eq(sizes.includes("192x192") && sizes.includes("512x512"), true, "install: manifest lists 192 + 512 icons"); }, "install: manifest lists 192 + 512 icons");
  const pngSize = (buf) => (buf[0] === 0x89 && buf[1] === 0x50) ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
  await chk(async () => { const s = pngSize(fs.readFileSync(path.join(ROOT, "icon-192.png"))); eq(s && s.w === 192 && s.h === 192, true, "install: icon-192.png is a 192x192 PNG"); }, "install: icon-192.png is a 192x192 PNG");
  await chk(async () => { const s = pngSize(fs.readFileSync(path.join(ROOT, "icon-512.png"))); eq(s && s.w === 512 && s.h === 512, true, "install: icon-512.png is a 512x512 PNG"); }, "install: icon-512.png is a 512x512 PNG");

  /* ---------- Batch C: default boxes + bin locations ---------- */
  const waitRemote = async (fn, label) => { for (let i = 0; i < 40; i++) { if (fn()) return; await sleep(150); } throw new Error("timeout waiting: " + label); };
  const waitDom = async (fn, label) => { for (let i = 0; i < 40; i++) { if (await page.evaluate(fn)) return; await sleep(150); } throw new Error("timeout waiting: " + label); };
  // Both features OFF (the default): screens look exactly like before Batch C
  await page.evaluate(() => { const s = document.querySelector("#inv-search"); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#btn-filter-all").click(); });
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#pack-boxes").hidden), true, "C off: boxes line hidden by default"), "C off: boxes line hidden by default");
  await chk(async () => eq((await page.evaluate(() => document.querySelectorAll("#pack-table .row-bin").length)) === 0, true, "C off: no bin labels on pack rows"), "C off: no bin labels on pack rows");
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#btn-pack-sort").hidden), true, "C off: Sort by bin button hidden"), "C off: Sort by bin button hidden");
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#btn-binfilter").hidden), true, "C off: By bin chip hidden"), "C off: By bin chip hidden");
  await chk(async () => eq((await page.evaluate(() => document.querySelectorAll("#inventory-groups .inv-bin").length)) === 0, true, "C off: no bin labels on inventory rows"), "C off: no bin labels on inventory rows");

  // Boxes ON in Settings + a rule: The Cakery, 12 kits = Box A + Box B
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await page.click("#set-boxes-on");
  await waitRemote(() => remoteData.settings && remoteData.settings.features.boxes === true, "boxes toggle saved");
  await waitDom(() => !document.querySelector("#boxes-editor").hidden, "boxes editor opens");
  await chk(async () => eq(remoteData.settings.features.boxes === true, true, "C1: boxes toggle saved to the shared data"), "C1: boxes toggle saved to the shared data");
  await chk(async () => eq(await page.evaluate(() => !document.querySelector("#boxes-editor").hidden), true, "C1: boxes editor opens with the toggle"), "C1: boxes editor opens with the toggle");
  await page.select("#rule-craft", "cak");
  await page.type("#rule-kits", "12");
  await page.select("#rule-boxes", "Box A");
  await page.select("#rule-boxes", "Box B");
  await page.click("#btn-rule-add");
  await waitRemote(() => (remoteData.settings.boxRules || []).length === 1, "box rule saved");
  await chk(async () => eq(remoteData.settings.boxRules[0].boxes.join(",") === "Box A,Box B", true, "C1: rule saved (CAK 12 = Box A + Box B, picked from the box menu)"), "C1: rule saved (CAK 12 = Box A + Box B, picked from the box menu)");
  /* The kits field validates: 7 is not a multiple of 6, so no rule is added.
     Flake, 3rd failure (run 40223090357): the earlier poll fix (runs
     40016302717 + 40210169050) was incomplete — polling 6s for the error
     still timed out, so the error genuinely never appeared. The real race:
     waitRemote returns when the MOCK records the PUT, but the page-side
     saveData .then (toast + renderAll, which rebuilds the rules list and
     shifts the Add button down a row) may still be pending — the "7"
     click can then land at stale coordinates and never reach the
     handler. Sequence on the RENDER, not just the remote save, and
     center the button before clicking, so no layout shift can steal it. */
  await waitDom(() => { const l = document.querySelector("#box-rules-list"); return l && l.textContent.includes("12 kits"); }, "rule row rendered");
  await page.evaluate(() => { document.querySelector("#rule-kits").value = ""; });
  await page.type("#rule-kits", "7");
  await page.evaluate(() => { document.querySelector("#btn-rule-add").scrollIntoView({ block: "center" }); });
  await page.click("#btn-rule-add");
  await waitDom(() => { const e = document.querySelector("#rule-error"); return e && e.textContent.includes("multiple of 6"); }, "multiple-of-6 error appears");
  await chk(async () => eq((remoteData.settings.boxRules || []).length, 1, "Boxes: kit counts that aren't multiples of 6 are rejected"), "Boxes: kit counts that aren't multiples of 6 are rejected");
  await chk(async () => eq(await page.$eval("#rule-error", e => e.textContent.includes("multiple of 6")), true, "Boxes: the kits field explains the multiple-of-6 rule"), "Boxes: the kits field explains the multiple-of-6 rule");
  await page.evaluate(() => { document.querySelector("#rule-kits").value = ""; });

  // Packing: an exact match shows the boxes; 18 kits (no rule) does not
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await page.click("#btn-pack-hand");
  await waitDom(() => !document.querySelector("#pack-boxes").hidden, "boxes line shows");
  await chk(async () => eq(await page.$eval("#pack-boxes-text", e => e.textContent), "Box A + Box B", "C1: boxes line shows the rule's boxes"), "C1: boxes line shows the rule's boxes");
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await sleep(200);
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#pack-boxes").hidden), true, "C1: no boxes line for 18 kits (no exact rule)"), "C1: no boxes line for 18 kits (no exact rule)");
  // Change override for this order only: back to 12, add Box C
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await page.click("#btn-pack-hand");
  await waitDom(() => !document.querySelector("#pack-boxes").hidden, "boxes line shows again");
  await page.click("#btn-boxes-change");
  await page.evaluate(() => [...document.querySelectorAll("#pack-boxes-chips .kits-chip")].find(x => x.textContent === "Box C").click());
  /* Polish item 2 fallout: page.click's minimal scroll parks an already-visible
     button under the fixed bottom band (scroll-margin/scroll-padding are inert
     when no scroll happens). Center it first, as a real user would scroll it
     fully into view before tapping. */
  await page.evaluate(() => document.querySelector("#btn-boxes-done").scrollIntoView({block: "center"}));
  await page.click("#btn-boxes-done");
  await chk(async () => eq((await page.$eval("#pack-boxes-text", e => e.textContent)).includes("Box C"), true, "C1: Change override adds Box C for this order"), "C1: Change override adds Box C for this order");
  await page.click("#btn-pack-print");
  await sleep(250);
  await chk(async () => eq((await page.evaluate(() => document.querySelector("#print-area").textContent)).includes("BOXES: Box A, Box B, Box C"), true, "C1+C3: packing sheet prints BOXES: Box A, Box B, Box C"), "C1+C3: packing sheet prints BOXES: Box A, Box B, Box C");
  /* A4: that print completed CAK-12 — undo it so the checklist Complete
     below deducts exactly once. The print also cleared the pick AND the
     Box C override, so re-pick CAK-12 and re-apply Box C first — the
     confirm sheet below must still name Box C. */
  await page.evaluate(() => [...document.querySelectorAll("#toast button")].find(b => b.textContent === "UNDO").click());
  await waitRemote(() => remoteData.inventory.scissors.qty === 245, "print UNDO restores scissors");
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await sleep(200);
  await page.click("#btn-pack-hand");
  await sleep(200);
  await waitDom(() => !document.querySelector("#pack-boxes").hidden, "boxes line shows after re-pick");
  await page.click("#btn-boxes-change");
  await page.evaluate(() => [...document.querySelectorAll("#pack-boxes-chips .kits-chip")].find(x => x.textContent === "Box C").click());
  await page.evaluate(() => document.querySelector("#btn-boxes-done").scrollIntoView({block: "center"}));
  await page.click("#btn-boxes-done");
  await sleep(200);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* v2 A5: confirm check-all */
  await sleep(150);
  await page.click("#btn-complete-pack");
  await waitDom(() => !document.querySelector("#sheet-backdrop").hidden, "confirm sheet opens");
  await chk(async () => eq((await page.$eval("#sheet-summary", e => e.textContent)).includes("Box C"), true, "C1: confirm sheet names the boxes"), "C1: confirm sheet names the boxes");
  await page.click("#sheet-primary");
  await waitRemote(() => remoteData.inventory.scissors.qty === 241, "CAK-12 pack saved");
  await chk(async () => eq(remoteData.inventory.scissors.qty === 241, true, "C1: completing CAK-12 still deducts exactly (scissors 245 -> 241)"), "C1: completing CAK-12 still deducts exactly (scissors 245 -> 241)");

  // Bins ON: placeholders, a custom bin via the item panel, and the sort
  await tab("settings");
  await page.click("#set-bins-on");
  await waitRemote(() => remoteData.settings && remoteData.settings.features.bins === true, "bins toggle saved");
  await waitDom(() => !document.querySelector("#btn-binfilter").hidden, "By bin chip shows");
  await chk(async () => eq(remoteData.settings.features.bins === true, true, "C2: bins toggle saved to the shared data"), "C2: bins toggle saved to the shared data");
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await chk(async () => eq(await page.evaluate(() => !document.querySelector("#btn-binfilter").hidden), true, "C2: By bin chip appears with the feature"), "C2: By bin chip appears with the feature");
  await waitDom(() => document.querySelectorAll("#inventory-groups .inv-bin").length >= 60, "placeholder bins render");
  await chk(async () => eq((await page.evaluate(() => document.querySelectorAll("#inventory-groups .inv-bin").length)) >= 60, true, "C2: inventory rows show placeholder bins"), "C2: inventory rows show placeholder bins");
  await page.evaluate(() => { const m = document.querySelector('.inv-item[data-item="scissors"] .inv-main'); if (m.getAttribute("aria-expanded") !== "true") m.click(); });
  await sleep(300);
  await chk(async () => eq(await page.evaluate(() => [...document.querySelectorAll(".inv-panel .seg button")].map(b => b.textContent).includes("Bin")), true, "C2: item panel gains a Bin mode"), "C2: item panel gains a Bin mode");
  await page.evaluate(() => [...document.querySelectorAll(".inv-panel .seg button")].find(b => b.textContent === "Bin").click());
  await sleep(250);
  await page.type(".inv-panel-input", "BIN-99");
  await page.click(".inv-panel-go");
  await waitRemote(() => remoteData.settings.bins && remoteData.settings.bins.scissors === "BIN-99", "custom bin saved");
  await chk(async () => eq(remoteData.settings.bins.scissors === "BIN-99", true, "C2: custom bin saved to the shared data"), "C2: custom bin saved to the shared data");
  /* A3: the bin panel stays open after its save with an input that no
     longer matches its prefill, so leaving Inventory prompts — Discard
     closes the panel (the bin itself is already saved) and switches.
     The boxes section's CAK-12 pick was discarded at the Settings switch
     too, so pick Cakery here before the kits. */
  await tab("pack");
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await sleep(150);
  await page.click('.kits-chip[data-for="pack"][data-kits="18"]');
  await page.click("#btn-pack-hand");
  await sleep(300);
  await chk(async () => eq((await page.evaluate(() => document.querySelector("#pack-table").textContent)).includes("BIN-99"), true, "C2: pack list shows the custom bin for Scissors"), "C2: pack list shows the custom bin for Scissors");
  await chk(async () => eq(await page.evaluate(() => !document.querySelector("#btn-pack-sort").hidden), true, "C2: Sort by bin button appears with the feature"), "C2: Sort by bin button appears with the feature");
  await page.click("#btn-pack-sort");
  await sleep(200);
  const binOrder = await page.evaluate(() => [...document.querySelectorAll("#pack-table tbody tr .row-bin")].map(e => e.textContent));
  await chk(async () => eq(binOrder.length === 19 && binOrder.every((b, i) => i === 0 || binOrder[i - 1] <= b) && binOrder[18] === "BIN-99", true, "C2: pack list sorts by bin (BIN-99 last)"), "C2: pack list sorts by bin (BIN-99 last)");

  /* Boxes are a free-form list: add a fourth box by name and it joins the
     rule dropdown; delete it and it leaves the list */
  await tab("settings");
  await page.type("#new-box-name", "Mailer box");
  await page.click("#btn-box-add");
  await waitRemote(() => (remoteData.settings.boxes || []).includes("Mailer box"), "box added");
  await chk(async () => eq(remoteData.settings.boxes.includes("Mailer box"), true, "Boxes: typed box name saved to the shared list"), "Boxes: typed box name saved to the shared list");
  /* The page re-renders after the save resolves — poll the DOM for it
     instead of asserting in the same tick the mock PUT lands (race) */
  let boxRendered = true;
  try { await waitDom(() => [...document.querySelectorAll("#rule-boxes option")].map(o => o.value).includes("Mailer box") && document.querySelector("#box-list").textContent.includes("Mailer box"), "box rendered in dropdown + list"); } catch (e) { boxRendered = false; }
  await chk(async () => eq(boxRendered, true, "Boxes: new box appears in the rule dropdown and the box list"), "Boxes: new box appears in the rule dropdown and the box list");
  /* A rule can carry ANY number of boxes: build a 3-box rule for TAM-24 */
  await page.select("#rule-craft", "tam");
  await page.type("#rule-kits", "24");
  await page.select("#rule-boxes", "Box A");
  await page.select("#rule-boxes", "Box B");
  await page.select("#rule-boxes", "Mailer box");
  /* Center the button before the real click: an uncentered click raced the
     save toast twice (the toast sits fixed at the bottom of the screen) */
  await page.evaluate(() => document.querySelector("#btn-rule-add").scrollIntoView({ block: "center" }));
  await sleep(200);
  await page.click("#btn-rule-add");
  await waitRemote(() => (remoteData.settings.boxRules || []).length === 2, "3-box rule saved");
  await chk(async () => eq(remoteData.settings.boxRules[1].boxes.join(","), "Box A,Box B,Mailer box", "Boxes: a rule holds three boxes (any number works)"), "Boxes: a rule holds three boxes (any number works)");
  await page.evaluate(() => [...document.querySelectorAll("#box-list .box-rule-row")].find(r => r.textContent.includes("Mailer box")).querySelector("button").click());
  await waitRemote(() => !(remoteData.settings.boxes || []).includes("Mailer box"), "box removed");
  await chk(async () => eq(remoteData.settings.boxes.includes("Mailer box"), false, "Boxes: deleted box leaves the shared list"), "Boxes: deleted box leaves the shared list");
  await chk(async () => eq(remoteData.settings.boxRules[1].boxes.join(","), "Box A,Box B", "Boxes: deleting a box strips it from rules that used it"), "Boxes: deleting a box strips it from rules that used it");

  // Both features back OFF: today's screens again
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await page.click("#set-bins-on");
  await page.click("#set-boxes-on");
  await waitRemote(() => remoteData.settings.features.bins === false && remoteData.settings.features.boxes === false, "both features off saved");
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#pack-boxes").hidden), true, "C off again: boxes line hidden"), "C off again: boxes line hidden");
  await chk(async () => eq((await page.evaluate(() => document.querySelectorAll("#pack-table .row-bin").length)) === 0, true, "C off again: no bin labels on pack rows"), "C off again: no bin labels on pack rows");

  /* v2 A2: a FULL order keeps the plain sheet; a 1-short order gets the red block.
     Seed HCB's seven items to 100 in the mock repo and reload (editor persists). */
  ["wood-board", "tray-set", "miniatures-bread-bag", "wood-burning-cream", "hc-placemat", "hc-instructions", "heat-gun"].forEach(id => { remoteData.inventory[id].qty = 100; });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(400);
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="6"]');
  await sleep(200);
  await page.click("#btn-pack-hand");
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* v2 A5: confirm the check-all */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.hidden), true, "v2 A2: full order — no short block"), "v2 A2: full order — no short block");
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.textContent), "Subtract from inventory", "v2 A2: full order keeps the plain primary"), "v2 A2: full order keeps the plain primary");
  await chk(async () => eq(await page.$eval("#sheet-cancel", e => e.textContent + "|" + e.classList.contains("btn-primary")), "Cancel|false", "v2 A2: full order keeps the plain cancel"), "v2 A2: full order keeps the plain cancel");
  await page.click("#sheet-primary");
  await waitRemote(() => remoteData.inventory["wood-board"].qty === 94, "HCB-6 packed from full stock");
  /* Zero the heat gun (99 on hand after the pack) through the count sheet */
  await tab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(200);
  await page.evaluate(() => { document.querySelector('#count-entry-list input[data-item="heat-gun"]').value = "0"; });
  await page.click("#btn-apply-counts");
  await sleep(250);
  await page.click("#sheet-primary"); /* v2 A3: confirm the count */
  await waitRemote(() => remoteData.inventory["heat-gun"].qty === 0, "heat gun counted to 0");
  /* Same order again: now exactly one item is short.
     A3: the inventory detour discarded the pick, so re-pick HCB-6. */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="6"]');
  await sleep(200);
  await page.click("#btn-pack-hand");
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary");
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-extra", e => !e.hidden && e.textContent.includes("1 item short")), true, "v2 A2: one-short order shows the block"), "v2 A2: one-short order shows the block");
  await chk(async () => eq(await page.$eval("#sheet-extra", e => e.textContent.includes("Heat gun: have 0, need 1, short 1")), true, "v3 E1: sheet line gives have / need / short"), "v3 E1: sheet line gives have / need / short");
  await chk(async () => eq(await page.$eval("#sheet-primary", e => e.textContent), "Subtract anyway (1 short)", "v2 A2: primary label for one short"), "v2 A2: primary label for one short");
  const histBeforeA2 = remoteData.history.length;
  await page.click("#sheet-cancel"); /* Go back */
  await sleep(300);
  await chk(async () => eq(remoteData.history.length, histBeforeA2, "v2 A2: Go back subtracts nothing"), "v2 A2: Go back subtracts nothing");
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary"); /* Subtract anyway */
  await waitRemote(() => remoteData.inventory["heat-gun"].qty === -1, "short pack applied anyway");

  /* v3 E3: backup reminder — Settings shows the last backup taken on this
     device, and a gentle nudge once it is over a week old */
  await tab("settings");
  await chk(async () => eq(await page.$eval("#last-backup", e => e.textContent.includes("never")), true, "v3 E3: no backup yet on this device"), "v3 E3: no backup yet on this device");
  await page.click("#btn-export");
  await sleep(300);
  await chk(async () => eq(await page.$eval("#last-backup", e => e.textContent.includes("never")), false, "v3 E3: exporting stamps the last-backup line"), "v3 E3: exporting stamps the last-backup line");
  await chk(async () => eq(await page.$eval("#backup-stale", e => e.hidden), true, "v3 E3: a fresh backup shows no nudge"), "v3 E3: a fresh backup shows no nudge");
  await page.evaluate(() => {
    localStorage.setItem("alooma.lastBackup.v1", new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString());
    document.querySelector('[data-tab="inventory"]').click();
    document.querySelector('[data-tab="settings"]').click();
  });
  await sleep(250);
  await chk(async () => eq(await page.$eval("#backup-stale", e => e.hidden), false, "v3 E3: over a week old shows the nudge"), "v3 E3: over a week old shows the nudge");

  /* Fix-round item 14: backup includes the saved queue + names; import
     accepts the new wrapper AND old bare-data files, warns before
     replacing differing/absent recipes, and rejects malformed recipes. */
  await page.evaluate(() => {
    localStorage.setItem("alooma.packqueue.v1", JSON.stringify([{ craftId: "bm", kits: 6 }]));
    localStorage.setItem("alooma.packedby.v1", "Sara");
    localStorage.setItem("alooma.countedby.v1", "Dina");
  });
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(400);
  await chk(async () => eq(await page.evaluate(() => document.querySelector("#pack-queue-count").textContent), "1", "item14: seeded queue restored on load"), "item14: seeded queue restored on load");
  await tab("settings");
  await page.evaluate(() => { window.__blobs = []; const orig = URL.createObjectURL; URL.createObjectURL = b => { window.__blobs.push(b); return orig.call(URL, b); }; });
  await page.click("#btn-export");
  await sleep(300);
  const exported = JSON.parse(await page.evaluate(async () => window.__blobs[0].text()));
  await chk(async () => eq(exported.packQueue, [{ craftId: "bm", kits: 6 }], "item14: export includes the saved queue"), "item14: export includes the saved queue");
  await chk(async () => eq(exported.names, { packedBy: "Sara", countedBy: "Dina" }, "item14: export includes the device names"), "item14: export includes the device names");
  await chk(async () => eq(exported.data && typeof exported.data.inventory === "object" && Array.isArray(exported.data.history), true, "item14: export still carries inventory + history"), "item14: export still carries inventory + history");
  const feedFile = async json => {
    await page.evaluate(async j => {
      const dt = new DataTransfer();
      dt.items.add(new File([j], "backup.json", { type: "application/json" }));
      const inp = document.querySelector("#import-file");
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, json);
    await sleep(500);
  };
  const sheetSummary = () => page.$eval("#sheet-summary", e => e.textContent);
  /* Wrapper import with DIFFERENT recipes: warns, then replaces
     recipes, queue, and names on confirm. */
  const wrapData = JSON.parse(JSON.stringify(remoteData));
  wrapData.settings = wrapData.settings || {};
  wrapData.settings.recipes = [{ id: "bm", code: "BM", name: "Blooming Mirrors", lines: [{ item: "scissors", qty: 1, per: 6 }] }];
  await feedFile(JSON.stringify({ app: "alooma", version: 1, data: wrapData, packQueue: [{ craftId: "tam", kits: 12 }], names: { packedBy: "Ruth", countedBy: "Noa" } }));
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Replace all data with this backup?", "item14: wrapper import asks first"), "item14: wrapper import asks first");
  await chk(async () => eq((await sheetSummary()).includes("differ"), true, "item14: wrapper import warns that recipes differ"), "item14: wrapper import warns that recipes differ");
  await page.click("#sheet-primary");
  await sleep(500);
  await chk(async () => eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]")), [{ craftId: "tam", kits: 12 }], "item14: wrapper import restores the queue"), "item14: wrapper import restores the queue");
  await chk(async () => eq(await page.evaluate(() => localStorage.getItem("alooma.packedby.v1")), "Ruth", "item14: wrapper import restores Packed by"), "item14: wrapper import restores Packed by");
  await chk(async () => eq(await page.evaluate(() => localStorage.getItem("alooma.countedby.v1")), "Noa", "item14: wrapper import restores Counted by"), "item14: wrapper import restores Counted by");
  await chk(async () => eq(remoteData.history[0].title, "Imported a backup file", "item14: wrapper import logged in History"), "item14: wrapper import logged in History");
  await chk(async () => eq(remoteData.settings.recipes.find(r => r.id === "bm").lines.length, 1, "item14: wrapper import replaced recipes (BM down to 1 line)"), "item14: wrapper import replaced recipes (BM down to 1 line)");
  /* Fix-round item 14, Path A: a BM-only backup must NOT delete the
     other built-ins from the catalog — TAM stays packable. */
  await tab("pack");
  await chk(async () => eq(await page.evaluate(() => { const t = [...document.querySelectorAll("#pack-crafts .craft-btn .craft-text")].map(e => e.textContent).join(" | "); return ["Blooming Mirrors", "Tambourines", "Judaic Clay-Art", "Hafrashat Challah", "The Cakery", "Miniature Interiors"].every(n => t.includes(n)); }), true, "item14: BM-only import keeps all six built-in crafts packable"), "item14: BM-only import keeps all six built-in crafts packable");
  await page.evaluate(() => { const b = [...document.querySelectorAll("#pack-crafts .craft-btn")].find(e => e.textContent.includes("Tambourines")); if (b) b.click(); });
  await sleep(200);
  await chk(async () => eq(await page.$eval("#pack-crafts .craft-btn.selected .craft-text", e => e.textContent.includes("Tambourines")), true, "item14: TAM button selects after BM-only import"), "item14: TAM button selects after BM-only import");
  /* Reload: the queue line and the TAM craft both survive. */
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(400);
  await chk(async () => eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]")), [{ craftId: "tam", kits: 12 }], "item14: queue keeps TAM-12 across reload after import"), "item14: queue keeps TAM-12 across reload after import");
  await tab("pack");
  await chk(async () => eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn .craft-text")].some(e => e.textContent.includes("Tambourines"))), true, "item14: TAM still packable after reload"), "item14: TAM still packable after reload");
  await tab("settings");
  /* Old bare-data file (no recipes key): warns about the reset, then
     restores built-ins WITHOUT touching queue or names. */
  const oldData = { inventory: JSON.parse(JSON.stringify(remoteData.inventory)), history: JSON.parse(JSON.stringify(remoteData.history)), settings: { features: { boxes: false, bins: false } } };
  await feedFile(JSON.stringify(oldData));
  await chk(async () => eq((await sheetSummary()).includes("no saved recipes"), true, "item14: old-file import warns recipes will reset to built-ins"), "item14: old-file import warns recipes will reset to built-ins");
  await page.click("#sheet-primary");
  await sleep(500);
  await chk(async () => eq(remoteData.settings.recipes.find(r => r.id === "bm").lines.length, 12, "item14: old-file import restored built-in BM (12 lines)"), "item14: old-file import restored built-in BM (12 lines)");
  await chk(async () => eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]")), [{ craftId: "tam", kits: 12 }], "item14: old-file import leaves the queue alone"), "item14: old-file import leaves the queue alone");
  await chk(async () => eq(await page.evaluate(() => localStorage.getItem("alooma.packedby.v1")), "Ruth", "item14: old-file import leaves names alone"), "item14: old-file import leaves names alone");
  /* Existing full backup: re-importing the export captured above
     round-trips exactly — same crafts, same queue, same names, and no
     differ warning for an equivalent file. */
  await feedFile(JSON.stringify(exported));
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Replace all data with this backup?", "item14: full-backup import asks first"), "item14: full-backup import asks first");
  await chk(async () => eq((await sheetSummary()).includes("differ"), false, "item14: full-backup import does not warn when recipes match"), "item14: full-backup import does not warn when recipes match");
  await page.click("#sheet-primary");
  await sleep(500);
  await chk(async () => eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]")), [{ craftId: "bm", kits: 6 }], "item14: full-backup import restores its queue"), "item14: full-backup import restores its queue");
  await chk(async () => eq(await page.evaluate(() => localStorage.getItem("alooma.packedby.v1")), "Sara", "item14: full-backup import restores its names"), "item14: full-backup import restores its names");
  await chk(async () => eq(remoteData.settings.recipes.find(r => r.id === "bm").lines.length, 12, "item14: full-backup import keeps full BM"), "item14: full-backup import keeps full BM");
  /* Malformed recipes: rejected outright, nothing changed, no sheet. */
  const histLenBeforeBad = remoteData.history.length;
  const badData = JSON.parse(JSON.stringify(remoteData));
  badData.settings.recipes = "not-an-array";
  await feedFile(JSON.stringify(badData));
  await chk(async () => eq(await page.$eval("#error-banner", e => !e.hidden && e.textContent.includes("malformed")), true, "item14: malformed recipes rejected with an error"), "item14: malformed recipes rejected with an error");
  await chk(async () => eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "item14: malformed recipes open no sheet"), "item14: malformed recipes open no sheet");
  await chk(async () => eq(remoteData.history.length, histLenBeforeBad, "item14: malformed recipes changed nothing"), "item14: malformed recipes changed nothing");
  /* Degenerate backup (empty inventory + null recipes, nothing usable):
     toasts and changes nothing — never wipes real data. */
  const qBeforeEmpty = await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]"));
  const histLenBeforeEmpty = remoteData.history.length;
  const putsBeforeEmpty = putCount;
  await feedFile(JSON.stringify({ app: "alooma", version: 1, data: { inventory: {}, history: [], settings: { features: { boxes: false, bins: true }, boxes: [], boxRules: [], bins: {}, recipes: null, customItems: [] } }, packQueue: [{ craftId: "bm", kits: 6 }], names: { packedBy: "Gate", countedBy: "Gate" } }));
  await chk(async () => eq(await page.$eval("#toast", e => e.textContent.includes("Nothing to import, backup is empty")), true, "degenerate: empty backup toasts"), "degenerate: empty backup toasts");
  await chk(async () => eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "degenerate: empty backup opens no sheet"), "degenerate: empty backup opens no sheet");
  await chk(async () => eq(remoteData.history.length, histLenBeforeEmpty, "degenerate: empty backup changed nothing"), "degenerate: empty backup changed nothing");
  await chk(async () => eq(putCount, putsBeforeEmpty, "degenerate: empty backup saved nothing"), "degenerate: empty backup saved nothing");
  await chk(async () => eq(await page.evaluate(() => JSON.parse(localStorage.getItem("alooma.packqueue.v1") || "[]")), qBeforeEmpty, "degenerate: queue unchanged"), "degenerate: queue unchanged");

  /* Round 2 item 1: an OLD backup (pre-rename names frozen in history)
     imports fine and its history shows the NEW names; stock counts stay
     attached to the same item IDs, and the queue/names are untouched
     (bare file). */
  const oldHistData = {
    inventory: JSON.parse(JSON.stringify(remoteData.inventory)),
    history: [
      { id: "old-mi-pack", ts: "2026-10-20T12:00:00.000Z", type: "packed", craftId: "mi", kits: 6, title: "Packed MI-6",
        recipe: [
          { item: "tools-supplies-tray-2", name: "Tools & supplies tray #2", qty: 1, per6: 1, per: 6 },
          { item: "scrapbook-paper-pack", name: "Scrapbook paper pack", qty: 1, per6: 1, per: 6 },
          { item: "english-ay-printout", name: "AY - Special Request", qty: 6, per6: 6, per: 6 }
        ],
        effects: [
          { item: "english-ay-printout", delta: -6 },
          { item: "tools-supplies-tray-2", delta: -1 },
          { item: "scrapbook-paper-pack", delta: -1 }
        ] },
      { id: "old-count-fix", ts: "2026-10-20T13:00:00.000Z", type: "count-fix", title: "Count fix Scrapbook paper pack: 3 \u2192 7",
        effects: [{ item: "scrapbook-paper-pack", delta: 4 }] }
    ],
    settings: { features: { boxes: false, bins: false } }
  };
  oldHistData.inventory["tools-supplies-tray-2"] = { qty: 7, threshold: null };
  oldHistData.inventory["scrapbook-paper-pack"] = { qty: 3, threshold: null };
  oldHistData.inventory["english-ay-printout"] = { qty: 12, threshold: null };
  await feedFile(JSON.stringify(oldHistData));
  await chk(async () => eq((await sheetSummary()).includes("no saved recipes"), true, "rename-migration: old-file import warns recipes will reset"), "rename-migration: old-file import warns recipes will reset");
  await page.click("#sheet-primary");
  await sleep(500);
  await chk(async () => eq(remoteData.history.find(e => e.id === "old-mi-pack").recipe.find(l => l.item === "tools-supplies-tray-2").name, "Supplies tray #2", "rename-migration: Tools tray history renamed"), "rename-migration: Tools tray history renamed");
  await chk(async () => eq(remoteData.history.find(e => e.id === "old-mi-pack").recipe.find(l => l.item === "scrapbook-paper-pack").name, "Scrapbook pack", "rename-migration: Scrapbook history renamed"), "rename-migration: Scrapbook history renamed");
  await chk(async () => eq(remoteData.history.find(e => e.id === "old-mi-pack").recipe.find(l => l.item === "english-ay-printout").name, "AY - by request", "rename-migration: AY history renamed"), "rename-migration: AY history renamed");
  await chk(async () => eq(remoteData.history.find(e => e.id === "old-count-fix").title, "Count fix Scrapbook pack: 3 \u2192 7", "rename-migration: count-fix title renamed"), "rename-migration: count-fix title renamed");
  await chk(async () => eq(remoteData.inventory["tools-supplies-tray-2"].qty, 7, "rename-migration: Tools tray count attached"), "rename-migration: Tools tray count attached");
  await chk(async () => eq(remoteData.inventory["scrapbook-paper-pack"].qty, 3, "rename-migration: Scrapbook count attached"), "rename-migration: Scrapbook count attached");
  await chk(async () => eq(remoteData.inventory["english-ay-printout"].qty, 12, "rename-migration: AY count attached"), "rename-migration: AY count attached");
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  await chk(async () => eq(await page.$eval("#history-list", e => e.textContent.includes("AY - by request")), true, "rename-migration: history tab shows the new AY name"), "rename-migration: history tab shows the new AY name");
  await chk(async () => eq(await page.$eval("#history-list", e => e.textContent.includes("AY - Special Request")), false, "rename-migration: history tab shows no old AY name"), "rename-migration: history tab shows no old AY name");


  /* Disconnect: back to view-only, token gone from this device */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(150);
  await page.click("#btn-disconnect");
  await sleep(250);
  await chk(async () => eq(await page.$eval("#sheet-title", e => e.textContent), "Disconnect this device?", "v2 A6: disconnect uses the in-app sheet, not a pop-up"), "v2 A6: disconnect uses the in-app sheet, not a pop-up");
  await page.click("#sheet-primary");
  await sleep(600);
  await chk(async () => eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "disconnect returns to view-only"), "disconnect returns to view-only");
  await chk(async () => eq(await page.$eval('[data-tab="pack"]', e => e.hidden), true, "View-only: Packing tab hidden again after disconnect"), "View-only: Packing tab hidden again after disconnect");
  await chk(async () => eq(await page.$eval("#tab-inventory", e => e.classList.contains("active")), true, "View-only: disconnect lands on Inventory"), "View-only: disconnect lands on Inventory");
  await chk(async () => eq(await page.evaluate(() => localStorage.getItem("alooma.editor.v1")), null, "token removed from device on disconnect"), "token removed from device on disconnect");

  /* Export produces the current data */
  await chk(async () => eq(remoteData.inventory["scissors"].qty, 241, "final remote scissors = 241 (receive 200, count 190, edit 195, delivery +50, CAK-12 pack -4)"), "final remote scissors = 241 (receive 200, count 190, edit 195, delivery +50, CAK-12 pack -4)");

  console.log(pass + " passed, " + fail + " failed; mock-repo PUTs: " + putCount);
  if (failList.length) console.log("FAILURES:\n - " + failList.join("\n - "));
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
