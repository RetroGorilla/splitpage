/* Start Splitpage with the machine.
 *
 * One job: register (or unregister) "run start.mjs --background at login", in
 * whatever way the platform expects. Nothing here starts a server itself —
 * start.mjs does that, and this only arranges for the OS to call it.
 *
 *   Windows   HKCU\...\CurrentVersion\Run -> wscript.exe autostart.vbs
 *             (wscript, not node, because a Run entry pointing straight at
 *             node.exe flashes a console window at every sign-in)
 *   macOS     ~/Library/LaunchAgents/com.splitpage.app.plist, RunAtLoad
 *   Linux     ~/.config/autostart/splitpage.desktop  (XDG, honoured by every
 *             mainstream desktop; a headless box has no login to hook, so
 *             there it reports unsupported rather than pretending)
 *
 * Always per-user, never machine-wide: this needs no administrator, it starts
 * when the person who installed it signs in, and an uninstall can always undo
 * it. A per-machine service would need elevation and would run for people who
 * never asked for it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

const APP = "Splitpage";
const LABEL = "com.splitpage.app";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/* The command the OS should run at login. `--background` means: no browser, no
   banner, and quietly do nothing if an instance is already listening. */
function launchCommand(root, node) {
  if (platform === "win32") {
    const vbs = join(root, "autostart.vbs");
    /* A packaged copy ships autostart.vbs, which starts start.bat with no
       window at all. A git checkout has no such file; fall back to node
       directly and accept the console window rather than register nothing. */
    if (existsSync(vbs)) return { file: "wscript.exe", args: [vbs] };
    return { file: node, args: [join(root, "start.mjs"), "--background"] };
  }
  return { file: node, args: [join(root, "start.mjs"), "--background"] };
}

/* Windows Run values are a single command line, so the pieces are quoted here
   rather than handed to a process as an argv array. */
const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const commandLine = ({ file, args }) => [file, ...args].map(quote).join(" ");

function plistPath() {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function desktopPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "autostart", "splitpage.desktop");
}

/* Where this platform records autostart, and whether we can do it at all.
   The path is part of the answer on purpose: every message this feature
   prints says where to look, so nobody has to guess what was touched. */
export function location() {
  if (platform === "win32") return { supported: true, where: `${RUN_KEY}\\${APP}` };
  if (platform === "darwin") return { supported: true, where: plistPath() };
  if (platform === "linux") return { supported: true, where: desktopPath() };
  return { supported: false, where: null };
}

/* What is registered right now, if anything: { enabled, command, where }.
   `command` is the raw registered command, so callers can tell an entry that
   points at THIS copy from one left by a different install. */
export function status() {
  const { supported, where } = location();
  if (!supported) return { supported, enabled: false, command: null, where };

  if (platform === "win32") {
    const res = spawnSync("reg.exe", ["query", RUN_KEY, "/v", APP], { encoding: "utf8" });
    if (res.status !== 0) return { supported, enabled: false, command: null, where };
    /* reg prints "    Splitpage    REG_SZ    <command>" */
    const line = String(res.stdout || "").split(/\r?\n/).find((l) => /\bREG_SZ\b/.test(l));
    const command = line ? line.split(/\bREG_SZ\b/)[1].trim() : null;
    return { supported, enabled: !!command, command, where };
  }

  if (!existsSync(where)) return { supported, enabled: false, command: null, where };
  let command = null;
  try {
    const text = readFileSync(where, "utf8");
    command = platform === "darwin"
      ? (text.match(/<string>([^<]*start\.mjs)<\/string>/) || [])[1] || text
      : (text.match(/^Exec=(.*)$/m) || [])[1] || text;
  } catch { /* unreadable is as good as absent */ }
  return { supported, enabled: true, command, where };
}

export function enable({ root, node = process.execPath }) {
  const { supported, where } = location();
  if (!supported) return { ok: false, where, error: `autostart is not supported on ${platform}` };
  const cmd = launchCommand(root, node);

  if (platform === "win32") {
    const res = spawnSync("reg.exe",
      ["add", RUN_KEY, "/v", APP, "/t", "REG_SZ", "/d", commandLine(cmd), "/f"],
      { encoding: "utf8" });
    return res.status === 0
      ? { ok: true, where }
      : { ok: false, where, error: (res.stderr || res.error?.message || "reg.exe failed").trim() };
  }

  if (platform === "darwin") {
    const file = plistPath();
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[cmd.file, ...cmd.args].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`);
    /* Load it now so this login gets it too, not just the next one. A failure
       here is not fatal: RunAtLoad still fires at the next sign-in. */
    spawnSync("launchctl", ["unload", file], { stdio: "ignore" });
    spawnSync("launchctl", ["load", "-w", file], { stdio: "ignore" });
    return { ok: true, where: file };
  }

  const file = desktopPath();
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `[Desktop Entry]
Type=Application
Name=${APP}
Comment=Keep the Splitpage document server running
Exec=${commandLine(cmd)}
Path=${root}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
  return { ok: true, where: file };
}

/* Remove the entry. `onlyIfPointsAt` guards the case that matters: two copies
   of Splitpage on one machine, where uninstalling the portable one must not
   silently stop the installed one from starting at boot. */
export function disable({ onlyIfPointsAt = null } = {}) {
  const current = status();
  if (!current.supported) return { ok: false, removed: false, where: current.where };
  if (!current.enabled) return { ok: true, removed: false, where: current.where };
  if (onlyIfPointsAt && current.command
      && !current.command.toLowerCase().includes(onlyIfPointsAt.toLowerCase())) {
    return { ok: true, removed: false, where: current.where, kept: "points at another copy" };
  }

  if (platform === "win32") {
    const res = spawnSync("reg.exe", ["delete", RUN_KEY, "/v", APP, "/f"], { encoding: "utf8" });
    return res.status === 0
      ? { ok: true, removed: true, where: current.where }
      : { ok: false, removed: false, where: current.where, error: (res.stderr || "reg.exe failed").trim() };
  }

  if (platform === "darwin") spawnSync("launchctl", ["unload", "-w", current.where], { stdio: "ignore" });
  try { rmSync(current.where, { force: true }); } catch (err) {
    return { ok: false, removed: false, where: current.where, error: err.message };
  }
  return { ok: true, removed: true, where: current.where };
}
