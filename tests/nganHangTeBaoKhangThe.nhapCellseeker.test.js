'use strict';

// Nhập dữ liệu xuất từ Cellseeker: ánh xạ thiết bị / Rack / hộp / dòng / lô / ống, chạy thử không đổi gì, nhập lại không tạo trùng,
// vị trí ống theo hàng, xung đột với dữ liệu có sẵn, tệp đính kèm của lô.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const Nhap = require('../services/nganHangTeBaoKhangTheNhapCellseeker');

const GOC = path.join(__dirname, '..');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);

const CELLS = [
  'Cellseeker cell ID,Cell line,Private,GMO,Clone,Growth,Species,Gender,Morphology,Tissue,BSL,Supplier,Description,Temperature,CO2,Project,Catalogue number,Culture medium name,Freezing medium name,Cultivation comments',
  '6,hADSC (human Adipose tissue Derived Mesenchymal Stem Cell),false,false,,Adherent,Human,,Fibroblastic,Adipose Tissue,BSL1,SCI Cellbank,Mô tả hADSC,37.0,5.0,Đề tài A,,MSC Cult I,CryoSave Med/I/II,',
  '12,HEK 293,false,true,,Adherent,Human,Female,Epithelial,Kidney,BSL2,ATCC,,37.0,5.0,,0045,DMEM/F12,,',
  '13,hADSC-2 (bản khác),false,false,,Suspension,Mouse,,,,,,,,,,,,,',
  '14,"Dòng, có dấu phẩy (thử)",false,false,,,,,,,,,,,,,,,,',
].join('\n');
const STOCKS = [
  'Cellseeker cell ID,Lot ID,Freezing date,Batch type,Comments,Operator,Parental stock Lot ID,Status,Passage number,Volume,Aliquot,Cell count,Viability,Mycoplasma test,Active status',
  '6,HF00-2201,2022-08-25T00:00,MCB,"Dòng 1\nDòng 2 (nhiều dòng)",Vi,,UNAPPROVED,0,1.0,1000000.00,,,2022-09-01T00:00,true',
  '6,HF00-2202,2022-09-25T00:00,WCB,,,HF00-2201,UNAPPROVED,1,,,,,,false',
  '6,hf00-2201,2022-10-01T00:00,WCB,,,,UNAPPROVED,2,,,,,,true',
  '12,HK-1,2023-01-01T00:00,MCB,,,,UNAPPROVED,3,,2500000.00,,,,true',
  '99,LO-MO-COI,2023-01-01T00:00,MCB,,,,UNAPPROVED,3,,,,,,true',
].join('\n');
const INVENTORY = [
  'Tank name,Numeric rack labeling,Rack label,Box position,Box columns,Box rows',
  'BINH-A,true,1,1,5,5',
  'BINH-A,true,1,2,5,5',
  'BINH-A,true,2,1,1,5',
  'BINH-B,true,1,1,5,5',
].join('\n');
const VIALS = [
  'Tank name,Rack label,Box position,Position,Freezing date,Cellseeker cell ID,Cell line,Lot ID,Stock status,Vial status,Reserved By',
  'BINH-A,1,1,1,2022-08-25T00:00,6,hADSC,HF00-2201,,,',
  'BINH-A,1,1,7,2022-08-25T00:00,6,hADSC,HF00-2201,,,', // hộp 5 cột: ô 7 = hàng 2, cột 2
  'BINH-A,1,1,25,,6,hADSC,HF00-2202,,,', // ô cuối cùng, không có ngày đông lạnh riêng → lấy ngày của lô
  'BINH-A,1,2,3,2022-10-01T00:00,6,hADSC,hf00-2201,,,', // lô trùng mã khác hoa thường
  'BINH-A,2,1,4,2023-01-01T00:00,12,HEK 293,HK-1,,,', // hộp 1 cột × 5 hàng: ô 4 = hàng 4
  'BINH-B,1,1,2,2023-01-01T00:00,12,HEK 293,HK-1,,,',
  'BINH-A,1,1,26,,6,hADSC,HF00-2201,,,', // ngoài hộp
  'BINH-A,1,1,1,,6,hADSC,HF00-2202,,,', // trùng ô với ống đầu
  'BINH-A,1,9,1,,6,hADSC,HF00-2201,,,', // hộp không có trong inventory
  'BINH-A,1,1,2,,6,hADSC,KHONG-CO,,,', // lô không có
].join('\n');
const BO_SUNG = 'Cellseeker cell ID,Name,Amount,Unit,Catalogue number,Supplier\n6,FBS,10,%,,\n6,MSC Cult I,50,%,,SCI-CIPP\n6,hFGF,10,ng/ml,,\n';

let tmp;
let thuMuc; // thư mục xuất giả (có thư mục con như khi giải nén .zip)
let db;
let nguoi;

function dungDb() {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, fullname TEXT, email TEXT, role TEXT, password TEXT DEFAULT '', is_banned INTEGER DEFAULT 0)");
  d.prepare("INSERT INTO users (id, fullname, email, role) VALUES (1, 'Quản trị', 'qt@sci.edu.vn', 'admin')").run();
  d.exec(fs.readFileSync(path.join(GOC, 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8'));
  return d;
}
const dem = (bang, dk = '1=1') => db.prepare(`SELECT COUNT(*) AS c FROM ${bang} WHERE ${dk}`).get().c;

test.before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nhm-cs-'));
  thuMuc = path.join(tmp, 'cellseeker-export-X-2026-11-02');
  fs.mkdirSync(path.join(thuMuc, 'stock-attachments'), { recursive: true });
  fs.mkdirSync(path.join(thuMuc, 'cell-images'), { recursive: true });
  const t = (hau, nd) => fs.writeFileSync(path.join(thuMuc, `cellseeker-export-X-2026-11-02-${hau}.csv`), '﻿' + nd);
  t('cells', CELLS); t('stocks', STOCKS); t('inventory', INVENTORY); t('vials', VIALS); t('culture_medium_supplements', BO_SUNG);
  fs.writeFileSync(path.join(thuMuc, 'stock-attachments', 'stock_lot_id-HF00-2201-CB014-23.jpg'), JPG); // hậu tố sau mã lô
  fs.writeFileSync(path.join(thuMuc, 'stock-attachments', 'stock_lot_id-KHONG-CO.jpg'), JPG);
  fs.writeFileSync(path.join(thuMuc, 'stock-attachments', 'stock_lot_id-HK-1.jpg'), Buffer.from('MZ không phải ảnh'));
  fs.writeFileSync(path.join(thuMuc, 'cell-images', 'cell_id-7078-10.jpg'), JPG);
  db = dungDb();
  nguoi = 1;
});
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('đọc thư mục xuất (cả khi trỏ vào thư mục cha) và lập kế hoạch: mã dòng, lô trùng hoa thường, vị trí theo hàng, ống lỗi bị bỏ kèm cảnh báo', () => {
  const d = Nhap.docThuMuc(tmp); // trỏ vào thư mục cha vẫn tìm được thư mục xuất
  assert.equal(d.cells.length, 4);
  assert.equal(d.stocks.length, 5, 'ô có xuống dòng nằm trong dấu nháy vẫn là một dòng');
  const ke = Nhap.lapKeHoach(d);
  assert.deepEqual(ke.dong.map((x) => x.ma), ['hADSC', 'HEK 293', 'hADSC-2', 'Dòng- có dấu phẩy']);
  const hadsc = ke.dong[0];
  assert.deepEqual([hadsc.ten, hadsc.loai_sinh_vat, hadsc.dang_nuoi, hadsc.bsl, hadsc.nhiet_do_c, hadsc.du_an, hadsc.bo_sung], ['hADSC (human Adipose tissue Derived Mesenchymal Stem Cell)', 'Người', 'bam_dinh', 1, 37, 'Đề tài A', 'FBS 10%, MSC Cult I 50%, hFGF 10 ng/ml']);
  assert.match(hadsc.ghi_chu, /^\[Cellseeker #6\]\nMô tả hADSC/);
  const hek = ke.dong[1];
  assert.deepEqual([hek.bien_doi_gen, hek.bsl, hek.ma_nguon], [1, 2, '0045']);
  assert.match(hek.gmo_mo_ta, /CẦN BỔ SUNG/);
  assert.equal(ke.dong[2].dang_nuoi, 'huyen_phu');
  assert.deepEqual(ke.lo.map((l) => l.ma), ['HF00-2201', 'HF00-2202', 'hf00-2201 (2)', 'HK-1'], 'lô trùng mã khác hoa thường được đổi tên; lô của dòng không có bị bỏ');
  assert.match(ke.lo[0].ghi_chu, /^Dòng 1\nDòng 2 \(nhiều dòng\)\nLoại lô \(Cellseeker\): MCB\nNgười thực hiện: Vi/);
  assert.match(ke.lo[0].ghi_chu, /Mycoplasma thử ngày 01\/09\/2022 \(Cellseeker không ghi kết quả\)/);
  assert.equal(ke.lo[1].ghi_chu.includes('không còn hoạt động'), true);
  assert.equal(ke.lo[0].so_te_bao_moi_ong, 1000000);
  // ống: ô 7 của hộp 5 cột = hàng 2 cột 2; ô 25 = hàng 5 cột 5; hộp 1 cột × 5 hàng ô 4 = hàng 4 cột 1
  const o = (tank, rack, hop, ten) => ke.ong.find((x) => x.tank === tank && x.rack === rack && x.hop === hop && x.vi_tri === ten);
  assert.deepEqual([o('BINH-A', '1', 1, 1).row, o('BINH-A', '1', 1, 1).col], [1, 1]);
  assert.deepEqual([o('BINH-A', '1', 1, 7).row, o('BINH-A', '1', 1, 7).col], [2, 2]);
  assert.deepEqual([o('BINH-A', '1', 1, 25).row, o('BINH-A', '1', 1, 25).col], [5, 5]);
  assert.equal(o('BINH-A', '1', 1, 25).freeze_date, '2022-09-25', 'ống không có ngày đông lạnh lấy ngày của lô');
  assert.deepEqual([o('BINH-A', '2', 1, 4).row, o('BINH-A', '2', 1, 4).col], [4, 1]);
  assert.equal(ke.ong.length, 6, 'bỏ: ngoài hộp, trùng ô, hộp không có, lô không có');
  assert.equal(ke.canhBao.filter((c) => /nằm ngoài hộp|hai ống cùng ô|không có trong inventory|không có lô/.test(c)).length, 4);
  assert.ok(ke.canhBao.some((c) => /1 ảnh trong cell-images/.test(c)));
  assert.deepEqual(ke.tepLo.map((t) => [t.ten, t.lo.ma]), [['stock_lot_id-HF00-2201-CB014-23.jpg', 'HF00-2201'], ['stock_lot_id-HK-1.jpg', 'HK-1']]);
  assert.ok(ke.canhBao.some((c) => /stock_lot_id-KHONG-CO\.jpg/.test(c)));
});

test('chạy thử không đổi CSDL; ghi thật tạo thiết bị Cellbank → Rack (vị trí số) → hộp → ống kèm lịch sử «Nhập kho»', () => {
  const ke = Nhap.lapKeHoach(Nhap.docThuMuc(thuMuc));
  const truoc = ['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_movements', 'nhm_tep'].map((b) => dem(b));
  const thu = Nhap.thucThi(db, ke, { nguoiId: nguoi, ghi: false, uploadsRoot: tmp });
  assert.deepEqual([thu.thietBi.moi, thu.rack.moi, thu.hop.moi, thu.dong.moi, thu.lo.moi, thu.ong.moi], [2, 3, 4, 4, 4, 6]);
  assert.deepEqual(['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_movements', 'nhm_tep'].map((b) => dem(b)), truoc, 'chạy thử không đổi gì');
  assert.equal(fs.existsSync(path.join(tmp, 'ngan-hang')), false, 'chạy thử không ghi tệp');

  const kq = Nhap.thucThi(db, ke, { nguoiId: nguoi, ghi: true, uploadsRoot: tmp });
  assert.deepEqual([kq.thietBi.moi, kq.rack.moi, kq.hop.moi, kq.dong.moi, kq.lo.moi, kq.ong.moi, kq.tep.moi, kq.tep.boQua], [2, 3, 4, 4, 4, 6, 1, 1], 'tệp thứ hai không phải ảnh thật nên bị từ chối');

  const a = db.prepare("SELECT * FROM nhm_containers WHERE name = 'BINH-A'").get();
  assert.deepEqual([a.quan_ly_boi, a.ngan_hang, a.mau_tb, a.temperature_c, a.parent_id], ['cellbank', 'te_bao', 'binh-ln', -196, null]);
  assert.equal(a.don_vi_id, db.prepare("SELECT id FROM nhm_don_vi WHERE ma = 'cellbank'").get().id);
  assert.equal(db.prepare('SELECT t.name FROM nhm_container_types t WHERE t.id = ?').get(a.type_id).name, 'Bình nitơ lỏng');
  const racks = db.prepare('SELECT name, vi_tri FROM nhm_containers WHERE parent_id = ? ORDER BY vi_tri').all(a.id);
  assert.deepEqual(racks.map((r) => [r.name, r.vi_tri]), [['Rack 1', 1], ['Rack 2', 2]]);
  const hop2 = db.prepare('SELECT b.rows, b.cols, b.vi_tri FROM nhm_boxes b JOIN nhm_containers r ON r.id = b.container_id WHERE r.parent_id = ? AND r.vi_tri = 2').get(a.id);
  assert.deepEqual([hop2.rows, hop2.cols, hop2.vi_tri], [5, 1, 1], 'hộp 1 cột × 5 hàng');
  const ong = db.prepare("SELECT t.*, l.ma AS lo_ma FROM nhm_tubes t JOIN nhm_lo l ON l.id = t.lo_id WHERE t.name = 'hADSC HF00-2201' ORDER BY t.row_no").all();
  assert.deepEqual(ong.map((t) => [t.row_no, t.col_no]), [[1, 1], [2, 2]]);
  assert.deepEqual([ong[0].status, ong[0].chu_loai, ong[0].owner_user_id, ong[0].passage, ong[0].freeze_date, ong[0].cell_count, ong[0].volume_ml, ong[0].project], ['in_storage', 'can_bo', 1, '0', '2022-08-25', 1000000, 1, 'Đề tài A']);
  assert.equal(dem('nhm_movements', "action = 'store' AND note = 'Nhập từ Cellseeker' AND user_label = 'Quản trị'"), 6);
  assert.ok(db.prepare("SELECT 1 FROM nhm_tubes WHERE name = 'hADSC hf00-2201 (2)'").get(), 'ống của lô đã đổi tên mang tên lô mới');
  assert.equal(db.pragma('foreign_key_check').length, 0);

  // tệp đính kèm lô: ghi đúng chỗ, đúng băm, mime ảnh
  const tep = db.prepare('SELECT * FROM nhm_tep').get();
  assert.deepEqual([tep.doi_tuong, tep.mime, tep.kich_thuoc, tep.mo_ta], ['lo', 'image/jpeg', JPG.length, 'Nhập từ Cellseeker']);
  assert.ok(fs.existsSync(path.join(tmp, 'ngan-hang', ...tep.khoa.split('/'))));
  assert.equal(db.prepare('SELECT ma FROM nhm_lo WHERE id = ?').get(tep.doi_tuong_id).ma, 'HF00-2201');
});

test('nhập lại không tạo trùng bất cứ thứ gì', () => {
  const truoc = ['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_movements', 'nhm_tep'].map((b) => dem(b));
  const kq = Nhap.thucThi(db, Nhap.lapKeHoach(Nhap.docThuMuc(thuMuc)), { nguoiId: nguoi, ghi: true, uploadsRoot: tmp });
  assert.deepEqual([kq.thietBi.moi, kq.rack.moi, kq.hop.moi, kq.dong.moi, kq.lo.moi, kq.ong.moi, kq.tep.moi], [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([kq.thietBi.coSan, kq.rack.coSan, kq.hop.coSan, kq.dong.coSan, kq.lo.coSan, kq.ong.coSan, kq.tep.coSan], [2, 3, 4, 4, 4, 6, 1]);
  assert.deepEqual(['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_movements', 'nhm_tep'].map((b) => dem(b)), truoc);
});

test('xung đột với dữ liệu có sẵn: trùng mã dòng đổi mã, ô đã có mẫu khác bị bỏ qua và báo; không sửa gì có sẵn', () => {
  const d2 = dungDb();
  d2.prepare("INSERT INTO nhm_dong_te_bao (ma, ten, ghi_chu) VALUES ('hADSC', 'Dòng có sẵn của người dùng', 'không liên quan')").run();
  const loai = d2.prepare("SELECT id FROM nhm_container_types WHERE name = 'Bình nitơ lỏng'").get().id;
  const tb = d2.prepare("INSERT INTO nhm_containers (type_id, code, name, quan_ly_boi, ngan_hang) VALUES (?, 'VC-X', 'BINH-A', 'cellbank', 'te_bao')").run(loai).lastInsertRowid;
  const rack = d2.prepare("INSERT INTO nhm_containers (parent_id, type_id, code, name, vi_tri, ngan_hang) VALUES (?, ?, 'VC-Y', 'Rack tự đặt', 1, 'te_bao')").run(tb, loai).lastInsertRowid;
  const hop = d2.prepare("INSERT INTO nhm_boxes (container_id, rows, cols, code, vi_tri) VALUES (?, 5, 5, 'HOP-X', 1)").run(rack).lastInsertRowid;
  d2.prepare("INSERT INTO nhm_tubes (box_id, row_no, col_no, name, owner_user_id, created_by, chu_loai) VALUES (?, 1, 1, 'Mẫu có sẵn', 1, 1, 'can_bo')").run(hop);
  const kq = Nhap.thucThi(d2, Nhap.lapKeHoach(Nhap.docThuMuc(thuMuc)), { nguoiId: 1, ghi: true, uploadsRoot: tmp });
  assert.deepEqual([kq.thietBi.coSan, kq.rack.coSan, kq.hop.coSan], [1, 1, 1], 'dùng lại thiết bị / Rack / hộp cùng tên và vị trí số');
  assert.deepEqual([kq.ong.moi, kq.ong.boQua], [5, 1]);
  assert.ok(kq.canhBao.some((c) => /Ô BINH-A R1 hộp 1 ô 1 đã có mẫu khác/.test(c)));
  assert.ok(kq.canhBao.some((c) => /Mã dòng «hADSC» đã có trong hệ thống/.test(c)));
  assert.equal(d2.prepare("SELECT ten FROM nhm_dong_te_bao WHERE ma = 'hADSC'").get().ten, 'Dòng có sẵn của người dùng', 'không sửa dòng có sẵn');
  assert.ok(d2.prepare("SELECT 1 FROM nhm_dong_te_bao WHERE ma = 'hADSC-CS6'").get());
  assert.equal(d2.prepare("SELECT name FROM nhm_tubes WHERE box_id = ? AND row_no = 1 AND col_no = 1").get(hop).name, 'Mẫu có sẵn');
  d2.close();
});

test('lỗi rõ ràng: thiếu thư mục xuất, người nhập không tồn tại, chưa có đơn vị Cellbank', () => {
  assert.throws(() => Nhap.docThuMuc(os.tmpdir() + path.sep + 'khong-co-thu-muc-nay-' + Date.now()), /ENOENT/);
  const trong = fs.mkdtempSync(path.join(os.tmpdir(), 'nhm-cs-trong-'));
  assert.throws(() => Nhap.docThuMuc(trong), /Không thấy tệp \*-cells\.csv/);
  fs.rmSync(trong, { recursive: true, force: true });
  const ke = Nhap.lapKeHoach(Nhap.docThuMuc(thuMuc));
  assert.throws(() => Nhap.thucThi(db, ke, { nguoiId: 999, ghi: false }), /Người nhập không tồn tại/);
  const d3 = dungDb();
  d3.prepare("DELETE FROM nhm_don_vi WHERE ma = 'cellbank'").run();
  assert.throws(() => Nhap.thucThi(d3, ke, { nguoiId: 1, ghi: false }), /đơn vị quản lý «Cellbank»/);
  d3.close();
});

// ═══ Nhập qua giao diện (POST /import/cellseeker, chỉ Admin) ═══

const PizZip = require('pizzip');
const { dungServer } = require('./helpers/nganHangServer');

/** Nén thư mục xuất giả thành .zip như tệp tải từ Cellseeker (có thư mục gốc, có tệp rác .DS_Store). */
function nenZip(dir, them = {}) {
  const z = new PizZip();
  const goc = path.basename(dir) + '/';
  z.file(goc + '.DS_Store', Buffer.from('rac'));
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) for (const g of fs.readdirSync(p)) z.file(goc + f + '/' + g, fs.readFileSync(path.join(p, g)));
    else z.file(goc + f, fs.readFileSync(p));
  }
  for (const [ten, nd] of Object.entries(them)) z.file(ten, nd);
  return z.generate({ type: 'nodebuffer' });
}

test('đổi cách đếm ô sang theo cột: ô số 8 của hộp 5×5 là C2 thay vì B3', () => {
  const d = Nhap.docThuMuc(thuMuc);
  d.vials[1].Position = '8';
  const o = (kieu) => Nhap.lapKeHoach(d, { kieuDem: kieu }).ong.find((x) => x.vi_tri === 8);
  assert.deepEqual([o('hang').row, o('hang').col], [2, 3]);
  assert.deepEqual([o('cot').row, o('cot').col], [3, 2]);
  assert.equal(Nhap.lapKeHoach(d, { kieuDem: 'cot' }).kieuDem, 'cot');
  assert.ok(Nhap.lapKeHoach(Nhap.docThuMuc(thuMuc)).viDu.some((v) => v.vi_tri === 7 && v.o === 'B2'), 'có ví dụ để người dùng đối chiếu');
});

test('giải nén .zip an toàn: chỉ lấy CSV và tệp của lô, bỏ qua rác, chặn zip nén quá mức, chặn đi vòng ra ngoài thư mục tạm', () => {
  assert.throws(() => Nhap.giaiNenZip(Buffer.from('khong phai zip')), /không phải tệp \.zip/);
  assert.throws(() => Nhap.giaiNenZip(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hong')])), /Không mở được/);
  const zip = nenZip(thuMuc, { '../../thoat-cells.csv': 'x', '__MACOSX/._cells.csv': 'x' });
  assert.throws(() => Nhap.giaiNenZip(zip, { toiDaTong: 10 }), /quá lớn/);
  assert.throws(() => Nhap.giaiNenZip(zip, { toiDaMuc: 2 }), /quá nhiều mục/);
  const g = Nhap.giaiNenZip(zip);
  try {
    const co = fs.readdirSync(g.dir).sort();
    assert.ok(co.includes('stock-attachments') && co.some((f) => f.endsWith('-vials.csv')));
    assert.ok(!co.includes('.DS_Store'));
    assert.equal(fs.readdirSync(path.join(g.dir, 'stock-attachments')).length, 3);
    assert.equal(fs.existsSync(path.join(g.dir, '..', 'thoat-cells.csv')), false, 'không ghi ra ngoài thư mục tạm');
    assert.equal(Nhap.lapKeHoach(Nhap.docThuMuc(g.dir)).ong.length, 6);
  } finally {
    g.don();
  }
  assert.equal(fs.existsSync(g.dir), false, 'thư mục tạm được xóa');
});

test('POST /import/cellseeker: chỉ Admin; kiểm tra không ghi gì; ghi thật một lần, nhập lại không trùng; lỗi tệp báo rõ', async () => {
  const s = await dungServer();
  try {
    const gui = async (user, tep, extra = {}, nganHang) => {
      const f = new FormData();
      if (tep) f.append('tep', new Blob([tep]), 'cellseeker-export.zip');
      for (const [k, v] of Object.entries(extra)) f.append(k, v);
      const res = await fetch(s.base + '/import/cellseeker', { method: 'POST', headers: { 'x-test-user': user, ...(nganHang ? { 'x-ngan-hang': nganHang } : {}) }, body: f });
      let json = null;
      try { json = await res.json(); } catch (_) { /* không phải JSON */ }
      return { status: res.status, json };
    };
    const zip = nenZip(thuMuc);
    assert.equal((await gui('manager', zip, { ghi: '1' })).status, 403, 'quản lý module cũng không nhập được');
    assert.equal((await gui('alice', zip)).status, 403);
    assert.equal((await fetch(s.base + '/import/cellseeker', { method: 'POST' })).status, 401);
    assert.equal((await gui('admin', null)).status, 400);
    assert.match((await gui('admin', Buffer.from('chữ thường'))).json.message, /không phải tệp \.zip/);
    assert.match((await gui('admin', nenZip(thuMuc).subarray(0, 40))).json.message, /Không mở được|Thiếu tệp|Không thấy/);
    const trong = new PizZip(); trong.file('a/ghi-chu.txt', 'x');
    assert.match((await gui('admin', trong.generate({ type: 'nodebuffer' }))).json.message, /Không thấy tệp \*-cells\.csv/);
    assert.equal((await gui('admin', zip, {}, 'khang_the')).status, 400, 'chỉ ngân hàng tế bào');

    const dem = (b) => s.db.prepare(`SELECT COUNT(*) AS c FROM ${b}`).get().c;
    const truoc = ['nhm_containers', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_tep'].map(dem);
    const kt = await gui('admin', zip, { kieu_dem: 'hang' });
    assert.equal(kt.status, 200);
    assert.equal(kt.json.da_ghi, false);
    assert.deepEqual([kt.json.ket_qua.ong.moi, kt.json.ket_qua.dong.moi, kt.json.ket_qua.lo.moi, kt.json.trong_tep.ong, kt.json.trong_tep.hop], [6, 4, 4, 6, 4]);
    assert.ok(kt.json.vi_du.length >= 1);
    assert.deepEqual(['nhm_containers', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_tep'].map(dem), truoc, 'kiểm tra không đổi gì');
    assert.equal(s.auditLog.some((a) => a.action === 'nhm_import_cellseeker'), false);

    const ghi = await gui('admin', zip, { ghi: '1', kieu_dem: 'hang' });
    assert.equal(ghi.status, 200);
    assert.deepEqual([ghi.json.da_ghi, ghi.json.ket_qua.ong.moi, ghi.json.ket_qua.tep.moi], [true, 6, 1]);
    assert.equal(dem('nhm_tubes'), 6);
    assert.equal(s.db.prepare("SELECT owner_user_id FROM nhm_tubes LIMIT 1").get().owner_user_id, 1, 'người tạo là Admin đang nhập');
    assert.ok(s.auditLog.some((a) => a.action === 'nhm_import_cellseeker' && /4 dòng, 4 lô, 6 ống/.test(a.detail)));
    const tree = (await s.api('admin', 'GET', '/tree')).json;
    assert.ok(tree.containers.some((c) => c.name === 'BINH-A' && c.quan_ly_boi === 'cellbank'));
    const lai = await gui('admin', zip, { ghi: '1' });
    assert.deepEqual([lai.json.ket_qua.ong.moi, lai.json.ket_qua.ong.coSan, lai.json.ket_qua.dong.moi, lai.json.ket_qua.tep.coSan], [0, 6, 0, 1], 'nhập lại không trùng');
    assert.equal(dem('nhm_tubes'), 6);
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('nhm-cellseeker-')).length, 0, 'không để lại thư mục tạm');
  } finally {
    await s.dong();
  }
});
