// Finds the Claude Code sessions on this laptop and their live status.
// Live sessions: ~/.claude/sessions/<pid>.json (written by every running Claude Code process, incl. Desktop).
// That registry is internal to Claude Code (not documented), so every field is read defensively.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Transcript } from "./transcript.mjs";

const CLAUDE = join(homedir(), ".claude");
const REGISTRY = join(CLAUDE, "sessions");
const PROJECTS = join(CLAUDE, "projects");
const OFFLINE_DAYS = 7;

export const slugOf = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function transcriptPath(cwd, sessionId) {
  const p = join(PROJECTS, slugOf(cwd), sessionId + ".jsonl");
  if (existsSync(p)) return p;
  for (const dir of readdirSync(PROJECTS)) { // slug rule changed or cwd moved: search
    const q = join(PROJECTS, dir, sessionId + ".jsonl");
    if (existsSync(q)) return q;
  }
  return null;
}

export class Sessions {
  constructor() {
    this.transcripts = new Map(); // sessionId -> Transcript (loaded lazily)
    this.offline = new Map();     // sessionId -> { file, mtime, remote } from recent transcripts
    this.lastScan = 0;
  }

  // Parsed transcript for a list() entry, read incrementally (only new lines).
  transcriptFor(s) {
    if (!s || !s.file) return null;
    let t = this.transcripts.get(s.id);
    if (!t) { t = new Transcript(); this.transcripts.set(s.id, t); }
    t.readFrom(s.file);
    return t;
  }

  // Remote-Control-enabled chats that are not running now (closed in Desktop), from recent transcripts.
  scanOffline() {
    if (Date.now() - this.lastScan < 60000) return;
    this.lastScan = Date.now();
    const since = Date.now() - OFFLINE_DAYS * 864e5;
    for (const dir of readdirSync(PROJECTS)) {
      let files;
      try { files = readdirSync(join(PROJECTS, dir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const file = join(PROJECTS, dir, f);
        let st;
        try { st = statSync(file); } catch { continue; }
        if (st.mtimeMs < since) continue;
        const id = f.slice(0, -6), known = this.offline.get(id);
        if (known && known.mtime === st.mtimeMs) continue;
        let remote = false;
        try { remote = readFileSync(file, "utf8").includes('"type":"bridge-session"'); } catch {}
        this.offline.set(id, { file, mtime: st.mtimeMs, remote });
      }
    }
  }

  live() {
    const out = [];
    let names;
    try { names = readdirSync(REGISTRY).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
    for (const f of names) {
      try {
        const r = JSON.parse(readFileSync(join(REGISTRY, f), "utf8"));
        if (!r.sessionId || !alive(r.pid)) continue;
        out.push(r);
      } catch {}
    }
    return out;
  }

  list() {
    this.scanOffline();
    const seen = new Set(), out = [];
    for (const r of this.live()) {
      seen.add(r.sessionId);
      const file = transcriptPath(r.cwd, r.sessionId);
      out.push({
        id: r.sessionId, name: r.name || null, cwd: r.cwd, pid: r.pid, file,
        remote: !!r.bridgeSessionId, desktop: r.entrypoint === "claude-desktop",
        state: r.status === "busy" ? "running" : r.status === "waiting" ? "waiting" : "idle",
        waitingFor: r.waitingFor || null, since: r.statusUpdatedAt || r.updatedAt || r.startedAt,
      });
    }
    for (const [id, o] of this.offline) {
      if (seen.has(id) || !o.remote) continue;
      out.push({ id, name: null, cwd: null, pid: null, file: o.file, remote: true, desktop: true, state: "offline", waitingFor: null, since: o.mtime });
    }
    // fill names, folders and the question detail from the transcript (cheap: incremental reads)
    for (const s of out) {
      const t = this.transcriptFor(s);
      if (t) {
        s.name = s.name || t.title;
        const p = s.state === "waiting" ? t.pending() : null;
        if (p) s.waitingFor = p.role === "question" ? "question" : "permission";
        s.last = lastLine(t);
      }
      if (!s.name) s.name = s.cwd ? s.cwd.split(/[\\/]/).pop() : s.id.slice(0, 8);
    }
    const rank = { waiting: 0, running: 1, idle: 2, offline: 3 };
    this.index = out.sort((a, b) => rank[a.state] - rank[b.state] || b.since - a.since);
    this.indexAt = Date.now();
    return this.index;
  }

  get(id) {
    const list = this.index && Date.now() - this.indexAt < 1500 ? this.index : this.list();
    return list.find((s) => s.id === id) || null;
  }
}

function lastLine(t) {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i];
    if (it.role === "assistant" || it.role === "user") return { role: it.role, text: it.text.replace(/[*#`>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 140) };
  }
  return null;
}
