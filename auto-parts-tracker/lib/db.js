'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// 连续问题达到该阈值 -> 自动挂起批次
const SUSPEND_THRESHOLD = 3;

const SEED = {
  parts: [
    {
      code: 'BP-0001-01',
      name: '机油滤清器',
      brand: '马勒 MAHLE',
      models: ['大众朗逸 1.5L(2018-2024)', '大众宝来 1.5L(2019-2024)', '斯柯达明锐 1.5L(2020-2023)'],
      batchId: 'B20260701-OC110',
      location: 'A区-03排-12层-04位',
      recalled: false
    },
    {
      code: 'BP-0001-02',
      name: '机油滤清器',
      brand: '马勒 MAHLE',
      models: ['大众朗逸 1.5L(2018-2024)', '大众宝来 1.5L(2019-2024)'],
      batchId: 'B20260701-OC110',
      location: 'A区-03排-12层-04位',
      recalled: false
    },
    {
      code: 'BP-0002-01',
      name: '前刹车片（4片装）',
      brand: '博世 BOSCH',
      models: ['丰田卡罗拉 1.2T(2017-2023)', '丰田雷凌 1.2T(2017-2023)'],
      batchId: 'B20260518-BP220',
      location: 'B区-01排-05层-09位',
      recalled: false
    },
    {
      code: 'BP-0003-01',
      name: '铱金火花塞（单支）',
      brand: 'NGK',
      models: ['本田思域 1.5T(2016-2021)', '本田CR-V 1.5T(2017-2022)'],
      batchId: 'B20260309-SP330',
      location: 'A区-07排-02层-01位',
      recalled: true
    },
    {
      code: 'BP-0004-01',
      name: '空气滤清器',
      brand: '曼牌 MANN',
      models: ['日产轩逸 1.6L(2019-2024)', '日产天籁 2.0L(2018-2023)'],
      batchId: 'B20260810-AC450',
      location: 'C区-02排-08层-03位',
      recalled: false
    },
    {
      code: 'BP-0005-01',
      name: '正时皮带套装',
      brand: '盖茨 GATES',
      models: ['别克英朗 1.5L(2015-2020)', '雪佛兰科鲁兹 1.5L(2015-2019)'],
      batchId: 'B20260422-TK610',
      location: 'B区-05排-11层-02位',
      recalled: false
    }
  ],
  batches: [
    {
      id: 'B20260701-OC110',
      supplier: '上海安亭汽配供应有限公司',
      supplierContact: '供货人 王经理 138-0000-1111',
      productionDate: '2026-06-28',
      inboundDate: '2026-07-01',
      status: 'active',
      suspendedReason: '',
      suspendedAt: null,
      totalIssues: 0,
      consecutiveIssues: 0
    },
    {
      id: 'B20260518-BP220',
      supplier: '广州黄埔汽配件贸易行',
      supplierContact: '供货人 陈姐 139-0000-2222',
      productionDate: '2026-05-10',
      inboundDate: '2026-05-18',
      status: 'active',
      suspendedReason: '',
      suspendedAt: null,
      totalIssues: 0,
      consecutiveIssues: 0
    },
    {
      id: 'B20260309-SP330',
      supplier: '天津港进口汽配直供仓',
      supplierContact: '供货人 刘工 137-0000-3333',
      productionDate: '2026-02-20',
      inboundDate: '2026-03-09',
      status: 'active',
      suspendedReason: '',
      suspendedAt: null,
      totalIssues: 0,
      consecutiveIssues: 0
    },
    {
      id: 'B20260810-AC450',
      supplier: '上海安亭汽配供应有限公司',
      supplierContact: '供货人 王经理 138-0000-1111',
      productionDate: '2026-08-02',
      inboundDate: '2026-08-10',
      status: 'active',
      suspendedReason: '',
      suspendedAt: null,
      totalIssues: 0,
      consecutiveIssues: 0
    },
    {
      id: 'B20260422-TK610',
      supplier: '重庆嘉陵工业配套件公司',
      supplierContact: '供货人 赵师傅 136-0000-4444',
      productionDate: '2026-04-05',
      inboundDate: '2026-04-22',
      status: 'active',
      suspendedReason: '',
      suspendedAt: null,
      totalIssues: 0,
      consecutiveIssues: 0
    }
  ],
  issues: [],
  meta: { nextIssueId: 1 }
};

let db = null;

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    db = JSON.parse(JSON.stringify(SEED));
    persist();
  } else {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  return db;
}

function persist() {
  // 先写临时文件再 rename，保证原子性
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function getDb() {
  if (!db) init();
  return db;
}

function getPart(code) {
  return getDb().parts.find(p => p.code === String(code || '').trim());
}

function getBatch(id) {
  return getDb().batches.find(b => b.id === id);
}

/**
 * 组装扫码视图数据 + 风险判定
 * 风险级别：danger（召回/挂起） > warning（连续问题） > ok
 */
function buildScanView(part) {
  const batch = getBatch(part.batchId);
  const risks = [];
  let level = 'ok';

  if (part.recalled) {
    risks.push('该配件已被【厂家召回】，禁止出库销售，立即下架并联系供应商');
    level = 'danger';
  }
  if (batch && batch.status === 'suspended') {
    risks.push(`批次已被后台挂起：${batch.suspendedReason || '质量风险'}（挂起时间 ${batch.suspendedAt || '-'}）`);
    level = 'danger';
  }
  if (level !== 'danger' && batch && batch.consecutiveIssues > 0) {
    risks.push(`该批次近期连续出现 ${batch.consecutiveIssues} 次质量问题，出库前请重点核对`);
    level = 'warning';
  }

  return {
    code: part.code,
    name: part.name,
    brand: part.brand,
    models: part.models,
    location: part.location,
    recalled: !!part.recalled,
    batch: batch ? {
      id: batch.id,
      supplier: batch.supplier,
      supplierContact: batch.supplierContact,
      productionDate: batch.productionDate,
      inboundDate: batch.inboundDate,
      status: batch.status,
      suspendedReason: batch.suspendedReason,
      suspendedAt: batch.suspendedAt,
      totalIssues: batch.totalIssues,
      consecutiveIssues: batch.consecutiveIssues
    } : null,
    risk: { level, risks }
  };
}

/**
 * 上报问题；连续问题计数达到阈值自动挂起
 */
function addIssue({ code, type, note, source, clientTime }) {
  const part = getPart(code);
  if (!part) {
    const err = new Error('条码不存在');
    err.statusCode = 404;
    throw err;
  }
  const d = getDb();
  const batch = getBatch(part.batchId);
  const issue = {
    id: d.meta.nextIssueId++,
    code: part.code,
    partName: part.name,
    batchId: part.batchId,
    type: type || 'other',
    note: note || '',
    source: source || 'counter',
    clientTime: clientTime || null,
    serverTime: new Date().toISOString(),
    autoSuspended: false
  };
  d.issues.unshift(issue);

  if (batch) {
    batch.totalIssues += 1;
    batch.consecutiveIssues += 1;
    if (batch.status !== 'suspended' && batch.consecutiveIssues >= SUSPEND_THRESHOLD) {
      batch.status = 'suspended';
      batch.suspendedReason = `连续 ${batch.consecutiveIssues} 次质量问题，系统自动挂起`;
      batch.suspendedAt = new Date().toISOString();
      issue.autoSuspended = true;
    }
  }
  persist();
  return { issue, batch, threshold: SUSPEND_THRESHOLD };
}

function suspendBatch(batchId, reason) {
  const batch = getBatch(batchId);
  if (!batch) {
    const err = new Error('批次不存在');
    err.statusCode = 404;
    throw err;
  }
  batch.status = 'suspended';
  batch.suspendedReason = reason || '后台人工挂起';
  batch.suspendedAt = new Date().toISOString();
  persist();
  return batch;
}

function resumeBatch(batchId) {
  const batch = getBatch(batchId);
  if (!batch) {
    const err = new Error('批次不存在');
    err.statusCode = 404;
    throw err;
  }
  batch.status = 'active';
  batch.suspendedReason = '';
  batch.suspendedAt = null;
  // 恢复即解除连续告警计数；历史累计 totalIssues 保留
  batch.consecutiveIssues = 0;
  persist();
  return batch;
}

function setRecalled(code, recalled, reason) {
  const part = getPart(code);
  if (!part) {
    const err = new Error('配件条码不存在');
    err.statusCode = 404;
    throw err;
  }
  part.recalled = !!recalled;
  const d = getDb();
  d.issues.unshift({
    id: d.meta.nextIssueId++,
    code: part.code,
    partName: part.name,
    batchId: part.batchId,
    type: recalled ? 'recall-marked' : 'recall-cleared',
    note: reason || (recalled ? '后台标记召回' : '后台解除召回'),
    source: 'admin',
    clientTime: null,
    serverTime: new Date().toISOString(),
    autoSuspended: false
  });
  persist();
  return part;
}

function listOverview() {
  const d = getDb();
  return {
    parts: d.parts,
    batches: d.batches,
    issues: d.issues,
    threshold: SUSPEND_THRESHOLD
  };
}

module.exports = {
  SUSPEND_THRESHOLD,
  init,
  getPart,
  getBatch,
  buildScanView,
  addIssue,
  suspendBatch,
  resumeBatch,
  setRecalled,
  listOverview
};
