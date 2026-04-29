/**
 * Transformation passes for deobfuscation
 */

const { replaceTMatrix } = require('./t-matrix');
const { simplifyConditionals } = require('./conditionals');
const { simplifyExpressions } = require('./expressions');
const { simplifyIfStatements } = require('./if-statements');
const { removeSwitchCaseStateMachines } = require('./switch-case');
const { removeUnusedVariables } = require('./unused-vars');
const { foldOpaquePredicates } = require('./opaque-predicates');
const { inlineSetTimeoutZero } = require('./inline-settimeout');

module.exports = {
  replaceTMatrix,
  simplifyConditionals,
  simplifyExpressions,
  simplifyIfStatements,
  removeSwitchCaseStateMachines,
  removeUnusedVariables,
  foldOpaquePredicates,
  inlineSetTimeoutZero
};


