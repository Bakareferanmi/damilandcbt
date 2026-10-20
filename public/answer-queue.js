// One queue per student/attempt. Only server-acknowledged revisions leave the outbox.
export class AnswerQueue {
  constructor({ key, storage, answers = {}, revisions = {}, allowed, send, onChange = () => {} }) {
    this.key = key;
    this.storage = storage;
    this.send = send;
    this.onChange = onChange;
    this.answers = { ...answers };
    this.revisions = { ...revisions };
    this.pending = {};
    this.storageError = false;
    this.conflicts = 0;
    this.running = null;
    this.terminal = null;
    const valid = new Set(allowed.map(String));
    try {
      const saved = JSON.parse(storage.getItem(key) || '{}');
      for (const [id, item] of Object.entries(saved)) {
        if (!valid.has(id) || !item || !['A', 'B', 'C', 'D'].includes(item.chosen) || !Number.isSafeInteger(item.revision) || item.revision < 1) continue;
        const remote = this.revisions[id] || 0;
        if (remote >= item.revision) {
          if (answers[id] !== item.chosen) this.conflicts++;
          continue;
        }
        this.pending[id] = item;
        this.answers[id] = item.chosen;
        this.revisions[id] = item.revision;
      }
    } catch { this.storageError = true; }
    this.persist();
  }

  get count() { return Object.keys(this.pending).length; }

  persist() {
    try {
      if (this.count) this.storage.setItem(this.key, JSON.stringify(this.pending));
      else this.storage.removeItem(this.key);
      this.storageError = false;
    } catch { this.storageError = true; }
    this.onChange(this);
  }

  choose(id, chosen) {
    this.answers[id] = chosen;
    const revision = (this.revisions[id] || 0) + 1;
    this.revisions[id] = revision;
    this.pending[id] = { chosen, revision };
    this.persist(); // Synchronous: navigation immediately after a click must retain the choice.
  }

  flush() {
    // Returning the running promise makes submit wait for saves already in flight.
    if (!this.running && !this.count) return Promise.resolve();
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    if (this.terminal) throw this.terminal;
    while (this.count) {
      // Bound a reconnect burst instead of sending up to 200 requests at once.
      const batch = Object.entries(this.pending).slice(0, 3);
      const outcomes = await Promise.allSettled(batch.map(async ([id, item]) => {
        const ack = await this.send(Number(id), item.chosen, item.revision);
        if (ack.chosen !== item.chosen || ack.revision !== item.revision) {
          const err = new Error('An answer changed in another request. Refresh to reconcile it.');
          err.terminal = true;
          throw err;
        }
        if (this.pending[id]?.revision === item.revision) delete this.pending[id];
        this.persist();
      }));
      const failed = outcomes.find((x) => x.status === 'rejected' && x.reason.terminal) || outcomes.find((x) => x.status === 'rejected');
      if (failed) {
        if (failed.reason.terminal) this.terminal = failed.reason;
        throw failed.reason;
      }
    }
  }
}
