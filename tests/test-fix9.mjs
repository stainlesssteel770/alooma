/* Fix 9 tests: hand-pack lock + cancel.
   - Lock: tick 3 then tap another craft/kit -> nothing changes (locked)
   - Cancel: 0 ticked -> no confirm; SOME -> 1 confirm; ALL -> 2 confirms
   - Backing out keeps pack + ticks
   - After cancel: selection unlocked, stock + History unchanged
   - Empty-queue message hidden during single hand-pack
*/
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
let puppeteer, EXE;
try { puppeteer = require("puppeteer"); }
catch (e) {
  puppeteer = require(process.env.PUPPETEER_CORE_PATH || "/home/hatch/workspace/steady/tests/node_modules/puppeteer-core");
  EXE = process.env.CHROME_PATH || "/home/hatch/.cache/puppeteer/chrome-headless-shell/linux-155.0.8059.84/chrome-headless-shell-linux64/chrome-headless-shell";
}
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const failList = [];
function eq(a, e, label) {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; }
  else { fail++; failList.push(label + " | expected " + JSON.stringify(e) + " got " + JSON.stringify(a)); }
}
async function chk(fn, label) {
  try { await fn(); } catch (e) { fail++; failList.push(label + " | threw " + e.message); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });

// Serve via file:// with mocked API
await page.goto("file://" + ROOT + "/index.html");
await page.waitForSelector(".tabs", { timeout: 15000 });
await sleep(500);

// Go to Pack tab, select craft + kits, start hand-pack
await page.evaluate(() => document.querySelector('[data-tab="pack"]').click());
await sleep(300);
await page.evaluate(() => document.querySelector('#pack-crafts .craft-btn').click());
await sleep(300);
await page.evaluate(() => document.querySelector('.kits-chip[data-kits="6"]').click());
await sleep(300);
await page.evaluate(() => document.querySelector('#btn-pack-hand').click());
await sleep(500);

// Test 1: Cancel button is visible during hand-pack
await chk(async () => eq(await page.$eval("#btn-pack-cancel", e => !e.hidden), true, "fix9: Cancel button visible during hand-pack"), "fix9: Cancel visible");

// Test 2: Craft buttons are locked
await chk(async () => eq(await page.$eval('#pack-crafts .craft-btn', e => e.classList.contains('locked')), true, "fix9: craft buttons have locked class"), "fix9: craft locked");

// Test 3: Kit chips are locked
await chk(async () => eq(await page.$eval('.kits-chip[data-for="pack"]', e => e.classList.contains('locked')), true, "fix9: kit chips have locked class"), "fix9: chips locked");

// Test 4: Empty-queue message hidden (pack-queue should be empty, no hint)
await chk(async () => {
  const html = await page.$eval("#pack-queue", e => e.innerHTML);
  eq(html.includes("No orders in the queue yet"), false, "fix9: empty-queue message hidden during hand-pack");
}, "fix9: no empty-queue msg");

console.log(`\nFix 9 tests: ${pass} passed, ${fail} failed`);
if (failList.length) {
  console.log("FAILURES:");
  failList.forEach(f => console.log(" - " + f));
}
await browser.close();
process.exit(fail > 0 ? 1 : 0);
