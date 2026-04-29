/**
 * Error handling and result management for deobfuscation
 */

/**
 * Create a structured error object
 */
function createError(code, message, details = {}) {
  return {
    code,
    message,
    details,
    timestamp: new Date().toISOString()
  };
}

/**
 * Standard error codes
 */
const ErrorCodes = {
  PARSE_ERROR: 'PARSE_ERROR',
  FILE_ERROR: 'FILE_ERROR',
  VM_ERROR: 'VM_ERROR',
  TRANSFORMATION_ERROR: 'TRANSFORMATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  TRANSFORMATION_WARNING: 'TRANSFORMATION_WARNING',
  POSTPROCESSING_ERROR: 'POSTPROCESSING_ERROR'
};

/**
 * Result object structure
 */
class DeobfuscationResult {
  constructor() {
    this.success = true;
    this.errors = [];
    this.warnings = [];
    this.stats = {
      passes: 0,
      preprocessing: {
        binaryExpressionsSimplified: 0,
        memberExpressionsConverted: 0,
        stringCleaningReplacements: 0,
        vmErrors: 0
      },
      transformations: {
        tMatrixReplacements: 0,
        conditionalsSimplified: 0,
        expressionsSimplified: 0,
        ifStatementsSimplified: 0,
        switchCaseRemoved: 0,
        unusedVariablesRemoved: 0
      },
      size: {
        original: 0,
        deobfuscated: 0,
        reduction: 0
      }
    };
    this.ast = null;
    this.code = null;
  }

  addError(error) {
    this.success = false;
    this.errors.push(error);
  }

  addWarning(message, details = {}) {
    if (typeof message === 'object' && message.code) {
      // It's already an error object
      this.warnings.push(message);
    } else {
      this.warnings.push({
        message,
        details,
        timestamp: new Date().toISOString()
      });
    }
  }

  toJSON() {
    return {
      success: this.success,
      errors: this.errors,
      warnings: this.warnings,
      stats: this.stats
    };
  }
}

module.exports = { createError, ErrorCodes, DeobfuscationResult };


