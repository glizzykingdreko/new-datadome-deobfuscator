const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const vm = require('vm');
const { hasSideEffectsOrRuntimeDeps, canSafelyEvaluate } = require('../preprocessing');

function simplifyExpressions(ast, logger = null, result = null) {
  let changed = false;
  let simplifications = 0;
  
  // Ensure scopes are crawled at block level for better identifier resolution
  traverse(ast, {
    BlockStatement(path) {
      path.scope.crawl();
    },
    Function(path) {
      path.scope.crawl();
    }
  });
  
  traverse(ast, {
    BinaryExpression(path) {
      if (!path.node) return;
      
      // For logical operators (&&, ||), check for runtime dependencies first
      // NEVER evaluate expressions with member access, function calls, or typeof
      if (['&&', '||'].includes(path.node.operator)) {
        if (hasSideEffectsOrRuntimeDeps(path.node)) {
          // Expression has runtime deps - don't evaluate
          return;
        }
      }
      
      // For all binary expressions, check for runtime dependencies (member access, typeof, calls)
      // But allow identifiers - Babel's evaluate() will only be confident if identifiers are resolved
      if (hasSideEffectsOrRuntimeDeps(path.node)) {
        // Expression has runtime deps - don't evaluate
        return;
      }
      
      try {
        // Try to evaluate - Babel will only be confident if all identifiers are constants
        const evaluated = path.evaluate();
        if (evaluated.confident) {
          const replacement = t.valueToNode(evaluated.value);
          path.replaceWith(replacement);
          changed = true;
          simplifications++;
          path.skip();
          return;
        }
      } catch (e) {
        // Continue if evaluation fails
      }
      
      // Try to evaluate complex expressions by ensuring scope is crawled
      // This helps with expressions containing identifiers that have numeric values
      // But only if the expression doesn't have runtime dependencies (member access, typeof, calls)
      // Check for runtime dependencies first - don't evaluate if found
      if (hasSideEffectsOrRuntimeDeps(path.node)) {
        return;
      }
      
      try {
        const scope = path.scope;
        if (scope) {
          scope.crawl();
          // Try evaluation again after crawling scope
          // Only evaluate if Babel is confident (i.e., all identifiers are resolved to constants)
          const evaluated = path.evaluate();
          if (evaluated.confident) {
            const replacement = t.valueToNode(evaluated.value);
            path.replaceWith(replacement);
            changed = true;
            simplifications++;
            path.skip();
            return;
          }
          
          // Additional attempt: manually resolve identifiers with numeric values
          // This helps with complex bitwise expressions where variables have numeric literals
          const collectIdentifiers = (node, identifiers) => {
            if (t.isIdentifier(node)) {
              if (!identifiers.has(node.name)) {
                identifiers.add(node.name);
              }
            } else if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
              collectIdentifiers(node.left, identifiers);
              collectIdentifiers(node.right, identifiers);
            } else if (t.isUnaryExpression(node)) {
              collectIdentifiers(node.argument, identifiers);
            } else if (t.isMemberExpression(node)) {
              collectIdentifiers(node.object, identifiers);
              if (node.property && !t.isLiteral(node.property)) {
                collectIdentifiers(node.property, identifiers);
              }
            }
          };
          
          const identifiers = new Set();
          collectIdentifiers(path.node, identifiers);
          
          // Check if all identifiers have numeric literal bindings
          const identifierValues = {};
          let allHaveNumericValues = true;
          
          for (const idName of identifiers) {
            const binding = scope.getBinding(idName);
            if (binding && binding.path.isVariableDeclarator()) {
              const init = binding.path.get('init');
              if (init.node) {
                if (t.isNumericLiteral(init.node)) {
                  identifierValues[idName] = init.node.value;
                } else if (t.isUnaryExpression(init.node) && 
                          (init.node.operator === '-' || init.node.operator === '+') &&
                          t.isNumericLiteral(init.node.argument)) {
                  identifierValues[idName] = init.node.operator === '-' 
                    ? -init.node.argument.value 
                    : init.node.argument.value;
                } else {
                  // Try to evaluate the init
                  try {
                    const evalResult = init.evaluate();
                    if (evalResult.confident && typeof evalResult.value === 'number') {
                      identifierValues[idName] = evalResult.value;
                    } else {
                      allHaveNumericValues = false;
                      break;
                    }
                  } catch (e) {
                    allHaveNumericValues = false;
                    break;
                  }
                }
              } else {
                // No init value - identifier is undefined/uninitialized
                // Don't evaluate expressions with uninitialized variables
                allHaveNumericValues = false;
                break;
              }
            } else {
              // No binding found - identifier is not a constant
              // Don't evaluate expressions with unresolved identifiers
              allHaveNumericValues = false;
              break;
            }
          }
          
          // If all identifiers have numeric values, try VM evaluation
          if (allHaveNumericValues && Object.keys(identifierValues).length > 0) {
            try {
              const vm = require('vm');
              const context = vm.createContext(identifierValues);
              const code = generate(path.node).code;
              const result = vm.runInContext(code, context);
              path.replaceWith(t.valueToNode(result));
              changed = true;
              simplifications++;
              path.skip();
              return;
            } catch (e) {
              // VM evaluation failed, continue
            }
          }
        }
      } catch (e) {
        // Continue if evaluation fails
      }
      
      const { node } = path;
      
      // Simplify logical expressions with boolean literals
      const simplifyLogical = (left, right, operator) => {
        if (t.isBooleanLiteral(left)) {
          if (left.value === false && operator === '||') return node.right;
          if (left.value === true && operator === '||') return t.booleanLiteral(true);
          if (left.value === true && operator === '&&') return node.right;
          if (left.value === false && operator === '&&') return t.booleanLiteral(false);
        }
        if (t.isBooleanLiteral(right)) {
          if (right.value === false && operator === '||') return node.left;
          if (right.value === true && operator === '||') return t.booleanLiteral(true);
          if (right.value === true && operator === '&&') return node.left;
          if (right.value === false && operator === '&&') return t.booleanLiteral(false);
        }
        return null;
      };
      
      if (['||', '&&'].includes(node.operator)) {
        // Don't simplify if expression has runtime dependencies
        if (hasSideEffectsOrRuntimeDeps(path.node)) {
          return;
        }
        const simplified = simplifyLogical(node.left, node.right, node.operator);
        if (simplified) {
          path.replaceWith(simplified);
        changed = true;
        path.skip();
        return;
      }
      }
    },
    
    LogicalExpression(path) {
      if (!path.node) return;
      
      const { node } = path;
      
      // Check for runtime dependencies first - don't evaluate if expression has member access, typeof, or calls
      if (hasSideEffectsOrRuntimeDeps(path.node)) {
        // Expression has runtime deps - don't evaluate
        return;
      }
      
      // Check if expression contains identifiers that aren't constants
      // We need to check the scope to see if identifiers are actually constants
      const scope = path.scope;
      if (scope) {
        scope.crawl();
        const hasUnresolvedIdentifiers = (expr) => {
          if (t.isIdentifier(expr)) {
            const binding = scope.getBinding(expr.name);
            if (!binding || !binding.path.isVariableDeclarator()) {
              return true; // Identifier not found or not a constant
            }
            const init = binding.path.get('init');
            if (!init.node) {
              return true; // Variable declared but not initialized
            }
            // Check if it's a constant literal
            if (!t.isLiteral(init.node) && !t.isUnaryExpression(init.node)) {
              return true; // Not a constant
            }
          } else if (t.isBinaryExpression(expr) || t.isLogicalExpression(expr)) {
            return hasUnresolvedIdentifiers(expr.left) || hasUnresolvedIdentifiers(expr.right);
          } else if (t.isUnaryExpression(expr)) {
            return hasUnresolvedIdentifiers(expr.argument);
          }
          return false;
        };
        
        if (hasUnresolvedIdentifiers(node.left) || hasUnresolvedIdentifiers(node.right)) {
          // Expression contains identifiers that aren't constants - don't evaluate
          return;
        }
      }
      
      try {
        const left = path.get('left').evaluate();
        const right = path.get('right').evaluate();
        
        if (left.confident && right.confident) {
          let result;
          if (node.operator === '&&') {
            result = left.value && right.value;
          } else if (node.operator === '||') {
            result = left.value || right.value;
          }
          path.replaceWith(t.valueToNode(result));
          changed = true;
          path.skip();
          return;
        }
        
        // Short-circuit evaluation - but only if left/right are literals or constants
        // Don't do short-circuit if they're identifiers that aren't constants
        if (left.confident) {
          if (node.operator === '&&' && !left.value) {
            // Only if left is a literal (not an identifier)
            if (t.isLiteral(path.node.left)) {
              path.replaceWith(t.booleanLiteral(false));
              changed = true;
              path.skip();
              return;
            }
          } else if (node.operator === '||' && left.value) {
            // Only if left is a literal (not an identifier)
            // If left is an identifier, preserve the expression even if it evaluates to truthy
            if (t.isLiteral(path.node.left)) {
              path.replaceWith(t.booleanLiteral(true));
              changed = true;
              path.skip();
              return;
            }
            // If left is an identifier, check if it's actually a constant
            if (t.isIdentifier(path.node.left)) {
              const leftBinding = scope.getBinding(path.node.left.name);
              if (!leftBinding || !leftBinding.path.isVariableDeclarator() || !leftBinding.path.get('init').node) {
                // Not a constant - preserve the expression
                return;
              }
              // It's a constant, safe to replace
              path.replaceWith(t.booleanLiteral(true));
              changed = true;
              path.skip();
              return;
            }
          }
        } else if (right.confident) {
          if (node.operator === '&&' && !right.value) {
            if (t.isLiteral(path.node.right)) {
              path.replaceWith(t.booleanLiteral(false));
              changed = true;
              path.skip();
              return;
            }
          } else if (node.operator === '||' && right.value) {
            // Only replace with true if right is a literal
            if (t.isLiteral(path.node.right)) {
              path.replaceWith(t.booleanLiteral(true));
              changed = true;
              path.skip();
              return;
            }
          }
        }
      } catch (e) {
        // Continue if evaluation fails
      }
      
      // Simplify boolean literal patterns
      if (t.isBooleanLiteral(node.left)) {
        if (node.left.value === false && node.operator === '||') {
        path.replaceWith(node.right);
        changed = true;
        path.skip();
        return;
      }
        if (node.left.value === true && node.operator === '||') {
        path.replaceWith(t.booleanLiteral(true));
        changed = true;
        path.skip();
        return;
      }
        if (node.left.value === true && node.operator === '&&') {
        path.replaceWith(node.right);
        changed = true;
        path.skip();
        return;
      }
        if (node.left.value === false && node.operator === '&&') {
        path.replaceWith(t.booleanLiteral(false));
        changed = true;
        path.skip();
        return;
        }
      }
      
      // Same for right side
      if (t.isBooleanLiteral(node.right)) {
        if (node.right.value === false && node.operator === '||') {
        path.replaceWith(node.left);
        changed = true;
        path.skip();
        return;
      }
        if (node.right.value === true && node.operator === '||') {
        path.replaceWith(t.booleanLiteral(true));
        changed = true;
        path.skip();
        return;
      }
        if (node.right.value === true && node.operator === '&&') {
        path.replaceWith(node.left);
        changed = true;
        path.skip();
        return;
      }
        if (node.right.value === false && node.operator === '&&') {
        path.replaceWith(t.booleanLiteral(false));
        changed = true;
        path.skip();
        return;
      }
      }
    },
    
    UnaryExpression(path) {
      if (!path.node) return;
      
      try {
        const evaluated = path.evaluate();
        if (evaluated.confident) {
          path.replaceWith(t.valueToNode(evaluated.value));
          changed = true;
          path.skip();
        }
      } catch (e) {
        // Continue if evaluation fails
      }
    },
    
    SequenceExpression(path) {
      if (!path.node) return;
      
      // Helper function to check if a node is a function (expression or declaration)
      const isFunction = (node) => {
        return t.isFunctionExpression(node) || t.isFunctionDeclaration(node) || 
               t.isArrowFunctionExpression(node);
      };
      
      // Helper function to check if an expression is an IIFE
      const isIIFE = (node) => {
        if (!node) return false;
        
        // Pattern: !function() { ... }() or void function() { ... }()
        if (t.isUnaryExpression(node)) {
          if (node.operator === '!' || node.operator === 'void') {
            if (t.isCallExpression(node.argument)) {
              return isFunction(node.argument.callee);
            }
          }
        }
        
        // Pattern: (function() { ... })() or function() { ... }()
        if (t.isCallExpression(node)) {
          if (isFunction(node.callee)) {
            return true;
          }
          // Pattern: (function() { ... }()) - function wrapped in unary
          if (t.isUnaryExpression(node.callee)) {
            return isFunction(node.callee.argument);
          }
        }
        
        return false;
      };
      
      // Remove sequence expressions that are just numeric literals (e.g., "12, 9" or "3, 8")
      // Keep only expressions with side effects
      const expressions = path.node.expressions;
      const usefulExpressions = [];
      
      for (const expr of expressions) {
        // Check if expression has side effects
        let hasSideEffects = false;
        
        // IIFEs always have side effects - check this first
        if (isIIFE(expr)) {
          hasSideEffects = true;
        }
        // Function calls have side effects
        else if (t.isCallExpression(expr)) {
          hasSideEffects = true;
        }
        // Assignments have side effects
        else if (t.isAssignmentExpression(expr)) {
          hasSideEffects = true;
        }
        // Update expressions (++/--) have side effects
        else if (t.isUpdateExpression(expr)) {
          hasSideEffects = true;
        }
        // Member expressions might have side effects (property access)
        else if (t.isMemberExpression(expr)) {
          // Keep member expressions that might be property access
          hasSideEffects = true;
        }
        // Identifiers might reference variables with side effects
        else if (t.isIdentifier(expr)) {
          hasSideEffects = true;
        }
        // Binary expressions with complex operations might have side effects
        else if (t.isBinaryExpression(expr) && ['&', '|', '^', '<<', '>>', '>>>'].includes(expr.operator)) {
          // Bitwise operations might reference variables - keep them for now
          hasSideEffects = true;
        }
        // Check for side effects using the helper function
        else if (hasSideEffectsOrRuntimeDeps(expr)) {
          hasSideEffects = true;
        }
        
        if (hasSideEffects) {
          usefulExpressions.push(expr);
        }
      }
      
      // If all expressions are useless (no side effects), try to evaluate the last one
      if (usefulExpressions.length === 0 && expressions.length > 0) {
        const lastExpr = expressions[expressions.length - 1];
        try {
          const lastPath = path.get('expressions')[expressions.length - 1];
          const evaluated = lastPath.evaluate();
          if (evaluated.confident) {
            // Replace with the last expression's value
            path.replaceWith(t.valueToNode(evaluated.value));
            changed = true;
            path.skip();
            return;
          }
        } catch (e) {
          // If evaluation fails, just remove the sequence (replace with the last expression)
          if (expressions.length === 1) {
            path.replaceWith(expressions[0]);
            changed = true;
            path.skip();
            return;
          }
          // For multiple expressions, keep only the last one
          path.replaceWith(expressions[expressions.length - 1]);
          changed = true;
          path.skip();
          return;
        }
      }
      
      // If we have useful expressions, keep only those
      if (usefulExpressions.length > 0 && usefulExpressions.length < expressions.length) {
        if (usefulExpressions.length === 1) {
          path.replaceWith(usefulExpressions[0]);
        } else {
          path.node.expressions = usefulExpressions;
        }
        changed = true;
      } else if (usefulExpressions.length === 0 && expressions.length > 1) {
        // All expressions are useless, replace with the last one
        path.replaceWith(expressions[expressions.length - 1]);
        changed = true;
      }
    },
    
    ExpressionStatement(path) {
      if (!path.node) return;
      
      const expr = path.node.expression;
      
      // Helper function to check if a node is a function (expression or declaration)
      const isFunction = (node) => {
        return t.isFunctionExpression(node) || t.isFunctionDeclaration(node) || 
               t.isArrowFunctionExpression(node);
      };
      
      // Helper function to check if an expression is an IIFE
      const isIIFE = (node) => {
        if (!node) return false;
        
        // Pattern: !function() { ... }() or void function() { ... }()
        if (t.isUnaryExpression(node)) {
          if (node.operator === '!' || node.operator === 'void') {
            if (t.isCallExpression(node.argument)) {
              return isFunction(node.argument.callee);
            }
          }
        }
        
        // Pattern: (function() { ... })() or function() { ... }()
        if (t.isCallExpression(node)) {
          if (isFunction(node.callee)) {
            return true;
          }
          // Pattern: (function() { ... }()) - function wrapped in unary
          if (t.isUnaryExpression(node.callee)) {
            return isFunction(node.callee.argument);
          }
        }
        
        return false;
      };
      
      // NEVER remove IIFEs (Immediately Invoked Function Expressions) - they have side effects
      if (isIIFE(expr)) {
        // This is an IIFE - preserve it
        return;
      }
      
      // Check for side effects before removing
      if (hasSideEffectsOrRuntimeDeps(expr)) {
        // Expression has side effects - don't remove
        return;
      }
      
      // Remove expression statements that are just numeric literals (e.g., "12, 9;")
      if (t.isSequenceExpression(expr)) {
        const seq = expr;
        // Check if all expressions are numeric/string/boolean literals
        const allLiterals = seq.expressions.every(e => 
          t.isNumericLiteral(e) || 
          t.isStringLiteral(e) || 
          t.isBooleanLiteral(e) ||
          (t.isUnaryExpression(e) && t.isNumericLiteral(e.argument))
        );
        
        if (allLiterals) {
          // Remove the entire statement
          path.remove();
          changed = true;
          return;
        }
      }
      
      // Remove expression statements that are just numeric literals
      if (t.isNumericLiteral(expr) || 
          t.isStringLiteral(expr) ||
          t.isBooleanLiteral(expr)) {
        path.remove();
        changed = true;
        return;
      }
      
      // Try to evaluate the expression
      try {
        const evaluated = path.get('expression').evaluate();
        if (evaluated.confident) {
          // If it evaluates to a literal, remove the statement
          // BUT only if it doesn't have side effects (already checked above)
          if (typeof evaluated.value === 'number' || 
              typeof evaluated.value === 'string' || 
              typeof evaluated.value === 'boolean') {
            path.remove();
            changed = true;
            return;
          }
        }
      } catch (e) {
        // Continue if evaluation fails
      }
    }
  });
  
  if (logger && simplifications > 0) {
    logger.debug(`Expression simplifications: ${simplifications}`);
  }
  if (result) {
    result.stats.transformations.expressionsSimplified = (result.stats.transformations.expressionsSimplified || 0) + simplifications;
  }
  
  return changed;
}

module.exports = { simplifyExpressions };
