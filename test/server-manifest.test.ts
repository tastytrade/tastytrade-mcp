/**
 * server.json is the registry's copy of everything this repository claims about
 * itself, and it is the one public artefact no other test reads.
 *
 * Two failure modes, both silent:
 *
 * 1. THE SIZE CAP. The MCP registry accepts at most 4096 bytes of
 *    publisher-provided `_meta`. Over that, publication is refused — and nothing
 *    in the build says so, because the file is still valid JSON and still parses.
 *    The prose in here is the kind that grows a sentence at a time, so the cap is
 *    asserted rather than remembered.
 *
 * 2. DISAGREEMENT WITH THE README. Both files ship a paste-ready client config.
 *    A reader meets one or the other, not both, so if they select different
 *    environments then half the readers land somewhere they did not choose — and
 *    the default is production, which is the half that costs money.
 *
 * Offline, and reads only tracked files.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  TOOL_ANNOTATIONS,
  TastytradeMCPServer,
} from "../src/mcp-server/index.js";
import { accessClassFor } from "../src/mcp-server/annotations.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(name: string): string {
  return readFileSync(path.join(REPO_ROOT, name), "utf8");
}

const MANIFEST = JSON.parse(read("server.json")) as Record<string, unknown>;
const PUBLISHER_KEY = "io.modelcontextprotocol.registry/publisher-provided";

/** The registry's documented ceiling on publisher-provided `_meta`. */
const META_BYTE_CAP = 4096;

interface Published {
  toolSurface?: {
    tools?: number;
    readOnly?: number;
    write?: number;
    destructive?: number;
  };
  install?: {
    cloneAndBuild?: {
      clientConfig?: {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
    };
  };
}

function published(): Published {
  const meta = MANIFEST._meta as Record<string, unknown>;
  return meta[PUBLISHER_KEY] as Published;
}

describe("server.json fits what the registry will accept", () => {
  it("keeps _meta under the 4096-byte publisher-provided cap", () => {
    // Serialised the way a publisher sends it — no pretty-printing, since the
    // cap is on the payload and not on the file as it sits on disk.
    const bytes = Buffer.byteLength(JSON.stringify(MANIFEST._meta), "utf8");
    expect(bytes).toBeLessThanOrEqual(META_BYTE_CAP);
  });

  it("is not vacuously small — the cap is a real bound on this file", () => {
    // Without this, deleting _meta entirely would satisfy the test above.
    const bytes = Buffer.byteLength(JSON.stringify(MANIFEST._meta), "utf8");
    expect(bytes).toBeGreaterThan(META_BYTE_CAP / 2);
  });

  it("declares the version package.json declares", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(MANIFEST.version).toBe(pkg.version);
  });
});

describe("server.json agrees with the code it describes", () => {
  it("advertises the tool counts the registry actually serves", () => {
    const server = Object.create(
      TastytradeMCPServer.prototype,
    ) as TastytradeMCPServer;
    const tools = (
      TastytradeMCPServer.prototype as unknown as {
        getTools: (this: TastytradeMCPServer) => Array<{ name: string }>;
      }
    ).getTools.call(server);

    const counts = { read: 0, write: 0, destructive: 0 };
    for (const t of tools) {
      const annotations = TOOL_ANNOTATIONS[t.name];
      expect(annotations).toBeDefined();
      counts[accessClassFor(annotations!)] += 1;
    }

    const surface = published().toolSurface ?? {};
    expect(surface.tools).toBe(tools.length);
    // Only assert the breakdown the file actually publishes, so adding a field
    // here is a deliberate act rather than something this test demands.
    if (surface.readOnly !== undefined)
      expect(surface.readOnly).toBe(counts.read);
    if (surface.write !== undefined) expect(surface.write).toBe(counts.write);
    if (surface.destructive !== undefined)
      expect(surface.destructive).toBe(counts.destructive);
  });
});

describe("the two paste-ready configs cannot disagree", () => {
  /** The env block server.json tells a reader to paste. */
  function manifestEnv(): Record<string, string> {
    const servers =
      published().install?.cloneAndBuild?.clientConfig?.mcpServers;
    expect(servers).toBeDefined();
    const entry = Object.values(servers!)[0];
    expect(entry?.env).toBeDefined();
    return entry!.env!;
  }

  /** Every `TASTYTRADE_ENV` value appearing in a README json fence. */
  function readmeEnvValues(): string[] {
    const readme = read("README.md");
    const values: string[] = [];
    for (const fence of readme.matchAll(/```json\n([\s\S]*?)```/g)) {
      for (const m of fence[1].matchAll(/"TASTYTRADE_ENV"\s*:\s*"([^"]+)"/g)) {
        values.push(m[1]);
      }
    }
    return values;
  }

  it("names an environment explicitly in server.json", () => {
    // An absent variable means production. A config that means production
    // without saying so is how an operator reaches it without deciding to, so
    // the block has to name it either way.
    expect(manifestEnv().TASTYTRADE_ENV).toBeDefined();
  });

  it("names an environment explicitly in the README's config block", () => {
    expect(readmeEnvValues().length).toBeGreaterThan(0);
  });

  it("selects the SAME environment in both", () => {
    const fromManifest = manifestEnv().TASTYTRADE_ENV;
    for (const value of readmeEnvValues()) {
      expect(value).toBe(fromManifest);
    }
  });

  it("selects an environment the server can actually read", () => {
    // A paste-ready block naming an unreadable environment would fail closed to
    // the sandbox — safe, but not what either file says it does.
    const value = manifestEnv().TASTYTRADE_ENV;
    expect([
      "production",
      "prod",
      "live",
      "sandbox",
      "cert",
      "staging",
      "sbx",
    ]).toContain(value);
  });
});
