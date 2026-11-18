/**
 * Điểm vào hạ tầng ký số MySign: MỘT bộ ký số cho mỗi CSDL, để mọi module (và routes/mysign.js) dùng chung
 * bảng, phiên đăng nhập MySign và các nguồn đã đăng ký.
 */

const path = require('path');
const { taoMySign } = require('./client');
const { taoKySo } = require('./kySo');

const theoDb = new WeakMap();

/** @param {{db:object, uploadsRoot:string}} p */
function kySoChung({ db, uploadsRoot }) {
  if (!theoDb.has(db)) theoDb.set(db, taoKySo({ db, mysign: taoMySign(), thuMuc: path.join(uploadsRoot, 'mysign') }));
  return theoDb.get(db);
}

module.exports = { kySoChung };
