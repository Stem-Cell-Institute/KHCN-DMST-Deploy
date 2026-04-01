/**
 * Import SCImago Journal Rank CSV vào bảng journal_metrics.
 *
 * Usage:
 *   node scripts/import-sjr-csv.js --file=./data/scimagojr2024.csv --year=2024
 *
 * Dùng chung logic với API POST /api/admin/sjr-csv-import (lib/sjr-csv-import.js).
 * DB: theo .env / lib/db-bridge (SQLite, Turso local, Turso remote).
 */

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}

const db = require(path.join(__dirname, '..', 'lib', 'db-bridge'));
const { importScimagoCsvToJournalMetrics } = require(path.join(__dirname, '..', 'lib', 'sjr-csv-import'));

function parseArgs(argv) {
  const out = { file: null, year: null };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--file=(.+)$/);
    if (m) out.file = m[1].trim();
    const y = a.match(/^--year=(\d{4})$/);
    if (y) out.year = parseInt(y[1], 10);
  }
  return out;
}

async function main() {
  const { file: fileArg, year: yearArg } = parseArgs(process.argv);
  if (!fileArg || !yearArg) {
    console.error('Thiếu tham số. Ví dụ: node scripts/import-sjr-csv.js --file=./data/scimagojr2024.csv --year=2024');
    process.exit(1);
  }

  const root = path.join(__dirname, '..');
  const csvPath = path.isAbsolute(fileArg) ? fileArg : path.join(root, fileArg);
  if (!fs.existsSync(csvPath)) {
    console.error('Không tìm thấy file:', csvPath);
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, 'utf8');
  const result = await importScimagoCsvToJournalMetrics(db, csvText, yearArg);

  console.log('--- Hoàn tất import SJR ---');
  console.log(`Thành công: ${result.ok}`);
  console.log(`Thất bại / bỏ qua: ${result.fail}`);
  console.log(`Tổng dòng CSV: ${result.total}`);
  if (result.errors && result.errors.length) {
    console.log('Một số lỗi/ghi chú:');
    result.errors.slice(0, 20).forEach((line) => console.log(' ', line));
    if (result.errors.length > 20) console.log(`  … và ${result.errors.length - 20} dòng khác`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
