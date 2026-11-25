/**
 * Cấu hình Hệ thống Phân quyền theo Vai trò (RBAC - Role-Based Access Control)
 * Quản lý Đề tài Cấp Viện - Viện Tế bào gốc (SCI)
 * Tích hợp chuẩn E-Office 2.0 (eoffice.sci.edu.vn)
 */

const ROLES = {
  VIEN_TRUONG: {
    key: 'VIEN_TRUONG',
    name: 'Viện trưởng',
    short_name: 'Viện trưởng',
    badge_class: 'badge-purple',
    icon: 'fa-user-tie',
    color: '#7e22ce',
    bg: '#f3e8ff',
    desc: 'Lãnh đạo cao nhất: Phê duyệt đề tài, ký Quyết định giao việc, QĐ gia hạn, QĐ nghiệm thu, Biên bản thanh lý'
  },
  SUPER_ADMIN: {
    key: 'SUPER_ADMIN',
    name: 'Admin toàn hệ thống',
    short_name: 'Admin hệ thống',
    badge_class: 'badge-red',
    icon: 'fa-screwdriver-wrench',
    color: '#b91c1c',
    bg: '#fee2e2',
    desc: 'Quản trị kỹ thuật, quản lý người dùng, cấu hình định mức, sao lưu dữ liệu và kiểm soát toàn bộ nhật ký hệ thống'
  },
  PHONG_KHCN: {
    key: 'PHONG_KHCN',
    name: 'Phòng Kế hoạch tổng hợp',
    short_name: 'Phòng KHTH',
    badge_class: 'badge-blue',
    icon: 'fa-briefcase',
    color: '#0284c7',
    bg: '#e0f2fe',
    desc: 'Đơn vị thường trực quản lý đề tài (gộp KHCN & TC-HC): Thẩm định hồ sơ, tổ chức Hội đồng, cấp số & đóng dấu văn bản pháp lý, giám sát tiến độ 6 tháng và hồ sơ kiểm toán'
  },
  CHU_NHIEM: {
    key: 'CHU_NHIEM',
    name: 'Chủ nhiệm đề tài (PI)',
    short_name: 'Chủ nhiệm đề tài',
    badge_class: 'badge-green',
    icon: 'fa-user-graduate',
    color: '#15803d',
    bg: '#dcfce7',
    desc: 'Nộp thuyết minh, dự toán, lập đề trù vật tư, nộp báo cáo 6 tháng, đơn gia hạn, báo cáo tổng kết (Chỉ thao tác trên đề tài của mình)'
  },
  THU_KHO: {
    key: 'THU_KHO',
    name: 'Thủ kho (Kho Vật tư & Hóa chất)',
    short_name: 'Thủ kho',
    badge_class: 'badge-orange',
    icon: 'fa-boxes-stacked',
    color: '#c2410c',
    bg: '#ffedd5',
    desc: 'Xuất kho hóa chất/vật tư tiêu hao theo phiếu duyệt, ký biên bản bàn giao, cập nhật tình trạng giao nhận thực tế'
  },
  PHONG_TC_CU: {
    key: 'PHONG_TC_CU',
    name: 'Phòng Tài chính - Cung ứng',
    short_name: 'Phòng TC-Cung ứng',
    badge_class: 'badge-indigo',
    icon: 'fa-sack-dollar',
    color: '#4338ca',
    bg: '#e0e7ff',
    desc: 'Thẩm định dự toán, đặt hàng mua sắm (Mã MISA), giải ngân kinh phí, kiểm soát hóa đơn chứng từ, thẩm tra quyết toán & thanh lý'
  }
};

// Danh mục chức năng nghiệp vụ & quyền hạn
const PERMISSION_GROUPS = [
  {
    group_id: 'DASHBOARD_REPORTS',
    group_name: 'I. Tổng quan & Báo cáo thống kê',
    permissions: [
      {
        key: 'VIEW_DASHBOARD_ALL',
        name: 'Xem Dashboard & KPI toàn viện',
        desc: 'Xem toàn bộ số liệu thống kê đề tài của tất cả các nhóm',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'THU_KHO']
      },
      {
        key: 'VIEW_DASHBOARD_OWN',
        name: 'Xem Dashboard phạm vi đề tài cá nhân',
        desc: 'Chỉ xem số liệu và tiến độ các đề tài do mình làm chủ nhiệm',
        roles: ['CHU_NHIEM']
      },
      {
        key: 'EXPORT_REPORTS',
        name: 'Xuất báo cáo tổng kết & Danh sách đề tài (Excel/CSV)',
        desc: 'Xuất danh sách và báo cáo tiến độ chung',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU']
      }
    ]
  },
  {
    group_id: 'PROJECT_LIFECYCLE',
    group_name: 'II. Khởi tạo & Phê duyệt Đề tài',
    permissions: [
      {
        key: 'CREATE_PROJECT',
        name: 'Đăng ký đề tài, nộp Thuyết minh & Dự toán',
        desc: 'Tạo hồ sơ đề tài mới và nộp bản đề cương sơ bộ',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN', 'CHU_NHIEM']
      },
      {
        key: 'MANAGE_COUNCIL_REVIEW',
        name: 'Tổ chức Hội đồng xét duyệt & Nhập biên bản',
        desc: 'Lập danh sách hội đồng, nhập biên bản họp và điểm đánh giá',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'VERIFY_HR_COMPLIANCE',
        name: 'Thẩm định nhân sự & Định mức giờ NCKH',
        desc: 'Kiểm tra hợp đồng lao động, tư cách chủ nhiệm và phân bổ giờ nghiên cứu',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'SIGN_ASSIGNMENT_DECISION',
        name: 'Ký Quyết định giao nhiệm vụ KHCN',
        desc: 'Thẩm quyền Viện trưởng ký quyết định phê duyệt chính thức',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN']
      },
      {
        key: 'ISSUE_STAMP_DOCS',
        name: 'Cấp số công văn & Đóng dấu văn bản pháp lý',
        desc: 'Vào sổ công văn, cấp số quyết định và đóng dấu pháp nhân của Viện',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'SIGN_CONTRACT',
        name: 'Ký Hợp đồng NCKH cơ sở',
        desc: 'Ký kết hợp đồng giữa Viện và Chủ nhiệm đề tài',
        roles: ['VIEN_TRUONG', 'CHU_NHIEM', 'SUPER_ADMIN']
      }
    ]
  },
  {
    group_id: 'FINANCE_SUPPLIES',
    group_name: 'III. Kinh phí, Vật tư & Cung ứng',
    permissions: [
      {
        key: 'APPROVE_BUDGET_ESTIMATE',
        name: 'Thẩm định & Phê duyệt Dự toán chi tiết',
        desc: 'Kiểm tra tính hợp lý của định mức hóa chất, vật tư và phê duyệt dự toán',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_TC_CU', 'PHONG_KHCN']
      },
      {
        key: 'SUBMIT_BUDGET_ADJUSTMENT',
        name: 'Lập Tờ trình đề nghị Điều chỉnh dự toán kinh phí',
        desc: 'Chủ nhiệm nộp tờ trình xin điều chuyển/thay đổi danh mục hóa chất trong quá trình thực hiện',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'REVIEW_BUDGET_ADJUSTMENT',
        name: 'Thẩm tra chuyên môn Điều chỉnh dự toán (P. KHCN)',
        desc: 'Phòng KHCN thẩm tra sự cần thiết kỹ thuật và tính hợp lệ trước khi trình Viện trưởng',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'APPROVE_BUDGET_ADJUSTMENT',
        name: 'Phê duyệt & Ký Quyết định Điều chỉnh dự toán (Viện trưởng)',
        desc: 'Viện trưởng phê duyệt ban hành Quyết định chính thức điều chỉnh dự toán kinh phí',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN']
      },
      {
        key: 'SUBMIT_SUPPLIES_REQUISITION',
        name: 'Lập đề trù vật tư, hóa chất tiêu hao',
        desc: 'Chủ nhiệm lập danh sách hóa chất, sinh phẩm cần cấp cho đề tài',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'MANAGE_MISA_PURCHASE',
        name: 'Đặt hàng mua sắm & Cấp mã MISA',
        desc: 'Tạo mã đơn mua hàng MISA, theo dõi hóa đơn và thanh toán nhà cung cấp',
        roles: ['SUPER_ADMIN', 'PHONG_TC_CU']
      },
      {
        key: 'DISPATCH_WAREHOUSE_SUPPLIES',
        name: 'Xuất kho & Ký phiếu xuất kho vật tư',
        desc: 'Thực hiện xuất vật tư, sinh phẩm và ký biên bản giao nhận',
        roles: ['SUPER_ADMIN', 'THU_KHO']
      },
      {
        key: 'DISBURSE_FUNDS',
        name: 'Tạm ứng & Giải ngân các đợt kinh phí',
        desc: 'Thực hiện chi tiền mặt hoặc chuyển khoản tạm ứng cho đề tài',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_TC_CU']
      }
    ]
  },
  {
    group_id: 'PROGRESS_EXTENSION',
    group_name: 'IV. Giám sát Định kỳ & Gia hạn Thời gian',
    permissions: [
      {
        key: 'SUBMIT_PERIODIC_REPORT',
        name: 'Nộp Báo cáo tiến độ định kỳ 6 tháng/lần',
        desc: 'Chủ nhiệm tải lên báo cáo kết quả thực hiện theo chu kỳ',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'REVIEW_PERIODIC_REPORT',
        name: 'Đánh giá & Duyệt Báo cáo định kỳ 6 tháng',
        desc: 'P. KHCN kiểm tra khối lượng công việc và xác nhận tiến độ',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'SUBMIT_EXTENSION_REQUEST',
        name: 'Nộp Đơn xin gia hạn (Lần 1, Lần 2)',
        desc: 'Chủ nhiệm làm đơn xin gia hạn tối đa 6 tháng/lần kèm cam kết',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'VERIFY_EXTENSION_RULES',
        name: 'Thẩm tra điều kiện gia hạn (Khóa ở Lần 3)',
        desc: 'P. KHCN thẩm định lý do, số lần gia hạn (tối đa 2 lần)',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'SIGN_EXTENSION_DECISION',
        name: 'Ký Quyết định cho phép gia hạn',
        desc: 'Viện trưởng phê duyệt và ký quyết định chính thức gia hạn',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN']
      }
    ]
  },
  {
    group_id: 'ACCEPTANCE_LIQUIDATION',
    group_name: 'V. Nghiệm thu & Thanh lý Hợp đồng',
    permissions: [
      {
        key: 'SUBMIT_ACCEPTANCE_DOSSIER',
        name: 'Nộp hồ sơ nghiệm thu (Báo cáo tổng kết, SP, bài báo)',
        desc: 'Chủ nhiệm nộp toàn bộ báo cáo khoa học và minh chứng sản phẩm',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'ORGANIZE_ACCEPTANCE_COUNCIL',
        name: 'Tổ chức Hội đồng nghiệm thu & Nhập biên bản họp',
        desc: 'P. KHCN tổ chức họp nghiệm thu, lập biên bản đánh giá đạt/không đạt',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'SUBMIT_REVISION_EXPLANATION',
        name: 'Nộp Bản giải trình tiếp thu sau họp nghiệm thu',
        desc: 'Chủ nhiệm chỉnh sửa báo cáo theo ý kiến Hội đồng và nộp bản giải trình',
        roles: ['CHU_NHIEM', 'SUPER_ADMIN']
      },
      {
        key: 'SIGN_ACCEPTANCE_DECISION',
        name: 'Ký Quyết định công nhận kết quả nghiệm thu',
        desc: 'Viện trưởng ban hành Quyết định chính thức công nhận đề tài hoàn thành',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN']
      },
      {
        key: 'FINALIZE_PROJECT_SETTLEMENT',
        name: 'Quyết toán kinh phí tài chính đề tài',
        desc: 'Phòng TC-Cung ứng thẩm định quyết toán toàn bộ các khoản chi',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_TC_CU']
      },
      {
        key: 'SIGN_CONTRACT_LIQUIDATION',
        name: 'Ký Biên bản thanh lý Hợp đồng NCKH',
        desc: 'Viện trưởng, P. KHCN, P. TC-Cung ứng và Chủ nhiệm đồng ký thanh lý',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'CHU_NHIEM']
      }
    ]
  },
  {
    group_id: 'AUDIT_INSPECTION',
    group_name: 'VI. Giám sát Hồ sơ & Phục vụ Thanh tra - Kiểm toán',
    permissions: [
      {
        key: 'VIEW_AUDIT_CHECKLIST_ALL',
        name: 'Xem ma trận hồ sơ pháp lý 13+ tài liệu toàn viện',
        desc: 'Tra cứu danh mục văn bản còn thiếu của tất cả 30 đề tài',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU']
      },
      {
        key: 'VIEW_AUDIT_CHECKLIST_OWN',
        name: 'Xem danh mục hồ sơ còn thiếu của đề tài mình',
        desc: 'Chủ nhiệm tra cứu giấy tờ cần bổ sung để được nghiệm thu / thanh lý',
        roles: ['CHU_NHIEM']
      },
      {
        key: 'VERIFY_HARDCOPY_AUDIT',
        name: 'Xác thực hồ sơ giấy bản cứng (Verify Audit)',
        desc: 'Phòng KHTH xác nhận đã nhận đủ bản cứng gốc đóng dấu lưu trữ',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN']
      },
      {
        key: 'UPLOAD_AUDIT_DOCUMENTS',
        name: 'Tải lên tài liệu số hóa (PDF)',
        desc: 'Upload các quyết định, hợp đồng, biên bản vào kho số hóa đề tài',
        roles: ['SUPER_ADMIN', 'PHONG_KHCN', 'CHU_NHIEM', 'THU_KHO', 'PHONG_TC_CU']
      },
      {
        key: 'EXPORT_AUDIT_HTML',
        name: 'Xuất Báo cáo Kiểm toán độc lập (HTML / Excel / In A4)',
        desc: 'Tải file báo cáo hoàn chỉnh phục vụ đoàn thanh tra, kiểm toán',
        roles: ['VIEN_TRUONG', 'SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU']
      }
    ]
  },
  {
    group_id: 'SYSTEM_ADMINISTRATION',
    group_name: 'VII. Quản trị Hệ thống & Phân quyền',
    permissions: [
      {
        key: 'MANAGE_USERS_ROLES',
        name: 'Quản lý người dùng & Gán vai trò (RBAC)',
        desc: 'Cấp quyền, tạo tài khoản và phân bổ vai trò cho cán bộ trong Viện',
        roles: ['SUPER_ADMIN']
      },
      {
        key: 'CONFIG_FINANCIAL_YEAR',
        name: 'Cấu hình định mức, mẫu biểu, chu kỳ báo cáo',
        desc: 'Thiết lập tham số ngân sách, mẫu đơn, chu kỳ cảnh báo',
        roles: ['SUPER_ADMIN', 'VIEN_TRUONG']
      },
      {
        key: 'VIEW_SYSTEM_AUDIT_LOG',
        name: 'Xem nhật ký hệ thống (Audit Trail Log)',
        desc: 'Theo dõi lịch sử truy cập, chỉnh sửa dữ liệu và thay đổi trạng thái',
        roles: ['SUPER_ADMIN', 'VIEN_TRUONG', 'PHONG_KHCN']
      }
    ]
  }
];

// Danh sách tài khoản demo mô phỏng từng vai trò
const DEMO_PROFILES = [
  {
    role: 'VIEN_TRUONG',
    fullname: 'PGS. TS. Phạm Văn Phúc',
    title: 'Viện trưởng Viện Tế bào gốc',
    email: 'phucpham@sci.edu.vn',
    unit: 'Ban Lãnh đạo Viện'
  },
  {
    role: 'SUPER_ADMIN',
    fullname: 'Quản trị viên Hệ thống (Admin)',
    title: 'Kỹ sư Quản trị Hệ thống E-Office',
    email: 'admin.it@sci.edu.vn',
    unit: 'Trung tâm CNTT & Dữ liệu'
  },
  {
    role: 'PHONG_KHCN',
    fullname: 'Trương Châu Nhật',
    title: 'Trưởng phòng Kế hoạch tổng hợp',
    email: 'nhattruong@sci.edu.vn',
    unit: 'Phòng Kế hoạch tổng hợp'
  },
  {
    role: 'CHU_NHIEM',
    fullname: 'Nguyễn Trường Sinh',
    title: 'Chủ nhiệm Đề tài (Cancer Biology)',
    email: 'sinhnguyen@sci.edu.vn',
    unit: 'Nhóm nghiên cứu Cancer Biology',
    sample_project_code: 'NCKH-SCI.07/24'
  },
  {
    role: 'THU_KHO',
    fullname: 'Cử nhân Trần Đình Trọng',
    title: 'Thủ kho Hóa chất & Vật tư',
    email: 'thukho@sci.edu.vn',
    unit: 'Kho Hóa chất - Vật tư Tiêu hao'
  },
  {
    role: 'PHONG_TC_CU',
    fullname: 'Kế toán trưởng Võ Thị Lan',
    title: 'Phụ trách Phòng TC - Cung ứng',
    email: 'p.khtc@sci.edu.vn',
    unit: 'Phòng Kế hoạch Tài chính & Cung ứng'
  }
];

function hasPermission(roleKey, permKey) {
  if (roleKey === 'SUPER_ADMIN') return true;
  for (const group of PERMISSION_GROUPS) {
    const perm = group.permissions.find(p => p.key === permKey);
    if (perm) {
      return perm.roles.includes(roleKey);
    }
  }
  return false;
}

function getPermissionsByRole(roleKey) {
  const result = [];
  for (const group of PERMISSION_GROUPS) {
    for (const perm of group.permissions) {
      if (roleKey === 'SUPER_ADMIN' || perm.roles.includes(roleKey)) {
        result.push(perm.key);
      }
    }
  }
  return result;
}

module.exports = {
  ROLES,
  PERMISSION_GROUPS,
  DEMO_PROFILES,
  hasPermission,
  getPermissionsByRole
};
