// Relay between the glasses and Claude Code hooks (all documented hook features):
// - Messages: the glasses' text is queued here, then a per-chat "doorbell" file is touched. That chat watches the
//   file (SessionStart watchPaths), so a FileChanged hook (asyncRewake) runs deliver.mjs, which takes the queue
//   from /hook/take and wakes Claude with it, even when the chat is idle.
// - Questions (AskUserQuestion via PreToolUse) and permission prompts (PermissionRequest) arrive as HTTP hooks.
//   While Away mode is on they are held here until you answer on the glasses; otherwise the hook returns at
//   once and the normal laptop dialog shows. Turning Away off hands anything held back to the laptop.
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX, doorbell, HERE } from "./inbox.mjs";

const STATE = join(HERE, ".local", "state.json"); // Away mode survives bridge restarts

mkdirSync(INBOX, { recursive: true });

// Shared with hooks/deliver.mjs (glasses messages): what Claude is told so replies fit the small glasses screen.
export const BRIEF = "The user is away from the laptop and reads your replies on small smart glasses (a few lines at a time). " +
  "End your turn with a short final message: 2 to 4 short bullets with the key results and anything you need from them. " +
  "No long explanations, tables or code blocks unless they ask.";
const HOLD_MS = 55 * 60e3;       // hooks are configured with a 3600 s timeout; always answer before that

export class Relay {
  constructor(sessions) {
    this.sessions = sessions;
    this.queues = new Map();     // sessionId -> [{ id, text, at }]
    this.sent = new Map();       // sessionId -> last messages sent from the glasses, shown in the chat
    this.held = new Map();       // sessionId -> { kind: question|permission, key, payload, reply(json), at }
    this.forced = false;         // Away mode: switched on and off from the glasses only (user's choice)
    try { this.forced = !!JSON.parse(readFileSync(STATE, "utf8")).away; } catch {}
    this.onEvent = () => {};
  }

  get away() { return this.forced; }
  set away(on) {
    this.forced = !!on;
    try { writeFileSync(STATE, JSON.stringify({ away: this.forced })); } catch {}
    if (!on) this.releaseAll();
    this.onEvent({ type: "away", away: this.forced });
  }

  sentFor(id) { return (this.sent.get(id) || []).map(({ id, text, at, deliveredAt }) => ({ id, text, at, delivered: !!deliveredAt })); }

  reachable(s) { return !!s && s.state !== "offline" && existsSync(doorbell(s.id)); }
  canSend(s) { return this.reachable(s); }

  heldFor(id) {
    const h = this.held.get(id);
    if (!h) return null;
    const p = h.payload, out = { kind: h.kind, key: h.key, at: h.at };
    if (h.kind === "question") return { ...out, questions: (p.tool_input || {}).questions || [] };
    const sug = Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [];
    return { ...out, tool: String(p.tool_name || "").split("__").pop(), input: summarize(p.tool_input), description: (p.tool_input || {}).description || null, canAlways: sug.length > 0 };
  }

  // ---------- glasses -> laptop ----------
  async send(s, { text, stop }) {
    text = String(text || "").trim();
    if (!text) return { error: "empty" };
    if (!this.reachable(s)) return { error: "This chat can't receive messages yet. Restart it once after setup." };
    const q = this.queues.get(s.id) || [];
    const msg = { id: Math.random().toString(36).slice(2), text: text.slice(0, 20000), at: Date.now(), stop: !!stop };
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

  // Like the CLI dialog: 1 Yes, 2 Yes and don't ask again (Claude Code's own suggested rule), 3 No (+ what to do instead).
  permission(s, { allow, always, message, key }) {
    const h = this.held.get(s.id);
    if (!h || h.kind !== "permission" || (key && h.key !== key)) return { error: "That request is no longer waiting." };
    const sug = Array.isArray(h.payload.permission_suggestions) ? h.payload.permission_suggestions : [];
    const decision = allow
      ? { behavior: "allow", ...(always && sug.length ? { updatedPermissions: sug } : {}) }
      : { behavior: "deny", message: message ? "The user said (from their glasses): " + String(message).slice(0, 4000) : "The user denied this from their glasses." };
    this.finish(s.id, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    return { ok: true };
  }

  // Like pressing Esc: there is no documented interrupt from outside, so ask Claude (between tool calls) to stop.
  stop(s) {
    if (this.held.get(s.id)) this.finish(s.id, null); // hand any held prompt back to the laptop
    return this.send(s, { text: "STOP. I pressed Stop on my glasses. Finish no more steps and start no new tool calls. Reply in one short line with where you stopped, then wait for me.", stop: true });
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
    if (name === "prompt") { // UserPromptSubmit from the laptop or phone: while Away, Claude writes for the glasses
      return send(res, 200, this.away ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: BRIEF } } : "");
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
