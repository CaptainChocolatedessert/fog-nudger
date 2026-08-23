import { describe, expect, it } from "vitest";

import { MaskRequests, isCurrent, shouldPaint } from "./maskRequest";

describe("isCurrent", () => {
  it("accepts only the generation most recently asked for", () => {
    expect(isCurrent(7, 7)).toBe(true);
    expect(isCurrent(6, 7)).toBe(false);
  });

  it("rejects a generation newer than the request", () => {
    // Cannot happen through `MaskRequests`, and it is asserted anyway because the failure of a `>=`
    // written for "recency" is silent and always in the same direction: it accepts a stale answer
    // at exactly the moment the sheet is supposed to be blank.
    expect(isCurrent(8, 7)).toBe(false);
  });
});

describe("MaskRequests", () => {
  it("starts idle and painting nothing", () => {
    const requests = new MaskRequests();
    expect(requests.current().kind).toBe("idle");
    expect(shouldPaint(requests.current())).toBe(false);
    expect(requests.painted()).toBeNull();
    expect(requests.waiting()).toBe(false);
  });

  it("blanks the moment settings change, before anything is computed", () => {
    // The property the whole module exists for. Blanking must not wait for the recomputation to
    // start, or there is a window where the old mask is on screen under the new settings.
    const requests = new MaskRequests();
    requests.fulfil(requests.request());
    expect(shouldPaint(requests.current())).toBe(true);

    requests.request();
    expect(shouldPaint(requests.current())).toBe(false);
    expect(requests.waiting()).toBe(true);
    expect(requests.painted()).toBeNull();
  });

  it("paints a reply that is still current", () => {
    const requests = new MaskRequests();
    const generation = requests.request();
    expect(requests.fulfil(generation)).toBe(true);
    expect(shouldPaint(requests.current())).toBe(true);
    expect(requests.painted()).toBe(generation);
  });

  it("discards a reply that a later request has superseded, and stays blank", () => {
    // The drag case: a value lands after the GM has moved the slider again. Painting it would show
    // ink for settings that are no longer on screen.
    const requests = new MaskRequests();
    const first = requests.request();
    const second = requests.request();

    expect(requests.fulfil(first)).toBe(false);
    expect(shouldPaint(requests.current())).toBe(false);
    expect(requests.waiting()).toBe(true);

    // And the newer one still lands normally afterwards.
    expect(requests.fulfil(second)).toBe(true);
    expect(requests.painted()).toBe(second);
  });

  it("keeps only the latest of several requests made while one is in flight", () => {
    // Nothing queues. Three moves during one computation leave one thing to compute, not three.
    const requests = new MaskRequests();
    const first = requests.request();
    requests.request();
    requests.request();
    const latest = requests.request();

    expect(requests.fulfil(first)).toBe(false);
    expect(requests.fulfil(latest)).toBe(true);
    expect(requests.painted()).toBe(latest);
  });

  it("reports a current failure and stays blank", () => {
    const requests = new MaskRequests();
    const generation = requests.request();
    expect(requests.fail(generation)).toBe(true);
    expect(requests.current().kind).toBe("failed");
    expect(shouldPaint(requests.current())).toBe(false);
    // Not "waiting" either: nothing is in flight, so a readout must not say it is still working.
    expect(requests.waiting()).toBe(false);
  });

  it("discards a superseded failure", () => {
    // An error about settings the GM has moved past would put a failure message under a slider that
    // has since been dragged somewhere else, which reads as the new position being broken.
    const requests = new MaskRequests();
    const first = requests.request();
    requests.request();
    expect(requests.fail(first)).toBe(false);
    expect(requests.current().kind).toBe("pending");
  });

  it("recovers from a failure on the next successful request", () => {
    const requests = new MaskRequests();
    requests.fail(requests.request());
    const next = requests.request();
    expect(requests.fulfil(next)).toBe(true);
    expect(shouldPaint(requests.current())).toBe(true);
  });

  it("hands out strictly increasing generations", () => {
    // A repeated stamp would make two different states indistinguishable, which is the one thing
    // `isCurrent` cannot defend against.
    const requests = new MaskRequests();
    const seen = [requests.request(), requests.request(), requests.request()];
    expect(seen[1]).toBeGreaterThan(seen[0]!);
    expect(seen[2]).toBeGreaterThan(seen[1]!);
  });
});
