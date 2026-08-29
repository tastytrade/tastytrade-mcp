#!/usr/bin/env bash
#
# build.sh — the single quality gate for this repo.
#
# Runs the full battery and FAILS on the first problem. Every stage must pass
# before code is committed or a PR is opened. The CI pipeline runs this exact
# script; run it locally before pushing.
#
#   1. install     reproducible deps from the lockfile (npm ci)
#   2. format      Prettier — no unformatted files
#   3. lint        ESLint — zero errors
#   4. typecheck   tsc --noEmit — zero type errors
#   5. build       tsc -> dist/ (compiler output; not committed)
#   6. test        Jest battery + coverage thresholds
#   7. audit       npm audit — fails on any HIGH or CRITICAL advisory
#   8. secrets     gitleaks — no secret-shaped value in the tree
#
# Keep this list and `stages_total` below in step with the stages themselves;
# the assertion at the bottom fails the gate if the count drifts.
#
# Usage:
#   ./build.sh                 # full gate (clean install)
#   SKIP_INSTALL=1 ./build.sh  # reuse existing node_modules (fast local re-run)
#
set -euo pipefail
cd "$(dirname "$0")"

# ---- pretty output -------------------------------------------------------
if [ -t 1 ]; then
  bold=$(printf '\033[1m'); green=$(printf '\033[32m'); red=$(printf '\033[31m')
  yellow=$(printf '\033[33m')
  blue=$(printf '\033[34m'); reset=$(printf '\033[0m')
else
  bold=""; green=""; red=""; blue=""; yellow=""; reset=""
fi
step=0
stages_total=8
stage() { step=$((step + 1)); printf "\n%s==> [%d/%d] %s%s\n" "$blue$bold" "$step" "$stages_total" "$1" "$reset"; }
ok()    { printf "%s    ✓ %s%s\n" "$green" "$1" "$reset"; }
fail()  { printf "%s    ✗ %s%s\n" "$red$bold" "$1" "$reset"; exit 1; }

# ---- toolchain check -----------------------------------------------------
command -v node >/dev/null 2>&1 || {
  printf "%snode not found on PATH. Activate Node (e.g. 'fnm use') and retry.%s\n" "$red" "$reset"
  exit 1
}
printf "%sToolchain%s  node %s · npm %s\n" "$bold" "$reset" "$(node -v)" "$(npm -v)"

# ---- 1. install ----------------------------------------------------------
stage "Install dependencies (npm ci)"
if [ "${SKIP_INSTALL:-}" = "1" ]; then
  ok "skipped (SKIP_INSTALL=1) — reusing existing node_modules"
else
  npm ci || fail "dependency install failed (lockfile out of sync?)"
  ok "dependencies installed from lockfile"
fi

# ---- 2. format -----------------------------------------------------------
stage "Format check (prettier --check)"
npm run --silent format:check || fail "unformatted files — run 'npm run format' to fix"
ok "all files formatted"

# ---- 3. lint -------------------------------------------------------------
stage "Lint (eslint)"
npm run --silent lint || fail "lint errors"
ok "no lint errors"

# ---- 4. typecheck --------------------------------------------------------
stage "Typecheck (tsc --noEmit)"
npm run --silent typecheck || fail "type errors"
ok "no type errors"

# ---- 5. build ------------------------------------------------------------
#
# dist/ is removed first so the build is authoritative rather than cumulative.
# `tsc` writes the files it emits and never deletes the ones it no longer emits,
# so renaming or deleting a module leaves its stale .js behind — and dist/ is not
# tracked, so nothing else would ever point that out. A stale module that still
# resolves is exactly the kind of thing that gets published in a tarball or baked
# into an image and then behaves differently from src/.
stage "Build (tsc -> dist/)"
rm -rf dist
npm run --silent build || fail "build failed"
[ -f dist/index.js ] || fail "build produced no dist/index.js"
ok "build succeeded"

# ---- 6. test -------------------------------------------------------------
stage "Test battery + coverage (jest)"
npm run --silent test:coverage || fail "tests failed or coverage below threshold"
# Jest enforces the floors; on its own, nothing enforces the policy ABOVE them.
# The config says its thresholds "sit a couple of points under what is currently
# achieved" and ratchet up, and a floor left far under real coverage lets a large
# share of that file's branch coverage be lost with this stage still green. This
# reads the summary the run
# just wrote, which is why it lives here rather than in a test: inside the run
# the file is the PREVIOUS run's, and on a fresh clone there is no file at all.
node scripts/check-coverage-floors.mjs ||
  fail "coverage floors have drifted from measured coverage — see above"
ok "tests passed, coverage thresholds met, floors still ratcheted"

# ---- 7. audit ------------------------------------------------------------
stage "Dependency audit (no HIGH / CRITICAL)"
npm audit --audit-level=high || fail "high/critical advisory present — run 'npm audit' for detail"
ok "no high or critical advisories"

stage "Secret scan (gitleaks)"
# Scans exactly what SHIPS: the working-tree content of every TRACKED file,
# copied into a temp directory first.
#
# `gitleaks dir .` was the obvious approach and the wrong one — it walks the
# filesystem and ignores .gitignore, so it reported the developer's own .env
# (real credentials, which is why it is gitignored) on every run. Suppressing
# that with path exclusions meant maintaining a list of things NOT to look at,
# which is the kind of list that quietly grows until the scan means nothing.
# `git ls-files` is the definition of what ships, so scanning that needs no
# exclusions at all.
#
# Three times during hardening a synthetic credential fixture written to
# exercise the redaction code tripped the scanner and was caught only at publish
# time. .gitleaks.toml documents the convention that avoids it: satisfy the
# redaction regexes' length floors WITHOUT the entropy.
#
# Skipped, loudly, when gitleaks is absent so a contributor without it is not
# blocked; CI installs it, so the check is enforced there.
if command -v gitleaks >/dev/null 2>&1; then
  scan_dir=$(mktemp -d)
  trap 'rm -rf "$scan_dir"' EXIT
  git ls-files | while IFS= read -r f; do
    mkdir -p "$scan_dir/$(dirname "$f")"
    cp "$f" "$scan_dir/$f"
  done
  gitleaks dir "$scan_dir" --config .gitleaks.toml --no-banner --redact \
    --exit-code 1 >/tmp/gitleaks-gate.log 2>&1 ||
    {
      sed "s|$scan_dir/||g" /tmp/gitleaks-gate.log | tail -20 >&2
      fail "gitleaks found a secret-shaped value — see above and .gitleaks.toml"
    }
  ok "no secrets detected in $(git ls-files | wc -l | tr -d ' ') tracked files"
else
  printf "    %s!%s gitleaks not installed — secret scan SKIPPED (CI enforces it)\n" "$yellow" "$reset"
fi

# ---- the stage labels must not lie -----------------------------------------
# Every stage announces itself as "[n/$stages_total]", so adding or removing a
# stage without updating the total prints a count that is quietly wrong — and a
# gate whose own output cannot be trusted is the wrong place to start. Cheap to
# assert, so assert it.
if [ "$step" -ne "$stages_total" ]; then
  fail "gate ran $step stages but is labelled [n/$stages_total] — update stages_total in build.sh"
fi

printf "\n%s%s✓ BUILD GREEN — all %d gates passed.%s\n" "$green" "$bold" "$stages_total" "$reset"
