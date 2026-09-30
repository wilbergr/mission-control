'use strict';
// Local HTTP server that receives Claude Code hook events.
// Each Claude session is launched with a generated --settings file whose hooks
// POST their stdin JSON to http://127.0.0.1:<port>/hook/<sessionId>.

const http = require('http');

class HookServer {
  /**
   * @param {(sessionId: string, payload: object) => void} onEvent
   */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.port = 0;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  _handle(req, res) {
    const m = /^\/hook\/([\w-]+)$/.exec(req.url || '');
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end();
      return;
    }
    const sessionId = m[1];
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy(); // safety cap
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = { hook_event_name: 'Unparseable' };
      }
      // The response body is what the hook command prints, and Claude reads that
      // stdout as the hook's JSON output — so onEvent may return a reply (today
      // only a PermissionRequest decision). onEvent is synchronous and cheap, so
      // answering after it still never delays Claude. Any failure answers `{}`,
      // which means "no decision": Claude simply shows its normal prompt.
      let reply = null;
      try {
        reply = this.onEvent(sessionId, payload) || null;
      } catch (err) {
        console.error('hook event handler failed:', err);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply || {}));
    });
    req.on('error', () => {});
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { HookServer };
