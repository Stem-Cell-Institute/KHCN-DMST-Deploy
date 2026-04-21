class DomainEventBus {
  constructor() {
    this.handlers = new Map();
  }

  subscribe(eventName, handler) {
    const list = this.handlers.get(eventName) || [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  publish(eventName, payload) {
    const list = this.handlers.get(eventName) || [];
    for (const handler of list) {
      try {
        handler(payload);
      } catch (_) {}
    }
  }
}

module.exports = {
  DomainEventBus,
};
