const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { isIdentifierName } = require("@babel/helper-validator-identifier");
const generate = require("@babel/generator").default;

const HEX_ONLY = /^(?:\\x[0-9a-fA-F]{2})+$/;

function decodeHexRuns(rawInner) {
    const bytes = rawInner.replace(/\\x/g, "").match(/.{2}/g) || [];
    return bytes.map((h) => String.fromCharCode(parseInt(h, 16))).join("");
}

/**
 * Mutates the given AST in place, replacing string and template literals
 * that are composed only of \xHH sequences with decoded string literals.
 *
 * @param {import('@babel/types').File} ast
 * @returns {import('@babel/types').File} the same ast, for convenience
 */
function decodeHexStringsInAst(ast, logger) {
    let replaced = 0;
    logger.info("Proceeding replacing HexStrings...")
    traverse(ast, {
        noScope: true,
        Program: {
            exit(programPath) {
                programPath.traverse({
                    StringLiteral(path) {
                        const raw = path.node.extra && path.node.extra.raw;
                        if (!raw) return;

                        // raw is quoted, strip first and last char
                        const inner = raw.slice(1, -1);
                        if (!HEX_ONLY.test(inner)) return;

                        const decoded = decodeHexRuns(inner);
                        replaced++;
                        path.replaceWith(t.stringLiteral(decoded));
                    },

                    TemplateLiteral(path) {
                        if (path.node.expressions.length !== 0) return;
                        if (path.node.quasis.length !== 1) return;

                        const raw = path.node.quasis[0].value && path.node.quasis[0].value.raw || "";
                        if (!HEX_ONLY.test(raw)) return;

                        const decoded = decodeHexRuns(raw);
                        path.replaceWith(t.stringLiteral(decoded));
                        replaced++;
                    },
                });
            },
        },
    });
    logger.info(`Replaced ${replaced} hex strings`);

    return ast;
}


function unwrapOneElementArrays(expr) {
    let cur = expr;
    while (t.isArrayExpression(cur) && cur.elements.length === 1) {
        const only = cur.elements[0];
        if (!only || t.isSpreadElement(only)) break;
        cur = only;
    }
    return cur;
}

function maybeCollapseTemplateToString(expr) {
    if (t.isTemplateLiteral(expr) && expr.expressions.length === 0) {
        const cooked = expr.quasis[0].value.cooked ?? expr.quasis[0].value.raw;
        return t.stringLiteral(cooked);
    }
    return expr;
}

/**
 * Mutates the AST to replace obj[[...]] with obj[...],
 * keeping bracket notation, e.g. String[["fromCharCode"]] -> String["fromCharCode"]
 *
 * @param {import('@babel/types').File} ast
 * @returns {import('@babel/types').File}
 */
function cleanDoubleBracketProps(ast, logger) {
    logger.info("Cleaning double bracket properties...")
    let replaced = 0;
    traverse(ast, {
        noScope: true,
        Program: {
            exit(programPath) {
                programPath.traverse({
                    MemberExpression(path) {
                        if (!path.node.computed) return;

                        const unwrapped = unwrapOneElementArrays(path.node.property);
                        if (unwrapped !== path.node.property) {
                            path.node.property = maybeCollapseTemplateToString(unwrapped);
                            path.node.computed = true;
                            replaced++;
                        }
                    },

                    OptionalMemberExpression(path) {
                        if (!path.node.computed) return;

                        const unwrapped = unwrapOneElementArrays(path.node.property);
                        if (unwrapped !== path.node.property) {
                            path.node.property = maybeCollapseTemplateToString(unwrapped);
                            path.node.computed = true;
                            replaced++;
                        }
                    },
                });
            },
        },
    });

    logger.info(`Replaced ${replaced} double bracket properties`)

    return ast;
}

function formatPaths(inputDict) {
    const formattedDict = {};
    const replacedDict = {};

    for (const [key, value] of Object.entries(inputDict)) {
        let formattedKey = Number(key); // Convert key to a number
        let formattedValue = value;

        // Check if the value has more than one '/' or doesn't start with './'
        if (formattedValue.startsWith('./')) {
            const segments = formattedValue.split('/');
            formattedValue = segments.length > 2 ? `./${segments.pop()}` : formattedValue;
        } else if (formattedValue.includes('/')) {
            const segments = formattedValue.split('/');
            formattedValue = `./${segments.pop()}`;
        }

        // Record the original path if it was replaced
        if (formattedValue !== value) {
            replacedDict[value] = formattedValue;
        }

        // Remove './' from the formatted value
        formattedValue = formattedValue.replace('./', '').replace('.js', '');

        // Update the formatted dictionary with the new key-value pair
        formattedDict[formattedKey] = formattedValue;
    }

    return { legenda: formattedDict, replacerDict: replacedDict };
}

/**
 * Find the module bundler IIFE in the AST body.
 * Patterns:
 *   Captcha:      !function A(e,B,s){ ... }({ ... })     (UnaryExpression → CallExpression)
 *   Interstitial: (function(){ ... })()                   (CallExpression → FunctionExpression)
 * Returns the body index, or -1 if not found.
 */
function findModuleBundlerIndex(body) {
    for (let i = 0; i < body.length; i++) {
        const node = body[i];

        if (node.type !== "ExpressionStatement") continue;

        // Captcha pattern: !function(...){}(...)
        if (node.expression.type === "UnaryExpression" &&
            node.expression.argument?.type === "CallExpression" &&
            node.expression.argument.callee?.type === "FunctionExpression" &&
            node.expression.argument.arguments?.length > 0) {
            return { index: i, type: "captcha" };
        }

        // Interstitial pattern: (function(){...})() — the callee is a FunctionExpression
        if (node.expression.type === "CallExpression" &&
            node.expression.callee?.type === "FunctionExpression" &&
            node.expression.callee.body?.body?.length > 0) {
            // Check if first statement declares an object with module properties
            const firstStmt = node.expression.callee.body.body[0];
            if (firstStmt?.type === "VariableDeclaration" &&
                firstStmt.declarations?.[0]?.init?.type === "ObjectExpression") {
                return { index: i, type: "interstitial" };
            }
        }
    }
    return null;
}

function scorporateCaptchaModules(ast, logger) {

    logger.info("Extracing exports...")

    // Find the module bundler IIFE (not at a fixed index)
    const bundler = findModuleBundlerIndex(ast.program.body);
    if (!bundler) {
        throw new Error("Could not find module bundler IIFE in AST");
    }

    const bundlerNode = ast.program.body[bundler.index];
    let ctype = bundler.type;
    logger.info(`Bundle type: ${ctype} (at body[${bundler.index}])`);

    if (ctype === "interstitial") {
        const LEGENDA_ORDER = [
            "reloader", "interstitial", "obfuscate", "helpers", "vm-obf",  "localstorage", "new_file_1", "new_file_2", "new_file_3", "new_file_4", "new_file_5", "new_file_6", "new_file_7", "new_file_8", "new_file_9", "new_file_10",
        ]
        let matched = new Set();
        let index = 0;
        let astLegenda = {}
        let mainBody = bundlerNode.expression.callee.body.body;
        mainBody[0].declarations[0].init.properties.forEach((prop) => {
            let keyName = prop.key.value;
            // if the key is not in matched, add it to initLegenda
            if (!matched.has(keyName)) {
                astLegenda[LEGENDA_ORDER[index]] = t.file(t.program(
                    prop.value.body.body
                ));
                matched.add(keyName);
                index++;
            }
        })
        astLegenda["main"] = t.file(
            t.program(
                mainBody[
                    mainBody.length - 1
                ].block.body
            )
        );
        logger.info(`Mapped legenda as -> ${Object.keys(astLegenda).length}`)
        return astLegenda
    }
    // Captcha bundler: !function(e,B,s){ ... }({ moduleId: [fn, deps], ... })
    const bundlerCall = bundlerNode.expression.argument; // the CallExpression
    const moduleObject = bundlerCall.arguments[0]; // the object with module definitions

    let initLegenda = {}
    let declarations = null;
    try {
        declarations = bundlerCall.callee.body.body[0].declarations[0];

        declarations.map((prop) => {
            let obj = prop.value.elements[1].properties;
            if (obj.length > 0) {
                obj.map((prop) => {
                    let keyName = prop.key.value;
                    let value = prop.value.value;
                    initLegenda[Number(value)] = keyName;
                })
            }

        })
    } catch (e) {
        moduleObject.properties.map((prop) => {
            if (
                t.isArrayExpression(prop.value) &&
                prop.value.elements.length === 2 &&
                t.isObjectExpression(prop.value.elements[1]) &&
                prop.value.elements[1].properties.length > 0
            ) {
                prop.value.elements[1].properties.map((prop) => {
                    initLegenda[Number(prop.value.value)] = prop.key.value;
                })
            }
        })
    }
    logger.info(`Mapped legenda as -> ${Object.keys(initLegenda).length}`)
    const { legenda, replacerDict } = formatPaths(initLegenda);

    let astLegenda = {};
    moduleObject.properties.map((prop) => {
        let keyName = prop.key.value;
        let functionCodeAST = t.file(t.program(
            prop.value.elements[0].body.body
        ))
        astLegenda[legenda[keyName]] = functionCodeAST;
    });
    return astLegenda
}


/**
 * Try to convert a computed property access into non computed dot form.
 * Converts only when the key is a string that is a valid IdentifierName.
 */
function tryUncompute(node) {
    if (!node.computed) return;

    let key = node.property;

    // Collapse empty template literals like `foo`
    if (t.isTemplateLiteral(key) && key.expressions.length === 0 && key.quasis.length === 1) {
        const cooked = key.quasis[0].value.cooked ?? key.quasis[0].value.raw;
        if (typeof cooked === "string" && isIdentifierName(cooked)) {
            node.property = t.identifier(cooked);
            node.computed = false;
            return;
        }
    }

    // Convert "foo" to .foo when valid
    if (t.isStringLiteral(key) && isIdentifierName(key.value)) {
        node.property = t.identifier(key.value);
        node.computed = false;
        return;
    }

    // Do not touch identifiers in computed form, obj[foo] is dynamic
}

/**
 * Mutates the AST in place.
 * @param {import('@babel/types').File} ast
 * @returns {import('@babel/types').File}
 */
function uncomputeMemberExpressions(ast) {
    traverse(ast, {
        noScope: true,
        Program: {
            exit(programPath) {
                programPath.traverse({
                    MemberExpression(path) {
                        tryUncompute(path.node);
                    },
                    OptionalMemberExpression(path) {
                        tryUncompute(path.node);
                    },
                });
            },
        },
    });
    return ast;
}

module.exports = {
    scorporateCaptchaModules,
    cleanDoubleBracketProps,
    decodeHexStringsInAst,
    uncomputeMemberExpressions
};


