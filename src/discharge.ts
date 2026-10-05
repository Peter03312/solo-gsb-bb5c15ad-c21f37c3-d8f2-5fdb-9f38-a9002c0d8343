/**
 * 已签发清单的逐港卸货审查（纯函数）。
 *
 * 以【冻结清单箱位】为基准，按调度员提交的有序卸港列表逐港模拟卸货：
 *   - 每港反复卸走“上方已空（同列更高层无在船箱）且属于本港”的箱，直到再无可卸箱；
 *   - 被后续港箱压住的本港箱留船（受阻箱），后续港不回补此前漏卸的箱；
 *   - 全部港口处理完后仍在船的箱为逾港未卸箱；无逾港未卸箱即全程无倒箱可行。
 *
 * 审查只读取签发时冻结的清单箱位（manifest_items），航次后续调整、
 * 约束变更或签发新清单均不改变旧清单的审查结果。
 */

import { Placement, Position } from './domain';

/** 一箱的卸港指派（卸港必须出现在港序列表中） */
export interface BoxPortAssignment {
  boxNo: string;
  port: string;
}

/** 请求级问题（任一存在即 400 整批拒绝） */
export type DischargeRequestIssue =
  | { reason: 'empty_port_sequence'; message: string }
  | { reason: 'duplicate_port'; message: string; port: string; occurrences: number }
  | { reason: 'unknown_port'; message: string; boxNo: string; port: string }
  | { reason: 'duplicate_box_assignment'; message: string; boxNo: string; occurrences: number }
  | { reason: 'box_missing'; message: string; boxNo: string }
  | { reason: 'box_unexpected'; message: string; boxNo: string };

/** 实际卸下的一箱（含冻结清单中的箱位） */
export interface DischargedBox {
  boxNo: string;
  position: Position;
}

/** 受阻箱：属于本港但离港时仍在船；blockedBy 为上方仍在船的阻挡箱（同列更高层，自低向高） */
export interface BlockedBox {
  boxNo: string;
  position: Position;
  blockedBy: DischargedBox[];
}

/** 一个卸港的模拟结果 */
export interface PortDischargeResult {
  port: string;
  /** 本港实际卸箱（按卸下先后，同轮次按箱位排序） */
  discharged: DischargedBox[];
  /** 本港受阻箱（卸港为本港、离港时仍留船） */
  blocked: BlockedBox[];
}

/** 逾港未卸箱：全程结束后仍在船（原定卸港已过，后续港不回补） */
export interface OvercarriedBox {
  boxNo: string;
  position: Position;
  /** 原定卸港 */
  port: string;
}

export interface DischargeSimulation {
  portResults: PortDischargeResult[];
  overcarried: OvercarriedBox[];
  /** 全程无倒箱可行 = 无逾港未卸箱 */
  feasible: boolean;
  counts: {
    /** 清单箱总数 */
    expected: number;
    /** 全程实际卸下总数 */
    discharged: number;
    /** 逾港未卸总数 */
    overcarried: number;
  };
}

/**
 * 校验卸货审查请求本身是否合法（不涉及模拟）：
 * 港序非空且不重复；每箱卸港出现在港序中；箱号与冻结清单完全一致
 * （不缺漏、不多余、不重复指派）。
 */
export function checkDischargePlan(
  ports: string[],
  boxPorts: BoxPortAssignment[],
  manifestBoxNos: Set<string>,
): DischargeRequestIssue[] {
  const issues: DischargeRequestIssue[] = [];

  if (ports.length === 0) {
    issues.push({
      reason: 'empty_port_sequence',
      message: '卸港列表不能为空，必须按卸货顺序给出至少一个港口',
    });
  }

  const portSeen = new Map<string, number>();
  for (const port of ports) {
    portSeen.set(port, (portSeen.get(port) ?? 0) + 1);
  }
  for (const [port, occurrences] of [...portSeen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (occurrences > 1) {
      issues.push({
        reason: 'duplicate_port',
        message: `卸港 ${port} 在港序中出现了 ${occurrences} 次，港序不得重复`,
        port,
        occurrences,
      });
    }
  }

  const portSet = new Set(ports);
  const assignSeen = new Map<string, number>();
  for (const a of boxPorts) {
    assignSeen.set(a.boxNo, (assignSeen.get(a.boxNo) ?? 0) + 1);
    if (!portSet.has(a.port)) {
      issues.push({
        reason: 'unknown_port',
        message: `箱 ${a.boxNo} 的卸港 ${a.port} 不在卸港列表中`,
        boxNo: a.boxNo,
        port: a.port,
      });
    }
    if (!manifestBoxNos.has(a.boxNo)) {
      issues.push({
        reason: 'box_unexpected',
        message: `箱号 ${a.boxNo} 不在该清单中，箱号须与清单完全一致`,
        boxNo: a.boxNo,
      });
    }
  }
  for (const [boxNo, occurrences] of [...assignSeen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (occurrences > 1) {
      issues.push({
        reason: 'duplicate_box_assignment',
        message: `箱 ${boxNo} 被指派了 ${occurrences} 次卸港，每箱至多一条`,
        boxNo,
        occurrences,
      });
    }
  }

  const assigned = new Set(boxPorts.map((a) => a.boxNo));
  for (const boxNo of [...manifestBoxNos].sort((a, b) => a.localeCompare(b))) {
    if (!assigned.has(boxNo)) {
      issues.push({
        reason: 'box_missing',
        message: `清单箱 ${boxNo} 缺少卸港指派，清单内每个箱都必须给出卸港`,
        boxNo,
      });
    }
  }

  return issues.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) ||
      issueSortKey(a).localeCompare(issueSortKey(b)),
  );
}

function issueSortKey(issue: DischargeRequestIssue): string {
  if ('boxNo' in issue) return issue.boxNo;
  if ('port' in issue) return issue.port;
  return '';
}

function compareByPosition(a: Position, b: Position, boxA: string, boxB: string): number {
  return (
    a.bay - b.bay || a.row - b.row || a.tier - b.tier || boxA.localeCompare(boxB)
  );
}

interface OnBoardBox {
  boxNo: string;
  position: Position;
  port: string;
}

/** 同列更高层仍在船的箱（自低向高排序） */
function blockersAbove(onBoard: Map<string, OnBoardBox>, box: OnBoardBox): DischargedBox[] {
  const above: DischargedBox[] = [];
  for (const other of onBoard.values()) {
    if (
      other.boxNo !== box.boxNo &&
      other.position.bay === box.position.bay &&
      other.position.row === box.position.row &&
      other.position.tier > box.position.tier
    ) {
      above.push({ boxNo: other.boxNo, position: other.position });
    }
  }
  return above.sort((a, b) => a.position.tier - b.position.tier);
}

/**
 * 按冻结清单箱位逐港模拟卸货。
 *
 * placements 为清单冻结箱位（每箱一条）；ports 为有序且不重复的卸港列表；
 * portOfBox 给出每个清单箱的卸港（调用方保证与清单一一对应且港口合法）。
 */
export function simulateDischarge(
  placements: Placement[],
  ports: string[],
  portOfBox: Map<string, string>,
): DischargeSimulation {
  const onBoard = new Map<string, OnBoardBox>();
  for (const p of placements) {
    onBoard.set(p.boxNo, {
      boxNo: p.boxNo,
      position: p.position,
      port: portOfBox.get(p.boxNo)!,
    });
  }

  const portResults: PortDischargeResult[] = [];
  let dischargedTotal = 0;

  for (const port of ports) {
    const discharged: DischargedBox[] = [];

    // 反复卸走上方已空且属于本港的箱，直到再无可卸箱。
    // 同一轮可卸的箱互不在对方上方（上方有箱即不可卸），整轮同时卸下与逐一卸下等价。
    for (;;) {
      const round = [...onBoard.values()]
        .filter((b) => b.port === port && blockersAbove(onBoard, b).length === 0)
        .sort((a, b) => compareByPosition(a.position, b.position, a.boxNo, b.boxNo));
      if (round.length === 0) break;
      for (const b of round) {
        onBoard.delete(b.boxNo);
        discharged.push({ boxNo: b.boxNo, position: b.position });
      }
    }

    // 本港受阻箱：属于本港但离港时仍留船，记录上方仍在船的阻挡箱
    const blocked: BlockedBox[] = [...onBoard.values()]
      .filter((b) => b.port === port)
      .sort((a, b) => compareByPosition(a.position, b.position, a.boxNo, b.boxNo))
      .map((b) => ({
        boxNo: b.boxNo,
        position: b.position,
        blockedBy: blockersAbove(onBoard, b),
      }));

    dischargedTotal += discharged.length;
    portResults.push({ port, discharged, blocked });
  }

  // 后续港不回补：仍留船的箱即逾港未卸
  const overcarried: OvercarriedBox[] = [...onBoard.values()]
    .sort((a, b) => compareByPosition(a.position, b.position, a.boxNo, b.boxNo))
    .map((b) => ({ boxNo: b.boxNo, position: b.position, port: b.port }));

  return {
    portResults,
    overcarried,
    feasible: overcarried.length === 0,
    counts: {
      expected: placements.length,
      discharged: dischargedTotal,
      overcarried: overcarried.length,
    },
  };
}
