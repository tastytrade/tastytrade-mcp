import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "tastytrade-llms-txt-docs/**",
      // Local-only developer tooling. /dev is gitignored and is never part of
      // a clone, so this entry only bites in a working tree that has one.
      "dev/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Declare the Node runtime for plain JS/ESM files.
    //
    // The flat config sets no environment globals, and `src/` only escapes
    // `no-undef` because typescript-eslint waives that rule for .ts files —
    // TypeScript already resolves globals through @types/node. Untyped .mjs
    // (this config, jest.config.mjs, scripts/, and any future script) gets no
    // such waiver, so `console`, `process` and the timers read as undefined.
    //
    // Declaring the runtime is the honest fix; switching `no-undef` off would
    // lose a real check.
    files: ["**/*.mjs", "**/*.js", "**/*.cjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        fetch: "readonly",
      },
    },
  },
  {
    rules: {
      // Agent input and the tastytrade HTTP boundary are intentionally `any`.
      // Correctness lives in the runtime validation/translation layer
      // (validateLegActions, sanity-checks, the ToolError adapter), not in
      // banning the type at these seams — so flagging it here is pure noise.
      "@typescript-eslint/no-explicit-any": "off",
      // Every case in the dispatcher's tool switch returns, so per-case block
      // scoping guards against a TDZ bug that cannot occur here.
      "no-case-declarations": "off",
      // Allow intentionally-unused names when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Must come last: turns off ESLint rules that would fight Prettier.
  eslintConfigPrettier,
);
