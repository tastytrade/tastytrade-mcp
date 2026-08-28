import { describe, it, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCS_ROOT,
  REQUIRED_DOCS,
  readVendoredDoc,
} from "../../src/resources/static/vendored-docs.js";

/**
 * The static MCP resources read these files at MODULE LOAD, so a missing docs
 * directory takes the server down at import time rather than degrading one
 * resource. That makes the docs a packaging dependency, and this suite the
 * guard: if someone trims `tastytrade-llms-txt-docs/` from an image, a
 * tarball, or the `files` list, it fails here instead of in production.
 */
describe("vendored docs are a satisfied runtime dependency", () => {
  it("resolves a docs directory that exists", () => {
    expect(existsSync(DOCS_ROOT)).toBe(true);
    expect(statSync(DOCS_ROOT).isDirectory()).toBe(true);
  });

  it.each(REQUIRED_DOCS)("ships %s with real content", (file) => {
    const full = path.join(DOCS_ROOT, file);
    expect(existsSync(full)).toBe(true);
    // Guard against a file that exists but was emptied or truncated to a stub.
    expect(statSync(full).size).toBeGreaterThan(500);
  });
});

describe("REQUIRED_DOCS is the list the resource modules really read", () => {
  /**
   * REQUIRED_DOCS is what a packaging check asserts against, and its own doc
   * comment promises it is kept in step with the modules. Restating the four
   * literals here would assert that promise about nothing, so the call sites
   * are read out of the source instead: every module that imports
   * readVendoredDoc, under whatever local alias, and every filename it passes.
   */
  const STATIC_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "resources",
    "static",
  );

  /** `import { readVendoredDoc } from "./vendored-docs.js"`, alias or not. */
  const IMPORT_RE =
    /import\s*\{\s*readVendoredDoc(?:\s+as\s+(\w+))?\s*\}\s*from\s*"\.\/vendored-docs\.js"/;

  function readsPerModule(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const entry of readdirSync(STATIC_DIR)) {
      if (!entry.endsWith(".ts") || entry === "vendored-docs.ts") continue;
      const source = readFileSync(path.join(STATIC_DIR, entry), "utf8");
      const imported = IMPORT_RE.exec(source);
      if (!imported) continue;
      const alias = imported[1] ?? "readVendoredDoc";
      const calls = [
        ...source.matchAll(new RegExp(`\\b${alias}\\(\\s*"([^"]+)"`, "g")),
      ].map((m) => m[1]);
      found.set(entry, calls);
    }
    return found;
  }

  const perModule = readsPerModule();
  const read = [...new Set([...perModule.values()].flat())].sort();

  it("finds the call sites at all", () => {
    // Rename the module or the export and the scan above quietly matches
    // nothing, which would turn the comparison below into `[] === []`.
    expect(perModule.size).toBeGreaterThan(0);
    expect(read.length).toBeGreaterThan(0);
    for (const [module, calls] of perModule) {
      expect(`${module}: ${calls.length}`).not.toBe(`${module}: 0`);
    }
  });

  it("lists every doc a resource module reads, and nothing more", () => {
    expect([...REQUIRED_DOCS].sort()).toEqual(read);
  });
});

describe("a missing doc explains itself", () => {
  it("names the file, the search path, and the fix", () => {
    let message = "";
    try {
      readVendoredDoc("definitely-not-a-real-doc.md");
    } catch (err) {
      message = (err as Error).message;
    }

    // A bare ENOENT tells a self-hoster nothing actionable; these are the
    // pieces that do — including the leading refusal, which is what a reader
    // sees first in a client's server-failed-to-start log.
    expect(message).toMatch(/^Cannot start/);
    expect(message).toContain("definitely-not-a-real-doc.md");
    expect(message).toContain(DOCS_ROOT);
    expect(message).toContain("runtime dependency");
    expect(message).toMatch(/ENOENT/);
  });
});
