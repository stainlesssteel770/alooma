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
    packCraft: null, bulkCraft: null, loadedAt: null, packPrintedKey: null,
    offline: false, savedData: null, localBase: null
  };

  /* ---------- v3 E4: offline action queue + data snapshot ----------
     Saves are captured as ACTIONS (stock deltas, exact-count sets, history
     entries, settings keys) diffed against the last state this device
     knows it saved. Offline, actions queue on the device; on reconnect
     they are re-applied on top of the latest remote data, so both sides
     are kept. A queued exact count whose item also changed remotely is
     the ONLY case that stops and asks. Nothing ever overwrites the whole
     file silently. */
  var QUEUE_KEY = "alooma.queue.v1", SNAP_KEY = "alooma.snapshot.v1";
  var saveQueue = [];
  try { var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); if (Array.isArray(q)) saveQueue = q; } catch (e) {}
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function persistQueue() { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(saveQueue)); } catch (e) {} }
  function persistSnapshot() {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify({ data: state.data, sha: state.sha, savedData: state.savedData, at: new Date().toISOString() })); } catch (e) {}
  }
  function readSnapshot() {
    try { var s = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); return s && s.data ? s : null; } catch (e) { return null; }
  }

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
  /* v2 A3: batch saves (a whole delivery / count) get one UNDO that
     reverses every entry in the batch */
  function batchToast(msg, entries) {
    showToast(esc(msg), "UNDO", function () { undoEntries(entries); }, 10000);
  }
  function undoEntries(entries) {
    var any = false;
    entries.forEach(function (e) {
      if (!e.undone) { L.applyEffects(state.data.inventory, e.effects, -1); e.undone = true; any = true; }
    });
    if (!any) return;
    renderAll();
    saveData("Undo batch of " + entries.length).then(function () { toast("Undone — the whole batch was reversed."); });
  }
  function lastDeliveryFor(itemId) {
    for (var i = 0; i < state.data.history.length; i++) {
      var e = state.data.history[i];
      if (e.type === "received" && e.item === itemId && !e.undone) return e.amount || 0;
    }
    return 0;
  }
  /* The Inventory search box also filters the delivery / count forms:
     rows hide in place (typed values are never wiped by a re-render) */
  function filterEntryList(list) {
    if (!list) return;
    var head = null, headVisible = false;
    Array.prototype.forEach.call(list.children, function (el) {
      if (el.classList.contains("entry-head")) {
        if (head) head.style.display = headVisible ? "" : "none";
        head = el; headVisible = false;
      } else {
        var show = !invQuery || (el.getAttribute("data-name") || "").indexOf(invQuery) >= 0;
        el.style.display = show ? "" : "none";
        if (show) headVisible = true;
      }
    });
    if (head) head.style.display = headVisible ? "" : "none";
  }
  /* ---------- in-app confirm sheet (no window.confirm / window.prompt) ---------- */
  var sheetCb = null, sheetCancelCb = null;
  function openSheet(opts) {
    $("sheet-title").textContent = opts.title || "";
    $("sheet-sub").textContent = opts.sub || "";
    $("sheet-summary").textContent = opts.summary || "";
    var extra = $("sheet-extra");
    if (opts.extraHtml) { extra.innerHTML = opts.extraHtml; extra.hidden = false; }
    else { extra.innerHTML = ""; extra.hidden = true; }
    var prim = $("sheet-primary");
    prim.textContent = opts.primary || "Confirm";
    prim.classList.toggle("danger", !!opts.primaryDanger);
    var cancelBtn = $("sheet-cancel");
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    cancelBtn.classList.toggle("btn-primary", !!opts.cancelFilled);
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
    sheetCancelCb = opts.onCancel || null;
    $("sheet-backdrop").hidden = false;
  }
  function closeSheet() { $("sheet-backdrop").hidden = true; sheetCb = null; sheetCancelCb = null; }
  function dismissSheet() { var cb = sheetCancelCb; closeSheet(); if (cb) cb(); }
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
        /* v3 E4: this loaded state is the base the next save diffs against */
        state.offline = false;
        state.savedData = clone(state.data);
        state.localBase = clone(state.data);
        persistSnapshot();
        refreshSyncStatus();
      })
      .catch(function () {
        /* v3 E4: no signal but this device has saved before — open on the
           last saved copy and queue any edits as actions */
        var snap = readSnapshot();
        if (snap) {
          state.data = snap.data;
          state.sha = snap.sha || null;
          state.savedData = snap.savedData || null;
          state.localBase = clone(snap.data);
          state.offline = true;
          state.loadedAt = snap.at ? new Date(snap.at) : new Date();
          normalizeData();
          state.loadFailed = false;
          document.body.classList.remove("load-failed");
          $("load-failed").hidden = true;
          refreshSyncStatus();
          return;
        }
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
    if (s < 45) return "now";
    var m = Math.round(s / 60);
    if (m < 60) return m + " min ago";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function refreshSyncStatus() {
    var n = saveQueue.length;
    if (n) {
      updateSaveStatus((state.offline ? "Offline" : "Waiting to save") + " · " + n + (n === 1 ? " change" : " changes") + " waiting");
      return;
    }
    if (state.offline) { updateSaveStatus("Offline · last saved copy"); return; }
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
  /* ---------- v3 E4: save engine (actions, queue, merge) ---------- */
  function diffAction(message, from, to) {
    if (!from || !to) return null;
    var deltas = {}, sets = {}, fields = {}, entries = [], replaced = [], removed = [], setKeys = {};
    var fromHist = {}, toHist = {};
    (from.history || []).forEach(function (e) { fromHist[e.id] = e; });
    (to.history || []).forEach(function (e) {
      toHist[e.id] = e;
      if (!fromHist[e.id]) entries.push(e);
      else if (JSON.stringify(fromHist[e.id]) !== JSON.stringify(e)) replaced.push(e);
    });
    (from.history || []).forEach(function (e) { if (!toHist[e.id]) removed.push(e.id); });
    /* An item whose change came with a count-fix entry is an exact SET,
       not a delta — sets are the only conflict-sensitive op */
    var counted = {};
    entries.forEach(function (e) {
      if (e.type !== "count-fix") return;
      if (e.item) counted[e.item] = true;
      (e.effects || []).forEach(function (ef) { counted[ef.item] = true; });
    });
    Object.keys(L.ITEMS).forEach(function (id) {
      var a = from.inventory[id] || { qty: 0, threshold: null };
      var b = to.inventory[id] || { qty: 0, threshold: null };
      if (a.qty !== b.qty) {
        if (counted[id]) sets[id] = { to: b.qty, base: a.qty };
        else deltas[id] = b.qty - a.qty;
      }
      var at = a.threshold != null ? a.threshold : null, bt = b.threshold != null ? b.threshold : null;
      if (at !== bt) fields[id] = { threshold: bt };
    });
    ["features", "boxes", "boxRules", "bins"].forEach(function (k) {
      if (JSON.stringify((from.settings || {})[k]) !== JSON.stringify((to.settings || {})[k])) setKeys[k] = clone((to.settings || {})[k]);
    });
    var empty = !Object.keys(deltas).length && !Object.keys(sets).length && !Object.keys(fields).length &&
      !entries.length && !replaced.length && !removed.length && !Object.keys(setKeys).length;
    if (empty) return null;
    return { id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(),
      message: message, deltas: deltas, sets: sets, fields: fields, entries: entries, replaced: replaced, removed: removed, settings: setKeys };
  }
  function putData(data, sha, message) {
    var c = repoCfg();
    var body = { message: message, content: b64encode(JSON.stringify(data, null, 2) + "\n"), branch: "main" };
    if (sha) body.sha = sha;
    return fetch("https://api.github.com/repos/" + c.owner + "/" + c.repo + "/contents/data.json", {
      method: "PUT", headers: ghHeaders(), body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) { var e = new Error("save " + r.status); e.status = r.status; throw e; }
      return r.json();
    }).then(function (j) { return j.content && j.content.sha ? j.content.sha : sha; });
  }
  function getRemote() {
    return fetch(apiDataUrl(), { headers: ghHeaders(), cache: "no-store" })
      .then(function (r) { if (!r.ok) { var e = new Error("api " + r.status); e.status = r.status; throw e; } return r.json(); })
      .then(function (j) { return { data: JSON.parse(b64decode(j.content)), sha: j.sha }; });
  }
  function askCountConflict(itemId, mine, theirs) {
    return new Promise(function (resolve) {
      openSheet({
        title: "Count conflict — " + L.ITEMS[itemId],
        summary: "You counted " + mine + ". While you were offline, " + L.ITEMS[itemId] + " changed on GitHub — it is now " + theirs + ". Which number should stand?",
        primary: "Use my count (" + mine + ")",
        cancelLabel: "Keep " + theirs,
        onConfirm: function () { resolve(true); },
        onCancel: function () { resolve(false); }
      });
    });
  }
  function applyOneAction(d, a) {
    Object.keys(a.deltas || {}).forEach(function (id) { if (d.inventory[id]) d.inventory[id].qty += a.deltas[id]; });
    Object.keys(a.fields || {}).forEach(function (id) { if (d.inventory[id]) d.inventory[id].threshold = a.fields[id].threshold; });
    Object.keys(a.settings || {}).forEach(function (k) { if (!d.settings) d.settings = L.defaultSettings(); d.settings[k] = clone(a.settings[k]); });
    (a.entries || []).forEach(function (e) {
      if (!d.history.some(function (h) { return h.id === e.id; })) d.history.unshift(clone(e));
    });
    (a.replaced || []).forEach(function (e) {
      var i = d.history.findIndex(function (h) { return h.id === e.id; });
      if (i >= 0) d.history[i] = clone(e);
    });
    (a.removed || []).forEach(function (id) {
      d.history = d.history.filter(function (h) { return h.id !== id; });
    });
    var chain = Promise.resolve();
    Object.keys(a.sets || {}).forEach(function (id) {
      chain = chain.then(function () {
        var s = a.sets[id];
        if (!d.inventory[id]) return;
        var cur = d.inventory[id].qty;
        if (cur === s.base) { d.inventory[id].qty = s.to; return; }
        /* The item also changed remotely — the one case that asks */
        return askCountConflict(id, s.to, cur).then(function (mine) {
          if (mine) d.inventory[id].qty = s.to;
        });
      });
    });
    return chain;
  }
  function applyActionsTo(data, actions) {
    var d = clone(data);
    if (!d.inventory) d.inventory = {};
    Object.keys(L.ITEMS).forEach(function (id) { if (!d.inventory[id]) d.inventory[id] = { qty: 0, threshold: null }; });
    if (!Array.isArray(d.history)) d.history = [];
    var chain = Promise.resolve();
    actions.forEach(function (a) { chain = chain.then(function () { return applyOneAction(d, a); }); });
    return chain.then(function () { d.settings = L.normalizeSettings(d.settings); return d; });
  }
  function mergeAndSave(actions, message) {
    return getRemote().then(function (remote) {
      return applyActionsTo(remote.data, actions).then(function (merged) {
        return putData(merged, remote.sha, message).then(function (newSha) {
          state.data = merged;
          normalizeData();
          state.localBase = clone(state.data);
          state.savedData = clone(state.data);
          state.sha = newSha;
          state.loadedAt = new Date();
          state.syncKind = "Saved";
          renderAll();
          persistSnapshot();
          refreshSyncStatus();
        });
      });
    });
  }
  function enqueueAction(action) {
    saveQueue.push(action);
    persistQueue();
    refreshSyncStatus();
  }
  var flushing = false;
  function flushQueue() {
    if (flushing || !saveQueue.length || !state.editor || state.loadFailed) return Promise.resolve();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve();
    flushing = true;
    var actions = saveQueue.slice();
    var message = actions.length === 1 ? actions[0].message : "Sync of " + actions.length + " offline changes";
    return mergeAndSave(actions, message).then(function () {
      saveQueue = saveQueue.slice(actions.length);
      persistQueue();
      state.offline = false;
      refreshSyncStatus();
      toast(actions.length === 1 ? "Back online — your offline change is saved." : "Back online — " + actions.length + " offline changes saved.");
    }).catch(function (e) {
      if (e && e.name === "TypeError") state.offline = true;
      refreshSyncStatus();
    }).then(function () { flushing = false; });
  }
  function saveData(message) {
    if (!state.editor) return Promise.reject(new Error("view-only"));
    var action = diffAction(message, state.localBase, state.data);
    if (!action) { state.localBase = clone(state.data); return Promise.resolve(); }
    if (state.offline || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      state.localBase = clone(state.data);
      enqueueAction(action);
      return Promise.resolve();
    }
    updateSaveStatus("Saving…");
    return putData(state.data, state.sha, message).then(function (newSha) {
      state.sha = newSha;
      state.savedData = clone(state.data);
      state.localBase = clone(state.data);
      state.loadedAt = new Date();
      state.syncKind = "Saved";
      persistSnapshot();
      refreshSyncStatus();
    }).catch(function (e) {
      if (e && (e.status === 409 || e.status === 422)) {
        /* v3 E4: the file moved under us — reload and re-apply this change
           on top instead of overwriting the other save */
        return mergeAndSave([action], message).then(function () { state.localBase = clone(state.data); });
      }
      if (e && e.name === "TypeError") {
        /* The network dropped mid-save: keep the change as a queued action */
        state.offline = true;
        state.localBase = clone(state.data);
        enqueueAction(action);
        return;
      }
      updateSaveStatus("NOT saved — check connection");
      showError("Your change was made on this screen but could NOT be saved to GitHub (" + e.message + "). Do not rely on it until it saves — reload the page to see the true saved status, then try again.");
      throw e;
    });
  }
  function updateSaveStatus(txt) {
    var el = $("save-status");
    el.textContent = txt || "";
    /* v3 D7: at 360 the line only takes header room when it matters —
       a save just landed, is in flight, or failed */
    el.classList.toggle("fresh", /^(Saved|Saving|NOT saved|Couldn|Offline|Waiting)/.test(txt || ""));
  }

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
    else btn.textContent = "Complete " + L.sku(state.packCraft, kitsNow) + (printed && checked < total ? " · from sheet" : "");
    $("btn-check-all").textContent = total > 0 && checked === total ? "Uncheck all" : "Check all";
  }
  var packFoldOverride = false;
  var packMode = null; /* null until the packer picks: "print" (sheet) or "hand" (checklist) */
  var bulkLines = []; /* [{craftId, kits}] queued on the Bulk import tab, in-memory only */
  var packSortBin = false; /* Batch C2: sort the pack list + sheet by bin */
  var packBoxOverride = null; /* null = use the box rule; an array = this order only */
  var packSelKey = null;
  var packKitsTouched = false; /* v2 A1: the kits error shows only after the field is touched */
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
    /* v2 A1: calm first screen — the red kits error appears only once the
       kits field has been touched; until then a muted help line shows. */
    var showKitsErr = !valid && packKitsTouched;
    if (showKitsErr) err.textContent = kits ? "Kits are ordered in multiples of 6 — use the stepper or a chip (6, 12, 18, 24…)." : "Enter the number of kits — orders are multiples of 6.";
    $("pack-help").hidden = (state.packCraft && valid) || showKitsErr;
    $("pack-sku").textContent = valid && state.packCraft ? L.sku(state.packCraft, kits) : "—";
    /* Batch B1: once craft + kits are chosen, fold the picker into one summary line */
    var folded = !packFoldOverride && !!state.packCraft && valid;
    $("pack-picker").hidden = folded;
    $("pack-picker-summary").hidden = !folded;
    if (folded) $("pack-summary-text").textContent = L.craftById(state.packCraft).name + " · " + kits + " kits";
    var selKey = state.packCraft + ":" + kits;
    if (selKey !== packSelKey) { packSelKey = selKey; packBoxOverride = null; packMode = null; $("pack-boxes-edit").hidden = true; }
    var tbody = $("pack-table").querySelector("tbody");
    tbody.innerHTML = "";
    if (!valid) {
      updatePackProgress();
      renderPackBoxes();
      renderPackMode();
      return;
    }
    if (!state.packCraft) { updatePackProgress(); renderPackBoxes(); renderPackMode(); return; }
    clearError(); /* v2 A1: a stale banner (e.g. from a Print tap) clears once the selection is valid */
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
      if (onHand < r.qty) shortages.push({ name: r.name, have: onHand, need: r.qty, short: r.qty - onHand });
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
      /* v3 E1: the toggle carries the total; expanding lists every short
         item on its own line — have / need / short — biggest shortage first */
      shortages.sort(function (a, b) { return b.short - a.short; });
      var lineText = "⚠ " + shortages.length + (shortages.length === 1 ? " item short" : " items short");
      var items = shortages.map(function (s) {
        return "<li>" + esc(s.name) + ": have " + s.have + ", need " + s.need + ", short " + s.short + "</li>";
      }).join("");
      warn.innerHTML = '<button type="button" class="warn-toggle" aria-expanded="false">' + esc(lineText) + '</button>' +
        '<div class="warn-full" hidden><ul class="short-list">' + items + "</ul>" +
        "<p>You can still record this — counts will go below zero so the shortage stays visible.</p></div>";
      var wt = warn.querySelector(".warn-toggle"), wf = warn.querySelector(".warn-full");
      wt.addEventListener("click", function () {
        var open = wf.hidden;
        wf.hidden = !open;
        wt.setAttribute("aria-expanded", open ? "true" : "false");
      });
      warn.hidden = false;
    }
    updatePackProgress();
    renderPackBoxes();
    renderPackMode();
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
    /* v2 A2: a short order must look different — red block naming each
       shortage and where its count lands, danger primary, filled Go back */
    var shorts = cur.pack.filter(function (r) { return qtyOf(r.item) < r.qty; });
    shorts.sort(function (a, b) { return (b.qty - qtyOf(b.item)) - (a.qty - qtyOf(a.item)); });
    var sheetOpts = {
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
    };
    if (shorts.length) {
      sheetOpts.extraHtml = '<div class="sheet-short"><p class="sheet-short-title">⚠ ' + shorts.length + (shorts.length === 1 ? " item short" : " items short") + "</p><ul>" +
        shorts.map(function (r) { var have = qtyOf(r.item); return "<li>" + esc(r.name) + ": have " + have + ", need " + r.qty + ", short " + (r.qty - have) + "</li>"; }).join("") + "</ul></div>";
      sheetOpts.primary = "Subtract anyway (" + shorts.length + " short)";
      sheetOpts.primaryDanger = true;
      sheetOpts.cancelLabel = "Go back";
      sheetOpts.cancelFilled = true;
    }
    openSheet(sheetOpts);
  }

  /* ---------- Pack path choice + Bulk import tab ---------- */
  /* After craft + kits are chosen on Packing, the packer picks a path: Print
     (print the sheet; Complete appears, unlocked by printing) or Hand pack
     (the on-screen checklist — the only place it shows). Separately, the Bulk
     import tab records orders that were already packed by hand: queue any mix
     of crafts and kit amounts, then record them all in one save. */
  function renderPackMode() {
    var kits = parseInt($("pack-kits").value, 10);
    var hasSel = !!state.packCraft && L.validKits(kits);
    var chosen = hasSel && packMode !== null;
    $("pack-mode").hidden = !hasSel;
    $("btn-print-sheet").classList.toggle("selected", packMode === "print");
    $("btn-mode-hand").classList.toggle("selected", packMode === "hand");
    $("pack-order").hidden = !chosen;
    $("pack-checklist").hidden = packMode !== "hand";
    if (!chosen) $("pack-warning").hidden = true;
  }
  function renderBulk() {
    craftButtons("bulk-crafts", state.bulkCraft, function (id) { state.bulkCraft = id; renderBulk(); });
    var kits = parseInt($("bulk-kits").value, 10);
    markChips("bulk", kits);
    var err = $("bulk-error"); err.textContent = "";
    var valid = L.validKits(kits);
    $("bulk-sku").textContent = valid && state.bulkCraft ? L.sku(state.bulkCraft, kits) : "—";
    if (state.bulkCraft && kits && !valid) err.textContent = "Kits are ordered in multiples of 6 — use the stepper or a chip (6, 12, 18, 24…).";
    renderBulkLines();
  }
  function renderBulkLines() {
    var wrap = $("bulk-lines");
    wrap.innerHTML = "";
    if (!bulkLines.length) {
      wrap.innerHTML = '<p class="hint">No orders added yet — pick a craft and kit amount above, then tap Add.</p>';
    }
    bulkLines.forEach(function (ln, i) {
      var craft = L.craftById(ln.craftId);
      var row = document.createElement("div");
      row.className = "hand-line";
      row.innerHTML = "<span>" + esc(craft.name) + " · " + ln.kits + " kits · " + esc(L.sku(ln.craftId, ln.kits)) + "</span>" +
        '<button type="button" class="btn btn-quiet" data-remove="' + i + '" aria-label="Remove ' + esc(L.sku(ln.craftId, ln.kits)) + '">✕</button>';
      wrap.appendChild(row);
    });
    var add = $("btn-bulk-add");
    var kits = parseInt($("bulk-kits").value, 10);
    add.disabled = !(!!state.bulkCraft && L.validKits(kits));
    add.textContent = !state.bulkCraft ? "Pick a craft"
      : !L.validKits(kits) ? "Choose kits"
      : "Add " + L.sku(state.bulkCraft, kits);
    var rec = $("btn-bulk-record");
    rec.disabled = !bulkLines.length;
    rec.textContent = bulkLines.length
      ? "Record all · " + bulkLines.length + (bulkLines.length === 1 ? " order" : " orders")
      : "Record all";
  }
  function addBulkLine() {
    if (!requireEditor()) return;
    var kits = parseInt($("bulk-kits").value, 10);
    if (!state.bulkCraft || !L.validKits(kits)) return;
    var craftId = state.bulkCraft;
    var sku = L.sku(craftId, kits);
    /* v3 D1: the same order twice is almost always a double tap — ask first */
    var dup = bulkLines.some(function (ln) { return ln.craftId === craftId && ln.kits === kits; });
    if (dup) {
      openSheet({
        title: sku + " is already in the list.",
        summary: "Add another " + sku + " to the queue?",
        primary: "Add another",
        cancelLabel: "Keep one",
        onConfirm: function () { queueBulkLine(craftId, kits); }
      });
      return;
    }
    queueBulkLine(craftId, kits);
  }
  function queueBulkLine(craftId, kits) {
    var line = { craftId: craftId, kits: kits };
    bulkLines.push(line);
    /* v3 D1: clear the picker after each Add, so a second tap on Add
       can't quietly queue the same order twice */
    state.bulkCraft = null;
    $("bulk-kits").value = "";
    renderBulk();
    showToast("Added " + esc(L.sku(craftId, kits)), "UNDO", function () {
      var i = bulkLines.indexOf(line);
      if (i >= 0) { bulkLines.splice(i, 1); renderBulk(); }
    }, 8000);
  }
  function recordAllBulk() {
    if (!requireEditor()) return;
    if (!bulkLines.length) return;
    var lines = bulkLines.slice();
    /* Aggregate the batch for the confirm summary so shortages account for
       every line, not just one order at a time. */
    var aggByItem = {}, aggPack = [];
    lines.forEach(function (ln) {
      L.computePack(ln.craftId, ln.kits).forEach(function (r) {
        if (aggByItem[r.item]) aggByItem[r.item].qty += r.qty;
        else { var c = { item: r.item, name: r.name, qty: r.qty }; aggByItem[r.item] = c; aggPack.push(c); }
      });
    });
    var skus = lines.map(function (ln) { return L.sku(ln.craftId, ln.kits); });
    openSheet({
      title: "Hand-packed",
      sub: lines.length + (lines.length === 1 ? " order: " : " orders: ") +
        skus.slice(0, 3).join(", ") + (skus.length > 3 ? " +" + (skus.length - 3) + " more" : "") + " · hand-packed",
      summary: packSummary(aggPack),
      primary: "Subtract from inventory",
      onConfirm: function () {
        /* One history entry per order (Undo/Edit keep working per order),
           applied locally like a delivery, then a SINGLE save for the batch. */
        lines.slice().reverse().forEach(function (ln) {
          var craft = L.craftById(ln.craftId);
          var entry = newEntry(
            "hand-packed",
            "Hand-packed " + craft.name + " — " + ln.kits + " kits (" + L.sku(ln.craftId, ln.kits) + ")",
            L.computePack(ln.craftId, ln.kits).map(function (r) { return { item: r.item, delta: -r.qty }; }),
            { craftId: ln.craftId, kits: ln.kits }
          );
          L.applyEffects(state.data.inventory, entry.effects, +1);
          state.data.history.unshift(entry);
        });
        bulkLines = [];
        renderAll();
        saveData("Hand-packed " + lines.length + " order(s)").then(function () {
          toast("Recorded " + lines.length + " hand-packed order" + (lines.length === 1 ? "" : "s") + ".");
        });
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
    updateReorderButton();
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
        if (rec.qty === 0) badge = '<span class="low-badge out-badge">Out of stock</span>';
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
          var placeholder = invPanelMode === "receive" ? "Amount"
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
      head.className = "entry-head";
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.setAttribute("data-name", L.ITEMS[itemId].toLowerCase());
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Counted">';
        list.appendChild(row);
      });
    });
    filterEntryList(list);
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
      if (v !== cur) changes.push({ item: itemId, counted: v, delta: v - cur, cur: cur });
    });
    if (!changes.length) { toast("No counts differ from what's on hand — nothing to apply."); return; }
    /* v2 A3: confirm sheet first. A count that differs from on-hand by more
       than 50% either way is flagged amber; on-hand 0 is never flagged
       (user's rule — with everything at 0 it would flag the world). */
    var lines = changes.map(function (ch) {
      var flag = "";
      if (ch.cur !== 0 && Math.abs(ch.counted - ch.cur) > Math.abs(ch.cur) / 2) {
        var pct = Math.round((ch.counted - ch.cur) / Math.abs(ch.cur) * 100);
        flag = ' <span class="flag">(' + (pct > 0 ? "+" : "") + pct + "% — double-check)</span>";
      }
      return "<li>" + esc(L.ITEMS[ch.item]) + ": " + ch.cur + " → " + ch.counted + flag + "</li>";
    }).join("");
    openSheet({
      title: "Set " + changes.length + (changes.length === 1 ? " count?" : " counts?"),
      summary: "Check the new counts — nothing is saved yet.",
      extraHtml: '<ul class="sheet-lines">' + lines + "</ul>",
      primary: "Apply counts",
      cancelLabel: "Edit numbers",
      onConfirm: function () {
        var entries = [];
        changes.forEach(function (ch) {
          var entry = newEntry(
            "count-fix",
            "Count fix " + L.ITEMS[ch.item] + ": " + ch.cur + " → " + ch.counted,
            [{ item: ch.item, delta: ch.delta }],
            { item: ch.item, counted: ch.counted }
          );
          /* apply locally without a save per item; one save at the end */
          L.applyEffects(state.data.inventory, entry.effects, +1);
          state.data.history.unshift(entry);
          entries.push(entry);
        });
        $("count-entry").hidden = true;
        renderAll();
        saveData("Count entry: " + entries.length + " item(s) fixed").then(function () {
          batchToast("Counts applied: " + entries.length + " item(s) updated.", entries);
        });
      }
    });
  }
  /* Batch B4: receive a whole delivery on one form — one save, one History entry per item */
  function renderDeliveryEntry() {
    var list = $("delivery-entry-list"); list.innerHTML = "";
    L.inventoryGroups().forEach(function (g) {
      var head = document.createElement("div");
      head.className = "entry-head";
      head.innerHTML = "<strong>" + esc(g.name) + "</strong>";
      list.appendChild(head);
      g.items.forEach(function (itemId) {
        var row = document.createElement("div"); row.className = "count-row";
        row.setAttribute("data-name", L.ITEMS[itemId].toLowerCase());
        row.innerHTML = "<span>" + esc(L.ITEMS[itemId]) + " (on hand: " + qtyOf(itemId) + ')</span>' +
          '<input type="number" min="0" step="1" data-item="' + itemId + '" placeholder="Arrived">';
        list.appendChild(row);
      });
    });
    filterEntryList(list);
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
    /* v2 A3: confirm sheet first; an amount over 5× that item's last
       delivery is flagged amber in the list */
    var lines = received.map(function (r) {
      var last = lastDeliveryFor(r.item);
      var onHand = qtyOf(r.item);
      var flag = "";
      if (last > 0 && r.amount > 5 * last) flag = ' <span class="flag">(' + Math.round(r.amount / last) + "× usual)</span>";
      /* v3 D5: no earlier delivery to compare with — flag against on-hand instead */
      else if (last <= 0 && onHand > 0 && r.amount > 5 * onHand) flag = ' <span class="flag">(' + Math.round(r.amount / onHand) + "× on hand)</span>";
      return "<li>" + esc(L.ITEMS[r.item]) + " +" + r.amount + flag + "</li>";
    }).join("");
    openSheet({
      title: "Add " + received.length + (received.length === 1 ? " item" : " items") + " to stock?",
      summary: "Check the amounts — nothing is saved yet.",
      extraHtml: '<ul class="sheet-lines">' + lines + "</ul>",
      primary: "Add to stock",
      cancelLabel: "Edit numbers",
      onConfirm: function () {
        var entries = [];
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
          entries.push(entry);
        });
        $("delivery-entry").hidden = true;
        renderAll();
        saveData("Delivery: " + received.length + " item(s) received").then(function () {
          batchToast("Delivery saved: " + received.length + " item(s) received.", entries);
        });
      }
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

  /* ---------- v3 E2: reorder list ---------- */
  function reorderItems() {
    var out = [];
    L.inventoryGroups().forEach(function (g) {
      g.items.forEach(function (itemId) {
        var rec = state.data.inventory[itemId];
        if (rec && rec.threshold !== null && rec.threshold !== undefined && rec.qty <= rec.threshold) {
          out.push({ item: itemId, name: L.ITEMS[itemId], group: g.name, qty: rec.qty, level: rec.threshold, order: Math.max(0, rec.threshold * 2 - rec.qty) });
        }
      });
    });
    return out;
  }
  function updateReorderButton() {
    var b = $("btn-reorder");
    if (!b) return;
    var n = reorderItems().length;
    b.textContent = "Reorder · " + n;
    b.disabled = n === 0;
  }
  function renderReorderPanel() {
    var list = $("reorder-list"); list.innerHTML = "";
    var items = reorderItems();
    if (!items.length) {
      list.innerHTML = '<p class="hint">Nothing is at or under its warning level right now.</p>';
      return;
    }
    items.forEach(function (r) {
      var row = document.createElement("div"); row.className = "count-row";
      row.innerHTML = "<span>" + esc(r.name) + " (on hand: " + r.qty + " · warning at " + r.level + ')</span>' +
        '<input type="number" min="0" step="1" data-item="' + r.item + '" value="' + r.order + '" aria-label="Order quantity for ' + esc(r.name) + '">';
      list.appendChild(row);
    });
  }
  function printReorder() {
    var qtys = {};
    $("reorder-list").querySelectorAll("input[data-item]").forEach(function (inp) {
      var v = parseInt(inp.value, 10);
      qtys[inp.getAttribute("data-item")] = Number.isInteger(v) && v >= 0 ? v : 0;
    });
    var groups = {}, order = [];
    reorderItems().forEach(function (r) {
      if (!groups[r.group]) { groups[r.group] = []; order.push(r.group); }
      groups[r.group].push(r);
    });
    var html = '<div class="label-title">Alooma — Reorder List</div>' +
      '<div class="label-sub">' + new Date().toLocaleString() + "</div>" +
      '<div class="label-sub">Order qty = 2 × warning level − on hand, unless edited before printing.</div>';
    order.forEach(function (g) {
      var rows = groups[g].map(function (r) {
        return "<tr><td>" + esc(r.name) + '</td><td class="qty">' + r.qty + '</td><td class="qty">' + r.level + '</td><td class="qty">' + (qtys[r.item] != null ? qtys[r.item] : r.order) + "</td></tr>";
      }).join("");
      html += '<div class="group-head">' + esc(g) + '</div><table><tr><th>Item</th><th>On hand</th><th>Warning level</th><th>Order qty</th></tr>' + rows + "</table>";
    });
    printHtml(html);
  }

  /* ---------- Settings: connect / disconnect / backup ---------- */
  function activateTab(name) {
    document.querySelectorAll("#tabs button").forEach(function (x) {
      var on = x.getAttribute("data-tab") === name;
      x.classList.toggle("active", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.toggle("active", x.id === "tab-" + name); });
    if (name === "settings") renderBackupNote();
  }
  /* View-only devices see ONLY Inventory and History (the user's rule). The
     connect screen stays reachable by tapping the header badge. */
  function applyTabAccess() {
    var editor = !!state.editor;
    document.querySelectorAll("#tabs button").forEach(function (b) {
      var t = b.getAttribute("data-tab");
      b.hidden = !editor && t !== "inventory" && t !== "history";
    });
    if (!editor) {
      var active = document.querySelector("#tabs button.active");
      if (active && active.hidden) activateTab("inventory");
    }
  }
  function renderSettings() {
    var status = $("settings-conn-status");
    var badge = $("conn-badge");
    if (state.editor) {
      badge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg> Editor';
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
      status.innerHTML = "This device is <strong>view-only</strong>: it can see Inventory and History only. To make changes from this device, connect it once — sign in with GitHub or paste a token; the sign-in is saved on this device only, and you can disconnect it any time here in Settings.";
      $("connect-form").hidden = false;
      $("disconnect-wrap").hidden = true;
    }
    /* v3 D6: viewers get the Print button at the right end of the chip
       row — the 48px editor action row is not spent on one icon for them */
    var pwrap = document.querySelector(".print-menu-wrap");
    var ptarget = state.editor ? document.querySelector(".inv-actions") : document.querySelector(".inv-filters");
    if (pwrap && ptarget && pwrap.parentElement !== ptarget) ptarget.appendChild(pwrap);
    $("device-login").hidden = !GH_APP_CLIENT_ID;
    applyTabAccess();
    renderBackupNote();
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
    /* v2 A6: the last pop-ups move into the in-app sheet */
    openSheet({
      title: "Disconnect this device?",
      summary: "The site becomes view-only here (Inventory and History only). Your data in the repo is not touched.",
      primary: "Disconnect",
      onConfirm: function () {
        state.editor = null;
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
        state.sha = null;
        loadData().then(function () { renderAll(); toast("Disconnected — this device is view-only now."); });
      }
    });
  }
  /* ---------- GitHub App device sign-in (no token to paste) ---------- */
  /* Public client ID of the "Alooma Packing" GitHub App (alooma repo only,
     Contents read/write, device flow on, user tokens non-expiring). Empty =
     the sign-in block stays hidden and the token path is the only connect. */
  var GH_APP_CLIENT_ID = "";
  var devicePoll = null;
  function stopDeviceLogin() {
    if (devicePoll) { clearTimeout(devicePoll); devicePoll = null; }
    $("device-login-wait").hidden = true;
    $("btn-gh-login").disabled = false;
  }
  function startDeviceLogin() {
    var err = $("connect-error"); err.textContent = "";
    stopDeviceLogin();
    fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GH_APP_CLIENT_ID })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.device_code) throw new Error((d && d.error_description) || "GitHub did not return a sign-in code.");
      $("device-code").textContent = d.user_code;
      $("device-login-wait").hidden = false;
      $("btn-gh-login").disabled = true;
      var interval = (d.interval || 5) * 1000;
      var deadline = Date.now() + (d.expires_in || 900) * 1000;
      var poll = function () {
        if (Date.now() > deadline) { stopDeviceLogin(); err.textContent = "That code expired — tap Connect with GitHub to get a new one."; return; }
        fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: GH_APP_CLIENT_ID, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
        }).then(function (r) { return r.json(); }).then(function (t) {
          if (t.access_token) { finishDeviceLogin(t.access_token); return; }
          if (t.error === "authorization_pending") { devicePoll = setTimeout(poll, interval); return; }
          if (t.error === "slow_down") { interval += 5000; devicePoll = setTimeout(poll, interval); return; }
          stopDeviceLogin();
          err.textContent = t.error === "access_denied" ? "The sign-in was denied on GitHub." : (t.error_description || "GitHub sign-in failed (" + t.error + ").");
        }).catch(function () { devicePoll = setTimeout(poll, interval); });
      };
      devicePoll = setTimeout(poll, interval);
    }).catch(function () {
      err.textContent = "Couldn't reach GitHub to start the sign-in. If this keeps happening, connect with a token instead (below).";
    });
  }
  function finishDeviceLogin(token) {
    stopDeviceLogin();
    var headers = { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + token };
    fetch("https://api.github.com/user", { headers: headers })
      .then(function (r) { if (!r.ok) throw new Error("GitHub approved the sign-in but the token was rejected (" + r.status + ")."); return r.json(); })
      .then(function (u) {
        return fetch("https://api.github.com/repos/" + DEFAULT_OWNER + "/" + DEFAULT_REPO + "/contents/data.json?ref=main", { headers: headers })
          .then(function (r) {
            if (!r.ok) throw new Error("Signed in, but the app can't read " + DEFAULT_OWNER + "/" + DEFAULT_REPO + " (" + r.status + "). The GitHub App must be installed on that repo.");
            return u;
          });
      })
      .then(function (u) {
        state.editor = { token: token, owner: DEFAULT_OWNER, repo: DEFAULT_REPO, login: u.login || "", kind: "device" };
        try { localStorage.setItem(LS_KEY, JSON.stringify(state.editor)); } catch (e) { /* private mode etc. */ }
        clearError();
        return loadData();
      })
      .then(function () {
        renderAll();
        toast("Connected — this device can now edit.");
      })
      .catch(function (e) { $("connect-error").textContent = e.message; });
  }
  function exportBackup() {
    var blob = new Blob([JSON.stringify(state.data, null, 2) + "\n"], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "alooma-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    /* v3 E3: remember on this device when the last backup was taken */
    try { localStorage.setItem("alooma.lastBackup.v1", new Date().toISOString()); } catch (e) {}
    renderBackupNote();
  }
  function renderBackupNote() {
    var el = $("last-backup");
    if (!el) return;
    var raw = null;
    try { raw = localStorage.getItem("alooma.lastBackup.v1"); } catch (e) {}
    var d = raw ? new Date(raw) : null;
    el.textContent = "Last backup (this device): " + (d && !isNaN(d.getTime())
      ? d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
      : "never");
    var stale = $("backup-stale");
    if (stale) stale.hidden = !!d && !isNaN(d.getTime()) && (Date.now() - d.getTime()) < 7 * 24 * 3600 * 1000;
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
      openSheet({
        title: "Replace all data with this backup?",
        summary: "Current inventory and history will be overwritten. This is logged in History.",
        primary: "Replace all data",
        onConfirm: function () {
          state.data = parsed;
          normalizeData();
          var marker = newEntry("import", "Imported a backup file", [], {});
          state.data.history.unshift(marker);
          renderAll();
          saveData("Import backup").then(function () { toast("Backup imported and saved."); });
        }
      });
    };
    reader.readAsText(file);
  }

  /* ---------- Settings: default boxes (Batch C1, free-form list) ---------- */
  /* Boxes are a simple list of names the user adds himself (any count, no
     sizes). A rule = craft (dropdown) + kit count (typed, multiples of 6
     only) + ANY number of boxes: each pick from the box dropdown adds one
     to the rule (shown as chips), so bigger orders can default to two,
     three, four boxes. */
  var rulePickedBoxes = []; /* boxes chosen so far for the rule being built */
  function renderBoxSettings() {
    var s = settings();
    $("set-boxes-on").checked = !!s.features.boxes;
    $("boxes-editor").hidden = !s.features.boxes;
    var list = $("box-list"); list.innerHTML = "";
    if (!s.boxes.length) list.innerHTML = '<p class="hint">No boxes yet — add your first box below.</p>';
    s.boxes.forEach(function (name) {
      var row = document.createElement("div"); row.className = "box-rule-row";
      row.innerHTML = "<span>" + esc(name) + "</span>";
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn btn-quiet"; del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete box " + name);
      del.addEventListener("click", function () {
        if (!requireEditor()) return;
        settings().boxes = settings().boxes.filter(function (b) { return b !== name; });
        /* A deleted box disappears from any rules that used it */
        settings().boxRules = settings().boxRules.map(function (r) {
          return { craftId: r.craftId, kits: r.kits, boxes: r.boxes.filter(function (b) { return b !== name; }) };
        }).filter(function (r) { return r.boxes.length > 0; });
        saveData("Box removed: " + name).then(function () { toast("Box removed."); renderAll(); });
      });
      row.appendChild(del);
      list.appendChild(row);
    });
    var rulesList = $("box-rules-list"); rulesList.innerHTML = "";
    if (!s.boxRules.length) rulesList.innerHTML = '<p class="hint">No rules yet.</p>';
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
      rulesList.appendChild(row);
    });
    var craftSel = $("rule-craft");
    if (!craftSel.options.length) {
      L.CRAFTS.forEach(function (c) {
        var o = document.createElement("option"); o.value = c.id; o.textContent = c.name;
        craftSel.appendChild(o);
      });
    }
    /* The box dropdown mirrors the user's box list; picking a box adds it
       to the rule being built (see the change wiring) */
    var boxSel = $("rule-boxes");
    boxSel.innerHTML = "";
    var ph = document.createElement("option"); ph.value = ""; ph.textContent = "Choose a box…";
    boxSel.appendChild(ph);
    s.boxes.forEach(function (name) {
      var o = document.createElement("option"); o.value = name; o.textContent = name;
      boxSel.appendChild(o);
    });
    boxSel.value = "";
    renderRulePicked();
  }
  function renderRulePicked() {
    var wrap = $("rule-boxes-picked");
    wrap.innerHTML = "";
    if (!rulePickedBoxes.length) {
      wrap.innerHTML = '<span class="hint">No boxes picked for this rule yet — choose from the box menu.</span>';
      return;
    }
    rulePickedBoxes.forEach(function (name, i) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "kits-chip selected";
      chip.textContent = name + " ✕";
      chip.setAttribute("aria-label", "Remove " + name + " from this rule");
      chip.addEventListener("click", function () {
        rulePickedBoxes.splice(i, 1);
        renderRulePicked();
      });
      wrap.appendChild(chip);
    });
  }
  function addBoxFromField() {
    if (!requireEditor()) return;
    var inp = $("new-box-name");
    var name = inp.value.trim();
    if (!name) { toast("Type a box name first."); return; }
    var dupe = settings().boxes.some(function (b) { return b.toLowerCase() === name.toLowerCase(); });
    if (dupe) { toast("That box is already in the list."); return; }
    settings().boxes.push(name);
    inp.value = "";
    saveData("Box added: " + name).then(function () { toast("Box added."); renderAll(); });
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
    renderBulk();
    renderInventory();
    renderHistory();
  }
  function init() {
    try {
      var saved = localStorage.getItem(LS_KEY);
      if (saved) state.editor = JSON.parse(saved);
    } catch (e) { state.editor = null; }

    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.addEventListener("click", function () { activateTab(b.getAttribute("data-tab")); });
    });
    $("conn-badge").addEventListener("click", function () { if (!state.editor) activateTab("settings"); });
    $("pack-kits").addEventListener("input", function () { packKitsTouched = true; packFoldOverride = false; renderPack(); });
    $("btn-pack-change").addEventListener("click", function () { packFoldOverride = true; renderPack(); });
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
    wireStepper("pack-kits", "pack-minus", "pack-plus", function () { packKitsTouched = true; packFoldOverride = false; renderPack(); });
    document.querySelectorAll(".kits-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var target = chip.getAttribute("data-for");
        $(target + "-kits").value = chip.getAttribute("data-kits");
        if (target === "pack") { packKitsTouched = true; packFoldOverride = false; renderPack(); } else renderBulk();
      });
    });
    $("btn-check-all").addEventListener("click", function () {
      var boxes = $("pack-table").querySelectorAll("tbody input[type=checkbox]");
      var allChecked = boxes.length > 0 && Array.prototype.every.call(boxes, function (cb) { return cb.checked; });
      var setAll = function (val) {
        boxes.forEach(function (cb) {
          cb.checked = val;
          cb.closest("tr").classList.toggle("checked-row", val);
        });
        updatePackProgress();
      };
      if (allChecked) { setAll(false); return; } /* unchecking is safe — no confirm */
      /* v2 A5: checking everything in one tap is the risky direction — ask first */
      openSheet({
        title: "Check all",
        summary: "Mark all " + boxes.length + " packed?",
        primary: "Mark all",
        onConfirm: function () { setAll(true); }
      });
    });
    $("inv-search").addEventListener("input", function (ev) { invQuery = ev.target.value.trim().toLowerCase(); applyInvFilters(); filterEntryList($("delivery-entry-list")); filterEntryList($("count-entry-list")); });
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
    /* Desktop brief item 1: Esc closes the topmost layer (sheet, then menu) */
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!$("sheet-backdrop").hidden) { dismissSheet(); return; }
      if (!$("print-menu").hidden) {
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
    $("sheet-cancel").addEventListener("click", dismissSheet);
    $("sheet-backdrop").addEventListener("click", function (ev) { if (ev.target === $("sheet-backdrop")) dismissSheet(); });
    $("btn-print-sheet").addEventListener("click", function () { packMode = "print"; renderPack(); printPackSheet(); });
    $("btn-mode-hand").addEventListener("click", function () { packMode = "hand"; renderPack(); });
    $("bulk-kits").addEventListener("input", renderBulk);
    wireStepper("bulk-kits", "bulk-minus", "bulk-plus", renderBulk);
    $("btn-bulk-add").addEventListener("click", addBulkLine);
    $("btn-bulk-record").addEventListener("click", recordAllBulk);
    $("bulk-lines").addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-remove]");
      if (!b) return;
      bulkLines.splice(parseInt(b.getAttribute("data-remove"), 10), 1);
      renderBulkLines();
    });
    $("btn-gh-login").addEventListener("click", startDeviceLogin);
    $("btn-gh-login-cancel").addEventListener("click", function () { stopDeviceLogin(); $("connect-error").textContent = ""; });
    $("btn-complete-pack").addEventListener("click", completePacking);
    $("btn-print-inventory").addEventListener("click", function () { printInventory("report"); });
    $("btn-print-count").addEventListener("click", function () { printInventory("count"); });
    $("btn-reorder").addEventListener("click", function () {
      var p = $("reorder-panel"); p.hidden = !p.hidden;
      if (!p.hidden) renderReorderPanel();
    });
    $("btn-close-reorder").addEventListener("click", function () { $("reorder-panel").hidden = true; });
    $("btn-print-reorder").addEventListener("click", printReorder);
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
    $("rule-boxes").addEventListener("change", function () {
      var name = $("rule-boxes").value;
      if (name && rulePickedBoxes.indexOf(name) < 0) rulePickedBoxes.push(name);
      $("rule-boxes").value = "";
      renderRulePicked();
    });
    $("btn-rule-add").addEventListener("click", function () {
      if (!requireEditor()) return;
      var err = $("rule-error"); err.textContent = "";
      var craftId = $("rule-craft").value;
      var kits = parseInt($("rule-kits").value, 10);
      if (!L.validKits(kits)) { err.textContent = "Kit count must be a multiple of 6 — 6, 12, 18, 24…"; return; }
      if (!rulePickedBoxes.length) { err.textContent = "Pick at least one box from the box menu first."; return; }
      var ruleBoxes = rulePickedBoxes.slice();
      settings().boxRules = settings().boxRules.filter(function (r) { return !(r.craftId === craftId && r.kits === kits); });
      settings().boxRules.push({ craftId: craftId, kits: kits, boxes: ruleBoxes });
      rulePickedBoxes = [];
      $("rule-kits").value = "";
      saveData("Box rule added").then(function () { toast("Rule added."); renderAll(); });
    });
    $("btn-box-add").addEventListener("click", addBoxFromField);
    $("new-box-name").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); addBoxFromField(); }
    });
    $("btn-boxes-change").addEventListener("click", function () {
      var cur = currentBoxes() || [];
      var chips = $("pack-boxes-chips"); chips.innerHTML = "";
      settings().boxes.forEach(function (b) {
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
    loadData().then(function () { renderAll(); flushQueue(); });
    /* v3 E4: connectivity changes drive the queue */
    window.addEventListener("online", function () { state.offline = false; refreshSyncStatus(); flushQueue(); });
    window.addEventListener("offline", function () { state.offline = true; refreshSyncStatus(); });
    if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
