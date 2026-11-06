'use strict';

/**
 * Email thông báo của module Ngân hàng Tế bào & Kháng thể.
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
const { layHan, CAP_VN, quanLyModule, nganHangCuaHop, nguoiConHoatDong, truongNhomHieuLuc, hopKhangThe } = require('./nganHangTeBaoKhangTheYeuCau');
const { NGAN_HANG } = require('./nganHangTeBaoKhangThe');

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
  /** «[Ngân hàng kháng thể]» theo hộp chứa mẫu; quản lý đúng ngân hàng của mẫu. */
  const tt = (boxId) => '[' + NGAN_HANG[nganHangCuaHop(db, boxId)] + ']';
  const ql = (boxId) => quanLyModule(db, nganHangCuaHop(db, boxId));
  const lienKet = (hash, boxId) => (goc ? `${goc}${TRANG}?nh=${nganHangCuaHop(db, boxId)}${hash || ''}` : '');
  const linkPhieu = (id, boxId) => (goc ? [{ nhan: 'Phiếu yêu cầu', text: 'Mở và in phiếu (cần đăng nhập)', href: `${goc}/api/ngan-hang-te-bao-khang-the/requests/${id}/print?nh=${nganHangCuaHop(db, boxId)}` }] : []);

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
  const thongTinMau = (t, duongDan, yc) => [
    { nhan: 'Mẫu', text: t.name },
    duongDan ? { nhan: 'Vị trí', text: duongDan } : null,
    yc && yc.so_ul_yeu_cau != null ? { nhan: 'Thể tích yêu cầu', text: yc.so_ul_yeu_cau + ' µL' } : null,
  ].filter(Boolean);

  return {
    gop,
    guiDen,
    lienKet,

    /** Có yêu cầu mới → người duyệt ở cấp hiện tại (ngân hàng kháng thể: thêm thư «để theo dõi» cho các quản lý). */
    async yeuCauMoi({ yc, tube, nguoiGui, duongDan, nguoiDuyet, uyQuyen }) {
      const khangThe = hopKhangThe(db, tube.box_id);
      const thongTin = thongTinMau(tube, duongDan, yc).concat(yc.ly_do ? [{ nhan: 'Lý do', text: yc.ly_do }] : []).concat(uyQuyen && uyQuyen.length ? [{ nhan: 'Được Viện trưởng ủy quyền duyệt', text: uyQuyen.join(', ') }] : []);
      const thu = dungThu(
        [{ text: `${ten(nguoiGui)} yêu cầu lấy một mẫu cần bạn duyệt (cấp duyệt: ${yc.cap_ten || CAP_VN[yc.cap]}).` }]
          .concat(thongTin)
          .concat([{ text: khangThe ? 'Vui lòng duyệt hoặc từ chối trong hệ thống. Sau khi duyệt, quản lý ngân hàng kháng thể sẽ giao mẫu theo quyết định của bạn.' : `Vui lòng duyệt hoặc từ chối trong vòng ${layHan(db).PHAN_HOI_NGAY} ngày; quá hạn yêu cầu sẽ chuyển cho quản lý module.` }]),
        lienKet('#cong-viec', tube.box_id)
      );
      const kq = await guiDen(gop(nguoiGui.id, nguoiDuyet), `${tt(tube.box_id)} Yêu cầu lấy mẫu: ${tube.name}`, thu);
      if (!khangThe) return kq;
      // quản lý ngân hàng kháng thể: được báo để theo dõi, KHÔNG duyệt (chỉ Viện trưởng duyệt)
      const duyet = new Set((nguoiDuyet || []).map((u) => u.id));
      const theoDoi = dungThu(
        [{ text: `${ten(nguoiGui)} vừa gửi yêu cầu lấy mẫu của ngân hàng kháng thể. Viện trưởng sẽ duyệt; bạn theo dõi và sẽ giao mẫu sau khi được duyệt.` }].concat(thongTin),
        lienKet('#cong-viec', tube.box_id)
      );
      const kq2 = await guiDen(gop(nguoiGui.id, ql(tube.box_id).filter((u) => !duyet.has(u.id))), `${tt(tube.box_id)} Yêu cầu lấy mẫu chờ Viện trưởng duyệt: ${tube.name}`, theoDoi);
      return { gui: kq.gui + kq2.gui, loi: kq.loi + kq2.loi, nguoi_nhan: kq.nguoi_nhan + kq2.nguoi_nhan };
    },

    /** Đã duyệt → người yêu cầu + quản lý module (để xử lý giao mẫu). Ngân hàng kháng thể: quản lý nhận thư riêng «hãy giao mẫu theo lệnh duyệt». */
    async yeuCauDaDuyet({ yc, tube, nguoiGui, nguoiXuLy, duongDan, xuLyThay, uyQuyenTen, donViTen, dongDuyet }) {
      if (hopKhangThe(db, tube.box_id)) {
        const chung = [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} đã được ${uyQuyenTen ? ten(nguoiXuLy) + ' duyệt theo ủy quyền của Viện trưởng ' + uyQuyenTen : 'Viện trưởng duyệt'}${xuLyThay ? ' (admin xử lý thay: ' + (yc.ly_do_xu_ly || '') + ')' : ''}.` }]
          .concat(thongTinMau(tube, duongDan, yc))
          .concat([{ nhan: 'Người duyệt', text: ten(nguoiXuLy) }].concat(yc.ly_do_xu_ly ? [{ nhan: 'Ghi chú của người duyệt', text: yc.ly_do_xu_ly }] : []));
        const toiNguoiXin = dungThu(chung.concat([{ text: `Quản lý ${donViTen || 'ngân hàng kháng thể'} sẽ liên hệ giao mẫu cho bạn.` }]).concat(linkPhieu(yc.id, tube.box_id)), lienKet('#cong-viec', tube.box_id));
        const toiQuanLy = dungThu(chung.concat([{ nhan: 'Người nhận mẫu', text: ten(nguoiGui) }, { text: 'Việc của quản lý: giao mẫu cho người yêu cầu theo đúng quyết định của Viện trưởng, rồi ghi nhận trong hệ thống («Giao mẫu»).' }]).concat(linkPhieu(yc.id, tube.box_id)), lienKet('#cong-viec', tube.box_id));
        const quanLy = ql(tube.box_id);
        const ids = new Set(quanLy.map((u) => u.id));
        const a = await guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui], (dongDuyet || []).filter((u) => !ids.has(u.id))), `${tt(tube.box_id)} Đã duyệt yêu cầu lấy mẫu: ${tube.name}`, toiNguoiXin);
        const b = await guiDen(gop(nguoiXuLy && nguoiXuLy.id, quanLy), `${tt(tube.box_id)} Đã duyệt — cần giao mẫu: ${tube.name}`, toiQuanLy);
        return { gui: a.gui + b.gui, loi: a.loi + b.loi, nguoi_nhan: a.nguoi_nhan + b.nguoi_nhan };
      }
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} đã được duyệt${xuLyThay ? ' (quản lý xử lý thay: ' + (yc.ly_do_xu_ly || '') + ')' : ''}.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat([{ nhan: 'Người duyệt', text: ten(nguoiXuLy) }].concat(yc.ly_do_xu_ly ? [{ nhan: 'Ghi chú của người duyệt', text: yc.ly_do_xu_ly }] : []))
          .concat([{ text: `${donViTen ? 'Quản lý ' + donViTen : 'Quản lý module'} sẽ liên hệ giao mẫu.` }])
          .concat(linkPhieu(yc.id, tube.box_id)),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui], ql(tube.box_id), dongDuyet), `${tt(tube.box_id)} Đã duyệt yêu cầu lấy mẫu: ${tube.name}`, thu);
    },

    /** Bị từ chối → người yêu cầu. */
    yeuCauTuChoi({ yc, tube, nguoiGui, nguoiXuLy, duongDan, dongDuyet }) {
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} đã bị từ chối.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat([{ nhan: 'Người xử lý', text: ten(nguoiXuLy) }, { nhan: 'Lý do', text: yc.ly_do_xu_ly || '(không ghi)' }])
          .concat(linkPhieu(yc.id, tube.box_id)),
        lienKet('#cong-viec', tube.box_id)
      );
      // người yêu cầu và quản lý module cùng được báo (người vừa từ chối không nhận lại)
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui], ql(tube.box_id), dongDuyet), `${tt(tube.box_id)} Yêu cầu lấy mẫu bị từ chối: ${tube.name}`, thu);
    },

    /** Quá hạn phản hồi → chuyển quản lý module. */
    yeuCauLeoThang({ yc, tube, nguoiGui, duongDan, capCu, capCuTen }) {
      const thu = dungThu(
        [{ text: `Yêu cầu lấy mẫu của ${ten(nguoiGui)} chưa được ${capCuTen || CAP_VN[capCu] || 'người duyệt'} xử lý quá hạn nên chuyển cho quản lý module. Bạn có thể duyệt hoặc từ chối.` }]
          .concat(thongTinMau(tube, duongDan))
          .concat(yc.ly_do ? [{ nhan: 'Lý do', text: yc.ly_do }] : []),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(null, ql(tube.box_id)), `${tt(tube.box_id)} Yêu cầu quá hạn cần quản lý xử lý: ${tube.name}`, thu);
    },

    /** Đã giao / đã trả mẫu → người yêu cầu. Ngân hàng kháng thể: kèm số µL giao và số còn lại. */
    yeuCauGiaoTra({ tube, nguoiGui, nguoiXuLy, duongDan, hanhDong, soUl, conLai, het }) {
      const thu = dungThu(
        [{ text: hanhDong === 'giao' ? 'Mẫu bạn yêu cầu đã được giao cho bạn.' : 'Mẫu bạn mượn đã được ghi nhận trả lại kho.' }]
          .concat(thongTinMau(tube, duongDan))
          .concat(soUl != null ? [{ nhan: 'Thể tích giao', text: soUl + ' µL' }] : [])
          .concat(hanhDong === 'tra' && het ? [{ text: 'Ống đã hết nên được bỏ khỏi kho.' }] : [])
          .concat([{ nhan: 'Người thực hiện', text: ten(nguoiXuLy) }]),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiGui]), `${tt(tube.box_id)} ${hanhDong === 'giao' ? 'Đã giao' : 'Đã nhận lại'} mẫu: ${tube.name}`, thu);
    },

    /** Viện trưởng cấp / thu hồi ủy quyền duyệt → người được ủy quyền. */
    uyQuyen({ hanhDong, nguoi, vienTruong, phamVi, denNgay, ghiChu }) {
      const cap = hanhDong === 'cap';
      const thu = dungThu(
        [{ text: cap ? `${ten(vienTruong)} vừa ủy quyền cho bạn duyệt yêu cầu lấy kháng thể.` : `${ten(vienTruong)} đã thu hồi ủy quyền duyệt của bạn.` }]
          .concat([{ nhan: 'Phạm vi', text: phamVi }])
          .concat(cap ? [{ nhan: 'Hiệu lực', text: denNgay ? 'đến hết ngày ' + denNgay.split('-').reverse().join('/') : 'cho tới khi thu hồi' }] : [])
          .concat(cap && ghiChu ? [{ nhan: 'Ghi chú', text: ghiChu }] : [])
          .concat(cap ? [{ text: 'Yêu cầu thuộc phạm vi này sẽ hiện ở «Việc cần xử lý». Mọi lần duyệt đều ghi «theo ủy quyền của Viện trưởng» vào lịch sử mẫu.' }] : []),
        goc ? `${goc}${TRANG}?nh=khang_the#cong-viec` : ''
      );
      return guiDen(gop(vienTruong && vienTruong.id, [nguoi]), `[${NGAN_HANG.khang_the}] ${cap ? 'Bạn được ủy quyền duyệt yêu cầu' : 'Đã thu hồi ủy quyền duyệt'}`, thu);
    },

    /** Ống kháng thể vừa chuyển sang «sắp hết» hoặc «hết» → quản lý ngân hàng kháng thể (để chuẩn bị mua / pha thêm). */
    theTichCanhBao({ tube, conLai, theTich, trangThai, duongDan }) {
      const het = trangThai === 'het';
      const thu = dungThu(
        [{ text: het ? 'Ống kháng thể dưới đây đã HẾT và được bỏ khỏi kho.' : `Ống kháng thể dưới đây SẮP HẾT (còn ${conLai} / ${theTich} µL).` }]
          .concat(thongTinMau(tube, duongDan)),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(null, ql(tube.box_id)), `${tt(tube.box_id)} ${het ? 'Đã hết' : 'Sắp hết'}: ${tube.name}`, thu);
    },

    /** Quản lý nhắc chủ mẫu khai báo mẫu có trong ô nhưng chưa có thông tin. */
    nhacKhaiBao({ ph, nguoiNhan, duongDan, nguoiNhac, lanThu }) {
      const thu = dungThu(
        [{ text: `Quản lý module phát hiện một mẫu trong hộp nhưng CHƯA có thông tin trong hệ thống${lanThu > 1 ? ' (nhắc lần ' + lanThu + ')' : ''}. Nếu là mẫu của bạn hoặc của nhóm bạn, vui lòng vào hệ thống bấm «Đây là mẫu của tôi» và điền thông tin.` },
          { nhan: 'Vị trí', text: duongDan }, { nhan: 'Mô tả mẫu', text: ph.mo_ta }]
          .concat([{ text: `Mẫu chưa được khai báo sau ${layHan(db).CHO_BO_NGAY} ngày kể từ lần nhắc đầu tiên có thể bị quản lý loại bỏ.` }]),
        lienKet('#cong-viec', ph.box_id)
      );
      return guiDen(gop(nguoiNhac && nguoiNhac.id, nguoiNhan), `${tt(ph.box_id)} Nhắc khai báo mẫu chưa có thông tin`, thu);
    },

    /** Chủ mẫu đã khai báo mẫu từng bị đánh dấu chưa khai báo → quản lý. */
    daKhaiBao({ ph, tube, nguoiKhai, duongDan }) {
      const thu = dungThu([{ text: `${ten(nguoiKhai)} đã nhận và khai báo mẫu từng bị đánh dấu «chưa khai báo».` }].concat(thongTinMau(tube, duongDan)), lienKet('#cong-viec', tube.box_id));
      return guiDen(gop(nguoiKhai.id, ql(tube.box_id)), `${tt(tube.box_id)} Đã khai báo mẫu: ${tube.name}`, thu);
    },

    /** Mẫu nghi mất → chủ mẫu, trưởng nhóm, quản lý. */
    nghiMat({ vv, tube, nguoiBao, duongDan }) {
      const thu = dungThu(
        [{ text: `Mẫu dưới đây bị báo không còn ở vị trí (nguồn: ${vv.nguon === 'kiem_ke' ? 'kiểm kê hộp' : 'báo của chủ mẫu / quản lý'}). Nếu bạn đã lấy mẫu này, vui lòng vào hệ thống bấm «Tôi đã lấy mẫu này».` }]
          .concat(thongTinMau(tube, duongDan)).concat(vv.mo_ta ? [{ nhan: 'Ghi chú', text: vv.mo_ta }] : []),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(nguoiBao && nguoiBao.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)], ql(tube.box_id)),
        `${tt(tube.box_id)} Mẫu nghi mất: ${tube.name}`, thu);
    },

    /** Có người nhận đã lấy mẫu → chủ mẫu xác nhận + quản lý. */
    nguoiNhanLay({ vv, tube, nguoiNhan, duongDan }) {
      const thu = dungThu(
        [{ text: `${ten(nguoiNhan)} cho biết đã lấy mẫu này (không qua yêu cầu). Chủ mẫu vui lòng xác nhận hoặc từ chối trong hệ thống.` }]
          .concat(thongTinMau(tube, duongDan)).concat(vv.nhan_ghi_chu ? [{ nhan: 'Ghi chú của người lấy', text: vv.nhan_ghi_chu }] : []),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(nguoiNhan.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)], ql(tube.box_id)),
        `${tt(tube.box_id)} Có người nhận đã lấy mẫu: ${tube.name}`, thu);
    },

    /** Thư nhắc việc đến hạn (kiểm kê, QC, nhiệt độ…) gộp theo người nhận. */
    nhacViec({ nguoiNhan, viec, nganHang }) {
      const doan = [{ text: `Có ${viec.length} việc đến hạn ở ${NGAN_HANG[nganHang] || 'ngân hàng'} cần bạn xem:` }]
        .concat(viec.map((v) => ({ nhan: v.muc === 'do' ? 'KHẨN' : 'Đến hạn', text: `${v.tieu_de} — ${v.chi_tiet}` })))
        .concat([{ text: 'Việc nào chưa làm sẽ được nhắc lại định kỳ. Xem đầy đủ ở «Việc cần xử lý» → «Đến hạn».' }]);
      const thu = dungThu(doan, goc ? `${goc}${TRANG}?nh=${nganHang}#den-han` : '');
      return guiDen(gop(null, [nguoiNhan]), `[${NGAN_HANG[nganHang]}] ${viec.some((v) => v.muc === 'do') ? 'KHẨN: ' : ''}${viec.length} việc đến hạn`, thu);
    },

    /** Số đo nhiệt độ ra ngoài khoảng cho phép → quản lý + người tạo thiết bị (không báo người vừa ghi). */
    canhBaoNhiet({ tb, soDo, nguong, nguoiGhi, nguoiNhan }) {
      const khoang = `${nguong.duoi != null ? nguong.duoi : '…'} đến ${nguong.tren != null ? nguong.tren : '…'}°C`;
      const thu = dungThu(
        [{ text: `Nhiệt độ của thiết bị dưới đây ra ngoài khoảng cho phép. Hãy kiểm tra thiết bị ngay; nếu cần, chuyển mẫu sang thiết bị khác rồi ghi nhận đã xử lý trong hệ thống.` },
          { nhan: 'Thiết bị', text: tb.name },
          { nhan: 'Số đo', text: `${String(soDo.nhiet_do).replace('.', ',')}°C` },
          { nhan: 'Khoảng cho phép', text: khoang },
          { nhan: 'Người ghi', text: ten(nguoiGhi) }]
          .concat(soDo.ghi_chu ? [{ nhan: 'Ghi chú', text: soDo.ghi_chu }] : []),
        goc ? `${goc}${TRANG}?nh=${tb.ngan_hang}#den-han` : ''
      );
      return guiDen(gop(nguoiGhi && nguoiGhi.id, nguoiNhan), `[${NGAN_HANG[tb.ngan_hang]}] CẢNH BÁO nhiệt độ: ${tb.name}`, thu);
    },

    /** Kết quả mycoplasma DƯƠNG TÍNH vừa được ghi → quản lý + người tạo dòng. */
    mycoDuongTinh({ dong, qc, nguoiGhi, nguoiNhan, soOng }) {
      const thu = dungThu(
        [{ text: 'Dòng tế bào dưới đây vừa có kết quả mycoplasma DƯƠNG TÍNH. Cách ly dòng này khỏi các dòng khác, xử lý hoặc loại bỏ, và thử lại sau xử lý.' },
          { nhan: 'Dòng', text: `${dong.ma} · ${dong.ten}` },
          { nhan: 'Ngày thử', text: String(qc.ngay).split('-').reverse().join('/') },
          qc.phuong_phap ? { nhan: 'Phương pháp', text: qc.phuong_phap } : null,
          { nhan: 'Số ống đang lưu', text: String(soOng) },
          { nhan: 'Người ghi', text: ten(nguoiGhi) }].filter(Boolean),
        goc ? `${goc}${TRANG}?nh=te_bao#den-han` : ''
      );
      return guiDen(gop(nguoiGhi && nguoiGhi.id, nguoiNhan), `[${NGAN_HANG.te_bao}] KHẨN: mycoplasma dương tính — ${dong.ma}`, thu);
    },

    /** Quản lý chốt thất lạc → chủ mẫu. */
    thatLac({ vv, tube, nguoiXuLy, duongDan }) {
      const thu = dungThu(
        [{ text: 'Mẫu nghi mất đã được chốt là THẤT LẠC (hết hạn chờ mà không ai nhận hay tìm thấy).' }]
          .concat(thongTinMau(tube, duongDan)).concat([{ nhan: 'Người chốt', text: ten(nguoiXuLy) }, { nhan: 'Lý do', text: vv.ly_do_xu_ly || '' }]),
        lienKet('#cong-viec', tube.box_id)
      );
      return guiDen(gop(nguoiXuLy && nguoiXuLy.id, [nguoiConHoatDong(db, tube.owner_user_id)], [truongNhomHieuLuc(db, tube.nhom_id)]),
        `${tt(tube.box_id)} Mẫu thất lạc: ${tube.name}`, thu);
    },
  };
}

module.exports = { taoThongBao };
