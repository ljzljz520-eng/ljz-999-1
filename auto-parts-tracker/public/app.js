'use strict';

const $ = id => document.getElementById(id);
const TTL_FALLBACK = 5 * 60 * 1000;
const OUTBOX_KEY = 'parts.outbox';
const HISTORY_KEY = 'parts.history';

let swReg = null;
let currentCode = null;

/* ---------------- Service Worker 注册 ---------------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => { swReg = reg; }).catch(() => {});
}
function postSW(msg) {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  }
}

/* ---------------- 通用 ---------------- */
function toast(text, kind) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 网络状态 & 离线演示 ---------------- */
function updateNetBadge() {
  const demo = $('demoOffline').checked;
  const online = navigator.onLine;
  const badge = $('netBadge');
  if (demo) {
    badge.className = 'badge offline';
    $('netText').textContent = '离线演示中';
  } else if (online) {
    badge.className = 'badge online';
    $('netText').textContent = '在线';
  } else {
    badge.className = 'badge offline';
    $('netText').textContent = '已离线';
  }
}
$('demoOffline').addEventListener('change', e => {
  postSW({ type: 'DEMO_OFFLINE', value: e.target.checked });
  updateNetBadge();
  toast(e.target.checked ? '已进入离线演示：扫描走本机 TTL 缓存' : '已恢复联网', 'ok');
});
window.addEventListener('online', () => { updateNetBadge(); flushOutbox(); });
window.addEventListener('offline', updateNetBadge);
updateNetBadge();

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- 扫码主流程 ---------------- */
async function doScan() {
  const code = $('codeInput').value.trim();
  if (!code) { $('codeInput').focus(); return; }
  currentCode = code;

  try {
    const data = await apiFetch('/api/scan/' + encodeURIComponent(code));
    renderDetail(data, code);
    addHistory(code, data.name, data.risk.level, data._cache);
  } catch (err) {
    if (err.data && err.data._cache && err.data._cache.source === 'offline-none') {
      renderOfflineMiss(code);
      addHistory(code, '-', 'offline-none', err.data._cache);
    } else {
      renderError(err.message);
      addHistory(code, '-', 'error');
    }
  }
  $('codeInput').select();
  flushOutbox(); // 联网时顺手补传
}

function renderCacheNote(cache) {
  const note = $('cacheNote');
  if (!cache) { note.style.display = 'none'; return; }
  const ttlMin = Math.round(cache.ttlMs / 60000);
  if (cache.source === 'cache-fresh') {
    note.style.display = 'none';
  } else if (cache.source === 'cache-stale') {
    note.style.display = 'block';
    if (cache.expired) {
      note.style.borderStyle = 'solid';
      note.innerHTML = `⚠️ <b>离线缓存已过期</b>（有效期 ${ttlMin} 分钟，缓存于 ${fmtTime(cache.cachedAt)}）。`
        + `以下信息仅供救急参考，<b>批次挂起/召回等风险状态可能已经变化</b>，恢复联网后必须重新扫码核对！`;
    } else {
      note.style.borderStyle = 'dashed';
      note.innerHTML = `📴 当前离线，展示本机缓存（缓存于 ${fmtTime(cache.cachedAt)}，尚在 ${ttlMin} 分钟有效期内）。`;
    }
  }
}

function renderBanner(risk, cache) {
  const el = $('riskBanner');
  const icon = { ok: '✅', warning: '⚠️', danger: '🚫' }[risk.level] || '❓';
  const title = {
    ok: '核验通过：该配件状态正常，可以出库',
    warning: '注意：该批次存在连续质量问题，请人工复核后再决定是否出库',
    danger: '风险拦截：该配件禁止出库！'
  }[risk.level];
  const suffix = (cache && cache.source === 'cache-stale')
    ? '<li class="muted">本结果来自离线缓存快照，风险状态以联网后最新数据为准</li>' : '';
  el.className = 'risk-banner ' + risk.level;
  el.innerHTML = `<span class="icon">${icon}</span><div>${title}`
    + (risk.risks.length ? `<ul>${risk.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('')}${suffix}</ul>` : suffix)
    + `</div>`;
}

function renderDetail(d, code) {
  $('detailPanel').style.display = 'block';
  $('fCode').textContent = d.code;
  $('fName').textContent = `${d.name} / ${d.brand}`;
  $('fModels').innerHTML = d.models.map(m => `<span class="tag">${escapeHtml(m)}</span>`).join('');
  $('fLocation').innerHTML = `📍 ${escapeHtml(d.location)}`;
  $('fRecall').innerHTML = d.recalled
    ? '<span class="tag recall">🔴 已召回，禁止销售</span>'
    : '<span class="tag active">未召回</span>';

  const b = d.batch;
  if (b) {
    $('fBatchId').textContent = b.id;
    $('fBatchStatus').innerHTML = b.status === 'suspended'
      ? `<span class="tag suspended">⛔ 已挂起${b.suspendedReason ? '：' + escapeHtml(b.suspendedReason) : ''}</span>`
      : '<span class="tag active">正常在途</span>';
    $('fSupplier').textContent = `${b.supplier}（${b.supplierContact}）`;
    $('fProdDate').textContent = b.productionDate;
    $('fInboundDate').textContent = b.inboundDate;
    $('fIssueStats').innerHTML = `累计上报 <b>${b.totalIssues}</b> 次　|　当前连续问题 <b>${b.consecutiveIssues}</b> 次`
      + (b.status === 'suspended'
        ? `<br><span class="muted small">挂起时间：${fmtTime(b.suspendedAt)}</span>` : '');
  } else {
    $('fBatchId').textContent = '-';
    $('fSupplier').textContent = '未找到批次记录';
  }

  $('scanMeta').textContent = d._cache
    ? `来源：${d._cache.source === 'cache-fresh' ? '本地缓存（有效期内）' : '本地缓存（过期兜底）'}`
    : '来源：服务器实时数据';

  renderCacheNote(d._cache);
  renderBanner(d.risk, d._cache);
}

function renderError(msg) {
  $('detailPanel').style.display = 'none';
  $('cacheNote').style.display = 'none';
  const el = $('riskBanner');
  el.className = 'risk-banner warning';
  el.innerHTML = `<span class="icon">❓</span><div>${escapeHtml(msg)}</div>`;
}

function renderOfflineMiss(code) {
  $('detailPanel').style.display = 'none';
  const note = $('cacheNote');
  note.style.display = 'block';
  note.style.borderStyle = 'solid';
  note.innerHTML = `📴 当前离线，且本机从未缓存过条码 <b>${escapeHtml(code)}</b>，无法核验。请恢复联网后扫码。`;
  const el = $('riskBanner');
  el.className = 'risk-banner danger';
  el.innerHTML = `<span class="icon">🚫</span><div>离线且无缓存：出于风险控制，不能放行该配件</div>`;
}

/* ---------------- 问题上报 + 离线 outbox ---------------- */
function getOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; } catch { return []; }
}
function setOutbox(list) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
  renderOutboxBar();
}
function renderOutboxBar() {
  const list = getOutbox();
  const bar = $('outboxBar');
  bar.className = list.length ? 'outbox-bar show' : 'outbox-bar';
  $('outboxText').textContent = `有 ${list.length} 条问题上报暂存本机，联网后自动补传`;
}

async function reportIssue() {
  if (!currentCode) return;
  const payload = {
    code: currentCode,
    type: $('issueType').value,
    note: $('issueNote').value.trim(),
    source: 'counter',
    clientTime: new Date().toISOString()
  };

  const tryPost = async () => {
    await apiFetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  };

  try {
    await tryPost();
    toast('问题已上报到服务器', 'ok');
  } catch {
    // 离线 / 服务不可用 -> 进 outbox
    const list = getOutbox();
    list.push(payload);
    setOutbox(list);
    toast('当前离线，问题已暂存本机，联网自动补传', 'err');
  }
  $('issueNote').value = '';
  // 重新扫码刷新状态（可能触发自动挂起）
  if (navigator.onLine && !$('demoOffline').checked) doScan();
}

async function flushOutbox() {
  if ($('demoOffline').checked || !navigator.onLine) return;
  const list = getOutbox();
  if (!list.length) return;
  const remain = [];
  for (const item of list) {
    try {
      await apiFetch('/api/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
    } catch {
      remain.push(item);
    }
  }
  setOutbox(remain);
  if (!remain.length) {
    toast(`补传成功：${list.length} 条问题已同步`, 'ok');
    if (currentCode) doScan();
  }
}
$('flushBtn').addEventListener('click', flushOutbox);
setInterval(flushOutbox, 15000);
renderOutboxBar();

/* ---------------- 本机扫码历史 ---------------- */
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function addHistory(code, name, level, cache) {
  const list = getHistory();
  list.unshift({
    time: new Date().toISOString(),
    code, name,
    level: level || 'unknown',
    source: cache ? (cache.source === 'cache-fresh' ? '缓存(有效)' : '缓存(过期)') : '服务器'
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
  renderHistory();
}
const LEVEL_LABEL = {
  ok: '<span style="color:#4ade80">✅ 正常</span>',
  warning: '<span style="color:#fbbf24">⚠️ 连续问题预警</span>',
  danger: '<span style="color:#f87171">🚫 风险拦截</span>',
  'offline-none': '<span style="color:#f87171">📴 离线无缓存</span>',
  error: '<span class="muted">查询失败</span>',
  unknown: '<span class="muted">-</span>'
};
function renderHistory() {
  const list = getHistory();
  $('historyBody').innerHTML = list.length
    ? list.map(h => `<tr><td class="small">${fmtTime(h.time)}</td><td>${escapeHtml(h.code)}</td>
        <td>${escapeHtml(h.name)}</td><td>${LEVEL_LABEL[h.level] || h.level}</td>
        <td class="muted small">${h.source}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">还没有扫码记录</td></tr>';
}
renderHistory();

/* ---------------- 事件绑定（扫码枪 = 键盘流 + 回车） ---------------- */
$('scanBtn').addEventListener('click', doScan);
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doScan(); });
$('reportBtn').addEventListener('click', reportIssue);
$('issueNote').addEventListener('keydown', e => { if (e.key === 'Enter') reportIssue(); });
