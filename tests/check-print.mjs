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
   group gets the brief's three LOW cases on its first three items */
const L = require(path.join(ROOT, "logic.js"));
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k].qty = 100; remote.inventory[k].threshold = null; });
const groups = L.inventoryGroups();
const G0 = groups[0];
remote.inventory[G0.items[0]].threshold = 50; remote.inventory[G0.items[0]].qty = 17;  /* LOW */
remote.inventory[G0.items[1]].threshold = 50; remote.inventory[G0.items[1]].qty = 63;  /* not low */
remote.inventory[G0.items[2]].threshold = null; remote.inventory[G0.items[2]].qty = 5; /* no level: never low */
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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR " + e.message));
  /* A4: pack printing now completes the order, so it requires the editor
     token like every other editor harness — without it printSingle
     no-ops and the print area stays empty. */
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
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
      footText: pa.querySelector(".print-foot") ? pa.querySelector(".print-foot").textContent : "",
      rowCells: [...pa.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()))
    };
  });
  ok(pack.rows === 19 && pack.ticks === 19, "pack sheet CAK-36: 19 rows, 19 tick boxes");
  ok(pack.text.includes("Total kits: 36") && pack.text.includes("Order ID:"), "pack sheet: subtitle is 'Total kits: 36 · Order ID: ___'");
  ok(pack.text.includes("Per 6") && pack.text.includes("Total"), "pack sheet: Per 6 + Total columns");
  ok(!pack.text.includes("SKU"), "pack sheet: no SKU line (mockup)");
  ok(pack.text.includes("BOXES: Big Box, Small Box"), "pack sheet: the order's boxes are printed (comma-separated)");
  ok(!pack.titleText.includes("BOXES"), "pack sheet: top stays title + subtitle only (no BOXES under the title)");
  ok(pack.footText.includes("BOXES: Big Box, Small Box") && pack.footText.includes("Packed by"), "pack sheet: BOXES line sits in the footer, above 'Packed by'");
  ok(!pack.footText.includes("Date:"), "pack sheet: Date left the footer (it lives on header line 1 now)");
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
  await checkGeometry("/tmp/alooma-packsheet.pdf", "pack sheet CAK-36");
  ok(packTexts.length >= 2, "pack sheet CAK-36: big rows spill to a 2nd page rather than shrinking (" + packTexts.length + " pages)");
  ok(packTexts.every((t, i) => (t.includes("Cakery") || (i === packTexts.length - 1 && t.includes("Packed by"))) && t.trim().length > 30), "pack sheet: craft title repeats on every page, none blank (a footer flowed to its own last page is allowed)");
  const packedByPages = packTexts.map((t, i) => t.includes("Packed by") ? i : -1).filter(i => i >= 0);
  ok(packedByPages.length === 1 && packedByPages[0] === packTexts.length - 1, "pack sheet: 'Packed by' footer lands once, on the last page");
  ok(!packTexts[0].includes("BOXES") && packTexts[packTexts.length - 1].includes("BOXES: Big Box, Small Box"), "pack sheet PDF: BOXES appears only on the last page, with the footer");

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

  /* Evidence for Mark's thermal test: a SHORT craft's pack sheet (HCB-12). */
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat Challah")).click());
  await page.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="12"]').click(); });
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(300);
  const hcbTitle = await page.evaluate(() => { const t = document.querySelector("#print-area .label-title"); return t ? t.textContent : ""; });
  ok(hcbTitle.includes("Hafrashat Challah"), "evidence: short-craft pack sheet really is Hafrashat Challah");
  await page.pdf({ path: "/tmp/alooma-packsheet-hcb.pdf", preferCSSPageSize: true, printBackground: true });
  await checkGeometry("/tmp/alooma-packsheet-hcb.pdf", "pack sheet HCB-12");

  /* New pack-sheet layout geometry (no-boxes probes): header line 1 has
     the craft name + Date on the title line (Date pinned top-right,
     so its baseline sits ~18pt above the 30pt name's — the exact
     top-alignment is proved on the throwaway page below), and the
     footer holds Packed by with no Date. Page counts are owned by the
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
    ok(!!nm && !!dt && !!sb && dt.y > sb.y, name + "-" + kits + ": header Date sits on the title line, above the subtitle");
    const footText = await page.evaluate(() => { const f = document.querySelector("#print-area .print-foot"); return f ? f.textContent : ""; });
    ok(footText.includes("Packed by") && !footText.includes("Date:"), name + "-" + kits + ": footer holds Packed by, no Date");
    await checkGeometry(file, name + "-" + kits + " new-layout geometry");
    return doc.numPages;
  }
  const miPages = await singlePack("Miniature Interiors", 6, "/tmp/alooma-packsheet-mi.pdf");
  console.log("singlePack MI-6: " + miPages + " pages (count owned by the matrix)");
  const tamPages = await singlePack("Tambourines", 6, "/tmp/alooma-packsheet-tam.pdf");
  console.log("singlePack TAM-6: " + tamPages + " pages (count owned by the matrix)");

  /* New pack-sheet layout matrix: every craft at 6 and 36 kits, with and
     without BOXES (3-box case). Spec gate: every craft fits ONE label
     except The Cakery (19 items). Row counts don't change with kits —
     only the numbers do — but both levels run because wider totals can
     steal width from Item and wrap a long name. Stock is 10000 on the
     matrix pages so 24 prints never hit a shortage sheet; each half
     gets its own page + mock so the box rules don't leak into the
     main page's CAK-36 assertions above. */
  const MATRIX_CRAFTS = ["Blooming Mirrors", "Tambourines", "Judaic Clay-Art", "Hafrashat Challah", "The Cakery", "Miniature Interiors"];
  const MATRIX_KITS = [6, 36];
  function matrixRemote(withBoxes) {
    const rm = JSON.parse(JSON.stringify(remote));
    rm.history = [];
    Object.keys(rm.inventory).forEach(k => { rm.inventory[k].qty = 10000; rm.inventory[k].threshold = null; });
    rm.settings.features.boxes = withBoxes;
    if (withBoxes) {
      rm.settings.boxes = ["Box A", "Box B", "Box C"];
      rm.settings.boxRules = [];
      MATRIX_CRAFTS.forEach(nm => {
        const c = Object.values(L.CRAFTS).find(c => c.name === nm);
        MATRIX_KITS.forEach(k => rm.settings.boxRules.push({ craftId: c.id, kits: k, boxes: ["Box A", "Box B", "Box C"] }));
      });
    } else rm.settings.boxRules = [];
    return rm;
  }
  async function openMatrixPage(withBoxes) {
    const pg = await browser.newPage();
    await pg.evaluateOnNewDocument(() => {
      localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
    });
    await pg.setRequestInterception(true);
    const rm = matrixRemote(withBoxes);
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
  }
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
    const pg = await openMatrixPage(withBoxes);
    for (const name of MATRIX_CRAFTS) {
      for (const kits of MATRIX_KITS) {
        const slug = name.toLowerCase().replace(/[^a-z]+/g, "-") + "-" + kits + (withBoxes ? "-boxes" : "-noboxes");
        const file = "/tmp/alooma-matrix-" + slug + ".pdf";
        const pages = await matrixPrint(pg, name, kits, file);
        console.log("MATRIX " + name + " " + kits + " boxes=" + withBoxes + " -> " + pages + " pages");
        matrixResults.push({ name, kits, withBoxes, pages, file });
        if (name === "The Cakery") {
          ok(pages >= 2, "matrix: CAK-" + kits + " boxes=" + withBoxes + " still flows (expected exception, " + pages + " pages)");
        } else {
          ok(pages === 1, "matrix: " + name + "-" + kits + " boxes=" + withBoxes + " fits one label (" + pages + " pages)");
          if (pages > 1) {
            const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
            const p2 = await doc.getPage(2);
            const t2 = (await p2.getTextContent()).items.map(it => it.str).join(" ");
            console.log("MATRIX SPILL " + name + "-" + kits + " boxes=" + withBoxes + " page 2 holds: " + t2.slice(0, 300));
          }
        }
      }
    }
    await pg.close();
  }
  /* Longest 1-label craft, for the report PNG: most rows among the
     1-page sheets (boxes case preferred — the fuller sheet). The PDF
     is already in the uploaded artifacts; the PNG is rasterized from
     it after the run. */
  const rowCount = nm => Object.values(L.CRAFTS).find(c => c.name === nm).items.length;
  const onePage = matrixResults.filter(r => r.pages === 1).sort((a, b) => rowCount(b.name) - rowCount(a.name));
  const longest = onePage.find(r => r.withBoxes) || onePage[0];
  if (longest) console.log("MATRIX longest 1-label craft: " + longest.name + " (" + rowCount(longest.name) + " rows) -> " + longest.file);

  /* Header Date proof, on a throwaway page that never calls page.pdf:
     8pt computed size + top-alignment with the title's first line +
     right-alignment with the title row. This page is closed right
     after, so no emulated media can poison a later PDF. */
  {
    const pg = await openMatrixPage(false);
    await pg.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Tambourines")).click());
    await pg.evaluate(() => { document.querySelector('.kits-chip[data-for="pack"][data-kits="36"]').click(); });
    await sleep(300);
    await pg.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(300);
    await pg.emulateMediaType("print");
    const hdr = await pg.evaluate(() => {
      const row = document.querySelector("#print-area .label-title-row");
      const t = document.querySelector("#print-area .label-title");
      const d = document.querySelector("#print-area .label-date");
      if (!row || !t || !d) return null;
      const rr = row.getBoundingClientRect(), tr = t.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return { datePx: parseFloat(getComputedStyle(d).fontSize), topDy: dr.top - tr.top, rightDy: rr.right - dr.right };
    });
    ok(!!hdr, "header Date proof: title row + title + date all rendered");
    if (hdr) {
      ok(Math.abs(hdr.datePx - 8 * 96 / 72) < 0.5, "pack sheet: header Date is 8pt (computed " + hdr.datePx + "px)");
      ok(Math.abs(hdr.topDy) < 2, "pack sheet: header Date top-aligns with the title's first line (dy=" + hdr.topDy.toFixed(2) + "px)");
      ok(Math.abs(hdr.rightDy) < 2, "pack sheet: header Date sits at the title row's right edge (dy=" + hdr.rightDy.toFixed(2) + "px)");
    }
    await pg.close();
  }

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

  console.log(fail ? "PRINT CHECKS FAILED (" + fail + ")" : "all print checks passed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
