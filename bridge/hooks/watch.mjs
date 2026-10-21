// SessionStart / CwdChanged hook: this chat watches its GlassCode doorbell file, so the glasses can wake it
// (see deliver.mjs). Never fails a session: any problem just means no doorbell for this chat.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { INBOX, doorbell } from "../inbox.mjs";

let out = "";
try {
  const d = JSON.parse(readFileSync(0, "utf8"));
  if (d.session_id) {
    mkdirSync(INBOX, { recursive: true });
    const bell = doorbell(d.session_id);
    if (!existsSync(bell)) writeFileSync(bell, "");
    const watchPaths = [bell];
    // the docs show watchPaths both as a top-level output and inside hookSpecificOutput; give both
    out = JSON.stringify({ watchPaths, hookSpecificOutput: { hookEventName: d.hook_event_name || "SessionStart", watchPaths } });
  }
} catch {}
process.stdout.write(out);
process.exitCode = 0;
