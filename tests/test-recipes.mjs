/* Recipe editor, sub-batch (a): catalog migration + line kinds, NO UI.
   Recipes move from code into synced data (settings.recipes /
   settings.customItems); logic.js keeps today's CRAFTS/ITEMS verbatim as
   built-in defaults and gains setCatalog, called by the app after every
   load. Covers: defaults identical to today; per-N rounding (heat gun
   1-per-18; tray pair); Fix 1 — kits {10, 15, 40} x EVERY line of EVERY
   craft, new lineQty vs today's lineQty identical; Fix 2 — the measured
   max line count that fits one 4x6 label (see MAX_LINES_ONE_LABEL: 9,
   measured by the item-9 label-fit audit, run 40209337998 — JCA's 9 rows
   fit with footer at 9pt spare, TAM's 10 rows spill the footer alone);
   old-data load produces no diff; custom recipes/items flow through the
   real pickers, sheets and inventory; boundary prints (JCA 9 lines = 1
   page, TAM 10 lines = 2 pages, custom 9-line craft = 1 page).
   Offline-recipe-edit sync is NOT tested here: it needs the (b) editor UI
   to make the edit — the queue path itself (diffAction settings keys +
   applyOneAction whole-key replace) is generic and already covered by the
   offline-queue suite for other settings keys.
   Run: node tests/test-recipes.mjs (CI, port 8919)
   Local logic only (no Chrome): node tests/test-recipes.mjs --logic-only */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8919;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, pass = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.log("FAIL " + label); } }
function eq(a, b, label) { if (JSON.stringify(a) === JSON.stringify(b)) { pass++; } else { fail++; console.log("FAIL " + label + "\n  expected " + JSON.stringify(b) + "\n  got      " + JSON.stringify(a)); } }

const L = require(path.join(ROOT, "logic.js"));

/* Frozen copy of TODAY's lineQty (pre-editor logic.js, verbatim) — the
   reference the new implementation must match on every line. */
function oldLineQty(ln, kits) {
  if (ln.rule === "tier18") return Math.ceil(kits / 18);
  if (ln.rule === "trayA") return Math.ceil(kits / 6 / 2);
  if (ln.rule === "trayB") return Math.floor(kits / 6 / 2);
  return ln.q6 * (kits / 6);
}
function oldEntries(craft, kits) {
  const out = {};
  craft.items.forEach(ln => { out[ln.item] = oldLineQty(ln, kits); });
  return out;
}
function newEntries(recipe, kits) {
  const out = {};
  recipe.lines.forEach(ln => {
    if (Array.isArray(ln.items)) {
      const q = L.pairQtys(ln, kits);
      out[ln.items[0]] = q[0];
      out[ln.items[1]] = q[1];
    } else {
      out[ln.item] = L.lineQty(ln, kits);
    }
  });
  return out;
}

/* ---------- NODE SECTION: defaults, rounding, Fix 1, Fix 2 constant ---------- */
eq(L.CRAFTS.length, 6, "defaults: 6 crafts");
eq(Object.keys(L.ITEMS).length, 62, "defaults: 62 items");
const builtIns = L.builtInRecipes();
eq(builtIns.map(c => c.id), ["bm", "tam", "jca", "hcb", "cak", "mi"], "builtInRecipes: ids in order");
eq(builtIns.map(c => c.code), ["BM", "TAM", "JCA", "HCB", "CAK", "MI"], "builtInRecipes: codes");
eq(builtIns.find(c => c.id === "jca").lines.length, 8, "builtInRecipes: JCA trays become ONE pair line (9 old lines -> 8)");
eq(builtIns.find(c => c.id === "jca").lines.find(ln => Array.isArray(ln.items)),
  { items: ["clay-tray-a", "clay-tray-b"], qty: 1, per: 6 }, "builtInRecipes: JCA pair line shape");
eq(builtIns.find(c => c.id === "hcb").lines.find(ln => ln.item === "heat-gun"),
  { item: "heat-gun", qty: 1, per: 18 }, "builtInRecipes: heat gun becomes 1-per-18");
eq(builtIns.find(c => c.id === "bm").lines.find(ln => ln.item === "scissors"),
  { item: "scissors", qty: 3, per: 6 }, "builtInRecipes: plain lines become per-6 with today's q6");

/* Per-N rounding spot checks (plan values). */
eq(L.lineQty({ item: "heat-gun", qty: 1, per: 18 }, 6), 1, "per-N: heat gun 6 kits -> 1");
eq(L.lineQty({ item: "heat-gun", qty: 1, per: 18 }, 18), 1, "per-N: heat gun 18 kits -> 1");
eq(L.lineQty({ item: "heat-gun", qty: 1, per: 18 }, 24), 2, "per-N: heat gun 24 kits -> 2");
eq(L.lineQty({ item: "x", qty: 3, per: 6 }, 12), 6, "per-N: plain 3-per-6 at 12 kits -> 6");
eq(L.pairQtys({ items: ["clay-tray-a", "clay-tray-b"], qty: 1, per: 6 }, 6), [1, 0], "pair: 6 kits -> A1 B0");
eq(L.pairQtys({ items: ["clay-tray-a", "clay-tray-b"], qty: 1, per: 6 }, 12), [1, 1], "pair: 12 kits -> A1 B1");
eq(L.pairQtys({ items: ["clay-tray-a", "clay-tray-b"], qty: 1, per: 6 }, 18), [2, 1], "pair: 18 kits -> A2 B1");

/* Fix 1: kits {10, 15, 40} x EVERY line of EVERY craft, new vs today's
   lineQty identical — plus the multiples, where computePack must agree too. */
for (const craft of L.CRAFTS) {
  const recipe = builtIns.find(c => c.id === craft.id);
  for (const kits of [6, 12, 18, 24, 30, 36, 10, 15, 40]) {
    eq(newEntries(recipe, kits), oldEntries(craft, kits), "Fix 1: " + craft.id + " at " + kits + " kits identical");
  }
}
for (const craft of L.CRAFTS) {
  for (const kits of [6, 12, 18, 36]) {
    const oldPack = {};
    L.computePack(craft.id, kits).forEach(r => { oldPack[r.item] = r.qty; });
    L.setCatalog(builtIns, []);
    const newPack = {};
    L.computePack(craft.id, kits).forEach(r => { newPack[r.item] = r.qty; });
    L.resetCatalog();
    eq(newPack, oldPack, "computePack parity: " + craft.id + "-" + kits + " with built-in catalog");
  }
}

/* Fix 2: measured max line count (see header) + which built-ins exceed it. */
eq(L.MAX_LINES_ONE_LABEL, 9, "Fix 2: measured max is 9 lines");
for (const craft of L.CRAFTS) {
  const n = L.computePack(craft.id, 6).length;
  if (craft.id === "jca") eq(n, 9, "Fix 2: JCA at exactly the max (9 entries)");
  if (craft.id === "hcb") eq(n, 7, "Fix 2: HCB under the max (7 entries)");
  if (["tam", "mi", "bm", "cak"].includes(craft.id)) ok(n > 9, "Fix 2: " + craft.id + " over the max (" + n + " entries, spills today)");
}

/* Normalization + catalog round-trip. */
eq(L.normalizeRecipes(null).map(c => c.id), ["bm", "tam", "jca", "hcb", "cak", "mi"], "normalizeRecipes: missing -> built-ins");
eq(L.normalizeRecipes("junk").map(c => c.id), ["bm", "tam", "jca", "hcb", "cak", "mi"], "normalizeRecipes: garbage -> built-ins");
eq(L.normalizeRecipes([{ id: "x", code: "nin", name: "Nine", hidden: false, lines: [{ item: "scissors", qty: 2, per: 6 }] }]).map(c => c.code), ["NIN"], "normalizeRecipes: code uppercased");
eq(L.normalizeCustomItems(null), [], "normalizeCustomItems: missing -> []");
eq(L.normalizeCustomItems([{ id: "scissors", name: "Fake", unit: "" }]), [], "normalizeCustomItems: cannot shadow a built-in id");
eq(L.normalizeCustomItems([{ id: "w", name: "Widget", unit: "each" }]), [{ id: "w", name: "Widget", unit: "each" }], "normalizeCustomItems: keeps valid custom");
eq(L.defaultSettings().recipes.map(c => c.id), ["bm", "tam", "jca", "hcb", "cak", "mi"], "defaultSettings: carries built-in recipes");
eq(L.defaultSettings().customItems, [], "defaultSettings: customItems empty");
L.setCatalog(builtIns.concat([{ id: "nine", code: "NIN", name: "Nine", hidden: false, lines: [{ item: "scissors", qty: 1, per: 6 }] }]),
  [{ id: "spare", name: "Spare Part", unit: "" }]);
eq(L.computePack("nine", 6).length, 1, "setCatalog: custom craft packs");
eq(L.ITEMS["spare"], "Spare Part", "setCatalog: custom item name visible");
eq(L.itemUnit("spare"), "", "setCatalog: custom item unit default");
eq(L.inventoryGroups().slice(-1)[0], { id: "added", name: "Added items", items: ["spare"] }, "setCatalog: unused custom item lands in trailing Added group");
L.resetCatalog();
eq(L.CRAFTS.length, 6, "resetCatalog: defaults restored");
eq(L.ITEMS["spare"], undefined, "resetCatalog: custom item gone");

if (process.argv.includes("--logic-only")) {
  console.log(fail ? "RECIPE LOGIC FAILED (" + fail + ")" : "recipe logic passed (" + pass + " checks)");
  process.exit(fail ? 1 : 0);
}

/* ---------- BROWSER SECTION ---------- */
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
try { pdfjs.GlobalWorkerOptions.workerSrc = new URL("file://" + require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href; } catch (e) {}

const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
let remoteSha = "sha-recipes";
let putCount = 0, lastPutBody = null;
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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 90000 });
try {
  const page = await browser.newPage();
  page.on("pageerror", e => console.log("PAGEERROR " + e.message));
  page.on("dialog", d => d.accept());
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  const mockHandler = req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() || "{}");
        if (body.sha !== remoteSha) return req.respond({ status: 409, headers: CORS, contentType: "application/json", body: JSON.stringify({ message: "conflict" }) });
        const data = JSON.parse(b64d(body.content));
        Object.keys(remote).forEach(k => delete remote[k]);
        Object.assign(remote, data);
        remoteSha = "sha-recipes-" + (++putCount);
        lastPutBody = data;
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha }) });
      }
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url === "https://api.github.com/user") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "tester" }) });
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  };
  page.on("request", mockHandler);
  async function load(expectedCrafts) {
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(n => document.querySelectorAll("#pack-crafts .craft-btn").length === n, { timeout: 15000 }, expectedCrafts);
    await sleep(300);
    await page.evaluate(() => { window.print = () => {}; });
  }
  async function pick(name, kits) {
    await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
    await sleep(150);
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), name);
    await page.click(`.kits-chip[data-for="pack"][data-kits="${kits}"]`);
    await sleep(150);
  }
  async function printSheet() {
    await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
    await sleep(400);
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll("#print-area tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()));
    });
    /* A blocked print (shortage sheet) leaves the area empty/stale — fail
       loudly here instead of confusing nulls downstream. */
    ok(rows.length > 0, "print happened (rows present, no shortage sheet blocked it)");
    return rows;
  }
  function qtyOf(rows, name) {
    const row = rows.find(r => r[1] === name);
    return row ? row[row.length - 1] : null;
  }
  async function pdfPages(tag) {
    await page.pdf({ path: "/tmp/alooma-recipes-" + tag + ".pdf", preferCSSPageSize: true, printBackground: true });
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync("/tmp/alooma-recipes-" + tag + ".pdf")) }).promise;
    return doc.numPages;
  }

  /* ---- Section A: old data (no recipes keys) loads built-ins, no diff ---- */
  remote.settings = { features: { boxes: true, bins: false, bulkTab: true }, boxes: ["Marker Box"], boxRules: [], bins: {} };
  await load(6);
  eq(await page.evaluate(() => document.body.textContent.includes("Marker Box")), true, "browser: seed proves itself (Marker Box from mock, not live data)");
  eq(putCount, 0, "browser: old-data load issues no PUT (no phantom save)");
  await sleep(1000);
  eq(putCount, 0, "browser: still no PUT after idle (migration is diff-free)");
  eq(await page.evaluate(() => document.querySelector("#save-status").textContent.includes("Loaded")), true, "browser: save status stays Loaded after old-data load");
  let rows = await (async () => { await pick("Blooming Mirrors", 6); return printSheet(); })();
  eq(qtyOf(rows, "Tree Mirror"), "6", "browser: defaults BM-6 tree mirror 6");
  eq(qtyOf(rows, "Scissors"), "3", "browser: defaults BM-6 scissors 3");
  rows = await (async () => { await pick("Hafrashat Challah", 6); return printSheet(); })();
  eq(qtyOf(rows, "Heat gun"), "1", "browser: defaults HCB-6 heat gun 1");
  rows = await (async () => { await pick("Judaic Clay-Art", 6); return printSheet(); })();
  eq(qtyOf(rows, "Clay Tray A"), "1", "browser: defaults JCA-6 tray A 1");
  eq(qtyOf(rows, "Clay Tray B"), "0", "browser: defaults JCA-6 tray B 0");
  eq(qtyOf(rows, "JCA Instructions"), "2", "browser: defaults JCA-6 instructions 2");

  /* ---- Section B: first real save carries the migrated recipes ---- */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(200);
  const putsBeforeToggle = putCount; /* section A prints already saved (3 PUTs) */
  await page.click("#set-boxes-on"); /* boxes true -> false: a trivial settings save */
  await page.waitForFunction(() => document.querySelector("#save-status").textContent.includes("Saved"), { timeout: 10000 });
  eq(putCount, putsBeforeToggle + 1, "browser: exactly one PUT for the toggle save");
  eq(lastPutBody.settings.recipes, JSON.parse(JSON.stringify(L.builtInRecipes())), "browser: saved recipes equal the built-ins");
  eq(lastPutBody.settings.customItems, [], "browser: saved customItems empty");

  /* ---- Section C: custom recipes + custom items through the real UI ---- */
  const customs = L.builtInRecipes();
  const bm = customs.find(c => c.id === "bm");
  bm.lines.find(ln => ln.item === "tree-mirror").qty = 5;
  bm.lines.push({ item: "test-widget", qty: 2, per: 6 });
  customs.push({ id: "nine-line-test", code: "NIN", name: "Nine Line Test", hidden: false, lines: [
    { item: "mi-frames", qty: 6, per: 6 }, { item: "apron", qty: 6, per: 6 }, { item: "gloves", qty: 6, per: 6 },
    { item: "scissors", qty: 3, per: 6 }, { item: "tacky-glue", qty: 3, per: 6 }, { item: "glue-dots", qty: 1, per: 6 },
    { item: "wood-board", qty: 6, per: 6 }, { item: "cake-box", qty: 6, per: 6 }, { item: "ck-placemat", qty: 6, per: 6 }
  ] });
  remote.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: {}, recipes: customs,
    customItems: [{ id: "test-widget", name: "Test Widget", unit: "each" }, { id: "spare-part", name: "Spare Part", unit: "" }] };
  Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
  /* Custom items start at 0 (plan) — stock the one the BM print needs.
     Spare-part is deliberately NOT seeded: the Added test below proves
     the app fills it at 0 on load. */
  remote.inventory["test-widget"] = { qty: 100, threshold: null };
  remote.history = [];
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 7, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { window.print = () => {}; });
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Nine Line Test"))), true, "browser: custom craft appears in the picker");
  rows = await (async () => { await pick("Blooming Mirrors", 6); return printSheet(); })();
  eq(qtyOf(rows, "Tree Mirror"), "5", "browser: edited BM-6 tree mirror 5 (recipe edit flows through)");
  eq(qtyOf(rows, "Test Widget"), "2", "browser: custom item packs from the edited recipe");
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-inventory").click(); });
  await sleep(400);
  const invSections = await page.evaluate(() => [...document.querySelectorAll("#print-area .print-page")].map(sec => ({
    title: sec.querySelector(".label-title") ? sec.querySelector(".label-title").textContent : "",
    rows: [...sec.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()))
  })));
  const added = invSections.find(s => s.title === "Added items");
  eq(!!added, true, "browser: Added items group exists in the inventory report");
  eq(added && added.rows.some(r => r[0] === "Spare Part" && r[1] === "0"), true, "browser: unused custom item sits in Added items at 0");
  await pick("Nine Line Test", 6);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(400);
  eq(await pdfPages("nine"), 1, "browser: custom 9-line craft prints exactly one page");

  /* ---- Section D: boundary prints at the measured max ---- */
  remote.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: {} };
  delete remote.settings.recipes;
  delete remote.settings.customItems;
  Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
  remote.history = [];
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { window.print = () => {}; });
  await pick("Judaic Clay-Art", 6);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(400);
  eq(await pdfPages("jca"), 1, "browser: JCA at exactly the max (9 lines) prints one page");
  await pick("Tambourines", 6);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(400);
  /* Renames: TAM's 10 lines now fit (Tam Decor Tray/Stack + Tam
     Instructions are shorter), so the above-the-max spill proof moved
     to BM's 12 lines — and the pack-sheet height-budget round moves it
     again: the 2.5pt cell padding lets BM's 12 lines fit at the same
     text size (no shrink), so BM now proves the fits half and the
     spill proof moves to CAK's 19 lines. Both halves still proven:
     fits, and over-max spills instead of shrinking. */
  eq(await pdfPages("tam"), 1, "browser: TAM 10 lines now fit after the renames");
  await pick("Blooming Mirrors", 6);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(400);
  eq(await pdfPages("bm"), 1, "browser: BM 12 lines now fit after the padding trim (same text size, no shrink)");
  await pick("The Cakery", 6);
  await page.evaluate(() => { document.querySelector("#btn-pack-print").click(); });
  await sleep(400);
  eq(await pdfPages("cak"), 2, "browser: CAK above the max (19 lines) spills to two pages, never shrinks");

  /* ---- Sub-batch (b) sections: editor UI + validation + hide/unhide ---- */
  const newContext = async () => (browser.createBrowserContext ? await browser.createBrowserContext() : await browser.createIncognitoBrowserContext());
  async function goSettings(pg) {
    await pg.evaluate(() => document.querySelector('[data-tab="settings"]').click());
    await sleep(300);
  }
  async function resetSeed() {
    remote.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: {} };
    delete remote.settings.recipes;
    delete remote.settings.customItems;
    Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
    remote.history = [];
    await page.reload({ waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
    await sleep(300);
    await page.evaluate(() => { window.print = () => {}; });
  }
  async function waitPut(pred, label) {
    for (let i = 0; i < 40; i++) {
      if (pred(lastPutBody)) return true;
      await sleep(150);
    }
    return false;
  }
  async function confirmIfOpen(pg) {
    const open = await pg.evaluate(() => { const bd = document.querySelector("#sheet-backdrop"); return bd && !bd.hidden; });
    if (open) { await pg.evaluate(() => document.querySelector("#sheet-primary").click()); await sleep(500); }
  }

  /* (b1) Viewers: no Settings tab, Recipes card is editor-only. */
  const vctx = await newContext();
  const vpage = await vctx.newPage();
  vpage.on("dialog", d => d.accept());
  await vpage.setRequestInterception(true);
  vpage.on("request", mockHandler);
  await vpage.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await vpage.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  eq(await vpage.evaluate(() => document.querySelector('[data-tab="settings"]').hidden), true, "(b) viewer: Settings tab hidden");
  eq(await vpage.evaluate(() => document.querySelector("#recipes-card").classList.contains("editor-only")), true, "(b) viewer: Recipes card is editor-only");
  await vctx.close();

  /* (b2) Code validation + Add craft. */
  await resetSeed();
  await goSettings(page);
  eq(await page.evaluate(() => !!document.querySelector("#recipes-card")), true, "(b) editor: Recipes card present");
  async function tryAdd(name, code) {
    await page.evaluate((n, c) => { document.querySelector("#recipe-add-name").value = n; document.querySelector("#recipe-add-code").value = c; }, name, code);
    await page.evaluate(() => document.querySelector("#recipe-add-btn").click());
    await sleep(400);
  }
  const packCount = async () => await page.evaluate(() => document.querySelectorAll("#pack-crafts .craft-btn").length);
  await tryAdd("Test Craft", "A");
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent !== ""), true, "(b) code 1 letter rejected");
  eq(await packCount(), 6, "(b) rejected add adds no craft");
  await tryAdd("Test Craft", "ABCDE");
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent !== ""), true, "(b) code 5 letters rejected");
  await tryAdd("Test Craft", "A1");
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent !== ""), true, "(b) code with digit rejected");
  await tryAdd("Another", "BM");
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent !== ""), true, "(b) duplicate code rejected");
  eq(await packCount(), 6, "(b) no rejected add added a craft");
  await tryAdd("Alpha Craft", "abc");
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent), "", "(b) lowercase code accepted (auto-uppercased)");
  eq(await packCount(), 7, "(b) valid add appears in the picker");
  const alphaRow = await page.evaluate(() => { const r = document.querySelector('[data-recipe-row="alpha-craft"]'); return r ? r.textContent : ""; });
  eq(alphaRow.includes("Alpha Craft") && alphaRow.includes("ABC"), true, "(b) new craft listed with uppercased code");

  /* (b3) Hide/unhide + a queued line for the hidden craft still completes. */
  await resetSeed();
  await pick("Blooming Mirrors", 6);
  await page.evaluate(() => document.querySelector("#btn-pack-queue").click());
  await sleep(300);
  eq(await page.evaluate(() => document.querySelector("#pack-queue").textContent.includes("Blooming Mirrors")), true, "(b) queue holds BM-6 before hide");
  const hctx = await newContext();
  const hpage = await hctx.newPage();
  hpage.on("dialog", d => d.accept());
  await hpage.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await hpage.setRequestInterception(true);
  hpage.on("request", mockHandler);
  await hpage.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
  await hpage.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  await goSettings(hpage);
  await hpage.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click());
  await sleep(300);
  await hpage.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-hide-toggle]').click());
  await sleep(500);
  eq(await waitPut(b => b && b.settings && b.settings.recipes && b.settings.recipes.some(r => r.id === "bm" && r.hidden), "hide"), true, "(b) hide saved (BM hidden in shared data)");
  eq(await hpage.evaluate(() => document.querySelector('[data-recipe-row="bm"]').textContent.includes("Hidden")), true, "(b) hidden craft shows Hidden badge");
  await hpage.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  eq(await hpage.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors"))), false, "(b) hidden craft absent from Pack picker");
  await hpage.evaluate(() => document.querySelector('[data-tab="bulk"]').click());
  await sleep(200);
  eq(await hpage.evaluate(() => [...document.querySelectorAll("#bulk-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors"))), false, "(b) hidden craft absent from Bulk picker");
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 5, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { window.print = () => {}; });
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors"))), false, "(b) reloaded picker still lacks hidden BM");
  eq(await page.evaluate(() => document.querySelector("#pack-queue").textContent.includes("Blooming Mirrors")), true, "(b) queued BM-6 survives reload while hidden");
  await pick("Tambourines", 6);
  await page.evaluate(() => document.querySelector("#btn-pack-queue").click());
  await sleep(300);
  await page.evaluate(() => document.querySelector("#btn-queue-hand").click());
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector("#pack-queue-progress").textContent.includes("Craft 1 of 2")), true, "(b) walk starts on the hidden line (Craft 1 of 2)");
  async function finishWalkLine() {
    await page.evaluate(() => document.querySelector("#btn-check-all").click());
    await sleep(300);
    await page.evaluate(() => document.querySelector("#sheet-primary").click());
    await sleep(300);
    await page.evaluate(() => document.querySelector("#btn-complete-pack").click());
    await sleep(300);
    await confirmIfOpen(page);
  }
  await finishWalkLine();
  eq(await page.evaluate(() => document.querySelector("#pack-queue-progress").textContent.includes("Craft 2 of 2")), true, "(b) walk steps to Craft 2 of 2");
  await finishWalkLine();
  eq(remote.history.some(e => e.title && e.title.includes("Blooming Mirrors") && e.title.includes("6 kits")), true, "(b) hidden craft's queued line completed (history entry)");
  eq(remote.history.some(e => e.title && e.title.includes("Tambourines") && e.title.includes("6 kits")), true, "(b) walk second line completed too");
  eq(remote.inventory["scissors"].qty, 94, "(b) hidden-line walk deducted stock (scissors 100-3-3)");
  await goSettings(hpage);
  /* Edit toggles: the hide step left BM's editor OPEN, so only click Edit
     if the hide toggle is not already showing. */
  await hpage.evaluate(() => { if (!document.querySelector('[data-recipe-row="bm"] [data-hide-toggle]')) document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click(); });
  await sleep(300);
  await hpage.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-hide-toggle]').click());
  await sleep(500);
  eq(await waitPut(b => b && b.settings && b.settings.recipes && b.settings.recipes.some(r => r.id === "bm" && !r.hidden), "unhide"), true, "(b) unhide saved");
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 6, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { window.print = () => {}; });
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors"))), true, "(b) unhidden craft back in picker");
  await hctx.close();

  /* (b4) New item at 0 and packable. Fix-round item 4: the item must
     appear in the Inventory TAB and History must refresh live, no
     reload — the old code threw in renderInventory (no row for the new
     item), aborting renderAll before History. */
  const errs4 = [];
  page.on("pageerror", e => errs4.push(e.message));
  await resetSeed();
  await goSettings(page);
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click());
  await sleep(300);
  await page.select('[data-recipe-row="bm"] [data-line-item]', '__new__');
  await sleep(300);
  eq(await page.evaluate(() => !!document.querySelector('[data-new-item-name]')), true, "(b) Create-new-item form appears");
  await page.evaluate(() => { document.querySelector('[data-new-item-name]').value = "Widget X"; document.querySelector('[data-new-item-unit]').value = "each"; });
  await page.evaluate(() => document.querySelector('[data-new-item-create]').click());
  await sleep(500);
  eq(await waitPut(b => b && b.settings && b.settings.customItems && b.settings.customItems.some(it => it.id === "widget-x"), "new item"), true, "(b) new item saved (widget-x in customItems)");
  eq(await page.evaluate(() => { const s = document.querySelector('[data-recipe-row="bm"] [data-line-item]'); return s ? s.value : null; }), "widget-x", "(b) line now uses the new item");
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); });
  await sleep(400);
  eq(errs4.length, 0, "(b) no page error after creating the item (was: renderInventory threw on the missing row)");
  eq(await page.evaluate(() => !!document.querySelector('#inventory-groups .inv-item[data-item="widget-x"]')), true, "(b) new item appears in the Inventory tab live, no reload");
  await page.evaluate(() => { document.querySelector('[data-tab="history"]').click(); });
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector('[data-tab="history"]').classList.contains("active") && !!document.querySelector("#history-list")), true, "(b) History tab refreshes live after the new item");
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-inventory").click(); });
  await sleep(400);
  const invB4 = await page.evaluate(() => [...document.querySelectorAll("#print-area .print-page")].map(sec => ({
    title: sec.querySelector(".label-title") ? sec.querySelector(".label-title").textContent : "",
    rows: [...sec.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()))
  })));
  const bmGroup = invB4.find(s => s.title === "Blooming Mirrors");
  eq(bmGroup && bmGroup.rows.some(r => r[0] === "Widget X (each)" && r[1] === "0"), true, "(b) new item at 0 with unit shown");
  await page.evaluate(() => { if (document.querySelector("#delivery-entry").hidden) document.querySelector("#btn-delivery").click(); });
  await sleep(250);
  await page.evaluate(() => { document.querySelector('#delivery-entry-list input[data-item="widget-x"]').value = "100"; });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await confirmIfOpen(page);
  await sleep(300);
  rows = await (async () => { await pick("Blooming Mirrors", 6); return printSheet(); })();
  eq(qtyOf(rows, "Widget X"), "6", "(b) new item packs (BM-6 Widget X 6)");
  eq(remote.inventory["widget-x"].qty, 94, "(b) new-item pack deducted stock");
  await goSettings(page);
  /* Same toggle hazard as the unhide step: BM's editor stayed open through
     the print/delivery steps, so only click Edit if it is not already open. */
  await page.evaluate(() => { if (!document.querySelector('[data-recipe-row="bm"] [data-line-remove]')) document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click(); });
  await sleep(300);
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-line-remove]').click());
  await sleep(500);
  eq(await waitPut(b => b && b.settings && b.settings.recipes && !b.settings.recipes.find(r => r.id === "bm").lines.some(ln => ln.item === "widget-x"), "line removed"), true, "(b) removing the line saved");
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-inventory").click(); });
  await sleep(400);
  const invB4b = await page.evaluate(() => [...document.querySelectorAll("#print-area .print-page")].map(sec => ({
    title: sec.querySelector(".label-title") ? sec.querySelector(".label-title").textContent : "",
    rows: [...sec.querySelectorAll("tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()))
  })));
  const addedB4 = invB4b.find(s => s.title === "Added items");
  /* Stock is 94 here, not 0: the delivery stocked 100 and the pack took 6.
     Removing the line leaves the inventory row (no item delete in v1). */
  eq(addedB4 && addedB4.rows.some(r => r[0] === "Widget X (each)" && r[1] === "94"), true, "(b) unused custom item lands in Added items (stock kept)");

  /* Label-fit warning (item-11 decision, part B6): as the new-item name
     is typed, a too-long name warns "Too long for the label, about N
     characters over", a fitting name shows none, and saving a too-long
     name still works (the warning never blocks). Setting .value
     programmatically fires no input event, so dispatch one after each
     set — otherwise the warning never updates. The following (b5) block
     fully resets the seed, so no cleanup is needed here. */
  await resetSeed();
  await goSettings(page);
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click());
  await sleep(300);
  await page.select('[data-recipe-row="bm"] [data-line-item]', '__new__');
  await sleep(300);
  eq(await page.evaluate(() => !!document.querySelector('[data-new-item-name]')), true, "(label-fit) create-new-item form appears");
  await page.evaluate(() => { const el = document.querySelector('[data-new-item-name]'); el.value = "Extraordinarily long test item name here"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(300);
  eq(await page.evaluate(() => { const w = document.querySelector('[data-label-fit]'); return !!w && !w.hidden && w.textContent.includes("Too long for the label"); }), true, "(label-fit) too-long name shows the label warning");
  eq(await page.evaluate(() => { const w = document.querySelector('[data-label-fit]'); return !!w && /about \d+ character/.test(w.textContent); }), true, "(label-fit) warning names how many characters over");
  await page.evaluate(() => { const el = document.querySelector('[data-new-item-name]'); el.value = "Widget Y"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await sleep(300);
  eq(await page.evaluate(() => { const w = document.querySelector('[data-label-fit]'); return !w || w.hidden; }), true, "(label-fit) fitting name shows no label warning");
  await page.evaluate(() => { const el = document.querySelector('[data-new-item-name]'); el.value = "Extraordinarily long test item name here"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.evaluate(() => document.querySelector('[data-new-item-create]').click());
  await sleep(500);
  eq(await waitPut(b => b && b.settings && b.settings.customItems && b.settings.customItems.some(it => it.id === "extraordinarily-long-test-item-name-here"), "long name saved"), true, "(label-fit) saving a too-long name still works");

  /* (b5) No one-label warning any more (layout task: the warning is
     removed — a long recipe simply flows) + line/pair add + dup
     validation + rename. */
  const tenLines = ["tree-mirror", "scissors", "heat-gun", "wood-burning-cream", "clay-tray-a", "clay-tray-b", "cake-box", "tambourines", "white-clay", "english-ay-printout"].map(id => ({ item: id, qty: 6, per: 6 }));
  remote.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: {},
    recipes: L.builtInRecipes().concat([
      { id: "ten-line", code: "TEN", name: "Ten Line", hidden: false, lines: tenLines },
      { id: "nine-line", code: "NIN", name: "Nine Line", hidden: false, lines: tenLines.slice(0, 9) } ]), customItems: [] };
  Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
  remote.history = [];
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll("#pack-crafts .craft-btn").length === 8, { timeout: 15000 });
  await sleep(300);
  await page.evaluate(() => { window.print = () => {}; });
  await goSettings(page);
  await page.evaluate(() => document.querySelector('[data-recipe-row="ten-line"] [data-recipe-edit]').click());
  await sleep(300);
  eq(await page.evaluate(() => !!document.querySelector('[data-recipe-row="ten-line"] [data-recipe-warning]')), false, "(b) editor never warns above the max (10 lines, warning removed)");
  await page.evaluate(() => document.querySelector('[data-recipe-row="nine-line"] [data-recipe-edit]').click());
  await sleep(300);
  eq(await page.evaluate(() => !!document.querySelector('[data-recipe-row="nine-line"] [data-recipe-warning]')), false, "(b) editor never warns at exactly the max (9 lines)");
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click());
  await sleep(300);
  const lineCount = async () => await page.evaluate(() => document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]').length);
  const bmLines0 = await lineCount();
  const puts0 = putCount;
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-add-line]').click());
  await sleep(500);
  eq(await lineCount(), bmLines0 + 1, "(b) Add line appends a row");
  eq(putCount, puts0 + 1, "(b) Add line saves immediately");
  const newRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')];
    const last = rows[rows.length - 1];
    return { qty: last.querySelector("[data-line-qty]").value, per: last.querySelector("[data-line-per]").value };
  });
  eq(newRow, { qty: "1", per: "6" }, "(b) new line defaults qty 1 per 6");
  /* Fix-round item 15: the new row is EMPTY — you must choose an item,
     and editing it before choosing errors instead of saving. */
  const newRowSel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')];
    const last = rows[rows.length - 1];
    const sel = last.querySelector("[data-line-item]");
    return { value: sel.value, first: sel.options[0].textContent };
  });
  eq(newRowSel, { value: "", first: "Choose an item…" }, "(b) new line is an empty row you must choose");
  const puts15 = putCount;
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')];
    const inp = rows[rows.length - 1].querySelector("[data-line-qty]");
    inp.value = "2";
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent), "Every line needs an item.", "(b) editing an unchosen row errors");
  eq(putCount, puts15, "(b) unchosen-row edit saves nothing");
  const puts1 = putCount;
  const setLastLineItem = async (val) => {
    await page.evaluate((v) => {
      const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')];
      const sel = rows[rows.length - 1].querySelector("[data-line-item]");
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, val);
  };
  await setLastLineItem('tree-mirror');
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent !== ""), true, "(b) duplicate item in one craft blocked");
  eq(putCount, puts1, "(b) blocked edit saves nothing");
  await setLastLineItem('cake-box');
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent), "", "(b) fixing the duplicate clears the error");
  eq(putCount, puts1 + 1, "(b) fixed edit saves");
  const puts2 = putCount;
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-add-pair]').click());
  await sleep(500);
  eq(await page.evaluate(() => !!document.querySelector('[data-recipe-row="bm"] [data-line-item2]')), true, "(b) Add pair appends a two-select row");
  eq(putCount, puts2 + 1, "(b) Add pair saves immediately");
  const puts3 = putCount;
  await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')]; rows[rows.length - 1].querySelector("[data-line-remove]").click(); });
  await sleep(500);
  eq(await lineCount(), bmLines0 + 1, "(b) Remove line drops the row");
  eq(putCount, puts3 + 1, "(b) Remove line saves immediately");
  /* Fix-round item 16: the removal toast's UNDO restores the exact row. */
  await page.evaluate(() => { const b = document.querySelector("#toast button"); if (b) b.click(); });
  await sleep(500);
  eq(await lineCount(), bmLines0 + 2, "(b) Undo restores the removed row");
  eq(await page.evaluate(() => !!document.querySelector('[data-recipe-row="bm"] [data-line-item2]')), true, "(b) Undo restores the pair row itself");
  eq(putCount, puts3 + 2, "(b) Undo restore saves");
  await page.evaluate(() => { const inp = document.querySelector('[data-recipe-row="bm"] [data-recipe-name]'); inp.value = "Blooming Mirrors X"; inp.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(500);
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors X"))), true, "(b) rename shows in the picker");

  /* Fix-round batch (a) item 5: duplicate names blocked. */
  const puts4 = putCount;
  await page.evaluate(() => { document.querySelector("#recipe-add-name").value = "blooming mirrors x"; document.querySelector("#recipe-add-code").value = "ZZ"; document.querySelector("#recipe-add-btn").click(); });
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector("#recipe-add-error").textContent.includes("already exists")), true, "(b) duplicate craft name (case-insensitive) blocked");
  eq(putCount, puts4, "(b) blocked craft add saves nothing");
  await page.evaluate(() => { const inp = document.querySelector('[data-recipe-row="bm"] [data-recipe-name]'); inp.value = "Tambourines"; inp.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(500);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent.includes("already exists")), true, "(b) rename onto another craft's name blocked");
  eq(putCount, puts4, "(b) blocked rename saves nothing");
  await page.evaluate(() => { const inp = document.querySelector('[data-recipe-row="bm"] [data-recipe-name]'); inp.value = "Blooming Mirrors X"; inp.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(500);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent), "", "(b) restoring the name clears the error");
  /* The restore is a no-change edit (the stored name was already X), so
     saveData's diffAction correctly issues NO put — the render still
     clears the error. Count it here, not at the end. */
  eq(putCount, puts4, "(b) restoring the same name saves nothing (no-change no-op)");
  await page.select('[data-recipe-row="bm"] [data-line-item]', '__new__');
  await sleep(300);
  await page.evaluate(() => { document.querySelector('[data-new-item-name]').value = "AY - Special Request"; document.querySelector('[data-new-item-unit]').value = ""; });
  await page.evaluate(() => document.querySelector('[data-new-item-create]').click());
  await sleep(500);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent.includes("already exists")), true, "(b) duplicate item name blocked even when its slug differs (AY - Special Request)");
  eq(putCount, puts4, "(b) blocked item saves nothing (restore above was already a no-change no-op)");

  /* Fix-round batch (a) item 6: recipe qty/per capped at 999. */
  const puts5 = putCount;
  const setLastQty = async (v) => { await page.evaluate((x) => { const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')]; const i = rows[rows.length - 1].querySelector("[data-line-qty]"); i.value = x; i.dispatchEvent(new Event("change", { bubbles: true })); }, v); await sleep(400); };
  await setLastQty("1000");
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent.includes("999")), true, "(b) recipe qty over 999 blocked");
  eq(putCount, puts5, "(b) blocked qty saves nothing");
  await setLastQty("6.5");
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent !== ""), true, "(b) decimal qty blocked");
  eq(putCount, puts5, "(b) blocked decimal saves nothing");
  await setLastQty("6");
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent), "", "(b) valid qty clears the error");
  eq(putCount, puts5 + 1, "(b) valid qty saves");
  await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-recipe-row="bm"] [data-recipe-line]')]; const i = rows[rows.length - 1].querySelector("[data-line-per]"); i.value = "0"; i.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-error]').textContent !== ""), true, "(b) per 0 blocked");
  eq(putCount, puts5 + 1, "(b) blocked per saves nothing");

  /* (b6) Rename keeps old history titles. */
  await resetSeed();
  rows = await (async () => { await pick("Blooming Mirrors", 6); await page.evaluate(() => document.querySelector("#btn-pack-hand").click()); await sleep(300); return null; })();
  await page.evaluate(() => document.querySelector("#btn-check-all").click());
  await sleep(300);
  await page.evaluate(() => document.querySelector("#sheet-primary").click());
  await sleep(300);
  await page.evaluate(() => document.querySelector("#btn-complete-pack").click());
  await sleep(300);
  await confirmIfOpen(page);
  eq(remote.history[0] && remote.history[0].title, "Hand packed Blooming Mirrors — 6 kits (BM-6)", "(b) hand-pack entry title before rename");
  await goSettings(page);
  await page.evaluate(() => document.querySelector('[data-recipe-row="bm"] [data-recipe-edit]').click());
  await sleep(300);
  await page.evaluate(() => { const inp = document.querySelector('[data-recipe-row="bm"] [data-recipe-name]'); inp.value = "Blooming Mirrors Renamed"; inp.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(500);
  eq(remote.history[0] && remote.history[0].title, "Hand packed Blooming Mirrors — 6 kits (BM-6)", "(b) old history title unchanged after rename");
  eq(await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].some(b => b.textContent.includes("Blooming Mirrors Renamed"))), true, "(b) renamed craft shows new name in picker");

  /* Fix-round batch (a) item 6: delivery skips non-whole / huge counts. */
  await resetSeed();
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); });
  await sleep(300);
  await page.evaluate(() => { if (document.querySelector("#delivery-entry").hidden) document.querySelector("#btn-delivery").click(); });
  await sleep(250);
  await page.evaluate(() => {
    document.querySelector('#delivery-entry-list input[data-item="scissors"]').value = "6.5";
    document.querySelector('#delivery-entry-list input[data-item="tambourines"]').value = "100000";
    document.querySelector('#delivery-entry-list input[data-item="white-clay"]').value = "10";
  });
  await page.click("#btn-apply-delivery");
  await sleep(250);
  await confirmIfOpen(page);
  await sleep(300);
  eq(remote.inventory["scissors"].qty, 100, "(b) delivery decimal skipped (was 6.5, not 6)");
  eq(remote.inventory["tambourines"].qty, 100, "(b) delivery huge count skipped");
  eq(remote.inventory["white-clay"].qty, 110, "(b) delivery valid line still saves");

  /* ---- (c) History snapshot + reprint/effect freeze ---- */
  /* Seed a one-line custom craft + custom item, pack it, rename the
     item (mock-side, as a rename would land in customItems), and prove
     the old entry keeps the old name everywhere while a new pack uses
     the new name. */
  remote.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: {},
    recipes: [{ id: "snap", code: "SNP", name: "Snap Test", hidden: false, lines: [{ item: "test-widget", qty: 6, per: 6 }] }],
    customItems: [{ id: "test-widget", name: "Test Widget", unit: "each" }] };
  Object.keys(remote.inventory).forEach(k => { remote.inventory[k] = { qty: 100, threshold: null }; });
  remote.inventory["test-widget"] = { qty: 100, threshold: null };
  remote.history = [];
  await load(1);
  await pick("Snap Test", 6);
  await printSheet(); /* single print -> "packed" entry with snapshot */
  eq(remote.history[0] && remote.history[0].recipe && remote.history[0].recipe[0] && remote.history[0].recipe[0].name, "Test Widget", "(c) snapshot stores the name at pack time");
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  eq(await page.evaluate(() => document.querySelector(".history-entry .history-effects")?.textContent.includes("Test Widget")), true, "(c) effect list shows the packed name");
  /* Rename the item, reload, and prove the old entry is frozen. */
  remote.settings.customItems[0].name = "Renamed Widget";
  await load(1);
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  eq(await page.evaluate(() => document.querySelector(".history-entry .history-effects")?.textContent.includes("Test Widget")), true, "(c) effect list keeps the old name after rename");
  eq(await page.evaluate(() => document.querySelector(".history-entry .history-effects")?.textContent.includes("Renamed Widget")), false, "(c) effect list does not pick up the new name");
  /* Reprint shows the old name. */
  await page.evaluate(() => document.querySelector(".history-entry .btn-reprint").click());
  await sleep(400);
  eq(await page.evaluate(() => document.querySelector("#print-area").textContent.includes("Test Widget")), true, "(c) reprint keeps the old name after rename");
  eq(await page.evaluate(() => document.querySelector("#print-area").textContent.includes("Renamed Widget")), false, "(c) reprint does not pick up the new name");
  /* A new pack uses the new name. */
  await pick("Snap Test", 6);
  await printSheet();
  eq(remote.history[0] && remote.history[0].recipe && remote.history[0].recipe[0].name, "Renamed Widget", "(c) new pack snapshots the new name");
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  eq(await page.evaluate(() => document.querySelector(".history-entry .history-effects")?.textContent.includes("Renamed Widget")), true, "(c) new entry effect list shows the new name");

  /* ---- Retest item 8: snapshot reprint Per-6 comes from the snapshot ---- */
  /* Change the recipe quantity, reload, and reprint the OLD entry: its
     Per-6 and total must still match what was packed, not the new rate. */
  remote.settings.recipes[0].lines[0].qty = 12;
  await load(1);
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(300);
  await page.evaluate(() => document.querySelectorAll(".history-entry .btn-reprint")[1].click());
  await sleep(400);
  const snapRows = await page.evaluate(() => {
    return [...document.querySelectorAll("#print-area tbody tr")].map(tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim()));
  });
  const snapOldRow = snapRows.find(r => r[1] === "Test Widget");
  eq(!!snapOldRow, true, "item8: old entry reprints its row");
  eq(snapOldRow && snapOldRow[2], "6", "item8: old reprint Per-6 comes from the snapshot (6, not 12)");
  eq(snapOldRow && snapOldRow[3], "6", "item8: old reprint total matches what was packed");
  /* A new pack uses the new rate for both Per-6 and total. */
  await pick("Snap Test", 6);
  const snapNewRows = await printSheet();
  const snapNewRow = snapNewRows.find(r => r[1] === "Renamed Widget");
  eq(!!snapNewRow, true, "item8: new pack prints its row");
  eq(snapNewRow && snapNewRow[2], "12", "item8: new pack Per-6 uses the new rate");
  eq(snapNewRow && snapNewRow[3], "12", "item8: new pack total uses the new rate");

  /* ---- (d) Clay rename fits one line on the BM label ---- */
  await resetSeed();
  await pick("Blooming Mirrors", 6);
  await printSheet();
  await page.pdf({ path: "/tmp/alooma-recipes-clay.pdf", preferCSSPageSize: true, printBackground: true });
  const clayDoc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync("/tmp/alooma-recipes-clay.pdf")) }).promise;
  /* "Clay Tray" is unique to the renamed item — plain "Clay" would also
     match BM's "White Clay" row. */
  const clayItems = (await (await clayDoc.getPage(1)).getTextContent()).items.filter(it => it.str.includes("Clay Tray"));
  eq(clayItems.length, 1, "(d) Clay name is one unbroken line on the BM label");
  eq(clayItems[0] && clayItems[0].str, "Clay Tray + 6 Picks", "(d) BM label shows the renamed Clay item");

  console.log(fail ? "RECIPE TESTS FAILED (" + fail + ")" : "all recipe tests passed (" + pass + " checks)");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
