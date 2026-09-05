'use strict';

// Claude's usage control response can contain cached windows after a failed
// HTTP fetch. Only usage-specific stderr events establish freshness. Raw debug
// output stays in a bounded, transient buffer and is never stored or forwarded.
function createUsageDiagnostics() {
  let pending = '';
  let truncated = false;
  let state = { outcome: 'unverified', code: null, httpStatus: null };
  function line(value) {
    if (/fetchUtilization: GET \/api\/oauth\/usage \(attempt \d+\)/.test(value)) {
      state = { outcome: 'unverified', code: null, httpStatus: null };
    }
    const success = value.match(/fetchUtilization: (200) after \d+ attempt\(s\)/);
    if (success) state = { outcome: 'verified', code: null, httpStatus: 200 };
    if (!/Failed to load usage data:/.test(value)) return;
    const status = value.match(/(?:status(?: code)?[=: ]+|HTTP\s+)(401|403|429|500|502|503|504|529)\b/i);
    const network = value.match(/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/);
    const httpStatus = status ? Number(status[1]) : null;
    const code = httpStatus ? `claude-usage-http-${httpStatus}`
      : network ? `claude-usage-${network[1].toLowerCase()}` : 'claude-usage-fetch-failed';
    state = { outcome: 'failed', code, httpStatus };
  }
  return {
    write(data) {
      for (const part of String(data).split(/(?<=\n)/)) {
        if (!truncated) {
          pending += part.slice(0, Math.max(0, 4096 - pending.length));
          if (pending.length >= 4096) truncated = true;
        }
        if (part.endsWith('\n')) {
          line(pending);
          pending = '';
          truncated = false;
        }
      }
    },
    finish() {
      if (pending) line(pending);
      pending = '';
      return { ...state };
    },
  };
}

module.exports = { createUsageDiagnostics };
