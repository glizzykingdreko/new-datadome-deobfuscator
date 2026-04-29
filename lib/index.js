/**
 * Public Node.js API for the DataDome captcha/interstitial deobfuscator.
 *
 *   const { deobfuscate } = require('datadome-deobfuscator');
 *   const result = deobfuscate(sourceCode);
 *   // result.modules['captcha']  → deobfuscated module source
 *   // result.bundleType          → 'captcha' | 'interstitial'
 *   // result.dynamic_challenge   → string | null
 *   // result.wasm                → { wasm, instance, helpers, ... } | null
 *   // result.report              → structured report object
 */

const parser = require('@babel/parser');
const generate = require('@babel/generator').default;

const { Logger, LogLevel } = require('../transformers/logger');
const { createError, ErrorCodes, DeobfuscationResult } = require('../transformers/errors');
const {
  deobfuscate: runDeobfuscatePasses,
  generateTMap,
  uncomputeMemberExpressions,
  cleanDoubleBracketProps,
  scorporateCaptchaModules,
  decodeHexStringsInAst
} = require('../transformers');
const { removeSwitchCaseStateMachines, removeUnusedVariables } = require('../transformers/transformations');
const {
  buildBundleSandbox,
  resolveDecoderCalls,
  foldSafeCalls,
  inlineConstIdentifiers,
  foldTableLookups,
  simplifyConstLogicalExprs,
  removeDeadTableInits,
  removeDeadWriteOnlyBindings,
  normalizeBracketAccess
} = require('../transformers/bundleSandbox');
const { extractDynamicChallenge } = require('../transformers/extractDynamicChallenge');
const { extractWasm } = require('../transformers/extractWasm');
const { extractWasmChallengeFields } = require('../transformers/extractWasmChallengeFields');

function detectBundleType(legendaKeys) {
  if (legendaKeys.includes('captcha')) return 'captcha';
  if (legendaKeys.includes('interstitial')) return 'interstitial';
  return 'unknown';
}

/**
 * Deobfuscate a DataDome captcha or interstitial bundle.
 *
 * @param {string} source — raw obfuscated source code.
 * @param {object} [options]
 * @param {string} [options.logLevel='INFO'] — DEBUG | INFO | WARN | ERROR | NONE.
 * @param {Logger} [options.logger] — bring your own logger (overrides logLevel).
 * @param {number} [options.maxPasses=10] — iterative deobfuscation cap.
 * @param {object} [options.generatorOptions] — passed to @babel/generator.
 * @returns {{
 *   bundleType: 'captcha'|'interstitial'|'unknown',
 *   modules: Record<string, string>,
 *   moduleOrder: string[],
 *   stats: { original: number, deobfuscated: number, reduction: number, reductionPercent: string },
 *   dynamic_challenge: string|null,
 *   wasm: object|null,
 *   warnings: any[],
 *   errors: any[],
 *   report: object,
 * }}
 */
function deobfuscate(source, options = {}) {
  const {
    logLevel = 'INFO',
    logger: providedLogger = null,
    maxPasses = 10,
    generatorOptions = null,
  } = options;

  const logger = providedLogger || new Logger(LogLevel[logLevel] || LogLevel.INFO, 'Deobfuscator');
  const result = new DeobfuscationResult();

  const report = {
    tool: 'datadome-deobfuscator',
    timestamp: new Date().toISOString(),
    status: 'success',
    bundleType: 'unknown',
    counts: { modulesTotal: 0, modulesProcessed: 0, errors: 0, warnings: 0 },
    stats: { original: source.length, deobfuscated: 0, reduction: 0, reductionPercent: '0.00%' },
    modules: [],
    dynamic_challenge: null,
    wasm: null,
    errors: [],
    warnings: [],
  };

  if (typeof source !== 'string' || source.length === 0) {
    const err = createError(ErrorCodes.VALIDATION_ERROR, 'source must be a non-empty string', {});
    report.errors.push(err);
    report.status = 'error';
    return finalize({ legendaCode: {}, moduleOrder: [], dynamic_challenge: null, wasm: null }, report, result);
  }

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (err) {
    const error = createError(ErrorCodes.PARSE_ERROR, 'Failed to parse source code', { error: err.message });
    report.errors.push(error);
    report.status = 'error';
    return finalize({ legendaCode: {}, moduleOrder: [], dynamic_challenge: null, wasm: null }, report, result);
  }

  try {
    ast = decodeHexStringsInAst(ast, logger);
    ast = cleanDoubleBracketProps(ast, logger);
  } catch (err) {
    const error = createError(ErrorCodes.TRANSFORMATION_ERROR, 'Failed to clear hex strings', { error: err.message });
    report.warnings.push(error);
  }

  let astLegenda;
  try {
    astLegenda = scorporateCaptchaModules(ast, logger);
  } catch (err) {
    const error = createError(ErrorCodes.TRANSFORMATION_ERROR, 'Failed to separate modules', { error: err.message });
    report.errors.push(error);
    report.status = 'error';
    return finalize({ legendaCode: {}, moduleOrder: [], dynamic_challenge: null, wasm: null }, report, result);
  }

  const moduleOrder = Object.keys(astLegenda);
  report.counts.modulesTotal = moduleOrder.length;
  report.bundleType = detectBundleType(moduleOrder);

  const newLegenda = {};
  let topDynamicChallenge = null;
  let topWasm = null;

  for (const [name, moduleAst] of Object.entries(astLegenda)) {
    const moduleEntry = { name, status: 'ok', errors: [], warnings: [] };
    try {
      if (name === 'captcha' || name === 'interstitial') {
        const tMapResult = generateTMap(moduleAst, null, logger);
        for (const e of tMapResult.errors) {
          moduleEntry.warnings.push(e);
          report.warnings.push(e);
        }

        let earlyDynamicChallenge = null;
        let bundle = null;
        try {
          bundle = buildBundleSandbox(moduleAst, logger);
          if (bundle) {
            resolveDecoderCalls(moduleAst, bundle);
            normalizeBracketAccess(moduleAst);
            try {
              const dc = extractDynamicChallenge(moduleAst, logger, bundle);
              if (dc) earlyDynamicChallenge = dc;
            } catch (e) {
              logger.warn(`extractDynamicChallenge (pre-fold) failed for ${name}`, { error: e.message });
            }
            foldSafeCalls(moduleAst, bundle);
            foldTableLookups(moduleAst, bundle);
            inlineConstIdentifiers(moduleAst);
          }
        } catch (err) {
          logger.warn(`[${name}] bundle-sandbox warning (continuing)`, { error: err.message });
        }

        const deobResult = runDeobfuscatePasses(moduleAst, {
          tMap: tMapResult.tMap,
          tName: tMapResult.tName,
          maxPasses,
          logger,
          logLevel,
        });
        moduleEntry.errors.push(...deobResult.errors);
        moduleEntry.warnings.push(...deobResult.warnings);
        report.errors.push(...deobResult.errors);
        report.warnings.push(...deobResult.warnings);
        if (!deobResult.success) moduleEntry.status = 'errors';
        newLegenda[name] = deobResult.ast;

        if (bundle) {
          try {
            resolveDecoderCalls(newLegenda[name], bundle);
            normalizeBracketAccess(newLegenda[name]);
            foldSafeCalls(newLegenda[name], bundle);
            foldTableLookups(newLegenda[name], bundle);
            inlineConstIdentifiers(newLegenda[name]);
            for (let i = 0; i < 5; i++) {
              const c = removeSwitchCaseStateMachines(newLegenda[name], logger, result);
              if (!c) break;
            }
            removeUnusedVariables(newLegenda[name], logger, result);
            inlineConstIdentifiers(newLegenda[name]);
            removeDeadTableInits(newLegenda[name]);
            removeDeadWriteOnlyBindings(newLegenda[name]);
            simplifyConstLogicalExprs(newLegenda[name]);
            removeUnusedVariables(newLegenda[name], logger, result);
            removeDeadWriteOnlyBindings(newLegenda[name]);
          } catch (err) {
            logger.warn(`[${name}] post-deob sandbox warning (continuing)`, { error: err.message });
          }
        }

        try {
          let dc = earlyDynamicChallenge;
          if (!dc) dc = extractDynamicChallenge(newLegenda[name], logger);
          if (dc) {
            moduleEntry.dynamic_challenge = dc.expression;
            if (!topDynamicChallenge) topDynamicChallenge = dc.expression;
          }
        } catch (err) {
          logger.warn(`extractDynamicChallenge failed for ${name}`, { error: err.message });
        }

        try {
          const windowAliases = (bundle && bundle.windowAliases) || new Set();
          const wasmInfo = extractWasm(newLegenda[name], windowAliases, logger);
          if (wasmInfo) {
            moduleEntry.wasm = wasmInfo;
            if (!topWasm) topWasm = wasmInfo;
          }
        } catch (err) {
          logger.warn(`extractWasm failed for ${name}`, { error: err.message });
        }

        try {
          const wcf = extractWasmChallengeFields(newLegenda[name], logger);
          if (wcf && moduleEntry.wasm) {
            moduleEntry.wasm.fields = wcf;
          } else if (wcf) {
            moduleEntry.wasm = { fields: wcf };
            if (!topWasm) topWasm = moduleEntry.wasm;
          }
        } catch (err) {
          logger.warn(`extractWasmChallengeFields failed for ${name}`, { error: err.message });
        }
      } else {
        newLegenda[name] = uncomputeMemberExpressions(moduleAst);
      }
      report.counts.modulesProcessed++;
    } catch (err) {
      const error = createError(ErrorCodes.TRANSFORMATION_ERROR, `Failed to process module ${name}`, { error: err.message });
      moduleEntry.errors.push(error);
      moduleEntry.status = 'failed';
      report.errors.push(error);
      logger.error(`Failed to process module ${name}`, error);
    }
    report.modules.push(moduleEntry);
  }

  const legendaCode = {};
  let totalOutputSize = 0;
  const genOpts = generatorOptions || {
    retainLines: false,
    compact: false,
    comments: false,
    jsescOption: { quotes: 'single', wrap: true },
    shouldPrintComment: () => false,
  };
  for (const [name, moduleAst] of Object.entries(newLegenda)) {
    const outName = (!name || name === 'undefined') ? 'main' : name;
    try {
      const out = generate(moduleAst, genOpts, source);
      const cleanedCode = out.code.replace(/\n{3,}/g, '\n\n');
      legendaCode[outName] = cleanedCode;
      totalOutputSize += cleanedCode.length;
      const me = report.modules.find((m) => m.name === name);
      if (me) me.output = { name: outName, size: cleanedCode.length };
    } catch (err) {
      const error = createError(ErrorCodes.TRANSFORMATION_ERROR, `Failed to generate code for module ${outName}`, { error: err.message });
      report.errors.push(error);
      logger.error(`Code generation failed for module ${outName}`, error);
    }
  }

  report.dynamic_challenge = topDynamicChallenge;
  report.wasm = topWasm;
  report.stats.deobfuscated = totalOutputSize;
  report.stats.reduction = report.stats.original - totalOutputSize;
  report.stats.reductionPercent = report.stats.original > 0
    ? ((report.stats.reduction / report.stats.original) * 100).toFixed(2) + '%'
    : '0.00%';
  report.counts.errors = report.errors.length;
  report.counts.warnings = report.warnings.length;
  if (report.errors.length > 0 && report.status === 'success') report.status = 'partial';

  return finalize({ legendaCode, moduleOrder: Object.keys(legendaCode), dynamic_challenge: topDynamicChallenge, wasm: topWasm }, report, result);
}

function finalize({ legendaCode, moduleOrder, dynamic_challenge, wasm }, report, result) {
  return {
    bundleType: report.bundleType,
    modules: legendaCode,
    moduleOrder,
    stats: report.stats,
    dynamic_challenge: dynamic_challenge || null,
    wasm: wasm || null,
    warnings: report.warnings,
    errors: report.errors,
    report,
    _result: result,
  };
}

module.exports = {
  deobfuscate,
  Logger,
  LogLevel,
  ErrorCodes,
};
