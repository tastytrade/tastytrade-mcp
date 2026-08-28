/**
 * Check jest.config.mjs's coverage floors — and the "Achieved:" figures written
 * beside them — against what the run that just finished actually measured.
 *
 * WHY THIS EXISTS
 *
 * jest.config.mjs states a policy about itself: "Floors sit a couple of points
 * under what is currently achieved... Ratchet them UP as coverage improves;
 * never down." The floors are enforced by Jest. The policy is not, and the
 * "Achieved:" annotations beside each group are the only way a maintainer can
 * check it — so when they rot, the policy lapses silently. It had: the HTTP
 * client's branch floor sat 22.5 points under its real coverage, on the one
 * file CONTRIBUTING.md singles out as never to be lowered, which means a fifth
 * of its branch coverage could have been lost with the gate still green.
 *
 * WHAT IT DOES NOT CHECK, AND WHY NOT
 *
 * It checks FRESHNESS, not monotonicity. A floor lowered in step with a real
 * drop in coverage — 64 down to 57 against a measured 59.73 — passes here, and
 * passes Jest, and is exactly what CONTRIBUTING.md's policy forbids. That is a
 * review responsibility, and CONTRIBUTING.md says so in those words rather than
 * claiming this script covers it.
 *
 * Making it a real ratchet needs a previous revision to compare against, and
 * every available one is wrong in a way that matters more than the gap. The CI
 * checkout is `fetch-depth: 1`, so there is no history in the environment the
 * check most needs to work in; `HEAD` is the working tree's own base, so it
 * catches an uncommitted lowering and nothing after the commit; and a merge
 * base against the default branch is vacuous on the default branch itself and
 * vacuous again for a stack of branches cut from a shared integration commit,
 * which is how this repository is currently developed. A control that is
 * vacuous in three of four situations, and fails open in the fourth, is worse
 * than an honest sentence about what a reviewer has to do. A committed
 * high-water file is no better: lowering it is the same edit, in a second file.
 *
 * WHY IT IS NOT A JEST TEST
 *
 * It needs the measured figures, and the only honest source of those is a run
 * that has finished. coverage/coverage-summary.json is written when the run
 * ends, so a test reading it inside the run reads the PREVIOUS run's numbers,
 * and in CI or a fresh clone there is no previous run at all — a check that
 * silently passes in the one environment that matters is worse than none. Run
 * from ./build.sh immediately after `npm run test:coverage`, the file is both
 * present and fresh by construction. The logic below is nonetheless exported
 * and pure, so it is exercised offline; only the reading of
 * the two files is left to `main`.
 *
 * Usage: node scripts/check-coverage-floors.mjs
 */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * How far a floor may sit below measured coverage before it stops being a
 * ratchet and starts being decoration. Loose enough that ordinary improvement
 * does not fail the gate the moment it lands; tight enough that the 22.5-point
 * gap this exists to prevent cannot reappear.
 */
export const MAX_FLOOR_SLACK = 8;

/**
 * How far an "Achieved:" annotation may sit from the measured figure. Tighter
 * than the floor slack because the annotation is a factual claim about the
 * present, not a safety margin: if it is out by more than rounding and a little
 * churn, the file is telling its next reader something untrue.
 */
export const MAX_ANNOTATION_DRIFT = 3;

export const METRICS = ["statements", "branches", "functions", "lines"];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The "Achieved: a / b / c / d" figures annotated against each threshold group.
 *
 * Read from the source text rather than the module, because they are comments.
 * A group's annotation is the last one written before its key, which is the
 * convention the file already follows; a group with none comes back undefined
 * and is reported as unannotated rather than skipped.
 */
export function annotatedFigures(source, groups) {
  const keyAt = (group) => {
    const key = new RegExp(
      `^\\s*(?:"${escapeRegExp(group)}"|${escapeRegExp(group)})\\s*:\\s*\\{`,
      "m",
    );
    return key.exec(source)?.index ?? -1;
  };
  const ordered = groups
    .map((group) => ({ group, at: keyAt(group) }))
    .sort((a, b) => a.at - b.at);

  const figures = {};
  let from = 0;
  for (const { group, at } of ordered) {
    if (at === -1) {
      figures[group] = undefined;
      continue;
    }
    const preamble = source.slice(from, at);
    from = at;
    // Four slash-separated figures immediately after the marker, each allowed
    // a unit word ("95.2 stmts / 91.2 branch / ..."), and allowed to wrap onto
    // the next comment line. Deliberately strict about the shape rather than
    // hunting for the next four numbers anywhere after the marker: this file's
    // own prose discusses coverage figures, and a loose pattern read the first
    // numbers of a sentence as an annotation.
    const ANNOTATION =
      /Achieved:\s*(?:\/\/\s*)?(\d[\d.]*)\s*[a-z]*\s*\/\s*(\d[\d.]*)\s*[a-z]*\s*\/\s*(\d[\d.]*)\s*[a-z]*\s*\/\s*(\d[\d.]*)/g;
    const matches = [...preamble.matchAll(ANNOTATION)];
    const last = matches.at(-1);
    figures[group] = last
      ? Object.fromEntries(
          METRICS.map((metric, i) => [metric, Number(last[i + 1])]),
        )
      : undefined;
  }
  return figures;
}

/**
 * The same path as the filesystem finally sees it, so two spellings of one file
 * compare equal.
 *
 * A checkout reached through a symlink — /tmp on macOS, a worker's workspace
 * link in CI, a git worktree under a linked directory — resolves the group
 * pattern to the symlinked spelling and the summary's rows to the real one.
 * path.resolve does not follow links, so every file and directory group
 * reported "no coverage was measured for this group" and the gate failed with
 * a message about the wrong thing entirely. It fails closed, which is the right
 * direction, but a CI break nobody can diagnose costs a morning.
 */
const settled = (target) => {
  try {
    return realpathSync(target);
  } catch {
    // A group naming a file that does not exist is a real problem and is
    // reported below as one; it must not throw out of the comparison first.
    return target;
  }
};

/**
 * Measured coverage for one threshold group.
 *
 * `global` is the run's own total. A group naming a file is that file's row. A
 * group naming a directory is every row beneath it, re-totalled from the
 * covered/total counts — averaging the percentages would weight a ten-line
 * module the same as a four-thousand-line one.
 */
export function measuredFor(group, summary, repoRoot = REPO_ROOT) {
  if (group === "global") return summary.total;

  const target = settled(path.resolve(repoRoot, group));
  const rows = Object.entries(summary).filter(([file]) => {
    if (file === "total") return false;
    const resolved = settled(path.resolve(file));
    return group.endsWith("/")
      ? resolved.startsWith(`${target}${path.sep}`)
      : resolved === target;
  });
  if (rows.length === 0) return undefined;

  const totalled = {};
  for (const metric of METRICS) {
    const covered = rows.reduce((sum, [, r]) => sum + r[metric].covered, 0);
    const total = rows.reduce((sum, [, r]) => sum + r[metric].total, 0);
    totalled[metric] = { pct: total === 0 ? 100 : (covered / total) * 100 };
  }
  return totalled;
}

/**
 * Everything wrong with one set of floors, given what was measured. Empty when
 * the configuration and the run agree.
 */
export function floorProblems({ thresholds, annotated, summary, repoRoot }) {
  const problems = [];
  for (const [group, floors] of Object.entries(thresholds)) {
    const measured = measuredFor(group, summary, repoRoot);
    if (measured === undefined) {
      problems.push(
        `${group}: no coverage was measured for this group — it matches no file, ` +
          `so its floors gate nothing.`,
      );
      continue;
    }
    const achieved = annotated[group];
    if (achieved === undefined) {
      problems.push(
        `${group}: no "Achieved:" annotation. Every threshold group carries one, ` +
          `because the floors alone do not say whether the ratchet has been kept.`,
      );
    }
    for (const metric of METRICS) {
      const now = measured[metric].pct;
      const floor = floors[metric];
      if (floor === undefined) {
        // Nothing else catches this. Jest applies no default for a metric a
        // group omits, and the arithmetic below reads `now < undefined` as
        // false and `now - undefined > 8` as NaN > 8, also false — so a group
        // that simply drops a line gates that metric nowhere, silently, which
        // is the exact failure mode this script was written to end.
        problems.push(
          `${group}.${metric}: no floor at all. A threshold group that omits a ` +
            `metric gates it nowhere — Jest applies no default, and this check ` +
            `has nothing to compare. Give it one, a couple of points under the ` +
            `measured ${now.toFixed(2)}.`,
        );
        continue;
      }
      if (now < floor) {
        // Jest fails first, so reaching this means the two disagree about which
        // files the group covers — worth saying out loud rather than swallowing.
        problems.push(
          `${group}.${metric}: measured ${now.toFixed(2)} is below the floor ${floor}.`,
        );
      } else if (now - floor > MAX_FLOOR_SLACK) {
        problems.push(
          `${group}.${metric}: floor ${floor} sits ${(now - floor).toFixed(1)} ` +
            `points under the measured ${now.toFixed(2)}. Ratchet it up to a ` +
            `couple of points under and update the "Achieved:" line beside it.`,
        );
      }
      if (
        achieved !== undefined &&
        Math.abs(achieved[metric] - now) > MAX_ANNOTATION_DRIFT
      ) {
        problems.push(
          `${group}.${metric}: annotated as ${achieved[metric]}, measured ` +
            `${now.toFixed(2)}. Correct the "Achieved:" line.`,
        );
      }
    }
  }
  return problems;
}

async function main() {
  const summaryPath = path.join(REPO_ROOT, "coverage", "coverage-summary.json");
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    console.error(
      `No ${path.relative(REPO_ROOT, summaryPath)}. Run 'npm run test:coverage' ` +
        `first — this check reads the summary that run writes.`,
    );
    process.exit(1);
  }

  const configPath = path.join(REPO_ROOT, "jest.config.mjs");
  const { default: config } = await import(pathToFileURL(configPath).href);
  const thresholds = config.coverageThreshold;
  const problems = floorProblems({
    thresholds,
    annotated: annotatedFigures(
      readFileSync(configPath, "utf8"),
      Object.keys(thresholds),
    ),
    summary,
    repoRoot: REPO_ROOT,
  });

  if (problems.length > 0) {
    console.error("jest.config.mjs's coverage floors have drifted:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nThe file's own policy: floors sit a couple of points under what is " +
        "currently achieved, and ratchet UP, never down.",
    );
    process.exit(1);
  }

  console.log(
    `coverage floors in step with measured coverage across ${Object.keys(thresholds).length} threshold groups`,
  );
}

// Importable for its tests, executable for the gate. `process.argv[1]` is the
// script path when it was run directly and something else when it was imported.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
