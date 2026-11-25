const db = require('../db/db');

async function testSupplyChecklist() {
  console.log('Testing Supply Allocation Checklist for P. KHCN...');
  await db.initSchema();

  // Find a sample supply item
  const supply = await db.get('SELECT * FROM nckh_supplies LIMIT 1');
  if (!supply) {
    console.log('No supplies found to test.');
    return;
  }
  console.log(`Original item [ID ${supply.id}]:`, supply.item_name, '| Stock:', supply.stock_status, '| Fulfilled:', supply.fulfillment_status);

  const suppliesRouter = require('../routes/supplies');
  const putHandler = suppliesRouter.stack.find(r => r.route && r.route.path === '/:id' && r.route.methods.put).route.stack[0].handle;

  let resData = null;
  await putHandler(
    {
      params: { id: supply.id },
      body: {
        stock_status: 'Trong kho',
        received_quantity: supply.requested_quantity, // Cấp đủ
        fulfillment_status: 'Đã nhận đủ',
        misa_order_id: 'MISA-SCI-2025-001',
        notes: 'P. KHCN đã xuất kho và giao cho NCV'
      },
      user: {}
    },
    { json(d) { resData = d; }, status(c) { return this; } },
    () => {}
  );

  console.log('Update Result:', resData?.message);
  const updated = await db.get('SELECT * FROM nckh_supplies WHERE id = ?', [supply.id]);
  console.log('Updated item:', updated.item_name, '| Stock:', updated.stock_status, '| Rec:', updated.received_quantity, '| Rem:', updated.remaining_quantity, '| Status:', updated.fulfillment_status, '| MISA:', updated.misa_order_id);

  if (updated.fulfillment_status === 'Đã nhận đủ' && updated.misa_order_id === 'MISA-SCI-2025-001') {
    console.log('✅ CHECKLIST CẤP PHÁT HÓA CHẤT P. KHCN HOẠT ĐỘNG HOÀN HẢO!');
  }
}

testSupplyChecklist().catch(console.error);
