// Demo only: stands in for the Discord webhook. Records every POST and whether it
// is multipart with a PNG attachment. GET /received returns the records.
import http from 'node:http';

const received = [];
http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/received') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(received));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const type = req.headers['content-type'] ?? '';
      const text = body.toString('latin1');
      const payload = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(text)?.[1] ?? (type.includes('json') ? body.toString('utf8') : '');
      received.push({
        at: new Date().toISOString(),
        url: req.url,
        multipart: type.startsWith('multipart/form-data'),
        hasFile: /filename="[^"]+"/.test(text),
        png: body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        bytes: body.length,
        payload: payload.slice(0, 1500),
      });
      res.writeHead(204).end();
    });
  })
  .listen(9999);
