'use strict';

// Nâng cấp dữ liệu từ bản dùng tên «Ab-bank»: đơn vị được đổi tên tại chỗ thành AntibodyBank (giữ id), thiết bị kháng thể
// chưa gắn đơn vị / còn là thiết bị riêng được đưa về AntibodyBank. Chạy lại nhiều lần không đổi gì thêm (idempotent).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8');

test('đổi tên Ab-bank thành AntibodyBank và đưa thiết bị kháng thể về đơn vị này', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // giả lập dữ liệu bản cũ: đơn vị tên Ab-bank, thiết bị kháng thể Public và một thiết bị riêng
  db.prepare("UPDATE nhm_don_vi SET ma = 'ab-bank', ten = 'Ab-bank' WHERE ngan_hang = 'khang_the'").run();
  const donViCu = db.prepare("SELECT id FROM nhm_don_vi WHERE ma = 'ab-bank'").get().id;
  const loai = db.prepare('SELECT id FROM nhm_container_types LIMIT 1').get().id;
  const them = (ten, nh, extra) => db.prepare(`INSERT INTO nhm_containers (type_id, code, name, ngan_hang, ${extra.cot}) VALUES (?, ?, ?, ?, ?)`).run(loai, 'VC-' + ten, ten, nh, extra.giaTri).lastInsertRowid;
  const congKhai = them('Public KT', 'khang_the', { cot: 'don_vi_id', giaTri: null });
  const rieng = them('Riêng KT', 'khang_the', { cot: 'rieng_user_id', giaTri: 14 });
  const tebao = them('Public TB', 'te_bao', { cot: 'don_vi_id', giaTri: null });

  db.exec(SCHEMA); // khởi động lại: nâng cấp
  db.exec(SCHEMA); // lần nữa: không đổi gì

  const ab = db.prepare("SELECT id, ma, ten FROM nhm_don_vi WHERE ngan_hang = 'khang_the'").all();
  assert.deepEqual(ab.map((u) => [u.ma, u.ten]), [['antibodybank', 'AntibodyBank']]);
  assert.equal(ab[0].id, donViCu, 'đổi tên tại chỗ, giữ id');
  const lay = (id) => db.prepare('SELECT don_vi_id, quan_ly_boi, rieng_user_id FROM nhm_containers WHERE id = ?').get(id);
  assert.deepEqual(lay(congKhai), { don_vi_id: donViCu, quan_ly_boi: 'cellbank', rieng_user_id: null });
  assert.deepEqual(lay(rieng), { don_vi_id: donViCu, quan_ly_boi: 'cellbank', rieng_user_id: null });
  assert.deepEqual(lay(tebao), { don_vi_id: null, quan_ly_boi: 'cong_khai', rieng_user_id: null }, 'ngân hàng tế bào không bị đụng tới');
});
