'use strict';

// Xuất một thiết bị ra Excel và nhập lại (vòng đi–về): máy A xuất, máy B (CSDL trống) nhập; nhập lại không trùng; tệp sai báo rõ.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { dungServer } = require('./helpers/nganHangServer');

let a; // máy nguồn
let b; // máy đích (CSDL trống)
let binh;

const NGAN_HANG = 'te_bao';
const gui = async (s, user, url, tep, extra = {}) => {
  const f = new FormData();
  if (tep) f.append('tep', new Blob([tep]), 'ngan-hang.xlsx');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  const res = await fetch(s.base + url, { method: 'POST', headers: { 'x-test-user': user }, body: f });
  let json = null;
  try { json = await res.json(); } catch (_) { /* không phải JSON */ }
  return { status: res.status, json };
};
const taiXuong = async (s, user, id) => {
  const res = await fetch(`${s.base}/containers/${id}/export.xlsx`, { headers: { 'x-test-user': user } });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!/spreadsheetml/.test(res.headers.get('content-type') || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* không phải JSON */ } }
  return { status: res.status, headers: res.headers, buf, json };
};
const docBang = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const sua = async (buf, fn) => { const wb = await docBang(buf); fn(wb); return Buffer.from(await wb.xlsx.writeBuffer()); };
const dem = (s, bang, dk = '1=1') => s.db.prepare(`SELECT COUNT(*) AS c FROM ${bang} WHERE ${dk}`).get().c;

test.before(async () => {
  a = await dungServer();
  b = await dungServer();
  const meta = (await a.api('manager', 'GET', '/meta')).json;
  const loaiRack = meta.containerTypes.find((t) => t.name === 'Rack').id;
  const tpl = meta.boxTemplates.find((t) => t.rows === 5 && t.cols === 5) || meta.boxTemplates[0];
  binh = (await a.api('manager', 'POST', '/containers', { name: 'Bình thử Excel', mau_tb: 'binh-ln', don_vi_id: (await a.api('manager', 'GET', '/meta')).json.donVi.find((d) => d.ten === 'Cellbank').id })).json.id;
  const r1 = (await a.api('manager', 'POST', '/containers', { name: 'Rack A', type_id: loaiRack, parent_id: binh, vi_tri: 1 })).json.id;
  const r2 = (await a.api('manager', 'POST', '/containers', { name: 'Rack B', type_id: loaiRack, parent_id: binh, vi_tri: 2 })).json.id;
  const h1 = (await a.api('manager', 'POST', '/boxes', { container_id: r1, template_id: tpl.id, name: 'Hộp đầu', vi_tri: 1, notes: 'Ghi chú hộp' })).json.ids[0];
  const h2 = (await a.api('manager', 'POST', '/boxes', { container_id: r2, rows: 5, cols: 1, vi_tri: 3 })).json.ids[0];
  const dong = (await a.api('manager', 'POST', '/cell-lines', { ma: 'HEK293', ten: 'HEK 293T', loai_sinh_vat: 'Người', mo_nguon_goc: 'Thận', dang_nuoi: 'bam_dinh', moi_truong: 'DMEM', nhiet_do_c: 37, co2_phan_tram: 5, bien_doi_gen: true, gmo_mo_ta: 'Vector pLKO', bsl: 2, du_an: 'Đề tài X', ghi_chu: 'Dòng thử' })).json.id;
  const lo = (await a.api('manager', 'POST', `/cell-lines/${dong}/lots`, { ma: 'LO-01', passage: 'P5', ngay_dong_lanh: '2024-05-06', so_te_bao_moi_ong: 1000000, moi_truong_dong: 'CryoSave' })).json.id;
  const tao = (box, r, c, ten, extra) => a.api('manager', 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: ten, chu_loai: 'can_bo', lo_id: lo, passage: 'P5', freeze_date: '2024-05-06', cell_count: 1000000, project: 'Đề tài X', ...extra });
  await tao(h1, 1, 1, 'HEK293 LO-01', {});
  await tao(h1, 2, 2, 'HEK293 LO-01', { notes: 'ống thứ hai' });
  const t3 = (await tao(h2, 4, 1, 'HEK293 hộp một cột', {})).json.id;
  await a.api('manager', 'POST', '/tubes', { box_id: h1, row_no: 5, col_no: 5, name: 'Ống không lô', chu_loai: 'can_bo' });
  assert.equal((await a.api('manager', 'POST', `/cell-lines/${dong}/qc`, { loai: 'mycoplasma', ket_qua: 'am_tinh', ngay: '2024-06-01', phuong_phap: 'PCR', ghi_chu: 'Âm tính' })).status, 201);
  a.db.prepare('UPDATE nhm_tubes SET owner_user_id = 3 WHERE id = ?').run(t3); // alice là chủ ống này
  a.db.prepare("UPDATE nhm_tubes SET status = 'checked_out' WHERE id = ?").run(t3);
});
test.after(async () => { await a.dong(); await b.dong(); });

test('xuất Excel: chỉ quản lý; đúng các trang, đúng dữ liệu; thiết bị nhiều cấp hoặc người lạ bị từ chối rõ ràng', async () => {
  assert.equal((await taiXuong(a, 'alice', binh)).status, 403);
  const x = await taiXuong(a, 'manager', binh);
  assert.equal(x.status, 200);
  assert.match(x.headers.get('content-disposition'), /attachment; filename\*=UTF-8''ngan-hang-B%C3%ACnh-th%E1%BB%AD-Excel-\d{4}-\d{2}-\d{2}\.xlsx/);
  const wb = await docBang(x.buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Hướng dẫn', 'Thiết bị', 'Rack', 'Hộp', 'Dòng tế bào', 'Lô', 'Ống', 'QC', 'Lịch sử (chỉ đọc)']);
  const dong = (ten) => { const w = wb.getWorksheet(ten); return Array.from({ length: w.rowCount - 1 }, (_, i) => w.getRow(i + 2).values.slice(1)); };
  assert.equal(dong('Thiết bị')[0][0], 'Bình thử Excel');
  assert.deepEqual(dong('Rack').map((r) => [r[0], r[1]]), [[1, 'Rack A'], [2, 'Rack B']]);
  assert.equal(dong('Hộp').length, 2);
  assert.equal(dong('Ống').length, 4);
  assert.equal(dong('Ống')[0][2], 'A1');
  assert.equal(dong('Dòng tế bào')[0][0], 'HEK293');
  assert.equal(dong('QC').length, 1);
  assert.ok(dong('Lịch sử (chỉ đọc)').length >= 4);
  assert.equal(a.auditLog.some((l) => l.action === 'nhm_container_export_xlsx'), true);

  // thiết bị có ngăn nhiều cấp: chưa xuất được
  const tu = (await a.api('manager', 'POST', '/containers', { name: 'Tủ nhiều ngăn', mau_tb: 'tu-86-dung-2-ngan' })).json.id;
  const loi = await taiXuong(a, 'manager', tu);
  assert.equal(loi.status, 400);
  assert.match(loi.json.message, /không phải Rack/);
  assert.equal((await taiXuong(a, 'manager', 99999)).status, 404);
  const ngan = (await a.api('manager', 'GET', '/tree')).json.containers.find((c) => c.parent_id === binh);
  assert.match((await taiXuong(a, 'manager', ngan.id)).json.message, /thiết bị gốc/);
});

test('nhập Excel: chỉ Admin; kiểm tra không ghi gì; ghi thật tái tạo đúng thiết bị, Rack, hộp, dòng, lô, ống, QC; nhập lại không trùng', async () => {
  const buf = (await taiXuong(a, 'manager', binh)).buf;
  assert.equal((await gui(b, 'manager', '/import/excel', buf, { ghi: '1' })).status, 403);
  assert.equal((await gui(b, 'alice', '/import/excel', buf)).status, 403);
  assert.equal((await gui(b, 'admin', '/import/excel', null)).status, 400);

  const truoc = ['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_qc'].map((t) => dem(b, t));
  const kt = await gui(b, 'admin', '/import/excel', buf);
  assert.equal(kt.status, 200);
  assert.equal(kt.json.da_ghi, false);
  assert.deepEqual([kt.json.ket_qua.ong.moi, kt.json.ket_qua.hop.moi, kt.json.ket_qua.dong.moi, kt.json.ket_qua.lo.moi, kt.json.ket_qua.qc.moi, kt.json.trong_tep.ong], [4, 2, 1, 1, 1, 4]);
  assert.deepEqual(['nhm_containers', 'nhm_boxes', 'nhm_tubes', 'nhm_dong_te_bao', 'nhm_lo', 'nhm_qc'].map((t) => dem(b, t)), truoc, 'kiểm tra không đổi gì');

  const ghi = await gui(b, 'admin', '/import/excel', buf, { ghi: '1' });
  assert.equal(ghi.status, 200);
  assert.equal(ghi.json.da_ghi, true);
  assert.equal(ghi.json.ket_qua.canhBao.length, 0, 'không có cảnh báo khi vòng đi–về sạch');
  assert.ok(b.auditLog.some((l) => l.action === 'nhm_import_excel'));

  const tb = b.db.prepare("SELECT c.*, t.name AS loai FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id WHERE c.name = 'Bình thử Excel'").get();
  assert.deepEqual([tb.loai, tb.temperature_c, tb.quan_ly_boi, tb.mau_tb, tb.ngan_hang], ['Bình nitơ lỏng', -196, 'cellbank', 'binh-ln', 'te_bao']);
  const racks = b.db.prepare('SELECT name, vi_tri FROM nhm_containers WHERE parent_id = ? ORDER BY vi_tri').all(tb.id);
  assert.deepEqual(racks.map((r) => [r.name, r.vi_tri]), [['Rack A', 1], ['Rack B', 2]]);
  const hop1 = b.db.prepare('SELECT b.* FROM nhm_boxes b JOIN nhm_containers r ON r.id = b.container_id WHERE r.parent_id = ? AND r.vi_tri = 1').get(tb.id);
  assert.deepEqual([hop1.name, hop1.notes, hop1.rows, hop1.cols, hop1.vi_tri], ['Hộp đầu', 'Ghi chú hộp', 5, 5, 1]);
  const hop2 = b.db.prepare('SELECT b.* FROM nhm_boxes b JOIN nhm_containers r ON r.id = b.container_id WHERE r.parent_id = ? AND r.vi_tri = 2').get(tb.id);
  assert.deepEqual([hop2.rows, hop2.cols, hop2.vi_tri], [5, 1, 3]);

  const dg = b.db.prepare("SELECT * FROM nhm_dong_te_bao WHERE ma = 'HEK293'").get();
  assert.deepEqual([dg.ten, dg.loai_sinh_vat, dg.dang_nuoi, dg.nhiet_do_c, dg.co2_phan_tram, dg.bien_doi_gen, dg.gmo_mo_ta, dg.bsl, dg.du_an, dg.ghi_chu], ['HEK 293T', 'Người', 'bam_dinh', 37, 5, 1, 'Vector pLKO', 2, 'Đề tài X', 'Dòng thử']);
  const lo = b.db.prepare("SELECT * FROM nhm_lo WHERE ma = 'LO-01'").get();
  assert.deepEqual([lo.dong_id, lo.passage, lo.ngay_dong_lanh, lo.so_te_bao_moi_ong, lo.moi_truong_dong], [dg.id, 'P5', '2024-05-06', 1000000, 'CryoSave']);
  const q = b.db.prepare('SELECT * FROM nhm_qc').get();
  assert.deepEqual([q.dong_id, q.loai, q.ket_qua, q.ngay, q.phuong_phap], [dg.id, 'mycoplasma', 'am_tinh', '2024-06-01', 'PCR']);

  const ong = b.db.prepare('SELECT t.*, b.vi_tri AS hop_vt FROM nhm_tubes t JOIN nhm_boxes b ON b.id = t.box_id ORDER BY t.name, t.row_no').all();
  assert.equal(ong.length, 4);
  const o2 = ong.find((t) => t.notes === 'ống thứ hai');
  assert.deepEqual([o2.row_no, o2.col_no, o2.passage, o2.freeze_date, o2.cell_count, o2.project, o2.lo_id, o2.status, o2.chu_loai], [2, 2, 'P5', '2024-05-06', 1000000, 'Đề tài X', lo.id, 'in_storage', 'can_bo']);
  const o3 = ong.find((t) => t.name === 'HEK293 hộp một cột');
  assert.deepEqual([o3.row_no, o3.col_no, o3.hop_vt, o3.status, o3.owner_user_id], [4, 1, 3, 'checked_out', 3], 'giữ trạng thái đã lấy ra và chủ mẫu theo email');
  assert.equal(ong.find((t) => t.name === 'Ống không lô').lo_id, null);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS c FROM nhm_movements WHERE note = 'Nhập từ Excel'").get().c, 4);
  assert.equal(b.db.pragma('foreign_key_check').length, 0);

  // xuất lại từ máy đích cho ra cùng dữ liệu (vòng đi–về khép kín)
  const tbB = b.db.prepare("SELECT id FROM nhm_containers WHERE name = 'Bình thử Excel'").get().id;
  const lai = await docBang((await taiXuong(b, 'manager', tbB)).buf);
  assert.equal(lai.getWorksheet('Ống').rowCount, 5);

  const hai = await gui(b, 'admin', '/import/excel', buf, { ghi: '1' });
  assert.deepEqual([hai.json.ket_qua.ong.moi, hai.json.ket_qua.dong.moi, hai.json.ket_qua.lo.moi, hai.json.ket_qua.hop.moi, hai.json.ket_qua.qc.moi, hai.json.ket_qua.thietBi.moi], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([hai.json.ket_qua.ong.coSan, hai.json.ket_qua.qc.coSan, hai.json.ket_qua.dong.coSan], [4, 1, 1]);
  assert.equal(dem(b, 'nhm_tubes'), 4);
});

test('nhập Excel: tệp sai cấu trúc báo rõ; dòng sai bị bỏ kèm cảnh báo; chủ mẫu email lạ thì người nhập làm chủ', async () => {
  const buf = (await taiXuong(a, 'manager', binh)).buf;
  const loi = async (tep) => (await gui(b, 'admin', '/import/excel', tep)).json.message;
  assert.match(await loi(Buffer.from('không phải excel')), /không phải tệp Excel/);
  assert.match(await loi(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('hỏng')])), /Không mở được/);
  assert.match(await loi(await sua(buf, (wb) => wb.removeWorksheet(wb.getWorksheet('Ống').id))), /thiếu trang «Ống»/);
  assert.match(await loi(await sua(buf, (wb) => { wb.getWorksheet('Hộp').getRow(1).getCell(5).value = 'Hàng'; })), /thiếu cột: «Số hàng»/);
  assert.match(await loi(await sua(buf, (wb) => wb.getWorksheet('Thiết bị').addRow(['Thiết bị thứ hai']))), /đúng 1 dòng/);

  const sai = await sua(buf, (wb) => {
    const ong = wb.getWorksheet('Ống');
    ong.getRow(2).getCell(5).value = 9; // cột ngoài hộp 5×5? (cột 9)
    ong.getRow(3).getCell(16).value = 'nguoila@khong-co.vn'; // chủ mẫu email lạ (cột «Chủ mẫu (email)»)
    ong.getRow(3).getCell(13).value = '06/05/2024'; // ngày dạng DD/MM/YYYY vẫn đọc được
  });
  const kq = await gui(b, 'admin', '/import/excel', sai);
  assert.equal(kq.status, 200);
  assert.ok(kq.json.ket_qua.canhBao.some((c) => /nằm ngoài hộp 5×5/.test(c)));
  assert.ok(kq.json.ket_qua.canhBao.some((c) => /nguoila@khong-co\.vn.*chưa có tài khoản/.test(c)) === false, 'ống đã có sẵn ở máy đích thì không xét lại chủ mẫu');
  assert.equal(kq.json.trong_tep.ong, 3, 'ống ngoài hộp bị bỏ');

  // máy đích mới tinh: email lạ được báo, người nhập (admin, id 1) làm chủ
  const c = await dungServer();
  try {
    const ghi = await gui(c, 'admin', '/import/excel', sai, { ghi: '1' });
    assert.equal(ghi.status, 200);
    assert.ok(ghi.json.ket_qua.canhBao.some((x) => /nguoila@khong-co\.vn.*chưa có tài khoản/.test(x)));
    const o = c.db.prepare("SELECT owner_user_id, freeze_date FROM nhm_tubes WHERE notes = 'ống thứ hai'").get();
    assert.deepEqual([o.owner_user_id, o.freeze_date], [1, '2024-05-06']);
  } finally {
    await c.dong();
  }
});
