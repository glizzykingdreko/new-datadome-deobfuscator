// Post-processing extractor for the WASM-challenge input field list.
//
// Captcha and interstitial bundles both feed a fixed-length Uint32Array
// into `<obj>.exports.wasm_b(...)`, and the elements of that array are
// what the compiled WebAssembly module hashes to produce the challenge
// response. The shape is always:
//
//   var R = new I.Uint32Array([
//     JD(I.ddm.userEnv, I.navigator.hardwareConcurrency || 0) >>> 0,
//     JD(I.ddm.userEnv, D.u.br_oh)                           >>> 0,
//     JD(I.ddm.userEnv, I.navigator.maxTouchPoints || 0)     >>> 0,
//     JD(I.ddm.userEnv, I.navigator.maxTouchPoints || 0)     >>> 0
//   ]);
//   A('<6-char-obf-name>', R.exports.wasm_b(R) >>> 0);
//
// The interesting part — for a solver rebuilding the payload without
// actually running the wasm — is the *ordered list of field names* the
// obfuscator decided to hash on this variant. We recover them by walking
// to the `wasm_b` call, resolving the Uint32Array binding, and reading
// the second argument of each inner `JD(userEnv, <EXPR>)` call. The
// "name" of `<EXPR>` is the deepest property of its MemberExpression
// chain; the optional `|| 0` default is stripped first.
//
// The outer `A('…', …)` signal name is *ignored on purpose* — it's a
// random 6-char obfuscator-generated label that rolls every build, so
// it carries no semantic value across variants.
//
// Returns `null` when the call can't be found or the array binding can't
// be resolved — which is the normal case for tags (no wasm) and for
// rows where the extractor hit an unfamiliar shape. Otherwise returns
// the ordered list of field names as a bare `string[]`. Callers nest it
// into the existing `wasm` report blob as the `fields` subfield.

const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

// Match any member-expression chain that ends in `.exports.wasm_b`. The
// prefix varies across variants: `R.exports.wasm_b`, `Q.instance.exports.wasm_b`,
// `x.y.z.exports.wasm_b` — all legal. We only care that the last two
// hops are `.exports.wasm_b`.
function calleeIsWasmB(callee) {
    if (!t.isMemberExpression(callee)) return false;
    if (callee.computed) {
        if (!t.isStringLiteral(callee.property, { value: 'wasm_b' })) return false;
    } else {
        if (!t.isIdentifier(callee.property, { name: 'wasm_b' })) return false;
    }
    const outer = callee.object;
    if (!t.isMemberExpression(outer)) return false;
    if (outer.computed) {
        return t.isStringLiteral(outer.property, { value: 'exports' });
    }
    return t.isIdentifier(outer.property, { name: 'exports' });
}

// Strip a trailing `>>> 0` / `| 0` / `|| 0` wrapper. These are redundant
// coerce-to-uint32 wrappers around the real expression; the field name
// lives inside.
function unwrapCoerce(node) {
    if (t.isBinaryExpression(node) &&
        (node.operator === '>>>' || node.operator === '|') &&
        t.isNumericLiteral(node.right, { value: 0 })) {
        return unwrapCoerce(node.left);
    }
    if (t.isLogicalExpression(node) &&
        node.operator === '||' &&
        t.isNumericLiteral(node.right, { value: 0 })) {
        return unwrapCoerce(node.left);
    }
    return node;
}

// Deepest property of a MemberExpression chain, e.g.:
//   M.navigator.hardwareConcurrency → "hardwareConcurrency"
//   D.u.br_oh                       → "br_oh"
//   I["navigator"]["maxTouchPoints"] → "maxTouchPoints"
// Returns null when the node isn't a recognisable MemberExpression or
// its leaf property isn't a literal identifier/string.
function deepestPropertyName(node) {
    if (!t.isMemberExpression(node) && !t.isOptionalMemberExpression(node)) return null;
    const prop = node.property;
    if (!node.computed && t.isIdentifier(prop)) return prop.name;
    if (node.computed && t.isStringLiteral(prop)) return prop.value;
    return null;
}

// Find the wasm_b call and return its Uint32Array identifier argument.
// The outer signal call `A('<6-char>', <obj>.exports.wasm_b(<arr>) >>> 0)`
// is only used to scope the search; we don't capture the name from it.
function findWasmChallengeCall(ast) {
    let hit = null;
    traverse(ast, {
        CallExpression(path) {
            if (hit) return;
            if (!calleeIsWasmB(path.node.callee)) return;
            if (path.node.arguments.length < 1) return;
            const arrArg = path.node.arguments[0];
            if (!t.isIdentifier(arrArg)) return;
            hit = { callPath: path, arrayIdent: arrArg };
            path.stop();
        }
    });
    return hit;
}

// Given an Identifier that names a `var R = new X.Uint32Array([...])`,
// walk its binding and return the element-node array. Returns null if
// the binding isn't resolvable, isn't a VariableDeclarator, or the init
// isn't a `new …Uint32Array([…])` call.
function resolveUint32ArrayElements(callPath, arrayIdent) {
    const binding = callPath.scope.getBinding(arrayIdent.name);
    if (!binding) return null;
    if (!binding.path.isVariableDeclarator()) return null;
    const init = binding.path.node.init;
    if (!t.isNewExpression(init)) return null;
    // Callee can be `Uint32Array` (bare) or `<alias>.Uint32Array`
    // (computed or dotted). We only care that it ends with `Uint32Array`.
    const callee = init.callee;
    const isUint32 = (n) => {
        if (t.isIdentifier(n, { name: 'Uint32Array' })) return true;
        if (t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) {
            if (!n.computed && t.isIdentifier(n.property, { name: 'Uint32Array' })) return true;
            if (n.computed && t.isStringLiteral(n.property, { value: 'Uint32Array' })) return true;
        }
        return false;
    };
    if (!isUint32(callee)) return null;
    if (init.arguments.length < 1) return null;
    const arg0 = init.arguments[0];
    if (!t.isArrayExpression(arg0)) return null;
    return arg0.elements;
}

// Extract the "field name" from a single Uint32Array element. The shape
// is `JD(<userEnv>, <EXPR>) >>> 0`; we strip the coerce wrapper, take
// arguments[1] of the call, strip its `|| 0` default, and read the
// deepest property name. Falls back to generated source text when the
// shape doesn't match — future variants get a readable sentinel
// instead of a silent drop.
function fieldNameFromElement(elem) {
    if (elem == null) return null;
    const inner = unwrapCoerce(elem);
    if (!t.isCallExpression(inner)) {
        return { name: null, raw: generate(elem).code, reason: 'not-a-call' };
    }
    if (inner.arguments.length < 2) {
        return { name: null, raw: generate(elem).code, reason: 'too-few-args' };
    }
    const expr = unwrapCoerce(inner.arguments[1]);
    // Direct string literal (`JD(env, "br_oh")`) — rare but possible.
    if (t.isStringLiteral(expr)) return { name: expr.value, raw: generate(elem).code };
    const leaf = deepestPropertyName(expr);
    if (leaf) return { name: leaf, raw: generate(elem).code };
    return { name: null, raw: generate(elem).code, reason: 'unresolved-leaf' };
}

// Returns the ordered list of field names as a bare `string[]`, or null
// when no wasm_b call / array binding is found. Callers merge the list
// into the existing `wasm` report blob as `wasm.fields`.
function extractWasmChallengeFields(ast, logger) {
    const hit = findWasmChallengeCall(ast);
    if (!hit) return null;

    const elements = resolveUint32ArrayElements(hit.callPath, hit.arrayIdent);
    if (!elements) {
        logger && logger.debug('extractWasmChallengeFields: wasm_b call found but Uint32Array binding unresolved', {
            identifier: hit.arrayIdent.name
        });
        return null;
    }

    const perElement = elements.map(fieldNameFromElement);
    const fields = perElement.map(e => e && e.name).filter(Boolean);

    if (fields.length !== elements.length) {
        logger && logger.warn('extractWasmChallengeFields: some elements unresolved, emitting what we have', {
            total: elements.length,
            resolved: fields.length,
            details: perElement
        });
    }

    return fields;
}

module.exports = { extractWasmChallengeFields };
