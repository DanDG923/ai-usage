'use strict';

// The messages a host in the main process exchanges with a background
// process (the collector utility process, the maintenance worker). Both sides
// take their message shapes from here, so there is one definition of them.

/**
 * A request from the host. The id is the host's own; the reply repeats it.
 *
 * @typedef {object} RequestEnvelope
 * @property {number} id
 * @property {string} type what is asked for; each service lists the types it knows
 * @property {Record<string, unknown>} [payload] the fields that type needs
 */

/**
 * The answer to one request: the same id, and either a result or the message
 * of the error that stopped it. Only values that survive a structured clone
 * cross the boundary, so an error travels as its message.
 *
 * @typedef {object} ReplyEnvelope
 * @property {number} id
 * @property {boolean} ok
 * @property {unknown} [result] present when ok
 * @property {{ message?: string }} [error] present when not ok
 */

/**
 * What a service answers to a close request, once its store is closed.
 *
 * @typedef {{ closed: boolean }} CloseResult
 */

// Every service understands this request: finish accepted work, close the
// store, answer. A host sends it to a child it no longer needs.
const CLOSE_REQUEST = 'close';

// Whether a message from a child can be matched to a request and settled:
// an object with a whole-number id and a true or false `ok`. The result is
// whatever the service returned, and a missing error message has a fallback
// in the host, so neither is checked here.
/**
 * @param {unknown} value
 * @returns {value is ReplyEnvelope}
 */
function isReplyEnvelope(value) {
  if (typeof value !== 'object' || value === null) return false;
  const { id, ok } = /** @type {{ id?: unknown, ok?: unknown }} */ (value);
  return Number.isInteger(id) && typeof ok === 'boolean';
}

module.exports = { CLOSE_REQUEST, isReplyEnvelope };
