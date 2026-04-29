// Post-processing extractor for WebAssembly.Instance plumbing.
//
// DataDome's captcha.js and interstitial.js embed a compiled-to-WASM
// module that's executed client-side to compute the detection payload.
// The shape is always:
//
//   1. A base64 string starts with "AGFzbQ" (the \0asm\x01\x00\x00\x00
//      WebAssembly magic header). Decoded, it's the raw WASM bytes.
//        var s = "AGFzbQEAAAAB…";
//
//   2. A `new <windowAlias>.WebAssembly.Instance(<module>, <imports>)`
//      call consumes a module (compiled from the base64 above) and an
//      imports object.
//        var R = new I.WebAssembly.Instance(u, N);
//
//   3. The imports object is produced by a top-level function whose
//      body is a big `return A.wbg = {}, A.wbg.__wbg_… = function(){…}`
//      sequence. That function is the "imports provider".
//        var N = wD();
//        function wD() { var A = {}; return A.wbg = {}, …; }
//
//   4. Inside the imports provider, some WBG shims reach out to the
//      window alias (`I.DataView`, `I.Uint32Array`, `new I.Error(…)`);
//      others call external helpers (`kD.decode(…)`, `ID()`, …).
//
// This module finds all four pieces and returns a structured report
// with the wasm bytes (still base64), the imports-provider source, the
// list of `window.*` properties the provider touches, and the source
// code of every external helper transitively referenced by the
// provider. The agent wiring this into the report adds them as a
// `wasm` field on the module entry; the database layer consumes the
// same shape.

const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

// ----- Helpers ----------------------------------------------------------

// Turn a member-expression chain into a dotted string, e.g.
// `I.WebAssembly.Instance` → `"I.WebAssembly.Instance"`, including the
// computed-`["X"]` form. Returns null for anything else (CallExpression,
// computed with non-literal property, etc.).
function dottedPath(node) {
    if (t.isIdentifier(node)) return node.name;
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
        const left = dottedPath(node.object);
        if (!left) return null;
        if (!node.computed && t.isIdentifier(node.property)) return left + '.' + node.property.name;
        if (node.computed && t.isStringLiteral(node.property)) return left + '.' + node.property.value;
    }
    return null;
}

// Wrap a naked AST node inside a File so `traverse` works. Accepts any
// Statement, Expression, or VariableDeclarator. Declarators get promoted
// to a `var` declaration so the program body stays well-formed.
function wrapFile(node) {
    let stmt;
    if (t.isStatement(node)) stmt = node;
    else if (t.isExpression(node)) stmt = t.expressionStatement(node);
    else if (t.isVariableDeclarator(node)) stmt = t.variableDeclaration('var', [node]);
    else stmt = t.expressionStatement(t.nullLiteral()); // unreachable — only walk known shapes
    return t.file(t.program([stmt]));
}

// Babel's globals + JS builtins the provider might touch without it
// counting as an "external helper".
const KNOWN_GLOBALS = new Set([
    'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
    'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Function',
    'RegExp', 'Date', 'Error', 'TypeError', 'RangeError', 'ReferenceError',
    'SyntaxError', 'URIError', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Promise', 'Proxy', 'Reflect', 'JSON',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'atob', 'btoa',
    'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
    'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
    'BigUint64Array', 'Uint8ClampedArray', 'ArrayBuffer', 'DataView',
    'arguments', 'this'
]);

// ----- Step 1: find the WASM base64 string ------------------------------

function findWasmString(ast) {
    let hit = null;
    traverse(ast, {
        StringLiteral(path) {
            if (hit) return;
            const v = path.node.value;
            // WASM magic in base64 is "AGFzbQEAAAAB" (12 chars). A real
            // module is at least a few hundred bytes; 200 chars of base64
            // is plenty of margin against accidental false positives.
            if (v && v.length >= 200 && v.startsWith('AGFzbQ')) {
                hit = { value: v, node: path.node, path };
                path.stop();
            }
        }
    });
    return hit;
}

// ----- Step 2: find `new <alias>.WebAssembly.Instance(mod, imports)` ----

function isWebAssemblyInstanceCallee(callee) {
    const p = dottedPath(callee);
    if (!p) return false;
    // Accept `WebAssembly.Instance`, `<alias>.WebAssembly.Instance`, or
    // any longer chain ending in `.WebAssembly.Instance`.
    return p === 'WebAssembly.Instance' || p.endsWith('.WebAssembly.Instance');
}

function findInstanceCall(ast) {
    let hit = null;
    traverse(ast, {
        NewExpression(path) {
            if (hit) return;
            const node = path.node;
            if (!isWebAssemblyInstanceCallee(node.callee)) return;
            if (node.arguments.length < 2) return;
            hit = {
                node,
                path,
                moduleArg: node.arguments[0],
                importsArg: node.arguments[1],
                chain: dottedPath(node.callee)
            };
            path.stop();
        }
    });
    return hit;
}

// ----- Step 3: find the imports-provider function declaration ----------

// Given the `imports` Identifier from the Instance call, follow its binding
// to find `var <name> = <providerFn>()`, then locate the top-level
// FunctionDeclaration for `providerFn`.
function findImportsProvider(ast, instanceInfo) {
    const importsArg = instanceInfo.importsArg;
    if (!t.isIdentifier(importsArg)) return null;

    // Resolve the binding at the Instance call's scope.
    const binding = instanceInfo.path.scope.getBinding(importsArg.name);
    if (!binding || !binding.path.isVariableDeclarator()) return null;

    const init = binding.path.node.init;
    if (!t.isCallExpression(init) || !t.isIdentifier(init.callee)) return null;
    const providerName = init.callee.name;

    // Find the top-level FunctionDeclaration with that name.
    let providerNode = null;
    for (const n of ast.program.body) {
        if (t.isFunctionDeclaration(n) && n.id && n.id.name === providerName) {
            providerNode = n;
            break;
        }
    }
    if (!providerNode) return null;

    return { name: providerName, node: providerNode };
}

// ----- Step 4: window attributes used inside the provider --------------

function collectWindowAttributes(fnNode, windowAliases) {
    const out = new Set();
    traverse(wrapFile(fnNode), {
        MemberExpression(path) {
            const obj = path.node.object;
            if (!t.isIdentifier(obj)) return;
            if (!windowAliases.has(obj.name)) return;
            if (!path.node.computed && t.isIdentifier(path.node.property)) {
                out.add(path.node.property.name);
            } else if (path.node.computed && t.isStringLiteral(path.node.property)) {
                out.add(path.node.property.value);
            }
        }
    });
    return Array.from(out).sort();
}

// ----- Step 5: external helpers transitively referenced ---------------

// Collect every identifier declared (params, vars, nested functions) within
// a function so we can tell "external" from "local" afterwards.
function collectLocalNames(fnNode) {
    const local = new Set();
    for (const p of fnNode.params || []) {
        if (t.isIdentifier(p)) local.add(p.name);
    }
    if (fnNode.id && fnNode.id.name) local.add(fnNode.id.name);
    traverse(wrapFile(fnNode), {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id)) local.add(path.node.id.name);
        },
        FunctionDeclaration(path) {
            if (path.node.id) local.add(path.node.id.name);
            for (const p of path.node.params || []) {
                if (t.isIdentifier(p)) local.add(p.name);
            }
        },
        FunctionExpression(path) {
            if (path.node.id) local.add(path.node.id.name);
            for (const p of path.node.params || []) {
                if (t.isIdentifier(p)) local.add(p.name);
            }
        },
        ArrowFunctionExpression(path) {
            for (const p of path.node.params || []) {
                if (t.isIdentifier(p)) local.add(p.name);
            }
        },
        CatchClause(path) {
            if (path.node.param && t.isIdentifier(path.node.param)) local.add(path.node.param.name);
        }
    });
    return local;
}

// Collect every identifier name referenced by a node that isn't a param,
// local, window alias, or known global — these are what we need to
// transitively chase down in the module scope.
function collectExternalRefs(node, localNames, windowAliases) {
    const out = new Set();
    traverse(wrapFile(node), {
        Identifier(path) {
            const name = path.node.name;
            if (localNames.has(name)) return;
            if (windowAliases.has(name)) return;
            if (KNOWN_GLOBALS.has(name)) return;
            // Skip property names on member expressions (`obj.foo` — `foo`
            // is just a key, not a variable reference).
            if (path.parent && t.isMemberExpression(path.parent) &&
                !path.parent.computed && path.parent.property === path.node) return;
            // Skip object-property keys (`{foo: 1}`), method shorthand.
            if (path.parent && t.isObjectProperty(path.parent) &&
                !path.parent.computed && path.parent.key === path.node) return;
            if (path.parent && t.isObjectMethod(path.parent) &&
                !path.parent.computed && path.parent.key === path.node) return;
            // Skip labels (`break outer;`, `outer: for …`).
            if (path.parent && (t.isLabeledStatement(path.parent) ||
                t.isBreakStatement(path.parent) || t.isContinueStatement(path.parent)) &&
                path.parent.label === path.node) return;
            out.add(name);
        }
    });
    return out;
}

// Given a name, locate its top-level declaration in the module AST and
// return the generated source for just that declaration. Returns null if
// the name isn't a top-level binding (could be a runtime global the
// bundle doesn't redeclare, or a name shadowed by an inner scope).
function findTopLevelDeclSource(ast, name) {
    for (const n of ast.program.body) {
        if (t.isFunctionDeclaration(n) && n.id && n.id.name === name) {
            return { kind: 'function', code: generate(n).code };
        }
        if (t.isVariableDeclaration(n)) {
            for (const d of n.declarations) {
                if (t.isIdentifier(d.id) && d.id.name === name) {
                    // Emit `var <name> = <init>;` on its own so multi-
                    // declarator lines (`var a = 1, b = 2, c = 3;`) come
                    // out as isolated snippets.
                    const solo = t.variableDeclaration(n.kind, [d]);
                    return { kind: 'var', code: generate(solo).code };
                }
            }
        }
    }
    return null;
}

// Breadth-first walk through external references, collecting source for
// every helper and following each helper's OWN external refs in turn.
// Stops at top-level bindings we can't resolve (globals, etc.) and at
// names we've already captured.
function collectExternalHelpers(ast, providerNode, windowAliases) {
    const helpers = [];
    const captured = new Set();
    const queue = [];

    // Seed with references from the provider itself.
    const providerLocals = collectLocalNames(providerNode);
    for (const name of collectExternalRefs(providerNode, providerLocals, windowAliases)) {
        queue.push(name);
    }

    while (queue.length) {
        const name = queue.shift();
        if (captured.has(name)) continue;

        const decl = findTopLevelDeclSource(ast, name);
        if (!decl) {
            // Not a top-level binding — probably a sibling runtime symbol
            // the bundle inherits from its outer IIFE. We can't surface
            // its source, so just mark it captured and move on.
            captured.add(name);
            continue;
        }
        captured.add(name);
        helpers.push({ name, kind: decl.kind, code: decl.code });

        // Recurse into this helper's own external refs.
        // Re-parse to AST so we can walk it with the same machinery.
        // Cheap because helper bodies are small.
        const helperAst = findTopLevelNode(ast, name);
        if (helperAst) {
            const helperLocals = collectLocalNames(helperAst);
            for (const ref of collectExternalRefs(helperAst, helperLocals, windowAliases)) {
                if (!captured.has(ref)) queue.push(ref);
            }
        }
    }

    return helpers;
}

// Return the actual top-level AST node (not a generated string) for a
// given name. Mirrors findTopLevelDeclSource but returns the node so the
// BFS traversal can keep walking.
function findTopLevelNode(ast, name) {
    for (const n of ast.program.body) {
        if (t.isFunctionDeclaration(n) && n.id && n.id.name === name) return n;
        if (t.isVariableDeclaration(n)) {
            for (const d of n.declarations) {
                if (t.isIdentifier(d.id) && d.id.name === name) return d.init || d;
            }
        }
    }
    return null;
}

// ----- Public API -------------------------------------------------------

// Run the extractor against a module AST. Returns null when this isn't a
// WASM-hosting module (tags, helper modules, etc.); otherwise a partial
// or complete report. Callers should treat any piece as independently
// useful — if the Instance call isn't found we still emit the wasm
// string, and if the provider can't be resolved we still emit the bytes
// and the instance call shape.
//
//   windowAliases: an iterable of identifiers that alias `window` at the
//                  top level (typically from bundleSandbox). Used both
//                  for collecting `window.*` attributes and for
//                  excluding the alias itself from external helpers.
function extractWasm(ast, windowAliases, logger) {
    const aliases = new Set(windowAliases || []);
    // Common global lookalikes — if neither list hits, the provider
    // obviously can't be identified anyway, but including these avoids
    // false external-helper reports in the edge case of no bundle
    // sandbox.
    if (aliases.size === 0) {
        aliases.add('window');
        aliases.add('self');
        aliases.add('globalThis');
    }

    const wasm = findWasmString(ast);
    if (!wasm) return null;

    const result = {
        wasm: wasm.value,
        instance: null,
        helpers: [],
        windowAttributes: [],
        instanceCall: null
    };

    const instanceInfo = findInstanceCall(ast);
    if (!instanceInfo) {
        logger && logger.debug('extractWasm: wasm string present but no WebAssembly.Instance call found');
        return result;
    }

    result.instanceCall = {
        source: generate(instanceInfo.node).code,
        chain: instanceInfo.chain
    };

    const providerInfo = findImportsProvider(ast, instanceInfo);
    if (!providerInfo) {
        logger && logger.debug('extractWasm: Instance call found but imports provider unresolved');
        return result;
    }

    result.instance = generate(providerInfo.node).code;
    result.providerName = providerInfo.name;
    result.windowAttributes = collectWindowAttributes(providerInfo.node, aliases);
    result.helpers = collectExternalHelpers(ast, providerInfo.node, aliases);

    return result;
}

module.exports = { extractWasm };
