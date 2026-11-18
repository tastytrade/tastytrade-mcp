/**
 * Orderly shutdown for a stdio server that may be partway through a money-moving
 * call when its process is told to stop: {@link InFlight} counts running calls and
 * refuses new ones, {@link shuttingDownRefusal} is what a late call is told, and
 * {@link installShutdownHandlers} wires SIGTERM and SIGINT to a bounded drain.
 *
 * An MCP client that is leaving closes stdin, then sends SIGTERM, then SIGKILL a
 * couple of seconds apart, and a node process running as PID 1 in a container has
 * no default SIGTERM action at all. Without a handler the server is killed mid-
 * request, and a request killed in flight may or may not have reached the broker.
 */

import type { ToolError } from "./safety/errors.js";

/**
 * How long in-flight calls may keep running after the first signal.
 *
 * Equal to the HTTP client's default request timeout, so a request that is
 * already on the wire when the signal arrives can finish or time out inside the
 * window instead of being cut off partway.
 */
export const SHUTDOWN_DRAIN_MS = 30_000;

/**
 * The reason the server's shutdown signal is aborted with, so a pre-submit check
 * can tell "the server is stopping" from "the caller went away" on a signal that
 * combines the two.
 */
export const SHUTDOWN_ABORT_REASON = Symbol("tastytrade-mcp.shutdown");

/** How a drain ended. */
export type DrainOutcome =
  { drained: true } | { drained: false; stillRunning: number };

/**
 * A counter of running calls that can be closed to new ones.
 *
 * `admit()` is the only way in and returns the release for that one call, or `null`
 * once the counter is closed. The release is idempotent, so a call that releases in
 * a `finally` and again on some other path cannot drive the count below the truth.
 */
export class InFlight {
  private count = 0;
  private closed = false;
  private readonly waiters: Array<() => void> = [];

  /** Start a call. `null` means the server is shutting down: do not start it. */
  admit(): (() => void) | null {
    if (this.closed) return null;
    this.count++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      if (this.count === 0) {
        for (const wake of this.waiters.splice(0)) wake();
      }
    };
  }

  /** Refuse every later `admit()`. Calls already admitted are unaffected. */
  close(): void {
    this.closed = true;
  }

  /** Calls admitted and not yet released. */
  get running(): number {
    return this.count;
  }

  /**
   * Close, then wait for the running calls to finish.
   *
   * Resolves `{ drained: true }` the moment the count reaches zero (immediately if
   * it already is), or `{ drained: false, stillRunning }` once `ms` have passed
   * with calls still open. The timer is unref'd so it never holds the process
   * open on its own, and cleared as soon as it is not needed.
   */
  drain(ms: number): Promise<DrainOutcome> {
    this.close();
    if (this.count === 0) return Promise.resolve({ drained: true });
    return new Promise<DrainOutcome>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve({ drained: true });
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(wake);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve({ drained: false, stillRunning: this.count });
      }, ms);
      timer.unref();
      this.waiters.push(wake);
    });
  }
}

/**
 * The responses a server owes its client, so a call is not counted as finished
 * until its answer has been handed to the transport.
 *
 * Releasing an {@link InFlight} slot when the handler returns is too early: the
 * SDK sends the result in a later step, and a drain that wakes in between closes
 * the connection, which makes the SDK drop every response it has not yet sent. The
 * call has then reached the broker and its answer is lost. So the handler hands
 * its release to {@link hold}, and the transport's `send` calls {@link sent} once
 * the write has settled.
 *
 * A response that will never be sent (the caller cancelled, or the connection
 * closed) is signalled by the request's abort signal, which releases at once.
 */
export class OwedResponses {
  private readonly owed = new Map<string | number, () => void>();

  /**
   * Keep `release` until the response to request `id` has been sent. With no id,
   * or when `signal` has already aborted, there is nothing to wait for and it is
   * released now.
   */
  hold(
    id: string | number | undefined,
    release: () => void,
    signal?: AbortSignal,
  ): void {
    if (id === undefined || signal?.aborted) {
      release();
      return;
    }
    this.owed.set(id, release);
    signal?.addEventListener(
      "abort",
      () => {
        if (this.owed.get(id) === release) this.owed.delete(id);
        release();
      },
      { once: true },
    );
  }

  /** A message has been written. If it answers a held request, release that one. */
  sent(message: object): void {
    if (!("id" in message) || "method" in message) return;
    const id = (message as { id: unknown }).id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const release = this.owed.get(id);
    if (release === undefined) return;
    this.owed.delete(id);
    release();
  }

  /** Responses still owed. */
  get pending(): number {
    return this.owed.size;
  }
}

/**
 * What a tool call that arrives during shutdown is told.
 *
 * `retryable: false`, because the same call to this same process will keep being
 * refused, and the token (if the call carried one) does not survive the restart.
 * Nothing was sent, so there is nothing to reconcile.
 */
export function shuttingDownRefusal(): ToolError {
  return {
    code: "request_cancelled",
    message:
      "This server is shutting down, so it did not start this call: nothing was sent and no confirmation token was spent.",
    retryable: false,
    hint:
      "A confirmation token does not survive the restart. Once the server is running again, " +
      "run the matching dry_run_* tool first and use the token it returns.",
  };
}

/** The two signals a supervisor or a terminal uses to ask a process to stop. */
export type ShutdownSignal = "SIGTERM" | "SIGINT";

/** What the handlers drive. The server class implements it. */
export interface ShutdownTarget {
  /** Calls started and not yet finished, for the log line. */
  readonly running: number;
  /** Stop starting calls, and wait up to `ms` for the running ones. */
  beginShutdown(ms: number): Promise<DrainOutcome>;
  /**
   * Close the transport. Everything already written must have reached the client's
   * end first: the process exits as soon as this resolves.
   */
  close(): Promise<void>;
}

/** Process-level effects, injected so the handlers can be tested without a process. */
export interface ShutdownDeps {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  exit(code: number): void;
  /** One line to stderr. Never given a tool argument. */
  log(line: string): void;
}

/**
 * Install SIGTERM and SIGINT handlers that drain and exit.
 *
 * First signal: log one line, `beginShutdown` (which resolves only once each
 * running call's response has been written), `close` (a failure there is
 * swallowed: the process is leaving either way), log the outcome, then exit 0 if
 * every call finished and 1 if any was still running at the bound. A second signal
 * while that is under way exits 1 at once: whoever sent it is out of patience.
 */
export function installShutdownHandlers(
  target: ShutdownTarget,
  deps: ShutdownDeps,
): void {
  let draining = false;
  const handle = (signal: ShutdownSignal): void => {
    if (draining) {
      deps.log(`[tastytrade-mcp] received ${signal} again; exiting now`);
      deps.exit(1);
      return;
    }
    draining = true;
    deps.log(
      `[tastytrade-mcp] received ${signal} with ${target.running} tool call(s) in flight; ` +
        `refusing new calls and waiting up to ${SHUTDOWN_DRAIN_MS} ms for them to finish`,
    );
    void (async () => {
      let outcome: DrainOutcome;
      try {
        outcome = await target.beginShutdown(SHUTDOWN_DRAIN_MS);
      } catch {
        // Not expected, but the exit must still happen, and non-zero.
        outcome = { drained: false, stillRunning: target.running };
      }
      try {
        await target.close();
      } catch {
        // Closing a transport that is already gone is not worth a failed exit.
      }
      deps.log(
        outcome.drained
          ? "[tastytrade-mcp] shutdown: every in-flight call finished"
          : `[tastytrade-mcp] shutdown: ${outcome.stillRunning} tool call(s) still running at the bound; exiting anyway`,
      );
      deps.exit(outcome.drained ? 0 : 1);
    })();
  };
  deps.on("SIGTERM", () => handle("SIGTERM"));
  deps.on("SIGINT", () => handle("SIGINT"));
}
