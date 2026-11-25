const express = require('express');
const path = require('path');
const cors = require('cors');
const authMiddleware = require('./middleware/auth');
const config = require('./config/config');

const subapp = express();

// Middleware cơ bản
subapp.use(cors());
subapp.use(express.json());
subapp.use(express.urlencoded({ extended: true }));

// Parse cookies đơn giản không cần package ngoài
subapp.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const parts = c.split('=');
      if (parts.length >= 2) {
        req.cookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('=').trim());
      }
    });
  }
  next();
});

subapp.use(authMiddleware);

// Phục vụ Static Files cho Giao diện Web
subapp.use(express.static(path.join(__dirname, 'public')));
subapp.use('/uploads', express.static(config.UPLOAD_DIR));

// Đăng ký các Router Nghiệp vụ Chuyên biệt cho Đề tài Cấp Viện
subapp.use('/api/calls', require('./routes/calls'));
subapp.use('/api/projects/:id/budget-adjustments', require('./routes/budgetAdjustments'));
subapp.use('/api/projects', require('./routes/projects'));
subapp.use('/api/documents', require('./routes/documents'));
subapp.use('/api/reports', require('./routes/reports'));
subapp.use('/api/extensions', require('./routes/extensions'));
subapp.use('/api/supplies', require('./routes/supplies'));
subapp.use('/api/audit', require('./routes/audit'));
subapp.use('/api/rbac', require('./routes/rbac'));
subapp.use('/api/products', require('./routes/products'));
subapp.use('/api/acceptances', require('./routes/acceptances'));
subapp.use('/api/councils', require('./routes/councils'));
subapp.use('/api/researchers', require('./routes/researchers'));

// Fallback route cho SPA / HTML Views
subapp.get('/ban-lam-viec-khcn', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ban-lam-viec-khcn.html'));
});

subapp.get('/quan-ly-dot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'quan-ly-dot.html'));
});

subapp.get('/phan-quyen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'phan-quyen.html'));
});

subapp.get('/kiem-tra-ho-so', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiem-tra-ho-so.html'));
});

subapp.get('/chi-tiet', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chi-tiet.html'));
});

subapp.get('/hoi-dong-ecv', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hoi-dong-ecv.html'));
});

subapp.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = subapp;
