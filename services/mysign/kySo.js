/**
 * Hạ tầng ký số MySign dùng chung cho các module (báo cáo phòng ban là nơi dùng đầu tiên).
 *
 *   - Liên kết tài khoản: mỗi người dùng lưu MÃ TÀI KHOẢN MySign của mình một lần (mysign_tai_khoan). Khi liên kết,
 *     hệ thống gọi MySign lấy chứng thư số để chắc tài khoản dùng được và hiện tên / hạn chứng thư cho người dùng.
 *   - Giao dịch ký (mysign_giao_dich): một lần xác nhận trên điện thoại, ký MỘT hoặc NHIỀU tài liệu PDF (mysign_tai_lieu).
 *     Mỗi tài liệu thuộc một "nguồn" (vd. bao_cao_phong + id báo cáo). PDF chờ ký và PDF đã ký nằm trên đĩa
 *     (<uploads>/mysign/<giao dịch>/), CSDL chỉ giữ đường dẫn — chạy được cả SQLite lẫn Turso.
 *   - Module dùng hạ tầng đăng ký một nguồn: dangKyNguon('bao_cao_phong', { khiThanhCong }) — được gọi TRONG giao dịch
 *     CSDL khi chữ ký về, để ghi kết quả nghiệp vụ (vd. "Viện trưởng duyệt") cùng lúc với việc đánh dấu đã ký.
 *
 * Trạng thái được cập nhật khi có người hỏi (capNhat), không có tiến trình chạy nền: giao diện hỏi vài giây một lần
 * trong lúc chờ, và yêu cầu nào bị bỏ dở sẽ được hỏi lại ở lần mở trang sau.
 */

const fs = require('fs');
const path = require('path');
const Pades = require('./pades');
const { LoiMySign } = require('./client');

/** Quá thời gian này mà MySign vẫn báo "đang chờ" thì coi như hết hạn (MySign thường tự hết hạn sớm hơn nhiều). */
const CHO_TOI_DA_MS = 30 * 60 * 1000;

const CAU_LENH = [
  `CREATE TABLE IF NOT EXISTS mysign_tai_khoan (
    user_id INTEGER PRIMARY KEY,
    mysign_user_id TEXT NOT NULL,
    credential_id TEXT,
    chu_the TEXT,
    het_han TEXT,
    so_dien_thoai TEXT,
    cap_nhat_luc TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS mysign_giao_dich (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mysign_user_id TEXT NOT NULL,
    nguon TEXT NOT NULL,
    transaction_id TEXT,
    trang_thai TEXT NOT NULL DEFAULT 'cho_xac_nhan'
      CHECK (trang_thai IN ('cho_xac_nhan','thanh_cong','tu_choi','het_han','loi')),
    ma_trang_thai TEXT,
    thong_diep TEXT,
    chuoi_json TEXT,
    chu_the TEXT,
    tao_luc TEXT NOT NULL,
    xong_luc TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS mysign_tai_lieu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giao_dich_id INTEGER NOT NULL REFERENCES mysign_giao_dich(id),
    thu_tu INTEGER NOT NULL,
    nguon TEXT NOT NULL,
    nguon_id INTEGER NOT NULL,
    ten TEXT,
    meta_json TEXT,
    tep_cho TEXT,
    thuoc_tinh_ky TEXT,
    tep_da_ky TEXT,
    sha256 TEXT,
    trang_thai TEXT NOT NULL DEFAULT 'cho' CHECK (trang_thai IN ('cho','da_ky','huy')),
    ky_luc TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS ix_mysign_tai_lieu_nguon ON mysign_tai_lieu(nguon, nguon_id)',
  'CREATE INDEX IF NOT EXISTS ix_mysign_tai_lieu_gd ON mysign_tai_lieu(giao_dich_id)',
];

/**
 * @param {{db:object, mysign:object, thuMuc:string}} p  thuMuc: nơi lưu PDF (vd. <uploads>/mysign)
 */
function taoKySo({ db, mysign, thuMuc }) {
  for (const sql of CAU_LENH) db.exec(sql);
  const nguon = new Map();
  const dangXuLy = new Set(); // id giao dịch đang được hoàn tất trong tiến trình này

  const tep = (rel) => path.join(thuMuc, rel);
  function ghiTep(rel, buf) {
    fs.mkdirSync(path.dirname(tep(rel)), { recursive: true });
    fs.writeFileSync(tep(rel), buf);
  }

  const taiKhoan = (userId) => db.prepare('SELECT * FROM mysign_tai_khoan WHERE user_id = ?').get(userId) || null;

  function luuChungThu(userId, mysignUserId, ct) {
    db.prepare(
      `INSERT INTO mysign_tai_khoan (user_id, mysign_user_id, credential_id, chu_the, het_han, so_dien_thoai, cap_nhat_luc)
       VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET mysign_user_id = excluded.mysign_user_id, credential_id = excluded.credential_id,
         chu_the = excluded.chu_the, het_han = excluded.het_han, so_dien_thoai = excluded.so_dien_thoai, cap_nhat_luc = excluded.cap_nhat_luc`
    ).run(userId, mysignUserId, ct.credential_id, ct.chu_the, ct.het_han, ct.so_dien_thoai);
  }

  /** Liên kết (hoặc đổi) tài khoản MySign. Chỉ lưu khi MySign xác nhận tài khoản có chứng thư số dùng được. */
  async function lienKet(userId, mysignUserId) {
    const ct = await mysign.chungThu(mysignUserId);
    luuChungThu(userId, mysignUserId, ct);
    return taiKhoan(userId);
  }

  function dangChoCuaNguoi(userId) {
    return db.prepare("SELECT id FROM mysign_giao_dich WHERE user_id = ? AND trang_thai = 'cho_xac_nhan'").get(userId) || null;
  }

  function huyLienKet(userId) {
    if (dangChoCuaNguoi(userId)) throw new LoiMySign('Đang có yêu cầu ký chờ xác nhận. Hãy xác nhận hoặc từ chối trên MySign trước.');
    db.prepare('DELETE FROM mysign_tai_khoan WHERE user_id = ?').run(userId);
  }

  function dangKyNguon(ten, xuLy) {
    nguon.set(ten, xuLy);
  }

  /** Tài liệu của một đối tượng nghiệp vụ trong giao dịch còn đang chờ (để không gửi trùng yêu cầu ký). */
  function dangCho(tenNguon, nguonId) {
    return (
      db
        .prepare(
          `SELECT g.id, g.tao_luc, g.user_id FROM mysign_tai_lieu t JOIN mysign_giao_dich g ON g.id = t.giao_dich_id
            WHERE t.nguon = ? AND t.nguon_id = ? AND g.trang_thai = 'cho_xac_nhan' ORDER BY g.id DESC LIMIT 1`
        )
        .get(tenNguon, nguonId) || null
    );
  }

  /** Bản đã ký mới nhất của một đối tượng nghiệp vụ. */
  function banDaKy(tenNguon, nguonId) {
    return (
      db
        .prepare(
          `SELECT t.*, g.chu_the, g.user_id FROM mysign_tai_lieu t JOIN mysign_giao_dich g ON g.id = t.giao_dich_id
            WHERE t.nguon = ? AND t.nguon_id = ? AND t.trang_thai = 'da_ky' ORDER BY t.id DESC LIMIT 1`
        )
        .get(tenNguon, nguonId) || null
    );
  }

  const docTep = (rel) => fs.readFileSync(tep(rel));

  /**
   * Gửi yêu cầu ký. Mỗi tài liệu tự dựng PDF có chỗ chừa chữ ký (taoPdfCho) — dựng SAU khi lấy chứng thư để
   * thuộc tính ký gắn đúng chứng thư sẽ ký.
   * @param {{userId:number, nguon:string, moTa:string, taiLieu:{nguonId:number, ten:string, meta?:object, taoPdfCho:()=>Promise<Buffer>}[]}} p
   * @returns {Promise<object>} giao dịch (như giaoDich())
   */
  async function batDau({ userId, nguon: tenNguon, moTa, taiLieu }) {
    if (!nguon.has(tenNguon)) throw new Error('Nguồn ký số chưa đăng ký: ' + tenNguon);
    if (!mysign.daCauHinh()) throw new LoiMySign('Hệ thống chưa được cấu hình chữ ký số MySign.');
    const tk = taiKhoan(userId);
    if (!tk) {
      const e = new LoiMySign('Bạn chưa liên kết tài khoản MySign.');
      e.ma = 'chua_lien_ket';
      throw e;
    }
    const ct = await mysign.chungThu(tk.mysign_user_id);
    luuChungThu(userId, tk.mysign_user_id, ct);

    const chuanBi = [];
    for (const t of taiLieu) {
      const { pdf, noiDung } = Pades.chuanBi(await t.taoPdfCho());
      const tt = Pades.thuocTinhKy({ noiDung, chungThu: ct.chuoi[0] });
      chuanBi.push({ ...t, pdf, tt });
    }

    const luc = new Date().toISOString();
    let gdId;
    const tlIds = [];
    db.transaction(() => {
      gdId = Number(
        db
          .prepare(
            `INSERT INTO mysign_giao_dich (user_id, mysign_user_id, nguon, chuoi_json, chu_the, tao_luc) VALUES (?,?,?,?,?,?)`
          )
          .run(userId, tk.mysign_user_id, tenNguon, JSON.stringify(ct.chuoi.map((b) => b.toString('base64'))), ct.chu_the, luc).lastInsertRowid
      );
      chuanBi.forEach((t, i) => {
        const id = Number(
          db
            .prepare(
              `INSERT INTO mysign_tai_lieu (giao_dich_id, thu_tu, nguon, nguon_id, ten, meta_json, thuoc_tinh_ky) VALUES (?,?,?,?,?,?,?)`
            )
            .run(gdId, i, tenNguon, t.nguonId, t.ten, JSON.stringify(t.meta || {}), t.tt.toString('base64')).lastInsertRowid
        );
        tlIds.push(id);
      });
    })();

    try {
      chuanBi.forEach((t, i) => {
        const rel = `${gdId}/${tlIds[i]}-cho.pdf`;
        ghiTep(rel, t.pdf);
        db.prepare('UPDATE mysign_tai_lieu SET tep_cho = ? WHERE id = ?').run(rel, tlIds[i]);
      });
      const txId = await mysign.guiYeuCauKy(tk.mysign_user_id, {
        credentialId: ct.credential_id,
        moTa,
        taiLieu: chuanBi.map((t, i) => ({ id: tlIds[i], ten: t.ten, hash: Pades.sha256(t.tt) })),
      });
      db.prepare('UPDATE mysign_giao_dich SET transaction_id = ? WHERE id = ?').run(txId, gdId);
    } catch (e) {
      ketThuc(gdId, 'loi', null, e instanceof LoiMySign ? e.nguoiDung : 'Không gửi được yêu cầu ký.');
      throw e;
    }
    return giaoDich(gdId);
  }

  function ketThuc(gdId, trangThai, ma, thongDiep) {
    db.transaction(() => {
      db.prepare(
        "UPDATE mysign_giao_dich SET trang_thai = ?, ma_trang_thai = ?, thong_diep = ?, xong_luc = ? WHERE id = ? AND trang_thai = 'cho_xac_nhan'"
      ).run(trangThai, ma, thongDiep, new Date().toISOString(), gdId);
      db.prepare("UPDATE mysign_tai_lieu SET trang_thai = 'huy' WHERE giao_dich_id = ? AND trang_thai = 'cho'").run(gdId);
    })();
  }

  /** Hỏi MySign và hoàn tất nếu đã có kết quả. Gọi lặp lại được; giao dịch đã xong thì chỉ trả lại trạng thái. */
  async function capNhat(gdId) {
    let g = db.prepare('SELECT * FROM mysign_giao_dich WHERE id = ?').get(gdId);
    if (!g || g.trang_thai !== 'cho_xac_nhan' || dangXuLy.has(gdId)) return giaoDich(gdId);
    dangXuLy.add(gdId);
    try {
      if (!g.transaction_id) {
        if (Date.now() - Date.parse(g.tao_luc) > 60 * 1000) ketThuc(gdId, 'loi', null, 'Yêu cầu ký chưa được gửi tới MySign.');
        return giaoDich(gdId);
      }
      let kq;
      try {
        kq = await mysign.trangThai(g.mysign_user_id, g.transaction_id);
      } catch (e) {
        if (Date.now() - Date.parse(g.tao_luc) > CHO_TOI_DA_MS) ketThuc(gdId, 'het_han', null, 'Yêu cầu ký đã hết thời gian chờ.');
        return { ...giaoDich(gdId), loi_tam: e instanceof LoiMySign ? e.nguoiDung : 'Không hỏi được trạng thái ký.' };
      }
      if (kq.trang_thai === 'cho_xac_nhan') {
        if (Date.now() - Date.parse(g.tao_luc) > CHO_TOI_DA_MS) ketThuc(gdId, 'het_han', kq.ma, 'Yêu cầu ký đã hết thời gian chờ.');
        return giaoDich(gdId);
      }
      if (kq.trang_thai !== 'thanh_cong') {
        ketThuc(gdId, kq.trang_thai, kq.ma, kq.thong_diep);
        return giaoDich(gdId);
      }
      hoanTat(g, kq);
      return giaoDich(gdId);
    } finally {
      dangXuLy.delete(gdId);
    }
  }

  function hoanTat(g, kq) {
    const ds = db.prepare('SELECT * FROM mysign_tai_lieu WHERE giao_dich_id = ? ORDER BY thu_tu').all(g.id);
    const chuoi = JSON.parse(g.chuoi_json).map((b) => Buffer.from(b, 'base64'));
    if (kq.chu_ky.length !== ds.length) {
      ketThuc(g.id, 'loi', kq.ma, 'MySign trả về thiếu chữ ký.');
      return;
    }
    const daKy = [];
    for (let i = 0; i < ds.length; i++) {
      const t = ds[i];
      const tt = Buffer.from(t.thuoc_tinh_ky, 'base64');
      // Kiểm chữ ký bằng khóa công khai của chứng thư TRƯỚC khi ghi: sai định dạng / sai khóa thì không tạo PDF hỏng.
      if (!Pades.chuKyKhop({ thuocTinh: tt, chuKy: kq.chu_ky[i], chungThu: chuoi[0] })) {
        ketThuc(g.id, 'loi', kq.ma, 'Chữ ký MySign trả về không khớp với chứng thư số.');
        return;
      }
      const cms = Pades.dongGoiCms({ thuocTinh: tt, chuKy: kq.chu_ky[i], chuoi });
      const pdf = Pades.chenChuKy(docTep(t.tep_cho), cms);
      const rel = `${g.id}/${t.id}-da-ky.pdf`;
      ghiTep(rel, pdf);
      daKy.push({ ...t, tep_da_ky: rel, sha256: Pades.sha256(pdf).toString('hex'), meta: JSON.parse(t.meta_json || '{}') });
    }
    const luc = new Date().toISOString();
    const xuLy = nguon.get(g.nguon);
    db.transaction(() => {
      const r = db
        .prepare("UPDATE mysign_giao_dich SET trang_thai = 'thanh_cong', ma_trang_thai = ?, thong_diep = ?, xong_luc = ? WHERE id = ? AND trang_thai = 'cho_xac_nhan'")
        .run(kq.ma, kq.thong_diep, luc, g.id);
      if (r.changes === 0) return;
      for (const t of daKy) {
        db.prepare("UPDATE mysign_tai_lieu SET trang_thai = 'da_ky', tep_da_ky = ?, sha256 = ?, ky_luc = ? WHERE id = ?").run(t.tep_da_ky, t.sha256, luc, t.id);
      }
      // Nguồn trả các tài liệu không còn hiệu lực nghiệp vụ (vd. báo cáo đã bị nộp lại trong lúc chờ ký).
      const huy = (xuLy && xuLy.khiThanhCong && xuLy.khiThanhCong({ giaoDich: { ...g, xong_luc: luc }, taiLieu: daKy })) || [];
      for (const id of huy) db.prepare("UPDATE mysign_tai_lieu SET trang_thai = 'huy' WHERE id = ?").run(id);
    })();
  }

  /** Giao dịch + tài liệu, dạng trả về cho giao diện. */
  function giaoDich(gdId) {
    const g = db.prepare('SELECT * FROM mysign_giao_dich WHERE id = ?').get(gdId);
    if (!g) return null;
    const ds = db.prepare('SELECT id, nguon, nguon_id, ten, trang_thai, ky_luc FROM mysign_tai_lieu WHERE giao_dich_id = ? ORDER BY thu_tu').all(gdId);
    return {
      id: g.id,
      user_id: g.user_id,
      nguon: g.nguon,
      trang_thai: g.trang_thai,
      thong_diep: g.thong_diep || (g.trang_thai === 'cho_xac_nhan' ? 'Đang chờ xác nhận trên ứng dụng MySign.' : null),
      chu_the: g.chu_the,
      tao_luc: g.tao_luc,
      xong_luc: g.xong_luc,
      tai_lieu: ds,
    };
  }

  return { mysign, taiKhoan, lienKet, huyLienKet, dangKyNguon, dangCho, dangChoCuaNguoi, banDaKy, docTep, batDau, capNhat, giaoDich };
}

module.exports = { taoKySo, CHO_TOI_DA_MS };
