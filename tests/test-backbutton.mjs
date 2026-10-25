/* Batch C item 15: each tab is a history step (#pack, #bulk, …) so the
   phone Back button goes to the previous tab. Tab clicks pushState;
   Back/forward routes through the A3 leave rule; Stay restores the
   history position (forward); Discard switches without adding an entry.
   Failing-first: on old code there is no hash at all, so every hash
   assert below fails. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");
const PORT = 8918;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function check(ok, label) { if (!ok) { fails++; console.log("Z FAIL " + label); } else console.log("ok " + label); }
function eq(a, b, label) { check(a === b, label + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

let remote;
function resetRemote() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
  base.history = [];
  for (const k of Object.keys(base.inventory)) base.inventory[k].qty = 100;
  base.settings = { features: { boxes: false, bins: false, bulkTab: true }, boxes: [], boxRules: [], bins: [] };
  remote = base;
}
resetRemote();

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) { res.writeHead(404); return res.end(); }
  let p = path.join(ROOT, req.url.split("?")[0].replace(/^\/+/, ""));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(ROOT, "index.html");
  const ext = path.extname(p);
  const type = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(p).pipe(res);
});

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=390,664"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 664 });
page.on("dialog", (d) => d.accept());
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (url.startsWith("https://api.github.com")) {
    if (req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }, body: "" });
    }
    if (req.method() === "GET") {
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ sha: "testsha", content: Buffer.from(JSON.stringify(remote, null, 2)).toString("base64") }) });
    }
    return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ content: { sha: "testsha2" } }) });
  }
  req.continue();
});
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
});

try {
  await new Promise((r) => server.listen(PORT, r));

  /* 1: initial load reads a valid hash. */
  await page.goto("http://127.0.0.1:" + PORT + "/index.html#history", { waitUntil: "load" });
  await sleep(800);
  eq(await page.$eval("#tab-history", (el) => el.classList.contains("active")), true, "1: #history load opens the History tab");
  eq(await page.evaluate(() => location.hash), "#history", "1: hash stays #history after load");

  /* 2: tab clicks pushState, one entry each. */
  const len0 = await page.evaluate(() => history.length);
  await page.click('[data-tab="pack"]');
  await sleep(400);
  eq(await page.evaluate(() => location.hash), "#pack", "2: pack click sets #pack");
  await page.click('[data-tab="inventory"]');
  await sleep(400);
  eq(await page.evaluate(() => location.hash), "#inventory", "2: inventory click sets #inventory");
  await page.click('[data-tab="history"]');
  await sleep(400);
  eq(await page.evaluate(() => location.hash), "#history", "2: history click sets #history");
  eq(await page.evaluate(() => history.length), len0 + 3, "2: three clicks add three history entries");

  /* 3: Back walks back through the tabs. */
  await page.goBack();
  await sleep(400);
  eq(await page.$eval("#tab-inventory", (el) => el.classList.contains("active")), true, "3: first Back lands on Inventory");
  eq(await page.evaluate(() => location.hash), "#inventory", "3: hash back to #inventory");
  await page.goBack();
  await sleep(400);
  eq(await page.$eval("#tab-pack", (el) => el.classList.contains("active")), true, "3: second Back lands on Pack");
  eq(await page.evaluate(() => location.hash), "#pack", "3: hash back to #pack");
  await page.goBack();
  await sleep(400);
  eq(await page.$eval("#tab-history", (el) => el.classList.contains("active")), true, "3: third Back lands on History");
  eq(await page.evaluate(() => location.hash), "#history", "3: hash back to #history");
  eq(await page.evaluate(() => history.length), len0 + 3, "3: Back navigation adds no entries");

  /* 4: Back with unsaved state prompts; Stay restores tab AND hash. */
  await page.click('[data-tab="pack"]');
  await sleep(400);
  const len1 = await page.evaluate(() => history.length);
  await page.evaluate(() => document.querySelector('#pack-crafts .craft-btn[data-craft="bm"]').click());
  await page.evaluate(() => document.querySelector('#pack-chips .kits-chip[data-kits="6"]').click());
  await sleep(300);
  await page.goBack();
  await sleep(400);
  eq(await page.evaluate(() => !document.querySelector("#sheet-backdrop").hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes"), true, "4: Back with a pick opens the leave prompt");
  eq(await page.$eval("#tab-pack", (el) => el.classList.contains("active")), true, "4: prompt leaves the tab on Pack");
  /* Guarded: on old code no prompt opens, so the Stay click must not crash. */
  if (await page.evaluate(() => !document.querySelector("#sheet-backdrop").hidden)) await page.click("#sheet-primary"); /* Stay and finish */
  await sleep(400);
  eq(await page.$eval("#tab-pack", (el) => el.classList.contains("active")), true, "4: Stay keeps Pack");
  eq(await page.evaluate(() => location.hash), "#pack", "4: Stay restores the hash to #pack");
  eq(await page.evaluate(() => history.length), len1, "4: Stay adds no history entry");
  eq(await page.evaluate(() => document.querySelectorAll('#pack-crafts .craft-btn.selected').length), 1, "4: Stay keeps the pick");

  /* 5: Back again, Discard switches without pushing. */
  await page.goBack();
  await sleep(400);
  eq(await page.evaluate(() => !document.querySelector("#sheet-backdrop").hidden && document.querySelector("#sheet-title").textContent === "Unsaved changes"), true, "5: second Back prompts again");
  /* Guarded: same old-code crash guard as section 4. */
  if (await page.evaluate(() => !document.querySelector("#sheet-backdrop").hidden)) await page.click("#sheet-cancel"); /* Discard */
  await sleep(400);
  eq(await page.$eval("#tab-history", (el) => el.classList.contains("active")), true, "5: Discard switches to History");
  eq(await page.evaluate(() => location.hash), "#history", "5: Discard lands on #history");
  eq(await page.evaluate(() => history.length), len1, "5: Discard adds no history entry");
  eq(await page.evaluate(() => document.querySelectorAll('#pack-crafts .craft-btn.selected').length), 0, "5: Discard clears the pick");

  /* 6: an invalid hash is ignored, not routed. */
  await page.evaluate(() => { location.hash = "nope"; });
  await sleep(400);
  eq(await page.$eval("#tab-history", (el) => el.classList.contains("active")), true, "6: invalid hash leaves the tab on History");
  await page.evaluate(() => { location.hash = "history"; });
  await sleep(400);
  eq(await page.$eval("#tab-history", (el) => el.classList.contains("active")), true, "6: returning to #history stays on History");

  if (fails) { console.log("Z BACKBUTTON TESTS FAILED (" + fails + ")"); process.exit(1); }
  console.log("Z BACKBUTTON TESTS PASSED");
} finally {
  await browser.close();
  server.close();
}
