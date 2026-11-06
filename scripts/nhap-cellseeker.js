#!/usr/bin/env node
'use strict';

/**
 * scripts/nhap-cellseeker.js — nhập dữ liệu xuất từ Cellseeker vào Ngân hàng Tế bào.
 *
 *   node scripts/nhap-cellseeker.js <thư-mục-giải-nén> [--db data/sci-ace.db] [--nguoi-nhap <email|id>] [--uploads <thư-mục>] [--ghi]
 *
 * Mặc định CHỈ CHẠY THỬ: làm hết các bước trong một giao dịch rồi hủy, in báo cáo (số lượng mới / đã có / bỏ qua, cảnh báo) mà không đổi gì.
 * Thêm --ghi để ghi thật; trước khi ghi, tự sao lưu CSDL thành «<tên>.truoc-cellseeker-<thời gian>.bak» cạnh tệp CSDL.
 * Nhập lại nhiều lần được (không tạo trùng, không sửa / xóa dữ liệu có sẵn). Nên chạy lúc ít người dùng.
 *
 * --nguoi-nhap: tài khoản ghi là người tạo thiết bị / dòng / lô / mẫu (mặc định: tài khoản admin đầu tiên).
 * --uploads: thư mục gốc chứa uploads (mặc định theo lib/appPaths); tệp đính kèm lô nằm ở <uploads>/ngan-hang/.
 * Chi tiết ánh xạ và giả định: services/nganHangTeBaoKhangTheNhapCellseeker.js, readme/MODULE-NGAN-HANG-TE-BAO-KHANG-THE.md.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const NhapCs = require('../services/nganHangTeBaoKhangTheNhapCellseeker');
const khoiTao = require('../services/nganHangTeBaoKhangTheKhoiTao');

function doiSo(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ghi') out.ghi = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main() {
  const a = doiSo(process.argv.slice(2));
  if (!a._[0]) {
    console.error('Cách dùng: node scripts/nhap-cellseeker.js <thư-mục-giải-nén> [--db data/sci-ace.db] [--nguoi-nhap <email|id>] [--uploads <thư-mục>] [--ghi]');
    process.exit(2);
  }
  const duongDb = path.resolve(a.db || path.join(__dirname, '..', 'data', 'sci-ace.db'));
  if (!fs.existsSync(duongDb)) { console.error('Không thấy tệp CSDL: ' + duongDb); process.exit(2); }

  const du = NhapCs.docThuMuc(a._[0]);
  const ke = NhapCs.lapKeHoach(du);
  console.log(`Đọc từ: ${du.goc}`);
  console.log(`Kế hoạch: ${ke.thietBi.length} thiết bị, ${ke.thietBi.reduce((n, t) => n + t.rack.length, 0)} Rack, ${ke.thietBi.reduce((n, t) => n + t.rack.reduce((m, r) => m + r.hop.length, 0), 0)} hộp, ${ke.dong.length} dòng, ${ke.lo.length} lô, ${ke.ong.length} ống, ${ke.tepLo.length} tệp.`);

  if (a.ghi) {
    // gom WAL vào tệp chính rồi chép để bản sao lưu đủ dữ liệu
    const tam = new Database(duongDb);
    tam.pragma('wal_checkpoint(TRUNCATE)');
    tam.close();
    const dau = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const sao = `${duongDb}.truoc-cellseeker-${dau}.bak`;
    fs.copyFileSync(duongDb, sao);
    console.log('Đã sao lưu CSDL: ' + sao);
  }

  const db = new Database(duongDb);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 15000');
  try {
    khoiTao.ensureSchema(db); // CSDL cũ thiếu cột / bảng mới thì bổ sung trước
    let nguoi;
    if (a['nguoi-nhap']) nguoi = /^\d+$/.test(a['nguoi-nhap']) ? db.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(a['nguoi-nhap'])) : db.prepare('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)').get(a['nguoi-nhap']);
    else nguoi = db.prepare("SELECT id, email FROM users WHERE LOWER(COALESCE(role, '')) = 'admin' AND COALESCE(is_banned, 0) = 0 ORDER BY id LIMIT 1").get();
    if (!nguoi) { console.error('Không tìm thấy tài khoản người nhập (dùng --nguoi-nhap <email|id>).'); process.exit(2); }
    console.log(`Người nhập: ${nguoi.email} (id ${nguoi.id})`);

    let uploads = a.uploads;
    if (!uploads) uploads = require('../lib/appPaths').uploadsRoot();
    const kq = NhapCs.thucThi(db, ke, { nguoiId: nguoi.id, ghi: !!a.ghi, uploadsRoot: path.resolve(uploads) });

    const dong = (ten, x) => console.log(`  ${ten.padEnd(12)} mới ${String(x.moi).padStart(4)} · đã có ${String(x.coSan).padStart(4)}${x.boQua != null ? ' · bỏ qua ' + x.boQua : ''}`);
    console.log(a.ghi ? '\nKẾT QUẢ (đã ghi):' : '\nKẾT QUẢ CHẠY THỬ (chưa ghi gì):');
    dong('Thiết bị', kq.thietBi); dong('Rack', kq.rack); dong('Hộp', kq.hop); dong('Dòng tế bào', kq.dong); dong('Lô', kq.lo); dong('Ống', kq.ong); dong('Tệp lô', kq.tep);
    if (kq.canhBao.length) {
      console.log(`\nCẢNH BÁO (${kq.canhBao.length}):`);
      kq.canhBao.slice(0, 60).forEach((c) => console.log('  - ' + c));
      if (kq.canhBao.length > 60) console.log(`  … và ${kq.canhBao.length - 60} cảnh báo nữa.`);
    }
    if (!a.ghi) console.log('\nĐây mới là chạy thử. Thêm --ghi để ghi thật.');
  } finally {
    db.close();
  }
}

main();
