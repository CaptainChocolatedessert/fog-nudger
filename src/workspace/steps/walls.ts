/**
 * Step: which ink counts as walls.
 *
 * Two filters over the ink the step before it read — minimum stroke width and smallest ink island —
 * and nothing of its own to paint: what they do is visible in the ink layer, which is the whole
 * reason they are safe enough to ship. Both go further than useful deliberately, because a control
 * whose top end still looks reasonable gives no feel for where the edge is.
 *
 * Small on purpose, and the obvious home for the next thing: spur pruning joins these two once the
 * skeleton exists.
 */

import type { Step } from "../step";

export const wallsStep: Step = {
  id: "walls",
};
