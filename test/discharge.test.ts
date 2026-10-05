import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Placement, Position } from '../src/domain';
import {
  BoxPortAssignment,
  checkDischargePlan,
  simulateDischarge,
} from '../src/discharge';

const pos = (bay: number, row: number, tier: number): Position => ({ bay, row, tier });

// 两列各三层：列(1,1) = A1/A2/A3（自底向上），列(2,1) = B1/B2/B3
const placements: Placement[] = [
  { boxNo: 'A1', position: pos(1, 1, 0) },
  { boxNo: 'A2', position: pos(1, 1, 1) },
  { boxNo: 'A3', position: pos(1, 1, 2) },
  { boxNo: 'B1', position: pos(2, 1, 0) },
  { boxNo: 'B2', position: pos(2, 1, 1) },
  { boxNo: 'B3', position: pos(2, 1, 2) },
];
const manifestBoxNos = new Set(placements.map((p) => p.boxNo));

function plan(entries: Array<[string, string]>): BoxPortAssignment[] {
  return entries.map(([boxNo, port]) => ({ boxNo, port }));
}

function portMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries);
}

/* ---------- checkDischargePlan：请求级校验 ---------- */

test('合法请求：港序有序不重复、箱号与清单一一对应、卸港均在港序内', () => {
  const issues = checkDischargePlan(
    ['P1', 'P2'],
    plan([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P2'],
      ['B1', 'P1'], ['B2', 'P2'], ['B3', 'P2'],
    ]),
    manifestBoxNos,
  );
  assert.deepEqual(issues, []);
});

test('空港序拒绝：empty_port_sequence', () => {
  const issues = checkDischargePlan([], plan([['A1', 'P1']]), manifestBoxNos);
  assert.ok(issues.some((i) => i.reason === 'empty_port_sequence'));
});

test('重复港序拒绝：duplicate_port（含出现次数）', () => {
  const issues = checkDischargePlan(
    ['P1', 'P2', 'P1'],
    plan([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P2'],
      ['B1', 'P1'], ['B2', 'P2'], ['B3', 'P2'],
    ]),
    manifestBoxNos,
  );
  const dup = issues.find((i) => i.reason === 'duplicate_port');
  assert.ok(dup && 'port' in dup && dup.port === 'P1' && 'occurrences' in dup && dup.occurrences === 2);
});

test('卸港不在港序内拒绝：unknown_port', () => {
  const issues = checkDischargePlan(
    ['P1'],
    plan([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P9'],
      ['B1', 'P1'], ['B2', 'P1'], ['B3', 'P1'],
    ]),
    manifestBoxNos,
  );
  const unk = issues.find((i) => i.reason === 'unknown_port');
  assert.ok(unk && 'boxNo' in unk && unk.boxNo === 'A3' && 'port' in unk && unk.port === 'P9');
});

test('箱号缺漏拒绝：box_missing（清单箱未指派卸港）', () => {
  const issues = checkDischargePlan(
    ['P1'],
    plan([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P1'],
      ['B1', 'P1'], ['B2', 'P1'],
    ]),
    manifestBoxNos,
  );
  const miss = issues.find((i) => i.reason === 'box_missing');
  assert.ok(miss && 'boxNo' in miss && miss.boxNo === 'B3');
});

test('箱号多余拒绝：box_unexpected（清单外箱号）', () => {
  const issues = checkDischargePlan(
    ['P1'],
    plan([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P1'],
      ['B1', 'P1'], ['B2', 'P1'], ['B3', 'P1'], ['ZZ', 'P1'],
    ]),
    manifestBoxNos,
  );
  const extra = issues.find((i) => i.reason === 'box_unexpected');
  assert.ok(extra && 'boxNo' in extra && extra.boxNo === 'ZZ');
});

test('重复指派拒绝：duplicate_box_assignment', () => {
  const issues = checkDischargePlan(
    ['P1', 'P2'],
    plan([
      ['A1', 'P1'], ['A1', 'P2'], ['A2', 'P1'], ['A3', 'P1'],
      ['B1', 'P1'], ['B2', 'P1'], ['B3', 'P1'],
    ]),
    manifestBoxNos,
  );
  const dup = issues.find((i) => i.reason === 'duplicate_box_assignment');
  assert.ok(dup && 'boxNo' in dup && dup.boxNo === 'A1' && 'occurrences' in dup && dup.occurrences === 2);
});

test('空清单：港序非空且不指派任何箱即合法', () => {
  const issues = checkDischargePlan(['P1'], [], new Set());
  assert.deepEqual(issues, []);
});

/* ---------- simulateDischarge：逐港模拟 ---------- */

test('按列分港：全程无倒箱可行，同列自上而下逐轮卸下', () => {
  const r = simulateDischarge(
    placements,
    ['P1', 'P2'],
    portMap([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P1'],
      ['B1', 'P2'], ['B2', 'P2'], ['B3', 'P2'],
    ]),
  );
  assert.equal(r.feasible, true);
  assert.deepEqual(r.overcarried, []);
  const [p1, p2] = r.portResults;
  assert.equal(p1!.port, 'P1');
  // 同列自顶向下：A3 -> A2 -> A1
  assert.deepEqual(p1!.discharged.map((d) => d.boxNo), ['A3', 'A2', 'A1']);
  assert.deepEqual(p1!.blocked, []);
  assert.deepEqual(p2!.discharged.map((d) => d.boxNo), ['B3', 'B2', 'B1']);
  assert.equal(r.counts.expected, 6);
  assert.equal(r.counts.discharged, 6);
  assert.equal(r.counts.overcarried, 0);
});

test('被后续港箱压住的本港箱留船：受阻箱带阻挡箱号与箱位，最终逾港未卸', () => {
  const r = simulateDischarge(
    placements,
    ['P1', 'P2'],
    portMap([
      ['A1', 'P2'], ['A2', 'P2'], ['A3', 'P1'],
      ['B1', 'P1'], ['B2', 'P1'], ['B3', 'P2'],
    ]),
  );
  assert.equal(r.feasible, false);
  const [p1, p2] = r.portResults;
  // P1 只能卸走列(1,1)顶部的 A3；B1/B2 被后续港的 B3 压住
  assert.deepEqual(p1!.discharged.map((d) => d.boxNo), ['A3']);
  assert.deepEqual(p1!.blocked.map((b) => b.boxNo), ['B1', 'B2']);
  const b1 = p1!.blocked.find((b) => b.boxNo === 'B1')!;
  assert.deepEqual(b1.position, pos(2, 1, 0));
  assert.deepEqual(
    b1.blockedBy.map((x) => x.boxNo),
    ['B2', 'B3'],
    '阻挡箱自低向高',
  );
  assert.deepEqual(b1.blockedBy[1]!.position, pos(2, 1, 2));
  const b2 = p1!.blocked.find((b) => b.boxNo === 'B2')!;
  assert.deepEqual(b2.blockedBy.map((x) => x.boxNo), ['B3']);
  // P2 卸 A2/B3（同轮）后卸 A1；后续港不回补 B1/B2
  assert.deepEqual(p2!.discharged.map((d) => d.boxNo), ['A2', 'B3', 'A1']);
  assert.deepEqual(
    r.overcarried.map((o) => [o.boxNo, o.port]),
    [['B1', 'P1'], ['B2', 'P1']],
  );
  assert.equal(r.counts.discharged, 4);
  assert.equal(r.counts.overcarried, 2);
});

test('同港箱被同港箱压住可依次卸下；夹心的后续港箱阻断下方本港箱', () => {
  // 单列三层：X1(底)->P1，X2(中)->P2，X3(顶)->P1
  const single: Placement[] = [
    { boxNo: 'X1', position: pos(1, 1, 0) },
    { boxNo: 'X2', position: pos(1, 1, 1) },
    { boxNo: 'X3', position: pos(1, 1, 2) },
  ];
  const r = simulateDischarge(
    single,
    ['P1', 'P2'],
    portMap([['X1', 'P1'], ['X2', 'P2'], ['X3', 'P1']]),
  );
  const [p1, p2] = r.portResults;
  assert.deepEqual(p1!.discharged.map((d) => d.boxNo), ['X3']);
  assert.deepEqual(p1!.blocked.map((b) => b.boxNo), ['X1']);
  assert.deepEqual(p1!.blocked[0]!.blockedBy.map((x) => x.boxNo), ['X2']);
  assert.deepEqual(p2!.discharged.map((d) => d.boxNo), ['X2']);
  assert.deepEqual(r.overcarried.map((o) => o.boxNo), ['X1']);
  assert.equal(r.feasible, false);
});

test('同轮次不同列的可卸箱同时卸下，按箱位排序记录', () => {
  const two: Placement[] = [
    { boxNo: 'A1', position: pos(1, 1, 0) },
    { boxNo: 'A2', position: pos(1, 1, 1) },
    { boxNo: 'B1', position: pos(2, 1, 0) },
  ];
  const r = simulateDischarge(
    two,
    ['P1'],
    portMap([['A1', 'P1'], ['A2', 'P1'], ['B1', 'P1']]),
  );
  // 第一轮：A2（列1顶）与 B1（列2顶）；第二轮：A1
  assert.deepEqual(r.portResults[0]!.discharged.map((d) => d.boxNo), ['A2', 'B1', 'A1']);
  assert.equal(r.feasible, true);
});

test('无箱港口结果为空；空清单全程可行', () => {
  const r = simulateDischarge(
    placements,
    ['P0', 'P1'],
    portMap([
      ['A1', 'P1'], ['A2', 'P1'], ['A3', 'P1'],
      ['B1', 'P1'], ['B2', 'P1'], ['B3', 'P1'],
    ]),
  );
  assert.deepEqual(r.portResults[0]!.discharged, []);
  assert.deepEqual(r.portResults[0]!.blocked, []);
  assert.equal(r.feasible, true);

  const empty = simulateDischarge([], ['P1'], new Map());
  assert.equal(empty.feasible, true);
  assert.equal(empty.counts.expected, 0);
  assert.deepEqual(empty.overcarried, []);
});
