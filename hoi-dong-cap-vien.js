(function() {
    var user = {};
    try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) { user = {}; }
    var token = localStorage.getItem('token');
    var listEl = document.getElementById('submissions-list');
    var msgEl = document.getElementById('msg');
    var userBar = document.getElementById('user-bar');
    var userEmail = document.getElementById('user-email');
    var apiBase = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')) ? 'http://localhost:3000' : '';

    if (token && user && user.email) {
        userEmail.textContent = typeof getLoginGreetingDisplay === 'function'
            ? getLoginGreetingDisplay(user)
            : (user.email + (user.role ? ' (' + user.role + ')' : ''));
        userBar.style.display = 'flex';
    }

    function escapeHtml(s) {
        if (s == null) return '';
        var div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    function loadSubmissions() {
        if (!token) {
            listEl.innerHTML = '<div class="empty-state">Vui lòng <a href="dang-nhap.html">đăng nhập</a> với tài khoản thành viên Hội đồng để xem hồ sơ.</div>';
            return;
        }
        fetch(apiBase + '/api/cap-vien/submissions', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function(res) {
                if (res.status === 401) {
                    listEl.innerHTML = '<div class="empty-state">Phiên đăng nhập hết hạn. <a href="dang-nhap.html">Đăng nhập lại</a>.</div>';
                    return null;
                }
                if (res.status === 403) {
                    listEl.innerHTML = '<div class="empty-state">Bạn không có quyền xem danh sách hồ sơ.</div>';
                    return null;
                }
                if (!res.ok) {
                    listEl.innerHTML = '<div class="empty-state">Máy chủ trả về lỗi. <a href="dang-nhap.html">Đăng nhập lại</a>.</div>';
                    return null;
                }
                return res.json();
            })
            .then(function(data) {
                if (!data) return;
                var items = Array.isArray(data) ? data : (data.items || data.submissions || []);
                if (items.length === 0) {
                    listEl.innerHTML = '<div class="empty-state">Chưa có hồ sơ đề tài cấp Viện nào được nộp.</div>';
                    return;
                }
                var isAdmin = (user.role || '').toLowerCase() === 'admin';
                listEl.innerHTML = items.map(function(s) {
                    var id = s.id || s._id;
                    var title = s.title || s.tenDeTai || 'Không tên';
                    var by = s.submittedBy || s.email || '';
                    var byName = s.submittedByName ? (escapeHtml(s.submittedByName) + ' (' + escapeHtml(by) + ')') : escapeHtml(by);
                    var date = s.createdAt || s.ngayNop || '';
                    var trackingUrl = 'theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + id;
                    var actions = '<a href="' + trackingUrl + '" class="btn-sm btn-view">Xem tiến trình</a><button type="button" class="btn-sm btn-download" data-id="' + id + '">Tải hồ sơ</button>';
                    if (isAdmin) actions += '<button type="button" class="btn-sm btn-delete" data-id="' + id + '" data-title="' + escapeHtml(title) + '">Xóa</button>';
                    return '<div class="submission-item" data-submission-id="' + id + '">' +
                        '<div><h4><a href="' + trackingUrl + '" style="color: inherit; text-decoration: none;">' + escapeHtml(title) + '</a></h4><p class="meta"><strong>Mã hồ sơ: #' + id + '</strong> — Nộp bởi: ' + byName + (date ? ' — ' + date : '') + '</p></div>' +
                        '<div class="actions">' + actions + '</div></div>';
                }).join('');
                listEl.querySelectorAll('.btn-download').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var id = this.getAttribute('data-id');
                        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/download', { headers: { 'Authorization': 'Bearer ' + token } })
                            .then(function(r) { if (!r.ok) throw new Error(); return r.blob(); })
                            .then(function(blob) {
                                var a = document.createElement('a');
                                a.href = URL.createObjectURL(blob);
                                a.download = 'ho-so-cap-vien-' + id + '.zip';
                                a.click();
                                URL.revokeObjectURL(a.href);
                            })
                            .catch(function() { alert('Không tải được hồ sơ.'); });
                    });
                });
                listEl.querySelectorAll('.btn-delete').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var id = this.getAttribute('data-id');
                        var title = this.getAttribute('data-title') || 'ho so';
                        if (!confirm('Xóa hồ sơ "' + title + '"? Không thể hoàn tác.')) return;
                        fetch(apiBase + '/api/cap-vien/submissions/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
                            .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
                            .then(function(result) {
                                if (result.ok) {
                                    if (msgEl) { msgEl.textContent = 'Đã xóa hồ sơ.'; msgEl.style.background = '#d4edda'; msgEl.style.color = '#155724'; msgEl.style.display = 'block'; }
                                    loadSubmissions();
                                } else {
                                    alert(result.data.message || 'Không thể xóa hồ sơ.');
                                }
                            })
                            .catch(function() { alert('Không thể kết nối máy chủ.'); });
                    });
                });
            })
            .catch(function() {
                listEl.innerHTML = '<div class="empty-state">Không thể tải danh sách. <a href="dang-nhap.html">Đăng nhập lại</a>.</div>';
            });
    }
    loadSubmissions();
})();
