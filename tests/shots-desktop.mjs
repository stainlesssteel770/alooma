/* Desktop evidence screenshots (brief: desktop + print fixes, step 0).
   Loads the app as an editor against a mocked repo with sample numbers
   and photographs every tab at tablet + desktop sizes, plus an open
   sheet at 1440. No asserts — this is the before/after evidence for the
   desktop report. Run: node tests/shots-desktop.mjs */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "screenshots", "desktop");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8914;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const remote = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "data-print.json"), "utf8"));
remote.history = [];
Object.keys(remote.inventory).forEach((k, i) => {
  remote.inventory[k].qty = 40 + ((i * 53) % 360);
  remote.inventory[k].threshold = null;
});
remote.inventory["scissors"].qty = 245; remote.inventory["scissors"].threshold = 250;
if (remote.inventory["white-clay"]) { remote.inventory["white-clay"].qty = 17; remote.inventory["white-clay"].threshold = 50; }
const remoteSha = "sha-shots";
const b64e = s => Buffer.from(s, "utf8").toString("base64");

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
  // A3: the 1440 block leaves an unsaved pick, so the 1920 goto raises the
  // browser's beforeunload prompt. Accepting it = Leave, which is what this
  // evidence suite wants (the unfinished pack is discarded).
  page.on("dialog", d => d.accept());
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("alooma.editor.v1", JSON.stringify({ token: "t", owner: "test", repo: "test", login: "tester" }));
  });
  await page.setRequestInterception(true);
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith("https://api.github.com") && req.method() === "OPTIONS") return req.respond({ status: 204, headers: CORS, body: "" });
    if (url.includes("/contents/data.json")) {
      if (req.method() === "PUT") return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ content: { sha: remoteSha } }) });
      return req.respond({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ sha: remoteSha, content: b64e(JSON.stringify(remote)) }) });
    }
    if (url.startsWith("https://api.github.com")) return req.respond({ status: 404, headers: CORS, body: "{}" });
    req.continue();
  });
  const SIZES = [[768, 1024], [1280, 800], [1440, 900], [1920, 1080]];
  for (const [w, h] of SIZES) {
    await page.setViewport({ width: w, height: h });
    // The 1440 block leaves a hand-pack in progress (unsaved pick), so this
    // goto raises the A3 beforeunload prompt — the dialog handler below
    // answers Leave. (An earlier networkidle0 theory was wrong: the prompt
    // blocks ANY navigation waiter, which is why both waiters hung here.)
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load", timeout: 30000 });
    await sleep(600);
    const geo = await page.evaluate(() => {
      const m = document.querySelector("main").getBoundingClientRect();
      const t = document.querySelector(".toast");
      return {
        scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        mainLeft: Math.round(m.left), mainWidth: Math.round(m.width),
        toastBottom: t && !t.hidden ? Math.round(window.innerHeight - t.getBoundingClientRect().bottom) : null
      };
    });
    console.log(`SIZE ${w}x${h}: scrollW=${geo.scrollW} innerW=${geo.innerW} mainLeft=${geo.mainLeft} mainWidth=${geo.mainWidth}`);
    await page.screenshot({ path: path.join(OUT, `pack-${w}.png`) });
    await page.evaluate(() => document.querySelector('[data-tab="inventory"]').click());
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `inventory-${w}.png`) });
    await page.evaluate(() => document.querySelector('[data-tab="settings"]').click());
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `settings-${w}.png`) });
    if (w === 1440) {
      await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
      await sleep(300);
      await page.evaluate(() => [...document.querySelectorAll("#pack-crafts .craft-btn")].find(b => b.textContent.includes("Blooming")).click());
      await page.click('.kits-chip[data-for="pack"][data-kits="6"]');
      await sleep(300);
      /* A4: Print would complete the order, so the confirm-sheet shot uses
         the hand-pack path instead: check all, then Complete. */
      await page.evaluate(() => document.querySelector("#btn-pack-hand").click());
      await sleep(300);
      await page.evaluate(() => document.querySelector("#btn-check-all").click());
      await sleep(300);
      await page.evaluate(() => document.querySelector("#sheet-primary").click()); /* Mark all */
      await sleep(300);
      await page.evaluate(() => document.querySelector("#btn-complete-pack").click());
      await sleep(500);
      const sheet2 = await page.evaluate(() => {
        const s = document.querySelector(".sheet").getBoundingClientRect();
        return { left: Math.round(s.left), top: Math.round(s.top), width: Math.round(s.width), height: Math.round(s.height) };
      });
      console.log(`CONFIRM SHEET at 1440x900: left=${sheet2.left} top=${sheet2.top} w=${sheet2.width} h=${sheet2.height}`);
      await page.screenshot({ path: path.join(OUT, "sheet-1440.png") });
    }
  }
  console.log("desktop screenshots written to screenshots/desktop/");
} finally {
  await browser.close();
  server.close();
}
