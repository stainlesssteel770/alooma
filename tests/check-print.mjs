import { createRequire } from "module";
import { spawn } from "child_process";
const require = createRequire(import.meta.url);
const puppeteer = require("/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
const EXE = "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8908", "--bind", "127.0.0.1"], { cwd: "/home/hatch/workspace/alooma-repo", stdio: "ignore" });
await sleep(700);
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8908/index.html", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(300);
  await page.evaluate(() => { document.querySelector("#btn-print-sheet").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-packsheet.pdf", preferCSSPageSize: true, printBackground: true });
  await page.evaluate(() => { document.querySelector('[data-tab="inventory"]').click(); document.querySelector("#btn-print-count").click(); });
  await sleep(300);
  await page.pdf({ path: "/tmp/alooma-countsheet.pdf", preferCSSPageSize: true, printBackground: true });
  console.log("pdfs written");
} finally { await browser.close(); server.kill(); }
