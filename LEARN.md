# DataDome Deobfuscation, the Walkthrough

How this deobfuscator reverses DataDome's two client-side scripts (**captcha** and **interstitial**) and the specific fixes that make it actually work.

---

## Table of Contents

- [1. The two bundles](#1-the-two-bundles)
- [2. Pipeline overview](#2-pipeline-overview)
- [3. Module separation](#3-module-separation)
- [4. T-matrix obfuscation](#4-t-matrix-obfuscation)
- [5. Custom base64 decoders, `C` and `Q`](#5-custom-base64-decoders-c-and-q)
- [6. Phase 4, the decoder call folder](#6-phase-4-the-decoder-call-folder)
- [7. The fixes that made it all work](#7-the-fixes-that-made-it-all-work)
- [8. Post-processing extractors](#8-post-processing-extractors)
- [9. Output quality invariants](#9-output-quality-invariants)
- [10. Known limitations](#10-known-limitations)
- [11. Debugging a new obfuscator version](#11-debugging-a-new-obfuscator-version)
- [Need DataDome Bypass Solutions?](#need-datadome-bypass-solutions)
- [Connect with me](#connect-with-me)

---

## 1. The two bundles

DataDome ships two client-side scripts with *different* obfuscation shapes. A single pipeline can't blindly apply the same transforms to both, the entry shape is different and the decoders live in different places.

| Bundle | Shape | Decoders live in | Matrix obfuscation |
|---|---|---|---|
| **Captcha** | Webpack/Browserify IIFE, `!function(e,B,s){ ... }({ 1:[fn,deps], ... })` | Module-local helpers `C`, `Q`, `Z`, `c`, `D`, `E` at module top level | `var e = (function(){…return c[34]})()`, precomputed |
| **Interstitial** | Anonymous IIFE, `(function(){ var e={…modules…}; … })()` | Same style as captcha | Same |

Everything past step 1 (module separation) looks roughly the same. It's the entry shape that diverges.

---

## 2. Pipeline overview

```
Input .js
   │
   ▼
Parse → AST
   │
   ▼
decodeHexStringsInAst         ← inline \xNN literals to the bytes they encode
cleanDoubleBracketProps       ← `obj[['key']]` → `obj['key']`
   │
   ▼
scorporateCaptchaModules      ← detect bundle shape, split into per-module ASTs
   │
   ▼
┌──────────────────────────────┐
│  For each module:            │
│    generateTMap              │   ← build `<matrix>[x][y] → stateNumber` map
│    deobfuscate():            │
│      • preprocessing         │   ← simplify binaries, clean strings, fold calls
│      • iterative passes      │   ← t-matrix, conditionals, expressions, if-stmts
│                              │   ← opaque predicates (MBA folding)
│      • switch-case unflatten │
│      • unused-var removal    │
│      • switch-case pass 2    │   ← catches state machines unmasked by var-removal
└──────────────────────────────┘
   │
   ▼
Generate code per module → write files
   │
   ▼
extractDynamicChallenge       ← pull out the per-session bit-twiddle expression
extractWasm                   ← extract embedded WASM bytes + imports provider
extractWasmChallengeFields    ← list of field names hashed by wasm_b
```

Entry point: [`main.js`](main.js)
Module splitter: [`transformers/captcha.js`](transformers/captcha.js)
Matrix resolver: [`transformers/index.js`](transformers/index.js), `generateTMap`
Iterative passes: [`transformers/preprocessing/index.js`](transformers/preprocessing/index.js) and [`transformers/transformations/`](transformers/transformations/)

---

## 3. Module separation

`scorporateCaptchaModules` detects which shape is at `program.body[0]`:

- **Captcha**: `UnaryExpression(!, CallExpression(FunctionExpression, [moduleObject]))`
- **Interstitial**: `CallExpression(FunctionExpression{body: [VariableDeclaration(ObjectExpression)]})`

The module object `{1: [fn, deps], 2: [fn, deps], …}` is unrolled and each module's function body becomes its own AST. Deps are used to name files (`./captcha`, `./picasso`, `./hash`, etc.).

Quick and easy, but the key bit is: every downstream phase runs **per module**, not on the whole bundle. That's what keeps the helper namespaces from colliding.

---

## 4. T-matrix obfuscation

Both bundles precompute a 128×512 matrix and alias one row to a variable (typically `e`). Every state-machine `case` in the code is written as `case e[X][Y]:` where `(X, Y)` indirects through the matrix to a small state number.

```js
var e = function (A) {
  var w, B, c = [];
  for (w = 0; w < 128; w++) c[w] = new Array(512);
  for (B = 0; B < 512; B++) for (A = 0; A < 128; A++)
    c[A][B] = c[jA(A, 34, 577, B, 401, 691, 128)];
  return c[34];
}();
```

After execution, every cell of `e` points to one of only 32 unique row-arrays. `generateTMap` runs this IIFE in a VM, walks the resulting `e`, and assigns each unique reference a state counter. Result: `tMap["e[248][513]"] = 7` (or whatever counter).

`replaceTMatrix` ([transformations/t-matrix.js](transformers/transformations/t-matrix.js)) then walks the AST and rewrites `e[X][Y]` → `NumericLiteral(tMap["e[X][Y]"])`.

Once every `case e[X][Y]:` has been rewritten to `case N:`, the switch-case unflattener can finally follow state transitions. Lots of words, but actually 3 efficient passes that turn unreadable matrix lookups into plain integers.

---

## 5. Custom base64 decoders, `C` and `Q` 
*Obv names changes with every new version*

Both bundles hide their string tables behind two decoders:

```js
function Q(A) { var w = t[A]; return atob(w); }             // standard base64
function C(A) {
  var w = a[A];
  return typeof w === "string" ? (function(A, …){
    // base64 decode using a *custom* alphabet
    var g = i(48) + i(81) + "pmzW3" + i(82) + "a" + i(Z(87, 3)) + … + "g";
    // … decode ...
  })(w) : w;
}
```

The custom alphabet `g` is constructed from `i(N)` (`String.fromCharCode`) calls interleaved with string literals. Some positions call MBA helpers like `Z(87, 3)` (= 90 = `Z`) and `E(98, 103)` (= 98 = `b`). If *any* of those helpers produces the wrong value, the alphabet is wrong and every decode produces mojibake. We'll see this exact failure mode bite us in §7.

### MBA helpers

Pure bit-arithmetic helpers like:

```js
function c(A, w) { return w + -10 * A - 11 - 11 * ~A; }
function E(A, w) { return -w + A - 1 - 1 * ~w; }
function Z(A, w, B, c) { return 2*(w&A) + 1*(w|~A) - 1*~(w&(c=~A)) + 2*~(w|c); }
```

Constant-returning for their input, `c(88, 29) === 117` regardless of external state. They're loaded into the VM context and used by Phase 4 to fold any `c(numLit, numLit)` into a numeric literal.

---

## 6. Phase 4, the decoder call folder

The core of string recovery. Walks every `CallExpression` and, when the callee is an Identifier in the VM context and every argument is a numeric literal (including `-N` forms), evaluates the call and replaces it with a literal.

### 6.1 Why it's the critical phase

Every cascade failure starts here. If `c(88, 29)` doesn't fold to `117`:
- `i(c(88, 29))` can't fold to `"u"`
- The custom base64 alphabet `g` is wrong
- `C(N)` produces garbage
- `I[C(N)]` becomes `I[garbage]` which is bad syntax
- For-loop inits like `for (r = e[376][C(c(694, 305))]; true;)` stay obfuscated
- Switch-case state machines can't read their initial state
- All state-machine flattening fails for that block

A single broken helper can leave hundreds of switch-cases unresolved. Don't underestimate this one.

### 6.2 Guards against bad inlines

Phase 4 has several rejection rules that prevent garbage from reaching the output:

| Guard | Why |
|---|---|
| `dec === undefined` | The decoder hit a missing table entry. Inlining `undefined` corrupts everything downstream (e.g., `I[undefined]`). |
| String contains `\uFFFD` or `\uFFFF` | Mojibake, an alphabet corruption produced invalid bytes. |
| Long string (>8 chars), mostly non-printable | Garbage. Short strings with a few high bytes are legit opaque keys. |
| Empty string in computed-member-property slot | `obj[""]` / `obj[""](x)` is meaningless syntax. Allowed elsewhere (RegExp flags, etc.). |
| Non-integer / negative / huge number in property slot | Prevents `obj[-2051.61]`, the decoder meant a string key, got a number. |
| `typeof dec === "object" && dec !== null` | Don't inline arrays/objects as literals. |
| `typeof dec === "function"` | Never inline function references. |
| `path.parentPath.node.object === path.node` | Don't let a numeric result replace the *object* of a member expression. |

Failures are cached by call text so we never retry `C(118)` after it's failed once.

### 6.3 Watchdogs

Two safety rails for pathological cases:

- **`TOTAL_FAILURE_LIMIT` = 100000**, absolute panic brake. Legitimate captcha workloads produce ~150 cheap throws across all modules; we never approach this.
- **`vm.runInContext({timeout: 50})`**, each call has a 50ms timeout in case something recurses or loops.

---

## 7. The fixes that made it all work

Several bugs were discovered and resolved during development. Each one blocked a chain of downstream passes. This is the part you'll actually want to read if a new variant breaks something.

### 7.1 Same-name pure helpers at different depths

**Symptom:** captcha's `C(N)` calls produced mojibake (`"Obje\uFFFF\xF4"` instead of `"Object"`).

**Cause:** two `function E(…)` declarations in the captcha module:

```js
function E(A, w) { return -w + A - 1 - 1 * ~w; }   // top-level, the MBA helper
// … 1500 lines later, nested inside another function …
function E(A) { return A > 37 ? 59 + A : A > 11 ? 53 + A : A > 1 ? 46 + A : 50 * A + 45; }
```

Both pass the "pure helper" shape test. When the recursive harvest traversed the AST, the nested one was loaded last and won in the VM context. `E(98, 103)` then returned `157` instead of `98`, so `String.fromCharCode(E(98, 103))` put `\u009D` into the custom base64 alphabet where `b` was supposed to be. Every `C()` call downstream produced garbage.

**Fix:** sort harvested pure helpers by nesting depth, deepest first, so the shallowest declaration overwrites everything else in the context. [preprocessing/index.js:758](transformers/preprocessing/index.js)

### 7.2 Red-herring for-init declarations

**Symptom:** captcha's state machines in `catch (w) { r = 124; for (; true;) switch (r) {…} }` weren't being flattened.

**Cause:** the obfuscator pads some for-inits with an unused declaration to confuse the unflattener:

```js
for (var eA = 544; true;) {       // <-- `eA` is never used; `r` is the real state
  switch (r) { /* state machine */ }
}
```

`getInitialState` only looked at the for-init; since `r` isn't declared there, it returned `null` and the whole state machine was skipped. Pretty cheap trick, surprisingly effective until you spot it.

**Fix:** when the for-init is a VariableDeclaration that doesn't touch the state variable, fall through to the "look above the loop" scan. Also run the unflattener *twice*, once normally, once after `removeUnusedVariables` strips the red herrings. [transformations/switch-case.js:114](transformers/transformations/switch-case.js), [transformers/index.js:162](transformers/index.js)

### 7.3 Nested array declarations overwriting globals

**Symptom:** `c(694, 305)` stopped resolving in captcha.

**Cause:** the recursive harvest was promoting *every* array-init `VariableDeclaration` in the AST to global scope, including a nested `for (var c = [C(948), 'bitness', …], n = [], g = 0; …)`. That synthesized `var c = [C(948), …]` at the global level in the VM, replacing `context.c` (the pure MBA helper function) with an array. Every subsequent `c(N, M)` call returned `undefined` because array-index access gives no result for non-existent numeric keys.

**Fix:** array harvesting now skips any name that's already bound in context, mirroring the decoder-skip logic. [preprocessing/index.js:780](transformers/preprocessing/index.js)

### 7.4 Non-terminating decoder evaluations

**Symptom:** captcha deobfuscation hung indefinitely, logging thousands of "Maximum call stack size exceeded" errors per second.

**Cause:** the harvest would grab *every* `FunctionDeclaration`, including ones that were legitimately recursive (deep helpers that pass some state between invocations). Phase 4 would then evaluate calls to them with arbitrary numeric arguments, triggering stack overflows for most inputs. Every pass of Phase 4 retried every call site, so the errors accumulated.

**Fix:**
- `isPureHelper` / `isDecoderLike` reject functions with `try/catch`, `new`, `this`, or direct self-recursion.
- Phase 4 caches failures by call-text so each distinct call is attempted at most once.
- `TOTAL_FAILURE_LIMIT` watchdog aborts the loop if the pipeline ever hits catastrophic runaway. [preprocessing/index.js:818](transformers/preprocessing/index.js)

### 7.5 Number as property key

**Symptom:** output contained expressions like `'InnerErr: ' + w[-2051.61]`.

**Cause:** a decoder returned a floating-point number for an invalid index and Phase 4 happily inlined it into `w[<call>]`, turning a runtime property access into `w[-2051.61]`.

**Fix:** when the result is a number and we're replacing the `property` of a computed member expression, only allow non-negative integers ≤ 2³¹−1. Floats, negatives, and out-of-range integers are cached as failures instead. [preprocessing/index.js:893](transformers/preprocessing/index.js)

### 7.6 Native functions overridden by nested pure-helper lookalikes

**Symptom:** interstitial's `n(N)` calls produced mojibake with `\uFFFC` / `\uFFFF` chars, just like the earlier captcha bug.

**Cause:** interstitial's custom base64 decoder builds its alphabet from `c(N)` calls where `c = String.fromCharCode` (assigned at top level). The first phase loaded `context.c = String.fromCharCode` correctly. Then the recursive harvest found a deeply nested `function c(A) { return A > 37 ? 59 + A : … }`, which passes the pure-helper shape test, and overwrote `context.c` with it. Every `c(83)` that should have returned `"S"` returned `142` instead, scrambling the alphabet and producing mojibake for every decoded string.

The earlier depth-ordering fix didn't help here because the native `String.fromCharCode` isn't a FunctionDeclaration, it's just bound at runtime via `var c = String.fromCharCode`. No top-level `function c(…)` exists to win the depth comparison.

**Fix:** before loading a pure helper, check if `context[name]` is already a native function (via `Function.prototype.toString` → `[native code]` check). If so, skip. This preserves `String.fromCharCode`, `atob`, and any other native aliased by `var x = <native>`. [preprocessing/index.js:764](transformers/preprocessing/index.js)

### 7.7 String-returning calls in member-expression object position

**Symptom:** interstitial had `n(1093).concat(g.message)`, `n(1096).concat(…)`, etc. where `n(1093)` should fold to `"l:"`, `n(1096)` to `"w:"`, but the calls stayed.

**Cause:** Phase 4 had a blanket guard "don't inline if this call is the `object` of a member expression". The rationale was preventing `t[x][y]` from turning into `42[y]` when `t[x]` resolved to a number. But the guard was too broad, strings are fine there: `"l:".concat(msg)` is perfectly valid JS.

**Fix:** narrow the guard to reject only when the result is a non-string (number, boolean, null, undefined). Strings pass through. [preprocessing/index.js:897](transformers/preprocessing/index.js)

### 7.8 Opaque MBA predicates

**Symptom:** comparisons like `-3*(F&-881) + 1*~(F&o) - 4*~(F|o) - 2*~(F|-881) + -2643 > -388` littered the output even after constant folding.

**Cause:** these are *obfuscated* predicates. DataDome writes an arithmetically-elaborate expression that (after substitution) collapses to something simple like `F - 880 > -388`. Ordinary constant folding can't see that because the variables are live. Their checks are strict and effective on this one, give credit where earned.

**Fix:** new pass `foldOpaquePredicates` ([transformations/opaque-predicates.js](transformers/transformations/opaque-predicates.js)) that:
1. Collects free identifiers in a pure-arithmetic subtree.
2. Pins any that are `var X = literal` bindings from the scope.
3. Samples 10–30 random 32-bit integers for the rest.
4. If every trial produces the same value, replace with that literal.
5. Otherwise tries linear-fit: fits `a*x + b*y + c` to the expression over 40 sample points. If the fit matches exactly, emit the simpler linear form.

Catches both *strictly* opaque predicates (MBA noise around `< 500` that's always true) and MBA-obfuscated arithmetic that has a simpler linear form.

---

## 8. Post-processing extractors

After the modules are clean, three extractors run over the deobfuscated ASTs and pull out the bits a solver actually needs.

### 8.1 `extractDynamicChallenge`

DataDome computes a per-session `dynamicChallenge` value by running a long bit-twiddling expression over `(build-sig, br_ow, br_oh, hardwareConcurrency)`. The expression is a bundle of `X[0] >>> 0 | X[1] ...` operations where `X` is a locally-named array (`o`, `a`, `n`, whatever the obfuscator picked this build).

The pass tries two detection strategies:
1. **Name-based**, if the deobfuscator already resolved the signal-name string literal, match on that.
2. **Shape-based**, fallback that scores expressions by index count, large-int XOR presence, and binary-expression depth.

Once it finds the call, it deep-clones the matching node (so we don't mutate the source AST), iteratively resolves any inner decoder calls, renames the locally-named arrays to consistent identifiers, and returns the final expression as a string. Lives at [`transformers/extractDynamicChallenge.js`](transformers/extractDynamicChallenge.js).

### 8.2 `extractWasm`

Both captcha and interstitial embed a compiled-to-WASM module that's executed client-side. The shape is always:

1. A base64 string starting with `"AGFzbQ"` (the `\0asm\x01\x00\x00\x00` WebAssembly magic header). Decoded, those are the raw WASM bytes.
2. A `new <windowAlias>.WebAssembly.Instance(<module>, <imports>)` call.
3. The imports object is produced by a top-level "imports provider" function whose body is a big `return A.wbg = {}, A.wbg.__wbg_… = function(){…}` sequence.
4. Inside the imports provider, some WBG shims reach out to the window alias (`I.DataView`, `I.Uint32Array`, `new I.Error(…)`); others call external helpers (`kD.decode(…)`, `ID()`, …).

`extractWasm` finds all four pieces and returns:

```js
{
  wasm: "AGFzbQEAAAAB…",        // raw base64 bytes of the WASM module
  instance: "function wD() {…}", // imports-provider source code
  providerName: "wD",            // function name of the provider
  windowAttributes: ["DataView", "Uint32Array", "Error", …],
  helpers: [{ name: "kD", source: "var kD = …" }, …]
}
```

Lives at [`transformers/extractWasm.js`](transformers/extractWasm.js).

### 8.3 `extractWasmChallengeFields`

Both bundles feed a fixed-length `Uint32Array` into `<obj>.exports.wasm_b(...)`, and the elements of that array are what the compiled WASM hashes to produce the challenge response. Shape is always:

```js
var R = new I.Uint32Array([
  JD(I.ddm.userEnv, I.navigator.hardwareConcurrency || 0) >>> 0,
  JD(I.ddm.userEnv, D.u.br_oh)                           >>> 0,
  JD(I.ddm.userEnv, I.navigator.maxTouchPoints || 0)     >>> 0,
  JD(I.ddm.userEnv, I.navigator.maxTouchPoints || 0)     >>> 0
]);
A('<6-char-obf-name>', R.exports.wasm_b(R) >>> 0);
```

The interesting bit, for a solver rebuilding the payload without actually running the wasm, is the *ordered list of field names* the obfuscator decided to hash on this variant. The pass walks to the `wasm_b` call, resolves the `Uint32Array` binding, strips the `>>> 0` / `|| 0` wrappers, and reads the deepest property name out of each `JD(userEnv, <EXPR>)`. Returns a bare `string[]` like `["hardwareConcurrency", "br_oh", "maxTouchPoints", "maxTouchPoints"]` and the caller nests it into the `wasm` blob as `wasm.fields`. Lives at [`transformers/extractWasmChallengeFields.js`](transformers/extractWasmChallengeFields.js).

The outer `A('<6-char>', …)` signal name is **ignored on purpose**, it's a random 6-char obfuscator-generated label that rolls every build. Carries no semantic value across variants.

---

## 9. Output quality invariants

A healthy deobfuscation run produces output with:

- **Zero** `\xNN` or `\uNNNN` escape sequences (mojibake indicator)
- **Zero** `for (; true;) { switch (X) { … } }` state machines with resolvable initial state
- **Zero** `obj[""]`, `obj[""](…)`, or `obj[-N.NN]` computed member accesses
- **Zero** `undefined` in computed property positions
- Nested `C(x)`, `Q(x)` calls only when their decoded result is rejected by the guards (rare, a handful at most per file)

Current numbers on the reference inputs:

| File | Time | Residual decoder calls | Escape sequences | State machines flattened |
|---|---|---|---|---|
| captcha.js | 3.7s | **0** | 0 | 70 |
| interstitial.js | 3.7s | **0** | 0 | 56 |

---

## 10. Known limitations

- **Decoders with corrupt output**, a handful of captcha indices (`C(118)`, `C(963)`, `C(1034)`, `C(1117)`) legitimately produce opaque byte strings. We keep the call expression in place when the decode looks unsafe; this is correct behavior but loses some readability.
- **Interstitial `undefined` checks**, runtime comparisons like `undefined !== g` survive (correctly) and account for ~20 `undefined` occurrences in the output.
- **Non-numeric-argument decoder calls**, Phase 4 only folds calls with numeric-literal args. Calls like `C(someVar)` where `someVar` isn't constant are left as-is.
- **For-loop state machines with dynamic initial state**, if the initial state is `R = e[C(D(166, 293))][13]` and some inner call can't resolve, the unflattener skips the loop. Currently 0 such skips across the reference inputs, but could recur with new obfuscator versions.

---

## 11. Debugging a new obfuscator version

When a new variant breaks something:

1. **Run with debug logging**, the pipeline prints per-phase counts (`Phase 3.5: harvested 25 pure helpers, 0 decoders (17 skipped), 2/9 arrays`, `Switch-case unflatten: scanned 108, flattened 70, skipped …`).

2. **Triage by symptom:**
   - *Mojibake in output (`\xFF`, `\uFFFF`):* a pure helper is wrong, same-name collision. Check the recursive harvest depth-ordering and native-fn guard.
   - *Lots of `C(N)` remaining:* the decoder alphabet is corrupted. Often means a helper returned a wrong value. Run the module through a VM manually and check `context.c(a, b)` etc.
   - *`for (; true;) { switch (…) }` residuals:* the unflattener couldn't get the initial state. Check for new for-init padding patterns.
   - *Hangs:* the harvest grabbed a recursive function. Tighten `isHarvestable`.

3. **Verify with a small reproducer**, extract the broken snippet into a standalone file, run the unflattener or Phase 4 on it in isolation, iterate.

The reference test files in `input/` are the regression set. If both stay clean (zero residuals, zero escapes), the pipeline is healthy.

---

## Need DataDome Bypass Solutions?
Get in touch with some experts who truly understand the technology, don’t think you want to have your project down each time Datadome pushes a change.

![TakionAPI Banner](https://repository-images.githubusercontent.com/769273753/f6d31bca-c19b-4b61-894d-4b4452e44293)

At [TakionAPI](https://takionapi.tech) we provide it Be sure to check it out, start a [free trial](https://dashboard.takionapi.tech) and then proceed checking out [our documentation](https://docs.takionapi.tech), one api call and Datadome is not a problem you need to worry about anymore.

Check our [datadome-bypass-examples](https://github.com/glizzykingdreko/datadome-bypass-examples) and be sure to [start a free trial](https://dashboard.takionapi.tech) for testing them

## Connect with me

If you found this useful, follow me on GitHub and Medium for more reverse-engineering deep-dives.

- [GitHub](https://github.com/glizzykingdreko)
- [Twitter](https://mobile.twitter.com/glizzykingdreko)
- [Medium](https://medium.com/@glizzykingdreko)
- [Email](mailto:glizzykingdreko@protonmail.com)
- [Buy me a coffee ❤️](https://www.buymeacoffee.com/glizzykingdreko)
- [TakionAPI](https://takionapi.tech)
