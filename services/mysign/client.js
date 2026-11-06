/**
 * Gọi API dịch vụ ký số từ xa MySign (Viettel-CA) — theo "Tài liệu tích hợp dịch vụ MySign API + SDK" v1.8.
 *
 * Cấu hình của Viện (một lần, biến môi trường; Viettel cấp khi ký hợp đồng tích hợp):
 *   MYSIGN_CLIENT_ID, MYSIGN_CLIENT_SECRET, MYSIGN_PROFILE_ID, MYSIGN_BASE_URL (mặc định https://remotesigning.viettel.vn)
 * Mỗi người ký chỉ cần MÃ TÀI KHOẢN MySign (user_id) của mình — không có mật khẩu nào đi qua hệ thống: người ký
 * xác nhận từng yêu cầu ký bằng sinh trắc học trên ứng dụng MySign trong điện thoại.
 *
 * Dùng chế độ BẤT ĐỒNG BỘ (async = 2): signHash trả ngay transactionId, hệ thống hỏi lại requests/status cho tới khi xong.
 */

const URL_MAC_DINH = 'https://remotesigning.viettel.vn';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_RSA = '1.2.840.113549.1.1.1';
const HET_GIO_MS = 20000;

/** Mã trạng thái của requests/status (Phụ lục 1, mục 2.2.4) → trạng thái nội bộ + câu báo cho người dùng. */
const TRANG_THAI = {
  1: { trang_thai: 'thanh_cong', thong_diep: 'Đã ký.' },
  4000: { trang_thai: 'cho_xac_nhan', thong_diep: 'Đang chờ xác nhận trên ứng dụng MySign.' },
  6000: { trang_thai: 'cho_xac_nhan', thong_diep: 'Đã xác nhận, MySign đang ký.' },
  4001: { trang_thai: 'het_han', thong_diep: 'Yêu cầu ký đã hết thời gian chờ xác nhận.' },
  4002: { trang_thai: 'tu_choi', thong_diep: 'Yêu cầu ký đã bị từ chối trên ứng dụng MySign.' },
  4004: { trang_thai: 'loi', thong_diep: 'MySign ký không thành công.' },
  4005: { trang_thai: 'loi', thong_diep: 'Tài khoản MySign không đủ số dư / lượt ký.' },
  13004: { trang_thai: 'loi', thong_diep: 'Chứng thư số đã hết hạn hoặc bị thu hồi.' },
  50000: { trang_thai: 'loi', thong_diep: 'MySign gặp lỗi khi lấy kết quả ký.' },
};

/** Lỗi trả về khi gọi MySign: `nguoiDung` là câu hiển thị được cho người dùng. */
class LoiMySign extends Error {
  constructor(nguoiDung, chiTiet) {
    super(nguoiDung + (chiTiet ? ' (' + chiTiet + ')' : ''));
    this.nguoiDung = nguoiDung;
    this.chiTiet = chiTiet || null;
  }
}

/** Đọc cấu hình từ biến môi trường. Thiếu client_id/secret/profile thì chữ ký số coi như chưa bật. */
function cauHinhTuMoiTruong(env = process.env) {
  return {
    baseUrl: (env.MYSIGN_BASE_URL || URL_MAC_DINH).replace(/\/+$/, ''),
    clientId: env.MYSIGN_CLIENT_ID || '',
    clientSecret: env.MYSIGN_CLIENT_SECRET || '',
    profileId: env.MYSIGN_PROFILE_ID || '',
  };
}

/**
 * Chuỗi hiển thị trên điện thoại (tên tài liệu, mô tả): MySign chỉ nhận chữ không dấu, số, dấu cách, _ và -,
 * mã hóa base64 dưới 100 ký tự.
 */
function chuoiHienThi(s, toiDa = 70) {
  const t = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .replace(/[–—]/g, '-')
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, toiDa)
    .trim();
  return Buffer.from(t || 'Tai lieu', 'utf8').toString('base64');
}

/**
 * @param {{cauHinh?:object, fetch?:Function}} [p]
 */
function taoMySign({ cauHinh, fetch: f } = {}) {
  const ch = cauHinh || cauHinhTuMoiTruong();
  const goiFetch = f || globalThis.fetch;
  const token = new Map(); // user_id → {access_token, het}

  const daCauHinh = () => !!(ch.clientId && ch.clientSecret && ch.profileId);
  const xacThucClient = () => ({ client_id: ch.clientId, client_secret: ch.clientSecret });

  async function goi(duong, body, accessToken) {
    if (!daCauHinh()) throw new LoiMySign('Hệ thống chưa được cấu hình chữ ký số MySign.');
    let r;
    try {
      r = await goiFetch(ch.baseUrl + duong, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HET_GIO_MS),
      });
    } catch (e) {
      throw new LoiMySign('Không kết nối được dịch vụ MySign. Vui lòng thử lại sau.', e && e.message);
    }
    let d = null;
    try {
      d = await r.json();
    } catch (_) {
      /* không phải JSON */
    }
    if (!r.ok) {
      const ma = d && (d.error || d.error_code);
      const moTa = d && d.error_description;
      throw new LoiMySign(dichLoi(ma, r.status), [r.status, ma, moTa].filter(Boolean).join(' '));
    }
    return d;
  }

  function dichLoi(ma, status) {
    if (ma === '58008' || ma === '59033') return 'Không tìm thấy tài khoản MySign này, hoặc tài khoản chưa được cấp quyền cho hệ thống.';
    if (ma === '58007') return 'Mã ứng dụng (client_id) MySign của hệ thống không hợp lệ. Liên hệ quản trị viên.';
    if (ma === '58011') return 'MySign không còn giữ yêu cầu ký này.';
    if (status >= 500) return 'Dịch vụ MySign đang lỗi. Vui lòng thử lại sau.';
    return 'MySign từ chối yêu cầu.';
  }

  async function dangNhap(userId, lamMoi) {
    const t = token.get(userId);
    if (!lamMoi && t && t.het > Date.now()) return t.access_token;
    const d = await goi('/vtss/service/ras/v1/login', { ...xacThucClient(), profile_id: ch.profileId, user_id: userId });
    if (!d || !d.access_token) throw new LoiMySign('MySign không cấp phiên đăng nhập.');
    const giay = Number(d.expires_in) || 3600;
    token.set(userId, { access_token: d.access_token, het: Date.now() + Math.max(60, giay - 60) * 1000 });
    return d.access_token;
  }

  /** Gọi API cần phiên của người ký; phiên hết hạn (401) thì đăng nhập lại một lần. */
  async function goiCoPhien(userId, duong, body) {
    try {
      return await goi(duong, body, await dangNhap(userId));
    } catch (e) {
      if (!(e instanceof LoiMySign) || !/^401/.test(String(e.chiTiet || ''))) throw e;
      return goi(duong, body, await dangNhap(userId, true));
    }
  }

  /**
   * Chứng thư số đang dùng được của tài khoản: key ENABLED, chứng thư hợp lệ, có thuật toán RSA.
   * @returns {Promise<{credential_id:string, chuoi:Buffer[], chu_the:string, het_han:string|null, so_dien_thoai:string|null}>}
   */
  async function chungThu(userId) {
    const d = await goiCoPhien(userId, '/vtss/service/certificates/info', {
      ...xacThucClient(),
      profile_id: ch.profileId,
      user_id: userId,
      certificates: 'chain',
      certInfo: true,
      authInfo: true,
    });
    const ds = Array.isArray(d) ? d : d && Array.isArray(d.credentials) ? d.credentials : [];
    const c = ds.find(
      (x) =>
        x && x.credential_id && x.key && String(x.key.status).toUpperCase() === 'ENABLED' &&
        x.cert && String(x.cert.status || 'valid').toLowerCase() === 'valid' &&
        (!Array.isArray(x.key.algo) || x.key.algo.includes(OID_RSA)) &&
        Array.isArray(x.cert.certificates) && x.cert.certificates.length
    );
    if (!c) throw new LoiMySign('Tài khoản MySign chưa có chứng thư số còn hiệu lực.');
    return {
      credential_id: c.credential_id,
      chuoi: c.cert.certificates.map((b) => Buffer.from(b, 'base64')),
      chu_the: c.cert.subjectDN || '',
      het_han: c.cert.validTo || null,
      so_dien_thoai: c.phone_number || null,
    };
  }

  /**
   * Gửi yêu cầu ký nhiều mã băm trong MỘT lần xác nhận trên điện thoại.
   * @param {string} userId
   * @param {{credentialId:string, taiLieu:{id:string|number, ten:string, hash:Buffer}[], moTa:string}} p
   * @returns {Promise<string>} transactionId
   */
  async function guiYeuCauKy(userId, { credentialId, taiLieu, moTa }) {
    const d = await goiCoPhien(userId, '/vtss/service/signHash', {
      credentialID: credentialId,
      ...xacThucClient(),
      numSignatures: taiLieu.length,
      description: chuoiHienThi(moTa),
      documents: taiLieu.map((t) => ({ document_id: String(t.id), document_name: chuoiHienThi(t.ten) })),
      hash: taiLieu.map((t) => t.hash.toString('base64')),
      hashAlgo: OID_SHA256,
      signAlgo: OID_RSA,
      async: 2,
    });
    const id = d && (d.transactionId || d.transaction_id);
    if (!id) throw new LoiMySign('MySign không trả mã yêu cầu ký.');
    return String(id);
  }

  /** @returns {Promise<{trang_thai:string, ma:string, thong_diep:string, chu_ky:Buffer[]}>} */
  async function trangThai(userId, transactionId) {
    const d = await goiCoPhien(userId, '/vtss/service/requests/status', { transactionId });
    const ma = String((d && d.status) || '');
    const tt = TRANG_THAI[ma] || { trang_thai: 'loi', thong_diep: 'MySign trả trạng thái không rõ (' + (ma || 'trống') + ').' };
    const chuKy = Array.isArray(d && d.signatures) ? d.signatures.map((s) => Buffer.from(s, 'base64')) : [];
    return { ...tt, ma, chu_ky: chuKy };
  }

  return { daCauHinh, chungThu, guiYeuCauKy, trangThai };
}

module.exports = { taoMySign, cauHinhTuMoiTruong, chuoiHienThi, LoiMySign, TRANG_THAI };
