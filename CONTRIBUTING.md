# Contributing

## The gate

`./build.sh` decides whether a change is shippable. CI runs the identical script,
so a green local run and a green CI run are the same run. It fails fast, in
order:

1. `npm ci` — reproducible install from the lockfile
2. `prettier --check`
3. `eslint` — zero errors
4. `tsc --noEmit`
5. `tsc` → `dist/`
6. Jest, including coverage thresholds
7. `npm audit` — fails on any HIGH or CRITICAL advisory
8. `gitleaks` — no secret-shaped value in the tree

```bash
./build.sh                 # everything
SKIP_INSTALL=1 ./build.sh  # reuse node_modules
```

**Never weaken a gate to make it pass.** No `passWithNoTests`, no `--no-audit`,
no blanket lint disables, no lowering a coverage floor to match a drop. Fix the
cause.

## Running tests

```bash
npm test
npm test -- test/safety/confirmation.test.ts
npm test -- -t "substring of the test name"
```

Always go through `npm test`, **never a bare `npx jest`**. The package script is
what supplies `--experimental-vm-modules`; without it ts-jest falls back to its
non-ESM path and any suite that reaches an `import.meta` source fails with
`TS1343`. Worse, it fails _selectively_, so a bare run can look green on the file
you are editing and still be red in the gate.

Tests live in `test/` mirroring `src/`, deliberately outside `src/` so they never
compile into `dist/`. Relative imports use the `.js` extension, same as `src/`.

## Adding a tool

Four coordinated edits, or it will not load:

1. the API method in `src/api-client.ts`
2. the Tool definition in `getTools()` in `src/mcp-server/index.ts`
3. the `TOOL_ANNOTATIONS` entry — `ListTools` throws without it
4. the `case` in `handleToolCall()`

Presentation metadata (title, description, `outputSchema`) goes in
`src/mcp-server/tool-metadata.ts`. A destructive tool additionally needs a
matching `dry_run_*` variant that issues the confirmation token.

## Conventions

- **ESM imports need `.js` extensions**, even though the source is `.ts`.
- **stdout is reserved for the MCP protocol.** All logging goes to
  `console.error`. Never `console.log` in a server code path.
- **The client speaks kebab-case only.** Agent-facing schemas are snake_case; the
  translation seam lives in the dispatcher. Never leak snake_case into
  `api-client.ts`, and never expose kebab-case in a tool schema.
- **An `outputSchema` constraint is a rejection rule handed to the client**,
  applied to data the broker authors. Prefer `type: "string"` with the known
  values in the description over an `enum` the API could outgrow.
- A test fixture that stands in for a credential must satisfy the redaction
  length floor **without** the entropy — see `.gitleaks.toml`.

## Safety-critical code

Anything under `src/safety/` gates a money-moving call. Two rules:

- **A check that cannot be performed refuses.** "We compared `NaN`" is not "we
  looked and it was fine".
- **Never emit a value a consumer cannot distinguish from a successfully-read
  one.** A number that could not be read is `null`, never `0`; a collection is
  `null`, never `[]`. Whichever way a failure is handled, it is visible in the
  response.

Changes there need tests that fail without the change.

## Pull requests

One logical change per PR, with tests. Keep the diff reviewable: separate
generated output, lockfile churn and mechanical sweeps from logic a human has to
read. Say explicitly which parts are not covered by a feature flag.
