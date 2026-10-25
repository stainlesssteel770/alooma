/* A3 leave-rule tests: one rule for every tab.
   If anything is chosen or unsaved — a Pack pick, a queue, a Bulk list,
   an open inventory edit, a typed-but-unsaved Settings name — switching
   to ANY other tab asks "Discard" or "Stay and finish". Discard clears it
   all and switches; Stay keeps you there with everything exactly as it
   was. Reload follows the same rule via the browser's own prompt.
   Run: node tests/test-leaverule.mjs */
import fs from "fs";
import path from "path";
import http from "http";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8916;
let failures = 0, passes = 0;
function ok(v, name) { if (v) { passes++; } else { failures++; console.log("FAIL " + name); } }
function eq(a, b, name) { if (a === b) { passes++; } else { failures++; console.log("FAIL " + name + "\n  expected " + JSON.stringify(b) + "\n  got      " + JSON.stringify(a)); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXE = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach(k => { remote.inventory[k].qty = 100; remote.inventory[k].threshold = null; });
remote.settings = { features: { boxes: false, bins: false, bulkTab: true } };
let remoteSha = "sha-1";
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
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  let dialogs = 0;
  page.on("dialog", d => { dialogs++; d.accept(); });
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }, body: "" });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "PUT") {
        const body = JSON.parse(req.postData() || "{}");
        if (body.sha !== remoteSha) return req.respond({ status: 409, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ message: "conflict" }) });
        const data = JSON.parse(b64d(body.content));
        Object.keys(remote).forEach(k => delete remote[k]);
        Object.assign(remote, data);
        remoteSha = "sha-2";
        return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
      return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
    req.continue();
  });
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(700);
  await page.evaluate(() => { window.print = () => {}; });

  async function currentTab() { return page.$eval("#tabs button.active", e => e.getAttribute("data-tab")); }
  async function promptOpen() {
    return page.evaluate(() => {
      const bd = document.querySelector("#sheet-backdrop");
      return bd && !bd.hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes";
    });
  }
  async function promptButtons() {
    return { primary: await page.$eval("#sheet-primary", e => e.textContent), cancel: await page.$eval("#sheet-cancel", e => e.textContent) };
  }
  async function clickTab(name) { await page.click(`[data-tab="${name}"]`); await sleep(300); }
  async function stay() { await page.click("#sheet-primary"); await sleep(300); }
  async function discard() { await page.click("#sheet-cancel"); await sleep(300); }
  async function pickPack(craft, kits) {
    await page.evaluate(n => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), craft);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="pack"][data-kits="${k}"]`).click(); }, kits);
    await sleep(200);
  }
  async function pickBulk(craft, kits) {
    await page.evaluate(n => [...document.querySelectorAll("#bulk-crafts .craft-btn")].find(b => b.textContent.includes(n)).click(), craft);
    await page.evaluate(k => { document.querySelector(`.kits-chip[data-for="bulk"][data-kits="${k}"]`).click(); }, kits);
    await sleep(200);
  }

  /* ---- 0. Clean switches never prompt ---- */
  for (const t of ["bulk", "inventory", "history", "settings", "pack"]) {
    await clickTab(t);
    eq(await promptOpen(), false, "clean switch to " + t + " prompts nothing");
    eq(await currentTab(), t, "clean switch lands on " + t);
  }

  /* ---- 1. A Pack pick prompts to EVERY other tab; Stay keeps, Discard clears ---- */
  for (const target of ["bulk", "inventory", "history", "settings"]) {
    await clickTab("pack");
    await pickPack("Blooming Mirrors", 6);
    await clickTab(target);
    eq(await promptOpen(), true, "pick prompts on the way to " + target);
    eq(JSON.stringify(await promptButtons()), JSON.stringify({ primary: "Stay and finish", cancel: "Discard" }), "prompt buttons for " + target);
    await stay();
    eq(await currentTab(), "pack", "Stay keeps you on Pack (target " + target + ")");
    eq(await page.$eval("#pack-sku", e => e.textContent), "BM-6", "Stay keeps the pick (target " + target + ")");
    await clickTab(target);
    eq(await promptOpen(), true, "pick prompts again on the way to " + target);
    await discard();
    eq(await currentTab(), target, "Discard switches to " + target);
    await clickTab("pack");
    eq(await page.$eval("#pack-kits", e => e.value), "", "Discard cleared the pick (target " + target + ")");
    eq(await page.$$eval("#pack-crafts .craft-btn.selected", els => els.length), 0, "Discard cleared the craft (target " + target + ")");
  }

  /* ---- 2. A queue prompts; Stay keeps it, Discard clears it ---- */
  await pickPack("Blooming Mirrors", 6);
  await page.click("#btn-pack-queue");
  await sleep(300);
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 1, "queue: one line before the switch");
  await clickTab("inventory");
  eq(await promptOpen(), true, "queue prompts on the way out");
  await stay();
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 1, "Stay keeps the queue");
  await clickTab("inventory");
  await discard();
  eq(await currentTab(), "inventory", "Discard switches with a queue");
  await clickTab("pack");
  eq(await page.$$eval("#pack-queue .queue-line", els => els.length), 0, "Discard cleared the queue");

  /* ---- 3. A Bulk list prompts; Discard clears list + pick ---- */
  await clickTab("bulk");
  await pickBulk("Blooming Mirrors", 6);
  await page.click("#btn-bulk-add");
  await sleep(300);
  await pickBulk("Tambourines", 12);
  await clickTab("pack");
  eq(await promptOpen(), true, "bulk list prompts on the way out");
  await discard();
  eq(await currentTab(), "pack", "Discard switches with a bulk list");
  await clickTab("bulk");
  eq(await page.$$eval("#bulk-lines .hand-line", els => els.length), 0, "Discard cleared the bulk list");
  eq(await page.$eval("#bulk-kits", e => e.value), "", "Discard cleared the bulk pick");

  /* ---- 4. An open inventory count form prompts; Stay keeps the typed value ---- */
  await clickTab("inventory");
  await page.click("#btn-enter-counts");
  await sleep(300);
  await page.evaluate(() => { document.querySelector('#count-entry-list input[data-item]').value = "5"; });
  await clickTab("pack");
  eq(await promptOpen(), true, "open count form prompts on the way out");
  await stay();
  eq(await page.$eval("#count-entry", e => !e.hidden), true, "Stay keeps the count form open");
  eq(await page.$eval('#count-entry-list input[data-item]', e => e.value), "5", "Stay keeps the typed value");
  await clickTab("pack");
  await discard();
  eq(await currentTab(), "pack", "Discard switches with a count form open");
  await clickTab("inventory");
  eq(await page.$eval("#count-entry", e => e.hidden), true, "Discard closed the count form");

  /* ---- 5. A modal edit sheet blocks tab taps (see below) ---- */
  await clickTab("pack");
  await pickPack("Blooming Mirrors", 6);
  await page.click("#btn-pack-hand");
  await sleep(200);
  await page.click("#btn-check-all");
  await sleep(200);
  await page.click("#sheet-primary"); /* Mark all */
  await sleep(200);
  await page.click("#btn-complete-pack");
  await sleep(250);
  await page.click("#sheet-primary"); /* Subtract from inventory */
  await sleep(600);
  await clickTab("history");
  /* The hand-pack left its pick behind, so leaving Pack prompted — Discard
     it now; the pick is done with and History must be clean for the edit. */
  eq(await promptOpen(), true, "hand-pack pick prompts on the way to History");
  await discard();
  eq(await currentTab(), "history", "Discard switches to History after the hand-pack");
  await page.evaluate(() => document.querySelector(".history-entry .btn-edit").click());
  await sleep(300);
  const editBefore = await page.evaluate(() => ({ title: document.querySelector("#sheet-title").textContent, val: document.querySelector("#sheet-input").value }));
  await page.evaluate(() => { const i = document.querySelector("#sheet-input"); i.value = String(parseInt(i.value, 10) + 1); });
  /* ---- 5. A modal edit sheet blocks tab taps; Cancel then switches cleanly ----
     The sheet backdrop (z-80) covers the tab bar (z-50), so a tab tap with
     an edit sheet open cannot reach the button at all — there is no leave
     prompt to test here. What must hold: the switch does not happen, the
     tap dismisses the sheet (backdrop taps cancel, same as Cancel), the
     edit is not saved, and the next tap switches cleanly. */
  await clickTab("pack");
  eq(await currentTab(), "history", "edit sheet blocks the tab switch");
  eq(await page.evaluate(() => document.querySelector("#sheet-backdrop").hidden), true, "backdrop tap dismisses the edit sheet");
  eq(await page.evaluate(() => document.querySelector(".history-entry .history-title").textContent.includes("6 kits")), true, "dismissed edit is not saved");
  await clickTab("pack");
  eq(await promptOpen(), false, "no prompt after dismissing the edit");
  eq(await currentTab(), "pack", "tab switch works after dismissing the edit");

  /* ---- 6. A typed-but-unsaved Settings name prompts; a saved one does not ---- */
  await clickTab("settings");
  await page.evaluate(() => { document.querySelector("#set-packed-by").value = "Zev"; });
  await clickTab("pack");
  eq(await promptOpen(), true, "unsaved Settings name prompts on the way out");
  await discard();
  await clickTab("settings");
  eq(await page.$eval("#set-packed-by", e => e.value), "", "Discard reverts the unsaved name");
  await page.evaluate(() => { const el = document.querySelector("#set-packed-by"); el.value = "Zev"; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await sleep(200);
  await clickTab("pack");
  eq(await promptOpen(), false, "saved Settings name prompts nothing");
  eq(await currentTab(), "pack", "saved Settings name switches freely");

  /* ---- 7. Reload follows the same rule via the browser's prompt ---- */
  const dialogsBefore = dialogs;
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  eq(dialogs, dialogsBefore, "clean reload shows no browser prompt");
  await pickPack("Blooming Mirrors", 6);
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  eq(dialogs, dialogsBefore + 1, "dirty reload fires the browser's prompt once");

  console.log(failures ? "LEAVERULE TESTS FAILED (" + failures + ")" : "all leaverule tests passed (" + passes + ")");
} finally {
  await browser.close();
  server.close();
}
process.exit(failures ? 1 : 0);
