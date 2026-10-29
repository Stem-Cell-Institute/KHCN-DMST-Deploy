/**
 * Xác minh quyền sở hữu hộp thư khi ĐĂNG KÝ tài khoản mới (POST /api/register).
 *
 * Trước đây đăng ký tạo tài khoản và đăng nhập ngay, chỉ kiểm đuôi @sci.edu.vn: ai gõ ten@sci.edu.vn
 * cũng đăng ký được thành người đó, và với tài khoản Viện tạo sẵn (chưa có mật khẩu) thì ai biết email
 * cũng đặt được mật khẩu và chiếm tài khoản, kể cả vai trò cao.
 *
 * Luồng mới — MẬT KHẨU ĐƯỢC ĐẶT SAU KHI XÁC MINH, không phải lúc đăng ký:
 *   1. yeuCau(email, họ tên)   → gửi liên kết dùng một lần tới CHÍNH hộp thư đó. Chưa tạo/đổi tài khoản nào.
 *   2. kiemTra(mã)             → trang xác minh hỏi xem liên kết còn dùng được không (không tiêu thụ mã).
 *   3. hoanTat(mã, mật khẩu)   → người cầm được liên kết (= đọc được hộp thư) đặt mật khẩu; lúc này mới
 *                                tạo tài khoản mới, hoặc kích hoạt tài khoản tạo sẵn chưa có mật khẩu.
 *
 * Vì sao KHÔNG nhận mật khẩu ở bước 1: nếu nhận, kẻ gõ email của nạn nhân sẽ biết mật khẩu của tài khoản
 * sẽ được tạo ngay khi nạn nhân (tưởng thư là thật) bấm liên kết.
 *
 * Mã: 32 byte ngẫu nhiên (256 bit), chỉ lưu sha256, hết hạn, dùng một lần (tiêu thụ nguyên tử bằng
 * UPDATE … WHERE used_at IS NULL). Gửi lại thư thì mã cũ mất hiệu lực.
 *
 * Phạm vi: CHỈ áp dụng cho người đăng ký mới. Tài khoản đã có mật khẩu không bị đụng tới (không thêm cột,
 * không migration, không buộc xác minh lại); đăng nhập, quên mật khẩu giữ nguyên.
 *
 * Thất bại an toàn: SMTP chưa cấu hình hoặc gửi thư lỗi → 503, KHÔNG tạo tài khoản, KHÔNG bỏ qua xác minh.
 */

const crypto = require('crypto');

const HAN_MA_MS = 2 * 60 * 60 * 1000; // 2 giờ
const GIAN_CACH_GUI_MS = 60 * 1000; // tối thiểu 60 giây giữa hai thư cho cùng một email
const TOI_DA_MOI_GIO = 5; // tối đa 5 thư / email / giờ — chống dội thư vào hộp của người khác
const GIU_HO_SO_MS = 7 * 24 * 3600 * 1000;
const MA_RE = /^[a-f0-9]{64}$/;

const bamMa = (ma) => crypto.createHash('sha256').update(String(ma)).digest('hex');
const taoMa = () => crypto.randomBytes(32).toString('hex');

function taoBang(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      fullname TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email, created_at);
  `);
}

/** Lỗi nghiệp vụ có mã trạng thái HTTP để router trả về. */
function loi(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function coMatKhau(pw) {
  return pw != null && String(pw).trim().length > 0;
}

function dungThu(lienKet) {
  const text =
    'Bạn (hoặc ai đó) vừa dùng địa chỉ email này để đăng ký tài khoản trên Hệ thống SCI-ACE / STIMS, Viện Tế bào gốc.\n\n' +
    'Mở liên kết sau để xác nhận đây là hộp thư của bạn và đặt mật khẩu (hiệu lực 2 giờ, chỉ dùng được một lần):\n' +
    lienKet +
    '\n\nNếu bạn không yêu cầu, hãy bỏ qua thư này — sẽ không có tài khoản nào được tạo hay thay đổi.';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#16233d">' +
    '<p>Bạn (hoặc ai đó) vừa dùng địa chỉ email này để đăng ký tài khoản trên Hệ thống SCI-ACE / STIMS, Viện Tế bào gốc.</p>' +
    '<p>Nhấn vào liên kết sau để xác nhận đây là hộp thư của bạn và đặt mật khẩu (hiệu lực <strong>2 giờ</strong>, chỉ dùng được một lần):</p>' +
    '<p><a href="' + lienKet + '">' + lienKet + '</a></p>' +
    '<p>Nếu bạn không yêu cầu, hãy bỏ qua thư này — sẽ không có tài khoản nào được tạo hay thay đổi.</p></div>';
  return { text, html };
}

/**
 * @param {{db:object, mailSend:null|((o:{to:string,subject:string,text:string,html:string})=>Promise<any>), baseUrl:string, bcrypt:object, now?:()=>number}} deps
 *   mailSend = null khi SMTP chưa cấu hình.
 */
function taoXacMinhEmail({ db, mailSend, baseUrl, bcrypt, now = Date.now }) {
  const goc = String(baseUrl || '').replace(/\/+$/, '');
  const iso = (ms) => new Date(ms).toISOString();

  /**
   * Gửi thư xác minh. Trả `{ gui: true }` khi đã gửi, `{ gui: false }` khi không có gì để xác minh
   * (email đã có tài khoản dùng được, hoặc bị khóa) — router trả CÙNG một thông báo cho cả hai.
   */
  async function yeuCau(email, fullname) {
    // Kiểm SMTP TRƯỚC mọi thứ, kể cả trước khi tra DB: thất bại an toàn, không để lộ email nào tồn tại.
    if (typeof mailSend !== 'function') {
      throw loi(503, 'Hệ thống chưa cấu hình gửi email nên chưa thể xác minh và đăng ký tài khoản. Vui lòng liên hệ quản trị viên.');
    }
    const u = db.prepare('SELECT id, password, COALESCE(is_banned, 0) AS is_banned FROM users WHERE email = ?').get(email);
    if (u && (coMatKhau(u.password) || Number(u.is_banned) === 1)) return { gui: false };

    const t = now();
    const cuoi = db.prepare('SELECT created_at FROM email_verifications WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
    if (cuoi && t - Date.parse(cuoi.created_at) < GIAN_CACH_GUI_MS) {
      throw loi(429, 'Vui lòng đợi 1 phút trước khi yêu cầu gửi lại thư xác minh.');
    }
    const trongGio = db
      .prepare('SELECT COUNT(*) AS n FROM email_verifications WHERE email = ? AND created_at > ?')
      .get(email, iso(t - 3600 * 1000)).n;
    if (trongGio >= TOI_DA_MOI_GIO) {
      throw loi(429, 'Đã gửi quá nhiều thư xác minh cho email này. Vui lòng thử lại sau.');
    }

    db.prepare('DELETE FROM email_verifications WHERE created_at < ?').run(iso(t - GIU_HO_SO_MS));
    // Thư mới làm mọi mã cũ của email này vô hiệu.
    db.prepare('UPDATE email_verifications SET used_at = ? WHERE email = ? AND used_at IS NULL').run(iso(t), email);
    const ma = taoMa();
    const r = db
      .prepare('INSERT INTO email_verifications (email, token_hash, fullname, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(email, bamMa(ma), fullname, iso(t), iso(t + HAN_MA_MS));
    const thu = dungThu(goc + '/xac-minh-email.html#token=' + ma);
    try {
      await mailSend({ to: email, subject: '[SCI-ACE] Xác minh email đăng ký tài khoản', text: thu.text, html: thu.html });
    } catch (e) {
      // Không gửi được thì không để lại mã (và không bắt người dùng chờ 1 phút mới thử lại).
      db.prepare('DELETE FROM email_verifications WHERE id = ?').run(Number(r.lastInsertRowid));
      console.error('[dang-ky] Gửi thư xác minh thất bại:', e && e.message ? e.message : e);
      throw loi(503, 'Không gửi được email xác minh lúc này. Vui lòng thử lại sau.');
    }
    return { gui: true };
  }

  function timMa(ma) {
    const m = String(ma == null ? '' : ma).trim().toLowerCase();
    if (!MA_RE.test(m)) return null;
    const row = db.prepare('SELECT id, email, fullname, expires_at, used_at FROM email_verifications WHERE token_hash = ?').get(bamMa(m));
    if (!row || row.used_at || Date.parse(row.expires_at) <= now()) return null;
    return row;
  }

  /** Liên kết còn dùng được không. Không tiêu thụ mã. */
  function kiemTra(ma) {
    const row = timMa(ma);
    return row ? { email: row.email, fullname: row.fullname } : null;
  }

  /**
   * Tiêu thụ mã và tạo / kích hoạt tài khoản. Trả `{ user, kichHoat }`.
   * Ném lỗi có `status` khi mã sai/hết hạn/đã dùng (400), tài khoản đã có (409) hoặc bị khóa (403).
   */
  async function hoanTat(ma, matKhau) {
    if (typeof matKhau !== 'string' || matKhau.length < 6) throw loi(400, 'Mật khẩu ít nhất 6 ký tự');
    if (matKhau.length > 128) throw loi(400, 'Mật khẩu quá dài (tối đa 128 ký tự).');
    const KHONG_HOP_LE = 'Liên kết xác minh không đúng, đã được dùng hoặc đã hết hạn. Vui lòng đăng ký lại để nhận thư mới.';
    const row = timMa(ma);
    if (!row) throw loi(400, KHONG_HOP_LE);
    const hash = await bcrypt.hash(matKhau, 10);

    const chay = db.transaction(() => {
      // Tiêu thụ nguyên tử: hai yêu cầu đồng thời cùng một mã thì chỉ một cái thắng.
      const dung = db
        .prepare('UPDATE email_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .run(iso(now()), row.id, iso(now()));
      if (dung.changes !== 1) return { loi: loi(400, KHONG_HOP_LE) };

      const u = db.prepare('SELECT id, email, fullname, role, password, COALESCE(is_banned, 0) AS is_banned FROM users WHERE email = ?').get(row.email);
      if (!u) {
        const ins = db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(row.email, hash, row.fullname, 'researcher');
        return { user: { id: Number(ins.lastInsertRowid), email: row.email, fullname: row.fullname, role: 'researcher' }, kichHoat: false };
      }
      if (Number(u.is_banned) === 1) return { loi: loi(403, 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.') };
      if (coMatKhau(u.password)) return { loi: loi(409, 'Email này đã có tài khoản. Vui lòng đăng nhập hoặc dùng "Quên mật khẩu".') };
      // Tài khoản tạo sẵn: chỉ ghi khi VẪN chưa có mật khẩu (chặn đua với đặt lại mật khẩu).
      const up = db
        .prepare("UPDATE users SET password = ?, fullname = ? WHERE id = ? AND (password IS NULL OR TRIM(password) = '')")
        .run(hash, row.fullname, u.id);
      if (up.changes !== 1) return { loi: loi(409, 'Email này đã có tài khoản. Vui lòng đăng nhập hoặc dùng "Quên mật khẩu".') };
      return { user: { id: u.id, email: row.email, fullname: row.fullname, role: u.role }, kichHoat: true };
    });
    const kq = chay();
    if (kq.loi) throw kq.loi;
    return kq;
  }

  return { yeuCau, kiemTra, hoanTat };
}

module.exports = { taoBang, taoXacMinhEmail, bamMa, HAN_MA_MS, GIAN_CACH_GUI_MS, TOI_DA_MOI_GIO };
