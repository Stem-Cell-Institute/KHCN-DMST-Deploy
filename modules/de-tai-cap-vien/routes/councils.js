const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logFromRequest } = require('../services/activityLogService');

function classifyScore(avg) {
  if (avg >= 90) return 'Xuất sắc';
  if (avg >= 80) return 'Tốt';
  if (avg >= 70) return 'Khá';
  if (avg >= 55) return 'Đạt';
  return 'Không đạt';
}

async function computeCouncilSummary(targetType, targetId) {
  const scores = await db.all(
    `SELECT * FROM nckh_council_scores
     WHERE target_type = ? AND target_id = ?
     ORDER BY id ASC`,
    [targetType, Number(targetId)]
  );

  const count = scores.length;
  const avgScore = count > 0
    ? Math.round((scores.reduce((sum, s) => sum + Number(s.total_score || 0), 0) / count) * 10) / 10
    : 0;
  const votesDat = scores.filter(s => s.vote === 'DAT').length;
  const votesSua = scores.filter(s => s.vote === 'DAT_CHINH_SUA').length;
  const votesKhongDat = scores.filter(s => s.vote === 'KHONG_DAT').length;

  return {
    scores,
    summary: {
      count,
      average_score: avgScore,
      rating: count > 0 ? classifyScore(avgScore) : null,
      votes_dat: votesDat,
      votes_dat_chinh_sua: votesSua,
      votes_khong_dat: votesKhongDat
    }
  };
}

// GET /api/councils/:targetType/:targetId
router.get('/:targetType/:targetId', async (req, res) => {
  try {
    const targetType = String(req.params.targetType).toUpperCase();
    if (!['PROPOSAL', 'PROJECT'].includes(targetType)) {
      return res.status(400).json({ success: false, error: 'targetType phải là PROPOSAL hoặc PROJECT.' });
    }
    const result = await computeCouncilSummary(targetType, req.params.targetId);
    res.json({ success: true, data: result.scores, summary: result.summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/councils/:targetType/:targetId/score - Nộp phiếu chấm điểm trực tuyến
router.post('/:targetType/:targetId/score', async (req, res) => {
  try {
    const targetType = String(req.params.targetType).toUpperCase();
    const targetId = Number(req.params.targetId);
    if (!['PROPOSAL', 'PROJECT'].includes(targetType)) {
      return res.status(400).json({ success: false, error: 'targetType phải là PROPOSAL hoặc PROJECT.' });
    }

    const {
      member_name,
      member_role = 'UY_VIEN',
      score_scientific = 0,
      score_methodology = 0,
      score_impact = 0,
      score_budget = 0,
      vote = 'DAT',
      comments = ''
    } = req.body || {};

    const finalMemberName = (member_name && String(member_name).trim()) || req.user?.fullname || 'Thành viên Hội đồng';
    const s1 = Math.min(Math.max(Number(score_scientific) || 0, 0), 30);
    const s2 = Math.min(Math.max(Number(score_methodology) || 0, 0), 30);
    const s3 = Math.min(Math.max(Number(score_impact) || 0, 0), 25);
    const s4 = Math.min(Math.max(Number(score_budget) || 0, 0), 15);
    const totalScore = Math.round((s1 + s2 + s3 + s4) * 10) / 10;

    await db.run(
      `INSERT INTO nckh_council_scores (
        target_type, target_id, member_name, member_role,
        score_scientific, score_methodology, score_impact, score_budget,
        total_score, vote, comments, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(target_type, target_id, member_name) DO UPDATE SET
        member_role = excluded.member_role,
        score_scientific = excluded.score_scientific,
        score_methodology = excluded.score_methodology,
        score_impact = excluded.score_impact,
        score_budget = excluded.score_budget,
        total_score = excluded.total_score,
        vote = excluded.vote,
        comments = excluded.comments,
        submitted_at = CURRENT_TIMESTAMP`,
      [targetType, targetId, finalMemberName, member_role, s1, s2, s3, s4, totalScore, vote, comments]
    );

    const { summary } = await computeCouncilSummary(targetType, targetId);

    // Tự động đồng bộ điểm trung bình vào Đề xuất hoặc Hồ sơ Nghiệm thu
    if (targetType === 'PROPOSAL') {
      const propResult = summary.votes_khong_dat > summary.count / 2
        ? 'Không đạt'
        : (summary.votes_dat_chinh_sua > 0 ? 'Đạt có chỉnh sửa' : 'Đạt');
      await db.run(
        `UPDATE nckh_proposals SET council_score = ?, council_result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [summary.average_score, propResult, targetId]
      );
    } else if (targetType === 'PROJECT') {
      const existingAcc = await db.get('SELECT id FROM nckh_acceptances WHERE project_id = ?', [targetId]);
      if (existingAcc) {
        await db.run(
          `UPDATE nckh_acceptances SET council_score = ?, council_rating = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ?`,
          [summary.average_score, summary.rating, targetId]
        );
      }
    }

    await logFromRequest(req, {
      action: 'SUBMIT_COUNCIL_SCORE',
      entityType: targetType,
      entityId: targetId,
      projectId: targetType === 'PROJECT' ? targetId : null,
      summary: `${finalMemberName} (${member_role}) chấm ${totalScore}/100 điểm (${vote}) cho ${targetType} #${targetId}`,
      details: { totalScore, vote, average_score: summary.average_score }
    });

    res.json({
      success: true,
      message: `Đã lưu phiếu chấm điểm (${totalScore}/100). Điểm trung bình Hội đồng hiện tại: ${summary.average_score}/100.`,
      summary
    });
  } catch (err) {
    console.error('Error in POST /api/councils/score:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/councils/score/:id
router.delete('/score/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM nckh_council_scores WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Đã xóa phiếu chấm điểm.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
