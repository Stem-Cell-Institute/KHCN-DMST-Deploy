'use strict';

/**
 * Repository cho Catalog BC - ModuleSettings + DocumentTypes.
 */
class SettingsRepository {
  constructor(db, documentModel) {
    this.db = db;
    this.model = documentModel;
  }

  getAll() {
    return this.model.getModuleSettings();
  }

  get(key, fallback) {
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
    return this.model.setModuleSetting(key, value, userId);
  }

  listDocumentTypes() {
    return this.model.listDocumentTypes();
  }

  upsertDocumentType(payload) {
    return this.model.upsertDocumentType(payload);
  }
}

module.exports = { SettingsRepository };
