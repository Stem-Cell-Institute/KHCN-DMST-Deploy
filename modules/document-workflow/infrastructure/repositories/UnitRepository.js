'use strict';

/**
 * Repository cho Catalog BC - Unit.
 */
class UnitRepository {
  constructor(db, documentModel) {
    this.db = db;
    this.model = documentModel;
  }

  listActive() {
    return this.db.prepare(`SELECT id, code, name FROM units WHERE active = 1 ORDER BY name`).all();
  }

  listAll() {
    return this.model.listUnits();
  }

  create(payload) {
    return this.model.createUnit(payload);
  }

  update(unitId, payload) {
    return this.model.updateUnit(unitId, payload);
  }

  delete(unitId) {
    return this.model.deleteUnit(unitId);
  }
}

module.exports = { UnitRepository };
