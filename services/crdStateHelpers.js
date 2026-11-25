/**
 * Helper tính toán trạng thái và thông báo phòng lab cho module CRD.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function createCrdStateHelpers({
  CRD_BROADCAST_TO_ID,
  crdBookingToClient,
  crdChatToClient,
  crdMachineToClient,
  crdPersonToUser,
  crdRoleDefsToClient,
}) {
  function crdEnsurePersonForAppUser(reqUser) {
    const pid = 'u_app_' + reqUser.id;
    const existing = db.prepare('SELECT id, crd_access_revoked FROM crd_persons WHERE id = ?').get(pid);
    if (existing) {
      if (Number(existing.crd_access_revoked) === 1) return null;
      /* Hồ sơ cũ có thể thiếu user_id — đồng bộ để API (email thông báo, v.v.) hoạt động */
      const uidRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(pid);
      if (uidRow && uidRow.user_id == null) {
        try {
          db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ?').run(reqUser.id, pid);
        } catch (_) { /* ignore nếu DB cũ không có cột */ }
      }
      return pid;
    }
    const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(reqUser.id);
    if (!u) return null;
    const name = (u.fullname || u.email || 'User').trim();
    const av = (name[0] || '?').toUpperCase();
    db.prepare('INSERT INTO crd_persons (id, name, email, role, avatar, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      pid,
      name,
      (u.email || '').toLowerCase(),
      'user',
      av,
      reqUser.id
    );
    return pid;
  }

  function crdBookingOverlaps(machineId, date, startH, endH, excludeId) {
    const ex = excludeId || '';
    const row = db
      .prepare(
        `SELECT id FROM crd_bookings WHERE machine_id = ? AND date = ? AND id != ?
       AND NOT (end_h <= ? OR start_h >= ?) LIMIT 1`
      )
      .get(machineId, date, ex, startH, endH);
    return !!row;
  }

  function crdAnnouncementToClient(r) {
    if (!r) return null;
    return {
      id: r.id,
      title: (r.title || '').trim(),
      body: r.body || '',
      sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
      isActive: Number(r.is_active) !== 0,
      createdAt: r.created_at || '',
      updatedAt: r.updated_at || ''
    };
  }

  function crdLabAnnouncementsActive() {
    try {
      return db
        .prepare(
          `SELECT * FROM crd_lab_announcements WHERE is_active = 1
         ORDER BY sort_order ASC, datetime(COALESCE(updated_at, created_at)) DESC, id ASC`
        )
        .all()
        .map(crdAnnouncementToClient);
    } catch (e) {
      return [];
    }
  }

  function crdLabAnnouncementsAll() {
    try {
      return db
        .prepare(
          `SELECT * FROM crd_lab_announcements
         ORDER BY sort_order ASC, datetime(COALESCE(updated_at, created_at)) DESC, id ASC`
        )
        .all()
        .map(crdAnnouncementToClient);
    } catch (e) {
      return [];
    }
  }

  function crdGetStateForUser(reqUser, precomputedMePersonId) {
    const mePersonId =
      precomputedMePersonId !== undefined ? precomputedMePersonId : crdEnsurePersonForAppUser(reqUser);
    const machines = db
      .prepare('SELECT * FROM crd_machines ORDER BY sort_order ASC, name ASC')
      .all()
      .map(crdMachineToClient);
    let users = db.prepare('SELECT * FROM crd_persons ORDER BY name ASC').all().map(crdPersonToUser);
    const isSysAdmin = (reqUser.role || '').toLowerCase() === 'admin';
    if (!isSysAdmin) {
      users = users.filter((u) => !u.crdAccessRevoked);
    }
    const bookings = db.prepare('SELECT * FROM crd_bookings ORDER BY date DESC, start_h ASC').all().map(crdBookingToClient);
    const chats = db.prepare('SELECT * FROM crd_chats WHERE is_deleted = 0 ORDER BY ts ASC').all().map(crdChatToClient);
    const crdRoles = crdRoleDefsToClient();
    const appRole = (reqUser.role || '').toLowerCase();
    let broadcastLastRead = 0;
    if (mePersonId) {
      const br = db.prepare('SELECT last_read_ts FROM crd_broadcast_read WHERE person_id = ?').get(mePersonId);
      broadcastLastRead = br && br.last_read_ts != null ? Number(br.last_read_ts) : 0;
    }
    return {
      machines,
      users,
      bookings,
      chats,
      mePersonId,
      appRole,
      crdRoles,
      broadcastLastRead,
      broadcastChannelId: CRD_BROADCAST_TO_ID,
      labAnnouncements: crdLabAnnouncementsActive()
    };
  }

  return {
    crdAnnouncementToClient,
    crdBookingOverlaps,
    crdEnsurePersonForAppUser,
    crdGetStateForUser,
    crdLabAnnouncementsActive,
    crdLabAnnouncementsAll,
  };
};
