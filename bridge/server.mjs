// GlassCode bridge: lets the glasses web app see and drive Claude Code sessions on this laptop.
// Binds to 127.0.0.1 only; the outside world reaches it through the tunnel (tunnel.mjs).
// Every /api route needs the device token. Images use short-lived signed links so <img> works.
import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { Sessions } from "./sessions.mjs";
import { Relay } from "./relay.mjs";
import { startTunnel } from "./tunnel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL = join(HERE, ".local");
const CONFIG = join(LOCAL, "config.json");
const VERSION = "1.0.0";

mkdirSync(LOCAL, { recursive: true });
if (!existsSync(CONFIG)) {
  writeFileSync(CONFIG, JSON.stringify({
    port: 8790,                               // API: the only port the tunnel points at
    hookPort: 8791,                           // hooks: local only, never tunnelled
    token: randomBytes(32).toString("hex"),   // the glasses' device token (goes in the app link)
    imgKey: randomBytes(32).toString("hex"),
    origins: ["https://ma9197.github.io", "http://localhost:8792", "http://127.0.0.1:8792"],
  }, null, 2));
}
export const config = JSON.parse(readFileSync(CONFIG, "utf8"));

const sha = (s) => createHash("sha256").update(String(s)).digest();
const TOKEN = sha(config.token);
const sessions = new Sessions();
const relay = new Relay(sessions);
const log = (...a) => appendFileSync(join(LOCAL, "bridge.log"), new Date().toISOString() + " " + a.join(" ") + "\n");

// ---------- auth (the token is 256-bit, so guessing is hopeless) ----------
// The right key is ALWAYS accepted. Wrong keys are slowed down per client, never for everyone: a global lockout
// let one stale tab (or a stranger) lock the real glasses out (2026-10-21).
const fails = new Map(); // client -> recent failure times
const client = (req) => String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?");
function authed(req, secret) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ") && timingSafeEqual(sha(h.slice(7)), secret)) return true;
  const c = client(req), list = (fails.get(c) || []).filter((t) => t > Date.now() - 600e3).concat(Date.now());
  fails.set(c, list);
  if (list.length === 20) log("20 bad keys from", c, "in 10 min");
  if (fails.size > 1000) fails.clear(); // memory bound
  return false;
}
const throttled = (req) => (fails.get(client(req)) || []).length >= 20;

const sign = (sid, img, exp) => createHmac("sha256", config.imgKey).update(`${sid}|${img}|${exp}`).digest("hex").slice(0, 32);
function imgUrl(sid, img) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `/img/${encodeURIComponent(sid)}/${encodeURIComponent(img)}?exp=${exp}&sig=${sign(sid, img, exp)}`;
}

// ---------- live events (long polling: Cloudflare quick tunnels do not support SSE) ----------
let seq = 0;
const events = [];             // ring of { seq, ...event }
const waiters = new Set();     // pending long-poll responses
function emit(ev) {
  events.push({ seq: ++seq, at: Date.now(), ...ev });
  if (events.length > 500) events.splice(0, events.length - 500);
  for (const w of waiters) w();
}
relay.onEvent = emit;

const prev = new Map(); // id -> { state, waitingFor, version }
function tick() {
  let list;
  try { list = sessions.list(); } catch (e) { log("list failed", e.stack); return; }
  for (const s of list) {
    overlay(s);
    const t = sessions.transcripts.get(s.id), version = t ? t.version : 0, p = prev.get(s.id);
    if (p && (p.state !== s.state || p.waitingFor !== s.waitingFor)) {
      emit({ type: "state", id: s.id, name: s.name, from: p.state, to: s.state, waitingFor: s.waitingFor, held: !!s.held });
    }
    if (p && p.version !== version) emit({ type: "items", id: s.id, version });
    prev.set(s.id, { state: s.state, waitingFor: s.waitingFor, version });
  }
}
setInterval(tick, 1000);

// A question or permission held for the glasses means the chat waits on you, whatever the registry says.
function overlay(s) {
  const h = relay.heldFor(s.id);
  if (h) { s.state = "waiting"; s.waitingFor = h.kind; }
  s.held = h;
  return s;
}

// ---------- views ----------
const publicSession = (s) => ({
  id: s.id, name: s.name, folder: s.cwd ? s.cwd.split(/[\\/]/).pop() : null, state: s.state,
  waitingFor: s.waitingFor, since: s.since, last: s.last || null, remote: s.remote, canSend: relay.canSend(s), held: s.held || null,
  tasks: s.tasks || null, activity: s.activity || null,
});

function itemsView(s, before, limit) {
  const t = sessions.transcriptFor(s);
  if (!t) return { session: publicSession(s), items: [], start: 0, total: 0 };
  const end = Math.min(before ?? t.items.length, t.items.length), start = Math.max(0, end - limit);
  const items = t.items.slice(start, end).map(({ input, name, ...it }) => ({ ...it, images: (it.images || []).map((id) => imgUrl(s.id, id)) }));
  return { session: publicSession(s), items, start, total: t.items.length, version: t.version, pending: t.pending()?.key || null, sent: relay.sentFor(s.id), tasks: t.tasks };
}

// ---------- http ----------
function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(code, { "Content-Type": isBuf ? headers.type || "application/octet-stream" : "application/json", "Cache-Control": "no-store", ...headers });
  res.end(isBuf ? body : body === "" ? undefined : JSON.stringify(body)); // "" = truly empty (hooks: "no decision")
}

function readJson(req) {
  return new Promise((ok, bad) => {
    let n = 0, chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 256e3) { bad(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { bad(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const origin = req.headers.origin;
  if (origin && config.origins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") return send(res, 204, "");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  try {
    // signed image links (no header possible on <img>)
    if (parts[0] === "img" && parts.length === 3) {
      const [, sid, img] = parts, exp = +url.searchParams.get("exp"), sig = url.searchParams.get("sig") || "";
      if (!(exp > Date.now() / 1000) || sig.length !== 32 || !timingSafeEqual(Buffer.from(sig), Buffer.from(sign(sid, img, exp)))) return send(res, 403, { error: "bad link" });
      const s = sessions.get(sid), t = s && sessions.transcriptFor(s), out = t && t.image(s.file, img);
      if (!out) return send(res, 404, { error: "no image" });
      return send(res, 200, out.data, { type: out.type, "Cache-Control": "private, max-age=3600" });
    }

    if (parts[0] !== "api") return send(res, 404, { error: "not found" });
    if (!authed(req, TOKEN)) return setTimeout(() => send(res, throttled(req) ? 429 : 401, { error: "unauthorized" }), throttled(req) ? 3000 : 0);

    if (parts[1] === "hello") return send(res, 200, { ok: true, version: VERSION, laptop: hostname(), away: relay.away, forced: relay.forced, seq });
    if (parts[1] === "sessions" && parts.length === 2) return send(res, 200, { sessions: sessions.list().map((s) => publicSession(overlay(s))), seq, away: relay.away });

    if (parts[1] === "sessions" && parts[2]) {
      const s = sessions.get(parts[2]) && overlay(sessions.get(parts[2]));
      if (!s) return send(res, 404, { error: "no such chat" });
      if (req.method === "GET" && parts.length === 3) {
        const before = url.searchParams.has("before") ? +url.searchParams.get("before") : undefined;
        return send(res, 200, itemsView(s, before, Math.min(+url.searchParams.get("limit") || 40, 100)));
      }
      if (req.method === "POST" && ["send", "answer", "permission", "stop"].includes(parts[3])) {
        const body = await readJson(req);
        log("POST", parts[3], s.id, JSON.stringify(body).slice(0, 2000));
        return send(res, 200, await relay[parts[3]](s, body));
      }
    }

    if (parts[1] === "away" && req.method === "POST") {
      const body = await readJson(req);
      relay.away = !!body.on;
      log("route to glasses", relay.forced);
      return send(res, 200, { away: relay.away, forced: relay.forced });
    }

    if (parts[1] === "events") {
      const since = +url.searchParams.get("since") || 0;
      let timer = null;
      const reply = () => { waiters.delete(reply); clearTimeout(timer); send(res, 200, { seq, events: events.filter((e) => e.seq > since) }); };
      if (seq > since && events.some((e) => e.seq > since)) return reply();
      timer = setTimeout(reply, 25000);
      waiters.add(reply);
      req.on("close", () => { waiters.delete(reply); clearTimeout(timer); });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    log("ERROR", req.method, url.pathname, e.stack);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(config.port, "127.0.0.1", () => {
  log("bridge listening on", config.port);
  console.log("GlassCode bridge on http://127.0.0.1:" + config.port);
  if (!process.argv.includes("--no-tunnel")) {
    startTunnel({ port: config.port, local: LOCAL, config, log, saveConfig: () => writeFileSync(CONFIG, JSON.stringify(config, null, 2)) });
  }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0)); // runs the tunnel cleanup

// Hooks from Claude Code on this laptop. Separate port the tunnel never reaches. Claude Code posts JSON without
// an Origin header; a web page always sends Origin, so refusing Origin stops other sites poking at localhost.
http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://x").pathname.split("/").filter(Boolean)[1];
  if (req.headers.origin || req.method !== "POST" || !/application\/json/.test(req.headers["content-type"] || "")) return send(res, 403, { error: "no" });
  try { relay.hook(name, await readJson(req), res, send); }
  catch (e) { log("HOOK ERROR", name, e.stack); if (!res.headersSent) send(res, 200, ""); } // never break a chat
}).listen(config.hookPort, "127.0.0.1");
