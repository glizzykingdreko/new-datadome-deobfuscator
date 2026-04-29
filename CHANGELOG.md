# Changelog

All notable changes to the DataDome deobfuscator are documented here.

## [Unreleased]

## [1.3.0] - 2026-04-20

### Changed

- **Unified reporting model with `parser/extract_signals/main.js`**. Top-level
  shape is now shared between both tools:
  `{ tool, input, outputDir, timestamp, status, counts, stats, errors, warnings, … }`.
  `tool: 'deobfuscator'` tags every report so a single consumer can tell them
  apart.
- **Stdout after `===DEOBFUSCATOR_RESULT===`** now carries the **full**
  report JSON (same content as `--report`), not the previous compact
  `{status, files, outputDir, errors}` summary. Consumers that only care
  about success vs. error can still read `report.status` — the smaller set
  of fields is a subset of the full payload.

## [1.2.0] - 2026-04-20

CLI refresh to match the `extract_signals/` conventions: named flags, a
richer structured report, and clean exit-code semantics for CI pipelines.

### Added
- **Named CLI flags** (`--input`, `--output`, `--report`, `--log-level`,
  `--no-delimiter`, `--help`). Positional args still work — `node main.js
  input/captcha.js output/captcha/` is unchanged.
- **`--report <path>`** writes a full JSON report to disk with timestamp,
  run status, per-module breakdown (status, errors, warnings, output file +
  size), size stats (`original`, `deobfuscated`, `reduction`, `reductionPercent`),
  and flat `errors` / `warnings` arrays. Missing parent directories are created.
- **`--log-level <LEVEL>`** accepts `DEBUG | INFO | WARN | ERROR | NONE` and
  configures the shared `Logger` instance. Invalid levels exit 1 immediately.
- **`--no-delimiter`** suppresses the `RESULT_DELIMITER` stdout block so the
  process can be piped silently.
- **`--help` / `-h`** prints usage, argument semantics, flags, and exit-code
  table.

### Changed
- **Exit codes** are now documented and consistent:
  - `0` — clean run.
  - `1` — fatal short-circuit (unreadable input, parse error, module-separation
    crash, unknown `--log-level`, unexpected exception).
  - `2` — finished but at least one module recorded an error worth reviewing.
  Warnings from VM evaluation no longer bump the exit code on their own.
- **Stdout contract preserved**. The `===DEOBFUSCATOR_RESULT===` line still
  precedes a compact `{status, files, outputDir, errors}` JSON — existing
  consumers (`monitor/`, parent `parser/index.js`) keep working.
- **Output directories** are now created lazily via `fs.mkdirSync(..., { recursive: true })`
  so a non-existent `--output ./new/dir/` no longer fails with ENOENT.

## [1.1.0] - 2026-04-17

Major overhaul — tags support, full decoder resolution, opaque-predicate folding.
Produces zero residual decoder calls, zero mojibake escape sequences, and zero
unflattened state machines across all three reference inputs (captcha, interstitial, tags).

### Added
- **Tags bundle support** — `scorporateCaptchaModules` now detects the Rollup-style
  `var X = (() => {...})()` shape and emits a single-module bundle named `jstag`.
  Tags were previously unsupported; the separator threw "Could not find module
  bundler IIFE in AST".
- **Tags matrix fallback** (`tryTagsMatrixFallback` in `transformers/index.js`) —
  detects tags' setTimeout-scheduled matrix population pattern (`E[O][i] = E[<hash>]`),
  extracts the matrix name, size, hash expression, and target-row assignment from
  the AST, synthesizes a bounded equivalent loop, and runs it in a VM. Builds the
  same `tMap["g[x][y]"]` format the existing `replaceTMatrix` pass consumes, so no
  downstream changes needed.
- **Phase 3.5: recursive decoder harvest** (`preprocessing/index.js`) — walks the
  entire AST (not just `program.body[1]`) to collect:
    - **Pure MBA helpers** (`function f(a, b) { return …pure arithmetic…; }`) —
      sorted deepest-first and loaded in that order so shallower declarations win.
    - **Decoder-like helpers** (single-param, no `this` / `new` / `try` / self-recursion) —
      loaded only when the name isn't already in context.
    - **Array-init declarations** (`var t = [...long…]`) — same skip-if-name-taken
      rule to avoid clobbering globals.
  Required for tags (whose decoders live deep inside closures) without breaking
  captcha/interstitial (whose decoders live at module top level).
- **Phase 4.5: global-method folding** (`preprocessing/index.js`) — folds
  `Math.ceil(764.31)`, `A.Math.floor(-196.24)`, `A.Number(-1560)`,
  `A.parseInt(13.37)`, `String.fromCharCode(N)`, etc. when all args are literals.
  Works on any alias of the global (tags aliases `window` as `A`; this is
  version-agnostic — it matches by callee shape, not by identifier name).
- **`setTimeout(fn, 0)` unwrapping** (`transformations/inline-settimeout.js`) —
  unwraps zero-delay timer wrappers used as control-flow obfuscation. Tags
  decorates plain assignments with hundreds of these
  (`setTimeout(function(){ t = 26; }, 0), setTimeout(function(){ z = -192; }, 0), …`).
  Non-zero delays are preserved (they're real async scheduling).
- **Opaque-predicate folding** (`transformations/opaque-predicates.js`) — folds
  MBA (Mixed Boolean-Arithmetic) expressions via random-sample evaluation:
    - **Constant fold**: if the expression produces the same value across 20+
      samples of its free variables, replace with that literal.
    - **Linear fit**: if the expression matches `a*x + b*y + c` with small
      integer coefficients on 40+ samples, emit the simpler linear form.
  Handles both purely-opaque predicates (`<MBA> > -388` always true/false) and
  MBA-obfuscated arithmetic (`<MBA>` = `F - 880` for some decoded variable `F`).
- **Empty-init + red-herring for-loop support** (`transformations/switch-case.js`) —
  state machines like `r = 124; for (; true;) switch(r) {…}` and
  `for (var eA = 544; true;) switch(r) {…}` (where `eA` is a decoy) now resolve
  their initial state by scanning statements above the loop.
- **Iterative switch-case unflattening** — runs twice, once before and once after
  `removeUnusedVariables`, because stripping the decoy for-init declarations
  exposes state machines that were previously hidden.
- **Call-text failure cache in Phase 4** — each unique `fn(args)` text is
  evaluated at most once across all iterations. Prevents quadratic retries when
  a decoder legitimately fails for a specific argument combination.

### Fixed
- **Pure-helper same-name collisions** — a deeply-nested `function E(A)` could
  override the top-level pure `function E(A, w)` because both pass the "single
  return of pure arithmetic" check. Now sorted by nesting depth, shallowest wins.
  Caused mojibake (`\uFFFF`, `\xFF`-prefix bytes) in every downstream decoder
  call whose alphabet relied on the clobbered helper.
- **Native functions overridden by pure-helper lookalikes** — interstitial's
  `var c = String.fromCharCode` was getting overwritten by a nested
  `function c(A) { return A > 37 ? 59 + A : …; }` during Phase 3.5. Now skips
  override when `context[name]` is a native function (detected via
  `Function.prototype.toString` → `[native code]`).
- **Nested array declarations clobbering global helpers** — Phase 3.5 was
  promoting every `var X = [...]` in the AST (including deeply nested ones like
  `for (var c = [C(948), 'bitness', …], n = [], g = 0; …)`) to global scope,
  overwriting same-named pure helpers. Now skips when the name is already bound.
- **Recursive functions causing infinite stack overflows** — pre-1.1 Phase 3.5
  loaded all function declarations including obviously-recursive ones; Phase 4
  would then stack-overflow on each call to them and retry on every iteration,
  producing 20,000+ errors. `isHarvestable` / `isPureHelper` / `isDecoderLike`
  now reject functions with `try/catch`, `new`, `this`, or direct self-recursion.
- **`undefined` and mojibake strings inlined into AST** — Phase 4 now rejects:
    - `dec === undefined` (outright)
    - Strings containing `\uFFFD` / `\uFFFF` (mojibake markers)
    - Long strings that are mostly non-printable
    - Empty strings in computed-member-expression property position
      (`obj[""]` is meaningless)
    - Non-integer / negative / oversized numbers in property position
      (`w[-2051.61]` pattern)
- **Strings in member-expression object position rejected too aggressively** —
  the blanket "don't inline if we're the object of a member expression" guard
  was blocking `n(1093)` → `"l:"` in valid contexts like `n(1093).concat(msg)`.
  Narrowed to reject only non-strings.
- **Phase 4 numeric-literal check** now also accepts `UnaryExpression`
  wrapping a `NumericLiteral` (i.e. `-42`, `+42`), so calls with negative-literal
  arguments (`xn(-73, -192)`, `D(-430, -18)`, …) get folded.
- **Phase 4 result guard** now allows `null` results through. Previously
  `typeof null === "object"` tripped the object-result rejection, leaving every
  `M(52)` style call (table entry is `null`) unresolved.
- **TOTAL_FAILURE_LIMIT panic brake** (100k) as an absolute watchdog against
  runaway VM evaluation loops. Legitimate workloads produce ~150 cheap throws;
  we never approach this.
- **`vm.runInContext({ timeout: 50 })`** belt-and-braces circuit breaker on
  every Phase 4 evaluation.

### Performance
All three reference inputs now deobfuscate in under 4 seconds each:
- captcha-def5678.js (504 KB input, 9 modules) — **3.7s**
- interstitial-af0108e.js (464 KB input, 7 modules) — **3.7s**
- tags-25ba714.js (111 KB input, 1 module) — **3.3s**

## [1.0.1] - 2026-04-13

### Fixed
- **Switch-case unflattening failing on chained assignments** — When the loop init used a chained assignment like `var m = r = 39`, the deobfuscator couldn't extract the initial state value because `getInitialState()` only checked `d.id.name === stateVar`. Since the declarator's `id` is `m` (not `r`), it returned `null` and skipped the entire state machine. Now handles `AssignmentExpression` inside declarator inits to correctly extract the state variable's initial value. Also unwraps the chained assignment in `keepDecls` so retained variables get clean initializers (`var m = 39` instead of `var m = r = 39`).

## [1.0.0] - 2026-04-12

### Added
- Initial deobfuscator pipeline
- Hex string decoding
- VM-based string cleaning (8 sub-phases)
- t-matrix (`t[x][y]`) resolution via VM execution
- Iterative transformation passes: expression, conditional, if-statement simplification
- Switch-case state machine unflattening
- Unused variable removal
- Module separation and extraction (captcha, interstitial, jstag)
- CLI interface (`node main.js <input> <output>`)
