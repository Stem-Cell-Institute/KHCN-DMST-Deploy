/**
 * Cấu hình thư mục tạm và middleware Multer cho upload hồ sơ, SJR CSV, Cấp Viện và HTQT.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const multer = require('./upload');

module.exports = function createMulterUploads({
  MULTIPART_MAX_FIELD_BYTES,
  UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE,
  UPLOAD_FILE_BYTES_CAP_VIEN,
  UPLOAD_FILE_BYTES_SJR_CSV,
  UPLOAD_FILE_BYTES_SUBMISSION,
  capVienPublicTemplatesFsDir,
  uploadDir,
  uploadDirCapVien,
}) {
  const tempUploadDir = path.join(uploadDir, 'temp');
  fs.mkdirSync(tempUploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      if (!req._uploadDir) {
        req._uploadDir = path.join(tempUploadDir, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        fs.mkdirSync(req._uploadDir, { recursive: true });
      }
      cb(null, req._uploadDir);
    },
    filename: function (req, file, cb) {
      const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, Date.now() + '_' + safe);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  });

  /** Upload CSV SCImago (memory) — POST /api/admin/sjr-csv-import */
  const uploadSjrCsv = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: UPLOAD_FILE_BYTES_SJR_CSV, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  });

  // Multer cho Đề tài cấp Viện (thư mục riêng)
  const tempUploadDirCapVien = path.join(uploadDirCapVien, 'temp');
  fs.mkdirSync(tempUploadDirCapVien, { recursive: true });
  const storageCapVien = multer.diskStorage({
    destination: function (req, file, cb) {
      if (!req._uploadDirCapVien) {
        req._uploadDirCapVien = path.join(tempUploadDirCapVien, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        fs.mkdirSync(req._uploadDirCapVien, { recursive: true });
      }
      cb(null, req._uploadDirCapVien);
    },
    filename: function (req, file, cb) {
      const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, Date.now() + '_' + safe);
    }
  });
  const uploadCapVien = multer({
    storage: storageCapVien,
    limits: { fileSize: UPLOAD_FILE_BYTES_CAP_VIEN, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  });

  /** Mẫu hồ sơ công khai (trang tải mẫu đề tài cấp Viện) — mọi định dạng, tối đa 80MB */
  const storageCapVienPublicTemplate = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, capVienPublicTemplatesFsDir);
    },
    filename: function (req, file, cb) {
      const tc = ((req.params && req.params.taskCode) || '').trim();
      const ext = path.extname(file.originalname || '') || '';
      const safe = tc.replace(/[^A-Za-z0-9\-_]/g, '_') || 'task';
      cb(null, safe + '_' + Date.now() + ext);
    },
  });
  const uploadCapVienPublicTemplate = multer({
    storage: storageCapVienPublicTemplate,
    limits: { fileSize: UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  });

  const htqtDoanRaDir = path.join(uploadDir, 'htqt-doan-ra');
  const DOAN_RA_TO_TRINH_TEMPLATE_PATH = path.join(htqtDoanRaDir, 'to-trinh-template.docx');
  const storageHtqtDoanRa = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtDoanRaDir);
    },
    filename: function (req, file, cb) {
      const id = parseInt(req.params.id, 10) || 0;
      const ext = path.extname(file.originalname || '') || '.docx';
      cb(null, 'doan_ra_' + id + '_' + Date.now() + ext);
    }
  });
  const uploadHtqtDoanRa = multer({
    storage: storageHtqtDoanRa,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(doc|docx)$/.test(n)) {
        return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
      }
      cb(null, true);
    }
  });

  const storageToTrinhTemplate = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtDoanRaDir);
    },
    filename: function (req, file, cb) {
      cb(null, 'to-trinh-template.docx');
    }
  });
  const uploadToTrinhTemplate = multer({
    storage: storageToTrinhTemplate,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.docx$/i.test(n)) {
        return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
      }
      cb(null, true);
    }
  });

  const htqtDoanVaoDir = path.join(uploadDir, 'htqt-doan-vao');
  const DOAN_VAO_TO_TRINH_TEMPLATE_PATH = path.join(htqtDoanVaoDir, 'to-trinh-template.docx');
  const storageHtqtDoanVao = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtDoanVaoDir);
    },
    filename: function (req, file, cb) {
      const id = parseInt(req.params.id, 10) || 0;
      const ext = path.extname(file.originalname || '') || '.docx';
      cb(null, 'doan_vao_' + id + '_' + Date.now() + ext);
    }
  });
  const uploadHtqtDoanVao = multer({
    storage: storageHtqtDoanVao,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(doc|docx)$/.test(n)) {
        return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
      }
      cb(null, true);
    }
  });
  const storageToTrinhTemplateDoanVao = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtDoanVaoDir);
    },
    filename: function (req, file, cb) {
      cb(null, 'to-trinh-template.docx');
    }
  });
  const uploadToTrinhTemplateDoanVao = multer({
    storage: storageToTrinhTemplateDoanVao,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.docx$/i.test(n)) {
        return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
      }
      cb(null, true);
    }
  });

  const htqtMouDir = path.join(uploadDir, 'htqt-mou');
  const MOU_TO_TRINH_TEMPLATE_PATH = path.join(htqtMouDir, 'to-trinh-template.docx');
  const storageHtqtMou = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtMouDir);
    },
    filename: function (req, file, cb) {
      const id = parseInt(req.params.id, 10) || 0;
      const ext = path.extname(file.originalname || '') || '.docx';
      cb(null, 'mou_' + id + '_' + Date.now() + ext);
    }
  });
  const uploadHtqtMou = multer({
    storage: storageHtqtMou,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(doc|docx)$/.test(n)) {
        return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
      }
      cb(null, true);
    }
  });
  const storageToTrinhTemplateMou = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtMouDir);
    },
    filename: function (req, file, cb) {
      cb(null, 'to-trinh-template.docx');
    }
  });
  const uploadToTrinhTemplateMou = multer({
    storage: storageToTrinhTemplateMou,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.docx$/i.test(n)) {
        return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
      }
      cb(null, true);
    }
  });

  const htqtYtnnDir = path.join(uploadDir, 'htqt-ytnn');
  const YTNN_TO_TRINH_TEMPLATE_PATH = path.join(htqtYtnnDir, 'to-trinh-template.docx');
  const storageHtqtYtnn = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtYtnnDir);
    },
    filename: function (req, file, cb) {
      const id = parseInt(req.params.id, 10) || 0;
      const ext = path.extname(file.originalname || '') || '.docx';
      cb(null, 'ytnn_' + id + '_' + Date.now() + ext);
    }
  });
  const uploadHtqtYtnn = multer({
    storage: storageHtqtYtnn,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(doc|docx)$/.test(n)) {
        return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
      }
      cb(null, true);
    }
  });
  const htqtThoaThuanDir = path.join(uploadDir, 'htqt-thoa-thuan');
  const uploadHtqtThoaThuanScan = multer({
    storage: multer.diskStorage({
      destination: function (_req, _file, cb) { cb(null, htqtThoaThuanDir); },
      filename: function (_req, file, cb) {
        const ext = path.extname(file.originalname || '') || '.pdf';
        const safe = path.basename(file.originalname || 'scan', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
        cb(null, 'thoa_thuan_' + Date.now() + '_' + safe + ext.toLowerCase());
      },
    }),
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (_req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Scan chỉ nhận PDF, DOC, DOCX, JPG, PNG'));
      cb(null, true);
    },
  });
  const uploadHtqtThoaThuanTermination = multer({
    storage: multer.diskStorage({
      destination: function (_req, _file, cb) { cb(null, htqtThoaThuanDir); },
      filename: function (_req, file, cb) {
        const ext = path.extname(file.originalname || '') || '.pdf';
        const safe = path.basename(file.originalname || 'termination', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
        cb(null, 'thoa_thuan_termination_' + Date.now() + '_' + safe + ext.toLowerCase());
      },
    }),
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (_req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Termination file: PDF, DOC, DOCX, JPG, PNG only'));
      cb(null, true);
    },
  });
  const storageToTrinhTemplateYtnn = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, htqtYtnnDir);
    },
    filename: function (req, file, cb) {
      cb(null, 'to-trinh-template.docx');
    }
  });
  const uploadToTrinhTemplateYtnn = multer({
    storage: storageToTrinhTemplateYtnn,
    limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
    fileFilter: function (req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.docx$/i.test(n)) {
        return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
      }
      cb(null, true);
    }
  });

  return {
    DOAN_RA_TO_TRINH_TEMPLATE_PATH,
    DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
    MOU_TO_TRINH_TEMPLATE_PATH,
    YTNN_TO_TRINH_TEMPLATE_PATH,
    upload,
    uploadCapVien,
    uploadCapVienPublicTemplate,
    uploadHtqtDoanRa,
    uploadHtqtDoanVao,
    uploadHtqtMou,
    uploadHtqtThoaThuanScan,
    uploadHtqtThoaThuanTermination,
    uploadHtqtYtnn,
    uploadSjrCsv,
    uploadToTrinhTemplate,
    uploadToTrinhTemplateDoanVao,
    uploadToTrinhTemplateMou,
    uploadToTrinhTemplateYtnn,
  };
};
