const config = require('../config/config');

// Helper to parse date string (DD/MM/YYYY, D/M/YYYY, MM/YYYY, or YYYY-MM-DD) to Date object
function parseDate(dateStr) {
  if (!dateStr) return null;
  let s = String(dateStr).trim().replace(/^(Tháng|tháng)\s+/i, '');
  if (!s) return null;

  // Check if DD/MM/YYYY or D/M/YYYY or YYYY-MM-DD
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      // YYYY-MM-DD
      const y = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const d = parseInt(parts[2], 10);
      return new Date(y, m, d);
    } else {
      // DD/MM/YYYY
      const d = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10) - 1;
      const y = parseInt(parts[2], 10);
      return new Date(y, m, d);
    }
  } else if (parts.length === 2) {
    // Format MM/YYYY (e.g. 11/2026, 05/2026) -> set to the last day of that month
    const m = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    if (!isNaN(m) && !isNaN(y) && m >= 1 && m <= 12) {
      const lastDay = new Date(y, m, 0).getDate();
      return new Date(y, m - 1, lastDay);
    }
  }

  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

// Format Date object to YYYY-MM-DD
function formatDateISO(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Format Date object to DD/MM/YYYY
function formatDateVN(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${d}/${m}/${y}`;
}

// Add months to date
function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

// Calculate base end date and current end date
function calculateEndDates(decisionDateStr, durationMonths = 12, extensionCount = 0) {
  const startDate = parseDate(decisionDateStr);
  if (!startDate) return { base_end_date: null, current_end_date: null };

  const baseEndDate = addMonths(startDate, durationMonths);
  const currentEndDate = addMonths(baseEndDate, extensionCount * config.EXTENSION_MONTHS);

  return {
    base_end_date: formatDateISO(baseEndDate),
    current_end_date: formatDateISO(currentEndDate)
  };
}

// Evaluate alert badge and status color
function evaluateStatus(project, customNow = new Date()) {
  const now = customNow instanceof Date ? customNow : new Date();
  const finalEval = (project.final_evaluation || '').toLowerCase();
  const status = (project.status || '').toUpperCase();

  if (finalEval.includes('nghiệm thu') || status === 'COMPLETED') {
    return {
      status_code: 'COMPLETED',
      status_color: 'BLUE',
      color_hex: '#2563eb',
      badge_text: 'Đã nghiệm thu',
      days_remaining: 0,
      is_overdue: false,
      can_extend: false
    };
  }

  if (finalEval.includes('hủy') || status === 'CANCELLED') {
    return {
      status_code: 'CANCELLED',
      status_color: 'GRAY',
      color_hex: '#6b7280',
      badge_text: 'Hủy đề tài',
      days_remaining: 0,
      is_overdue: false,
      can_extend: false
    };
  }

  const endDate = parseDate(project.current_end_date || project.base_end_date);
  if (!endDate) {
    return {
      status_code: 'IN_PROGRESS',
      status_color: 'GREEN',
      color_hex: '#16a34a',
      badge_text: 'Đang thực hiện',
      days_remaining: 999,
      is_overdue: false,
      can_extend: (project.extension_count || 0) < config.MAX_EXTENSIONS
    };
  }

  // Calculate day difference
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysDiff = Math.ceil((endDate.getTime() - now.getTime()) / msPerDay);
  const extCount = project.extension_count || 0;
  const canExtend = extCount < config.MAX_EXTENSIONS;

  if (daysDiff < 0) {
    // Overdue -> RED ALERT
    return {
      status_code: 'OVERDUE',
      status_color: 'RED',
      color_hex: '#dc2626',
      badge_text: `Quá hạn ${Math.abs(daysDiff)} ngày`,
      days_remaining: daysDiff,
      overdue_days: Math.abs(daysDiff),
      is_overdue: true,
      can_extend: canExtend,
      warning_msg: canExtend 
        ? `Đề tài đã hết hạn! Cần làm thủ tục Nghiệm thu hoặc Gia hạn lần ${extCount + 1} (6 tháng).`
        : `Đề tài đã hết hạn và đã dùng hết ${config.MAX_EXTENSIONS} lần gia hạn! Bắt buộc phải nghiệm thu hoặc chấm dứt.`
    };
  } else if (daysDiff <= config.WARNING_THRESHOLD_DAYS) {
    // Near deadline -> YELLOW WARNING
    return {
      status_code: 'EXPIRING_SOON',
      status_color: 'YELLOW',
      color_hex: '#ca8a04',
      badge_text: `Sắp hết hạn (Còn ${daysDiff} ngày)`,
      days_remaining: daysDiff,
      is_overdue: false,
      can_extend: canExtend,
      warning_msg: canExtend
        ? `Sắp đến hạn! Vui lòng nộp báo cáo hoặc nộp đơn xin gia hạn lần ${extCount + 1} (thêm 6 tháng).`
        : `Sắp đến hạn kết thúc (Đã gia hạn tối đa 2 lần). Vui lòng chuẩn bị hồ sơ nghiệm thu.`
    };
  } else {
    // On track -> GREEN
    return {
      status_code: 'IN_PROGRESS',
      status_color: 'GREEN',
      color_hex: '#16a34a',
      badge_text: `Đúng hạn (Còn ${daysDiff} ngày)`,
      days_remaining: daysDiff,
      is_overdue: false,
      can_extend: canExtend
    };
  }
}

// Generate 6-month report milestones
function generateReportMilestones(decisionDateStr, totalMonths) {
  const start = parseDate(decisionDateStr);
  if (!start) return [];

  const milestones = [];
  const cycles = Math.floor(totalMonths / config.REPORT_CYCLE_MONTHS);

  for (let i = 1; i <= cycles; i++) {
    const months = i * config.REPORT_CYCLE_MONTHS;
    const dueDate = addMonths(start, months);
    milestones.push({
      period_num: i,
      label: `Báo cáo định kỳ ${months} tháng (Kỳ ${i})`,
      due_date: formatDateISO(dueDate),
      due_date_vn: formatDateVN(dueDate)
    });
  }
  return milestones;
}

module.exports = {
  parseDate,
  formatDateISO,
  formatDateVN,
  addMonths,
  calculateEndDates,
  evaluateStatus,
  generateReportMilestones
};
