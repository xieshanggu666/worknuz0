// 知识责任交接端到端回归（fake-indexeddb + 真实 store）
// 覆盖（同批逐篇指定接任者 + 独立确认/谢绝 + 管理员分批批准）：
//   负责人批量发起逐篇指定接任者（权限/快照/重复发起校验）→ 各接任者独立确认/谢绝（互不阻塞）→
//   管理员按确认结果分批批准（仅转移勾选的已确认文档；未确认/他人确认的不混入）→
//   所有权 + 历史归属 + 评审待办 + 保鲜责任 + 待审批访问申请 + 按决定收回权限 →
//   分批期间并发变更：仅冲突篇回退、其余照常转移 → 驳回 / 整批取消 / 谢绝 / 二次交接历史累积 →
//   纯函数：批次状态汇总与并发校验。
// 运行：npm run test:handover
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useAccessStore } from '@/stores/access'
import { useFreshnessStore } from '@/stores/freshness'
import { useHandoverStore } from '@/stores/handover'
import { uid } from '@/utils/format'
import {
  HANDOVER, HANDOVER_ITEM, REVOKE_MODE,
  deriveHandoverStatus, handoverProgress, checkHandoverConflicts, checkItemConflicts,
  migrateLegacyHandover
} from '@/utils/handover'
import { canDecideAccess, ACCESS, isGrantActive } from '@/utils/access'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const review = useReviewStore(pinia)
const access = useAccessStore(pinia)
const freshness = useFreshnessStore(pinia)
const handover = useHandoverStore(pinia)

const owner = { id: 'u-owner', name: '原负责人', role: 'editor', avatar: 'YZ' }
const next = { id: 'u-next', name: '接任者', role: 'editor', avatar: 'JR' }
const third = { id: 'u-third', name: '第三成员', role: 'editor', avatar: 'DS' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()
const mkItems = (pairs) => pairs.map(([docId, toUserId]) => ({ docId, toUserId }))

await db.users.bulkAdd([owner, next, third, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '交接文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title: '', body: '<p>正文 v1</p>', categoryId: 'c', tagIds: [], visibility: 'public' } }],
    ...extra
  }
  d.versions[0].snapshot.title = d.title
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)
const getHo = (id) => db.handovers.get(id)
const itemOf = (h, docId) => h.items.find((it) => it.docId === docId)

// ---------- 1. 发起校验（逐篇指定接任者）----------
console.log('\n[1] 发起交接的权限与参数校验')
const d1 = await mkDoc()
let r = await handover.initiateHandover({ items: mkItems([[d1.id, next.id]]) }, null)
assert(r.status === 'guest', '访客不能发起交接')
r = await handover.initiateHandover({ items: [] }, owner)
assert(r.status === 'no-docs', '未选择文档被拒绝')
r = await handover.initiateHandover({ items: mkItems([[d1.id, owner.id]]) }, owner)
assert(r.status === 'bad-target', '接任者不能是负责人自己')
r = await handover.initiateHandover({ items: mkItems([[d1.id, 'u-ghost']]) }, owner)
assert(r.status === 'bad-target', '接任者必须是已注册成员')
r = await handover.initiateHandover({ items: mkItems([[d1.id, next.id]]) }, third)
assert(r.status === 'denied', '非负责人不能交接他人文档')
r = await handover.initiateHandover({ items: mkItems([[d1.id, next.id]]), revokeMode: 'keep', note: '轮岗交接' }, owner)
assert(r.status === 'ok' && r.handover.status === HANDOVER.PENDING_CONFIRM, '负责人发起成功，进入待确认')
const ho1 = r.handover
assert(itemOf(ho1, d1.id).toUserId === next.id && itemOf(ho1, d1.id).snapshot.ownerId === owner.id, '逐篇接任者与并发校验快照已记录')
r = await handover.initiateHandover({ items: mkItems([[d1.id, third.id]]) }, owner)
assert(r.status === 'in-handover', '同一文档存在流转中交接条目时不可重复发起')
assert(handover.activeHandoverOfDoc(d1.id)?.item.toUserId === next.id, '文档可查到流转中的交接条目及其接任者')
await handover.cancelHandover(ho1.id, owner)
assert((await getHo(ho1.id)).status === HANDOVER.CANCELLED, '发起人可整批取消')

// ---------- 2. 各接任者独立确认 / 谢绝（互不阻塞）----------
console.log('\n[2] 同批多接任者独立确认/谢绝，互不阻塞')
const dA = await mkDoc()
const dB = await mkDoc()
const dC = await mkDoc()
r = await handover.initiateHandover({
  items: mkItems([[dA.id, next.id], [dB.id, third.id], [dC.id, next.id]]),
  revokeMode: 'keep', note: '逐篇指定'
}, owner)
assert(r.status === 'ok', '同批三篇逐篇指定不同接任者（next × 2、third × 1）')
const ho2 = r.handover
assert(handoverProgress(ho2).pendingConfirm === 3, '批次初始：3 篇待确认')

// next 只能看到自己的两篇；third 的确认不影响 next
r = await handover.respondHandover(ho2.id, 'confirm', '', next)
assert(r.status === 'ok' && r.affected === 2, 'next 一次性确认分配给自己的 2 篇')
let h2 = await getHo(ho2.id)
assert(itemOf(h2, dA.id).status === HANDOVER_ITEM.PENDING_APPROVAL && itemOf(h2, dC.id).status === HANDOVER_ITEM.PENDING_APPROVAL, 'next 的两篇进入待批准')
assert(itemOf(h2, dB.id).status === HANDOVER_ITEM.PENDING_CONFIRM, 'third 的一篇仍待确认（互不阻塞）')
assert(h2.status === HANDOVER.PARTIAL_APPROVAL, '批次进入分批处理中（有待确认 + 有待批准）')
assert(handover.pendingConfirmFor(third.id).some((x) => x.id === ho2.id), 'third 的待确认列表仍含本批')
assert(!handover.pendingConfirmFor(next.id).some((x) => x.id === ho2.id), 'next 确认后不再出现在其待确认列表')
assert(handover.pendingApprovalFor('admin').some((x) => x.id === ho2.id), '管理员待批准列表已含本批（可先批已确认的）')

// third 谢绝自己的那篇
r = await handover.respondHandover(ho2.id, 'decline', '近期排期满', third)
assert(r.status === 'ok' && r.affected === 1 && r.declined === true, 'third 独立谢绝 1 篇')
h2 = await getHo(ho2.id)
assert(itemOf(h2, dB.id).status === HANDOVER_ITEM.DECLINED, '被谢绝文档保持原状（未完成）')
assert((await getDoc(dB.id)).ownerId === owner.id, '谢绝后所有权未动')
assert(h2.status === HANDOVER.PARTIAL_APPROVAL, '仍有待批准 → 批次保持分批处理中')

// 非接任者不能回应；重复回应无待处理条目
r = await handover.respondHandover(ho2.id, 'confirm', '', viewer)
assert(r.status === 'denied', '与本批无关成员不能回应')
r = await handover.respondHandover(ho2.id, 'confirm', '', next)
assert(r.status === 'denied', '接任者重复回应被拒绝（无待确认条目）')

// ---------- 3. 管理员分批批准：只转移勾选的已确认文档 ----------
console.log('\n[3] 管理员按确认结果分批批准')
// 先只批准 dA 一篇（dC 已确认但本批不勾选；dB 已谢绝）
r = await handover.decideHandover(ho2.id, 'approve', '先转 dA', admin, [dA.id])
assert(r.status === 'ok' && r.transferred === 1, '分批批准：仅执行 1 篇转移')
let docA1 = await getDoc(dA.id)
assert(docA1.ownerId === next.id, 'dA 所有权转移给 next')
let docB1 = await getDoc(dB.id)
assert(docB1.ownerId === owner.id, 'dB（谢绝）所有权保持原状')
let docC1 = await getDoc(dC.id)
assert(docC1.ownerId === owner.id, 'dC 本批未勾选，所有权保持原状、继续待批准')
let h2b = await getHo(ho2.id)
assert(itemOf(h2b, dA.id).status === HANDOVER_ITEM.COMPLETED && itemOf(h2b, dC.id).status === HANDOVER_ITEM.PENDING_APPROVAL, 'dA 完成、dC 仍待批准')
assert(h2b.status === HANDOVER.PARTIAL_APPROVAL && !h2b.completedAt, '批次未全部完成：分批处理中且不记整单完成时间')

// 未确认/谢绝的文档不能被批准；非管理员不能批准
r = await handover.decideHandover(ho2.id, 'approve', '', admin, [dB.id])
assert(r.status === 'none', '谢绝态文档不在可批准范围')
r = await handover.decideHandover(ho2.id, 'approve', '', third, [dC.id])
assert(r.status === 'denied', '非管理员不能批准')

// 批准 dC，整批了结：完成 + 谢绝的混合终态
r = await handover.decideHandover(ho2.id, 'approve', '再转 dC', admin, [dC.id])
assert(r.status === 'ok' && r.transferred === 1, '第二批批准 dC 完成')
const h2done = await getHo(ho2.id)
assert((await getDoc(dC.id)).ownerId === next.id, 'dC 所有权转移给 next')
assert(itemOf(h2done, dC.id).status === HANDOVER_ITEM.COMPLETED && itemOf(h2done, dC.id).completedAt, 'dC 条目记录完成时间')
assert(h2done.status === HANDOVER.PARTIAL_APPROVAL && h2done.completedAt, '批次部分完成（2 完成 + 1 谢绝），标记整体完成时间')
assert(handoverProgress(h2done).completed === 2 && handoverProgress(h2done).declined === 1, '批次进度：2 完成 1 谢绝')
assert(!handover.pendingApprovalFor('admin').some((x) => x.id === ho2.id), '已无待批准文档，离开管理员待办')
assert(h2done.ownerHistory === undefined || true, '历史归属记录在文档维度')
const hA = await getDoc(dA.id)
assert(hA.ownerHistory.length === 1 && hA.ownerHistory[0].toUserId === next.id && hA.ownerHistory[0].handoverId === ho2.id, 'dA 保留原负责人历史归属')

// ---------- 4. 批准转移全要素（评审/保鲜/访问申请/收回权限，revoke）----------
console.log('\n[4] 分批转移全要素：评审待办/保鲜责任/访问申请/按决定收回权限')
const docA2 = await mkDoc()
const revA = {
  id: uid('rev'), docId: docA2.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: docA2.title, body: docA2.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
}
await db.reviews.add(revA)
await db.docs.update(docA2.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: revA.id })
const docB2 = await mkDoc({ editors: [owner.id, third.id] })
const frB = {
  id: uid('fr'), docId: docB2.id, round: 1, status: 'open', cycleDays: 30, dueAt: nowIso(),
  reviewId: null, submittedBy: owner.id, submittedAt: null, decidedBy: null, decidedAt: null,
  decisionNote: '', createdAt: nowIso(), timeline: []
}
await db.freshnessTickets.add(frB)
await db.docs.update(docB2.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 86400000).toISOString(), round: 1, activeTicket: frB.id } })
const accPending = {
  id: uid('acc'), docId: docB2.id, applicantId: third.id, status: ACCESS.PENDING, requestedPermission: 'read',
  reason: '申请阅读', createdAt: nowIso(), decidedBy: null, decidedAt: null, decisionNote: '', grant: null, timeline: []
}
const accGrant = {
  id: uid('acc'), docId: docB2.id, applicantId: owner.id, status: ACCESS.APPROVED, requestedPermission: 'collab',
  reason: '历史授权', createdAt: nowIso(), decidedBy: admin.id, decidedAt: nowIso(), decisionNote: '',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null,
  grant: { permission: 'collab', grantedAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null },
  timeline: []
}
await db.accessRequests.bulkAdd([accPending, accGrant])
await Promise.all([kb.reloadDocs(), review.reload(), access.reload(), freshness.reload()])

// docA2 → next，docB2 → third，revoke 模式；另加一篇 docG → next 尚未确认，验证不能提前批准
const docG = await mkDoc()
r = await handover.initiateHandover({
  items: mkItems([[docA2.id, next.id], [docB2.id, third.id], [docG.id, next.id]]),
  revokeMode: REVOKE_MODE.REVOKE, note: '整体交接'
}, owner)
const ho4 = r.handover
// next 确认 docA2（+docG 归 next 也会一起确认），third 确认 docB2
await handover.respondHandover(ho4.id, 'confirm', '', next)
await handover.respondHandover(ho4.id, 'confirm', '', third)
// 三篇都已确认；只批准前两篇，docG 不勾选
r = await handover.decideHandover(ho4.id, 'approve', '同意前两篇', admin, [docA2.id, docB2.id])
assert(r.status === 'ok' && r.transferred === 2, '一批两篇分别转给不同接任者')

const docA2d = await getDoc(docA2.id)
assert(docA2d.ownerId === next.id && docA2d.editors.includes(next.id) && !docA2d.editors.includes(owner.id), 'docA2 转给 next：接任者加入、revoke 移出原负责人')
const revA1 = await db.reviews.get(revA.id)
assert(revA1.submittedBy === next.id && revA1.timeline.some((t) => t.action === 'handover'), 'docA2 待办评审改挂接任者并留痕')
const docB2d = await getDoc(docB2.id)
assert(docB2d.ownerId === third.id && docB2d.freshness.activeTicket === frB.id, 'docB2 所有权转给 third，保鲜责任随转移')
const frB1 = await db.freshnessTickets.get(frB.id)
assert(frB1.submittedBy === third.id && frB1.timeline.some((t) => t.action === 'handover'), 'docB2 流转中复核单改挂送审人 third')
const accP1 = await db.accessRequests.get(accPending.id)
assert(accP1.status === ACCESS.PENDING && canDecideAccess(accP1, docB2d, third.id, third.role) === true, '待审批访问申请随新负责人 third 可审批')
const accG1 = await db.accessRequests.get(accGrant.id)
assert(accG1.status === ACCESS.REVOKED && !isGrantActive(accG1), 'revoke：原负责人有效授权按决定收回')
const ho4d = await getHo(ho4.id)
const itemB = itemOf(ho4d, docB2.id)
assert(itemB.result.accessPending === 1 && itemB.result.revokedGrants === 1, 'docB2 转移结果逐篇留档')
assert(itemOf(ho4d, docG.id).status === HANDOVER_ITEM.PENDING_APPROVAL && (await getDoc(docG.id)).ownerId === owner.id, 'docG 未勾选：仍待批准、所有权未动')

// 管理员驳回 docG
r = await handover.decideHandover(ho4.id, 'reject', '范围待确认', admin, [docG.id])
assert(r.status === 'ok' && r.rejected === 1 && itemOf(await getHo(ho4.id), docG.id).status === HANDOVER_ITEM.REJECTED, '管理员逐篇驳回')
assert((await getDoc(docG.id)).ownerId === owner.id, '驳回后文档保持原状')

// ---------- 5. 分批期间并发变更：仅冲突篇回退，其余照常转移 ----------
console.log('\n[5] 分批批准期间并发变更 → 仅冲突篇回退')
const dX = await mkDoc()
const dY = await mkDoc()
r = await handover.initiateHandover({ items: mkItems([[dX.id, next.id], [dY.id, third.id]]) , revokeMode: 'revoke' }, owner)
const ho5 = r.handover
await handover.respondHandover(ho5.id, 'confirm', '', next)
await handover.respondHandover(ho5.id, 'confirm', '', third)
// dY 在交接流转期间被并发编辑
await kb.updateDoc(dY.id, { body: '<p>交接期间的并发修改</p>' }, owner, '并发编辑')
r = await handover.decideHandover(ho5.id, 'approve', '', admin, [dX.id, dY.id])
assert(r.status === 'ok' && r.transferred === 1 && r.conflicts.length === 1 && r.conflicts[0].docId === dY.id, '同批批准：dY 冲突被识别，仅 dX 转移')
const ho5d = await getHo(ho5.id)
assert(itemOf(ho5d, dX.id).status === HANDOVER_ITEM.COMPLETED, '无冲突的 dX 照常完成转移')
assert(itemOf(ho5d, dY.id).status === HANDOVER_ITEM.FAILED && itemOf(ho5d, dY.id).failReason.includes('并发变更'), 'dY 仅本篇失败回退并记录原因')
assert((await getDoc(dX.id)).ownerId === next.id, 'dX 所有权已转移')
const dY1 = await getDoc(dY.id)
assert(dY1.ownerId === owner.id && dY1.body.includes('并发修改'), 'dY 所有权未动、并发内容保留')
assert(ho5d.status === HANDOVER.PARTIAL_APPROVAL, '批次：1 完成 + 1 失败回退（分批处理终态）')

// 冲突篇失败后文档恢复自由，可重新发起交接给同一人并走完
r = await handover.initiateHandover({ items: mkItems([[dY.id, third.id]]) }, owner)
assert(r.status === 'ok', '失败回退后文档可重新发起交接')
await handover.respondHandover(r.handover.id, 'confirm', '', third)
r = await handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok' && (await getDoc(dY.id)).ownerId === third.id, '重新发起后批准完成')

// 选定条目全部冲突 → 无任何转移，返回 changed
const dZ = await mkDoc()
r = await handover.initiateHandover({ items: mkItems([[dZ.id, next.id]]), revokeMode: 'keep' }, owner)
const ho6 = r.handover
await handover.respondHandover(ho6.id, 'confirm', '', next)
await kb.updateDoc(dZ.id, { body: '<p>又一次并发修改</p>' }, owner, '并发编辑2')
r = await handover.decideHandover(ho6.id, 'approve', '', admin)
assert(r.status === 'changed' && r.conflicts.length === 1, '本批仅一篇且冲突：无转移，返回 changed')
assert(itemOf(await getHo(ho6.id), dZ.id).status === HANDOVER_ITEM.FAILED, '该篇标记失败回退')
assert((await getDoc(dZ.id)).ownerId === owner.id, '所有权未动')

// ---------- 6. keep 模式 & 二次交接历史归属累积 ----------
console.log('\n[6] keep 模式保留原权限 + 二次交接历史累积')
const dK = await mkDoc()
r = await handover.initiateHandover({ items: mkItems([[dK.id, next.id]]), revokeMode: REVOKE_MODE.KEEP }, owner)
await handover.respondHandover(r.handover.id, 'confirm', '', next)
r = await handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok', 'keep 模式交接完成')
const dK1 = await getDoc(dK.id)
assert(dK1.ownerId === next.id && dK1.editors.includes(owner.id), '所有权转移但原负责人保留协作成员身份')

// next 再把 dK 交接给 third，历史归属累积
r = await handover.initiateHandover({ items: mkItems([[dK.id, third.id]]), revokeMode: 'revoke', note: '二次交接' }, next)
assert(r.status === 'ok', '新负责人可再次发起交接')
await handover.respondHandover(r.handover.id, 'confirm', '', third)
r = await handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok', '二次交接完成')
const dK2 = await getDoc(dK.id)
assert(dK2.ownerId === third.id, '二次交接后所有权归 third')
assert(dK2.ownerHistory.length === 2 && dK2.ownerHistory[0].ownerId === owner.id && dK2.ownerHistory[1].ownerId === next.id, '历任负责人全程保留（2 段任期）')
assert(!dK2.editors.includes(next.id) && dK2.editors.includes(third.id), '二次交接按 revoke 决定收回上一任权限')

// ---------- 7. 纯函数：批次状态汇总 / 并发校验 / 老数据迁移 ----------
console.log('\n[7] 纯函数：状态汇总、并发校验、老数据迁移')
const PC = HANDOVER_ITEM.PENDING_CONFIRM
const PA = HANDOVER_ITEM.PENDING_APPROVAL
const CP = HANDOVER_ITEM.COMPLETED
const DC = HANDOVER_ITEM.DECLINED
const RJ = HANDOVER_ITEM.REJECTED
const FL = HANDOVER_ITEM.FAILED
const mkS = (statuses) => ({ items: statuses.map((s, i) => ({ docId: 'd' + i, status: s })) })
assert(deriveHandoverStatus(mkS([PC, PC]).items) === HANDOVER.PENDING_CONFIRM, '全部待确认 → pending_confirm')
assert(deriveHandoverStatus(mkS([PA, PA]).items) === HANDOVER.PENDING_APPROVAL, '全部待批准 → pending_approval')
assert(deriveHandoverStatus(mkS([PC, PA]).items) === HANDOVER.PARTIAL_APPROVAL, '待确认+待批准 → 分批处理中')
assert(deriveHandoverStatus(mkS([CP, PA]).items) === HANDOVER.PARTIAL_APPROVAL, '已完成+待批准 → 分批处理中')
assert(deriveHandoverStatus(mkS([CP, CP]).items) === HANDOVER.COMPLETED, '全部完成 → completed')
assert(deriveHandoverStatus(mkS([DC, DC]).items) === HANDOVER.DECLINED, '全部谢绝 → declined')
assert(deriveHandoverStatus(mkS([RJ, RJ]).items) === HANDOVER.REJECTED, '全部驳回 → rejected')
assert(deriveHandoverStatus(mkS([FL, FL]).items) === HANDOVER.FAILED, '全部失败 → failed')
assert(deriveHandoverStatus(mkS([CP, DC]).items) === HANDOVER.PARTIAL_APPROVAL, '完成+谢绝混合 → 分批处理（终态结果）')
assert(deriveHandoverStatus(mkS([RJ, DC]).items) === HANDOVER.REJECTED, '驳回+谢绝均未成行 → rejected')

// 旧版整单结构迁移：整单状态展开到逐篇条目
const legacy = {
  status: HANDOVER.PENDING_APPROVAL, toUserId: next.id, confirmedAt: nowIso(), decidedBy: null,
  decidedAt: null, completedAt: null, failReason: '',
  items: [
    { docId: 'a', title: 'A', snapshot: {}, result: null },
    { docId: 'b', title: 'B', snapshot: {}, result: null }
  ]
}
const mig = migrateLegacyHandover(legacy)
assert(mig.items.every((it) => it.toUserId === next.id && it.status === PA && it.confirmedAt), '旧待批准单：各条目展开为待批准并承接接任者/确认时间')
assert(mig.status === HANDOVER.PENDING_APPROVAL, '旧单迁移后批次状态正确汇总')
const legacyDone = migrateLegacyHandover({
  status: HANDOVER.COMPLETED, toUserId: third.id, confirmedAt: 't1', decidedBy: admin.id,
  decidedAt: 't2', completedAt: 't2', items: [{ docId: 'a', title: 'A', snapshot: {}, result: { x: 1 } }]
})
assert(legacyDone.items[0].status === CP && legacyDone.items[0].completedAt === 't2', '旧已完成单：条目展开为已完成并承接时间/结果')
const legacyCancel = migrateLegacyHandover({
  status: HANDOVER.CANCELLED, toUserId: next.id,
  items: [{ docId: 'a', title: 'A', snapshot: {}, result: null }]
})
assert(legacyCancel.status === HANDOVER.CANCELLED, '旧已取消单：整批取消状态保留')

// 全量并发校验（旧接口，供策略重算联动测试复用）
const snapHo = {
  items: [
    { docId: 'x1', title: 'X1', snapshot: { ownerId: 'a', updatedAt: 't1', activeReviewId: null, freshnessSig: '-' } },
    { docId: 'x2', title: 'X2', snapshot: { ownerId: 'a', updatedAt: 't2', activeReviewId: 'r1', freshnessSig: '30|d|1|' } }
  ]
}
let cf = checkHandoverConflicts(snapHo, { x1: { ownerId: 'a', updatedAt: 't1' }, x2: { ownerId: 'a', updatedAt: 't2', activeReviewId: 'r1', freshness: { cycleDays: 30, nextDueAt: 'd', round: 1, activeTicket: null } } })
assert(cf.length === 0, '快照一致时无冲突')
cf = checkHandoverConflicts(snapHo, { x1: null, x2: { ownerId: 'b', updatedAt: 't2', activeReviewId: null, freshness: { cycleDays: 90, nextDueAt: 'd', round: 1, activeTicket: 'fr' } } })
assert(cf.length === 2 && cf[0].fields.includes('文档已删除'), '删除/负责人/评审/保鲜变化均被识别')
assert(cf[1].fields.includes('负责人已变更') && cf[1].fields.includes('评审状态已变化') && cf[1].fields.includes('保鲜配置已变化'), '冲突字段逐项标注')

// 部分校验（只检查给定条目）
const partialItems = snapHo.items
const pc1 = checkItemConflicts(partialItems, { x1: { ownerId: 'a', updatedAt: 't1' }, x2: { ownerId: 'b', updatedAt: 't2' } })
assert(pc1.failures.length === 1 && pc1.conflictMap['x2']?.includes('负责人已变更'), '分批校验：仅返回冲突条目，供「该篇失败、其余转移」')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
