const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');

module.exports = {
  PORT: process.env.CAP_VIEN_PORT || process.env.PORT || 3005,
  DB_URL: process.env.CAP_VIEN_MODULE_DB_URL || `file:${path.join(ROOT_DIR, 'data', 'de-tai-cap-vien.db')}`,
  UPLOAD_DIR: process.env.CAP_VIEN_MODULE_UPLOAD_DIR || path.join(ROOT_DIR, 'uploads'),
  MOUNT_PATH: process.env.MOUNT_PATH || '/de-tai-cap-vien',
  WARNING_THRESHOLD_DAYS: 45, // days before expiration to show yellow warning
  REPORT_CYCLE_MONTHS: 6, // periodic report cycle
  MAX_EXTENSIONS: 2, // maximum allowed extensions
  EXTENSION_MONTHS: 6, // 6 months per extension
  SCHEDULER_ENABLED: process.env.SCHEDULER_ENABLED !== 'false',
  SCHEDULER_INTERVAL_HOURS: Number(process.env.SCHEDULER_INTERVAL_HOURS) || 24,
  SCHEDULER_RUN_AT_HOUR: process.env.SCHEDULER_RUN_AT_HOUR !== undefined ? Number(process.env.SCHEDULER_RUN_AT_HOUR) : 8,
  SCHEDULER_INITIAL_DELAY_MS: Number(process.env.SCHEDULER_INITIAL_DELAY_MS) || 15000
};
