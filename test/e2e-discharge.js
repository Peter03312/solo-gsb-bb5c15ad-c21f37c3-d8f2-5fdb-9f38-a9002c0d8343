/* eslint-disable no-console */
// 已签发清单卸货审查 端到端验证：embedded-postgres + 真实 Express HTTP
//   - 按冻结清单箱位逐港模拟：上方已空且属于本港的箱反复卸走，直到无可卸箱
//   - 受阻箱带上方仍在船阻挡箱号与箱位；逾港未卸箱；全程无倒箱可行性
//   - 航次后续调整/签发新清单不改变旧清单审查结果
//   - 未知清单 404；空港序/重复港序/卸港未知/箱号缺漏/多余/重复指派 400
// 运行: node test/e2e-discharge.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30199;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-discharge'),
    user: 'stowage',
    password: 'stowage',
    port: 54399,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54399/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const ALL_P1P2 = {
    ports: ['P1', 'P2'],
    boxPorts: [
      { boxNo: 'A1', port: 'P1' }, { boxNo: 'A2', port: 'P1' }, { boxNo: 'A3', port: 'P1' },
      { boxNo: 'B1', port: 'P2' }, { boxNo: 'B2', port: 'P2' }, { boxNo: 'B3', port: 'P2' },
    ],
  };
  // 列(1,1)：A1(底)->P2、A2->P2、A3(顶)->P1；列(2,1)：B1(底)->P1、B2->P1、B3(顶)->P2
  const BLOCKED_PLAN = {
    ports: ['P1', 'P2'],
    boxPorts: [
      { boxNo: 'A1', port: 'P2' }, { boxNo: 'A2', port: 'P2' }, { boxNo: 'A3', port: 'P1' },
      { boxNo: 'B1', port: 'P1' }, { boxNo: 'B2', port: 'P1' }, { boxNo: 'B3', port: 'P2' },
    ],
  };

  try {
    // ---- 1. 登记 + 配位 rev1 + 签发清单 rev1 ----
    const { body: voyage } = await http('POST', `${BASE}/voyages`, {
      voyageNo: 'V-E2E-DISCHARGE-001',
      bays: 2, rows: 1, tiers: 3,
      defaultColumnWeightLimit: '10000',
      boxes: [
        { boxNo: 'A1', weight: '100', category: '1' },
        { boxNo: 'A2', weight: '100', category: '1' },
        { boxNo: 'A3', weight: '100', category: '1' },
        { boxNo: 'B1', weight: '100', category: '1' },
        { boxNo: 'B2', weight: '100', category: '1' },
        { boxNo: 'B3', weight: '100', category: '1' },
      ],
      incompatRules: [],
    }, 201);
    const vid = voyage.id;

    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'A1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'A2', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'A3', position: { bay: 1, row: 1, tier: 2 } },
        { boxNo: 'B1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'B2', position: { bay: 2, row: 1, tier: 1 } },
        { boxNo: 'B3', position: { bay: 2, row: 1, tier: 2 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 1 }, 201);

    // ---- 2. 可行：按列分港，全程无倒箱 ----
    const ok = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, ALL_P1P2, 200);
    check('可行方案 feasible=true，无逾港未卸箱',
      ok.body.feasible === true && ok.body.overcarried.length === 0);
    check('P1 自顶向下卸 A3/A2/A1',
      JSON.stringify(ok.body.portResults[0].discharged.map((d) => d.boxNo)) === '["A3","A2","A1"]');
    check('P2 自顶向下卸 B3/B2/B1，且各港无受阻箱',
      JSON.stringify(ok.body.portResults[1].discharged.map((d) => d.boxNo)) === '["B3","B2","B1"]' &&
      ok.body.portResults.every((p) => p.blocked.length === 0));
    check('计数：expected=6 discharged=6 overcarried=0',
      ok.body.counts.expected === 6 && ok.body.counts.discharged === 6 && ok.body.counts.overcarried === 0);
    check('响应带回航次/清单修订号/港序',
      ok.body.voyageId === vid && ok.body.manifestRevision === 1 &&
      JSON.stringify(ok.body.ports) === '["P1","P2"]');

    // ---- 3. 不可行：本港箱被后续港箱压住，受阻+逾港未卸 ----
    const bad = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, BLOCKED_PLAN, 200);
    check('受阻方案 feasible=false', bad.body.feasible === false);
    const p1 = bad.body.portResults[0];
    check('P1 仅卸走顶部 A3', JSON.stringify(p1.discharged.map((d) => d.boxNo)) === '["A3"]');
    check('P1 受阻箱为 B1/B2', JSON.stringify(p1.blocked.map((b) => b.boxNo)) === '["B1","B2"]');
    const b1 = p1.blocked.find((b) => b.boxNo === 'B1');
    check('B1 阻挡箱自低向高为 B2/B3（含箱位）',
      JSON.stringify(b1.blockedBy.map((x) => x.boxNo)) === '["B2","B3"]' &&
      b1.blockedBy[0].position.tier === 1 && b1.blockedBy[1].position.tier === 2 &&
      b1.blockedBy[1].position.bay === 2 && b1.blockedBy[1].position.row === 1);
    const b2 = p1.blocked.find((b) => b.boxNo === 'B2');
    check('B2 阻挡箱为 B3', JSON.stringify(b2.blockedBy.map((x) => x.boxNo)) === '["B3"]');
    check('逾港未卸箱为 B1/B2（原定 P1），后续港不回补',
      JSON.stringify(bad.body.overcarried.map((o) => [o.boxNo, o.port])) === '[["B1","P1"],["B2","P1"]]');
    check('计数：discharged=4 overcarried=2',
      bad.body.counts.discharged === 4 && bad.body.counts.overcarried === 2);

    // ---- 4. 冻结：航次前进 + 签发新清单后，旧清单审查结果不变 ----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'A1', position: { bay: 2, row: 1, tier: 0 } },
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
      ],
    }, 200);
    await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 2 }, 201);
    const again = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, BLOCKED_PLAN, 200);
    check('旧清单(rev1)审查结果不受后续调整/新清单影响',
      JSON.stringify(again.body.portResults) === JSON.stringify(bad.body.portResults) &&
      JSON.stringify(again.body.overcarried) === JSON.stringify(bad.body.overcarried) &&
      again.body.feasible === bad.body.feasible);
    const rev2 = await http('POST', `${BASE}/voyages/${vid}/manifests/2/discharge-review`, ALL_P1P2, 200);
    check('新清单(rev2)按各自冻结箱位审查：A1 已换至列(2,1)底层，被 B2/B3 压住而逾港未卸',
      rev2.body.feasible === false &&
      rev2.body.portResults[0].blocked.length === 1 &&
      rev2.body.portResults[0].blocked[0].boxNo === 'A1' &&
      rev2.body.portResults[0].blocked[0].position.bay === 2 &&
      rev2.body.overcarried.length === 1 && rev2.body.overcarried[0].boxNo === 'A1');

    // ---- 5. 拒绝情形 ----
    const noVoyage = await http('POST', `${BASE}/voyages/00000000-0000-0000-0000-000000000000/manifests/1/discharge-review`, ALL_P1P2);
    check('未知航次 404 voyage_not_found',
      noVoyage.status === 404 && noVoyage.body.error.code === 'voyage_not_found');

    const noManifest = await http('POST', `${BASE}/voyages/${vid}/manifests/99/discharge-review`, ALL_P1P2);
    check('未知清单 404 manifest_not_found',
      noManifest.status === 404 && noManifest.body.error.code === 'manifest_not_found');

    const badRev = await http('POST', `${BASE}/voyages/${vid}/manifests/abc/discharge-review`, ALL_P1P2);
    check('清单修订号格式非法 400 invalid_revision',
      badRev.status === 400 && badRev.body.error.code === 'invalid_revision');

    const malformed = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, { ports: 'P1' });
    check('请求体非法 400 invalid_request_body',
      malformed.status === 400 && malformed.body.error.code === 'invalid_request_body');

    const emptyPorts = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, { ...ALL_P1P2, ports: [] });
    check('空港序 400 invalid_discharge_plan / empty_port_sequence',
      emptyPorts.status === 400 && emptyPorts.body.error.code === 'invalid_discharge_plan' &&
      emptyPorts.body.error.details.issues.some((i) => i.reason === 'empty_port_sequence'));

    const dupPorts = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, { ...ALL_P1P2, ports: ['P1', 'P2', 'P1'] });
    check('重复港序 400 / duplicate_port',
      dupPorts.status === 400 && dupPorts.body.error.details.issues.some(
        (i) => i.reason === 'duplicate_port' && i.port === 'P1' && i.occurrences === 2));

    const unknownPort = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, {
      ...ALL_P1P2,
      boxPorts: ALL_P1P2.boxPorts.map((b) => (b.boxNo === 'A3' ? { ...b, port: 'P9' } : b)),
    });
    check('卸港不在港序 400 / unknown_port',
      unknownPort.status === 400 && unknownPort.body.error.details.issues.some(
        (i) => i.reason === 'unknown_port' && i.boxNo === 'A3' && i.port === 'P9'));

    const missing = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, {
      ...ALL_P1P2,
      boxPorts: ALL_P1P2.boxPorts.filter((b) => b.boxNo !== 'B3'),
    });
    check('箱号缺漏 400 / box_missing',
      missing.status === 400 && missing.body.error.details.issues.some(
        (i) => i.reason === 'box_missing' && i.boxNo === 'B3'));

    const extra = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, {
      ...ALL_P1P2,
      boxPorts: [...ALL_P1P2.boxPorts, { boxNo: 'ZZ', port: 'P1' }],
    });
    check('箱号多余 400 / box_unexpected',
      extra.status === 400 && extra.body.error.details.issues.some(
        (i) => i.reason === 'box_unexpected' && i.boxNo === 'ZZ'));

    const dupBox = await http('POST', `${BASE}/voyages/${vid}/manifests/1/discharge-review`, {
      ...ALL_P1P2,
      boxPorts: [...ALL_P1P2.boxPorts, { boxNo: 'A1', port: 'P2' }],
    });
    check('重复指派 400 / duplicate_box_assignment',
      dupBox.status === 400 && dupBox.body.error.details.issues.some(
        (i) => i.reason === 'duplicate_box_assignment' && i.boxNo === 'A1' && i.occurrences === 2));
  } finally {
    server.close();
    await pool.end().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
