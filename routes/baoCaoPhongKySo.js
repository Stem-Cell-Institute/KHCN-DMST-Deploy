/**
 * Viện trưởng DUYỆT VÀ KÝ SỐ báo cáo phòng ban qua MySign (Viettel-CA) — router con của routes/baoCaoPhong.js.
 * Hạ tầng ký (liên kết tài khoản, gọi MySign, chữ ký PAdES trong PDF) nằm ở services/mysign/, dùng chung với module khác.
 *
 *   POST /dot/:id/ky-so            Viện trưởng chọn một hoặc nhiều báo cáo của đợt: { bao_cao: [{id, nop_luc}], ghi_chu? }.
 *                                  Dựng PDF từng báo cáo (có ô chữ ký số ở cột Viện trưởng) rồi gửi MỘT yêu cầu ký sang MySign:
 *                                  Viện trưởng xác nhận một lần trên điện thoại cho cả nhóm. Trả giao dịch để giao diện hỏi tiến độ
 *                                  qua GET /api/mysign/giao-dich/:id.
 *   GET  /bao-cao/:id/ky-so/xem-truoc  PDF xem trước (chưa có khung) + thông tin trang (header X-Ky-So-Meta) để Viện trưởng kéo khung chữ ký.
 *   GET  /bao-cao/:id/ban-ky-so    tải PDF đã ký số của bản nộp hiện tại (ai xem được báo cáo thì tải được).
 *
 * Vị trí khung chữ ký: mỗi báo cáo trong yêu cầu ký có thể kèm vi_tri {trang, x, y, w, h} (tỉ lệ 0..1 so với khổ trang, gốc trên-trái, trang từ 0)
 * hoặc MẢNG tối đa 4 vị trí khi văn bản cần ký ở nhiều chỗ: chữ ký số thật nằm ở chỗ đầu, các chỗ sau là khung lặp lại cùng nội dung
 * (một người ký, một lần xác nhận). Không kèm thì khung ở vị trí mặc định của biểu mẫu. Các chỗ ký lần gần nhất được nhớ theo người ký.
 *
 * Quy tắc (mỗi dòng đều có test):
 *   - "Duyệt" chỉ được ghi khi chữ ký về thành công: từ chối / hết hạn / lỗi trên MySign thì báo cáo giữ nguyên như chưa ký.
 *   - Ký đúng bản Viện trưởng đã đọc (nop_luc như quyết định thường). Phòng nộp lại trong lúc chờ ký thì chữ ký không gán cho bản mới.
 *   - Đã ký số thì không đổi quyết định được nữa (chữ ký số không rút lại được). Muốn khác thì phòng phải nộp bản mới.
 *   - Mỗi báo cáo chỉ có một yêu cầu ký đang chờ; trong lúc chờ cũng không quyết định kiểu thường được.
 *   - Không duyệt / Đề nghị chỉnh sửa giữ nguyên cách cũ (không ký), vì đi kèm lý do gửi qua email.
 */

const express = require('express');
const Xuat = require('../services/baoCaoPhongXuat');
const { contentDisposition } = require('../lib/filenames');
const { LoiMySign } = require('../services/mysign/client');
const { kiemDanhSachViTri } = require('../services/mysign/viTri');
const KhungKy = require('../services/mysign/khungKy');

const NGUON = 'bao_cao_phong';
const TOI_DA_MOT_LAN = 50;
const LY_DO_KY = 'Phê duyệt báo cáo';
const { gioVietNam } = KhungKy;

/** Tên người trong DN chứng thư (CN=...), để ghi vào lịch sử. */
const tenTrongChungThu = (dn) => (String(dn || '').match(/CN=([^,\n]+)/) || [])[1] || '';

module.exports = function createKySoRouter({ db, kySo, vt, thongBao, guiNen, loi, bao, docId, parseJson, nap, ghiLichSu }) {
  const router = express.Router();
  const batKySo = () => !!(kySo && kySo.mysign.daCauHinh());

  /**
   * Trạng thái ký số của BẢN NỘP hiện tại của một báo cáo: {trang_thai:'da_ky', luc, nguoi_ky} | {trang_thai:'dang_cho', giao_dich_id} | null.
   */
  function kyCuaBaoCao(baoCaoId, nopLuc) {
    if (!kySo) return null;
    const cho = kySo.dangCho(NGUON, baoCaoId);
    if (cho) return { trang_thai: 'dang_cho', giao_dich_id: cho.id };
    const da = kySo.banDaKy(NGUON, baoCaoId);
    if (da && parseJson(da.meta_json, {}).nop_luc === nopLuc) return { trang_thai: 'da_ky', luc: da.ky_luc, nguoi_ky: tenTrongChungThu(da.chu_the) };
    return null;
  }

  if (kySo) {
    kySo.dangKyNguon(NGUON, {
      /** Chạy trong giao dịch CSDL lúc chữ ký về: ghi "Viện trưởng duyệt" + "đã ký số" cho đúng bản đã ký. */
      khiThanhCong({ giaoDich, taiLieu }) {
        const huy = [];
        const dotIds = new Set();
        const truoc = new Map();
        for (const t of taiLieu) {
          const b = db.prepare('SELECT id, dot_id, trang_thai, nop_luc FROM bcp_bao_cao WHERE id = ?').get(t.nguon_id);
          if (!b || b.nop_luc !== t.meta.nop_luc || (b.trang_thai !== 'da_nop' && b.trang_thai !== 'da_duyet')) {
            huy.push(t.id);
            continue;
          }
          if (!truoc.has(b.dot_id)) truoc.set(b.dot_id, vt.tienDoDot(b.dot_id));
          dotIds.add(b.dot_id);
          const hienTai = vt.quyetDinhMotBaoCao(b.id);
          const ghiChu = t.meta.ghi_chu || '';
          if (!hienTai || hienTai.quyet_dinh !== 'duyet' || (hienTai.ghi_chu || '') !== ghiChu) ghiLichSu(b.id, 'vt_duyet', giaoDich.user_id, ghiChu);
          ghiLichSu(b.id, 'vt_ky_so', giaoDich.user_id, 'Ký số qua MySign' + (giaoDich.chu_the ? ' — ' + tenTrongChungThu(giaoDich.chu_the) : ''));
        }
        // Xử lý xong báo cáo cuối cùng đang chờ → MỘT thư tổng kết cho người quản lý (như quyết định thường).
        for (const dotId of dotIds) {
          const sau = vt.tienDoDot(dotId);
          if (truoc.get(dotId).cho_quyet_dinh > 0 && sau.cho_quyet_dinh === 0) guiNen(thongBao.baoDaXuLyXong(dotId, giaoDich.user_id, sau));
        }
        return huy;
      },
    });
  }

  router.post(
    '/dot/:id/ky-so',
    bao(async (req, res) => {
      if (!req.bcp.laVienTruong) return loi(res, 403, 'Chỉ Viện trưởng mới ký số duyệt báo cáo.');
      if (!batKySo()) return loi(res, 409, 'Hệ thống chưa được cấu hình chữ ký số MySign.');
      const dotId = docId(req.params.id);
      if (!dotId) return loi(res, 400, 'ID không hợp lệ.');
      const body = req.body || {};
      const ds = Array.isArray(body.bao_cao) ? body.bao_cao : [];
      if (!ds.length || ds.length > TOI_DA_MOT_LAN) return loi(res, 400, `Chọn từ 1 đến ${TOI_DA_MOT_LAN} báo cáo để ký.`);
      const ghiChu = typeof body.ghi_chu === 'string' ? body.ghi_chu.trim() : '';
      if (ghiChu.length > 2000) return loi(res, 400, 'Nội dung tối đa 2000 ký tự.');
      // Dòng thông tin trong khung chữ ký: người ký chọn; không gửi thì dùng lựa chọn đã lưu lần trước.
      const tcKhung = KhungKy.kiemTuyChon(body.khung, kySo.tuyChonKhung(req.user.id));
      if (tcKhung.loi) return loi(res, 400, tcKhung.loi);
      const tuyChonKhung = tcKhung.tuy_chon;
      const hinh = tuyChonKhung.hinh ? kySo.docHinh(req.user.id) : null;

      const dot = db
        .prepare('SELECT d.id, d.tieu_de, d.loai, d.ky, d.trang_thai, v.truong_json FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id WHERE d.id = ?')
        .get(dotId);
      if (!dot) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      if (!db.prepare('SELECT 1 AS ok FROM bcp_trinh_lan WHERE dot_id = ?').get(dotId)) return loi(res, 409, 'Đợt này chưa được người quản lý module trình Viện trưởng.');

      const chon = [];
      const viTriTheoId = new Map();
      const daThay = new Set();
      for (const x of ds) {
        const id = docId(x && x.id);
        if (!id || daThay.has(id)) return loi(res, 400, 'Danh sách báo cáo không hợp lệ.');
        daThay.add(id);
        const n = nap(req, id);
        if (!n || n.b.dot_id !== dotId) return loi(res, 404, 'Có báo cáo không thuộc đợt báo cáo này.');
        const b = n.b;
        if (b.trang_thai !== 'da_nop' && b.trang_thai !== 'da_duyet') return loi(res, 409, `Báo cáo của ${b.phong_ten} chưa nộp hoặc đang chỉnh sửa nên chưa ký được.`);
        if (typeof x.nop_luc !== 'string' || x.nop_luc !== b.nop_luc) {
          return loi(res, 409, `Báo cáo của ${b.phong_ten} vừa được nộp lại hoặc thay đổi. Hãy tải lại trang để đọc bản mới trước khi ký.`);
        }
        if (x.vi_tri !== undefined) {
          // Một vị trí (bản cũ) hoặc danh sách nhiều chỗ ký trong cùng báo cáo.
          const kq = kiemDanhSachViTri(x.vi_tri);
          if (kq.loi) return loi(res, 400, kq.loi);
          viTriTheoId.set(id, kq.vi_tri_ds);
        }
        const ky = kyCuaBaoCao(id, b.nop_luc);
        if (ky && ky.trang_thai === 'da_ky') return loi(res, 409, `Báo cáo của ${b.phong_ten} đã được ký số.`);
        if (ky && ky.trang_thai === 'dang_cho') return loi(res, 409, `Báo cáo của ${b.phong_ten} đang có yêu cầu ký chờ xác nhận trên MySign.`);
        chon.push(b);
      }

      const truong = parseJson(dot.truong_json, []);
      const nguoiKy = (db.prepare('SELECT fullname FROM users WHERE id = ?').get(req.user.id) || {}).fullname || req.user.fullname || req.user.email || '';
      const luc = new Date();
      const metaTrang = new Map(); // id báo cáo → số trang thật (để nhớ "trang cuối")
      const taiLieu = chon.map((b) => {
        const r = db
          .prepare(
            `SELECT CASE WHEN uc.fullname IS NULL THEN p.ten ELSE p.ten || ' — ' || uc.fullname END AS phong_ten, u.fullname AS nguoi_nop
               FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id
               LEFT JOIN users u ON u.id = b.nguoi_nop_id LEFT JOIN users uc ON uc.id = b.chu_id
              WHERE b.id = ?`
          )
          .get(b.id);
        return {
          nguonId: b.id,
          ten: 'Bao cao ' + r.phong_ten,
          meta: { nop_luc: b.nop_luc, dot_id: dotId, ghi_chu: ghiChu },
          taoPdfCho: async ({ chungThu } = {}) => {
            // Tên hiển thị theo chứng thư (đúng người đứng tên chứng thư số); không đọc được thì dùng tên trong hệ thống.
            const hoTen = (chungThu && chungThu.cn) || nguoiKy;
            const dong = KhungKy.dungDong({
              tuyChon: tuyChonKhung,
              thongTin: { ho_ten: hoTen, to_chuc: chungThu && chungThu.to_chuc, so_seri: chungThu && chungThu.so_seri, ly_do: LY_DO_KY, noi_ky: Xuat.CO_QUAN.noi_viet },
              thoiGian: gioVietNam(luc),
            });
            const kq = await Xuat.taoPdfChiTiet(
              [
                Xuat.dungMoHinh({
                  dot,
                  truong,
                  baoCao: { phong_ten: r.phong_ten, nguoi_nop: r.nguoi_nop || '', du_lieu: parseJson(b.du_lieu_json, {}) },
                  ngayXuat: luc,
                  kySo: { ten: hoTen, dong },
                }),
              ],
              { choKy: { ten: hoTen, lyDo: LY_DO_KY, noiKy: Xuat.CO_QUAN.noi_viet, luc, viTri: viTriTheoId.get(b.id), hinh: hinh && hinh.buf } }
            );
            metaTrang.set(b.id, kq.meta.so_trang);
            return kq.pdf;
          },
        };
      });

      try {
        const g = await kySo.batDau({ userId: req.user.id, nguon: NGUON, moTa: 'Duyet ' + (chon.length === 1 ? taiLieu[0].ten : chon.length + ' bao cao') + ' - ' + dot.tieu_de, taiLieu });
        // Nhớ lựa chọn dòng thông tin cho lần sau (chỉ khi người ký tự chọn).
        if (body.khung !== undefined) kySo.luuTuyChonKhung(req.user.id, tuyChonKhung);
        // Nhớ các chỗ ký của báo cáo cuối trong nhóm cho lần sau (chỉ khi người ký tự đặt).
        const cuoi = [...chon].reverse().find((b) => viTriTheoId.has(b.id));
        if (cuoi) {
          const soTrangCuoi = (metaTrang.get(cuoi.id) || 0) - 1;
          const ds = viTriTheoId.get(cuoi.id).map((v) => ({ ...v, trang_cuoi: v.trang === soTrangCuoi }));
          kySo.luuViTri(req.user.id, NGUON, ds[0], ds.slice(1));
        }
        res.json({ ok: true, giao_dich: g });
      } catch (e) {
        if (e && e.maLoi === 'vi_tri') return loi(res, 400, e.message);
        if (!(e instanceof LoiMySign)) throw e;
        loi(res, e.ma === 'chua_lien_ket' ? 409 : 502, e.nguoiDung, { ma: e.ma || 'mysign' });
      }
    })
  );

  router.get(
    '/bao-cao/:id/ky-so/xem-truoc',
    bao(async (req, res) => {
      if (!req.bcp.laVienTruong) return loi(res, 403, 'Chỉ Viện trưởng mới ký số duyệt báo cáo.');
      if (!batKySo()) return loi(res, 409, 'Hệ thống chưa được cấu hình chữ ký số MySign.');
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const b = n.b;
      if (!db.prepare('SELECT 1 AS ok FROM bcp_trinh_lan WHERE dot_id = ?').get(b.dot_id)) return loi(res, 409, 'Đợt này chưa được người quản lý module trình Viện trưởng.');
      if (b.trang_thai !== 'da_nop' && b.trang_thai !== 'da_duyet') return loi(res, 409, 'Báo cáo chưa nộp hoặc đang chỉnh sửa nên chưa ký được.');
      const dot = db
        .prepare('SELECT d.id, d.tieu_de, d.loai, d.ky, d.trang_thai, v.truong_json FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id WHERE d.id = ?')
        .get(b.dot_id);
      const r = db
        .prepare(
          `SELECT CASE WHEN uc.fullname IS NULL THEN p.ten ELSE p.ten || ' — ' || uc.fullname END AS phong_ten, u.fullname AS nguoi_nop
             FROM bcp_bao_cao b JOIN bcp_phong p ON p.id = b.phong_id
             LEFT JOIN users u ON u.id = b.nguoi_nop_id LEFT JOIN users uc ON uc.id = b.chu_id WHERE b.id = ?`
        )
        .get(id);
      const nguoiKy = (db.prepare('SELECT fullname FROM users WHERE id = ?').get(req.user.id) || {}).fullname || req.user.fullname || '';
      const kq = await Xuat.taoPdfChiTiet(
        [
          Xuat.dungMoHinh({
            dot, truong: parseJson(dot.truong_json, []),
            baoCao: { phong_ten: r.phong_ten, nguoi_nop: r.nguoi_nop || '', du_lieu: parseJson(b.du_lieu_json, {}) },
            ngayXuat: new Date(),
            kySo: { ten: nguoiKy, dong: ['ĐÃ KÝ SỐ', 'Người ký: ' + nguoiKy, 'Thời gian: (lúc ký)', 'Qua MySign — Viettel-CA'] },
          }),
        ],
        { xemTruocKy: true }
      );
      const khung = await kySo.khungCuaNguoi(req.user.id, { lyDo: LY_DO_KY, noiKy: Xuat.CO_QUAN.noi_viet, tenMacDinh: nguoiKy });
      const meta = { nop_luc: b.nop_luc, ten: r.phong_ten, ...kq.meta, gan_nhat: kySo.viTriGanNhat(req.user.id, NGUON), khung };
      res.setHeader('Content-Type', 'application/pdf');
      // Tiêu đề HTTP chỉ nhận ASCII: JSON được escape các ký tự có dấu.
      res.setHeader('X-Ky-So-Meta', JSON.stringify(meta).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
      res.setHeader('Content-Length', kq.pdf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(kq.pdf);
    })
  );

  router.get(
    '/bao-cao/:id/ban-ky-so',
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const da = kySo && kySo.banDaKy(NGUON, id);
      if (!da || parseJson(da.meta_json, {}).nop_luc !== n.b.nop_luc) return loi(res, 404, 'Bản nộp hiện tại của báo cáo này chưa được ký số.');
      const buf = kySo.docTep(da.tep_da_ky);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition(`Báo cáo ${n.b.phong_ten} - đã ký số.pdf`, { inline: req.query.xem === '1' }));
      res.setHeader('Content-Length', buf.length);
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    })
  );

  return { router, kyCuaBaoCao, batKySo };
};
