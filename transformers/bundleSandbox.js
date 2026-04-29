// Bundle VM sandbox + string-table decoder + safe-call folder.
//
// DataDome captcha/interstitial variants ship an in-bundle decoder
// (shape: `function w(A, Q) { return typeof (Q = o[A]) == 'string'
// ? <base64 IIFE>(Q) : o[A]; }`) plus many pure MBA/arithmetic helpers
// (`function D(A, Q, t) { return A + Q; }`, `function g(A, Q) { return
// -5 * Q - 6 - 6 * ~Q; }`, etc.) that the main deobfuscator pipeline
// skips because it refuses to execute CallExpressions (to avoid DOM
// side effects).
//
// This module builds a single VM sandbox containing every safe-to-execute
// prelude declaration (all top-level FunctionDeclarations + safe
// VariableDeclaration declarators), then lets callers:
//   - resolve `<decoderName>(<NumericLiteral>)` calls to their string values
//   - fold `Math.*`, `Number(...)`, `String.fromCharCode(...)`,
//     user-defined pure helpers (`D(-338, -593)`), and window-aliased
//     forms (`N.Math.ceil(194.55)`) whose args are all literals
//   - normalize `obj["name"]` → `obj.name` for identifier-safe keys
//
// Best-effort throughout: setup failure or per-site eval failure leaves
// the AST untouched and returns counts so the runner can report status.

const vm = require('vm');
const t = require('@babel/types');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

const ID_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SAFE_GLOBAL_NAMES = [
    'Math', 'Number', 'String', 'JSON', 'Array', 'Object',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'Boolean', 'atob', 'btoa', 'encodeURIComponent', 'decodeURIComponent'
];

// ----- Shape detection --------------------------------------------------

// Shape-match the decoder rather than name-match it — DataDome renames
// `w` per build. The `typeof` + base64-alphabet regex pair is distinctive
// enough; we don't require the literal `'string'` substring because some
// builds obfuscate it into a character-code concat.
function isDecoderFn(node) {
    if (!t.isFunctionDeclaration(node)) return false;
    if (!node.params || node.params.length !== 2) return false;
    const body = generate(node).code;
    return /typeof\s*\(.*=.*\[/.test(body) &&
           /replace\([^)]*A-Za-z0-9/.test(body);
}

// Table-init IIFEs like `var b = (function () { ... })()`. Include only
// if the body doesn't reach into DOM globals — we're running this in
// a sandbox that doesn't have them.
function isSafeTableIIFE(node) {
    if (!t.isCallExpression(node)) return false;
    if (!t.isFunctionExpression(node.callee)) return false;
    const body = generate(node.callee.body).code;
    return !/(^|[^.\w])(window|document|navigator)\b/.test(body) &&
           !/\bN\s*\[/.test(body);
}

function isSafeDeclarator(d) {
    if (!d.init) return false;
    if (t.isArrayExpression(d.init)) return true;
    if (t.isStringLiteral(d.init)) return true;
    if (t.isNumericLiteral(d.init)) return true;
    // `var c = String.fromCharCode` — alias on a well-known pure global.
    if (t.isMemberExpression(d.init) &&
        !d.init.computed &&
        t.isIdentifier(d.init.object) &&
        ['String', 'Array', 'Object', 'Math', 'JSON', 'Number'].includes(d.init.object.name)) {
        return true;
    }
    if (isSafeTableIIFE(d.init)) return true;
    return false;
}

// ----- Window-alias detection -------------------------------------------

// `var N = window`, `var N = this`, `var N = function(){return this}()`,
// `var N = (new Function('return this'))()`, etc. Every alias we find is
// bound back to the sandbox itself so `N.Math.ceil(...)` just works.
function isWindowExpr(n) {
    if (!n) return false;
    if (t.isIdentifier(n, { name: 'window' })) return true;
    if (t.isIdentifier(n, { name: 'self' })) return true;
    if (t.isIdentifier(n, { name: 'globalThis' })) return true;
    if (t.isThisExpression(n)) return true;
    if (t.isCallExpression(n) && t.isFunctionExpression(n.callee)) {
        const body = n.callee.body.body;
        if (body.length === 1 &&
            t.isReturnStatement(body[0]) &&
            t.isThisExpression(body[0].argument)) return true;
    }
    if (t.isCallExpression(n) &&
        t.isNewExpression(n.callee) &&
        t.isIdentifier(n.callee.callee, { name: 'Function' })) return true;
    return false;
}

function collectWindowAliases(ast) {
    const aliases = new Set();
    for (const node of ast.program.body) {
        if (t.isVariableDeclaration(node)) {
            for (const d of node.declarations) {
                if (t.isIdentifier(d.id) && isWindowExpr(d.init)) {
                    aliases.add(d.id.name);
                }
            }
        } else if (t.isExpressionStatement(node) &&
                   t.isAssignmentExpression(node.expression, { operator: '=' }) &&
                   t.isIdentifier(node.expression.left) &&
                   isWindowExpr(node.expression.right)) {
            aliases.add(node.expression.left.name);
        }
    }
    return aliases;
}

// ----- Sandbox construction ---------------------------------------------

function locateBundleStructure(ast) {
    let decoderFn = null;
    const initDecls = [];
    const topLevelFnNames = new Set();
    for (const node of ast.program.body) {
        if (t.isFunctionDeclaration(node)) {
            initDecls.push(node);
            if (node.id) topLevelFnNames.add(node.id.name);
            if (!decoderFn && isDecoderFn(node)) decoderFn = node;
            continue;
        }
        if (t.isVariableDeclaration(node)) {
            const safeDeclarators = node.declarations.filter(isSafeDeclarator);
            if (safeDeclarators.length > 0) {
                initDecls.push(t.variableDeclaration(node.kind, safeDeclarators));
            }
        }
    }
    return { decoderFn, initDecls, topLevelFnNames };
}

// Build the sandbox once and return the context + metadata callers need.
// Two-phase prelude evaluation:
//   Phase 1: ALL top-level FunctionDeclarations are concatenated and run
//            in a single `runInContext`. JS hoists them, so forward-refs
//            between helpers (decoder -> later-declared `x`, IIFE ->
//            later-declared `atob`, etc.) resolve.
//   Phase 2: Each safe VariableDeclaration is run independently. A bad
//            declarator (referencing a not-yet-synthesised helper, or a
//            false positive from `isSafeTableIIFE`) is skipped without
//            taking down the earlier ones that succeeded.
// Returns `null` if the module has no top-level fn decls at all.
function buildBundleSandbox(ast, logger) {
    const { decoderFn, initDecls, topLevelFnNames } = locateBundleStructure(ast);
    if (initDecls.length === 0) return null;

    const windowAliases = collectWindowAliases(ast);

    const sandbox = {
        Math, Number, String, JSON, Array, Object,
        parseInt, parseFloat, isNaN, isFinite,
        Boolean, Buffer, Error, TypeError, RegExp, Date,
        atob: s => Buffer.from(s, 'base64').toString('binary'),
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        encodeURIComponent, decodeURIComponent,
        console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    };
    for (const name of [...windowAliases, 'window', 'self', 'globalThis']) {
        sandbox[name] = sandbox;
    }

    try {
        vm.createContext(sandbox);
    } catch (err) {
        logger && logger.warn('bundleSandbox: createContext failed', { error: err.message });
        return null;
    }

    const fnDecls = initDecls.filter(n => t.isFunctionDeclaration(n));
    const varDecls = initDecls.filter(n => t.isVariableDeclaration(n));

    // Phase 1: helpers together, so hoisting resolves forward-refs.
    const fnSrc = fnDecls.map(n => {
        try { return generate(n).code; } catch { return ''; }
    }).filter(Boolean).join('\n');
    if (fnSrc) {
        try {
            vm.runInContext(fnSrc, sandbox, { timeout: 5000 });
        } catch (err) {
            logger && logger.warn('bundleSandbox: helper prelude evaluation failed', { error: err.message });
            return null;
        }
    }

    // Phase 2: var decls, each in its own script so one throw doesn't
    // abort the rest. Preserves source order (table decoders that depend
    // on earlier table-init vars still see them).
    let skipped = 0;
    for (const decl of varDecls) {
        let src;
        try { src = generate(decl).code; } catch { skipped++; continue; }
        try {
            vm.runInContext(src, sandbox, { timeout: 5000 });
        } catch (err) {
            skipped++;
            logger && logger.debug && logger.debug('bundleSandbox: prelude var decl skipped', {
                error: err.message,
                src: src.slice(0, 80)
            });
        }
    }
    if (skipped > 0) {
        logger && logger.debug && logger.debug(`bundleSandbox: skipped ${skipped} var prelude declarations`);
    }

    return {
        sandbox,
        decoderName: decoderFn ? decoderFn.id.name : null,
        windowAliases,
        topLevelFnNames,
    };
}

// ----- Replacement-node building ----------------------------------------

// Converts a runtime value into a Babel replacement node. Returns null
// for types we can't safely reify (objects, functions, symbols, bigints,
// out-of-safe-integer-range numbers).
//
// Negative numbers emit as `UnaryExpression('-', positive)` rather than
// `NumericLiteral(-N)`. Babel's generator prints a bare NumericLiteral with
// a negative value as `-N`, and when the node is inlined into a parent
// UnaryExpression (e.g. `-V` where V was -434), the result becomes `--434`
// — parsed as a decrement operator and an unparseable expression. Using
// UnaryExpression('-', ...) forces the generator to print `- -434` (with
// a space) so the parse is preserved.
function valueToNode(v) {
    if (v === undefined) return t.unaryExpression('void', t.numericLiteral(0));
    if (v === null) return t.nullLiteral();
    if (typeof v === 'string') return t.stringLiteral(v);
    if (typeof v === 'boolean') return t.booleanLiteral(v);
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return t.binaryExpression('/', t.numericLiteral(0), t.numericLiteral(0));
        if (!Number.isFinite(v)) {
            const inf = t.binaryExpression('/', t.numericLiteral(1), t.numericLiteral(0));
            return v > 0 ? inf : t.unaryExpression('-', inf);
        }
        if (Math.abs(v) > Number.MAX_SAFE_INTEGER) return null;
        if (v < 0 || Object.is(v, -0)) return t.unaryExpression('-', t.numericLiteral(-v));
        return t.numericLiteral(v);
    }
    return null;
}

// ----- Decoder resolver --------------------------------------------------

// Idempotent — safe to re-invoke on the same AST after more folds have
// materialised fresh `w(<num>)` call sites (constant folding often does).
function resolveDecoderCalls(ast, bundle) {
    if (!bundle || !bundle.decoderName) return { resolved: 0, failed: 0 };
    const { sandbox, decoderName } = bundle;
    const script = new vm.Script(`${decoderName}(__arg)`);
    let resolved = 0, failed = 0;
    traverse(ast, {
        CallExpression(path) {
            const call = path.node;
            if (!t.isIdentifier(call.callee, { name: decoderName })) return;
            if (call.arguments.length !== 1) return;
            const arg = call.arguments[0];
            if (!t.isNumericLiteral(arg)) return;
            sandbox.__arg = arg.value;
            let v;
            try { v = script.runInContext(sandbox, { timeout: 500 }); }
            catch { failed++; return; }
            const r = valueToNode(v);
            if (!r) { failed++; return; }
            path.replaceWith(r);
            resolved++;
        }
    });
    return { resolved, failed };
}

// ----- Safe-call folder --------------------------------------------------

// Literals, unary-prefixed literals (-5, +5, !0, !1, ~0), or the literal
// `undefined` identifier. Strings and booleans count too — `String.fromCharCode`
// takes numbers only but `parseInt('10', 10)` takes a string.
function isLiteralArg(n) {
    if (t.isNumericLiteral(n) || t.isStringLiteral(n)) return true;
    if (t.isBooleanLiteral(n) || t.isNullLiteral(n)) return true;
    if (t.isUnaryExpression(n) && ['-', '+', '!', '~'].includes(n.operator)) {
        return t.isNumericLiteral(n.argument) || t.isBooleanLiteral(n.argument);
    }
    if (t.isIdentifier(n, { name: 'undefined' })) return true;
    return false;
}

// Returns a dotted path ("D", "Math.ceil", "N.Math.ceil") if the callee is
// a pure identifier or non-computed MemberExpression chain; null otherwise.
function dottedPath(calleeNode) {
    if (t.isIdentifier(calleeNode)) return calleeNode.name;
    if (!t.isMemberExpression(calleeNode) || calleeNode.computed) return null;
    const parts = [];
    let cur = calleeNode;
    while (t.isMemberExpression(cur) && !cur.computed && t.isIdentifier(cur.property)) {
        parts.unshift(cur.property.name);
        cur = cur.object;
    }
    if (!t.isIdentifier(cur)) return null;
    parts.unshift(cur.name);
    return parts.join('.');
}

// Fold safe calls whose callee path starts with a "safe root" (window alias,
// known global, or top-level helper fn) and whose arguments are all
// literals. Skips the decoder — callers should run `resolveDecoderCalls`
// for that. Idempotent: once a call is replaced with a literal, this
// traversal can't re-match it on future passes.
function foldSafeCalls(ast, bundle, options = {}) {
    if (!bundle) return { folded: 0, failed: 0 };
    const { sandbox, decoderName, windowAliases, topLevelFnNames } = bundle;
    const { maxArgs = 8, maxStringLen = 2048 } = options;

    const safeRoots = new Set([
        ...SAFE_GLOBAL_NAMES,
        'window', 'self', 'globalThis',
        ...windowAliases,
        ...topLevelFnNames,
    ]);
    if (decoderName) safeRoots.delete(decoderName);

    let folded = 0, failed = 0;
    traverse(ast, {
        CallExpression(path) {
            const call = path.node;
            const p = dottedPath(call.callee);
            if (!p) return;
            const rootName = p.split('.')[0];
            if (!safeRoots.has(rootName)) return;
            if (p === decoderName) return;
            if (call.arguments.length > maxArgs) return;
            if (!call.arguments.every(isLiteralArg)) return;

            // Scope-shadow guard — don't evaluate `w(3)` when a function
            // scope between here and the module root has its own `var w`.
            // The sandbox entry is the module-level binding; calling
            // against it when a local has taken over produces garbage
            // (same failure mode as foldTableLookups above).
            const binding = path.scope.getBinding(rootName);
            if (binding && binding.scope.block &&
                !t.isProgram(binding.scope.block)) return;

            let src;
            try { src = generate(call).code; } catch { return; }

            let v;
            try { v = vm.runInContext(src, sandbox, { timeout: 500 }); }
            catch { failed++; return; }

            // Reject absurdly long string results — a buggy helper that
            // returns megabytes would blow up codegen. 2KB is plenty for
            // anything DataDome encodes as a per-signal string.
            if (typeof v === 'string' && v.length > maxStringLen) { failed++; return; }

            const r = valueToNode(v);
            if (!r) { failed++; return; }
            path.replaceWith(r);
            folded++;
        }
    });
    return { folded, failed };
}

// ----- Const-identifier inlining ----------------------------------------

// For every top-level `var X = <literal>` (where X is never reassigned and
// its binding kind isn't a `let`/`const` that would shadow inside inner
// scopes), replace every reference to X with the literal value. Runs after
// foldSafeCalls has turned `s = N.Math.ceil(194.55)` into `s = 195` so the
// opportunity actually exists.
//
// Relies on Babel's scope analysis: `binding.constant` is true when there
// are zero `constantViolations`. References include uses in any nested
// scope (ex: `function foo() { return s + 1; }`), but binding analysis
// correctly stops at the shadowing point if an inner scope redeclares X.
function inlineConstIdentifiers(ast) {
    let inlined = 0;
    traverse(ast, {
        Program(path) {
            const bindings = path.scope.bindings;
            for (const name in bindings) {
                const binding = bindings[name];
                if (!binding.constant) continue;
                if (binding.kind !== 'var' && binding.kind !== 'const' && binding.kind !== 'let') continue;
                const init = binding.path.node.init;
                if (!init) continue;
                // Only inline primitives — avoid inlining arrays/objects
                // (would multiply allocations) or call results (not safe
                // without knowing purity).
                const v = literalValueOf(init);
                if (v === NOT_A_LITERAL) continue;
                for (const ref of binding.referencePaths) {
                    // Don't touch the declarator itself; Babel shouldn't
                    // include it in referencePaths but guard anyway.
                    if (ref.node === binding.identifier) continue;
                    const repl = valueToNode(v);
                    if (!repl) continue;
                    ref.replaceWith(repl);
                    inlined++;
                }
            }
        }
    });
    return inlined;
}

const NOT_A_LITERAL = Symbol('not-a-literal');
function literalValueOf(node) {
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isStringLiteral(node)) return node.value;
    if (t.isBooleanLiteral(node)) return node.value;
    if (t.isNullLiteral(node)) return null;
    if (t.isIdentifier(node, { name: 'undefined' })) return undefined;
    if (t.isUnaryExpression(node)) {
        if (node.operator === '-' && t.isNumericLiteral(node.argument)) return -node.argument.value;
        if (node.operator === '+' && t.isNumericLiteral(node.argument)) return +node.argument.value;
        if (node.operator === '!' && t.isBooleanLiteral(node.argument)) return !node.argument.value;
        if (node.operator === 'void' && t.isNumericLiteral(node.argument)) return undefined;
    }
    return NOT_A_LITERAL;
}

// ----- Table-lookup folder ----------------------------------------------

// Folds `<baseIdent>[<num>][<num>]…` chains in the AST by evaluating them
// against the sandbox. The base identifier must be something that lives in
// the sandbox (e.g. the `b` IIFE-init matrix) — top-level fn names are
// excluded so we don't try to index into a function.
//
// Primitives substitute directly. Object/array results get a synthetic
// numeric tag via `bundle.interner` so two lookups that return the same
// ref end up with equal tags — which lets the switch-case unflattener
// pair `for (e = b[436][315]; true;) { switch (e) { case b[343][448]: } }`
// against the initial state. Tags start at `TAG_BASE` to dodge any
// realistic case-value collisions in hand-written code.
//
// The interner MUST live on the shared bundle, not local state: pre-deob
// and post-deob calls both see `b[..][..]` expressions, and any ref that
// appears in both passes must map to the same tag. A local map would
// hand out tag 2147000000 to a fresh pre-deob ref and again to a fresh
// post-deob ref (potentially a different object), silently breaking
// switch-case matching on the state machines that use those values.
const TAG_BASE = 2_147_000_000;  // near INT32_MAX ceiling — collision-proof
function foldTableLookups(ast, bundle) {
    if (!bundle) return { folded: 0, failed: 0, interned: 0 };
    const { sandbox, topLevelFnNames } = bundle;
    if (!bundle.interner) bundle.interner = new Map();
    const interner = bundle.interner;
    let folded = 0, failed = 0;

    traverse(ast, {
        MemberExpression(path) {
            // Only match the outermost MemberExpression of a chain — Babel
            // visits deepest first, so a chain like `b[1][2][3]` triggers
            // this visitor for `b[1]`, `b[1][2]`, AND `b[1][2][3]`. We want
            // the one that represents the whole lookup, which is the one
            // whose parent is NOT itself a computed MemberExpression on us.
            const node = path.node;
            if (t.isMemberExpression(path.parent) &&
                path.parent.object === node &&
                path.parent.computed) return;

            // Build the chain: collect base ident + index nodes.
            const indices = [];
            let cur = node;
            while (t.isMemberExpression(cur) && cur.computed) {
                if (!t.isNumericLiteral(cur.property)) return; // non-numeric index — not a pure lookup
                indices.unshift(cur.property.value);
                cur = cur.object;
            }
            if (!t.isIdentifier(cur)) return;
            const baseName = cur.name;
            if (indices.length === 0) return;
            if (indices.length > 6) return; // ignore absurd chains

            // Scope-shadow guard. If `baseName` resolves to a binding in
            // a scope narrower than the module (i.e. a local `var w = []`
            // inside a function), then `w[0]` here references that local,
            // not the sandbox `w` we're about to look up. Evaluating
            // against the sandbox would coerce the function/array we
            // ingested as module-level `w` and produce junk (classically:
            // `<decoder-fn>[0] = undefined`, `>>> 0` → 0, the whole
            // bit-twiddle collapses to a stray integer).
            const binding = path.scope.getBinding(baseName);
            if (binding && binding.scope.block &&
                !t.isProgram(binding.scope.block)) return;

            // Base must be in the sandbox and NOT a function (functions are
            // not table-like — calling `MathFn[0]` would evaluate to undefined).
            const base = sandbox[baseName];
            if (base == null) return;
            if (typeof base === 'function') return;
            if (topLevelFnNames && topLevelFnNames.has(baseName)) return;

            // Evaluate the chain.
            let v = base;
            for (const i of indices) {
                if (v == null) return;
                v = v[i];
            }

            let replacement;
            if (typeof v === 'string' || typeof v === 'number' ||
                typeof v === 'boolean' || v === null || v === undefined) {
                replacement = valueToNode(v);
                if (!replacement) { failed++; return; }
            } else if (typeof v === 'object' || typeof v === 'function') {
                // Intern object refs to stable numeric tags — two lookups
                // landing on the same ref get equal tags, which is what the
                // switch-case unflattener needs to compare them.
                let tag = interner.get(v);
                if (tag === undefined) {
                    tag = TAG_BASE + interner.size;
                    interner.set(v, tag);
                }
                replacement = t.numericLiteral(tag);
            } else {
                failed++;
                return;
            }
            path.replaceWith(replacement);
            folded++;
        }
    });
    return { folded, failed, interned: interner.size };
}

// ----- Constant logical/conditional simplification ----------------------

// Fold the six classic identities that the existing simplifyExpressions
// misses because it needs full `path.evaluate()` confidence on the whole
// tree. These only need one side to be a known literal (or any node the
// evaluator can fully resolve, which includes folded arithmetic like
// `-471 > -6 * -3413 + 2592 - ... - 2048` after binary-expression pass).
//
//   true  && X   →  X
//   false && X   →  false (when X is pure; else `(X, false)` via Sequence)
//   X && true    →  X     (in value-context: X; Babel's evaluator alone
//                          won't do this because `X && true` genuinely
//                          returns X if truthy and X if falsy, so it IS X)
//   X && false   →  false (when X is pure)
//   true  || X   →  true  (when X is pure)
//   false || X   →  X
//   X || true    →  true  (when X is pure)
//   X || false   →  X     (in value-context: X)
//   true  ? a:b  →  a
//   false ? a:b  →  b
//   L == R  /  L != R  /  L === R  /  L !== R  /  L < R  /  etc.
//     for numeric/boolean/string/null/undefined literals → constant
//
// "Pure" here means: no CallExpression, MemberExpression, AssignmentExpression,
// typeof, new, or UpdateExpression in the subtree. Same conservative rule
// the rest of the pipeline uses.
// Direct recursive purity check. Previous version wrapped the node in a
// new File/Program + called `traverse` to find side effects — that costs
// O(subtree) *per call* AND allocates a fresh AST, so running it once per
// LogicalExpression/ConditionalExpression in a 150KB file added up to
// minutes and killed the pipeline. This version walks only the structural
// expression fields without allocating anything.
function isPureExpr(node) {
    if (!node || typeof node.type !== 'string') return true;
    const ty = node.type;
    if (ty === 'CallExpression' || ty === 'NewExpression' ||
        ty === 'MemberExpression' || ty === 'OptionalMemberExpression' ||
        ty === 'OptionalCallExpression' ||
        ty === 'AssignmentExpression' || ty === 'UpdateExpression' ||
        ty === 'YieldExpression' || ty === 'AwaitExpression') return false;
    if (ty === 'UnaryExpression' &&
        (node.operator === 'typeof' || node.operator === 'delete')) return false;

    switch (ty) {
        case 'BinaryExpression':
        case 'LogicalExpression':
            return isPureExpr(node.left) && isPureExpr(node.right);
        case 'UnaryExpression':
            return isPureExpr(node.argument);
        case 'ConditionalExpression':
            return isPureExpr(node.test) &&
                   isPureExpr(node.consequent) &&
                   isPureExpr(node.alternate);
        case 'SequenceExpression':
            for (const e of node.expressions) if (!isPureExpr(e)) return false;
            return true;
        case 'ArrayExpression':
            for (const e of node.elements) if (e && !isPureExpr(e)) return false;
            return true;
        case 'TemplateLiteral':
            for (const e of node.expressions) if (!isPureExpr(e)) return false;
            return true;
        default:
            // Literals, Identifiers, ThisExpression, etc.
            return true;
    }
}

function literalTruthiness(node) {
    if (t.isBooleanLiteral(node)) return { known: true, truthy: node.value };
    if (t.isNumericLiteral(node)) return { known: true, truthy: node.value !== 0 && !Number.isNaN(node.value) };
    if (t.isStringLiteral(node)) return { known: true, truthy: node.value.length > 0 };
    if (t.isNullLiteral(node)) return { known: true, truthy: false };
    if (t.isIdentifier(node, { name: 'undefined' })) return { known: true, truthy: false };
    if (t.isIdentifier(node, { name: 'NaN' })) return { known: true, truthy: false };
    if (t.isIdentifier(node, { name: 'Infinity' })) return { known: true, truthy: true };
    if (t.isUnaryExpression(node, { operator: 'void' })) return { known: true, truthy: false };
    if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) {
        return { known: true, truthy: node.argument.value !== 0 };
    }
    if (t.isUnaryExpression(node, { operator: '!' })) {
        const inner = literalTruthiness(node.argument);
        if (inner.known) return { known: true, truthy: !inner.truthy };
    }
    return { known: false };
}

// Cheap shape check for BinaryExpression sides — literals (number, string,
// boolean, null) or unary-prefixed literals (-5, +5, !0, ~0). Lets us skip
// `path.evaluate()` on the hot path when we already know it can't succeed.
function isEvaluableLiteral(node) {
    if (t.isNumericLiteral(node) || t.isStringLiteral(node) ||
        t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
    if (t.isIdentifier(node, { name: 'undefined' }) ||
        t.isIdentifier(node, { name: 'NaN' }) ||
        t.isIdentifier(node, { name: 'Infinity' })) return true;
    if (t.isUnaryExpression(node) && ['-', '+', '!', '~'].includes(node.operator)) {
        return isEvaluableLiteral(node.argument);
    }
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        return isEvaluableLiteral(node.left) && isEvaluableLiteral(node.right);
    }
    return false;
}

// Detect member-expression chains that read runtime state — the
// obfuscator deliberately wraps `navigator.*`, `window.*`, `document.*`,
// `performance.*`, `screen.*`, `<alias>.ddm.*`, `<alias>.ddResObj.*` reads
// with `|| 0` / `&& true` / `? … : …` defaults. extract_signals'
// LEGENDA matchers key on the wrappers; simplifying them breaks
// classification across variants. If any object OR property in the
// chain matches one of these well-known names, we preserve the wrapper.
const RUNTIME_ROOT_IDENTS = new Set([
    'navigator', 'document', 'window', 'performance',
    'self', 'globalThis', 'screen'
]);
const RUNTIME_PROP_NAMES = new Set([
    'navigator', 'document', 'window', 'performance',
    'screen', 'ddm', 'ddResObj'
]);
function readsRuntimeProperty(node) {
    if (!node) return false;
    let n = node;
    // Walk the chain. Stops at the first non-Member/non-Call node.
    while (n) {
        if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
            if (!n.computed && t.isIdentifier(n.property) && RUNTIME_PROP_NAMES.has(n.property.name)) return true;
            if (n.computed && t.isStringLiteral(n.property) && RUNTIME_PROP_NAMES.has(n.property.value)) return true;
            if (t.isIdentifier(n.object) && RUNTIME_ROOT_IDENTS.has(n.object.name)) return true;
            n = n.object;
        } else if (t.isCallExpression(n) || t.isNewExpression(n)) {
            n = n.callee;
        } else {
            break;
        }
    }
    return false;
}

// Signal-emit detector — same shape as the one in transformations/if-statements.js
// and transformations/switch-case.js. Catches `A('XnbZeN', s)` (resolved) AND
// `A(D(97), c[w(18)])` (still-obfuscated) so we can refuse to drop a branch
// that contains real `A(...)` emits, even at the post-deobfuscation sandbox
// stage where matrix-resolved equalities can fold to literal booleans and
// take an entire `for(n=…;…;) switch(n)` state machine with them.
const _SIGNAL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,30}$/;
function _collectEmits(nodeOrArray) {
    const out = new Set();
    const visit = (n) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) visit(x); return; }
        if (
            n.type === 'CallExpression' &&
            n.callee && n.callee.type === 'Identifier' &&
            n.callee.name && /^[A-Z]$/.test(n.callee.name) &&
            n.arguments && n.arguments.length >= 2 && n.arguments.length <= 3
        ) {
            const first = n.arguments[0];
            if (first && first.type === 'StringLiteral' &&
                typeof first.value === 'string' &&
                _SIGNAL_NAME_RE.test(first.value)) {
                out.add(first.value);
            } else {
                out.add(`@${n.callee.name}(${n.arguments.length})`);
            }
        }
        for (const key in n) {
            if (key === 'loc' || key === 'start' || key === 'end' ||
                key === 'leadingComments' || key === 'trailingComments' ||
                key === 'innerComments' || key === 'extra') continue;
            const child = n[key];
            if (child && typeof child === 'object') visit(child);
        }
    };
    visit(nodeOrArray);
    return out;
}
function _canSafelyFold(droppedBranch, keptBranch) {
    if (!droppedBranch) return true;
    const dropped = _collectEmits(droppedBranch);
    if (dropped.size === 0) return true;
    const kept = keptBranch ? _collectEmits(keptBranch) : new Set();
    for (const name of dropped) {
        if (!kept.has(name)) return false;
    }
    return true;
}

// Single traversal that runs all four simplifications. We rely on the
// outer pipeline (Post-deob + Post-unflatten) to iterate — avoiding an
// inner `while (progressed)` loop keeps this O(N) on the AST instead of
// O(changes · N), which used to balloon into minutes on captcha-sized
// modules.
function simplifyConstLogicalExprs(ast) {
    let changed = 0;
    traverse(ast, {
        LogicalExpression: {
            exit(path) {
                const { operator, left, right } = path.node;

                // Preserve `X.navigator.hardwareConcurrency || 0`,
                // `X.screen.width && …`, `a.ddm.userEnv ? … : …`, and
                // similar runtime-state reads. The obfuscator wraps these
                // expressions deliberately; extract_signals' LEGENDA
                // matchers and the server-side detection model both key
                // on the wrappers being present. Stripping `|| 0` off a
                // navigator read orphans every matcher that used it.
                if (readsRuntimeProperty(left) || readsRuntimeProperty(right)) return;

                const L = literalTruthiness(left);
                const R = literalTruthiness(right);
                let repl = null;
                if (operator === '&&') {
                    if (L.known && L.truthy) repl = right;                       // true  && X → X
                    else if (L.known && !L.truthy && isPureExpr(left)) repl = left;  // false && X → false
                    else if (R.known && R.truthy) repl = left;                   // X && true  → X
                    else if (R.known && !R.truthy && isPureExpr(left)) repl = right; // X && false → false
                } else if (operator === '||') {
                    if (L.known && !L.truthy) repl = right;                      // false || X → X
                    else if (L.known && L.truthy && isPureExpr(left)) repl = left;   // true  || X → true
                    else if (R.known && !R.truthy) repl = left;                  // X || false → X
                    else if (R.known && R.truthy && isPureExpr(left)) repl = right;  // X || true  → true
                }
                if (repl) {
                    path.replaceWith(repl);
                    changed++;
                }
            }
        },
        ConditionalExpression: {
            exit(path) {
                const L = literalTruthiness(path.node.test);
                if (!L.known) return;
                if (!isPureExpr(path.node.test)) return;
                // Same guard — preserve ternaries whose test reads a
                // runtime property (LEGENDA-distinctive wrappers).
                if (readsRuntimeProperty(path.node.test)) return;
                path.replaceWith(L.truthy ? path.node.consequent : path.node.alternate);
                changed++;
            }
        },
        BinaryExpression: {
            exit(path) {
                // Only try to evaluate when both sides are literal-shaped —
                // avoids an expensive evaluate() on every single
                // BinaryExpression in the AST. For a ~150KB captcha module
                // that's tens of thousands of nodes, and evaluate() on a
                // non-literal is wasted work.
                if (!isEvaluableLiteral(path.node.left)) return;
                if (!isEvaluableLiteral(path.node.right)) return;
                try {
                    const ev = path.evaluate();
                    if (!ev.confident) return;
                    const repl = valueToNode(ev.value);
                    if (!repl) return;
                    path.replaceWith(repl);
                    changed++;
                } catch {}
            }
        },
        IfStatement: {
            exit(path) {
                const L = literalTruthiness(path.node.test);
                if (!L.known) return;
                if (!isPureExpr(path.node.test)) return;
                // Refuse to drop a branch with signal emits the surviving
                // branch doesn't already cover. Without this, matrix-resolved
                // equalities like `f[w(847)][w(380)] == f[…][…]` that fold
                // to a constant boolean can silently delete an entire `for
                // (n=…;…;) switch(n) { case …: A('signal',…); }` state
                // machine sitting in the dropped branch. Empirically hits
                // interstitial-b9f50d5's worker-message handler (case 2 of
                // the Y switch) — drops ArlI2n, 5jNg41, mo2EqT.
                const dropped = L.truthy ? path.node.alternate : path.node.consequent;
                const kept    = L.truthy ? path.node.consequent : path.node.alternate;
                if (!_canSafelyFold(dropped, kept)) return;
                if (L.truthy) {
                    const c = path.node.consequent;
                    if (t.isBlockStatement(c)) path.replaceWithMultiple(c.body);
                    else path.replaceWith(c);
                } else {
                    const a = path.node.alternate;
                    if (!a) path.remove();
                    else if (t.isBlockStatement(a)) path.replaceWithMultiple(a.body);
                    else path.replaceWith(a);
                }
                changed++;
            }
        }
    });
    return changed;
}

// ----- Dead write-only binding removal ----------------------------------

// Drops top-level bindings whose only uses are writes (assignments) —
// values that are stored but never read. Common pattern in the obfuscated
// output: the original state-machine cases assigned the state var in
// positions where switch-case control flow consumed the value, but once
// we unflatten the machine those assignments become purely dead. Left
// alone, they keep the declaration `var s = 195, E = -363, …` alive and
// block inlineConstIdentifiers from folding everything at the use sites.
//
// For each stray assignment we either delete the statement entirely (if
// the RHS has no observable side effects) or replace it with the RHS
// (preserving any call it might make). Then the declarator itself goes.
function removeDeadWriteOnlyBindings(ast) {
    let removed = 0;
    traverse(ast, {
        Program(path) {
            const bindings = path.scope.bindings;
            for (const name in bindings) {
                const binding = bindings[name];
                if (!binding.path.isVariableDeclarator()) continue;
                if (binding.referencePaths.length > 0) continue;
                if (binding.constantViolations.length === 0) continue;

                // Remove each assignment, substituting the RHS when it
                // might have side effects.
                for (const violation of binding.constantViolations) {
                    if (!violation.node) continue; // already removed during this pass
                    const asn = violation.node;
                    if (!t.isAssignmentExpression(asn) || asn.operator !== '=') continue;
                    if (!t.isIdentifier(asn.left, { name })) continue;
                    const rhs = asn.right;
                    const rhsIsPure =
                        t.isLiteral(rhs) ||
                        t.isIdentifier(rhs) ||
                        (t.isUnaryExpression(rhs) && t.isLiteral(rhs.argument));
                    if (rhsIsPure) {
                        try { violation.remove(); } catch {}
                    } else {
                        try { violation.replaceWith(rhs); } catch {}
                    }
                }

                // Drop the declarator (its parent decl if that was the only one).
                const decl = binding.path.parentPath;
                try {
                    if (decl.isVariableDeclaration() && decl.node.declarations.length === 1) {
                        decl.remove();
                    } else {
                        binding.path.remove();
                    }
                } catch {}
                removed++;
            }
        }
    });
    return removed;
}

// ----- Dead IIFE-init removal -------------------------------------------

// Removes top-level `var X = <pure IIFE>;` declarators whose binding is
// never referenced. After `foldTableLookups` replaces every `X[i][j]` with
// a numeric tag, the table-init IIFE (the `b = function() { ... }()` that
// allocates the 128×512 matrix) becomes dead code. The generic
// `removeUnusedVariables` pass won't strip it because its init is a
// CallExpression — it conservatively assumes call sites have side effects.
// Here we know the IIFE is pure (we vetted it with `isSafeTableIIFE`
// when building the sandbox), so dropping it is safe.
function removeDeadTableInits(ast) {
    let removed = 0;
    traverse(ast, {
        Program(path) {
            const bindings = path.scope.bindings;
            for (const name in bindings) {
                const binding = bindings[name];
                if (!binding.path.isVariableDeclarator()) continue;
                const init = binding.path.node.init;
                if (!init || !isSafeTableIIFE(init)) continue;
                if (binding.referencePaths.length > 0) continue;
                const decl = binding.path.parentPath;
                if (!decl.isVariableDeclaration()) continue;
                if (decl.node.declarations.length === 1) decl.remove();
                else binding.path.remove();
                removed++;
            }
        }
    });
    return removed;
}

// ----- Bracket normalization --------------------------------------------

// Converts `obj["name"]` → `obj.name` where `name` is a valid JS
// identifier. Lets downstream substring matching (LEGENDA, etc.) find
// chained property accesses regardless of bracket-vs-dot style.
function normalizeBracketAccess(ast) {
    let converted = 0;
    traverse(ast, {
        MemberExpression(path) {
            const n = path.node;
            if (!n.computed) return;
            if (!t.isStringLiteral(n.property)) return;
            if (!ID_RE.test(n.property.value)) return;
            n.property = t.identifier(n.property.value);
            n.computed = false;
            converted++;
        }
    });
    return converted;
}

// ----- Backwards-compat single-shot API (used by extract_signals) -------

// One-call convenience wrapper: build sandbox, resolve decoder calls,
// fold safe calls. Returns a flat stats object. If the module isn't
// a recognizable bundle shape, returns `{ resolved: 0, folded: 0, skipped: '...' }`.
function decodeStringTable(ast, logger) {
    const bundle = buildBundleSandbox(ast, logger);
    if (!bundle) return { resolved: 0, folded: 0, skipped: 'no sandbox' };
    const res = resolveDecoderCalls(ast, bundle);
    const fold = foldSafeCalls(ast, bundle);
    return {
        resolved: res.resolved,
        resolveFailed: res.failed,
        folded: fold.folded,
        foldFailed: fold.failed,
        decoderName: bundle.decoderName,
        windowAliases: Array.from(bundle.windowAliases),
    };
}

module.exports = {
    buildBundleSandbox,
    resolveDecoderCalls,
    foldSafeCalls,
    inlineConstIdentifiers,
    foldTableLookups,
    simplifyConstLogicalExprs,
    removeDeadTableInits,
    removeDeadWriteOnlyBindings,
    normalizeBracketAccess,
    decodeStringTable,
};
