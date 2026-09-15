'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
// 离线缓存有效期（毫秒），默认 5 分钟；通过响应头下发给 Service Worker
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);

db.init();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    // ---------- API ----------
    if (p.startsWith('/api/')) {
      // 扫码：/api/scan/BP-0001-01
      if (req.method === 'GET' && /^\/api\/scan\/[^/]+$/.test(p)) {
        const code = decodeURIComponent(p.slice('/api/scan/'.length));
        const part = db.getPart(code);
        if (!part) return sendJson(res, 404, { error: '未找到该条码对应的配件', code });
        const view = db.buildScanView(part);
        return sendJson(res, 200, view, {
          // SW 依据这两个头做 TTL 缓存
          'X-Cache-TTL': String(CACHE_TTL_MS),
          'X-Server-Time': new Date().toISOString()
        });
      }

      if (req.method === 'POST' && p === '/api/issues') {
        const body = await readBody(req);
        if (!body.code) return sendJson(res, 400, { error: '缺少 code（配件条码）' });
        const result = db.addIssue(body);
        return sendJson(res, 201, {
          ok: true,
          issue: result.issue,
          batch: result.batch,
          threshold: result.threshold
        });
      }

      if (req.method === 'GET' && p === '/api/admin/overview') {
        return sendJson(res, 200, db.listOverview());
      }

      if (req.method === 'POST' && p === '/api/admin/batches/suspend') {
        const body = await readBody(req);
        if (!body.batchId) return sendJson(res, 400, { error: '缺少 batchId' });
        const batch = db.suspendBatch(body.batchId, body.reason);
        return sendJson(res, 200, { ok: true, batch });
      }

      if (req.method === 'POST' && p === '/api/admin/batches/resume') {
        const body = await readBody(req);
        if (!body.batchId) return sendJson(res, 400, { error: '缺少 batchId' });
        const batch = db.resumeBatch(body.batchId);
        return sendJson(res, 200, { ok: true, batch });
      }

      if (req.method === 'POST' && p === '/api/admin/recall') {
        const body = await readBody(req);
        if (!body.code) return sendJson(res, 400, { error: '缺少 code' });
        const part = db.setRecalled(body.code, body.recalled, body.reason);
        return sendJson(res, 200, { ok: true, part });
      }

      return sendJson(res, 404, { error: '接口不存在' });
    }

    // ---------- 静态资源 ----------
    let rel = p === '/' ? '/index.html' : p;
    if (p === '/admin') rel = '/admin.html';
    const filePath = path.normalize(path.join(__dirname, 'public', rel));
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    const status = err.statusCode || 500;
    sendJson(res, status, { error: err.message || '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  console.log(`汽配条码追踪站已启动`);
  console.log(`  柜台扫码:  http://localhost:${PORT}/`);
  console.log(`  后台管理:  http://localhost:${PORT}/admin`);
  console.log(`  缓存 TTL:  ${CACHE_TTL_MS / 1000} 秒`);
});
