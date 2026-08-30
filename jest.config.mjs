/**
 * Jest configuration (ESM).
 *
 * This package is `"type": "module"` and the TypeScript sources use ESM with
 * explicit `.js` import extensions. ts-jest therefore runs in ESM mode and we
 * strip the `.js` extension off relative imports so it resolves the `.ts`
 * source. Run with `node --experimental-vm-modules` (see the `test` script).
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
export default {
  testEnvironment: "node",
  // Tests live under test/ mirroring src/. Keeping them out of src/ means the
  // production build (tsconfig includes only src/**) never emits test code to
  // dist/.
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  extensionsToTreatAsEsm: [".ts"],
  // Runs before any test module is loaded, in every worker. It deletes the
  // variables that change what the server does — the proxy and TLS-trust
  // family, and TASTYTRADE_* — out of the worker's own process.env, so a green
  // run means the same thing on a developer's machine as it does on a clean
  // CI runner. See the file for the failure that produced it: the credential
  // guard reads process.env by design, so a shell with
  // NODE_TLS_REJECT_UNAUTHORIZED=0 exported failed 23 suites.
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  // test/tsconfig.json widens `rootDir` to the repository root so one test file
  // can import another (a shared harness). Under the production config's
  // `rootDir: "./src"` that is TS6059, and ts-jest's ESM path does not suppress
  // it — see test/tsconfig.json for the full explanation.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      { useESM: true, tsconfig: "<rootDir>/test/tsconfig.json" },
    ],
  },
  // Resolve `./foo.js` (ESM-style relative import) back to `./foo` so ts-jest
  // picks up the `.ts` source. Only touches relative paths, never packages.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  clearMocks: true,
  // Coverage is measured across ALL of src/, not just the safety modules.
  //
  // Collecting only src/safety/** plus annotations.ts would collect eight of
  // the twenty-four files under src/, leaving the dispatcher, the HTTP client
  // and the OAuth client with no floor at all — and the safety layer is not the
  // whole of the money-moving path. A tool call reaches it through the
  // dispatcher and leaves through the HTTP client, so a figure that measures
  // only the modules already known to be well covered describes a fraction of
  // what an order passes through. Every file under src/ is collected, so the
  // global floor below is a claim about the whole server.
  collectCoverageFrom: ["src/**/*.ts"],

  // The default reporters, plus `json-summary`.
  //
  // scripts/check-coverage-floors.mjs reads coverage/coverage-summary.json
  // immediately after this run, inside the same gate stage, to check the floors
  // below against what was actually measured. It cannot be a Jest test: the
  // summary is written when the run ENDS, so a test reading it would be reading
  // the previous run's figures, and on a fresh clone there is no previous run
  // to read. Listing the defaults explicitly because naming any reporter
  // replaces the whole set.
  coverageReporters: ["clover", "json", "lcov", "text", "json-summary"],

  // Floors sit a couple of points under what is currently achieved, so
  // incidental churn does not fail the build but a real regression does.
  // Ratchet them UP as coverage improves; never down to accommodate a drop.
  //
  // Every group is annotated with what it currently achieves, in the header's
  // order — statements / branches / functions / lines. Those figures are a
  // claim about the present, and they are checked against the run that just
  // measured them: scripts/check-coverage-floors.mjs fails the gate if an
  // annotation has drifted, or if a floor has fallen far enough below measured
  // coverage to stop being a ratchet. So an annotation that has drifted, and a
  // floor sitting far above what was measured, do not survive a green build. A
  // floor lowered in step with a real drop still passes here — that one is a
  // review responsibility, and CONTRIBUTING.md says so.
  coverageThreshold: {
    // Whole tree. Achieved: 98.3 stmts / 94.3 branch / 97.6 func / 98.7 lines.
    global: { statements: 93, branches: 89, functions: 93, lines: 94 },

    // The safety layer is what stands between an agent and a bad order, so it
    // is held far higher than the tree. Achieved: 100 / 96.4 / 100 / 100.
    "./src/safety/": {
      statements: 98,
      branches: 94,
      functions: 100,
      lines: 100,
    },

    // The dispatcher: every tool call passes through it.
    // Achieved: 98.3 / 93.8 / 98.6 / 99.0.
    "./src/mcp-server/index.ts": {
      statements: 96,
      branches: 91,
      functions: 96,
      lines: 97,
    },

    // The registry that drives both annotations and rate-limit buckets.
    // Achieved: 100 / 100 / 100 / 100.
    "./src/mcp-server/annotations.ts": {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },

    // The only credential path in the server. Achieved: 100 / 97.2 / 100 / 100.
    "./src/oauth-client.ts": {
      statements: 100,
      branches: 95,
      functions: 100,
      lines: 100,
    },

    // The HTTP client's floor is high because two things removed most of its
    // uncovered mass at once: twelve near-duplicate query serializers were
    // consolidated into one, and path construction went from a two-branch
    // helper to one constructor with a case per refusal.
    // Achieved: 97.8 / 86.4 / 98.6 / 98.1, and ratcheted to
    // a couple of points under. Never lower these to accommodate a drop.
    "./src/api-client.ts": {
      statements: 95,
      branches: 84,
      functions: 96,
      lines: 96,
    },
  },
};
