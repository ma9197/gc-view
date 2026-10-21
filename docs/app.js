/* GlassCode: see and drive the Claude Code chats on your laptop from Meta Ray-Ban Display glasses.
   Talks to the GlassCode bridge on the laptop through a tunnel. The pairing link carries the device key
   (#t=) and where to look up the tunnel address (#g= gist id); both stay on this device.
   Input: arrows move, Enter selects, Escape/Backspace/system Back goes back. */
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
      const f = (await r.json()).files["endpoint.json"];
      const e = JSON.parse(f.content);
      if (e && /^https:\/\/[^/]+$/.test(String(e.url).replace(/\/$/, ""))) { API = e.url.replace(/\/$/, ""); LS.set("api", API); }
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
    const d = document.querySelector(".top .dot");
    if (d) d.classList.toggle("on", on);
  }

  // ---------- app state ----------
  const S = { sessions: [], away: false, seq: 0, showOffline: false, loaded: false, error: null };
  const stack = [{ type: "list" }];
  const top = () => stack[stack.length - 1];
  let chat = null; // { id, items, start, total, session, sent, expanded:Set, answers:{} }

  // ---------- focus navigation (rows of focusables, like a TV remote) ----------
  const focusKey = {}; // screen -> data-k last focused
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
  function focusEl(e, dir) {
    if (!e) return;
    e.focus({ preventScroll: true });
    const sc = e.closest(".scroll");
    if (sc) {
      const r = e.getBoundingClientRect(), v = sc.getBoundingClientRect();
      if (r.height > v.height - 16) sc.scrollTop += dir === "up" ? r.bottom - v.bottom + 8 : r.top - v.top - 8; // tall: show the edge we came from
      else if (r.top < v.top + 4) sc.scrollTop -= v.top - r.top + 8;
      else if (r.bottom > v.bottom - 4) sc.scrollTop += r.bottom - v.bottom + 8;
    }
    if (e.dataset.k) focusKey[top().type] = e.dataset.k;
  }
  function move(dir) {
    const gs = groups(), cur = document.activeElement;
    if (!gs.length) return;
    const gi = gs.findIndex((g) => g.includes(cur));
    if (gi < 0) return focusEl((dir === "up" ? gs[gs.length - 1] : gs[0])[0], dir);
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
  function restoreFocus(fallback) {
    const k = focusKey[top().type];
    const e = (k && $app.querySelector(`[data-k="${CSS.escape(k)}"]`)) || (fallback && $app.querySelector(fallback)) || $app.querySelector("[data-f]");
    if (e) focusEl(e);
  }

  // ---------- keys and Back ----------
  const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  document.addEventListener("keydown", (e) => {
    const t = e.target, inInput = t && t.tagName === "INPUT";
    if (KEYS[e.key]) { e.preventDefault(); move(KEYS[e.key]); return; }
    if (e.key === "Enter") {
      if (inInput || (t && t.tagName === "BUTTON")) return; // native: composer opens / button clicks
      if (t && t.dataset && t.dataset.k) { e.preventDefault(); activate(t); }
      return;
    }
    if (e.key === "Escape" || e.key === "GoBack" || e.key === "BrowserBack" || (e.key === "Backspace" && !(inInput && t.value))) {
      e.preventDefault(); back();
    }
  });
  // Back from the system gesture arrives as history.back(): keep one guard entry while inside a chat.
  let guarded = false;
  function guard() { if (stack.length > 1 && !guarded) { try { history.pushState({ gc: 1 }, ""); guarded = true; } catch {} } }
  window.addEventListener("popstate", () => { guarded = false; back(true); });
  function back(fromHistory) {
    if (stack.length <= 1) return;
    if (!fromHistory && guarded) { guarded = false; history.back(); return; } // let popstate do it once
    if (top().type === "chat") { stopSpeaking(); chat = null; }
    stack.pop();
    render();
    if (top().type === "list") loadList();
    guard();
  }
  function go(screen) { stack.push(screen); render(); guard(); }

  $app.addEventListener("click", (e) => { const t = e.target.closest("[data-k]"); if (t && t.tagName !== "INPUT") activate(t); });
  $app.addEventListener("change", (e) => { const t = e.target; if (t.dataset && t.dataset.k) onInput(t); });

  // ---------- rendering helpers ----------
  const STATE = {
    running: { icon: "&bull;&bull;", label: "Working" },
    waiting: { icon: "?", label: "Needs you" },
    idle: { icon: "&#10003;", label: "Done" },
    offline: { icon: "&ndash;", label: "Offline" },
  };
  function stateLabel(s) {
    if (s.state === "waiting") return s.waitingFor === "question" ? "Question for you" : s.waitingFor === "permission" || /permission/.test(s.waitingFor || "") ? "Needs approval" : "Needs you";
    return STATE[s.state].label;
  }
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d";
  }
  function topBar(title, extra) {
    return `<div class="top"><span class="dot${online ? " on" : ""}"></span><h1>${esc(title)}</h1>${extra || ""}</div>`;
  }
  function awayPill() {
    return `<button class="pill${S.away ? " on" : ""}" data-f data-k="away">${S.away ? "Away: on" : "Away: off"}</button>`;
  }

  // small markdown subset: code blocks, inline code, bold, headings, bullets, links (as text)
  function md(src) {
    const parts = String(src).split(/```[^\n]*\n?/);
    return parts.map((p, i) => {
      if (i % 2) return `<pre><code>${esc(p.replace(/\n$/, ""))}</code></pre>`;
      return p.split(/\n{2,}/).map((para) => {
        if (!para.trim()) return "";
        const lines = para.split("\n").map((l) => {
          let h = esc(l)
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
          if (/^#{1,6}\s/.test(l)) return `<h>${h.replace(/^#{1,6}\s/, "")}</h>`;
          if (/^\s*[-*]\s/.test(l)) return "&bull; " + h.replace(/^\s*[-*]\s/, "");
          return h;
        });
        return `<p>${lines.join("<br>")}</p>`;
      }).join("");
    }).join("");
  }
  const plain = (s) => String(s).replace(/```[\s\S]*?```/g, " code block. ").replace(/[`*#>|_]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // ---------- screens ----------
  function render() {
    const t = top();
    if (!LS.get("token")) return renderPair();
    if (t.type === "list") return renderList();
    if (t.type === "chat") return renderChat();
    if (t.type === "image") return renderImage(t.src);
  }

  function renderPair() {
    $app.innerHTML = `<div class="pair"><h1>GlassCode</h1><p>Open the GlassCode pairing link from your phone (scan its QR code).</p>
      <p>Or paste the link here:</p><input type="text" data-f data-k="pair" autocomplete="off" spellcheck="false" placeholder="Paste link"></div>`;
    restoreFocus();
  }

  function rowHtml(s) {
    const st = STATE[s.state] || STATE.idle;
    const icon = s.state === "waiting" && s.waitingFor !== "question" ? "!" : st.icon;
    const last = s.last ? (s.last.role === "user" ? "You: " : "") + s.last.text : "";
    return `<button class="row" data-f data-k="s:${esc(s.id)}"><span class="st ${s.state}">${icon}</span><span class="rb">
      <div class="rn">${esc(s.name)}</div>
      <div class="rs"><b class="${s.state}">${esc(stateLabel(s))}</b>${s.folder ? " &middot; " + esc(s.folder) : ""} &middot; ${ago(s.since)}</div>
      ${last ? `<div class="rl">${esc(last)}</div>` : ""}</span></button>`;
  }

  function renderList() {
    const live = S.sessions.filter((s) => s.state !== "offline"), off = S.sessions.filter((s) => s.state === "offline");
    let body;
    if (!S.loaded) body = `<div class="empty">${esc(S.error || "Connecting to your laptop...")}</div>`;
    else {
      body = live.map(rowHtml).join("") || `<div class="empty">No chats are open on the laptop.</div>`;
      if (off.length) {
        body += `<button class="row" data-f data-k="offline"><span class="st offline">${S.showOffline ? "&minus;" : "+"}</span><span class="rb"><div class="rn">Offline chats (${off.length})</div><div class="rs">Closed on the laptop. Read only.</div></span></button>`;
        if (S.showOffline) body += off.map(rowHtml).join("");
      }
    }
    $app.innerHTML = topBar("GlassCode", awayPill()) + `<div class="scroll">${body}</div>`;
    restoreFocus(".scroll [data-f]");
  }

  function renderImage(src) {
    $app.innerHTML = `<div class="viewer"><img src="${esc(src)}" alt=""></div>`;
  }

  // chat items -> blocks (long runs of tool steps fold into one row)
  function blocks(items) {
    const out = [];
    let run = [];
    const flush = () => {
      if (run.length > 2 && !chat.expanded.has(run[0].key)) out.push({ kind: "group", key: run[0].key, items: run });
      else run.forEach((it) => out.push({ kind: "tool", it }));
      run = [];
    };
    for (const it of items) {
      if (it.role === "tool" && !(it.images && it.images.length) && it.status !== "error") { run.push(it); continue; }
      flush();
      out.push({ kind: it.role, it });
    }
    flush();
    return out;
  }

  function blockHtml(b) {
    const it = b.it;
    const thumbs = (it && it.images && it.images.length) ? `<div class="thumbs">${it.images.map((u) => `<img src="${esc(img(u))}" alt="" loading="lazy">`).join("")}</div>` : "";
    switch (b.kind) {
      case "user":
        return `<div class="msg user" tabindex="-1" data-f data-k="i:${esc(it.key)}">${it.via === "glasses" ? '<div class="who">From glasses</div>' : ""}${esc(it.text).replace(/\n/g, "<br>")}${thumbs}</div>`;
      case "assistant":
        return `<div class="msg assistant md" tabindex="-1" data-f data-k="i:${esc(it.key)}">${md(it.text)}${thumbs}</div>`;
      case "note":
        return `<div class="msg note">${esc(it.text)}</div>`;
      case "question": {
        const q = (it.question || [])[0] || {};
        const st = it.status === "answered" ? `Answered: ${esc((it.answer || "").replace(/^User has answered your questions?:\s*/i, "").slice(0, 240))}` : it.status === "pending" ? "Waiting for your answer" : "Dismissed";
        return `<div class="tool" tabindex="-1" data-f data-k="i:${esc(it.key)}"><span class="tn">Question</span><span class="ts">${esc(q.question || "")} &middot; ${st}</span></div>`;
      }
      case "group":
        return `<div class="tool group" tabindex="-1" data-f data-k="g:${esc(b.key)}"><span class="tn">+ ${b.items.length} steps</span><span class="ts">${esc(b.items.map((x) => x.tool).filter((v, i, a) => a.indexOf(v) === i).join(", "))}</span></div>`;
      default: { // tool
        const mark = it.status === "running" ? "&hellip;" : it.status === "error" ? "&#10007;" : "&#10003;";
        return `<div class="tool ${it.status}" tabindex="-1" data-f data-k="i:${esc(it.key)}"><span class="tn">${mark} ${esc(it.tool)}</span><span class="ts">${esc(it.summary || "")}</span></div>${thumbs ? `<div class="msg" style="padding-top:0">${thumbs}</div>` : ""}`;
      }
    }
  }

  function heldHtml(s) {
    const h = s.held;
    if (h && h.kind === "question") {
      const qs = h.questions || [];
      return `<div class="card">${qs.map((q, qi) => {
        const a = chat.answers[qi] || (chat.answers[qi] = { picked: [], other: "" });
        return `<div class="qh">${esc(q.header || "Question")}${q.multiSelect ? " &middot; pick any" : ""}</div><div class="qt">${esc(q.question)}</div>
          ${(q.options || []).map((o, oi) => `<button class="opt${a.picked.includes(o.label) ? " on" : ""}" data-f data-k="o:${qi}:${oi}"><div class="ol">${a.picked.includes(o.label) ? "&#10003; " : ""}${esc(o.label)}</div>${o.description ? `<div class="od">${esc(o.description)}</div>` : ""}</button>`).join("")}
          <div class="acts" style="margin:6px 0"><input class="speak" type="text" data-f data-k="other:${qi}" placeholder="${a.other ? esc(a.other) : "Other: speak or type"}" autocomplete="off"></div>`;
      }).join("")}<div class="acts" data-row><button class="send" data-f data-k="submit">Send answer</button></div></div>`;
    }
    if (h && h.kind === "permission") {
      return `<div class="card"><div class="qh">Approval needed</div><div class="qt">${esc(h.tool)}</div><div class="hint">${esc(h.input)}</div>
        <div class="acts" data-row><button class="send" data-f data-k="allow">Allow</button><button data-f data-k="deny">Deny</button></div></div>`;
    }
    if (s.state === "waiting") {
      return `<div class="card"><div class="qh">Waiting on the laptop</div><div class="hint">Claude is asking something on the laptop. Answer it there or on your phone. To answer here next time, turn Away on first.</div>
        ${S.away ? "" : `<div class="acts" data-row><button data-f data-k="away">Turn Away on</button></div>`}</div>`;
    }
    return "";
  }

  function renderChat() {
    if (!chat) return;
    const s = chat.session || { name: "Loading...", state: "idle" };
    const sc = $app.querySelector(".scroll");
    const atBottom = !sc || chat.atBottom !== false;
    const prevTop = sc ? sc.scrollTop : 0;
    const pending = (chat.sent || []).filter((m) => !m.delivered);
    let html = chat.start > 0 ? `<div class="msg note">Move up for older messages</div>` : "";
    html += blocks(chat.items).map(blockHtml).join("");
    html += pending.map((m) => `<div class="msg sent"><div class="who">Sending from glasses...</div>${esc(m.text)}</div>`).join("");
    html += heldHtml(s);
    const draft = LS.get("draft:" + chat.id, "");
    const bar = s.canSend
      ? `<div class="bar">${draft ? `<div class="draft" tabindex="-1" data-f data-k="draft">${esc(draft)}</div>` : ""}
        <div class="acts" data-row><input class="speak" type="text" data-f data-k="speak" autocomplete="off" spellcheck="false" placeholder="${draft ? "Add more" : "Speak or type"}">
        <button class="send" data-f data-k="send"${draft ? "" : " disabled"}>Send</button>${draft ? `<button data-f data-k="undo">Undo</button><button data-f data-k="clear">Clear</button>` : ""}
        <button data-f data-k="read">${speaking ? "Stop" : "Read"}</button></div></div>`
      : `<div class="bar"><div class="acts" data-row><div class="hint" style="flex:1">${s.state === "offline" ? "Offline: open it on the laptop to continue." : "Read only: restart this chat on the laptop once to message it."}</div><button data-f data-k="read">${speaking ? "Stop" : "Read"}</button></div></div>`;
    const st = STATE[s.state] || STATE.idle;
    $app.innerHTML = topBar(s.name, `<span class="pill" style="color:var(--${s.state === "running" ? "run" : s.state === "waiting" ? "wait" : s.state === "idle" ? "done" : "off"})">${esc(stateLabel(s))}</span>`) +
      `<div class="scroll">${html}</div>` + bar;
    const nsc = $app.querySelector(".scroll");
    nsc.addEventListener("scroll", () => { if (chat) chat.atBottom = nsc.scrollHeight - nsc.scrollTop - nsc.clientHeight < 40; });
    // images load after layout: keep the newest message in view if we were at the bottom
    nsc.addEventListener("load", () => { if (chat && chat.atBottom !== false) nsc.scrollTop = nsc.scrollHeight; }, true);
    if (chat.keepTop != null) { nsc.scrollTop = nsc.scrollHeight - chat.keepTop; chat.keepTop = null; }
    else nsc.scrollTop = atBottom || chat.first ? nsc.scrollHeight : prevTop;
    if (chat.first && chat.ready) { // first view: the question if one waits, else the newest message
      chat.first = false;
      const all = nsc.querySelectorAll("[data-f]");
      const e = (s.held && nsc.querySelector(".card [data-f]")) || all[all.length - 1] || $app.querySelector(".bar [data-f]");
      focusKey.chat = e && e.dataset.k;
    }
    restoreFocus(s.held ? ".card [data-f]" : ".bar [data-f]");
  }

  // ---------- actions ----------
  async function activate(el) {
    const k = el.dataset.k;
    try {
      if (k.startsWith("s:")) return openChat(k.slice(2));
      if (k === "offline") { S.showOffline = !S.showOffline; return render(); }
      if (k === "away") { const j = await api("/api/away", { body: { on: !S.away } }); S.away = j.away; toast(S.away ? "Away on: questions come to the glasses" : "Away off: questions stay on the laptop", true); return render(); }
      if (k.startsWith("g:")) { chat.expanded.add(k.slice(2)); return render(); }
      if (k.startsWith("i:")) { const it = chat.items.find((x) => "i:" + x.key === k); if (it && it.images && it.images.length) go({ type: "image", src: img(it.images[0]) }); return; }
      if (k === "send") return sendDraft();
      if (k === "undo") { const d = LS.get("draft:" + chat.id, ""); const parts = d.split("\n"); parts.pop(); LS.set("draft:" + chat.id, parts.join("\n")); focusKey.chat = "speak"; return render(); }
      if (k === "clear") { LS.del("draft:" + chat.id); focusKey.chat = "speak"; return render(); }
      if (k === "read") return toggleRead();
      if (k.startsWith("o:")) return pickOption(k);
      if (k === "submit") return submitAnswers();
      if (k === "allow" || k === "deny") {
        await api(`/api/sessions/${encodeURIComponent(chat.id)}/permission`, { body: { allow: k === "allow", key: chat.session.held && chat.session.held.key } });
        toast(k === "allow" ? "Allowed" : "Denied", true);
        return refreshChat();
      }
    } catch (e) { toast(e.message); }
  }

  // Text from the glasses composer (dictation, handwriting or keyboard). Each entry is ADDED to the draft,
  // so you can dictate, think, and dictate more before sending. The box empties itself after each entry.
  function onInput(t) {
    const v = t.value.trim(), k = t.dataset.k;
    t.value = "";
    if (!v) return;
    if (k === "pair") { if (pairWith(readLink(v)) || pairWith({ t: v })) { API = LS.get("api", null); start(); } return; }
    if (k === "speak") {
      const d = LS.get("draft:" + chat.id, "");
      LS.set("draft:" + chat.id, d ? d + "\n" + v : v);
      focusKey.chat = "speak";
      return render();
    }
    if (k.startsWith("other:")) {
      const qi = +k.split(":")[1], q = chat.session.held.questions[qi], a = chat.answers[qi];
      a.other = a.other ? a.other + " " + v : v;
      if (!q.multiSelect) a.picked = [];
      focusKey.chat = "submit";
      return render();
    }
  }

  function pickOption(k) {
    const [, qi, oi] = k.split(":").map(Number), q = chat.session.held.questions[qi], a = chat.answers[qi], label = q.options[oi].label;
    if (q.multiSelect) a.picked = a.picked.includes(label) ? a.picked.filter((x) => x !== label) : a.picked.concat(label);
    else { a.picked = [label]; a.other = ""; focusKey.chat = "submit"; }
    render();
  }

  async function submitAnswers() {
    const h = chat.session.held, answers = {};
    h.questions.forEach((q, qi) => {
      const a = chat.answers[qi] || { picked: [], other: "" };
      const vals = a.picked.concat(a.other ? [a.other] : []);
      if (vals.length) answers[q.question] = vals.join(", ");
    });
    if (Object.keys(answers).length < h.questions.length) return toast("Pick an answer for each question first");
    await api(`/api/sessions/${encodeURIComponent(chat.id)}/answer`, { body: { key: h.key, answers } });
    chat.answers = {};
    toast("Answer sent", true);
    refreshChat();
  }

  async function sendDraft() {
    const text = LS.get("draft:" + chat.id, "").trim();
    if (!text) return;
    const id = chat.id;
    chat.sent = (chat.sent || []).concat({ text, delivered: false });
    LS.del("draft:" + id);
    focusKey.chat = "speak";
    render();
    try {
      const j = await api(`/api/sessions/${encodeURIComponent(id)}/send`, { body: { text }, timeout: 20000 });
      toast(j.delivered ? "Sent" : "Queued: it will arrive in a moment", true);
    } catch (e) {
      LS.set("draft:" + id, text); // keep the words if sending failed
      toast(e.message);
    }
    refreshChat();
  }

  // ---------- read aloud (speechSynthesis: one built-in voice) ----------
  let speaking = false;
  function stopSpeaking() { try { speechSynthesis.cancel(); } catch {} speaking = false; }
  function toggleRead() {
    if (speaking) { stopSpeaking(); return render(); }
    const last = [...chat.items].reverse().find((x) => x.role === "assistant");
    if (!last || !window.speechSynthesis) return toast("Nothing to read");
    const u = new SpeechSynthesisUtterance(plain(last.text).slice(0, 4000));
    u.onend = u.onerror = () => { speaking = false; if (top().type === "chat") render(); };
    speaking = true;
    speechSynthesis.speak(u);
    render();
  }

  // ---------- data ----------
  async function loadList() {
    try {
      const j = await api("/api/sessions");
      S.sessions = j.sessions; S.away = j.away; S.loaded = true; S.error = null;
    } catch (e) { S.error = e.message; }
    if (top().type === "list") render();
  }

  async function openChat(id) {
    const s = S.sessions.find((x) => x.id === id);
    chat = { id, items: [], start: 0, total: 0, session: s || null, sent: [], expanded: new Set(), answers: {}, first: true };
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
      chat.total = j.total;
      const heldBefore = chat.session && chat.session.held && chat.session.held.key;
      chat.session = j.session;
      if ((j.session.held && j.session.held.key) !== heldBefore) chat.answers = {};
      chat.sent = j.sent || [];
      chat.ready = true;
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

  // ---------- live updates and notifications ----------
  let bannerTimer = null;
  function toast(text, ok) {
    $banner.textContent = text;
    $banner.className = "show" + (ok ? " done" : "");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { $banner.className = ""; }, 4000);
  }
  // the list only matters while it is on screen; at most one refresh every 2 s (busy chats change constantly)
  let listTimer = null, listAt = 0;
  function refreshListSoon() {
    if (top().type !== "list" || listTimer) return;
    listTimer = setTimeout(() => { listTimer = null; listAt = Date.now(); loadList(); }, Math.max(300, 2000 - (Date.now() - listAt)));
  }
  let chatTimer = null;
  const refreshChatSoon = () => { clearTimeout(chatTimer); chatTimer = setTimeout(refreshChat, 400); };

  function handle(events) {
    let chatDirty = false;
    for (const ev of events) {
      if (ev.type === "away") S.away = ev.away;
      const mine = chat && ev.id === chat.id;
      if (mine && (ev.type === "items" || ev.type === "state" || ev.type === "held" || ev.type === "delivered")) chatDirty = true;
      if (ev.type === "state" && ev.from === "running" && ev.to === "idle") toast(`${mine ? "" : ev.name + ": "}Claude finished`, true);
      if (ev.type === "held" && ev.held) toast(`${ev.name || "A chat"} needs you: ${ev.held.kind === "question" ? "question" : "approval"}`);
      if (ev.type === "state" && ev.to === "waiting" && !ev.held) toast(`${ev.name || "A chat"} needs you`);
    }
    refreshListSoon();
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

  // the page is frozen while hidden (display asleep): catch up when it comes back
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadList(); if (chat) refreshChat(); poll(); } });

  async function start() {
    render();
    if (!LS.get("token")) return;
    if (!API) await lookup();
    await loadList();
    poll();
  }
  start();
})();
