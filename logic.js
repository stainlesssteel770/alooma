/* Alooma packing helper — catalog + quantity logic.
   Shared by the browser app and the node tests.
   Quantities are stored as "qty per 6 kits" (q6) because every order is a
   multiple of 6 kits. Special rules:
   - "tier18": 1 per 3 batches (18 kits): 6-18 kits = 1, 24-36 = 2, 42-54 = 3
     (ceil(kits/18)). Used for the Heat gun and Wood burning cream
     (owner-confirmed 2026-10-22, corrected same day: "until and including
     18 is 1, 24 until and including 36 is 2").
   - "trayA"/"trayB": JCA clay trays alternate. Total trays = kits/6, split
     A,B,A,B... (6 kits: A1 B0, 12: A1 B1, 18: A2 B1, 24: A2 B2, 30: A3 B2).
*/
(function (root) {
  "use strict";

  var ITEMS = {
    /* Blooming Mirrors */
    "tree-mirror": "Tree Mirror",
    "colored-clay-tool-tray": "Colored Clay & Tool tray (with 6 toothpicks)",
    "white-clay": "White Clay",
    "grass-pack-of-6": "Grass (pack of 6)",
    "double-sided-tape": "Double Sided tape",
    "bm-name-labels": "BM Name Labels",
    "bm-placemat": "BM Placemat",
    "grass-template": "Grass Template",
    "bm-instructions": "BM Instructions brochure",
    /* Tambourines */
    "tambourines": "Tambourines",
    "tamb-embellishment-tray-large": "Tamb Embellishment Trays (large square)",
    "embellishment-containers": "Embellishment Containers (stack of 6)",
    "wooden-mini-spoons": "Wooden mini Spoons",
    "wooden-picks": "Wooden Picks",
    "tamb-placemats": "Tamb Placemats",
    "jerusalem-printouts": "Jerusalem Printouts",
    "tamb-instructions": "Tamb Instructions brochure",
    /* Judaic Clay-Art */
    "jca-frame": "Frame (glass with linen backing)",
    "clay-tray-a": "Clay Tray A",
    "clay-tray-b": "Clay Tray B",
    "jca-embellishment-tray": "JCA Embellishment Tray",
    "bag-with-tools": "Bag with Tools",
    "jca-placemats": "JCA Placemats",
    "parchment-paper": "Parchment Paper (cut in half)",
    "jca-templates": "Templates",
    "jca-instructions": "JCA Instructions brochure",
    /* Hafrashat Challah */
    "wood-board": "Wood board",
    "tray-set": "Tray set (includes 2)",
    "miniatures-bread-bag": "Miniatures bread bag",
    "wood-burning-cream": "Wood burning cream",
    "hc-placemat": "HC Placemat",
    "hc-instructions": "HC Instructions brochure",
    "heat-gun": "Heat gun",
    /* The Cakery */
    "heart-jewelry-box": "Heart Jewelry Box",
    "cake-box": "Cake box",
    "circle-cardboard": "Circle cardboard",
    "parchment-circle": "Parchment (circle)",
    "plastic-pet-bowl": "Plastic pet bowl",
    "cream-circle-tray": "Cream circle tray",
    "sprinkles-pack": "Sprinkles (pack)",
    "faux-cherries-bag": "Faux cherries bag",
    "glue-dots": "Glue dots",
    "popsicle-stick": "Popsicle stick",
    "ck-placemat": "CK Placemat",
    "printed-posters": "Printed Posters (set of 3)",
    "poster-stands": "Poster stands (for quotes)",
    "ck-name-labels": "CK Name labels",
    "apron": "Apron",
    "gloves": "Gloves",
    "ck-instructions": "CK Instructions brochure",
    /* Miniature Interiors */
    "mi-frames": "Frames",
    "white-block-pack": "White Block (pack of 6)",
    "miniatures-tray-1": "Miniatures tray #1",
    "tools-supplies-tray-2": "Tools & supplies tray #2",
    "scrapbook-paper-pack": "Scrapbook paper pack",
    "mi-name-label": "MI Name label",
    "mi-placemats": "MI Placemats",
    "mi-instructions": "MI Instructions brochure",
    "english-ay-printout": "English AY Printout - by request only",
    /* Shared (counted once in inventory, used by several crafts) */
    "scissors": "Scissors",
    "tacky-glue": "Tacky Glue",
    "permanent-markers": "Permanent Markers"
  };

  function line(item, q6) { return { item: item, q6: q6 }; }
  function tier(item) { return { item: item, rule: "tier18" }; }

  var CRAFTS = [
    {
      id: "bm", code: "BM", name: "Blooming Mirrors",
      items: [
        line("tree-mirror", 6),
        line("colored-clay-tool-tray", 1),
        line("white-clay", 6),
        line("grass-pack-of-6", 1),
        line("double-sided-tape", 2),
        line("tacky-glue", 3),
        line("scissors", 3),
        line("bm-name-labels", 6),
        line("permanent-markers", 1),
        line("bm-placemat", 6),
        line("grass-template", 6),
        line("bm-instructions", 6)
      ]
    },
    {
      id: "tam", code: "TAM", name: "Tambourines",
      items: [
        line("tambourines", 6),
        line("tamb-embellishment-tray-large", 1),
        line("embellishment-containers", 1),
        line("wooden-mini-spoons", 6),
        line("wooden-picks", 6),
        line("scissors", 3),
        line("tacky-glue", 6),
        line("tamb-placemats", 6),
        line("jerusalem-printouts", 6),
        line("tamb-instructions", 6)
      ]
    },
    {
      id: "jca", code: "JCA", name: "Judaic Clay-Art",
      items: [
        line("jca-frame", 6),
        { item: "clay-tray-a", rule: "trayA" },
        { item: "clay-tray-b", rule: "trayB" },
        line("jca-embellishment-tray", 1),
        line("bag-with-tools", 1),
        line("jca-placemats", 6),
        line("parchment-paper", 6),
        line("jca-templates", 6),
        line("jca-instructions", 2)
      ]
    },
    {
      id: "hcb", code: "HCB", name: "Hafrashat Challah",
      items: [
        line("wood-board", 6),
        line("tray-set", 1),
        line("miniatures-bread-bag", 6),
        tier("wood-burning-cream"),
        line("hc-placemat", 6),
        line("hc-instructions", 6),
        tier("heat-gun")
      ]
    },
    {
      id: "cak", code: "CAK", name: "The Cakery",
      items: [
        line("heart-jewelry-box", 6),
        line("cake-box", 6),
        line("circle-cardboard", 6),
        line("parchment-circle", 6),
        line("plastic-pet-bowl", 6),
        line("cream-circle-tray", 1),
        line("sprinkles-pack", 1),
        line("faux-cherries-bag", 1),
        line("scissors", 2),
        line("glue-dots", 1),
        line("popsicle-stick", 6),
        line("ck-placemat", 6),
        line("printed-posters", 1),
        line("poster-stands", 3),
        line("ck-name-labels", 6),
        line("permanent-markers", 1),
        line("apron", 6),
        line("gloves", 6),
        line("ck-instructions", 6)
      ]
    },
    {
      id: "mi", code: "MI", name: "Miniature Interiors",
      items: [
        line("mi-frames", 6),
        line("white-block-pack", 1),
        line("miniatures-tray-1", 1),
        line("tools-supplies-tray-2", 1),
        line("scrapbook-paper-pack", 1),
        line("scissors", 3),
        line("mi-name-label", 6),
        line("permanent-markers", 1),
        line("mi-placemats", 6),
        line("mi-instructions", 6),
        line("english-ay-printout", 6)
      ]
    }
  ];

  function craftById(id) {
    for (var i = 0; i < CRAFTS.length; i++) if (CRAFTS[i].id === id) return CRAFTS[i];
    return null;
  }

  function validKits(kits) {
    return Number.isInteger(kits) && kits > 0 && kits % 6 === 0;
  }

  /* Quantity of one recipe line for an order of `kits` kits. */
  function lineQty(ln, kits) {
    if (ln.rule === "tier18") return Math.ceil(kits / 18);
    if (ln.rule === "trayA") return Math.ceil(kits / 6 / 2);
    if (ln.rule === "trayB") return Math.floor(kits / 6 / 2);
    return ln.q6 * (kits / 6);
  }

  /* Full pack list for a craft + kit count: [{item, name, qty}] in recipe order. */
  function computePack(craftId, kits) {
    var craft = craftById(craftId);
    if (!craft) throw new Error("Unknown craft: " + craftId);
    if (!validKits(kits)) throw new Error("Kits must be a positive multiple of 6 (got " + kits + ")");
    return craft.items.map(function (ln) {
      return { item: ln.item, name: ITEMS[ln.item], qty: lineQty(ln, kits) };
    });
  }

  function sku(craftId, kits) {
    var craft = craftById(craftId);
    return craft.code + "-" + kits;
  }

  /* Which crafts use each item (for inventory grouping). */
  function itemCrafts() {
    var map = {};
    CRAFTS.forEach(function (c) {
      c.items.forEach(function (ln) {
        (map[ln.item] = map[ln.item] || []).push(c.id);
      });
    });
    return map;
  }

  /* Inventory groups: items used by >1 craft go under "shared"; the rest
     under their only craft. Returns [{id, name, items:[itemId...]}] in
     craft order with Shared last. */
  function inventoryGroups() {
    var usage = itemCrafts();
    var groups = CRAFTS.map(function (c) {
      return {
        id: c.id, name: c.name,
        items: c.items.map(function (ln) { return ln.item; })
          .filter(function (id) { return usage[id].length === 1; })
      };
    });
    var shared = Object.keys(ITEMS).filter(function (id) { return usage[id] && usage[id].length > 1; });
    /* keep shared items in a stable, sensible order */
    var sharedOrder = ["scissors", "tacky-glue", "permanent-markers"];
    shared.sort(function (a, b) { return sharedOrder.indexOf(a) - sharedOrder.indexOf(b); });
    groups.push({ id: "shared", name: "Shared items", items: shared });
    return groups;
  }

  function emptyData() {
    var inv = {};
    Object.keys(ITEMS).forEach(function (id) { inv[id] = { qty: 0, threshold: null }; });
    return { version: 1, inventory: inv, history: [] };
  }

  /* Apply a history entry's effects to an inventory object (mutates inv). */
  function applyEffects(inv, effects, sign) {
    effects.forEach(function (e) {
      if (!inv[e.item]) inv[e.item] = { qty: 0, threshold: null };
      inv[e.item].qty += sign * e.delta;
    });
  }

  var api = {
    ITEMS: ITEMS, CRAFTS: CRAFTS, craftById: craftById, validKits: validKits,
    lineQty: lineQty, computePack: computePack, sku: sku,
    itemCrafts: itemCrafts, inventoryGroups: inventoryGroups,
    emptyData: emptyData, applyEffects: applyEffects
  };
  root.ALOOMA = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
