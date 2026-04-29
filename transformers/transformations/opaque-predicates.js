/**
 * Fold opaque predicates — MBA (Mixed Boolean-Arithmetic) obfuscation.
 *
 * DataDome injects expressions like:
 *   -3 * (F & -881) + 1 * ~(F & o) - 4 * ~(F | o) - 2 * ~(F | -881) + -2643 > -388
 * These look variable-dependent but actually collapse to a constant because of
 * identities like (x&y) + (x&~y) = x and ~(x|y) = ~x & ~y. The result is
 * always true/false regardless of F and o.
 *
 * Strategy: for each "pure" arithmetic/bitwise/comparison expression,
 *   1. Collect its free identifiers.
 *   2. If Babel reports any of them as constant-bound to a numeric literal in
 *      scope, pin that value; otherwise the identifier is free.
 *   3. Run N trials with randomised 32-bit integers for each free identifier.
 *   4. If every trial produces the same value, replace the expression with
 *      that literal.
 *
 * We only fold expressions whose tree is pure — no calls, no member access,
 * no assignments — so substituting identifiers with arbitrary integers has
 * the same semantics the runtime would compute.
 */

const traverse = require("@babel/traverse").default;
const generate = require("@babel/generator").default;
const t = require("@babel/types");

const PURE_BINOPS = new Set([
    "+", "-", "*", "/", "%", "**",
    "&", "|", "^", "<<", ">>", ">>>",
    "==", "!=", "===", "!==",
    "<", "<=", ">", ">="
]);
const PURE_UNARYOPS = new Set(["-", "+", "~", "!"]);

// Collect free identifiers in a pure-arithmetic subtree. Returns null if the
// subtree contains any unsupported construct (call, member, assignment, etc.)
function collectFreeIdents(node, out) {
    if (
        t.isNumericLiteral(node) ||
        t.isBooleanLiteral(node) ||
        t.isNullLiteral(node)
    ) {
        return true;
    }
    if (t.isIdentifier(node)) {
        if (node.name === "undefined" || node.name === "NaN" || node.name === "Infinity") return true;
        out.add(node.name);
        return true;
    }
    if (t.isUnaryExpression(node) && PURE_UNARYOPS.has(node.operator)) {
        return collectFreeIdents(node.argument, out);
    }
    if (t.isBinaryExpression(node) && PURE_BINOPS.has(node.operator)) {
        return collectFreeIdents(node.left, out) && collectFreeIdents(node.right, out);
    }
    return false;
}

// Try to extract a numeric constant bound to `name` at the given scope. Only
// returns a value if Babel marks the binding as constant AND init is a literal
// (or negated literal).
function resolveConstant(scope, name) {
    const binding = scope.getBinding(name);
    if (!binding || !binding.constant) return undefined;
    const init = binding.path.node.init;
    if (!init) return undefined;
    if (t.isNumericLiteral(init)) return init.value;
    if (
        t.isUnaryExpression(init) &&
        (init.operator === "-" || init.operator === "+") &&
        t.isNumericLiteral(init.argument)
    ) {
        return init.operator === "-" ? -init.argument.value : init.argument.value;
    }
    if (t.isBooleanLiteral(init)) return init.value;
    return undefined;
}

const TRIAL_PROBES = [0, 1, -1, 2, -2, 0x7fffffff, -0x80000000, 42, -7, 0xdeadbeef | 0];
const EXTRA_TRIALS = 10;

function randomInt32() {
    return (Math.random() * 0x100000000 - 0x80000000) | 0;
}

// Fit `a*x + b*y + c` to a pure-integer function of 1 or 2 free variables.
// Returns {a, b, c} if the expression matches on many random samples, else null.
// Fixed-value inputs (from scope constants) are passed through `fixedArgsTemplate`.
function fitLinear(fn, argOrder, fixed, freeVars) {
    if (freeVars.length < 1 || freeVars.length > 2) return null;

    const argsAt = (values) => {
        return argOrder.map((name) => {
            if (name in fixed) return fixed[name];
            return values[name] ?? 0;
        });
    };

    let c, a, b = 0;
    try {
        c = fn(...argsAt({}));
        const aSample = fn(...argsAt({ [freeVars[0]]: 1 }));
        if (typeof c !== "number" || typeof aSample !== "number") return null;
        if (!Number.isFinite(c) || !Number.isFinite(aSample)) return null;
        a = aSample - c;
        if (freeVars.length === 2) {
            const bSample = fn(...argsAt({ [freeVars[1]]: 1 }));
            if (typeof bSample !== "number" || !Number.isFinite(bSample)) return null;
            b = bSample - c;
        }
    } catch (_) { return null; }

    // Require integer coefficients in a reasonable range — MBA output is always
    // tiny integers. Large coefficients mean the fit is spurious.
    if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return null;
    if (Math.abs(a) > 10 || Math.abs(b) > 10) return null;

    // Verify on many random samples (integers + boundary values).
    const verifyProbes = [0, 1, -1, 2, -2, 7, -7, 100, -100, 12345, -54321];
    for (let trial = 0; trial < 40; trial++) {
        const vals = {};
        if (trial < verifyProbes.length * verifyProbes.length && freeVars.length === 2) {
            vals[freeVars[0]] = verifyProbes[trial % verifyProbes.length];
            vals[freeVars[1]] = verifyProbes[Math.floor(trial / verifyProbes.length) % verifyProbes.length];
        } else if (trial < verifyProbes.length && freeVars.length === 1) {
            vals[freeVars[0]] = verifyProbes[trial];
        } else {
            for (const v of freeVars) vals[v] = randomInt32();
        }
        let actual;
        try { actual = fn(...argsAt(vals)); }
        catch (_) { return null; }
        const xv = vals[freeVars[0]] ?? 0;
        const yv = freeVars.length === 2 ? (vals[freeVars[1]] ?? 0) : 0;
        const expected = (a * xv + b * yv + c) | 0;
        // Use 32-bit integer comparison — MBA output is always 32-bit.
        if (((actual | 0) !== expected)) return null;
    }

    return { a, b, c };
}

// Build an AST node for `a*x + b*y + c` with literal-simplification
// (drop zero terms, emit `x` instead of `1*x`, `-x` instead of `-1*x`).
function buildLinear({ a, b, c }, freeVars) {
    const terms = [];
    const emitTerm = (coef, ident) => {
        if (coef === 0) return null;
        if (coef === 1) return t.identifier(ident);
        if (coef === -1) return t.unaryExpression("-", t.identifier(ident));
        return t.binaryExpression("*", t.numericLiteral(coef), t.identifier(ident));
    };
    const ax = emitTerm(a, freeVars[0]);
    if (ax) terms.push(ax);
    if (freeVars.length === 2) {
        const by = emitTerm(b, freeVars[1]);
        if (by) terms.push(by);
    }

    let expr = terms.length ? terms[0] : null;
    for (let i = 1; i < terms.length; i++) {
        // Fold `+ -x` into `- x` for readability.
        if (t.isUnaryExpression(terms[i]) && terms[i].operator === "-") {
            expr = t.binaryExpression("-", expr, terms[i].argument);
        } else {
            expr = t.binaryExpression("+", expr, terms[i]);
        }
    }
    if (c !== 0 || !expr) {
        if (!expr) return t.numericLiteral(c);
        if (c < 0) {
            expr = t.binaryExpression("-", expr, t.numericLiteral(-c));
        } else {
            expr = t.binaryExpression("+", expr, t.numericLiteral(c));
        }
    }
    return expr;
}

function equalNumeric(a, b) {
    if (typeof a !== typeof b) return false;
    if (typeof a === "number") {
        if (Number.isNaN(a) && Number.isNaN(b)) return true;
        return Object.is(a, b);
    }
    return a === b;
}

// Measure an expression's "MBA weight" — the number of bitwise ops it contains.
// We only bother simplifying nodes with weight >= 2 (a single `x & y` is not
// worth rewriting, but several stacked bitwise ops usually are MBA junk).
function bitwiseOpCount(node) {
    if (!node) return 0;
    let count = 0;
    if (t.isBinaryExpression(node)) {
        if (["&", "|", "^", "<<", ">>", ">>>"].includes(node.operator)) count++;
        count += bitwiseOpCount(node.left);
        count += bitwiseOpCount(node.right);
    } else if (t.isUnaryExpression(node) && node.operator === "~") {
        count++;
        count += bitwiseOpCount(node.argument);
    }
    return count;
}

function foldOpaquePredicates(ast, logger = null, result = null) {
    let changed = false;
    let foldedConst = 0;
    let foldedLinear = 0;
    let attempted = 0;

    traverse(ast, {
        BinaryExpression: {
            exit(path) {
                if (!path.node) return;
                const code = generate(path.node).code;
                if (code.length < 20) return;

                const freeSet = new Set();
                if (!collectFreeIdents(path.node, freeSet)) return;
                if (freeSet.size === 0) return;

                // Partition identifiers into fixed-constants and true-free.
                const fixed = {};
                const freeVars = [];
                for (const name of freeSet) {
                    const val = resolveConstant(path.scope, name);
                    if (val !== undefined) {
                        fixed[name] = val;
                    } else {
                        freeVars.push(name);
                    }
                }

                attempted++;

                const argOrder = [...Object.keys(fixed), ...freeVars];
                let fn;
                try {
                    fn = new Function(...argOrder, `return (${code});`);
                } catch (_) {
                    return;
                }

                const fixedArgs = argOrder.map((n) => (n in fixed ? fixed[n] : null));

                // First try: invariant folding (expression is the same for all free-var values).
                let canonical;
                let consistent = true;
                const trialCount = TRIAL_PROBES.length + EXTRA_TRIALS;
                for (let trial = 0; trial < trialCount; trial++) {
                    const args = fixedArgs.slice();
                    for (let i = Object.keys(fixed).length; i < argOrder.length; i++) {
                        const probe = trial < TRIAL_PROBES.length ? TRIAL_PROBES[trial] : randomInt32();
                        args[i] = probe;
                    }
                    let val;
                    try { val = fn(...args); }
                    catch (_) { consistent = false; break; }
                    if (trial === 0) canonical = val;
                    else if (!equalNumeric(val, canonical)) { consistent = false; break; }
                }

                if (consistent) {
                    if (typeof canonical === "number") {
                        if (Number.isNaN(canonical) || !Number.isFinite(canonical)) return;
                    } else if (typeof canonical !== "boolean") return;
                    try {
                        path.replaceWith(t.valueToNode(canonical));
                        changed = true;
                        foldedConst++;
                    } catch (_) {}
                    return;
                }

                // Second try: linear-MBA simplification (`<expr>` collapses to
                // `a*x + b*y + c`). Only worth attempting on expressions that
                // actually look like MBA (several bitwise ops).
                if (bitwiseOpCount(path.node) < 2) return;
                const fit = fitLinear(fn, argOrder, fixed, freeVars);
                if (!fit) return;

                try {
                    const newNode = buildLinear(fit, freeVars);
                    // Sanity check: don't replace if the new form is larger than the old.
                    const newCode = generate(newNode).code;
                    if (newCode.length >= code.length) return;
                    path.replaceWith(newNode);
                    changed = true;
                    foldedLinear++;
                } catch (_) {}
            }
        }
    });

    if (logger) {
        logger.info(
            `Opaque predicate folding: ${foldedConst} constants, ${foldedLinear} linear (out of ${attempted})`
        );
    }
    if (result && result.stats && result.stats.transformations) {
        result.stats.transformations.opaquePredicatesFolded =
            (result.stats.transformations.opaquePredicatesFolded || 0) + foldedConst + foldedLinear;
    }
    return changed;
}

module.exports = { foldOpaquePredicates };
