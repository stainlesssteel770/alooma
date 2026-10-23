/* Alooma accessibility scan (Batch C) — runs axe-core (installed by CI)
   over every tab in the default view-only state and fails on any
   serious or critical violation. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
const PORT = 8911;
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const axeSrc = fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let fail = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 780 });
  await page.goto("http://127.0.0.1:8911/index.html", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(400);
  for (const tab of ["pack", "inventory", "history", "settings"]) {
    await page.evaluate(t => document.querySelector('[data-tab="' + t + '"]').click(), tab);
    await sleep(300);
    await page.evaluate(axeSrc);
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }));
    });
    const bad = res.filter(v => v.impact === "serious" || v.impact === "critical");
    if (bad.length) { fail++; console.log("FAIL a11y tab=" + tab + ": " + JSON.stringify(bad)); }
    else console.log("ok   a11y tab=" + tab + ": 0 serious/critical (" + res.length + " total violations)");
    res.filter(v => v.impact !== "serious" && v.impact !== "critical").forEach(v => console.log("     note " + tab + " " + v.id + " (" + v.impact + ") x" + v.nodes));
  }
} finally { await browser.close(); server.close(); }
process.exit(fail ? 1 : 0);
