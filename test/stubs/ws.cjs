// Stands in for the `ws` package so rt.js's liveness logic can be driven
// deterministically.
//
// A real server can't help here: the bug being guarded against is a *half-open*
// socket — the peer is gone but no FIN ever arrives, so readyState stays OPEN,
// sends still succeed and 'close' never fires. You cannot ask a real ws server
// to withhold a pong either; the protocol layer answers pings automatically.
// So the socket itself is faked, and tests decide exactly what comes back.
const state = (globalThis.__WS_STUB__ ||= { instances: [] });

class FakeWebSocket {
    constructor(url, options) {
        this.url = url;
        this.options = options || {};
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];          // JSON strings passed to send()
        this.pings = 0;          // protocol-level ping() calls
        this.terminated = false;
        this.closedGracefully = false;
        this._handlers = {};
        state.instances.push(this);
    }

    on(event, fn) {
        (this._handlers[event] ||= []).push(fn);
        return this;
    }

    _fire(event, ...args) {
        for (const fn of this._handlers[event] || []) fn(...args);
    }

    // rt.js detaches a socket it is deliberately killing before terminating it,
    // so a late 'close' can't run against the socket that replaced it.
    removeAllListeners() {
        this._handlers = {};
        return this;
    }

    send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
        this.sent.push(data);
    }

    ping() {
        if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
        this.pings += 1;
    }

    terminate() {
        this.terminated = true;
        this._die();
    }

    close() {
        this.closedGracefully = true;
        this._die();
    }

    _die() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this._fire('close');
    }

    // ---- test-side controls ----
    acceptConnection() {
        this.readyState = FakeWebSocket.OPEN;
        this._fire('open');
    }

    deliver(obj) {
        this._fire('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
    }

    replyPong() {
        this._fire('pong');
    }

    lastSent() {
        return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null;
    }
}

FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

module.exports = FakeWebSocket;
module.exports.WebSocket = FakeWebSocket;
module.exports.default = FakeWebSocket;
