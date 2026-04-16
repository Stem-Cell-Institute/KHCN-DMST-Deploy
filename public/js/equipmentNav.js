(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function hide(id) {
    var n = byId(id);
    if (n) n.classList.add('nav-hidden');
  }

  function show(id) {
    var n = byId(id);
    if (n) n.classList.remove('nav-hidden');
  }

  function applyNav(data) {
    var caps = (data && data.capabilities) || {};
    var assignment = (data && data.assignment) || {};
    var role = String((assignment && assignment.module_role) || '').toLowerCase();
    var isMaster = !!(data && data.isMasterAdmin);

    if (!data || !data.canAccess) {
      hide('nav-add');
      hide('nav-dash');
      hide('nav-permissions');
      hide('btn-add-top');
      hide('btn-permissions-top');
      return;
    }

    if (isMaster || role === 'manager') {
      show('nav-add');
      show('btn-add-top');
    } else {
      hide('nav-add');
      hide('btn-add-top');
    }

    if (isMaster || role === 'manager') show('nav-dash');
    else hide('nav-dash');

    if (isMaster || caps.canManageDepartments || caps.canManagePublicContent || caps.canConfigureViewerFields) {
      show('nav-permissions');
      show('btn-permissions-top');
    } else {
      hide('nav-permissions');
      hide('btn-permissions-top');
    }
  }

  function loadModuleMe() {
    if (!window.equipmentApi || !window.equipmentApi.getJson) return Promise.resolve(null);
    return window.equipmentApi.getJson('/module/me').then(function (r) {
      if (!r.ok) return null;
      return r.data && r.data.data ? r.data.data : null;
    });
  }

  function canOpenEquipmentPermissionsPage(data) {
    if (!data || !data.canAccess) return false;
    if (data.isMasterAdmin) return true;
    var c = data.capabilities || {};
    return !!(c.canManageDepartments || c.canManagePublicContent || c.canConfigureViewerFields);
  }

  window.equipmentNav = {
    sync: function (opts) {
      opts = opts || {};
      return loadModuleMe().then(function (data) {
        applyNav(data);
        if (opts.requireMaster && (!data || !data.isMasterAdmin)) {
          window.location.href = '/public/equipment/index.html';
          return Promise.reject({ code: 'NAV_REDIRECT' });
        }
        if (opts.requirePermissionsPage && !canOpenEquipmentPermissionsPage(data)) {
          window.location.href = '/public/equipment/index.html';
          return Promise.reject({ code: 'NAV_REDIRECT' });
        }
      });
    },
  };
})();
