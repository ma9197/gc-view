/* GlassCode: see and drive the Claude Code chats on your laptop from Meta Ray-Ban Display glasses.
   Looks like the Claude Code terminal. Talks to the GlassCode bridge on the laptop through a tunnel; the pairing
   link carries the device key (#t=) and where to find the tunnel address (#g= gist id); both stay on this device.
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

  const DEFAULT_QUICK = ["Continue", "Yes, go ahead", "No, stop there", "Run the tests", "Summarize where you are in 3 short bullets", "What do you need from me?"];
  const prefs = Object.assign({ speak: true, offline: false, quick: DEFAULT_QUICK }, LS.get("prefs", {}));
  const savePrefs = () => LS.set("prefs", prefs);

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
      if (r.status === 401 || r.status === 429) { setOnline(false); throw Object.assign(new Error("The laptop refused this device's key. Open the GlassCode link again."), { auth: true }); }
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
    if (d) d.className = "dot conn " + (on ? "ok" : "err");
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
    const v = sc.getBoundingClientRect(), seen = (e) => { const r = e.getBoundingClientRect(); return r.bottom > v.top && r.top < v.bottom; };
    if (byKey && seen(byKey)) return byKey;
    let best = null, bd = Infinity;
    for (const e of sc.querySelectorAll("[data-f]")) {
      if (!seen(e)) continue;
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
    if (e.key === "Enter") {
      if (inInput || (t && t.tagName === "BUTTON")) return; // native: the composer opens / the button clicks
      if (t && t.dataset && t.dataset.k) { e.preventDefault(); activate(t); }
      return;
    }
    if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || (e.key === "Backspace" && !(inInput && t.value))) {
      e.preventDefault(); back();
    }
  });
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

  // ---------- glyphs (CSS/SVG, so they render on any font) ----------
  const star = (spin) => `<svg class="star${spin ? " spin" : ""}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>`;
  const dot = (cls) => `<span class="dot ${cls || ""}"></span>`;
  const elbow = '<span class="elbow"></span>';
  const ptr = '<span class="ptr"><svg viewBox="0 0 10 16" width=".6em" height=".9em" aria-hidden="true"><path d="M2 2l6 6-6 6" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const box = (st) => `<span class="box${st === "completed" ? " on" : st === "in_progress" ? " mid" : ""}"></span>`;

  function mark(s) {
    if (s.state === "running") return star(true);
    if (s.state === "waiting") return `<span class="warn">${dot()}</span>`;
    if (s.state === "idle") return `<span class="ok">${dot()}</span>`;
    return `<span class="dim">${dot("hollow")}</span>`;
  }
  const COLOR = { running: "cl", waiting: "warn", idle: "ok", offline: "dim" };
  function stateText(s) {
    if (s.state === "running") return "working " + dur(Date.now() - s.since);
    if (s.state === "waiting") return s.waitingFor === "question" ? "question for you" : /permission/.test(s.waitingFor || "") ? "needs approval" : "waiting for you";
    return s.state === "idle" ? "done" : "offline";
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

  // ---------- screens ----------
  function render() {
    if (!LS.get("token")) return renderPair();
    const t = top();
    if (t.type === "list") return renderList();
    if (t.type === "settings") return renderSettings();
    if (t.type === "chat") return renderChat();
    if (t.type === "image") return renderImage();
  }

  function renderPair() {
    $app.innerHTML = `<div class="pair"><div class="t">${star()} <b>GlassCode</b></div>
      <div class="dim">Open the GlassCode pairing link from your phone (tap it or scan its QR code).</div>
      <input class="otext" type="text" data-f data-k="pair" autocomplete="off" spellcheck="false" placeholder="Or paste the link here"></div>`;
    restoreFocus();
  }

  function rowHtml(s) {
    const t = s.tasks, line3 = s.activity || (s.last ? (s.last.role === "user" ? "> " : "") + s.last.text : "");
    return `<button class="row" data-f data-k="s:${esc(s.id)}">${ptr}<span class="rb">
      <span class="rl1">${mark(s)}<span class="rn">${esc(s.name)}</span>${isNew(s) ? '<span class="tag">new</span>' : ""}</span>
      <span class="rl2"><span class="${COLOR[s.state]}">${esc(stateText(s))}</span>${s.folder ? " &middot; " + esc(s.folder) : ""}${s.state !== "running" ? " &middot; " + ago(s.since) : ""}${t ? ` &middot; ${t.done}/${t.total} tasks` : ""}</span>
      ${line3 ? `<span class="rl3">${elbow}<span>${esc(line3)}</span></span>` : ""}</span></button>`;
  }

  function renderList() {
    const live = S.sessions.filter((s) => s.state !== "offline"), off = S.sessions.filter((s) => s.state === "offline");
    const need = live.filter((s) => s.state === "waiting"), running = live.filter((s) => s.state === "running");
    let body;
    if (!S.loaded) body = `<div class="empty">${esc(S.error || "Connecting to your laptop...")}</div>`;
    else {
      body = need.length ? `<button class="row inbox" data-f data-k="inbox">${ptr}<span class="rb"><span class="rl1">${dot()}<span class="rn">${need.length === 1 ? "1 chat needs you" : need.length + " chats need you"}</span></span>
        <span class="rl2">Pinch to start with ${esc(need[0].name)}</span></span></button>` : "";
      body += live.map(rowHtml).join("") || `<div class="empty">No chats are open on the laptop.</div>`;
      if (off.length) {
        body += `<button class="row" data-f data-k="offline">${ptr}<span class="rb"><span class="rl1"><span class="dim">${dot("hollow")}</span><span class="rn dim">${prefs.offline ? "Hide" : "Show"} offline chats (${off.length})</span></span><span class="rl2">Closed on the laptop. Read only.</span></span></button>`;
        if (prefs.offline) body += off.map(rowHtml).join("");
      }
    }
    $app.innerHTML = `<div class="welcome"><div class="t">${star()} GlassCode<span class="dim" style="font-weight:400">${S.laptop ? " &middot; " + esc(S.laptop) : ""}</span>
        <span class="dot conn ${online ? "ok" : "err"}" style="margin-left:auto"></span></div>
      <div class="s">${live.length} open &middot; <span class="${need.length ? "warn" : ""}">${need.length} need you</span> &middot; ${running.length} working</div>
      <div class="modes" data-row><button class="chip${S.away ? " on" : ""}" data-f data-k="away">&raquo; Away: ${S.away ? "on" : "off"}</button><button class="chip" data-f data-k="settings">Settings</button></div></div>
      <div class="scroll">${body}</div>`;
    restoreFocus(need.length ? '[data-k="inbox"]' : ".scroll [data-f]");
  }

  function renderSettings() {
    const c = confirming;
    const item = (k, label, val, on) => `<button class="set" data-f data-k="${k}">${ptr}<span>${label}</span><span class="sv${on ? " on" : ""}">${val}</span></button>`;
    $app.innerHTML = `<div class="head"><span class="n">${star()} Settings</span></div><div class="scroll">
      ${item("set:away", "Away mode (questions to glasses)", S.away ? "on" : "off", S.away)}
      ${item("set:speak", "Speak alerts out loud", prefs.speak ? "on" : "off", prefs.speak)}
      ${item("set:offline", "Show offline chats", prefs.offline ? "on" : "off", prefs.offline)}
      <div class="sect">Quick replies &middot; pinch one twice to remove</div>
      ${prefs.quick.map((q, i) => item("qr:" + i, esc(q), c("qr:" + i) ? "pinch again to remove" : "", false)).join("")}
      <input class="otext" type="text" data-f data-k="qradd" autocomplete="off" placeholder="+ Add a quick reply (speak or type)">
      ${item("qr:reset", "Reset quick replies", c("qr:reset") ? "pinch again" : "", false)}
      <div class="sect">This device</div>
      <button class="set danger" data-f data-k="unpair">${ptr}<span>Unpair this device</span><span class="sv">${c("unpair") ? "pinch again to unpair" : ""}</span></button>
      <div class="sect">${esc(S.laptop || "laptop")} &middot; swipe to move, pinch to select, back to leave</div></div>`;
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

  // transcript items -> blocks; long runs of plain tool steps fold into one row
  function blocks(items) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length > 2 && !chat.open.has("g:" + run[0].key)) out.push({ kind: "group", key: run[0].key, items: run });
      else run.forEach((it) => out.push({ kind: "tool", it }));
      run = [];
    };
    for (const it of items) {
      if (it.quiet) continue; // task-list plumbing: shown as the checklist instead
      const plainTool = it.role === "tool" && !(it.images && it.images.length) && it.status === "done" && !chat.open.has("i:" + it.key);
      if (plainTool) { run.push(it); continue; }
      flush();
      out.push({ kind: it.role, it });
    }
    flush();
    return out;
  }

  const thumbs = (it) => (it && it.images && it.images.length ? `<div class="thumbs">${it.images.map((u) => `<img src="${esc(img(u))}" alt="" loading="lazy">`).join("")}</div>` : "");

  function toolDetails(it) {
    const diff = it.diff ? `<div class="diff">${it.diff.map((l) => `<div class="${l[0] === "+" ? "a" : l[0] === "-" ? "d" : "c"}">${esc(l)}</div>`).join("")}</div>` : "";
    return `<div class="det">${it.detail ? `<pre class="cmd">${esc(it.detail)}</pre>` : ""}${diff}${it.out ? `<pre>${esc(it.out)}</pre>` : ""}${!it.detail && !diff && !it.out ? "<pre>No more details.</pre>" : ""}</div>`;
  }

  function blockHtml(b) {
    const it = b.it, k = (p) => `data-f tabindex="-1" data-k="${p}"`;
    switch (b.kind) {
      case "user":
        return `<div class="it user" ${k("i:" + esc(it.key))}>${it.via === "glasses" ? '<div class="via">from your glasses</div>' : ""}<span class="gt">&gt;</span>${esc(it.text).replace(/\n/g, "<br>")}${thumbs(it)}</div>`;
      case "assistant":
        return `<div class="it" ${k("i:" + esc(it.key))}><div class="line">${dot()}<div class="md">${md(it.text)}</div></div>${thumbs(it)}</div>`;
      case "note":
        return `<div class="note">${esc(it.text)}</div>`;
      case "question": {
        const q = (it.question || [])[0] || {};
        const ans = it.status === "answered" ? esc((it.answer || "").replace(/^User has answered your questions?:\s*/i, "").slice(0, 240)) : it.status === "pending" ? "Waiting for your answer" : "Dismissed";
        return `<div class="it" ${k("i:" + esc(it.key))}><div class="line"><span class="${it.status === "pending" ? "warn" : "ok"}">${dot()}</span><span><span class="tn">Question</span> ${esc(q.question || "")}</span></div><div class="res">${elbow}<span>${ans}</span></div></div>`;
      }
      case "group": {
        const counts = {};
        b.items.forEach((x) => { counts[x.tool] = (counts[x.tool] || 0) + 1; });
        const what = Object.entries(counts).map(([n, c]) => (c > 1 ? `${esc(n)} &times;${c}` : esc(n))).join(", ");
        return `<div class="it" ${k("g:" + esc(b.key))}><div class="line"><span class="ok">${dot()}</span><span><span class="tn">${b.items.length} tool uses</span></span></div><div class="res">${elbow}<span>${what} &middot; pinch to expand</span></div></div>`;
      }
      default: { // tool, like "● Bash(npm test)  ⎿ 12 passed"
        const st = it.status === "running" ? `<span class="dim">${dot("blink")}</span>` : it.status === "error" ? `<span class="err">${dot()}</span>` : `<span class="ok">${dot()}</span>`;
        const open = chat.open.has("i:" + it.key);
        return `<div class="it" ${k("i:" + esc(it.key))}><div class="line">${st}<span><span class="tn">${esc(it.tool)}</span>${it.summary ? `(${esc(it.summary)})` : ""}</span></div>
          <div class="res">${elbow}<span class="${it.status === "error" ? "err" : ""}">${esc(it.status === "running" ? "Running..." : it.result || "Done")}</span></div>${open ? toolDetails(it) : ""}${thumbs(it)}</div>`;
      }
    }
  }

  function tasksHtml() {
    const ts = chat.tasks || [];
    if (!ts.length || (ts.every((t) => t.status === "completed") && chat.session && chat.session.state !== "running")) return "";
    const open = chat.open.has("tasks"), done = ts.filter((t) => t.status === "completed").length;
    let show = ts;
    if (!open && ts.length > 6) { const i = Math.max(0, ts.findIndex((t) => t.status !== "completed") - 1); show = ts.slice(i, i + 6); }
    return `<div class="it tasks" data-f tabindex="-1" data-k="tasks"><div class="line"><span class="cl">${dot()}</span><span><span class="tn">Tasks</span> <span class="dim">${done}/${ts.length} done</span></span></div>
      ${show.map((t) => `<div class="task${t.status === "completed" ? " done" : t.status === "in_progress" ? " now" : ""}">${box(t.status)}<span>${esc(t.status === "in_progress" ? t.activeForm || t.subject : t.subject)}</span></div>`).join("")}
      ${show.length < ts.length ? `<div class="dim" style="font-size:14px">+${ts.length - show.length} more &middot; pinch to see all</div>` : ""}</div>`;
  }

  function dialogHtml(s) {
    const h = s.held;
    if (h && h.kind === "question") {
      return `<div class="dlg">${(h.questions || []).map((q, qi) => {
        const a = chat.answers[qi] || (chat.answers[qi] = { picked: [], other: "" }), n = (q.options || []).length;
        return `${q.header ? `<div class="hdr">${esc(q.header)}</div>` : ""}<div class="q">${esc(q.question)}</div>
          ${(q.options || []).map((o, oi) => { const on = a.picked.includes(o.label);
            return `<button class="opt${on ? " on" : ""}" data-f data-k="o:${qi}:${oi}">${ptr}<span class="ob"><div class="ol">${q.multiSelect ? box(on ? "completed" : "") + " " : ""}${oi + 1}. ${esc(o.label)}</div>${o.description ? `<div class="od">${esc(o.description)}</div>` : ""}</span></button>`; }).join("")}
          <input class="otext" type="text" data-f data-k="other:${qi}" autocomplete="off" placeholder="${n + 1}. ${a.other ? esc(a.other) : "Type something (speak or type)"}">`;
      }).join("<br>")}
        <button class="opt" data-f data-k="submit" style="margin-top:6px">${ptr}<span class="ob"><div class="ol pm">Submit</div></span></button></div>`;
    }
    if (h && h.kind === "permission") {
      return `<div class="dlg"><div class="dt">${esc(h.tool)}${/^(Bash|PowerShell)$/.test(h.tool) ? " command" : ""}</div>
        <div class="cmdbox">${esc(h.input)}</div>${h.description ? `<div class="dim" style="font-size:15px">${esc(h.description)}</div>` : ""}
        <div class="q">Do you want to proceed?</div>
        <button class="opt" data-f data-k="p:yes">${ptr}<span class="ob"><div class="ol">1. Yes</div></span></button>
        ${h.canAlways ? `<button class="opt" data-f data-k="p:always">${ptr}<span class="ob"><div class="ol">2. Yes, and don't ask again</div><div class="od">Claude Code's own suggested rule</div></span></button>` : ""}
        <button class="opt" data-f data-k="p:no">${ptr}<span class="ob"><div class="ol">${h.canAlways ? 3 : 2}. No</div></span></button>
        <input class="otext" type="text" data-f data-k="p:tell" autocomplete="off" placeholder="${h.canAlways ? 4 : 3}. No, and tell Claude what to do differently"></div>`;
    }
    if (s.state === "waiting") {
      const q = [...chat.items].reverse().find((x) => x.role === "question" && x.status === "pending");
      return `<div class="dlg" style="border-color:var(--warn)"><div class="dt warn">Waiting on the laptop</div>
        ${q ? `<div class="q">${esc(((q.question || [])[0] || {}).question || "")}</div>` : ""}
        <div class="dim" style="font-size:15px">Answer it on the laptop or your phone. ${S.away ? "" : "Turn Away on first to answer here next time."}</div>
        ${S.away ? "" : `<button class="opt" data-f data-k="away">${ptr}<span class="ob"><div class="ol">Turn Away on</div></span></button>`}</div>`;
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
    const others = S.sessions.filter((x) => x.id !== chat.id && x.state === "waiting");
    let html = chat.start > 0 ? `<div class="note">swipe up for older messages</div>` : "";
    html += blocks(chat.items).map(blockHtml).join("") + tasksHtml();
    html += pendingSent.map((m) => `<div class="it user"><div class="via">sending from your glasses...</div><span class="gt">&gt;</span>${esc(m.text)}</div>`).join("");
    html += dialogHtml(s);
    if (others.length && !s.held) html += `<button class="it" data-f data-k="next:${esc(others[0].id)}"><div class="line"><span class="warn">${dot()}</span><span class="warn">Next: ${esc(others[0].name)} needs you</span></div></button>`;

    const draft = LS.get("draft:" + chat.id, "");
    const t = chat.session && chat.session.tasks;
    const spinner = s.state === "running" ? `<div class="spin" data-row>${star(true)}<span class="v">${esc((t && t.active) || "Working")}&hellip; <span class="dim">(<span class="el">${dur(Date.now() - s.since)}</span>${t ? ` &middot; ${t.done}/${t.total} tasks` : ""})</span></span>
      ${s.canSend ? `<button class="chip" data-f data-k="stop">${confirming("stop") ? "Pinch again to stop" : "Stop"}</button>` : ""}</div>` : "";
    const quick = s.canSend && !s.held ? `<div class="chips" data-row>${prefs.quick.map((q, i) => `<button class="chip" data-f data-k="q:${i}">${esc(q)}</button>`).join("")}</div>` : "";
    const prompt = s.canSend
      ? `<div class="prompt">${draft ? `<div class="draft" data-f tabindex="-1" data-k="draft">${esc(draft)}</div>` : ""}
          <div class="pl"><span class="gt">&gt;</span><input class="pin" type="text" data-f data-k="speak" autocomplete="off" spellcheck="false" placeholder="${draft ? "Add more (speak or type)" : "Speak or type..."}"></div></div>
        ${draft ? '<div class="acts" data-row><button class="chip go" data-f data-k="send">Send</button><button class="chip" data-f data-k="undo">Undo</button><button class="chip" data-f data-k="clear">Clear</button></div>' : ""}`
      : `<div class="ro">${s.state === "offline" ? "Offline: open it on the laptop to continue." : "Read only: restart this chat on the laptop once to message it."}</div>`;
    // like the CLI mode line; only shown when it matters, to keep the transcript big
    const modeline = speaking ? '<div class="modeline cl">reading aloud &middot; pinch the reply again to stop</div>' : S.away ? '<div class="modeline"><span class="warn">&raquo; away mode on</span> &middot; questions come here</div>' : "";

    $app.innerHTML = `<div class="head"><span class="n">${esc(s.name)}</span><span class="st ${COLOR[s.state]}">${mark(s)}${esc(stateText(s))}</span></div>
      <div class="scroll">${html}</div><div class="bottom">${spinner}${quick}${prompt}${modeline}</div>`;

    const nsc = $app.querySelector(".scroll");
    nsc.addEventListener("scroll", () => { if (chat) chat.atBottom = nsc.scrollHeight - nsc.scrollTop - nsc.clientHeight < 40; });
    nsc.addEventListener("load", () => { if (chat && chat.atBottom !== false) nsc.scrollTop = nsc.scrollHeight; }, true); // images load late
    if (chat.keepTop != null) { nsc.scrollTop = nsc.scrollHeight - chat.keepTop; chat.keepTop = null; }
    else nsc.scrollTop = atBottom ? nsc.scrollHeight : prevTop;
    if (chat.first && chat.ready) { // first view: the question if one waits, else the newest message
      chat.first = false;
      const all = nsc.querySelectorAll('[data-k^="i:"], [data-k^="g:"], [data-k="tasks"]');
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
      if (k.startsWith("next:")) { stack.pop(); return openChat(k.slice(5)); }
      if (k === "inbox") { const s = S.sessions.find((x) => x.state === "waiting"); return s && openChat(s.id); }
      if (k === "offline" || k === "set:offline") { prefs.offline = !prefs.offline; savePrefs(); return render(); }
      if (k === "settings") return go({ type: "settings" });
      if (k === "away" || k === "set:away") return toggleAway();
      if (k === "set:speak") { prefs.speak = !prefs.speak; savePrefs(); if (prefs.speak) say("Alerts will be spoken"); return render(); }
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
    if (it.images && it.images.length && it.role !== "tool") return openImages(it);
    if (it.role === "assistant") return toggleRead(it.text);
    if (it.role === "tool") { // pinch a tool step: its command, output or diff; screenshots open full screen
      if (it.images && it.images.length) return openImages(it);
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
    toast(S.away ? "Away on: questions come to the glasses" : "Away off: questions stay on the laptop", true);
    render();
  }

  function settingsAction(k) {
    const again = confirming(k);
    if (!again) { Object.assign(confirmKey, { k, at: Date.now() }); return render(); }
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
    const [, qi, oi] = k.split(":").map(Number), h = chat.session.held, q = h.questions[qi], a = chat.answers[qi], label = q.options[oi].label;
    if (q.multiSelect) { a.picked = a.picked.includes(label) ? a.picked.filter((x) => x !== label) : a.picked.concat(label); return render(); }
    a.picked = [label]; a.other = "";
    if (autoSubmit()) return; // like the CLI: picking the answer to the last open question sends it
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
  function say(text) {
    if (!prefs.speak || speaking || !window.speechSynthesis) return;
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
  }

  // ---------- data ----------
  async function loadList() {
    try {
      const j = await api("/api/sessions");
      S.sessions = j.sessions; S.away = j.away; S.loaded = true; S.error = null;
      if (!LS.get("seen", null)) { j.sessions.forEach((s) => { seen[s.id] = Date.now(); }); LS.set("seen", seen); } // first run: all read
    } catch (e) { S.error = e.message; }
    if (top().type === "list") render();
  }
  async function hello() { try { const j = await api("/api/hello"); S.laptop = j.laptop; S.away = j.away; } catch {} }

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
      const j = await api(`/api/sessions/${encodeURIComponent(id)}?limit=60`);
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
      const j = await api(`/api/sessions/${encodeURIComponent(chat.id)}?before=${chat.start}&limit=40`);
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

  function handle(events) {
    let chatDirty = false, listDirty = false;
    for (const ev of events) {
      if (ev.type === "away") { S.away = ev.away; listDirty = true; }
      const mine = chat && ev.id === chat.id, name = ev.name || "A chat";
      if (mine && ["items", "state", "held", "delivered"].includes(ev.type)) chatDirty = true;
      if (ev.type === "state" || ev.type === "held") listDirty = true;
      if (ev.type === "state" && ev.from === "running" && ev.to === "idle") { toast(`${mine ? "" : name + ": "}Claude finished`, true); say(`${name} finished`); }
      if (ev.type === "held" && ev.held) { toast(`${name} needs you: ${ev.held.kind === "question" ? "a question" : "an approval"}`); say(`${name} needs you`); }
      if (ev.type === "state" && ev.to === "waiting" && !ev.held) { toast(`${name} is waiting on the laptop`); say(`${name} is waiting on the laptop`); }
    }
    if (listDirty || top().type === "list") refreshListSoon(); // the chat screen uses the list too (Next row)
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
        if (e.auth) { S.error = e.message; S.loaded = false; if (top().type === "list") render(); }
        await sleep(wait);
        wait = Math.min(wait * 2, 15000);
      }
    }
    polling = false;
  }

  // live clock without re-rendering (spinner elapsed time)
  setInterval(() => {
    if (document.hidden || !chat || !chat.session || chat.session.state !== "running") return;
    const el = $app.querySelector(".spin .el");
    if (el) el.textContent = dur(Date.now() - chat.session.since);
  }, 1000);

  // the page is frozen while hidden (display asleep): catch up when it comes back
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadList(); if (chat) refreshChat(); poll(); } });

  async function start() {
    render();
    if (!LS.get("token")) return;
    if (!API) await lookup();
    hello();
    await loadList();
    poll();
  }
  start();
})();
