'use strict';

/**
 * Email thông báo của module Ngân hàng tế bào & Kháng thể.
 *
 * Nguyên tắc (giống services/baoCaoPhongThongBao.js):
 *   - Email KHÔNG BAO GIỜ làm hỏng thao tác chính: mọi lỗi (SMTP chưa cấu hình, mạng, địa chỉ hỏng) chỉ ghi log,
 *     hàm trả kết quả chứ không ném lỗi.
 *   - Gửi RIÊNG từng người, không CC / BCC chung.
 *   - Mọi dữ liệu người dùng gõ (tên mẫu, lời nhắn, mô tả) được escape trước khi vào HTML.
 *   - Không gửi cho chính người vừa thực hiện thao tác; một người xuất hiện ở nhiều vai trò chỉ nhận MỘT thư.
 *   - Liên kết chỉ trỏ về chính hệ thống (BASE_URL).
 */

const { esc } = require('./baoCaoPhongThongBao');
const { layHan, CAP_VN, quanLyModule, nguoiConHoatDong, truongNhomHieuLuc } = require('./nganHangTeBaoKhangTheYeuCau');

const EMAIL_HOP_LE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRANG = '/public/ngan-hang-te-bao-khang-the/index.html';

function dungThu(doan, lienKet) {
  // mỗi đoạn: {nhan?, text, href?}; có href thì trong HTML là liên kết bấm được, trong bản chữ in kèm địa chỉ
  const text = doan.map((d) => (d.nhan ? `${d.nhan}: ${d.text}` : d.text) + (d.href ? ` ${d.href}` : '')).join('\n') + (lienKet ? `\n\nMở trong hệ thống: ${lienKet}` : '') + '\n\n— Hệ thống STIMS, Viện Tế bào gốc';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#16233d">' +
    doan.map((d) => `<p style="margin:0 0 8px">${d.nhan ? `<strong>${esc(d.nhan)}:</strong> ` : ''}${d.href ? `<a href="${esc(d.href)}" style="color:#b7281e;font-weight:bold">${esc(d.text)}</a>` : esc(d.text).replace(/\n/g, '<br>')}</p>`).join('') +
    (lienKet ? `<p style="margin:14px 0 0"><a href="${esc(lienKet)}" style="color:#b7281e;font-weight:bold">Mở trong hệ thống</a></p>` : '') +
    '<p style="margin:18px 0 0;color:#5a6783;font-size:12px">Hệ thống STIMS, Viện Tế bào gốc — thư tự động, vui lòng không trả lời.</p></div>';
  return { text, html };
}

/** @param {{db:object, mailSend?:Function, baseUrl?:string}} deps */
function taoThongBao({ db, mailSend, baseUrl }) {
  const goc = String(baseUrl || '').replace(/\/+$/, '');
  const lienKet = (hash) => (goc ? `${goc}${TRANG}${hash || ''}` : '');
  const linkPhieu = (id) => (goc ? [{ nhan: 'Phiếu yêu cầu', text: 'Mở và in phiếu (cần đăng nhập)', href: `${goc}/api/ngan-hang-te-bao-khang-the/requests/${id}/print` }] : []);

  /** Gộp nhiều danh sách người nhận: bỏ trùng, bỏ người thực hiện, bỏ địa chỉ hỏng. */
  function gop(boQuaUserId, ...dsList) {
    const thay = new Map();
    for (const ds of dsList) for (const u of ds || []) if (u && u.id !== boQuaUserId && EMAIL_HOP_LE.test(String(u.email || ''))) thay.set(u.id, u);
    return [...thay.values()];
  }

  async function guiDen(ds, tieuDe, thu) {
    const kq = { gui: 0, loi: 0, nguoi_nhan: ds.length };
    if (!mailSend || !ds.length) return kq;
    for (const u of ds) {
      try {
        await mailSend({ to: u.email, subject: tieuDe, text: thu.text, html: thu.html });
        kq.gui++;
      } catch (e) {
        kq.loi++;
        console.warn('[ngan-hang] Gửi mail thất bại:', e && e.message ? e.message : e);
      }
    }
    return kq;
  }

  const ten = (u) => (u ? u.fullname || u.email : '(không rõ)');
  const thongTinMau = (t, duongDan) => [
    { nhan: 'Mẫu', text: t.name },
    duongDan ? { nhan: 'Vị trí', text: duongDan } : null,
  ].filter(Boolean);

  return {
    gop,
    guiDen,
    lienKet,

    /** Có yêu cầu mới → người duyệt ở cấp hiện tại. */
    yeuCauMoi({ yc, tube, nguoiGui, duongDan, nguoiDuyet }) {
      const thu = dungThu(
        [{ text: `${ten(nguoiGui)} xin lấy một mẫu cần bạn duyệt (cấp duyệt: ${yc.cap_ten || CAP_VN[yc.cap]}).` }]
          .concat(thongTinMau(tube, duongDan))
          .concat(yc.ly_do ? [{ nhan: 'Lý do', text: yc.ly_do }] : [])
          .concat([{ text: `Vui lòng duyệt hoặc từ chối trong vòng ${layHan(db).PHAN_HOI_NGAY} ngày; quá hạn yêu cầu sẽ chuyển cho quản lý module.` }]),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiGui.id, nguoiDuyet), `[Ngân hàng mẫu] Yêu cầu lấy mẫu: ${tube.name}`, thu);
    },

    /** Đã duyệt → người yêu cầu + quản lý module (để xử lý giao mẫu). */
    yeuCauDaDuyet({ yc, tube, nguoiGui, nguoiXuLy, duongDan, xuLyThay, donViTen, dongDuyet }) {
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} đã được duyệt${xuLyThay ? ' (quản lý xử lý thay: ' + (yc.ly_do_xu_ly || '') + ')' : ''}.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat([{ nhan: 'Người duyệt', text: ten(nguoiXuLy) }].concat(yc.ly_do_xu_ly ? [{ nhan: 'Ghi chú của người duyệt', text: yc.ly_do_xu_ly }] : []))
          .concat([{ text: `${donViTen ? 'Quản lý ' + donViTen : 'Quản lý module'} sẽ liên hệ giao mẫu.` }])
          .concat(linkPhieu(yc.id)),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui], quanLyModule(db), dongDuyet), `[Ngân hàng mẫu] Đã duyệt yêu cầu lấy mẫu: ${tube.name}`, thu);
    },

    /** Bị từ chối → người yêu cầu. */
    yeuCauTuChoi({ yc, tube, nguoiGui, nguoiXuLy, duongDan, dongDuyet }) {
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} đã bị từ chối.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat([{ nhan: 'Người xử lý', text: ten(nguoiXuLy) }, { nhan: 'Lý do', text: yc.ly_do_xu_ly || '(không ghi)' }])
          .concat(linkPhieu(yc.id)),
        lienKet('#cong-viec')
      );
      // người yêu cầu và quản lý module cùng được báo (người vừa từ chối không nhận lại)
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui], quanLyModule(db), dongDuyet), `[Ngân hàng mẫu] Yêu cầu lấy mẫu bị từ chối: ${tube.name}`, thu);
    },

    /** Quá hạn phản hồi → chuyển quản lý module. */
    yeuCauLeoThang({ yc, tube, nguoiGui, duongDan, capCu, capCuTen }) {
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} chưa được ${capCuTen || CAP_VN[capCu] || 'người duyệt'} xử lý quá hạn nên chuyển cho quản lý module. Bạn có thể duyệt hoặc từ chối.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat(yc.ly_do ? [{ nhan: 'Lý do', text: yc.ly_do }] : []),
        lienKet('#cong-viec')
      );
      return guiDen(gop(null, quanLyModule(db)), `[Ngân hàng mẫu] Yêu cầu quá hạn cần quản lý xử lý: ${tube.name}`, thu);
    },

    /** Đã giao / đã trả mẫu → người yêu cầu. */
    yeuCauGiaoTra({ tube, nguoiGui, nguoiXuLy, duongDan, hanhDong }) {
      const thu = dungThu(
        [{ text: hanhDong === 'giao' ? 'Mẫu bạn xin đã được giao cho bạn.' : 'Mẫu bạn mượn đã được ghi nhận trả lại kho.' }]
          .concat(thongTinMau(tube, duongDan)).concat([{ nhan: 'Người thực hiện', text: ten(nguoiXuLy) }]),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui]), `[Ngân hàng mẫu] ${hanhDong === 'giao' ? 'Đã giao' : 'Đã nhận lại'} mẫu: ${tube.name}`, thu);
    },

    /** Quản lý nhắc chủ mẫu khai báo mẫu có trong ô nhưng chưa có thông tin. */
    nhacKhaiBao({ ph, nguoiNhan, duongDan, nguoiNhac, lanThu }) {
      const thu = dungThu(
        [{ text: `Quản lý module phát hiện một mẫu trong hộp nhưng CHƯA có thông tin trong hệ thống${lanThu > 1 ? ' (nhắc lần ' + lanThu + ')' : ''}. Nếu là mẫu của bạn hoặc của nhóm bạn, vui lòng vào hệ thống bấm «Đây là mẫu của tôi» và điền thông tin.` },
          { nhan: 'Vị trí', text: duongDan }, { nhan: 'Mô tả mẫu', text: ph.mo_ta }]
          .concat([{ text: `Mẫu chưa được khai báo sau ${layHan(db).CHO_BO_NGAY} ngày kể từ lần nhắc đầu tiên có thể bị quản lý loại bỏ.` }]),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiNhac && nguoiNhac.id, nguoiNhan), '[Ngân hàng mẫu] Nhắc khai báo mẫu chưa có thông tin', thu);
    },

    /** Chủ mẫu đã khai báo mẫu từng bị đánh dấu chưa khai báo → quản lý. */
    daKhaiBao({ ph, tube, nguoiKhai, duongDan }) {
      const thu = dungThu([{ text: `${ten(nguoiKhai)} đã nhận và khai báo mẫu từng bị đánh dấu «chưa khai báo».` }].concat(thongTinMau(tube, duongDan)), lienKet('#cong-viec'));
      return guiDen(gop(nguoiKhai.id, quanLyModule(db)), `[Ngân hàng mẫu] Đã khai báo mẫu: ${tube.name}`, thu);
    },

    /** Mẫu nghi mất → chủ mẫu, trưởng nhóm, quản lý. */
    nghiMat({ vv, tube, nguoiBao, duongDan }) {
      const thu = dungThu(
        [{ text: `Mẫu dưới đây bị báo không còn ở vị trí (nguồn: ${vv.nguon === 'kiem_ke' ? 'kiểm kê hộp' : 'báo của chủ mẫu / quản lý'}). Nếu bạn đã lấy mẫu này, vui lòng vào hệ thống bấm «Tôi đã lấy mẫu này».` }]
          .concat(thongTinMau(tube, duongDan)).concat(vv.mo_ta ? [{ nhan: 'Ghi chú', text: vv.mo_ta }] : []),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiBao && nguoiBao.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)], quanLyModule(db)),
        `[Ngân hàng mẫu] Mẫu nghi mất: ${tube.name}`, thu);
    },

    /** Có người nhận đã lấy mẫu → chủ mẫu xác nhận + quản lý. */
    nguoiNhanLay({ vv, tube, nguoiNhan, duongDan }) {
      const thu = dungThu(
        [{ text: `${ten(nguoiNhan)} cho biết đã lấy mẫu này (không qua yêu cầu). Chủ mẫu vui lòng xác nhận hoặc từ chối trong hệ thống.` }]
          .concat(thongTinMau(tube, duongDan)).concat(vv.nhan_ghi_chu ? [{ nhan: 'Ghi chú của người lấy', text: vv.nhan_ghi_chu }] : []),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiNhan.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)], quanLyModule(db)),
        `[Ngân hàng mẫu] Có người nhận đã lấy mẫu: ${tube.name}`, thu);
    },

    /** Quản lý chốt thất lạc → chủ mẫu. */
    thatLac({ vv, tube, nguoiXuLy, duongDan }) {
      const thu = dungThu(
        [{ text: 'Mẫu nghi mất đã được chốt là THẤT LẠC (hết hạn chờ mà không ai nhận hay tìm thấy).' }]
          .concat(thongTinMau(tube, duongDan)).concat([{ nhan: 'Người chốt', text: ten(nguoiXuLy) }, { nhan: 'Lý do', text: vv.ly_do_xu_ly || '' }]),
        lienKet('#cong-viec')
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)]),
        `[Ngân hàng mẫu] Mẫu thất lạc: ${tube.name}`, thu);
    },
  };
}

module.exports = { taoThongBao };
