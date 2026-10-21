// Reads a Claude Code transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) into chat items for the glasses.
// The jsonl format is internal to Claude Code (not documented), so parsing is defensive: unknown records are skipped.
import { openSync, readSync, fstatSync, closeSync, readFileSync } from "node:fs";

const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
const MAX_TEXT = 20000; // per item, the glasses never need more
const mimeOf = (p) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" })[String(p).split(".").pop().toLowerCase()] || "application/octet-stream";

// Short one-line summary of a tool call, like the mobile app shows.
export function toolSummary(name, input = {}) {
  const base = (p) => String(p || "").split(/[\\/]/).pop();
  const first = (s, n = 90) => { s = String(s || "").split("\n")[0]; return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  switch (name) {
    case "Bash": case "PowerShell": return first(input.description || input.command);
    case "Read": case "Write": case "Edit": case "NotebookEdit": return base(input.file_path || input.notebook_path);
    case "Grep": case "Glob": return first(input.pattern);
    case "WebFetch": return first(input.url);
    case "WebSearch": return first(input.query);
    case "Agent": case "Task": return first(input.description || input.prompt);
    case "Skill": return first(input.skill);
    case "TodoWrite": return "Updated the task list";
    case "SendUserFile": return (input.files || []).map(base).join(", ");
    default: return first(input.description || input.action_summary || input.query || input.url || "");
  }
}

// Strips wrapper tags Claude Code puts around some user turns.
function cleanUserText(s) {
  return String(s)
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted text]")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-name>([^<]*)<\/command-name>[\s\S]*/, "$1")
    .replace(/^<scheduled-task name="([^"]*)"[\s\S]*/, "Scheduled task: $1")
    .trim();
}

// A message the glasses sent arrives as a hook wake-up (see hooks/deliver.mjs): pull the user's text back out.
function glassesText(prompt) {
  const i = prompt.search(/Message from the user, typed or dictated in GlassCode|The user sent this from GlassCode/);
  if (i < 0) return null;
  const body = prompt.slice(i), start = body.indexOf("\n\n");
  if (start < 0) return null;
  return body.slice(start + 2).replace(/<\/system-reminder>[\s\S]*$/, "").trim();
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
}

const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n…" : s);

/**
 * Incremental parser: call feed() with new jsonl lines, read items/images/pending.
 * items: [{ key, role: user|assistant|tool|question|note, time, text?, tool?, summary?, status?, images?, question? }]
 */
export class Transcript {
  constructor() {
    this.items = [];
    this.byKey = new Map();      // key -> item
    this.toolItems = new Map();  // tool_use id -> item
    this.images = new Map();     // image id -> { off, len, path } (where it sits in the jsonl) or { file } (image on disk)
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.title = null;
    this.lastActivity = 0;
    this.version = 0;            // bumps on every change, lets clients diff cheaply
  }

  push(item) { this.items.push(item); this.byKey.set(item.key, item); this.version++; return item; }

  addImage(id, img) { this.images.set(id, img); return id; }

  feedLine(line, off = 0, len = 0) {
    const at = { off, len }; // byte range of this record: images are re-read from disk on demand
    let d;
    try { d = JSON.parse(line); } catch { return; }
    if (!d || d.isSidechain) return; // subagent internals are not shown on mobile either
    if (d.type === "custom-title" && d.customTitle) { this.title = d.customTitle; return; }
    if (d.type === "agent-name" && d.agentName && !this.title) { this.title = d.agentName; return; }
    const time = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (time) this.lastActivity = Math.max(this.lastActivity, time);

    if (d.type === "system" && d.subtype === "compact_boundary") {
      this.push({ key: d.uuid, role: "note", time, text: "Conversation compacted" });
      return;
    }
    if (d.type === "attachment" && d.attachment) {
      const a = d.attachment;
      // async hook wake-ups (glasses messages arrive this way) and queued prompts
      if (a.type === "queued_command" && typeof a.prompt === "string") {
        const g = glassesText(a.prompt);
        if (g) this.push({ key: d.uuid, role: "user", via: "glasses", time, text: clip(g) });
        else if (!a.prompt.startsWith("<task-notification>")) this.push({ key: d.uuid, role: "user", time, text: clip(cleanUserText(a.prompt)) });
      }
      return;
    }
    const m = d.message;
    if (!m) return;

    if (d.type === "user") {
      if (d.isMeta || d.isCompactSummary) return;
      if (typeof m.content === "string") {
        const t = cleanUserText(m.content);
        if (t && !t.startsWith("<local-command") && !t.startsWith("<task-notification>")) this.push({ key: d.uuid, role: "user", time, text: clip(t) });
        return;
      }
      if (!Array.isArray(m.content)) return;
      const userImages = [];
      let userText = "";
      m.content.forEach((b, i) => {
        if (!b) return;
        if (b.type === "text") userText += (userText ? "\n" : "") + b.text;
        else if (b.type === "image" && b.source && b.source.data) userImages.push(this.addImage(`${d.uuid}.${i}`, { ...at, path: ["message", "content", i, "source"] }));
        else if (b.type === "tool_result") this.toolResult(b, d, { ...at, i });
      });
      userText = cleanUserText(userText);
      if ((userText && !userText.startsWith("<task-notification>")) || userImages.length) {
        this.push({ key: d.uuid, role: "user", time, text: clip(userText), images: userImages });
      }
      return;
    }

    if (d.type === "assistant" && Array.isArray(m.content)) {
      m.content.forEach((b, i) => {
        if (!b) return;
        if (b.type === "text" && b.text && b.text.trim()) {
          // one API message is written as several records; merge its text blocks
          const key = `${m.id || d.uuid}.text`;
          const prev = this.byKey.get(key);
          if (prev && this.items[this.items.length - 1] === prev) { prev.text = clip(prev.text + "\n\n" + b.text); this.version++; }
          else this.byKey.set(key, this.push({ key: `${key}.${i}`, role: "assistant", time, text: clip(b.text) }));
        } else if (b.type === "tool_use") {
          const item = b.name === "AskUserQuestion"
            ? { key: b.id, role: "question", time, tool: b.name, question: (b.input && b.input.questions) || [], status: "pending" }
            : { key: b.id, role: "tool", time, tool: String(b.name).split("__").pop(), summary: toolSummary(b.name, b.input), status: "running", images: [] };
          if (b.name === "SendUserFile" && b.input && Array.isArray(b.input.files)) {
            b.input.files.filter((p) => IMG_EXT.test(p)).forEach((p, n) => item.images.push(this.addImage(`${b.id}.f${n}`, { file: p })));
          }
          this.toolItems.set(b.id, this.push(item));
        }
      });
    }
  }

  toolResult(b, d, at) {
    const item = this.toolItems.get(b.tool_use_id);
    if (!item) return;
    item.status = b.is_error ? "error" : "done";
    if (item.role === "question") {
      item.status = b.is_error ? "dismissed" : "answered";
      item.answer = clip(textOf(b.content));
    }
    if (Array.isArray(b.content)) {
      b.content.forEach((c, i) => {
        if (c && c.type === "image" && c.source && c.source.data) item.images.push(this.addImage(`${d.uuid}.${b.tool_use_id}.${i}`, { off: at.off, len: at.len, path: ["message", "content", at.i, "content", i, "source"] }));
      });
    }
    if (b.is_error && item.role === "tool") item.error = clip(textOf(b.content)).slice(0, 300);
    this.version++;
  }

  // Reads whatever was appended to the file since last time.
  readFrom(file) {
    let fd;
    try { fd = openSync(file, "r"); } catch { return false; }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) { Object.assign(this, new Transcript()); } // file was rewritten: start over
      if (size === this.offset) return false;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      // split on raw bytes so each record's byte range is known; a half-written last line waits for next time
      const all = this.partial.length ? Buffer.concat([this.partial, buf]) : buf;
      const base = this.offset - this.partial.length;
      let start = 0;
      for (let nl = all.indexOf(10); nl !== -1; nl = all.indexOf(10, start)) {
        if (nl > start) this.feedLine(all.toString("utf8", start, nl), base + start, nl - start);
        start = nl + 1;
      }
      this.partial = all.subarray(start);
      this.offset = size;
      return true;
    } finally { closeSync(fd); }
  }

  // Image bytes for an id from items[].images, read back from the transcript (or the file Claude sent).
  image(file, id) {
    const ref = this.images.get(id);
    if (!ref) return null;
    if (ref.file) {
      try { return { type: mimeOf(ref.file), data: readFileSync(ref.file) }; } catch { return null; }
    }
    let fd;
    try {
      fd = openSync(file, "r");
      const buf = Buffer.alloc(ref.len);
      readSync(fd, buf, 0, ref.len, ref.off);
      let v = JSON.parse(buf.toString("utf8"));
      for (const k of ref.path) v = v && v[k];
      return v && v.data ? { type: v.media_type || "image/png", data: Buffer.from(v.data, "base64") } : null;
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }

  // The open question / tool call Claude is waiting on, if any.
  pending() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.role === "user" || it.role === "assistant") return null;
      if ((it.role === "question" && it.status === "pending") || (it.role === "tool" && it.status === "running")) return it;
    }
    return null;
  }
}
