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
/* The repo's data.json is the user's LIVE data — reset to a known blank
   state before applying the seeds below */
Object.keys(remoteData.inventory).forEach(k => { remoteData.inventory[k] = { qty: 0, threshold: null }; });
remoteData.history = [];
delete remoteData.settings;
remoteData.inventory["scissors"] = { qty: 200, threshold: 250 };
remoteData.inventory["tree-mirror"] = { qty: 5, threshold: null };
remoteData.settings = {
  features: { boxes: true, bins: true, bulkTab: true },
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
/* v2 A6: the app must never fall back to the phone's own pop-ups */
const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
ok(!appSrc.includes("window.confirm("), "v2 A6: no window.confirm left in app.js");
ok(!appSrc.includes("window.prompt("), "v2 A6: no window.prompt left in app.js");
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
        /* Content inside a sideways-scrolling row (the v2 B2 filter chips)
           is SUPPOSED to extend past the edge — it is clipped by its
           scroller, which must itself be in bounds. The page-level
           scrollWidth check above still catches real sideways scroll. */
        let sc = el.parentElement, clipped = false;
        while (sc && sc !== document.body) {
          const ox = getComputedStyle(sc).overflowX;
          if (ox === "auto" || ox === "scroll") {
            const sr = sc.getBoundingClientRect();
            if (sr.left >= -1 && sr.right <= W + 1) clipped = true;
            break;
          }
          sc = sc.parentElement;
        }
        if (clipped) return;
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
  /* A3: a tab switch with anything chosen or unsaved opens the "Unsaved
     changes" prompt instead of switching. The audit always takes Discard:
     the dirty state at its switches (queued Bulk lines left after a Record
     sheet was measured, never confirmed) is intentionally abandoned, and
     the tour must reach the tab it is measuring. */
  const tab = async name => {
    await page.evaluate(n => document.querySelector('[data-tab="' + n + '"]').click(), name);
    await sleep(250);
    const prompt = await page.$eval("#sheet-backdrop", e => !e.hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes").catch(() => false);
    if (prompt) { await page.click("#sheet-cancel"); await sleep(250); }
  };
  const pickCraft = async (grid, text) => page.evaluate((g, t) => [...document.querySelectorAll(g + " .craft-btn")].find(b => b.textContent.includes(t)).click(), grid, text);
  /* The audit measures GEOMETRY; the UI suite already proves real clicks.
     Drive state changes with DOM clicks (scrolling into view first) so a
     below-the-fold button can't crash the tour before it measures. */
  const clickEl = async sel => {
    await page.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) throw new Error("missing element " + s);
      el.scrollIntoView({ block: "center" });
      el.click();
    }, sel);
    await sleep(150);
  };

  for (const width of [360, 390]) {
    await page.setViewport({ width, height: 844 });
    await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(400);
    /* View-only pass: Inventory + History + the Print menu (reachable view-only) */
    await check(width + " view-only: inventory");
    /* v3 D6: for viewers the Print button lives in the chip row, and the
       first stock row starts higher without the empty action row */
    const voWrap = await page.evaluate(() => document.querySelector(".print-menu-wrap").parentElement.className);
    ok(voWrap.includes("inv-filters"), "v3 D6: view-only Print sits in the chip row at " + width);
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
    const voTop = await page.evaluate(() => { const el = document.querySelector(".inv-item"); return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1; });
    console.log("v3 D6 view-only first row at", width, "=", voTop);
    ok(voTop > 0 && voTop <= 300, "v3 D6: view-only first row at/above 300 at " + width + " (saw " + voTop + ")");
    await clickEl("#btn-print-menu"); await sleep(200);
    await check(width + " view-only: print menu open");
    await page.evaluate(() => document.body.click()); await sleep(150);
    await tab("history");
    await check(width + " view-only: history");
    /* Connect (real path: badge -> Settings -> token) */
    await clickEl("#conn-badge"); await sleep(200);
    await page.type("#gh-token", "fake-token-for-test");
    await clickEl("#btn-connect"); await sleep(700);
    await check(width + " editor: settings after connect");
    /* Packing states */
    await tab("pack");
    await check(width + " pack: empty");
    if (width === 360) {
      /* v2 B3: at 360x780 the craft cards AND the kit chips are on screen together */
      await page.setViewport({ width: 360, height: 780 });
      await sleep(250);
      await page.evaluate(() => window.scrollTo(0, 0));
      const fit = await page.evaluate(() => {
        const chips = document.querySelector("#pack-chips").getBoundingClientRect();
        const cards = document.querySelector("#pack-crafts").getBoundingClientRect();
        return { chipsBottom: Math.round(chips.bottom), cardsBottom: Math.round(cards.bottom) };
      });
      console.log("v2 B3 at 360x780: cards bottom", fit.cardsBottom, "| chips bottom", fit.chipsBottom);
      ok(fit.cardsBottom <= 780 && fit.chipsBottom <= 780, "v2 B3: craft cards + kit chips fit at 360x780 (chips bottom " + fit.chipsBottom + ")");
      await page.setViewport({ width: 360, height: 844 });
      await sleep(150);
    }
    await pickCraft("#pack-crafts", "The Cakery");
    await clickEl('.kits-chip[data-for="pack"][data-kits="12"]');
    await sleep(250);
    await check(width + " pack: CAK-12 chosen, no path yet");
    await clickEl("#btn-pack-hand"); await sleep(250);
    await check(width + " pack: hand path checklist");
    if (width === 390) {
      /* v2 B1: with the checklist scrolled into work position, at least 5
         rows must be fully visible above the tab bar + sticky action bar */
      await page.evaluate(() => document.querySelector("#pack-checklist").scrollIntoView());
      await sleep(200);
      const visRows = await page.evaluate(() => {
        const limit = window.innerHeight - 140;
        return [...document.querySelectorAll("#pack-table tbody tr")].filter(tr => { const r = tr.getBoundingClientRect(); return r.top >= 0 && r.bottom <= limit; }).length;
      });
      console.log("v2 B1 visible rows at 390x844:", visRows);
      ok(visRows >= 5, "v2 B1: at least 5 pack rows visible at 390x844 (saw " + visRows + ")");
    }
    /* A4: Print completes the order (and clears the pick) — it runs last
       here so the checklist measurements above see the live order. A short
       order asks "Print anyway" first. */
    await clickEl("#btn-pack-print"); await sleep(250);
    const printSheetOpen = await page.$eval("#sheet-backdrop", e => !e.hidden).catch(() => false);
    if (printSheetOpen) { await clickEl("#sheet-primary"); await sleep(250); }
    await check(width + " pack: print path (sheet printed + order completed)");
    await clickEl("#btn-check-all"); await sleep(200);
    await clickEl("#sheet-primary"); await sleep(200); /* v2 A5: confirm the check-all */
    await clickEl("#btn-complete-pack"); await sleep(300);
    await check(width + " pack: confirm sheet open");
    await page.evaluate(() => document.querySelector("#sheet-cancel").click()); await sleep(250);
    /* Bulk states */
    await tab("bulk");
    await check(width + " bulk: empty");
    await pickCraft("#bulk-crafts", "Blooming");
    await clickEl('.kits-chip[data-for="bulk"][data-kits="36"]');
    await clickEl("#btn-bulk-add"); await sleep(250);
    await pickCraft("#bulk-crafts", "Hafrashat");
    await clickEl('.kits-chip[data-for="bulk"][data-kits="36"]');
    await clickEl("#btn-bulk-add"); await sleep(250);
    await check(width + " bulk: two queued orders");
    /* v2 B4: the queued-order remove button is a real 44px target and the Record bar sticks */
    const rmSize = await page.evaluate(() => { const b = document.querySelector("#bulk-lines [data-remove]"); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    ok(rmSize.w >= 44 && rmSize.h >= 44, "v2 B4: queued-order remove button is at least 44px (" + rmSize.w + "x" + rmSize.h + ")");
    const bulkSticky = await page.evaluate(() => getComputedStyle(document.querySelector("#tab-bulk .action-bar")).position);
    ok(bulkSticky === "sticky", "v2 B4: Bulk Record bar is sticky (position=" + bulkSticky + ")");
    await clickEl("#btn-bulk-record"); await sleep(300);
    await check(width + " bulk: confirm sheet open");
    await page.evaluate(() => document.querySelector("#sheet-cancel").click()); await sleep(250);
    /* Inventory states */
    await tab("inventory");
    await check(width + " inventory: list");
    /* v2 B2: stock starts near the top — first row at/above the target */
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100);
    const invTop = await page.evaluate(() => { const el = document.querySelector(".inv-item"); return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1; });
    console.log("v2 B2 first inventory row top at", width, "=", invTop);
    /* The brief's 300 target didn't reconcile with its own changes (489 -> 363);
       the user's pick 2026-10-23: drop the Inventory title too and accept ~331.
       v3 E2 then added the Reorder button row above the list (user-approved
       in the v3 brief), which costs its ~58px: bound is 340 + 58, and the
       measured value is reported in every batch report. */
    ok(invTop > 0 && invTop <= 398, "v2 B2 + v3 E2: first inventory row at/above 398 at " + width + "px (saw " + invTop + ")");
    /* v3 D2 + D6: the editor action row is exactly 48 and Print is back in it */
    const actH = await page.evaluate(() => Math.round(document.querySelector(".inv-actions").getBoundingClientRect().height));
    ok(actH === 48, "v3 D2: inventory action row is 48px at " + width + " (saw " + actH + ")");
    const edWrap = await page.evaluate(() => document.querySelector(".print-menu-wrap").parentElement.className);
    ok(edWrap.includes("inv-actions"), "v3 D6: editor Print sits in the action row at " + width);
    await clickEl("#btn-print-menu"); await sleep(200);
    await check(width + " inventory: print menu open");
    await clickEl("#btn-print-menu"); await sleep(150);
    await page.evaluate(() => { const m = document.querySelector('.inv-item[data-item="colored-clay-tool-tray"] .inv-main'); if (m) m.click(); });
    await sleep(300);
    await check(width + " inventory: item panel open (longest name)");
    await clickEl("#btn-delivery"); await sleep(300);
    await check(width + " inventory: delivery form open");
    await page.evaluate(() => document.querySelector("#btn-cancel-delivery").click()); await sleep(200);
    await clickEl("#btn-enter-counts"); await sleep(300);
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
  await clickEl("#btn-print-menu"); await sleep(200);
  await check("1280 inventory: print menu open");

  /* Desktop brief item 1: tablet + desktop sizes — same no-overflow sweep,
     plus the desktop-specific promises: card never touches the edges at
     768, header contents align with the column, sheets are centred
     modals, Esc closes layers, toast sits 24px off the bottom */
  await page.evaluate(() => localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" })));
  const DSIZES = [[768, 1024], [1280, 800], [1440, 900], [1920, 1080]];
  for (const [dw, dh] of DSIZES) {
    await page.setViewport({ width: dw, height: dh });
    await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(400);
    await check(dw + " pack");
    await tab("inventory");
    await check(dw + " inventory");
    await tab("settings");
    await check(dw + " settings");
    const geo = await page.evaluate(() => {
      const m = document.querySelector("main").getBoundingClientRect();
      const b = document.querySelector(".brand").getBoundingClientRect();
      return { mainLeft: Math.round(m.left), brandLeft: Math.round(b.left), contentLeft: Math.round(m.left) + 19 };
    });
    if (dw === 768) ok(geo.mainLeft >= 10, "desktop: at 768 the card keeps side margins (mainLeft=" + geo.mainLeft + ")");
    if (dw >= 1440) ok(Math.abs(geo.brandLeft - geo.contentLeft) <= 3, "desktop: header aligns with the column at " + dw + " (brand " + geo.brandLeft + " vs content " + geo.contentLeft + ")");
    if (dw === 1280) {
      await tab("bulk");
      await pickCraft("#bulk-crafts", "Blooming");
      await page.click('.kits-chip[data-for="bulk"][data-kits="6"]');
      await clickEl("#btn-bulk-add"); await sleep(300);
      const gap = await page.evaluate(() => { const t = document.querySelector(".toast"); const r = t.getBoundingClientRect(); return Math.round(window.innerHeight - r.bottom); });
      ok(gap === 24, "desktop: toast bottom gap is 24 (saw " + gap + ")");
    }
    if (dw === 1440) {
      await tab("bulk");
      await pickCraft("#bulk-crafts", "Blooming");
      await page.click('.kits-chip[data-for="bulk"][data-kits="6"]');
      await clickEl("#btn-bulk-add"); await sleep(200);
      await clickEl("#btn-bulk-record"); await sleep(600);
      const sc = await page.evaluate(() => { const s = document.querySelector(".sheet").getBoundingClientRect(); return { cx: Math.round(s.left + s.width / 2), cy: Math.round(s.top + s.height / 2) }; });
      ok(Math.abs(sc.cx - 720) <= 5 && Math.abs(sc.cy - 450) <= 10, "desktop: sheet centred at 1440 (" + sc.cx + "," + sc.cy + ")");
      await page.keyboard.press("Escape"); await sleep(250);
      ok(await page.evaluate(() => document.querySelector("#sheet-backdrop").hidden), "desktop: Esc closes the sheet");
      await tab("inventory");
      await clickEl("#btn-print-menu"); await sleep(200);
      ok(await page.evaluate(() => !document.querySelector("#print-menu").hidden), "desktop: print menu opens");
      await page.keyboard.press("Escape"); await sleep(200);
      ok(await page.evaluate(() => document.querySelector("#print-menu").hidden), "desktop: Esc closes the print menu");
    }
  }

  /* Mark's desktop repro (2026-10-23): view-only, click Print, and the
     options menu "wouldn't show up properly" — it was clipped inside the
     scrolling chip row (overflow-x: auto clips the y axis too), where D6
     puts the button for view-only devices. Hit-testing is the honest
     check: getBoundingClientRect reports the full box even when clipped,
     while elementFromPoint only lands on an item that is really visible.
     The menu is position:fixed now, placed from the button at open time. */
  await page.evaluate(() => localStorage.removeItem("alooma.editor.v1"));
  for (const [vw2, vh2] of [[390, 844], [1440, 900]]) {
    await page.setViewport({ width: vw2, height: vh2 });
    await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
    await sleep(400);
    await tab("inventory");
    await page.click("#btn-print-menu");
    await sleep(250);
    const hit = await page.evaluate(() => {
      const menu = document.querySelector("#print-menu");
      if (menu.hidden) return { open: false, items: 0, hits: [] };
      const items = [...menu.querySelectorAll("button")];
      const hits = items.map(b => {
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el === b || b.contains(el);
      });
      return { open: true, items: items.length, hits };
    });
    ok(hit.open && hit.items >= 2 && hit.hits.every(Boolean), "print menu fully visible + hittable, view-only at " + vw2 + " (open=" + hit.open + ", hits=" + JSON.stringify(hit.hits) + ")");
    /* …and printing itself is a viewer right: both reports must build */
    await page.evaluate(() => document.querySelector("#btn-print-inventory").click());
    await sleep(300);
    ok(await page.evaluate(() => document.querySelector("#print-area").textContent.includes("Tree Mirror")), "view-only at " + vw2 + ": Inventory report builds");
    await page.click("#btn-print-menu"); await sleep(250);
    await page.evaluate(() => document.querySelector("#btn-print-count").click());
    await sleep(300);
    ok(await page.evaluate(() => document.querySelector("#print-area").textContent.includes("Counted")), "view-only at " + vw2 + ": Count sheet builds");
    await page.click("#btn-print-menu"); await sleep(150);
  }

  console.log(pass + " passed, " + fail + " failed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
