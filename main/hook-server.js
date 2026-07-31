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
      // Respond immediately so the hook command never delays Claude.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = { hook_event_name: 'Unparseable' };
      }
      try {
        this.onEvent(sessionId, payload);
      } catch (err) {
        console.error('hook event handler failed:', err);
      }
    });
    req.on('error', () => {});
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = { HookServer };
