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

  window.equipmentApi = {
    authHeaders: authHeaders,
    qsToken: qsToken,
    getJson: function (path) {
      return fetch('/api/equipment' + path, {
        headers: authHeaders(true),
        credentials: 'same-origin',
      }).then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, status: r.status, data: j };
        });
      });
    },
    sendJson: function (method, path, body) {
      return fetch('/api/equipment' + path, {
        method: method,
        headers: authHeaders(true),
        credentials: 'same-origin',
        body: body != null ? JSON.stringify(body) : undefined,
      }).then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, status: r.status, data: j };
        });
      });
    },
  };
})();
