import { describe, it, expect } from "@jest/globals";
import { loadFixture } from "./harness.js";

/**
 * The one part of the shared harness nothing else asserts on: `loadFixture`.
 *
 * The broader smoke tests this file once carried — the handshake, a tool dispatch, the
 * injected headers, the 404 and transport-failure envelopes, read-only mode — are
 * driven harder by the suites that depend on the harness, each assertion having a
 * named owner elsewhere. Removing them changed the coverage of src/ by not one line,
 * branch or function.
 *
 * `loadFixture` is the exception: it has bespoke error handling whose only purpose is
 * to turn a typo'd fixture name into an actionable message instead of a bare ENOENT,
 * and no other suite takes that path.
 */
describe("the harness fixture loader", () => {
  it("parses a recorded sandbox payload off disk", () => {
    const fixture = loadFixture("tastytrade_get_orders") as {
      items: Array<Record<string, unknown>>;
    };

    // Asserted against the recorded content, not merely `toBeDefined()`: the
    // point is that the JSON is parsed and handed back whole.
    expect(Array.isArray(fixture.items)).toBe(true);
    expect(fixture.items.length).toBeGreaterThan(0);
    expect(fixture.items[0]).toHaveProperty("order-type");
  });

  it("explains a missing fixture instead of throwing ENOENT", () => {
    expect(() => loadFixture("tastytrade_not_recorded")).toThrow(
      /No recorded fixture/,
    );
    // The message has to be actionable: it names the file it looked for and the
    // directory to look in, which is the whole reason the catch exists.
    expect(() => loadFixture("tastytrade_not_recorded")).toThrow(
      /tastytrade_not_recorded\.json/,
    );
  });
});
