const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

function fmtDateVi(s) {
  if (!s) return '—';
  const d = String(s).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

function splitYmd(iso) {
  const s = String(iso || '').slice(0, 10);
  const p = s.split('-');
  if (p.length !== 3) return { day: '…', month: '…', year: '…' };
  return { day: p[2], month: p[1], year: p[0] };
}

function fundingItemsTableText(items) {
  let arr = [];
  try {
    arr = typeof items === 'string' ? JSON.parse(items || '[]') : items || [];
  } catch (_) {
    arr = [];
  }
  if (!arr.length) return '—';
  return arr
    .map((r, i) => {
      const item = r.item || r.khoan || '—';
      const amount = r.amount != null ? Number(r.amount).toLocaleString('vi-VN') : '0';
      const note = r.note || r.ghi_chu || '';
      return `${i + 1}. ${item}: ${amount} VNĐ${note ? ` (${note})` : ''}`;
    })
    .join('\n');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} registrationId
 * @returns {Promise<Buffer>}
 */
async function exportApprovalWord(db, registrationId) {
  const row = db
    .prepare(
      `SELECT r.*,
        u.fullname AS submitter_name, u.email AS submitter_email,
        k.fullname AS khcn_reviewer_name,
        d.fullname AS director_reviewer_name
       FROM conference_registrations r
       JOIN users u ON u.id = r.submitted_by_user_id
       LEFT JOIN users k ON k.id = r.khcn_reviewer_id
       LEFT JOIN users d ON d.id = r.director_reviewer_id
       WHERE r.id = ?`
    )
    .get(registrationId);
  if (!row) {
    const e = new Error('NOT_FOUND');
    e.code = 'NOT_FOUND';
    throw e;
  }

  const dirDate = splitYmd(row.director_reviewed_at || row.updated_at);
  const khcnDate = fmtDateVi(row.khcn_reviewed_at);
  const dirDateFull = fmtDateVi(row.director_reviewed_at);

  const fundingTotal = Number(row.funding_requested_vnd || 0);

  const templatePath = path.join(__dirname, '..', 'templates', 'conference_registration_approval.docx');
  if (!fs.existsSync(templatePath)) {
    const e = new Error('TEMPLATE_MISSING');
    e.code = 'TEMPLATE_MISSING';
    throw e;
  }

  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  const data = {
    submission_code: row.submission_code || '',
    unit: row.unit || '—',
    research_group: row.research_group || '—',
    job_title: row.job_title || '—',
    submitter_name: row.submitter_name || row.submitter_email || '—',
    conf_name: row.conf_name || '—',
    conf_type: row.conf_type || '—',
    conf_organizer: row.conf_organizer || '—',
    conf_start_date: fmtDateVi(row.conf_start_date),
    conf_end_date: fmtDateVi(row.conf_end_date),
    conf_location: row.conf_location || '—',
    conf_country: row.conf_country || '—',
    conf_website: row.conf_website || '—',
    has_paper: Number(row.has_paper) === 1 ? 'Có' : 'Không',
    paper_title: row.paper_title || '—',
    paper_authors: row.paper_authors || '—',
    paper_type: row.paper_type || '—',
    purpose: row.purpose || '—',
    funding_type: row.funding_type || '—',
    funding_total_vnd: fundingTotal.toLocaleString('vi-VN'),
    funding_items_table: fundingItemsTableText(row.funding_items),
    khcn_comment: row.khcn_comment || '—',
    khcn_reviewer_name: row.khcn_reviewer_name || '—',
    khcn_reviewed_date: khcnDate,
    director_comment: row.director_comment || '—',
    director_reviewer_name: row.director_reviewer_name || '—',
    director_reviewed_date: dirDateFull,
    approved_day: dirDate.day,
    approved_month: dirDate.month,
    approved_year: dirDate.year,
  };

  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { exportApprovalWord, fmtDateVi, fundingItemsTableText };
