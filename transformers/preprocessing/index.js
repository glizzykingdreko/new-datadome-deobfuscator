/**
 * Preprocessing passes for string deobfuscation and VM evaluation
 */

const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const parser = require('@babel/parser');
const t = require('@babel/types');
const vm = require('vm');
const { simplifyConcatenation } = require('../utils');
const { createError, ErrorCodes } = require('../errors');

// Helper traverse for isolated node traversal
const traverseHelper = require('@babel/traverse').default;

let atob;
try {
  atob = require('atob');
} catch (e) {
  // Fallback for environments without atob
  atob = (str) => Buffer.from(str, 'base64').toString('binary');
}

/**
 * Simplify binary expressions in member expressions and assignments
 */
function simplifyBinaryExpressions(ast, logger = null, result = null) {
  let changed = false;
  let simplifications = 0;

  try {
    traverse(ast, {
      MemberExpression(path) {
        if (t.isBinaryExpression(path.node.property, { operator: '+' })) {
          const simplifiedString = simplifyConcatenation(path.node.property);
          if (simplifiedString !== null) {
            path.node.property = t.stringLiteral(simplifiedString);
            changed = true;
            simplifications++;
          }
        }
      },
      AssignmentExpression(path) {
        if (t.isBinaryExpression(path.node.right, { operator: '+' })) {
          const simplifiedString = simplifyConcatenation(path.node.right);
          if (simplifiedString !== null) {
            path.node.right = t.stringLiteral(simplifiedString);
            changed = true;
            simplifications++;
          }
        }
      }
    });

    if (logger) logger.info(`Binary expression simplifications: ${simplifications}`);
    if (result) result.stats.preprocessing.binaryExpressionsSimplified = simplifications;
  } catch (err) {
    const error = createError(
      ErrorCodes.TRANSFORMATION_ERROR,
      'Error during binary expression simplification',
      { error: err.message, stack: err.stack }
    );
    if (logger) logger.error('Binary expression simplification failed', error);
    if (result) result.addError(error);
  }

  return changed;
}

/**
 * Check if an expression contains member access, function calls, or typeof
 * These should not be simplified as they have side effects or runtime dependencies
 */
function hasSideEffectsOrRuntimeDeps(node) {
  if (!node) return false;

  let hasSideEffects = false;

  // Create a temporary AST wrapper for traversal
  const tempAst = { type: 'Program', body: [{ type: 'ExpressionStatement', expression: node }] };

  try {
    traverseHelper(tempAst, {
      noScope: true,
      MemberExpression() {
        hasSideEffects = true;
        // Stop traversal once we find a runtime dependency
        this.stop();
      },
      CallExpression() {
        hasSideEffects = true;
        // Stop traversal once we find a runtime dependency
        this.stop();
      },
      UnaryExpression(path) {
        if (path.node.operator === 'typeof') {
          hasSideEffects = true;
          // Stop traversal once we find a runtime dependency
          this.stop();
        }
      }
    });
  } catch (e) {
    // If traversal fails, assume it has side effects to be safe
    hasSideEffects = true;
  }

  return hasSideEffects;
}

/**
 * Check if an expression can be safely evaluated statically
 * Returns true if the expression has no member access, function calls, typeof, or identifiers
 * Identifiers are considered runtime dependencies unless they're bound to constants
 */
function canSafelyEvaluate(node) {
  if (!node) return false;

  // Create a temporary AST wrapper for traversal
  const tempAst = { type: 'Program', body: [{ type: 'ExpressionStatement', expression: node }] };

  try {
    let canEvaluate = true;
    const identifiers = new Set();

    traverseHelper(tempAst, {
      noScope: true,
      MemberExpression() {
        // Member access means runtime dependency - cannot safely evaluate
        canEvaluate = false;
        // Stop traversal once we find a runtime dependency
        this.stop();
      },
      CallExpression() {
        // Function calls mean runtime dependency - cannot safely evaluate
        canEvaluate = false;
        // Stop traversal once we find a runtime dependency
        this.stop();
      },
      UnaryExpression(path) {
        if (path.node.operator === 'typeof') {
          // typeof means runtime dependency - cannot safely evaluate
          canEvaluate = false;
          // Stop traversal once we find a runtime dependency
          this.stop();
        }
      },
      Identifier(path) {
        // Collect identifiers - we'll check if they're constants later
        identifiers.add(path.node.name);
      }
    });

    // If we found identifiers, we need to check if they're all constants
    // For now, we'll be conservative and not evaluate expressions with identifiers
    // unless we're certain they're safe (e.g., in a specific scope context)
    // This prevents evaluating expressions like "a || 33" where 'a' is a variable
    if (identifiers.size > 0) {
      // Identifiers found - cannot safely evaluate without scope information
      return false;
    }

    return canEvaluate;
  } catch (e) {
    // If traversal fails, assume we cannot safely evaluate
    return false;
  }
}

/**
 * Check if a binary expression is a pure string concatenation
 * (only string literals, no member access, no function calls, no typeof)
 */
function isPureStringConcatenation(node) {
  if (!t.isBinaryExpression(node, { operator: '+' })) {
    return false;
  }

  // Create a temporary AST wrapper for traversal
  const tempAst = { type: 'Program', body: [{ type: 'ExpressionStatement', expression: node }] };

  // Verify it only contains string/numeric literals
  let isPure = true;
  try {
    traverseHelper(tempAst, {
      noScope: true,
      MemberExpression() {
        isPure = false;
      },
      CallExpression() {
        isPure = false;
      },
      UnaryExpression(path) {
        if (path.node.operator === 'typeof') {
          isPure = false;
        }
      },
      Identifier() {
        // Identifiers in pure string concatenation are not allowed
        // (they would need runtime evaluation)
        isPure = false;
      }
    });
  } catch (e) {
    // If traversal fails, assume it's not pure to be safe
    isPure = false;
  }

  return isPure;
}

/**
 * Clean binary and member expressions (convert bracket notation to dot notation)
 * Evaluates statically computable expressions, avoids expressions with member access or runtime dependencies
 */
function cleanBinaryAndMemberExpressions(ast, logger = null, result = null) {
  let changed = false;
  let conversions = 0;

  try {
    traverse(ast, {
      MemberExpression(path) {
        // Convert bracket notation with string literals to dot notation
        if (path.node.computed && t.isStringLiteral(path.node.property)) {
          const property = path.node.property.value;
          // Only convert if property is a valid identifier
          if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(property)) {
            path.node.computed = false;
            path.node.property = t.identifier(property);
            changed = true;
            conversions++;
          }
        }
        // Simplify binary expressions in properties ONLY if pure string concatenation
        else if (path.node.property && t.isBinaryExpression(path.node.property, { operator: '+' })) {
          if (isPureStringConcatenation(path.node.property)) {
            const simplifiedString = simplifyConcatenation(path.node.property);
            if (simplifiedString !== null) {
              path.node.property = t.stringLiteral(simplifiedString);
              changed = true;
              conversions++;
            }
          }
        }
      },
      BinaryExpression(path) {
        // For logical operators (&&, ||), handle them specially
        // NEVER evaluate the whole expression if ANY part has runtime deps (member access, typeof, calls)
        if (['&&', '||'].includes(path.node.operator)) {
          // First, check if the ENTIRE expression has runtime dependencies
          // This catches nested &&/|| chains with member access, typeof, etc.
          if (hasSideEffectsOrRuntimeDeps(path.node)) {
            // The expression has runtime deps somewhere - don't evaluate the whole thing
            // But we can still try to simplify the left side if it's safe
            if (canSafelyEvaluate(path.node.left)) {
              try {
                const leftEvaluated = path.get('left').evaluate();
                if (leftEvaluated.confident) {
                  // For &&: if left is falsy, replace whole expression with left value; 
                  // if left is truthy, replace left side with its value (keep && and right side)
                  // For ||: if left is truthy, replace whole expression with left value;
                  // if left is falsy, replace left side with its value (keep || and right side)
                  if (path.node.operator === '&&') {
                    if (!leftEvaluated.value) {
                      // Left is falsy, so whole expression is falsy
                      path.replaceWith(t.valueToNode(leftEvaluated.value));
                      changed = true;
                      conversions++;
                      path.skip();
                      return;
                    } else {
                      // Left is truthy, replace left side with its evaluated value
                      // Keep the && and right side intact (right side has runtime deps)
                      path.node.left = t.valueToNode(leftEvaluated.value);
                      changed = true;
                      conversions++;
                      return;
                    }
                  } else if (path.node.operator === '||') {
                    if (leftEvaluated.value) {
                      // Left is truthy, so whole expression is left value
                      path.replaceWith(t.valueToNode(leftEvaluated.value));
                      changed = true;
                      conversions++;
                      path.skip();
                      return;
                    } else {
                      // Left is falsy, replace left side with its evaluated value
                      // Keep the || and right side intact (right side has runtime deps)
                      path.node.left = t.valueToNode(leftEvaluated.value);
                      changed = true;
                      conversions++;
                      return;
                    }
                  }
                }
              } catch (e) {
                // Evaluation failed, skip
                return;
              }
            }
            // Expression has runtime deps, don't touch it further
            return;
          }

          // No runtime deps anywhere - safe to evaluate the whole expression
          if (canSafelyEvaluate(path.node)) {
            try {
              const evaluated = path.evaluate();
              if (evaluated.confident) {
                path.replaceWith(t.valueToNode(evaluated.value));
                changed = true;
                conversions++;
                path.skip();
                return;
              }
            } catch (e) {
              // Evaluation failed, skip
              return;
            }
          }
          return;
        }

        // Only simplify pure string concatenations with '+' operator
        if (path.node.operator === '+') {
          // Check if this is a pure string concatenation (no side effects, no member access)
          if (isPureStringConcatenation(path.node)) {
            const simplifiedString = simplifyConcatenation(path.node);
            if (simplifiedString !== null) {
              path.replaceWith(t.stringLiteral(simplifiedString));
              changed = true;
              conversions++;
              path.skip();
              return;
            }
          }
        }

        // For all other operators, check if they can be safely evaluated
        if (canSafelyEvaluate(path.node)) {
          try {
            const evaluated = path.evaluate();
            if (evaluated.confident) {
              path.replaceWith(t.valueToNode(evaluated.value));
              changed = true;
              conversions++;
              path.skip();
              return;
            }
          } catch (e) {
            // Evaluation failed, skip
          }
        }
      },
      ConditionalExpression(path) {
        // Only evaluate conditionals if the test can be safely evaluated
        // and doesn't contain member access, function calls, or typeof
        if (canSafelyEvaluate(path.node.test)) {
          try {
            const testEvaluated = path.get('test').evaluate();
            if (testEvaluated.confident) {
              // Replace with the appropriate branch
              if (testEvaluated.value) {
                path.replaceWith(path.node.consequent);
              } else {
                path.replaceWith(path.node.alternate);
              }
              changed = true;
              conversions++;
              path.skip();
              return;
            }
          } catch (e) {
            // Evaluation failed, skip
          }
        }
      }
    });

    if (logger) logger.info(`Member/binary expression conversions: ${conversions}`);
    if (result) result.stats.preprocessing.memberExpressionsConverted = conversions;
  } catch (err) {
    const error = createError(
      ErrorCodes.TRANSFORMATION_ERROR,
      'Error during member/binary expression cleaning',
      { error: err.message, stack: err.stack }
    );
    if (logger) logger.error('Member/binary expression cleaning failed', error);
    if (result) result.addError(error);
  }

  return changed;
}

/**
 * Clean strings using VM context evaluation
 * This handles String.fromCharCode, window assignments, and array deobfuscation
 */
function cleanStrings(ast, logger = null, result = null) {
  let changed = false;
  let replacements = 0;
  let vmErrors = 0;

  try {
    if (logger) logger.info('Starting string cleaning phase...');

    // Create VM context with necessary globals
    const context = vm.createContext({
      atob: atob,
      window: {
        Number,
        Math,
        parseInt,
        String,
        Boolean,
        Array,
        Object,
        Function,
        RegExp,
        Date,
        Error,
        Symbol,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Proxy,
      }
    });

    let windowName = null;
    let matrixFunc = null;
    let obfuscatedArray = null;
    let obfuscatedArrayCode = null;

    // Phase 1: Identify and execute String.fromCharCode assignments
    if (logger) logger.info('Phase 1: Processing String.fromCharCode assignments');
    traverse(ast, {
      VariableDeclarator(path) {
        try {
          if (
            t.isIdentifier(path.node.id) &&
            t.isMemberExpression(path.node.init) &&
            t.isIdentifier(path.node.init.object) &&
            path.node.init.object.name === 'String' &&
            (
              (
                t.isIdentifier(path.node.init.property) &&
                path.node.init.property.name === 'fromCharCode'
              ) ||
              (
                t.isStringLiteral(path.node.init.property) &&
                path.node.init.property.value === 'fromCharCode'
              ) ||
              (
                t.isLiteral(path.node.init.property) &&
                path.node.init.property.value.toString() === 'fromCharCode'
              ) ||
              (
                t.isNumericLiteral(path.node.init.property) &&
                path.node.init.property.value === 97
              )
            )
          ) {
            const code = generate(path.node).code;
            vm.runInContext(code, context);
            logger.info(`Executed String.fromCharCode assignment: ${code}`);
          } else if (
            t.isIdentifier(path.node.id) &&
            t.isIdentifier(path.node.init) &&
            path.node.init.name === "window"
          ) {
            const code = generate(path.node).code;
            vm.runInContext(code, context);
            windowName = path.node.id.name;
            if (logger) logger.info(`Found window assignment: ${windowName}`);
          } else if (
            t.isCallExpression(path.node.init) &&
            t.isFunctionExpression(path.node.init.callee) &&
            path.node.init.callee.body.body.length > 0 &&
            t.isReturnStatement(path.node.init.callee.body.body[path.node.init.callee.body.body.length - 1]) &&
            t.isMemberExpression(path.node.init.callee.body.body[path.node.init.callee.body.body.length - 1].argument) &&
            t.isIdentifier(path.node.init.callee.body.body[path.node.init.callee.body.body.length - 1].argument.object) &&
            t.isNumericLiteral(path.node.init.callee.body.body[path.node.init.callee.body.body.length - 1].argument.property)
          ) {
            matrixFunc = generate(path.node).code;
            if (logger) logger.info('Found matrix function');
            // create ast out of it
            const matrixAst = parser.parse(matrixFunc, {
              sourceType: 'script',
              allowReturnOutsideFunction: true,
              allowAwaitOutsideFunction: true,
            });

            let functionCall = null;
            traverse(matrixAst, {
              CallExpression(path) {
                if (t.isIdentifier(path.node.callee)) {
                  functionCall = path.node.callee.name;
                }
              }
            });
            logger.info("Function call", functionCall)
            traverse(ast, {
              FunctionDeclaration(path) {
                if (path.node.id.name === functionCall) {
                  vm.runInContext(generate(path.node).code, context);
                }
              }
            });
          }
        } catch (err) {
          vmErrors++;
          if (logger) logger.info(`VM execution warning: ${err.message}`);
        }
      }
    });

    // Phase 2: Process function declarations and array declarations
    if (logger) logger.info('Phase 2: Processing function and array declarations');
    if (ast.program && ast.program.body && ast.program.body.length > 1) {

      // Interstitial function call
      const secondBody = ast.program.body[1];
      if (
        secondBody &&
        ((
          t.isExpressionStatement(secondBody) &&
          secondBody.expression &&
          t.isCallExpression(secondBody.expression) &&
          secondBody.expression.callee &&
          t.isFunctionExpression(secondBody.expression.callee) &&
          secondBody.expression.callee.body &&
          secondBody.expression.callee.body.body
        ))
      ) {
        logger.info("Second body is valid");

        let deobArrays = "";
        secondBody.expression.callee.body.body.forEach((node) => {
          try {
            if (t.isFunctionDeclaration(node)) {
              vm.runInContext(generate(node).code, context);
              if (matrixFunc) {
                try {
                  logger.info("Executing matrix function", matrixFunc)
                  vm.runInContext(matrixFunc, context);
                  matrixFunc = null;
                  logger.info("Matrix function executed")
                } catch (e) {
                  if (logger) logger.info(`Matrix function execution failed: ${e.message}`);
                }
              }
            } else if (t.isVariableDeclaration(node)) {
              deobArrays += generate(node).code + ";\n";
            }
          } catch (err) {
            vmErrors++;
            if (logger) logger.info(`VM execution warning: ${err.message}`);
          }
        });

        if (deobArrays) {
          try {
            vm.runInContext(deobArrays, context);
          } catch (err) {
            vmErrors++;
            if (logger) logger.info(`Array declaration execution failed: ${err.message}`);
          }
        } else {
          logger.info("No array declarations found")
        }

        // Phase 3: Process more variable declarations
        logger.info("Phase 3: Processing more variable declarations")
        secondBody.expression.callee.body.body.forEach((node) => {
          try {
            if (
              t.isVariableDeclaration(node) &&
              t.isMemberExpression(node.declarations[0].init) &&
              t.isIdentifier(node.declarations[0].init.object) &&
              node.declarations[0].init.object.name === "String" &&
              node.declarations[0].init.property &&
              node.declarations[0].init.property.name === "fromCharCode"
            ) {

              for (let declaration of node.declarations) {
                if (!(t.isIdentifier(declaration.init) && declaration.init.name === "window")) {
                  vm.runInContext(generate(node).code, context);
                }
              }
            } else if (t.isVariableDeclaration(node)) {
              for (let declaration of node.declarations) {
                if (
                  t.isArrayExpression(declaration.init) ||
                  (
                    t.isMemberExpression(declaration.init) &&
                    t.isIdentifier(declaration.init.object) &&
                    t.isIdentifier(declaration.init.property) &&
                    declaration.init.object.name === 'String' &&
                    declaration.init.property.name === 'fromCharCode'
                  )
                ) {
                  deobArrays += generate(declaration).code + ";\n";
                }
              }
            }
          } catch (err) {
            vmErrors++;
            if (logger) logger.info(`VM execution warning: ${err.message}`);
          }
        });

        if (deobArrays) {
          try {
            vm.runInContext(deobArrays, context);
          } catch (err) {
            vmErrors++;
            if (logger) logger.info(`Additional array execution failed: ${err.message}`);
          }
        }
      } else {
        logger.info("No function declarations found")
        ast.program.body.forEach((node) => {
          let code = generate(node).code;
          if (node.type !== 'FunctionDeclaration') {
            const regex = /(\w+)\[\[`exports`\]\]/g;
            const matches = [...code.matchAll(regex)];
            if (matches.length !== 0) {
              const lastMatch = matches[matches.length - 1];
              const xValue = lastMatch[1];
              vm.runInContext(`${xValue} = {}`, context);
            }
          }
          try { vm.runInContext(code, context) } catch (e) { }
        })
        ast.program.body.forEach((node) => {
          let code = generate(node).code;
          if (node.type !== 'FunctionDeclaration') {
            const regex = /(\w+)\[\[`exports`\]\]/g;
            const matches = [...code.matchAll(regex)];
            if (matches.length !== 0) {
              const lastMatch = matches[matches.length - 1];
              const xValue = lastMatch[1];
              vm.runInContext(`${xValue} = {}`, context);
            }
          }
          try { vm.runInContext(code, context) } catch (e) {
          }
        })
        let functionDeclarations = ast.program.body.filter((node) => {
          return node.type === 'FunctionDeclaration'
        });
        // run function declarations in context
        functionDeclarations.forEach((node) => {
          let code = generate(node).code;
          vm.runInContext(code, context);
        })
      }
    }

    // Phase 3.5: Recursively harvest nested decoder function declarations
    // and their backing arrays (e.g., tags `K`, `M`, `rn` + `tn`, `en`).
    // Tags/newer bundles hide decoders deep inside closures, so the top-level
    // passes above miss them. We collect every FunctionDeclaration and every
    // VariableDeclaration whose init is an ArrayExpression, then run them in
    // the VM. Function declarations go first so arrays that call them (e.g.
    // `en = [..., hn(115, 62), ...]`) can resolve on evaluation.
    if (logger) logger.info('Phase 3.5: Harvesting nested decoder functions and arrays');
    const harvestedFnNames = new Set();
    {
      // A "pure MBA helper" is a function whose body is a single return
      // statement over an expression tree of parameters, literals, and
      // bitwise/arithmetic operators only. These are the decoder primitives
      // DataDome generates (e.g. `function hn(n,t){ return 2*(t&n) - ...; }`).
      // They have no side effects and are safe to call from the VM with any
      // numeric arguments.
      function isPureExpression(node) {
        if (!node) return false;
        if (t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
        if (t.isIdentifier(node)) return true;
        if (t.isUnaryExpression(node) && ["-", "+", "~", "!"].includes(node.operator)) {
          return isPureExpression(node.argument);
        }
        if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
          return isPureExpression(node.left) && isPureExpression(node.right);
        }
        if (t.isAssignmentExpression(node) && node.operator === "=") {
          return t.isIdentifier(node.left) && isPureExpression(node.right);
        }
        if (t.isSequenceExpression(node)) {
          return node.expressions.every(isPureExpression);
        }
        if (t.isConditionalExpression(node)) {
          return isPureExpression(node.test) && isPureExpression(node.consequent) && isPureExpression(node.alternate);
        }
        return false;
      }
      function isPureHelper(fnNode) {
        if (!fnNode.id || !t.isIdentifier(fnNode.id)) return false;
        const params = fnNode.params || [];
        if (params.length === 0 || params.length > 8) return false;
        if (!params.every((p) => t.isIdentifier(p))) return false;
        if (!t.isBlockStatement(fnNode.body)) return false;
        if (fnNode.body.body.length !== 1) return false;
        const stmt = fnNode.body.body[0];
        if (!t.isReturnStatement(stmt)) return false;
        return isPureExpression(stmt.argument);
      }

      // Decoder-ish: allows table lookups (`var w = tn[A]; return atob(w);`)
      // and small decode bodies. Used for loading table decoders like K, M
      // that aren't pure MBA but are still safe to call — as long as their
      // backing arrays are loaded. We still reject if body looks stateful
      // (calls to named functions, `this`, `new`, `try/catch`).
      function isDecoderLike(fnNode) {
        if (!fnNode.id || !t.isIdentifier(fnNode.id)) return false;
        const fnName = fnNode.id.name;
        const params = fnNode.params || [];
        if (params.length === 0 || params.length > 4) return false;
        if (!params.every((p) => t.isIdentifier(p))) return false;

        let safe = true;
        traverse(fnNode.body, {
          noScope: true,
          CallExpression(p) {
            const callee = p.node.callee;
            if (t.isIdentifier(callee) && callee.name === fnName) {
              safe = false; p.stop(); return;
            }
            if (t.isThisExpression(callee)) { safe = false; p.stop(); }
          },
          NewExpression(p) { safe = false; p.stop(); },
          TryStatement(p) { safe = false; p.stop(); },
          ThisExpression(p) { safe = false; p.stop(); }
        });
        return safe;
      }

      // Measure how deeply a path is nested inside function/class bodies.
      // Used to break ties when multiple pure helpers share a name — a
      // top-level `function E(A, w)` is almost always the "real" MBA helper,
      // while a deeply-nested `function E(A)` with the same name is usually
      // a local helper that happens to also be pure-shaped.
      function nestingDepth(path) {
        let d = 0;
        let p = path.parentPath;
        while (p) {
          if (
            t.isFunctionDeclaration(p.node) ||
            t.isFunctionExpression(p.node) ||
            t.isArrowFunctionExpression(p.node) ||
            t.isClassDeclaration(p.node) ||
            t.isClassExpression(p.node)
          ) d++;
          p = p.parentPath;
        }
        return d;
      }

      const pureFns = [];
      const decoderFns = [];
      const arrayDecls = [];
      traverse(ast, {
        FunctionDeclaration(path) {
          if (isPureHelper(path.node)) pureFns.push({ node: path.node, depth: nestingDepth(path) });
          else if (isDecoderLike(path.node)) decoderFns.push(path.node);
        },
        VariableDeclaration(path) {
          const arrayInits = path.node.declarations.filter(
            (d) => d.init && t.isArrayExpression(d.init) && d.init.elements.length > 3
          );
          if (arrayInits.length === 0) return;
          for (const decl of arrayInits) {
            arrayDecls.push(t.variableDeclaration('var', [decl]));
          }
        }
      });
      // Deepest first so shallower declarations overwrite them in the VM —
      // we want the top-level `function E(A, w)` to win over a nested
      // `function E(A)` with a different body.
      pureFns.sort((a, b) => b.depth - a.depth);

      // Pure MBA helpers always override — they're definitive. Different
      // decls of the same name (e.g. tags' MBA `T(n,t)` vs tags' top-level
      // initializer `T()`) are unambiguous: the pure one is what the decoder
      // needs, and overwriting doesn't break anything because pure fns have
      // no side effects on the context.
      // Check whether context[name] is a native function (e.g. from
      // `var c = String.fromCharCode`). Never clobber those — our pure-helper
      // lookalikes with the same name are always wrong in this case.
      function isNativeFn(fn) {
        if (typeof fn !== "function") return false;
        try { return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)); }
        catch (_) { return false; }
      }

      let pureOk = 0, decoderOk = 0, arrOk = 0, decoderSkipped = 0, pureSkipped = 0;
      for (const entry of pureFns) {
        const fn = entry.node;
        const name = fn.id.name;
        if (isNativeFn(context[name])) { pureSkipped++; continue; }
        try {
          vm.runInContext(generate(fn).code, context);
          harvestedFnNames.add(name);
          pureOk++;
        } catch (_) {}
      }
      // Decoder-like fns only load when the name isn't already taken by a
      // pure helper or an earlier phase — this prevents a nested, closure-
      // referencing version (e.g. captcha's deep `function Z(A){...I[C(10)]...}`)
      // from clobbering the pure one that Phase 2 already loaded.
      for (const fn of decoderFns) {
        const name = fn.id.name;
        if (context[name] !== undefined) { decoderSkipped++; continue; }
        try {
          vm.runInContext(generate(fn).code, context);
          harvestedFnNames.add(name);
          decoderOk++;
        } catch (_) {}
      }
      // Arrays: same clobbering guard as decoders. A nested `var c = [...]`
      // (e.g. `for (var c = [C(948), 'bitness', ...], n = [], g = 0; ...)`) would
      // overwrite a pure helper `function c(…)` already in context.
      let arrSkipped = 0;
      for (const decl of arrayDecls) {
        const name = decl.declarations[0].id && decl.declarations[0].id.name;
        if (name && context[name] !== undefined) { arrSkipped++; continue; }
        try {
          vm.runInContext(generate(decl).code, context);
          arrOk++;
        } catch (_) {}
      }
      if (logger) logger.info(`Phase 3.5: harvested ${pureOk} pure helpers (${pureSkipped} skipped — native fn), ${decoderOk} decoders (${decoderSkipped} skipped — name taken), ${arrOk}/${arrayDecls.length} arrays (${arrSkipped} skipped — name taken)`);
    }

    // Phase 4: Replace call expressions with evaluated values.
    //
    // Captcha/interstitial decoders can legitimately throw for some argument
    // values (wrong arg type, stack overflow on a specific index) while working
    // for others. A function-wide blacklist kills the good calls to save the
    // bad ones — instead we cache every unique call *text* and only retry
    // things we haven't seen.
    //
    // Safety rails:
    //  - Per-call-text failure cache. Once `fn(2, -3)` throws, we never retry
    //    that exact call, but `fn(5, 7)` is still attempted.
    //  - Global failure cap as an absolute panic brake if the pipeline goes
    //    unexpectedly south. Set high so legitimate workloads never hit it.
    //  - vm.runInContext timeout (50ms per call) circuit breaker.
    //
    // We never inline a result of `undefined` — that's almost always a
    // symptom that the decoder is missing closure state, and pushing
    // `undefined` into the AST corrupts downstream passes (e.g. it ends up
    // as `I[undefined]` in member expressions).
    if (logger) logger.info('Phase 4: Replacing call expressions');
    const TOTAL_FAILURE_LIMIT = 100000;
    const callFailureCache = new Set(); // call-text strings that threw
    let phase4Failures = 0;
    let phase4Aborted = false;
    let recursionFailures = 0;

    // Treat `-42` (UnaryExpression wrapping NumericLiteral) as a numeric literal too.
    const isNumericLit = (arg) =>
      t.isNumericLiteral(arg) ||
      (t.isUnaryExpression(arg) &&
        (arg.operator === "-" || arg.operator === "+") &&
        t.isNumericLiteral(arg.argument));

    for (let i = 0; i < 5 && !phase4Aborted; i++) {
      traverse(ast, {
        CallExpression(path) {
          if (phase4Aborted) { path.stop(); return; }
          if (
            !t.isIdentifier(path.node.callee) ||
            ![1, 2].includes(path.node.arguments.length) ||
            !path.node.arguments.every(isNumericLit) ||
            !context[path.node.callee.name]
          ) {
            return;
          }

          const enc = generate(path.node).code;
          if (callFailureCache.has(enc)) return;

          try {
            const dec = vm.runInContext(enc, context, { timeout: 50 });

            if (dec === undefined) {
              callFailureCache.add(enc);
              return;
            }
            if (typeof dec === "string") {
              // Reject mojibake — strings with the Unicode replacement marker
              // (U+FFFD) or the non-character (U+FFFF) are the signature of
              // a broken decode (usually a wrong function loaded into context).
              if (/[\uFFFD\uFFFF]/.test(dec)) {
                callFailureCache.add(enc);
                return;
              }
              // Empty strings are legitimate in most contexts (regex flags,
              // default values, etc.) but break computed member access
              // (`obj[""]` / `obj[""](x)`). Skip only in that position.
              if (
                dec.length === 0 &&
                path.parentPath.isMemberExpression() &&
                path.parentPath.node.property === path.node &&
                path.parentPath.node.computed
              ) {
                callFailureCache.add(enc);
                return;
              }
              // Short opaque-key decodes often contain `\xFF`-range bytes by
              // design, so we don't reject those. But if the decode is *long*
              // and reads as mostly unprintable, it's almost certainly garbage.
              if (dec.length > 8) {
                let nonPrintable = 0;
                for (let j = 0; j < dec.length; j++) {
                  const code = dec.charCodeAt(j);
                  if (code < 0x20 || code >= 0x7F) nonPrintable++;
                }
                if (nonPrintable > dec.length / 3) {
                  callFailureCache.add(enc);
                  return;
                }
              }
            }
            // Number-as-property-key guard: when we'd inline a non-integer
            // number into the property slot of a computed member expression
            // (`obj[<call>]`), the result is nonsense like `w[-2051.61]`. The
            // decoder almost certainly intended a string key.
            if (
              typeof dec === "number" &&
              path.parentPath.isMemberExpression() &&
              path.parentPath.node.property === path.node &&
              path.parentPath.node.computed &&
              (!Number.isInteger(dec) || dec < 0 || dec > 0x7fffffff)
            ) {
              callFailureCache.add(enc);
              return;
            }
            // Don't let a numeric/boolean/null/undefined result replace the
            // *object* of a member expression — `42.concat(x)` is meaningless.
            // Strings are fine in that slot: `"l:".concat(msg)` works.
            if (
              path.parentPath.isMemberExpression() &&
              path.parentPath.node.object === path.node &&
              typeof dec !== "string"
            ) {
              return;
            }
            if (
              typeof dec === "function" ||
              (typeof dec === "object" && dec !== null)
            ) {
              return;
            }

            path.replaceWith(t.valueToNode(dec));
            changed = true;
            replacements++;
          } catch (err) {
            vmErrors++;
            phase4Failures++;
            callFailureCache.add(enc);
            const msg = err && err.message ? err.message : "";
            if (msg.includes("Maximum call stack") || msg.includes("too much recursion") || err instanceof RangeError) {
              recursionFailures++;
            }
            if (phase4Failures >= TOTAL_FAILURE_LIMIT) {
              phase4Aborted = true;
              if (logger) logger.warn(`Phase 4 aborted after ${phase4Failures} failures — pipeline panic brake`);
              path.stop();
            }
          }
        }
      });
    }
    if (logger) {
      logger.info(`Phase 4: ${phase4Failures} unique-call failures cached (${recursionFailures} recursion, ${phase4Failures - recursionFailures} runtime)`);
    }

    // Phase 4.5: Fold pure global-method calls regardless of the window alias.
    // Tags code reassigns `window` to a local identifier (commonly `A`) and then
    // writes `A.Math.ceil(764.31)`, `A.Number(-1560)`, `A.parseInt(13.37)`, etc.
    // Existing Phase 6 only runs when `newWindowName` was found via ddResObj; tags
    // has no ddResObj. Here we match the callee shape directly and evaluate any
    // call that bottoms out in a known-pure global, as long as all args are literals.
    if (logger) logger.info('Phase 4.5: Folding global Math/Number/parseInt/String calls');
    {
      const SAFE_MATH = new Set([
        "abs", "ceil", "floor", "round", "trunc", "sign",
        "min", "max", "pow", "sqrt", "cbrt", "log", "log2", "log10", "exp",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "sinh", "cosh", "tanh", "hypot", "fround", "clz32", "imul"
      ]);
      const SAFE_STRING = new Set(["fromCharCode", "fromCodePoint"]);
      const SAFE_DIRECT = new Set(["Number", "parseInt", "parseFloat", "isNaN", "isFinite"]);

      const isNumericLit = (arg) =>
        t.isNumericLiteral(arg) ||
        t.isStringLiteral(arg) ||
        (t.isUnaryExpression(arg) &&
          (arg.operator === "-" || arg.operator === "+") &&
          t.isNumericLiteral(arg.argument));

      // Extract a static property name from a MemberExpression, handling both
      // dot form (`.Name`) and computed-string form (`["Name"]`). Returns the
      // name or null if dynamic.
      const propName = (m) => {
        if (!t.isMemberExpression(m)) return null;
        if (!m.computed && t.isIdentifier(m.property)) return m.property.name;
        if (m.computed && t.isStringLiteral(m.property)) return m.property.value;
        return null;
      };
      const isObjectIdent = (node, name) => t.isIdentifier(node, { name });
      const isObjectNamed = (node, name) => {
        if (isObjectIdent(node, name)) return true;
        // A member like `<x>.Math` where .Math is the *name*
        return t.isMemberExpression(node) && propName(node) === name;
      };

      // Recognize a safe callee shape, return the code snippet to evaluate or null.
      // Handles dot and ["string"] forms interchangeably, any `A` alias for window.
      function classify(callee) {
        if (!t.isMemberExpression(callee) && !t.isIdentifier(callee)) return null;

        if (t.isMemberExpression(callee)) {
          const method = propName(callee);
          if (!method) return null;

          // <anything>.Math.<method>  OR  Math.<method>
          if (isObjectNamed(callee.object, "Math") && SAFE_MATH.has(method)) {
            return `Math.${method}`;
          }
          // <anything>.String.<method>  OR  String.<method>
          if (isObjectNamed(callee.object, "String") && SAFE_STRING.has(method)) {
            return `String.${method}`;
          }
          // <alias>.Number / .parseInt / .parseFloat / .isNaN / .isFinite
          if (SAFE_DIRECT.has(method)) {
            return method;
          }
          return null;
        }

        // Bare identifier: Number / parseInt / parseFloat
        if (SAFE_DIRECT.has(callee.name)) return callee.name;
        return null;
      }

      const safeCtx = vm.createContext({ Math, String, Number, parseInt, parseFloat, isNaN, isFinite });
      let folded = 0;
      traverse(ast, {
        CallExpression(path) {
          try {
            const symbol = classify(path.node.callee);
            if (!symbol) return;
            if (!path.node.arguments.every(isNumericLit)) return;

            const argsCode = path.node.arguments.map((a) => generate(a).code).join(", ");
            const code = `${symbol}(${argsCode})`;
            const val = vm.runInContext(code, safeCtx);

            // Don't inline non-primitives; NaN/Infinity are allowed (valueToNode handles them).
            if (typeof val === "function" || (typeof val === "object" && val !== null)) return;

            path.replaceWith(t.valueToNode(val));
            changed = true;
            folded++;
            replacements++;
          } catch (e) {
            // Swallow — will be retried with more context in later passes if useful.
          }
        }
      });
      if (logger) logger.info(`Phase 4.5: folded ${folded} global calls`);
    }

    // Phase 5: Remove ddResObj assignments and find window name
    if (logger) logger.info('Phase 5: Removing ddResObj assignments');
    let newWindowName = null;
    traverse(ast, {
      AssignmentExpression(path) {
        const left = path.node.left;
        const right = path.node.right;

        if (
          t.isMemberExpression(left) &&
          (t.isStringLiteral(right) || t.isNumericLiteral(right)) &&
          t.isStringLiteral(left.property) &&
          t.isMemberExpression(left.object) &&
          t.isStringLiteral(left.object.property) &&
          left.object.property.value === "ddResObj"
        ) {
          newWindowName = left.object.object.name;
          path.remove();
          changed = true;
        }
      }
    });

    // Phase 6: Evaluate Math/Number/parseInt calls
    if (logger) logger.info('Phase 6: Evaluating Math/Number/parseInt calls');
    if (newWindowName) {
      const windowContext = vm.createContext({
        [newWindowName]: {
          Math,
          Number,
          parseInt
        }
      });

      const isValidMathCall = (node) =>
        t.isMemberExpression(node) &&
        t.isStringLiteral(node.property) &&
        t.isMemberExpression(node.object) &&
        t.isIdentifier(node.object.object, { name: newWindowName }) &&
        t.isStringLiteral(node.object.property, { value: "Math" }) &&
        node.property.value !== "random";

      const isValidDirectCall = (node) =>
        t.isMemberExpression(node) &&
        t.isStringLiteral(node.property) &&
        t.isIdentifier(node.object, { name: newWindowName }) &&
        ["Number", "parseInt"].includes(node.property.value);

      traverse(ast, {
        CallExpression(path) {
          try {
            const { callee } = path.node;

            if (isValidMathCall(callee) || isValidDirectCall(callee)) {
              const generatedCode = generate(path.node).code;
              const evaluated = vm.runInContext(generatedCode, windowContext);

              path.replaceWith(t.valueToNode(evaluated));
              changed = true;
              replacements++;
            } else if (
              t.isIdentifier(callee) &&
              path.node.arguments.length === 2 &&
              path.node.arguments.every((arg) => t.isNumericLiteral(arg) || t.isUnaryExpression(arg))
            ) {
              const evaluated = vm.runInContext(generate(path.node).code, context);

              path.replaceWith(t.valueToNode(evaluated));
              changed = true;
              replacements++;
            }
          } catch (e) {
            // Fallback: replace window name with "window"
            if (newWindowName) {
              path.traverse({
                Identifier(path) {
                  if (path.node.name === newWindowName) {
                    path.node.name = "window";
                  }
                }
              });
            }
            vmErrors++;
            if (logger) logger.info(`Window call evaluation failed: ${e.message}`);
          }
        }
      });
    }

    // Phase 7: Find and replace obfuscated array accesses
    if (logger) logger.info('Phase 7: Processing obfuscated array accesses');
    if (ast.program && ast.program.body && ast.program.body.length > 1) {
      const secondBody = ast.program.body[1];
      if (secondBody &&
        t.isExpressionStatement(secondBody) &&
        secondBody.expression &&
        t.isCallExpression(secondBody.expression) &&
        secondBody.expression.callee &&
        t.isFunctionExpression(secondBody.expression.callee) &&
        secondBody.expression.callee.body &&
        secondBody.expression.callee.body.body) {

        secondBody.expression.callee.body.body.forEach((node) => {
          try {
            if (!t.isExpressionStatement(node)) {
              const code = generate(node).code;
              if (!code.includes("window")) {
                vm.runInContext(code, context);

                if (
                  t.isVariableDeclaration(node) &&
                  node.declarations.length === 1 &&
                  t.isIdentifier(node.declarations[0].id) &&
                  t.isCallExpression(node.declarations[0].init) &&
                  t.isFunctionExpression(node.declarations[0].init.callee) &&
                  node.declarations[0].init.callee.params.length === 2 &&
                  node.declarations[0].init.callee.body.body.length === 4
                ) {
                  obfuscatedArray = node.declarations[0].id.name;
                  obfuscatedArrayCode = context[obfuscatedArray];
                  if (logger) logger.info(`Found obfuscated array: ${obfuscatedArray}`);
                }
              } else {
                if (t.isVariableDeclaration(node)) {
                  const windowDeclarator = node.declarations.find((declarator) =>
                    t.isIdentifier(declarator.init) && declarator.init.name === 'window'
                  );
                  if (windowDeclarator) {
                    node.declarations.forEach((declarator) => {
                      if (declarator !== windowDeclarator) {
                        try {
                          vm.runInContext(generate(declarator).code, context);
                        } catch (e) {
                          vmErrors++;
                        }
                      }
                    });
                  }
                }
              }
            }
          } catch (e) {
            vmErrors++;
            if (logger) logger.info(`Array processing failed: ${e.message}`);
          }
        });
      }
    }

    // Phase 8: Replace obfuscated array member expressions
    if (obfuscatedArray && obfuscatedArrayCode) {
      if (logger) logger.info('Phase 8: Replacing obfuscated array member expressions');
      const foundCalls = [];

      traverse(ast, {
        MemberExpression(path) {
          const { node } = path;

          if (
            t.isMemberExpression(node.object) &&
            t.isLiteral(node.property) &&
            t.isIdentifier(node.object.object) &&
            node.object.object.name === obfuscatedArray &&
            t.isLiteral(node.object.property) &&
            t.isNumericLiteral(node.property) &&
            t.isNumericLiteral(node.object.property)
          ) {
            try {
              const output = obfuscatedArrayCode[node.object.property.value][node.property.value];
              if (!foundCalls.includes(output)) {
                foundCalls.push(output);
              }
              path.replaceWith(t.numericLiteral(foundCalls.indexOf(output)));
              changed = true;
              replacements++;
            } catch (e) {
              vmErrors++;
              if (logger) logger.info(`Array member replacement failed: ${e.message}`);
            }
          }
        }
      });
    }

    if (logger) {
      logger.info('String cleaning completed', {
        replacements,
        vmErrors,
        foundObfuscatedArray: !!obfuscatedArray
      });
    }

    if (result) {
      result.stats.preprocessing.stringCleaningReplacements = replacements;
      result.stats.preprocessing.vmErrors = vmErrors;
    }

    if (vmErrors > 0 && result) {
      result.addWarning(`Some VM evaluations failed (${vmErrors} errors)`, { vmErrors });
    }

  } catch (err) {
    const error = createError(
      ErrorCodes.TRANSFORMATION_ERROR,
      'Error during string cleaning',
      { error: err.message, stack: err.stack }
    );
    if (logger) logger.error('String cleaning failed', error);
    if (result) result.addError(error);
  }


  return changed;
}

module.exports = {
  simplifyBinaryExpressions,
  cleanBinaryAndMemberExpressions,
  cleanStrings,
  hasSideEffectsOrRuntimeDeps,
  canSafelyEvaluate
};

