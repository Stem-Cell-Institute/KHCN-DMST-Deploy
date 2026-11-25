const db = require('../db/db');
const projectService = require('../services/projectService');

async function testExtensionRule() {
  console.log('Testing Extension Lockout Rule (Max 2 times, each 6 months)...');
  await db.initSchema();

  // Create a temporary project for testing
  const testCode = 'NCKH-TEST-EXT-' + Date.now();
  const rs = await db.run(`
    INSERT INTO nckh_projects (
      code, title, leader_name, decision_number, decision_date, duration_months,
      base_end_date, current_end_date, extension_count, status
    ) VALUES (?, 'Đề tài Thử Nghiệm Gia Hạn', 'Test Leader', 'QĐ-TEST', '2025-01-01', 12, '2026-01-01', '2026-01-01', 0, 'IN_PROGRESS')
  `, [testCode]);

  const pId = rs.lastInsertRowid;
  console.log(`Created test project ID: ${pId}`);

  const extRouter = require('../routes/extensions');
  const postHandler = extRouter.stack.find(r => r.route && r.route.methods.post).route.stack[0].handle;

  // 1. Lần 1: Xin gia hạn 6 tháng
  let resData1 = null;
  await postHandler(
    { params: { projectId: pId }, body: { reason: 'Chờ kết quả xét nghiệm mẫu đợt 1', decision_number: 'QĐ-GH-1' }, user: {} },
    { json(d) { resData1 = d; }, status(c) { return this; } },
    () => {}
  );
  console.log('Gia hạn Lần 1 Result:', resData1?.message, '| Hạn mới:', resData1?.new_end_date);

  // 2. Lần 2: Xin gia hạn 6 tháng lần 2 (lần cuối)
  let resData2 = null;
  await postHandler(
    { params: { projectId: pId }, body: { reason: 'Thiếu hóa chất đợt 2 do nhà cung cấp chậm', decision_number: 'QĐ-GH-2' }, user: {} },
    { json(d) { resData2 = d; }, status(c) { return this; } },
    () => {}
  );
  console.log('Gia hạn Lần 2 Result:', resData2?.message, '| Hạn mới:', resData2?.new_end_date, '| Cuối?:', resData2?.is_final_extension);

  // 3. Lần 3: Xin gia hạn lần 3 -> PHẢI BỊ CHẶN CỨNG!
  let resData3 = null;
  let statusCode3 = 200;
  await postHandler(
    { params: { projectId: pId }, body: { reason: 'Xin gia hạn thêm lần 3' }, user: {} },
    { 
      status(c) { statusCode3 = c; return this; },
      json(d) { resData3 = d; }
    },
    () => {}
  );
  console.log(`Gia hạn Lần 3 Status: ${statusCode3} | Error:`, resData3?.error);

  if (statusCode3 === 400 && resData3?.error?.includes('tối đa')) {
    console.log('✅ CHẶN GIA HẠN LẦN 3 HOÀN TOÀN CHÍNH XÁC!');
  } else {
    console.error('❌ Thử nghiệm thất bại: Chưa chặn được gia hạn lần 3!');
  }

  // Cleanup
  await db.run('DELETE FROM nckh_projects WHERE id = ?', [pId]);
}

testExtensionRule().catch(console.error);
