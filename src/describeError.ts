/**
 * Turn any thrown value into one readable line.
 *
 * ## Owlbear's failures are not `Error`s
 *
 * The SDK posts every call to the parent frame and waits for a reply. When the parent refuses, the
 * SDK rejects with the payload it received — unaltered, unwrapped, and never converted. A scene call
 * made before a scene is open rejects with the plain object:
 *
 * ```
 * { error: { name: "MissingDataError", message: "No scene found" } }
 * ```
 *
 * Nothing in that is an `Error`, so the obvious `error instanceof Error` test is false for every
 * failure the SDK can hand back, and a reporter written around it discards the only useful thing it
 * was given. That is not a quirk of one call: it is how every rejection from the SDK arrives.
 *
 * ## Why this project needs it on day one
 *
 * The two questions that block the architecture — whether a scene-level wall occludes, and whether
 * one can be edited by hand — are answered by writing walls and reading what Owlbear says back. If a
 * write is refused, the refusal *is* the finding. Discarding it would leave a probe that reports the
 * same silence for "walls cannot be written this way" and for "the probe never ran".
 *
 * Two refusals must also stay distinguishable at every call site once walls are being committed in
 * bulk: a size or validation failure is permanent and retrying is futile, while a rate limit is
 * temporary and giving up loses data.
 *
 * ## Why this is its own module
 *
 * Pure, and therefore testable. Anything importing the SDK cannot be reached from a node test — the
 * SDK reads `window.location.search` at module load and dies with `ReferenceError: window is not
 * defined`. Splitting the pure half out is the standing rule here, and it matters more than usual
 * for this function: it exists to survive shapes nobody controls.
 *
 * ## What it must never do
 *
 * Return a bare, undescribed value silently. A description that reads the same whether it found a
 * cause or found nothing is a diagnostic that cannot distinguish its outcomes. When there is nothing
 * to say, this says so.
 */
export function describeError(value: unknown, depth = 0): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;

    // The SDK's envelope, unwrapped. Bounded rather than followed to the end: past this point the
    // payload is Owlbear's own, and a general search for something error-shaped would be guessing
    // at a structure nobody has documented. The bound also settles a payload referring to itself.
    if (depth < 2 && "error" in record) {
      return describeError(record.error, depth + 1);
    }

    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (name && message) return `${name}: ${message}`;
    if (name || message) return name || message;

    try {
      const json = JSON.stringify(value);
      // `{}` is the shape a `DOMException` and a few other host objects take, since their fields sit
      // on the prototype. Passing it on would say nothing; the fallback at least names the type.
      if (json && json !== "{}") return json;
    } catch {
      // Cyclic, or holding a value JSON cannot carry. The fallback covers it.
    }
  }

  // `String()` on an object is not safe — one made with a null prototype has no `toString` and
  // throws, which would turn a report about a failure into a second failure inside the reporter.
  const shown =
    value !== null && typeof value === "object"
      ? Object.prototype.toString.call(value)
      : String(value);
  return `no detail on ${shown}`;
}

/**
 * The `name` Owlbear gave a rejection, unwrapped from its envelope, or `""` if there is none.
 *
 * Its live consumer is `isRateLimited`, directly below, and that is the whole of it — no write site
 * calls this. The doc used to say it "exists for the one distinction DESIGN.md §7 insists on making
 * at every write site", which invites a reader to go looking for callers that are not there. The
 * distinction is real and *is* made, at the one place that makes it: the emit path retries when
 * `isRateLimited` says throttle and rethrows otherwise. A rate limit is temporary and giving up on
 * it loses data; a validation or size failure is permanent and retrying it forever is a hang. What
 * this function contributes is the unwrapping, because those arrive through the same channel and
 * look alike in a message.
 */
export function errorName(value: unknown, depth = 0): string {
  if (value instanceof Error) return value.name;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (depth < 2 && "error" in record) return errorName(record.error, depth + 1);
    if (typeof record.name === "string") return record.name;
  }
  return "";
}

/**
 * Whether a rejection is Owlbear throttling us rather than refusing us.
 *
 * **Matches loosely, on purpose.** The name observed is `RateLimitHit` and the message "Too many
 * requests", and either alone is taken as a throttle. The two mistakes here are not symmetric: a
 * throttle read as a refusal abandons a write that would have succeeded on retry and silently loses
 * regions, while a refusal read as a throttle costs a few pointless retries and then reports itself
 * anyway. Erring toward "throttle" is the cheaper error.
 */
export function isRateLimited(value: unknown): boolean {
  const name = errorName(value);
  if (name.toLowerCase().includes("ratelimit")) return true;
  return describeError(value).toLowerCase().includes("too many requests");
}
