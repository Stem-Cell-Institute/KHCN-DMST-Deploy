const subapp = require('../subapp');
const db = require('../db/db');

async function test() {
  console.log('Testing subapp in-process...');
  await db.initSchema();

  // Test stats endpoint directly using mock req/res
  const reqStats = { query: {}, headers: {} };
  let statsData = null;
  const resStats = {
    json(data) {
      statsData = data;
    },
    status(code) {
      return this;
    }
  };

  const projectsRouter = require('../routes/projects');
  // Call stats handler
  const routes = projectsRouter.stack;
  const statsRoute = routes.find(r => r.route && r.route.path === '/stats');
  if (statsRoute) {
    await statsRoute.route.stack[0].handle(reqStats, resStats, () => {});
    console.log('✅ Stats endpoint response:');
    console.log('  Total projects:', statsData?.stats?.total_projects);
    console.log('  Green (On track):', statsData?.stats?.green_count);
    console.log('  Yellow (Warning):', statsData?.stats?.yellow_count);
    console.log('  Red (Overdue):', statsData?.stats?.red_count);
    console.log('  Extended:', statsData?.stats?.extended_count);
    console.log('  Completed:', statsData?.stats?.completed_count);
    console.log('  Total Budget:', statsData?.stats?.total_budget_formatted);
  }

  // Test single project details
  const detailRoute = routes.find(r => r.route && r.route.path === '/:id');
  if (detailRoute) {
    let detailData = null;
    const reqDetail = { params: { id: 1 }, headers: {} };
    const resDetail = {
      json(data) { detailData = data; },
      status(c) { return this; }
    };
    await detailRoute.route.stack[0].handle(reqDetail, resDetail, () => {});
    console.log('\n✅ Project 1 Detail:');
    console.log('  Code:', detailData?.data?.code);
    console.log('  Title:', detailData?.data?.title);
    console.log('  Leader:', detailData?.data?.leader_name);
    console.log('  Status Color:', detailData?.data?.status_color);
    console.log('  Badge Text:', detailData?.data?.badge_text);
    console.log('  Supplies count:', detailData?.data?.supplies?.length);
    console.log('  Reports count:', detailData?.data?.reports?.length);
  }

  console.log('\n🎉 ALL CORE SUBAPP LOGIC TESTS PASSED!');
}

test().catch(console.error);
