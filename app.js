/* Alooma app — viewer/editor client.
   Data lives in data.json in the public GitHub repo. Reading uses the
   GitHub API (or the Pages-served copy as fallback). Editing requires a
   GitHub token saved ONLY in this device's localStorage; every edit is a
   commit of data.json through the GitHub Contents API. */
(function () {
  "use strict";
  var L = window.ALOOMA;
  var DEFAULT_OWNER = "stainlesssteel770";
  var DEFAULT_REPO = "alooma";
  var LS_KEY = "alooma.editor.v1";

  var state = {
    data: null, sha: null, editor: null, /* {token, owner, repo, login} */
    packCraft: "cak", handCraft: "cak", loadedAt: null
  };

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.hidden = false;
    setTimeout(function () { t.hidden = true; }, 4200);
  }
  function showError(msg) {
    var b = $("error-banner"); b.textContent = msg; b.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearError() { $("error-banner").hidden = true; }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = ""; bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function repoCfg() {
    return state.editor
      ? { owner: state.editor.owner, repo: state.editor.repo }
      : { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
  }
  function ghHeaders() {
    var h = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (state.editor && state.editor.token) h["Authorization"] = "Bearer " + state.editor.token;
    return h;
  }

  /* ---------- data load / save ---------- */
  function apiDataUrl() {
    var c = repoCfg();
    return "https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json?ref=main&_=" + Date.now();
  }
  function loadData() {
    return fetch(apiDataUrl(), { headers: ghHeaders(), cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("api " + r.status); return r.json(); })
      .then(function (j) {
        state.sha = j.sha;
        state.data = JSON.parse(b64decode(j.content));
        state.loadedAt = new Date();
      })
      .catch(function () {
        /* Fallback: the Pages-served copy of data.json (lags commits by ~1 min). */
        return fetch("data.json?_=" + Date.now(), { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error("pages " + r.status); return r.json(); })
          .then(function (d) { state.data = d; state.loadedAt = new Date(); });
      })
      .then(function () { normalizeData(); updateSaveStatus("Loaded " + state.loadedAt.toLocaleTimeString()); })
      .catch(function () { showError("Could not load the current data. Check your connection and reload the page."); });
  }
  function normalizeData() {
    if (!state.data || typeof state.data !== "object") state.data = L.emptyData();
    if (!state.data.inventory) state.data.inventory = {};
    Object.keys(L.ITEMS).forEach(function (id) {
      if (!state.data.inventory[id]) state.data.inventory[id] = { qty: 0, threshold: null };
    });
    if (!Array.isArray(state.data.history)) state.data.history = [];
  }
  function saveData(message) {
    if (!state.editor) return Promise.reject(new Error("view-only"));
    var c = repoCfg();
    updateSaveStatus("Saving…");
    var body = {
      message: message,
      content: b64encode(JSON.stringify(state.data, null, 2) + "\n"),
      branch: "main"
    };
    if (state.sha) body.sha = state.sha;
    return fetch("https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json", {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 409 || r.status === 422) {
        /* Someone/something committed in between: refresh the sha and retry once. */
        return fetch(apiDataUrl(), { headers: ghHeaders(), cache: "no-store" })
          .then(function (rr) { return rr.json(); })
          .then(function (j) {
            body.sha = j.sha;
            return fetch("https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json", {
              method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
            });
          });
      }
      return r;
    }).then(function (r) {
      if (!r.ok) throw new Error("save " + r.status);
      return r.json();
    }).then(function (j) {
      state.sha = j.content && j.content.sha ? j.content.sha : state.sha;
      state.loadedAt = new Date();
      updateSaveStatus("Saved ✓ " + state.loadedAt.toLocaleTimeString());
    }).catch(function (e) {
      updateSaveStatus("NOT saved — check connection");
      showError("Your change was made on this screen but could NOT be saved to GitHub (" + e.message + "). Do not rely on it until it saves — reload the page to see the true saved status, then try again.");
      throw e;
    });
  }
  function updateSaveStatus(txt) { $("save-status").textContent = txt || ""; }

  /* ---------- mutations (editor only) ---------- */
  function newEntry(type, title, effects, extra) {
    var e = {
      id: "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(), type: type, title: title,
      effects: effects, undone: false
    };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  /* Apply effects + log entry + save. Returns a promise. */
  function commitChange(entry, commitMsg) {
    L.applyEffects(state.data.inventory, entry.effects, +1);
    state.data.history.unshift(entry);
    renderAll();
    return saveData(commitMsg).then(function () { toast("Saved: " + entry.title); });
  }
  function requireEditor() {
    if (state.editor) return true;
    showError("This device is view-only. Connect a GitHub token in Settings to make changes from here.");
    return false;
  }

  /* ---------- rendering: shared ---------- */
  function craftButtons(containerId, selectedId, onPick) {
    var box = $(containerId); box.innerHTML = "";
    L.CRAFTS.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "craft-btn" + (c.id === selectedId ? " selected" : "");
      b.innerHTML = esc(c.name) + "<small>" + esc(c.code) + " · " + c.items.length + " items</small>";
      b.addEventListener("click", function () { onPick(c.id); });
      box.appendChild(b);
    });
  }
  function qtyOf(itemId) { return state.data.inventory[itemId] ? state.data.inventory[itemId].qty : 0; }

  /* ---------- Packing tab ---------- */
  function renderPack() {
    craftButtons("pack-crafts", state.packCraft, function (id) { state.packCraft = id; renderPack(); });
    var kits = parseInt($("pack-kits").value, 10);
    var err = $("pack-error"), warn = $("pack-warning");
    err.textContent = ""; warn.hidden = true;
    var valid = L.validKits(kits);
    $("pack-sku").textContent = valid ? L.sku(state.packCraft, kits) : "—";
    var tbody = $("pack-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!valid) {
      err.textContent = kits ? "Kits are ordered in multiples of 6 — enter 6, 12, 18, 24…" : "";
      return;
    }
    var pack = L.computePack(state.packCraft, kits);
    var shortages = [];
    pack.forEach(function (r, idx) {
      var onHand = qtyOf(r.item);
      if (onHand < r.qty) shortages.push(r.name + " (need " + r.qty + ", have " + onHand + ")");
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><input type="checkbox" data-idx="' + idx + '"></td>' +
        "<td>" + esc(r.name) + "</td>" +
        '<td class="num">' + r.qty + "</td>" +
        '<td class="num' + (onHand < r.qty ? " short" : "") + '">' + onHand + "</td>";
      tr.querySelector("input").addEventListener("change", function (ev) {
        tr.classList.toggle("checked-row", ev.target.checked);
      });
      tbody.appendChild(tr);
    });
    if (shortages.length) {
      warn.innerHTML = "<strong>Not enough on hand for:</strong> " + shortages.map(esc).join(" · ") +
        "<br>You can still record the packing — those counts will go below zero so the shortage stays visible.";
      warn.hidden = false;
    }
  }
  function currentPack() {
    var kits = parseInt($("pack-kits").value, 10);
    if (!L.validKits(kits)) return null;
    return { craft: L.craftById(state.packCraft), kits: kits, pack: L.computePack(state.packCraft, kits) };
  }
  function completePacking() {
    if (!requireEditor()) return;
    var cur = currentPack(); if (!cur) return;
    var craft = cur.craft;
    var lines = cur.pack.map(function (r) { return r.name + " −" + r.qty; }).join("\n");
    if (!window.confirm("Completed packing?\n\n" + craft.name + " — " + cur.kits + " kits (" + L.sku(craft.id, cur.kits) + ")\nThis subtracts from inventory:\n\n" + lines)) return;
    var entry = newEntry(
      "packed",
      "Packed " + craft.name + " — " + cur.kits + " kits (" + L.sku(craft.id, cur.kits) + ")",
      cur.pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
      { craftId: craft.id, kits: cur.kits }
    );
    $("pack-list-wrap").hidden = true;
    $("pack-table").querySelectorAll("input[type=checkbox]").forEach(function (cb) { cb.checked = false; });
    commitChange(entry, "Packed " + L.sku(craft.id, cur.kits));
  }

  /* ---------- Hand-packed tab ---------- */
  function renderHand() {
    craftButtons("hand-crafts", state.handCraft, function (id) { state.handCraft = id; renderHand(); });
    var kits = parseInt($("hand-kits").value, 10);
    var err = $("hand-error"); err.textContent = "";
    var valid = L.validKits(kits);
    $("hand-sku").textContent = valid ? L.sku(state.handCraft, kits) : "—";
    var tbody = $("hand-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!valid) { err.textContent = kits ? "Kits are ordered in multiples of 6 — enter 6, 12, 18, 24…" : ""; return; }
    L.computePack(state.handCraft, kits).forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(r.name) + '</td><td class="num">' + r.qty + '</td><td class="num">' + qtyOf(r.item) + "</td>";
      tbody.appendChild(tr);
    });
  }
  function recordHand() {
    if (!requireEditor()) return;
    var kits = parseInt($("hand-kits").value, 10);
    if (!L.validKits(kits)) return;
    var craft = L.craftById(state.handCraft);
    var pack = L.computePack(craft.id, kits);
    var lines = pack.map(function (r) { return r.name + " −" + r.qty; }).join("\n");
    if (!window.confirm("Record hand-packed?\n\n" + craft.name + " — " + kits + " kits (" + L.sku(craft.id, kits) + ")\nThis subtracts from inventory:\n\n" + lines)) return;
    var entry = newEntry(
      "hand-packed",
      "Hand-packed " + craft.name + " — " + kits + " kits (" + L.sku(craft.id, kits) + ")",
      pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
      { craftId: craft.id, kits: kits }
    );
    commitChange(entry, "Hand-packed " + L.sku(craft.id, kits));
  }

  /* ---------- Inventory tab ---------- */
  function isLow(itemId) {
    var rec = state.data.inventory[itemId];
    return rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold;
  }
  function renderInventory() {
    var wrap = $("inventory-groups"); wrap.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var div = document.createElement("div"); div.className = "inv-group";
      var html = "<h3>" + esc(g.name) + "</h3>";
      g.items.forEach(function (itemId) {
        var rec = state.data.inventory[itemId];
        html +=
          '<div class="inv-item" data-item="' + itemId + '">' +
          '<span class="inv-name">' + esc(L.ITEMS[itemId]) + "</span>" +
          (isLow(itemId) ? '<span class="low-badge">Low stock</span>' : "") +
          '<span class="inv-qty">' + rec.qty + "</span>" +
          '<span class="inv-controls editor-only">' +
          '<label>Receive<input type="number" class="in-receive" min="0" step="1" placeholder="Qty"></label>' +
          '<button class="btn btn-receive">+ Receive</button>' +
          '<label>Set count<input type="number" class="in-set" min="0" step="1" placeholder="Actual"></label>' +
          '<button class="btn btn-set">Fix count</button>' +
          '<label>Low at/below<input type="number" class="in-threshold" min="0" step="1" placeholder="Off" value="' + (rec.threshold === null || rec.threshold === undefined ? "" : rec.threshold) + '"></label>' +
          '<button class="btn btn-threshold">Set warning</button>' +
          "</span></div>";
      });
      div.innerHTML = html;
      wrap.appendChild(div);
    });
    wrap.querySelectorAll(".inv-item").forEach(function (row) {
      var itemId = row.getAttribute("data-item");
      var name = L.ITEMS[itemId];
      row.querySelector(".btn-receive").addEventListener("click", function () {
        if (!requireEditor()) return;
        var v = parseInt(row.querySelector(".in-receive").value, 10);
        if (!Number.isInteger(v) || v <= 0) { showError("Enter how many " + name + " were received (a whole number above 0)."); return; }
        clearError();
        commitChange(
          newEntry("received", "Received " + v + " × " + name, [{ item: itemId, delta: v }], { item: itemId, amount: v }),
          "Received " + v + " x " + name
        );
      });
      row.querySelector(".btn-set").addEventListener("click", function () {
        if (!requireEditor()) return;
        var v = parseInt(row.querySelector(".in-set").value, 10);
        if (!Number.isInteger(v) || v < 0) { showError("Enter the actual counted number for " + name + " (0 or more)."); return; }
        var cur = qtyOf(itemId);
        if (v === cur) { toast(name + " is already " + cur + " — nothing to fix."); return; }
        clearError();
        var entry = newEntry(
          "count-fix",
          "Count fix " + name + ": " + cur + " → " + v,
          [{ item: itemId, delta: v - cur }],
          { item: itemId, counted: v }
        );
        commitChange(entry, "Count fix " + name + " to " + v);
      });
      row.querySelector(".btn-threshold").addEventListener("click", function () {
        if (!requireEditor()) return;
        var raw = row.querySelector(".in-threshold").value;
        var v = raw === "" ? null : parseInt(raw, 10);
        if (raw !== "" && (!Number.isInteger(v) || v < 0)) { showError("Low-stock warning for " + name + " must be 0 or more, or blank for off."); return; }
        clearError();
        state.data.inventory[itemId].threshold = v;
        renderAll();
        saveData("Low-stock warning " + name + " -> " + (v === null ? "off" : v))
          .then(function () { toast("Warning for " + name + ": " + (v === null ? "off" : "at or below " + v)); });
      });
    });
  }
  function renderCountEntry() {
    var list = $("count-entry-list"); list.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var head = document.createElement("div");
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Counted">';
        list.appendChild(row);
      });
    });
  }
  function applyCounts() {
    if (!requireEditor()) return;
    var inputs = $("count-entry-list").querySelectorAll("input[data-item]");
    var changes = [];
    inputs.forEach(function (inp) {
      if (inp.value === "") return;
      var v = parseInt(inp.value, 10);
      var itemId = inp.getAttribute("data-item");
      if (!Number.isInteger(v) || v < 0) return;
      var cur = qtyOf(itemId);
      if (v !== cur) changes.push({ item: itemId, counted: v, delta: v - cur });
    });
    if (!changes.length) { toast("No counts differ from what's on hand — nothing to apply."); return; }
    var done = 0;
    changes.forEach(function (ch) {
      var entry = newEntry(
        "count-fix",
        "Count fix " + L.ITEMS[ch.item] + ": " + qtyOf(ch.item) + " → " + ch.counted,
        [{ item: ch.item, delta: ch.delta }],
        { item: ch.item, counted: ch.counted }
      );
      /* apply locally without a save per item; one save at the end */
      L.applyEffects(state.data.inventory, entry.effects, +1);
      state.data.history.unshift(entry);
      done++;
    });
    $("count-entry").hidden = true;
    renderAll();
    saveData("Count entry: " + done + " item(s) fixed").then(function () { toast("Counts applied: " + done + " item(s) updated."); });
  }

  /* ---------- History tab ---------- */
  var TYPE_LABEL = { "received": "Received", "packed": "Packed", "hand-packed": "Hand-packed", "count-fix": "Count fix", "import": "Backup import" };
  function renderHistory() {
    var wrap = $("history-list"); wrap.innerHTML = "";
    if (!state.data.history.length) { wrap.innerHTML = '<p class="hint">No changes logged yet.</p>'; return; }
    state.data.history.forEach(function (entry) {
      var div = document.createElement("div");
      div.className = "history-entry" + (entry.undone ? " undone" : "");
      var effects = entry.effects.map(function (e) {
        return esc(L.ITEMS[e.item] || e.item) + " " + (e.delta > 0 ? "+" : "") + e.delta;
      }).join(" · ");
      div.innerHTML =
        '<div class="history-head"><span class="history-title">' + esc(entry.title) + "</span>" +
        '<span class="history-date">' + esc(TYPE_LABEL[entry.type] || entry.type) + " · " + esc(fmtDate(entry.ts)) + "</span></div>" +
        (effects ? '<div class="history-effects">' + effects + "</div>" : "") +
        (entry.undone ? '<div class="undone-tag">Undone</div>' : "") +
        (!entry.undone && state.editor ? '<div class="history-actions"><button class="btn btn-edit">Edit</button><button class="btn btn-undo">Undo</button></div>' : "");
      wrap.appendChild(div);
      if (!entry.undone && state.editor) {
        div.querySelector(".btn-undo").addEventListener("click", function () { undoEntry(entry); });
        div.querySelector(".btn-edit").addEventListener("click", function () { editEntry(entry); });
      }
    });
  }
  function undoEntry(entry) {
    if (!requireEditor()) return;
    if (!window.confirm("Undo this entry?\n\n" + entry.title + "\n\nIts inventory changes will be reversed exactly.")) return;
    L.applyEffects(state.data.inventory, entry.effects, -1);
    entry.undone = true;
    renderAll();
    saveData("Undo: " + entry.title).then(function () { toast("Undone: " + entry.title); });
  }
  function replaceEffects(entry, newEffects, newTitle, extraUpdates) {
    /* reverse old, apply new, keep one history entry */
    L.applyEffects(state.data.inventory, entry.effects, -1);
    L.applyEffects(state.data.inventory, newEffects, +1);
    entry.effects = newEffects;
    if (newTitle) entry.title = newTitle;
    if (extraUpdates) Object.keys(extraUpdates).forEach(function (k) { entry[k] = extraUpdates[k]; });
    entry.editedAt = new Date().toISOString();
    renderAll();
    return saveData("Edit history: " + entry.title);
  }
  function editEntry(entry) {
    if (!requireEditor()) return;
    if (entry.type === "received") {
      var v = parseInt(window.prompt("Received quantity for " + (L.ITEMS[entry.item] || "") + ":", entry.amount), 10);
      if (!Number.isInteger(v) || v <= 0) return;
      replaceEffects(entry, [{ item: entry.item, delta: v }],
        "Received " + v + " × " + L.ITEMS[entry.item], { amount: v })
        .then(function () { toast("Entry updated."); });
    } else if (entry.type === "count-fix") {
      var c = parseInt(window.prompt("Counted number for " + (L.ITEMS[entry.item] || "") + ":", entry.counted), 10);
      if (!Number.isInteger(c) || c < 0) return;
      var oldDelta = entry.effects[0].delta;
      var before = entry.counted - oldDelta;
      replaceEffects(entry, [{ item: entry.item, delta: c - before }],
        "Count fix " + L.ITEMS[entry.item] + ": " + before + " → " + c, { counted: c })
        .then(function () { toast("Entry updated."); });
    } else if (entry.type === "packed" || entry.type === "hand-packed") {
      var k = parseInt(window.prompt("Number of kits (multiple of 6):", entry.kits), 10);
      if (!L.validKits(k) || k === entry.kits) return;
      var pack = L.computePack(entry.craftId, k);
      var verb = entry.type === "packed" ? "Packed" : "Hand-packed";
      var craft = L.craftById(entry.craftId);
      replaceEffects(entry,
        pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
        verb + " " + craft.name + " — " + k + " kits (" + L.sku(entry.craftId, k) + ")",
        { kits: k })
        .then(function () { toast("Entry updated."); });
    } else {
      toast("This entry type can't be edited — undo it instead.");
    }
  }

  /* ---------- Printing (4x6 thermal labels) ---------- */
  function printHtml(html) {
    $("print-area").innerHTML = html;
    setTimeout(function () { window.print(); }, 60);
  }
  function printPackSheet() {
    var cur = currentPack(); if (!cur) { showError("Pick a craft and a valid number of kits first."); return; }
    clearError();
    var rows = cur.pack.map(function (r) {
      return "<tr><td>" + esc(r.name) + '</td><td class="qty">' + r.qty + "</td></tr>";
    }).join("");
    printHtml(
      "<table><thead>" +
      '<tr><th colspan="2"><div class="label-title">' + esc(cur.craft.name) + "</div>" +
      '<div class="label-sub">SKU ' + esc(L.sku(cur.craft.id, cur.kits)) + " · " + cur.kits + " kits · " +
      new Date().toLocaleDateString() + "</div>" +
      '<div class="order-id">Order ID: ____________________</div></th></tr>' +
      "<tr><th>Item</th><th class='qty'>Qty</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>"
    );
  }
  function printInventory(mode) {
    var groupsHtml = L.inventoryGroups().map(function (g) {
      var rows = g.items.map(function (itemId) {
        if (mode === "count") {
          return "<tr><td>" + esc(L.ITEMS[itemId]) + '</td><td class="qty">' + qtyOf(itemId) + '</td><td class="counted-blank"></td></tr>';
        }
        return "<tr><td>" + esc(L.ITEMS[itemId]) + '</td><td class="qty">' + qtyOf(itemId) + "</td></tr>";
      }).join("");
      return '<div class="group-head">' + esc(g.name) + "</div><table>" + rows + "</table>";
    }).join("");
    var title = mode === "count" ? "Count Sheet" : "Current Inventory";
    var head =
      '<div class="label-title">Alooma — ' + title + "</div>" +
      '<div class="label-sub">' + new Date().toLocaleString() + "</div>" +
      '<div class="order-id">Order ID: ____________________</div>';
    if (mode === "count") {
      head = '<div class="label-title">Alooma — Count Sheet</div><div class="label-sub">' +
        new Date().toLocaleString() + " · Write the counted number, then type it back in under Inventory → Enter counted numbers</div>";
      groupsHtml = L.inventoryGroups().map(function (g) {
        var rows = g.items.map(function (itemId) {
          return "<tr><td>" + esc(L.ITEMS[itemId]) + '</td><td class="qty">' + qtyOf(itemId) + '</td><td class="counted-blank">&nbsp;</td></tr>';
        }).join("");
        return '<div class="group-head">' + esc(g.name) + "</div><table><tr><th>Item</th><th class='qty'>Should be</th><th>Counted</th></tr>" + rows + "</table>";
      }).join("");
    }
    printHtml(head + groupsHtml);
  }

  /* ---------- Settings: connect / disconnect / backup ---------- */
  function renderSettings() {
    var status = $("settings-conn-status");
    var badge = $("conn-badge");
    if (state.editor) {
      badge.textContent = "Editor — " + (state.editor.login ? "@" + state.editor.login : "connected");
      badge.className = "badge badge-editor";
      document.body.classList.remove("view-only");
      status.innerHTML = "This device is connected as editor" +
        (state.editor.login ? " (<strong>@" + esc(state.editor.login) + "</strong>)" : "") +
        " for repo <strong>" + esc(state.editor.owner + "/" + state.editor.repo) + "</strong>. Changes made here are saved to that repo.";
      $("connect-form").hidden = true;
      $("disconnect-wrap").hidden = false;
    } else {
      badge.textContent = "View only";
      badge.className = "badge badge-view";
      document.body.classList.add("view-only");
      status.innerHTML = "This device is <strong>view-only</strong>. Anyone can view current status — no sign-in needed. To make changes from this device, connect it once with a GitHub token; it will be saved on this device only, and you can disconnect it any time here in Settings.";
      $("connect-form").hidden = false;
      $("disconnect-wrap").hidden = true;
    }
    $("about-repo").textContent = repoCfg().owner + "/" + repoCfg().repo;
    document.querySelectorAll(".editor-note").forEach(function (n) { /* visibility via body.view-only CSS on siblings; notes shown by CSS */ });
  }
  function connectDevice() {
    var token = $("gh-token").value.trim();
    var owner = $("gh-owner").value.trim() || DEFAULT_OWNER;
    var repo = $("gh-repo").value.trim() || DEFAULT_REPO;
    var err = $("connect-error"); err.textContent = "";
    if (!token) { err.textContent = "Paste a GitHub token first."; return; }
    var headers = { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token };
    fetch("https://api.github.com/user", { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("Token was rejected by GitHub (" + r.status + ")."); return r.json(); })
      .then(function (u) {
        return fetch("https://api.github.com/repos/" + owner + "/" + repo + "/contents/data.json?ref=main", { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error("Token works, but it can't read " + owner + "/" + repo + " (" + r.status + "). Check the repo name and that the token has Contents access to it.");
            return u;
          });
      })
      .then(function (u) {
        state.editor = { token: token, owner: owner, repo: repo, login: u.login || "" };
        try { localStorage.setItem(LS_KEY, JSON.stringify(state.editor)); } catch (e) { /* private mode etc. */ }
        $("gh-token").value = "";
        clearError();
        return loadData();
      })
      .then(function () {
        renderAll();
        toast("Connected — this device can now edit.");
      })
      .catch(function (e) { err.textContent = e.message; });
  }
  function disconnectDevice() {
    if (!window.confirm("Disconnect the GitHub token from this device?\n\nThe site becomes view-only here. Your data in the repo is not touched.")) return;
    state.editor = null;
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    state.sha = null;
    loadData().then(function () { renderAll(); toast("Disconnected — this device is view-only now."); });
  }
  function exportBackup() {
    var blob = new Blob([JSON.stringify(state.data, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "alooma-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function importBackup(file) {
    if (!requireEditor()) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(reader.result); } catch (e) { showError("That file is not valid JSON — import cancelled."); return; }
      if (!parsed || typeof parsed.inventory !== "object" || !Array.isArray(parsed.history)) {
        showError("That file doesn't look like an Alooma backup (needs inventory + history) — import cancelled."); return;
      }
      if (!window.confirm("Replace ALL current data with this backup?\n\nCurrent inventory and history will be overwritten. This is logged in History.")) return;
      state.data = parsed;
      normalizeData();
      var marker = newEntry("import", "Imported a backup file", [], {});
      state.data.history.unshift(marker);
      renderAll();
      saveData("Import backup").then(function () { toast("Backup imported and saved."); });
    };
    reader.readAsText(file);
  }

  /* ---------- wiring ---------- */
  function renderAll() {
    renderSettings();
    renderPack();
    renderHand();
    renderInventory();
    renderHistory();
  }
  function init() {
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved) state.editor = JSON.parse(saved);
    } catch (e) { state.editor = null; }

    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        $("tab-" + b.getAttribute("data-tab")).classList.add("active");
      });
    });
    $("pack-kits").addEventListener("input", renderPack);
    $("hand-kits").addEventListener("input", renderHand);
    $("btn-open-list").addEventListener("click", function () {
      var w = $("pack-list-wrap"); w.hidden = false;
      w.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("btn-print-sheet").addEventListener("click", printPackSheet);
    $("btn-complete-pack").addEventListener("click", completePacking);
    $("btn-record-hand").addEventListener("click", recordHand);
    $("btn-print-inventory").addEventListener("click", function () { printInventory("report"); });
    $("btn-print-count").addEventListener("click", function () { printInventory("count"); });
    $("btn-enter-counts").addEventListener("click", function () {
      var p = $("count-entry"); p.hidden = !p.hidden;
      if (!p.hidden) renderCountEntry();
    });
    $("btn-apply-counts").addEventListener("click", applyCounts);
    $("btn-cancel-counts").addEventListener("click", function () { $("count-entry").hidden = true; });
    $("btn-connect").addEventListener("click", connectDevice);
    $("btn-disconnect").addEventListener("click", disconnectDevice);
    $("btn-export").addEventListener("click", exportBackup);
    $("import-file").addEventListener("change", function (ev) {
      if (ev.target.files && ev.target.files[0]) importBackup(ev.target.files[0]);
      ev.target.value = "";
    });

    /* render the static shells first so the page is usable while data loads */
    if (!state.data) state.data = L.emptyData();
    renderAll();
    loadData().then(renderAll);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
