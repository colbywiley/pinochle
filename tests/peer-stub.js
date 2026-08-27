// Test-only stand-in for PeerJS, served in place of the CDN script.
// Connects pages of the same browser context over BroadcastChannel so a
// real host + client multiplayer game can run inside Playwright.
(() => {
  const bus = new BroadcastChannel('peer-stub');
  const localPeers = {};   // peer id -> FakePeer (this page)
  const conns = {};        // connId -> FakeDataConnection (this page's end)

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] ||= []).push(fn); }
    emit(ev, ...a) { (this._h[ev] || []).forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }
  }

  class FakeDataConnection extends Emitter {
    constructor(localId, remoteId, connId, metadata) {
      super();
      this._localId = localId;
      this.peer = remoteId;
      this.connId = connId;
      this.metadata = metadata;
      this.openState = false;
    }
    send(msg) {
      bus.postMessage({ kind: 'data', connId: this.connId, payload: JSON.parse(JSON.stringify(msg)) });
    }
    close() {
      bus.postMessage({ kind: 'close', connId: this.connId });
      delete conns[this.connId];
    }
  }

  class FakeMediaConnection extends Emitter {
    constructor(remoteId, metadata) { super(); this.peer = remoteId; this.metadata = metadata; }
    answer() {}
  }

  class FakePeer extends Emitter {
    constructor(id, opts) {
      super();
      if (typeof id !== 'string') id = 'anon-' + Math.random().toString(36).slice(2, 10);
      this.id = id;
      localPeers[id] = this;
      setTimeout(() => this.emit('open', id), 0);
    }
    connect(remoteId, opts = {}) {
      const connId = 'c' + Math.random().toString(36).slice(2, 10);
      const dc = new FakeDataConnection(this.id, remoteId, connId, opts.metadata);
      conns[connId] = dc;
      bus.postMessage({ kind: 'connect', to: remoteId, from: this.id, connId, metadata: opts.metadata ?? null });
      setTimeout(() => {
        if (!dc.openState) this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + remoteId });
      }, 1500);
      return dc;
    }
    call(remoteId, stream, opts = {}) {
      return new FakeMediaConnection(remoteId, opts.metadata);
    }
    destroy() { delete localPeers[this.id]; }
  }

  bus.onmessage = e => {
    const m = e.data;
    if (m.kind === 'connect') {
      const p = localPeers[m.to];
      if (!p) return;
      const dc = new FakeDataConnection(m.to, m.from, m.connId, m.metadata);
      conns[m.connId] = dc;
      p.emit('connection', dc);
      // let the app attach its 'open' handler first; open the initiator's
      // side BEFORE ours so nothing we send in our open handler beats it
      setTimeout(() => {
        dc.openState = true;
        bus.postMessage({ kind: 'accept', connId: m.connId });
        dc.emit('open');
      }, 0);
    } else if (m.kind === 'accept') {
      const c = conns[m.connId];
      if (c && !c.openState) { c.openState = true; c.emit('open'); }
    } else if (m.kind === 'data') {
      conns[m.connId]?.emit('data', m.payload);
    } else if (m.kind === 'close') {
      const c = conns[m.connId];
      if (c) { delete conns[m.connId]; c.emit('close'); }
    }
  };

  // Pages that go away must close their connections (disconnect handling)
  window.addEventListener('pagehide', () => {
    for (const id of Object.keys(conns)) {
      bus.postMessage({ kind: 'close', connId: id });
    }
  });

  window.Peer = FakePeer;
})();
