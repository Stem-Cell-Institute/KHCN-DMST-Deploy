const fs = require('fs');
const path = require('path');
const multer = require('multer');

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
]);

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sanitizeName(name) {
  return String(name || 'file').replace(/[^\w.\-()\s]/g, '_');
}

function createDocumentUpload(uploadsRoot) {
  const documentsRoot = path.join(uploadsRoot, 'documents');
  fs.mkdirSync(documentsRoot, { recursive: true });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const documentId = parseId(req.params.id);
      if (!documentId) return cb(new Error('document_id_invalid'));
      const stepRaw = req.body && req.body.step != null ? req.body.step : null;
      const step = Math.min(9, Math.max(1, parseInt(stepRaw, 10) || 1));
      const dir = path.join(documentsRoot, String(documentId), `step_${step}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}_${sanitizeName(file.originalname)}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 30 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
      if (!ALLOWED_MIME_TYPES.has(String(file.mimetype || '').toLowerCase())) {
        return cb(
          new Error(
            'Định dạng file không hợp lệ. Chỉ chấp nhận PDF, DOC, DOCX, XLSX, JPG, PNG.'
          )
        );
      }
      cb(null, true);
    },
  });
}

module.exports = {
  createDocumentUpload,
};
