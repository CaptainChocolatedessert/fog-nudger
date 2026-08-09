/**
 * Dev log receiver. Pairs with src/devlog.ts.
 *
 *   npm run devlog
 *
 * Appends to dev.log (gitignored) and echoes to stdout, so a failure inside a real Owlbear room
 * is readable without digging through the devtools of a third-party iframe.
 *
 * ## Line order is arrival order, and is NOT event order
 *
 * The shim posts each line as its own fire-and-forget HTTP request. Those requests race, so the
 * order lines land here is not the order the events happened — observed on the very first run,
 * with five lines spanning 16ms written in none of the orders they occurred. Reading top to
 * bottom therefore gives a sequence that looks authoritative and is wrong.
 *
 * The timestamps are the trustworthy part: each is taken at the log call, in the client, before
 * the request exists. So sort by them rather than trusting the file:
 *
 *   sort dev.log
 *
 * (ISO-8601 sorts correctly as text, which is why the raw stamp is kept in the file even though
 * the stdout echo shows only the time.)
 *
 * ## Across machines, even the timestamps do not settle order
 *
 * Sorting works within one machine, where every surface reads one clock. It does NOT work across
 * clients: a GM and a player stamp their lines from two unsynchronised system clocks that can
 * differ by seconds. Never build a causal argument — this happened, *therefore* that happened —
 * out of lines from two different clients. Within a client, the order is real.
 */

import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Registered in ../project setup notes.md, which is where ports are claimed across every project
// in this folder. 9999 is cartographers-fog's. Binds explicitly and fails rather than moving, so it
// needs no equivalent of Vite's strictPort — but it does need a distinct number, because two
// projects sharing a receiver interleave into one file with no way to tell them apart.
// Must stay in step with the ENDPOINT in src/devlog.ts.
const PORT = 9998;
const LOG_FILE = fileURLToPath(new URL("../dev.log", import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

const server = createServer((req, res) => {
  // The extension iframe is on a different origin from this receiver, so the POST is a
  // cross-origin request and needs both the preflight answer and the header below.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) req.destroy();
  });

  req.on("end", async () => {
    res.writeHead(204).end();
    try {
      await record(JSON.parse(body));
    } catch {
      await record({
        level: "warn",
        at: null,
        args: [`unparseable payload: ${body.slice(0, 200)}`],
      });
    }
  });
});

async function record({ level = "info", at = null, args = [], client = "?" }) {
  const stamp = at ?? new Date().toISOString();
  const time = stamp.slice(11, 23);
  // Every client in the room logs here, and every iframe within a client, so say which. Without
  // it a GM and a player interleaved read as a single client contradicting itself. Padded wide
  // enough for `player:bb71/ui`, so the message column stays aligned and scannable.
  const who = `[${String(client).padEnd(15)}]`;
  const line = `${time} [${String(level).toUpperCase()}] ${who} ${args.join(" ")}`;
  process.stdout.write(`${line}\n`);
  await appendFile(LOG_FILE, `${stamp} [${level}] ${who} ${args.join(" ")}\n`, "utf8");
}

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`dev log receiver listening on http://localhost:${PORT}/log\n`);
  process.stdout.write(`appending to ${LOG_FILE}\n`);
});
