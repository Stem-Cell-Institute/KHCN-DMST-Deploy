/**
 * Phân tích sử dụng thiết bị (CRD) — API /api/equipment-analytics
 * CSDL: crd_machines, crd_bookings, crd_persons, crd_maintenance_log
 * equipment_id trong query/body = machine_id (TEXT) trong CRD.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

function parseRange(from, to) {
  const fromStr = (from || '').trim();
  const toStr = (to || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) return null;
  const d0 = new Date(fromStr + 'T00:00:00');
  const d1 = new Date(toStr + 'T00:00:00');
  if (Number.isNaN(d0.getTime()) || Number.isNaN(d1.getTime()) || d0 > d1) return null;
  return { fromStr, toStr };
}

function countInclusiveDays(fromStr, toStr) {
  const a = new Date(fromStr + 'T12:00:00');
  const b = new Date(toStr + 'T12:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

function hoursPerDayMachine(m) {
  const from = Number(m.avail_from);
  const to = Number(m.avail_to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return to - from;
}

function bookingStartMs(dateStr, startH) {
  const d = new Date(dateStr + 'T00:00:00');
  const h = Math.floor(Number(startH));
  const frac = Number(startH) - h;
  const m = Math.round(frac * 60);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function parseSqliteLocalDateTime(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.replace(' ', 'T');
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function trendBucketKey(dateStr, groupBy) {
  if (groupBy === 'month') return dateStr.slice(0, 7);
  if (groupBy === 'week') {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = (d.getDay() + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    const y = monday.getFullYear();
    const mo = String(monday.getMonth() + 1).padStart(2, '0');
    const da = String(monday.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return dateStr;
}

function eachDateInRange(fromStr, toStr, fn) {
  let cur = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  while (cur <= end) {
    const ds = cur.toISOString().slice(0, 10);
    fn(ds);
    cur = new Date(cur.getTime() + 86400000);
  }
}

function overlapHourOnDay(startH, endH, hourInt) {
  const lo = Math.max(Number(startH), hourInt);
  const hi = Math.min(Number(endH), hourInt + 1);
  return Math.max(0, hi - lo);
}

function computeUtilizationForMachines(db, range, equipmentId, groupBy) {
  const { fromStr, toStr } = range;
  const numDays = countInclusiveDays(fromStr, toStr);
  const machines = equipmentId
    ? db.prepare('SELECT id, name, avail_from, avail_to FROM crd_machines WHERE id = ?').all(equipmentId)
    : db.prepare('SELECT id, name, avail_from, avail_to FROM crd_machines ORDER BY sort_order ASC, name ASC').all();

  const bookingsStmt = db.prepare(
    `SELECT date, start_h, end_h, status FROM crd_bookings
     WHERE machine_id = ? AND date >= ? AND date <= ?
       AND status IN ('confirmed','completed')`
  );

  const result = [];

  for (const m of machines) {
    const hDay = hoursPerDayMachine(m);
    const totalAvailable = hDay * numDays;
    const rows = bookingsStmt.all(m.id, fromStr, toStr);
    let totalBooked = 0;
    const hourStarts = new Array(24).fill(0);
    const slotBooked = new Array(24).fill(0);

    for (const r of rows) {
      const dur = Math.max(0, Number(r.end_h) - Number(r.start_h));
      totalBooked += dur;
      const sh = Number(r.start_h);
      hourStarts[Math.min(23, Math.max(0, Math.floor(sh + 1e-9)))] += 1;

      const af = Math.floor(Number(m.avail_from));
      const at = Math.ceil(Number(m.avail_to));
      for (let h = af; h < at && h < 24; h++) {
        slotBooked[h] += overlapHourOnDay(r.start_h, r.end_h, h);
      }
    }

    let peakHour = null;
    let peakCount = 0;
    for (let h = 0; h < 24; h++) {
      if (hourStarts[h] > peakCount) {
        peakCount = hourStarts[h];
        peakHour = h;
      }
    }
    if (peakCount <= 0) peakHour = null;

    const deadHours = [];
    const af = Math.floor(Number(m.avail_from));
    const at = Math.ceil(Number(m.avail_to));
    for (let h = af; h < at && h < 24; h++) {
      const maxSlot = numDays;
      const util = maxSlot > 0 ? (slotBooked[h] / maxSlot) * 100 : 0;
      if (util < 10) deadHours.push(h);
    }

    const trendMap = new Map();
    eachDateInRange(fromStr, toStr, (ds) => {
      const key = trendBucketKey(ds, groupBy);
      if (!trendMap.has(key)) trendMap.set(key, { booked: 0, days: 0 });
      const e = trendMap.get(key);
      e.days += 1;
    });

    for (const r of rows) {
      const key = trendBucketKey(r.date, groupBy);
      if (!trendMap.has(key)) trendMap.set(key, { booked: 0, days: 0 });
      trendMap.get(key).booked += Math.max(0, Number(r.end_h) - Number(r.start_h));
    }

    const trend = Array.from(trendMap.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, v]) => {
        const avail = hDay * v.days;
        const rate = avail > 0 ? Math.round((v.booked / avail) * 10000) / 100 : 0;
        return { date, rate };
      });

    const utilizationRate =
      totalAvailable > 0 ? Math.round((totalBooked / totalAvailable) * 10000) / 100 : 0;

    result.push({
      id: m.id,
      name: m.name,
      total_available_hours: Math.round(totalAvailable * 100) / 100,
      total_booked_hours: Math.round(totalBooked * 100) / 100,
      utilization_rate: utilizationRate,
      peak_hour: peakHour,
      dead_hours: deadHours,
      trend,
    });
  }

  return result;
}

function computeUserBehavior(db, range, equipmentId) {
  const { fromStr, toStr } = range;
  const mid = equipmentId || null;

  const allBookings = db
    .prepare(
      `SELECT b.* FROM crd_bookings b
       WHERE b.date >= ? AND b.date <= ?
       ${mid ? 'AND b.machine_id = ?' : ''}`
    )
    .all(mid ? [fromStr, toStr, mid] : [fromStr, toStr]);

  const byHour = new Array(24).fill(0);
  for (const b of allBookings) {
    const h = Math.min(23, Math.max(0, Math.floor(Number(b.start_h) + 1e-9)));
    byHour[h] += 1;
  }

  let totalBookings = allBookings.length;
  let totalCancelled = 0;
  let lateCancellations = 0;
  let noShows = 0;
  const leadSamples = [];

  for (const b of allBookings) {
    const st = (b.status || '').toLowerCase();
    if (st === 'cancelled') {
      totalCancelled += 1;
      const startMs = bookingStartMs(b.date, b.start_h);
      const cancelMs = parseSqliteLocalDateTime(b.updated_at);
      if (cancelMs != null && startMs > cancelMs && startMs - cancelMs < 2 * 3600000) lateCancellations += 1;
    }
    if (st === 'no_show') noShows += 1;

    const startMs = bookingStartMs(b.date, b.start_h);
    const createdMs = parseSqliteLocalDateTime(b.created_at) || parseSqliteLocalDateTime(b.updated_at);
    if (createdMs != null && startMs > createdMs) {
      leadSamples.push((startMs - createdMs) / 3600000);
    }
  }

  const cancellationRate =
    totalBookings > 0 ? Math.round((totalCancelled / totalBookings) * 10000) / 100 : 0;

  const leadTimeAvgHours =
    leadSamples.length > 0
      ? Math.round((leadSamples.reduce((a, x) => a + x, 0) / leadSamples.length) * 100) / 100
      : null;

  const rows = db
    .prepare(
      `SELECT
         b.person_id,
         MAX(p.name) AS person_name,
         MAX(p.user_id) AS user_id,
         MAX(u.fullname) AS user_fullname,
         COUNT(*) AS booking_count,
         SUM(CASE WHEN LOWER(COALESCE(b.status,'')) = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_n,
         SUM(CASE WHEN LOWER(COALESCE(b.status,'')) IN ('confirmed','completed') THEN (b.end_h - b.start_h) ELSE 0 END) AS total_hours
       FROM crd_bookings b
       LEFT JOIN crd_persons p ON p.id = b.person_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE b.date >= ? AND b.date <= ?
       ${mid ? 'AND b.machine_id = ?' : ''}
       GROUP BY b.person_id
       ORDER BY total_hours DESC`
    )
    .all(mid ? [fromStr, toStr, mid] : [fromStr, toStr]);

  const top_users = rows.map((r) => {
    const bc = Number(r.booking_count) || 0;
    const canc = Number(r.cancelled_n) || 0;
    const cr = bc > 0 ? Math.round((canc / bc) * 10000) / 100 : 0;
    const grpRow = db
      .prepare(
        `SELECT research_group FROM crd_bookings
         WHERE person_id = ? AND date >= ? AND date <= ?
           ${mid ? 'AND machine_id = ?' : ''}
           AND research_group IS NOT NULL AND TRIM(research_group) != ''
         GROUP BY research_group ORDER BY COUNT(*) DESC LIMIT 1`
      )
      .get(mid ? [r.person_id, fromStr, toStr, mid] : [r.person_id, fromStr, toStr]);
    return {
      user_id: r.user_id != null ? r.user_id : r.person_id,
      full_name: (r.user_fullname || r.person_name || r.person_id || '').trim() || String(r.person_id),
      group: grpRow && grpRow.research_group ? String(grpRow.research_group) : '',
      total_hours: Math.round(Number(r.total_hours || 0) * 100) / 100,
      booking_count: bc,
      cancellation_rate: cr,
    };
  });

  const groupRows = db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(research_group), ''), '(Không ghi nhóm)') AS group_name,
         SUM(CASE WHEN LOWER(COALESCE(status,'')) IN ('confirmed','completed') THEN (end_h - start_h) ELSE 0 END) AS total_hours,
         COUNT(*) AS booking_count
       FROM crd_bookings
       WHERE date >= ? AND date <= ?
       ${mid ? 'AND machine_id = ?' : ''}
       GROUP BY 1
       ORDER BY total_hours DESC`
    )
    .all(mid ? [fromStr, toStr, mid] : [fromStr, toStr]);

  const top_groups = groupRows.map((g) => ({
    group_name: g.group_name,
    total_hours: Math.round(Number(g.total_hours || 0) * 100) / 100,
    booking_count: Number(g.booking_count) || 0,
  }));

  return {
    top_users,
    top_groups,
    cancellation_stats: {
      total_bookings: totalBookings,
      total_cancelled: totalCancelled,
      cancellation_rate: cancellationRate,
      late_cancellations: lateCancellations,
      no_shows: noShows,
    },
    lead_time_avg_hours: leadTimeAvgHours,
    booking_by_hour: byHour,
  };
}

function maintenanceStatusList(db) {
  const cycleHoursStmt = db.prepare(
    `SELECT COALESCE(SUM(end_h - start_h), 0) AS hours
     FROM crd_bookings
     WHERE machine_id = ?
       AND LOWER(COALESCE(status,'')) != 'cancelled'
       AND (? IS NULL OR date > ?)`
  );
  const rows = db.prepare('SELECT * FROM crd_machines ORDER BY sort_order ASC, name ASC').all();
  return rows.map((m) => {
    const lastMaint = m.last_maintenance_date ? String(m.last_maintenance_date).slice(0, 10) : null;
    const cyc = cycleHoursStmt.get(m.id, lastMaint, lastMaint);
    const acc = Math.round((Number((cyc && cyc.hours) || 0) || 0) * 100) / 100;
    const thr = Number(m.maintenance_threshold_hours);
    const threshold = Number.isFinite(thr) && thr > 0 ? thr : 500;
    const until = Math.max(0, threshold - acc);
    let maintenance_urgency = 'ok';
    if (acc >= threshold) maintenance_urgency = 'overdue';
    else if (until < 50) maintenance_urgency = 'warning';

    let next_suggested_date = null;
    if (m.last_maintenance_date && /^\d{4}-\d{2}-\d{2}$/.test(String(m.last_maintenance_date))) {
      const d = new Date(String(m.last_maintenance_date) + 'T12:00:00');
      d.setDate(d.getDate() + 90);
      next_suggested_date = d.toISOString().slice(0, 10);
    }

    return {
      id: m.id,
      name: m.name,
      accumulated_hours: acc,
      maintenance_threshold_hours: threshold,
      hours_until_maintenance: Math.round(until * 100) / 100,
      maintenance_urgency,
      last_maintenance_date: lastMaint,
      next_suggested_date,
    };
  });
}

function reportSummary(db, range) {
  const utilization = computeUtilizationForMachines(db, range, null, 'month');
  const behavior = computeUserBehavior(db, range, null);
  const maintenance = { equipment: maintenanceStatusList(db) };
  return {
    period: { from: range.fromStr, to: range.toStr },
    utilization: { equipment: utilization },
    user_behavior: behavior,
    maintenance,
  };
}

/** Heatmap: tối đa 7 ngày trong [from,to] (từ ngày `to` lùi), cột giờ 07–22 */
function computeUsageHeatmap(db, range, equipmentId) {
  const { fromStr, toStr } = range;
  const hours = [];
  for (let h = 7; h <= 22; h++) hours.push(h);

  const days = [];
  const end = new Date(toStr + 'T12:00:00');
  for (let i = 0; i < 7; i++) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    if (ds >= fromStr && ds <= toStr) days.push(ds);
  }
  days.reverse();

  const rows = equipmentId
    ? db
        .prepare(
          `SELECT date, start_h, end_h FROM crd_bookings
           WHERE date >= ? AND date <= ? AND machine_id = ? AND status IN ('confirmed','completed')`
        )
        .all(fromStr, toStr, equipmentId)
    : db
        .prepare(
          `SELECT date, start_h, end_h FROM crd_bookings
           WHERE date >= ? AND date <= ? AND status IN ('confirmed','completed')`
        )
        .all(fromStr, toStr);

  const cells = days.map((ds) =>
    hours.map((h) => {
      let bookings = 0;
      let hourSum = 0;
      for (const r of rows) {
        if (r.date !== ds) continue;
        const ov = overlapHourOnDay(r.start_h, r.end_h, h);
        if (ov > 0) {
          bookings += 1;
          hourSum += ov;
        }
      }
      return {
        bookings,
        hours: Math.round(hourSum * 100) / 100,
        /** Tối đa 1 giờ / ô → 100% = full slot */
        utilization: Math.min(100, Math.round(hourSum * 10000) / 100),
      };
    })
  );

  const flatH = cells.flatMap((row) => row.map((c) => c.hours));
  const maxHours = Math.max(0.0001, ...flatH);

  return { days, hours, cells, max_hours_in_cell: maxHours };
}

module.exports = function createEquipmentAnalyticsRouter({ db }) {
  const router = express.Router();

  router.get('/usage-heatmap', (req, res) => {
    try {
      const range = parseRange(req.query.from, req.query.to);
      if (!range) return res.status(400).json({ message: 'Tham số from, to bắt buộc (YYYY-MM-DD)' });
      const equipmentId = (req.query.equipment_id || '').trim() || null;
      const data = computeUsageHeatmap(db, range, equipmentId);
      return res.json(data);
    } catch (e) {
      console.error('[equipment-analytics/usage-heatmap]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/maintenance-logs', (req, res) => {
    try {
      const fromStr = (req.query.from || '').trim();
      const toStr = (req.query.to || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
        return res.status(400).json({ message: 'Tham số from, to (YYYY-MM-DD)' });
      }
      const rows = db
        .prepare(
          `SELECT l.id, l.machine_id AS equipment_id, m.name AS equipment_name, l.maintenance_date,
                  l.hours_at_maintenance, l.type, l.performed_by, l.cost, l.notes, l.created_at
           FROM crd_maintenance_log l
           JOIN crd_machines m ON m.id = l.machine_id
           WHERE l.maintenance_date >= ? AND l.maintenance_date <= ?
           ORDER BY l.maintenance_date DESC, l.id DESC`
        )
        .all(fromStr, toStr);
      return res.json({ logs: rows });
    } catch (e) {
      if (String(e.message || '').includes('no such table')) {
        return res.json({ logs: [] });
      }
      console.error('[equipment-analytics/maintenance-logs]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/utilization', (req, res) => {
    try {
      const range = parseRange(req.query.from, req.query.to);
      if (!range) {
        return res.status(400).json({ message: 'Tham số from, to bắt buộc (YYYY-MM-DD)' });
      }
      const groupBy = ['day', 'week', 'month'].includes(String(req.query.group_by)) ? req.query.group_by : 'day';
      const equipmentId = (req.query.equipment_id || '').trim() || null;
      const equipment = computeUtilizationForMachines(db, range, equipmentId, groupBy);
      return res.json({ equipment });
    } catch (e) {
      console.error('[equipment-analytics/utilization]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/user-behavior', (req, res) => {
    try {
      const range = parseRange(req.query.from, req.query.to);
      if (!range) return res.status(400).json({ message: 'Tham số from, to bắt buộc (YYYY-MM-DD)' });
      const equipmentId = (req.query.equipment_id || '').trim() || null;
      const data = computeUserBehavior(db, range, equipmentId);
      return res.json(data);
    } catch (e) {
      console.error('[equipment-analytics/user-behavior]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/maintenance-status', (req, res) => {
    try {
      return res.json({ equipment: maintenanceStatusList(db) });
    } catch (e) {
      console.error('[equipment-analytics/maintenance-status]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  /**
   * Admin: chỉnh ngưỡng giờ đến lúc cần bảo trì (cột maintenance_threshold_hours).
   * PATCH /api/equipment-analytics/machine/:machineId/maintenance-threshold
   * body: { maintenance_threshold_hours: number }
   */
  router.patch('/machine/:machineId/maintenance-threshold', express.json(), (req, res) => {
    try {
      const machineId = (req.params.machineId || '').trim();
      if (!machineId) return res.status(400).json({ message: 'Thiếu machineId' });
      const raw = req.body && req.body.maintenance_threshold_hours;
      const thr = Number(raw);
      if (!Number.isFinite(thr) || thr < 1 || thr > 100000) {
        return res.status(400).json({ message: 'maintenance_threshold_hours phải từ 1 đến 100000' });
      }
      const row = db.prepare('SELECT id FROM crd_machines WHERE id = ?').get(machineId);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
      db.prepare(
        `UPDATE crd_machines SET maintenance_threshold_hours = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(thr, machineId);
      return res.json({ ok: true, id: machineId, maintenance_threshold_hours: thr });
    } catch (e) {
      console.error('[equipment-analytics/maintenance-threshold PATCH]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.post('/maintenance-log', express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const equipment_id = (b.equipment_id || '').trim();
      const maintenance_date = (b.maintenance_date || '').trim();
      const type = b.type != null ? String(b.type).trim() : null;
      const performed_by = b.performed_by != null ? String(b.performed_by).trim() : null;
      const cost = b.cost != null && b.cost !== '' ? Number(b.cost) : null;
      const notes = b.notes != null ? String(b.notes) : null;

      if (!equipment_id || !maintenance_date || !/^\d{4}-\d{2}-\d{2}$/.test(maintenance_date)) {
        return res.status(400).json({ message: 'Thiếu equipment_id hoặc maintenance_date (YYYY-MM-DD)' });
      }
      if (type && !['preventive', 'corrective', 'calibration'].includes(type)) {
        return res.status(400).json({ message: 'type phải là preventive | corrective | calibration' });
      }
      const m = db.prepare('SELECT id, last_maintenance_date FROM crd_machines WHERE id = ?').get(equipment_id);
      if (!m) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
      const lastMaint = m.last_maintenance_date ? String(m.last_maintenance_date).slice(0, 10) : null;
      /** Giờ tích lũy chu kỳ = tổng giờ đặt lịch của máy từ lần bảo trì gần nhất. */
      const cyc = db
        .prepare(
          `SELECT COALESCE(SUM(end_h - start_h), 0) AS hours
           FROM crd_bookings
           WHERE machine_id = ?
             AND LOWER(COALESCE(status,'')) != 'cancelled'
             AND (? IS NULL OR date > ?)`
        )
        .get(equipment_id, lastMaint, lastMaint);
      const hoursAt = Math.round((Number((cyc && cyc.hours) || 0) || 0) * 100) / 100;

      const tx = db.transaction(() => {
        db.prepare(
          `INSERT INTO crd_maintenance_log (machine_id, maintenance_date, hours_at_maintenance, type, performed_by, cost, notes)
           VALUES (?,?,?,?,?,?,?)`
        ).run(equipment_id, maintenance_date, hoursAt, type || null, performed_by, cost, notes);
        db.prepare(
          `UPDATE crd_machines SET accumulated_hours = 0, last_maintenance_date = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(maintenance_date, equipment_id);
      });
      tx();
      return res.status(201).json({
        ok: true,
        equipment_id,
        accumulated_hours_reset: true,
        hours_logged_for_cycle: hoursAt,
      });
    } catch (e) {
      console.error('[equipment-analytics/maintenance-log POST]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/maintenance-log/:equipment_id', (req, res) => {
    try {
      const equipment_id = (req.params.equipment_id || '').trim();
      if (!equipment_id) return res.status(400).json({ message: 'Thiếu equipment_id' });
      const rows = db
        .prepare(
          `SELECT id, machine_id AS equipment_id, maintenance_date, hours_at_maintenance, type, performed_by, cost, notes, created_at
           FROM crd_maintenance_log WHERE machine_id = ? ORDER BY maintenance_date DESC, id DESC`
        )
        .all(equipment_id);
      return res.json({ equipment_id, logs: rows });
    } catch (e) {
      if (String(e.message || '').includes('no such table')) {
        return res.json({ equipment_id: req.params.equipment_id, logs: [] });
      }
      console.error('[equipment-analytics/maintenance-log GET]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  router.get('/report/summary', (req, res) => {
    try {
      const range = parseRange(req.query.from, req.query.to);
      if (!range) return res.status(400).json({ message: 'Tham số from, to bắt buộc (YYYY-MM-DD)' });
      return res.json(reportSummary(db, range));
    } catch (e) {
      console.error('[equipment-analytics/report/summary]', e);
      return res.status(500).json({ message: e.message || 'Lỗi máy chủ' });
    }
  });

  function maintenanceUrgencyLabel(u) {
    if (u === 'overdue') return 'Quá hạn';
    if (u === 'warning') return 'Sắp đến hạn';
    return 'OK';
  }

  router.get('/report/export', async (req, res) => {
    try {
      const range = parseRange(req.query.from, req.query.to);
      if (!range) {
        return res.status(400).json({ success: false, error: 'Tham số from, to bắt buộc (YYYY-MM-DD)' });
      }
      const format = String(req.query.format || 'excel').toLowerCase();
      const summary = reportSummary(db, range);
      const util = summary.utilization.equipment;
      const beh = summary.user_behavior;

      if (format === 'excel' || format === 'xlsx') {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'SCI-ACE';
        const s1 = wb.addWorksheet('Utilization');
        s1.columns = [
          { header: 'Thiết bị', key: 'name', width: 28 },
          { header: 'Giờ có sẵn', key: 'avail', width: 14 },
          { header: 'Giờ đã đặt', key: 'booked', width: 14 },
          { header: 'Tỷ lệ %', key: 'rate', width: 10 },
          { header: 'Giờ cao điểm', key: 'peak', width: 12 },
          { header: 'Giờ “chết” (<10%)', key: 'dead', width: 28 },
        ];
        for (const e of util) {
          s1.addRow({
            name: e.name,
            avail: e.total_available_hours,
            booked: e.total_booked_hours,
            rate: e.utilization_rate,
            peak: e.peak_hour != null ? e.peak_hour : '—',
            dead: (e.dead_hours || []).join(', ') || '—',
          });
        }

        const s2 = wb.addWorksheet('Nguoi_dung_Nhom');
        s2.addRow(['Top người dùng']);
        s2.addRow(['user_id', 'Họ tên', 'Nhóm NC', 'Tổng giờ', 'Số lịch', 'Tỷ lệ hủy %']);
        for (const u of beh.top_users) {
          s2.addRow([u.user_id, u.full_name, u.group, u.total_hours, u.booking_count, u.cancellation_rate]);
        }
        s2.addRow([]);
        s2.addRow(['Top nhóm nghiên cứu']);
        s2.addRow(['Tên nhóm', 'Tổng giờ', 'Số lịch']);
        for (const g of beh.top_groups) {
          s2.addRow([g.group_name, g.total_hours, g.booking_count]);
        }

        const s3 = wb.addWorksheet('Bao_tri');
        s3.addRow(['Thiết bị', 'Ngày BT', 'Giờ tích lũy lúc BT', 'Loại', 'Thực hiện', 'Chi phí', 'Ghi chú']);
        let logs = [];
        try {
          logs = db
            .prepare(
              `SELECT m.name, l.maintenance_date, l.hours_at_maintenance, l.type, l.performed_by, l.cost, l.notes
               FROM crd_maintenance_log l
               JOIN crd_machines m ON m.id = l.machine_id
               WHERE l.maintenance_date >= ? AND l.maintenance_date <= ?
               ORDER BY l.maintenance_date DESC`
            )
            .all(range.fromStr, range.toStr);
        } catch (_) {
          /* bảng chưa có */
        }
        for (const l of logs) {
          s3.addRow([
            l.name,
            l.maintenance_date,
            l.hours_at_maintenance,
            l.type,
            l.performed_by,
            l.cost,
            l.notes,
          ]);
        }

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="bao-cao-thiet-bi-${range.fromStr}_${range.toStr}.xlsx"`
        );
        await wb.xlsx.write(res);
        return res.end();
      }

      if (format === 'word' || format === 'docx') {
        const templatePath = path.join(__dirname, '..', 'templates', 'equipment_report_template.docx');
        if (!fs.existsSync(templatePath)) {
          return res.status(500).json({
            success: false,
            error:
              'Thiếu file templates/equipment_report_template.docx (chạy node scripts/init-equipment-report-template.js)',
          });
        }
        const totalBooked = util.reduce((a, e) => a + (Number(e.total_booked_hours) || 0), 0);
        const avgUtil =
          util.length > 0
            ? Math.round(
                (util.reduce((a, e) => a + (Number(e.utilization_rate) || 0), 0) / util.length) * 100
              ) / 100
            : 0;
        const generatedBy =
          req.user && (req.user.fullname || req.user.email)
            ? String(req.user.fullname || req.user.email).trim()
            : '—';
        const generatedDate = new Date().toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          hour12: false,
        });

        const equipment_table = util.map((e) => ({
          eq_name: e.name,
          eq_avail: String(e.total_available_hours ?? ''),
          eq_booked: String(e.total_booked_hours ?? ''),
          eq_util: String(e.utilization_rate ?? ''),
        }));

        const user_stats_table = (beh.top_users || []).map((u) => ({
          u_name: u.full_name,
          u_group: u.group || '—',
          u_hours: String(u.total_hours ?? ''),
          u_bookings: String(u.booking_count ?? ''),
          u_cancel: String(u.cancellation_rate ?? ''),
        }));

        const maintenance_table = (summary.maintenance.equipment || []).map((m) => ({
          m_name: m.name,
          m_accumulated: String(m.accumulated_hours ?? ''),
          m_threshold: String(m.maintenance_threshold_hours ?? ''),
          m_urgency_label: maintenanceUrgencyLabel(m.maintenance_urgency),
          m_last_date: m.last_maintenance_date || '—',
        }));

        const content = fs.readFileSync(templatePath, 'binary');
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
        doc.render({
          report_period: `${range.fromStr} — ${range.toStr}`,
          total_equipment: String(util.length),
          total_hours: String(Math.round(totalBooked * 100) / 100),
          avg_utilization: String(avgUtil),
          equipment_table,
          user_stats_table,
          maintenance_table,
          generated_date: generatedDate,
          generated_by: generatedBy,
        });
        const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="bao-cao-thiet-bi-${range.fromStr}_${range.toStr}.docx"`
        );
        return res.send(Buffer.from(buf));
      }

      return res.status(400).json({ success: false, error: 'format phải là excel | xlsx | word | docx' });
    } catch (e) {
      console.error('[equipment-analytics/report/export]', e);
      if (!res.headersSent) {
        return res.status(500).json({ success: false, error: e.message || 'Lỗi xuất file' });
      }
    }
  });

  return router;
};
