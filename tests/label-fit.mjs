/* Label-fit audit (brief item 9, REPORT ONLY — never gates the build).
   At the original 4x6 sizes, with no shrinking anywhere, which crafts fit
   on one label and which spill? For every craft at every chip count
   (6..36) it prints the single sheet and reports: rows, pages, how many
   rows page 1 holds, what spills onto page 2, and the unused bottom gap
   on the last page (wasted space). Plus the brief's exact Print-all case
   (BM-6 / TAM-12 / BM-6 / BM-12 / CAK-18), the count sheet, and one
   CAK-36 sheet with the BOXES rule on (footer line costs space too).
   Every sheet reloads first so the mocked seed (all qty 100) is fresh —
   A4 prints deduct, and a stale stock level would fake a shortage sheet.
   Exit code is 0 unless the harness itself crashes; the FIT lines in
   this script's output ARE the audit. Run: node tests/label-fit.mjs */
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
const PORT = 8918;
const OUT = "/tmp/alooma-labelfit";
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const L = require(path.join(ROOT, "logic.js"));
const CRAFTS = Object.values(L.CRAFTS);
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
remote.settings.features.boxes = false;
const remoteSha = "sha-labelfit";
const b64e = s => Buffer.from(s, "utf8").toString("base64");

async function parsePdf(pdf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const items = tc.items.filter(it => it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5] }));
    pages.push({ text: items.map(it => it.s).join(" "), items });
  }
  return pages;
}
function bottomGap(page) {
  if (!page.items.length) return null;
  return Math.round(Math.min(...page.items.map(it => it.y)) - 14);
}
function rowsOnPage(craft, page) {
  return craft.items.map(ln => L.ITEMS[ln.item]).filter(nm => nm && page.text.includes(nm));
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
  /* A3: reloads after an unfinished walk would raise beforeunload; the
     audit's reloads happen from clean states, but accept any dialog so a
     stray prompt can never stall the audit. */
  page.on("dialog", d => { d.accept().catch(() => {}); });
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
  async function load() {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
    await sleep(300);
    await page.evaluate(() => { window.print = () => {}; });
  }
  async function pick(craftName, kits) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), craftName);
    await page.click(`.kits-chip[data-for="pack"][data-kits="${kits}"]`);
    await sleep(150);
  }
  async function singleSheet(craft, kits, tag) {
    await load();
    await pick(craft.name, kits);
    await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(400);
    const pdf = path.join(OUT, tag + ".pdf");
    await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
    const pages = await parsePdf(pdf);
    const p1rows = rowsOnPage(craft, pages[0]).length;
    let p2 = "-";
    if (pages.length > 1) {
      const spilled = rowsOnPage(craft, pages[pages.length - 1]);
      const foot = pages[pages.length - 1].text.includes("Packed by") ? " + footer" : "";
      p2 = (spilled.length ? spilled.join(" | ") : "no rows") + foot;
    }
    console.log(`FIT ${craft.name} ${kits} rows=${craft.items.length} pages=${pages.length} p1rows=${p1rows} p2=[${p2}] bottomGap=${bottomGap(pages[pages.length - 1])}pt`);
  }

  /* ---- Matrix: every craft at every chip count, boxes off ---- */
  for (const craft of CRAFTS) {
    for (const kits of [6, 12, 18, 24, 30, 36]) {
      await singleSheet(craft, kits, craft.id + "-" + kits);
    }
  }

  /* ---- Same CAK-36 with the BOXES rule on (footer line costs space) ---- */
  remote.settings.features.boxes = true;
  remote.settings.boxes = ["Big Box", "Small Box"];
  remote.settings.boxRules = [{ craftId: "cak", kits: 36, boxes: ["Big Box", "Small Box"] }];
  await singleSheet(CRAFTS.find(c => c.id === "cak"), 36, "cak-36-boxes");
  remote.settings.features.boxes = false;

  /* ---- The brief's exact Print-all case ---- */
  await load();
  async function queueFirst(name, kits) {
    await pick(name, kits);
    await page.evaluate(() => { document.querySelector("#btn-pack-queue").click(); });
    await sleep(250);
  }
  async function queueAdd(name, kits) {
    await pick(name, kits);
    await page.evaluate(() => { document.querySelector("#btn-queue-add").click(); });
    await sleep(250);
  }
  await queueFirst("Blooming Mirrors", 6);
  await queueAdd("Tambourines", 12);
  await queueAdd("Blooming Mirrors", 6);
  await queueAdd("Blooming Mirrors", 12);
  await queueAdd("The Cakery", 18);
  await page.evaluate(() => { document.querySelector("#btn-queue-print").click(); });
  await sleep(400);
  /* Batch C item 3: BM appears 3x in this queue, so Print all opens the
     duplicate check first — confirm YES, or nothing prints at all (the
     first audit run measured exactly that blocked state: 1 blank page). */
  await page.evaluate(() => {
    const bd = document.querySelector("#sheet-backdrop");
    const title = document.querySelector("#sheet-title");
    if (bd && !bd.hidden && title && title.textContent.includes("Multiple of the same craft")) {
      document.querySelector("#sheet-primary").click();
    }
  });
  await sleep(400);
  const allPdf = path.join(OUT, "printall-5.pdf");
  await page.pdf({ path: allPdf, preferCSSPageSize: true, printBackground: true });
  const allPages = await parsePdf(allPdf);
  const perPage = allPages.map(p => {
    const titles = CRAFTS.map(c => c.name).filter(nm => p.text.includes(nm));
    return (titles.length ? titles.join("+") : "notitle") + (p.text.includes("Packed by") ? "+foot" : "");
  });
  console.log(`PRINTALL BM-6/TAM-12/BM-6/BM-12/CAK-18 pages=${allPages.length} perPage=[${perPage.join(" | ")}]`);

  /* ---- Count sheet ---- */
  await load();
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-count").click(); });
  await sleep(400);
  const cntPdf = path.join(OUT, "count.pdf");
  await page.pdf({ path: cntPdf, preferCSSPageSize: true, printBackground: true });
  const cntPages = await parsePdf(cntPdf);
  const cntPerPage = cntPages.map(p => {
    const titles = [...CRAFTS.map(c => c.name), "Shared items"].filter(nm => p.text.includes(nm));
    return (titles.length ? titles.join("+") : "notitle") + (p.text.includes("Counted by") ? "+foot" : "");
  });
  console.log(`COUNT pages=${cntPages.length} perPage=[${cntPerPage.join(" | ")}]`);

  console.log("LABEL FIT DONE");
} finally {
  await browser.close();
  server.close();
}
