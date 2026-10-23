'use strict';

/**
 * Nợ kỹ thuật #9 — xác định "chủ nhiệm đề tài" từ `missions.principal` (chuỗi tên, không phải
 * khóa ngoại). Chỉ test hàm thuần, không cần khởi động server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { normalizePersonName, isMissionPrincipal } = require('../services/missionOwnership');

test('chuẩn hoá tên: bỏ dấu, hoa/thường, khoảng trắng — chịu được "Thuỷ" vs "Thủy"', () => {
  assert.equal(normalizePersonName('  Đào  Thị Thanh Thuỷ '), 'dao thi thanh thuy');
  assert.equal(normalizePersonName('ĐÀO THỊ THANH THỦY'), 'dao thi thanh thuy');
  assert.equal(normalizePersonName('Đào Thị Thanh Thuỷ'), normalizePersonName('đào thị thanh thủy'));
  assert.equal(normalizePersonName(null), '');
  assert.equal(normalizePersonName(undefined), '');
  assert.equal(normalizePersonName('   '), '');
});

test('chuẩn hoá tên: dạng NFD (dấu rời) và NFC cho cùng kết quả', () => {
  const nfc = 'Nguyễn Thị Ánh';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(normalizePersonName(nfd), normalizePersonName(nfc));
});

function taoDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE cap_vien_submissions (id INTEGER PRIMARY KEY, submittedById INTEGER)');
  db.prepare('INSERT INTO cap_vien_submissions (id, submittedById) VALUES (?, ?)').run(7, 42);
  return db;
}

test('khớp tên chủ nhiệm với họ tên người dùng', () => {
  const db = taoDb();
  const m = { principal: 'Trương Châu Nhật', source_type: null, source_id: null };
  assert.equal(isMissionPrincipal(db, m, { id: 13, fullname: 'Trương Châu Nhật' }), true);
  assert.equal(isMissionPrincipal(db, m, { id: 13, fullname: 'truong chau nhat' }), true, 'không phân biệt dấu/hoa thường');
});

test('không khớp: tên khác, tên cụt, hoặc người dùng không có họ tên', () => {
  const db = taoDb();
  const m = { principal: 'Phạm Văn', source_type: null, source_id: null };
  assert.equal(isMissionPrincipal(db, m, { id: 14, fullname: 'Phạm Văn Phúc' }), false, 'không so khớp một phần');
  assert.equal(isMissionPrincipal(db, m, { id: 1, fullname: 'Nguyễn Trường Sinh' }), false);
  assert.equal(isMissionPrincipal(db, m, { id: 2, fullname: '' }), false);
  assert.equal(isMissionPrincipal(db, m, { id: 2, fullname: null }), false);
  assert.equal(isMissionPrincipal(db, { principal: '', source_type: null }, { id: 2, fullname: '' }), false, 'hai chuỗi rỗng KHÔNG được coi là khớp');
  assert.equal(isMissionPrincipal(db, { principal: null }, { id: 2, fullname: null }), false);
});

test('đề tài cấp Viện: người nộp hồ sơ là chủ nhiệm, kể cả khi tên không khớp', () => {
  const db = taoDb();
  const m = { principal: 'Tên Gõ Khác Hẳn', source_type: 'cap_vien', source_id: 7 };
  assert.equal(isMissionPrincipal(db, m, { id: 42, fullname: 'Người Nộp Hồ Sơ' }), true);
  assert.equal(isMissionPrincipal(db, m, { id: 43, fullname: 'Người Khác' }), false);
});

test('thiếu mission hoặc user thì không phải chủ nhiệm (không ném lỗi)', () => {
  const db = taoDb();
  assert.equal(isMissionPrincipal(db, null, { id: 1, fullname: 'A' }), false);
  assert.equal(isMissionPrincipal(db, { principal: 'A' }, null), false);
});
