/**
 * Shutdown through the real `run()`: the stdio transport over injected streams, the
 * real signal wiring, and the real `close()`. Reads what the client would have
 * read before the process exited.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { TastytradeMCPServer } from "../../src/mcp-server/index.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

const ACCT = "5WX00001";

afterEach(() => {
  jest.restoreAllMocks();
  _resetRateLimitsForTest();
});

/** A fake upstream whose balances answer takes `delayMs`. */
function adapterWith(delayMs: number) {
  return async (config: any) => {
    const url: string = config.url ?? "";
    if (url.includes("/balances")) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const data = url.includes("/balances")
      ? { data: { "net-liquidating-value": "1.00" } }
      : { data: { items: [{ account: { "account-number": ACCT } }] } };
    return { data, status: 200, statusText: "200", headers: {}, config } as any;
  };
}

/** Drive a real `run()` to the point where a balances call is running. */
async function runWithCallInFlight(stdout: Writable, delayMs = 300) {
  jest.spyOn(console, "error").mockImplementation(() => {});
  const server = new TastytradeMCPServer(
    { apiUrl: "https://api.cert.tastyworks.com" },
    { adapter: adapterWith(delayMs), tokenProvider: () => "t" } as any,
  );
  const stdin = new PassThrough();
  const signals = new EventEmitter();
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  await server.run({
    stdin,
    stdout,
    process: {
      on: (signal, listener) => signals.on(signal, listener),
      exit: (code) => {
        exit(code);
      },
    },
  });
  const send = (message: object): void => {
    stdin.write(JSON.stringify(message) + "\n");
  };
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "tastytrade_get_balances",
      arguments: { account_number: ACCT },
    },
  });
  const deadline = Date.now() + 2000;
  while (server.running < 1) {
    if (Date.now() > deadline) throw new Error("the call never started");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { server, signals, exited, send };
}

describe("run() with a call in flight when SIGTERM arrives", () => {
  it("writes the response for the running call before it exits 0", async () => {
    const stdout = new PassThrough();
    let written = "";
    stdout.on("data", (chunk) => (written += chunk));
    const { signals, exited } = await runWithCallInFlight(stdout);

    signals.emit("SIGTERM");
    const code = await exited;
    const atExit = written;

    expect(code).toBe(0);
    const response = atExit
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .find((message) => message.id === 2);
    expect(response?.error).toBeUndefined();
    expect(response?.result?.content?.[0]?.text).toContain(
      "net-liquidating-value",
    );
  });

  it("does not exit before a slow output has accepted the response", async () => {
    // The stream accepts the write at once (so the transport's send resolves) but
    // takes 150 ms to process it, like a pipe that is slow to drain.
    const processed: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        setTimeout(() => {
          processed.push(chunk.toString());
          done();
        }, 150);
      },
    });
    const { signals, exited } = await runWithCallInFlight(stdout);

    signals.emit("SIGTERM");
    await expect(exited).resolves.toBe(0);

    expect(processed.some((chunk) => chunk.includes('"id":2'))).toBe(true);
  });

  it("exits 0 promptly when the client cancels the running call during the drain, with no response for it", async () => {
    // The SDK sends no response for a cancelled request, so only the request's own
    // abort signal can release the call's slot. If the drain were not told about the
    // abort, it would wait out its 30 second bound and exit 1.
    const stdout = new PassThrough();
    let written = "";
    stdout.on("data", (chunk) => (written += chunk));
    const { server, signals, exited, send } = await runWithCallInFlight(
      stdout,
      300,
    );

    signals.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "client gave up" },
    });

    const started = Date.now();
    const code = await Promise.race([
      exited,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("no exit within 3s"), 3000),
      ),
    ]);
    const atExit = written;

    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    const ids = atExit
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line))
      .map((message) => message.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    // Let the upstream call finish so no timer outlives the test.
    while (server.running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it("exits 1 at once on a second signal", async () => {
    const stdout = new PassThrough();
    stdout.resume();
    const { server, signals, exited } = await runWithCallInFlight(stdout, 600);

    signals.emit("SIGTERM");
    signals.emit("SIGTERM");

    await expect(exited).resolves.toBe(1);
    // Let the upstream call finish so no timer outlives the test.
    while (server.running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});
