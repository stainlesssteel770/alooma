/* Final deliverables for the multi-craft queue brief (sample data only):
   - 3-craft Print all PDF (CAK-36 + TAM-12 + HCB-18)
   - single packing sheet WITH the BOXES line, and one WITHOUT
   - count sheet with a Counted by name filled in
   - phone screenshots: queue with 3 crafts, Hand pack "Craft 2 of 3",
     the unsaved-changes prompt
   Every PDF is geometry-gated (288x432pt pages, nothing in the 14pt
   bottom margin, no text collisions) like check-print.mjs.
   Writes /tmp/alooma-*.pdf + screenshots/*.png (the workflow uploads
   both paths as test-evidence).
   Run: node tests/make-deliverables.mjs */
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
const PORT = 8913;
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) pass++; else { fail++; console.log("FAIL " + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 100, threshold: null }; });
remoteData.history = [];
if (remoteData.settings && remoteData.settings.features) { remoteData.settings.features.boxes = false; remoteData.settings.features.bins = false; }
let remoteSha = "sha-d1";
let putCount = 0;
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const b64d = s => Buffer.from(s, "base64").toString("utf8");

async function pageTextsAndSizes(pdf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf)) }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    const vp = pg.getViewport({ scale: 1 });
    out.push({ text: tc.items.map(it => it.str).join(" "), w: vp.width, h: vp.height, items: tc.items });
  }
  return out;
}
async function checkPdf(pdf, label, extra) {
  const pages = await pageTextsAndSizes(pdf);
  ok(pages.length >= 1, label + ": at least one page (" + pages.length + ")");
  ok(pages.every(p => Math.abs(p.w - 288) <= 1.5 && Math.abs(p.h - 432) <= 1.5),
    label + ": every page is 288x432pt (got " + pages.map(p => Math.round(p.w) + "x" + Math.round(p.h)).join(", ") + ")");
  const problems = [];
  pages.forEach((p, i) => {
    const items = p.items.filter(it => it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 12 }));
    for (const it of items) if (it.y - 0.3 * it.h < 14) problems.push("p" + (i + 1) + ": '" + it.s.slice(0, 30) + "' inside the bottom margin");
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      if (Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) <= 1) continue;
      if (Math.abs(A.y - B.y) < 12) problems.push("p" + (i + 1) + ": '" + A.s.slice(0, 26) + "' collides with '" + B.s.slice(0, 26) + "'");
    }
  });
  ok(problems.length === 0, label + ": rendered geometry clean" + (problems.length ? " — " + [...new Set(problems)].slice(0, 3).join("; ") : ""));
  if (extra) extra(pages);
  return pages;
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
fs.mkdirSync(path.join(ROOT, "screenshots"), { recursive: true });
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
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
        remoteSha = "sha-d" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  const load = async () => {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(500);
    await page.evaluate(() => { window.print = () => {}; });
  };
  await load();
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
  async function freshQueue() {
    await page.evaluate(() => { localStorage.removeItem("alooma.packqueue.v1"); });
    await load();
  }

  /* ---- A. Queue with 3 crafts (screenshot) + 3-craft Print all (PDF) ---- */
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await queueAdd("Hafrashat Challah", 18);
  await page.screenshot({ path: path.join(ROOT, "screenshots/queue-3craft.png"), fullPage: true });
  ok(await page.$$eval("#pack-queue .queue-line", els => els.length) === 3, "deliverable: queue holds 3 crafts for the screenshot");
  await page.click("#btn-queue-print");
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-printall-3craft.pdf", preferCSSPageSize: true, printBackground: true });
  await checkPdf("/tmp/alooma-printall-3craft.pdf", "3-craft Print all", pages => {
    const joined = pages.map(p => p.text).join(" | ");
    const order = ["The Cakery", "Tambourines", "Hafrashat Challah"].map(t => joined.indexOf(t));
    ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2], "3-craft Print all: sections in queue order (CAK, TAM, HCB)");
    ok(joined.includes("Total kits: 36") && joined.includes("Total kits: 12") && joined.includes("Total kits: 18"), "3-craft Print all: each craft's own subtitle");
  });

  /* ---- B. Hand pack walk at "Craft 2 of 3" (screenshot) ---- */
  await freshQueue();
  await queueAdd("The Cakery", 36);
  await queueAdd("Tambourines", 12);
  await queueAdd("Hafrashat Challah", 18);
  await page.click("#btn-queue-hand");
  await sleep(300);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary");
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary");
  await sleep(700);
  ok(await page.$eval("#pack-queue-progress", e => e.textContent) === "Craft 2 of 3", "deliverable: walk advanced to Craft 2 of 3");
  await page.screenshot({ path: path.join(ROOT, "screenshots/handpack-2of3.png"), fullPage: true });

  /* ---- C. Single sheets: WITH and WITHOUT the BOXES line ---- */
  remoteData.settings.features.boxes = true;
  remoteData.settings.boxes = ["Big Box", "Small Box"];
  remoteData.settings.boxRules = [{ craftId: "cak", kits: 36, boxes: ["Big Box", "Small Box"] }];
  await freshQueue();
  await packSelect("The Cakery", 36);
  await page.click("#btn-print-sheet");
  await sleep(200);
  await page.pdf({ path: "/tmp/alooma-single-boxes.pdf", preferCSSPageSize: true, printBackground: true });
  await checkPdf("/tmp/alooma-single-boxes.pdf", "single WITH BOXES", pages => {
    ok(pages.map(p => p.text).join(" ").includes("BOXES: Big Box + Small Box"), "single WITH BOXES: BOXES line present");
  });
  remoteData.settings.features.boxes = false;
  await freshQueue();
  await packSelect("The Cakery", 18);
  await page.click("#btn-print-sheet");
  await sleep(200);
  await page.pdf({ path: "/tmp/alooma-single-noboxes.pdf", preferCSSPageSize: true, printBackground: true });
  await checkPdf("/tmp/alooma-single-noboxes.pdf", "single WITHOUT BOXES", pages => {
    ok(!pages.map(p => p.text).join(" ").includes("BOXES"), "single WITHOUT BOXES: no BOXES line");
  });

  /* ---- D. Count sheet with a Counted by name ---- */
  await tab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#count-by").value = "Dina"; });
  await page.evaluate(() => document.querySelector("#btn-print-count").click());
  await sleep(200);
  await page.pdf({ path: "/tmp/alooma-count-dina.pdf", preferCSSPageSize: true, printBackground: true });
  await checkPdf("/tmp/alooma-count-dina.pdf", "count sheet with name", pages => {
    const hits = pages.filter(p => p.text.includes("Counted by")).length;
    ok(hits === 1, "count sheet with name: exactly one Counted by footer (got " + hits + ")");
    ok(pages.map(p => p.text).join(" ").includes("Counted by: Dina"), "count sheet with name: Counted by Dina");
  });

  /* ---- E. Unsaved-changes prompt (screenshot) ---- */
  await page.click(".inv-item .inv-main");
  await sleep(300);
  await page.type(".inv-panel-input", "5");
  await tab("history");
  ok(await page.$eval("#sheet-title", e => e.textContent) === "Unsaved changes", "deliverable: unsaved-changes prompt shown");
  await page.screenshot({ path: path.join(ROOT, "screenshots/unsaved-prompt.png"), fullPage: true });

  console.log(fail ? "DELIVERABLES FAILED (" + fail + ")" : "all deliverables built (" + pass + " checks)");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
