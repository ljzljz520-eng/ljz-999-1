'use strict';
const $ = id => document.getElementById(id);

function toast(text, kind) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 2600);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(iso) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-';
}
const ISSUE_TYPE_LABEL = {
  quality: '质量缺陷', package: '包装破损', wrong: '型号不符',
  fake: '疑似假货', other: '其他问题',
  'recall-marked': '标记召回', 'recall-cleared': '解除召回'
};

let overview = null;

async function load() {
  try {
    const res = await fetch('/api/admin/overview');
    overview = await res.json();
    render();
    setNet(true);
  } catch {
    setNet(false);
    toast('加载失败：后台需要联网访问服务器数据', 'err');
  }
}

function setNet(online) {
  $('netBadge').className = 'badge ' + (online ? 'online' : 'offline');
  $('netText').textContent = online ? '在线' : '离线';
}
window.addEventListener('online', load);
window.addEventListener('offline', () => setNet(false));

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `操作失败 (${res.status})`);
  return data;
}

async function suspend(batchId) {
  const reason = prompt('挂起原因（柜台扫码时将直接显示该提示）：', '人工质量复核，暂停出库');
  if (reason === null) return;
  try {
    await postJSON('/api/admin/batches/suspend', { batchId, reason });
    toast('批次已挂起，柜台再扫码将直接红色拦截', 'ok');
    load();
  } catch (e) { toast(e.message, 'err'); }
}

async function resume(batchId) {
  if (!confirm('确认恢复该批次？连续问题计数将清零（历史累计保留）。')) return;
  try {
    await postJSON('/api/admin/batches/resume', { batchId });
    toast('批次已恢复', 'ok');
    load();
  } catch (e) { toast(e.message, 'err'); }
}

async function toggleRecall(part) {
  const next = !part.recalled;
  let reason = '';
  if (next) {
    reason = prompt('召回原因：', '厂家通报缺陷召回') || '';
    if (reason === '') return;
  } else if (!confirm('确认解除该配件的召回标记？')) return;
  try {
    await postJSON('/api/admin/recall', { code: part.code, recalled: next, reason });
    toast(next ? '已标记召回，柜台扫码将拦截' : '召回标记已解除', 'ok');
    load();
  } catch (e) { toast(e.message, 'err'); }
}

function render() {
  const partsByBatch = {};
  overview.parts.forEach(p => {
    (partsByBatch[p.batchId] = partsByBatch[p.batchId] || []).push(p);
  });

  // 批次表
  $('batchBody').innerHTML = overview.batches.map(b => {
    const suspended = b.status === 'suspended';
    const parts = partsByBatch[b.id] || [];
    return `<tr>
      <td><b>${escapeHtml(b.id)}</b><br>
        <span class="muted small">${parts.length} 个配件条码</span></td>
      <td>${escapeHtml(b.supplier)}<br><span class="muted small">${escapeHtml(b.supplierContact)}</span></td>
      <td class="small">产 ${escapeHtml(b.productionDate)}<br>入 ${escapeHtml(b.inboundDate)}</td>
      <td>${suspended
        ? '<span class="tag suspended">⛔ 已挂起</span>'
        : '<span class="tag active">正常</span>'}</td>
      <td>${b.totalIssues} / <b style="${b.consecutiveIssues >= overview.threshold ? 'color:#f87171' : ''}">${b.consecutiveIssues}</b>
        <div class="muted small">阈值 ${overview.threshold} 自动挂起</div></td>
      <td class="small">${suspended ? escapeHtml(b.suspendedReason) + `<br><span class="muted">${fmt(b.suspendedAt)}</span>` : '—'}</td>
      <td>${suspended
        ? `<button class="sm ok" onclick="resume('${encodeURIComponent(b.id)}')">恢复</button>`
        : `<button class="sm danger" onclick="suspend('${encodeURIComponent(b.id)}')">挂起</button>`}</td>
    </tr>`;
  }).join('');

  // 配件表
  $('partBody').innerHTML = overview.parts.map(p => `
    <tr>
      <td><b>${escapeHtml(p.code)}</b></td>
      <td>${escapeHtml(p.name)}<br><span class="muted small">${escapeHtml(p.brand)}</span></td>
      <td class="small">${escapeHtml(p.batchId)}</td>
      <td class="small">${escapeHtml(p.location)}</td>
      <td>${p.recalled ? '<span class="tag recall">已召回</span>' : '<span class="muted small">否</span>'}</td>
      <td><button class="sm ${p.recalled ? 'ok' : 'danger'}" onclick='toggleRecall(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        ${p.recalled ? '解除召回' : '标记召回'}</button></td>
    </tr>`).join('');

  // 问题流水
  $('issueBody').innerHTML = overview.issues.length ? overview.issues.map(i => `
    <tr>
      <td>${i.id}</td>
      <td class="small">${fmt(i.serverTime)}</td>
      <td><b>${escapeHtml(i.code)}</b><br><span class="muted small">${escapeHtml(i.partName)}</span></td>
      <td class="small">${escapeHtml(i.batchId)}</td>
      <td>${ISSUE_TYPE_LABEL[i.type] || escapeHtml(i.type)}</td>
      <td class="small">${escapeHtml(i.note) || '—'}</td>
      <td class="small">${i.source === 'counter' ? '柜台' : '后台'}</td>
      <td>${i.autoSuspended ? '<span class="tag suspended">触发自动挂起</span>' : ''}</td>
    </tr>`).join('')
    : '<tr><td colspan="8" class="empty">暂无问题上报</td></tr>';
}

window.suspend = suspend;
window.resume = resume;
window.toggleRecall = toggleRecall;

load();
setInterval(load, 10000);
