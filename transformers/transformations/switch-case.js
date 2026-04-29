const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function removeSwitchCaseStateMachines(ast, logger = null, result = null) {
  let changed = false;
  let scanned = 0;
  let flattened = 0;
  let skipNoSwitch = 0, skipNoIdent = 0, skipNoInit = 0, skipNoExec = 0;
  let skipEmitDrop = 0;

  // A signal emit is a CallExpression like `A('signalName', value)` where the
  // callee is a plain Identifier and the first argument is an identifier-ish
  // string. We need to know every emit the switch contains so we can verify
  // the unflatten trace doesn't silently drop any side effects (extract_signals
  // classifies functions by seeing these calls — lose one, lose the signal).
  const SIGNAL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,30}$/;
  function collectEmits(nodeOrArray) {
    const out = new Set();
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      if (
        n.type === 'CallExpression' &&
        n.callee && n.callee.type === 'Identifier' &&
        n.arguments && n.arguments.length >= 1 && n.arguments.length <= 3 &&
        n.arguments[0] && n.arguments[0].type === 'StringLiteral' &&
        typeof n.arguments[0].value === 'string' &&
        SIGNAL_NAME_RE.test(n.arguments[0].value)
      ) {
        out.add(n.arguments[0].value);
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

  // Loop test is truthy for obfuscator state machines. Accept anything that
  // isn't provably falsy — decoded helpers (`C(D(120, 18))`) show up as call
  // expressions; missing tests (`for(;;)`) show up as null.
  function isLoopTestTruthy(test) {
    if (test == null) return true;
    if (t.isBooleanLiteral(test, { value: false })) return false;
    if (t.isNullLiteral(test)) return false;
    if (t.isNumericLiteral(test, { value: 0 })) return false;
    if (t.isStringLiteral(test, { value: "" })) return false;
    if (t.isIdentifier(test, { name: "undefined" })) return false;
    return true;
  }

  traverse(ast, {
    ForStatement(path) {
      const { node } = path;
      if (!isLoopTestTruthy(node.test)) return;
      scanned++;

      // Find the switch inside the loop
      let switchStmt = null;
      let before = [];
      if (t.isSwitchStatement(node.body)) {
        switchStmt = node.body;
      } else if (t.isBlockStatement(node.body)) {
        const i = node.body.body.findIndex(s => t.isSwitchStatement(s));
        if (i < 0) { skipNoSwitch++; return; }
        before = node.body.body.slice(0, i);
        switchStmt = node.body.body[i];
      } else {
        skipNoSwitch++;
        return;
      }
      if (!t.isIdentifier(switchStmt.discriminant)) { skipNoIdent++; return; }
      const stateVar = switchStmt.discriminant.name;

      // Get initial state
      const initial = getInitialState(path, node, stateVar);
      if (initial == null) { skipNoInit++; return; }

      const cases = switchStmt.cases;
      const indexByValue = new Map();
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        if (c.test && t.isNumericLiteral(c.test)) indexByValue.set(c.test.value, i);
      }

      const executed = [];
      const visitedStates = new Set();
      let state = initial;

      while (indexByValue.has(state) && !visitedStates.has(state)) {
        visitedStates.add(state);
        const startIdx = indexByValue.get(state);

        // Coalesce multi-label fall-through, pick the first case with a non-empty body
        const { body } = coalesceBody(cases, startIdx);

        // Strip break, continue, and assignments to the state var, explode comma expressions
        const { stmts, lastAssign } = cleanBody(body, stateVar);

        executed.push(...stmts);
        if (lastAssign == null) break;
        state = lastAssign;
      }

      if (!executed.length) { skipNoExec++; return; }

      // Safety check — the trace must cover every signal emit in the switch.
      // If the state-dispatch analysis missed a case body that contains an
      // `A('literal', …)` call, flattening would silently drop a signal
      // emit. In that case we bail: better to leave a state machine in
      // place than to lose an emit (invariant #1 in the extract_signals
      // acceptance criteria).
      const allEmits = collectEmits(cases.map(c => c.consequent));
      if (allEmits.size > 0) {
        const executedEmits = collectEmits(executed);
        let missing = null;
        for (const name of allEmits) {
          if (!executedEmits.has(name)) { missing = name; break; }
        }
        if (missing) {
          skipEmitDrop++;
          return;
        }
      }

      // Keep any other loop-initialized bindings except the state var itself
      const keepDecls = t.isVariableDeclaration(node.init)
        ? node.init.declarations
            .filter(d => !(t.isIdentifier(d.id, { name: stateVar })))
            .map(d => {
              // Unwrap chained assignment: var m = r = 39 → var m = 39
              if (
                t.isAssignmentExpression(d.init) &&
                t.isIdentifier(d.init.left, { name: stateVar }) &&
                t.isNumericLiteral(d.init.right)
              ) {
                d.init = d.init.right;
              }
              return d;
            })
        : [];

      const replacement = [];
      if (keepDecls.length) replacement.push(t.variableDeclaration(node.init.kind, keepDecls));
      replacement.push(...before, ...executed);

      if (replacement.length === 0) path.remove();
      else path.replaceWithMultiple(replacement);
      changed = true;
      flattened++;
      if (result) result.stats.transformations.switchCaseRemoved++;
    }
  });

  if (logger) {
    logger.info(`Switch-case unflatten: scanned ${scanned}, flattened ${flattened}, skipped (no switch: ${skipNoSwitch}, non-ident discriminant: ${skipNoIdent}, no initial state: ${skipNoInit}, no executed: ${skipNoExec}, would-drop-emits: ${skipEmitDrop})`);
  }
  return changed;

  // Helpers

  function coalesceBody(cases, idx) {
    let j = idx;
    while (j < cases.length && cases[j].consequent.length === 0) j++;
    return { body: j < cases.length ? cases[j].consequent : [] };
  }

  function cleanBody(stmts, stateVar) {
    const out = [];
    let lastAssign = null;

    for (const s of stmts) {
      if (t.isBreakStatement(s) || t.isContinueStatement(s)) continue;

      if (t.isExpressionStatement(s)) {
        const exprs = explodeSequence(s.expression);
        const kept = [];
        for (const ex of exprs) {
          if (
            t.isAssignmentExpression(ex) &&
            t.isIdentifier(ex.left, { name: stateVar }) &&
            t.isNumericLiteral(ex.right)
          ) {
            lastAssign = ex.right.value; // remember next state, do not emit it
            continue;
          }
          kept.push(ex);
        }
        kept.forEach(ex => out.push(t.expressionStatement(ex)));
        continue;
      }

      out.push(s);
    }

    return { stmts: out, lastAssign };
  }

  // Flatten nested SequenceExpressions into a plain list of expressions
  function explodeSequence(expr) {
    if (t.isSequenceExpression(expr)) {
      const flat = [];
      for (const e of expr.expressions) flat.push(...explodeSequence(e));
      return flat;
    }
    return [expr];
  }

  function getInitialState(path, forNode, stateVar) {
    const init = forNode.init;
    if (t.isVariableDeclaration(init)) {
      for (const d of init.declarations) {
        if (t.isIdentifier(d.id, { name: stateVar }) && t.isNumericLiteral(d.init)) {
          return d.init.value;
        }
        // Handle chained assignment: var m = r = 39 (state var assigned inside another declarator's init)
        if (
          t.isAssignmentExpression(d.init) &&
          t.isIdentifier(d.init.left, { name: stateVar }) &&
          t.isNumericLiteral(d.init.right)
        ) {
          return d.init.right.value;
        }
      }
      // Red-herring guard: the obfuscator often pads the for-init with an
      // unused declaration (`for (var eA = 544; true;)`) while the real state
      // var is assigned by an earlier `r = 124;` in the enclosing block. If
      // this for-init doesn't touch the state var, fall through to the
      // above-the-loop scan to find the real initial state.
      return lookAbove(path, forNode, stateVar);
    } else if (
      t.isAssignmentExpression(init) &&
      t.isIdentifier(init.left, { name: stateVar }) &&
      t.isNumericLiteral(init.right)
    ) {
      return init.right.value;
    } else if (!init) {
      return lookAbove(path, forNode, stateVar);
    }
    return null;
  }

  function lookAbove(path, forNode, stateVar) {
    // Look a few statements above the loop for either an ExpressionStatement
    // assignment (`r = 124;`) or a VariableDeclaration (`var t = 30;`).
    const p = path.parentPath;
    if (!p || !t.isBlockStatement(p.node)) return null;
    const arr = p.node.body;
    const idx = arr.indexOf(forNode);
    for (let i = idx - 1; i >= 0 && i >= idx - 3; i--) {
      const s = arr[i];
      if (
        t.isExpressionStatement(s) &&
        t.isAssignmentExpression(s.expression) &&
        t.isIdentifier(s.expression.left, { name: stateVar }) &&
        t.isNumericLiteral(s.expression.right)
      ) {
        return s.expression.right.value;
      }
      if (t.isVariableDeclaration(s)) {
        for (const d of s.declarations) {
          if (t.isIdentifier(d.id, { name: stateVar }) && t.isNumericLiteral(d.init)) {
            return d.init.value;
          }
          if (
            t.isAssignmentExpression(d.init) &&
            t.isIdentifier(d.init.left, { name: stateVar }) &&
            t.isNumericLiteral(d.init.right)
          ) {
            return d.init.right.value;
          }
        }
      }
    }
    return null;
  }
}

module.exports = { removeSwitchCaseStateMachines };