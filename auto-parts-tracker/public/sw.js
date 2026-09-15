'use strict';
/* 汽配条码追踪 - Service Worker
 * 策略：
 *  - GET /api/scan/* : stale-while-revalidate + TTL。在线且缓存新鲜直接用缓存；
 *    过期则尝试网络，离线时用过期缓存兜底但明确标记 expired。
 *  - 静态页面/脚本   : 网络优先，失败回退缓存（保证应用壳离线可开）
 */
const SCAN_CACHE = 'parts-scan-v1';
const SHELL_CACHE = 'parts-shell-v1';
const DEFAULT_TTL = 5 * 60 * 1000;

// 离线演示开关：由柜台页通过 postMessage 控制，不影响系统真实网络
let demoOffline = false;
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'DEMO_OFFLINE') demoOffline = !!event.data.value;
});
function netFetch(req) {
  return demoOffline ? Promise.reject(new Error('demo offline')) : fetch(req);
}

async function cacheScan(req, response) {
  const clone = response.clone();
  const data = await clone.json();
  const ttl = Number(response.headers.get('X-Cache-TTL')) || DEFAULT_TTL;
  const entry = {
    url: req.url,
    body: data,
    cachedAt: Date.now(),
    ttl,
    serverTime: response.headers.get('X-Server-Time') || null
  };
  const cache = await caches.open(SCAN_CACHE);
  // 以 URL 为 key 存自定义 JSON
  await cache.put(req.url, new Response(JSON.stringify(entry), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function readScanCache(req) {
  const cache = await caches.open(SCAN_CACHE);
  const hit = await cache.match(req.url);
  if (!hit) return null;
  return JSON.parse(await hit.text());
}

/** 给页面返回一个 Response，body 中附带 _cache 来源信息 */
function respondWithView(entry, source) {
  const age = Date.now() - entry.cachedAt;
  const expired = age > entry.ttl;
  const body = {
    ...entry.body,
    _cache: {
      source,                 // 'cache-fresh' | 'cache-stale'
      cachedAt: new Date(entry.cachedAt).toISOString(),
      ttlMs: entry.ttl,
      ageMs: age,
      expired,
      serverTime: entry.serverTime
    }
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 扫码接口：TTL 缓存
  if (url.pathname.startsWith('/api/scan/')) {
    event.respondWith((async () => {
      const cached = await readScanCache(req);
      const fresh = cached && (Date.now() - cached.cachedAt) <= cached.ttl;

      if (cached && fresh) {
        // 后台静默更新
        netFetch(req).then(r => { if (r.ok) cacheScan(req, r); }).catch(() => {});
        return respondWithView(cached, 'cache-fresh');
      }

      try {
        const res = await netFetch(req);
        if (res.ok) await cacheScan(req, res);
        return res;
      } catch (netErr) {
        // 离线 / 网络故障：有缓存就兜底（无论是否过期）
        if (cached) return respondWithView(cached, 'cache-stale');
        return new Response(JSON.stringify({
          error: '当前离线，且本地没有该条码的缓存',
          _cache: { source: 'offline-none' }
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // 管理接口不缓存（POST 已在上面过滤，GET /api/admin/* 走网络）
  if (url.pathname.startsWith('/api/')) return;

  // 应用外壳：网络优先，失败回退缓存
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      const cache = await caches.open(SHELL_CACHE);
      cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await caches.match(req);
      if (hit) return hit;
      // 导航请求兜底到首页
      if (req.mode === 'navigate') {
        const fallback = await caches.match('./');
        if (fallback) return fallback;
      }
      return new Response('离线且无缓存', { status: 503 });
    }
  })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SCAN_CACHE && k !== SHELL_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
