import { Pool } from 'pg';
import { HttpError } from './errors';
import { Placement } from './domain';
import {
  BoxPortAssignment,
  checkDischargePlan,
  simulateDischarge,
} from './discharge';

/* ---------- DTO ---------- */

export interface DischargeReviewInput {
  /** 有序且不重复的卸港列表（按卸货先后） */
  ports: string[];
  /** 清单内每个箱的卸港指派（箱号须与冻结清单完全一致） */
  boxPorts: BoxPortAssignment[];
}

/* ---------- 服务 ---------- */

export class DischargeService {
  constructor(private readonly pool: Pool) {}

  /**
   * 卸货审查：以某修订号的【已签发冻结清单】箱位为基准，按提交港序逐港模拟，
   * 判定全程无倒箱是否可行。只读操作，不落库：
   * 审查结果完全由冻结清单与本次提交的港序/卸港决定，航次后续调整、
   * 约束变更或签发新清单均不改变旧清单的审查结果。
   *
   *  - 航次不存在 → 404 voyage_not_found；
   *  - 该修订号无已签发清单 → 404 manifest_not_found；
   *  - 港序为空/重复、箱卸港不在港序、箱号缺漏/多余/重复指派 → 400 invalid_discharge_plan。
   */
  async review(voyageId: string, manifestRevision: number, input: DischargeReviewInput) {
    if (!Number.isInteger(manifestRevision) || manifestRevision < 0) {
      throw HttpError.badRequest('invalid_revision', '清单修订号必须为非负整数');
    }

    const client = await this.pool.connect();
    try {
      const voyage = await client.query(
        `SELECT id, voyage_no FROM voyages WHERE id = $1`,
        [voyageId],
      );
      if (voyage.rows.length === 0) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }

      const manifest = await client.query(
        `SELECT rev, box_count FROM manifests WHERE voyage_id = $1 AND rev = $2`,
        [voyageId, manifestRevision],
      );
      if (manifest.rows.length === 0) {
        throw HttpError.notFound(
          'manifest_not_found',
          `航次在修订号 ${manifestRevision} 没有已签发的装载清单，无法审查卸货`,
        );
      }

      // 冻结清单箱位（与后续布局调整/新清单解耦）
      const items = await client.query(
        `SELECT box_no, bay, row, tier FROM manifest_items
         WHERE voyage_id = $1 AND rev = $2 ORDER BY box_no`,
        [voyageId, manifestRevision],
      );
      const placements: Placement[] = items.rows.map((r) => ({
        boxNo: r.box_no as string,
        position: { bay: r.bay as number, row: r.row as number, tier: r.tier as number },
      }));

      // 请求级校验：港序/卸港指派与冻结清单的一致性
      const manifestBoxNos = new Set(placements.map((p) => p.boxNo));
      const issues = checkDischargePlan(input.ports, input.boxPorts, manifestBoxNos);
      if (issues.length > 0) {
        throw HttpError.invalidRequest(
          'invalid_discharge_plan',
          '卸货审查请求包含非法内容，已拒绝',
          { issueCount: issues.length, issues },
        );
      }

      const portOfBox = new Map(input.boxPorts.map((a) => [a.boxNo, a.port]));
      const simulation = simulateDischarge(placements, input.ports, portOfBox);

      return {
        voyageId,
        voyageNo: voyage.rows[0].voyage_no as string,
        manifestRevision,
        ports: input.ports,
        feasible: simulation.feasible,
        counts: simulation.counts,
        portResults: simulation.portResults,
        overcarried: simulation.overcarried,
      };
    } finally {
      client.release();
    }
  }
}
