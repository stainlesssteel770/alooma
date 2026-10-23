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
    packCraft: null, handCraft: null, loadedAt: null, packPrintedKey: null
  };

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  var toastTimer = null;
  function showToast(html, actionLabel, actionFn, ms) {
    var t = $("toast");
    t.innerHTML = html;
    if (actionLabel) {
      var b = document.createElement("button");
      b.textContent = actionLabel;
      b.addEventListener("click", function () { t.hidden = true; actionFn(); });
      t.appendChild(b);
    }
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 4200);
  }
  function toast(msg) { showToast(esc(msg), null, null, 4200); }
  function actionToast(msg, entry) {
    showToast(esc(msg), "UNDO", function () { undoEntry(entry, true); }, 10000);
  }
  /* ---------- in-app confirm sheet (no window.confirm / window.prompt) ---------- */
  var sheetCb = null;
  function openSheet(opts) {
    $("sheet-title").textContent = opts.title || "";
    $("sheet-sub").textContent = opts.sub || "";
    $("sheet-summary").textContent = opts.summary || "";
    $("sheet-primary").textContent = opts.primary || "Confirm";
    var wrap = $("sheet-input-wrap");
    if (opts.input) {
      wrap.hidden = false;
      $("sheet-input-label").textContent = opts.input.label || "";
      var inp = $("sheet-input");
      inp.value = opts.input.value;
      inp.min = opts.input.min != null ? opts.input.min : "";
      inp.step = opts.input.step || 1;
    } else { wrap.hidden = true; }
    sheetCb = opts.onConfirm;
    $("sheet-backdrop").hidden = false;
  }
  function closeSheet() { $("sheet-backdrop").hidden = true; sheetCb = null; }
  function packSummary(pack) {
    var shorts = [];
    pack.forEach(function (r) {
      var oh = qtyOf(r.item);
      if (oh < r.qty) shorts.push(r.name + " " + oh + " of " + r.qty);
    });
    var s = pack.length + " items";
    if (shorts.length) {
      s += " · Short: " + shorts.slice(0, 2).join(" · ");
      if (shorts.length > 2) s += " · +" + (shorts.length - 2) + " more";
    } else { s += " · Nothing short"; }
    return s;
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
      .then(function () {
        normalizeData();
        state.loadFailed = false;
        document.body.classList.remove("load-failed");
        $("load-failed").hidden = true;
        state.syncKind = "Loaded";
        refreshSyncStatus();
      })
      .catch(function () {
        /* A failed load must never look like zero stock: show one empty
           state, no quantities, and every screen/action stays hidden. */
        state.loadFailed = true;
        document.body.classList.add("load-failed");
        $("load-failed").hidden = false;
        updateSaveStatus("Couldn't load data");
      });
  }
  function relAgo(d) {
    if (!d) return "";
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function refreshSyncStatus() {
    if (state.loadedAt) updateSaveStatus((state.syncKind || "Loaded") + " · " + relAgo(state.loadedAt));
  }
  function normalizeData() {
    if (!state.data || typeof state.data !== "object") state.data = L.emptyData();
    if (!state.data.inventory) state.data.inventory = {};
    Object.keys(L.ITEMS).forEach(function (id) {
      if (!state.data.inventory[id]) state.data.inventory[id] = { qty: 0, threshold: null };
    });
    if (!Array.isArray(state.data.history)) state.data.history = [];
    state.data.settings = L.normalizeSettings(state.data.settings);
  }
  function settings() {
    if (!state.data.settings) state.data.settings = L.defaultSettings();
    return state.data.settings;
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
      state.syncKind = "Saved";
      refreshSyncStatus();
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
    return saveData(commitMsg).then(function () { actionToast(entry.title, entry); });
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
      b.innerHTML = (c.id === selectedId ? '<span class="craft-check" aria-hidden="true">✓</span>' : "") +
        esc(c.name) + "<small>" + esc(c.code) + " · " + c.items.length + " items</small>";
      b.addEventListener("click", function () { onPick(c.id); });
      box.appendChild(b);
    });
  }
  function qtyOf(itemId) { return state.data.inventory[itemId] ? state.data.inventory[itemId].qty : 0; }

  /* ---------- Packing tab ---------- */
  function markChips(forId, kits) {
    document.querySelectorAll('.kits-chip[data-for="' + forId + '"]').forEach(function (c) {
      c.classList.toggle("selected", parseInt(c.getAttribute("data-kits"), 10) === kits);
    });
  }
  function updatePackProgress() {
    var boxes = $("pack-table").querySelectorAll("tbody input[type=checkbox]");
    var checked = 0;
    boxes.forEach(function (cb) { if (cb.checked) checked++; });
    var total = boxes.length;
    $("pack-progress").textContent = total ? checked + " of " + total + " checked" : "";
    $("pack-progress-fill").style.width = total ? Math.round(checked / total * 100) + "%" : "0";
    var btn = $("btn-complete-pack");
    var kitsNow = parseInt($("pack-kits").value, 10);
    var validSel = !!state.packCraft && L.validKits(kitsNow);
    var printed = validSel && state.packPrintedKey === state.packCraft + ":" + kitsNow;
    var ready = total > 0 && (checked === total || printed);
    btn.disabled = !ready;
    if (!state.packCraft) btn.textContent = "Choose a craft";
    else if (!L.validKits(kitsNow)) btn.textContent = "Choose kits";
    else if (!ready) btn.textContent = "Check " + (total - checked) + " more";
    else btn.textContent = "Complete " + L.sku(state.packCraft, kitsNow);
    $("btn-check-all").textContent = total > 0 && checked === total ? "Uncheck all" : "Check all";
  }
  var packFoldOverride = false;
  var packSortBin = false; /* Batch C2: sort the pack list + sheet by bin */
  var packBoxOverride = null; /* null = use the box rule; an array = this order only */
  var packSelKey = null;
  function currentBoxes() {
    var cur = currentPack(); if (!cur || !settings().features.boxes) return null;
    if (packBoxOverride !== null) return packBoxOverride.slice();
    return L.boxRuleFor(settings(), cur.craft.id, cur.kits);
  }
  function renderPackBoxes() {
    var cur = currentPack();
    var on = !!cur && settings().features.boxes;
    var rule = on ? L.boxRuleFor(settings(), cur.craft.id, cur.kits) : null;
    var show = on && (rule !== null || packBoxOverride !== null);
    $("pack-boxes").hidden = !show;
    if (!show) { $("pack-boxes-edit").hidden = true; return; }
    var boxes = packBoxOverride !== null ? packBoxOverride : rule;
    $("pack-boxes-text").textContent = boxes.length ? L.boxesText(settings(), boxes) : "None";
  }
  function renderPack() {
    craftButtons("pack-crafts", state.packCraft, function (id) { state.packCraft = id; packFoldOverride = false; renderPack(); });
    var kits = parseInt($("pack-kits").value, 10);
    markChips("pack", kits);
    var err = $("pack-error"), warn = $("pack-warning");
    err.textContent = ""; warn.hidden = true;
    var valid = L.validKits(kits);
    $("pack-sku").textContent = valid && state.packCraft ? L.sku(state.packCraft, kits) : "—";
    /* Batch B1: once craft + kits are chosen, fold the picker into one summary line */
    var folded = !packFoldOverride && !!state.packCraft && valid;
    $("pack-picker").hidden = folded;
    $("pack-picker-summary").hidden = !folded;
    if (folded) $("pack-summary-text").textContent = L.craftById(state.packCraft).name + " · " + kits + " kits";
    var selKey = state.packCraft + ":" + kits;
    if (selKey !== packSelKey) { packSelKey = selKey; packBoxOverride = null; $("pack-boxes-edit").hidden = true; }
    var tbody = $("pack-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!valid) {
      err.textContent = kits ? "Kits are ordered in multiples of 6 — use the stepper or a chip (6, 12, 18, 24…)." : "Enter the number of kits — orders are multiples of 6.";
      updatePackProgress();
      renderPackBoxes();
      return;
    }
    if (!state.packCraft) { updatePackProgress(); renderPackBoxes(); return; }
    var pack = L.computePack(state.packCraft, kits);
    var binsOn = settings().features.bins;
    $("btn-pack-sort").hidden = !binsOn;
    $("btn-pack-sort").textContent = packSortBin && binsOn ? "Sorted by bin ✓" : "Sort by bin";
    var rowsPack = pack.slice();
    if (packSortBin && binsOn) {
      rowsPack.sort(function (a, b) {
        var ba = L.binFor(settings(), a.item), bb = L.binFor(settings(), b.item);
        return ba < bb ? -1 : ba > bb ? 1 : 0;
      });
    }
    var shortages = [];
    rowsPack.forEach(function (r, idx) {
      var onHand = qtyOf(r.item);
      if (onHand < r.qty) shortages.push(r.name + " (need " + r.qty + ", have " + onHand + ")");
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td><input type="checkbox" data-idx="' + idx + '" aria-label="Packed: ' + esc(r.name) + '"></td>' +
        '<td><span class="row-name">' + esc(r.name) + "</span>" + (binsOn ? ' <span class="row-bin">' + esc(L.binFor(settings(), r.item)) + "</span>" : "") + "</td>" +
        '<td class="num">' + r.qty + "</td>" +
        '<td class="num' + (onHand < r.qty ? " short" : "") + '">' + onHand + "</td>";
      var cb = tr.querySelector("input");
      cb.addEventListener("change", function () {
        tr.classList.toggle("checked-row", cb.checked);
        updatePackProgress();
      });
      tr.addEventListener("click", function (ev) {
        if (ev.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
      });
      tbody.appendChild(tr);
    });
    if (shortages.length) {
      var shown = shortages.slice(0, 3).map(esc).join(" · ");
      var more = shortages.length > 3 ? " · +" + (shortages.length - 3) + " more" : "";
      var full = shortages.length > 3 ? "<details><summary>Show all " + shortages.length + " shortages</summary>" + shortages.map(esc).join(" · ") + "</details>" : "";
      warn.innerHTML = "<strong>Not enough on hand for:</strong> " + shown + more + full +
        "<br>You can still record this — counts will go below zero so the shortage stays visible.";
      warn.hidden = false;
    }
    updatePackProgress();
    renderPackBoxes();
  }
  function currentPack() {
    if (!state.packCraft) return null;
    var kits = parseInt($("pack-kits").value, 10);
    if (!L.validKits(kits)) return null;
    return { craft: L.craftById(state.packCraft), kits: kits, pack: L.computePack(state.packCraft, kits) };
  }
  function completePacking() {
    if (!requireEditor()) return;
    var cur = currentPack(); if (!cur) return;
    var craft = cur.craft;
    var boxes = currentBoxes();
    openSheet({
      title: craft.name,
      sub: cur.kits + " kits · " + L.sku(craft.id, cur.kits),
      summary: packSummary(cur.pack) + (boxes && boxes.length ? " · Boxes: " + L.boxesText(settings(), boxes) : ""),
      primary: "Subtract from inventory",
      onConfirm: function () {
        var entry = newEntry(
          "packed",
          "Packed " + craft.name + " — " + cur.kits + " kits (" + L.sku(craft.id, cur.kits) + ")",
          cur.pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
          { craftId: craft.id, kits: cur.kits }
        );
        state.packPrintedKey = null;
        commitChange(entry, "Packed " + L.sku(craft.id, cur.kits));
      }
    });
  }

  /* ---------- Hand-packed tab ---------- */
  function renderHand() {
    craftButtons("hand-crafts", state.handCraft, function (id) { state.handCraft = id; renderHand(); });
    var kits = parseInt($("hand-kits").value, 10);
    markChips("hand", kits);
    var err = $("hand-error"); err.textContent = "";
    var valid = L.validKits(kits);
    $("hand-sku").textContent = valid && state.handCraft ? L.sku(state.handCraft, kits) : "—";
    var tbody = $("hand-table").querySelector("tbody");
    tbody.innerHTML = "";
    var hb = $("btn-record-hand");
    hb.disabled = !(valid && state.handCraft);
    hb.textContent = !state.handCraft ? "Choose a craft"
      : !valid ? "Choose kits"
      : "Record " + L.sku(state.handCraft, kits);
    if (!valid || !state.handCraft) { err.textContent = kits && state.handCraft ? "Kits are ordered in multiples of 6 — use the stepper or a chip (6, 12, 18, 24…)." : ""; return; }
    L.computePack(state.handCraft, kits).forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(r.name) + '</td><td class="num">' + r.qty + '</td><td class="num">' + qtyOf(r.item) + "</td>";
      tbody.appendChild(tr);
    });
  }
  function recordHand() {
    if (!requireEditor()) return;
    var kits = parseInt($("hand-kits").value, 10);
    if (!state.handCraft || !L.validKits(kits)) return;
    var craft = L.craftById(state.handCraft);
    var pack = L.computePack(craft.id, kits);
    openSheet({
      title: craft.name,
      sub: kits + " kits · " + L.sku(craft.id, kits) + " · hand-packed",
      summary: packSummary(pack),
      primary: "Subtract from inventory",
      onConfirm: function () {
        var entry = newEntry(
          "hand-packed",
          "Hand-packed " + craft.name + " — " + kits + " kits (" + L.sku(craft.id, kits) + ")",
          pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
          { craftId: craft.id, kits: kits }
        );
        commitChange(entry, "Hand-packed " + L.sku(craft.id, kits));
      }
    });
  }

  /* ---------- Inventory tab ---------- */
  var invOpenItem = null, invPanelMode = "receive";
  var invQuery = "", invFilter = "all";
  var invSortBin = false; /* Batch C2: "By bin" sort toggle */
  function isLow(itemId) {
    var rec = state.data.inventory[itemId];
    return rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold;
  }
  function applyInvFilters() {
    var lowCount = 0, outCount = 0, total = 0;
    document.querySelectorAll(".inv-item").forEach(function (row) {
      var itemId = row.getAttribute("data-item");
      var rec = state.data.inventory[itemId];
      var low = isLow(itemId);
      if (low) lowCount++;
      if (rec && rec.qty === 0) outCount++;
      total++;
      var matchName = !invQuery || L.ITEMS[itemId].toLowerCase().indexOf(invQuery) >= 0;
      var matchMode = invFilter === "all" || (invFilter === "low" && low) || (invFilter === "out" && rec && rec.qty === 0);
      row.style.display = matchName && matchMode ? "" : "none";
    });
    document.querySelectorAll("#inventory-groups .inv-group").forEach(function (g) {
      var any = Array.prototype.some.call(g.querySelectorAll(".inv-item"), function (r) { return r.style.display !== "none"; });
      g.style.display = any ? "" : "none";
    });
    $("all-count").textContent = total;
    $("low-count").textContent = lowCount;
    $("out-count").textContent = outCount;
    $("btn-filter-all").setAttribute("aria-pressed", invFilter === "all" ? "true" : "false");
    $("btn-lowfilter").setAttribute("aria-pressed", invFilter === "low" ? "true" : "false");
    $("btn-outfilter").setAttribute("aria-pressed", invFilter === "out" ? "true" : "false");
    $("btn-binfilter").hidden = !settings().features.bins;
    $("btn-binfilter").setAttribute("aria-pressed", invSortBin ? "true" : "false");
  }
  function renderInventory() {
    var wrap = $("inventory-groups"); wrap.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var div = document.createElement("div"); div.className = "inv-group";
      var html = "<h3><span>" + esc(g.name) + '</span><span class="inv-onhand">On hand</span></h3>';
      var items = g.items.slice();
      if (invSortBin && settings().features.bins) {
        items.sort(function (a, b) {
          var ba = L.binFor(settings(), a), bb = L.binFor(settings(), b);
          return ba < bb ? -1 : ba > bb ? 1 : 0;
        });
      }
      items.forEach(function (itemId) {
        var rec = state.data.inventory[itemId];
        var badge = "";
        if (rec.qty === 0 && rec.threshold !== null && rec.threshold !== undefined) badge = '<span class="low-badge out-badge">Out of stock</span>';
        else if (isLow(itemId)) badge = '<span class="low-badge">Low · ≤' + rec.threshold + "</span>";
        html +=
          '<div class="inv-item" data-item="' + itemId + '">' +
          '<button type="button" class="inv-main" aria-expanded="' + (invOpenItem === itemId) + '">' +
          '<span class="inv-name">' + esc(L.ITEMS[itemId]) + "</span>" + badge + (settings().features.bins ? '<span class="inv-bin">' + esc(L.binFor(settings(), itemId)) + "</span>" : "") +
          '<span class="inv-qty">' + rec.qty + "</span>" +
          '<span class="inv-chev" aria-hidden="true">' + (invOpenItem === itemId ? "▾" : "▸") + "</span>" +
          "</button>";
        if (invOpenItem === itemId) {
          var modes = [["receive", "Receive"], ["set", "Set count"], ["warning", "Warning"]];
          if (settings().features.bins) modes.push(["bin", "Bin"]);
          var seg = modes.map(function (m) {
            return '<button type="button" data-mode="' + m[0] + '"' + (invPanelMode === m[0] ? ' class="on"' : "") + ">" + m[1] + "</button>";
          }).join("");
          var placeholder = invPanelMode === "receive" ? "How many arrived?"
            : invPanelMode === "set" ? "Actual count (now " + rec.qty + ")"
            : invPanelMode === "bin" ? "Bin label (now " + L.binFor(settings(), itemId) + ")"
            : "Warn at or below (blank = off)";
          var prefill = invPanelMode === "warning" && rec.threshold !== null && rec.threshold !== undefined ? rec.threshold
            : invPanelMode === "bin" ? (settings().bins[itemId] || "") : "";
          var goLabel = invPanelMode === "receive" ? "Add" : invPanelMode === "set" ? "Set" : "Save";
          html +=
            '<div class="inv-panel editor-only">' +
            '<div class="seg" role="group" aria-label="Action for ' + esc(L.ITEMS[itemId]) + '">' + seg + "</div>" +
            '<div class="inrow"><input type="' + (invPanelMode === "bin" ? "text" : "number") + '" class="inv-panel-input" min="0" step="1" inputmode="' + (invPanelMode === "bin" ? "text" : "numeric") + '" placeholder="' + placeholder + '" value="' + prefill + '">' +
            '<button type="button" class="go inv-panel-go">' + goLabel + "</button></div>" +
            '<div class="panel-note">On hand now: ' + rec.qty + (rec.threshold !== null && rec.threshold !== undefined ? " · low-stock warning at or below " + rec.threshold : " · no low-stock warning") + (settings().features.bins ? " · Bin " + esc(L.binFor(settings(), itemId)) : "") + "</div>" +
            "</div>";
        }
        html += "</div>";
      });
      div.innerHTML = html;
      wrap.appendChild(div);
    });
    wrap.querySelectorAll(".inv-item").forEach(function (row) {
      var itemId = row.getAttribute("data-item");
      var name = L.ITEMS[itemId];
      row.querySelector(".inv-main").addEventListener("click", function () {
        if (invOpenItem === itemId) { invOpenItem = null; }
        else { invOpenItem = itemId; invPanelMode = "receive"; }
        renderInventory();
      });
      var panel = row.querySelector(".inv-panel");
      if (!panel) return;
      panel.querySelectorAll(".seg button").forEach(function (b) {
        b.addEventListener("click", function () { invPanelMode = b.getAttribute("data-mode"); renderInventory(); });
      });
      panel.querySelector(".inv-panel-go").addEventListener("click", function () {
        if (!requireEditor()) return;
        var raw = panel.querySelector(".inv-panel-input").value;
        var v = raw === "" ? null : parseInt(raw, 10);
        if (invPanelMode === "receive") {
          if (!Number.isInteger(v) || v <= 0) { showError("Enter how many " + name + " were received (a whole number above 0)."); return; }
          clearError();
          commitChange(
            newEntry("received", "Received " + v + " × " + name, [{ item: itemId, delta: v }], { item: itemId, amount: v }),
            "Received " + v + " x " + name
          );
        } else if (invPanelMode === "set") {
          if (!Number.isInteger(v) || v < 0) { showError("Enter the actual counted number for " + name + " (0 or more)."); return; }
          var cur = qtyOf(itemId);
          if (v === cur) { toast(name + " is already " + cur + " — nothing to fix."); return; }
          clearError();
          commitChange(
            newEntry("count-fix", "Count fix " + name + ": " + cur + " → " + v, [{ item: itemId, delta: v - cur }], { item: itemId, counted: v }),
            "Count fix " + name + " to " + v
          );
        } else if (invPanelMode === "bin") {
          var binVal = raw.trim();
          clearError();
          if (binVal) settings().bins[itemId] = binVal; else delete settings().bins[itemId];
          renderAll();
          saveData("Bin " + name + " -> " + L.binFor(settings(), itemId))
            .then(function () { toast("Bin for " + name + ": " + L.binFor(settings(), itemId)); });
        } else {
          if (raw !== "" && (!Number.isInteger(v) || v < 0)) { showError("Low-stock warning for " + name + " must be 0 or more, or blank for off."); return; }
          clearError();
          state.data.inventory[itemId].threshold = v;
          renderAll();
          saveData("Low-stock warning " + name + " -> " + (v === null ? "off" : v))
            .then(function () { toast("Warning for " + name + ": " + (v === null ? "off" : "at or below " + v)); });
        }
      });
    });
    applyInvFilters();
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
  /* Batch B4: receive a whole delivery on one form — one save, one History entry per item */
  function renderDeliveryEntry() {
    var list = $("delivery-entry-list"); list.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var head = document.createElement("div");
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Arrived">';
        list.appendChild(row);
      });
    });
  }
  function applyDelivery() {
    if (!requireEditor()) return;
    var inputs = $("delivery-entry-list").querySelectorAll("input[data-item]");
    var received = [];
    inputs.forEach(function (inp) {
      if (inp.value === "") return;
      var v = parseInt(inp.value, 10);
      if (!Number.isInteger(v) || v <= 0) return;
      received.push({ item: inp.getAttribute("data-item"), amount: v });
    });
    if (!received.length) { toast("Type how many of each item arrived first — nothing to save yet."); return; }
    received.forEach(function (r) {
      var entry = newEntry(
        "received",
        "Received " + r.amount + " × " + L.ITEMS[r.item],
        [{ item: r.item, delta: r.amount }],
        { item: r.item, amount: r.amount }
      );
      /* apply locally without a save per item; one save at the end */
      L.applyEffects(state.data.inventory, entry.effects, +1);
      state.data.history.unshift(entry);
    });
    $("delivery-entry").hidden = true;
    renderAll();
    saveData("Delivery: " + received.length + " item(s) received").then(function () {
      toast("Delivery saved: " + received.length + " item(s) received.");
    });
  }

  /* ---------- History tab ---------- */
  var TYPE_LABEL = { "received": "Received", "packed": "Packed", "hand-packed": "Hand-packed", "count-fix": "Count fix", "import": "Backup import" };
  var TYPE_DOT = { "packed": "#1A7336", "hand-packed": "#20242B", "received": "#5C6570", "count-fix": "#8A4B00", "import": "#5C6570" };
  function fmtDateRel(iso) {
    var d = new Date(iso), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var yest = new Date(now); yest.setDate(now.getDate() - 1);
    var day = sameDay ? "Today" : d.toDateString() === yest.toDateString() ? "Yesterday"
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
    return day + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function renderHistory() {
    var wrap = $("history-list"); wrap.innerHTML = "";
    if (!state.data.history.length) { wrap.innerHTML = '<p class="hint">No changes logged yet.</p>'; return; }
    state.data.history.forEach(function (entry) {
      var div = document.createElement("div");
      div.className = "history-entry" + (entry.undone ? " undone" : "");
      var eff = entry.effects.map(function (e) {
        return esc(L.ITEMS[e.item] || e.item) + " " + (e.delta > 0 ? "+" : "") + e.delta;
      });
      var summary = eff.slice(0, 3).join(" · ");
      if (eff.length > 3) summary += " · +" + (eff.length - 3) + " more";
      var fullList = eff.length > 3
        ? "<details><summary>Show all " + eff.length + " changes</summary>" + eff.join(" · ") + "</details>" : "";
      div.innerHTML =
        '<div class="history-head"><span class="type-dot" style="background:' + (TYPE_DOT[entry.type] || "#5C6570") + '"></span>' +
        '<span class="history-title">' + esc(entry.title) + "</span>" +
        '<span class="history-date">' + esc(fmtDateRel(entry.ts)) + "</span></div>" +
        (eff.length ? '<div class="history-effects">' + summary + fullList + "</div>" : "") +
        (entry.undone ? '<div class="undone-tag">Undone</div>' : "") +
        (!entry.undone && state.editor ? '<div class="history-actions"><button class="btn btn-edit">Edit…</button><button class="btn btn-undo">Undo</button></div>' : "");
      wrap.appendChild(div);
      if (!entry.undone && state.editor) {
        div.querySelector(".btn-undo").addEventListener("click", function () { undoEntry(entry); });
        div.querySelector(".btn-edit").addEventListener("click", function () { editEntry(entry); });
      }
    });
  }
  function undoEntry(entry, skipConfirm) {
    if (!requireEditor()) return;
    if (entry.undone) return;
    var doUndo = function () {
      L.applyEffects(state.data.inventory, entry.effects, -1);
      entry.undone = true;
      renderAll();
      saveData("Undo: " + entry.title).then(function () { toast("Undone: " + entry.title); });
    };
    if (skipConfirm) { doUndo(); return; }
    var eff = entry.effects.map(function (e) {
      return (L.ITEMS[e.item] || e.item) + " " + (e.delta > 0 ? "+" : "") + e.delta;
    });
    var summary = eff.slice(0, 3).join(" · ") + (eff.length > 3 ? " · +" + (eff.length - 3) + " more" : "");
    openSheet({
      title: "Undo this entry?",
      sub: entry.title,
      summary: "These changes will be reversed exactly: " + summary,
      primary: "Undo — reverse it",
      onConfirm: doUndo
    });
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
      openSheet({
        title: "Edit entry",
        sub: "Received — " + (L.ITEMS[entry.item] || ""),
        summary: "",
        input: { label: "Received quantity", value: entry.amount, min: 1 },
        primary: "Save",
        onConfirm: function (v) {
          if (!Number.isInteger(v) || v <= 0) { toast("Enter a quantity above 0."); return; }
          replaceEffects(entry, [{ item: entry.item, delta: v }],
            "Received " + v + " × " + L.ITEMS[entry.item], { amount: v })
            .then(function () { toast("Entry updated."); });
        }
      });
    } else if (entry.type === "count-fix") {
      openSheet({
        title: "Edit entry",
        sub: "Count fix — " + (L.ITEMS[entry.item] || ""),
        summary: "",
        input: { label: "Counted number", value: entry.counted, min: 0 },
        primary: "Save",
        onConfirm: function (c) {
          if (!Number.isInteger(c) || c < 0) { toast("Enter a counted number, 0 or more."); return; }
          var oldDelta = entry.effects[0].delta;
          var before = entry.counted - oldDelta;
          replaceEffects(entry, [{ item: entry.item, delta: c - before }],
            "Count fix " + L.ITEMS[entry.item] + ": " + before + " → " + c, { counted: c })
            .then(function () { toast("Entry updated."); });
        }
      });
    } else if (entry.type === "packed" || entry.type === "hand-packed") {
      var craft0 = L.craftById(entry.craftId);
      openSheet({
        title: "Edit entry",
        sub: craft0.name + " — currently " + entry.kits + " kits (" + L.sku(entry.craftId, entry.kits) + ")",
        summary: "",
        input: { label: "Number of kits (multiple of 6)", value: entry.kits, min: 6, step: 6 },
        primary: "Save",
        onConfirm: function (k) {
          if (!L.validKits(k)) { toast("Kits must be a multiple of 6."); return; }
          if (k === entry.kits) return;
          var pack = L.computePack(entry.craftId, k);
          var verb = entry.type === "packed" ? "Packed" : "Hand-packed";
          var craft = L.craftById(entry.craftId);
          replaceEffects(entry,
            pack.map(function (r) { return { item: r.item, delta: -r.qty }; }),
            verb + " " + craft.name + " — " + k + " kits (" + L.sku(entry.craftId, k) + ")",
            { kits: k })
            .then(function () { toast("Entry updated."); });
        }
      });
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
    /* Printing the sheet means they're packing from paper: unlock Complete for this exact order. */
    state.packPrintedKey = cur.craft.id + ":" + cur.kits;
    updatePackProgress();
    var binsOn = settings().features.bins;
    var sheetPack = cur.pack.slice();
    if (packSortBin && binsOn) {
      sheetPack.sort(function (a, b) {
        var ba = L.binFor(settings(), a.item), bb = L.binFor(settings(), b.item);
        return ba < bb ? -1 : ba > bb ? 1 : 0;
      });
    }
    var rows = sheetPack.map(function (r) {
      return '<tr><td class="tick"><span class="tick-box"></span></td><td>' + esc(r.name) + "</td>" +
        (binsOn ? '<td class="bin">' + esc(L.binFor(settings(), r.item)) + "</td>" : "") +
        '<td class="qty">' + r.qty + "</td></tr>";
    }).join("");
    var boxes = currentBoxes();
    printHtml(
      "<table><thead>" +
      '<tr><th colspan="' + (binsOn ? 4 : 3) + '"><div class="label-title">' + esc(cur.craft.name) + "</div>" +
      '<div class="label-sub">SKU ' + esc(L.sku(cur.craft.id, cur.kits)) + " · " + cur.kits + " kits · " +
      new Date().toLocaleDateString() + "</div>" +
      (boxes && boxes.length ? '<div class="label-sub"><strong>BOXES: ' + esc(boxes.join(" + ")) + "</strong></div>" : "") +
      '<div class="order-id">Order ID: ____________________</div></th></tr>' +
      "<tr><th class='tick'></th><th>Item</th>" + (binsOn ? "<th>Bin</th>" : "") + "<th class='qty'>Qty</th></tr></thead>" +
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
      '<div class="label-sub">' + new Date().toLocaleString() + "</div>";
    if (mode === "count") {
      head = '<div class="label-title">Alooma — Count Sheet</div><div class="label-sub">' +
        new Date().toLocaleString() + " · Write the counted number, then type it back in under Inventory → Enter counted numbers</div>" +
        '<div class="label-sub">Columns: Item · Should be · Counted</div>';
      var binsOn = settings().features.bins;
      groupsHtml = L.inventoryGroups().map(function (g) {
        var cItems = g.items.slice();
        if (binsOn && invSortBin) {
          cItems.sort(function (a, b) {
            var ba = L.binFor(settings(), a), bb = L.binFor(settings(), b);
            return ba < bb ? -1 : ba > bb ? 1 : 0;
          });
        }
        var rows = cItems.map(function (itemId) {
          return "<tr><td>" + esc(L.ITEMS[itemId]) + "</td>" +
            (binsOn ? '<td class="bin">' + esc(L.binFor(settings(), itemId)) + "</td>" : "") +
            '<td class="qty">' + qtyOf(itemId) + '</td><td class="counted-blank">&nbsp;</td></tr>';
        }).join("");
        return '<div class="group-head">' + esc(g.name) + "</div><table>" + rows + "</table>";
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

  /* ---------- Settings: default boxes (Batch C1) ---------- */
  function renderBoxSettings() {
    var s = settings();
    $("set-boxes-on").checked = !!s.features.boxes;
    $("boxes-editor").hidden = !s.features.boxes;
    var meta = $("box-meta"); meta.innerHTML = "";
    L.BOX_IDS.forEach(function (b) {
      var row = document.createElement("div"); row.className = "box-meta-row";
      row.innerHTML = "<strong>" + b + "</strong>" +
        '<input type="text" data-box-name="' + b + '" value="' + esc(s.boxes[b].name) + '" aria-label="Name for box ' + b + '">' +
        '<input type="text" data-box-size="' + b + '" value="' + esc(s.boxes[b].size) + '" placeholder="Size (optional)" aria-label="Size for box ' + b + '">';
      meta.appendChild(row);
    });
    meta.querySelectorAll("input").forEach(function (inp) {
      inp.addEventListener("change", function () {
        if (!requireEditor()) return;
        var bn = inp.getAttribute("data-box-name"), bs = inp.getAttribute("data-box-size");
        if (bn) settings().boxes[bn].name = inp.value.trim() || ("Box " + bn);
        if (bs) settings().boxes[bs].size = inp.value.trim();
        saveData("Box details updated").then(function () { toast("Box details saved."); renderAll(); });
      });
    });
    var list = $("box-rules-list"); list.innerHTML = "";
    if (!s.boxRules.length) list.innerHTML = '<p class="hint">No rules yet.</p>';
    s.boxRules.forEach(function (r, idx) {
      var craft = L.craftById(r.craftId);
      var row = document.createElement("div"); row.className = "box-rule-row";
      row.innerHTML = "<span>" + esc(craft ? craft.name : r.craftId) + " · " + r.kits + " kits = " + esc(L.boxesText(s, r.boxes)) + "</span>";
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn btn-quiet"; del.textContent = "Delete";
      del.addEventListener("click", function () {
        if (!requireEditor()) return;
        settings().boxRules.splice(idx, 1);
        saveData("Box rule removed").then(function () { toast("Rule removed."); renderAll(); });
      });
      row.appendChild(del);
      list.appendChild(row);
    });
    var craftSel = $("rule-craft");
    if (!craftSel.options.length) {
      L.CRAFTS.forEach(function (c) {
        var o = document.createElement("option"); o.value = c.id; o.textContent = c.name;
        craftSel.appendChild(o);
      });
      var kitsSel = $("rule-kits");
      [6, 12, 18, 24, 30, 36].forEach(function (k) {
        var o = document.createElement("option"); o.value = k; o.textContent = k + " kits";
        kitsSel.appendChild(o);
      });
      var rb = $("rule-boxes");
      L.BOX_IDS.forEach(function (b) {
        var lab = document.createElement("label");
        lab.innerHTML = '<input type="checkbox" value="' + b + '"> ' + b;
        rb.appendChild(lab);
      });
    }
  }

  /* ---------- Settings: bin locations (Batch C2) ---------- */
  function renderBinSettings() {
    $("set-bins-on").checked = !!settings().features.bins;
  }

  /* ---------- wiring ---------- */
  function renderAll() {
    renderSettings();
    renderBoxSettings();
    renderBinSettings();
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
        document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.remove("active"); x.setAttribute("aria-selected", "false"); });
        document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        b.setAttribute("aria-selected", "true");
        $("tab-" + b.getAttribute("data-tab")).classList.add("active");
      });
    });
    $("pack-kits").addEventListener("input", function () { packFoldOverride = false; renderPack(); });
    $("btn-pack-change").addEventListener("click", function () { packFoldOverride = true; renderPack(); });
    $("hand-kits").addEventListener("input", renderHand);
    function wireStepper(inputId, minusId, plusId, renderFn) {
      $(minusId).addEventListener("click", function () {
        var v = parseInt($(inputId).value, 10);
        $(inputId).value = Number.isInteger(v) ? Math.max(6, v - 6) : 6;
        renderFn();
      });
      $(plusId).addEventListener("click", function () {
        var v = parseInt($(inputId).value, 10);
        $(inputId).value = Number.isInteger(v) ? v + 6 : 6;
        renderFn();
      });
    }
    wireStepper("pack-kits", "pack-minus", "pack-plus", function () { packFoldOverride = false; renderPack(); });
    wireStepper("hand-kits", "hand-minus", "hand-plus", renderHand);
    document.querySelectorAll(".kits-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var target = chip.getAttribute("data-for");
        $(target + "-kits").value = chip.getAttribute("data-kits");
        if (target === "pack") { packFoldOverride = false; renderPack(); } else renderHand();
      });
    });
    $("btn-check-all").addEventListener("click", function () {
      var boxes = $("pack-table").querySelectorAll("tbody input[type=checkbox]");
      var allChecked = boxes.length > 0 && Array.prototype.every.call(boxes, function (cb) { return cb.checked; });
      boxes.forEach(function (cb) {
        cb.checked = !allChecked;
        cb.closest("tr").classList.toggle("checked-row", cb.checked);
      });
      updatePackProgress();
    });
    $("inv-search").addEventListener("input", function (ev) { invQuery = ev.target.value.trim().toLowerCase(); applyInvFilters(); });
    $("btn-filter-all").addEventListener("click", function () { invFilter = "all"; applyInvFilters(); });
    $("btn-lowfilter").addEventListener("click", function () { invFilter = "low"; applyInvFilters(); });
    $("btn-outfilter").addEventListener("click", function () { invFilter = "out"; applyInvFilters(); });
    $("btn-binfilter").addEventListener("click", function () { invSortBin = !invSortBin; renderInventory(); });
    $("btn-pack-sort").addEventListener("click", function () { packSortBin = !packSortBin; renderPack(); });
    $("set-bins-on").addEventListener("change", function () {
      if (!requireEditor()) { renderBinSettings(); return; }
      settings().features.bins = $("set-bins-on").checked;
      if (!settings().features.bins) { invSortBin = false; packSortBin = false; }
      saveData("Bin locations " + (settings().features.bins ? "on" : "off")).then(function () { renderAll(); });
    });
    $("btn-print-menu").addEventListener("click", function () {
      var menu = $("print-menu");
      var open = menu.hidden;
      menu.hidden = !open;
      $("btn-print-menu").setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("print-menu").addEventListener("click", function () {
      $("print-menu").hidden = true;
      $("btn-print-menu").setAttribute("aria-expanded", "false");
    });
    document.addEventListener("click", function (ev) {
      var wrap = document.querySelector(".print-menu-wrap");
      if (wrap && !wrap.contains(ev.target)) {
        $("print-menu").hidden = true;
        $("btn-print-menu").setAttribute("aria-expanded", "false");
      }
    });
    $("sheet-primary").addEventListener("click", function () {
      var cb = sheetCb;
      if (!cb) { closeSheet(); return; }
      var val = null;
      if (!$("sheet-input-wrap").hidden) val = parseInt($("sheet-input").value, 10);
      closeSheet();
      cb(val);
    });
    $("sheet-cancel").addEventListener("click", closeSheet);
    $("sheet-backdrop").addEventListener("click", function (ev) { if (ev.target === $("sheet-backdrop")) closeSheet(); });
    $("btn-print-sheet").addEventListener("click", printPackSheet);
    $("btn-complete-pack").addEventListener("click", completePacking);
    $("btn-record-hand").addEventListener("click", recordHand);
    $("btn-print-inventory").addEventListener("click", function () { printInventory("report"); });
    $("btn-print-count").addEventListener("click", function () { printInventory("count"); });
    $("btn-enter-counts").addEventListener("click", function () {
      var p = $("count-entry"); p.hidden = !p.hidden;
      if (!p.hidden) renderCountEntry();
    });
    $("btn-retry-load").addEventListener("click", function () { loadData().then(renderAll); });
    setInterval(refreshSyncStatus, 30000);
    $("btn-apply-counts").addEventListener("click", applyCounts);
    $("btn-cancel-counts").addEventListener("click", function () { $("count-entry").hidden = true; });
    $("btn-delivery").addEventListener("click", function () {
      var p = $("delivery-entry"); p.hidden = !p.hidden;
      if (!p.hidden) renderDeliveryEntry();
    });
    $("btn-apply-delivery").addEventListener("click", applyDelivery);
    $("btn-cancel-delivery").addEventListener("click", function () { $("delivery-entry").hidden = true; });
    $("set-boxes-on").addEventListener("change", function () {
      if (!requireEditor()) { renderBoxSettings(); return; }
      settings().features.boxes = $("set-boxes-on").checked;
      saveData("Default boxes " + (settings().features.boxes ? "on" : "off")).then(function () { renderAll(); });
    });
    $("btn-rule-add").addEventListener("click", function () {
      if (!requireEditor()) return;
      var craftId = $("rule-craft").value;
      var kits = parseInt($("rule-kits").value, 10);
      var boxes = Array.prototype.map.call(document.querySelectorAll("#rule-boxes input:checked"), function (i) { return i.value; });
      if (!boxes.length) { toast("Tick at least one box for the rule."); return; }
      settings().boxRules = settings().boxRules.filter(function (r) { return !(r.craftId === craftId && r.kits === kits); });
      settings().boxRules.push({ craftId: craftId, kits: kits, boxes: boxes });
      saveData("Box rule added").then(function () { toast("Rule added."); renderAll(); });
    });
    $("btn-boxes-change").addEventListener("click", function () {
      var cur = currentBoxes() || [];
      var chips = $("pack-boxes-chips"); chips.innerHTML = "";
      L.BOX_IDS.forEach(function (b) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "kits-chip" + (cur.indexOf(b) >= 0 ? " selected" : "");
        chip.textContent = b;
        chip.setAttribute("data-box", b);
        chip.addEventListener("click", function () { chip.classList.toggle("selected"); });
        chips.appendChild(chip);
      });
      $("pack-boxes-edit").hidden = false;
    });
    $("btn-boxes-done").addEventListener("click", function () {
      packBoxOverride = Array.prototype.map.call(
        document.querySelectorAll("#pack-boxes-chips .kits-chip.selected"),
        function (c) { return c.getAttribute("data-box"); }
      );
      $("pack-boxes-edit").hidden = true;
      renderPackBoxes();
    });
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
