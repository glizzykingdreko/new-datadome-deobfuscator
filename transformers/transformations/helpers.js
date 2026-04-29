/**
 * Helper functions for transformations
 */

const t = require('@babel/types');

/**
 * Helper to check if an if statement contains break/return
 */
function hasBreakOrReturnInIf(ifStmt) {
  const checkStatement = (stmt) => {
    if (t.isBreakStatement(stmt) || t.isReturnStatement(stmt)) {
      return true;
    }
    if (t.isBlockStatement(stmt)) {
      return stmt.body.some(checkStatement);
    }
    if (t.isIfStatement(stmt)) {
      return (stmt.consequent && checkStatement(stmt.consequent)) ||
             (stmt.alternate && checkStatement(stmt.alternate));
    }
    return false;
  };
  
  return (ifStmt.consequent && checkStatement(ifStmt.consequent)) ||
         (ifStmt.alternate && checkStatement(ifStmt.alternate));
}

module.exports = { hasBreakOrReturnInIf };
