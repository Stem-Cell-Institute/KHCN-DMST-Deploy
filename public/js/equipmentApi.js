(function () {
  function authHeaders(isJson) {
    var t = '';
    try {
      t = localStorage.getItem('token') || '';
    } catch (e) {}
    var h = {};
    if (isJson) h['Content-Type'] = 'application/json';
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function qsToken() {
    try {
      var t = localStorage.getItem('token');
      return t ? '?token=' + encodeURIComponent(t) : '';
    } catch (e) {
      return '';
    }
  }

  // Bọc mỗi lời gọi API sao cho KHÔNG BAO GIỜ reject (mất kết nối, CORS, JSON lỗi...) — luôn trả về
  // { ok, status, data } để caller chỉ cần kiểm tra r.ok, tránh nút bấm bị "treo" không phản hồi khi mất mạng.
  function toResult(fetchPromise) {
    return fetchPromise
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (j) {
            return { ok: r.ok, status: r.status, data: j };
          });
      })
      .catch(function (err) {
        return { ok: false, status: 0, data: { message: 'Lỗi kết nối mạng: ' + (err && err.message ? err.message : 'không kết nối được máy chủ.') } };
      });
  }

  window.equipmentApi = {
    authHeaders: authHeaders,
    qsToken: qsToken,
    getJson: function (path) {
      return toResult(
        fetch('/api/equipment' + path, {
          headers: authHeaders(true),
          credentials: 'same-origin',
        })
      );
    },
    sendJson: function (method, path, body) {
      return toResult(
        fetch('/api/equipment' + path, {
          method: method,
          headers: authHeaders(true),
          credentials: 'same-origin',
          body: body != null ? JSON.stringify(body) : undefined,
        })
      );
    },
  };
})();
