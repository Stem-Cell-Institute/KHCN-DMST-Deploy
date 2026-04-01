/**
 * Timeline Đề tài cấp Viện - 18 bước đầy đủ + Nút hành động
 */
(function() {
    var apiBase = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')) ? 'http://localhost:3000' : '';
    var token = localStorage.getItem('token');
    var id = (function() {
        var m = /[?&]id=(\d+)/.exec(window.location.search);
        return m ? parseInt(m[1], 10) : 0;
    })();
    var contentEl = document.getElementById('content-area');
    var breadcrumbId = document.getElementById('breadcrumb-id');
    var submissionData = null;

    function escapeHtml(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    function toggleStage(el) {
        var card = el.closest('.stage-card');
        if (card) card.classList.toggle('expanded');
    }
    window.toggleStage = toggleStage;

    function execAction(step, action) {
        if (!submissionData || !id) return;
        var actions = {
            '1-bo-sung': function() { window.location.href = 'nop-de-tai-cap-vien.html?bo_sung=' + id; },
            '2-hop-le': function() { callStepAPI(2, 'approve', {}); },
            '2-yeu-cau-bo-sung': function() { showSupplementDialog(function(note) { if (note) callStepAPI(2, 'request_revision', { note: note }); }); },
            '2-revert': function() { if (confirm('Đưa hồ sơ về Bước 2 để Thư ký kiểm tra lại. Chỉ Admin thực hiện.')) callRevertToStep2(); },
            'revert-to-2': function() { if (confirm('Đưa hồ sơ về Bước 2 (Kiểm tra hồ sơ hành chính). Chỉ Admin.')) callRevertToStep(2); },
            'revert-to-3': function() { if (confirm('Đưa hồ sơ về Bước 3 (Phân công phản biện). Chỉ Admin.')) callRevertToStep(3); },
            'revert-to-4': function() { if (confirm('Đưa hồ sơ về Bước 4 & 4A (Đánh giá phản biện / Thẩm định dự toán). Chỉ Admin.')) callRevertToStep(4); },
            'revert-to-5': function() { if (confirm('Đưa hồ sơ về Bước 5 (Họp Hội đồng). Chỉ Admin.')) callRevertToStep(5); },
            'revert-to-6': function() { if (confirm('Đưa hồ sơ về Bước 6 (Cấp Quyết định phê duyệt). Chỉ Admin.')) callRevertToStep(6); },
            'revert-to-7': function() { if (confirm('Đưa hồ sơ về Bước 7 (Ký hợp đồng). Chỉ Admin.')) callRevertToStep(7); },
            '3-phan-cong': function() { showAssignReviewersDialog(); },
            '4-nop-phieu': function() { showReviewerUploadDialog(); },
            '4-upload-pb1': function() { showReviewerUploadDialog(1); },
            '4-upload-pb2': function() { showReviewerUploadDialog(2); },
            '4-complete-pb1': function() { callStep4ReviewerComplete(1); },
            '4-complete-pb2': function() { callStep4ReviewerComplete(2); },
            '4-delete-pb1': function() { if (confirm('Xóa file phản biện 1 để upload lại?')) callStep4ReviewerDelete(1); },
            '4-delete-pb2': function() { if (confirm('Xóa file phản biện 2 để upload lại?')) callStep4ReviewerDelete(2); },
            '4-gui-email': function() { sendAdminStepEmail(4); },
            '4a-nop-tham-dinh': function() { showBudgetUploadDialog(); },
            '4a-gui-email': function() { sendAdminStepEmail('4a'); },
            '4a-yeu-cau-bo-sung': function() { showBudgetRevisionRequestDialog(); },
            '4a-nop-chinh-sua': function() { showBudgetRevisedUploadDialog(); },
            '4a-phe-duyet': function() { if (confirm('Xác nhận phê duyệt dự toán? Email sẽ gửi đến Chủ nhiệm và Hội đồng.')) callStep4aAPI('approve'); },
            '5-lap-bien-ban': function() { var file = prompt('URL hoặc upload file biên bản họp:'); if (file) callStepAPI(5, 'complete', { file: file }); },
            '6-ky-quyet-dinh': function() { var qd = prompt('Số Quyết định:'); var ngay = prompt('Ngày ký (dd/mm/yyyy):'); if (qd && ngay) callStepAPI(6, 'approve', { decisionNo: qd, date: ngay }); },
            '7-xac-nhan-ky': function() { callStepAPI(7, 'confirm_signed', {}); },
            '8-nop-dao-duc': function() { window.location.href = 'nop-de-tai-cap-vien.html?dao_duc=' + id; },
            '8a-nop-don-tam-ung': function() { var sotien = prompt('Số tiền tạm ứng (VNĐ):'); if (sotien) callStepAPI('8a', 'request', { amount: sotien }); },
            '9-cap-nhat-tien-do': function() { var pct = prompt('Tiến độ % (0-100):'); var note = prompt('Ghi chú:'); if (pct != null) callStepAPI(9, 'update_progress', { percent: pct, note: note }); },
            '10-nop-bao-cao': function() { alert('Mở form nộp báo cáo tiến độ 6 tháng.'); },
            '10a-nop-bao-cao': function() { alert('Mở form nộp báo cáo tiến độ 6 tháng (lần 2).'); },
            '11-de-xuat-dieu-chinh': function() { var loai = prompt('Loại điều chỉnh (nhân sự/kế hoạch/dự toán/gia hạn):'); var nd = prompt('Nội dung:'); if (loai && nd) callStepAPI(11, 'request', { type: loai, content: nd }); },
            '12-nop-nghiem-thu': function() { alert('Mở form nộp hồ sơ nghiệm thu.'); },
            '13-nop-phieu-pb': function() { alert('Mở form nộp phiếu phản biện nghiệm thu.'); },
            '15-lap-bien-ban': function() { callStepAPI(15, 'complete', {}); },
            '16-ky-quyet-dinh': function() { callStepAPI(16, 'approve', {}); },
            '17-ban-giao': function() { callStepAPI(17, 'handover', {}); },
            '18-thanh-ly': function() { callStepAPI(18, 'settle', {}); }
        };
        var fn = actions[step + '-' + action];
        if (fn) fn();
        else if (typeof action === 'string' && action.indexOf('revert-to-') === 0) {
            var num = parseInt(action.replace('revert-to-', ''), 10);
            if (!isNaN(num) && num >= 2 && num <= 7) callRevertToStep(num);
            else alert('Bước không hợp lệ.');
        } else alert('Hành động: ' + step + '/' + action + ' — Cần tích hợp API backend.');
    }

    function callStepAPI(step, action, payload) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/' + step, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ action: action, payload: payload || {} })
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert('Đã cập nhật thành công.');
                location.reload();
            } else {
                alert(res.data.message || 'Thất bại. Backend có thể chưa triển khai endpoint này.');
            }
        }).catch(function(err) {
            alert('Đã ghi nhận (demo). Khi backend chạy, hành động sẽ được lưu thật.');
        });
    }

    function callStep4aAPI(action, formData) {
        var url = apiBase + '/api/cap-vien/submissions/' + id + '/steps/4a/' + action;
        var opts = { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } };
        if (formData) {
            opts.body = formData;
        } else {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify({});
        }
        fetch(url, opts)
            .then(function(r) {
                return r.text().then(function(t) {
                    try {
                        return { ok: r.ok, data: t ? JSON.parse(t) : {} };
                    } catch (err) {
                        return { ok: false, data: { message: t || 'Lỗi' } };
                    }
                });
            })
            .then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã cập nhật.');
                    location.reload();
                } else {
                    alert(res.data.message || 'Thất bại.');
                }
            })
            .catch(function() {
                alert('Không kết nối được máy chủ.');
            });
    }
    function callStep4aRequestRevision(formData) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4a/request-revision', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData
        })
            .then(function(r) {
                return r.text().then(function(t) {
                    try {
                        return { ok: r.ok, data: t ? JSON.parse(t) : {} };
                    } catch (err) {
                        return { ok: false, data: { message: t || 'Lỗi' } };
                    }
                });
            })
            .then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã gửi yêu cầu.');
                    location.reload();
                } else {
                    alert(res.data.message || 'Thất bại.');
                }
            })
            .catch(function() {
                alert('Không kết nối được máy chủ.');
            });
    }
    function callStep4aUploadRevised(formData) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4a/upload-revised', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData
        })
            .then(function(r) {
                return r.text().then(function(t) {
                    try {
                        return { ok: r.ok, data: t ? JSON.parse(t) : {} };
                    } catch (err) {
                        return { ok: false, data: { message: t || 'Lỗi' } };
                    }
                });
            })
            .then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã nộp.');
                    location.reload();
                } else {
                    alert(res.data.message || 'Thất bại.');
                }
            })
            .catch(function() {
                alert('Không kết nối được máy chủ.');
            });
    }

    function callStep4ReviewerComplete(slot) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4/reviewer-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ slot: slot })
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || ('Đã hoàn thành phản biện ' + slot + '.'));
                location.reload();
            } else {
                alert(res.data.message || 'Không thể xác nhận hoàn thành.');
            }
        }).catch(function() {
            alert('Không kết nối được máy chủ.');
        });
    }

    function callStep4ReviewerDelete(slot) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4/reviewer-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ slot: slot })
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || ('Đã xóa file phản biện ' + slot + '.'));
                location.reload();
            } else {
                alert(res.data.message || 'Không thể xóa file phản biện.');
            }
        }).catch(function() {
            alert('Không kết nối được máy chủ.');
        });
    }

    function callRevertToStep2() {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/revert-to-step-2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã đưa hồ sơ về Bước 2.');
                location.reload();
            } else {
                alert(res.data.message || 'Không thể đưa về Bước 2.');
            }
        }).catch(function(err) {
            alert('Đã ghi nhận (demo). Khi backend chạy, hành động sẽ được lưu thật.');
        });
    }
    function callRevertToStep(stepNum) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/revert-to-step/' + stepNum, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã đưa hồ sơ về Bước ' + stepNum + '.');
                location.reload();
            } else {
                alert(res.data.message || 'Không thể đưa về bước đó.');
            }
        }).catch(function(err) {
            alert('Không kết nối được máy chủ.');
        });
    }

    function sendAdminStepEmail(step) {
        var endpoint = step === '4a' ? 'send-step4a-email' : 'send-step4-email';
        var label = step === '4a' ? 'Bước 4A (Tổ thẩm định)' : 'Bước 4 (Phản biện + Hội đồng)';
        if (!confirm('Gửi lại email ' + label + '? Chỉ Admin thực hiện.')) return;
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/' + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã gửi email.');
            } else {
                alert(res.data.message || 'Thất bại.');
            }
        }).catch(function() {
            alert('Không kết nối được máy chủ.');
        });
    }

    function actionButtons(step, actions) {
        if (!actions || !actions.length) return '';
        var html = '<div class="stage-actions">';
        actions.forEach(function(a) {
            html += '<button type="button" class="btn-action ' + (a.className || '') + '" data-step="' + step + '" data-action="' + a.action + '">' + escapeHtml(a.label) + '</button>';
        });
        html += '</div>';
        return html;
    }

    function showAssignReviewersDialog() {
        fetch(apiBase + '/api/cap-vien/council', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
            .then(function(res) {
                if (!res.ok || !res.data.council || res.data.council.length < 2) {
                    alert(res.data.message || 'Không tải được danh sách Hội đồng. Cần ít nhất 2 thành viên. Vào Quản trị để thêm.');
                    return;
                }
                var council = res.data.council;
                var opts = council.map(function(c) { return '<option value="' + c.id + '">' + escapeHtml(c.fullname || c.email) + ' (' + escapeHtml(c.roleDisplay || c.role) + ')</option>'; }).join('');
                var overlay = document.createElement('div');
                overlay.className = 'assign-dialog-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
                var box = document.createElement('div');
                box.className = 'assign-dialog-box';
                box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
                box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">Phân công 2 phản biện</h3>' +
                    '<p style="margin:0 0 12px 0;font-size:0.9rem;color:#666">Chọn 2 thành viên Hội đồng làm phản biện từ danh sách bên dưới.</p>' +
                    '<div class="form-group" style="margin-bottom:12px"><label style="display:block;font-weight:500;margin-bottom:4px">Phản biện 1</label><select id="assign-pb1" style="width:100%;padding:8px 12px;border:2px solid #dee2e6;border-radius:8px;font-size:1rem"><option value="">— Chọn thành viên —</option>' + opts + '</select></div>' +
                    '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:500;margin-bottom:4px">Phản biện 2</label><select id="assign-pb2" style="width:100%;padding:8px 12px;border:2px solid #dee2e6;border-radius:8px;font-size:1rem"><option value="">— Chọn thành viên —</option>' + opts + '</select></div>' +
                    '<div style="display:flex;gap:10px;justify-content:flex-end">' +
                    '<button type="button" class="btn-action btn-secondary" id="assign-dialog-cancel" style="padding:8px 16px">Hủy</button>' +
                    '<button type="button" class="btn-action" id="assign-dialog-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Hoàn thành phân công</button></div>';
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                var close = function() { document.body.removeChild(overlay); };
                overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
                document.getElementById('assign-dialog-cancel').onclick = close;
                document.getElementById('assign-dialog-submit').onclick = function() {
                    var v1 = document.getElementById('assign-pb1').value;
                    var v2 = document.getElementById('assign-pb2').value;
                    if (!v1 || !v2) { alert('Vui lòng chọn đủ 2 phản biện.'); return; }
                    if (v1 === v2) { alert('Phản biện 1 và Phản biện 2 phải khác nhau.'); return; }
                    close();
                    callStepAPI(3, 'assign', { reviewerIds: [parseInt(v1, 10), parseInt(v2, 10)] });
                };
            })
            .catch(function() { alert('Không tải được danh sách Hội đồng. Vui lòng chạy backend.'); });
    }

    function showBudgetUploadDialog() {
        var overlay = document.createElement('div');
        overlay.className = 'budget-upload-dialog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.className = 'budget-upload-dialog-box';
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">📋 Nộp phiếu thẩm định dự toán</h3>' +
            '<p style="margin:0 0 16px 0;font-size:0.9rem;color:#666">Tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02). Định dạng PDF khuyến nghị.</p>' +
            '<div class="form-group" style="margin-bottom:12px"><label style="display:block;font-weight:500;margin-bottom:4px">1. Phiếu thẩm định (SCI-BUDGET-01)</label><input type="file" id="budget-file-1" name="budget_phieu_tham_dinh" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:500;margin-bottom:4px">2. Tờ trình (SCI-BUDGET-02)</label><input type="file" id="budget-file-2" name="budget_to_trinh" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div id="budget-upload-msg" style="display:none;margin-bottom:12px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="budget-dialog-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="budget-dialog-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Nộp phiếu thẩm định</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('budget-dialog-cancel').onclick = close;
        document.getElementById('budget-dialog-submit').onclick = function() {
            var inp1 = document.getElementById('budget-file-1');
            var inp2 = document.getElementById('budget-file-2');
            var msgEl = document.getElementById('budget-upload-msg');
            if (!inp1 || !inp1.files || !inp1.files[0] || !inp2 || !inp2.files || !inp2.files[0]) {
                if (msgEl) { msgEl.textContent = 'Vui lòng chọn đủ 2 file.'; msgEl.style.display = 'block'; msgEl.style.background = '#f8d7da'; msgEl.style.color = '#721c24'; }
                return;
            }
            var formData = new FormData();
            formData.append('budget_phieu_tham_dinh', inp1.files[0]);
            formData.append('budget_to_trinh', inp2.files[0]);
            document.getElementById('budget-dialog-submit').disabled = true;
            if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4a/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: formData
            }).then(function(r) {
                return r.text().then(function(t) {
                    try { var d = t ? JSON.parse(t) : {}; return { ok: r.ok, data: d }; } catch(e) { return { ok: false, data: { message: t || 'Lỗi máy chủ' } }; }
                });
            }).then(function(res) {
                if (res.ok) {
                    if (msgEl) { msgEl.textContent = res.data.message || 'Đã nộp phiếu thẩm định.'; msgEl.style.display = 'block'; msgEl.style.background = '#d4edda'; msgEl.style.color = '#155724'; }
                    setTimeout(function() { close(); location.reload(); }, 1200);
                } else {
                    if (msgEl) { msgEl.textContent = res.data.message || 'Nộp thất bại.'; msgEl.style.display = 'block'; msgEl.style.background = '#f8d7da'; msgEl.style.color = '#721c24'; }
                    document.getElementById('budget-dialog-submit').disabled = false;
                }
            }).catch(function() {
                if (msgEl) { msgEl.textContent = 'Không kết nối được máy chủ.'; msgEl.style.display = 'block'; msgEl.style.background = '#f8d7da'; msgEl.style.color = '#721c24'; }
                document.getElementById('budget-dialog-submit').disabled = false;
            });
        };
    }

    function showBudgetRevisionRequestDialog() {
        var overlay = document.createElement('div');
        overlay.className = 'budget-revision-dialog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.className = 'budget-revision-dialog-box';
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">⚠️ Yêu cầu bổ sung/chỉnh sửa dự toán</h3>' +
            '<p style="margin:0 0 12px 0;font-size:0.9rem;color:#666">Nội dung và file đính kèm sẽ gửi đến Chủ nhiệm (CC Hội đồng).</p>' +
            '<div class="form-group" style="margin-bottom:12px"><label style="display:block;font-weight:500;margin-bottom:4px">Nội dung yêu cầu *</label><textarea id="budget-revision-note" rows="4" placeholder="Nhập nội dung cần Chủ nhiệm chỉnh sửa..." style="width:100%;padding:10px;border:2px solid #dee2e6;border-radius:8px;font-family:inherit;box-sizing:border-box;"></textarea></div>' +
            '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:500;margin-bottom:4px">File đính kèm (tùy chọn)</label><input type="file" id="budget-revision-files" name="revision_files" accept=".pdf,.doc,.docx" multiple style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div id="budget-revision-msg" style="display:none;margin-bottom:12px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="budget-revision-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="budget-revision-submit" style="padding:8px 16px;background:#ff9800;color:#fff;border:none">Xong</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('budget-revision-cancel').onclick = close;
        document.getElementById('budget-revision-submit').onclick = function() {
            var note = (document.getElementById('budget-revision-note') && document.getElementById('budget-revision-note').value || '').trim();
            if (!note) { alert('Vui lòng nhập nội dung yêu cầu bổ sung.'); return; }
            var formData = new FormData();
            formData.append('note', note);
            var inp = document.getElementById('budget-revision-files');
            if (inp && inp.files) for (var i = 0; i < inp.files.length; i++) formData.append('revision_files', inp.files[i]);
            document.getElementById('budget-revision-submit').disabled = true;
            callStep4aRequestRevision(formData);
            close();
        };
    }

    function showBudgetRevisedUploadDialog() {
        var overlay = document.createElement('div');
        overlay.className = 'budget-revised-dialog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.className = 'budget-revised-dialog-box';
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">📤 Nộp tài liệu tài chính đã chỉnh sửa</h3>' +
            '<p style="margin:0 0 16px 0;font-size:0.9rem;color:#666">Tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02) đã chỉnh sửa theo yêu cầu.</p>' +
            '<div class="form-group" style="margin-bottom:12px"><label style="display:block;font-weight:500;margin-bottom:4px">1. Phiếu thẩm định (SCI-BUDGET-01)</label><input type="file" id="budget-revised-1" name="budget_phieu_tham_dinh" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:500;margin-bottom:4px">2. Tờ trình (SCI-BUDGET-02)</label><input type="file" id="budget-revised-2" name="budget_to_trinh" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div id="budget-revised-msg" style="display:none;margin-bottom:12px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="budget-revised-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="budget-revised-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Nộp tài liệu chỉnh sửa</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('budget-revised-cancel').onclick = close;
        document.getElementById('budget-revised-submit').onclick = function() {
            var inp1 = document.getElementById('budget-revised-1');
            var inp2 = document.getElementById('budget-revised-2');
            if (!inp1 || !inp1.files || !inp1.files[0] || !inp2 || !inp2.files || !inp2.files[0]) {
                alert('Vui lòng chọn đủ 2 file.'); return;
            }
            var formData = new FormData();
            formData.append('budget_phieu_tham_dinh', inp1.files[0]);
            formData.append('budget_to_trinh', inp2.files[0]);
            document.getElementById('budget-revised-submit').disabled = true;
            callStep4aUploadRevised(formData);
            close();
        };
    }

    function showReviewerUploadDialog(forcedSlot) {
        var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
        var reviewerIds = (submissionData && submissionData.assignedReviewerIds) ? (function(){ try { return JSON.parse(submissionData.assignedReviewerIds || '[]'); } catch(e){ return []; } })() : [];
        var mySlot = reviewerIds[0] === user.id ? 1 : (reviewerIds[1] === user.id ? 2 : 0);
        var chosenSlot = parseInt(forcedSlot || '0', 10);
        if (!mySlot && user.role !== 'admin') { alert('Chỉ phản biện được phân công hoặc Admin mới được nộp phiếu đánh giá.'); return; }
        if (chosenSlot && user.role !== 'admin' && chosenSlot !== mySlot) {
            alert('Bạn chỉ có thể upload cho slot phản biện được phân công.');
            return;
        }
        var slot = chosenSlot || mySlot || 1;
        var overlay = document.createElement('div');
        overlay.className = 'reviewer-upload-dialog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.className = 'reviewer-upload-dialog-box';
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">📋 Nộp phiếu đánh giá phản biện (SCI-TASK-06)</h3>' +
            '<p style="margin:0 0 16px 0;font-size:0.9rem;color:#666">Tải lên file phiếu đánh giá. Định dạng PDF hoặc Word.</p>' +
            ((user.role === 'admin' && !chosenSlot) ? '<div class="form-group" style="margin-bottom:12px"><label>Phản biện slot</label><select id="reviewer-slot" style="width:100%;padding:8px"><option value="1">Phản biện 1</option><option value="2">Phản biện 2</option></select></div>' : '') +
            '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:500;margin-bottom:4px">File phiếu đánh giá</label><input type="file" id="reviewer-phieu-file" name="phieu_danh_gia" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="reviewer-upload-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="reviewer-upload-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Nộp phiếu</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('reviewer-upload-cancel').onclick = close;
        document.getElementById('reviewer-upload-submit').onclick = function() {
            var fileInp = document.getElementById('reviewer-phieu-file');
            var s = (document.getElementById('reviewer-slot') && document.getElementById('reviewer-slot').value) || slot;
            if (!fileInp || !fileInp.files || !fileInp.files[0]) { alert('Vui lòng chọn file.'); return; }
            var formData = new FormData();
            formData.append('phieu_danh_gia', fileInp.files[0]);
            formData.append('slot', s);
            document.getElementById('reviewer-upload-submit').disabled = true;
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/4/reviewer-upload', {
                method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData
            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                .then(function(res) { if (res.ok) { alert(res.data.message || 'Đã nộp.'); location.reload(); } else { alert(res.data.message || 'Thất bại.'); document.getElementById('reviewer-upload-submit').disabled = false; } })
                .catch(function() { alert('Không kết nối được máy chủ.'); document.getElementById('reviewer-upload-submit').disabled = false; });
        };
    }

    function showSupplementDialog(onSubmit) {
        var overlay = document.createElement('div');
        overlay.className = 'supplement-dialog-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.className = 'supplement-dialog-box';
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:480px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        box.innerHTML = '<h3 style="margin:0 0 12px 0;font-size:1.1rem;color:#333">Nội dung yêu cầu bổ sung</h3>' +
            '<p style="margin:0 0 12px 0;font-size:0.9rem;color:#666">Nội dung này sẽ gửi cho nghiên cứu viên và lưu lại cho Hội đồng xem.</p>' +
            '<textarea id="supplement-dialog-note" rows="5" placeholder="Nhập nội dung cần bổ sung..." style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:14px;resize:vertical;box-sizing:border-box;"></textarea>' +
            '<div style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="supplement-dialog-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="supplement-dialog-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Gửi yêu cầu</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var noteEl = document.getElementById('supplement-dialog-note');
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('supplement-dialog-cancel').onclick = close;
        document.getElementById('supplement-dialog-submit').onclick = function() {
            var note = (noteEl && noteEl.value || '').trim();
            if (!note) { alert('Vui lòng nhập nội dung yêu cầu bổ sung.'); return; }
            close();
            if (onSubmit) onSubmit(note);
        };
        if (noteEl) noteEl.focus();
    }

    var TAI_MAU_URL = 'tai-mau-ho-so-de-tai-cap-vien.html';
    function templateHint(stepId) {
        var hints = {
            1: 'SCI-TASK-01, 02, 03',
            4: 'SCI-TASK-06',
            '4a': 'SCI-BUDGET-01, 02',
            5: 'SCI-TASK-07',
            10: 'SCI-INST-07',
            '10a': 'SCI-INST-07',
            11: 'SCI-ACE-06',
            12: 'SCI-FINAL-01, 02, 03',
            13: 'SCI-FINAL-04',
            15: 'SCI-FINAL-05, 06',
            18: 'SCI-FINAL-08'
        };
        var codes = hints[stepId];
        if (!codes) return '';
        return '<p class="template-hint">📄 Cần mẫu: <strong>' + escapeHtml(codes) + '</strong>. <a href="' + escapeHtml(TAI_MAU_URL) + '" target="_blank">Tải tại mục Hướng dẫn tải mẫu hồ sơ</a></p>';
    }

    /**
     * Logic giống ACE (theo-doi-ho-so): dùng STATUS để xác định bước hiện tại.
     * currentBlock = index block đang thực hiện (0-based). Chỉ đúng 1 block active (cam).
     */
    function statusToCurrentBlock(status) {
        var s = (status || 'SUBMITTED').toUpperCase();
        if (s === 'SUBMITTED') return 1;   // Bước 1 xong, Bước 2 đang làm
        if (s === 'NEED_REVISION') return 1;   // Bước 2 đang chờ NCV nộp lại (vẫn hiển thị Bước 2 active)
        if (s === 'VALIDATED') return 2;   // Bước 2 xong, Bước 3 đang làm
        if (s === 'ASSIGNED' || s === 'UNDER_REVIEW') return 3;     // Bước 3 xong, Bước 4 đang làm
        if (s === 'REVIEWED') return 4;    // Bước 4 xong, Bước 5 đang làm
        if (s === 'IN_MEETING' || s === 'CONDITIONAL') return 5;    // Bước 5
        if (s === 'APPROVED') return 6;    // Bước 6
        if (s === 'CONTRACTED') return 7;  // Bước 7
        if (s === 'IMPLEMENTATION') return 8;   // Bước 9
        if (s === 'COMPLETED' || s === 'REJECTED') return 18;       // Xong hoặc dừng
        return 1;
    }

    function getStepState(stepId, currentBlock) {
        var seq = [1, 2, 3, [4, '4a'], 5, 6, 7, [8, '8a'], 9, 10, '10a', 11, 12, 13, 15, 16, 17, 18];
        currentBlock = Math.min(seq.length, Math.max(0, currentBlock));
        for (var i = 0; i < seq.length; i++) {
            var block = seq[i];
            var blockSteps = Array.isArray(block) ? block : [block];
            var match = blockSteps.some(function(s) { return s == stepId; });
            if (match) {
                if (i < currentBlock) return 'completed';
                if (i === currentBlock) return 'active';
                return 'pending';
            }
        }
        return 'pending';
    }

    function stageClass(state) { return state === 'completed' ? 'completed' : (state === 'active' ? 'active' : 'pending'); }
    function stageIcon(state) { return state === 'completed' ? '✓' : (state === 'active' ? '⏳' : '⏸'); }
    function stageBadge(state) { return state === 'completed' ? 'badge-done' : (state === 'active' ? 'badge-progress' : 'badge-pending'); }
    function stageBadgeTxt(state) { return state === 'completed' ? '✓ Hoàn thành' : (state === 'active' ? '▶ Đang thực hiện' : '⏸ Chưa bắt đầu'); }

    function buildFullTimeline(data) {
        submissionData = data;
        var code = data.code || ('DTSCI-2025-' + String(data.id).padStart(3, '0'));
        var title = data.title || data.tenDeTai || 'Không tên';
        var chunhiem = data.submittedByName || data.submittedBy || data.chuNhiem || '—';
        var ngayNop = data.createdAt || data.ngayNop || '—';
        var status = (data.status || 'SUBMITTED').toUpperCase();
        var files = data.files || [];
        // Xác định block hiện tại theo STATUS là nguồn chuẩn
        var statusBlock = statusToCurrentBlock(status);
        if (status === 'SUBMITTED') {
            statusBlock = 1;
        }
        var currentBlock = statusBlock;
        // Nếu backend có trường stepsDone thì chỉ dùng để tinh chỉnh,
        // không cho phép vượt quá block tối đa suy ra từ STATUS
        if (data.stepsDone != null) {
            var raw = parseInt(data.stepsDone, 10);
            if (!isNaN(raw) && raw >= 0) {
                var stepsBlock = Math.min(18, raw);
                currentBlock = Math.min(statusBlock, stepsBlock);
            }
        }
        // Chỉ cho viền xanh (completed) khi dữ liệu thực sự đã xong:
        // Bước 4 & 4A: chỉ coi hoàn thành khi CẢ 2 phản biện nộp VÀ dự toán đã phê duyệt
        var step4BothDone = !!(data.step_4_reviewer1_done && data.step_4_reviewer2_done);
        var step4aApproved = (data.budget_4a_status || '').toLowerCase() === 'approved';
        var step4And4aReallyDone = step4BothDone && step4aApproved;
        if (step4And4aReallyDone && currentBlock < 4) {
            currentBlock = 4;  // 4 & 4a hiển thị xanh, Bước 5 active (cam)
        }
        // Ngược lại: nếu status nói "qua bước 4" nhưng dữ liệu chưa đủ thì KHÔNG tô xanh 4 & 4a (tránh viền xanh lem sang bước chưa xong)
        if (currentBlock >= 4 && !step4And4aReallyDone) {
            currentBlock = 3;  // 4 & 4a vẫn là active (cam), không viền xanh
        }
        var stepsDone = currentBlock;
        var total = 18;
        var progress = data.progressPercent != null ? data.progressPercent : Math.round((stepsDone / total) * 100);
        var statusLabel = { SUBMITTED: 'Đã nộp', VALIDATED: 'Đã kiểm tra (Hợp lệ)', NEED_REVISION: 'Cần bổ sung', APPROVED: 'Đã phê duyệt', IN_PROGRESS: 'Đang thực hiện', COMPLETED: 'Hoàn thành', REJECTED: 'Từ chối' }[status] || status;

        var byRound = {};
        (files || []).forEach(function(f) {
            var r = f.revisionRound != null ? f.revisionRound : 0;
            if (!byRound[r]) byRound[r] = []; byRound[r].push(f);
        });
        var rounds = Object.keys(byRound).map(Number).sort(function(a, b) { return a - b; });
        var fileItems = rounds.map(function(round) {
            var title = round === 0 ? 'Hồ sơ gốc' : 'Hồ sơ bổ sung (lần ' + round + ')';
            var items = (byRound[round] || []).map(function(f) {
                var name = f.originalName || f.fieldName || f.name || 'file';
                var size = f.size ? (f.size / 1024).toFixed(0) + ' KB' : '';
                return '<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(name) + '</div><div class="file-meta">' + escapeHtml(size) + ' • ' + escapeHtml(ngayNop) + '</div></div></div><button class="btn-download-file" data-fid="' + (f.id || '') + '">📥 Tải về</button></div>';
            }).join('');
            return '<div class="files-group-by-round" style="margin-bottom:12px"><div class="files-title" style="font-weight:600;color:var(--primary);margin-bottom:6px;font-size:0.95rem">' + escapeHtml(title) + '</div><div class="file-list">' + items + '</div></div>';
        }).join('');

        var avatar = (typeof chunhiem === 'string' ? chunhiem.substring(0, 2).toUpperCase() : 'NV').replace(/[^A-Z0-9]/gi, '') || 'NV';

        var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
        var isAdmin = user.role === 'admin';
        var html = '';
        html += '<div class="timeline-toolbar"><button class="btn-export" onclick="window.print()">🖨️ In</button><button class="btn-export" onclick="exportPDF()">📥 Xuất PDF</button><button class="btn-export" onclick="exportExcel()">📊 Xuất Excel</button></div>';
        html += '<div class="task-header"><div class="task-code">Mã đề tài: ' + escapeHtml(code);
        if (isAdmin && data.id) html += ' <button type="button" class="btn-edit-code btn-sm" data-id="' + data.id + '" style="margin-left:8px;font-size:12px;padding:2px 8px;">Sửa mã</button>';
        html += '</div>';
        html += '<h1 class="task-title">' + escapeHtml(title) + '</h1>';
        html += '<div class="task-meta">';
        html += '<div class="meta-item"><span class="meta-label">Chủ nhiệm</span><span class="meta-value">' + escapeHtml(chunhiem) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Ngày nộp</span><span class="meta-value">' + escapeHtml(ngayNop) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Thời gian thực hiện</span><span class="meta-value">24 tháng</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Kinh phí</span><span class="meta-value">—</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Trạng thái</span><span class="meta-value" style="color:#4caf50">✅ ' + escapeHtml(statusLabel) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Tiến độ</span><span class="meta-value">' + stepsDone + '/' + total + ' bước (' + Math.round(progress) + '%)</span></div></div></div>';

        var activeCount = stepsDone < total ? 1 : 0;
        var pendingCount = total - stepsDone - activeCount;
        html += '<div class="progress-overview"><h3 style="margin-bottom:15px">Tổng quan tiến độ</h3>';
        html += '<div class="progress-label"><span>Hoàn thành các bước quản lý</span><span><strong>' + stepsDone + '/' + total + ' bước</strong> đã hoàn thành</span></div>';
        html += '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min(100, progress) + '%">' + Math.round(progress) + '%</div></div>';
        html += '<div class="timeline-stats">';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#4caf50">' + stepsDone + '</div><div class="stat-mini-label">Bước hoàn thành</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#ff9800">' + activeCount + '</div><div class="stat-mini-label">Đang thực hiện</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#f44336">0</div><div class="stat-mini-label">Quá hạn</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#999">' + pendingCount + '</div><div class="stat-mini-label">Chưa bắt đầu</div></div></div></div>';

        html += '<div class="timeline-phases">';
        // ===== GIAI ĐOẠN 1 =====
        html += '<div class="phase-header"><h3>📋 GIAI ĐOẠN 1: ĐĂNG KÝ VÀ XÉT DUYỆT HỒ SƠ (Bước 1-6)</h3></div>';

        var stepHistory = data.stepHistory || {};
        (function(){ var s=getStepState(1,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="1"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 1: Nộp hồ sơ đề xuất</h3><div class="stage-subtitle"><span>👤 Nghiên cứu viên</span><span class="stage-duration">⏱️ Thực tế: 2 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span style="font-size:12px;color:#666">'+escapeHtml(ngayNop)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline">';
        var step1Hist = stepHistory['1'] || [];
        if (step1Hist.length) {
            step1Hist.forEach(function(h) {
                var label = (h.actionType === 'researcher_submit') ? '📝 Nghiên cứu viên nộp hồ sơ' : h.actionType;
                html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? escapeHtml(h.note) : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
            });
        } else {
            html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">📝 Nghiên cứu viên nộp hồ sơ</div><div class="event-time">' + escapeHtml(ngayNop) + '</div></div><div class="event-content">Chủ nhiệm ' + escapeHtml(chunhiem) + ' nộp đầy đủ hồ sơ qua hệ thống online</div><div class="event-user"><div class="user-avatar">' + avatar + '</div><span>' + escapeHtml(chunhiem) + '</span></div></div>';
        }
        html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Hệ thống tự động sinh mã</div><div class="event-time">' + escapeHtml(ngayNop) + '</div></div><div class="event-content">Mã đề tài: <strong>' + escapeHtml(code) + '</strong></div></div>';
        html += '<div class="timeline-event"><div class="event-header"><div class="event-title">📧 Email thông báo tự động</div><div class="event-time">' + escapeHtml(ngayNop) + '</div></div><div class="event-content">Gửi đến: Admin, Chủ tịch HĐKHCN, Thư ký, thành viên Hội đồng</div></div></div>';
        if (fileItems) html += '<div class="files-section"><div class="files-title">📎 Hồ sơ đã nộp (' + files.length + ' files):</div>' + fileItems + '</div>';
        html += actionButtons(1, [{ label: '📎 Bổ sung hồ sơ', action: 'bo-sung' }]) + templateHint(1) + '</div></div></div>';

        (function(){ var s=getStepState(2,stepsDone); var extraClass = (status === 'NEED_REVISION') ? ' expanded' : ''; html+='<div class="stage-card '+stageClass(s)+extraClass+'" data-step="2"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 2: Kiểm tra hồ sơ hành chính</h3><div class="stage-subtitle"><span>👤 Thư ký HĐKHCN</span><span class="stage-duration">⏱️ Quy định: 3-5 ngày • Thực tế: 3 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        (function(){
            var reviewNote = data.reviewNote || '';
            var reviewedAt = data.reviewedAt || '—';
            var reviewedByName = data.reviewedByName || '—';
            var step2History = data.step2History || [];
            var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            var isAdmin = user.role === 'admin';
            var actionLabels = { secretary_approve: '✅ Thư ký kết luận: Hợp lệ', secretary_request_revision: '⚠️ Thư ký yêu cầu bổ sung', researcher_supplement: '📤 Nghiên cứu viên nộp hồ sơ bổ sung', researcher_resubmit: '📤 Nghiên cứu viên nộp lại hồ sơ', admin_revert: '↩ Admin đưa hồ sơ về Bước 2' };
            var actionClasses = { secretary_approve: 'success', secretary_request_revision: 'warning', researcher_supplement: '', researcher_resubmit: '', admin_revert: '' };
            if (status === 'SUBMITTED') {
                html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Thư ký kiểm tra hồ sơ</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra tính đầy đủ, format, điều kiện chủ nhiệm</div></div>';
                if (step2History.length) {
                    step2History.forEach(function(h) {
                        var label = actionLabels[h.actionType] || h.actionType;
                        var cls = actionClasses[h.actionType] || '';
                        html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? '<p style="white-space:pre-wrap">' + escapeHtml(h.note) + '</p>' : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
                    });
                }
                html += '<div class="timeline-event"><div class="event-header"><div class="event-title">✅ Kết luận</div><div class="event-time">—</div></div><div class="event-content">Chọn Hợp lệ hoặc Yêu cầu bổ sung bên dưới</div></div></div>';
                html += '<div class="files-section"><div class="files-title">📎 File tạo ra:</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">SCI-TASK-04_Phieu_kiem_tra.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
                html += actionButtons(2, [{ label: '✅ Hợp lệ', action: 'hop-le' }, { label: '⚠️ Yêu cầu bổ sung', action: 'yeu-cau-bo-sung', className: 'btn-secondary' }]);
            } else if (status === 'VALIDATED') {
                html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Thư ký kiểm tra hồ sơ</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra tính đầy đủ, format, điều kiện chủ nhiệm</div></div>';
                if (step2History.length) {
                    step2History.forEach(function(h) {
                        var label = actionLabels[h.actionType] || h.actionType;
                        var cls = actionClasses[h.actionType] || '';
                        html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? '<p style="white-space:pre-wrap">' + escapeHtml(h.note) + '</p>' : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
                    });
                } else {
                    html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Kết luận: Hợp lệ</div><div class="event-time">' + escapeHtml(reviewedAt) + '</div></div><div class="event-content">✓ Hồ sơ đầy đủ<br>✓ Format đúng quy định<br>→ Chuyển Bước 3<br>' + (reviewedByName !== '—' ? '<div class="event-user" style="margin-top:8px">Người kiểm tra: ' + escapeHtml(reviewedByName) + '</div>' : '') + '</div></div>';
                }
                html += '</div><div class="files-section"><div class="files-title">📎 File tạo ra:</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">SCI-TASK-04_Phieu_kiem_tra.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
                if (isAdmin) html += actionButtons(2, [{ label: '↩ Đưa về Bước 2 (chỉ Admin)', action: 'revert', className: 'btn-secondary' }]);
            } else if (status === 'NEED_REVISION') {
                html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Thư ký kiểm tra hồ sơ</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra tính đầy đủ, format, điều kiện chủ nhiệm</div></div>';
                if (step2History.length) {
                    step2History.forEach(function(h) {
                        var label = actionLabels[h.actionType] || h.actionType;
                        var cls = actionClasses[h.actionType] || '';
                        html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? '<p style="white-space:pre-wrap">' + escapeHtml(h.note) + '</p>' : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
                    });
                } else {
                    html += '<div class="timeline-event warning"><div class="event-header"><div class="event-title">⚠️ Yêu cầu bổ sung đã gửi</div><div class="event-time">' + escapeHtml(reviewedAt) + '</div></div><div class="event-content">' + (reviewNote ? '<p><strong>Nội dung gửi nghiên cứu viên:</strong></p><p style="white-space:pre-wrap;background:#fff8e1;padding:10px;border-radius:8px">' + escapeHtml(reviewNote) + '</p>' : '') + '<p style="margin-top:10px">Người gửi: ' + escapeHtml(reviewedByName) + '</p></div></div>';
                }
                html += '</div><p class="stage-note" style="margin-top:12px;padding:12px;background:#e3f2fd;border-radius:8px">Quá trình vẫn ở Bước 2. Nộp hồ sơ bổ sung bên dưới (không đổi trang). Sau khi gửi, Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung tiếp.</p>';
                var filesByRoundStep2 = {};
                (data.files || []).forEach(function(f) {
                    var r = f.revisionRound != null ? f.revisionRound : 0;
                    if (!filesByRoundStep2[r]) filesByRoundStep2[r] = []; filesByRoundStep2[r].push(f);
                });
                var roundsStep2 = Object.keys(filesByRoundStep2).map(Number).sort(function(a,b){ return a - b; });
                if (roundsStep2.length) {
                    html += '<div class="files-section" style="margin-top:12px"><div class="files-title">📎 Hồ sơ đã nộp:</div>';
                    roundsStep2.forEach(function(round) {
                        var title = round === 0 ? 'Hồ sơ gốc' : 'Hồ sơ bổ sung (lần ' + round + ')';
                        html += '<div class="files-group-by-round" style="margin-bottom:8px"><div class="files-title" style="font-weight:600;color:var(--primary);font-size:0.9rem">' + escapeHtml(title) + '</div><div class="file-list">';
                        (filesByRoundStep2[round] || []).forEach(function(f) {
                            var name = f.originalName || f.fieldName || 'file';
                            html += '<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(name) + '</div></div></div><button type="button" class="btn-download-file" data-fid="' + (f.id || '') + '">📥 Tải về</button></div>';
                        });
                        html += '</div></div>';
                    });
                    html += '</div>';
                }
                html += '<div class="step2-supplement-form" style="margin-top:16px;padding:16px;background:#f8f9fa;border-radius:12px;border:1px solid #dee2e6">';
                html += '<div class="files-title" style="margin-bottom:8px">📎 Hồ sơ bổ sung (lần mới)</div>';
                html += '<p style="font-size:0.9rem;color:#666;margin-bottom:10px">Thêm file (PDF, DOCX). Nhấn ➕ để thêm ô tải lên.</p>';
                html += '<div id="step2-supplement-inputs"><div class="form-group supplement-row" style="margin-bottom:8px"><input type="file" name="supplement" accept=".pdf,.doc,.docx" class="supplement-file" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px"></div></div>';
                html += '<button type="button" id="btn-add-supplement-step2" style="margin-bottom:12px;padding:6px 12px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer;font-size:0.9rem">➕ Thêm ô tải file</button> ';
                html += '<button type="button" id="btn-submit-supplement-step2" class="btn-action" style="padding:8px 16px">📤 Gửi hồ sơ bổ sung</button> ';
                html += '<button type="button" id="btn-resubmit-step2" class="btn-action btn-secondary" style="padding:8px 16px">📋 Nộp lại (không file mới)</button>';
                html += '<p id="step2-supplement-msg" class="msg" style="display:none;margin-top:10px;padding:8px;border-radius:8px;font-size:0.9rem"></p></div>';
            } else {
                html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Thư ký kiểm tra hồ sơ</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra tính đầy đủ, format, điều kiện chủ nhiệm</div></div></div>';
                html += '<div class="files-section"><div class="files-title">📎 File tạo ra:</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">SCI-TASK-04_Phieu_kiem_tra.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
                var u2 = {}; try { u2 = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
                if ((u2.role || '').toLowerCase() === 'admin') html += actionButtons(2, [{ label: '↩ Đưa về Bước 2 (Admin)', action: 'revert', className: 'btn-secondary' }]);
            }
            html += '</div></div></div>';
        })();

        (function(){ var s=getStepState(3,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="3"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 3: Phân công phản biện</h3><div class="stage-subtitle"><span>👤 Chủ tịch HĐKHCN</span><span class="stage-duration">⏱️ Quy định: 2-3 ngày • Thực tế: 2 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        (function(){
            var pb1 = (data.reviewerNames && data.reviewerNames[0]) ? data.reviewerNames[0] : '—';
            var pb2 = (data.reviewerNames && data.reviewerNames[1]) ? data.reviewerNames[1] : '—';
            var assignedAt = data.assignedAt || '—';
            var assignedBy = data.assignedByName || '—';
            var step3Hist = stepHistory['3'] || [];
            html += '<div class="stage-content"><div class="stage-timeline">';
            if (step3Hist.length) {
                step3Hist.forEach(function(h) {
                    var label = (h.actionType === 'chairman_assign') ? '👥 Chủ tịch HĐKHCN phân công 2 phản biện' : h.actionType;
                    if (h.actionType === 'chairman_assign') {
                        html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div></div>';
                    } else {
                        html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? escapeHtml(h.note) : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
                    }
                });
                // Luon hien thi ro PB1/PB2 de Hoi dong de theo doi.
                html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">📌 Kết quả phân công phản biện</div><div class="event-time">' + escapeHtml(assignedAt) + '</div></div><div class="event-content"><strong>Phản biện 1:</strong> ' + escapeHtml(pb1) + '<br><strong>Phản biện 2:</strong> ' + escapeHtml(pb2) + (assignedBy !== '—' ? '<br><strong>Phân công bởi:</strong> ' + escapeHtml(assignedBy) : '') + '</div></div>';
            } else {
                html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">👥 Phân công 2 phản biện</div><div class="event-time">' + escapeHtml(assignedAt) + '</div></div><div class="event-content"><strong>Phản biện 1:</strong> ' + escapeHtml(pb1) + '<br><strong>Phản biện 2:</strong> ' + escapeHtml(pb2) + '<br>' + (assignedBy !== '—' ? 'Phân công bởi: ' + escapeHtml(assignedBy) : '') + '</div></div>';
            }
            if (status === 'VALIDATED') {
                var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
                var isChairmanOrAdmin = (user.role || '').toLowerCase() === 'chu_tich' || (user.role || '').toLowerCase() === 'admin';
                if (isChairmanOrAdmin) html += actionButtons(3, [{ label: '👥 Phân công phản biện', action: 'phan-cong' }]);
            }
            var u3 = {}; try { u3 = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            if ((u3.role || '').toLowerCase() === 'admin') html += actionButtons(3, [{ label: '↩ Đưa về Bước 2 (Admin)', action: 'revert-to-2', className: 'btn-secondary' }]);
            html += '</div></div></div>';
        })();

        html += '<div class="parallel-label">⚡ 2 BƯỚC THỰC HIỆN SONG SONG ⚡</div><div class="parallel-stages">';

        (function(){ var s=getStepState(4,stepsDone); if (!step4And4aReallyDone && s === 'completed') s = 'active'; html+='<div class="stage-card '+stageClass(s)+'" data-step="4"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 4: Đánh giá phản biện</h3><div class="stage-subtitle"><span>👥 2 Phản biện</span><span class="stage-duration">⏱️ 7-10 ngày • Thực tế: 10 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        (function(){
            var reviewerFiles = {};
            (data.files || []).forEach(function(f){
                if (f.fieldName === 'reviewer_phieu_1') reviewerFiles[1] = f;
                if (f.fieldName === 'reviewer_phieu_2') reviewerFiles[2] = f;
            });
            var reviewerNames = data.reviewerNames || [];
            var done1 = !!data.step_4_reviewer1_done;
            var done2 = !!data.step_4_reviewer2_done;
            html += '<div class="stage-content"><div class="stage-timeline">';

            var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            var roleLower = (u.role || '').toLowerCase();
            var isAdmin = roleLower === 'admin';
            var reviewerIds = [];
            try { reviewerIds = JSON.parse(data.assignedReviewerIds || '[]'); } catch(e) {}
            var mySlot = reviewerIds[0] === u.id ? 1 : (reviewerIds[1] === u.id ? 2 : 0);
            [1, 2].forEach(function(slot){
                var done = slot === 1 ? done1 : done2;
                var file = reviewerFiles[slot];
                var rvName = reviewerNames[slot - 1] || ('Phản biện ' + slot);
                var title = (done ? '✅ ' : '⏳ ') + 'Phản biện ' + slot + (done ? ' hoàn thành' : ' chưa hoàn thành');
                var cls = done ? 'success' : '';
                var canAct = isAdmin || mySlot === slot;

                html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(title) + '</div><div class="event-time">—</div></div><div class="event-content"><strong>Người phản biện:</strong> ' + escapeHtml(rvName) + '<br><strong>Trạng thái file:</strong> ' + escapeHtml(file ? ('Đã upload: ' + (file.originalName || 'phiếu phản biện')) : 'Chưa upload file') + '</div></div>';

                html += '<div class="files-section"><div class="files-title">📎 File phản biện ' + slot + ':</div><div class="file-list">';
                if (file) {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(file.originalName || ('SCI-TASK-06_PB' + slot + '.pdf')) + '</div><div class="file-meta">' + (done ? 'Đã hoàn thành' : 'Chưa hoàn thành') + '</div></div></div><button class="btn-download-file" data-fid="' + (file.id || '') + '">📥 Tải về</button></div>';
                } else {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">SCI-TASK-06_PB' + slot + '_xxx.pdf</div><div class="file-meta">Chưa có file</div></div></div><button class="btn-download-file" disabled title="Chưa có file để tải">📥 Tải về</button></div>';
                }
                html += '</div></div>';

                if (canAct) {
                    var slotBtns = [{ label: '📤 Upload PB' + slot, action: 'upload-pb' + slot }];
                    if (file) {
                        slotBtns.push({ label: '✅ PB' + slot + ' hoàn thành', action: 'complete-pb' + slot });
                        slotBtns.push({ label: '🗑️ Xóa file PB' + slot, action: 'delete-pb' + slot, className: 'btn-secondary' });
                    }
                    html += actionButtons(4, slotBtns);
                }
            });

            var step4Btns = [];
            if (isAdmin) {
                step4Btns.push({ label: '📧 Gửi email Bước 4 (Admin)', action: 'gui-email', className: 'btn-secondary' });
                if (stepsDone >= 4) step4Btns.push({ label: '↩ Đưa về Bước 3 (Admin)', action: 'revert-to-3', className: 'btn-secondary' });
            }
            html += actionButtons(4, step4Btns) + templateHint(4) + '</div></div></div>';
        })();

        (function(){ var s=getStepState('4a',stepsDone); if (!step4And4aReallyDone && s === 'completed') s = 'active'; html+='<div class="stage-card '+stageClass(s)+'" data-step="4a"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 4A: Thẩm định dự toán</h3><div class="stage-subtitle"><span>💰 Tổ Thẩm định TC</span><span class="stage-duration">⏱️ 5-7 ngày • Thực tế: 7 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline">';
        var step4aHist = stepHistory['4a'] || [];
        var budget4aLabels = { budget_upload: '📋 Nộp phiếu thẩm định dự toán', budget_request_revision: '⚠️ Yêu cầu bổ sung/chỉnh sửa', researcher_upload_revised: '📤 Nghiên cứu viên nộp tài liệu chỉnh sửa', budget_approve: '✅ Phê duyệt dự toán' };
        var budget4aClasses = { budget_upload: 'success', budget_request_revision: 'warning', researcher_upload_revised: '', budget_approve: 'success' };
        if (step4aHist.length) {
            step4aHist.forEach(function(h) {
                var label = budget4aLabels[h.actionType] || h.actionType;
                var cls = budget4aClasses[h.actionType] || '';
                html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(label) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? '<p style="white-space:pre-wrap">' + escapeHtml(h.note) + '</p>' : '') + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
            });
        }
        var budget4aStatus = data.budget_4a_status || '';
        var budget4aRevisionNote = data.budget_4a_revision_note || '';
        var budget4aRevisionAt = data.budget_4a_revision_requested_at || '—';
        if (budget4aStatus === 'need_revision' && budget4aRevisionNote) {
            html += '<div class="timeline-event warning"><div class="event-header"><div class="event-title">⚠️ Yêu cầu bổ sung đang chờ NCV xử lý</div><div class="event-time">' + escapeHtml(budget4aRevisionAt) + '</div></div><div class="event-content"><p style="white-space:pre-wrap;background:#fff8e1;padding:10px;border-radius:8px">' + escapeHtml(budget4aRevisionNote) + '</p></div></div>';
        }
        if (budget4aStatus === 'approved') {
            html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Kết luận thẩm định: Đã phê duyệt</div><div class="event-time">' + escapeHtml(data.budget_4a_approved_at || '—') + '</div></div><div class="event-content">Dự toán đã được Tổ thẩm định phê duyệt.</div></div>';
        }
        (function(){
            var budgetFields = ['budget_phieu_tham_dinh','budget_to_trinh'];
            var budgetLabels = { budget_phieu_tham_dinh: 'SCI-BUDGET-01 Phiếu thẩm định', budget_to_trinh: 'SCI-BUDGET-02 Tờ trình' };
            var files = (data.files || []).filter(function(f){ return budgetFields.indexOf(f.fieldName) >= 0; });
            var fileMap = {}; files.forEach(function(f){ fileMap[f.fieldName] = f; });
            html += '<div class="files-section"><div class="files-title">📎 File thẩm định (' + (files.length || 2) + ' files):</div><div class="file-list">';
            budgetFields.forEach(function(field){
                var f = fileMap[field];
                if (f) {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(f.originalName) + '</div><div class="file-meta">Đã nộp</div></div></div><button class="btn-download-file" data-fid="' + f.id + '">📥 Tải về</button></div>';
                } else {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(budgetLabels[field] || field) + '</div><div class="file-meta">Chưa có file</div></div></div><button class="btn-download-file" disabled title="Chưa có file để tải">📥 Tải về</button></div>';
                }
            });
            html += '</div></div>';
        })();
        (function(){
            var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            var isBudgetTeam = (user.role || '').toLowerCase() === 'admin' || ['totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc'].indexOf((user.role || '').toLowerCase()) >= 0;
            var isOwner = (data.submittedById && user.id) && data.submittedById === user.id;
            var step4aBtns = [];
            if (isBudgetTeam) {
                step4aBtns.push({ label: '📋 Nộp phiếu thẩm định', action: 'nop-tham-dinh' });
                if (budget4aStatus !== 'approved') step4aBtns.push({ label: '⚠️ Yêu cầu bổ sung/chỉnh sửa', action: 'yeu-cau-bo-sung', className: 'btn-secondary' });
                if (budget4aStatus !== 'approved' && (data.files || []).some(function(f){ return f.fieldName === 'budget_phieu_tham_dinh' || f.fieldName === 'budget_to_trinh'; })) {
                    step4aBtns.push({ label: '✅ Phê duyệt dự toán', action: 'phe-duyet' });
                }
            }
            if (isOwner && budget4aStatus === 'need_revision') {
                step4aBtns.push({ label: '📤 Nộp tài liệu chỉnh sửa', action: 'nop-chinh-sua' });
            }
            var isAdmin = (user.role || '').toLowerCase() === 'admin';
            if (isAdmin) { step4aBtns.push({ label: '📧 Gửi email Bước 4A (Admin)', action: 'gui-email', className: 'btn-secondary' }); if (stepsDone >= 4) step4aBtns.push({ label: '↩ Đưa về Bước 3 (Admin)', action: 'revert-to-3', className: 'btn-secondary' }); }
            if (step4aBtns.length) html += actionButtons('4a', step4aBtns);
            html += templateHint('4a') + '</div></div></div>';
        })();

        html += '</div>'; // đóng parallel-stages — chỉ Bước 4 & 4A song song

        (function(){ var s=getStepState(5,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="5"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 5: Họp Hội đồng Khoa học Viện</h3><div class="stage-subtitle"><span>👥 HĐKHCN (9 thành viên)</span><span class="stage-duration">⏱️ Họp định kỳ</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">🏛️ Họp HĐKHCN</div><div class="event-time">—</div></div><div class="event-content"><strong>Địa điểm:</strong> Phòng họp Hội đồng<br><strong>Tham dự:</strong> 9/9 thành viên<br><strong>Tài liệu:</strong> Phiếu phản biện + Tờ trình TC<br><strong>Kết quả biểu quyết:</strong> —<br><strong>Quyết định:</strong> —</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Biên bản (1 file):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">SCI-TASK-07_Bien_ban_hop_HDKHCN.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        (function(){ var step5Btns = [{ label: '📋 Lập biên bản họp', action: 'lap-bien-ban' }]; var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}; if (u.role === 'admin' && stepsDone >= 5) step5Btns.push({ label: '↩ Đưa về Bước 4 (Admin)', action: 'revert-to-4', className: 'btn-secondary' }); html += actionButtons(5, step5Btns) + templateHint(5) + '</div></div>'; })();

        (function(){ var s=getStepState(6,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="6"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 6: Cấp Quyết định phê duyệt</h3><div class="stage-subtitle"><span>👤 Viện trưởng</span><span class="stage-duration">⏱️ 3-5 ngày • Thực tế: 4 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">✍️ Viện trưởng ký Quyết định</div><div class="event-time">—</div></div><div class="event-content"><strong>Số QĐ:</strong> —<br><strong>Kinh phí:</strong> —<br><strong>Thời gian:</strong> —<br><strong>Phí quản lý:</strong> —</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Quyết định (2 files):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-ACE-QD_VN_xx-2025.pdf</div><div class="file-meta">Tiếng Việt • —</div></div></div><button class="btn-download-file">📥 Tải về</button></div><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-ACE-QD_EN_xx-2025.pdf</div><div class="file-meta">English • —</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        (function(){ var step6Btns = [{ label: '✍️ Ký Quyết định phê duyệt', action: 'ky-quyet-dinh' }]; var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}; if (u.role === 'admin' && stepsDone >= 6) step6Btns.push({ label: '↩ Đưa về Bước 5 (Admin)', action: 'revert-to-5', className: 'btn-secondary' }); html += actionButtons(6, step6Btns) + '</div></div>'; })();

        // ===== GIAI ĐOẠN 2 =====
        html += '<div class="phase-header"><h3>📝 GIAI ĐOẠN 2: KÝ HỢP ĐỒNG VÀ TRIỂN KHAI (Dự kiến)</h3></div>';

        (function(){ var s=getStepState(7,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="7"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 7: Ký hợp đồng thực hiện</h3><div class="stage-subtitle"><span>✍️ Viện trưởng & Chủ nhiệm</span><span class="stage-duration">⏱️ 7-10 ngày • Thực tế: 12 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">📝 Soạn thảo hợp đồng</div><div class="event-time">—</div></div><div class="event-content">Phòng KHCN soạn thảo hợp đồng dựa trên Quyết định</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Chủ nhiệm kiểm tra</div><div class="event-time">—</div></div><div class="event-content">Chủ nhiệm xác nhận nội dung hợp đồng</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">✍️ Ký kết hợp đồng</div><div class="event-time">—</div></div><div class="event-content"><strong>Bên A:</strong> Viện Tế bào gốc (Viện trưởng ký)<br><strong>Bên B:</strong> ' + escapeHtml(chunhiem) + ' (Chủ nhiệm)<br><strong>Số HĐ:</strong> —<br><strong>Hiệu lực:</strong> 24 tháng</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Hợp đồng (1 file):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-CONTRACT-01_xx-2025.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        (function(){ var step7Btns = [{ label: '✅ Xác nhận đã ký hợp đồng', action: 'xac-nhan-ky' }]; var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}; if (u.role === 'admin' && stepsDone >= 7) step7Btns.push({ label: '↩ Đưa về Bước 6 (Admin)', action: 'revert-to-6', className: 'btn-secondary' }); html += actionButtons(7, step7Btns) + '</div></div>'; })();

        (function(){ var s=getStepState(8,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="8"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 8: Đăng ký đạo đức</h3><div class="stage-subtitle"><span>⚖️ Hội đồng Đạo đức</span><span class="stage-duration">⏱️ 14-21 ngày • Thực tế: 20 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">📝 Nộp hồ sơ đạo đức</div><div class="event-time">—</div></div><div class="event-content">Đăng ký thí nghiệm theo quy định</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Hội đồng xem xét</div><div class="event-time">—</div></div><div class="event-content">Họp Hội đồng Đạo đức Viện Tế bào gốc</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Cấp mã đạo đức</div><div class="event-time">—</div></div><div class="event-content"><strong>Mã đạo đức:</strong> —<br><strong>Hiệu lực:</strong> 24 tháng<br><strong>Quyết định:</strong> —</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Quyết định đạo đức (1 file):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-ETHICS-QD-2025-xxx.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        html += actionButtons(8, [{ label: '📝 Nộp hồ sơ đạo đức', action: 'nop-dao-duc' }]) + '</div></div>';

        (function(){ var s=getStepState('8a',stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="8a"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 8A: Tạm ứng kinh phí đợt 1</h3><div class="stage-subtitle"><span>💰 Phòng Tài chính</span><span class="stage-duration">⏱️ 7-10 ngày • Thực tế: 10 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">📝 Chủ nhiệm làm đơn</div><div class="event-time">—</div></div><div class="event-content">Đơn xin tạm ứng 40% kinh phí</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">✅ Phòng TC duyệt</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra hồ sơ, phê duyệt tạm ứng</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">💸 Chuyển tiền</div><div class="event-time">—</div></div><div class="event-content"><strong>Số tiền:</strong> —<br><strong>Tài khoản:</strong> ' + escapeHtml(chunhiem) + '<br><strong>Ngân hàng:</strong> —</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Chứng từ (2 files):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-FINANCE-01_Don_tam_ung_dot1.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">Phieu_chi_xxx.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        html += actionButtons('8a', [{ label: '📝 Nộp đơn tạm ứng', action: 'nop-don-tam-ung' }]) + '</div></div>';

        // ===== GIAI ĐOẠN 3 =====
        html += '<div class="phase-header"><h3>⚙️ GIAI ĐOẠN 3: THỰC HIỆN VÀ BÁO CÁO (24 tháng)</h3></div>';

        (function(){ var s=getStepState(9,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="9"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 9: Thực hiện đề tài</h3><div class="stage-subtitle"><span>👥 Nhóm nghiên cứu</span><span class="stage-duration">⏱️ 24 tháng</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="alert-box alert-info"><span style="font-size:20px">ℹ️</span><div><strong>Tiến độ hiện tại:</strong> —<br><strong>Hoạt động chính:</strong> —<br><strong>Kế hoạch tiếp theo:</strong> —</div></div>';
        html += '<div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">🛒 Mua sắm thiết bị</div><div class="event-time">—</div></div><div class="event-content">—</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">🧬 Tách chiết tế bào gốc</div><div class="event-time">—</div></div><div class="event-content">—</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔬 Thử nghiệm / Tuyển bệnh nhân</div><div class="event-time">—</div></div><div class="event-content">—</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Lab notebook & Dữ liệu:</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📊</span><div class="file-details"><div class="file-name">Lab_notebook.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        html += actionButtons(9, [{ label: '📊 Cập nhật tiến độ', action: 'cap-nhat-tien-do' }]) + '</div></div>';

        (function(){ var s=getStepState(10,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="10"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 10: Báo cáo tiến độ 6 tháng (lần 1)</h3><div class="stage-subtitle"><span>📊 Chủ nhiệm báo cáo</span><span class="stage-duration">⏱️ Định kỳ</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">📝 Nộp báo cáo tiến độ</div><div class="event-time">—</div></div><div class="event-content">—</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">🏛️ Họp báo cáo</div><div class="event-time">—</div></div><div class="event-content"><strong>Kết luận:</strong> —<br><strong>Phê duyệt:</strong> Tạm ứng đợt 2</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Báo cáo (2 files):</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">SCI-ACE-07_Bao_cao_6thang_lan1.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div><div class="file-item"><div class="file-info"><span class="file-icon">📊</span><div class="file-details"><div class="file-name">Bien_ban_hop_bao_cao.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        html += actionButtons(10, [{ label: '📄 Nộp báo cáo tiến độ', action: 'nop-bao-cao' }]) + templateHint(10) + '</div></div>';

        (function(){ var s=getStepState('10a',stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="10a"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 10A: Báo cáo tiến độ 6 tháng (lần 2)</h3><div class="stage-subtitle"><span>📊 Chủ nhiệm báo cáo</span><span class="stage-duration">⏱️ Dự kiến: 31/03/2026</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div style="padding:30px;text-align:center;color:#999"><div style="font-size:48px;margin-bottom:10px">📅</div><div style="font-size:14px">Báo cáo giữa kỳ lần 2 sẽ đến hạn vào <strong>31/03/2026</strong></div></div>';
        html += actionButtons('10a', [{ label: '📄 Nộp báo cáo', action: 'nop-bao-cao' }]) + templateHint('10a') + '</div></div>';

        (function(){ var s=getStepState(11,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="11"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 11: Điều chỉnh nội dung/nhân sự (nếu cần)</h3><div class="stage-subtitle"><span>📝 Chủ nhiệm đề xuất</span><span class="stage-duration">⏱️ Khi cần thiết</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div style="padding:30px;text-align:center;color:#999"><div style="font-size:48px;margin-bottom:10px">✏️</div><div style="font-size:14px">Bước này chỉ kích hoạt khi cần điều chỉnh:<br>• Thay đổi nhân sự chính<br>• Điều chỉnh kế hoạch nghiên cứu<br>• Thay đổi dự toán (±10%)<br>• Gia hạn thời gian</div></div>';
        html += actionButtons(11, [{ label: '✏️ Đề xuất điều chỉnh', action: 'de-xuat-dieu-chinh' }]) + templateHint(11) + '</div></div>';

        // ===== GIAI ĐOẠN 4 =====
        html += '<div class="phase-header"><h3>🎯 GIAI ĐOẠN 4: NGHIỆM THU (Dự kiến: 04-06/2027)</h3></div>';

        (function(){ var s=getStepState(12,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="12"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 12: Nộp hồ sơ nghiệm thu</h3><div class="stage-subtitle"><span>👤 Chủ nhiệm</span><span class="stage-duration">⏱️ Dự kiến: 01/04/2027</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="alert-box alert-info"><span style="font-size:20px">📋</span><div><strong>Hồ sơ nghiệm thu:</strong> Báo cáo tổng kết, Báo cáo tài chính, Sản phẩm (bài báo ISI/Scopus), Tóm tắt tiếng Anh.</div></div>';
        html += actionButtons(12, [{ label: '📄 Nộp hồ sơ nghiệm thu', action: 'nop-nghiem-thu' }]) + templateHint(12) + '</div></div>';

        (function(){ var s=getStepState(13,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="13"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 13-14: Phản biện nghiệm thu</h3><div class="stage-subtitle"><span>👥 2 Phản biện</span><span class="stage-duration">⏱️ 10-14 ngày</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><p style="padding:15px;color:var(--gray)">Phản biện đọc hồ sơ và nộp phiếu đánh giá nghiệm thu.</p>';
        html += actionButtons(13, [{ label: '📋 Nộp phiếu phản biện', action: 'nop-phieu-pb' }]) + templateHint(13) + '</div></div>';

        (function(){ var s=getStepState(15,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="15"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 15: Họp Hội đồng nghiệm thu</h3><div class="stage-subtitle"><span>👥 HĐNT (≥7 thành viên)</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><p style="padding:15px;color:var(--gray)">Họp Hội đồng nghiệm thu xem xét và biểu quyết.</p>';
        html += actionButtons(15, [{ label: '📋 Lập biên bản họp nghiệm thu', action: 'lap-bien-ban' }]) + templateHint(15) + '</div></div>';

        (function(){ var s=getStepState(16,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="16"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 16: Quyết định nghiệm thu</h3><div class="stage-subtitle"><span>👤 Viện trưởng</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><p style="padding:15px;color:var(--gray)">Viện trưởng ký Quyết định công nhận nghiệm thu.</p>';
        html += actionButtons(16, [{ label: '✍️ Ký Quyết định nghiệm thu', action: 'ky-quyet-dinh' }]) + '</div></div>';

        (function(){ var s=getStepState(17,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="17"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 17: Bàn giao sản phẩm & Lưu trữ</h3><div class="stage-subtitle"><span>👤 Chủ nhiệm</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><p style="padding:15px;color:var(--gray)">Chủ nhiệm bàn giao sản phẩm và lưu trữ hồ sơ.</p>';
        html += actionButtons(17, [{ label: '📦 Xác nhận bàn giao', action: 'ban-giao' }]) + '</div></div>';

        (function(){ var s=getStepState(18,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="18"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 18: Thanh lý hợp đồng</h3><div class="stage-subtitle"><span>✍️ Viện trưởng & Chủ nhiệm</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><p style="padding:15px;color:var(--gray)">Thanh lý hợp đồng và kết thúc đề tài.</p>';
        html += actionButtons(18, [{ label: '✅ Xác nhận thanh lý', action: 'thanh-ly' }]) + templateHint(18) + '</div></div>';

        html += '</div>';
        html += '<div style="margin-top:2rem;padding:1.5rem;background:rgba(26,77,46,0.06);border-radius:12px"><a href="#" id="btn-download-zip" class="btn-export" style="text-decoration:none;display:inline-block">📥 Tải toàn bộ hồ sơ (ZIP)</a></div>';
        return html;
    }

    function exportPDF() { alert('Xuất PDF — Tính năng đang phát triển'); }
    function exportExcel() { alert('Xuất Excel — Tính năng đang phát triển'); }
    window.exportPDF = exportPDF;
    window.exportExcel = exportExcel;

    if (!id) {
        contentEl.innerHTML = '<div class="empty-state">Thiếu ID hồ sơ. <a href="theo-doi-de-tai-cap-vien.html">Quay lại danh sách</a>.</div>';
        return;
    }
    breadcrumbId.textContent = '#' + id;

    if (!token) {
        contentEl.innerHTML = '<div class="empty-state">Vui lòng <a href="dang-nhap.html">đăng nhập</a> để xem tiến trình hồ sơ.</div>';
        return;
    }

    fetch(apiBase + '/api/cap-vien/submissions/' + id, { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(res) {
            if (res.status === 401) { contentEl.innerHTML = '<div class="empty-state">Phiên đăng nhập hết hạn. <a href="dang-nhap.html">Đăng nhập lại</a>.</div>'; return null; }
            if (res.status === 403) { contentEl.innerHTML = '<div class="empty-state">Bạn không có quyền xem hồ sơ này.</div>'; return null; }
            if (res.status === 404) { contentEl.innerHTML = '<div class="empty-state">Không tìm thấy hồ sơ. <a href="theo-doi-de-tai-cap-vien.html">Quay lại danh sách</a>.</div>'; return null; }
            return res.json();
        })
        .then(function(data) {
            if (!data) return;
            data.id = id;
            contentEl.innerHTML = buildFullTimeline(data);

            contentEl.querySelectorAll('.btn-edit-code').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var sid = this.getAttribute('data-id');
                    if (!sid || !token) return;
                    var current = (data.code || ('DTSCI-2025-' + String(data.id).padStart(3, '0')));
                    var newCode = prompt('Sửa mã đề tài (chỉ Admin). Mã hiện tại: ' + current, current);
                    if (newCode == null || newCode.trim() === '') return;
                    newCode = newCode.trim();
                    fetch(apiBase + '/api/admin/cap-vien/submissions/' + sid + '/code', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ code: newCode })
                    }).then(function(r) {
                        return r.json().then(function(d) { return { ok: r.ok, data: d }; }).catch(function() { return { ok: false, data: {} }; });
                    }).then(function(res) {
                        if (res.ok) {
                            data.code = newCode;
                            var codeDiv = contentEl.querySelector('.task-code');
                            if (codeDiv) {
                                var first = codeDiv.firstChild;
                                if (first && first.nodeType === 3) first.textContent = 'Mã đề tài: ' + newCode;
                                else if (codeDiv.childNodes.length) codeDiv.insertBefore(document.createTextNode('Mã đề tài: ' + newCode), codeDiv.firstChild);
                            }
                            var strongCode = contentEl.querySelector('.stage-content .event-content strong');
                            if (strongCode && strongCode.textContent && strongCode.textContent.indexOf('DTSCI') >= 0) strongCode.textContent = newCode;
                        } else alert(res.data.message || 'Không cập nhật được mã.');
                    }).catch(function() { alert('Lỗi kết nối.'); });
                });
            });

            document.getElementById('btn-download-zip').addEventListener('click', function(e) {
                e.preventDefault();
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

            contentEl.querySelectorAll('.btn-download-file').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var fid = this.getAttribute('data-fid');
                    if (!fid) { alert('Tải qua nút "Tải toàn bộ hồ sơ (ZIP)" bên dưới.'); return; }
                    var suggestedName = (this.closest('.file-item') && this.closest('.file-item').querySelector('.file-name')) ? this.closest('.file-item').querySelector('.file-name').textContent.trim() : 'file';
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/files/' + fid + '/download', { headers: { 'Authorization': 'Bearer ' + token } })
                        .then(function(r) { if (!r.ok) throw new Error(); return r.blob(); })
                        .then(function(blob) {
                            var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = suggestedName || 'file'; a.click(); URL.revokeObjectURL(a.href);
                        })
                        .catch(function() { alert('Không tải được file.'); });
                });
            });

            contentEl.querySelectorAll('.btn-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var step = this.getAttribute('data-step');
                    var action = this.getAttribute('data-action');
                    execAction(step, action);
                });
            });

            var btnAddSupplement = document.getElementById('btn-add-supplement-step2');
            var btnSubmitSupplement = document.getElementById('btn-submit-supplement-step2');
            if (btnAddSupplement) {
                btnAddSupplement.addEventListener('click', function() {
                    var container = document.getElementById('step2-supplement-inputs');
                    var first = container && container.querySelector('.supplement-row');
                    if (first) {
                        var clone = first.cloneNode(true);
                        if (clone.querySelector('input')) clone.querySelector('input').value = '';
                        container.appendChild(clone);
                    }
                });
            }
            if (btnSubmitSupplement) {
                btnSubmitSupplement.addEventListener('click', function() {
                    var msgEl = document.getElementById('step2-supplement-msg');
                    btnSubmitSupplement.disabled = true;
                    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
                    var formData = new FormData();
                    var inputs = contentEl.querySelectorAll('.step2-supplement-form input[name="supplement"]');
                    inputs.forEach(function(inp) { if (inp.files && inp.files[0]) formData.append('supplement', inp.files[0]); });
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/supplement', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + token },
                        body: formData
                    }).then(function(r) {
                        return r.text().then(function(t) {
                            try { var d = t ? JSON.parse(t) : {}; return { ok: r.ok, data: d }; } catch(e) { return { ok: false, data: { message: t || 'Lỗi máy chủ' } }; }
                        });
                    }).then(function(res) {
                        if (res.ok) {
                            if (msgEl) {
                                msgEl.textContent = res.data.message || 'Đã ghi nhận hồ sơ bổ sung.';
                                msgEl.style.display = 'block';
                                msgEl.style.background = '#d4edda';
                                msgEl.style.color = '#155724';
                            }
                            setTimeout(function() { location.reload(); }, 1500);
                        } else {
                            if (msgEl) {
                                msgEl.textContent = res.data.message || 'Gửi thất bại.';
                                msgEl.style.display = 'block';
                                msgEl.style.background = '#f8d7da';
                                msgEl.style.color = '#721c24';
                            }
                            btnSubmitSupplement.disabled = false;
                        }
                    }).catch(function(err) {
                        if (msgEl) {
                            msgEl.textContent = 'Không kết nối được máy chủ. Kiểm tra backend và thử lại.';
                            msgEl.style.display = 'block';
                            msgEl.style.background = '#f8d7da';
                            msgEl.style.color = '#721c24';
                        }
                        btnSubmitSupplement.disabled = false;
                    });
                });
            }
            var btnResubmit = document.getElementById('btn-resubmit-step2');
            if (btnResubmit) {
                btnResubmit.addEventListener('click', function() {
                    var msgEl = document.getElementById('step2-supplement-msg');
                    btnResubmit.disabled = true;
                    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/resubmit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({})
                    }).then(function(r) {
                        return r.json().then(function(d) { return { ok: r.ok, data: d }; });
                    }).then(function(res) {
                        if (res.ok) {
                            if (msgEl) {
                                msgEl.textContent = res.data.message || 'Đã ghi nhận nộp lại hồ sơ.';
                                msgEl.style.display = 'block';
                                msgEl.style.background = '#d4edda';
                                msgEl.style.color = '#155724';
                            }
                            setTimeout(function() { location.reload(); }, 1500);
                        } else {
                            if (msgEl) {
                                msgEl.textContent = res.data.message || 'Nộp lại thất bại.';
                                msgEl.style.display = 'block';
                                msgEl.style.background = '#f8d7da';
                                msgEl.style.color = '#721c24';
                            }
                            btnResubmit.disabled = false;
                        }
                    }).catch(function() {
                        if (msgEl) {
                            msgEl.textContent = 'Không kết nối được máy chủ.';
                            msgEl.style.display = 'block';
                            msgEl.style.background = '#f8d7da';
                            msgEl.style.color = '#721c24';
                        }
                        btnResubmit.disabled = false;
                    });
                });
            }

            var activeCards = contentEl.querySelectorAll('.stage-card.active');
            activeCards.forEach(function(c) { c.classList.add('expanded'); });
        })
        .catch(function() {
            contentEl.innerHTML = '<div class="empty-state">Không thể tải thông tin. Vui lòng chạy backend và <a href="theo-doi-de-tai-cap-vien.html">thử lại</a>.</div>';
        });

    window.addEventListener('scroll', function() {
        var btn = document.getElementById('scrollToTop');
        if (btn) btn.classList.toggle('visible', window.pageYOffset > 300);
    });
})();
