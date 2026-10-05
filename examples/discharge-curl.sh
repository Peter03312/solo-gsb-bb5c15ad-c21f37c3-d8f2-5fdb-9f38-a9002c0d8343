#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 已签发清单卸货审查（无倒箱可行性）curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/discharge-curl.sh
#
# 演示：登记 -> 配位 -> 签发清单 ->
#       提交航次+清单修订号、有序卸港列表与每箱卸港进行卸货审查：
#         · 按冻结清单箱位逐港模拟，上方已空且属于本港的箱反复卸走
#         · 可行方案：各港实际卸箱、全程无倒箱 feasible=true
#         · 不可行方案：受阻箱及其上方仍在船阻挡箱号与箱位、逾港未卸箱
#       航次后续调整/签发新清单后旧清单审查结果不变；
#       未知清单 404；空港序/重复港序/卸港未知/箱号缺漏/多余 -> 400 明确拒绝。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jqid() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }

say "健康检查"
curl -sS "$BASE/health"; echo

say "1) 登记航次 V-DIS-$(date +%s)（2x1x3 两列三层，6 箱）"
VOYAGE_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-DIS-'$(date +%s)'",
  "bays": 2, "rows": 1, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "boxes": [
    { "boxNo": "A1", "weight": "100", "category": "1" },
    { "boxNo": "A2", "weight": "100", "category": "1" },
    { "boxNo": "A3", "weight": "100", "category": "1" },
    { "boxNo": "B1", "weight": "100", "category": "1" },
    { "boxNo": "B2", "weight": "100", "category": "1" },
    { "boxNo": "B3", "weight": "100", "category": "1" }
  ],
  "incompatRules": []
}')
echo "$VOYAGE_JSON"
VID=$(echo "$VOYAGE_JSON" | jqid id)
echo "voyageId=$VID"

say "2) 配位（revision 0 -> 1）：列(1,1)=A1/A2/A3 自底向上，列(2,1)=B1/B2/B3"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "A1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "A2", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "A3", "position": { "bay": 1, "row": 1, "tier": 2 } },
    { "boxNo": "B1", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "B2", "position": { "bay": 2, "row": 1, "tier": 1 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 1, "tier": 2 } }
  ]
}' >/dev/null
echo "航次当前修订号=1"

say "3) 签发装载清单（冻结 rev=1 箱位）"
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 1
}'; echo

say "4) 卸货审查（可行）：港序 [P1,P2]，列(1,1) 全去 P1、列(2,1) 全去 P2"
echo "   -> 各港自顶向下卸箱，feasible=true，无逾港未卸箱"
curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-review" -H 'content-type: application/json' -d '{
  "ports": ["P1", "P2"],
  "boxPorts": [
    { "boxNo": "A1", "port": "P1" }, { "boxNo": "A2", "port": "P1" }, { "boxNo": "A3", "port": "P1" },
    { "boxNo": "B1", "port": "P2" }, { "boxNo": "B2", "port": "P2" }, { "boxNo": "B3", "port": "P2" }
  ]
}'; echo

say "5) 卸货审查（不可行）：B1/B2 去 P1 却被去 P2 的 B3 压住"
echo "   -> P1 受阻箱 B1/B2 及其上方阻挡箱号与箱位；B1/B2 最终逾港未卸，feasible=false"
curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-review" -H 'content-type: application/json' -d '{
  "ports": ["P1", "P2"],
  "boxPorts": [
    { "boxNo": "A1", "port": "P2" }, { "boxNo": "A2", "port": "P2" }, { "boxNo": "A3", "port": "P1" },
    { "boxNo": "B1", "port": "P1" }, { "boxNo": "B2", "port": "P1" }, { "boxNo": "B3", "port": "P2" }
  ]
}'; echo

say "6) 冻结：航次继续前进（A1<->B1 互换，rev=2）并签发新清单，旧清单(rev1)审查结果不变"
curl -sS -X POST "$API/voyages/$VID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [
    { "boxNo": "A1", "position": { "bay": 2, "row": 1, "tier": 0 } },
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } }
  ]
}' >/dev/null
curl -sS -X POST "$API/voyages/$VID/manifests" -H 'content-type: application/json' -d '{
  "expectedRevision": 2
}' >/dev/null
echo "航次当前修订号=2，已签发新清单；重审旧清单 rev=1（与第 5 步结果一致）："
curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-review" -H 'content-type: application/json' -d '{
  "ports": ["P1", "P2"],
  "boxPorts": [
    { "boxNo": "A1", "port": "P2" }, { "boxNo": "A2", "port": "P2" }, { "boxNo": "A3", "port": "P1" },
    { "boxNo": "B1", "port": "P1" }, { "boxNo": "B2", "port": "P1" }, { "boxNo": "B3", "port": "P2" }
  ]
}'; echo

say "7) 拒绝演示：未知清单 404 manifest_not_found"
curl -sS -X POST "$API/voyages/$VID/manifests/99/discharge-review" -H 'content-type: application/json' -d '{
  "ports": ["P1"],
  "boxPorts": [
    { "boxNo": "A1", "port": "P1" }, { "boxNo": "A2", "port": "P1" }, { "boxNo": "A3", "port": "P1" },
    { "boxNo": "B1", "port": "P1" }, { "boxNo": "B2", "port": "P1" }, { "boxNo": "B3", "port": "P1" }
  ]
}'; echo

say "8) 拒绝演示：重复港序 + 箱号缺漏/多余 -> 400 invalid_discharge_plan（issues 逐项列出）"
curl -sS -X POST "$API/voyages/$VID/manifests/1/discharge-review" -H 'content-type: application/json' -d '{
  "ports": ["P1", "P1"],
  "boxPorts": [
    { "boxNo": "A1", "port": "P1" }, { "boxNo": "A2", "port": "P1" },
    { "boxNo": "B1", "port": "P1" }, { "boxNo": "B2", "port": "P1" },
    { "boxNo": "ZZ", "port": "P1" }
  ]
}'; echo
echo "（上例同时缺少 A3/B3 的卸港指派、港序重复、ZZ 为清单外箱号）"
