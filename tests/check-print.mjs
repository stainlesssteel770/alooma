/* Print check: each 4x6 output must paginate to EXACTLY its content —
   no trailing blank labels (the pre-redesign bug: pack sheet printed 3
   labels, inventory/count 7, most of them blank).
   Run: node tests/check-print.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/* Portable browser loading: full `puppeteer` if installed (CI installs it);
   otherwise the sandbox's puppeteer-core + chrome-headless-shell.
   Override with PUPPETEER_CORE_PATH / CHROME_PATH. */
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
const PORT = 8908;
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let fail = 0;
function pages(pdf) { return fs.readFileSync(pdf, "latin1").match(/\/MediaBox/g).length; }
function expectPages(pdf, want, label) {
  const got = pages(pdf);
  if (got === want) console.log("ok   " + label + " = " + got + " page(s)");
  else { fail++; console.log("FAIL " + label + ": expected " + want + " page(s), got " + got); }
}
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8908/index.html", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-print-sheet").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-packsheet.pdf", preferCSSPageSize: true, printBackground: true });
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-inventory").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-invreport.pdf", preferCSSPageSize: true, printBackground: true });
  await page.evaluate(() => { document.querySelector("#btn-print-count").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-countsheet.pdf", preferCSSPageSize: true, printBackground: true });
  console.log("pdfs written");
  expectPages("/tmp/alooma-packsheet.pdf", 1, "pack sheet CAK-18");
  expectPages("/tmp/alooma-invreport.pdf", 3, "inventory report (62 items)");
  expectPages("/tmp/alooma-countsheet.pdf", 3, "count sheet (62 items)");
} finally { await browser.close(); server.close(); }
process.exit(fail ? 1 : 0);
