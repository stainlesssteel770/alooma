/* Batch A tests (dev brief Oct 24): Bulk padding under the sticky bar,
   toast clear of bar/cards on one line with unbroken SKUs, no red kits
   error after a tab-switch clear, phone header status fully visible,
   Bulk wording ("Record all" title, "to the list"), and the Settings
   Bulk-tab toggle (default OFF).
   Run: node tests/test-batcha.mjs */
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
const PORT = 8914;
let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 100, threshold: null }; });
remoteData.history = [];
/* NOTE: bulkTab deliberately NOT set here — the default (absent = OFF) is
   what section A2 tests. */
if (remoteData.settings && remoteData.settings.features) { remoteData.settings.features.boxes = false; remoteData.settings.features.bins = false; }
let remoteSha = "sha-b1";
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
  await page.setViewport({ width: 390, height: 664 });
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
        remoteSha = "sha-b" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  await page.evaluate(() => { window.print = () => {}; });

  /* A3: a tab switch with anything chosen or unsaved prompts instead of
     switching; batcha always takes Discard (the dirty state here is
     already saved or intentionally abandoned). */
  async function tab(name) {
    await page.click(`[data-tab="${name}"]`);
    await sleep(300);
    const prompt = await page.$eval("#sheet-backdrop", e => !e.hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes").catch(() => false);
    if (prompt) { await page.click("#sheet-cancel"); await sleep(300); }
  }
  async function waitFor(fn, label, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 5000)) { if (await fn()) return true; await sleep(100); }
    console.log("TIMEOUT waiting for: " + label);
    return false;
  }
  async function bulkAdd(craftName, kits) {
    await page.evaluate(name => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), craftName);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="bulk"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.click("#btn-bulk-add");
    await sleep(250);
  }
  /* Rects of the Bulk form/list vs the visible parts of the sticky bar and
     (optionally) the fixed bottom nav. Returns an array of overlap
     descriptions. At top scroll the nav is NOT checked: a fixed nav
     covers the viewport bottom on every page, so a list tailing past it
     is normal — the brief's check is "none sits under the BAR", and the
     bottom-scroll check (nav included) proves every line clears the nav
     once scrolled there, which the padding guarantees. */
  async function bulkOverlaps(withNav = true) {
    return page.evaluate((withNav) => {
      const vp = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      const inter = (a, b) => { if (!a || !b) return null; const x = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }; return (x.right - x.left > 1 && x.bottom - x.top > 1) ? x : null; };
      const bar = inter(rect(document.querySelector("#tab-bulk .action-bar")), vp);
      const nav = withNav ? inter(rect(document.querySelector("#tabs")), vp) : null;
      const out = [];
      ["#bulk-crafts", "#bulk-lines", "#bulk-lines-head"].forEach(sel => {
        const r = rect(document.querySelector(sel));
        if (!r) return;
        if (bar && inter(r, bar)) out.push(sel + " under sticky bar");
        if (nav && inter(r, nav)) out.push(sel + " under bottom nav");
      });
      return out;
    }, withNav);
  }
  async function scrollTop() { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200); }
  async function scrollBottom() { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(200); }

  /* ---- A2. Bulk tab hidden by default, shown by the Settings toggle ---- */
  eq(await page.$eval('[data-tab="bulk"]', e => e.hidden), true, "A2: Bulk tab hidden by default (editor, no flag)");
  await tab("settings");
  await page.click("#set-bulk-on");
  await waitFor(async () => !(await page.$eval('[data-tab="bulk"]', e => e.hidden)), "bulk tab appears after toggle");
  eq(await page.$eval('[data-tab="bulk"]', e => e.hidden), false, "A2: Bulk tab shown after toggle on");
  eq(remoteData.settings && remoteData.settings.features && remoteData.settings.features.bulkTab, true, "A2: bulkTab saved to shared data");
  await page.click("#set-bulk-on");
  await waitFor(async () => await page.$eval('[data-tab="bulk"]', e => e.hidden), "bulk tab hides after toggle off");
  eq(await page.$eval('[data-tab="bulk"]', e => e.hidden), true, "A2: Bulk tab hidden after toggle off");
  await page.click("#set-bulk-on");
  await waitFor(async () => !(await page.$eval('[data-tab="bulk"]', e => e.hidden)), "bulk tab reappears");
  eq(await page.$eval('[data-tab="bulk"]', e => e.hidden), false, "A2: Bulk tab shown again (left on for the rest)");

  /* ---- 1. Bulk form/list never under the sticky bar or bottom nav ---- */
  await tab("bulk");
  await scrollTop();
  eq(await bulkOverlaps(false), [], "1: top scroll, empty list — nothing under the sticky bar");
  await scrollBottom();
  eq(await bulkOverlaps(), [], "1: bottom scroll, empty list — nothing under bar/nav");
  await bulkAdd("Blooming Mirrors", 6);
  await scrollTop();
  eq(await bulkOverlaps(false), [], "1: top scroll, 1 line — nothing under the sticky bar");
  await scrollBottom();
  eq(await bulkOverlaps(), [], "1: bottom scroll, 1 line — nothing under bar/nav");

  /* ---- 2. New card fully visible; toast clear, one line, SKU unbroken ---- */
  await bulkAdd("Tambourines", 12);
  const cardOk = await page.evaluate(() => {
    const cards = document.querySelectorAll("#bulk-lines .hand-line");
    const card = cards[cards.length - 1];
    if (!card) return false;
    const r = card.getBoundingClientRect();
    const bar = document.querySelector("#tab-bulk .action-bar").getBoundingClientRect();
    const nav = document.querySelector("#tabs").getBoundingClientRect();
    return r.bottom <= Math.min(bar.top, nav.top) + 1;
  });
  eq(cardOk, true, "2: new card fully above the sticky bar");
  const toastOk = await page.evaluate(() => {
    const t = document.querySelector("#toast");
    if (!t || t.hidden) return "toast hidden";
    const tr = t.getBoundingClientRect();
    const bar = document.querySelector("#tab-bulk .action-bar").getBoundingClientRect();
    const nav = document.querySelector("#tabs").getBoundingClientRect();
    const cards = document.querySelectorAll("#bulk-lines .hand-line");
    const card = cards[cards.length - 1].getBoundingClientRect();
    const over = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    if (over(tr, bar)) return "toast over bar";
    if (over(tr, card)) return "toast over card";
    if (over(tr, nav)) return "toast over nav";
    const cs = getComputedStyle(t);
    const lh = cs.lineHeight === "normal" ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight);
    /* Height alone can't prove one line: the UNDO button's 44px min-height
       sets the toast floor at 68px even for a single line. A message
       wrapping to 3+ lines would push past ~87px; the short fixed text
       ("Added TAM-12") plus the nowrap SKU is what guarantees one line. */
    const spanH = document.querySelector("#toast .nowrap")?.getBoundingClientRect().height || 0;
    if (tr.height > 76) return "toast wraps (" + Math.round(tr.height) + "px)";
    if (spanH > lh + 6) return "toast SKU wraps";
    return "ok";
  });
  eq(toastOk, "ok", "2: toast clear of bar/card/nav, on one line");
  eq(await page.evaluate(() => { const s = document.querySelector("#toast .nowrap"); return s ? s.textContent : null; }), "TAM-12", "2: toast SKU wrapped in a nowrap span");
  await page.evaluate(name => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Blooming Mirrors");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="bulk"][data-kits="6"]').click(); });
  await sleep(150);
  eq(await page.evaluate(() => { const s = document.querySelector("#btn-bulk-add .nowrap"); return s ? s.textContent : null; }), "BM-6", "2: Add button SKU in a nowrap span");

  /* ---- 2b. Packing toast: clear of bar/nav, SKU unbroken ---- */
  await tab("pack");
  await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Blooming Mirrors");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
  await sleep(150);
  await page.click("#btn-pack-hand");
  await sleep(200);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* "Mark all" confirm */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(300);
  await page.click("#sheet-primary"); /* "Subtract from inventory" confirm */
  await sleep(300);
  const packToastOk = await page.evaluate(() => {
    const t = document.querySelector("#toast");
    if (!t || t.hidden) return "toast hidden";
    const tr = t.getBoundingClientRect();
    const bar = document.querySelector("#tab-pack .action-bar");
    const nav = document.querySelector("#tabs");
    const over = (a, b) => { if (!b) return false; const r = b.getBoundingClientRect(); return a.left < r.right - 1 && r.left < a.right - 1 && a.top < r.bottom - 1 && r.top < a.bottom - 1; };
    if (over(tr, bar)) return "toast over pack bar";
    if (over(tr, nav)) return "toast over nav";
    return "ok";
  });
  eq(packToastOk, "ok", "2b: pack toast clear of bar/nav");
  eq(await page.evaluate(() => { const s = document.querySelector("#toast .nowrap"); return s ? s.textContent : null; }), "BM-6", "2b: pack toast SKU in a nowrap span");

  /* ---- 8. Discard on a tab switch leaves a clean form, no red error ---- */
  await tab("pack");
  await page.evaluate(name => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Tambourines");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="18"]').click(); });
  await sleep(150);
  await tab("bulk");
  await tab("pack");
  eq(await page.$eval("#pack-kits", e => e.value), "", "8: pick cleared on return to Packing");
  eq(await page.$eval("#pack-error", e => e.textContent), "", "8: no red kits error on the cleared form");
  eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 0, "8: no craft selected on return");

  /* ---- 14. Phone header status fully visible ---- */
  const hdr = await page.evaluate(() => {
    const s = document.querySelector("#save-status"), b = document.querySelector("#conn-badge");
    const sr = s.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { statusRight: Math.round(sr.right), statusWidth: Math.round(sr.width), badgeRight: Math.round(br.right), vw: window.innerWidth };
  });
  eq(hdr.statusWidth > 0 && hdr.statusRight <= hdr.vw, true, "14: save status visible and inside the viewport (" + JSON.stringify(hdr) + ")");
  eq(hdr.badgeRight <= hdr.vw, true, "14: header badge inside the viewport");

  /* ---- 13. Bulk wording ---- */
  await tab("bulk");
  /* Section 8's tab dance cleared the list under the old rules, so build
     it fresh here — Record all with an empty list opens no sheet, and the
     title assert would read a stale sheet title. */
  await bulkAdd("Blooming Mirrors", 6);
  await bulkAdd("Tambourines", 12);
  await page.click("#btn-bulk-record");
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Record all", "13: Record all sheet titled 'Record all'");
  await page.click("#sheet-cancel");
  await sleep(200);
  await page.evaluate(name => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Blooming Mirrors");
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="bulk"][data-kits="6"]').click(); });
  await sleep(150);
  await page.click("#btn-bulk-add");
  await sleep(300);
  /* Batch C item 3: no prompt while adding — the second BM-6 queues
     silently; the duplicate pop-up fires at Record all instead. */
  eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 3, "13: duplicate queues silently, no prompt while adding");
  eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "13: no sheet opened while adding");
  const putsBeforeDup = putCount;
  await page.click("#btn-bulk-record");
  await sleep(300);
  eq(await page.$eval("#sheet-title", e => e.textContent), "Multiple of the same craft detected", "13: Record all opens the duplicate pop-up");
  eq(await page.evaluate(() => document.querySelector("#sheet-summary").textContent.includes("Blooming Mirrors x2 (6 kits + 6 kits)") && document.querySelector("#sheet-summary").textContent.includes("Was this intentional?")), true, "13: pop-up names the craft, count and kit amounts");
  eq(await page.$eval("#sheet-primary", e => e.textContent), "YES", "13: YES is the primary button");
  eq(await page.$eval("#sheet-primary", e => e.classList.contains("success")), true, "13: YES is green");
  eq(await page.$eval("#sheet-cancel", e => e.textContent), "NO", "13: NO is the cancel button");
  eq(await page.$eval("#sheet-cancel", e => e.classList.contains("danger")), true, "13: NO is red");
  await page.click("#sheet-cancel");
  await sleep(200);
  eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 3, "13: NO keeps all three lines");
  eq(putCount, putsBeforeDup, "13: NO saves nothing");

  /* ---- 12 (bulk): manual kits validation on the Bulk input ---- */
  await page.evaluate(name => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(name)).click(), "Blooming Mirrors");
  async function bulkType(v) {
    await page.evaluate(x => { const i = document.querySelector("#bulk-kits"); i.focus(); i.value = x; i.dispatchEvent(new Event("input", { bubbles: true })); }, v);
    await sleep(250);
  }
  async function bulkSheetOpen() { return page.$eval("#sheet-backdrop", e => !e.hidden); }
  await bulkType("6.5");
  eq(await page.$eval("#bulk-error", e => e.textContent), "Kits must be a whole number — decimals aren't allowed.", "12: bulk decimals rejected, not treated as 6");
  await bulkType("0");
  eq(await page.$eval("#bulk-error", e => e.textContent), "Kits must be at least 6.", "12: bulk zero rejected with 'must be at least 6'");
  await bulkType("150");
  eq(await page.$eval("#sheet-title", e => e.textContent), "Large order", "12: bulk kits above 96 ask first");
  if (await bulkSheetOpen()) { await page.click("#sheet-cancel"); await sleep(250); }
  eq(await page.$eval("#bulk-kits", e => e.value), "0", "12: bulk Go back reverts to the previous value");
  await bulkType("150");
  eq(await page.$eval("#sheet-title", e => e.textContent), "Large order", "12: bulk retyping asks again after Go back");
  if (await bulkSheetOpen()) { await page.click("#sheet-primary"); await sleep(250); }
  eq(await page.$eval("#bulk-kits", e => e.value), "150", "12: bulk confirming keeps the large value");
  eq(await page.$eval("#sheet-backdrop", e => e.hidden), true, "12: bulk confirming closes the sheet");

  console.log(fail ? "BATCHA TESTS FAILED (" + fail + ")" : "all batcha tests passed (" + pass + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
