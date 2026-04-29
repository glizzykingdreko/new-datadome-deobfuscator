/**
 * Replace t[x][y] matrix obfuscation with numeric values
 */

const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { createError, ErrorCodes } = require('../errors');

function replaceTMatrix(ast, tMap, tName, logger = null, result = null) {
  let changed = false;
  let replacements = 0;

  logger.info(`Replacing t-matrix obfuscation with tName: ${tName} with a Mao with ${Object.keys(tMap).length} entries`);
  
  try {
    traverse(ast, {
      MemberExpression(path) {
        if (!path.node) return;
        
        const { node } = path;
        
        if (t.isMemberExpression(node.object) && 
            t.isIdentifier(node.object.object) && 
            node.object.object.name === tName &&
            t.isNumericLiteral(node.object.property) &&
            t.isNumericLiteral(node.property)) {
          
          const x = node.object.property.value;
          const y = node.property.value;
          const key = `${tName}[${x}][${y}]`;
          
          if (tMap[key] !== undefined) {
            try {
              path.replaceWith(t.numericLiteral(tMap[key]));
              changed = true;
              replacements++;
              path.skip();
            } catch (err) {
              const error = createError(
                ErrorCodes.TRANSFORMATION_ERROR,
                `Failed to replace t[${x}][${y}]`,
                { key, error: err.message, stack: err.stack }
              );
              if (logger) logger.error(`Failed to replace ${key}`, error);
              if (result) result.addError(error);
            }
          }
        }
      }
    });
    
    if (logger) logger.debug(`T-Matrix replacements: ${replacements}`);
    if (result) result.stats.transformations.tMatrixReplacements = replacements;
  } catch (err) {
    const error = createError(
      ErrorCodes.TRANSFORMATION_ERROR,
      'Error during t-matrix replacement',
      { error: err.message, stack: err.stack }
    );
    if (logger) logger.error('T-Matrix replacement failed', error);
    if (result) result.addError(error);
    throw err;
  }
  
  return changed;
}

module.exports = { replaceTMatrix };
