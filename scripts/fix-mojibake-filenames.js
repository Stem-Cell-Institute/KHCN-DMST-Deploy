#!/usr/bin/env node
/**
 * scripts/fix-mojibake-filenames.js
 *
 * Sửa tên file tiếng Việt đã bị lưu sai trong CSDL (mojibake do busboy đọc
 * multipart theo latin1 — xem lib/filenames.js). Chỉ đụng vào bản ghi mà
 * decodeUploadedFilename() thực sự thay đổi được; tên đã đúng sẽ được bỏ qua.
 *
 * Cách dùng:
 *   node scripts/fix-mojibake-filenames.js            # chạy thử, KHÔNG ghi
 *   node scripts/fix-mojibake-filenames.js --apply    # ghi thật
 *   node scripts/fix-mojibake-filenames.js --db <path> [--apply]
 *
 * Chạy thử trước, đọc danh sách, thấy đúng rồi mới --apply.
 */

const path = require('path');
const Database = require('better-sqlite3');
const appPaths = require('../lib/appPaths');
const { decodeUploadedFilename } = require('../lib/filenames');

/** Cột nghi ngờ chứa tên file hiển thị. */
const NAME_COLUMN_RE = /original_name|originalFileName|ten_file|file_name|filename|ten_tai_lieu|ten_goc|scan_file_name/i;

function parseArgs(argv) {
  const out = { apply: false, db: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--db') out.db = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = args.db ? path.resolve(args.db) : appPaths.sqliteFilePath();
  console.log('CSDL : ' + dbPath);
  console.log('Chế độ: ' + (args.apply ? 'GHI THẬT (--apply)' : 'CHẠY THỬ (không ghi)'));
  console.log('');

  const db = new Database(dbPath, { readonly: !args.apply });

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((t) => t.name);

  let scanned = 0;
  let changed = 0;
  const updates = [];

  for (const table of tables) {
    let cols;
    try {
      cols = db.prepare(`PRAGMA table_info("${table}")`).all();
    } catch (_) {
      continue;
    }
    const pk = cols.find((c) => c.pk === 1);
    if (!pk) continue; // cần khoá chính để cập nhật chính xác
    const nameCols = cols.filter((c) => NAME_COLUMN_RE.test(c.name)).map((c) => c.name);
    if (!nameCols.length) continue;

    for (const col of nameCols) {
      let rows;
      try {
        rows = db
          .prepare(`SELECT "${pk.name}" AS _id, "${col}" AS _v FROM "${table}" WHERE "${col}" IS NOT NULL AND TRIM("${col}") <> ''`)
          .all();
      } catch (_) {
        continue;
      }
      for (const r of rows) {
        scanned++;
        const fixed = decodeUploadedFilename(r._v);
        if (fixed !== r._v) {
          changed++;
          updates.push({ table, col, pk: pk.name, id: r._id, from: r._v, to: fixed });
        }
      }
    }
  }

  if (!updates.length) {
    console.log(`Đã quét ${scanned} giá trị — không có tên nào cần sửa.`);
    db.close();
    return;
  }

  console.log(`Đã quét ${scanned} giá trị — ${changed} tên cần sửa:\n`);
  for (const u of updates) {
    console.log(`  ${u.table}.${u.col} #${u.id}`);
    console.log(`     cũ : ${u.from}`);
    console.log(`     mới: ${u.to}`);
  }

  if (!args.apply) {
    console.log('\nĐây là bản chạy thử. Thêm --apply để ghi thay đổi vào CSDL.');
    db.close();
    return;
  }

  const run = db.transaction((list) => {
    for (const u of list) {
      db.prepare(`UPDATE "${u.table}" SET "${u.col}" = ? WHERE "${u.pk}" = ?`).run(u.to, u.id);
    }
  });
  run(updates);
  console.log(`\nĐã cập nhật ${updates.length} bản ghi.`);
  db.close();
}

main();
