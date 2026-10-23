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
function checkPagination(texts, label) {
  ok(texts.length >= groups.length, label + ": at least one page per group (" + texts.length + " pages)");
  let allPure = true, seen = new Set();
  texts.forEach(t => {
    const found = DISTINCT.filter(tok => t.includes(tok));
    if (found.length !== 1) allPure = false;
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
  await page.evaluate(() => { document.querySelector("#btn-print-sheet").click(); });
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
  ok(pack.text.includes("Total kits: 36") && pack.text.includes("Order ID:"), "pack sheet: subtitle is 'Total kits: 36   Order ID: ___'");
  ok(pack.text.includes("Per 6") && pack.text.includes("Total"), "pack sheet: Per 6 + Total columns");
  ok(!pack.text.includes("SKU"), "pack sheet: no SKU line (mockup)");
  ok(pack.text.includes("BOXES: Big Box + Small Box"), "pack sheet: the order's boxes are printed");
  ok(!pack.titleText.includes("BOXES"), "pack sheet: top stays title + subtitle only (no BOXES under the title)");
  ok(pack.footText.includes("BOXES: Big Box + Small Box") && pack.footText.includes("Packed by"), "pack sheet: BOXES line sits in the footer, above 'Packed by'");
  const cakCraft = Object.values(L.CRAFTS).find(c => c.name === "The Cakery");
  const expectCells = {};
  cakCraft.items.forEach(ln => { expectCells[L.ITEMS[ln.item]] = [String(L.lineQty(ln, 6)), String(L.lineQty(ln, 36))]; });
  ok(pack.rowCells.every(cells => { const e = expectCells[cells[1]]; return e && cells[cells.length - 2] === e[0] && cells[cells.length - 1] === e[1]; }),
     "pack sheet: every row's Per 6 and Total match the recipe (Scissors 2/12, Printed Posters 1/6, boxes 6/36)");
  await page.pdf({ path: "/tmp/alooma-packsheet.pdf", preferCSSPageSize: true, printBackground: true });
  const packTexts = await pageTexts("/tmp/alooma-packsheet.pdf");
  ok(packTexts.length >= 2, "pack sheet CAK-36: big rows spill to a 2nd page rather than shrinking (" + packTexts.length + " pages)");
  ok(packTexts.every(t => t.includes("Cakery") && t.trim().length > 30), "pack sheet: craft title repeats on every page, none blank");
  const packedByPages = packTexts.map((t, i) => t.includes("Packed by") ? i : -1).filter(i => i >= 0);
  ok(packedByPages.length === 1 && packedByPages[0] === packTexts.length - 1, "pack sheet: 'Packed by' footer lands once, on the last page");
  ok(!packTexts[0].includes("BOXES") && packTexts[packTexts.length - 1].includes("BOXES: Big Box + Small Box"), "pack sheet PDF: BOXES appears only on the last page, with the footer");

  /* CAK-12: all 19 lines still listed (2 pages now, by design) */
  await page.click("#btn-pack-change");
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-print-sheet").click(); });
  await sleep(300);
  eq12: {
    const rows12 = await page.evaluate(() => document.querySelectorAll("#print-area tbody tr").length);
    ok(rows12 === 19, "pack sheet CAK-12: all 19 rows listed");
  }
  await page.pdf({ path: "/tmp/alooma-packsheet12.pdf", preferCSSPageSize: true, printBackground: true });
  const pack12Texts = await pageTexts("/tmp/alooma-packsheet12.pdf");
  ok(pack12Texts.every(t => t.trim().length > 30), "pack sheet CAK-12: no blank pages (" + pack12Texts.length + " pages)");

  /* Evidence for Mark's thermal test: a SHORT craft's pack sheet (HCB-12) */
  await page.click("#btn-pack-change");
  await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat Challah")).click());
  await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-print-sheet").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-packsheet-hcb.pdf", preferCSSPageSize: true, printBackground: true });

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
  checkPagination(cntTexts, "count sheet");
  ok(cntTexts.filter(t => t.includes("Counted by")).length === groups.length, "count sheet: every craft's sheet carries its own 'Counted by' footer");

  console.log(fail ? "PRINT CHECKS FAILED (" + fail + ")" : "all print checks passed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
