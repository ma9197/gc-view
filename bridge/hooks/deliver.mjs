// FileChanged hook with asyncRewake: when the glasses ring this chat's doorbell, take the queued messages from
// the bridge and wake Claude with them (exit 2 + stderr is shown to Claude, even when the chat is idle).
// Exit 2 ONLY to deliver. Every other path exits 0, because asyncRewake wakes Claude on any non-zero exit
// (anthropics/claude-code#96148) and a broken hook must never wake a chat.
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { doorbell, HERE } from "../inbox.mjs";

const quiet = () => process.exit(0);
process.on("uncaughtException", quiet);
process.on("unhandledRejection", quiet);
setTimeout(quiet, 20000).unref(); // the hook timeout is 30 s

try {
  const d = JSON.parse(readFileSync(0, "utf8"));
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
  if (!d.session_id || !d.file_path || !same(d.file_path, doorbell(d.session_id))) quiet();
  const { hookPort } = JSON.parse(readFileSync(join(HERE, ".local", "config.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${hookPort}/hook/take`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: d.session_id }), signal: AbortSignal.timeout(8000),
  });
  const { messages = [] } = await r.json();
  const texts = messages.map((m) => String(m.text || "").trim()).filter(Boolean);
  if (!texts.length) quiet();
  process.stderr.write(
    "Message from the user, typed or dictated in GlassCode (their own glasses remote, relayed by a hook they installed). " +
    "If something needs their approval, ask with AskUserQuestion: they can answer from the glasses.\n\n" +
    texts.join("\n\n---\n\n") + "\n",
    () => process.exit(2),
  );
} catch { quiet(); }
