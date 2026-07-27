'use strict';

const config = require('../config');

// Session-remembered approvals so an identical effectful call isn't re-asked.
const sessionAllowed = new Set();

function sig(name, args) {
  let key = '';
  try {
    key = JSON.stringify(args);
  } catch {}
  return `${name}:${key}`.slice(0, 300);
}

// Tools that must get an explicit loop-level confirm (extend via
// LESLIE_PERMISSION_ASK). Tools that gate themselves — run_command,
// install_software (allowlist) and write_file (preview confirm) — are NOT here;
// they run at the loop level and prompt with their own finer logic.
const ASK_TOOLS = new Set(config.permissionAsk || []);

/**
 * allow | ask | deny for a tool call.
 * - plan mode: read-only allowed, everything effectful denied.
 * - otherwise: read-only and self-gating tools run; only tools explicitly in
 *   ASK_TOOLS are asked (once, then remembered for the session). Other effectful
 *   tools (create_document, open_url, open_app) run as they always have.
 */
function decide(name, meta, args) {
  const readOnly = Boolean(meta && meta.readOnly);
  if (config.planMode) return readOnly ? 'allow' : 'deny';
  if (readOnly) return 'allow';
  if (meta && meta.selfGates) return 'allow';
  if (ASK_TOOLS.has(name) && !sessionAllowed.has(sig(name, args))) return 'ask';
  return 'allow';
}

function remember(name, args) {
  sessionAllowed.add(sig(name, args));
}

function denyReason(name) {
  if (config.planMode) {
    return `"${name}" is blocked in plan mode (read-only investigation). Propose it in your plan instead of running it.`;
  }
  return `"${name}" was blocked by the current permission settings.`;
}

module.exports = { decide, remember, denyReason };
