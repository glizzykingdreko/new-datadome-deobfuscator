/**
 * Main entry point for deobfuscation module
 */

const parser = require('@babel/parser');
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const { Logger, LogLevel } = require('./logger');
const { createError, ErrorCodes, DeobfuscationResult } = require('./errors');
const { simplifyBinaryExpressions, cleanBinaryAndMemberExpressions, cleanStrings } = require('./preprocessing');
const { scorporateCaptchaModules , uncomputeMemberExpressions, cleanDoubleBracketProps, decodeHexStringsInAst} = require('./captcha');
const {
  replaceTMatrix,
  simplifyConditionals,
  simplifyExpressions,
  simplifyIfStatements,
  removeSwitchCaseStateMachines,
  removeUnusedVariables,
  foldOpaquePredicates,
  inlineSetTimeoutZero
} = require('./transformations');
const { extractModules, DEFAULT_LEGENDA } = require('./postprocessing');

/**
 * Main deobfuscation function
 */
function deobfuscate(ast, options = {}) {
  const { 
    tMap = {}, 
    tName = 't',
    maxPasses = 10,
    logger: providedLogger = null,
    logLevel = 'INFO',
    enablePreprocessing = true
  } = options;
  
  // Initialize logger
  const logger = providedLogger || new Logger(LogLevel[logLevel] || LogLevel.INFO, 'Deobfuscator');
  
  // Initialize result object
  const result = new DeobfuscationResult();
  result.ast = ast;
  
  try {
    logger.info('Starting deobfuscation process', { maxPasses, tMapSize: Object.keys(tMap).length });
    
    if (!ast) {
      const error = createError(ErrorCodes.VALIDATION_ERROR, 'AST is required');
      result.addError(error);
      logger.error('Invalid AST provided', error);
      return result;
    }
    
    // ========================================================================
    // PREPROCESSING PHASE
    // ========================================================================
    if (enablePreprocessing) {
      logger.info('Starting preprocessing phase...');
      
      try {
        // Step 1: Simplify binary expressions
        logger.info('Step 1: Simplifying binary expressions...');
        simplifyBinaryExpressions(ast, logger, result);
        
        // Step 2: Clean strings using VM evaluation
        logger.info('Step 2: Cleaning strings and evaluating VM expressions...');
        cleanStrings(ast, logger, result);
        
        // Step 3: Clean binary and member expressions
        logger.info('Step 3: Cleaning member and binary expressions...');
        cleanBinaryAndMemberExpressions(ast, logger, result);

        // Step 4: Unwrap setTimeout(fn, 0) control-flow obfuscation — DataDome
        // hides plain assignments behind zero-delay timers. Inlining them once
        // here lets the iterative pass see normal-looking code.
        logger.info('Step 4: Inlining setTimeout(fn, 0) wrappers...');
        inlineSetTimeoutZero(ast, logger, result);

        logger.info('Preprocessing phase completed');
      } catch (err) {
        const error = createError(
          ErrorCodes.TRANSFORMATION_ERROR,
          'Error during preprocessing phase',
          { error: err.message, stack: err.stack }
        );
        result.addError(error);
        logger.error('Preprocessing phase failed', error);
        // Continue anyway - preprocessing errors are often non-fatal
      }
    } else {
      logger.info('Preprocessing phase skipped (disabled)');
    }
    
    // ========================================================================
    // MAIN TRANSFORMATION PHASE
    // ========================================================================
    let passCount = 0;
    let changed = true;
    
    // Apply transformations in multiple passes until no more changes
    while (changed && passCount < maxPasses) {
      changed = false;
      passCount++;
      
      
      try {
        // Replace t[x][y] matrix obfuscation (after preprocessing has evaluated function calls)
        if (Object.keys(tMap).length > 0) {
          const tChanged = replaceTMatrix(ast, tMap, tName, logger, result);
          changed = tChanged || changed;
        }
        
        // Simplify conditionals
        const condChanged = simplifyConditionals(ast, logger, result);
        changed = condChanged || changed;
        
        // Simplify expressions
        const exprChanged = simplifyExpressions(ast, logger, result);
        changed = exprChanged || changed;
        
        // Simplify if statements
        const ifChanged = simplifyIfStatements(ast, logger, result);
        changed = ifChanged || changed;

        // Fold opaque predicates (MBA-style bitwise arithmetic that collapses
        // to a constant regardless of its variables). Runs after simplifyExpressions
        // so genuine constant subexpressions are already folded.
        const opaqueChanged = foldOpaquePredicates(ast, logger, result);
        changed = opaqueChanged || changed;
        
        
      } catch (err) {
        const error = createError(
          ErrorCodes.TRANSFORMATION_ERROR,
          `Error during pass ${passCount}`,
          { pass: passCount, error: err.message, stack: err.stack }
        );
        result.addError(error);
        logger.error(`Pass ${passCount} failed`, error);
        
        // Continue with next pass instead of aborting
        if (logger) logger.warn(`Continuing with next pass after error`);
      }
    }

    // Remove switch-case state machines.
    // Babel's traverse can skip sibling nodes when we call replaceWithMultiple,
    // so a single sweep sometimes leaves nested state machines behind. Loop
    // until no more changes — bounded at 5 passes for safety.
    let switchChanged = false;
    for (let sw = 0; sw < 5; sw++) {
      const c = removeSwitchCaseStateMachines(ast, logger, result);
      if (!c) break;
      switchChanged = true;
    }
    changed = switchChanged || changed;

    result.stats.passes = passCount;
    logger.info(`Completed ${passCount} transformation passes`);
    // Remove unused variables (runs in its own loop). This can strip red-herring
    // for-init declarations (`for (var eA = 544; true;)`) and expose state
    // machines the unflattener couldn't see on the first pass.
    try {
      logger.info('Removing unused variables...');
      const varsChanged = removeUnusedVariables(ast, logger, result);
      logger.info('Unused variable removal completed', { changed: varsChanged });
    } catch (err) {
      const error = createError(
        ErrorCodes.TRANSFORMATION_ERROR,
        'Error during unused variable removal',
        { error: err.message, stack: err.stack }
      );
      result.addError(error);
      logger.error('Unused variable removal failed', error);
    }

    // Second unflatten pass — after removeUnusedVariables the for-init decoys
    // are gone, so state machines the first pass couldn't see are now visible.
    for (let sw = 0; sw < 5; sw++) {
      const c = removeSwitchCaseStateMachines(ast, logger, result);
      if (!c) break;
    }
    
    logger.info('Deobfuscation process completed', {
      success: result.success,
      errors: result.errors.length,
      warnings: result.warnings.length
    });
    
  } catch (err) {
    const error = createError(
      ErrorCodes.UNKNOWN_ERROR,
      'Unexpected error during deobfuscation',
      { error: err.message, stack: err.stack }
    );
    result.addError(error);
    logger.error('Fatal error during deobfuscation', error);
  }
  result.ast = ast;
  return result;
}

/**
 * Generate t[x][y] mapping from source code using AST traversal
 */
function generateTMap(sourceCode, tMapPath = './t-map.json', logger = null) {
  const result = { tMap: {}, errors: [], tName: null };
  
  try {
    
    // Parse source code to AST
    let ast;
    try {
      ast = typeof sourceCode === 'string' ? parser.parse(sourceCode, {
        sourceType: 'script',
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      }) : sourceCode;
    } catch (err) {
      const error = createError(ErrorCodes.PARSE_ERROR, 'Failed to parse source code for t-map generation', {
        error: err.message,
        stack: err.stack
      });
      result.errors.push(error);
      if (logger) logger.error('AST parsing failed', error);
      return result;
    }
    
    // Find At function and t array using AST traversal
    let atFunction = null;
    let tArrayDeclaration = null;
    let atFunctionName = null;
    let tVariableName = null;
    let referencedFunctionName = null;
    
    // First pass: Find the t array and identify which function it references
    traverse(ast, {
      VariableDeclarator(path) {
        if (
          t.isCallExpression(path.node.init) &&
          t.isFunctionExpression(path.node.init.callee)
        ) {
            let lastBodyElement = path.node.init.callee.body.body[path.node.init.callee.body.body.length - 1];
            if (
              t.isReturnStatement(lastBodyElement) &&
              t.isMemberExpression(lastBodyElement.argument)
            ) {
              tVariableName = path.node.id ? path.node.id.name : null;
              result.tName = tVariableName;
              logger.info(`Found matrix array: ${tVariableName || 'anonymous'}`);
              tArrayDeclaration = path.node;
              traverse(path.node.init.callee.body, {
                CallExpression(callPath) {
                  if (t.isIdentifier(callPath.node.callee)) {
                    atFunctionName = callPath.node.callee.name;
                    logger.info(`Found function reference in matrix array: ${atFunctionName}`);
                  }
                }
              }, path.scope);
              if (!atFunctionName) {
                atFunctionName = "not_required";
              }
              
          }
        }
      }
    });
    
    // Second pass: Find the function that matches the referenced name
    // The At function typically has 7-8 parameters, not 3
    if (atFunctionName && atFunctionName !== "not_required") {
      traverse(ast, {
        FunctionDeclaration(path) {
          const funcName = path.node.id ? path.node.id.name : null;
          const paramCount = path.node.params ? path.node.params.length : 0;
          
          // If we found a referenced function name, find that exact function
          if (atFunctionName && funcName === atFunctionName) {
            atFunction = path.node;
            atFunctionName = funcName;
            path.stop(); // Stop traversal once we find the matching function
          } 
        }
      });
    }
    if (!atFunction && atFunctionName !== "not_required") {
      const error = createError(ErrorCodes.VM_ERROR, 'Could not find maxtrix-array-function function in source code', {
        atFunctionName: atFunctionName || 'unknown'
      });
      result.errors.push(error);
      logger.error('t-map generation skipped: required functions not found', error);
      return result;
    }
    
    try {
      // Generate code for both functions
      // For function declaration, we need to ensure it's properly scoped
      let atFunctionCode = atFunction ? generate(atFunction).code : "";
      
      // Extract just the IIFE expression from the t array declaration, not the variable declaration
      // This avoids conflicts with const/let declarations
      let tArrayCode;
      if (t.isCallExpression(tArrayDeclaration.init)) {
        // Generate just the call expression (the IIFE)
        tArrayCode = generate(tArrayDeclaration.init).code;
        // Wrap it in a variable assignment using the variable name we found
        tArrayCode = `var ${tVariableName} = ${tArrayCode};`;
      } else {
        // Fallback: generate the full declaration
        tArrayCode = generate(tArrayDeclaration).code;
      }
      
      if (logger) logger.debug('Generating t-map from extracted functions', {
        atFunctionName: atFunctionName || 'anonymous',
        tVariableName: tVariableName || 'anonymous',
        referencedFunctionName: referencedFunctionName || 'none'
      });
      
      const context = vm.createContext({});
      
      // Execute function declaration first (if it's a function declaration)
      if (atFunction && t.isFunctionDeclaration(atFunction)) {
        vm.runInContext(atFunctionCode, context);
      } else if (atFunctionName !== "not_required") {
        // If it's a function expression, we need to assign it
        atFunctionCode = `var ${atFunctionName} = ${atFunctionCode}`;
        vm.runInContext(atFunctionCode, context);
      }
      
      // Replace function name references in t array code if they don't match
      // The t array code might call a different name (like 'At') but we found a function with a different name
      if (referencedFunctionName && referencedFunctionName !== atFunctionName) {
        // Replace the function name in the t array code
        tArrayCode = tArrayCode.replace(
          new RegExp(`\\b${referencedFunctionName}\\b`, 'g'),
          atFunctionName
        );
        if (logger) logger.debug(`Replaced function name ${referencedFunctionName} with ${atFunctionName} in t array code`);
      }
      
      // Now execute the t array code (which may reference the function)
      vm.runInContext(tArrayCode, context);
      
      // Find the t variable in context (it might have a different name)
      let tArray = null;
      if (tVariableName && context[tVariableName]) {
        tArray = context[tVariableName];
      } else {
        // Try to find any array variable in context
        for (const key in context) {
          if (Array.isArray(context[key])) {
            tArray = context[key];
            if (logger) logger.debug(`Found t array in context as: ${key}`);
            break;
          }
        }
      }
      
      if (tArray && Array.isArray(tArray)) {
        const arrayToIndex = new Map();
        let stateCounter = 0;
        
        tArray.forEach((row, x) => {
          if (!Array.isArray(row)) return;
          row.forEach((cell, y) => {
            if (Array.isArray(cell)) {
              if (!arrayToIndex.has(cell)) {
                arrayToIndex.set(cell, stateCounter++);
              }
              result.tMap[`${result.tName}[${x}][${y}]`] = arrayToIndex.get(cell);
            }
          });
        });
        
        if (logger) logger.info(`Generated t-map with ${Object.keys(result.tMap).length} entries`, {
          atFunctionName: atFunctionName || 'anonymous',
          tVariableName: tVariableName || 'anonymous'
        });
        
      } else {
        const error = createError(ErrorCodes.VM_ERROR, 't array is not a valid array after execution', {
          tVariableName: tVariableName || 'unknown',
          foundInContext: Object.keys(context).join(', '),
          type: typeof tArray
        });
        result.errors.push(error);
        if (logger) logger.error('Invalid t array structure', error);
      }
    } catch (err) {
      const error = createError(ErrorCodes.VM_ERROR, 'Error executing t-map generation code', {
        error: err.message,
        stack: err.stack,
        atFunctionName: atFunctionName || 'unknown',
        tVariableName: tVariableName || 'unknown'
      });
      result.errors.push(error);
      if (logger) logger.error('VM execution failed', error);
    }
  } catch (err) {
    const error = createError(ErrorCodes.UNKNOWN_ERROR, 'Unexpected error in generateTMap', {
      error: err.message,
      stack: err.stack
    });
    result.errors.push(error);
    if (logger) logger.error('Unexpected error', error);
  }

  return result;
}

module.exports = {
  // Main functions
  deobfuscate,
  generateTMap,
  
  // Classes and utilities
  Logger,
  LogLevel,
  DeobfuscationResult,
  ErrorCodes,
  createError,
  
  // Preprocessing passes
  simplifyBinaryExpressions,
  cleanBinaryAndMemberExpressions,
  cleanStrings,
  decodeHexStringsInAst,
  scorporateCaptchaModules,
  cleanDoubleBracketProps,

  // Transformation passes
  replaceTMatrix,
  simplifyConditionals,
  simplifyExpressions,
  simplifyIfStatements,
  removeSwitchCaseStateMachines,
  removeUnusedVariables,
  
  // Postprocessing
  extractModules,
  uncomputeMemberExpressions,
  DEFAULT_LEGENDA
};


