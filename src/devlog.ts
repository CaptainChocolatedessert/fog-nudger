/**
 * Dev log shim — forwards errors and console output out of the extension iframe to a local
 * Node receiver (`npm run devlog`), so a failure inside a real Owlbear room is readable
 * without digging through the devtools of a third-party iframe.
 *
 * Inherited from the sibling project, where it earned its keep. No-ops entirely in
 * production builds.
 */

/**
 * Registered in `../project setup notes.md` alongside the Vite port. 9999 belongs to
 * cartographers-fog, whose receiver is often already running on this machine.
 *
 * Sharing a receiver is not a harmless collision: this shim fires and forgets, so posting to the
 * wrong one *succeeds*, and Fog Nudger's output lands in another project's log interleaved with
 * its lines and nothing anywhere saying so.
 *
 * Must stay in step with `tools/devlog-server.mjs`.
 */
const ENDPOINT = "http://localhost:9998/log";

export type LogLevel = "info" | "warn" | "error" | "reject" | "console";

/**
 * Identifies which client a line came from.
 *
 * Every client in the room posts to the same receiver, so without this the interleaved output
 * of a GM and a player reads as one client behaving erratically. That is not hypothetical: in
 * the sibling an unlabelled log made a player's normal sync lag look like state shrinking,
 * which is impossible, and cost a bug hunt.
 */
let clientLabel = "?";

export function setDevLogLabel(label: string): void {
  clientLabel = label;
}

/**
 * Which of a client's iframes a line came from.
 *
 * One client runs at least two: the headless background page and whatever UI is open. They are
 * separate JavaScript realms sharing nothing, so they log independently and their lines interleave
 * — and the two are easy to confuse, because the same message can plausibly come from either.
 */
export type DevLogSurface = "bg" | "ui";

/**
 * Build the label that identifies one surface of one client.
 *
 * Kept here, pure and beside the shim it feeds, so every entry point produces the same shape.
 * Two of them constructing labels independently is how one of them ends up not constructing one
 * at all — which is exactly what happened: the panel logged as `?` while the background page was
 * correctly labelled, and with a second client in the room those anonymous lines would have
 * interleaved into what reads as a single client.
 */
export function formatDevLogLabel(
  role: string,
  playerId: string,
  surface: DevLogSurface,
): string {
  // Owlbear's roles are "GM" and "PLAYER". Anything else is unexpected rather than impossible,
  // and mislabelling it "player" would hide that, so it passes through as itself.
  const who = role === "GM" ? "GM" : role === "PLAYER" ? "player" : role;
  return `${who}:${playerId.slice(0, 4)}/${surface}`;
}

/**
 * Stringify log arguments without throwing. Anything can end up in a log call — circular SDK
 * items, Errors, DOM events — and the shim losing a message is much worse than the message
 * being ugly, since the message is usually why we are looking.
 */
export function serializeArgs(args: readonly unknown[]): string[] {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    }
    if (typeof arg === "string") return arg;
    if (typeof arg === "bigint") return `${arg}n`;
    if (typeof arg === "symbol") return arg.toString();
    if (typeof arg === "function") return `[Function ${arg.name || "anonymous"}]`;
    if (arg === null || typeof arg !== "object") return String(arg);
    try {
      return JSON.stringify(arg, circularReplacer()) ?? String(arg);
    } catch {
      return Object.prototype.toString.call(arg);
    }
  });
}

function circularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

export function devLog(level: LogLevel, ...args: unknown[]): void {
  if (!import.meta.env.DEV) return;
  // Fire and forget. A missing receiver must never break the extension, so every failure
  // path here is swallowed deliberately.
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      level,
      client: clientLabel,
      args: serializeArgs(args),
      at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

let installed = false;

/**
 * `surface` is taken here, at module load, rather than waiting for the full label.
 *
 * The complete label needs the player's role and id, which cost an SDK round trip and are not
 * available until Owlbear is ready. Anything that fails before then — and a failure during
 * startup is the one hardest to place afterwards — would otherwise log as a bare `?`,
 * indistinguishable from the same bare `?` coming out of the other iframe. Half a label
 * immediately beats a whole one later.
 */
export function installDevLog(surface: DevLogSurface): void {
  if (!import.meta.env.DEV || installed) return;
  installed = true;
  clientLabel = `?/${surface}`;

  window.addEventListener("error", (event) => {
    devLog("error", event.message, `${event.filename}:${event.lineno}:${event.colno}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    devLog("reject", event.reason);
  });

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    devLog("console", ...args);
    originalError(...args);
  };

  devLog("info", "dev log shim installed");
}
