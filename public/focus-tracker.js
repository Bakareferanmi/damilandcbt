// One event per hidden transition. No blur listener: clicking the calculator is not a tab switch.
export class FocusTracker {
  constructor({ storage, key, send, clock = () => Math.floor(Date.now()/1000), uuid = () => crypto.randomUUID() }) {
    Object.assign(this, { storage, key, send, clock, uuid });
    this.pending = []; this.hidden = false; this.busy = false;
    try { const saved = JSON.parse(storage.getItem(key) || '[]'); if (Array.isArray(saved)) this.pending = saved.slice(-500); } catch {}
  }
  persist() { try { this.storage.setItem(this.key, JSON.stringify(this.pending)); } catch {} }
  change(hidden, active) {
    if (hidden && !this.hidden && active && this.pending.length < 500) {
      this.pending.push({ eventId: this.uuid(), occurredAt: this.clock() }); this.persist();
    }
    this.hidden = hidden;
    return this.flush();
  }
  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length) {
        const event = this.pending[0];
        const status = await this.send(event);
        if (status !== 200 && status !== 409 && status !== 401 && status !== 403) break;
        this.pending.shift(); this.persist();
      }
    } catch {} finally { this.busy = false; }
  }
}
