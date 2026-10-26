/* Service-worker freshness test (fix-round item 1): a cached client must
   get a NEW app.js on its next load (network-first for app files), old
   caches must be deleted on activate, and the app must still open when
   the network is down (cache fallback).
   The test serves a TEMP copy of the shell (never the repo files) so it
   can mutate the served app.js between loads. Old cache-first sw.js
   FAILS the marker assertion: the reload keeps serving the cached v1
   bytes. Run: node tests/test-sw.mjs */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8920;
let failures = 0, passes = 0;
function ok(v, name) { if (v) { passes++; } else { failures++; console.log("FAIL " + name); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXE = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

/* Temp shell dir: copy only the 5 shell files, so mutating app.js here
   never touches the repo. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "alooma-sw-"));
for (const f of ["index.html", "app.js", "logic.js", "styles.css", "sw.js"])
  fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));

const remoteData = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const b64e = s => Buffer.from(s, "utf8").toString("base64");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(TMP, rel === "/" ? "index.html" : rel.replace(/^\/+/, ""));
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
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS")
      return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }, body: "" });
    if (url.includes("/contents/data.json"))
      return req.respond({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, contentType: "application/json", body: JSON.stringify({ sha: "sha-x", content: b64e(JSON.stringify(remoteData)) }) });
    if (url.startsWith("https://api.github.com"))
      return req.respond({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" });
    req.continue();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(800);
  /* Seed a stale cache from a previous version, then force a fresh
     install (unregister + reload): activate must delete it. A plain
     reload does NOT re-run activate, so the unregister step is what
     makes this assertion test anything. */
  await page.evaluate(() => caches.open("alooma-shell-OLD").then(c => c.put("/stale.txt", new Response("stale"))));
  await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))));
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(800);
  const keys = await page.evaluate(() => caches.keys());
  ok(!keys.includes("alooma-shell-OLD"), "SW: old cache deleted on activate (keys: " + keys.join(",") + ")");

  /* v1 bytes are cached now; mutate the served file, reload online. */
  const v1 = await page.evaluate(() => fetch("app.js").then(r => r.text()));
  ok(v1.length > 1000, "SW: v1 app.js fetched through the worker");
  fs.appendFileSync(path.join(TMP, "app.js"), "\n// SW-UPDATE-MARKER-V2\n");
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 });
  await sleep(500);
  const v2 = await page.evaluate(() => fetch("app.js").then(r => r.text()));
  ok(v2.includes("SW-UPDATE-MARKER-V2"), "SW: cached client gets the NEW app.js on its next load (network-first)");

  /* Network down: the shell must still open from cache. Continued
     (non-API) requests fail offline, so the worker's cache fallback is
     what serves index/app/logic/styles. The intercepted data mock still
     answers (puppeteer offline mode does not stop interception), so the
     app itself loads fully. */
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
  await sleep(500);
  const offTitle = await page.evaluate(() => document.title);
  ok(offTitle.length > 0, "SW: page opens offline (title present)");
  const offJs = await page.evaluate(() => fetch("app.js").then(r => r.text()).catch(() => ""));
  ok(offJs.includes("SW-UPDATE-MARKER-V2"), "SW: app.js still served from cache offline");
  await page.setOfflineMode(false);

  console.log(failures ? "SW TESTS FAILED (" + failures + ")" : "all sw tests passed (" + passes + ")");
} finally {
  await browser.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
