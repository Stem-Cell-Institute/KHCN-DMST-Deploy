(function() {
    var token = localStorage.getItem('token');
    var user = {};
    try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch (_) {}
    var listEl = document.getElementById('submissions-list');
    var userBar = document.getElementById('user-bar');
    var userEmail = document.getElementById('user-email');
    var apiBase = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')) ? 'http://localhost:3000' : '';

    if (token && user.email) {
        userEmail.textContent = typeof getLoginGreetingDisplay === 'function'
            ? getLoginGreetingDisplay(user)
            : user.email;
        userBar.style.display = 'flex';
    } else {
        listEl.innerHTML = '<div class="empty-state">Vui lòng <a href="dang-nhap.html">đăng nhập</a> để xem hồ sơ của bạn.</div>';
        return;
    }

    function escapeHtml(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    function loadSubmissions() {
        if (!token) return;
        fetch(apiBase + '/api/cap-vien/submissions', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function(res) {
                if (res.status === 401) {
                    listEl.innerHTML = '<div class="empty-state">Phiên đăng nhập hết hạn. <a href="dang-nhap.html">Đăng nhập lại</a>.</div>';
                    return null;
                }
                return res.json();
            })
            .then(function(data) {
                if (!data) return;
                var items = Array.isArray(data) ? data : (data.items || data.submissions || []);
                if (items.length === 0) {
                    listEl.innerHTML = '<div class="empty-state">Bạn chưa nộp hồ sơ đề tài cấp Viện nào. <a href="nop-de-tai-cap-vien.html">Nộp đề tài mới</a>.</div>';
                    return;
                }
                var isAdmin = (user.role || '').toLowerCase() === 'admin';
                listEl.innerHTML = items.map(function(s) {
                    var id = s.id || s._id;
                    var title = s.title || 'Không tên';
                    var date = s.createdAt || '';
                    var deleteBtn = isAdmin ? '<button type="button" class="btn-action btn-delete" data-id="' + id + '" data-title="' + escapeHtml(title) + '">Xóa</button>' : '';
                    return '<div class="submission-item">' +
                        '<div><h4>' + escapeHtml(title) + '</h4><p class="meta">Ngày nộp: ' + escapeHtml(date) + '</p></div>' +
                        '<div class="item-actions">' +
                        '<a href="theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + id + '" class="btn-action btn-track">Tiến trình</a>' +
                        '<button type="button" class="btn-action btn-download" data-id="' + id + '">Tải về</button>' +
                        deleteBtn +
                        '</div></div>';
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
                        var title = this.getAttribute('data-title') || 'hồ sơ';
                        if (!confirm('Xóa hồ sơ "' + title + '"? Không thể hoàn tác.')) return;
                        fetch(apiBase + '/api/cap-vien/submissions/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
                            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                            .then(function(result) {
                                if (result.ok) {
                                    alert('Đã xóa hồ sơ.');
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
                listEl.innerHTML = '<div class="empty-state">Không thể tải danh sách. Vui lòng chạy backend.</div>';
            });
    }
    loadSubmissions();
})();
