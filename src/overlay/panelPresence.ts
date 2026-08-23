/**
 * How the overlay learns that the panel is open, so it can keep off it.
 *
 * The overlay covers the whole window — that is what a full-screen modal is — so at any zoom where
 * the linework is thick, ink paints straight over the panel and makes the sliders hard to use. The
 * panel is exactly where a GM is working while the overlay is up, so this is not a corner case.
 *
 * ## Why a heartbeat rather than open and close messages
 *
 * The panel is a popover, and a popover is dismissed by clicking anywhere outside it. Whether an
 * iframe torn down that way reliably gets to send a farewell is not something worth betting the
 * behaviour on: a missed close message leaves a permanent blank stripe across a third of the map,
 * with nothing to say why.
 *
 * A heartbeat cannot fail that way. The panel says "still here" on a timer; the overlay reserves
 * space only while it has heard recently. Nothing needs to be told about the ending, so there is no
 * ending to miss, and the state repairs itself within one stale interval however the panel went
 * away.
 *
 * ## Failing safe
 *
 * If the broadcast never arrives at all — the local destination not reaching a sibling iframe is
 * unverified — the overlay simply never reserves the band and draws over the panel exactly as it
 * did before. That is the current behaviour rather than a new fault, which is the right direction
 * for an unproven mechanism to fail in.
 *
 * No DOM, no SDK: constants and one shape, shared by two iframes that have nothing else in common.
 */

import { key } from "../namespace";

/** Namespaced, so another extension's chatter cannot be mistaken for ours. */
export const PANEL_PRESENCE_CHANNEL = key("panel-presence");

/** How often the panel announces itself. */
export const HEARTBEAT_MS = 400;

/**
 * How long a heartbeat stays believed.
 *
 * Comfortably more than two intervals. One would make a single dropped or late message flicker the
 * band, and a band that flickers is worse than one that lingers — the lingering costs a moment of
 * hidden map, the flickering costs the layout jumping under a slider the GM is dragging.
 */
export const PRESENCE_STALE_MS = 1200;

/**
 * How far left of the panel's own edge to reserve, in pixels.
 *
 * The panel iframe knows its width but **not its position**: it cannot read the top window's
 * geometry across origins. Owlbear places the popover near its toolbar rather than flush to the
 * screen edge, so this covers the gap between the two.
 *
 * Was 64 and measured too wide in a room (user, 2026-08-23); halved. Still a guess rather than a
 * measurement — the band is logged on every change, so it stays correctable by looking.
 */
export const PANEL_EDGE_MARGIN = 32;

/** What the panel sends. Carries its width so the band follows the manifest rather than a copy of it. */
export interface PanelPresence {
  readonly width: number;
}

/** Narrow an arriving broadcast, which is `unknown` and comes from another frame. */
export function readPanelPresence(data: unknown): PanelPresence | null {
  if (typeof data !== "object" || data === null) return null;
  const width = (data as { width?: unknown }).width;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return null;
  return { width };
}

/** The band to keep clear, given the last presence heard and how long ago. */
export function reservedWidth(
  presence: PanelPresence | null,
  ageMs: number,
  staleMs = PRESENCE_STALE_MS,
): number {
  if (!presence || ageMs >= staleMs) return 0;
  return presence.width + PANEL_EDGE_MARGIN;
}
