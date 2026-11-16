// e2e 用靜態伺服器：repo 根目錄同時掛在 / 與 /NHI-drug-price-history/（模擬 GitHub Pages 專案子路徑）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 8765);
const BASE = '/NHI-drug-price-history';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

// 「headers 已送、body 未完」且之後可放行完成的回應（spec-startup S4、S10）：
//   PUT  /__slow_put/<id>      測試端先把完整 body 存進來
//   GET  /__slow_body/<id>     送出 headers 與前半段 body 後停住
//   GET  /__slow_release/<id>  補完後半段並結束；若 body 請求尚未抵達，抵達時直接送完整內容
const slow = new Map();

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const slowRoute = /^\/__slow_(put|body|release)\/([\w-]+)$/.exec(path);
  if (slowRoute) {
    const [, op, id] = slowRoute;
    if (op === 'put') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      slow.set(id, { body: Buffer.concat(chunks), res: null, released: false });
      res.writeHead(204); res.end();
      return;
    }
    const s = slow.get(id);
    if (!s) { res.writeHead(404); res.end('unknown slow id'); return; }
    const half = Math.max(1, s.body.length >> 1);
    if (op === 'body') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'] });
      if (s.released) { res.end(s.body); return; }
      res.write(s.body.subarray(0, half));
      s.res = res;
      return;
    }
    s.released = true;
    if (s.res) s.res.end(s.body.subarray(half));
    res.writeHead(204); res.end();
    return;
  }
  // 只送出 headers 與半截 body 後停住：模擬「接收 body 階段逾時」，
  // 這是 route.fulfill 做不到的情境（fulfill 是原子的）
  if (path === '/__stall_body') {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Content-Length': '999999' });
    res.write('{"dataVersion":');
    return;
  }
  if (path === BASE) { res.writeHead(301, { Location: `${BASE}/` }); res.end(); return; }
  if (path.startsWith(`${BASE}/`)) path = path.slice(BASE.length);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
