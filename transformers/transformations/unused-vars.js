/**
 * Remove unused variable declarations
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function removeUnusedVariables(ast, logger = null, result = null) {
  let removedVars = true;
  let varPassCount = 0;
  const MAX_VAR_PASSES = 20;
  
  while (removedVars && varPassCount < MAX_VAR_PASSES) {
    removedVars = false;
    varPassCount++;
    
    // Ensure scopes are crawled
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
      },
      Function(path) {
        path.scope.crawl();
      },
      BlockStatement(path) {
        path.scope.crawl();
      }
    });

    traverse(ast, {
      Program: {
        exit(path) {
          const scope = path.scope;
          if (!scope) return;
          const bindings = scope.bindings;
          
          Object.keys(bindings).forEach(name => {
            const binding = bindings[name];
            if (!binding.path.isVariableDeclarator()) return;
            
            const references = binding.referencePaths || [];
            const violations = binding.constantViolations || [];
            const isUsed = references.length > 0 || violations.length > 0;
        
            if (!isUsed) {
              const init = binding.path.get('init');
              const hasSimpleInit = !init.node || (
                t.isNumericLiteral(init.node) ||
                t.isStringLiteral(init.node) ||
                t.isBooleanLiteral(init.node) ||
                (t.isUnaryExpression(init.node) && t.isNumericLiteral(init.node.argument))
              );
              
              const canRemove = hasSimpleInit || !init.node;
              
              if (canRemove) {
                const declaration = binding.path.parentPath;
                if (declaration.isVariableDeclaration()) {
                  const declarators = declaration.get('declarations');
                  if (declarators.length === 1) {
                    declaration.remove();
                    removedVars = true;
                  } else {
                    binding.path.remove();
                    removedVars = true;
                  }
                }
              }
            }
          });
        }
      },
      
      Function: {
        exit(path) {
          const scope = path.scope;
          if (!scope) return;
          const bindings = scope.bindings;
          
          Object.keys(bindings).forEach(name => {
            const binding = bindings[name];
            if (!binding.path.isVariableDeclarator()) return;
            
            const references = binding.referencePaths || [];
            const violations = binding.constantViolations || [];
            const isUsed = references.length > 0 || violations.length > 0;
        
            if (!isUsed) {
              const init = binding.path.get('init');
              const hasSimpleInit = !init.node || (
                t.isNumericLiteral(init.node) ||
                t.isStringLiteral(init.node) ||
                t.isBooleanLiteral(init.node) ||
                (t.isUnaryExpression(init.node) && t.isNumericLiteral(init.node.argument))
              );
              
              const canRemove = hasSimpleInit || !init.node;
              
              if (canRemove) {
                const declaration = binding.path.parentPath;
                if (declaration.isVariableDeclaration()) {
                  const declarators = declaration.get('declarations');
                  if (declarators.length === 1) {
                    declaration.remove();
                    removedVars = true;
                  } else {
                    binding.path.remove();
                    removedVars = true;
                  }
                }
              }
            }
          });
        }
      },
      
      BlockStatement: {
        exit(path) {
          const scope = path.scope;
          if (!scope) return;
          
          const bindings = scope.bindings;
          Object.keys(bindings).forEach(name => {
            const binding = bindings[name];
            if (!binding.path.isVariableDeclarator()) return;
            
            const references = binding.referencePaths || [];
            const violations = binding.constantViolations || [];
            const isUsed = references.length > 0 || violations.length > 0;
        
            if (!isUsed) {
              const init = binding.path.get('init');
              const hasSimpleInit = !init.node || (
                t.isNumericLiteral(init.node) ||
                t.isStringLiteral(init.node) ||
                t.isBooleanLiteral(init.node) ||
                (t.isUnaryExpression(init.node) && t.isNumericLiteral(init.node.argument))
              );
              
              const canRemove = hasSimpleInit || !init.node;
              
              if (canRemove) {
                const declaration = binding.path.parentPath;
                if (declaration.isVariableDeclaration()) {
                  const declarators = declaration.get('declarations');
                  if (declarators.length === 1) {
                    declaration.remove();
                    removedVars = true;
                  } else {
                    binding.path.remove();
                    removedVars = true;
                  }
                }
              }
            }
          });
        }
      }
    });

    // Clean up empty variable declarations after removal
    if (removedVars) {
      traverse(ast, {
        VariableDeclaration(path) {
          if (path.node.declarations.length === 0) {
            path.remove();
          }
        }
      });
    }
  }

  if (logger && varPassCount > 0) {
    logger.debug(`Unused variable removal completed after ${varPassCount} passes`);
  }
  if (result) {
    result.stats.transformations.unusedVariablesRemoved = varPassCount;
  }

  return removedVars;
}

module.exports = { removeUnusedVariables };
