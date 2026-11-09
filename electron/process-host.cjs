'use strict';

// The main-process side of a background process that answers requests. The
// collector utility process and the maintenance worker both run through this
// one host. It starts the child when work arrives, matches replies to
// requests by id, times a request out, releases a child that has had no work
// for a while, and fails every in-flight request of a child that dies, so
// nothing can wait on a process that is no longer there.
//
// What differs between the two is passed in: how to start, reach and stop the
// child, the wording of errors, and a handful of rules on which the two have
// always behaved differently. Each of those rules is an option here, so that
// sharing this module changes the behaviour of neither.

const { CLOSE_REQUEST, isReplyEnvelope } = require('./process-protocol.cjs');

/** @typedef {import('./process-protocol.cjs').RequestEnvelope} RequestEnvelope */
/** @typedef {import('./process-protocol.cjs').CloseResult} CloseResult */

/**
 * What a child reports to its host. `listen` connects these to the child's
 * own events.
 *
 * @typedef {object} ChildEvents
 * @property {(message: unknown) => void} reply the child sent a message
 * @property {(code: number) => void} exited the child has exited
 * @property {(error: unknown) => void} failed the child broke and will not answer; its requests fail with this error
 */

/**
 * The errors a caller of the host can be given, in the host's own wording.
 *
 * @typedef {object} HostErrors
 * @property {(type: string) => Error} timedOut the request of this type was not answered in time
 * @property {(code: number) => Error} exited the child exited with requests in flight
 * @property {() => Error} stopped the host was stopped with requests in flight
 * @property {() => Error} closing a request was made after close()
 * @property {string} failed the message of an error reply that carries none
 */

/**
 * @template {object} Child
 * @typedef {object} ProcessHostOptions
 * @property {string} name what the log calls the child, such as "Collector process"
 * @property {() => Child} spawn start a child
 * @property {(child: Child, events: ChildEvents) => void} listen subscribe to a child that was just started
 * @property {(child: Child, message: RequestEnvelope) => void} send
 * @property {(child: Child) => void} stop end a child at once; a throw means it had already gone and is ignored
 * @property {(message: string) => void} log
 * @property {HostErrors} errors
 * @property {(type: string) => number | null} requestTimeoutMs how long a request of this type may go unanswered once the child has answered every timed request sent before it; null for no limit
 * @property {boolean} unrefRequestTimers true when a request that is only waiting for its time limit must not keep the main process alive
 * @property {'stop' | 'abandon'} onTimeout what an unanswered request does to the child and its other requests; see request()
 * @property {'throw' | 'reject'} spawnFailure whether request() throws when a child cannot be started, or returns a rejected promise
 * @property {boolean} idleAfterSendFailure whether the idle period starts again after a request that could not be sent
 * @property {number} idleTimeoutMs how long a child with no work is kept; zero or less keeps it for good
 * @property {number} retireGraceMs how long a released child has to exit before it is stopped
 * @property {boolean} stopOnCloseReply true to stop a released child as soon as it answers the close request, false to let it exit by itself
 * @property {Record<string, unknown>} [retirePayload] the payload of the close request sent to a released child; the request carries none when omitted
 * @property {() => number} [retireHoldMs] how much longer the child must be kept even though it is idle; zero or less when it may be released now
 * @property {(type: string, ok: boolean) => void} [onReply] a request of this type was answered, before its caller is told
 * @property {() => void} [onChildGone] the child was dropped without being asked to close (it exited, failed, timed out or was stopped), so whatever it held is lost
 * @property {(code: number) => string} [exitLog] a log line for a child's exit; nothing is logged when omitted
 */

/**
 * A request waiting for its reply, and the child it was sent to.
 *
 * @template {object} Child
 * @typedef {object} PendingRequest
 * @property {(result: unknown) => void} resolve
 * @property {(error: unknown) => void} reject
 * @property {Child} child
 * @property {NodeJS.Timeout | null} timer null when the request has no time limit, or is still waiting behind an earlier one
 * @property {number | null} limit how long the request may go unanswered once its turn has come; null for no limit
 * @property {() => void} expire what happens when that time is up
 * @property {string} type
 */

/**
 * A released child that was asked to close and has not exited yet.
 *
 * @typedef {object} Retirement
 * @property {number} id the id of the close request
 * @property {NodeJS.Timeout} timer ends a child that does not exit in time
 * @property {boolean} stopped whether the host has already stopped it
 * @property {Promise<void>} exited settles when the child has exited
 * @property {() => void} markExited
 */

/**
 * @typedef {object} ProcessHost
 * @property {(type: string, payload?: Record<string, unknown>) => Promise<any>} request resolves with the reply's result, whose shape depends on the type
 * @property {() => void} stop end the child now and fail its requests
 * @property {() => Promise<CloseResult>} close ask the child to close after its accepted work, refuse new work, and wait for released children to exit
 * @property {boolean} running whether there is a child to send to
 */

/**
 * @template {object} Child
 * @param {ProcessHostOptions<Child>} options
 * @returns {ProcessHost}
 */
function createProcessHost({
  name, spawn, listen, send, stop: stopChild, log, errors,
  requestTimeoutMs, unrefRequestTimers, onTimeout, spawnFailure, idleAfterSendFailure,
  idleTimeoutMs, retireGraceMs, stopOnCloseReply, retirePayload,
  retireHoldMs = () => 0, onReply = () => {}, onChildGone = () => {}, exitLog,
}) {
  // The child new requests go to. Every pending request belongs to it: a
  // child is only replaced once its requests have been failed or answered.
  /** @type {Child | null} */
  let current = null;
  let closing = false;
  /** @type {Promise<CloseResult> | undefined} */
  let closePromise;
  // One counter for requests and for the close request of a released child.
  let nextId = 1;
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;
  /** @type {Map<number, PendingRequest<Child>>} */
  const pending = new Map();
  // Released children still closing their store.
  /** @type {Map<Child, Retirement>} */
  const retiring = new Map();
  // Children whose first ignored message has been logged.
  /** @type {WeakSet<Child>} */
  const reported = new WeakSet();

  /** @param {Child} target */
  const busy = (target) => [...pending.values()].some((entry) => entry.child === target);

  /** @param {Child} target */
  function stopNow(target) {
    try { stopChild(target); } catch { /* Already gone. */ }
  }

  // Stop sending to a child that can no longer answer.
  /** @param {Child} target */
  function drop(target) {
    if (current !== target) return;
    current = null;
    onChildGone();
  }

  // Fail the in-flight requests of one child. A recycled child's late exit
  // event must not reject a request that was already registered against its
  // replacement.
  /**
   * @param {Child} owner
   * @param {unknown} error
   */
  function failPending(owner, error) {
    for (const [id, entry] of pending) {
      if (entry.child !== owner) continue;
      pending.delete(id);
      // A request with no time limit carries null, which has nothing to clear.
      clearTimeout(entry.timer ?? undefined);
      entry.reject(error);
    }
  }

  // A child works through its requests in the order they were sent, so a
  // request's time limit is for its own work: it starts when the timed
  // requests sent before it have been answered, not while it waits behind
  // them. Only the oldest such request of a child is being timed. If that one
  // is never answered, every request behind it fails with it.
  /** @param {Child} target */
  function startClock(target) {
    // The map keeps the order in which the requests were sent.
    for (const entry of pending.values()) {
      if (entry.child !== target || entry.limit === null) continue;
      if (!entry.timer) {
        entry.timer = setTimeout(entry.expire, entry.limit);
        if (unrefRequestTimers) entry.timer.unref?.();
      }
      return;
    }
  }

  // A message that cannot be matched to a waiting request changes nothing.
  // The first one from each child is logged; a child that keeps sending them
  // does not fill the log.
  /**
   * @param {Child} source
   * @param {string} what
   */
  function ignore(source, what) {
    if (reported.has(source)) return;
    reported.add(source);
    log(`${name}: ignored ${what}.`);
  }

  // End a released child that has not exited by itself. It stays in the list
  // until its exit is seen, so close() can wait for it.
  /**
   * @param {Child} target
   * @param {Retirement} retirement
   */
  function endRetirement(target, retirement) {
    if (retirement.stopped) return;
    retirement.stopped = true;
    clearTimeout(retirement.timer);
    stopNow(target);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!current || closing || busy(current) || !(idleTimeoutMs > 0)) return;
    const target = current;
    idleTimer = setTimeout(() => retire(target), Math.max(idleTimeoutMs, retireHoldMs()));
    idleTimer.unref?.();
  }

  /** @param {Child} target */
  function retire(target) {
    if (current !== target || closing || busy(target)) return;
    if (retireHoldMs() > 0) {
      scheduleIdle();
      return;
    }
    // Detach before asking it to close: a new request gets a fresh child,
    // never a connection which is already being closed. It has nothing in
    // flight, so SQLite sees an ordinary close.
    current = null;
    const id = nextId++;
    let markExited = () => {};
    /** @type {Promise<void>} */
    const exited = new Promise((resolve) => { markExited = resolve; });
    /** @type {Retirement} */
    const retirement = {
      id,
      timer: setTimeout(() => endRetirement(target, retirement), retireGraceMs),
      stopped: false,
      exited,
      markExited,
    };
    retirement.timer.unref?.();
    retiring.set(target, retirement);
    try {
      send(target, retirePayload ? { id, type: CLOSE_REQUEST, payload: { ...retirePayload } } : { id, type: CLOSE_REQUEST });
    } catch { endRetirement(target, retirement); }
  }

  /**
   * @param {Child} source
   * @param {unknown} message
   */
  function receive(source, message) {
    if (!isReplyEnvelope(message)) {
      ignore(source, 'a message that is not a reply');
      return;
    }
    const retirement = retiring.get(source);
    if (retirement?.id === message.id) {
      // The released child has closed its store.
      if (stopOnCloseReply) endRetirement(source, retirement);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry || entry.child !== source) {
      ignore(source, `a reply to a request that is not waiting for one (id ${message.id})`);
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer ?? undefined);
    onReply(entry.type, message.ok);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error?.message || errors.failed));
    startClock(source);
    if (current === source) scheduleIdle();
  }

  function currentChild() {
    if (current) return current;
    const spawned = spawn();
    listen(spawned, {
      reply: (message) => receive(spawned, message),
      failed: (error) => {
        drop(spawned);
        failPending(spawned, error);
      },
      exited: (code) => {
        drop(spawned);
        const retirement = retiring.get(spawned);
        if (retirement) {
          clearTimeout(retirement.timer);
          retiring.delete(spawned);
          retirement.markExited();
        }
        if (exitLog) log(exitLog(code));
        failPending(spawned, errors.exited(code));
      },
    });
    current = spawned;
    return spawned;
  }

  // A request that never answers is a stuck child, and it is replaced. The
  // two ways of doing that differ in what the child's other requests are told
  // and in what happens to released children:
  // - 'stop': the unanswered request fails with the timeout, then the host is
  //   stopped as stop() does it. Released children are ended at once, the
  //   child is ended, and its other requests fail as stopped.
  // - 'abandon': every request of the child fails with the same timeout, then
  //   the child is ended. Released children are left to finish closing.
  /**
   * @param {string} type
   * @param {Record<string, unknown>} [payload]
   * @returns {Promise<any>} the reply's result, whose shape depends on the type
   */
  function request(type, payload = {}) {
    if (closing && type !== CLOSE_REQUEST) return Promise.reject(errors.closing());
    clearTimeout(idleTimer);
    if (spawnFailure === 'throw') currentChild();
    return new Promise((resolve, reject) => {
      const target = currentChild();
      const id = nextId++;
      const limit = requestTimeoutMs(type);
      const expire = () => {
        if (!pending.has(id)) return;
        if (onTimeout === 'abandon') {
          drop(target);
          failPending(target, errors.timedOut(type));
          stopNow(target);
          return;
        }
        pending.delete(id);
        reject(errors.timedOut(type));
        if (current === target) stop();
      };
      /** @type {PendingRequest<Child>} */
      const entry = { resolve, reject, child: target, timer: null, limit, expire, type };
      pending.set(id, entry);
      startClock(target);
      try {
        send(target, { id, type, payload });
      } catch (error) {
        pending.delete(id);
        clearTimeout(entry.timer ?? undefined);
        reject(error);
        if (idleAfterSendFailure) scheduleIdle();
      }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    for (const [target, retirement] of retiring) endRetirement(target, retirement);
    const target = current;
    if (!target) return;
    drop(target);
    stopNow(target);
    failPending(target, errors.stopped());
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(idleTimer);
    // The child serializes this behind its active work, so nothing running is
    // cut short. A released child still closing its store is waited for as
    // well.
    /** @type {Promise<CloseResult>} */
    const closed = current ? request(CLOSE_REQUEST) : Promise.resolve({ closed: true });
    closePromise = Promise.all([closed, ...[...retiring.values()].map((retirement) => retirement.exited)]).then(([result]) => result);
    return closePromise;
  }

  return { request, stop, close, get running() { return Boolean(current); } };
}

module.exports = { createProcessHost };
