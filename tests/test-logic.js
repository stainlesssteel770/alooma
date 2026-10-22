/* Logic tests for Alooma. Run: node tests/test-logic.js */
const L = require("../logic.js");
let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log("FAIL " + label + "\n  expected " + e + "\n  got      " + a); }
}
function qty(pack, item) { const r = pack.find(r => r.item === item); return r ? r.qty : undefined; }

/* --- CAK-18: must reproduce the old site's verified deductions exactly --- */
const cak18 = L.computePack("cak", 18);
eq(cak18.length, 19, "CAK has 19 lines");
eq(qty(cak18, "heart-jewelry-box"), 18, "CAK18 heart box");
eq(qty(cak18, "cream-circle-tray"), 3, "CAK18 cream tray");
eq(qty(cak18, "sprinkles-pack"), 3, "CAK18 sprinkles");
eq(qty(cak18, "glue-dots"), 3, "CAK18 glue dots");
eq(qty(cak18, "printed-posters"), 3, "CAK18 posters");
eq(qty(cak18, "faux-cherries-bag"), 3, "CAK18 cherries");
eq(qty(cak18, "permanent-markers"), 3, "CAK18 markers");
eq(qty(cak18, "poster-stands"), 9, "CAK18 poster stands");
eq(qty(cak18, "scissors"), 6, "CAK18 scissors");
eq(qty(cak18, "apron"), 18, "CAK18 apron");
eq(L.sku("cak", 18), "CAK-18", "SKU format");

/* --- Tier rule: heat gun + wood burning cream, 1 per 3 batches, ceil(kits/18).
       Owner correction 2026-10-22: up to and including 18 = 1; 24-36 = 2. --- */
for (const [kits, want] of [[6,1],[12,1],[18,1],[24,2],[30,2],[36,2],[42,3],[48,3],[54,3],[60,4]]) {
  eq(qty(L.computePack("hcb", kits), "heat-gun"), want, "heat gun " + kits);
  eq(qty(L.computePack("hcb", kits), "wood-burning-cream"), want, "wood cream " + kits);
}
/* HCB regular lines still scale per 6 */
eq(qty(L.computePack("hcb", 18), "wood-board"), 18, "HCB18 wood board");
eq(qty(L.computePack("hcb", 18), "tray-set"), 3, "HCB18 tray set");
eq(qty(L.computePack("hcb", 18), "miniatures-bread-bag"), 18, "HCB18 bread bag");

/* --- JCA clay trays alternate A,B,A,B --- */
for (const [kits, a, b] of [[6,1,0],[12,1,1],[18,2,1],[24,2,2],[30,3,2],[36,3,3]]) {
  eq(qty(L.computePack("jca", kits), "clay-tray-a"), a, "tray A " + kits);
  eq(qty(L.computePack("jca", kits), "clay-tray-b"), b, "tray B " + kits);
}
eq(qty(L.computePack("jca", 6), "jca-instructions"), 2, "JCA instructions 2 per 6 (confirmed real)");

/* --- TAM: 1 large-square tray per 6, no rectangle line --- */
const tam6 = L.computePack("tam", 6);
eq(tam6.length, 10, "TAM has 10 lines");
eq(qty(tam6, "tamb-embellishment-tray-large"), 1, "TAM large tray");
eq(tam6.some(r => /rectangle/i.test(r.name)), false, "TAM has no rectangle tray line");
eq(qty(tam6, "tacky-glue"), 6, "TAM tacky glue 6 per 6");

/* --- BM + MI spot checks against the old site --- */
eq(qty(L.computePack("bm", 6), "double-sided-tape"), 2, "BM tape 2 per 6");
eq(qty(L.computePack("bm", 6), "tacky-glue"), 3, "BM tacky 3 per 6");
eq(qty(L.computePack("bm", 6), "scissors"), 3, "BM scissors 3 per 6");
eq(L.computePack("mi", 6).length, 11, "MI has 11 lines");
eq(qty(L.computePack("mi", 12), "english-ay-printout"), 12, "MI printout");

/* --- Kit validation: multiples of 6 only --- */
eq(L.validKits(18), true, "18 valid");
eq(L.validKits(7), false, "7 invalid");
eq(L.validKits(0), false, "0 invalid");
eq(L.validKits(-6), false, "-6 invalid");
let threw = false; try { L.computePack("cak", 10); } catch (e) { threw = true; }
eq(threw, true, "computePack throws on 10 kits");

/* --- Distinct items stay distinct --- */
const names = Object.values(L.ITEMS);
eq(names.includes("Wooden Picks"), true, "wooden picks exist");
eq(qty(L.computePack("bm", 6), "colored-clay-tool-tray"), 1, "BM clay tray line (toothpicks are inside its name)");
eq(L.ITEMS["parchment-paper"] !== L.ITEMS["parchment-circle"], true, "parchment paper != parchment circle");
eq(L.computePack("jca", 6).some(r => r.item === "clay-tray-a") && L.computePack("jca", 6).some(r => r.item === "clay-tray-b"), true, "tray A and B are separate lines");

/* --- Inventory effects: pack, receive, count-fix, undo, edit --- */
const data = L.emptyData();
eq(Object.keys(data.inventory).length, 62, "62 unique inventory items");
eq(data.inventory["scissors"].qty, 0, "inventory starts at 0");
/* receive 100 scissors, pack CAK-18 (uses 6), undo the pack */
L.applyEffects(data.inventory, [{ item: "scissors", delta: 100 }], +1);
const packFx = L.computePack("cak", 18).map(r => ({ item: r.item, delta: -r.qty }));
L.applyEffects(data.inventory, packFx, +1);
eq(data.inventory["scissors"].qty, 94, "CAK-18 deducts 6 scissors");
eq(data.inventory["heart-jewelry-box"].qty, -18, "unreceived items go negative by exact amount");
L.applyEffects(data.inventory, packFx, -1); /* undo */
eq(data.inventory["scissors"].qty, 100, "undo restores scissors");
eq(data.inventory["heart-jewelry-box"].qty, 0, "undo restores heart box");
/* edit a pack from 18 to 6 kits: apply delta difference */
const pack6Fx = L.computePack("cak", 6).map(r => ({ item: r.item, delta: -r.qty }));
L.applyEffects(data.inventory, packFx, +1);
const diff = pack6Fx.map((e, i) => ({ item: e.item, delta: e.delta - packFx[i].delta }));
L.applyEffects(data.inventory, diff, +1);
eq(data.inventory["scissors"].qty, 98, "edit 18->6 kits leaves 2 scissors deducted");

/* --- Groups: shared items listed once --- */
const groups = L.inventoryGroups();
eq(groups.reduce((n, g) => n + g.items.length, 0), 62, "groups cover all 62 items exactly once");
eq(groups.find(g => g.id === "shared").items, ["scissors", "tacky-glue", "permanent-markers"], "shared group");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
