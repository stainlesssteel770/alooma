/* Offline / failed-load test (Batch A6): when the data request fails, the
   app must show ONE empty state ("Can't reach the stock data. Nothing
   shown.") with a Retry button — no quantities, no warnings, no actions —
   and Retry must recover when the network comes back.
   Run: node tests/test-offline.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
/* Portable browser loading: full `puppeteer` if installed (CI installs it);
   otherwise the sandbox's puppeteer-core + chrome-headless-shell.
   Override with PUPPETEER_CORE_PATH / CHROME_PATH. */
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8912;

let pass = 0, fail = 0;
function eq(a, e, label) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else { fail++; console.log("FAIL " + label + "\n  expected " + E + "\n  got      " + A); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let online = false;
const remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const b64e = s => Buffer.from(s, "utf8").toString("base64");

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
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 90000 });
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    const isData = url.includes("api.github.com") || url.includes("data.json");
    if (isData && !online) return req.abort();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.includes("api.github.com/repos/") && url.includes("/contents/data.json")) {
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: "sha-x", content: b64e(JSON.stringify(remoteData)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(600);

  eq(await page.$eval("#load-failed", e => !e.hidden && e.offsetParent !== null), true, "A6: empty state visible on failed load");
  eq(await page.$eval("#load-failed h2", e => e.textContent), "Can't reach the stock data. Nothing shown.", "A6: empty-state wording");
  eq(await page.$eval("#tab-pack", e => getComputedStyle(e).display), "none", "A6: pack screen hidden — no quantities shown");
  eq(await page.$eval("#tab-inventory", e => getComputedStyle(e).display), "none", "A6: inventory hidden — no zero stock shown");
  eq(await page.$eval("#save-status", e => e.textContent), "Couldn't load data", "A6: header says data didn't load");
  eq(await page.$$eval("#pack-warning:not([hidden])", els => els.length), 0, "A6: no shortage warnings");

  /* Network comes back -> Retry recovers fully */
  online = true;
  await page.click("#btn-retry-load");
  await sleep(800);
  eq(await page.$eval("#load-failed", e => e.hidden), true, "A6: empty state gone after Retry");
  eq(await page.$$eval("#pack-crafts .craft-btn", els => els.length), 6, "A6: crafts render after Retry");
  eq(await page.$eval("#save-status", e => e.textContent), "Loaded · now", "A6: header freshness after load (v3 D7 short form)");

  console.log(pass + " passed, " + fail + " failed");
} finally {
  await browser.close();
  server.close();
}
process.exit(fail ? 1 : 0);
