const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

// A signal emit is `A(<name>, value [, value])` where `A` is the bundle's
// emit function. We have to recognise both the resolved form
// (`A('XnbZeN', s)`) AND the unresolved form (`A(D(97), c[w(18)])`) because
// if-statement simplification runs while decoder calls are still in flight
// — and matrix-resolved equalities like `f[w(847)][w(380)] == f[…][…]`
// can fold to a constant boolean before the inner branch's `A(…)` calls
// have their first argument resolved. If we only matched the resolved
// form, the guard would miss exactly the case it was added to catch.
//
// Detection rule: any CallExpression whose callee is a single-letter
// uppercase Identifier with 2 or 3 arguments. DataDome consistently names
// the emit function with a single uppercase letter (almost always `A`,
// occasionally other letters across variants), and signal emits always
// pass at least a name + one value. The shape is conservative on purpose
// — losing a signal is worse than over-preserving a dead branch.
//
// We track the resolved STRING NAME when we have it (so kept-vs-dropped
// can compare specific signals) and a stable shape-key (`@FNAME(arity)`)
// otherwise (so unresolved emits in the dropped branch are still treated
// as "missing" if the kept branch doesn't contain something equivalent).
const SIGNAL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,30}$/;
function collectEmits(nodeOrArray) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (
      n.type === 'CallExpression' &&
      n.callee && n.callee.type === 'Identifier' &&
      n.callee.name && /^[A-Z]$/.test(n.callee.name) &&
      n.arguments && n.arguments.length >= 2 && n.arguments.length <= 3
    ) {
      const first = n.arguments[0];
      if (first && first.type === 'StringLiteral' &&
          typeof first.value === 'string' &&
          SIGNAL_NAME_RE.test(first.value)) {
        out.add(first.value);
      } else {
        // Unresolved — track shape so kept/dropped comparison works:
        // "@A(2)" means "an A(...) call with 2 args, name not yet folded".
        out.add(`@${n.callee.name}(${n.arguments.length})`);
      }
    }
    for (const key in n) {
      if (key === 'loc' || key === 'start' || key === 'end' ||
          key === 'leadingComments' || key === 'trailingComments' ||
          key === 'innerComments' || key === 'extra') continue;
      const child = n[key];
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(nodeOrArray);
  return out;
}

// Refuse to drop a branch when it contains signal emits not also present in
// the branch we'd keep. Returns true when folding is safe.
//
// Why this exists: matrix-resolved equalities like
// `f[w(847)][w(380)] == f[w(I(26, 985))][w(189)]` reduce to literal `5 == 7`
// after t-matrix replacement, which Babel's evaluate() then folds to a
// constant boolean. If that boolean turns out to be `false` (matrix cells
// happen to differ), if-statement simplification would silently delete the
// alternate — including an entire `for (n = …; …;) switch (n) { case …:
// A('signal', …); }` state machine sitting inside it. Empirically this
// happens on interstitial-b9f50d5 around the worker-message handler, and
// drops `ArlI2n`, `5jNg41`, `mo2EqT` (the consequent's signals are unique
// to the dropped branch). Either the matrix lookup is wrong or the
// obfuscator legitimately encoded a constant equality — we can't tell, but
// either way losing a real signal emit is the worse failure mode. So when
// we see signals about to vanish, leave the if alone and let the unflatten
// pass deal with it downstream.
function canSafelyFold(droppedBranch, keptBranch) {
  if (!droppedBranch) return true;
  const droppedEmits = collectEmits(droppedBranch);
  if (droppedEmits.size === 0) return true;
  const keptEmits = keptBranch ? collectEmits(keptBranch) : new Set();
  for (const name of droppedEmits) {
    if (!keptEmits.has(name)) return false;
  }
  return true;
}

function simplifyIfStatements(ast, logger = null, result = null) {
  let changed = false;
  let skipEmitDrop = 0;

  traverse(ast, {
    IfStatement(path) {
      if (!path.node) return;

      const test = path.get('test');

      // Simplify: if(true) -> body
      if (t.isBooleanLiteral(test.node) && test.node.value === true) {
        if (!canSafelyFold(path.node.alternate, path.node.consequent)) { skipEmitDrop++; return; }
        if (t.isBlockStatement(path.node.consequent)) {
          path.replaceWithMultiple(path.node.consequent.body);
        } else {
          path.replaceWith(path.node.consequent);
        }
        changed = true;
        path.skip();
        return;
      }

      // Simplify: if(false) -> else or remove
      if (t.isBooleanLiteral(test.node) && test.node.value === false) {
        if (!canSafelyFold(path.node.consequent, path.node.alternate)) { skipEmitDrop++; return; }
        if (path.node.alternate) {
          if (t.isBlockStatement(path.node.alternate)) {
            path.replaceWithMultiple(path.node.alternate.body);
          } else {
            path.replaceWith(path.node.alternate);
          }
        } else {
          path.remove();
        }
        changed = true;
        path.skip();
        return;
      }

      try {
        const evaluated = test.evaluate();
        if (evaluated.confident) {
          const dropped = evaluated.value ? path.node.alternate : path.node.consequent;
          const kept    = evaluated.value ? path.node.consequent : path.node.alternate;
          if (!canSafelyFold(dropped, kept)) { skipEmitDrop++; return; }
          if (evaluated.value) {
            if (t.isBlockStatement(path.node.consequent)) {
              path.replaceWithMultiple(path.node.consequent.body);
            } else {
              path.replaceWith(path.node.consequent);
            }
            changed = true;
            path.skip();
          } else {
            if (path.node.alternate) {
              if (t.isBlockStatement(path.node.alternate)) {
                path.replaceWithMultiple(path.node.alternate.body);
              } else {
                path.replaceWith(path.node.alternate);
              }
            } else {
              path.remove();
            }
            changed = true;
            path.skip();
          }
        }
      } catch (e) {
        // Continue if evaluation fails
      }
    }
  });

  if (logger && skipEmitDrop > 0) {
    logger.info(`If-statement simplify: skipped ${skipEmitDrop} fold(s) to preserve signal emits`);
  }

  return changed;
}

module.exports = { simplifyIfStatements };
