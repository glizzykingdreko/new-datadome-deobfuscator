/**
 * Postprocessing: Extract and split modules from deobfuscated code
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const { createError, ErrorCodes } = require('../errors');

/**
 * Default module legend/mapping
 */
const DEFAULT_LEGENDA = {
  183: "reloader",
  462: "signals",
  804: "obfuscate",
  152: "helpers",
  701: "localstorage",
  872: "vm-obf",
};

const LEGENDA_ORDER = [
  "reloader", "signals", "obfuscate", "helpers", "localstorage", "vm-obf"
]

/**
 * Extract modules from deobfuscated AST and split into separate files
 * 
 * @param {Object} ast - The deobfuscated AST
 * @param {Object} options - Configuration options
 * @param {Object} options.legenda - Module ID to name mapping (default: DEFAULT_LEGENDA)
 * @param {string} options.outputDir - Output directory for extracted modules (default: './test')
 * @param {Logger} options.logger - Logger instance (optional)
 * @param {DeobfuscationResult} options.result - Result object for error tracking (optional)
 * @returns {Object} - Object with modules map and extraction stats
 */
function extractModules(ast, options = {}) {
  const {
    outputDir = './test',
    logger = null,
    result = null
  } = options;

  const extractionResult = {
    modules: {},
    stats: {
      modulesExtracted: 0,
      modulesRenamed: 0,
      newModules: 0,
      missingModules: [],
      duplicates: [],
      filesWritten: 0
    },
    warnings: []
  };

  try {
    if (logger) logger.info('Starting module extraction...');

    // Validate AST structure
    if (!ast || !ast.program || !ast.program.body || ast.program.body.length < 2) {
      const error = createError(
        ErrorCodes.VALIDATION_ERROR,
        'Invalid AST structure: expected at least 2 body elements',
        { bodyLength: ast?.program?.body?.length || 0 }
      );
      if (logger) logger.error('AST validation failed', error);
      if (result) result.addError(error);
      throw error;
    }

    const content = ast.program.body[1];
    if (!content || !content.expression || !content.expression.callee || 
        !content.expression.callee.body || !content.expression.callee.body.body) {
      const error = createError(
        ErrorCodes.VALIDATION_ERROR,
        'Invalid AST structure: expected expression with callee body',
        { hasExpression: !!content?.expression }
      );
      if (logger) logger.error('AST structure validation failed', error);
      if (result) result.addError(error);
      throw error;
    }

    for (let node of content.expression.callee.body.body) {
      if (t.isVariableDeclaration(node)) {
        for (let declaration of node.declarations) {
          if (
            t.isIdentifier(declaration.id) &&
            t.isObjectExpression(declaration.init) &&
            declaration.init.properties.length >= 3 &&
            declaration.init.properties.every(property => t.isLiteral(property.key))
          ) {
            moduleVariable = declaration;
            break;
          }
        }
      } 
    }

    const bodyContent = content.expression.callee.body.body;

    if (!moduleVariable) {
      const error = createError(
        ErrorCodes.VALIDATION_ERROR,
        'Module object not found: expected ObjectExpression with at least 3 literal properties',
        { variablesCount: variables.length }
      );
      if (logger) logger.error('Module extraction failed', error);
      if (result) result.addError(error);
      throw error;
    }

    if (logger) logger.debug(`Found module object with ${moduleVariable.init.properties.length} properties`);

    // Ensure output directory exists
    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        if (logger) logger.debug(`Created output directory: ${outputDir}`);
      }
    } catch (err) {
      const error = createError(
        ErrorCodes.FILE_ERROR,
        'Failed to create output directory',
        { path: outputDir, error: err.message }
      );
      if (logger) logger.error('Directory creation failed', error);
      if (result) result.addError(error);
      throw error;
    }


    let lastexpression = bodyContent[bodyContent.length - 1].block.body[0];

    let legendaMatched = new Set();
    let legenda = {};
    for (let declaration of lastexpression.declarations) {
      if (
        t.isIdentifier(declaration.id) && 
        (
          (
            t.isCallExpression(declaration.init) && 
            t.isCallExpression(declaration.init.callee) &&
            t.isIdentifier(declaration.init.callee.callee) &&
            1 === declaration.init.callee.arguments.length &&
            (
              t.isLiteral(declaration.init.callee.arguments[0]) ||
              t.isNumericLiteral(declaration.init.callee.arguments[0])
            )
          ) ||
          (
            t.isCallExpression(declaration.init) &&
            t.isIdentifier(declaration.init.callee) &&
            1 === declaration.init.arguments.length &&
            (
              t.isLiteral(declaration.init.arguments[0]) ||
              t.isNumericLiteral(declaration.init.arguments[0])
            )
          )  ||
          (
            t.isMemberExpression(declaration.init) &&
            t.isCallExpression(declaration.init.object) &&
            t.isIdentifier(declaration.init.property) &&
            1 === declaration.init.object.arguments.length &&
            (
              t.isLiteral(declaration.init.object.arguments[0]) ||
              t.isNumericLiteral(declaration.init.object.arguments[0])
            )
          ) 
        )
      ) {
        let num;
        if (t.isMemberExpression(declaration.init)) {
          num = declaration.init.object.arguments[0].value;
        } else if (t.isCallExpression(declaration.init)) {
          if (declaration.init.callee && t.isCallExpression(declaration.init.callee)) {
            num = declaration.init.callee.arguments[0].value;
          } else {
            num = declaration.init.arguments[0].value;
          }
        }
        // check if already in set
        if (legendaMatched.has(num)) {
          continue;
        }
        legendaMatched.add(num);
        legenda[num] = LEGENDA_ORDER[legendaMatched.size - 1];
      }
    }

    for (let property of moduleVariable.init.properties) {
      try {
        const originalKey = property.key.value;
        const value = property.value;
        let moduleName = null;
        logger.info(`Processing module: ${originalKey}`);

        // Determine module name from legenda or use default
        if (!(originalKey in legenda)) {
          moduleName = `new_${originalKey}`;
          extractionResult.stats.newModules++;
          if (logger) logger.warn(`New module detected: ${originalKey} -> ${moduleName}`);
          extractionResult.warnings.push({
            type: 'NEW_MODULE',
            originalKey,
            moduleName,
            message: `New module detected: ${originalKey} -> ${moduleName}`
          });
        } else {
          moduleName = legenda[originalKey];
          extractionResult.stats.modulesRenamed++;
        }

        extractionResult.modules[originalKey] = moduleName;
        extractionResult.stats.modulesExtracted++;

        // Generate code for the module
        let moduleCode;
        try {
          if (!t.isFunctionExpression(value) && !t.isArrowFunctionExpression(value)) {
            throw new Error('Module value is not a function expression');
          }
          moduleCode = generate(value.body).code;
          
          // Remove outer braces and adjust indentation
          const firstBrace = moduleCode.indexOf('{');
          const lastBrace = moduleCode.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            moduleCode = moduleCode.slice(firstBrace + 1, lastBrace);
            // Remove one level of indentation (assuming 1 space)
            moduleCode = moduleCode.replace(/^ {1}/gm, '');
          }
        } catch (err) {
          const error = createError(
            ErrorCodes.TRANSFORMATION_ERROR,
            `Failed to generate code for module ${moduleName}`,
            { originalKey, moduleName, error: err.message }
          );
          if (logger) logger.error(`Code generation failed for module ${moduleName}`, error);
          if (result) result.addWarning(error);
          extractionResult.warnings.push({
            type: 'CODE_GENERATION_ERROR',
            moduleName,
            error: err.message
          });
          continue;
        }

        // Write module file
        const outputPath = path.join(outputDir, `${moduleName}.js`);
        try {
          fs.writeFileSync(outputPath, moduleCode, 'utf8');
          extractionResult.stats.filesWritten++;
          if (logger) logger.debug(`Extracted module: ${moduleName} -> ${outputPath}`);
        } catch (err) {
          const error = createError(
            ErrorCodes.FILE_ERROR,
            `Failed to write module file: ${moduleName}`,
            { path: outputPath, error: err.message }
          );
          if (logger) logger.error(`File write failed for ${moduleName}`, error);
          if (result) result.addWarning(error);
          extractionResult.warnings.push({
            type: 'FILE_WRITE_ERROR',
            moduleName,
            path: outputPath,
            error: err.message
          });
        }
      } catch (err) {
        const error = createError(
          ErrorCodes.TRANSFORMATION_ERROR,
          `Error processing module property`,
          { error: err.message, stack: err.stack }
        );
        if (logger) logger.error('Module property processing failed', error);
        if (result) result.addWarning(error);
        extractionResult.warnings.push({
          type: 'PROCESSING_ERROR',
          error: err.message
        });
      }
    }

    // Validate module mapping
    const legendaKeys = Object.values(legenda);
    const matchedKeys = Object.values(extractionResult.modules);
    const matchedNumbers = Object.keys(extractionResult.modules).map(Number);

    // Check for missing keys from legenda
    for (let key of legendaKeys) {
      if (!matchedKeys.includes(key)) {
        extractionResult.stats.missingModules.push(key);
        if (logger) logger.warn(`Missing module from legenda: ${key}`);
        extractionResult.warnings.push({
          type: 'MISSING_MODULE',
          moduleName: key,
          message: `Module ${key} is in legenda but not found in extracted modules`
        });
      }
    }

    // Check for duplicates
    const seen = new Set();
    for (let m of matchedKeys) {
      if (seen.has(m)) {
        extractionResult.stats.duplicates.push(m);
        if (logger) logger.warn(`Duplicate module name: ${m}`);
        extractionResult.warnings.push({
          type: 'DUPLICATE_MODULE',
          moduleName: m,
          message: `Duplicate module name detected: ${m}`
        });
      }
      seen.add(m);
    }

    // Process main module (last element of content)
    if (bodyContent.length === 0) {
      const error = createError(
        ErrorCodes.VALIDATION_ERROR,
        'No content found for main module extraction',
        {}
      );
      if (logger) logger.error('Main module extraction failed', error);
      if (result) result.addWarning(error);
      extractionResult.warnings.push({
        type: 'MAIN_MODULE_ERROR',
        error: 'No content found'
      });
    } else {
      try {
        const mainModule = bodyContent[bodyContent.length - 1];
        let mainModuleCode = generate(mainModule).code;
        
        // Parse main module to transform require calls
        let mainModuleAst;
        try {
          mainModuleAst = parser.parse(mainModuleCode, { 
            sourceType: 'script',
            allowReturnOutsideFunction: true
          });
        } catch (err) {
          const error = createError(
            ErrorCodes.PARSE_ERROR,
            'Failed to parse main module',
            { error: err.message }
          );
          if (logger) logger.error('Main module parsing failed', error);
          if (result) result.addWarning(error);
          extractionResult.warnings.push({
            type: 'PARSE_ERROR',
            error: err.message
          });
          throw error;
        }

        // Replace numeric module references with require() calls
        let replacements = 0;
        traverse(mainModuleAst, {
          CallExpression(path) {
            if (
              path.node.arguments.length === 1 &&
              t.isNumericLiteral(path.node.arguments[0]) &&
              matchedNumbers.includes(path.node.arguments[0].value)
            ) {
              const moduleId = path.node.arguments[0].value;
              const moduleName = extractionResult.modules[moduleId];
              
              if (moduleName) {
                path.replaceWith(
                  t.callExpression(
                    t.identifier("require"),
                    [t.stringLiteral(`./${moduleName}.js`)]
                  )
                );
                replacements++;
              }
            }
          }
        });

        if (logger) logger.debug(`Replaced ${replacements} module references in main module`);

        // Generate final main module code
        mainModuleCode = generate(mainModuleAst, {
          retainLines: false,
          compact: false,
          comments: false
        }).code;

        // Write main module file
        const mainModulePath = path.join(outputDir, 'main.js');
        try {
          fs.writeFileSync(mainModulePath, mainModuleCode, 'utf8');
          extractionResult.stats.filesWritten++;
          if (logger) logger.info(`Main module written: ${mainModulePath}`);
        } catch (err) {
          const error = createError(
            ErrorCodes.FILE_ERROR,
            'Failed to write main module file',
            { path: mainModulePath, error: err.message }
          );
          if (logger) logger.error('Main module file write failed', error);
          if (result) result.addWarning(error);
          extractionResult.warnings.push({
            type: 'FILE_WRITE_ERROR',
            moduleName: 'main',
            path: mainModulePath,
            error: err.message
          });
        }
      } catch (err) {
        // Provide detailed context about main module processing failure
        const context = {
          error: err.message,
          stack: err.stack,
          bodyContentLength: bodyContent.length,
          mainModuleType: bodyContent[bodyContent.length - 1]?.type || 'unknown',
          modulesExtracted: extractionResult.stats.modulesExtracted,
          matchedNumbers: matchedNumbers.length,
          hasModules: Object.keys(extractionResult.modules).length > 0
        };
        
        const error = createError(
          ErrorCodes.POSTPROCESSING_ERROR,
          'Main module processing failed',
          context
        );
        if (logger) logger.error('Main module processing failed', error);
        if (result) result.addWarning(error);
        extractionResult.warnings.push({
          type: 'MAIN_MODULE_PROCESSING_ERROR',
          ...context
        });
      }
    }

    if (logger) {
      logger.info('Module extraction completed', {
        modulesExtracted: extractionResult.stats.modulesExtracted,
        filesWritten: extractionResult.stats.filesWritten,
        newModules: extractionResult.stats.newModules,
        missingModules: extractionResult.stats.missingModules.length,
        duplicates: extractionResult.stats.duplicates.length
      });
    }

    // Add warnings to result object if provided
    if (result) {
      extractionResult.warnings.forEach(warning => {
        if (warning.type === 'NEW_MODULE') {
          result.addWarning(`New module detected: ${warning.originalKey} -> ${warning.moduleName}`, {
            originalKey: warning.originalKey,
            moduleName: warning.moduleName
          });
        } else if (warning.type === 'MISSING_MODULE') {
          result.addWarning(`Missing module from legenda: ${warning.moduleName}`, {
            moduleName: warning.moduleName
          });
        } else if (warning.type === 'DUPLICATE_MODULE') {
          result.addWarning(`Duplicate module name: ${warning.moduleName}`, {
            moduleName: warning.moduleName
          });
        } else {
          result.addWarning(warning.message || warning.error, warning);
        }
      });
    }

  } catch (err) {
    throw err;
    // Provide detailed context about what was being processed when the error occurred
    const context = {
      error: err.message,
      stack: err.stack,
      modulesExtracted: extractionResult.stats.modulesExtracted,
      filesWritten: extractionResult.stats.filesWritten,
      modulesFound: Object.keys(extractionResult.modules).length,
      outputDir: outputDir,
      legendaSize: Object.keys(legenda).length,
      astStructure: {
        hasProgram: !!ast?.program,
        hasBody: !!ast?.program?.body,
        bodyLength: ast?.program?.body?.length || 0,
        hasSecondElement: !!(ast?.program?.body && ast.program.body.length > 1),
        secondElementType: ast?.program?.body?.[1]?.type || 'unknown'
      }
    };
    
    // Try to get more specific error context
    if (ast?.program?.body && ast.program.body.length > 1) {
      const secondBody = ast.program.body[1];
      if (secondBody?.expression?.callee?.body?.body) {
        context.bodyContentLength = secondBody.expression.callee.body.body.length;
        context.bodyContentTypes = secondBody.expression.callee.body.body
          .slice(0, 5)
          .map(node => node?.type || 'unknown');
      }
    }
    
    const error = createError(
      ErrorCodes.UNKNOWN_ERROR,
      'Unexpected error during module extraction',
      context
    );
    if (logger) logger.error('Module extraction failed', error);
    if (result) result.addError(error);
    throw error;
  }

  return extractionResult;
}

module.exports = {
  extractModules,
  DEFAULT_LEGENDA
};

