/**
 * Đăng ký tài khoản có xác minh email (POST /api/register → thư → /api/register/hoan-tat).
 * Mỗi test canh MỘT chốt chặn; tên test nói rõ chốt chặn đó (để làm mutation check: gỡ chốt thì test phải đỏ).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { dungUngDung } = require('./helpers/dangKyApp');

const EM = 'nguoimoi@sci.edu.vn';
const MK = 'matkhau-an-toan-1';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function voiApp(fn, tuyChon) {
  const ung = await dungUngDung(tuyChon);
  try {
    await fn(ung);
  } finally {
    await ung.dung();
  }
}

// ── CHỐT 1: đăng ký không tạo tài khoản, không đăng nhập ─────────────────────────────────────────

test('đăng ký chỉ gửi thư: không tạo user, không token, không cookie', () =>
  voiApp(async (u) => {
    const r = await u.dangKy(EM);
    assert.equal(r.s, 202);
    assert.equal(r.d.token, undefined);
    assert.equal(r.d.user, undefined);
    assert.equal(r.cookie, null);
    assert.equal(u.user(EM), undefined, 'chưa xác minh thì không có tài khoản');
    assert.equal(u.thu.length, 1);
    assert.equal(u.thu[0].to, EM);
  }));

test('mật khẩu gửi kèm lúc đăng ký bị bỏ qua (kẻ gõ email người khác không biết được mật khẩu tài khoản sẽ tạo)', () =>
  voiApp(async (u) => {
    await u.dangKy(EM, 'Nguyễn Văn Thử', { password: 'kẻ-tấn-công-chọn' });
    const ma = u.maTuThu(EM);
    const r = await u.goi('/hoan-tat', { token: ma, password: MK });
    assert.equal(r.s, 201);
    assert.equal(await u.bcrypt.compare('kẻ-tấn-công-chọn', u.user(EM).password), false);
    assert.equal(await u.bcrypt.compare(MK, u.user(EM).password), true);
  }));

test('đăng ký bỏ qua trường role/vai trò do client gửi: tài khoản mới luôn là researcher', () =>
  voiApp(async (u) => {
    await u.dangKy(EM, 'Nguyễn Văn Thử', { role: 'admin' });
    const r = await u.goi('/hoan-tat', { token: u.maTuThu(EM), password: MK, role: 'admin' });
    assert.equal(r.s, 201);
    assert.equal(u.user(EM).role, 'researcher');
  }));

// ── CHỐT 2: mã ngẫu nhiên >=128 bit, chỉ lưu sha256 ──────────────────────────────────────────────

test('mã dài 256 bit, DB chỉ lưu sha256 (không lưu mã thô) và mã mỗi lần một khác', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const ma1 = u.maTuThu(EM);
    assert.match(ma1, /^[a-f0-9]{64}$/);
    // Chống mã "đệm" từ nguồn ngẫu nhiên ngắn: nửa sau của mã không được là một ký tự lặp lại.
    assert.ok(new Set(ma1.slice(32)).size > 4 && new Set(ma1.slice(0, 32)).size > 4, 'mã phải đủ entropy ở cả hai nửa');
    const rows = u.db.prepare('SELECT * FROM email_verifications').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, sha256(ma1));
    assert.ok(!JSON.stringify(rows).includes(ma1), 'mã thô không được nằm ở đâu trong bản ghi');
    u.lui(EM, 120_000);
    await u.dangKy(EM);
    assert.notEqual(u.maTuThu(EM), ma1);
  }));

// ── CHỐT 3: SMTP chưa cấu hình / lỗi → thất bại an toàn ──────────────────────────────────────────

test('SMTP chưa cấu hình → 503, không tạo user, không để lại mã (không bỏ qua xác minh)', () =>
  voiApp(
    async (u) => {
      const r = await u.dangKy(EM);
      assert.equal(r.s, 503);
      assert.equal(r.d.token, undefined);
      assert.equal(u.user(EM), undefined);
      assert.equal(u.soHang(), 0);
    },
    { coSmtp: false }
  ));

test('SMTP chưa cấu hình: tài khoản tạo sẵn cũng không kích hoạt được và vẫn chưa có mật khẩu', () =>
  voiApp(
    async (u) => {
      u.taoSan(EM, 'admin');
      const r = await u.dangKy(EM);
      assert.equal(r.s, 503);
      assert.equal(u.user(EM).password, '');
      assert.equal(u.soHang(), 0);
    },
    { coSmtp: false }
  ));

test('gửi thư lỗi → 503, xóa mã vừa tạo, không tạo user và có thể thử lại ngay (không bị khóa 60 giây)', () =>
  voiApp(async (u) => {
    u.cheDoMail = async () => { throw new Error('SMTP down'); };
    const r = await u.dangKy(EM);
    assert.equal(r.s, 503);
    assert.equal(u.soHang(), 0);
    assert.equal(u.user(EM), undefined);
    u.cheDoMail = null;
    const r2 = await u.dangKy(EM);
    assert.equal(r2.s, 202);
    assert.equal(u.thu.length, 1);
  }));

test('SMTP chưa cấu hình: trả 503 cho MỌI email, kể cả email đã có tài khoản (không lộ email nào tồn tại)', () =>
  voiApp(
    async (u) => {
      u.db.prepare("INSERT INTO users (email, password, fullname) VALUES ('cu@sci.edu.vn', 'x', 'Cũ')").run();
      assert.equal((await u.dangKy('cu@sci.edu.vn')).s, 503);
      assert.equal((await u.dangKy(EM)).s, 503);
    },
    { coSmtp: false }
  ));

// ── CHỐT 4: tài khoản tạo sẵn phải xác minh trước khi đặt mật khẩu ───────────────────────────────

test('tài khoản tạo sẵn: đăng ký KHÔNG đặt mật khẩu, không đăng nhập, chỉ gửi thư tới chủ hộp thư', () =>
  voiApp(async (u) => {
    u.taoSan(EM, 'admin');
    const r = await u.dangKy(EM, 'Kẻ mạo danh');
    assert.equal(r.s, 202);
    assert.equal(r.d.token, undefined);
    assert.equal(r.cookie, null);
    const row = u.user(EM);
    assert.equal(row.password, '', 'chưa xác minh thì mật khẩu vẫn rỗng');
    assert.equal(row.fullname, 'Tài khoản tạo sẵn', 'chưa xác minh thì tên cũng không bị ghi đè');
    assert.equal(u.thu.length, 1);
  }));

test('tài khoản tạo sẵn: không có mã (hoặc đoán mã) thì không đặt được mật khẩu, không chiếm được quyền', () =>
  voiApp(async (u) => {
    u.taoSan(EM, 'admin');
    await u.dangKy(EM);
    for (const token of [undefined, '', 'abc', 'a'.repeat(64), crypto.randomBytes(32).toString('hex'), sha256('x')]) {
      const r = await u.goi('/hoan-tat', { token, password: MK });
      assert.equal(r.s, 400, 'mã ' + String(token).slice(0, 8));
      assert.equal(r.cookie, null);
    }
    assert.equal(u.user(EM).password, '');
  }));

test('tài khoản tạo sẵn: có mã trong thư thì kích hoạt, GIỮ NGUYÊN vai trò, đăng nhập được bằng mật khẩu mới', () =>
  voiApp(async (u) => {
    u.taoSan(EM, 'thu_ky');
    await u.dangKy(EM, 'Trần Thư Ký');
    const r = await u.goi('/hoan-tat', { token: u.maTuThu(EM), password: MK });
    assert.equal(r.s, 200);
    assert.equal(r.d.activated, true);
    assert.equal(r.d.user.role, 'thu_ky');
    assert.ok(r.cookie && r.cookie.includes('auth_token='));
    assert.equal(u.jwt.verify(r.d.token, u.JWT_SECRET).email, EM);
    const row = u.user(EM);
    assert.equal(row.role, 'thu_ky');
    assert.equal(row.fullname, 'Trần Thư Ký');
    assert.equal(await u.bcrypt.compare(MK, row.password), true);
  }));

// ── CHỐT 5: tài khoản đã có không bị đụng tới ────────────────────────────────────────────────────

test('tài khoản đã có mật khẩu: không gửi thư, mật khẩu/họ tên không đổi, thông báo GIỐNG HỆT email mới', () =>
  voiApp(async (u) => {
    const hash = await u.bcrypt.hash('mat-khau-cu', 10);
    u.db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?,?,?,?)').run('cu@sci.edu.vn', hash, 'Người Cũ', 'phong_khcn');
    const cu = await u.dangKy('cu@sci.edu.vn', 'Kẻ khác');
    const moi = await u.dangKy(EM);
    assert.equal(cu.s, 202);
    assert.equal(cu.s, moi.s);
    assert.deepEqual(cu.d, moi.d, 'không được lộ email nào đã có tài khoản');
    assert.equal(u.thu.filter((t) => t.to === 'cu@sci.edu.vn').length, 0);
    const row = u.user('cu@sci.edu.vn');
    assert.equal(row.password, hash);
    assert.equal(row.fullname, 'Người Cũ');
    assert.equal(row.role, 'phong_khcn');
  }));

test('mã còn hiệu lực nhưng tài khoản được kích hoạt trong lúc chờ → 409, không ghi đè mật khẩu đang có', () =>
  voiApp(async (u) => {
    u.taoSan(EM, 'admin');
    await u.dangKy(EM);
    const ma = u.maTuThu(EM);
    const hash = await u.bcrypt.hash('mat-khau-vua-dat-lai', 10);
    u.db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, EM);
    const r = await u.goi('/hoan-tat', { token: ma, password: MK });
    assert.equal(r.s, 409);
    assert.equal(r.cookie, null);
    assert.equal(u.user(EM).password, hash);
  }));

test('tài khoản bị khóa: không gửi thư; nếu bị khóa sau khi có mã thì hoan-tat bị từ chối (403)', () =>
  voiApp(async (u) => {
    u.taoSan('khoa@sci.edu.vn', 'researcher');
    u.db.prepare("UPDATE users SET is_banned = 1 WHERE email = 'khoa@sci.edu.vn'").run();
    assert.equal((await u.dangKy('khoa@sci.edu.vn')).s, 202);
    assert.equal(u.thu.length, 0);

    u.taoSan(EM, 'researcher');
    await u.dangKy(EM);
    u.db.prepare('UPDATE users SET is_banned = 1 WHERE email = ?').run(EM);
    const r = await u.goi('/hoan-tat', { token: u.maTuThu(EM), password: MK });
    assert.equal(r.s, 403);
    assert.equal(u.user(EM).password, '');
  }));

// ── CHỐT 6: dùng một lần, hết hạn, thay thế ──────────────────────────────────────────────────────

test('mã chỉ dùng được MỘT lần: lần hai bị từ chối và không đổi mật khẩu', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const ma = u.maTuThu(EM);
    assert.equal((await u.goi('/hoan-tat', { token: ma, password: MK })).s, 201);
    const hash = u.user(EM).password;
    const r2 = await u.goi('/hoan-tat', { token: ma, password: 'mat-khau-khac-2' });
    assert.equal(r2.s, 400);
    assert.equal(r2.cookie, null);
    assert.equal(u.user(EM).password, hash);
    assert.equal((await u.goi('/kiem-tra', { token: ma })).s, 400);
  }));

test('hai yêu cầu hoàn tất ĐỒNG THỜI cùng một mã: đúng một yêu cầu thắng', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const ma = u.maTuThu(EM);
    const kq = await Promise.all([1, 2, 3, 4].map((i) => u.goi('/hoan-tat', { token: ma, password: MK + i })));
    assert.equal(kq.filter((r) => r.s === 201).length, 1);
    assert.equal(kq.filter((r) => r.s === 400).length, 3);
    assert.equal(u.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  }));

test('mã hết hạn bị từ chối ở cả kiem-tra lẫn hoan-tat và không tạo tài khoản', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const ma = u.maTuThu(EM);
    u.db.prepare('UPDATE email_verifications SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await u.goi('/kiem-tra', { token: ma })).s, 400);
    assert.equal((await u.goi('/hoan-tat', { token: ma, password: MK })).s, 400);
    assert.equal(u.user(EM), undefined);
  }));

test('mã có hạn dùng ngắn (2 giờ), không phải vô thời hạn', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const h = u.db.prepare('SELECT created_at, expires_at FROM email_verifications').get();
    const ms = Date.parse(h.expires_at) - Date.parse(h.created_at);
    assert.ok(ms > 0 && ms <= 2 * 3600 * 1000, 'hạn ' + ms + ' ms');
  }));

test('gửi lại thư làm mã cũ mất hiệu lực', () =>
  voiApp(async (u) => {
    await u.dangKy(EM);
    const cu = u.maTuThu(EM);
    u.lui(EM, 120_000);
    await u.dangKy(EM);
    const moi = u.maTuThu(EM);
    assert.notEqual(cu, moi);
    assert.equal((await u.goi('/hoan-tat', { token: cu, password: MK })).s, 400);
    assert.equal(u.user(EM), undefined);
    assert.equal((await u.goi('/hoan-tat', { token: moi, password: MK })).s, 201);
  }));

test('kiem-tra không tiêu thụ mã; mật khẩu không hợp lệ không làm cháy mã', () =>
  voiApp(async (u) => {
    await u.dangKy(EM, 'Nguyễn Văn Thử');
    const ma = u.maTuThu(EM);
    const k = await u.goi('/kiem-tra', { token: ma });
    assert.equal(k.s, 200);
    assert.deepEqual(k.d, { email: EM, fullname: 'Nguyễn Văn Thử' });
    assert.equal((await u.goi('/kiem-tra', { token: ma })).s, 200);
    assert.equal((await u.goi('/hoan-tat', { token: ma, password: '123' })).s, 400);
    assert.equal((await u.goi('/hoan-tat', { token: ma, password: 'x'.repeat(129) })).s, 400);
    assert.equal(u.user(EM), undefined);
    assert.equal((await u.goi('/hoan-tat', { token: ma, password: MK })).s, 201);
  }));

// ── CHỐT 7: chống dội thư ────────────────────────────────────────────────────────────────────────

test('mỗi email tối thiểu 60 giây giữa hai thư (lần hai bị 429, không gửi thêm)', () =>
  voiApp(async (u) => {
    assert.equal((await u.dangKy(EM)).s, 202);
    assert.equal((await u.dangKy(EM)).s, 429);
    assert.equal(u.thu.length, 1);
  }));

test('mỗi email tối đa 5 thư mỗi giờ', () =>
  voiApp(async (u) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await u.dangKy(EM)).s, 202, 'lần ' + (i + 1));
      u.lui(EM, 120_000);
    }
    assert.equal((await u.dangKy(EM)).s, 429);
    assert.equal(u.thu.length, 5);
  }));

test('giới hạn theo địa chỉ IP trên đường gửi thư xác minh', () =>
  voiApp(
    async (u) => {
      assert.equal((await u.dangKy('a1@sci.edu.vn')).s, 202);
      assert.equal((await u.dangKy('a2@sci.edu.vn')).s, 202);
      assert.equal((await u.dangKy('a3@sci.edu.vn')).s, 429);
      assert.equal(u.thu.length, 2);
    },
    { gioiHanGuiThu: { windowMs: 3600 * 1000, max: 2 } }
  ));

// ── CHỐT 8: kiểm đầu vào & nội dung thư ──────────────────────────────────────────────────────────

test('đuôi email ngoài @sci.edu.vn, email sai định dạng hoặc thiếu họ tên: 400 và không gửi thư', () =>
  voiApp(async (u) => {
    assert.equal((await u.dangKy('ai-do@gmail.com')).s, 400);
    assert.equal((await u.dangKy('khong-hop-le')).s, 400);
    assert.equal((await u.dangKy('a\r\nBcc: x@evil.com@sci.edu.vn')).s, 400);
    assert.equal((await u.dangKy(EM, 'A')).s, 400);
    assert.equal((await u.dangKy(EM, 'x'.repeat(151))).s, 400);
    assert.equal((await u.goi('', { email: EM })).s, 400);
    assert.equal(u.thu.length, 0);
    assert.equal(u.soHang(), 0);
  }));

test('thư gửi đúng người nhận, liên kết trỏ vào hệ thống (mã trong #fragment), KHÔNG chèn họ tên người gõ', () =>
  voiApp(async (u) => {
    await u.dangKy(EM, 'Bấm vào http://evil.example để nhận thưởng');
    const t = u.thu[0];
    assert.equal(t.to, EM);
    assert.match(t.text, /https:\/\/eoffice\.test\/xac-minh-email\.html#token=[a-f0-9]{64}/);
    assert.ok(!t.text.includes('evil.example') && !t.html.includes('evil.example'), 'họ tên do người gõ không được vào thư');
    assert.ok(!/\?token=/.test(t.text), 'mã không nằm trong query string (sẽ vào nhật ký truy cập)');
  }));
