/**
 * lib/upload.js
 * Bọc multer để sửa tên file tiếng Việt tại MỘT điểm duy nhất.
 *
 * busboy (multer 1.x) giải mã tên file trong multipart/form-data theo latin1, nên
 * "Đơn đề nghị.docx" tới tay handler dưới dạng mojibake. Thay vì sửa rải rác ở
 * hàng chục chỗ dùng req.file.originalname (dễ sót), ta sửa ngay trong fileFilter:
 * multer gọi fileFilter TRƯỚC storage.handleFile, nên cả tên lưu xuống đĩa lẫn
 * mọi handler phía sau đều nhận được tên đã đúng.
 *
 * Dùng y hệt multer: require('./lib/upload') thay cho require('multer').
 */

const multer = require('multer');
const { decodeUploadedFilename } = require('./filenames');

function uploadWithVietnameseFilenames(options) {
  const opts = Object.assign({}, options || {});
  const userFileFilter = typeof opts.fileFilter === 'function' ? opts.fileFilter : null;

  opts.fileFilter = function (req, file, cb) {
    try {
      file.originalname = decodeUploadedFilename(file.originalname);
    } catch (_) {
      /* giữ nguyên tên gốc nếu có sự cố — không chặn upload vì lỗi đặt tên */
    }
    if (userFileFilter) return userFileFilter(req, file, cb);
    return cb(null, true);
  };

  return multer(opts);
}

// Giữ nguyên API tĩnh: diskStorage, memoryStorage, MulterError
Object.assign(uploadWithVietnameseFilenames, multer);

module.exports = uploadWithVietnameseFilenames;
