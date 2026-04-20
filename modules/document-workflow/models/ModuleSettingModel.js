class ModuleSettingModel {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    const rows = this.db.prepare(`SELECT setting_key, setting_value FROM module_settings`).all();
    const out = {};
    rows.forEach((r) => {
      out[r.setting_key] = r.setting_value;
    });
    return out;
  }

  set(key, value, userId) {
    this.db
      .prepare(
        `INSERT INTO module_settings(setting_key, setting_value, updated_by, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value = excluded.setting_value,
           updated_by = excluded.updated_by,
           updated_at = datetime('now')`
      )
      .run(key, value, userId || null);
  }
}

module.exports = ModuleSettingModel;
