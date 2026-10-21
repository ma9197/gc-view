/* GlassCode: see and drive the Claude Code chats on your laptop from Meta Ray-Ban Display glasses.
   An app look in the spirit of the Claude app. Talks to the GlassCode bridge on the laptop through a tunnel; the
   pairing link carries the device key (#t=) and where to find the tunnel address (#g= gist id); both stay here.
   Everything works with the Neural Band: swipe = arrows (move/scroll), index pinch = Enter (select),
   middle pinch = Back (history.back, also Escape/Backspace on a keyboard). */
(function () {
  "use strict";

  const $app = document.getElementById("app"), $banner = document.getElementById("banner");
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("gc." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("gc." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("gc." + k); } catch {} },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- preferences (Settings) ----------
  const DEFAULT_QUICK = ["Continue", "Yes, go ahead", "No, stop there", "Run the tests", "Summarize where you are in 3 short bullets", "What do you need from me?"];
  const CHOICES = {
    size: [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]],
    dim: [["cover1", "Cover: light"], ["cover2", "Cover: medium"], ["cover3", "Cover: strong"], ["black", "See-through"], ["dimmer", "Faint panels"], ["dim", "Panels"]],
    font: [["sans", "Clean"], ["serif", "Serif (Claude style)"]],
  };
  const prefs = Object.assign({ speak: true, offline: false, quick: DEFAULT_QUICK, size: "m", dim: "cover2", bold: false, font: "sans", steps: false }, LS.get("prefs", {}));
  const savePrefs = () => { LS.set("prefs", prefs); applyPrefs(); };
  function applyPrefs() {
    const d = document.documentElement.dataset;
    d.size = prefs.size; d.dim = prefs.dim; d.font = prefs.font; d.bold = prefs.bold ? "1" : "0";
  }
  applyPrefs();
  const label = (k) => (CHOICES[k].find((c) => c[0] === prefs[k]) || CHOICES[k][0])[1];
  const cycle = (k) => { const i = CHOICES[k].findIndex((c) => c[0] === prefs[k]); prefs[k] = CHOICES[k][(i + 1) % CHOICES[k].length][0]; };

  // ---------- pairing ----------
  function readLink(str) {
    const out = {}, s = String(str || "");
    for (const part of [s.split("#")[1] || "", (s.split("?")[1] || "").split("#")[0]]) {
      const p = new URLSearchParams(part);
      for (const k of ["t", "g", "api"]) if (p.get(k)) out[k] = p.get(k);
    }
    return out;
  }
  function pairWith(link) {
    if (!link.t) return false;
    LS.set("token", link.t);
    if (link.g) LS.set("gist", link.g);
    if (link.api) LS.set("api", link.api);
    return true;
  }
  if (pairWith(readLink(location.href))) history.replaceState(null, "", location.pathname); // key out of the address bar

  // ---------- talking to the bridge ----------
  let API = LS.get("api", null), lastLookup = 0, online = false;
  async function lookup() {
    const g = LS.get("gist");
    if (!g || Date.now() - lastLookup < 15000) return API;
    lastLookup = Date.now();
    try {
      const r = await fetch("https://api.github.com/gists/" + encodeURIComponent(g), { cache: "no-store" });
      const e = JSON.parse((await r.json()).files["endpoint.json"].content);
      const u = String(e.url || "").replace(/\/$/, "");
      if (/^https:\/\/[^/]+$/.test(u)) { API = u; LS.set("api", API); }
    } catch {}
    return API;
  }
  async function api(path, opts = {}) {
    if (!LS.get("token")) throw Object.assign(new Error("This device is not paired. Open the GlassCode link again."), { auth: true }); // never poll with no key
    if (!API) await lookup();
    if (!API) { setOnline(false); throw new Error("Looking for the laptop..."); }
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    try {
      const r = await fetch(API + path, {
        method: opts.body ? "POST" : "GET", signal: ctrl.signal,
        headers: Object.assign({ Authorization: "Bearer " + LS.get("token", "") }, opts.body ? { "Content-Type": "application/json" } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { setOnline(false); throw Object.assign(new Error("This device's key does not match the laptop. Open the GlassCode link again."), { auth: true }); }
      if (r.status === 429) { setOnline(false); throw new Error("Too many wrong keys from this network. Retrying..."); }
      if (!r.ok) throw new Error(j.error || "Error " + r.status);
      setOnline(true);
      return j;
    } catch (e) {
      if (!e.auth && (e.name === "AbortError" || e instanceof TypeError)) { setOnline(false); lookup(); }
      throw e;
    } finally { clearTimeout(timer); }
  }
  const img = (u) => (/^\//.test(u) ? API + u : u);
  function setOnline(on) {
    if (on === online) return;
    online = on;
    const d = document.querySelector(".conn");
    if (d) d.className = "dot conn " + (on ? "c-done" : "c-err");
    if (top().type === "chat") render(); // show or clear the "reconnecting" warning on stale status
  }

  // ---------- state ----------
  const S = { sessions: [], away: false, seq: 0, loaded: false, error: null, laptop: "" };
  const stack = [{ type: "list" }];
  const top = () => stack[stack.length - 1];
  let chat = null; // { id, items, start, session, sent, tasks, open:Set, answers, first, ready }
  const confirmKey = { k: null, at: 0 }; // two-pinch confirm for Stop and destructive settings
  const confirming = (k) => confirmKey.k === k && Date.now() - confirmKey.at < 4000;

  // unread marks: chats that finished after you last looked at them
  const seen = LS.get("seen", null) || {};
  const markSeen = (id) => { seen[id] = Date.now(); LS.set("seen", seen); };
  const isNew = (s) => s.state === "idle" && s.last && s.last.role === "assistant" && s.since > (seen[s.id] || 0);

  // ---------- focus navigation (rows of focusables, like a TV remote) ----------
  const focusKey = {};
  function groups() {
    const out = [], byRow = new Map();
    for (const e of $app.querySelectorAll("[data-f]")) {
      if (!e.offsetParent && e !== document.activeElement) continue;
      const row = e.closest("[data-row]") || e;
      let g = byRow.get(row);
      if (!g) { g = []; byRow.set(row, g); out.push(g); }
      g.push(e);
    }
    return out;
  }
  const cx = (e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
  function focusEl(e, dir, remember = true) {
    if (!e) return;
    e.focus({ preventScroll: true });
    const sc = e.closest(".scroll");
    if (sc) {
      const r = e.getBoundingClientRect(), v = sc.getBoundingClientRect();
      if (r.height > v.height - 16) sc.scrollTop += dir === "up" ? r.bottom - v.bottom + 8 : r.top - v.top - 8; // tall: show the edge we came from
      else if (r.top < v.top + 4) sc.scrollTop -= v.top - r.top + 8;
      else if (r.bottom > v.bottom - 4) sc.scrollTop += r.bottom - v.bottom + 8;
    }
    if (e.closest(".chips")) e.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (remember && e.dataset.k) focusKey[top().type] = e.dataset.k;
  }
  function move(dir) {
    if (top().type === "image") { if (dir === "left" || dir === "right") stepImage(dir === "right" ? 1 : -1); return; }
    const gs = groups();
    if (!gs.length) return;
    let cur = document.activeElement, gi = gs.findIndex((g) => g.includes(cur));
    if (gi < 0) { // focus was lost (the glasses can drop it after Back): carry on from where you were, not the bottom
      cur = anchor();
      gi = gs.findIndex((g) => g.includes(cur));
      if (gi < 0) return focusEl((dir === "up" ? gs[gs.length - 1] : gs[0])[0], dir);
    }
    const g = gs[gi], ci = g.indexOf(cur);
    if (dir === "right" && top().type === "list" && /^s:/.test(cur.dataset.k || "")) return openMenu(cur.dataset.k.slice(2));
    if (dir === "right" && !g[ci + 1] && top().type === "chat") { const box = $app.querySelector('[data-k="speak"]'); if (box && box !== cur) return focusEl(box, dir); }
    if (dir === "left" || dir === "right") return focusEl(g[ci + (dir === "right" ? 1 : -1)], dir);
    const sc = cur.closest(".scroll");
    if (sc && g.length === 1) { // read long messages in steps before moving on
      const r = cur.getBoundingClientRect(), v = sc.getBoundingClientRect();
      if (dir === "down" && r.bottom > v.bottom + 6) { sc.scrollTop += Math.min(v.height * 0.7, r.bottom - v.bottom + 8); return; }
      if (dir === "up" && r.top < v.top - 6) { sc.scrollTop -= Math.min(v.height * 0.7, v.top - r.top + 8); return; }
    }
    const ng = gs[gi + (dir === "down" ? 1 : -1)];
    if (!ng) { if (dir === "up" && top().type === "chat") loadOlder(); return; }
    const x = cx(cur);
    focusEl(ng.reduce((a, b) => (Math.abs(cx(b) - x) < Math.abs(cx(a) - x) ? b : a)), dir);
  }
  // Where to resume when nothing is focused: the last remembered element if it is on screen, else the focusable
  // nearest the middle of what is visible.
  function anchor() {
    const k = focusKey[top().type];
    const byKey = k && $app.querySelector(`[data-k="${CSS.escape(k)}"]`);
    const sc = $app.querySelector(".scroll");
    if (!sc) return byKey || null;
    const v = sc.getBoundingClientRect(), shown = (e) => { const r = e.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; };
    if (byKey && shown(byKey)) return byKey;
    let best = null, bd = Infinity;
    for (const e of sc.querySelectorAll("[data-f]")) {
      if (!shown(e)) continue;
      const r = e.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - (v.top + v.bottom) / 2);
      if (d < bd) { bd = d; best = e; }
    }
    return best || byKey || null;
  }
  function restoreFocus(fallback) {
    const k = focusKey[top().type];
    const byKey = k && $app.querySelector(`[data-k="${CSS.escape(k)}"]`);
    // a fallback is not remembered: while a screen is still loading it must not steal the real first choice
    const first = [].concat(fallback || []).map((q) => $app.querySelector(q)).find(Boolean); // fallbacks in priority order
    const e = byKey || first || $app.querySelector("[data-f]");
    if (e) focusEl(e, null, !!byKey);
  }

  // ---------- keys and Back ----------
  const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  document.addEventListener("keydown", (e) => {
    const t = e.target, inInput = t && t.tagName === "INPUT";
    if (e.key === "Unidentified") return; // the glasses' center tap: not a command
    if (KEYS[e.key]) { e.preventDefault(); move(KEYS[e.key]); return; }
    if (e.key === "Enter" && keyupSeen && t && /^s:/.test((t.dataset && t.dataset.k) || "")) { // a chat in the list: tap or hold
      e.preventDefault();
      if (e.repeat) { if (hold && !hold.menu) { clearTimeout(hold.timer); hold.menu = true; openMenu(hold.k.slice(2)); } return; }
      const h = (hold = { k: t.dataset.k, menu: false });
      h.timer = setTimeout(() => { if (hold === h) { h.menu = true; openMenu(h.k.slice(2)); } }, 550);
      return;
    }
    if (e.key === "Enter") {
      if (inInput || (t && t.tagName === "BUTTON")) return; // native: the composer opens / the button clicks
      if (t && t.dataset && t.dataset.k) { e.preventDefault(); activate(t); }
      return;
    }
    if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || (e.key === "Backspace" && !(inInput && t.value))) {
      e.preventDefault(); back();
    }
  });
  // Press and hold a chat for its options. The tap opens the chat on release; a hold of 0.55 s opens the menu.
  // Only used once a keyup has been seen (if the glasses never send one, every tap would look like a hold):
  // until then a pinch opens the chat at once, and swipe right opens the options.
  let hold = null, keyupSeen = LS.get("keyup", false);
  document.addEventListener("keyup", (e) => {
    if (e.key !== "Enter") return;
    if (!keyupSeen) { keyupSeen = true; LS.set("keyup", true); return; }
    const h = hold;
    hold = null;
    if (h && !h.menu) { clearTimeout(h.timer); openChat(h.k.slice(2)); }
  });
  $app.addEventListener("contextmenu", (e) => { const t = e.target.closest('[data-k^="s:"]'); if (t) { e.preventDefault(); openMenu(t.dataset.k.slice(2)); } });

  // The middle-pinch Back arrives as history.back(): keep one guard entry while off the home screen.
  let guarded = false;
  function guard() { if (stack.length > 1 && !guarded) { try { history.pushState({ gc: 1 }, ""); guarded = true; } catch {} } }
  window.addEventListener("popstate", () => { guarded = false; back(true); });
  function back(fromHistory) {
    if (stack.length <= 1) return;
    if (!fromHistory && guarded) { guarded = false; history.back(); return; } // popstate does the rest once
    if (top().type === "chat") { stopSpeaking(); chat = null; }
    stack.pop();
    render();
    if (top().type === "list") loadList();
    guard();
    // the glasses may reset focus after their Back gesture: put it back where you were
    requestAnimationFrame(() => setTimeout(() => { if (!$app.contains(document.activeElement)) { const a = anchor(); if (a) focusEl(a, null, false); } }, 0));
  }
  function go(screen) { stack.push(screen); render(); guard(); }

  $app.addEventListener("click", (e) => { const t = e.target.closest("[data-k]"); if (t && t.tagName !== "INPUT") activate(t); });
  $app.addEventListener("change", (e) => { const t = e.target; if (t.dataset && t.dataset.k) onInput(t); });

  // ---------- icons ----------
  const spark = (spin) => `<svg class="spark${spin ? " spin" : ""}" viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.3 5.3l4.2 4.2M14.5 14.5l4.2 4.2M18.7 5.3l-4.2 4.2M9.5 14.5l-4.2 4.2"/></g></svg>`;
  const dot = (cls) => `<span class="dot ${cls || ""}"></span>`;
  const arrowUp = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const box = (st) => `<span class="box${st === "completed" ? " on" : st === "in_progress" ? " mid" : ""}"></span>`;

  const CLS = { running: "c-run", waiting: "c-wait", idle: "c-done", offline: "c-off" };
  const mark = (s) => (s.state === "running" ? `<span class="c-run">${dot("pulse")}</span>` : s.state === "offline" ? `<span class="c-off">${dot("ring")}</span>` : `<span class="${CLS[s.state]}">${dot()}</span>`);
  const bgCount = (s) => (s.background ? s.background.length : 0);
  function stateText(s) {
    // the main chat finished but agents/commands it started still run: not done yet
    if (s.state === "running" && s.turn === "idle" && bgCount(s)) return `Waiting on ${bgCount(s)} background task${bgCount(s) > 1 ? "s" : ""}`;
    if (s.state === "running") return "Working " + dur(Date.now() - s.since);
    if (s.state === "waiting") return s.waitingFor === "question" ? "Question for you" : /permission/.test(s.waitingFor || "") ? "Needs approval" : "Waiting for you";
    return s.state === "idle" ? "Done" : "Offline";
  }
  function dur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  }

  // small markdown subset: code blocks, tables, inline code, bold, headings, bullets, links (as text)
  function md(src) {
    const parts = String(src).split(/```[^\n]*\n?/);
    return parts.map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>`;
      return p.split(/\n{2,}/).map((para) => {
        if (!para.trim()) return "";
        if (/^\s*\|/.test(para)) return `<div class="tbl">${esc(para.split("\n").filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).join("\n"))}</div>`;
        const ls = para.split("\n").map((l) => {
          const h = esc(l).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
          if (/^#{1,6}\s/.test(l)) return `<span class="h">${h.replace(/^#{1,6}\s/, "")}</span>`;
          if (/^\s*[-*]\s/.test(l)) return "&bull; " + h.replace(/^\s*[-*]\s/, "");
          return h;
        });
        return `<p>${ls.join("<br>")}</p>`;
      }).join("");
    }).join("");
  }
  const plain = (s) => String(s).replace(/```[\s\S]*?```/g, " code block. ").replace(/[`*#>|_]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const short = (s, n) => { const t = plain(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

  // ---------- screens ----------
  function render() {
    if (!LS.get("token")) return renderPair();
    const t = top();
    if (t.type === "list") return renderList();
    if (t.type === "settings") return renderSettings();
    if (t.type === "chat") return renderChat();
    if (t.type === "image") return renderImage();
    if (t.type === "menu") return renderMenu();
    if (t.type === "hidden") return renderHidden();
  }

  function openMenu(id) { if (top().type === "list") go({ type: "menu", id }); }
  function renderMenu() {
    const s = S.sessions.find((x) => x.id === top().id) || { name: "Chat" };
    const opt = (k, name, sub) => `<button class="set" data-f data-k="${k}"><span>${name}${sub ? `<br><span class="t3" style="font-size:.8em">${sub}</span>` : ""}</span></button>`;
    $app.innerHTML = `<div class="top"><span class="title"><span>${esc(s.name)}</span></span></div><div class="scroll">
      ${opt("m:hide", "Remove from list", "It stays on the laptop. Bring it back in Settings.")}
      ${opt("m:read", "Mark as read")}
      ${opt("m:open", "Open chat")}
      <div class="note">Back to cancel</div></div>`;
    focusKey.menu = null;
    restoreFocus(".scroll [data-f]");
  }
  function renderHidden() {
    const list = top().list;
    const body = !list ? '<div class="empty">Loading...</div>' : !list.length ? '<div class="empty">No hidden chats.</div>'
      : list.map((s) => `<button class="set" data-f data-k="h:${esc(s.id)}"><span>${esc(s.name)}</span><span class="sv">Show again</span></button>`).join("");
    $app.innerHTML = `<div class="top"><span class="title"><span>Hidden chats</span></span></div><div class="scroll">${body}<div class="note">Pinch a chat to put it back in the list</div></div>`;
    restoreFocus(".scroll [data-f]");
  }
  async function loadHidden() {
    try { const j = await api("/api/hidden"); if (top().type === "hidden") { top().list = j.sessions; render(); } } catch (e) { toast(e.message); }
  }

  function renderPair() {
    $app.innerHTML = `<div class="pair"><h1>${spark()} GlassCode</h1>
      <div class="t2">Open the GlassCode pairing link from your phone (tap it or scan its QR code).</div>
      <input class="field" type="text" data-f data-k="pair" autocomplete="off" spellcheck="false" placeholder="Or paste the link here"></div>`;
    restoreFocus();
  }

  function cardHtml(s) {
    const t = s.tasks;
    return `<button class="card${s.state === "waiting" ? " need" : ""}" data-f data-k="s:${esc(s.id)}">
      <span class="l1">${mark(s)}<span class="nm">${esc(s.name)}</span>${isNew(s) ? '<span class="new">New</span>' : ""}</span>
      <span class="l2"><span class="st ${CLS[s.state]}">${esc(stateText(s))}</span>${s.folder ? `<span>${esc(s.folder)}</span>` : ""}${s.state !== "running" ? `<span>${ago(s.since)}</span>` : ""}${t ? `<span>${t.done}/${t.total} tasks</span>` : ""}${s.turn === "busy" && bgCount(s) ? `<span>+${bgCount(s)} in background</span>` : ""}</span>
      ${s.last ? `<span class="l3">${s.last.role === "user" ? "You: " : ""}${esc(short(s.last.text, 120))}</span>` : ""}</button>`;
  }

  function renderList() {
    const live = S.sessions.filter((s) => s.state !== "offline"), off = S.sessions.filter((s) => s.state === "offline");
    const need = live.filter((s) => s.state === "waiting"), work = live.filter((s) => s.state === "running"), done = live.filter((s) => s.state === "idle");
    let body;
    if (!S.loaded) body = `<div class="empty">${esc(S.error || "Connecting to your laptop...")}</div>`;
    else {
      const sect = (title, list) => (list.length ? `<div class="sect">${title}</div>` + list.map(cardHtml).join("") : "");
      body = sect("Needs you", need) + sect("Working", work) + sect("Done", done);
      if (!live.length) body = `<div class="empty">No chats are open on the laptop.</div>`;
      if (off.length) {
        body += `<button class="card" data-f data-k="offline"><span class="l1"><span class="c-off">${dot("ring")}</span><span class="nm t2">${prefs.offline ? "Hide" : "Show"} offline chats (${off.length})</span></span><span class="l3">Closed on the laptop. Read only.</span></button>`;
        if (prefs.offline) body += off.map(cardHtml).join("");
      }
    }
    $app.innerHTML = `<div class="top" data-row><span class="title">${spark()}<span>GlassCode</span><span class="dot conn ${online ? "c-done" : "c-err"}"></span></span>
        <button class="pill btn${S.away ? " on" : ""}" data-f data-k="away">Away ${S.away ? "on" : "off"}</button><button class="pill btn" data-f data-k="updates">Hear updates</button><button class="pill btn" data-f data-k="settings">Settings</button></div>
      <div class="scroll">${body}</div>`;
    restoreFocus(".scroll [data-f]");
  }

  function renderSettings() {
    const item = (k, name, val, on, cls) => `<button class="set${cls ? " " + cls : ""}" data-f data-k="${k}"><span>${name}</span><span class="sv${on ? " on" : ""}">${val}</span></button>`;
    $app.innerHTML = `<div class="top"><span class="title">${spark()}<span>Settings</span></span></div><div class="scroll">
      <div class="sect">Reading</div>
      ${item("set:size", "Text size", label("size"))}
      ${item("set:bold", "Bold text", prefs.bold ? "On" : "Off", prefs.bold)}
      ${item("set:font", "Reply font", label("font"))}
      ${item("set:dim", "Background", label("dim"))}
      <div class="preview">Preview: Claude's replies look like this. The glasses can't show black (it is see-through), so "Cover" puts a grey layer over what's behind you. Stronger = less of the world.</div>
      <div class="sect">Chats</div>
      ${item("set:away", "Away mode", S.away ? "On" : "Off", S.away)}
      ${item("set:speak", "Speak alerts out loud", prefs.speak ? "On" : "Off", prefs.speak)}
      ${item("set:steps", "Show Claude's steps", prefs.steps ? "On" : "Off", prefs.steps)}
      ${item("set:offline", "Show offline chats", prefs.offline ? "On" : "Off", prefs.offline)}
      ${item("set:hidden", "Hidden chats", String(S.hiddenCount || 0))}
      <div class="sect">Quick replies (pinch one twice to remove)</div>
      ${prefs.quick.map((q, i) => item("qr:" + i, esc(q), confirming("qr:" + i) ? "Pinch again to remove" : "", false, "danger")).join("")}
      <input class="field" type="text" data-f data-k="qradd" autocomplete="off" placeholder="+ Add a quick reply (speak or type)">
      ${item("qr:reset", "Reset quick replies", confirming("qr:reset") ? "Pinch again" : "")}
      <div class="sect">This device</div>
      ${item("unpair", "Unpair this device", confirming("unpair") ? "Pinch again to unpair" : "", false, "danger")}
      <div class="note">${esc(S.laptop || "laptop")} &middot; swipe to move, pinch to select, back to leave</div></div>`;
    restoreFocus(".scroll [data-f]");
  }

  function renderImage() {
    const t = top(), n = t.list.length;
    $app.innerHTML = `<div class="viewer"><img src="${esc(t.list[t.idx])}" alt=""></div><div class="vcount">${n > 1 ? `${t.idx + 1} / ${n} &middot; swipe for more &middot; ` : ""}back to close</div>`;
  }
  function stepImage(d) {
    const t = top();
    if (t.list.length < 2) return;
    t.idx = (t.idx + d + t.list.length) % t.list.length;
    renderImage();
  }

  // The conversation as you'd read it in the Claude app: your messages, Claude's final reply of each turn,
  // pictures (with the text that went with them) and questions. Steps and running comments stay hidden.
  function conversation(items, running) {
    const out = [];
    let last = null, cap = null, pics = [];
    const reply = (atEnd) => {
      if (last && !(atEnd && running)) { // a turn still running has no final reply yet
        out.push({ kind: "reply", it: last });
        pics.forEach((b) => { if (b.from === last) b.cap = null; }); // don't repeat the reply as a caption
      }
      last = null; pics = [];
    };
    for (const it of items) {
      if (it.role === "user") { reply(false); out.push({ kind: "user", it }); }
      else if (it.role === "assistant") { last = it; cap = it; }
      else if (it.role === "question") { reply(false); out.push({ kind: "question", it }); }
      else if (it.role === "note") out.push({ kind: "note", it });
      else if (it.role === "tool" && it.images && it.images.length) {
        const b = { kind: "image", it, from: it.caption ? null : cap, cap: it.caption || (cap ? short(cap.text, 220) : "") };
        out.push(b); pics.push(b);
      }
    }
    reply(true);
    return out;
  }

  // "Show Claude's steps" (Settings): everything, with long runs of steps folded into one row
  function steps(items) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length > 2 && !chat.open.has("g:" + run[0].key)) out.push({ kind: "group", key: run[0].key, items: run });
      else run.forEach((it) => out.push({ kind: "tool", it }));
      run = [];
    };
    for (const it of items) {
      if (it.quiet) continue;
      if (it.role === "tool" && !(it.images && it.images.length) && it.status === "done" && !chat.open.has("i:" + it.key)) { run.push(it); continue; }
      flush();
      out.push(it.role === "assistant" ? { kind: "reply", it } : it.role === "tool" && it.images && it.images.length ? { kind: "image", it, cap: it.caption || it.result || "" } : { kind: it.role, it });
    }
    flush();
    return out;
  }

  const thumbs = (urls) => (urls && urls.length ? `<div class="thumbs">${urls.map((u) => `<img src="${esc(img(u))}" alt="" loading="lazy">`).join("")}</div>` : "");

  function blockHtml(b) {
    const it = b.it, k = (p) => `data-f tabindex="-1" data-k="${p}"`;
    switch (b.kind) {
      case "user":
        return `<div class="msg bubble" ${k("i:" + esc(it.key))}>${it.via === "glasses" ? '<div class="via">From your glasses</div>' : ""}${esc(it.text).replace(/\n/g, "<br>")}${thumbs(it.images)}</div>`;
      case "reply":
        return `<div class="msg reply" ${k("i:" + esc(it.key))}>${spark()}<div class="body md">${md(it.text)}</div></div>`;
      case "image":
        return `<div class="msg imgcard" ${k("i:" + esc(it.key))}>${thumbs(it.images)}${b.cap ? `<div class="cap">${esc(b.cap)}</div>` : ""}</div>`;
      case "note":
        return `<div class="note">${esc(it.text)}</div>`;
      case "question": {
        const q = (it.question || [])[0] || {};
        const ans = it.status === "answered" ? esc((it.answer || "").replace(/^User has answered your questions?:\s*/i, "").slice(0, 240)) : it.status === "pending" ? "Waiting for your answer" : "Dismissed";
        return `<div class="msg qcard" ${k("i:" + esc(it.key))}><b>${esc(q.question || "Question")}</b><br>${ans}</div>`;
      }
      case "group":
        return `<div class="step" ${k("g:" + esc(b.key))}><span class="sn">${b.items.length} steps</span><span class="ss">${esc([...new Set(b.items.map((x) => x.tool))].join(", "))} &middot; pinch to show</span></div>`;
      default: { // a step (only with "Show Claude's steps")
        const st = it.status === "running" ? "c-run" : it.status === "error" ? "c-err" : "c-done";
        const open = chat.open.has("i:" + it.key);
        const diff = it.diff ? it.diff.map((l) => `<span class="${l[0] === "+" ? "a" : l[0] === "-" ? "d" : ""}">${esc(l)}</span>`).join("\n") : "";
        return `<div class="step" ${k("i:" + esc(it.key))}><span class="${st}">${dot()}</span><span class="sn">${esc(it.tool)}</span><span class="ss">${esc(it.status === "running" ? "running..." : it.result || it.summary || "")}</span></div>
          ${open ? `<div class="det">${esc(it.detail || it.summary || "")}${diff ? "\n" + diff : ""}${it.out ? "\n" + esc(it.out) : ""}</div>` : ""}`;
      }
    }
  }

  function tasksHtml() {
    const ts = chat.tasks || [];
    if (!ts.length || (ts.every((t) => t.status === "completed") && chat.session && chat.session.state !== "running")) return "";
    const open = chat.open.has("tasks"), done = ts.filter((t) => t.status === "completed").length;
    let show = ts;
    if (!open && ts.length > 5) { const i = Math.max(0, ts.findIndex((t) => t.status !== "completed") - 1); show = ts.slice(i, i + 5); }
    return `<div class="tasks" data-f tabindex="-1" data-k="tasks"><div class="sect" style="margin:0 0 4px">Tasks &middot; ${done} of ${ts.length} done</div>
      ${show.map((t) => `<div class="task${t.status === "completed" ? " done" : t.status === "in_progress" ? " now" : ""}">${box(t.status)}<span>${esc(t.status === "in_progress" ? t.activeForm || t.subject : t.subject)}</span></div>`).join("")}
      ${show.length < ts.length ? `<div class="t3" style="font-size:.78em">+${ts.length - show.length} more &middot; pinch to see all</div>` : ""}</div>`;
  }

  function dialogHtml(s) {
    const h = s.held;
    if (h && h.kind === "question") {
      return `<div class="dlg"><div class="kind">Claude asks</div>${(h.questions || []).map((q, qi) => {
        const a = chat.answers[qi] || (chat.answers[qi] = { picked: [], other: "" });
        return `<div class="q">${q.header ? esc(q.header) + ": " : ""}${esc(q.question)}</div>
          ${(q.options || []).map((o, oi) => { const on = a.picked.includes(o.label);
            return `<button class="opt${on ? " on" : ""}" data-f data-k="o:${qi}:${oi}">${q.multiSelect ? box(on ? "completed" : "") : ""}<span class="ob"><div>${esc(o.label)}</div>${o.description ? `<div class="od">${esc(o.description)}</div>` : ""}</span></button>`; }).join("")}
          <input class="field" type="text" data-f data-k="other:${qi}" autocomplete="off" placeholder="${a.other ? esc(a.other) : "Something else (speak or type)"}">`;
      }).join("")}
        <button class="opt go" data-f data-k="submit">Send answer</button></div>`;
    }
    if (h && h.kind === "permission") {
      return `<div class="dlg"><div class="kind">Approval needed</div><div class="q">${esc(h.tool)}${h.description ? ": " + esc(h.description) : ""}</div>
        <div class="cmd">${esc(h.input)}</div>
        <button class="opt" data-f data-k="p:yes"><span class="ob">Yes</span></button>
        ${h.canAlways ? `<button class="opt" data-f data-k="p:always"><span class="ob"><div>Yes, and don't ask again</div><div class="od">Claude Code's own suggested rule</div></span></button>` : ""}
        <button class="opt" data-f data-k="p:no"><span class="ob">No</span></button>
        <input class="field" type="text" data-f data-k="p:tell" autocomplete="off" placeholder="No, and tell Claude what to do instead"></div>`;
    }
    if (s.state === "waiting") {
      const q = [...chat.items].reverse().find((x) => x.role === "question" && x.status === "pending");
      return `<div class="dlg"><div class="kind">Waiting on the laptop</div>${q ? `<div class="q">${esc(((q.question || [])[0] || {}).question || "")}</div>` : ""}
        <div class="t2" style="font-size:.86em">Answer it on the laptop or your phone.${S.away ? "" : " Turn Away on first to answer here next time."}</div>
        ${S.away ? "" : '<button class="opt" data-f data-k="away"><span class="ob">Turn Away on</span></button>'}</div>`;
    }
    return "";
  }

  function renderChat() {
    if (!chat) return;
    const s = chat.session || { name: "Loading...", state: "idle", since: Date.now() };
    const sc = $app.querySelector(".scroll");
    // coming back from the image viewer: the old scroll element is gone, so use the position saved when it opened
    const saved = chat.savedTop;
    chat.savedTop = null;
    const atBottom = saved == null && (!sc || chat.atBottom !== false), prevTop = saved != null ? saved : sc ? sc.scrollTop : 0;
    const pendingSent = (chat.sent || []).filter((m) => !m.delivered);
    const list = prefs.steps ? steps(chat.items) : conversation(chat.items, s.turn ? s.turn === "busy" : s.state === "running");
    let html = chat.start > 0 ? `<div class="note">Swipe up for older messages</div>` : "";
    html += list.map(blockHtml).join("") + tasksHtml();
    html += pendingSent.map((m) => `<div class="msg bubble"><div class="via">Sending from your glasses...</div>${esc(m.text)}</div>`).join("");
    html += dialogHtml(s);
    if (!list.length && !pendingSent.length) html += `<div class="empty">${s.state === "running" ? "Claude is working. The reply shows here when it's done." : "No messages yet."}</div>`;

    const draft = LS.get("draft:" + chat.id, "");
    const t = chat.session && chat.session.tasks;
    const status = s.state === "running" && online
      ? `<div class="status" data-row>${spark(true)}<span class="v">${esc(s.turn === "idle" && bgCount(s) ? stateText(s) : (t && t.active) || "Working")} <span class="t3">&middot; <span class="el">${dur(Date.now() - s.since)}</span>${t ? ` &middot; ${t.done}/${t.total} tasks` : ""}${bgCount(s) ? " &middot; " + esc(s.background.map((b) => b.desc).join(", ")) : ""}</span></span>
        ${s.canSend ? `<button class="chip warn" data-f data-k="stop">${confirming("stop") ? "Pinch again to stop" : "Stop"}</button>` : ""}</div>` : "";
    const quick = s.canSend && !s.held ? `<div class="chips" data-row>${prefs.quick.map((q, i) => `<button class="chip" data-f data-k="q:${i}">${esc(q)}</button>`).join("")}</div>` : "";
    const compose = s.canSend
      ? `${draft ? `<div class="draft" data-f tabindex="-1" data-k="draft">${esc(draft)}</div>` : ""}
        <div class="composer" data-row><input class="in" type="text" data-f data-k="speak" autocomplete="off" spellcheck="false" placeholder="${draft ? "Add more (speak or type)" : "Reply to Claude (speak or type)"}">
          ${draft ? `<button class="round send" data-f data-k="send" aria-label="Send">${arrowUp}</button>` : ""}</div>
        ${draft ? '<div class="chips" data-row><button class="chip" data-f data-k="undo">Undo last part</button><button class="chip" data-f data-k="clear">Clear</button></div>' : ""}`
      : `<div class="ro">${s.state === "offline" ? "Offline: open it on the laptop to continue." : "Read only: restart this chat on the laptop once to message it."}</div>`;
    const mode = speaking ? '<div class="mode c-run">Reading aloud &middot; pinch the reply again to stop</div>' : S.away ? '<div class="mode"><span class="c-wait">Away mode on</span> &middot; questions come here, replies kept short</div>' : "";
    const state = online ? `<span class="pill ${CLS[s.state]}">${mark(s)}${esc(stateText(s))}</span>` : `<span class="pill c-err">${dot("pulse")}Reconnecting</span>`;

    $app.innerHTML = `<div class="top"><span class="title"><span>${esc(s.name)}</span></span>${state}</div>
      <div class="scroll">${html}</div><div class="bottom">${status}${quick}${compose}${mode}</div>`;

    const nsc = $app.querySelector(".scroll");
    nsc.addEventListener("scroll", () => { if (chat) chat.atBottom = nsc.scrollHeight - nsc.scrollTop - nsc.clientHeight < 40; });
    nsc.addEventListener("load", () => { if (chat && chat.atBottom !== false) nsc.scrollTop = nsc.scrollHeight; }, true); // images load late
    if (chat.keepTop != null) { nsc.scrollTop = nsc.scrollHeight - chat.keepTop; chat.keepTop = null; }
    else nsc.scrollTop = atBottom ? nsc.scrollHeight : prevTop;
    if (chat.first && chat.ready) { // first view: the question if one waits, else the newest message
      chat.first = false;
      const all = nsc.querySelectorAll('[data-k^="i:"], [data-k="tasks"]');
      const e = (s.held && nsc.querySelector(".dlg [data-f]")) || all[all.length - 1] || $app.querySelector(".bottom [data-f]");
      focusKey.chat = e && e.dataset.k;
    }
    // safe fallback (never Stop): the question, else the message box, else the newest message
    restoreFocus(s.held ? ".dlg [data-f]" : ['[data-k="speak"]', '.scroll [data-k^="i:"]', ".bottom [data-f]"]);
  }

  // ---------- actions ----------
  async function activate(el) {
    const k = el.dataset.k;
    try {
      if (k.startsWith("s:")) return openChat(k.slice(2));
      if (k === "offline" || k === "set:offline") { prefs.offline = !prefs.offline; savePrefs(); return render(); }
      if (k === "settings") return go({ type: "settings" });
      if (k === "m:hide" || k === "m:read" || k === "m:open") {
        const id = top().id, s = S.sessions.find((x) => x.id === id);
        if (k === "m:open") { stack.pop(); return openChat(id); } // menu -> chat (keeps the one Back guard)
        if (k === "m:read") { markSeen(id); return back(); }
        await api("/api/hidden", { body: { id, hidden: true } });
        S.sessions = S.sessions.filter((x) => x.id !== id);
        toast(`Removed ${s ? s.name : "chat"}. Settings > Hidden chats brings it back.`, true);
        return back();
      }
      if (k === "set:hidden") { go({ type: "hidden", list: null }); return loadHidden(); }
      if (k.startsWith("h:")) { await api("/api/hidden", { body: { id: k.slice(2), hidden: false } }); toast("Back in the list", true); return loadHidden(); }
      if (k === "updates") return speakUpdates();
      if (k === "away" || k === "set:away") return toggleAway();
      if (k === "set:speak") { prefs.speak = !prefs.speak; savePrefs(); if (prefs.speak) say("Alerts will be spoken"); return render(); }
      if (k === "set:steps") { prefs.steps = !prefs.steps; savePrefs(); return render(); }
      if (k === "set:bold") { prefs.bold = !prefs.bold; savePrefs(); return render(); }
      if (k === "set:size" || k === "set:dim" || k === "set:font") { cycle(k.slice(4)); savePrefs(); return render(); }
      if (k.startsWith("qr:") || k === "unpair") return settingsAction(k);
      if (k.startsWith("g:") || k === "tasks") { chat.open.has(k) ? chat.open.delete(k) : chat.open.add(k); return render(); }
      if (k.startsWith("i:")) return itemAction(k);
      if (k.startsWith("q:")) return sendText(prefs.quick[+k.slice(2)]);
      if (k === "send") return sendText(LS.get("draft:" + chat.id, ""), true);
      if (k === "undo") { const parts = LS.get("draft:" + chat.id, "").split("\n"); parts.pop(); LS.set("draft:" + chat.id, parts.join("\n")); focusKey.chat = "speak"; return render(); }
      if (k === "clear") { LS.del("draft:" + chat.id); focusKey.chat = "speak"; return render(); }
      if (k === "stop") { // two pinches, so a stray pinch never stops Claude
        if (!confirming("stop")) { Object.assign(confirmKey, { k: "stop", at: Date.now() }); setTimeout(render, 4100); return render(); }
        confirmKey.k = null;
        await api(`/api/sessions/${encodeURIComponent(chat.id)}/stop`, { body: {} });
        toast("Asked Claude to stop", true);
        return refreshChat();
      }
      if (k.startsWith("o:")) return pickOption(k);
      if (k === "submit") return submitAnswers();
      if (k.startsWith("p:")) return answerPermission(k.slice(2));
    } catch (e) { toast(e.message); }
  }

  function itemAction(k) {
    const it = chat.items.find((x) => "i:" + x.key === k);
    if (!it) return;
    if (it.images && it.images.length) return openImages(it);
    if (it.role === "assistant") return toggleRead(it.text);
    if (it.role === "tool") { // only with "Show Claude's steps": pinch a step for its command, output or diff
      if (chat.open.has(k)) chat.open.delete(k); else chat.open.add(k);
      return render();
    }
  }

  function openImages(it) {
    const list = [];
    for (const x of chat.items) for (const u of x.images || []) list.push(img(u));
    const idx = Math.max(0, list.indexOf(img(it.images[0])));
    const sc = $app.querySelector(".scroll");
    if (sc) chat.savedTop = sc.scrollTop;
    go({ type: "image", list, idx });
  }

  async function toggleAway() {
    const j = await api("/api/away", { body: { on: !S.away } });
    S.away = j.away;
    toast(S.away ? "Away on: questions come here, replies kept short" : "Away off: questions stay on the laptop", true);
    render();
  }

  function settingsAction(k) {
    if (!confirming(k)) { Object.assign(confirmKey, { k, at: Date.now() }); return render(); }
    confirmKey.k = null;
    if (k === "unpair") { ["token", "gist", "api"].forEach(LS.del); location.reload(); return; }
    if (k === "qr:reset") prefs.quick = DEFAULT_QUICK.slice();
    else prefs.quick.splice(+k.slice(3), 1);
    savePrefs();
    focusKey.settings = "qradd";
    render();
  }

  // Text from the glasses composer (dictation, handwriting or keyboard). Each entry is ADDED, so you can dictate,
  // think, and dictate more before sending. The box empties itself after each entry.
  function onInput(t) {
    const v = t.value.trim(), k = t.dataset.k;
    t.value = "";
    if (!v) return;
    if (k === "pair") { if (pairWith(readLink(v)) || pairWith({ t: v })) { API = LS.get("api", null); start(); } return; }
    if (k === "qradd") { prefs.quick.push(v.slice(0, 200)); savePrefs(); toast("Quick reply added", true); return render(); }
    if (k === "speak") {
      const d = LS.get("draft:" + chat.id, "");
      LS.set("draft:" + chat.id, d ? d + "\n" + v : v);
      focusKey.chat = "speak";
      return render();
    }
    if (k === "p:tell") return answerPermission("tell", v);
    if (k.startsWith("other:")) {
      const qi = +k.split(":")[1], q = chat.session.held.questions[qi], a = chat.answers[qi];
      a.other = a.other ? a.other + " " + v : v;
      if (!q.multiSelect) a.picked = [];
      if (autoSubmit()) return;
      focusKey.chat = "submit";
      return render();
    }
  }

  function pickOption(k) {
    const [, qi, oi] = k.split(":").map(Number), h = chat.session.held, q = h.questions[qi], a = chat.answers[qi], lbl = q.options[oi].label;
    if (q.multiSelect) { a.picked = a.picked.includes(lbl) ? a.picked.filter((x) => x !== lbl) : a.picked.concat(lbl); return render(); }
    a.picked = [lbl]; a.other = "";
    if (autoSubmit()) return; // like the Claude app: picking the answer to the last open question sends it
    focusKey.chat = qi + 1 < h.questions.length ? `o:${qi + 1}:0` : "submit";
    render();
  }
  function answersReady() {
    const h = chat.session.held, answers = {};
    h.questions.forEach((q, qi) => {
      const a = chat.answers[qi] || { picked: [], other: "" };
      const vals = a.picked.concat(a.other ? [a.other] : []);
      if (vals.length) answers[q.question] = vals.join(", ");
    });
    return Object.keys(answers).length === h.questions.length ? answers : null;
  }
  function autoSubmit() {
    const h = chat.session.held;
    if (h.questions.some((q) => q.multiSelect) || !answersReady()) return false;
    submitAnswers();
    return true;
  }
  async function submitAnswers() {
    const answers = answersReady();
    if (!answers) return toast("Answer each question first");
    try {
      await api(`/api/sessions/${encodeURIComponent(chat.id)}/answer`, { body: { key: chat.session.held.key, answers } });
      chat.answers = {};
      toast("Answer sent", true);
    } catch (e) { toast(e.message); }
    refreshChat();
  }
  async function answerPermission(kind, message) {
    const body = { key: chat.session.held && chat.session.held.key, allow: kind === "yes" || kind === "always", always: kind === "always", message: message || null };
    try {
      await api(`/api/sessions/${encodeURIComponent(chat.id)}/permission`, { body });
      toast(body.allow ? (body.always ? "Allowed, won't ask again" : "Allowed") : message ? "Denied, with your note" : "Denied", true);
    } catch (e) { toast(e.message); }
    refreshChat();
  }

  async function sendText(text, fromDraft) {
    text = String(text || "").trim();
    if (!text) return;
    const id = chat.id;
    chat.sent = (chat.sent || []).concat({ text, delivered: false });
    if (fromDraft) LS.del("draft:" + id);
    focusKey.chat = "speak";
    render();
    try {
      const j = await api(`/api/sessions/${encodeURIComponent(id)}/send`, { body: { text }, timeout: 20000 });
      toast(j.delivered ? "Sent" : "Queued: it arrives in a moment", true);
    } catch (e) {
      if (fromDraft) LS.set("draft:" + id, text); // keep the words if sending failed
      toast(e.message);
    }
    refreshChat();
  }

  // ---------- speech (speechSynthesis: one built-in voice) ----------
  let speaking = false;
  function stopSpeaking() { try { speechSynthesis.cancel(); } catch {} speaking = false; }
  function toggleRead(text) {
    if (speaking) { stopSpeaking(); return render(); }
    if (!text || !window.speechSynthesis) return toast("Nothing to read");
    const u = new SpeechSynthesisUtterance(plain(text).slice(0, 4000));
    u.onend = u.onerror = () => { speaking = false; if (top().type === "chat") render(); };
    speaking = true;
    speechSynthesis.speak(u);
    render();
  }
  // Spoken summary on request: who needs you, what finished since you last looked, what is working.
  function speakUpdates() {
    const live = S.sessions.filter((s) => s.state !== "offline");
    const need = live.filter((s) => s.state === "waiting").map((s) => s.name);
    const fresh = live.filter(isNew).map((s) => s.name);
    const work = live.filter((s) => s.state === "running").length;
    const parts = [];
    if (need.length) parts.push(`${need.length} need you: ${need.join(", ")}.`);
    if (fresh.length) parts.push(`${fresh.length} finished: ${fresh.join(", ")}.`);
    parts.push(work ? `${work} working.` : "Nothing is working right now.");
    const text = parts.join(" ");
    toast(text, !need.length);
    if (window.speechSynthesis) { stopSpeaking(); try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {} }
  }

  function say(text) {
    if (!prefs.speak || speaking || !window.speechSynthesis) return;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
  }

  // ---------- data ----------
  async function loadList() {
    try {
      const j = await api("/api/sessions");
      S.sessions = j.sessions; S.away = j.away; S.hiddenCount = j.hiddenCount || 0; S.loaded = true; S.error = null;
      if (!LS.get("seen", null)) { j.sessions.forEach((s) => { seen[s.id] = Date.now(); }); LS.set("seen", seen); } // first run: all read
    } catch (e) { S.error = e.message; }
    if (top().type === "list") render();
  }
  async function hello() {
    try {
      const j = await api("/api/hello");
      S.laptop = j.laptop; S.away = j.away;
      if (!S.seq) S.seq = j.seq; // start from now: don't replay alerts you already heard
    } catch {}
  }

  async function openChat(id) {
    const s = S.sessions.find((x) => x.id === id);
    chat = { id, items: [], start: 0, session: s || null, sent: [], tasks: [], open: new Set(), answers: {}, first: true, ready: false };
    markSeen(id);
    go({ type: "chat", id });
    await refreshChat();
  }

  async function refreshChat() {
    if (!chat) return;
    const id = chat.id;
    try {
      const j = await api(`/api/sessions/${encodeURIComponent(id)}?limit=80`);
      if (!chat || chat.id !== id) return;
      if (chat.items.length && j.start > chat.start) chat.items = chat.items.slice(0, j.start - chat.start).concat(j.items);
      else { chat.items = j.items; chat.start = j.start; }
      const heldBefore = chat.session && chat.session.held && chat.session.held.key;
      chat.session = j.session;
      if ((j.session.held && j.session.held.key) !== heldBefore) { chat.answers = {}; if (j.session.held) focusKey.chat = null; }
      chat.sent = j.sent || [];
      chat.tasks = j.tasks || [];
      chat.ready = true;
      markSeen(id);
      if (top().type === "chat") render();
    } catch (e) { toast(e.message); }
  }

  async function loadOlder() {
    if (!chat || chat.start <= 0 || chat.loadingOlder) return;
    chat.loadingOlder = true;
    try {
      const j = await api(`/api/sessions/${encodeURIComponent(chat.id)}?before=${chat.start}&limit=60`);
      const sc = $app.querySelector(".scroll");
      chat.keepTop = sc ? sc.scrollHeight - sc.scrollTop : null;
      chat.items = j.items.concat(chat.items);
      chat.start = j.start;
      render();
    } catch (e) { toast(e.message); }
    chat.loadingOlder = false;
  }

  // ---------- live updates and alerts ----------
  let bannerTimer = null;
  function toast(text, ok) {
    $banner.textContent = text;
    $banner.className = "show" + (ok ? " done" : "");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { $banner.className = ""; }, 4000);
  }
  // at most one list refresh every 2 s (busy chats change constantly)
  let listTimer = null, listAt = 0, chatTimer = null;
  function refreshListSoon() {
    if (listTimer) return;
    listTimer = setTimeout(() => { listTimer = null; listAt = Date.now(); loadList(); }, Math.max(300, 2000 - (Date.now() - listAt)));
  }
  const refreshChatSoon = () => { clearTimeout(chatTimer); chatTimer = setTimeout(refreshChat, 400); };

  // Alerts only for news: never for events older than a minute or already alerted (e.g. after the display slept).
  let alertAt = LS.get("alertAt", 0);
  function handle(events) {
    let chatDirty = false, listDirty = false;
    for (const ev of events) {
      const fresh = ev.at > alertAt && ev.at > Date.now() - 60000;
      if (ev.at > alertAt) { alertAt = ev.at; LS.set("alertAt", alertAt); }
      if (ev.type === "away") { S.away = ev.away; listDirty = true; }
      const mine = chat && ev.id === chat.id, name = ev.name || "A chat";
      if (mine && ["items", "state", "held", "delivered"].includes(ev.type)) chatDirty = true;
      if (ev.type === "state" || ev.type === "held") listDirty = true;
      if (!fresh) continue;
      if (ev.type === "state" && ev.from === "running" && ev.to === "idle") { toast(`${mine ? "" : name + ": "}Claude finished`, true); say(`${name} finished`); }
      if (ev.type === "held" && ev.held) { toast(`${name} needs you: ${ev.held.kind === "question" ? "a question" : "an approval"}`); say(`${name} needs you`); }
      if (ev.type === "state" && ev.to === "waiting" && !ev.held) { toast(`${name} is waiting on the laptop`); say(`${name} is waiting on the laptop`); }
    }
    if (listDirty || top().type === "list") refreshListSoon();
    if (chatDirty) refreshChatSoon();
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    let wait = 1000;
    while (!document.hidden) {
      try {
        const j = await api(`/api/events?since=${S.seq}`, { timeout: 35000 });
        if (j.seq < S.seq) { S.seq = j.seq; refreshListSoon(); if (chat) refreshChat(); continue; } // bridge restarted
        S.seq = j.seq;
        if (j.events.length) handle(j.events);
        wait = 1000;
      } catch (e) {
        if (e.auth) { // a rejected key will not fix itself: stop asking, say what to do, check again in a minute
          S.error = e.message; S.loaded = false;
          if (top().type === "list") render(); else toast(e.message);
          polling = false;
          setTimeout(() => { if (LS.get("token")) poll(); }, 60000);
          return;
        }
        await sleep(wait);
        wait = Math.min(wait * 2, 15000);
      }
    }
    polling = false;
  }

  // live clock without re-rendering (status line elapsed time)
  setInterval(() => {
    if (document.hidden || !chat || !chat.session || chat.session.state !== "running") return;
    const el = $app.querySelector(".status .el");
    if (el) el.textContent = dur(Date.now() - chat.session.since);
  }, 1000);

  // the page is frozen while hidden (display asleep): catch up when it comes back
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadList(); if (chat) refreshChat(); poll(); } });

  async function start() {
    render();
    if (!LS.get("token")) return;
    if (!API) await lookup();
    await hello();
    await loadList();
    poll();
  }
  start();
})();
