// Self-check for the parts that are easy to break: transcript parsing and the relay's queue/answer flow.
// Run: node check.mjs   (no network, touches nothing outside a temp file)
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript.mjs";
import { Relay } from "./relay.mjs";

const L = (o) => JSON.stringify(o) + "\n";
const file = join(tmpdir(), "glasscode-check.jsonl");
writeFileSync(file,
  L({ type: "custom-title", customTitle: "Check chat" }) +
  L({ type: "user", uuid: "u1", timestamp: "2026-10-20T10:00:00Z", message: { role: "user", content: "hello <system-reminder>x</system-reminder>" } }) +
  L({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "part one" }] } }) +
  L({ type: "assistant", uuid: "a2", message: { id: "m1", content: [{ type: "text", text: "part two" }] } }) +
  L({ type: "assistant", uuid: "a3", message: { id: "m2", content: [{ type: "tool_use", id: "t1", name: "mcp__Claude_Browser__computer", input: { action: "screenshot" } }] } }) +
  L({ type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGDATA").toString("base64") } }] }] } }) +
  L({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command \"FileChanged\": Message from the user, typed or dictated in GlassCode (their own glasses remote, relayed by a hook they installed). If something needs their approval, ask.\n\nrun the tests\n\n</system-reminder>" } }) +
  L({ type: "assistant", uuid: "a5", message: { id: "m4", content: [{ type: "tool_use", id: "t3", name: "TaskCreate", input: { subject: "Write tests", activeForm: "Writing tests" } }] } }) +
  L({ type: "user", uuid: "u3", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "Task #7 created successfully" }] } }) +
  L({ type: "assistant", uuid: "a6", message: { id: "m5", content: [{ type: "tool_use", id: "t4", name: "TaskUpdate", input: { taskId: "7", status: "in_progress" } }] } }) +
  L({ type: "assistant", uuid: "a7", message: { id: "m6", content: [{ type: "tool_use", id: "t5", name: "Edit", input: { file_path: "D:/x/app.js" } }] } }) +
  L({ type: "user", uuid: "u4", toolUseResult: { structuredPatch: [{ lines: [" a", "-b", "+c", "+d"] }] }, message: { content: [{ type: "tool_result", tool_use_id: "t5", content: "ok" }] } }) +
  L({ type: "assistant", uuid: "a4", message: { id: "m3", content: [{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [{ question: "Color?", options: [{ label: "Red" }, { label: "Blue" }] }] } }] } }),
);

const t = new Transcript();
t.readFrom(file);
assert.equal(t.title, "Check chat");
assert.deepEqual(t.items.map((i) => i.role), ["user", "assistant", "tool", "user", "tool", "tool", "tool", "question"]);
assert.ok(t.items[4].quiet && t.items[5].quiet, "task tools are hidden behind the checklist");
assert.deepEqual(t.progress(), { done: 0, total: 1, active: "Writing tests" }, "task id comes from the TaskCreate result");
assert.equal(t.items[6].result, "Updated app.js with 2 additions and 1 removal", "CLI-style edit summary");
assert.deepEqual(t.items[6].diff, [" a", "-b", "+c", "+d"]);
assert.equal(t.items[6].input, undefined, "tool input is dropped once the result is in");
assert.equal(t.items[0].text, "hello");
assert.equal(t.items[1].text, "part one\n\npart two", "text blocks of one API message merge");
assert.equal(t.items[2].tool, "computer", "MCP tool names are shortened");
assert.equal(t.items[3].via, "glasses");
assert.equal(t.items[3].text, "run the tests");
const img = t.image(file, t.items[2].images[0]);
assert.equal(img.type, "image/png");
assert.equal(img.data.toString(), "PNGDATA", "image is read back from its byte range");
assert.equal(t.pending().role, "question");
assert.equal(t.readFrom(file), false, "nothing new to read");
unlinkSync(file);

// relay: queue -> take, and question hold -> answer
const sessions = { get: () => ({ id: "s1", name: "S", state: "idle" }) };
const relay = new Relay(sessions);
relay.forced = false; // independent of the saved Away state
const replies = [];
const send = (res, code, body) => replies.push({ code, body });
relay.queues.set("s1", [{ id: "m", text: "hi" }]);
relay.hook("take", { session_id: "s1" }, {}, send);
assert.deepEqual(replies.pop().body.messages.map((m) => m.text), ["hi"]);
relay.hook("ask", { session_id: "s1", tool_use_id: "t2", tool_input: { questions: [{ question: "Color?" }] } }, { on() {} }, send);
assert.equal(replies.pop().body, "", "Away off: the laptop dialog shows");
relay.forced = true;
relay.hook("ask", { session_id: "s1", tool_use_id: "t2", tool_input: { questions: [{ question: "Color?" }] } }, { on() {} }, send);
assert.equal(replies.length, 0, "Away on: held for the glasses");
assert.equal(relay.heldFor("s1").kind, "question");
relay.answer({ id: "s1" }, { key: "t2", answers: { "Color?": "Blue" } });
const out = replies.pop().body.hookSpecificOutput;
assert.equal(out.permissionDecision, "allow");
assert.deepEqual(out.updatedInput.answers, { "Color?": "Blue" });
assert.equal(relay.heldFor("s1"), null);
console.log("check ok");
process.exit(0);
