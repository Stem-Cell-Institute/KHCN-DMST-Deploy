/**
 * Timeline Đề tài cấp Viện - 17 bước (Bước 10 gộp các kỳ BC định kỳ) + Nút hành động
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
    var stickyProgressEl = null;
    var stickyTriggerY = 260;

    function escapeHtml(s) {
        if (!s) return '';
        var div = document.createElement('div');
        div.textContent = String(s);
        return div.innerHTML;
    }

    /** Sau reload, cuộn lại đúng thẻ bước (data-step) — tránh nhảy lên đầu trang sau upload */
    var TIMELINE_SCROLL_STEP_KEY = 'capVienTimelineScrollStep';
    function rememberTimelineScrollStep(stepKey) {
        try {
            if (stepKey == null || stepKey === '') return;
            var sk = String(stepKey);
            if (!/^[\d.a-zA-Z_-]+$/.test(sk)) return;
            sessionStorage.setItem(TIMELINE_SCROLL_STEP_KEY, JSON.stringify({ submissionId: id, step: sk }));
        } catch (e) {}
    }
    function reloadKeepingTimelineStep(stepKey) {
        rememberTimelineScrollStep(stepKey);
        location.reload();
    }
    function applyStoredTimelineScrollStep() {
        if (!contentEl) return;
        try {
            var raw = sessionStorage.getItem(TIMELINE_SCROLL_STEP_KEY);
            if (!raw) return;
            sessionStorage.removeItem(TIMELINE_SCROLL_STEP_KEY);
            var o = JSON.parse(raw);
            if (!o || Number(o.submissionId) !== Number(id)) return;
            var step = String(o.step || '');
            if (!/^[\d.a-zA-Z_-]+$/.test(step)) return;
            var card = contentEl.querySelector('.stage-card[data-step="' + step + '"]');
            if (!card) return;
            setStageExpanded(card, true, false);
            var navOffset = 80;
            function scrollToCard() {
                var r = card.getBoundingClientRect();
                var y = window.pageYOffset + r.top - navOffset;
                window.scrollTo(0, Math.max(0, y));
            }
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    scrollToCard();
                    setTimeout(function() {
                        scrollToCard();
                        refreshStickyTrigger();
                    }, 120);
                });
            });
        } catch (e) {}
    }

    function timelineField(val) {
        if (val == null) return '—';
        var t = String(val).trim();
        return t ? escapeHtml(t) : '—';
    }

    function setStageExpanded(card, expand, animate) {
        if (!card) return;
        var content = card.querySelector('.stage-content');
        if (!content) return;
        if (expand) {
            card.classList.add('expanded');
            content.style.display = 'block';
            if (!animate) {
                content.style.maxHeight = 'none';
                content.style.opacity = '1';
                return;
            }
            content.style.maxHeight = '0px';
            content.style.opacity = '0';
            requestAnimationFrame(function() {
                content.style.maxHeight = content.scrollHeight + 'px';
                content.style.opacity = '1';
            });
            content.addEventListener('transitionend', function onExpandEnd(e) {
                if (e.propertyName !== 'max-height') return;
                content.style.maxHeight = 'none';
                content.removeEventListener('transitionend', onExpandEnd);
            });
        } else {
            if (!card.classList.contains('expanded')) return;
            if (!animate) {
                card.classList.remove('expanded');
                content.style.maxHeight = '0px';
                content.style.opacity = '0';
                content.style.display = 'none';
                return;
            }
            content.style.maxHeight = content.scrollHeight + 'px';
            requestAnimationFrame(function() {
                content.style.maxHeight = '0px';
                content.style.opacity = '0';
            });
            content.addEventListener('transitionend', function onCollapseEnd(e) {
                if (e.propertyName !== 'max-height') return;
                card.classList.remove('expanded');
                content.style.display = 'none';
                content.removeEventListener('transitionend', onCollapseEnd);
            });
        }
    }
    function toggleStage(el) {
        var card = el.closest('.stage-card');
        if (!card) return;
        var isExpanded = card.classList.contains('expanded');
        setStageExpanded(card, !isExpanded, true);
    }
    window.toggleStage = toggleStage;
    function refreshStickyTrigger() {
        var overview = contentEl ? contentEl.querySelector('.progress-overview') : null;
        if (!overview) return;
        stickyTriggerY = Math.max(220, overview.offsetTop + overview.offsetHeight - 20);
    }
    /** Thứ tự khối timeline — Bước 10 chứa toàn bộ các kỳ báo cáo định kỳ (không còn 10A) */
    function timelineSeq() {
        return [1, 2, 3, [4, '4a'], 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18];
    }
    function timelineTotalBlocks() {
        return timelineSeq().length;
    }
    function callPeriodicReportAdmin(action, payload) {
        return fetch(apiBase + '/api/cap-vien/submissions/' + id + '/periodic-report/admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ action: action, payload: payload || {} })
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        });
    }
    function showPeriodicReportUploadDialog() {
        if (!submissionData || !id || !token) return;
        var pr = submissionData.periodicReport || {};
        var periods = (pr.periods || []).filter(function(p) {
            var sl = String(p.status || '').toLowerCase();
            return sl !== 'waived' && sl !== 'bypassed';
        });
        if (!periods.length) {
            alert('Chưa có kỳ báo cáo. Nhờ Admin cấu hình chu kỳ và tạo danh sách kỳ (set_cycle → apply_recalc).');
            return;
        }
        var lines = periods.map(function(p, i) {
            return (i + 1) + ') periodId=' + p.id + ' — ' + escapeHtml(p.label || ('Kỳ ' + p.seq)) + ' — ' + escapeHtml(String(p.status || '')) + ' — hạn: ' + escapeHtml(p.dueAt ? fmtDateTime(p.dueAt) : '—');
        }).join('\n');
        var pidStr = prompt('Nhập periodId (số) để nộp / thay file báo cáo:\n\n' + lines);
        if (pidStr == null || !String(pidStr).trim()) return;
        var periodId = parseInt(String(pidStr).trim(), 10);
        if (!Number.isFinite(periodId) || periodId <= 0) { alert('periodId không hợp lệ.'); return; }
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.pdf,.doc,.docx,application/pdf';
        inp.onchange = function() {
            var file = inp.files && inp.files[0];
            if (!file) return;
            var fd = new FormData();
            fd.append('periodic_report_file', file);
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/periodic-report/period/' + periodId + '/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: fd
            }).then(function(r) {
                return r.json().then(function(d) { return { ok: r.ok, data: d }; });
            }).then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã lưu file báo cáo.');
                    reloadKeepingTimelineStep('10');
                } else {
                    alert(res.data.message || 'Upload thất bại.');
                }
            }).catch(function() { alert('Không kết nối được máy chủ.'); });
        };
        inp.click();
    }
    function execPeriodicAdminAction(action) {
        var a = String(action || '').toLowerCase().trim();
        function done(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã xử lý.');
                reloadKeepingTimelineStep('10');
            } else {
                alert(res.data.message || 'Thất bại.');
            }
        }
        if (a === 'set_cycle') {
            var cm = prompt('Chu kỳ (tháng), ví dụ 6:', '6');
            if (cm == null) return;
            var at = prompt('anchorType: post_step7 | contract_start | custom_date', 'post_step7');
            if (at == null) return;
            var aa = at === 'custom_date' ? prompt('anchorAt (ISO), ví dụ 2026-01-15T00:00:00.000Z') : '';
            if (at === 'custom_date' && (aa == null || !String(aa).trim())) return;
            var off = prompt('dueOffsetDays (số ngày lệch deadline, có thể 0):', '0');
            if (off == null) return;
            callPeriodicReportAdmin('set_cycle', {
                cycleMonths: parseInt(cm, 10) || 6,
                anchorType: String(at).trim(),
                anchorAt: at === 'custom_date' ? String(aa).trim() : null,
                dueOffsetDays: parseInt(off, 10) || 0
            }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'preview_schedule') {
            var pc = prompt('periodCount (số kỳ preview):', '6');
            if (pc == null) return;
            callPeriodicReportAdmin('preview_schedule', { periodCount: parseInt(pc, 10) || 6 }).then(function(res) {
                if (!res.ok) { alert(res.data.message || 'Thất bại.'); return; }
                alert(JSON.stringify(res.data.preview || res.data, null, 2));
            }).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'apply_recalc') {
            var wipe = confirm('Tính lại toàn bộ kỳ? Nếu đã có kỳ đã nộp file, chọn OK chỉ khi bạn đã dùng forceWipe (sẽ hỏi tiếp).');
            if (!wipe) return;
            var fw = confirm('forceWipe: XÓA toàn bộ kỳ hiện có và tạo lại? (Nguy hiểm nếu đã có file đính kèm)');
            var pc2 = prompt('periodCount:', '6');
            if (pc2 == null) return;
            callPeriodicReportAdmin('apply_recalc', { forceWipe: fw, periodCount: parseInt(pc2, 10) || 6 }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'insert_period') {
            var due = prompt('dueAt (ISO):');
            if (due == null || !String(due).trim()) return;
            var lab = prompt('label (tùy chọn):', '');
            var ps = prompt('periodStart (ISO, Enter = giống dueAt):', '');
            callPeriodicReportAdmin('insert_period', {
                dueAt: String(due).trim(),
                label: lab ? String(lab).trim() : null,
                periodStart: ps && String(ps).trim() ? String(ps).trim() : undefined
            }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'delete_period') {
            var delId = prompt('periodId cần xóa (soft, chỉ kỳ chưa có file):');
            if (delId == null || !String(delId).trim()) return;
            callPeriodicReportAdmin('delete_period', { periodId: parseInt(delId, 10) }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'waive_period') {
            var wId = prompt('periodId:');
            var wNote = prompt('note (bắt buộc):');
            if (!wId || wNote == null || !String(wNote).trim()) return;
            callPeriodicReportAdmin('waive_period', { periodId: parseInt(wId, 10), note: String(wNote).trim() }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'bypass_submit') {
            var bId = prompt('periodId:');
            var bNote = prompt('note (bắt buộc):');
            if (!bId || bNote == null || !String(bNote).trim()) return;
            callPeriodicReportAdmin('bypass_submit', { periodId: parseInt(bId, 10), note: String(bNote).trim() }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'detach_file') {
            var dId = prompt('periodId cần gỡ file:');
            if (dId == null || !String(dId).trim()) return;
            callPeriodicReportAdmin('detach_file', { periodId: parseInt(dId, 10) }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'move_file') {
            var from = prompt('fromPeriodId:');
            var to = prompt('toPeriodId:');
            if (!from || !to) return;
            callPeriodicReportAdmin('move_file', { fromPeriodId: parseInt(from, 10), toPeriodId: parseInt(to, 10) }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'freeze_deadlines') {
            var u = prompt('pausedUntil (ISO hoặc để trống):', '');
            var rs = prompt('pauseReason:', 'freeze');
            callPeriodicReportAdmin('freeze_deadlines', { pausedUntil: u ? String(u).trim() : null, pauseReason: rs ? String(rs).trim() : 'freeze' }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'unfreeze_deadlines') {
            callPeriodicReportAdmin('unfreeze_deadlines', {}).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        if (a === 'resend_reminder') {
            var rp = prompt('periodId (để trống = chung):', '');
            var n = prompt('note ghi log:', '');
            callPeriodicReportAdmin('resend_reminder', {
                periodId: rp && String(rp).trim() ? parseInt(rp, 10) : null,
                note: n != null ? String(n) : null
            }).then(done).catch(function() { alert('Lỗi mạng.'); });
            return;
        }
        alert('Hành động admin định kỳ không rõ: ' + action);
    }
    function updateFloatingUI() {
        var btn = document.getElementById('scrollToTop');
        if (btn) btn.classList.toggle('visible', window.pageYOffset > 300);
        if (stickyProgressEl) stickyProgressEl.classList.toggle('visible', window.pageYOffset > stickyTriggerY);
    }

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
            '2-dev-reset-2': function() { if (confirm('Reset dữ liệu Bước 2 về trạng thái ban đầu (dev only)?')) callDevResetStep('2'); },
            '3-dev-reset-3': function() { if (confirm('Reset dữ liệu Bước 3 về trạng thái ban đầu (dev only)?')) callDevResetStep('3'); },
            '4-dev-reset-4': function() { if (confirm('Reset dữ liệu Bước 4 về trạng thái ban đầu (dev only)?')) callDevResetStep('4'); },
            '4a-dev-reset-4a': function() { if (confirm('Reset dữ liệu Bước 4A về trạng thái ban đầu (dev only)?')) callDevResetStep('4a'); },
            '5-dev-reset-5': function() { if (confirm('Reset dữ liệu Bước 5 (họp HĐ, biên bản, lịch sử bước 5) — dev only?')) callDevResetStep('5'); },
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
            '5-cap-nhat-hop-hd': function() { showHdMeetingEditDialog(); },
            '5-lap-bien-ban': function() { showStep5BienBanUploadDialog(); },
            '5-council-pass-hd': function() { callStep5CouncilPass(); },
            '5-council-request-revision': function() { showStep5CouncilRequestRevisionDialog(); },
            '5-council-revision-upload': function() { showStep5CouncilRevisionUploadDialog(); },
            '5-chair-approve-revision': function() { callStep5ChairRevisionDecision('approve'); },
            '5-chair-request-more': function() { showStep5ChairRequestMoreDialog(); },
            '6-hoan-thanh': function() {
                if (!confirm('Xác nhận Hoàn thành Bước 6?\n\nĐiều kiện: đã lưu Số quyết định và đã upload đủ bản scan (tiếng Việt + tiếng Anh) vào hồ sơ.\n\nSau khi xác nhận, hồ sơ chuyển sang Bước 7 (Ký hợp đồng); hệ thống gửi thông báo hành chính tới Chủ nhiệm (CC các thành viên Hội đồng KHCN nhận thông báo).')) return;
                callStepAPI(6, 'approve', {});
            },
            '7-hoan-thanh': function() {
                var msg = 'Xác nhận hoàn thành Bước 7 (Ký hợp đồng)?\n\nĐiều kiện: đã upload Hợp đồng KHCN vào hồ sơ.\n\nHồ sơ sẽ chuyển sang bước tiếp (Bước 8 — Đăng ký đạo đức). Email thông báo tới Chủ nhiệm và các bên nhận thông báo trong Quản trị chỉ gửi khi Admin bật tùy chọn «Gửi email khi hoàn thành Bước 7».';
                if (!confirm(msg)) return;
                callStepAPI(7, 'complete', {});
            },
            '8-nop-dao-duc': function() { window.location.href = 'nop-de-tai-cap-vien.html?dao_duc=' + id; },
            '8-hoan-thanh': function() {
                if (!confirm('Hoàn thành Bước 8 (Đăng ký đạo đức / Cấp mã)?\n\nĐiều kiện: đã lưu Mã đạo đức và đã upload Quyết định đạo đức vào hồ sơ.')) return;
                callStepAPI(8, 'complete', {});
            },
            '8-admin-bypass': function() {
                if (!confirm('Bypass Bước 8?\n\nĐánh dấu hoàn thành mà không yêu cầu đủ Mã đạo đức + file Quyết định. Chỉ Admin.')) return;
                callStepAPI(8, 'admin_bypass', {});
            },
            '8-admin-waive': function() {
                if (!confirm('Bất hoạt Bước 8?\n\nĐề tài này sẽ không cần thực hiện đăng ký đạo đức (không áp dụng bước). Chỉ Admin.')) return;
                callStepAPI(8, 'admin_waive', {});
            },
            '9-cap-nhat-tien-do': function() { var pct = prompt('Tiến độ % (0-100):'); var note = prompt('Ghi chú:'); if (pct != null) callStepAPI(9, 'update_progress', { percent: pct, note: note }); },
            '10-nop-bao-cao': function() { showPeriodicReportUploadDialog(); },
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
                alert(res.data.message || 'Đã cập nhật thành công.');
                reloadKeepingTimelineStep(step);
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
                    reloadKeepingTimelineStep('4a');
                } else {
                    alert(res.data.message || 'Thất bại.');
                }
            })
            .catch(function() {
                alert('Không kết nối được máy chủ.');
            });
    }

    function callUpdateStep5HdMeeting(payload) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/hd-meeting', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(payload || {})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã lưu.');
                reloadKeepingTimelineStep('5');
            } else {
                alert(res.data.message || 'Không lưu được.');
            }
        }).catch(function() {
            alert('Không kết nối được máy chủ.');
        });
    }

    function showHdMeetingEditDialog() {
        var d = submissionData || {};
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:560px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow:auto;';
        var v = function(field) {
            var raw = d[field];
            return raw != null ? String(raw) : '';
        };
        box.innerHTML = '<h3 style="margin:0 0 12px 0;font-size:1.15rem;color:#333">🏛️ Cập nhật thông tin họp HĐ KHCN</h3>' +
            '<p style="margin:0 0 14px 0;font-size:0.88rem;color:#666">Chỉ Thư ký HĐKHCN hoặc Admin. Các trường để trống sẽ hiển thị là «—» trên tiến trình.</p>' +
            '<div class="form-group" style="margin-bottom:10px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Thời gian / diễn biến (hiển thị cạnh tiêu đề)</label>' +
            '<input type="text" id="hd-meet-event-time" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box" placeholder="VD: 09:00 15/04/2026"></div>' +
            '<div class="form-group" style="margin-bottom:10px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Địa điểm</label>' +
            '<input type="text" id="hd-meet-location" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box" placeholder="VD: Phòng họp Hội đồng"></div>' +
            '<div class="form-group" style="margin-bottom:10px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Tham dự</label>' +
            '<input type="text" id="hd-meet-attendance" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box" placeholder="VD: 9/9 thành viên"></div>' +
            '<div class="form-group" style="margin-bottom:10px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Tài liệu</label>' +
            '<input type="text" id="hd-meet-documents" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box" placeholder="VD: Phiếu phản biện + Tờ trình TC"></div>' +
            '<div class="form-group" style="margin-bottom:10px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Kết quả biểu quyết</label>' +
            '<textarea id="hd-meet-vote" rows="2" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box;font-family:inherit" placeholder="VD: 9/9 phiếu Đồng ý"></textarea></div>' +
            '<div class="form-group" style="margin-bottom:16px"><label style="display:block;font-weight:600;margin-bottom:4px;font-size:0.9rem">Quyết định</label>' +
            '<textarea id="hd-meet-decision" rows="3" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box;font-family:inherit" placeholder="Nội dung quyết định của Hội đồng"></textarea></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">' +
            '<button type="button" id="hd-meet-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="hd-meet-save" style="padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Lưu thông tin</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.getElementById('hd-meet-event-time').value = v('step5_hd_meeting_event_time');
        document.getElementById('hd-meet-location').value = v('step5_hd_meeting_location');
        document.getElementById('hd-meet-attendance').value = v('step5_hd_meeting_attendance');
        document.getElementById('hd-meet-documents').value = v('step5_hd_meeting_documents');
        document.getElementById('hd-meet-vote').value = v('step5_hd_meeting_vote_result');
        document.getElementById('hd-meet-decision').value = v('step5_hd_meeting_decision');
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('hd-meet-cancel').onclick = close;
        document.getElementById('hd-meet-save').onclick = function() {
            callUpdateStep5HdMeeting({
                eventTime: (document.getElementById('hd-meet-event-time').value || '').trim(),
                location: (document.getElementById('hd-meet-location').value || '').trim(),
                attendance: (document.getElementById('hd-meet-attendance').value || '').trim(),
                documents: (document.getElementById('hd-meet-documents').value || '').trim(),
                voteResult: (document.getElementById('hd-meet-vote').value || '').trim(),
                decision: (document.getElementById('hd-meet-decision').value || '').trim()
            });
            close();
        };
    }

    function showStep5BienBanUploadDialog() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto';
        box.innerHTML = '<h3 style="margin:0 0 12px;font-size:1.1rem;color:#333">📤 Upload Biên bản họp Hội đồng</h3>' +
            '<p style="margin:0 0 8px;font-size:0.88rem;color:#666"><strong>Biên bản họp chính</strong> (PDF/Word): nếu chọn file mới, file đã lưu trước đó sẽ được thay thế. Có thể bỏ trống nếu chỉ nộp tài liệu kèm.</p>' +
            '<input type="file" id="step5-bien-ban-file" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box">' +
            '<p style="margin:14px 0 8px;font-size:0.88rem;color:#666"><strong>Tài liệu kèm</strong> (nhận xét Ủy viên HĐ, phiếu, v.v.): thêm nhiều file; các file đã lưu <em>không</em> bị xóa khi upload thêm.</p>' +
            '<div id="step5-extra-files-wrap" style="display:flex;flex-direction:column;gap:8px"></div>' +
            '<button type="button" id="step5-add-extra-file" style="margin-top:8px;padding:8px 14px;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;cursor:pointer;font-size:0.9rem">+ Thêm file</button>' +
            '<div id="step5-bien-ban-msg" style="display:none;margin-top:10px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" id="step5-bien-ban-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="step5-bien-ban-submit" style="padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Tải lên</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var extraWrap = document.getElementById('step5-extra-files-wrap');
        var addExtra = function() {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px';
            var inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = '.pdf,.doc,.docx';
            inp.style.cssText = 'flex:1;min-width:0;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box';
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.textContent = '✕';
            rm.title = 'Xóa dòng';
            rm.style.cssText = 'padding:6px 10px;background:#fee2e2;border:1px solid #fecaca;border-radius:8px;cursor:pointer;flex-shrink:0';
            rm.onclick = function() { row.remove(); };
            row.appendChild(inp);
            row.appendChild(rm);
            extraWrap.appendChild(row);
        };
        document.getElementById('step5-add-extra-file').onclick = function() { addExtra(); };
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('step5-bien-ban-cancel').onclick = close;
        document.getElementById('step5-bien-ban-submit').onclick = function() {
            var mainInp = document.getElementById('step5-bien-ban-file');
            var msgEl = document.getElementById('step5-bien-ban-msg');
            var mainFile = mainInp && mainInp.files && mainInp.files[0] ? mainInp.files[0] : null;
            var extraFiles = [];
            if (extraWrap) {
                extraWrap.querySelectorAll('input[type="file"]').forEach(function(el) {
                    if (el.files && el.files[0]) extraFiles.push(el.files[0]);
                });
            }
            if (!mainFile && !extraFiles.length) {
                alert('Vui lòng chọn ít nhất một file: biên bản chính hoặc tài liệu kèm.');
                return;
            }
            var btn = document.getElementById('step5-bien-ban-submit');
            btn.disabled = true;
            if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
            var showErr = function(t) {
                alert(t);
                if (msgEl) {
                    msgEl.textContent = t;
                    msgEl.style.display = 'block';
                    msgEl.style.background = '#f8d7da';
                    msgEl.style.color = '#721c24';
                }
                btn.disabled = false;
            };
            var doExtras = function() {
                if (!extraFiles.length) {
                    return Promise.resolve({ ok: true, data: {} });
                }
                var fd = new FormData();
                extraFiles.forEach(function(f) { fd.append('step5_extra_files', f); });
                return fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/upload-step5-extras', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: fd
                }).then(function(r) {
                    return r.json().then(function(d) { return { ok: r.ok, data: d }; }).catch(function() { return { ok: false, data: { message: 'Lỗi phản hồi máy chủ' } }; });
                });
            };
            var chain = Promise.resolve();
            if (mainFile) {
                var fdMain = new FormData();
                fdMain.append('bien_ban_hop', mainFile);
                chain = chain.then(function() {
                    return fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/upload-minutes', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + token },
                        body: fdMain
                    }).then(function(r) {
                        return r.json().then(function(d) { return { ok: r.ok, data: d }; }).catch(function() { return { ok: false, data: { message: 'Lỗi phản hồi máy chủ' } }; });
                    });
                });
            }
            chain.then(function(prevRes) {
                if (mainFile && prevRes && !prevRes.ok) {
                    showErr((prevRes.data && prevRes.data.message) || 'Upload biên bản thất bại.');
                    return null;
                }
                return doExtras();
            }).then(function(exRes) {
                if (exRes === null) return;
                if (!exRes.ok) {
                    showErr((exRes.data && exRes.data.message) || 'Upload tài liệu kèm thất bại.');
                    return;
                }
                alert('Đã lưu.');
                close();
                reloadKeepingTimelineStep('5');
            }).catch(function() {
                alert('Không kết nối được máy chủ.');
                btn.disabled = false;
            });
        };
    }

    function showStep6DecisionUploadDialog() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto';
        box.innerHTML = '<h3 style="margin:0 0 12px;font-size:1.1rem;color:#333">P. KHCN upload Quyết định phê duyệt đề tài</h3>' +
            '<p style="margin:0 0 14px;font-size:0.88rem;color:#455a64;text-align:justify">Chọn <strong>bản scan</strong> Quyết định phê duyệt: <strong>một file tiếng Việt</strong> và <strong>một file tiếng Anh</strong> (PDF/Word). Nhấn <strong>Lưu vào hồ sơ</strong> để ghi nhận.</p>' +
            '<div style="margin-bottom:12px"><label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:6px">Bản scan Quyết định (tiếng Việt) <span style="color:#c62828">*</span></label>' +
            '<input type="file" id="step6-dlg-file-vn" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box"></div>' +
            '<div style="margin-bottom:16px"><label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:6px">Bản scan Quyết định (English) <span style="color:#c62828">*</span></label>' +
            '<input type="file" id="step6-dlg-file-en" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" id="step6-dlg-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="step6-dlg-submit" style="padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Lưu vào hồ sơ</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('step6-dlg-cancel').onclick = close;
        document.getElementById('step6-dlg-submit').onclick = function() {
            var vnEl = document.getElementById('step6-dlg-file-vn');
            var enEl = document.getElementById('step6-dlg-file-en');
            var fVn = vnEl && vnEl.files && vnEl.files[0] ? vnEl.files[0] : null;
            var fEn = enEl && enEl.files && enEl.files[0] ? enEl.files[0] : null;
            if (!fVn || !fEn) {
                alert('Vui lòng chọn đủ hai file: bản tiếng Việt và bản tiếng Anh.');
                return;
            }
            var btn = document.getElementById('step6-dlg-submit');
            btn.disabled = true;
            var fd = new FormData();
            fd.append('decision_vn', fVn);
            fd.append('decision_en', fEn);
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/6/upload-decision', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: fd
            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                .then(function(res) {
                    btn.disabled = false;
                    if (res.ok) {
                        alert(res.data.message || 'Đã lưu bản scan Quyết định vào hồ sơ.');
                        close();
                        reloadKeepingTimelineStep('6');
                    } else {
                        alert(res.data.message || 'Upload thất bại.');
                    }
                }).catch(function() {
                    btn.disabled = false;
                    alert('Không kết nối được máy chủ.');
                });
        };
    }

    function showStep7ContractUploadDialog() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto';
        box.innerHTML = '<h3 style="margin:0 0 12px;font-size:1.1rem;color:#333">P. KHCN upload Hợp đồng KHCN</h3>' +
            '<p style="margin:0 0 14px;font-size:0.88rem;color:#455a64;text-align:justify">Chọn file <strong>Hợp đồng KHCN</strong> (PDF hoặc Word). File sẽ được lưu vào hồ sơ; có thể upload lại để thay thế trước khi nhấn <strong>Hoàn thành</strong>.</p>' +
            '<div style="margin-bottom:16px"><label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:6px">File Hợp đồng KHCN <span style="color:#c62828">*</span></label>' +
            '<input type="file" id="step7-dlg-file" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" id="step7-dlg-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="step7-dlg-submit" style="padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Lưu vào hồ sơ</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('step7-dlg-cancel').onclick = close;
        document.getElementById('step7-dlg-submit').onclick = function() {
            var inp = document.getElementById('step7-dlg-file');
            var f = inp && inp.files && inp.files[0] ? inp.files[0] : null;
            if (!f) {
                alert('Vui lòng chọn file Hợp đồng KHCN.');
                return;
            }
            var btn = document.getElementById('step7-dlg-submit');
            btn.disabled = true;
            var fd = new FormData();
            fd.append('step7_hop_dong_khcn', f);
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/7/upload-contract', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: fd
            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                .then(function(res) {
                    btn.disabled = false;
                    if (res.ok) {
                        alert(res.data.message || 'Đã lưu Hợp đồng KHCN.');
                        close();
                        reloadKeepingTimelineStep('7');
                    } else {
                        alert(res.data.message || 'Upload thất bại.');
                    }
                }).catch(function() {
                    btn.disabled = false;
                    alert('Không kết nối được máy chủ.');
                });
        };
    }

    function showStep8EthicsUploadDialog() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-height:90vh;overflow-y:auto';
        box.innerHTML = '<h3 style="margin:0 0 12px;font-size:1.1rem;color:#333">P. KHCN upload Quyết định đạo đức</h3>' +
            '<p style="margin:0 0 14px;font-size:0.88rem;color:#455a64;text-align:justify">Chọn <strong>một file</strong> Quyết định / văn bản đạo đức (PDF hoặc Word). Có thể upload lại để thay thế trước khi nhấn <strong>Hoàn thành</strong>.</p>' +
            '<div style="margin-bottom:16px"><label style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:6px">File Quyết định đạo đức <span style="color:#c62828">*</span></label>' +
            '<input type="file" id="step8-dlg-file" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" id="step8-dlg-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="step8-dlg-submit" style="padding:8px 16px;background:#1565c0;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Lưu vào hồ sơ</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('step8-dlg-cancel').onclick = close;
        document.getElementById('step8-dlg-submit').onclick = function() {
            var inp = document.getElementById('step8-dlg-file');
            var f = inp && inp.files && inp.files[0] ? inp.files[0] : null;
            if (!f) {
                alert('Vui lòng chọn file.');
                return;
            }
            var btn = document.getElementById('step8-dlg-submit');
            btn.disabled = true;
            var fd = new FormData();
            fd.append('step8_ethics_quyet_dinh', f);
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/8/upload-ethics-decision', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: fd
            }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                .then(function(res) {
                    btn.disabled = false;
                    if (res.ok) {
                        alert(res.data.message || 'Đã lưu file.');
                        close();
                        reloadKeepingTimelineStep('8');
                    } else {
                        alert(res.data.message || 'Upload thất bại.');
                    }
                }).catch(function() {
                    btn.disabled = false;
                    alert('Không kết nối được máy chủ.');
                });
        };
    }

    function callStep5Json(url, body) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(body || {})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; }).catch(function() { return { ok: false, data: { message: 'Lỗi phản hồi máy chủ' } }; });
        });
    }

    function callStep5CouncilPass() {
        if (!confirm('Ghi nhận Hội đồng KHCN đã thông qua? Hồ sơ sẽ chuyển sang Bước 6 (trạng thái sau họp).')) return;
        callStep5Json(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/council-pass', {}).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã cập nhật.');
                reloadKeepingTimelineStep('5');
            } else {
                alert(res.data.message || 'Không thực hiện được.');
            }
        }).catch(function() { alert('Không kết nối được máy chủ.'); });
    }

    function showStep5CouncilRequestRevisionDialog() {
        var note = prompt('Nội dung góp ý / yêu cầu chỉnh sửa của Hội đồng (bắt buộc):', '');
        if (note == null) return;
        note = String(note).trim();
        if (!note) {
            alert('Vui lòng nhập nội dung.');
            return;
        }
        callStep5Json(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/council-request-revision', { note: note }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã gửi yêu cầu.');
                reloadKeepingTimelineStep('5');
            } else {
                alert(res.data.message || 'Không gửi được.');
            }
        }).catch(function() { alert('Không kết nối được máy chủ.'); });
    }

    function showStep5CouncilRevisionUploadDialog() {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:520px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
        var round = (submissionData && submissionData.step5_council_revision_round) ? submissionData.step5_council_revision_round : 1;
        box.innerHTML = '<h3 style="margin:0 0 10px;font-size:1.1rem;color:#333">📤 Nộp hồ sơ chỉnh sửa (vòng ' + round + ')</h3>' +
            '<p style="margin:0 0 12px;font-size:0.88rem;color:#666">Chọn một hoặc nhiều file (PDF, Word…). Bản nộp trước đó trong cùng vòng sẽ được thay thế.</p>' +
            '<input type="file" id="step5-rev-files" multiple accept=".pdf,.doc,.docx,.zip,.rar" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px;box-sizing:border-box">' +
            '<div id="step5-rev-msg" style="display:none;margin-top:10px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
            '<button type="button" id="step5-rev-cancel" style="padding:8px 16px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer">Hủy</button>' +
            '<button type="button" id="step5-rev-submit" style="padding:8px 16px;background:#b45309;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">Gửi hồ sơ</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('step5-rev-cancel').onclick = close;
        document.getElementById('step5-rev-submit').onclick = function() {
            var inp = document.getElementById('step5-rev-files');
            var msgEl = document.getElementById('step5-rev-msg');
            if (!inp || !inp.files || !inp.files.length) {
                alert('Vui lòng chọn ít nhất một file.');
                return;
            }
            var formData = new FormData();
            for (var i = 0; i < inp.files.length; i++) {
                formData.append('files', inp.files[i]);
            }
            var btn = document.getElementById('step5-rev-submit');
            btn.disabled = true;
            if (msgEl) { msgEl.style.display = 'none'; }
            fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/council-revision-upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: formData
            }).then(function(r) {
                return r.json().then(function(d) { return { ok: r.ok, data: d }; }).catch(function() { return { ok: false, data: { message: 'Lỗi phản hồi' } }; });
            }).then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã lưu.');
                    close();
                    reloadKeepingTimelineStep('5');
                } else {
                    var t = res.data.message || 'Upload thất bại.';
                    alert(t);
                    if (msgEl) {
                        msgEl.textContent = t;
                        msgEl.style.display = 'block';
                        msgEl.style.background = '#f8d7da';
                        msgEl.style.color = '#721c24';
                    }
                    btn.disabled = false;
                }
            }).catch(function() {
                alert('Không kết nối được máy chủ.');
                btn.disabled = false;
            });
        };
    }

    function callStep5ChairRevisionDecision(action) {
        if (action === 'approve') {
            if (!confirm('Thông qua bản chỉnh sửa của Chủ nhiệm? (Kết thúc vòng góp ý hiện tại)')) return;
            callStep5Json(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/council-revision-chair', { action: 'approve' }).then(function(res) {
                if (res.ok) {
                    alert(res.data.message || 'Đã cập nhật.');
                    reloadKeepingTimelineStep('5');
                } else {
                    alert(res.data.message || 'Không thực hiện được.');
                }
            }).catch(function() { alert('Không kết nối được máy chủ.'); });
        }
    }

    function showStep5ChairRequestMoreDialog() {
        var note = prompt('Góp ý / yêu cầu Chủ nhiệm chỉnh sửa tiếp (bắt buộc):', '');
        if (note == null) return;
        note = String(note).trim();
        if (!note) {
            alert('Vui lòng nhập nội dung.');
            return;
        }
        callStep5Json(apiBase + '/api/cap-vien/submissions/' + id + '/steps/5/council-revision-chair', { action: 'request_more', note: note }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã gửi yêu cầu.');
                reloadKeepingTimelineStep('5');
            } else {
                alert(res.data.message || 'Không gửi được.');
            }
        }).catch(function() { alert('Không kết nối được máy chủ.'); });
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
                    reloadKeepingTimelineStep('4a');
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
                    reloadKeepingTimelineStep('4a');
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
                reloadKeepingTimelineStep('4');
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
                reloadKeepingTimelineStep('4');
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
                reloadKeepingTimelineStep('2');
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
                reloadKeepingTimelineStep(String(stepNum));
            } else {
                alert(res.data.message || 'Không thể đưa về bước đó.');
            }
        }).catch(function(err) {
            alert('Không kết nối được máy chủ.');
        });
    }
    function callDevResetStep(stepKey) {
        fetch(apiBase + '/api/cap-vien/submissions/' + id + '/dev-reset-step/' + stepKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        }).then(function(res) {
            if (res.ok) {
                alert(res.data.message || 'Đã reset bước.');
                reloadKeepingTimelineStep(String(stepKey));
            } else {
                alert(res.data.message || 'Reset thất bại.');
            }
        }).catch(function() {
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
                    setTimeout(function() { close(); reloadKeepingTimelineStep('4a'); }, 1200);
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
            '<button type="button" class="btn-action" id="budget-revision-submit" style="padding:8px 16px;background:linear-gradient(180deg,#fb923c 0%,#ea580c 100%);color:#fff;border:none;box-shadow:0 2px 8px rgba(234,88,12,.35)">Xong</button></div>';
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
        box.innerHTML = '<h3 style="margin:0 0 16px 0;font-size:1.15rem;color:#333">📤 Nộp bổ sung tài liệu theo yêu cầu</h3>' +
            '<p style="margin:0 0 16px 0;font-size:0.9rem;color:#666">Nộp bổ sung tài liệu/tài liệu đã chỉnh sửa theo yêu cầu của Tổ thẩm định dự toán.</p>' +
            '<div id="budget-revised-inputs" class="form-group" style="margin-bottom:12px"><label style="display:block;font-weight:500;margin-bottom:4px">Tài liệu bổ sung</label><input type="file" name="revised_files" class="budget-revised-file" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px"></div>' +
            '<button type="button" id="budget-revised-add-file" style="margin-bottom:14px;padding:6px 12px;background:#e9ecef;border:1px solid #dee2e6;border-radius:8px;cursor:pointer;font-size:0.9rem">➕ Thêm tệp</button>' +
            '<div id="budget-revised-msg" style="display:none;margin-bottom:12px;padding:10px;border-radius:8px;font-size:0.9rem"></div>' +
            '<div style="display:flex;gap:10px;justify-content:flex-end">' +
            '<button type="button" class="btn-action btn-secondary" id="budget-revised-cancel" style="padding:8px 16px">Hủy</button>' +
            '<button type="button" class="btn-action" id="budget-revised-submit" style="padding:8px 16px;background:#5c6ee8;color:#fff;border:none">Nộp tài liệu bổ sung</button></div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        var close = function() { document.body.removeChild(overlay); };
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
        document.getElementById('budget-revised-cancel').onclick = close;
        document.getElementById('budget-revised-add-file').onclick = function() {
            var container = document.getElementById('budget-revised-inputs');
            if (!container) return;
            var wrap = document.createElement('div');
            wrap.className = 'form-group';
            wrap.style.marginTop = '8px';
            wrap.innerHTML = '<input type="file" name="revised_files" class="budget-revised-file" accept=".pdf,.doc,.docx" style="width:100%;padding:8px;border:2px solid #dee2e6;border-radius:8px">';
            container.appendChild(wrap);
        };
        document.getElementById('budget-revised-submit').onclick = function() {
            var inputs = overlay.querySelectorAll('.budget-revised-file');
            var formData = new FormData();
            var count = 0;
            inputs.forEach(function(inp) {
                if (inp && inp.files && inp.files[0]) {
                    formData.append('revised_files', inp.files[0]);
                    count++;
                }
            });
            if (!count) { alert('Vui lòng chọn ít nhất 1 file.'); return; }
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
                .then(function(res) { if (res.ok) { alert(res.data.message || 'Đã nộp.'); reloadKeepingTimelineStep('4'); } else { alert(res.data.message || 'Thất bại.'); document.getElementById('reviewer-upload-submit').disabled = false; } })
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
        if (s === 'IN_MEETING') return 4; // Vẫn trong Bước 5 (họp HĐ) — cùng nhóm active với REVIEWED
        if (s === 'CONDITIONAL') return 5; // Đã ghi nhận HĐ thông qua → Bước 5 hoàn thành, Bước 6 đang làm
        if (s === 'APPROVED') return 6;    // Bước 6
        if (s === 'CONTRACTED') return 7;  // Bước 7
        if (s === 'IMPLEMENTATION') return 8;   // Bước 9
        if (s === 'COMPLETED' || s === 'REJECTED') return timelineTotalBlocks();       // Xong hoặc dừng
        return 1;
    }

    /** Tiêu đề hiển thị ở mục «Trạng thái» (theo đúng bước/block đang active — không hiện mã DB như CONDITIONAL). */
    function getHeaderTrangThaiDisplay(blockIndex, statusUpper) {
        var seq = timelineSeq();
        var NAMES = {
            1: 'Bước 1: Nộp hồ sơ đề xuất',
            2: 'Bước 2: Kiểm tra hồ sơ hành chính',
            3: 'Bước 3: Phân công phản biện',
            4: 'Bước 4: Đánh giá phản biện',
            '4a': 'Bước 4A: Thẩm định dự toán',
            5: 'Bước 5: Họp Hội đồng Khoa học Viện',
            6: 'Bước 6: Cấp Quyết định phê duyệt',
            7: 'Bước 7: Ký hợp đồng thực hiện',
            8: 'Bước 8: Đăng ký đạo đức',
            9: 'Bước 9: Thực hiện đề tài',
            10: 'Bước 10: Báo cáo tiến độ định kỳ (theo các kỳ)',
            11: 'Bước 11: Điều chỉnh nội dung/nhân sự',
            12: 'Bước 12: Nộp hồ sơ nghiệm thu',
            13: 'Bước 13–14: Phản biện nghiệm thu',
            15: 'Bước 15: Họp Hội đồng nghiệm thu',
            16: 'Bước 16: Quyết định nghiệm thu',
            17: 'Bước 17: Bàn giao sản phẩm & lưu trữ',
            18: 'Bước 18: Thanh lý hợp đồng'
        };
        var st = (statusUpper || '').toUpperCase();
        if (st === 'REJECTED') return 'Đã từ chối hồ sơ';
        var bi = parseInt(blockIndex, 10);
        if (isNaN(bi)) bi = 0;
        bi = Math.max(0, Math.min(seq.length, bi));
        if (bi >= seq.length || st === 'COMPLETED') {
            return 'Đã hoàn thành toàn bộ quy trình (17 bước)';
        }
        var block = seq[bi];
        if (Array.isArray(block)) {
            if (block.indexOf(4) >= 0 && block.indexOf('4a') >= 0) {
                return 'Bước 4 & 4A — Phản biện / Thẩm định dự toán';
            }
            var parts = [];
            for (var pi = 0; pi < block.length; pi++) {
                var k = block[pi];
                if (NAMES[k]) parts.push(NAMES[k]);
            }
            return parts.join(' • ') || 'Khối tiến độ hiện tại';
        }
        return NAMES[block] || ('Bước ' + block);
    }

    function getStepState(stepId, currentBlock) {
        var seq = timelineSeq();
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
    function displayRound(roundValue) {
        var r = parseInt(roundValue, 10);
        if (!Number.isFinite(r) || r < 1) r = 1;
        return r;
    }
    /** Vòng hiển thị (1-based) cho từng mốc lịch sử 4A */
    function budget4aHistoryRoundDisplay(h, data) {
        if (!h) return null;
        var note = String(h.note || '');
        var bracket = note.match(/^\[Vòng\s*(\d+)\]/i);
        if (bracket) {
            var rb = parseInt(bracket[1], 10);
            if (Number.isFinite(rb)) return displayRound(rb);
        }
        var paren = note.match(/\(vòng\s*(\d+)\)/i);
        if (paren) {
            var rp = parseInt(paren[1], 10);
            if (Number.isFinite(rp)) return displayRound(rp);
        }
        var loose = note.match(/vòng\s*(\d+)/i);
        if (loose) {
            var rl = parseInt(loose[1], 10);
            if (Number.isFinite(rl)) return displayRound(rl);
        }
        if (h.actionType === 'budget_approve' && data) {
            return displayRound(data.budget_4a_round != null ? data.budget_4a_round : 1);
        }
        return null;
    }
    function budget4aRoundBadgeHtml(roundDisp) {
        if (roundDisp == null || !Number.isFinite(roundDisp)) return '';
        return '<span class="budget-round-badge" title="Vòng thẩm định dự toán">Vòng ' + roundDisp + '</span>';
    }
    function budget4aNoteWithoutRoundPrefix(note) {
        var s = String(note || '');
        s = s.replace(/^\[Vòng\s*\d+\]\s*/i, '').trim();
        s = s.replace(/^\s*Nộp phiếu thẩm định dự toán\s*\(vòng\s*\d+\)\s*:\s*/i, 'Nộp phiếu thẩm định dự toán: ').trim();
        s = s.replace(/\s*\(vòng\s*\d+\)\s*$/i, '').trim();
        return s;
    }
    function fmtDateTime(iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        var p = function(n) { return String(n).padStart(2, '0'); };
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function applyStepDeadlinesUI(data) {
        var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
        var isAdmin = (user.role || '').toLowerCase() === 'admin';
        var map = data.stepDeadlines || {};
        var now = Date.now();
        contentEl.querySelectorAll('.stage-card[data-step]').forEach(function(card) {
            var step = card.getAttribute('data-step');
            var dl = map[step];
            var content = card.querySelector('.stage-content');
            var statusWrap = card.querySelector('.stage-status');
            var isCompleted = card.classList.contains('completed');
            if (dl && statusWrap) {
                var dueTs = new Date(dl.dueAt || '').getTime();
                var deadlineBadge = statusWrap.querySelector('.deadline-badge');
                if (!deadlineBadge) {
                    deadlineBadge = document.createElement('span');
                    deadlineBadge.className = 'deadline-badge';
                    statusWrap.insertBefore(deadlineBadge, statusWrap.querySelector('.expand-icon') || null);
                }
                if (!isNaN(dueTs)) {
                    if (!isCompleted && dueTs < now) {
                        var days = Math.max(1, Math.floor((now - dueTs) / (24 * 60 * 60 * 1000)) + 1);
                        deadlineBadge.textContent = '⛔ Quá hạn ' + days + ' ngày';
                        deadlineBadge.classList.add('is-overdue');
                        card.classList.add('overdue', 'overdue-flash');
                    } else {
                        deadlineBadge.textContent = '⏰ Deadline: ' + fmtDateTime(dl.dueAt);
                        deadlineBadge.classList.remove('is-overdue');
                        card.classList.remove('overdue-flash');
                    }
                }
                if (isAdmin) deadlineBadge.title = 'Admin có thể điều chỉnh deadline';
            }
            if (isAdmin && content) {
                var dueTxt = dl ? fmtDateTime(dl.dueAt) : 'Chưa đặt';
                var openTxt = dl ? fmtDateTime(dl.openedAt) : '—';
                var deadlineInner =
                    '<div class="admin-deadline-meta">Mở bước: <strong>' + openTxt + '</strong> • Deadline: <strong>' + dueTxt + '</strong></div>' +
                    '<div class="stage-actions admin-deadline-actions">' +
                    '<button type="button" class="btn-action btn-secondary btn-deadline-action" data-step="' + step + '" data-deadline-action="set-days">⏱ Đặt số ngày</button>' +
                    '<button type="button" class="btn-action btn-secondary btn-deadline-action" data-step="' + step + '" data-deadline-action="set-datetime">🗓 Chỉnh ngày giờ</button>' +
                    '<button type="button" class="btn-action btn-secondary btn-deadline-action" data-step="' + step + '" data-deadline-action="clear">🧹 Xóa deadline</button>' +
                    '</div>';
                var sub = content.querySelector('.admin-deadline-subzone');
                if (sub) {
                    sub.innerHTML = deadlineInner;
                } else {
                    var zone = content.querySelector('.admin-dev-zone');
                    if (!zone) {
                        zone = document.createElement('div');
                        zone.className = 'admin-dev-zone';
                        content.appendChild(zone);
                    }
                    zone.innerHTML =
                        '<div class="admin-tools-title">Công cụ Admin (dev)</div>' +
                        deadlineInner;
                }
            }
        });
    }
    function callSetStepDeadline(step, payload) {
        return fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/' + step + '/deadline', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(payload || {})
        }).then(function(r) {
            return r.json().then(function(d) { return { ok: r.ok, data: d }; });
        });
    }
    function fileUploaderLabel(f) {
        if (!f) return '—';
        var field = String(f.fieldName || '');
        if (field.indexOf('budget_revised_attachment_') === 0) {
            var role0 = String(f.uploadedByRole || '').toLowerCase();
            return role0 === 'admin' ? 'Chủ nhiệm (Admin nộp thay)' : 'Chủ nhiệm đề tài';
        }
        if (field.indexOf('budget_revision_request_') === 0) return 'Tổ thẩm định TC';
        if (field.indexOf('step5_council_revision_f_') === 0) return 'Hồ sơ chỉnh sửa Bước 5 (HĐKHCN)';
        if (field.indexOf('step5_hd_extra_') === 0) return 'Tài liệu kèm Bước 5 (Thư ký/Admin)';
        if (field === 'step6_decision_vn' || field === 'step6_decision_en') return 'Phòng KHCN / Thư ký HĐKHCN / Admin (Quyết định Bước 6)';
        if (field === 'step7_hop_dong_khcn') return 'Phòng KHCN / Thư ký HĐKHCN / Admin (Hợp đồng KHCN Bước 7)';
        if (field === 'step8_ethics_quyet_dinh') return 'Phòng KHCN / Thư ký HĐKHCN / Admin (Quyết định đạo đức Bước 8)';
        if (/^periodic_report_p\d+$/i.test(field)) return 'Báo cáo định kỳ (upload gắn kỳ #' + field.replace(/^periodic_report_p/i, '') + ')';
        var role = String(f.uploadedByRole || '').toLowerCase();
        if (role === 'researcher') return 'Chủ nhiệm';
        if (role === 'totruong_tham_dinh_tc' || role === 'thanh_vien_tham_dinh_tc' || role === 'totruong_tham_dinh' || role === 'thanh_vien_tham_dinh') return 'Tổ thẩm định TC';
        if (role === 'admin') return 'Admin';
        if (role === 'phong_khcn') return 'Phòng KHCN';
        if (role === 'thu_ky') return 'Thư ký HĐKHCN';
        return 'Chưa xác định';
    }

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
                var stepsBlock = Math.min(timelineTotalBlocks(), raw);
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
        if (status === 'CONDITIONAL' && currentBlock < 5) {
            currentBlock = 5;
        }
        var step8Done = data.step8_completed === 1 || data.step8_completed === true || String(data.step8_completed) === '1';
        var step8Waived = data.step8_waived === 1 || data.step8_waived === true || String(data.step8_waived) === '1';
        var step8Resolved = step8Done || step8Waived;
        if (status === 'CONTRACTED' && step8Resolved && currentBlock < 8) {
            currentBlock = 8;
        }
        var stepsDone = currentBlock;
        var total = timelineTotalBlocks();
        var progress = data.progressPercent != null ? data.progressPercent : Math.round((stepsDone / total) * 100);
        var statusLabel = getHeaderTrangThaiDisplay(stepsDone, status);
        var statusMetaColor = status === 'REJECTED' ? '#c62828' : '#2e7d32';
        var statusMetaIcon = status === 'REJECTED' ? '❌' : ((status === 'COMPLETED' || stepsDone >= total) ? '✅' : '▶');

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

        var escAttr = function(v) {
            return escapeHtml(v != null ? String(v) : '');
        };
        var step6Fvn = null;
        var step6Fen = null;
        var step7F = null;
        var step8F = null;
        (files || []).forEach(function(f) {
            if (f.fieldName === 'step6_decision_vn' && (!step6Fvn || (f.id || 0) > (step6Fvn.id || 0))) step6Fvn = f;
            if (f.fieldName === 'step6_decision_en' && (!step6Fen || (f.id || 0) > (step6Fen.id || 0))) step6Fen = f;
            if (f.fieldName === 'step7_hop_dong_khcn' && (!step7F || (f.id || 0) > (step7F.id || 0))) step7F = f;
            if (f.fieldName === 'step8_ethics_quyet_dinh' && (!step8F || (f.id || 0) > (step8F.id || 0))) step8F = f;
        });
        var uStep6 = {};
        try { uStep6 = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) {}
        var roleStep6 = String(uStep6.role || '').toLowerCase();
        var canEditStep6 = roleStep6 === 'admin' || roleStep6 === 'phong_khcn' || roleStep6 === 'thu_ky';
        var canEditStep7 = canEditStep6;
        var canEditStep8 = canEditStep6;
        var step6Past = ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].indexOf(status) >= 0;
        var step6TimeHdr = data.step6_meta_updated_at ? escapeHtml(String(data.step6_meta_updated_at)) : '—';
        var step6RowVn = (step6Fvn && step6Fvn.id)
            ? ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(step6Fvn.originalName || 'QD-VN') + '</div><div class="file-meta">Tiếng Việt • ' + escapeHtml(fileUploaderLabel(step6Fvn)) + (step6Fvn.uploadedAt ? ' • ' + escapeHtml(step6Fvn.uploadedAt) : '') + '</div></div></div><button type="button" class="btn-download-file" data-fid="' + step6Fvn.id + '">📥 Tải về</button></div>')
            : ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">Chưa có Quyết định (VN)</div><div class="file-meta">Tiếng Việt</div></div></div><button type="button" class="btn-download-file" disabled title="Chưa có file">📥 Tải về</button></div>');
        var step6RowEn = (step6Fen && step6Fen.id)
            ? ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(step6Fen.originalName || 'QD-EN') + '</div><div class="file-meta">English • ' + escapeHtml(fileUploaderLabel(step6Fen)) + (step6Fen.uploadedAt ? ' • ' + escapeHtml(step6Fen.uploadedAt) : '') + '</div></div></div><button type="button" class="btn-download-file" data-fid="' + step6Fen.id + '">📥 Tải về</button></div>')
            : ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">Chưa có Quyết định (EN)</div><div class="file-meta">English</div></div></div><button type="button" class="btn-download-file" disabled title="Chưa có file">📥 Tải về</button></div>');
        var step6EditorHtml = '';
        if (canEditStep6 && step6Past) {
            step6EditorHtml = '<div class="step6-editor" style="margin-top:14px;padding:14px;background:#f0f7ff;border-radius:10px;border:1px solid #b3d9ff;max-width:820px">' +
                '<div style="font-weight:700;margin-bottom:10px;color:#1565c0">Phòng KHCN / Thư ký HĐKHCN / Admin — nhập & chỉnh sửa thông tin Quyết định</div>' +
                '<p style="margin:0 0 10px 0;font-size:0.88rem;color:#455a64">Lưu và chỉnh sửa thông tin bất cứ lúc nào. Dùng nút bên dưới để upload <strong>cùng lúc</strong> hai bản scan (VN + EN). Để nhấn <strong>Hoàn thành</strong> và chuyển Bước 7: đã lưu Số QĐ và đã có đủ hai file trong hồ sơ.</p>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Số QĐ<br><input type="text" id="step6-input-so-qd" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step6_so_qd) + '"></label></div>' +
                '<div><label style="font-size:0.85rem;font-weight:600">Kinh phí<br><input type="text" id="step6-input-kinh-phi" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step6_kinh_phi) + '"></label></div>' +
                '<div><label style="font-size:0.85rem;font-weight:600">Thời gian thực hiện<br><input type="text" id="step6-input-thoi-gian" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step6_thoi_gian) + '"></label></div>' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Phí quản lý<br><input type="text" id="step6-input-phi-quan-ly" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step6_phi_quan_ly) + '"></label></div>' +
                '</div>' +
                '<button type="button" class="btn-action btn-primary btn-step6-save-meta" style="margin-top:12px">💾 Lưu thông tin</button>' +
                '<div style="margin-top:14px">' +
                '<button type="button" class="btn-action btn-primary btn-step6-open-upload">P. KHCN upload Quyết định phê duyệt đề tài</button>' +
                '</div></div>';
        }

        var avatar = (typeof chunhiem === 'string' ? chunhiem.substring(0, 2).toUpperCase() : 'NV').replace(/[^A-Z0-9]/gi, '') || 'NV';

        var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
        var isAdmin = user.role === 'admin';
        var html = '';
        html += '<div class="timeline-toolbar"><button class="btn-export" onclick="window.print()">🖨️ In</button><button class="btn-export" onclick="exportPDF()">📥 Xuất PDF</button><button class="btn-export" onclick="exportExcel()">📊 Xuất Excel</button></div>';
        html += '<div id="sticky-mini-progress" class="sticky-mini-progress" aria-hidden="true"><div class="sticky-mini-progress-inner"><div class="sticky-mini-title">Tiến độ tổng quan</div><div class="sticky-mini-meta">' + stepsDone + '/' + total + ' bước • ' + Math.round(progress) + '%</div><div class="sticky-mini-track"><div class="sticky-mini-fill" style="width:' + Math.min(100, progress) + '%"></div></div></div></div>';
        var taskCodeClass = 'task-code' + (/coe/i.test(String(code || '')) ? ' task-code-coe' : '');
        html += '<div class="task-header"><div class="task-header-code-row"><div class="' + taskCodeClass + '">Mã đề tài: ' + escapeHtml(code);
        if (isAdmin && data.id) html += ' <button type="button" class="btn-edit-code btn-sm" data-id="' + data.id + '" style="margin-left:8px;font-size:12px;padding:2px 8px;">Sửa mã</button>';
        html += '</div>';
        if (/coe/i.test(String(code || ''))) {
            html += '<span class="task-coe-note">Đề tài này thuộc dự án CoE</span>';
        }
        html += '</div>';
        html += '<h1 class="task-title">' + escapeHtml(title) + '</h1>';
        html += '<div class="task-meta">';
        html += '<div class="meta-item"><span class="meta-label">Chủ nhiệm</span><span class="meta-value">' + escapeHtml(chunhiem) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Ngày nộp</span><span class="meta-value">' + escapeHtml(ngayNop) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Thời gian thực hiện</span><span class="meta-value">—</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Kinh phí</span><span class="meta-value">—</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Trạng thái</span><span class="meta-value" style="color:' + statusMetaColor + '">' + statusMetaIcon + ' ' + escapeHtml(statusLabel) + '</span></div>';
        html += '<div class="meta-item"><span class="meta-label">Tiến độ</span><span class="meta-value">' + stepsDone + '/' + total + ' bước (' + Math.round(progress) + '%)</span></div></div></div>';

        var activeCount = stepsDone < total ? 1 : 0;
        var pendingCount = total - stepsDone - activeCount;
        html += '<div class="progress-overview"><h3 style="margin-bottom:15px">Tổng quan tiến độ</h3>';
        html += '<div class="progress-label"><span>Hoàn thành các bước quản lý</span><span><strong>' + stepsDone + '/' + total + ' bước</strong> đã hoàn thành</span></div>';
        html += '<div class="progress-bar"><div class="progress-fill" style="width:' + Math.min(100, progress) + '%">' + Math.round(progress) + '%</div></div>';
        html += '<div class="timeline-stats">';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#4caf50">' + stepsDone + '</div><div class="stat-mini-label">Bước hoàn thành</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#ea580c;font-weight:800">' + activeCount + '</div><div class="stat-mini-label">Đang thực hiện</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#f44336">0</div><div class="stat-mini-label">Quá hạn</div></div>';
        html += '<div class="stat-mini"><div class="stat-mini-value" style="color:#999">' + pendingCount + '</div><div class="stat-mini-label">Chưa bắt đầu</div></div></div></div>';

        html += '<div class="timeline-phases">';
        // ===== GIAI ĐOẠN 1 =====
        html += '<div class="phase-header"><h3>📋 GIAI ĐOẠN 1: ĐĂNG KÝ VÀ XÉT DUYỆT HỒ SƠ (Bước 1-6)</h3></div>';

        var stepHistory = data.stepHistory || {};
        function formatStepActualDuration(stepKey, regulPrefix) {
            var st = data.stepActualStats && data.stepActualStats[stepKey];
            var actualText;
            if (!st || (st.openedAt == null && st.days == null)) {
                actualText = 'Thực tế: —';
            } else if (st.completed && st.days != null) {
                actualText = 'Thực tế: ' + st.days + ' ngày';
            } else if (st.completed && st.days == null) {
                actualText = 'Thực tế: —';
            } else if (!st.completed && st.days != null) {
                actualText = 'Thực tế: đang ' + st.days + ' ngày';
            } else {
                actualText = 'Thực tế: —';
            }
            if (regulPrefix) return '⏱️ ' + regulPrefix + ' • ' + actualText;
            return '⏱️ ' + actualText;
        }
        (function(){ var s=getStepState(1,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="1"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 1: Nộp hồ sơ đề xuất</h3><div class="stage-subtitle"><span>👤 Nghiên cứu viên</span><span class="stage-duration">' + formatStepActualDuration('1', null) + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span style="font-size:12px;color:#666">'+escapeHtml(ngayNop)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content">';
        html += '<div class="visual-card visual-card-progress"><h4 class="visual-card-title">🧭 Tiến trình thẩm định</h4><div class="stage-timeline">';
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

        (function(){ var s=getStepState(2,stepsDone); var extraClass = (status === 'NEED_REVISION') ? ' expanded' : ''; html+='<div class="stage-card '+stageClass(s)+extraClass+'" data-step="2"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 2: Kiểm tra hồ sơ hành chính</h3><div class="stage-subtitle"><span>👤 Thư ký HĐKHCN</span><span class="stage-duration">' + formatStepActualDuration('2', 'Quy định: 3-5 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
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
                html += '</div>';
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
                html += '<button type="button" id="btn-submit-supplement-step2" class="btn-step2-supplement-submit" style="padding:8px 16px">📤 Gửi hồ sơ bổ sung</button> ';
                html += '<button type="button" id="btn-resubmit-step2" class="btn-step2-supplement-secondary" style="padding:8px 16px">📋 Nộp lại (không file mới)</button>';
                html += '<p id="step2-supplement-msg" class="msg" style="display:none;margin-top:10px;padding:8px;border-radius:8px;font-size:0.9rem"></p></div>';
            } else {
                html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Thư ký kiểm tra hồ sơ</div><div class="event-time">—</div></div><div class="event-content">Kiểm tra tính đầy đủ, format, điều kiện chủ nhiệm</div></div></div>';
                var u2 = {}; try { u2 = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
                if ((u2.role || '').toLowerCase() === 'admin') html += actionButtons(2, [{ label: '↩ Đưa về Bước 2 (Admin)', action: 'revert', className: 'btn-secondary' }]);
            }
            if (isAdmin) html += actionButtons(2, [{ label: '♻️ Reset Bước 2 (dev)', action: 'dev-reset-2', className: 'btn-secondary' }]);
            html += '</div></div></div>';
        })();

        (function(){ var s=getStepState(3,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="3"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 3: Phân công phản biện</h3><div class="stage-subtitle"><span>👤 Chủ tịch HĐKHCN</span><span class="stage-duration">' + formatStepActualDuration('3', 'Quy định: 2-3 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
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
                html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">📌 Kết quả phân công phản biện</div><div class="event-time">' + escapeHtml(assignedAt) + '</div></div><div class="event-content"><strong>Phản biện 1:</strong> ' + escapeHtml(pb1) + '<br><strong>Phản biện 2:</strong> ' + escapeHtml(pb2) + '<br><strong>Phân công bởi:</strong> Chủ tịch Hội đồng KHCN</div></div>';
            } else {
                html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">👥 Phân công 2 phản biện</div><div class="event-time">' + escapeHtml(assignedAt) + '</div></div><div class="event-content"><strong>Phản biện 1:</strong> ' + escapeHtml(pb1) + '<br><strong>Phản biện 2:</strong> ' + escapeHtml(pb2) + '<br><strong>Phân công bởi:</strong> Chủ tịch Hội đồng KHCN</div></div>';
            }
            if (status === 'VALIDATED') {
                var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
                var isChairmanOrAdmin = (user.role || '').toLowerCase() === 'chu_tich' || (user.role || '').toLowerCase() === 'admin';
                if (isChairmanOrAdmin) html += actionButtons(3, [{ label: '👥 Phân công phản biện', action: 'phan-cong' }]);
            }
            var u3 = {}; try { u3 = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            if ((u3.role || '').toLowerCase() === 'admin') html += actionButtons(3, [{ label: '↩ Đưa về Bước 2 (Admin)', action: 'revert-to-2', className: 'btn-secondary' }, { label: '♻️ Reset Bước 3 (dev)', action: 'dev-reset-3', className: 'btn-secondary' }]);
            html += '</div></div></div>';
        })();

        html += '<div class="parallel-label">⚡ 2 BƯỚC THỰC HIỆN SONG SONG ⚡</div><div class="parallel-stages">';

        (function(){ var s=getStepState(4,stepsDone); if (!step4And4aReallyDone && s === 'completed') s = 'active'; html+='<div class="stage-card '+stageClass(s)+'" data-step="4"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 4: Đánh giá phản biện</h3><div class="stage-subtitle"><span>👥 2 Phản biện</span><span class="stage-duration">' + formatStepActualDuration('4', 'Quy định: 7-10 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        (function(){
            var reviewerFiles = {};
            (data.files || []).forEach(function(f){
                if (f.fieldName === 'reviewer_phieu_1') reviewerFiles[1] = f;
                if (f.fieldName === 'reviewer_phieu_2') reviewerFiles[2] = f;
            });
            var step4State = getStepState(4, stepsDone);
            if (!step4And4aReallyDone && step4State === 'completed') step4State = 'active';
            var showReviewerProgressBadge = step4State !== 'pending';
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
                var subPb = slot === 1
                    ? 'Khu vực chỉ dành cho phản biện 1 — xử lý độc lập với phản biện 2'
                    : 'Khu vực chỉ dành cho phản biện 2 — xử lý độc lập với phản biện 1';

                html += '<div class="reviewer-slot reviewer-slot-' + slot + '">';
                html += '<div class="reviewer-slot-header"><div class="reviewer-slot-head"><div class="reviewer-slot-num" aria-hidden="true">' + slot + '</div><div class="reviewer-slot-heading-text"><div class="reviewer-slot-title">KHU VỰC PHẢN BIỆN ' + slot + '</div><div class="reviewer-slot-sub">' + escapeHtml(subPb) + '</div></div></div>' + (showReviewerProgressBadge ? ('<span class="stage-badge ' + (done ? 'badge-done' : 'badge-progress') + '">' + (done ? 'Đã hoàn thành' : 'Đang thực hiện') + '</span>') : '') + '</div>';
                html += '<div class="reviewer-slot-body">';
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
                    if (file) {
                        html += '<p class="reviewer-slot-hint reviewer-slot-hint-' + slot + '" style="margin:10px 0 0;font-size:12px;padding:10px 12px;border-radius:10px;line-height:1.45">💡 Sau khi PB' + slot + ' upload thành công file, hãy nhấn nút <strong>PB' + slot + ' hoàn thành</strong> để hoàn tất nhiệm vụ.</p>';
                    }
                }
                html += '</div></div>';
            });

            var step4Btns = [];
            if (isAdmin) {
                step4Btns.push({ label: '📧 Gửi email Bước 4 (Admin)', action: 'gui-email', className: 'btn-secondary' });
                if (stepsDone >= 4) step4Btns.push({ label: '↩ Đưa về Bước 3 (Admin)', action: 'revert-to-3', className: 'btn-secondary' });
                step4Btns.push({ label: '♻️ Reset Bước 4 (dev)', action: 'dev-reset-4', className: 'btn-secondary' });
            }
            if (step4Btns.length) {
                html += '<div class="admin-unified-tools">';
                html += '<div class="admin-tools-title">Công cụ Admin (dev)</div>';
                html += '<div class="stage-actions admin-tools-row">';
                step4Btns.forEach(function(a) {
                    html += '<button type="button" class="btn-action ' + (a.className || '') + '" data-step="4" data-action="' + a.action + '">' + escapeHtml(a.label) + '</button>';
                });
                html += '</div>';
                html += '<div class="admin-deadline-subzone"></div>';
                html += '</div>';
            }
            html += templateHint(4) + '</div></div></div>';
        })();

        (function(){ var s=getStepState('4a',stepsDone); if (!step4And4aReallyDone && s === 'completed') s = 'active'; html+='<div class="stage-card '+stageClass(s)+'" data-step="4a"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 4A: Thẩm định dự toán</h3><div class="stage-subtitle"><span>💰 Tổ Thẩm định TC</span><span class="stage-duration">' + formatStepActualDuration('4a', 'Quy định: 5-7 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="visual-card visual-card-progress"><h4 class="visual-card-title">🧭 Tiến trình thẩm định</h4><div class="stage-timeline">';
        var step4aHist = stepHistory['4a'] || [];
        var budget4aStatus = data.budget_4a_status || '';
        var budget4aRound = displayRound(data.budget_4a_round || 1);
        var budget4aRoundDisplay = budget4aRound;
        var budget4aLabels = { budget_upload: '📋 Nộp phiếu thẩm định dự toán', budget_request_revision: '⚠️ Yêu cầu bổ sung/chỉnh sửa', researcher_upload_revised: '📤 Nghiên cứu viên nộp tài liệu chỉnh sửa', budget_approve: '✅ Phê duyệt dự toán' };
        var budget4aClasses = { budget_upload: 'success', budget_request_revision: 'warning', researcher_upload_revised: '', budget_approve: 'success' };
        if (step4aHist.length) {
            step4aHist.forEach(function(h) {
                var label = budget4aLabels[h.actionType] || h.actionType;
                var cls = budget4aClasses[h.actionType] || '';
                var rd = budget4aHistoryRoundDisplay(h, data);
                var noteHtml = '';
                if (h.note) {
                    var noteBody = (rd != null || /^\[Vòng\s*\d+\]/i.test(String(h.note))) ? budget4aNoteWithoutRoundPrefix(h.note) : h.note;
                    noteHtml = '<p style="white-space:pre-wrap">' + escapeHtml(noteBody) + '</p>';
                }
                html += '<div class="timeline-event ' + cls + '"><div class="event-header"><div class="event-title">' + escapeHtml(label) + budget4aRoundBadgeHtml(rd) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + noteHtml + '<div class="event-user" style="margin-top:6px">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
            });
        }
        var budget4aRevisionNote = data.budget_4a_revision_note || '';
        var budget4aRevisionAt = data.budget_4a_revision_requested_at || '—';
        if (budget4aStatus === 'need_revision' && budget4aRevisionNote) {
            html += '<div class="timeline-event warning"><div class="event-header"><div class="event-title">⚠️ Yêu cầu bổ sung đang chờ NCV xử lý' + budget4aRoundBadgeHtml(budget4aRoundDisplay) + '</div><div class="event-time">' + escapeHtml(budget4aRevisionAt) + '</div></div><div class="event-content"><p style="white-space:pre-wrap;background:#fff8e1;padding:10px;border-radius:8px">' + escapeHtml(budget4aRevisionNote) + '</p></div></div>';
        }
        if (budget4aStatus === 'approved') {
            html += '<div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Kết luận thẩm định: Đã phê duyệt' + budget4aRoundBadgeHtml(budget4aRoundDisplay) + '</div><div class="event-time">' + escapeHtml(data.budget_4a_approved_at || '—') + '</div></div><div class="event-content">Dự toán đã được Tổ thẩm định phê duyệt <strong>(vòng ' + budget4aRoundDisplay + ')</strong>.</div></div>';
        }
        html += '</div></div>';
        (function(){
            var budgetFields = ['budget_phieu_tham_dinh','budget_to_trinh'];
            var budgetLabels = { budget_phieu_tham_dinh: 'SCI-BUDGET-01 Phiếu thẩm định', budget_to_trinh: 'SCI-BUDGET-02 Tờ trình' };
            var files = (data.files || []).filter(function(f){ return budgetFields.indexOf(f.fieldName) >= 0; });
            var revisedAttachments = (data.files || []).filter(function(f){ return (f.fieldName || '').indexOf('budget_revised_attachment_') === 0; });
            var byRound = {};
            files.forEach(function(f){
                var r = displayRound((f.revisionRound != null) ? Number(f.revisionRound) : 1);
                if (!byRound[r]) byRound[r] = {};
                byRound[r][f.fieldName] = f;
            });
            var revisedByRound = {};
            revisedAttachments.forEach(function(f){
                var r = displayRound((f.revisionRound != null) ? Number(f.revisionRound) : 1);
                if (!revisedByRound[r]) revisedByRound[r] = [];
                revisedByRound[r].push(f);
            });
            var rounds = Object.keys(byRound).map(function(x){ return Number(x); }).sort(function(a,b){ return b-a; });
            if (rounds.indexOf(budget4aRound) < 0) rounds.push(budget4aRound);
            rounds = rounds.sort(function(a,b){ return b-a; });
            html += '<div class="visual-card visual-card-files"><h4 class="visual-card-title">📎 Hồ sơ đã nộp</h4><div class="files-section"><div class="files-title">Theo vòng bổ sung (vòng hiện tại: ' + budget4aRoundDisplay + ')</div>';
            rounds.forEach(function(round){
                var fileMap = byRound[round] || {};
                var hasAnyBudget = !!(fileMap.budget_phieu_tham_dinh || fileMap.budget_to_trinh);
                var roundDisplay = displayRound(round);
                html += '<div class="files-group-by-round" style="margin-bottom:12px"><div class="files-title" style="font-size:13px;color:#1e3a8a">Vòng ' + roundDisplay + (round === budget4aRound ? ' (đang xử lý)' : '') + '</div><div class="file-list">';
                if (hasAnyBudget) {
                    html += '<div class="files-title" style="font-size:12px;color:#475569">Hồ sơ Tổ thẩm định tài chính:</div>';
                    budgetFields.forEach(function(field){
                        var f = fileMap[field];
                        if (f) {
                            html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(f.originalName) + '</div><div class="file-meta">Đã nộp • Vòng ' + roundDisplay + ' • Upload bởi: ' + escapeHtml(fileUploaderLabel(f)) + '</div></div></div><button class="btn-download-file" data-fid="' + f.id + '">📥 Tải về</button></div>';
                        } else {
                            html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(budgetLabels[field] || field) + '</div><div class="file-meta">Thiếu file ở vòng này</div></div></div><button class="btn-download-file" disabled title="Chưa có file để tải">📥 Tải về</button></div>';
                        }
                    });
                }
                var revisedList = revisedByRound[round] || [];
                if (revisedList.length) {
                    html += '<div class="files-title" style="font-size:12px;color:#475569;margin-top:8px">Tài liệu Chủ nhiệm bổ sung/chỉnh sửa:</div>';
                    revisedList.forEach(function(f) {
                        html += '<div class="file-item"><div class="file-info"><span class="file-icon">📎</span><div class="file-details"><div class="file-name">' + escapeHtml(f.originalName || 'Tài liệu bổ sung') + '</div><div class="file-meta">Vòng ' + roundDisplay + ' • Upload bởi: ' + escapeHtml(fileUploaderLabel(f)) + '</div></div></div><button class="btn-download-file" data-fid="' + (f.id || '') + '">📥 Tải về</button></div>';
                    });
                }
                if (!hasAnyBudget && !revisedList.length) {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">Chưa có tài liệu ở vòng này</div><div class="file-meta">Đang chờ nộp</div></div></div><button class="btn-download-file" disabled title="Chưa có file để tải">📥 Tải về</button></div>';
                }
                html += '</div></div>';
            });
            html += '</div></div>';
        })();
        (function(){
            var user = {}; try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            var isBudgetTeam = (user.role || '').toLowerCase() === 'admin' || ['totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc'].indexOf((user.role || '').toLowerCase()) >= 0;
            var isOwner = (data.submittedById != null && user.id != null) && Number(data.submittedById) === Number(user.id);
            var isAdmin = (user.role || '').toLowerCase() === 'admin';
            var canSubmitRevision = budget4aStatus === 'need_revision' && (isOwner || isAdmin);
            var hasCurrentRoundBudgetFiles = (data.files || []).filter(function(f){
                var r = displayRound((f.revisionRound != null) ? Number(f.revisionRound) : 1);
                return r === budget4aRound && (f.fieldName === 'budget_phieu_tham_dinh' || f.fieldName === 'budget_to_trinh');
            }).length >= 2;
            var hasCurrentRoundRevisedAttachments = (data.files || []).some(function(f){
                var r = displayRound((f.revisionRound != null) ? Number(f.revisionRound) : 1);
                return r === budget4aRound && String(f.fieldName || '').indexOf('budget_revised_attachment_') === 0;
            });
            var budgetTeamBtns = [];
            var adminUtilityBtns = [];
            if (isBudgetTeam) {
                budgetTeamBtns.push({ label: '📋 Nộp phiếu thẩm định', action: 'nop-tham-dinh' });
                if (budget4aStatus !== 'approved') budgetTeamBtns.push({ label: '⚠️ Yêu cầu bổ sung/chỉnh sửa', action: 'yeu-cau-bo-sung', className: 'btn-secondary' });
                if (budget4aStatus !== 'approved' && (hasCurrentRoundBudgetFiles || hasCurrentRoundRevisedAttachments)) {
                    budgetTeamBtns.push({ label: '✅ Phê duyệt dự toán', action: 'phe-duyet' });
                }
            }
            var ownerBtns = [];
            if (budget4aStatus === 'need_revision') {
                ownerBtns.push({ label: '📤 Chủ nhiệm nộp hồ sơ bổ sung', action: 'nop-chinh-sua', className: (canSubmitRevision ? '' : 'is-disabled') });
            } else if (budget4aStatus === 'approved') {
                ownerBtns.push({ label: '📤 Chủ nhiệm nộp hồ sơ bổ sung', action: 'nop-chinh-sua', className: 'is-disabled' });
            }
            if (isAdmin) {
                adminUtilityBtns.push({ label: '📧 Gửi email Bước 4A (Admin)', action: 'gui-email', className: 'btn-secondary' });
                if (stepsDone >= 4) adminUtilityBtns.push({ label: '↩ Đưa về Bước 3 (Admin)', action: 'revert-to-3', className: 'btn-secondary' });
                adminUtilityBtns.push({ label: '♻️ Reset Bước 4A (dev)', action: 'dev-reset-4a', className: 'btn-secondary' });
            }
            html += '<div class="visual-card visual-card-actions"><h4 class="visual-card-title">🎛️ Chức năng</h4>';
            if (budgetTeamBtns.length) {
                html += '<div class="action-zone action-zone-budget"><h5 class="action-zone-title">👥 Khu vực Tổ thẩm định</h5>';
                html += '<div class="alert-box alert-info" style="margin:0 0 8px 0"><span style="font-size:16px">🧭</span><div><strong>Luồng thao tác:</strong> Nộp phiếu → (có thể yêu cầu bổ sung nhiều vòng) → Phê duyệt.<br><strong>Lưu ý:</strong> Có thể nộp phiếu xong và phê duyệt luôn nếu không cần bổ sung thêm.</div></div>';
                html += actionButtons('4a', budgetTeamBtns);
                html += '</div>';
            }

            var owner4aCls = 'action-zone action-zone-owner' + (budget4aStatus === 'need_revision' ? ' action-zone-owner--attention' : '');
            html += '<div class="' + owner4aCls + '"><h5 class="action-zone-title">👤 Khu vực Chủ nhiệm đề tài</h5>';
            if (budget4aStatus === 'need_revision') {
                if (canSubmitRevision) html += '<div class="alert-box alert-info" style="margin:0 0 8px 0"><span style="font-size:18px">ℹ️</span><div>Đang mở nộp bổ sung cho <strong>vòng ' + budget4aRoundDisplay + '</strong>. ' + (isAdmin && !isOwner ? 'Admin có thể nộp thay để kiểm thử.' : 'Chủ nhiệm có thể upload lại hồ sơ theo yêu cầu.') + '</div></div>';
                else html += '<div class="alert-box alert-warning" style="margin:0 0 8px 0"><span style="font-size:18px">⏳</span><div>Đang chờ <strong>Chủ nhiệm đề tài</strong> nộp hồ sơ bổ sung cho vòng ' + budget4aRoundDisplay + '.</div></div>';
            } else if (budget4aStatus === 'approved') {
                html += '<div class="alert-box alert-success" style="margin:0 0 8px 0"><span style="font-size:18px">✅</span><div>Tổ thẩm định đã phê duyệt. Nút nộp bổ sung được khóa.</div></div>';
            } else {
                html += '<div class="alert-box alert-info" style="margin:0 0 8px 0"><span style="font-size:18px">ℹ️</span><div>Chưa có yêu cầu bổ sung từ Tổ thẩm định.</div></div>';
            }
            if (ownerBtns.length) html += actionButtons('4a', ownerBtns);
            html += '</div>';
            if (isAdmin) {
                html += '<div class="admin-unified-tools">';
                html += '<div class="admin-tools-title">Công cụ Admin (dev)</div>';
                if (adminUtilityBtns.length) {
                    html += '<div class="stage-actions admin-tools-row">';
                    adminUtilityBtns.forEach(function(a) {
                        html += '<button type="button" class="btn-action ' + (a.className || '') + '" data-step="4a" data-action="' + a.action + '">' + escapeHtml(a.label) + '</button>';
                    });
                    html += '</div>';
                }
                html += '<div class="admin-deadline-subzone"></div>';
                html += '</div>';
            }
            html += templateHint('4a') + '</div></div></div>';
        })();

        html += '</div>'; // đóng parallel-stages — chỉ Bước 4 & 4A song song

        (function(){ var s=getStepState(5,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="5"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 5: Họp Hội đồng Khoa học Viện</h3><div class="stage-subtitle"><span>👥 HĐKHCN</span><span class="stage-duration">' + formatStepActualDuration('5', null) + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        (function(){
            var evTime = timelineField(data.step5_hd_meeting_event_time);
            var step5Meta = '';
            if (data.step5_hd_meeting_updated_at) {
                step5Meta = '<div style="margin-top:10px;font-size:12px;color:#64748b;border-top:1px dashed #cbd5e1;padding-top:8px">Cập nhật lần cuối: ' + escapeHtml(data.step5_hd_meeting_updated_at) + (data.step5HdMeetingUpdatedByName ? ' — ' + escapeHtml(data.step5HdMeetingUpdatedByName) : '') + '</div>';
            }
            html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">🏛️ Họp HĐKHCN</div><div class="event-time">' + evTime + '</div></div><div class="event-content"><strong>Địa điểm:</strong> ' + timelineField(data.step5_hd_meeting_location) + '<br><strong>Tham dự:</strong> ' + timelineField(data.step5_hd_meeting_attendance) + '<br><strong>Tài liệu:</strong> ' + timelineField(data.step5_hd_meeting_documents) + '<br><strong>Kết quả biểu quyết:</strong> ' + timelineField(data.step5_hd_meeting_vote_result) + '<br><strong>Quyết định:</strong> ' + timelineField(data.step5_hd_meeting_decision) + step5Meta + '</div></div></div>';
        })();
        (function(){
            var step5File = null;
            var step5ExtraFiles = [];
            var step5RevFiles = [];
            (data.files || []).forEach(function(f) {
                if (f.fieldName === 'step5_bien_ban_hop_hd') step5File = f;
                if (String(f.fieldName || '').indexOf('step5_hd_extra_') === 0) step5ExtraFiles.push(f);
                if (String(f.fieldName || '').indexOf('step5_council_revision_f_') === 0) step5RevFiles.push(f);
            });
            var step5Hist = stepHistory['5'] || [];
            var histHtml = '';
            if (step5Hist.length) {
                histHtml = '<div class="visual-card visual-card-progress" style="margin-top:14px"><h4 class="visual-card-title" style="font-size:0.95rem">📜 Lịch sử bước 5</h4><div class="stage-timeline">';
                var labels5 = {
                    step5_bien_ban_upload: '📎 Upload biên bản họp',
                    hd_meeting_info_update: '📝 Cập nhật thông tin họp HĐ',
                    step5_council_request_revision: '📋 Yêu cầu chỉnh sửa (Thư ký HĐ)',
                    step5_council_revision_upload: '📤 Chủ nhiệm nộp hồ sơ chỉnh sửa',
                    step5_chair_approve_revision: '✅ Thông qua bản chỉnh sửa',
                    step5_chair_request_more_revision: '⚠️ Yêu cầu chỉnh sửa tiếp',
                    step5_council_pass_hd: '🏁 Hội đồng KHCN thông qua (chuyển Bước 6)',
                    step5_extra_file_upload: '📎 Upload tài liệu kèm (Bước 5)'
                };
                step5Hist.forEach(function(h) {
                    var lab = labels5[h.actionType] || h.actionType;
                    histHtml += '<div class="timeline-event success"><div class="event-header"><div class="event-title">' + escapeHtml(lab) + '</div><div class="event-time">' + escapeHtml(h.performedAt || '—') + '</div></div><div class="event-content">' + (h.note ? '<div style="white-space:pre-wrap">' + escapeHtml(h.note) + '</div>' : '') + '<div style="margin-top:6px;font-size:12px;color:#64748b">👤 ' + escapeHtml(h.performedByName || '—') + '</div></div></div>';
                });
                histHtml += '</div></div>';
            }
            html += '<div class="files-section" style="margin-top:14px"><div class="files-title">📎 Biên bản họp HĐ KHCN</div><div class="file-list">';
            if (step5File) {
                html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">' + escapeHtml(step5File.originalName || 'biên bản.pdf') + '</div><div class="file-meta">Upload: ' + escapeHtml(fileUploaderLabel(step5File)) + (step5File.uploadedAt ? ' • ' + escapeHtml(step5File.uploadedAt) : '') + '</div></div></div><button class="btn-download-file" data-fid="' + (step5File.id || '') + '">📥 Tải về</button></div>';
            } else {
                html += '<div class="file-item"><div class="file-info"><span class="file-icon">📋</span><div class="file-details"><div class="file-name">Chưa có biên bản họp</div><div class="file-meta">Thư ký / Admin nộp qua nút «Upload Biên bản họp Hội đồng»</div></div></div><button class="btn-download-file" disabled title="Chưa có file">📥 Tải về</button></div>';
            }
            html += '</div></div>';
            if (step5ExtraFiles.length) {
                step5ExtraFiles.sort(function(a, b) {
                    var ta = String(a.uploadedAt || '');
                    var tb = String(b.uploadedAt || '');
                    if (ta !== tb) return ta.localeCompare(tb);
                    return (a.id || 0) - (b.id || 0);
                });
                html += '<div class="files-section" style="margin-top:14px"><div class="files-title">📎 Tài liệu kèm (nhận xét Ủy viên HĐ, phiếu, ...)</div><div class="file-list">';
                step5ExtraFiles.forEach(function(f) {
                    html += '<div class="file-item"><div class="file-info"><span class="file-icon">📎</span><div class="file-details"><div class="file-name">' + escapeHtml(f.originalName || 'file') + '</div><div class="file-meta">' + escapeHtml(fileUploaderLabel(f)) + (f.uploadedAt ? ' • ' + escapeHtml(f.uploadedAt) : '') + '</div></div></div><button class="btn-download-file" data-fid="' + (f.id || '') + '">📥 Tải về</button></div>';
                });
                html += '</div></div>';
            }
            var revByRound = {};
            step5RevFiles.forEach(function(f) {
                var rr = f.revisionRound != null ? Number(f.revisionRound) : 0;
                if (!revByRound[rr]) revByRound[rr] = [];
                revByRound[rr].push(f);
            });
            var revRounds = Object.keys(revByRound).map(Number).sort(function(a, b) { return a - b; });
            if (revRounds.length) {
                html += '<div class="files-section" style="margin-top:14px"><div class="files-title">📎 Hồ sơ chỉnh sửa theo góp ý Hội đồng</div>';
                revRounds.forEach(function(rr) {
                    html += '<div style="margin:10px 0 6px;font-size:13px;font-weight:700;color:#475569">Vòng ' + rr + '</div><div class="file-list">';
                    revByRound[rr].forEach(function(f) {
                        html += '<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(f.originalName || 'file') + '</div><div class="file-meta">' + escapeHtml(fileUploaderLabel(f)) + (f.uploadedAt ? ' • ' + escapeHtml(f.uploadedAt) : '') + '</div></div></div><button class="btn-download-file" data-fid="' + (f.id || '') + '">📥 Tải về</button></div>';
                    });
                    html += '</div>';
                });
                html += '</div>';
            }
            html += histHtml;
        })();
        (function(){
            var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}
            var ur = (u.role || '').toLowerCase();
            var isAdmin5 = ur === 'admin';
            var isThuKy = ur === 'thu_ky';
            var isChuTich = ur === 'chu_tich';
            var st5 = (data.status || '').toUpperCase();
            var step5OnTrack = st5 === 'REVIEWED' || st5 === 'IN_MEETING';
            var revSt = (data.step5_council_revision_status || '').trim();
            var revRound = data.step5_council_revision_round != null ? Number(data.step5_council_revision_round) : 0;
            var isOwner5 = (data.submittedById != null && u.id != null) && Number(data.submittedById) === Number(u.id);
            var canSecretary = isThuKy || isAdmin5;
            var canChairAct = isChuTich || isThuKy || isAdmin5;

            html += '<div class="visual-card visual-card-actions" style="margin-top:14px"><h4 class="visual-card-title" style="font-size:0.95rem">🎛️ Thao tác Bước 5</h4>';

            if (canSecretary) {
                html += '<div class="action-zone action-zone-secretary"><h5 class="action-zone-title">📋 Dành cho Thư ký Hội đồng KHCN</h5>';
                if (revSt === 'waiting_researcher') {
                    html += '<div class="alert-box alert-info" style="margin:0 0 10px"><span style="font-size:16px">⏳</span><div>Đang chờ <strong>Chủ nhiệm</strong> nộp hồ sơ chỉnh sửa (vòng ' + revRound + ').</div></div>';
                } else if (revSt === 'waiting_chair') {
                    html += '<div class="alert-box alert-info" style="margin:0 0 10px"><span style="font-size:16px">⏳</span><div>Đang chờ <strong>Chủ tịch HĐKHCN</strong> xem xét bản chỉnh sửa vòng ' + revRound + '.</div></div>';
                }
                if (step5OnTrack) {
                    html += '<div class="stage-actions" style="flex-wrap:wrap;display:flex;gap:8px;align-items:center">';
                    html += '<button type="button" class="btn-action btn-secondary" data-step="5" data-action="cap-nhat-hop-hd">📝 Cập nhật thông tin họp HĐ KHCN</button>';
                    html += '<button type="button" class="btn-action" data-step="5" data-action="lap-bien-ban">📤 Upload Biên bản họp Hội đồng</button>';
                    html += '<button type="button" class="btn-action' + (revSt ? ' is-disabled' : '') + '" data-step="5" data-action="council-pass-hd"' + (revSt ? ' disabled title="Đang có vòng chỉnh sửa chưa đóng"' : '') + '>✅ Hội đồng KHCN thông qua</button>';
                    html += '<button type="button" class="btn-action btn-secondary' + (revSt ? ' is-disabled' : '') + '" data-step="5" data-action="council-request-revision"' + (revSt ? ' disabled title="Hoàn tất vòng hiện tại trước"' : '') + '>⚠️ Yêu cầu chỉnh sửa theo góp ý Hội đồng</button>';
                    html += '</div>';
                    if (data.step5_council_revision_note && revSt === 'waiting_researcher') {
                        html += '<div style="margin-top:10px;font-size:12px;color:#475569"><strong>Góp ý hiện tại:</strong> <span style="white-space:pre-wrap">' + escapeHtml(data.step5_council_revision_note) + '</span>';
                        if (data.step5_council_revision_requested_at) {
                            html += '<br><em style="color:#64748b">' + escapeHtml(data.step5_council_revision_requested_at) + (data.step5CouncilRevisionRequestedByName ? ' — ' + escapeHtml(data.step5CouncilRevisionRequestedByName) : '') + '</em>';
                        }
                        html += '</div>';
                    }
                } else {
                    html += '<p style="margin:0;font-size:13px;color:#64748b">Hồ sơ đã chuyển khỏi giai đoạn này (trạng thái: ' + escapeHtml(st5) + ').</p>';
                }
                html += '</div>';
            } else if (revSt === 'waiting_researcher' && data.step5_council_revision_note) {
                html += '<div class="action-zone action-zone-secretary"><h5 class="action-zone-title">📋 Góp ý Hội đồng (vòng ' + revRound + ')</h5>';
                html += '<div class="alert-box alert-warning" style="margin:0"><span style="font-size:16px">📌</span><div style="white-space:pre-wrap">' + escapeHtml(data.step5_council_revision_note) + '</div></div></div>';
            }

            if (revSt === 'waiting_researcher' && step5OnTrack && (isOwner5 || isAdmin5)) {
                html += '<div class="action-zone action-zone-owner action-zone-owner--attention"><h5 class="action-zone-title">👤 Khu vực Chủ nhiệm đề tài</h5>';
                html += '<div class="alert-box alert-info" style="margin:0 0 10px"><span style="font-size:16px">ℹ️</span><div>Nộp hồ sơ chỉnh sửa theo góp ý Hội đồng <strong>(vòng ' + revRound + ')</strong>. Sau khi lưu, có thể tải file ở mục «Hồ sơ chỉnh sửa theo góp ý Hội đồng» phía trên.</div></div>';
                if (data.step5_council_revision_note && !canSecretary) {
                    html += '<div style="margin:0 0 10px;padding:10px 12px;background:#fffbeb;border-radius:8px;font-size:13px;border:1px solid #fcd34d"><strong>Góp ý:</strong> <span style="white-space:pre-wrap">' + escapeHtml(data.step5_council_revision_note) + '</span></div>';
                }
                html += '<div class="stage-actions"><button type="button" class="btn-action" data-step="5" data-action="council-revision-upload">📤 Nộp / cập nhật hồ sơ chỉnh sửa</button></div></div>';
            }

            if (revSt === 'waiting_chair' && step5OnTrack && canChairAct) {
                html += '<div class="action-zone action-zone-chair"><h5 class="action-zone-title">🏛️ Khu vực Chủ tịch Hội đồng KHCN</h5>';
                html += '<div class="stage-actions" style="display:flex;flex-wrap:wrap;gap:8px">';
                html += '<button type="button" class="btn-action" data-step="5" data-action="chair-approve-revision">✅ Thông qua bản chỉnh sửa</button>';
                html += '<button type="button" class="btn-action btn-secondary" data-step="5" data-action="chair-request-more">⚠️ Yêu cầu chỉnh sửa tiếp</button>';
                html += '</div></div>';
            }

            if (isAdmin5 && stepsDone >= 5) {
                html += '<div class="stage-actions" style="margin-top:10px"><button type="button" class="btn-action btn-secondary" data-step="5" data-action="revert-to-4">↩ Đưa về Bước 4 (Admin)</button></div>';
            }

            html += '</div>';

            if (isAdmin5) {
                html += '<div class="admin-unified-tools">';
                html += '<div class="admin-tools-title">Công cụ Admin (dev)</div>';
                html += '<div class="stage-actions admin-tools-row">';
                html += '<button type="button" class="btn-action btn-secondary" data-step="5" data-action="dev-reset-5">♻️ Reset Bước 5 (dev)</button>';
                html += '</div>';
                html += '<div class="admin-deadline-subzone"></div>';
                html += '</div>';
            }
            html += templateHint(5) + '</div></div>';
        })();

        (function(){ var s=getStepState(6,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="6"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 6: Cấp Quyết định phê duyệt</h3><div class="stage-subtitle"><span>👤 Phòng KHCN · Thư ký HĐKHCN · Viện trưởng</span><span class="stage-duration">' + formatStepActualDuration('6', 'Quy định: 3-5 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">📎 Phòng KHCN lưu bản scan Quyết định (VN/EN)</div><div class="event-time">' + step6TimeHdr + '</div></div><div class="event-content"><strong>Số QĐ:</strong> ' + timelineField(data.step6_so_qd) + '<br><strong>Kinh phí:</strong> ' + timelineField(data.step6_kinh_phi) + '<br><strong>Thời gian:</strong> ' + timelineField(data.step6_thoi_gian) + '<br><strong>Phí quản lý:</strong> ' + timelineField(data.step6_phi_quan_ly);
        if (data.step6MetaUpdatedByName) {
            html += '<br><span style="font-size:0.85em;color:#546e7a">Cập nhật bởi: ' + escapeHtml(data.step6MetaUpdatedByName) + '</span>';
        }
        html += '</div></div></div>';
        html += step6EditorHtml;
        html += '<div class="files-section"><div class="files-title">📎 Bản scan Quyết định trong hồ sơ (VN + EN):</div><div class="file-list">' + step6RowVn + step6RowEn + '</div></div>';
        (function() {
            var step6Btns = [];
            if (canEditStep6 && status === 'CONDITIONAL') {
                step6Btns.push({ label: 'Hoàn thành', action: 'hoan-thanh' });
            }
            var u = {};
            try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) {}
            if (u.role === 'admin' && stepsDone >= 6) step6Btns.push({ label: '↩ Đưa về Bước 5 (Admin)', action: 'revert-to-5', className: 'btn-secondary' });
            html += actionButtons(6, step6Btns) + '</div></div>';
        })();

        // ===== GIAI ĐOẠN 2 =====
        html += '<div class="phase-header"><h3>📝 GIAI ĐOẠN 2: KÝ HỢP ĐỒNG VÀ TRIỂN KHAI</h3></div>';

        var step7Row = (step7F && step7F.id)
            ? ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(step7F.originalName || 'Hợp đồng KHCN') + '</div><div class="file-meta">' + escapeHtml(fileUploaderLabel(step7F)) + (step7F.uploadedAt ? ' • ' + escapeHtml(step7F.uploadedAt) : '') + '</div></div></div><button type="button" class="btn-download-file" data-fid="' + step7F.id + '">📥 Tải về</button></div>')
            : ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">Chưa có Hợp đồng KHCN trong hồ sơ</div><div class="file-meta">—</div></div></div><button type="button" class="btn-download-file" disabled title="Chưa có file">📥 Tải về</button></div>');
        var canEditStep7Meta = canEditStep7 && (status === 'APPROVED' || status === 'CONTRACTED');
        var step7EditorHtml = '';
        if (canEditStep7Meta) {
            step7EditorHtml = '<div class="step7-editor" style="margin-top:14px;padding:14px;background:#f5f9ff;border-radius:10px;border:1px solid #90caf9;max-width:820px">' +
                '<div style="font-weight:700;margin-bottom:10px;color:#1565c0">P. KHCN / Thư ký HĐKHCN / Admin — thông tin Hợp đồng</div>' +
                '<p style="margin:0 0 10px 0;font-size:0.88rem;color:#455a64">Điền <strong>Số HĐ</strong> và <strong>Hiệu lực</strong> (có thể ghi khoảng thời gian hoặc một dòng mô tả). Nhấn <strong>Lưu</strong> để cập nhật; có thể chỉnh sửa lại nhiều lần khi hồ sơ ở Bước 7 hoặc ngay sau khi hoàn thành Bước 7.</p>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Số HĐ<br><input type="text" id="step7-input-so-hd" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step7_so_hd) + '"></label></div>' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Hiệu lực<br><input type="text" id="step7-input-hieu-luc" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" placeholder="VD: 01/01/2026 – 31/12/2028" value="' + escAttr(data.step7_hieu_luc) + '"></label></div>' +
                '</div>' +
                '<button type="button" class="btn-action btn-primary btn-step7-save-meta" style="margin-top:12px">💾 Lưu thông tin Hợp đồng</button>';
            if (data.step7MetaUpdatedByName) {
                step7EditorHtml += '<div style="margin-top:8px;font-size:0.82rem;color:#546e7a">Cập nhật gần nhất: ' + escapeHtml(data.step7MetaUpdatedByName) + (data.step7_meta_updated_at ? ' • ' + escapeHtml(String(data.step7_meta_updated_at)) : '') + '</div>';
            }
            step7EditorHtml += '</div>';
        }
        (function(){ var s=getStepState(7,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="7"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 7: Ký hợp đồng thực hiện</h3><div class="stage-subtitle"><span>✍️ Viện trưởng & Chủ nhiệm · P. KHCN lưu Hợp đồng</span><span class="stage-duration">' + formatStepActualDuration('7', 'Quy định: 7-10 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">📝 Soạn thảo hợp đồng</div><div class="event-time">—</div></div><div class="event-content">Phòng KHCN soạn thảo hợp đồng dựa trên Quyết định</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Chủ nhiệm kiểm tra</div><div class="event-time">—</div></div><div class="event-content">Chủ nhiệm xác nhận nội dung hợp đồng</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">✍️ Ký kết hợp đồng</div><div class="event-time">—</div></div><div class="event-content"><strong>Bên A:</strong> Viện Tế bào gốc (Viện trưởng ký)<br><strong>Bên B:</strong> ' + escapeHtml(chunhiem) + ' (Chủ nhiệm)<br><strong>Số HĐ:</strong> ' + timelineField(data.step7_so_hd) + '<br><strong>Hiệu lực:</strong> ' + timelineField(data.step7_hieu_luc) + '</div></div></div>';
        html += step7EditorHtml;
        html += '<div class="files-section"><div class="files-title">📎 Hợp đồng KHCN đã lưu trong hồ sơ (mẫu: <a href="' + escapeHtml(TAI_MAU_URL) + '" target="_blank">tải mẫu hồ sơ</a>)</div><div class="file-list">' + step7Row + '</div></div>';
        if (canEditStep7 && status === 'APPROVED') {
            html += '<div style="margin-top:12px;max-width:820px"><button type="button" class="btn-action btn-primary btn-step7-open-upload">P. KHCN upload Hợp đồng KHCN</button></div>';
        }
        (function(){ var step7Btns = []; if (canEditStep7 && status === 'APPROVED') { step7Btns.push({ label: 'Hoàn thành', action: 'hoan-thanh' }); } var u = {}; try { u = JSON.parse(localStorage.getItem('user') || '{}'); } catch(e) {}; if (u.role === 'admin' && stepsDone >= 7) step7Btns.push({ label: '↩ Đưa về Bước 6 (Admin)', action: 'revert-to-6', className: 'btn-secondary' }); html += actionButtons(7, step7Btns) + '</div></div>'; })();

        var step8Row = (step8F && step8F.id)
            ? ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">' + escapeHtml(step8F.originalName || 'Quyết định đạo đức') + '</div><div class="file-meta">' + escapeHtml(fileUploaderLabel(step8F)) + (step8F.uploadedAt ? ' • ' + escapeHtml(step8F.uploadedAt) : '') + '</div></div></div><button type="button" class="btn-download-file" data-fid="' + step8F.id + '">📥 Tải về</button></div>')
            : ('<div class="file-item"><div class="file-info"><span class="file-icon">📄</span><div class="file-details"><div class="file-name">Chưa có Quyết định đạo đức trong hồ sơ</div><div class="file-meta">—</div></div></div><button type="button" class="btn-download-file" disabled title="Chưa có file">📥 Tải về</button></div>');
        var canEditStep8Workflow = canEditStep8 && status === 'CONTRACTED' && !step8Resolved;
        var step8EditorHtml = '';
        if (canEditStep8Workflow) {
            step8EditorHtml = '<div class="step8-editor" style="margin-top:14px;padding:14px;background:#f1f8f4;border-radius:10px;border:1px solid #a5d6a7;max-width:820px">' +
                '<div style="font-weight:700;margin-bottom:10px;color:#2e7d32">P. KHCN / Thư ký HĐKHCN / Admin — thông tin cấp mã đạo đức</div>' +
                '<p style="margin:0 0 10px 0;font-size:0.88rem;color:#455a64">Nhập <strong>Mã đạo đức</strong>, <strong>Hiệu lực</strong>, <strong>Số / ký hiệu Quyết định</strong>. Nhấn <strong>Lưu</strong>. Upload Quyết định bên dưới; sau đó nhấn <strong>Hoàn thành</strong> khi đủ điều kiện (giống Bước 6).</p>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Mã đạo đức<br><input type="text" id="step8-input-ma" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step8_ma_dao_duc) + '"></label></div>' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Hiệu lực<br><input type="text" id="step8-input-hieu-luc" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" placeholder="VD: đến 31/12/2028" value="' + escAttr(data.step8_hieu_luc) + '"></label></div>' +
                '<div style="grid-column:1/-1"><label style="font-size:0.85rem;font-weight:600">Số / ký hiệu Quyết định<br><input type="text" id="step8-input-so-qd" style="width:100%;box-sizing:border-box;padding:8px;border:2px solid #dee2e6;border-radius:8px" value="' + escAttr(data.step8_so_quyet_dinh) + '"></label></div>' +
                '</div>' +
                '<button type="button" class="btn-action btn-primary btn-step8-save-meta" style="margin-top:12px">💾 Lưu thông tin đạo đức</button>';
            if (data.step8MetaUpdatedByName) {
                step8EditorHtml += '<div style="margin-top:8px;font-size:0.82rem;color:#546e7a">Cập nhật gần nhất: ' + escapeHtml(data.step8MetaUpdatedByName) + (data.step8_meta_updated_at ? ' • ' + escapeHtml(String(data.step8_meta_updated_at)) : '') + '</div>';
            }
            step8EditorHtml += '</div>';
        }
        var step8CardSt = getStepState(8, stepsDone);
        if (step8Resolved && step8CardSt === 'active') step8CardSt = 'completed';
        var step8HdrBadgeClass = stageBadge(step8CardSt);
        var step8HdrBadgeTxt = (step8Waived && !step8Done) ? '⊘ Không áp dụng' : stageBadgeTxt(step8CardSt);
        (function(){ var s=step8CardSt; html+='<div class="stage-card '+stageClass(s)+'" data-step="8"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 8: Đăng ký đạo đức</h3><div class="stage-subtitle"><span>⚖️ Hội đồng Đạo đức · P. KHCN cập nhật hồ sơ</span><span class="stage-duration">' + formatStepActualDuration('8', 'Quy định: 14-21 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+step8HdrBadgeClass+'">'+step8HdrBadgeTxt+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="stage-timeline"><div class="timeline-event"><div class="event-header"><div class="event-title">📝 Nộp hồ sơ đạo đức</div><div class="event-time">—</div></div><div class="event-content">Đăng ký thí nghiệm theo quy định</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔍 Hội đồng xem xét</div><div class="event-time">—</div></div><div class="event-content">Họp Hội đồng Đạo đức Viện Tế bào gốc</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">✅ Cấp mã đạo đức</div><div class="event-time">—</div></div><div class="event-content"><strong>Mã đạo đức:</strong> ' + timelineField(data.step8_ma_dao_duc) + '<br><strong>Hiệu lực:</strong> ' + timelineField(data.step8_hieu_luc) + '<br><strong>Quyết định:</strong> ' + timelineField(data.step8_so_quyet_dinh) + '</div></div></div>';
        if (step8Waived && !step8Done) {
            html += '<div class="alert-box alert-info" style="margin-top:12px;max-width:820px"><span style="font-size:20px">ℹ️</span><div><strong>Admin đã bất hoạt bước này:</strong> đăng ký đạo đức không áp dụng cho đề tài theo quyết định quản trị.</div></div>';
        }
        html += step8EditorHtml;
        html += '<div class="files-section"><div class="files-title">📎 Quyết định đạo đức (1 file):</div><div class="file-list">' + step8Row + '</div></div>';
        if (canEditStep8Workflow) {
            html += '<div style="margin-top:12px;max-width:820px"><button type="button" class="btn-action btn-primary btn-step8-open-upload">P. KHCN upload Quyết định đạo đức</button></div>';
        }
        (function(){
            var step8Btns = [];
            if (canEditStep8Workflow) {
                step8Btns.push({ label: 'Hoàn thành', action: 'hoan-thanh' });
                step8Btns.push({ label: '📝 Mở form nộp đạo đức', action: 'nop-dao-duc', className: 'btn-secondary' });
            } else if (status === 'CONTRACTED' && step8Done) {
                step8Btns.push({ label: '📝 Mở form nộp đạo đức', action: 'nop-dao-duc', className: 'btn-secondary' });
            }
            var u8 = {};
            try { u8 = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) {}
            var u8Role = String(u8.role || '').toLowerCase();
            if (u8Role === 'admin' && stepsDone >= 8) step8Btns.push({ label: '↩ Đưa về Bước 7 (Admin)', action: 'revert-to-7', className: 'btn-secondary' });
            html += actionButtons(8, step8Btns);
            if (u8Role === 'admin') {
                html += '<div class="admin-unified-tools" style="margin-top:14px">';
                html += '<div class="admin-tools-title">Công cụ Admin (dev)</div>';
                if (status === 'CONTRACTED' && !step8Resolved) {
                    html += '<div class="stage-actions admin-tools-row" style="display:flex;flex-wrap:wrap;gap:8px">';
                    html += '<button type="button" class="btn-action btn-secondary" data-step="8" data-action="admin-bypass">⏭ Bypass Bước 8 (hoàn thành thủ công)</button>';
                    html += '<button type="button" class="btn-action btn-secondary" data-step="8" data-action="admin-waive">⊘ Bất hoạt Bước 8 (không áp dụng)</button>';
                    html += '</div>';
                }
                html += '<div class="admin-deadline-subzone"></div>';
                html += '</div>';
            }
            html += '</div></div>';
        })();

        // ===== GIAI ĐOẠN 3 =====
        html += '<div class="phase-header"><h3>⚙️ GIAI ĐOẠN 3: THỰC HIỆN VÀ BÁO CÁO</h3></div>';

        (function(){ var s=getStepState(9,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="9"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 9: Thực hiện đề tài</h3><div class="stage-subtitle"><span>👥 Nhóm nghiên cứu</span><span class="stage-duration">' + formatStepActualDuration('9', null) + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="alert-box alert-info"><span style="font-size:20px">ℹ️</span><div><strong>Tiến độ hiện tại:</strong> —<br><strong>Hoạt động chính:</strong> —<br><strong>Kế hoạch tiếp theo:</strong> —</div></div>';
        html += '<div class="stage-timeline"><div class="timeline-event success"><div class="event-header"><div class="event-title">🛒 Mua sắm thiết bị</div><div class="event-time">—</div></div><div class="event-content">—</div></div><div class="timeline-event success"><div class="event-header"><div class="event-title">🧬 Tách chiết tế bào gốc</div><div class="event-time">—</div></div><div class="event-content">—</div></div><div class="timeline-event"><div class="event-header"><div class="event-title">🔬 Thử nghiệm / Tuyển bệnh nhân</div><div class="event-time">—</div></div><div class="event-content">—</div></div></div>';
        html += '<div class="files-section"><div class="files-title">📎 Lab notebook & Dữ liệu:</div><div class="file-list"><div class="file-item"><div class="file-info"><span class="file-icon">📊</span><div class="file-details"><div class="file-name">Lab_notebook.pdf</div><div class="file-meta">—</div></div></div><button class="btn-download-file">📥 Tải về</button></div></div></div>';
        html += actionButtons(9, [{ label: '📊 Cập nhật tiến độ', action: 'cap-nhat-tien-do' }]) + '</div></div>';

        var prData = data.periodicReport || {};
        var prPeriods = prData.periods || [];
        var prPrimary = prData.primaryFiles || {};
        var prCfg = prData.config;
        var periodicAllTerminal = prPeriods.length > 0 && prPeriods.every(function(p) {
            var sl = String(p.status || '').toLowerCase();
            return sl === 'submitted' || sl === 'waived' || sl === 'bypassed';
        });
        var canPeriodicUpload = ['IMPLEMENTATION', 'COMPLETED'].indexOf(status) >= 0;
        (function() {
            var s = getStepState(10, stepsDone);
            if (periodicAllTerminal) s = 'completed';
            html += '<div class="stage-card ' + stageClass(s) + '" data-step="10"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">' + stageIcon(s) + '</div><div class="stage-info"><h3>Bước 10: Báo cáo tiến độ định kỳ (các kỳ)</h3><div class="stage-subtitle"><span>📊 Chủ nhiệm / P.KHCN — mỗi kỳ một báo cáo</span><span class="stage-duration">' + formatStepActualDuration('10', 'Theo cấu hình kỳ') + '</span></div></div></div><div class="stage-status"><span class="stage-badge ' + stageBadge(s) + '">' + stageBadgeTxt(s) + '</span><span class="expand-icon">▼</span></div></div>';
        })();
        html += '<div class="stage-content">';
        if (prCfg) {
            html += '<div class="alert-box alert-info" style="margin-bottom:12px;max-width:920px"><span style="font-size:20px">📅</span><div><strong>Cấu hình:</strong> chu kỳ <strong>' + escapeHtml(String(prCfg.cycleMonths != null ? prCfg.cycleMonths : '—')) + '</strong> tháng • neo <code style="font-size:0.85em">' + escapeHtml(String(prCfg.anchorType || '—')) + '</code>' + (prCfg.pauseReportClock ? ' • <em>đóng băng hạn</em>' : '') + '</div></div>';
        }
        html += '<div class="stage-timeline">';
        if (!prPeriods.length) {
            html += '<div class="timeline-event"><div class="event-header"><div class="event-title">Chưa có kỳ báo cáo</div><div class="event-time">—</div></div><div class="event-content">Admin dùng <strong>Cấu hình chu kỳ BC</strong> rồi <strong>Tính lại kỳ</strong> (hoặc <strong>Thêm kỳ thủ công</strong>) để tạo kỳ.</div></div>';
        }
        prPeriods.forEach(function(p) {
            var stP = String(p.status || '').toLowerCase();
            var evCls = (stP === 'submitted' || stP === 'waived' || stP === 'bypassed') ? 'timeline-event success' : 'timeline-event';
            var f = prPrimary[p.id] || null;
            var fname = f ? escapeHtml(f.originalName || 'file') : '—';
            var meta = f ? (escapeHtml(fileUploaderLabel(f)) + (f.uploadedAt ? ' • ' + escapeHtml(f.uploadedAt) : '')) : 'Chưa nộp file';
            var dl = p.dueAt ? fmtDateTime(p.dueAt) : '—';
            html += '<div class="' + evCls + '"><div class="event-header"><div class="event-title">Kỳ #' + escapeHtml(String(p.seq)) + (p.label ? ': ' + escapeHtml(p.label) : '') + '</div><div class="event-time">Hạn: ' + escapeHtml(dl) + '</div></div><div class="event-content"><strong>Trạng thái:</strong> ' + escapeHtml(stP || '—') + ' • <strong>periodId:</strong> ' + escapeHtml(String(p.id)) + '<br><strong>File:</strong> ' + fname + '<br><span style="font-size:0.9em;color:#546e7a">' + meta + '</span>';
            if (f && f.id) {
                html += '<div style="margin-top:8px"><button type="button" class="btn-download-file btn-sm" data-fid="' + escapeHtml(String(f.id)) + '">📥 Tải báo cáo kỳ</button></div>';
            }
            html += '</div></div>';
        });
        html += '</div>';
        var step10Btns = [];
        if (canPeriodicUpload) step10Btns.push({ label: '📄 Nộp / thay file báo cáo (chọn kỳ)', action: 'nop-bao-cao' });
        html += actionButtons(10, step10Btns) + templateHint(10);
        if (isAdmin) {
            html += '<div class="admin-unified-tools" style="margin-top:14px">';
            html += '<div class="admin-tools-title">Công cụ Admin — báo cáo tiến độ định kỳ (Bước 10)</div>';
            html += '<div class="stage-actions admin-tools-row" style="display:flex;flex-wrap:wrap;gap:8px">';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="set_cycle" title="Thiết lập số tháng mỗi kỳ, neo ngày (post_step7 / contract_start / custom_date) và lệch deadline">⚙️ Cấu hình chu kỳ BC</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="preview_schedule" title="Xem trước danh sách kỳ và hạn (không lưu DB)">👁 Xem trước lịch kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="apply_recalc" title="Tạo lại danh sách kỳ theo cấu hình — cẩn thận với xóa toàn bộ kỳ">🔄 Tính lại kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="insert_period" title="Thêm một kỳ báo cáo với hạn và nhãn tùy chọn">➕ Thêm kỳ thủ công</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="delete_period" title="Xóa mềm một kỳ (thường chỉ khi kỳ chưa có file)">🗑 Xóa kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="waive_period" title="Đánh dấu kỳ không bắt buộc nộp BC (cần ghi chú)">⊘ Miễn trừ kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="bypass_submit" title="Đánh dấu kỳ đã hoàn thành không cần file (Admin)">⏭ Bypass nộp kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="detach_file" title="Gỡ file báo cáo đã đính vào một kỳ">📤 Gỡ file khỏi kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="move_file" title="Chuyển file từ kỳ này sang kỳ khác">↔ Chuyển file giữa kỳ</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="freeze_deadlines" title="Tạm dừng đếm hạn (đóng băng) — có thể đặt đến ngày">❄️ Đóng băng hạn</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="unfreeze_deadlines" title="Bật lại đếm hạn bình thường">☀️ Bỏ đóng băng hạn</button>';
            html += '<button type="button" class="btn-action btn-secondary" data-periodic-action="resend_reminder" title="Gửi lại email nhắc (một kỳ hoặc chung)">✉️ Gửi lại nhắc</button>';
            html += '</div>';
            html += '<details class="periodic-admin-help" style="margin-top:12px;font-size:0.88rem;max-width:920px;line-height:1.5">';
            html += '<summary style="cursor:pointer;font-weight:600;color:#1565c0;user-select:none">📖 Hướng dẫn chi tiết từng nút (Admin)</summary>';
            html += '<div style="margin-top:10px;padding:12px 14px;border:1px solid #bbdefb;border-radius:10px;background:#f5f9ff">';
            html += '<ul style="margin:0;padding-left:1.2rem">';
            html += '<li><strong>Cấu hình chu kỳ BC</strong> — Lưu quy tắc: bao nhiêu tháng một kỳ, neo từ đâu (<code>post_step7</code> sau Bước 7, <code>contract_start</code> theo HĐ, <code>custom_date</code> kèm ngày ISO), và số ngày lệch deadline. Thường làm <em>trước</em> khi tính lại kỳ.</li>';
            html += '<li><strong>Xem trước lịch kỳ</strong> — Chỉ hiển thị (alert JSON) N kỳ tương lai, <em>không ghi</em> CSDL. Dùng để kiểm tra trước khi bấm «Tính lại kỳ».</li>';
            html += '<li><strong>Tính lại kỳ</strong> — Sinh lại danh sách kỳ theo cấu hình hiện tại. Có bước xác nhận; tùy chọn <strong>xóa toàn bộ kỳ cũ</strong> (nguy hiểm nếu đã có file đính kèm). Nhập số lượng kỳ cần tạo.</li>';
            html += '<li><strong>Thêm kỳ thủ công</strong> — Thêm <em>một</em> kỳ: nhập <code>dueAt</code> dạng ISO, nhãn tùy chọn, và (nếu cần) ngày bắt đầu kỳ.</li>';
            html += '<li><strong>Xóa kỳ</strong> — Xóa mềm theo <code>periodId</code> (xem trong danh sách kỳ). Chỉ phù hợp kỳ chưa có file / theo quy định máy chủ.</li>';
            html += '<li><strong>Miễn trừ kỳ</strong> — Kỳ không phải nộp BC (waived). Bắt buộc nhập <code>periodId</code> và <strong>ghi chú</strong>.</li>';
            html += '<li><strong>Bypass nộp kỳ</strong> — Đánh dấu kỳ hoàn thành <em>không cần file</em>. Bắt buộc <code>periodId</code> và ghi chú. Khác «Miễn trừ» ở trạng thái nghiệp vụ — dùng khi đã chốt không thu file nhưng cần đóng kỳ.</li>';
            html += '<li><strong>Gỡ file khỏi kỳ</strong> — Bỏ file báo cáo đang gắn với kỳ (để upload lại hoặc chỉnh). Nhập <code>periodId</code>.</li>';
            html += '<li><strong>Chuyển file giữa kỳ</strong> — Nhập <code>fromPeriodId</code> và <code>toPeriodId</code> để gán lại file sang kỳ đích.</li>';
            html += '<li><strong>Đóng băng hạn</strong> — Tạm dừng «đồng hồ» hạn (theo cấu hình hệ thống); có thể nhập đến ngày <code>pausedUntil</code> (ISO) và lý do. Dùng kỳ nghỉ, xử lý sự cố.</li>';
            html += '<li><strong>Bỏ đóng băng hạn</strong> — Khôi phục tính hạn bình thường, một bước.</li>';
            html += '<li><strong>Gửi lại nhắc</strong> — Gửi email nhắc nộp BC. Có thể để trống kỳ (áp dụng chung) hoặc nhập <code>periodId</code>; thêm ghi chú để lưu nhật ký.</li>';
            html += '</ul>';
            html += '<p style="margin:12px 0 0;font-size:0.84rem;color:#546e7a"><strong>Lưu ý:</strong> Mã API gốc (set_cycle, …) vẫn được gửi tới máy chủ; chỉ nhãn hiển thị đổi sang tiếng Việt.</p>';
            html += '</div></details>';
            if (prData.adminLog && prData.adminLog.length) {
                html += '<div style="margin-top:12px;font-size:0.82rem;max-height:180px;overflow:auto;border:1px solid #e0e0e0;border-radius:8px;padding:8px;background:#fafafa"><strong>Nhật ký admin (gần nhất):</strong><ul style="margin:8px 0 0 18px;padding:0">';
                prData.adminLog.slice(0, 12).forEach(function(log) {
                    html += '<li>' + escapeHtml(log.performedAt || '') + ' — <code>' + escapeHtml(log.actionType || '') + '</code>' + (log.note ? ' — ' + escapeHtml(log.note) : '') + '</li>';
                });
                html += '</ul></div>';
            }
            html += '<div class="admin-deadline-subzone"></div></div>';
        }
        html += '</div></div>';

        (function(){ var s=getStepState(11,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="11"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 11: Điều chỉnh nội dung/nhân sự (nếu cần)</h3><div class="stage-subtitle"><span>📝 Chủ nhiệm đề xuất</span><span class="stage-duration">' + formatStepActualDuration('11', 'Khi cần thiết') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div style="padding:30px;text-align:center;color:#999"><div style="font-size:48px;margin-bottom:10px">✏️</div><div style="font-size:14px">Bước này chỉ kích hoạt khi cần điều chỉnh:<br>• Thay đổi nhân sự chính<br>• Điều chỉnh kế hoạch nghiên cứu<br>• Thay đổi dự toán (±10%)<br>• Gia hạn thời gian</div></div>';
        html += actionButtons(11, [{ label: '✏️ Đề xuất điều chỉnh', action: 'de-xuat-dieu-chinh' }]) + templateHint(11) + '</div></div>';

        // ===== GIAI ĐOẠN 4 =====
        html += '<div class="phase-header"><h3>🎯 GIAI ĐOẠN 4: NGHIỆM THU</h3></div>';

        (function(){ var s=getStepState(12,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="12"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 12: Nộp hồ sơ nghiệm thu</h3><div class="stage-subtitle"><span>👤 Chủ nhiệm</span><span class="stage-duration">' + formatStepActualDuration('12', 'Dự kiến: 01/04/2027') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
        html += '<div class="stage-content"><div class="alert-box alert-info"><span style="font-size:20px">📋</span><div><strong>Hồ sơ nghiệm thu:</strong> Báo cáo tổng kết, Báo cáo tài chính, Sản phẩm (bài báo ISI/Scopus), Tóm tắt tiếng Anh.</div></div>';
        html += actionButtons(12, [{ label: '📄 Nộp hồ sơ nghiệm thu', action: 'nop-nghiem-thu' }]) + templateHint(12) + '</div></div>';

        (function(){ var s=getStepState(13,stepsDone); html+='<div class="stage-card '+stageClass(s)+'" data-step="13"><div class="stage-header" onclick="toggleStage(this)"><div class="stage-left"><div class="stage-icon">'+stageIcon(s)+'</div><div class="stage-info"><h3>Bước 13-14: Phản biện nghiệm thu</h3><div class="stage-subtitle"><span>👥 2 Phản biện</span><span class="stage-duration">' + formatStepActualDuration('13', 'Quy định: 10-14 ngày') + '</span></div></div></div><div class="stage-status"><span class="stage-badge '+stageBadge(s)+'">'+stageBadgeTxt(s)+'</span><span class="expand-icon">▼</span></div></div>'; })();
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
            applyStepDeadlinesUI(data);

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

            var btnStep6Save = contentEl.querySelector('.btn-step6-save-meta');
            if (btnStep6Save) {
                btnStep6Save.addEventListener('click', function() {
                    var body = {
                        soQd: (document.getElementById('step6-input-so-qd') && document.getElementById('step6-input-so-qd').value) || '',
                        kinhPhi: (document.getElementById('step6-input-kinh-phi') && document.getElementById('step6-input-kinh-phi').value) || '',
                        thoiGian: (document.getElementById('step6-input-thoi-gian') && document.getElementById('step6-input-thoi-gian').value) || '',
                        phiQuanLy: (document.getElementById('step6-input-phi-quan-ly') && document.getElementById('step6-input-phi-quan-ly').value) || ''
                    };
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/6/decision-meta', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(body)
                    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                        .then(function(res) {
                            if (res.ok) {
                                alert(res.data.message || 'Đã lưu.');
                                reloadKeepingTimelineStep('6');
                            } else {
                                alert(res.data.message || 'Không lưu được.');
                            }
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                });
            }
            var btnStep6OpenUp = contentEl.querySelector('.btn-step6-open-upload');
            if (btnStep6OpenUp) {
                btnStep6OpenUp.addEventListener('click', function() { showStep6DecisionUploadDialog(); });
            }
            var btnStep7OpenUp = contentEl.querySelector('.btn-step7-open-upload');
            if (btnStep7OpenUp) {
                btnStep7OpenUp.addEventListener('click', function() { showStep7ContractUploadDialog(); });
            }
            var btnStep7SaveMeta = contentEl.querySelector('.btn-step7-save-meta');
            if (btnStep7SaveMeta) {
                btnStep7SaveMeta.addEventListener('click', function() {
                    var body = {
                        soHd: (document.getElementById('step7-input-so-hd') && document.getElementById('step7-input-so-hd').value) || '',
                        hieuLuc: (document.getElementById('step7-input-hieu-luc') && document.getElementById('step7-input-hieu-luc').value) || ''
                    };
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/7/contract-meta', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(body)
                    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                        .then(function(res) {
                            if (res.ok) {
                                alert(res.data.message || 'Đã lưu.');
                                reloadKeepingTimelineStep('7');
                            } else {
                                alert(res.data.message || 'Không lưu được.');
                            }
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                });
            }
            var btnStep8OpenUp = contentEl.querySelector('.btn-step8-open-upload');
            if (btnStep8OpenUp) {
                btnStep8OpenUp.addEventListener('click', function() { showStep8EthicsUploadDialog(); });
            }
            var btnStep8SaveMeta = contentEl.querySelector('.btn-step8-save-meta');
            if (btnStep8SaveMeta) {
                btnStep8SaveMeta.addEventListener('click', function() {
                    var body = {
                        maDaoDuc: (document.getElementById('step8-input-ma') && document.getElementById('step8-input-ma').value) || '',
                        hieuLuc: (document.getElementById('step8-input-hieu-luc') && document.getElementById('step8-input-hieu-luc').value) || '',
                        soQuyetDinh: (document.getElementById('step8-input-so-qd') && document.getElementById('step8-input-so-qd').value) || ''
                    };
                    fetch(apiBase + '/api/cap-vien/submissions/' + id + '/steps/8/ethics-meta', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify(body)
                    }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
                        .then(function(res) {
                            if (res.ok) {
                                alert(res.data.message || 'Đã lưu.');
                                reloadKeepingTimelineStep('8');
                            } else {
                                alert(res.data.message || 'Không lưu được.');
                            }
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                });
            }

            contentEl.querySelectorAll('.btn-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var pAct = this.getAttribute('data-periodic-action');
                    if (pAct) {
                        execPeriodicAdminAction(pAct);
                        return;
                    }
                    var step = this.getAttribute('data-step');
                    var action = this.getAttribute('data-action');
                    if (step == null || step === '' || action == null || action === '') return;
                    execAction(step, action);
                });
            });
            contentEl.querySelectorAll('.btn-deadline-action').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var step = this.getAttribute('data-step');
                    var act = this.getAttribute('data-deadline-action');
                    if (!step || !act) return;
                    if (act === 'set-days') {
                        var d = prompt('Đặt thời hạn hoàn thành bước (số ngày kể từ lúc mở bước):', '7');
                        if (d == null) return;
                        var days = parseInt(String(d).trim(), 10);
                        if (!Number.isFinite(days) || days <= 0) { alert('Số ngày không hợp lệ.'); return; }
                        callSetStepDeadline(step, { durationDays: days }).then(function(res) {
                            if (res.ok) reloadKeepingTimelineStep(step);
                            else alert(res.data.message || 'Không đặt được deadline.');
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                        return;
                    }
                    if (act === 'set-datetime') {
                        var v = prompt('Nhập deadline (YYYY-MM-DD HH:mm), ví dụ 2026-04-30 17:00');
                        if (v == null || !String(v).trim()) return;
                        var dueAt = String(v).trim().replace(' ', 'T');
                        callSetStepDeadline(step, { dueAt: dueAt }).then(function(res) {
                            if (res.ok) reloadKeepingTimelineStep(step);
                            else alert(res.data.message || 'Không cập nhật được deadline.');
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                        return;
                    }
                    if (act === 'clear') {
                        if (!confirm('Xóa deadline của bước ' + step + '?')) return;
                        callSetStepDeadline(step, { clear: true }).then(function(res) {
                            if (res.ok) reloadKeepingTimelineStep(step);
                            else alert(res.data.message || 'Không xóa được deadline.');
                        }).catch(function() { alert('Không kết nối được máy chủ.'); });
                    }
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
                            setTimeout(function() { reloadKeepingTimelineStep('2'); }, 1500);
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
                            setTimeout(function() { reloadKeepingTimelineStep('2'); }, 1500);
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
            activeCards.forEach(function(c) { setStageExpanded(c, true, false); });
            applyStoredTimelineScrollStep();
            stickyProgressEl = document.getElementById('sticky-mini-progress');
            refreshStickyTrigger();
            updateFloatingUI();
        })
        .catch(function() {
            contentEl.innerHTML = '<div class="empty-state">Không thể tải thông tin. Vui lòng chạy backend và <a href="theo-doi-de-tai-cap-vien.html">thử lại</a>.</div>';
        });

    window.addEventListener('scroll', updateFloatingUI);
    window.addEventListener('resize', function() {
        refreshStickyTrigger();
        updateFloatingUI();
    });
})();
