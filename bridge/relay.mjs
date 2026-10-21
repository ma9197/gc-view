// Relay between the glasses and Claude Code hooks (all documented hook features):
// - Messages: the glasses' text is queued here, then a per-chat "doorbell" file is touched. That chat watches the
//   file (SessionStart watchPaths), so a FileChanged hook (asyncRewake) runs deliver.mjs, which takes the queue
//   from /hook/take and wakes Claude with it, even when the chat is idle.
// - Questions (AskUserQuestion via PreToolUse) and permission prompts (PermissionRequest) arrive as HTTP hooks.
//   While Away mode is on they are held here until you answer on the glasses; otherwise the hook returns at
//   once and the normal laptop dialog shows. Turning Away off hands anything held back to the laptop.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { INBOX, doorbell } from "./inbox.mjs";

mkdirSync(INBOX, { recursive: true });

const HOLD_MS = 55 * 60e3;       // hooks are configured with a 3600 s timeout; always answer before that

export class Relay {
  constructor(sessions) {
    this.sessions = sessions;
    this.queues = new Map();     // sessionId -> [{ id, text, at }]
    this.sent = new Map();       // sessionId -> last messages sent from the glasses, shown in the chat
    this.held = new Map();       // sessionId -> { kind: question|permission, key, payload, reply(json), at }
    this.forced = false;         // Away mode: switched on and off from the glasses only (user's choice)
    this.onEvent = () => {};
  }

  get away() { return this.forced; }
  set away(on) { this.forced = !!on; if (!on) this.releaseAll(); this.onEvent({ type: "away", away: this.forced }); }

  sentFor(id) { return (this.sent.get(id) || []).map(({ id, text, at, deliveredAt }) => ({ id, text, at, delivered: !!deliveredAt })); }

  reachable(s) { return !!s && s.state !== "offline" && existsSync(doorbell(s.id)); }
  canSend(s) { return this.reachable(s); }

  heldFor(id) {
    const h = this.held.get(id);
    return h ? { kind: h.kind, key: h.key, at: h.at, ...(h.kind === "question" ? { questions: (h.payload.tool_input || {}).questions || [] } : { tool: h.payload.tool_name, input: summarize(h.payload.tool_input) }) } : null;
  }

  // ---------- glasses -> laptop ----------
  async send(s, { text }) {
    text = String(text || "").trim();
    if (!text) return { error: "empty" };
    if (!this.reachable(s)) return { error: "This chat can't receive messages yet. Restart it once after setup." };
    const q = this.queues.get(s.id) || [];
    const msg = { id: Math.random().toString(36).slice(2), text: text.slice(0, 20000), at: Date.now() };
    q.push(msg); this.queues.set(s.id, q);
    const sent = (this.sent.get(s.id) || []).concat(msg).slice(-50);
    this.sent.set(s.id, sent);
    writeFileSync(doorbell(s.id), String(Date.now())); // ring
    // wait briefly for deliver.mjs to pick it up, so the glasses can say "sent" vs "waiting"
    for (let i = 0; i < 40 && this.queues.get(s.id)?.includes(msg); i++) await new Promise((r) => setTimeout(r, 250));
    return { id: msg.id, delivered: !this.queues.get(s.id)?.includes(msg) };
  }

  answer(s, { key, answers }) {
    const h = this.held.get(s.id);
    if (!h || h.kind !== "question" || (key && h.key !== key)) return { error: "That question is no longer waiting." };
    const questions = (h.payload.tool_input || {}).questions || [];
    const clean = {};
    for (const q of questions) if (answers && answers[q.question] != null) clean[q.question] = String(answers[q.question]).slice(0, 4000);
    this.finish(s.id, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions, answers: clean } } });
    return { ok: true };
  }

  permission(s, { allow, key }) {
    const h = this.held.get(s.id);
    if (!h || h.kind !== "permission" || (key && h.key !== key)) return { error: "That request is no longer waiting." };
    this.finish(s.id, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: allow ? { behavior: "allow" } : { behavior: "deny", message: "The user denied this from their glasses." } } });
    return { ok: true };
  }

  finish(id, json) {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    clearTimeout(h.timer);
    h.reply(json);
    this.onEvent({ type: "held", id, held: null });
  }

  releaseAll() { for (const id of [...this.held.keys()]) this.finish(id, null); }

  // ---------- hooks -> relay (local only) ----------
  hook(name, data, res, send) {
    const sid = String(data.session_id || "");
    if (name === "take") { // deliver.mjs collects the queue for its own chat
      const q = this.queues.get(sid) || [];
      this.queues.delete(sid);
      for (const m of q) m.deliveredAt = Date.now();
      if (q.length) this.onEvent({ type: "delivered", id: sid, ids: q.map((m) => m.id) });
      return send(res, 200, { messages: q });
    }
    if (name === "ask" || name === "permission") {
      const empty = () => send(res, 200, "");
      if (!sid || !this.away) return empty(); // at the laptop: normal dialog
      const prev = this.held.get(sid);
      if (prev) this.finish(sid, null);
      const kind = name === "ask" ? "question" : "permission";
      const h = { kind, key: data.tool_use_id || String(Date.now()), payload: data, at: Date.now(),
        reply: (json) => (json ? send(res, 200, json) : empty()) };
      h.timer = setTimeout(() => this.finish(sid, null), HOLD_MS);
      res.on("close", () => { if (this.held.get(sid) === h) { this.held.delete(sid); clearTimeout(h.timer); this.onEvent({ type: "held", id: sid, held: null }); } });
      this.held.set(sid, h);
      const s = this.sessions.get(sid);
      this.onEvent({ type: "held", id: sid, name: s?.name, held: this.heldFor(sid) });
      return;
    }
    send(res, 404, { error: "unknown hook" });
  }
}

function summarize(input = {}) {
  const v = input.command || input.file_path || input.url || input.pattern || input.description || JSON.stringify(input);
  return String(v).slice(0, 400);
}
