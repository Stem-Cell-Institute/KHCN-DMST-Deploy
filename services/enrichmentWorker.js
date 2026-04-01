/**
 * Worker nền: enrich tự động theo chu kỳ (setInterval, không queue ngoài).
 */

const path = require('path');
const enrichService = require(path.join(__dirname, 'enrichmentService.js'));
const { sqlEligibleForEnrichWhere } = enrichService;

let isRunning = false;
let workerInterval = null;
const INTERVAL_MS = 30000;
const BATCH_SIZE = 10;

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db-bridge'));
}

async function dbAll(db, sql, params = []) {
  const out = db.prepare(sql).all(...params);
  return out instanceof Promise ? await out : out;
}

async function runOneCycle() {
  if (isRunning) return;
  isRunning = true;
  try {
    const db = getDb();
    const rows = await dbAll(
      db,
      `SELECT id FROM publications WHERE ${sqlEligibleForEnrichWhere()} ORDER BY id LIMIT ?`,
      [BATCH_SIZE]
    );
    if (!rows || rows.length === 0) return;

    const ids = rows.map((r) => r.id);
    const stats = await enrichService.enrichPublicationBatch(ids);
    console.log(
      `[EnrichWorker] Chu kỳ xong: ${stats.success} enrich, ${stats.failed} lỗi`
    );
  } catch (e) {
    console.error('[EnrichWorker]', e.message || e);
  } finally {
    isRunning = false;
  }
}

function startWorker() {
  if (workerInterval != null) return;
  workerInterval = setInterval(() => {
    runOneCycle();
  }, INTERVAL_MS);
  runOneCycle();
  console.log('[EnrichWorker] Đã khởi động, chu kỳ 30s');
}

function stopWorker() {
  if (workerInterval != null) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

function getWorkerStatus() {
  return {
    isRunning,
    intervalMs: INTERVAL_MS,
    batchSize: BATCH_SIZE,
  };
}

module.exports = {
  startWorker,
  stopWorker,
  getWorkerStatus,
};
