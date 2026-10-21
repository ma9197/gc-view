// Public HTTPS address for the bridge API, so the glasses can reach the laptop from anywhere.
// Cloudflare Quick Tunnel: free, no account, but the address changes on every start, so each new address is
// written to a secret GitHub gist (endpoint.json) that the glasses read. Uses the gh CLI's existing login.
// ponytail: quick tunnels have no uptime promise; a Tailscale Funnel or named tunnel is the upgrade path.
import { spawn, execFile } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";

export function startTunnel({ port, local, config, saveConfig, log }) {
  const exe = join(local, "bin", "cloudflared.exe");
  if (!existsSync(exe)) { log("tunnel: cloudflared.exe missing"); return; }
  let url = null, child = null;
  // a cloudflared left over from a crashed bridge would keep an old address alive: stop it (ours only, by pid)
  const pidFile = join(local, "cloudflared.pid");
  try {
    const old = readFileSync(pidFile, "utf8").trim(); // both filters must match, so a reused pid is never killed
    if (/^\d+$/.test(old)) execFile("taskkill", ["/F", "/FI", `PID eq ${old}`, "/FI", "IMAGENAME eq cloudflared.exe"], { windowsHide: true }, () => {});
  } catch {}
  process.on("exit", () => { try { child && child.kill(); } catch {} });
  const run = () => {
    const p = child = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { windowsHide: true });
    writeFileSync(pidFile, String(p.pid));
    const scan = (c) => {
      const m = String(c).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== url) { url = m[0]; log("tunnel up", url); publish(url); }
    };
    p.stdout.on("data", scan);
    p.stderr.on("data", scan);
    p.on("exit", (code) => { log("tunnel exited", code); url = null; setTimeout(run, 5000); });
  };

  function gh(args) {
    return new Promise((ok, bad) => execFile("gh", args, { windowsHide: true }, (e, out, err) => (e ? bad(new Error(err || e.message)) : ok(out))));
  }
  async function publish(u) {
    const body = JSON.stringify({ url: u, at: new Date().toISOString() });
    const tmp = join(local, "endpoint.json");
    writeFileSync(tmp, body);
    for (let i = 0; i < 5; i++) {
      try {
        if (!config.gistId) {
          const out = await gh(["gist", "create", tmp, "--desc", "GlassCode endpoint"]); // secret gist by default
          config.gistId = out.trim().split("/").pop();
          saveConfig();
        } else {
          await gh(["api", "-X", "PATCH", `gists/${config.gistId}`, "-f", `files[endpoint.json][content]=${body}`]);
        }
        log("endpoint published to gist", config.gistId);
        return;
      } catch (e) { log("publish failed", e.message); await new Promise((r) => setTimeout(r, 5000 * (i + 1))); }
    }
  }
  run();
  return { get url() { return url; } };
}
