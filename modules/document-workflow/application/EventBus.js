'use strict';

/**
 * Simple in-process pub/sub for domain events.
 * - Subscribers are async-safe; errors are caught to not break publisher.
 * - One event type -> many handlers.
 */
function createEventBus(options) {
  const logger = (options && options.logger) || {
    warn: (...args) => console.warn('[event-bus]', ...args),
    info: () => {},
  };
  const listeners = new Map();

  function subscribe(type, handler) {
    if (!type || typeof handler !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return function unsubscribe() {
      const set = listeners.get(type);
      if (set) set.delete(handler);
    };
  }

  function publish(event) {
    if (!event || !event.type) return;
    const set = listeners.get(event.type);
    if (!set || !set.size) return;
    for (const handler of set) {
      try {
        const out = handler(event);
        if (out && typeof out.then === 'function') {
          out.catch((err) => {
            logger.warn(`handler failed for ${event.type}:`, err && err.message);
          });
        }
      } catch (err) {
        logger.warn(`handler threw for ${event.type}:`, err && err.message);
      }
    }
  }

  return { subscribe, publish };
}

module.exports = { createEventBus };
