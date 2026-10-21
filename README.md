# GlassCode

See and drive the Claude Code chats on your laptop from Meta Ray-Ban Display glasses.

- `docs/`: the glasses web app (GitHub Pages). 600x600, arrows + Enter + Back.
- `bridge/`: a small Node server on the laptop. It reads chat status and transcripts, and talks to Claude Code
  only through documented hooks:
  - **Messages:** each chat watches a "doorbell" file (SessionStart/CwdChanged `watchPaths`). A FileChanged hook
    with `asyncRewake` (`hooks/deliver.mjs`) wakes the chat with your text.
  - **Questions:** an HTTP `PreToolUse` hook on `AskUserQuestion` returns your answers.
  - **Permissions:** an HTTP `PermissionRequest` hook. Both are held for the glasses only while Away mode is on.
- `bridge/tunnel.mjs`: Cloudflare Quick Tunnel. Each new address goes to a secret gist that the app reads.

Security: every API call needs the device token (in the pairing link, never in this repo). Images use
short-lived signed links. The hook port is local only. Secrets live in `bridge/.local/` (git-ignored).

Run: `node bridge/server.mjs` (add `--no-tunnel` for local tests). Check: `node bridge/check.mjs`.
Hooks config: `bridge/hooks/hooks.json` (merged into `~/.claude/settings.json`).
