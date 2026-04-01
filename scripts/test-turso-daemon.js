// Probe Turso local daemon endpoints
const http = require('http');

function probe(port) {
  return new Promise((resolve) => {
    const endpoints = [
      { path: '/', method: 'GET' },
      { path: '/v1/', method: 'GET' },
      { path: '/v1/pipeline', method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', args: [] }) },
      { path: '/v1/execute', method: 'POST', body: JSON.stringify({ sql: 'SELECT 1', args: [] }) },
      { path: '/v1/statements', method: 'POST', body: JSON.stringify({ statements: ['SELECT 1'] }) },
    ];

    console.log(`\nProbing localhost:${port}...\n`);

    (async () => {
      for (const ep of endpoints) {
        try {
          const result = await new Promise((res2, rej2) => {
            const reqOpts = {
              hostname: '127.0.0.1', port, path: ep.path,
              method: ep.method,
              headers: { 'Content-Type': 'application/json', 'Content-Length': ep.body ? Buffer.byteLength(ep.body) : 0 },
            };
            const req = http.request(reqOpts, (res) => {
              let data = '';
              res.on('data', c => data += c);
              res.on('end', () => res2({ status: res.statusCode, body: data.slice(0, 300) }));
            });
            req.on('error', rej2);
            if (ep.body) req.write(ep.body);
            req.end();
          });
          console.log(`  ${ep.method} ${ep.path} -> ${result.status}: ${result.body.slice(0, 150)}`);
        } catch (e) {
          console.log(`  ${ep.method} ${ep.path} -> ERROR: ${e.message}`);
        }
      }
    })();
    resolve();
  });
}

probe(8080);
