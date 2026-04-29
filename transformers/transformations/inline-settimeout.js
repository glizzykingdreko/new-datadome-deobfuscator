/**
 * Unwrap `setTimeout(function() { ... }, 0)` wrappers.
 *
 * DataDome heavily uses `setTimeout(fn, 0)` to defer execution by one tick,
 * not for timing but as a control-flow obfuscation. Every batch of initial
 * assignments ends up looking like:
 *
 *     setTimeout(function () { t = 26; }, 0),
 *     setTimeout(function () { z = -192; }, 0),
 *     setTimeout(function () { i = -172; }, 0);
 *
 * At runtime these just run once. The timer ID returned by setTimeout is
 * never captured. Pulling the body out inlines the real code and lets the
 * rest of the pipeline (dead-code elimination, variable inlining) do its job.
 *
 * We only unwrap when:
 *   - the callee is `setTimeout` (or `<any>.setTimeout`),
 *   - the delay argument is the literal 0,
 *   - the first argument is a zero-param function,
 *   - the function body is empty or only expression statements (so it can
 *     become a plain expression when the call sits inside a larger one).
 */

const traverse = require("@babel/traverse").default;
const t = require("@babel/types");

function isSetTimeoutCallee(callee) {
    if (t.isIdentifier(callee, { name: "setTimeout" })) return true;
    if (
        t.isMemberExpression(callee) &&
        !callee.computed &&
        t.isIdentifier(callee.property, { name: "setTimeout" })
    ) return true;
    if (
        t.isMemberExpression(callee) &&
        callee.computed &&
        t.isStringLiteral(callee.property, { value: "setTimeout" })
    ) return true;
    return false;
}

function inlineSetTimeoutZero(ast, logger = null, result = null) {
    let unwrapped = 0;
    let removed = 0;

    traverse(ast, {
        CallExpression(path) {
            const node = path.node;
            if (!isSetTimeoutCallee(node.callee)) return;
            if (node.arguments.length < 2) return;

            const [fn, delay] = node.arguments;
            if (!t.isNumericLiteral(delay, { value: 0 })) return;
            if (!t.isFunctionExpression(fn) && !t.isArrowFunctionExpression(fn)) return;
            if (fn.params && fn.params.length > 0) return;

            // Collect body statements.
            let stmts;
            if (t.isBlockStatement(fn.body)) {
                stmts = fn.body.body;
            } else {
                // Arrow with expression body.
                stmts = [t.expressionStatement(fn.body)];
            }

            // Only unwrap if every statement is an ExpressionStatement — otherwise
            // inlining into the caller's expression context breaks semantics.
            if (!stmts.every((s) => t.isExpressionStatement(s))) return;

            if (stmts.length === 0) {
                // Empty setTimeout(function(){}, 0) — noop.
                if (t.isExpressionStatement(path.parent)) {
                    path.parentPath.remove();
                } else {
                    // Inside a SequenceExpression/etc: replace with `0` so the
                    // surrounding tree stays well-formed; simplifyExpressions
                    // will strip it later.
                    path.replaceWith(t.numericLiteral(0));
                }
                removed++;
                return;
            }

            const expressions = stmts.map((s) => s.expression);
            const replacement =
                expressions.length === 1
                    ? expressions[0]
                    : t.sequenceExpression(expressions);

            path.replaceWith(replacement);
            unwrapped++;
        }
    });

    if (logger) logger.info(`Inline setTimeout(fn, 0): unwrapped ${unwrapped}, removed ${removed} empty`);
    if (result && result.stats && result.stats.transformations) {
        result.stats.transformations.setTimeoutUnwrapped =
            (result.stats.transformations.setTimeoutUnwrapped || 0) + unwrapped + removed;
    }
    return unwrapped > 0 || removed > 0;
}

module.exports = { inlineSetTimeoutZero };
