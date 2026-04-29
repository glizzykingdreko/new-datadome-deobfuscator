// Pulls out the `dynamicChallenge` bit-twiddling expression that DataDome
// hashes across (build-sig, br_ow, br_oh, hardwareConcurrency). The expression
// is a long bundle of `X[0] >>> 0 | X[1] ...` operations where `X` is a
// locally-named array (`o`, `a`, `n`, whatever the minifier picked).
//
// We locate the call `_('dynamicChallenge', <expr>)` in the module AST,
// clone the expression node so mutations don't affect the emitted source,
// rename every identifier used as the index-base of a numeric-indexed
// MemberExpression (the `o` in `o[0]`, `o[1]`, …) to `X`, and return the
// generated code.
//
// Returns `null` when the call can't be found — which is the normal case
// for modules other than captcha/interstitial; callers should simply not
// attach `dynamic_challenge` to those module entries.

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const TARGET_NAME_KEY = 'dynamicChallenge';

// Walk the expression and find every identifier used as `foo[<number>]`.
// Usually a single name, but keep a set in case future builds spread the
// hash across multiple arrays.
function findArrayBases(exprNode) {
    const names = new Set();
    const subtreeRoot = t.file(t.program([t.expressionStatement(exprNode)]));
    traverse(subtreeRoot, {
        MemberExpression(p) {
            if (t.isIdentifier(p.node.object) && t.isNumericLiteral(p.node.property)) {
                names.add(p.node.object.name);
            }
        }
    });
    return names;
}

// Shape-based fallback for when the signal-name string isn't resolved by
// the deobfuscator. The dynamic-challenge expression is a giant bit-twiddle:
//   * an `X[N]`-style MemberExpression with NumericLiteral index for at
//     least three distinct N (the `o[0]`/`o[1]`/`o[2]` triple).
//   * a terminal XOR with a large integer constant (`^ 806081892` style).
//   * many `>>> 0` operators.
function scoreExpressionShape(exprNode) {
    const wrapped = t.file(t.program([t.expressionStatement(exprNode)]));
    const indices = new Set();
    let hasLargeIntXor = false;
    let binExprCount = 0;
    traverse(wrapped, {
        MemberExpression(p) {
            if (t.isIdentifier(p.node.object) && t.isNumericLiteral(p.node.property)) {
                indices.add(p.node.property.value);
            }
        },
        BinaryExpression(p) {
            binExprCount++;
            if (p.node.operator === '^' &&
                t.isNumericLiteral(p.node.right) &&
                p.node.right.value > 1_000_000) {
                hasLargeIntXor = true;
            }
        }
    });
    return { indices, indexCount: indices.size, hasLargeIntXor, binExprCount };
}

function looksLikeDynamicChallenge(exprNode) {
    if (!t.isBinaryExpression(exprNode)) return false;
    const s = scoreExpressionShape(exprNode);
    return s.indexCount >= 3 && s.hasLargeIntXor && s.binExprCount >= 30;
}

// Lazy-loaded to avoid a circular require between extractDynamicChallenge
// and bundleSandbox (bundleSandbox imports nothing from here, but the
// project's module graph is happier when the dependency is one-way).
let _bundleSandbox = null;
function getBundleSandbox() {
    if (!_bundleSandbox) _bundleSandbox = require('./bundleSandbox');
    return _bundleSandbox;
}

function extractDynamicChallenge(ast, logger, bundle = null) {
    let match = null;
    let matchedBy = null;

    // Pass 1: name-based — ideal case where the deobfuscator resolved the
    // signal-name string literal.
    traverse(ast, {
        CallExpression(path) {
            if (match) return;
            const node = path.node;
            if (node.arguments.length !== 2) return;
            const first = node.arguments[0];
            if (!t.isStringLiteral(first, { value: TARGET_NAME_KEY })) return;
            match = node.arguments[1];
            matchedBy = 'name';
            path.stop();
        }
    });

    // Pass 2: shape-based — catches builds where the signal name is still
    // encoded to a short obfuscated string like `'8CajNe'`.
    if (!match) {
        traverse(ast, {
            CallExpression(path) {
                if (match) return;
                const node = path.node;
                if (node.arguments.length !== 2) return;
                const second = node.arguments[1];
                if (!looksLikeDynamicChallenge(second)) return;
                match = second;
                matchedBy = 'shape';
                path.stop();
            }
        });
    }

    if (!match) return null;

    // Deep-clone via serialize/reparse so we don't mutate the source AST.
    const cloned = parser.parseExpression(generate(match).code);

    const bases = findArrayBases(cloned);
    if (bases.size === 0) {
        logger && logger.warn('extractDynamicChallenge: found call but no array index bases to rewrite');
    }

    const wrapper = t.file(t.program([t.expressionStatement(cloned)]));

    // Resolve inner decoder calls on the CLONE so the reported expression
    // shows concrete literals instead of `w(uQ(1242, 2005))` chains. Only
    // runs when the caller handed us a bundle sandbox — the module-level
    // `w` / helpers / tables it holds are exactly what the bit-twiddle
    // needs. The clone is scope-free (plain expression in a synthetic
    // Program), so the scope-shadow guards in foldSafeCalls / foldTableLookups
    // never fire here; they're only relevant to the original AST where a
    // local `var w = []` shadows the module binding.
    if (bundle) {
        try {
            const sandbox = getBundleSandbox();
            // Loop until stable — one fold can expose another (e.g.
            // `w(uQ(1242, 2005))` needs `uQ(1242, 2005) → <num>` before
            // `w(<num>)` becomes foldable).
            for (let i = 0; i < 5; i++) {
                let progressed = false;
                const r1 = sandbox.foldSafeCalls(wrapper, bundle);
                if (r1.folded > 0) progressed = true;
                const r2 = sandbox.resolveDecoderCalls(wrapper, bundle);
                if (r2.resolved > 0) progressed = true;
                if (!progressed) break;
            }
        } catch (err) {
            logger && logger.debug('extractDynamicChallenge: inner-call resolve failed, emitting raw expression', { error: err.message });
        }
    }

    traverse(wrapper, {
        Identifier(p) {
            if (!bases.has(p.node.name)) return;
            // Only rename when this identifier is the .object of a MemberExpression.
            if (t.isMemberExpression(p.parent) && p.parent.object === p.node) {
                p.node.name = 'X';
            }
        }
    });

    // The cloned expression lives at wrapper.program.body[0].expression — use
    // that instead of `cloned` in case babel replaced the top-level node
    // during the fold/resolve passes.
    const finalExpr = wrapper.program.body[0].expression;
    const code = generate(finalExpr, { compact: false, comments: false }).code;
    return {
        expression: code,
        originalArrayNames: Array.from(bases),
        matchedBy, // 'name' | 'shape' — which detection path found it
    };
}

module.exports = { extractDynamicChallenge };
