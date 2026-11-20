'use strict';
// Bağımsız küçük sunucu (sadece node http, bağımlılık yok): overlay + SSE.
// Mevcut altyapının overlay/websocket yöntemi varsa bu dosya yerine o kullanılır.
const http = require('http');
const fs = require('fs');
const path = require('path');

function createOverlayServer({ game, port = 3000 }) {
  const clients = new Set();
  const send = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  game.subscribe(events => { for (const c of clients) send(c, 'events', events); });
  const snapTimer = setInterval(() => { const s = game.engine.snapshot(); for (const c of clients) send(c, 'snapshot', s); }, 500);

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res); send(res, 'snapshot', game.engine.snapshot());
      req.on('close', () => clients.delete(res));
    } else if (url === '/api/countries') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ countries: game.countries.COUNTRIES.map(({ id, name, continent, class: cls, lon, lat }) => ({ id, name, continent, class: cls, lon, lat })), phases: game.config.round.phases }));
    } else if (url === '/' || url === '/overlay') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'overlay', 'index.html')));
    } else { res.writeHead(404); res.end('not found'); }
  });
  server.listen(port);
  server.on('close', () => clearInterval(snapTimer));
  return server;
}
module.exports = { createOverlayServer };
