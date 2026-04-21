class UnitRepository {
  constructor(deps) {
    this.db = deps.db;
    this.documentModel = deps.documentModel;
  }

  listActive() {
    return this.db
      .prepare(`SELECT id, code, name FROM units WHERE active = 1 ORDER BY name`)
      .all();
  }

  listAll() {
    return this.documentModel.listUnits();
  }

  create(payload) {
    return this.documentModel.createUnit(payload);
  }

  update(unitId, payload) {
    return this.documentModel.updateUnit(unitId, payload);
  }

  delete(unitId) {
    return this.documentModel.deleteUnit(unitId);
  }
}

module.exports = {
  UnitRepository,
};
