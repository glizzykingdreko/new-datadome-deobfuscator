/**
 * Utility functions for deobfuscation
 */

const t = require('@babel/types');

/**
 * Check if an expression is a complex bitwise obfuscation pattern
 */
function isComplexBitwiseObfuscation(node) {
  if (!node) return false;
  
  const hasBitwiseOps = (expr) => {
    if (!expr) return false;
    if (t.isBinaryExpression(expr)) {
      if (['&', '|', '^'].includes(expr.operator)) return true;
      return hasBitwiseOps(expr.left) || hasBitwiseOps(expr.right);
    }
    if (t.isUnaryExpression(expr) && expr.operator === '~') {
      return hasBitwiseOps(expr.argument);
    }
    if (t.isConditionalExpression(expr)) {
      return hasBitwiseOps(expr.test) || hasBitwiseOps(expr.consequent) || hasBitwiseOps(expr.alternate);
    }
    return false;
  };
  
  if (t.isBinaryExpression(node)) {
    if (['<', '>', '<=', '>=', '==', '!=', '==='].includes(node.operator)) {
      return hasBitwiseOps(node.left) || hasBitwiseOps(node.right);
    }
    return hasBitwiseOps(node);
  }
  
  return hasBitwiseOps(node);
}

/**
 * Detect if a ternary has obfuscated condition with true/false branches
 */
function isObfuscatedTernary(node) {
  if (!t.isConditionalExpression(node)) return false;
  const testIsComplex = isComplexBitwiseObfuscation(node.test);
  const consequentIsBool = t.isBooleanLiteral(node.consequent);
  return testIsComplex && consequentIsBool;
}

/**
 * Simplify string concatenation expressions
 */
function simplifyConcatenation(expression) {
  if (t.isStringLiteral(expression)) {
    return expression.value;
  } else if (t.isBinaryExpression(expression, { operator: '+' })) {
    const left = simplifyConcatenation(expression.left);
    const right = simplifyConcatenation(expression.right);
    if (left !== null && right !== null) {
      return left + right;
    }
  }
  return null;
}

module.exports = {
  isComplexBitwiseObfuscation,
  isObfuscatedTernary,
  simplifyConcatenation
};


