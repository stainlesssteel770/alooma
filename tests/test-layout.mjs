/* Layout audit: REAL geometry at phone widths. Drives the real page through
   every tab and the states that open extra UI (menus, sheets, panels, forms),
   and fails if the page scrolls sideways or ANY visible element sticks out
   of the viewport horizontally. Born from the 2026-10-23 bug where the
   Inventory Print menu opened half off-screen on a phone: the UI suite had
   only checked that the menu opened, never where it was.
   Run: node tests/test-layout.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8911;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++;
  else { fail++; console.log("FAIL " + label + (extra ? "\n  " + extra : "")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Seeded "repo": stock + both Batch C features on + a box rule + history,
   so the widest content renders during the tour */
let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remoteData.inventory["scissors"] = { qty: 200, threshold: 250 };
remoteData.inventory["tree-mirror"] = { qty: 5, threshold: null };
remoteData.settings = {
  features: { boxes: true, bins: true },
  boxes: { A: { name: "Box A", size: "12 x 9 x 4" }, B: { name: "Box B", size: "" }, C: { name: "Box C", size: "" } },
  boxRules: [{ craftId: "cak", kits: 12, boxes: ["A", "B"] }],
  bins: { scissors: "BIN-99" }
};
remoteData.history = [
  { id: "h2", ts: "2026-10-22T15:04:00.000Z", type: "hand-packed", title: "Hand-packed Hafrashat Challah — 36 kits (HCB-36)", effects: [{ item: "wood-board", delta: -36 }], meta: { craftId: "hcb", kits: 36 }, undone: false },
  { id: "h1", ts: "2026-10-22T14:00:00.000Z", type: "received", title: "Received Scissors ×200", effects: [{ item: "scissors", delta: 200 }], meta: {}, undone: false }
];
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
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.startsWith("https://api.github.com/user") && req.method() === "GET") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "testeditor" }) });
    if (url.includes("api.github.com/repos/") && url.includes("/contents/data.json")) {
      if (req.method() === "GET") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remoteData)) }) });
      if (req.method() === "PUT") {
        putCount++;
        remoteData = JSON.parse(b64d(JSON.parse(req.postData()).content));
        remoteSha = "sha-" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, contentType: "application/json", body: "{}" });
    req.continue();
  });
  page.on("dialog", async d => { await d.accept(); });

  const sweep = () => page.evaluate(() => {
    const W = window.innerWidth;
    const bad = [];
    if (document.documentElement.scrollWidth > W + 1) bad.push("PAGE scrollWidth=" + document.documentElement.scrollWidth + " > " + W);
    document.querySelectorAll("body *").forEach(el => {
      if (el.classList && el.classList.contains("sr-only")) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.left < -1 || r.right > W + 1) {
        const tag = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.split(" ").join(".") : "");
        bad.push(tag + " left=" + Math.round(r.left) + " right=" + Math.round(r.right) + " (viewport " + W + ")");
      }
    });
    return bad.slice(0, 8);
  });
  const check = async label => {
    const bad = await sweep();
    ok(bad.length === 0, label, bad.join("\n  "));
  };
  const tab = async name => { await page.evaluate(n => document.querySelector('[data-tab="' + n + '"]').click(), name); await sleep(250); };
  const pickCraft = async (grid, text) => page.evaluate((g, t) => [...document.querySelectorAll(g + " .craft-btn")].find(b => b.textContent.includes(t)).click(), grid, text);

  for (const width of [360, 390]) {
    await page.setViewport({ width, height: 844 });
    await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(400);
    /* View-only pass: Inventory + History + the Print menu (reachable view-only) */
    await check(width + " view-only: inventory");
    await page.click("#btn-print-menu"); await sleep(200);
    await check(width + " view-only: print menu open");
    await page.evaluate(() => document.body.click()); await sleep(150);
    await tab("history");
    await check(width + " view-only: history");
    /* Connect (real path: badge -> Settings -> token) */
    await page.click("#conn-badge"); await sleep(200);
    await page.type("#gh-token", "fake-token-for-test");
    await page.click("#btn-connect"); await sleep(700);
    await check(width + " editor: settings after connect");
    /* Packing states */
    await tab("pack");
    await check(width + " pack: empty");
    await pickCraft("#pack-crafts", "The Cakery");
    await page.click('.kits-chip[data-for="pack"][data-kits="12"]');
    await sleep(250);
    await check(width + " pack: CAK-12 chosen, no path yet");
    await page.click("#btn-print-sheet"); await sleep(250);
    await check(width + " pack: print path (boxes line + Complete)");
    await page.click("#btn-mode-hand"); await sleep(250);
    await check(width + " pack: hand path checklist");
    await page.click("#btn-check-all"); await sleep(200);
    await page.click("#btn-complete-pack"); await sleep(300);
    await check(width + " pack: confirm sheet open");
    await page.evaluate(() => document.querySelector("#sheet-cancel").click()); await sleep(250);
    /* Bulk states */
    await tab("bulk");
    await check(width + " bulk: empty");
    await pickCraft("#bulk-crafts", "Blooming");
    await page.click('.kits-chip[data-for="bulk"][data-kits="36"]');
    await page.click("#btn-bulk-add"); await sleep(250);
    await pickCraft("#bulk-crafts", "Hafrashat");
    await page.click('.kits-chip[data-for="bulk"][data-kits="36"]');
    await page.click("#btn-bulk-add"); await sleep(250);
    await check(width + " bulk: two queued orders");
    await page.click("#btn-bulk-record"); await sleep(300);
    await check(width + " bulk: confirm sheet open");
    await page.evaluate(() => document.querySelector("#sheet-cancel").click()); await sleep(250);
    /* Inventory states */
    await tab("inventory");
    await check(width + " inventory: list");
    await page.click("#btn-print-menu"); await sleep(200);
    await check(width + " inventory: print menu open");
    await page.click("#btn-print-menu"); await sleep(150);
    await page.evaluate(() => { const m = document.querySelector('.inv-item[data-item="colored-clay-tool-tray"] .inv-main'); if (m) m.click(); });
    await sleep(300);
    await check(width + " inventory: item panel open (longest name)");
    await page.click("#btn-delivery"); await sleep(300);
    await check(width + " inventory: delivery form open");
    await page.evaluate(() => document.querySelector("#btn-cancel-delivery").click()); await sleep(200);
    await page.click("#btn-enter-counts"); await sleep(300);
    await check(width + " inventory: count entry open");
    await page.evaluate(() => document.querySelector("#btn-cancel-counts").click()); await sleep(200);
    /* History + Settings */
    await tab("history");
    await check(width + " history: seeded entries");
    await tab("settings");
    await check(width + " settings: boxes editor + rules");
    await page.evaluate(() => localStorage.removeItem("alooma.editor.v1"));
  }

  /* Desktop sanity at 1280: tabs + the print menu where the button sits right */
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(400);
  await tab("inventory");
  await page.click("#btn-print-menu"); await sleep(200);
  await check("1280 inventory: print menu open");

  console.log(pass + " passed, " + fail + " failed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
