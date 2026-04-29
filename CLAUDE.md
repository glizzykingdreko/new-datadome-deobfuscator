# Deobfuscator — Agent Instructions

This is a Babel AST-based JavaScript deobfuscator for DataDome's client-side scripts. Read this file fully before making any changes. For an in-depth walkthrough of the obfuscation patterns, pipeline rationale, and historical fixes, see [LEARN.md](./LEARN.md).

## Table of Contents

- [Architecture](#architecture)
- [How Transformations Work](#how-transformations-work)
- [VM Evaluation](#vm-evaluation)
- [Common Patterns in the Obfuscated Code](#common-patterns-in-the-obfuscated-code)
- [Testing Changes](#testing-changes)
- [Rules](#rules)
- [Debugging playbook](#debugging-playbook)
- [Related work / other repos](#related-work--other-repos)
- [Need DataDome Bypass Solutions?](#need-datadome-bypass-solutions)

## Architecture

### Entry Point

`main.js` is the CLI. It reads an obfuscated JS file, parses it into an AST, runs the full pipeline, and writes separated module files. You should not need to modify `main.js` unless changing CLI behavior or the top-level orchestration.

### Pipeline Flow

The deobfuscation runs in strict order. Each phase depends on the previous one:

```
Input JS → Parse AST
  → Hex string decoding + bracket cleanup (captcha.js)
  → Module separation (captcha.js — detects all 3 bundle shapes)
  → For each module (captcha/interstitial/jstag):
      → t-matrix generation (transformers/index.js)
          · captcha/interstitial: extract `var e = (function(){...})()` IIFE, run in VM
          · tags: tryTagsMatrixFallback — detects setTimeout-scheduled population,
            synthesizes bounded equivalent, runs in VM
      → Preprocessing (preprocessing/index.js)
          → Binary expression simplification
          → setTimeout(fn, 0) unwrap (inline-settimeout.js)
          → VM-based string cleaning
              · Phase 1: String.fromCharCode / window-alias / matrix helper
              · Phase 2: top-level function/array declarations into VM context
              · Phase 3: additional var declarations
              · Phase 3.5: recursive harvest — pure MBA helpers (depth-sorted,
                         skip-native-overrides) + decoder-likes + array inits
                         (skip-if-name-taken to avoid clobbering)
              · Phase 4: fold `fn(numLit, numLit)` calls, with guards for
                         undefined / mojibake / floats-as-property / etc.
              · Phase 4.5: fold Math.*, Number, parseInt, String.fromCharCode
                         on any alias
              · Phase 5: remove ddResObj, find window name
              · Phase 6: eval Math/Number/parseInt on aliased-window
              · Phase 7: replace obfuscated array accesses
          → Member expression cleanup (cleanBinaryAndMemberExpressions)
      → Iterative transformation passes (up to 10):
          → t-matrix replacement (transformations/t-matrix.js)
          → Conditional simplification (transformations/conditionals.js)
          → Expression simplification (transformations/expressions.js)
          → If-statement simplification (transformations/if-statements.js)
          → Opaque-predicate folding (transformations/opaque-predicates.js)
      → Switch-case state machine unflattening — pass 1 (transformations/switch-case.js)
      → Unused variable removal (transformations/unused-vars.js)
      → Switch-case unflattening — pass 2 (catches state machines exposed
                                            when decoy for-inits are stripped)
  → Code generation + file output
```

### Key Directories

| Path | Purpose |
|------|---------|
| `transformers/index.js` | Main `deobfuscate()`, `generateTMap()`, `tryTagsMatrixFallback()` |
| `transformers/preprocessing/index.js` | String cleaning, VM evaluation, binary simplification, Phase 3.5 recursive harvest, Phase 4/4.5 call folding |
| `transformers/transformations/` | All AST transformation passes (one file per pass) |
| `transformers/transformations/opaque-predicates.js` | MBA constant-fold + linear-fit |
| `transformers/transformations/inline-settimeout.js` | `setTimeout(fn, 0)` unwrap |
| `transformers/transformations/switch-case.js` | State machine unflattening (runs twice) |
| `transformers/postprocessing/index.js` | Module extraction logic |
| `transformers/captcha.js` | Module separation (all 3 bundle shapes), hex decoding, bracket-to-dot conversion |
| `transformers/logger.js` | Logger with levels (DEBUG/INFO/WARN/ERROR) |
| `transformers/errors.js` | Error codes, `DeobfuscationResult` class |
| `input/` | Obfuscated source files (captcha.js, interstitial.js, tags.js) |
| `output/` | Deobfuscated output, organized by script type |
| `LEARN.md` | In-depth pipeline walkthrough + historical fixes log |
| `CHANGELOG.md` | Version history |

## How Transformations Work

Every transformation file in `transformations/` exports a single function with the signature:

```js
function transformName(ast, logger = null, result = null) → boolean
```

- `ast` — the Babel AST (mutated in place)
- `logger` — optional Logger instance
- `result` — optional DeobfuscationResult for stats tracking
- Returns `true` if any changes were made, `false` otherwise

The return value drives the iterative pass loop in `transformers/index.js`. If no transformation returns `true`, the loop stops.

### Adding a New Transformation

1. Create a new file in `transformers/transformations/` following the same pattern
2. Export a single function with the `(ast, logger, result) → boolean` signature
3. Add it to `transformers/transformations/index.js` exports
4. Wire it into the pass loop in `transformers/index.js` (inside the `while (changed)` block)
5. Add a stats counter in `errors.js` if you want to track it

### Switch-Case Unflattening (Important Context)

The obfuscator flattens sequential code into state machines:

```js
for (var x = state = 42; true;) {
  switch (state) {
    case 42: case 99:  doThing(); state = 55; continue;
    case 55: case 13:  doOther(); state = 30; continue;
    case 30: case 77:
  }
  break;
}
```

Each "real" case has two labels (the actual state + a decoy). The deobfuscator in `switch-case.js`:
- Finds the state variable from the switch discriminant
- Extracts the initial state from the loop init (handles `var x = state = N` chained assignments)
- Follows state transitions by reading assignments to the state variable
- Outputs the statements in execution order

**Watch out for:** The `indexByValue` map stores the **last** index for duplicate case values. The `coalesceBody` function handles fall-through by scanning forward for non-empty bodies. These two behaviors together correctly resolve the dual-label pattern.

### Red-herring for-inits and two-pass unflattening

The obfuscator also pads some for-inits with unused declarations that shadow the real pattern:

```js
r = 124;
for (var eA = 544; true;) {       // eA is never used; r is the real state var
  switch (r) { /* … */ }
}
```

`getInitialState` detects this: when the for-init is a `VariableDeclaration` that doesn't touch the switch's state variable, it falls through to the "look above the loop" scan for an `r = N` assignment or `var r = N` declaration.

The main pipeline runs the unflattener **twice** — once before `removeUnusedVariables`, once after. The first pass handles straightforward cases; stripping unused variables then removes decoy for-inits, and the second pass picks up whatever the first pass couldn't read.

### Phase 3.5 — recursive decoder harvest

Required for tags. The top-level passes (1–3) only walk `program.body[1]`; tags' decoders (`K`, `M`, `rn`, `cn`, `hn`, `tn`, `en`, …) live deep inside `function I(){…}`, so the top-level passes never see them.

Phase 3.5 walks the **entire AST** and classifies each `FunctionDeclaration`:

- **Pure MBA helpers** — single `return` statement over arithmetic / bitwise / ternary / assignment / sequence expressions on params and literals. Sorted **deepest-first** and loaded in that order so the shallowest declaration overwrites deeper ones (prevents a nested `function E(A)` from clobbering a top-level `function E(A, w)`).
- **Decoder-like helpers** — 1–4 params, no `this` / `new` / `try` / direct self-recursion. Loaded only when the name isn't already in context (prevents clobbering top-level decoders with their nested look-alikes).
- **Array-init `VariableDeclaration`s** — same skip-if-name-taken rule (prevents `for (var c = [C(948), …], n = [], g = 0; …)` from clobbering a top-level `function c(A, w)`).

Extra guard: **never overwrite a native function**. If `context[name]` is already a native (detected via `Function.prototype.toString` → `[native code]`), the pure-helper load is skipped. This preserves `var c = String.fromCharCode` against nested `function c(A) { return A > 37 ? 59 + A : …; }` shadows in interstitial.

### Phase 4 — decoder call folder

Evaluates `fn(numLit, …)` calls in the VM context and replaces them with their result literal. Guards against inlining anything that would corrupt the AST:

| Guard | Purpose |
|---|---|
| `dec === undefined` | Signals a missing table entry. Inlining `undefined` gives `I[undefined]`. |
| String contains `\uFFFD` or `\uFFFF` | Mojibake markers — alphabet is corrupted. |
| String >8 chars with >⅓ non-printable | Garbage decode. Short strings with `\xFF`-range bytes are allowed (legitimate opaque keys). |
| Empty string in computed-member property position | `obj[""]` / `obj[""](x)` is meaningless. Allowed elsewhere (regex flags). |
| Non-integer/negative/oversized number in property position | Prevents `w[-2051.61]`. |
| Non-string result replacing the **object** of a member expression | `42.concat(x)` is meaningless. Strings are allowed — `"l:".concat(msg)` works. |
| Function/non-null object result | Never inline references or complex values. |

Also includes a `callFailureCache` keyed by call-text (each unique `fn(args)` attempted at most once across all iterations), a per-evaluation `vm.runInContext({ timeout: 50 })`, and a `TOTAL_FAILURE_LIMIT = 100000` panic brake.

### Opaque-predicate folding (MBA)

DataDome wraps predicates in Mixed Boolean-Arithmetic expressions:

```js
var o = 880;
if (!t.l && -3 * (F & -881) + 1 * ~(F & o) - 4 * ~(F | o) - 2 * ~(F | -881) + -2643 > -388) { … }
```

The `foldOpaquePredicates` pass samples the expression at 20+ random 32-bit integer assignments to its free variables:

- If every trial yields the same value → replace with that literal.
- Otherwise, try to fit `a*x + b*y + c` with small integer coefficients over 40+ samples. On match, emit the simpler linear form.

Pins any free identifier that Babel reports as a constant binding (`var o = 880` → `o = 880` in all samples), which lets expressions involving a decoded constant collapse to tight linear forms.

## VM Evaluation

The preprocessing phase uses Node.js `vm` module to evaluate obfuscated expressions. This is sandboxed but not fully secure, it's meant for trusted input only (DataDome scripts we control).

The `generateTMap()` function in `transformers/index.js` also uses VM to execute the matrix-populating function and extract the `t[x][y]` mapping.

Key safety checks before VM evaluation:
- `hasSideEffectsOrRuntimeDeps(node)` — detects member access, function calls, typeof
- `canSafelyEvaluate(node)` — checks for no runtime dependencies
- `isPureStringConcatenation(node)` — validates string concat safety

## Common Patterns in the Obfuscated Code

When debugging or extending the deobfuscator, these are the patterns you'll encounter:

1. **t-matrix indirection** — `<matrix>[x][y]` used as case values in switch statements. Captcha/interstitial use `var e = (function(){…return c[34]})()`; tags uses a setTimeout-scheduled population.
2. **Switch-case state machines** — `for (init; true;) { switch(r) { … } break; }` wrapping sequential code. Init may be empty, a state assignment, or a **red-herring** unused var declaration.
3. **Chained assignments in loop init** — `var m = r = 39` where `r` is the state var.
4. **Hex-encoded strings** — `\x48\x65\x6C\x6C\x6F` instead of `"Hello"`.
5. **Computed member expressions** — `obj["prop"]` instead of `obj.prop`.
6. **String building via function calls** — `String.fromCharCode(...)`, array joins, custom-alphabet base64 (`C`, `Q`, `n`, `K`, `M`).
7. **Pure MBA helpers** — `function c(A, w) { return w + -10*A - 11 - 11*~A; }` used as opaque numeric sources (character codes for alphabet construction, array indices, …).
8. **Opaque-math predicates** — `<MBA_expression> < N` as conditional tests. Either constant or equivalent to a simple linear form.
9. **setTimeout(fn, 0) wrappers** (tags) — hundreds of zero-delay timers used as control-flow obfuscation around plain assignments.
10. **Dead code / decoy declarations** — Unused variables, unreachable cases, red-herring for-inits.
11. **Same-name shadowing** — Different `function E(…)` declarations at different nesting levels, both pure-shaped but with different semantics. Must pick the shallowest.

## Testing Changes

```bash
# Run deobfuscator on all three reference inputs
node main.js parser/tmp/captcha-def5678.js parser/tmp/captcha-def5678/
node main.js parser/tmp/interstitial-af0108e.js parser/tmp/interstitial-af0108e/
node main.js parser/tmp/tags-25ba714.js parser/tmp/tags-25ba714/
```

There's no automated test suite. Validate output quality with these one-liners:

```bash
# Should all return 0:
grep -c 'for (; true;)' parser/tmp/captcha-def5678/captcha.js
grep -c 'for (; true;)' parser/tmp/interstitial-af0108e/interstitial.js
grep -cE '\\u|\\x'      parser/tmp/captcha-def5678/captcha.js
grep -cE '\\u|\\x'      parser/tmp/interstitial-af0108e/interstitial.js
grep -cE '\\u|\\x'      parser/tmp/tags-25ba714/jstag.js
grep -cE '\b[CQ]\([0-9]+\)'  parser/tmp/captcha-def5678/captcha.js
grep -cE '\bn\([0-9]+\)'     parser/tmp/interstitial-af0108e/interstitial.js
grep -cE '\b[MK]\([0-9]+\)|g\[[0-9]+\]\[[0-9]+\]'  parser/tmp/tags-25ba714/jstag.js
```

Additional red flags to eyeball in the output:
- No remaining `for(true) { switch(...) }` state machines (unless genuinely conditional)
- No remaining `<matrix>[x][y]` references
- No hex-encoded strings
- No `obj[""]`, `obj[""](x)`, or `obj[-N.NN]` member access corruption
- No lingering MBA expressions like `-3*(F&-881) + 1*~(F&o) + …`
- Clean, readable control flow

## Rules

- **Never evaluate untrusted code** outside the VM sandbox
- **Preserve semantics** — transformations must not change the program's runtime behavior
- **Mutation in place** — all transforms mutate the AST directly, they don't return new ASTs
- **Idempotent passes** — running a transformation twice should produce the same result
- **Return `changed` correctly** — the iterative loop depends on accurate change detection
- **Never let Phase 3.5 clobber a native function or top-level pure helper** — decoders silently fail and produce mojibake downstream. Check `isNativeFn` / depth-ordering / skip-if-name-taken before loading.
- **Never inline undefined, mojibake, or floats as property keys** — these corruptions cascade through the rest of the pipeline. If in doubt, cache the call as a failure and leave it in place.

## Debugging playbook

When a new obfuscator version breaks something:

1. **Run with full logging** — the pipeline prints per-phase counts:
   ```
   Phase 3.5: harvested 25 pure helpers (0 skipped — native fn), 0 decoders
              (17 skipped — name taken), 2/9 arrays (7 skipped — name taken)
   Switch-case unflatten: scanned 108, flattened 70, skipped (no switch: 38,
              non-ident discriminant: 0, no initial state: 0, no executed: 0)
   ```

2. **Triage by symptom**:
   - *Mojibake (`\xFF`, `\uFFFF`) in output* — a helper is wrong; name collision. Check Phase 3.5 depth-ordering and native-fn guard.
   - *Lots of `C(N)` / `n(N)` / `M(N)` remaining* — decoder alphabet broken. Load the module manually in a VM (see `LEARN.md` §9) and verify each helper function returns the right value for known inputs.
   - *`for (; true;) { switch (…) }` residuals* — unflattener couldn't resolve initial state. Check for new for-init decoy patterns, or state values that don't exist in `cases`.
   - *Hangs with "Maximum call stack" spam* — Phase 3.5 harvested a recursive function. Tighten `isHarvestable` / `isPureHelper` / `isDecoderLike`.
   - *`obj[""]`, `obj[undefined]`, `obj[-N.NN]` in output* — Phase 4 guard was bypassed. Don't loosen the guard; find why the decoder is returning that value.

3. **Regression check** — the three reference files in `parser/tmp/` should stay clean (zero residuals) after any change. Use the one-liners in §"Testing Changes".

## Related work / other repos

Other DataDome repos by the same author. Helpful context when reasoning about the wider system the deobfuscator plugs into:

- [datadome-wasm](https://github.com/glizzykingdreko/datadome-wasm) — embedded WASM module reverse-engineered standalone.
- [datadome-encryption](https://github.com/glizzykingdreko/datadome-encryption) — request-payload encryption logic, Node.
- [datadome-encryption-python](https://github.com/glizzykingdreko/datadome-encryption-python) — same encryption, Python port.
- [Datadome-GeeTest-Captcha-Solver](https://github.com/glizzykingdreko/Datadome-GeeTest-Captcha-Solver) — solver for the GeeTest variant of DataDome's captcha.
- [Datadome-Movements-Display](https://github.com/glizzykingdreko/Datadome-Movements-Display) — visualizer for DataDome's mouse-movement signals.

Older, **superseded by this one**, kept for reference:

- [Datadome-Deobfuscator](https://github.com/glizzykingdreko/Datadome-Deobfuscator) (Oct 2023, outdated)
- [Datadome-Interstitial-Deobfuscator](https://github.com/glizzykingdreko/Datadome-Interstitial-Deobfuscator) (Jan 2024, outdated)
- [Datadome-Captcha-Deobfuscator](https://github.com/glizzykingdreko/Datadome-Captcha-Deobfuscator) (Jan 2024, outdated)
- [Datadome-Interstital-Encryptor](https://github.com/glizzykingdreko/Datadome-Interstital-Encryptor) (outdated)

Articles, same author:

- [Analyzing DataDome's latest changes](https://medium.com/@glizzykingdreko/analyzing-datadome-latest-changes-424f385bcdd4) — Medium write-up on the most recent obfuscator updates.
- [Breaking down DataDome captcha WAF](https://medium.com/@glizzykingdreko/breaking-down-datadome-captcha-waf-d7b68cef3e21) — Medium walkthrough of the captcha bundle's structure.

Other antibot vendors, same pattern:

- [akamai-script-patcher](https://github.com/glizzykingdreko/akamai-script-patcher) — Akamai bot-management script deobfuscator + integrity-check patcher.
- [akamai-v3-deobfuscator](https://github.com/glizzykingdreko/akamai-v3-deobfuscator) — Akamai v3 sensor data trace and reconstruction.
- [akamai-v3-tools](https://github.com/glizzykingdreko/akamai-v3-tools) — Akamai v3 sensor data encrypt / decrypt web UI.

## Need DataDome Bypass Solutions?

Get in touch with some experts who truly understand the technology, don't think you want to have your project down each time Datadome pushes a change.

![TakionAPI Banner](https://repository-images.githubusercontent.com/769273753/f6d31bca-c19b-4b61-894d-4b4452e44293)

At [TakionAPI](https://takionapi.tech) we provide it. Be sure to check it out, start a [free trial](https://dashboard.takionapi.tech) and then proceed checking out [our documentation](https://docs.takionapi.tech), one api call and Datadome is not a problem you need to worry about anymore.

Check our [datadome-bypass-examples](https://github.com/glizzykingdreko/datadome-bypass-examples) and be sure to [start a free trial](https://dashboard.takionapi.tech) for testing them.
