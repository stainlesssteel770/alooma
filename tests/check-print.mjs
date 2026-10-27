/* Print check (desktop brief items 2+3): every print is one craft per
   4x6 page in the checklist style — big craft title, ONE subtitle line,
   full black grid, repeated title/header on continuation pages, no
   blank pages, LOW rows flagged from warn-at (bold + LOW tag), packing
   gains a Per 6 column, footers sign each craft's sheet.
   Pagination is asserted from the actual PDF text (pdfjs): each page
   must contain exactly one craft-group title.
   Run: node tests/check-print.mjs */
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
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
try { pdfjs.GlobalWorkerOptions.workerSrc = new URL("file://" + require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href; } catch (e) {}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8908;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
function ok(cond, label) { if (cond) console.log("ok   " + label); else { fail++; console.log("FAIL " + label); } }

/* Sample data through a mocked repo: every item at 100; the first BM
   group gets the brief's LOW cases on its first four items, including
   the fix-round item 3 at-threshold case (qty == level is LOW) */
const L = require(path.join(ROOT, "logic.js"));
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k].qty = 100; remote.inventory[k].threshold = null; });
const groups = L.inventoryGroups();
const G0 = groups[0];
remote.inventory[G0.items[0]].threshold = 50; remote.inventory[G0.items[0]].qty = 17;  /* LOW */
remote.inventory[G0.items[1]].threshold = 50; remote.inventory[G0.items[1]].qty = 63;  /* not low */
remote.inventory[G0.items[2]].threshold = null; remote.inventory[G0.items[2]].qty = 5; /* no level: never low */
remote.inventory[G0.items[3]].threshold = 50; remote.inventory[G0.items[3]].qty = 50;  /* at threshold: LOW (at or under) */
remote.settings.features.boxes = true; /* currentBoxes() is null unless the feature is on */
remote.settings.boxes = ["Big Box", "Small Box"]; /* the settings sanitizer keeps only rule boxes that exist here */
remote.settings.boxRules = [{ craftId: "cak", kits: 36, boxes: ["Big Box", "Small Box"] }]; /* CAK-36 order carries boxes */
const remoteSha = "sha-print";
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const DISTINCT = ["Blooming Mirrors", "Tambourines", "Judaic Clay-Art", "Hafrashat Challah", "The Cakery", "Miniature Interiors", "Shared items"]; /* full title phrases: bare "Miniature" also matches HCB's own item "Miniatures bread bag" */

async function pageTexts(pdf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    out.push(tc.items.map(it => it.str).join(" "));
  }
  return out;
}
/* Fix-round item 9: printed line widths live in the PDF's vector rects,
   not in text. A collapsed table splits its shared row border across a
   break, so Cakery's page-1 bottom line printed at half width (the
   before PDF: every page-1 table line h==2 units except the last,
   h==1). This returns page 1's horizontal table lines (wide, thin
   rects, excluding the taller header rule) — the assertion below
   requires them ALL to share one height. */
async function page1TableLineHeights(pdf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
  const pg = await doc.getPage(1);
  const ops = await pg.getOperatorList();
  const out = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjs.OPS.constructPath) {
      const a = ops.argsArray[i];
      if (Array.isArray(a[1]) && a[1].length === 4 && a[1][2] > 100 && a[1][3] <= 2) out.push(a[1][3]);
    }
  }
  return out;
}
/* Rendered-geometry check (Mark's thermal-print findings): text alone
   can't see an overlap — the old checks passed while the footer was
   drawn through the last rows. From the glyph positions in the PDF:
   (a) nothing may sit inside a 14pt bottom margin (thermal cutoff zone);
   (b) two text runs whose x-ranges overlap may not come within 12pt
   vertically — that's a collision (legit neighbours are a full line
   apart; a vertically-centred cell sits in a different column). */
async function checkGeometry(pdf, label) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
  const problems = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const items = tc.items.filter(it => it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 12 }));
    for (const it of items) {
      if (it.y - 0.3 * it.h < 14) problems.push("p" + i + ": '" + it.s.slice(0, 30) + "' inside the bottom margin");
    }
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      if (Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) <= 1) continue;
      if (Math.abs(A.y - B.y) < 12) problems.push("p" + i + ": '" + A.s.slice(0, 26) + "' collides with '" + B.s.slice(0, 26) + "'");
    }
  }
  ok(problems.length === 0, label + ": rendered geometry clean (no collisions, nothing in the bottom margin)" + (problems.length ? " — " + [...new Set(problems)].slice(0, 3).join("; ") : ""));
  return problems.length === 0;
}
function checkPagination(texts, label, footerWord) {
  ok(texts.length >= groups.length, label + ": at least one page per group (" + texts.length + " pages)");
  let allPure = true, seen = new Set();
  texts.forEach(t => {
    const found = DISTINCT.filter(tok => t.includes(tok));
    if (found.length === 0 && footerWord && t.includes(footerWord)) { /* a footer that flowed onto its own page is legal */ }
    else if (found.length !== 1) allPure = false;
    found.forEach(f => seen.add(f));
    if (t.trim().length < 30) allPure = false; /* blank page */
  });
  ok(allPure, label + ": every page holds exactly one craft, none blank");
  ok(seen.size === DISTINCT.length, label + ": all " + DISTINCT.length + " groups present (" + [...seen].join(", ") + ")");
}

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
  page.on("pageerror", e => console.log("PAGEERROR " + e.message));
  /* Crash-proofing hoists: CORS is used by the request handlers in the matrix, sheets, and count units (not just A4, where it is declared), matrixRemote/openMatrixPage are called by the items-8+10 unit, and MATRIX_CRAFTS/MATRIX_KITS are iterated by the sheets unit's sheet-names loop — so all five live outside the unit try blocks (same values, same timing, only wider scope). The lint gate proved the MATRIX_ hoist is load-bearing: without it the sheets loop is a runtime ReferenceError. */
  let CORS, matrixRemote, openMatrixPage, MATRIX_CRAFTS, MATRIX_KITS;
  try {
  /* A4: pack printing now completes the order, so it requires the editor
     token like every other editor harness — without it printSingle
     no-ops and the print area stays empty. */
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await page.setRequestInterception(true);
  CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.includes("/contents/data.json")) {
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);

  } catch (e) { fail++; console.log("FAIL (A4): " + e.message); }
  try {
  /* ---- Packing sheet: CAK-36 (Per 6 vs Total must differ somewhere) ---- */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="36"]');
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(300);
  const pack = await page.evaluate(() => {
    const pa = document.querySelector("#print-area");
    return {
      rows: pa.querySelectorAll("tbody tr").length,
      ticks: pa.querySelectorAll(".tick-box").length,
      text: pa.textContent,
      titleText: pa.querySelector("thead") ? pa.querySelector("thead").textContent : "",
      subText: pa.querySelector(".label-sub") ? pa.querySelector(".label-sub").textContent : "",
      footText: pa.querySelector(".print-foot") ? pa.querySelector(".print-foot").textContent : "",
      rowCells: [...pa.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()))
    };
  });
  ok(pack.rows === 19 && pack.ticks === 19, "pack sheet CAK-36: 19 rows, 19 tick boxes");
  ok(pack.text.includes("Total kits: 36") && pack.text.includes("Order ID:"), "pack sheet: subtitle is 'Total kits: 36 · Order ID: ___ Packed by: ___ · Date: ___'");
  ok(pack.subText.includes("Packed by: ________"), "pack sheet: Packed by moved to header line 2 (blank when no name set)");
  ok(pack.text.includes("Per 6") && pack.text.includes("Total"), "pack sheet: Per 6 + Total columns");
  ok(!pack.text.includes("SKU"), "pack sheet: no SKU line (mockup)");
  ok(pack.text.includes("BOXES: Big Box, Small Box"), "pack sheet: the order's boxes are printed (comma-separated)");
  ok(!pack.titleText.includes("BOXES"), "pack sheet: top stays title + subtitle only (no BOXES under the title)");
  ok(pack.footText.includes("BOXES: Big Box, Small Box") && !pack.footText.includes("Packed by"), "pack sheet: footer is BOXES-only (Packed by lives in the subtitle now)");
  ok(!pack.footText.includes("Date:"), "pack sheet: Date left the footer (it lives in the subtitle now)");
  /* The 8pt + top-alignment proof lives on a throwaway page after the
     matrix (never emulateMediaType on a page that later calls page.pdf:
     restoring to "screen" makes every later PDF render in screen media
     — Letter pages with the print-area hidden — which silently voided
     the CAK-36 spill, singlePack, inventory and count assertions in
     run 1. */
  const cakCraft = Object.values(L.CRAFTS).find(c => c.name === "The Cakery");
  const expectCells = {};
  cakCraft.items.forEach(ln => { expectCells[L.ITEMS[ln.item]] = [String(L.lineQty(ln, 6)), String(L.lineQty(ln, 36))]; });
  ok(pack.rowCells.every(cells => { const e = expectCells[cells[1]]; return e && cells[cells.length - 2] === e[0] && cells[cells.length - 1] === e[1]; }),
     "pack sheet: every row's Per 6 and Total match the recipe (Scissors 2/12, Printed Posters 1/6, boxes 6/36)");
  await page.pdf({ path: "/tmp/alooma-packsheet.pdf", preferCSSPageSize: true, printBackground: true });
  const packTexts = await pageTexts("/tmp/alooma-packsheet.pdf");
  /* Diagnostic for the batch (b) repeat failures: which page lacks what. */
  console.log("CAK-36 page flags: " + packTexts.map((t, i) => "p" + (i + 1) + " len=" + t.trim().length + " cakery=" + t.includes("Cakery") + " packedby=" + t.includes("Packed by")).join(" | "));
  await checkGeometry("/tmp/alooma-packsheet.pdf", "pack sheet CAK-36");
  ok(packTexts.length >= 2, "pack sheet CAK-36: big rows spill to a 2nd page rather than shrinking (" + packTexts.length + " pages)");
  ok(packTexts.every(t => t.includes("Cakery") && t.trim().length > 30), "pack sheet: craft title repeats on every page, none blank (a footer flowed to its own last page is allowed)");
  ok(packTexts.every(t => t.includes("Packed by")), "pack sheet: subtitle Packed by repeats on every page (it lives in the thead)");
  /* Header-repeat regression test (batch (b) fix): the longest sheet
     (Cakery, 2 pages) repeats the FULL header on its last page — title
     plus subtitle with both Packed by and Date. This FAILED on the
     3-line subtitle (runs 40372731228-40382956540: the last page had
     neither) and passes on the 2-line subtitle. */
  const lastPage = packTexts[packTexts.length - 1];
  ok(lastPage.includes("Cakery") && lastPage.includes("Packed by") && lastPage.includes("Date:"), "pack sheet CAK-36: last page repeats the full header (title + Packed by + Date)");

  ok(!packTexts[0].includes("BOXES") && packTexts[packTexts.length - 1].includes("BOXES: Big Box, Small Box"), "pack sheet PDF: BOXES appears only on the last page, with the footer");
  {
    /* Round 2 item 2 (fix-round item 9, now FIXED): the fragment-edge
       line used to print at half height (h=1 vs 2 for the rest) because
       the collapsed border was shared with the next page's first row.
       Print tables now use separate borders, so every page-1 line is
       full height. box-decoration-break: clone was tried earlier and
       reverted (it fixed neither the line nor the repeats, and it
       broke the repeated thead on page 2). */
    const hs = await page1TableLineHeights("/tmp/alooma-packsheet.pdf");
    ok(hs.length >= 10 && hs.every(h => h >= 2), "pack sheet CAK-36: page-1 table lines all full height (item 9 fixed: " + hs.join(",") + ")");
  }

  } catch (e) { fail++; console.log("FAIL (CAK-36): " + e.message); }
  try {
  /* CAK-12: all 19 lines still listed (2 pages now, by design).
     A4: the CAK-36 print completed and cleared the pick, so re-pick. */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(300);
  eq12: {
    const rows12 = await page.evaluate(() => document.querySelectorAll("#print-area tbody tr").length);
    ok(rows12 === 19, "pack sheet CAK-12: all 19 rows listed");
  }
  await page.pdf({ path: "/tmp/alooma-packsheet12.pdf", preferCSSPageSize: true, printBackground: true });
  const pack12Texts = await pageTexts("/tmp/alooma-packsheet12.pdf");
  await checkGeometry("/tmp/alooma-packsheet12.pdf", "pack sheet CAK-12");
  ok(pack12Texts.every(t => t.trim().length > 30), "pack sheet CAK-12: no blank pages (" + pack12Texts.length + " pages)");

  } catch (e) { fail++; console.log("FAIL (CAK-12): " + e.message); }
  try {
  /* Evidence for Mark's thermal test: a SHORT craft's pack sheet (HCB-12). */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat Challah")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="12"]').click(); });
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(300);
  const hcbTitle = await page.evaluate(() => { const t = document.querySelector("#print-area .label-title"); return t ? t.textContent : ""; });
  ok(hcbTitle.includes("Hafrashat Challah"), "evidence: short-craft pack sheet really is Hafrashat Challah");
  /* Fix-round item 17: the Per-6 column shows the rate when it isn't
     per-6 — tier18 lines read 1/18, plain lines stay bare. */
  const hcbRates = await page.evaluate(() => [...document.querySelectorAll("#print-area tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim())));
  const heatRate = (hcbRates.find(c => c[1] === "Heat gun") || [])[2];
  ok(heatRate === "1/18", "pack sheet HCB-12: Heat gun Per 6 shows 1/18 (got " + heatRate + ")");
  const creamRate = (hcbRates.find(c => c[1] === "Wood burning cream") || [])[2];
  ok(creamRate === "1/18", "pack sheet HCB-12: Wood burning cream Per 6 shows 1/18 (got " + creamRate + ")");
  ok(hcbRates.every(c => c[2] === "1/18" || !c[2].includes("/")), "pack sheet HCB-12: only the 1-per-18 lines carry a rate suffix");
  await page.pdf({ path: "/tmp/alooma-packsheet-hcb.pdf", preferCSSPageSize: true, printBackground: true });
  await checkGeometry("/tmp/alooma-packsheet-hcb.pdf", "pack sheet HCB-12");

  } catch (e) { fail++; console.log("FAIL (item 17): " + e.message); }
  try {
  /* New pack-sheet layout geometry (no-boxes probes): header line 1 has
     the craft name + Date on the title line (Date pinned top-right,
     so its baseline sits ~18pt above the 30pt name's — the exact
     top-alignment is proved on the throwaway page below), and the
     subtitle carries Packed by and no footer renders without boxes. Page counts are owned by the
     matrix below — these probes only log theirs. */
  async function singlePack(name, kits, file) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(300);
    await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
    const p1 = await doc.getPage(1);
    const runs1 = (await p1.getTextContent()).items.filter(it => it.str.trim()).map(it => ({ s: it.str, y: it.transform[5] }));
    const nm = runs1.find(r => r.s.includes(name.split(" ")[0]));
    const dt = runs1.find(r => r.s.includes("Date:"));
    const sb = runs1.find(r => r.s.includes("Total kits:"));
    ok(!!nm && !!dt && !!sb && dt.y < sb.y, name + "-" + kits + ": Date sits on subtitle line 2, below line 1 (never on the title line)");
    const subFoot = await page.evaluate(() => ({ sub: (document.querySelector("#print-area .label-sub") || {}).textContent || "", hasFoot: !!document.querySelector("#print-area .print-foot") }));
    ok(subFoot.sub.includes("Packed by") && !subFoot.hasFoot, name + "-" + kits + ": subtitle carries Packed by, no footer without boxes");
    await checkGeometry(file, name + "-" + kits + " new-layout geometry");
    return doc.numPages;
  }
  const miPages = await singlePack("Miniature Interiors", 6, "/tmp/alooma-packsheet-mi.pdf");
  console.log("singlePack MI-6: " + miPages + " pages (count owned by the matrix)");
  const tamPages = await singlePack("Tambourines", 6, "/tmp/alooma-packsheet-tam.pdf");
  console.log("singlePack TAM-6: " + tamPages + " pages (count owned by the matrix)");

  } catch (e) { fail++; console.log("FAIL (layout probes): " + e.message); }
  try {
  /* New pack-sheet layout matrix: every craft at 6 and 36 kits, with and
     without BOXES (3-box case). Spec gate: every craft fits ONE label
     except The Cakery (19 items). Row counts don't change with kits —
     only the numbers do — but both levels run because wider totals can
     steal width from Item and wrap a long name. Stock is 10000 on the
     matrix pages so 24 prints never hit a shortage sheet; each half
     gets its own page + mock so the box rules don't leak into the
     main page's CAK-36 assertions above. */
  MATRIX_CRAFTS = ["Blooming Mirrors", "Tambourines", "Judaic Clay-Art", "Hafrashat Challah", "The Cakery", "Miniature Interiors"];
  MATRIX_KITS = [6, 36];
  matrixRemote = function(withBoxes, binsOn) {
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 10000; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = withBoxes;
    rm.settings.features.bins = binsOn;
    if (withBoxes) {
      rm.settings.boxes = ["Box A", "Box B", "Box C"];
      rm.settings.boxRules = [];
      MATRIX_CRAFTS.forEach(nm => {
        const c = Object.values(L.CRAFTS).find(c => c.name === nm);
        MATRIX_KITS.forEach(k => rm.settings.boxRules.push({ craftId: c.id, kits: k, boxes: ["Box A", "Box B", "Box C"] }));
      });
    } else rm.settings.boxRules = [];
    return rm;
  };
  openMatrixPage = async function(withBoxes, binsOn) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = matrixRemote(withBoxes, binsOn);
    pg.on("request", req => {
      const url = req.url();
      if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
      if (url.includes("/contents/data.json")) return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: "sha-matrix", content: b64e(JSON.stringify(rm)) }) });
      if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
      req.continue();
    });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    return pg;
  };
  async function matrixPrint(pg, name, kits, file) {
    await pg.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
    await pg.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
    await checkGeometry(file, "matrix " + name + "-" + kits);
    return doc.numPages;
  }
  const matrixResults = [];
  for (const withBoxes of [false, true]) {
    for (const binsOn of [false, true]) {
    const pg = await openMatrixPage(withBoxes, binsOn);
    for (const name of MATRIX_CRAFTS) {
      for (const kits of MATRIX_KITS) {
        const slug = name.toLowerCase().replace(/[^a-z]+/g, "-") + "-" + kits + (withBoxes ? "-boxes" : "-noboxes") + (binsOn ? "-binson" : "-binsoff");
        const file = "/tmp/alooma-matrix-" + slug + ".pdf";
        const pages = await matrixPrint(pg, name, kits, file);
        console.log("MATRIX " + name + " " + kits + " boxes=" + withBoxes + " bins=" + binsOn + " -> " + pages + " pages");
        matrixResults.push({ name, kits, withBoxes, pages, file });
        if (name === "The Cakery") {
          ok(pages >= 2, "matrix: CAK-" + kits + " boxes=" + withBoxes + " bins=" + binsOn + " still flows (expected exception, " + pages + " pages)");
        } else {
          ok(pages === 1, "matrix: " + name + "-" + kits + " boxes=" + withBoxes + " bins=" + binsOn + " fits one label (" + pages + " pages)");
          if (pages > 1) {
            const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
            const p2 = await doc.getPage(2);
            const t2 = (await p2.getTextContent()).items.map(it => it.str).join(" ");
            console.log("MATRIX SPILL " + name + "-" + kits + " boxes=" + withBoxes + " bins=" + binsOn + " page 2 holds: " + t2.slice(0, 300));
          }
        }
      }
    }
    await pg.close();
    }
  }
  /* Longest 1-label craft, for the report PNG: most rows among the
     1-page sheets (boxes case preferred — the fuller sheet). The PDF
     is already in the uploaded artifacts; the PNG is rasterized from
     it after the run. */
  const rowCount = nm => Object.values(L.CRAFTS).find(c => c.name === nm).items.length;
  const onePage = matrixResults.filter(r => r.pages === 1).sort((a, b) => rowCount(b.name) - rowCount(a.name));
  const longest = onePage.find(r => r.withBoxes) || onePage[0];
  if (longest) console.log("MATRIX longest 1-label craft: " + longest.name + " (" + rowCount(longest.name) + " rows) -> " + longest.file);
  } catch (e) { fail++; console.log("FAIL (matrix): " + e.message); }
  try {
  /* Bins-on sheet fix (item-11 follow-up): the Bin column is sized to
     "888" (styles.css td.bin 21pt), so Item gains ~19pt. The sheet check
     now asserts: bins-off 1 line, bins-on at most 2 lines (never 3+),
     nothing cut off (no text past the page edge), and page counts
     (non-Cakery 1 label, Cakery at most 2) at 6 AND 36 kits, bins on and
     off. A stress craft (per 888, kits 6) puts "888" in every number
     cell and measures the real Bin/Item column widths from the PDF. */
  async function openSheetPage(binsOn, recipes, customItems) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 10000; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = false;
    rm.settings.features.bins = binsOn;
    rm.settings.boxRules = [];
    if (recipes) rm.settings.recipes = recipes;
    if (customItems) {
      rm.settings.customItems = customItems;
      customItems.forEach(ci => { rm.inventory[ci.id] = { qty: 10000, threshold: null }; });
    }
    pg.on("request", req => {
      const url = req.url();
      if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
      if (url.includes("/contents/data.json")) return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: "sha-sheet", content: b64e(JSON.stringify(rm)) }) });
      if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
      req.continue();
    });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    return pg;
  }
  async function pdfSheetAnalysis(file) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
    const pages = [];
    let maxRight = 0, pageW = 288;
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      pageW = pg.getViewport({ scale: 1 }).width;
      const tc = await pg.getTextContent();
      const words = tc.items.filter(it => it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width }));
      for (const wd of words) maxRight = Math.max(maxRight, wd.x + wd.w);
      words.sort((a, b) => b.y - a.y);
      const groups = [];
      for (const it of words) {
        const g = groups.find(g => Math.abs(g.y - it.y) <= 2);
        if (g) g.items.push(it); else groups.push({ y: it.y, items: [it] });
      }
      const lines = [];
      for (const g of groups) {
        g.items.sort((a, b) => a.x - b.x);
        lines.push(g.items.map(it => it.s).join(" ").replace(/\s+/g, " ").trim());
      }
      pages.push({ lines, words });
    }
    const hw = pages[0].words;
    const hit = hw.find(wd => wd.s === "Item");
    const hrow = hit ? hw.filter(wd => Math.abs(wd.y - hit.y) <= 2) : [];
    const hx = (s) => { const wd = hrow.find(wd => wd.s === s || (s === "Per" && wd.s.startsWith("Per "))); return wd ? wd.x : null; };
    return { pages, lines: pages.flatMap(p => p.lines), maxRight, pageW, numPages: doc.numPages, headerX: { item: hx("Item"), bin: hx("Bin"), per: hx("Per") } };
  }
  /* A name's words run contiguously within its row, except a 2-line name:
     Bin/Per-6/Total align to the first line's baseline, so the first line
     holds name-part-1 + the other cells and the second holds name-part-2
     alone — BUT the single-line cells can also sit on their own line
     between the name's lines (their own baseline). The matcher consumes
     name words in order and jumps to the next line whenever the current
     word is not the next name word, and counts ONLY lines where a name
     word was actually consumed: a cells-only line between name lines
     must not inflate the count (run 11: every true 2-liner read as 3).
     It tries EVERY occurrence of the first word and keeps the smallest
     span: two items can share a first word ("Miniatures tray #1" vs
     "Miniatures bread bag"), and a greedy first-match from the wrong row
     would false-fail the second name. */
  function linesForName(name, lines) {
    const words = name.split(/\s+/);
    let best = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const lw0 = lines[i].split(/\s+/);
      for (let j = 0; j < lw0.length; j++) {
        if (lw0[j] !== words[0]) continue;
        let wi = 0, li = i, k = j, lw = lw0;
        const usedLines = new Set([i]);
        while (wi < words.length) {
          if (k < lw.length && lw[k] === words[wi]) { usedLines.add(li); wi++; k++; }
          else if (li + 1 < lines.length) { li++; lw = lines[li].split(/\s+/); k = 0; }
          else break;
        }
        if (wi === words.length && usedLines.size < best) best = usedLines.size;
      }
    }
    return best;
  }
  /* Guards for the consuming-lines fix (run-11 decision 2): a fake 2-line
     name must pass the bins-on check and a fake 3-line name must fail
     it, including when the Bin/Per/Total cells sit on their own line
     between the name's lines (the run-11 miscount). Under the OLD
     matcher, the cells-line 2-liner returned 3, so that guard fails
     pre-fix; the plain 2-liner and both 3-liners behave the same
     under old and new matchers (controls). */
  ok(linesForName("Permanent Markers", ["Permanent B59 6 6", "Markers"]) <= 2, "guard: fake 2-line name passes the bins-on check");
  ok(linesForName("Permanent Markers", ["Permanent", "B59 6 6", "Markers"]) <= 2, "guard: fake 2-line name with cells on their own line passes the bins-on check");
  ok(linesForName("JCA Embellishment Tray", ["JCA B21 1 1", "Embellishment", "Tray"]) > 2, "guard: fake 3-line name fails the bins-on check");
  ok(linesForName("JCA Embellishment Tray", ["JCA", "B21 1 1", "Embellishment", "Tray"]) > 2, "guard: fake 3-line name with cells line still fails the bins-on check");
  /* Stress sheet: per 888 at 6 kits puts "888" in Per 6 and Total. The
     Bin cell must be EMPTY so the Bin column sits at its CSS width —
     every built-in item has a default "BIN-NN" code (logic.js
     defaultBins), which would make the column content-driven (~50pt)
     and hide the CSS change, so the stress line uses a test-only custom
     item (no default code). The Bin width assertion fails on the old
     40pt column (~53pt total) and passes on the 888-sized one (~34pt). */
  {
    const stressRecipes = L.builtInRecipes().concat([{ id: "stress888", code: "STR", name: "Stress 888", hidden: false, lines: [{ item: "stress-item-888", qty: 888, per: 6 }] }]);
    const pg = await openSheetPage(true, stressRecipes, [{ id: "stress-item-888", name: "Stress Item", unit: "" }]);
    await pg.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Stress 888")).click());
    await pg.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    const file = "/tmp/alooma-sheet-stress888.pdf";
    await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const a = await pdfSheetAnalysis(file);
    ok(a.lines.some(ln => (ln.match(/888/g) || []).length >= 2), "stress sheet: Per 6 and Total both show 888");
    const binW = (a.headerX.per !== null && a.headerX.bin !== null) ? Math.round(a.headerX.per - a.headerX.bin) : null;
    const itemW = (a.headerX.bin !== null && a.headerX.item !== null) ? Math.round(a.headerX.bin - a.headerX.item) : null;
    console.log("STRESSWIDTHS bins-on Bin=" + binW + "pt Item=" + itemW + "pt");
    ok(binW !== null && binW < 48, "stress sheet: Bin column under 48pt total (888-sized, was ~53pt at 40pt) (Bin=" + binW + "pt)");
    await pg.close();
  }
  for (const binsOn of [false, true]) {
    const pg = await openSheetPage(binsOn);
    for (const name of MATRIX_CRAFTS) {
      for (const kits of MATRIX_KITS) {
        await pg.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
        await pg.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
        await sleep(300);
        await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
        await sleep(300);
        const file = "/tmp/alooma-sheet-" + name.toLowerCase().replace(/[^a-z]+/g, "-") + "-" + kits + "-bins" + (binsOn ? "on" : "off") + ".pdf";
        await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
        const a = await pdfSheetAnalysis(file);
        const craft = Object.values(L.CRAFTS).find(c => c.name === name);
        /* Names from computePack rows, not recipe lines: the JCA clay-tray
           pair line expands to "Clay Tray A" + "Clay Tray B" rows on the
           sheet, and the raw line has no .item (L.ITEMS[undefined]). */
        /* Round 2 item 4: the pack sheet hides 0/0 rows, so the expected
           names are the computePack rows minus rows whose 6-kit rate and
           current qty are both 0 (the JCA pair's unused tray at 6 kits).
           Same rule the sheet builder applies; every other row still
           expects its name on the sheet. */
        const per6map = {};
        L.computePack(craft.id, 6).forEach(r => { per6map[r.item] = r.qty; });
        const names = L.computePack(craft.id, kits).filter(r => per6map[r.item] !== 0 || r.qty !== 0).map(r => L.ITEMS[r.item]).filter(Boolean);
        const tag = "sheet names: " + name + "-" + kits + " bins-" + (binsOn ? "on" : "off");
        if (!binsOn) {
          const wrapped = names.filter(nm => !a.lines.some(ln => ln.includes(nm)));
          ok(wrapped.length === 0, tag + " (all " + names.length + " names on one line)" + (wrapped.length ? " \u2014 wraps: " + wrapped.join(", ") : ""));
        } else {
          const over2 = names.map(nm => ({ nm, n: linesForName(nm, a.lines) })).filter(x => x.n > 2).map(x => x.nm + " (" + x.n + " lines)");
          ok(over2.length === 0, tag + " (all " + names.length + " names at most 2 lines)" + (over2.length ? " \u2014 over 2 lines: " + over2.join(", ") : ""));
        }
        ok(a.maxRight <= a.pageW + 1, tag + ": nothing cut off past the page edge (maxRight=" + Math.round(a.maxRight) + " pageW=" + Math.round(a.pageW) + ")");
        if (name === "The Cakery") {
          ok(a.numPages <= 2, tag + ": Cakery at most 2 labels (" + a.numPages + " pages)");
        } else {
          ok(a.numPages === 1, tag + ": fits one label (" + a.numPages + " pages)");
        }
        if (!binsOn && kits === 6 && a.headerX.per !== null && a.headerX.item !== null) {
          console.log("SHEETWIDTHS bins-off " + name + "-6 Item=" + Math.round(a.headerX.per - a.headerX.item) + "pt");
        }
      }
    }
    await pg.close();
  }

  /* MI count-sheet re-measurement (run-11 add-on): the Oct-25 MI-count
     2-page acceptance predates the header redo, so measure MI's count
     sheet fresh on the current layout, bins on and off, after the 2026-10-27 MI renames (the pack sheet now fits 1 label bins-on). LOGGING ONLY — no assertions:
     the count sheet has no per-craft page-count check, and this block
     reports (it does not lock in) MI count pagination. The isolated MI
     section uses the same .print-page trim trick the suite already uses
     for single-craft inventory PDFs; the log self-validates with the
     sections remaining and whether MI's last row (AY) is present. */
  async function openCountPage(binsOn) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 100; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = false;
    rm.settings.features.bins = binsOn;
    rm.settings.boxRules = [];
    pg.on("request", req => {
      const url = req.url();
      if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
      if (url.includes("/contents/data.json")) return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: "sha-micount", content: b64e(JSON.stringify(rm)) }) });
      if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
      req.continue();
    });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    return pg;
  }
  for (const binsOn of [false, true]) {
    const pg = await openCountPage(binsOn);
    await pg.evaluate(() => { document.querySelector("#btn-print-count").click(); });
    await sleep(300);
    const trim = await pg.evaluate(() => {
      const secs = [...document.querySelectorAll("#print-area .print-page")];
      secs.forEach(sec => {
        const t = sec.querySelector(".label-title");
        if (!t || !t.textContent.includes("Miniature Interiors")) sec.remove();
      });
      const kept = [...document.querySelectorAll("#print-area .print-page")].length;
      const ay = document.querySelector("#print-area").textContent.includes("AY - by request");
      return { kept, ay };
    });
    const file = "/tmp/alooma-micount-bins" + (binsOn ? "on" : "off") + ".pdf";
    await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    const a = await pdfSheetAnalysis(file);
    const overflow = a.numPages > 1 ? a.pages.slice(1).flatMap(p => p.lines).join(" | ").slice(0, 300) : "";
    console.log("MICOUNT bins-" + (binsOn ? "on" : "off") + ": " + a.numPages + " pages, sections kept=" + trim.kept + ", AY present=" + trim.ay + (a.numPages > 1 ? " (overflow: " + overflow + ")" : ""));
    await pg.close();
  }

  } catch (e) { fail++; console.log("FAIL (sheets): " + e.message); }
  try {
  /* Fix-round items 8 + 10 proof, on a throwaway page that never calls
     page.pdf (this page is closed right after, so no emulated media
     can poison a later PDF). With boxes on, the TAM-36 sheet has a
     footer, so one page proves both: Date lives in-flow in the
     subtitle (no absolute element left to overlap the title), and the
     footer draws no border of its own (the table border is the single
     line above BOXES). */
  {
    const pg = await openMatrixPage(true, false);
    await pg.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
    await pg.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="36"]').click(); });
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    await pg.emulateMediaType("print");
    const hdr = await pg.evaluate(() => {
      const sub = document.querySelector("#print-area .label-sub");
      const t = document.querySelector("#print-area .label-title");
      const foot = document.querySelector("#print-area .print-foot");
      if (!sub || !t) return null;
      const tr = t.getBoundingClientRect(), sr = sub.getBoundingClientRect();
      return {
        hasAbsDate: !!document.querySelector("#print-area .label-date"),
        subText: sub.textContent.replace(/\s+/g, " ").trim(),
        titleRowKids: document.querySelector("#print-area .label-title-row").children.length,
        overlap: sr.top < tr.bottom - 1,
        footBorder: foot ? getComputedStyle(foot).borderTopWidth : null,
        footText: foot ? foot.textContent : ""
      };
    });
    ok(!!hdr, "header proof: title + subtitle rendered");
    if (hdr) {
      ok(!hdr.hasAbsDate, "pack sheet: no absolute Date element left (Date lives in the subtitle now)");
      ok(hdr.subText.includes("Date: ________"), "pack sheet: subtitle carries the blank Date on line 2 (" + hdr.subText + ")");
      ok(hdr.titleRowKids === 1, "pack sheet: title row holds only the title");
      ok(!hdr.overlap, "pack sheet: subtitle sits below the title, never overlapping it");
      ok(hdr.footText.includes("BOXES:"), "pack sheet: boxes footer rendered for the border check");
      ok(hdr.footBorder === "0px", "pack sheet: footer draws no border-top (table border is the single line above BOXES)");
    }
    await pg.close();
  }

  } catch (e) { fail++; console.log("FAIL (items 8+10): " + e.message); }
  try {
  /* Print all (queue, brief item 1): 3 crafts, one job, queue order — the
     geometry gate runs on it too, like every other print. The first line
     enters Queue mode via the Queue button; the rest Add. */
  async function queueAdd(name, kits) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(150);
    await page.evaluate(() => { document.querySelector("#btn-queue-add").click(); });
    await sleep(250);
  }
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="36"]').click(); });
  await sleep(150);
  await page.evaluate(() => { document.querySelector("#btn-pack-queue").click(); });
  await sleep(250);
  await queueAdd("Tambourines", 12);
  await queueAdd("Hafrashat Challah", 18);
  await page.evaluate(() => { document.querySelector("#btn-queue-print").click(); });
  await sleep(300);
  const allTitles = await page.$$eval("#print-area .print-page .label-title", els => els.map(e => e.textContent));
  ok(JSON.stringify(allTitles) === JSON.stringify(["The Cakery", "Tambourines", "Hafrashat Challah"]), "Print all: one job, sections in queue order");
  await page.pdf({ path: "/tmp/alooma-printall.pdf", preferCSSPageSize: true, printBackground: true });
  await checkGeometry("/tmp/alooma-printall.pdf", "Print all (3 crafts)");

  /* ---- Inventory report ---- */
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-inventory").click(); });
  await sleep(300);
  const inv = await page.evaluate(() => {
    const pa = document.querySelector("#print-area");
    const rows = [...pa.querySelectorAll("tbody tr")].map(tr => ({ text: tr.textContent, low: tr.classList.contains("low") }));
    return { sections: pa.querySelectorAll(".print-page").length, text: pa.textContent, rows,
             firstSub: pa.querySelector(".label-sub") ? pa.querySelector(".label-sub").textContent : "" };
  });
  ok(inv.sections === groups.length, "inventory: one section per group (" + inv.sections + ")");
  ok(/^Inventory · [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(inv.firstSub.trim()), "inventory: subtitle is 'Inventory · <date>' (" + inv.firstSub.trim() + ")");
  ok(!inv.text.includes("Warn at"), "inventory: no Warn-at column or text");
  const lowRow = inv.rows.find(r => r.text.includes(L.ITEMS[G0.items[0]]));
  const midRow = inv.rows.find(r => r.text.includes(L.ITEMS[G0.items[1]]));
  const noLvlRow = inv.rows.find(r => r.text.includes(L.ITEMS[G0.items[2]]));
  ok(lowRow && lowRow.low && lowRow.text.includes("LOW"), "LOW flag: level 50, on hand 17 -> flagged (bold row + LOW tag)");
  ok(midRow && !midRow.low, "LOW flag: level 50, on hand 63 -> not flagged");
  ok(noLvlRow && !noLvlRow.low, "LOW flag: no level set -> never flagged");
  const atRow = inv.rows.find(r => r.text.includes(L.ITEMS[G0.items[3]]));
  ok(atRow && atRow.low && atRow.text.includes("LOW"), "LOW flag: level 50, on hand 50 (at threshold) -> flagged, matching screen + README");
  await page.pdf({ path: "/tmp/alooma-invreport.pdf", preferCSSPageSize: true, printBackground: true });
  checkPagination(await pageTexts("/tmp/alooma-invreport.pdf"), "inventory report");
  await checkGeometry("/tmp/alooma-invreport.pdf", "inventory report");

  /* Evidence for Mark's thermal test: single-craft inventory PDFs (the
     full build above is trimmed harness-side, after its asserts ran) */
  for (const [name, file] of [["The Cakery", "/tmp/alooma-inventory-cak.pdf"], ["Hafrashat Challah", "/tmp/alooma-inventory-hcb.pdf"]]) {
    await page.evaluate(() => { document.querySelector("#btn-print-inventory").click(); });
    await sleep(300);
    await page.evaluate(n => {
      const pa = document.querySelector("#print-area");
      [...pa.querySelectorAll(".print-page")].forEach(sec => {
        const t = sec.querySelector(".label-title");
        if (!t || !t.textContent.includes(n)) sec.remove();
      });
    }, name);
    await page.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    await checkGeometry(file, "inventory single-craft (" + name + ")");
  }

  } catch (e) { fail++; console.log("FAIL (print all): " + e.message); }
  try {
  /* ---- Count sheet ---- */
  await page.evaluate(() => { document.querySelector("#btn-print-count").click(); });
  await sleep(300);
  const cnt = await page.evaluate(() => {
    const pa = document.querySelector("#print-area");
    const rows = [...pa.querySelectorAll("tbody tr")].map(tr => ({ text: tr.textContent, low: tr.classList.contains("low") }));
    return { text: pa.textContent, rows, firstSub: pa.querySelector(".label-sub") ? pa.querySelector(".label-sub").textContent : "" };
  });
  ok(/^Count sheet · /.test(cnt.firstSub.trim()), "count sheet: subtitle is 'Count sheet · <date>'");
  ok(cnt.text.includes("Counted by:"), "count sheet: 'Counted by' footer present");
  ok(!cnt.text.includes("Write the counted number"), "count sheet: instruction line removed");
  ok(!cnt.text.includes("Warn at"), "count sheet: no Warn-at column or text");
  const cLow = cnt.rows.find(r => r.text.includes(L.ITEMS[G0.items[0]]));
  ok(cLow && cLow.low && cLow.text.includes("LOW"), "count sheet: LOW flag applies too");
  const cAt = cnt.rows.find(r => r.text.includes(L.ITEMS[G0.items[3]]));
  ok(cAt && cAt.low && cAt.text.includes("LOW"), "count sheet: at-threshold item flagged LOW (fix-round item 3)");
  await page.pdf({ path: "/tmp/alooma-countsheet.pdf", preferCSSPageSize: true, printBackground: true });
  const cntTexts = await pageTexts("/tmp/alooma-countsheet.pdf");
  checkPagination(cntTexts, "count sheet", "Counted by");
  await checkGeometry("/tmp/alooma-countsheet.pdf", "count sheet");
  /* Brief item 4: exactly one Counted by footer in the whole count job,
     and it is on the last page (under the last table, or flowed onto one
     final label — checkPagination's carve-out allows the latter). */
  const footPages = cntTexts.map((t, i) => t.includes("Counted by") ? i : -1).filter(i => i >= 0);
  ok(footPages.length === 1, "count sheet: exactly one 'Counted by' footer in the whole job (was one per craft)");
  ok(footPages[0] === cntTexts.length - 1, "count sheet: the footer is on the last page");

  } catch (e) { fail++; console.log("FAIL (count): " + e.message); }
  try {
  /* Subtitle line-count regression test (batch (b) fix): every craft's
     pack sheet renders its subtitle in at most 2 lines — including the
     longest craft names and the longest Order ID rendering (the
     12-underscore blank; Order ID has no input, so the blank IS the
     longest it gets). This FAILED on the 3-line subtitle (3 subtitle
     lines measured on the run-4 Cakery PDF) and passes on the 2-line
     subtitle. Line count comes from the rendered subtitle's text boxes
     in the DOM. A shortage sheet ("Print anyway") is cleared if stock
     runs short this late in the suite; it does not affect the count. */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(300);
  try {
    if (await page.$eval("#sheet-backdrop", e => !e.hidden)) await page.click("#sheet-cancel");
    await sleep(300);
  } catch (e) { /* no sheet open, nothing to discard */ }
  for (const craft of L.CRAFTS) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), craft.name);
    await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
    await sleep(300);
    await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    try {
      if (await page.$eval("#sheet-backdrop", e => !e.hidden)) await page.click("#sheet-primary");
      await sleep(300);
    } catch (e) { /* no shortage sheet */ }
    const subInfo = await page.evaluate(() => {
      const sub = document.querySelector("#print-area .label-sub");
      if (!sub) return { lines: -1, text: "" };
      const r = document.createRange();
      r.selectNodeContents(sub);
      const tops = new Set([...r.getClientRects()].map(x => Math.round(x.top)));
      return { lines: tops.size, text: sub.textContent };
    });
    ok(subInfo.lines !== -1 && subInfo.lines <= 2, "subtitle lines: " + craft.name + " renders at most 2 subtitle lines (" + subInfo.lines + ")");
    ok(subInfo.text.includes("Packed by"), "subtitle content: " + craft.name + " subtitle still carries Packed by");
    ok(subInfo.text.includes("Date:"), "subtitle content: " + craft.name + " subtitle still carries Date");
  }

  } catch (e) { fail++; console.log("FAIL (subtitle): " + e.message); }

  try {
  /* Round 2 item 2: every page's bottom border prints full thickness.
     A table's bottom border on a fragment page used to print at half
     height (0.75pt vs 1.50pt on this parser's ruler; 0.72pt vs 1.44pt on
     the reporter's ruler) — a collapsed-border fragment edge effect.
     The window (1.44 ± 0.15) covers the full border on either ruler and
     rejects the half border on either ruler. Measured from the PDF's
     vector operators (pdfjs), not pixels: the table's bottom border on
     a page is the lowest full-span group of horizontal filled rects. */
  const OPSB = pdfjs.OPS;
  const mulB = (m, n) => [m[0]*n[0] + m[2]*n[1], m[1]*n[0] + m[3]*n[1], m[0]*n[2] + m[2]*n[3], m[1]*n[2] + m[3]*n[3], m[0]*n[4] + m[2]*n[5] + m[4], m[1]*n[4] + m[3]*n[5] + m[5]];
  const applyB = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
  async function bottomBorders(pdf) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const opList = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const bars = [];
      for (let i = 0; i < opList.fnArray.length; i++) {
        const fn = opList.fnArray[i];
        const args = opList.argsArray[i];
        if (fn === OPSB.transform) ctm = mulB(ctm, args);
        else if (fn === OPSB.save) stack.push(ctm.slice());
        else if (fn === OPSB.restore) { if (stack.length) ctm = stack.pop(); }
        else if (fn === OPSB.constructPath) {
          const ops = args[0], cargs = args[1];
          let j = 0;
          for (const op of ops) {
            if (op === OPSB.rectangle) {
              const [x, y, w, h] = cargs.slice(j, j + 4); j += 4;
              const [x0, y0] = applyB(ctm, x, y);
              const [x1, y1] = applyB(ctm, x + w, y + h);
              const hh = Math.abs(y1 - y0), ww = Math.abs(x1 - x0);
              if (hh <= 3 && ww >= 20) bars.push({ y: Math.min(y0, y1), x0: Math.min(x0, x1), x1: Math.max(x0, x1), t: hh });
            } else if (op === OPSB.moveTo) j += 2;
            else if (op === OPSB.lineTo) j += 2;
            else if (op === OPSB.curveTo) j += 6;
          }
        }
      }
      const groups = new Map();
      for (const b of bars) {
        const key = Math.round(b.y * 10) / 10;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(b);
      }
      const ys = [...groups.keys()].sort((a, b) => a - b);
      if (!ys.length) { out.push({ page: p, none: true }); continue; }
      const g = groups.get(ys[0]);
      out.push({ page: p, span: Math.max(...g.map(b => b.x1)) - Math.min(...g.map(b => b.x0)), ts: g.map(b => b.t) });
    }
    return out;
  }
  async function openBorderPage(binsOn) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 100; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = false;
    rm.settings.features.bins = binsOn;
    rm.settings.boxRules = [];
    pg.on("request", req => {
      const url = req.url();
      if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: "" });
      if (url.includes("/contents/data.json")) return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, contentType: "application/json", body: JSON.stringify({ sha: "sha-border", content: b64e(JSON.stringify(rm)) }) });
      if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: "{}" });
      req.continue();
    });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    return pg;
  }
  async function checkBorders(tag, file) {
    const rows = await bottomBorders(file);
    for (const r of rows) {
      ok(!r.none && r.span >= 250 && r.ts.every(t => Math.abs(t - 1.44) <= 0.15),
        "border: " + tag + " p" + r.page + " bottom border full" + (r.none ? " (NO BARS)" : " (span " + Math.round(r.span) + "pt, " + r.ts.map(t => t.toFixed(3)).join("/") + "pt)"));
    }
  }
  for (const binsOn of [false, true]) {
    const pg = await openBorderPage(binsOn);
    await pg.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("The Cakery")).click());
    await pg.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="6"]').click(); });
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    const file = "/tmp/alooma-border-cak-6-bins" + (binsOn ? "on" : "off") + ".pdf";
    await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    await pg.close();
    await checkBorders("cak-6-bins" + (binsOn ? "on" : "off"), file);
    const pg2 = await openBorderPage(binsOn);
    await pg2.evaluate(() => { document.querySelector("#btn-print-count").click(); });
    await sleep(400);
    const file2 = "/tmp/alooma-border-count-bins" + (binsOn ? "on" : "off") + ".pdf";
    await pg2.pdf({ path: file2, preferCSSPageSize: true, printBackground: true });
    await pg2.close();
    await checkBorders("count-bins" + (binsOn ? "on" : "off"), file2);
  }

  } catch (e) { fail++; console.log("FAIL (borders): " + e.message); }


  try {
  /* Round 2 item 4: the PACK sheet hides rows that are 0/0 (Per 6 = 0
     and Total = 0) — the JCA alternating pair shows Clay Tray B as 0/0
     at 6 kits (only Tray A is used) but 1/1 at 12 kits. The filter lives
     in the pack-sheet builder only: computePack, the inventory list,
     the hand-pack checklist and the COUNT sheet all still show the row. */
  async function openZeroPage() {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 100; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = false;
    rm.settings.features.bins = false;
    rm.settings.boxRules = [];
    pg.on("request", req => {
      const url = req.url();
      if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: "" });
      if (url.includes("/contents/data.json")) return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, contentType: "application/json", body: JSON.stringify({ sha: "sha-zero", content: b64e(JSON.stringify(rm)) }) });
      if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }, body: "{}" });
      req.continue();
    });
    await pg.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    return pg;
  }
  async function pdfText(pdf) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
    let out = "";
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      out += tc.items.map(it => it.str).join(" ") + "\n";
    }
    return out;
  }
  for (const kits of [6, 12]) {
    const pg = await openZeroPage();
    await pg.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Judaic")).click());
    await pg.evaluate(k => { document.querySelector('.kits-chip[data-for="pack"][data-kits="' + k + '"]').click(); }, kits);
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    const file = "/tmp/alooma-zero-jca-" + kits + ".pdf";
    await pg.pdf({ path: file, preferCSSPageSize: true, printBackground: true });
    await pg.close();
    const text = await pdfText(file);
    ok(text.includes("Clay Tray A"), "zero-rows: JCA " + kits + " pack sheet shows Clay Tray A");
    if (kits === 6) ok(!text.includes("Clay Tray B"), "zero-rows: JCA 6 pack sheet hides Clay Tray B (0/0)");
    else ok(text.includes("Clay Tray B"), "zero-rows: JCA 12 pack sheet shows Clay Tray B");
  }
  const pgc = await openZeroPage();
  await pgc.evaluate(() => { document.querySelector("#btn-print-count").click(); });
  await sleep(400);
  await pgc.pdf({ path: "/tmp/alooma-zero-count.pdf", preferCSSPageSize: true, printBackground: true });
  await pgc.close();
  const countText = await pdfText("/tmp/alooma-zero-count.pdf");
  ok(countText.includes("Clay Tray B"), "zero-rows: count sheet still shows Clay Tray B");

  } catch (e) { fail++; console.log("FAIL (zero-rows): " + e.message); }

  console.log(fail ? "PRINT CHECKS FAILED (" + fail + ")" : "all print checks passed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
