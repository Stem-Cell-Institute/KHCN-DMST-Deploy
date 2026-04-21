class SettingsRepository {
  constructor(deps) {
    this.db = deps.db;
    this.documentModel = deps.documentModel;
  }

  getAll() {
    return this.documentModel.getModuleSettings();
  }

  get(key, fallback = null) {
    try {
      const row = this.db
        .prepare(`SELECT setting_value FROM module_settings WHERE setting_key = ?`)
        .get(String(key || ''));
      return row && row.setting_value != null ? String(row.setting_value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  set(key, value, userId) {
    return this.documentModel.setModuleSetting(key, value, userId);
  }

  listDocumentTypes() {
    return this.documentModel.listDocumentTypes();
  }

  upsertDocumentType(payload) {
    return this.documentModel.upsertDocumentType(payload);
  }
}

module.exports = {
  SettingsRepository,
};
