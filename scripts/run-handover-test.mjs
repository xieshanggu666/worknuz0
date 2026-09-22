// 知识责任交接端到端回归（fake-indexeddb + 真实 store）
// 覆盖：负责人批量发起（权限/快照/重复发起校验）→ 接任者确认/谢绝 → 管理员批准统一转移
// （所有权 + 历史归属 + 评审待办 + 保鲜责任 + 待审批访问申请 + 按决定收回权限）→
// 交接期间并发变更 → 校验失败整体回退；驳回 / 取消 / 多次交接历史累积。
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
import { HANDOVER, REVOKE_MODE, checkHandoverConflicts } from '@/utils/handover'
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

// ---------- 1. 发起校验 ----------
console.log('\n[1] 发起交接的权限与参数校验')
const d1 = await mkDoc()
let r = await handover.initiateHandover({ docIds: [d1.id], toUserId: next.id, revokeMode: 'keep', note: '' }, null)
assert(r.status === 'guest', '访客不能发起交接')
r = await handover.initiateHandover({ docIds: [], toUserId: next.id, revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'no-docs', '未选择文档被拒绝')
r = await handover.initiateHandover({ docIds: [d1.id], toUserId: owner.id, revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'bad-target', '接任者不能是自己')
r = await handover.initiateHandover({ docIds: [d1.id], toUserId: 'u-ghost', revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'bad-target', '接任者必须是已注册成员')
r = await handover.initiateHandover({ docIds: [d1.id], toUserId: next.id, revokeMode: 'keep', note: '' }, third)
assert(r.status === 'denied', '非负责人不能交接他人文档')
r = await handover.initiateHandover({ docIds: [d1.id], toUserId: next.id, revokeMode: 'keep', note: '轮岗交接' }, owner)
assert(r.status === 'ok' && r.handover.status === HANDOVER.PENDING_CONFIRM, '负责人发起成功，进入待确认')
const ho1 = r.handover
assert(ho1.items[0].snapshot.ownerId === owner.id && ho1.items[0].snapshot.updatedAt === d1.updatedAt, '发起时为文档打上并发校验快照')
r = await handover.initiateHandover({ docIds: [d1.id], toUserId: third.id, revokeMode: 'keep', note: '' }, owner)
assert(r.status === 'in-handover', '同一文档存在流转中交接单时不可重复发起')
assert(handover.activeHandoverOfDoc(d1.id)?.status === HANDOVER.PENDING_CONFIRM, '文档可查到流转中的交接单')

// ---------- 2. 接任者确认 / 谢绝 ----------
console.log('\n[2] 接任者确认与谢绝')
r = await handover.confirmHandover(ho1.id, third)
assert(r.status === 'denied', '非接任者不能确认')
r = await handover.confirmHandover(ho1.id, next)
assert(r.status === 'ok' && r.handover.status === HANDOVER.PENDING_APPROVAL, '接任者确认后进入待批准')
r = await handover.confirmHandover(ho1.id, next)
assert(r.status === 'changed', '重复确认被拒绝')
r = await handover.cancelHandover(ho1.id, owner)
assert(r.status === 'ok' && r.handover.status === HANDOVER.CANCELLED, '发起人可取消流转中的交接')

const d2 = await mkDoc()
r = await handover.initiateHandover({ docIds: [d2.id], toUserId: next.id, revokeMode: 'keep', note: '' }, owner)
const ho2 = r.handover
r = await handover.declineHandover(ho2.id, '近期排期已满，暂不接收', next)
assert(r.status === 'ok' && r.handover.status === HANDOVER.DECLINED, '接任者可谢绝交接')
assert((await getHo(ho2.id)).decideNote.includes('排期已满'), '谢绝备注留痕')

// ---------- 3. 管理员批准：统一转移（revoke 模式全要素） ----------
console.log('\n[3] 批准执行：所有权/待办审批/保鲜责任统一转移，按决定收回权限')
// docA：负责人名下有待审批的评审单（待办审批转移）
const docA = await mkDoc()
const revA = {
  id: uid('rev'), docId: docA.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: docA.title, body: docA.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
}
await db.reviews.add(revA)
await db.docs.update(docA.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: revA.id })
// docB：保鲜复核单流转中 + 待审批访问申请 + 原负责人的历史有效授权
const docB = await mkDoc({ editors: [owner.id, third.id] })
const frB = {
  id: uid('fr'), docId: docB.id, round: 1, status: 'open', cycleDays: 30, dueAt: nowIso(),
  reviewId: null, submittedBy: owner.id, submittedAt: null, decidedBy: null, decidedAt: null,
  decisionNote: '', createdAt: nowIso(), timeline: []
}
await db.freshnessTickets.add(frB)
await db.docs.update(docB.id, { freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() + 86400000).toISOString(), round: 1, activeTicket: frB.id } })
const accPending = {
  id: uid('acc'), docId: docB.id, applicantId: third.id, status: ACCESS.PENDING, requestedPermission: 'read',
  reason: '申请阅读', createdAt: nowIso(), decidedBy: null, decidedAt: null, decisionNote: '', grant: null, timeline: []
}
const accGrant = {
  id: uid('acc'), docId: docB.id, applicantId: owner.id, status: ACCESS.APPROVED, requestedPermission: 'collab',
  reason: '历史授权', createdAt: nowIso(), decidedBy: admin.id, decidedAt: nowIso(), decisionNote: '',
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null,
  grant: { permission: 'collab', grantedAt: nowIso(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revokedAt: null },
  timeline: []
}
await db.accessRequests.bulkAdd([accPending, accGrant])
await Promise.all([kb.reloadDocs(), review.reload(), access.reload(), freshness.reload()])

r = await handover.initiateHandover({ docIds: [docA.id, docB.id], toUserId: next.id, revokeMode: REVOKE_MODE.REVOKE, note: '整体交接' }, owner)
assert(r.status === 'ok', '批量发起成功（含评审中/保鲜中文档）')
const ho3 = r.handover
r = await handover.decideHandover(ho3.id, 'approve', '', admin)
assert(r.status === 'changed', '未经接任者确认不能批准执行')
r = await handover.confirmHandover(ho3.id, next)
assert(r.status === 'ok', '接任者确认')
r = await handover.decideHandover(ho3.id, 'approve', '同意交接', third)
assert(r.status === 'denied', '非管理员不能批准')
r = await handover.decideHandover(ho3.id, 'approve', '同意交接', admin)
assert(r.status === 'ok' && r.approved === true, '管理员批准，统一转移完成')

const ho3Done = await getHo(ho3.id)
assert(ho3Done.status === HANDOVER.COMPLETED && ho3Done.completedAt, '交接单已完成')
const docA1 = await getDoc(docA.id)
assert(docA1.ownerId === next.id, 'docA 所有权已转移给接任者')
assert(docA1.ownerHistory.length === 1 && docA1.ownerHistory[0].ownerId === owner.id && docA1.ownerHistory[0].handoverId === ho3.id, 'docA 保留原负责人历史归属')
assert(docA1.editors.includes(next.id) && !docA1.editors.includes(owner.id), 'revoke 模式：接任者加入协作、原负责人移出')
const revA1 = await db.reviews.get(revA.id)
assert(revA1.submittedBy === next.id, 'docA 待办评审改挂接任者')
assert(revA1.timeline.some((t) => t.action === 'handover'), '评审单留有交接转移痕迹')
const docB1 = await getDoc(docB.id)
assert(docB1.ownerId === next.id && docB1.freshness.activeTicket === frB.id, 'docB 所有权与保鲜责任一并转移')
const frB1 = await db.freshnessTickets.get(frB.id)
assert(frB1.submittedBy === next.id && frB1.timeline.some((t) => t.action === 'handover'), '流转中复核单改挂送审人并留痕')
const accP1 = await db.accessRequests.get(accPending.id)
assert(accP1.status === ACCESS.PENDING, '待审批访问申请保留（审批责任随新负责人）')
assert(canDecideAccess(accP1, docB1, next.id, next.role) === true, '接任者作为新负责人可审批该申请')
const accG1 = await db.accessRequests.get(accGrant.id)
assert(accG1.status === ACCESS.REVOKED && !isGrantActive(accG1), '原负责人的有效授权按交接决定收回')
const itemB = ho3Done.items.find((i) => i.docId === docB.id)
assert(itemB.result.accessPending === 1 && itemB.result.revokedGrants === 1, '转移结果逐篇留档（待审批 1 项、收回授权 1 项）')
const itemA = ho3Done.items.find((i) => i.docId === docA.id)
assert(itemA.result.reviewIds.includes(revA.id), '转移结果记录改挂的评审单')
assert(ho3Done.timeline.some((t) => t.action === 'approve'), '交接单留有批准执行痕迹')

// ---------- 4. keep 模式：保留原负责人协作权限 ----------
console.log('\n[4] keep 模式保留原负责人协作权限')
const docC = await mkDoc()
r = await handover.initiateHandover({ docIds: [docC.id], toUserId: next.id, revokeMode: REVOKE_MODE.KEEP, note: '' }, owner)
await handover.confirmHandover(r.handover.id, next)
r = await handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok', 'keep 模式交接完成')
const docC1 = await getDoc(docC.id)
assert(docC1.ownerId === next.id && docC1.editors.includes(owner.id), '所有权转移但原负责人保留协作成员身份')

// ---------- 5. 并发变更：校验失败整体回退 ----------
console.log('\n[5] 交接期间并发变更 → 失败整体回退')
const docD = await mkDoc()
const docE = await mkDoc()
r = await handover.initiateHandover({ docIds: [docD.id, docE.id], toUserId: next.id, revokeMode: 'revoke', note: '' }, owner)
const ho5 = r.handover
await handover.confirmHandover(ho5.id, next)
// 交接流转期间，docE 被（另一窗口）并发编辑保存
await kb.updateDoc(docE.id, { body: '<p>交接期间的并发修改</p>' }, owner, '并发编辑')
r = await handover.decideHandover(ho5.id, 'approve', '', admin)
assert(r.status === 'changed' && r.conflicts.length === 1 && r.conflicts[0].docId === docE.id, '批准时校验出并发变更')
assert(r.conflicts[0].fields.includes('内容已更新'), '冲突字段标注「内容已更新」')
const ho5Done = await getHo(ho5.id)
assert(ho5Done.status === HANDOVER.FAILED && ho5Done.failReason.includes('并发变更'), '交接单标记为已失败回退并记录原因')
const docD1 = await getDoc(docD.id)
assert(docD1.ownerId === owner.id && !docD1.ownerHistory, '整体回退：未冲突的 docD 也未发生任何转移')
const docE1 = await getDoc(docE.id)
assert(docE1.ownerId === owner.id && docE1.body.includes('并发修改'), '并发修改的内容保留，所有权未动')

// 评审状态并发变化同样触发回退
const docF = await mkDoc()
const revF = {
  id: uid('rev'), docId: docF.id, status: 'pending', submittedBy: owner.id, submittedAt: nowIso(),
  snapshot: { title: docF.title, body: docF.body, categoryId: 'c', tagIds: [], visibility: 'public' },
  baseVersion: 1, decidedBy: null, decidedAt: null, decisionNote: '', timeline: []
}
await db.reviews.add(revF)
await db.docs.update(docF.id, { publishState: PUBLISH.IN_REVIEW, activeReviewId: revF.id })
await kb.reloadDocs()
r = await handover.initiateHandover({ docIds: [docF.id], toUserId: next.id, revokeMode: 'keep', note: '' }, owner)
const ho6 = r.handover
await handover.confirmHandover(ho6.id, next)
await review.decideReview(revF.id, 'approve', '先审结', admin) // 交接期间评审被审批
r = await handover.decideHandover(ho6.id, 'approve', '', admin)
assert(r.status === 'changed' && r.conflicts[0].fields.includes('评审状态已变化'), '评审状态并发变化触发回退')
assert((await getDoc(docF.id)).ownerId === owner.id, 'docF 所有权未转移')

// ---------- 6. 驳回与多次交接的历史归属累积 ----------
console.log('\n[6] 驳回与历史归属累积')
const docG = await mkDoc()
r = await handover.initiateHandover({ docIds: [docG.id], toUserId: next.id, revokeMode: 'keep', note: '' }, owner)
const ho7 = r.handover
await handover.confirmHandover(ho7.id, next)
r = await handover.decideHandover(ho7.id, 'reject', '交接文档范围待确认', admin)
assert(r.status === 'ok' && r.approved === false && (await getHo(ho7.id)).status === HANDOVER.REJECTED, '管理员驳回交接')
assert((await getDoc(docG.id)).ownerId === owner.id, '驳回后所有权保持原状')

// docC 已完成 owner→next；再由 next 交接给 third，历史归属累积
r = await handover.initiateHandover({ docIds: [docC.id], toUserId: third.id, revokeMode: 'revoke', note: '二次交接' }, next)
assert(r.status === 'ok', '新负责人可再次发起交接')
await handover.confirmHandover(r.handover.id, third)
r = await handover.decideHandover(r.handover.id, 'approve', '', admin)
assert(r.status === 'ok', '二次交接完成')
const docC2 = await getDoc(docC.id)
assert(docC2.ownerId === third.id, '二次交接后所有权归第三成员')
assert(docC2.ownerHistory.length === 2 && docC2.ownerHistory[0].ownerId === owner.id && docC2.ownerHistory[1].ownerId === next.id, '历任负责人全程保留（2 段任期）')
assert(!docC2.editors.includes(next.id) && docC2.editors.includes(third.id), '二次交接按 revoke 决定收回上一任权限')

// ---------- 7. 纯函数：并发校验 ----------
console.log('\n[7] 并发变更校验纯函数')
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

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
