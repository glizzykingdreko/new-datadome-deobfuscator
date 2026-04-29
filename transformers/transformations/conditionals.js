const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { isComplexBitwiseObfuscation, isObfuscatedTernary } = require('../utils');

function simplifyConditionals(ast, logger = null, result = null) {
  let changed = false;
  
  traverse(ast, {
    ConditionalExpression(path) {
      if (!path.node) return;
      
      const { node } = path;
      
      // Handle nested ternaries: ((complex_bitwise ? true : x) ? "a" : "b")
      if (t.isConditionalExpression(node.test)) {
        const innerTest = node.test;
        if (t.isBooleanLiteral(innerTest.consequent) && innerTest.consequent.value === true) {
          if (isComplexBitwiseObfuscation(innerTest.test)) {
            const simplifiedTest = t.logicalExpression('||', innerTest.test, innerTest.alternate);
            path.get('test').replaceWith(simplifiedTest);
            changed = true;
          }
        }
        if (t.isBooleanLiteral(innerTest.consequent) && innerTest.consequent.value === false) {
          if (isComplexBitwiseObfuscation(innerTest.test)) {
            const simplifiedTest = t.logicalExpression('&&', t.unaryExpression('!', innerTest.test), innerTest.alternate);
            path.get('test').replaceWith(simplifiedTest);
            changed = true;
          }
        }
      }
      
      // Detect obfuscated ternary: (complex_bitwise ? true : x) -> simplify
      if (isObfuscatedTernary(node)) {
        const test = path.get('test');
        try {
          const evaluated = test.evaluate();
          if (evaluated.confident) {
            if (evaluated.value) {
              path.replaceWith(node.consequent);
            } else {
              path.replaceWith(node.alternate);
            }
            changed = true;
            path.skip();
            return;
          }
        } catch (e) {
          // Evaluation failed, continue
        }
      }
      
      // Pattern: (expr ? true : false) -> !!expr or just expr
      if (t.isBooleanLiteral(node.consequent) && t.isBooleanLiteral(node.alternate)) {
        if (node.consequent.value === true && node.alternate.value === false) {
          path.replaceWith(node.test);
          changed = true;
          path.skip();
          return;
        } else if (node.consequent.value === false && node.alternate.value === true) {
          path.replaceWith(t.unaryExpression('!', node.test));
          changed = true;
          path.skip();
          return;
        }
      }
      
      // Pattern: (expr ? true : x) -> expr || x
      if (t.isBooleanLiteral(node.consequent) && node.consequent.value === true) {
        if (isComplexBitwiseObfuscation(node.test)) {
          path.replaceWith(t.logicalExpression('||', node.test, node.alternate));
          changed = true;
          path.skip();
          return;
        }
      }
      
      // Pattern: (expr ? false : x) -> !expr && x
      if (t.isBooleanLiteral(node.consequent) && node.consequent.value === false) {
        if (isComplexBitwiseObfuscation(node.test)) {
          path.replaceWith(t.logicalExpression('&&', t.unaryExpression('!', node.test), node.alternate));
          changed = true;
          path.skip();
          return;
        }
      }
      
      // Try to evaluate the test
      const test = path.get('test');
      try {
        const evaluated = test.evaluate();
        if (evaluated.confident) {
          if (evaluated.value) {
            if (path.node.consequent) {
              path.replaceWith(path.node.consequent);
              changed = true;
              path.skip();
            }
          } else {
            if (path.node.alternate) {
              path.replaceWith(path.node.alternate);
              changed = true;
              path.skip();
            }
          }
        }
      } catch (e) {
        // Continue if evaluation fails
      }
      
      // Simplify: true ? x : y -> x
      if (t.isBooleanLiteral(test.node) && test.node.value === true) {
        if (path.node.consequent) {
          path.replaceWith(path.node.consequent);
          changed = true;
          path.skip();
        }
        return;
      }
      
      // Simplify: false ? x : y -> y
      if (t.isBooleanLiteral(test.node) && test.node.value === false) {
        if (path.node.alternate) {
          path.replaceWith(path.node.alternate);
          changed = true;
          path.skip();
        }
        return;
      }
    }
  });
  
  return changed;
}

module.exports = { simplifyConditionals };
