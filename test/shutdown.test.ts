/**
 * Shutdown: the in-flight counter, the refusal a late call gets, the signal
 * handlers, and `run()` actually installing them.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  InFlight,
  OwedResponses,
  SHUTDOWN_DRAIN_MS,
  installShutdownHandlers,
  shuttingDownRefusal,
} from "../src/shutdown.js";
import type {
  DrainOutcome,
  ShutdownDeps,
  ShutdownSignal,
  ShutdownTarget,
} from "../src/shutdown.js";
import { TastytradeMCPServer } from "../src/mcp-server/index.js";

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("InFlight", () => {
  it("counts admitted calls, and a release is idempotent", () => {
    const flight = new InFlight();
    const first = flight.admit();
    const second = flight.admit();
    expect(flight.running).toBe(2);
    first?.();
    first?.();
    expect(flight.running).toBe(1);
    second?.();
    expect(flight.running).toBe(0);
  });

  it("refuses to admit once closed, and leaves admitted calls counted", () => {
    const flight = new InFlight();
    const release = flight.admit();
    flight.close();
    expect(flight.admit()).toBeNull();
    expect(flight.running).toBe(1);
    release?.();
    expect(flight.running).toBe(0);
  });

  it("drains at once when nothing is running, and closes", async () => {
    const flight = new InFlight();
    await expect(flight.drain(1000)).resolves.toEqual({ drained: true });
    expect(flight.admit()).toBeNull();
  });

  it("resolves a drain at the last release, not at the bound", async () => {
    jest.useFakeTimers();
    const flight = new InFlight();
    const one = flight.admit();
    const two = flight.admit();
    let outcome: DrainOutcome | undefined;
    void flight.drain(5000).then((o) => (outcome = o));
    one?.();
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    two?.();
    await Promise.resolve();
    expect(outcome).toEqual({ drained: true });
    // The bound's timer is cleared once it is not needed.
    expect(jest.getTimerCount()).toBe(0);
  });

  it("gives up at the bound and says how many calls were still open", async () => {
    jest.useFakeTimers();
    const flight = new InFlight();
    flight.admit();
    const done = flight.drain(5000);
    jest.advanceTimersByTime(4999);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(done).resolves.toEqual({ drained: false, stillRunning: 1 });
  });
});

describe("OwedResponses", () => {
  const response = (id: number | string): object => ({
    jsonrpc: "2.0",
    id,
    result: {},
  });

  it("keeps a call counted until its own response has been sent", async () => {
    const flight = new InFlight();
    const owed = new OwedResponses();
    const release = flight.admit() as () => void;
    owed.hold(7, release, new AbortController().signal);

    const drain = flight.drain(60_000);
    let settled = false;
    void drain.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(owed.pending).toBe(1);

    owed.sent(response(8)); // someone else's answer
    owed.sent({ jsonrpc: "2.0", id: 7, method: "ping" }); // a request, not an answer
    await Promise.resolve();
    expect(settled).toBe(false);

    owed.sent(response(7));
    await expect(drain).resolves.toEqual({ drained: true });
    expect(owed.pending).toBe(0);
  });

  it("releases an error response too, and string ids stay distinct from numbers", () => {
    const owed = new OwedResponses();
    const released: string[] = [];
    owed.hold("1", () => released.push("string"), new AbortController().signal);
    owed.hold(1, () => released.push("number"), new AbortController().signal);
    owed.sent({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } });
    expect(released).toEqual(["number"]);
    owed.sent(response("1"));
    expect(released).toEqual(["number", "string"]);
  });

  it("releases at once with no request id or an aborted signal", () => {
    const owed = new OwedResponses();
    const release = jest.fn();
    owed.hold(undefined, release);
    const aborted = new AbortController();
    aborted.abort();
    owed.hold(3, release, aborted.signal);
    expect(release).toHaveBeenCalledTimes(2);
    expect(owed.pending).toBe(0);
  });

  it("releases when the request is aborted, since no response will follow", () => {
    const owed = new OwedResponses();
    const release = jest.fn();
    const controller = new AbortController();
    owed.hold(4, release, controller.signal);
    expect(release).not.toHaveBeenCalled();
    controller.abort();
    expect(release).toHaveBeenCalledTimes(1);
    expect(owed.pending).toBe(0);
    owed.sent(response(4));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("shuttingDownRefusal", () => {
  it("is request_cancelled, not retryable, and says nothing was sent", () => {
    const refusal = shuttingDownRefusal();
    expect(refusal.code).toBe("request_cancelled");
    expect(refusal.retryable).toBe(false);
    expect(refusal.message).toContain("shutting down");
    expect(refusal.message).toContain("nothing was sent");
    expect(refusal.message).toContain("no confirmation token was spent");
    expect(refusal.hint).toContain("dry_run_");
    expect(refusal.hint).toContain("does not survive the restart");
  });
});

/** A target whose drain the test settles by hand. */
function fakeTarget(running = 2) {
  const calls: string[] = [];
  let settle!: (o: DrainOutcome) => void;
  let failDrain!: (e: Error) => void;
  const target: ShutdownTarget & {
    beginShutdown: jest.Mock<ShutdownTarget["beginShutdown"]>;
    close: jest.Mock<ShutdownTarget["close"]>;
  } = {
    running,
    beginShutdown: jest.fn((ms: number) => {
      calls.push(`beginShutdown(${ms})`);
      return new Promise<DrainOutcome>((resolve, reject) => {
        settle = resolve;
        failDrain = reject;
      });
    }),
    close: jest.fn(async () => {
      calls.push("close");
    }),
  };
  return {
    target,
    calls,
    settle: (o: DrainOutcome) => settle(o),
    failDrain: (e: Error) => failDrain(e),
  };
}

function fakeDeps(calls: string[]) {
  const listeners = new Map<ShutdownSignal, () => void>();
  const logs: string[] = [];
  const exit = jest.fn((code: number) => {
    calls.push(`exit(${code})`);
  });
  const deps: ShutdownDeps = {
    on: (signal, listener) => {
      listeners.set(signal, listener);
    },
    exit,
    log: (line) => logs.push(line),
  };
  return {
    deps,
    exit,
    logs,
    send: (signal: ShutdownSignal) => listeners.get(signal)?.(),
    listeners,
  };
}

/** Let queued promise callbacks run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("installShutdownHandlers", () => {
  it("listens for SIGTERM and SIGINT", () => {
    const { target, calls } = fakeTarget();
    const { deps, listeners } = fakeDeps(calls);
    installShutdownHandlers(target, deps);
    expect([...listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("drains, closes, then exits 0 when every call finished", async () => {
    const { target, calls, settle } = fakeTarget(2);
    const { deps, exit, logs, send } = fakeDeps(calls);
    installShutdownHandlers(target, deps);

    send("SIGTERM");
    await flush();
    expect(calls).toEqual([`beginShutdown(${SHUTDOWN_DRAIN_MS})`]);
    expect(SHUTDOWN_DRAIN_MS).toBe(30_000);
    expect(exit).not.toHaveBeenCalled();

    settle({ drained: true });
    await flush();
    expect(calls).toEqual(["beginShutdown(30000)", "close", "exit(0)"]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("SIGTERM");
    expect(logs[0]).toContain("2 tool call(s) in flight");
    expect(logs[0]).toContain("30000");
  });

  it("exits 1 when calls were still running at the bound", async () => {
    const { target, calls, settle } = fakeTarget();
    const { deps, logs, send } = fakeDeps(calls);
    installShutdownHandlers(target, deps);
    send("SIGINT");
    settle({ drained: false, stillRunning: 1 });
    await flush();
    expect(calls).toEqual(["beginShutdown(30000)", "close", "exit(1)"]);
    expect(logs[1]).toContain("1 tool call(s) still running");
  });

  it("exits 1 straight away on a second signal, before the drain resolves", async () => {
    const { target, calls } = fakeTarget();
    const { deps, exit, send } = fakeDeps(calls);
    installShutdownHandlers(target, deps);
    send("SIGINT");
    await flush();
    send("SIGINT");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    // Only one drain was ever started.
    expect(target.beginShutdown).toHaveBeenCalledTimes(1);
  });

  it("still exits when close() rejects", async () => {
    const { target, calls, settle } = fakeTarget();
    target.close.mockRejectedValueOnce(new Error("already closed"));
    const { deps, send } = fakeDeps(calls);
    installShutdownHandlers(target, deps);
    send("SIGTERM");
    settle({ drained: true });
    await flush();
    expect(calls).toEqual(["beginShutdown(30000)", "exit(0)"]);
  });

  it("exits 1 when the drain itself fails", async () => {
    const { target, calls, failDrain } = fakeTarget(3);
    const { deps, logs, send } = fakeDeps(calls);
    installShutdownHandlers(target, deps);
    send("SIGTERM");
    failDrain(new Error("boom"));
    await flush();
    expect(calls).toEqual(["beginShutdown(30000)", "close", "exit(1)"]);
    expect(logs[1]).toContain("3 tool call(s) still running");
  });
});

describe("run() wiring", () => {
  it("installs the handlers, so SIGTERM on the process ends in exit(0)", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const signals = new EventEmitter();
    let exited: (code: number) => void = () => {};
    const exitCode = new Promise<number>((resolve) => (exited = resolve));
    const server = new TastytradeMCPServer({
      apiUrl: "https://api.cert.tastyworks.com",
    });
    await server.run({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      process: {
        on: (signal, listener) => signals.on(signal, listener),
        exit: (code) => exited(code),
      },
    });

    signals.emit("SIGTERM");
    let giveUp: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      exitCode,
      new Promise<string>((resolve) => {
        giveUp = setTimeout(() => resolve("no exit within 2s"), 2000);
      }),
    ]);
    clearTimeout(giveUp);
    expect(outcome).toBe(0);
    const lines = errors.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("received SIGTERM"))).toBe(true);
  });
});
