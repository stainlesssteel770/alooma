/* UI tests: drive the REAL page and REAL buttons in headless Chrome.
   The GitHub API is mocked at the network layer so editor flows (connect,
   save-per-change, disconnect) run end to end without a real token.
   Run: node tests/test-ui.mjs   (needs the steady testbed's puppeteer-core) */
import { createRequire } from "module";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const puppeteer = require("/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
const EXE = "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8907;

let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* In-memory "GitHub repo": starts as the shipped data.json */
let remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
let remoteSha = "sha-1";
let putCount = 0;
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const b64d = s => Buffer.from(s, "base64").toString("utf8");

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
await sleep(700);

const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") {
      return req.respond({ status: 204, headers: CORS, body: "" });
    }
    if (url.startsWith("https://api.github.com/user") && req.method() === "GET") {
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ login: "testeditor" }) });
    }
    if (url.includes("api.github.com/repos/") && url.includes("/contents/data.json")) {
      if (req.method() === "GET") {
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remoteData)) }) });
      }
      if (req.method() === "PUT") {
        putCount++;
        const body = JSON.parse(req.postData());
        remoteData = JSON.parse(b64d(body.content));
        remoteSha = "sha-" + (putCount + 1);
        return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      }
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, contentType: "application/json", body: "{}" });
    req.continue();
  });
  page.on("dialog", async d => { await d.accept(testDialogAnswer); });
  let testDialogAnswer = "";
  globalThis.__setDialog = v => { testDialogAnswer = v; };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(400);

  /* Viewer mode by default */
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "starts view-only");
  eq(await page.$$eval("#pack-crafts .craft-btn", els => els.length), 6, "6 craft buttons");
  eq(await page.$eval("#pack-sku", e => e.textContent), "CAK-18", "default SKU CAK-18");

  /* Pack list shows CAK-18 needs */
  await page.click("#btn-open-list");
  await sleep(200);
  const packRows = await page.$$eval("#pack-table tbody tr", trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim()).join("|")));
  eq(packRows.length, 19, "CAK pack list 19 rows");
  eq(packRows.find(r => r.includes("Heart Jewelry Box")), "|Heart Jewelry Box|18|0", "CAK18 heart box row");
  eq(packRows.find(r => r.includes("Poster stands")), "|Poster stands (for quotes)|9|0", "CAK18 poster stands row");

  /* Connect with a (mock) token */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await page.type("#gh-token", "fake-token-for-test");
  await page.click("#btn-connect");
  await sleep(600);
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "Editor — @testeditor", "connected as editor");
  const ls = await page.evaluate(() => localStorage.getItem("alooma.editor.v1"));
  eq(JSON.parse(ls).login, "testeditor", "editor saved on this device only (localStorage)");

  /* Receive: 200 scissors via the real Inventory button */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(200);
  await page.evaluate(() => {
    const row = document.querySelector('.inv-item[data-item="scissors"]');
    row.querySelector(".in-receive").value = "200";
    row.querySelector(".btn-receive").click();
  });
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 200, "receive committed to (mock) repo");
  eq(remoteData.history[0].type, "received", "receive logged in history data");

  /* Threshold: scissors low at/below 250 -> badge shows */
  await page.evaluate(() => {
    const row = document.querySelector('.inv-item[data-item="scissors"]');
    row.querySelector(".in-threshold").value = "250";
    row.querySelector(".btn-threshold").click();
  });
  await sleep(600);
  eq(await page.$$eval('.inv-item[data-item="scissors"] .low-badge', els => els.length), 1, "low-stock badge at qty<=threshold");

  /* Complete CAK-18 packing via the real button (confirm auto-accepted) */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(200);
  await page.click("#btn-open-list");
  await sleep(150);
  await page.click("#btn-complete-pack");
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 194, "CAK-18 deducted 6 scissors (200->194)");
  eq(remoteData.inventory["heart-jewelry-box"].qty, -18, "CAK-18 deducted 18 heart boxes");
  eq(remoteData.history[0].type, "packed", "pack logged");

  /* Undo the pack from History: inventory restored exactly */
  await page.evaluate(() => document.querySelector('[data-tab="history"]').click());
  await sleep(200);
  await page.evaluate(() => document.querySelector(".history-entry .btn-undo").click());
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 200, "undo pack restored scissors");
  eq(remoteData.inventory["heart-jewelry-box"].qty, 0, "undo pack restored heart boxes");
  eq(remoteData.history.find(h => h.type === "packed").undone, true, "entry marked undone");

  /* Hand-packed HCB 18: heat gun 2 (tier), wood board 18 */
  await page.evaluate(() => document.querySelector('[data-tab="hand"]').click());
  await sleep(200);
  await page.evaluate(() => {
    [...document.querySelectorAll("#hand-crafts .craft-btn")].find(b => b.textContent.includes("Hafrashat")).click();
    document.querySelector("#hand-kits").value = "18";
    document.querySelector("#hand-kits").dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  eq(await page.$eval("#hand-sku", e => e.textContent), "HCB-18", "hand SKU HCB-18");
  await page.click("#btn-record-hand");
  await sleep(600);
  eq(remoteData.inventory["heat-gun"].qty, -2, "hand-packed HCB-18 heat gun tier = 2");
  eq(remoteData.inventory["wood-burning-cream"].qty, -2, "hand-packed HCB-18 wood cream tier = 2");
  eq(remoteData.inventory["wood-board"].qty, -18, "hand-packed HCB-18 wood board 18");

  /* Count fix via Enter counts: scissors counted 190 */
  await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
  await sleep(200);
  await page.click("#btn-enter-counts");
  await sleep(200);
  await page.evaluate(() => {
    const inp = document.querySelector('#count-entry-list input[data-item="scissors"]');
    inp.value = "190";
    document.querySelector("#btn-apply-counts").click();
  });
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 190, "count entry set scissors to 190");
  eq(remoteData.history[0].type, "count-fix", "count fix logged");

  /* Edit that count-fix entry: counted 195 (dialog: prompt returns answer, first dialog is confirm-accept) */
  await page.evaluate(() => { window.prompt = () => "195"; document.querySelector('[data-tab="history"]').click(); });
  await sleep(200);
  await page.evaluate(() => document.querySelector(".history-entry .btn-edit").click());
  await sleep(600);
  eq(remoteData.inventory["scissors"].qty, 195, "edit count-fix to 195 applied exactly");

  /* Print areas: pack sheet has Order ID line; inventory report grouped, shared once */
  await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
  await sleep(150);
  const packPrint = await page.evaluate(() => {
    window.print = () => {};
    document.querySelector("#btn-print-sheet").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq(packPrint.includes("Order ID:"), true, "packing sheet has Order ID line");
  eq(packPrint.includes("CAK-18"), true, "packing sheet shows SKU");
  const invPrint = await page.evaluate(() => {
    document.querySelector('[data-tab="inventory"]').click();
    document.querySelector("#btn-print-inventory").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq((invPrint.match(/Scissors/g) || []).length, 1, "inventory report lists Scissors once");
  eq(invPrint.includes("Shared items"), true, "inventory report has Shared group");
  const countPrint = await page.evaluate(() => {
    document.querySelector("#btn-print-count").click();
    return document.querySelector("#print-area").innerHTML;
  });
  eq(countPrint.includes("Should be") && countPrint.includes("Counted"), true, "count sheet has Should be / Counted columns");

  /* Disconnect: back to view-only, token gone from this device */
  await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await sleep(150);
  await page.click("#btn-disconnect");
  await sleep(600);
  eq(await page.$eval("#conn-badge", e => e.textContent.trim()), "View only", "disconnect returns to view-only");
  eq(await page.evaluate(() => localStorage.getItem("alooma.editor.v1")), null, "token removed from device on disconnect");

  /* Export produces the current data */
  eq(remoteData.inventory["scissors"].qty, 195, "final remote scissors = 195 (receive 200, count 190, edit 195)");

  console.log(pass + " passed, " + fail + " failed; mock-repo PUTs: " + putCount);
} finally {
  await browser.close();
  server.kill();
}
process.exit(fail ? 1 : 0);
