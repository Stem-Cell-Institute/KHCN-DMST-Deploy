const db = require('../db/db');
const projectService = require('./projectService');

/**
 * Định nghĩa chuẩn 18 đầu mục văn bản pháp lý xuyên suốt 7 giai đoạn
 * Phục vụ Quản lý tiến độ - Nghiệm thu - Thanh lý - Thanh tra Kiểm toán
 * Phân định rõ trách nhiệm theo thông lệ quản lý KH&CN tại Việt Nam:
 * - CHU_NHIEM: Chủ nhiệm đề tài lập và nộp
 * - PHONG_KHCN: Phòng KHCN / Hội đồng / Lãnh đạo Viện ban hành & lưu trữ
 * - PHONG_TC_CU: Phòng Tài chính - Cung ứng / Thủ kho phối hợp thực hiện
 */
const AUDIT_CRITERIA = [
  {
    key: 'THUYET_MINH',
    name: 'Thuyết minh đề tài (đã duyệt)',
    short_name: 'Thuyết minh',
    stage: 1,
    required: true,
    group: 'PHÁP LÝ & ĐỀ CƯƠNG',
    desc: 'Đề cương nghiên cứu chi tiết đã được Hội đồng và Lãnh đạo Viện phê duyệt',
    icon: 'fa-file-lines',
    needed_for: 'ALL',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'BB_XET_DUYET',
    name: 'Biên bản Hội đồng xét duyệt đề cương',
    short_name: 'BB Xét duyệt',
    stage: 2,
    required: true,
    group: 'PHÁP LÝ & ĐỀ CƯƠNG',
    desc: 'Biên bản họp Hội đồng xét duyệt đề tài cấp cơ sở và phiếu nhận xét phản biện',
    icon: 'fa-users',
    needed_for: 'ALL',
    owner_role: 'PHONG_KHCN',
    owner_label: 'P. KHCN lập & lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'QD_GIAO_NHIEM_VU',
    name: 'Quyết định giao nhiệm vụ KHCN',
    short_name: 'QĐ Giao việc',
    stage: 3,
    required: true,
    group: 'QUYẾT ĐỊNH & HỢP ĐỒNG',
    desc: 'Quyết định chính thức của Viện trưởng giao nhiệm vụ, xác định kinh phí và thời hạn',
    icon: 'fa-stamp',
    needed_for: 'ALL',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện trưởng ký / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'HOP_DONG_NCKH',
    name: 'Hợp đồng NCKH cấp cơ sở',
    short_name: 'Hợp đồng NCKH',
    stage: 3,
    required: true,
    group: 'QUYẾT ĐỊNH & HỢP ĐỒNG',
    desc: 'Hợp đồng nghiên cứu khoa học ký giữa Viện trưởng và Chủ nhiệm đề tài',
    icon: 'fa-file-contract',
    needed_for: 'ALL',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện & Chủ nhiệm ký / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'DU_TOAN_DA_DUYET',
    name: 'Bản Dự toán kinh phí đã phê duyệt',
    short_name: 'Dự toán duyệt',
    stage: 3,
    required: true,
    group: 'TÀI CHÍNH & VẬT TƯ',
    desc: 'Bản phụ lục dự toán chi tiết hóa chất, vật tư, sinh phẩm đã được thẩm định & phê duyệt',
    icon: 'fa-calculator',
    needed_for: 'ALL',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm lập / P. KHCN & TC duyệt',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'PHONG_TC_CU', 'SUPER_ADMIN']
  },
  {
    key: 'DON_DIEU_CHINH_DU_TOAN',
    name: 'Tờ trình đề xuất điều chỉnh dự toán kinh phí (nếu có)',
    short_name: 'Tờ trình ĐC Dự toán',
    stage: 3,
    requiredIfAdjusted: true,
    group: 'TÀI CHÍNH & VẬT TƯ',
    desc: 'Tờ trình của Chủ nhiệm đề tài đề xuất điều chỉnh cơ cấu kinh phí / danh mục hóa chất',
    icon: 'fa-file-signature',
    needed_for: 'LIQUIDATION',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm đề tài lập & nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'QD_DIEU_CHINH_DU_TOAN',
    name: 'Quyết định phê duyệt điều chỉnh dự toán (nếu có)',
    short_name: 'QĐ Điều chỉnh DT',
    stage: 3,
    requiredIfAdjusted: true,
    group: 'TÀI CHÍNH & VẬT TƯ',
    desc: 'Quyết định của Viện trưởng cho phép điều chỉnh cơ cấu kinh phí / danh mục hóa chất',
    icon: 'fa-file-invoice-dollar',
    needed_for: 'LIQUIDATION',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện trưởng duyệt / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'CHUNG_TU_VAT_TU',
    name: 'Biên bản cấp phát vật tư / Đơn hàng MISA',
    short_name: 'Chứng từ vật tư',
    stage: 4,
    required: true,
    group: 'TÀI CHÍNH & VẬT TƯ',
    desc: 'Phiếu xuất kho, biên bản giao nhận hóa chất hoặc mã đơn đặt hàng MISA phục vụ quyết toán',
    icon: 'fa-boxes-packing',
    needed_for: 'LIQUIDATION',
    owner_role: 'PHONG_TC_CU',
    owner_label: 'Thủ kho & P. TC-Cung ứng',
    allowed_upload_roles: ['THU_KHO', 'PHONG_TC_CU', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'BAO_CAO_6_THANG',
    name: 'Báo cáo tiến độ định kỳ 6 tháng/lần',
    short_name: 'Báo cáo 6 tháng',
    stage: 5,
    required: true,
    group: 'GIÁM SÁT TIẾN ĐỘ',
    desc: 'Báo cáo tiến độ định kỳ theo chu kỳ 6 tháng do Chủ nhiệm nộp kèm đánh giá của P. KHCN',
    icon: 'fa-clock-rotate-left',
    needed_for: 'ALL',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'DON_GIA_HAN_1',
    name: 'Đơn đề nghị gia hạn Lần 1 (6 tháng)',
    short_name: 'Đơn gia hạn L1',
    stage: 6,
    requiredIfExtended: true,
    group: 'GIÁM SÁT TIẾN ĐỘ & GIA HẠN',
    desc: 'Đơn xin gia hạn thời gian thực hiện lần 1 (+6 tháng) kèm giải trình khối lượng công việc',
    icon: 'fa-file-signature',
    needed_for: 'EXTENSION',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'QD_GIA_HAN_1',
    name: 'Quyết định cho phép gia hạn Lần 1',
    short_name: 'QĐ Gia hạn L1',
    stage: 6,
    requiredIfExtended: true,
    group: 'GIÁM SÁT TIẾN ĐỘ & GIA HẠN',
    desc: 'Quyết định chính thức của Viện trưởng cho phép gia hạn Lần 1 thêm 6 tháng',
    icon: 'fa-stamp',
    needed_for: 'EXTENSION',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện trưởng ký / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'DON_GIA_HAN_2',
    name: 'Đơn đề nghị gia hạn Lần 2 (6 tháng - Lần cuối)',
    short_name: 'Đơn gia hạn L2',
    stage: 6,
    requiredIfExtended: true,
    group: 'GIÁM SÁT TIẾN ĐỘ & GIA HẠN',
    desc: 'Đơn đề nghị gia hạn lần 2 (+6 tháng cuối cùng) kèm Bản cam kết tiến độ hoàn thành của Chủ nhiệm',
    icon: 'fa-file-pen',
    needed_for: 'EXTENSION',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'QD_GIA_HAN_2',
    name: 'Quyết định cho phép gia hạn Lần 2 (Lần cuối)',
    short_name: 'QĐ Gia hạn L2',
    stage: 6,
    requiredIfExtended: true,
    group: 'GIÁM SÁT TIẾN ĐỘ & GIA HẠN',
    desc: 'Quyết định của Viện trưởng cho phép gia hạn Lần 2 (+6 tháng) - Không được gia hạn thêm sau lần này',
    icon: 'fa-certificate',
    needed_for: 'EXTENSION',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện trưởng ký / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'BAO_CAO_TONG_KET',
    name: 'Báo cáo tổng kết đề tài & Tóm tắt',
    short_name: 'Báo cáo tổng kết',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Báo cáo khoa học tổng kết toàn bộ kết quả đề tài kèm file dữ liệu gốc do Chủ nhiệm nộp',
    icon: 'fa-book-open',
    needed_for: 'ACCEPTANCE',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'SAN_PHAM_KHCN',
    name: 'Minh chứng sản phẩm KHCN (Bài báo / Quy trình / Sáng chế)',
    short_name: 'Sản phẩm KHCN',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Bài báo khoa học ISI/Scopus/Trong nước, quy trình công nghệ hoặc sản phẩm đăng ký theo thuyết minh',
    icon: 'fa-award',
    needed_for: 'ACCEPTANCE',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'BB_NGHIEM_THU',
    name: 'Biên bản Hội đồng đánh giá nghiệm thu',
    short_name: 'BB Nghiệm thu',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Biên bản họp Hội đồng nghiệm thu cấp cơ sở và các phiếu nhận xét, đánh giá của ủy viên',
    icon: 'fa-check-double',
    needed_for: 'ACCEPTANCE',
    owner_role: 'PHONG_KHCN',
    owner_label: 'P. KHCN lập & lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'GIAI_TRINH_SAU_HOP',
    name: 'Bản giải trình tiếp thu sau nghiệm thu',
    short_name: 'Giải trình sau họp',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Bản giải trình chỉnh sửa hoàn thiện theo ý kiến Hội đồng có xác nhận của Chủ tịch HĐ',
    icon: 'fa-clipboard-check',
    needed_for: 'LIQUIDATION',
    owner_role: 'CHU_NHIEM',
    owner_label: 'Chủ nhiệm nộp',
    allowed_upload_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN']
  },
  {
    key: 'QD_CONG_NHAN',
    name: 'Quyết định công nhận kết quả nghiệm thu',
    short_name: 'QĐ Công nhận KQ',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Quyết định chính thức của Viện trưởng công nhận kết quả hoàn thành đề tài',
    icon: 'fa-certificate',
    needed_for: 'LIQUIDATION',
    owner_role: 'PHONG_KHCN',
    owner_label: 'Viện trưởng ký / P. KHCN lưu',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TCHC', 'SUPER_ADMIN']
  },
  {
    key: 'BB_THANH_LY',
    name: 'Biên bản thanh lý Hợp đồng & Báo cáo quyết toán',
    short_name: 'Thanh lý Hợp đồng',
    stage: 7,
    required: true,
    group: 'NGHIỆM THU & THANH LÝ',
    desc: 'Biên bản thanh lý Hợp đồng NCKH và Báo cáo quyết toán kinh phí có xác nhận của P. TC-Cung ứng & P. KHCN',
    icon: 'fa-handshake',
    needed_for: 'LIQUIDATION',
    owner_role: 'PHONG_TC_CU',
    owner_label: 'P. TC-Cung ứng & P. KHCN',
    allowed_upload_roles: ['PHONG_KHCN', 'PHONG_TC_CU', 'PHONG_TCHC', 'SUPER_ADMIN']
  }
];

// Tìm nhanh cấu hình tiêu chí theo mã
function getCriteriaByKey(key) {
  return AUDIT_CRITERIA.find(c => c.key === key) || null;
}

// Helper tìm file khớp với tiêu chí trong danh sách nckh_documents
function findMatchingDocument(crit, documents = []) {
  if (!documents || documents.length === 0) return null;

  // 1. Ưu tiên tuyệt đối: Khớp chính xác mã doc_type === crit.key
  let exact = documents.find(d => d.doc_type === crit.key);
  if (exact) return exact;

  // 2. Tương thích ngược với các mã doc_type cũ đã seed hoặc upload trước đây
  switch (crit.key) {
    case 'THUYET_MINH':
      return documents.find(d => d.doc_type === 'DE_CUONG' || (d.stage === 1 && d.title.toLowerCase().includes('thuyết minh')));
    case 'BB_XET_DUYET':
      return documents.find(d => d.stage === 2 && (d.title.toLowerCase().includes('xét duyệt') || d.title.toLowerCase().includes('biên bản')));
    case 'QD_GIAO_NHIEM_VU':
      return documents.find(d => d.stage === 3 && d.title.toLowerCase().includes('quyết định giao'));
    case 'HOP_DONG_NCKH':
      return documents.find(d => d.doc_type === 'HOP_DONG' || (d.stage === 3 && d.title.toLowerCase().includes('hợp đồng')));
    case 'DU_TOAN_DA_DUYET':
      return documents.find(d => d.stage === 3 && d.title.toLowerCase().includes('dự toán') && !d.title.toLowerCase().includes('điều chỉnh'));
    case 'DON_DIEU_CHINH_DU_TOAN':
      return documents.find(d => d.doc_type === 'DON_DIEU_CHINH_DU_TOAN' || (d.stage === 3 && d.title.toLowerCase().includes('tờ trình') && d.title.toLowerCase().includes('điều chỉnh')));
    case 'QD_DIEU_CHINH_DU_TOAN':
      return documents.find(d => d.doc_type === 'QD_DIEU_CHINH_DU_TOAN' || (d.stage === 3 && d.title.toLowerCase().includes('điều chỉnh dự toán') && !d.title.toLowerCase().includes('tờ trình')));
    case 'CHUNG_TU_VAT_TU':
      return documents.find(d => d.stage === 4);
    case 'BAO_CAO_6_THANG':
      return documents.find(d => d.stage === 5);
    case 'DON_GIA_HAN_1':
      return documents.find(d => d.doc_type === 'DON_GIA_HAN_1' || d.doc_type === 'DON_GIA_HAN' || (d.stage === 6 && d.title.toLowerCase().includes('đơn') && !d.title.toLowerCase().includes('lần 2')));
    case 'QD_GIA_HAN_1':
      return documents.find(d => d.doc_type === 'QD_GIA_HAN_1' || d.doc_type === 'QD_GIA_HAN' || (d.stage === 6 && d.title.toLowerCase().includes('quyết định') && !d.title.toLowerCase().includes('lần 2')));
    case 'DON_GIA_HAN_2':
      return documents.find(d => d.doc_type === 'DON_GIA_HAN_2' || (d.stage === 6 && d.title.toLowerCase().includes('đơn') && d.title.toLowerCase().includes('lần 2')));
    case 'QD_GIA_HAN_2':
      return documents.find(d => d.doc_type === 'QD_GIA_HAN_2' || (d.stage === 6 && d.title.toLowerCase().includes('quyết định') && d.title.toLowerCase().includes('lần 2')));
    case 'BAO_CAO_TONG_KET':
      return documents.find(d => d.stage === 7 && d.title.toLowerCase().includes('tổng kết'));
    case 'SAN_PHAM_KHCN':
      return documents.find(d => d.doc_type === 'SAN_PHAM' || (d.stage === 7 && (d.title.toLowerCase().includes('bài báo') || d.title.toLowerCase().includes('sản phẩm'))));
    case 'BB_NGHIEM_THU':
      return documents.find(d => d.doc_type === 'BIEN_BAN_NGHIEM_THU' || (d.stage === 7 && d.title.toLowerCase().includes('nghiệm thu') && d.title.toLowerCase().includes('biên bản')));
    case 'GIAI_TRINH_SAU_HOP':
      return documents.find(d => d.doc_type === 'GIAI_TRINH' || (d.stage === 7 && d.title.toLowerCase().includes('giải trình')));
    case 'QD_CONG_NHAN':
      return documents.find(d => d.stage === 7 && d.title.toLowerCase().includes('công nhận'));
    case 'BB_THANH_LY':
      return documents.find(d => d.stage === 7 && (d.title.toLowerCase().includes('thanh lý') || d.title.toLowerCase().includes('quyết toán')));
    default:
      return null;
  }
}

// Hàm đánh giá tình trạng hồ sơ pháp lý của một đề tài
function evaluateProjectAudit(project, documents = [], extensions = [], reports = [], supplies = [], overrides = [], adjustments = []) {
  const overrideMap = new Map();
  overrides.forEach(o => overrideMap.set(o.doc_key, o));

  const isExtended = (project.extension_count || 0) > 0;
  const extCount = project.extension_count || 0;
  const isCompleted = project.status === 'COMPLETED' || (project.final_evaluation || '').includes('Nghiệm thu');
  const isCancelled = project.status === 'CANCELLED';

  const items = [];
  let totalRequired = 0;
  let completedCount = 0;
  const missingAllList = [];
  const missingForAcceptance = [];
  const missingForLiquidation = [];
  const missingByOwner = {
    CHU_NHIEM: [],
    PHONG_KHCN: [],
    PHONG_TC_CU: []
  };
  let missingExtension2 = false;

  for (const crit of AUDIT_CRITERIA) {
    const manual = overrideMap.get(crit.key);
    const matchedDoc = findMatchingDocument(crit, documents);

    // 0. Xử lý tiêu chí Điều chỉnh Dự toán (chỉ bắt buộc khi có phát sinh điều chỉnh hoặc đã upload file)
    if (crit.key === 'QD_DIEU_CHINH_DU_TOAN' || crit.key === 'DON_DIEU_CHINH_DU_TOAN') {
      const hasAdjustment = (adjustments && adjustments.length > 0) || (project.budget_revised && project.budget_revised !== project.budget_total) || !!matchedDoc;
      if (!hasAdjustment) {
        items.push({
          ...crit,
          status: 'NOT_REQUIRED',
          status_label: 'Không áp dụng (Không điều chỉnh dự toán)',
          badge_class: 'badge-gray',
          file: null,
          notes: 'Đề tài giữ nguyên dự toán ban đầu, không phát sinh điều chỉnh'
        });
        continue;
      }

      totalRequired++;
      const approvedAdj = crit.key === 'QD_DIEU_CHINH_DU_TOAN' ? adjustments.find(a => a.status === 'APPROVED') : null;

      if (manual && manual.status === 'VERIFIED') {
        completedCount++;
        items.push({
          ...crit,
          status: 'VERIFIED',
          status_label: 'Đã xác thực bản cứng',
          badge_class: 'badge-green',
          file: matchedDoc || null,
          verified_by: manual.verified_by,
          verified_at: manual.verified_at,
          notes: manual.notes || 'P. KHCN đã xác thực Quyết định điều chỉnh dự toán'
        });
      } else if (matchedDoc || approvedAdj) {
        completedCount++;
        items.push({
          ...crit,
          status: 'UPLOADED',
          status_label: 'Đã có QĐ điều chỉnh dự toán',
          badge_class: 'badge-blue',
          file: matchedDoc || {
            id: null,
            title: approvedAdj ? `Quyết định điều chỉnh dự toán số ${approvedAdj.decision_number}` : 'Quyết định điều chỉnh dự toán',
            file_name: 'QD_Dieu_chinh_du_toan.pdf',
            file_size: 1024,
            is_virtual: true
          },
          notes: approvedAdj ? `QĐ số ${approvedAdj.decision_number} ngày ${approvedAdj.decision_date}` : (matchedDoc ? matchedDoc.title : 'Đã có QĐ phê duyệt điều chỉnh')
        });
      } else {
        missingAllList.push(crit.name);
        missingForLiquidation.push(crit.name);
        if (missingByOwner[crit.owner_role]) missingByOwner[crit.owner_role].push(crit.name);
        items.push({
          ...crit,
          status: 'MISSING',
          status_label: 'Còn thiếu QĐ điều chỉnh',
          badge_class: 'badge-red',
          file: null,
          notes: 'Đề tài có đề xuất điều chỉnh dự toán nhưng chưa có Quyết định phê duyệt của Viện trưởng'
        });
      }
      continue;
    }

    // 1. Xử lý các tiêu chí Gia hạn (Lần 1 và Lần 2) theo đúng trạng thái thực tế của quy trình
    const isExtCrit = ['DON_GIA_HAN_1', 'QD_GIA_HAN_1', 'DON_GIA_HAN_2', 'QD_GIA_HAN_2'].includes(crit.key);

    if (isExtCrit) {
      const extNum = crit.key.endsWith('_2') ? 2 : 1;
      const isQdKey = crit.key.startsWith('QD_GIA_HAN');
      const extRow = (extensions || []).find(e => Number(e.extension_num) === extNum);

      // Nếu đã được P. KHCN xác thực bản chính
      if (manual && manual.status === 'VERIFIED' && matchedDoc) {
        totalRequired++;
        completedCount++;
        items.push({
          ...crit,
          status: 'VERIFIED',
          status_label: 'Đã duyệt bản chính',
          badge_class: 'badge-green',
          file: matchedDoc,
          verified_by: manual.verified_by,
          verified_at: manual.verified_at,
          notes: manual.notes || 'P. KH&CN đã đối chiếu dấu mộc đỏ và khóa lưu trữ'
        });
        continue;
      }

      // Nếu đã tải lên tệp văn bản số hóa thực tế
      if (matchedDoc) {
        totalRequired++;
        completedCount++;
        items.push({
          ...crit,
          status: 'UPLOADED',
          status_label: 'Đã nộp bản số hóa',
          badge_class: 'badge-blue',
          file: matchedDoc,
          notes: matchedDoc.title || 'Đã tải tệp lên hệ thống'
        });
        continue;
      }

      // Nếu chưa có đợt đề xuất gia hạn nào cho lần này và cũng chưa tải tệp
      if (!extRow && extCount < extNum) {
        items.push({
          ...crit,
          status: 'NOT_REQUIRED',
          status_label: 'Không áp dụng (Không gia hạn)',
          badge_class: 'badge-gray',
          file: null,
          notes: `Đề tài chưa phát sinh gia hạn Lần ${extNum}`
        });
        continue;
      }

      // Nếu Viện trưởng KHÔNG PHÊ DUYỆT (REJECTED) đợt gia hạn này thì không ban hành Quyết định cho phép gia hạn
      if (extRow && extRow.status === 'REJECTED' && isQdKey) {
        items.push({
          ...crit,
          status: 'NOT_REQUIRED',
          status_label: 'Không ban hành (Viện trưởng từ chối gia hạn)',
          badge_class: 'badge-gray',
          file: null,
          notes: extRow.director_opinion || 'Viện trưởng không phê duyệt đề xuất gia hạn'
        });
        continue;
      }

      // Trường hợp đã phát sinh đề xuất gia hạn (PENDING, REVISION_NEEDED, APPROVED) nhưng CHƯA tải tệp thực tế lên
      totalRequired++;
      if (extNum === 2) missingExtension2 = true;
      missingAllList.push(crit.name);
      if (missingByOwner[crit.owner_role]) missingByOwner[crit.owner_role].push(crit.name);

      const pendingNote = !isQdKey
        ? `Chủ nhiệm đã tạo đề xuất gia hạn Lần ${extNum} nhưng chưa tải bản scan Đơn đề nghị gia hạn có chữ ký.`
        : (extRow && extRow.status === 'APPROVED'
            ? `Còn thiếu bản scan Quyết định gia hạn Lần ${extNum} có dấu mộc đỏ.`
            : `Đang chờ P. KH&CN trình Viện trưởng ký Quyết định gia hạn Lần ${extNum} và tải lên bản scan có dấu mộc đỏ.`);

      items.push({
        ...crit,
        status: 'MISSING',
        status_label: !isQdKey ? 'Chờ nộp Đơn đã ký' : 'Chờ QĐ phê duyệt (Mộc đỏ)',
        badge_class: 'badge-red',
        file: null,
        notes: pendingNote
      });
      continue;
    }

    // 2. Các tiêu chí bắt buộc chung (13 tiêu chí cốt lõi)
    totalRequired++;

    // A. Kiểm tra xác thực bản cứng từ P. KHCN (nếu không bị đánh dấu MISSING thủ công)
    if (manual && manual.status === 'VERIFIED') {
      completedCount++;
      items.push({
        ...crit,
        status: 'VERIFIED',
        status_label: 'Đã xác thực bản cứng',
        badge_class: 'badge-green',
        file: matchedDoc || null,
        verified_by: manual.verified_by,
        verified_at: manual.verified_at,
        notes: manual.notes || 'P. KHCN đã kiểm tra & xác thực hồ sơ giấy bản gốc'
      });
      continue;
    }

    // B. Nếu đã có file thực tế được upload trong nckh_documents -> Luôn ưu tiên ghi nhận!
    if (matchedDoc) {
      completedCount++;
      items.push({
        ...crit,
        status: 'UPLOADED',
        status_label: 'Đã nộp file số hóa',
        badge_class: 'badge-blue',
        file: matchedDoc,
        notes: `${matchedDoc.title || matchedDoc.file_name} (Người nộp: ${matchedDoc.uploaded_by || 'P. KHCN'})`
      });
      continue;
    }

    // C. Kiểm tra chứng từ ảo từ bảng Vật tư MISA hoặc Báo cáo định kỳ 6 tháng (nếu đề tài không bị ghi chú "Thiếu tất cả")
    const isSheetMissingAll = (project.missing_docs || '').toLowerCase().includes('thiếu tất cả');
    let virtualDoc = null;

    if (!isSheetMissingAll) {
      if (crit.key === 'CHUNG_TU_VAT_TU') {
        const hasSuppliesProof = supplies.some(s => s.proof_file_path || s.misa_order_id || s.fulfillment_status === 'Đã nhận đủ');
        if (hasSuppliesProof) {
          virtualDoc = {
            id: null,
            title: 'Hồ sơ cấp phát hóa chất/vật tư qua MISA',
            file_name: 'MISA_Vat_Tu.pdf',
            file_size: 1024,
            is_virtual: true
          };
        }
      } else if (crit.key === 'BAO_CAO_6_THANG') {
        const hasApprovedReport = reports.some(r => r.status === 'APPROVED' || r.submitted_date);
        if (hasApprovedReport) {
          virtualDoc = {
            id: null,
            title: 'Báo cáo định kỳ 6 tháng đã nộp trên hệ thống',
            file_name: 'Bao_cao_dinh_ky.pdf',
            file_size: 1024,
            is_virtual: true
          };
        }
      }
    }

    if (virtualDoc) {
      completedCount++;
      items.push({
        ...crit,
        status: 'UPLOADED',
        status_label: 'Đã ghi nhận trên hệ thống',
        badge_class: 'badge-blue',
        file: virtualDoc,
        notes: virtualDoc.title
      });
    } else {
      missingAllList.push(crit.name);
      if (crit.needed_for === 'ACCEPTANCE' || crit.needed_for === 'ALL') {
        missingForAcceptance.push(crit.name);
      }
      if (crit.needed_for === 'LIQUIDATION' || crit.needed_for === 'ALL') {
        missingForLiquidation.push(crit.name);
      }
      if (missingByOwner[crit.owner_role]) {
        missingByOwner[crit.owner_role].push(crit.name);
      }

      items.push({
        ...crit,
        status: 'MISSING',
        status_label: 'Còn thiếu',
        badge_class: 'badge-red',
        file: null,
        notes: (project.missing_docs && project.missing_docs !== 'Đã xong')
          ? `Chưa nộp file (Ghi chú gốc: ${project.missing_docs})`
          : `Chưa nộp file (${crit.owner_label})`
      });
    }
  }

  const percent = totalRequired > 0 ? Math.round((completedCount / totalRequired) * 100) : 0;

  // Xác định trạng thái hồ sơ kiểm toán tổng quát
  let auditStatus = 'INCOMPLETE';
  let auditLabel = 'Hồ sơ chưa hoàn thiện';
  let auditBadgeClass = 'badge-red';

  if (percent === 100) {
    auditStatus = 'FULL_AUDIT_READY';
    auditLabel = 'Đầy đủ 100% hồ sơ (Sẵn sàng Kiểm toán)';
    auditBadgeClass = 'badge-green';
  } else if (isCompleted) {
    if (missingForLiquidation.some(m => m.includes('thanh lý') || m.includes('quyết toán'))) {
      auditStatus = 'MISSING_LIQUIDATION';
      auditLabel = 'Đã nghiệm thu - Thiếu Biên bản thanh lý / Quyết toán';
      auditBadgeClass = 'badge-yellow';
    } else {
      auditStatus = 'COMPLETED_INCOMPLETE';
      auditLabel = 'Đã nghiệm thu - Cần bổ sung hồ sơ lưu trữ';
      auditBadgeClass = 'badge-yellow';
    }
  } else if (isExtended) {
    auditStatus = 'EXTENDED_NEEDS_DOCS';
    auditLabel = missingExtension2
      ? 'Đã gia hạn Lần 1 - Thiếu Đơn & QĐ gia hạn Lần 2 (hoặc Hồ sơ Nghiệm thu)'
      : `Đã gia hạn (Lần ${extCount}) - Chuẩn bị nghiệm thu/thanh lý`;
    auditBadgeClass = 'badge-purple';
  } else if (project.status_color === 'RED') {
    auditStatus = 'OVERDUE_INCOMPLETE';
    auditLabel = 'Quá hạn - Cần hoàn thiện gấp hồ sơ xử lý';
    auditBadgeClass = 'badge-red';
  } else {
    auditStatus = 'IN_PROGRESS';
    auditLabel = `Đang thực hiện (${percent}%)`;
    auditBadgeClass = 'badge-blue';
  }

  return {
    project_id: project.id,
    code: project.code,
    title: project.title,
    leader_name: project.leader_name,
    research_group: project.research_group,
    status: project.status,
    extension_count: project.extension_count || 0,
    is_extended: isExtended,
    missing_extension_2: missingExtension2,
    is_completed: isCompleted,
    is_cancelled: isCancelled,
    total_required: totalRequired,
    completed_count: completedCount,
    missing_count: totalRequired - completedCount,
    percentage: percent,
    audit_status: auditStatus,
    audit_label: auditLabel,
    audit_badge_class: auditBadgeClass,
    items,
    missing_list: missingAllList,
    missing_for_acceptance: missingForAcceptance,
    missing_for_liquidation: missingForLiquidation,
    missing_by_owner: missingByOwner,
    ready_for_acceptance: missingForAcceptance.length === 0,
    ready_for_liquidation: missingForLiquidation.length === 0,
    ready_for_audit: percent === 100
  };
}

module.exports = {
  AUDIT_CRITERIA,
  getCriteriaByKey,
  findMatchingDocument,
  evaluateProjectAudit
};
