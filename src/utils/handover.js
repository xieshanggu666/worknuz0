// 知识责任交接：状态常量、并发变更校验、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：负责人勾选名下文档批量发起交接，并在同一批中逐篇指定接任者（pending_confirm）→
// 各接任者只对分配给自己的文档独立确认（pending_approval）或谢绝（declined），互不阻塞 →
// 管理员按确认结果分批批准：已确认的文档可勾选成批执行转移（completed），也可逐篇/成批驳回（rejected）；
// 未确认的文档继续等待，不进入本批批准。所有权（保留历史归属）、待办审批、保鲜责任随每篇批准一并转移，
// 并按交接决定保留/收回原负责人权限。批准执行时以发起快照逐篇复核并发变更：本批内某篇不一致只标记该篇
// 失败回退（failed），其余文档照常转移，不产生部分转移；失败文档可重新发起交接。
import { ROLE, isGuestUser } from './permission'

// 交接单（批次）状态：由各文档条目状态汇总推导（见 deriveHandoverStatus）
export const HANDOVER = {
  PENDING_CONFIRM: 'pending_confirm', // 待确认：尚有文档等待其接任者确认/谢绝
  PARTIAL_APPROVAL: 'partial_approval', // 分批处理中：已有文档完成/谢绝/驳回/失败，但仍有文档待确认或待批准
  PENDING_APPROVAL: 'pending_approval', // 待批准：全部文档均已确认（无待确认），尚有已确认文档等待管理员批准
  COMPLETED: 'completed', // 已完成：全部文档均已完成转移
  DECLINED: 'declined', // 已谢绝：所有文档均被接任者谢绝
  REJECTED: 'rejected', // 已驳回：所有文档均被管理员驳回（或谢绝+驳回的终态组合）
  CANCELLED: 'cancelled', // 已取消：发起人（或管理员）在流转中整批取消
  FAILED: 'failed' // 已失败回退：所有文档均在执行时校验失败/异常，未产生任何转移
}

// 逐篇交接状态（item.status）
export const HANDOVER_ITEM = {
  PENDING_CONFIRM: 'pending_confirm', // 待该文档的接任者确认
  PENDING_APPROVAL: 'pending_approval', // 接任者已确认，待管理员批准执行
  COMPLETED: 'completed', // 已完成：本文档所有权/待办/保鲜责任已转移
  DECLINED: 'declined', // 接任者谢绝本文档（保持原状，可重新发起）
  REJECTED: 'rejected', // 管理员驳回本文档（保持原状，可重新发起）
  FAILED: 'failed' // 执行时校验到并发变更/异常，本文档未转移，可重新发起
}

// 终态：本文档不再随本批流转
const ITEM_TERMINAL = new Set([
  HANDOVER_ITEM.COMPLETED,
  HANDOVER_ITEM.DECLINED,
  HANDOVER_ITEM.REJECTED,
  HANDOVER_ITEM.FAILED
])
// 终态但属于"未转移、可重新发起"
export const ITEM_NOT_TRANSFERRED = new Set([
  HANDOVER_ITEM.DECLINED,
  HANDOVER_ITEM.REJECTED,
  HANDOVER_ITEM.FAILED
])
// 终态"未成行"（谢绝/驳回/失败，区别于已完成）
const ITEM_CLOSED = new Set([
  HANDOVER_ITEM.DECLINED,
  HANDOVER_ITEM.REJECTED,
  HANDOVER_ITEM.FAILED
])

// 原负责人权限处理（发起时整批统一选定的交接决定）
export const REVOKE_MODE = {
  KEEP: 'keep', // 保留协作权限：原负责人留在协作成员中，可继续编辑
  REVOKE: 'revoke' // 收回全部权限：移出协作成员，并撤销其在文档上的有效限时授权
}

// ---------- 条目与批次状态派生 ----------

export function isItemTerminal(item) {
  return !!item && ITEM_TERMINAL.has(item.status)
}
export function isItemOpen(item) {
  return !!item && !ITEM_TERMINAL.has(item.status)
}

// 交接单是否仍在流转中（至少一篇文档还可确认/可审批；可整批取消）
export function isHandoverOpen(h) {
  return !!h && h.status !== HANDOVER.CANCELLED && (h.items || []).some(isItemOpen)
}

// 本文档条目是否仍在流转（用于文档占用、修改提示、退役互斥）
export function isItemOfDocOpen(h, docId) {
  const item = (h?.items || []).find((it) => it.docId === docId)
  return !!item && isItemOpen(item)
}

// 由逐篇状态汇总批次状态（纯函数）
export function deriveHandoverStatus(items) {
  const list = items || []
  const n = list.length
  if (!n) return HANDOVER.PENDING_CONFIRM
  const count = (s) => list.filter((it) => it.status === s).length
  const pendingConfirm = count(HANDOVER_ITEM.PENDING_CONFIRM)
  const pendingApproval = count(HANDOVER_ITEM.PENDING_APPROVAL)
  const completed = count(HANDOVER_ITEM.COMPLETED)
  const declined = count(HANDOVER_ITEM.DECLINED)
  const rejected = count(HANDOVER_ITEM.REJECTED)
  const failed = count(HANDOVER_ITEM.FAILED)

  if (completed === n) return HANDOVER.COMPLETED
  // 没有任何流转中文档：整批已终态
  if (pendingConfirm + pendingApproval === 0) {
    if (completed > 0) return HANDOVER.PARTIAL_APPROVAL // 部分完成 + 其余谢绝/驳回/失败（仍展示终态结果）
    if (declined === n) return HANDOVER.DECLINED
    if (failed === n) return HANDOVER.FAILED
    return HANDOVER.REJECTED // 全部驳回，或驳回/谢绝/失败的未成行组合
  }
  // 仍有流转中文档
  if (pendingConfirm + pendingApproval > 0) {
    // 已存在两种不同的流转阶段（既有待确认又有已确认待批准），或已有处理结果 → 分批处理中
    if (pendingConfirm > 0 && pendingApproval > 0) return HANDOVER.PARTIAL_APPROVAL
    const processed = completed + declined + rejected + failed
    if (processed > 0) return HANDOVER.PARTIAL_APPROVAL
    return pendingConfirm > 0 ? HANDOVER.PENDING_CONFIRM : HANDOVER.PENDING_APPROVAL
  }
  return HANDOVER.PARTIAL_APPROVAL // 无流转中文档但未全部完成（理论上上面已兜底）
}

export function handoverStatusLabel(status) {
  return {
    pending_confirm: '待接任者确认',
    partial_approval: '分批处理中',
    pending_approval: '待管理员批准',
    completed: '已完成',
    declined: '已谢绝',
    rejected: '已驳回',
    cancelled: '已取消',
    failed: '已失败回退'
  }[status] || status
}

export function handoverStatusCls(status) {
  return {
    pending_confirm: 'st-pending',
    partial_approval: 'st-wait',
    pending_approval: 'st-wait',
    completed: 'st-ok',
    declined: 'st-off',
    rejected: 'st-no',
    cancelled: 'st-off',
    failed: 'st-fail'
  }[status] || ''
}

export function handoverItemStatusLabel(status) {
  return {
    pending_confirm: '待确认',
    pending_approval: '待批准',
    completed: '已完成',
    declined: '已谢绝',
    rejected: '已驳回',
    failed: '已失败回退'
  }[status] || status
}

export function handoverItemStatusCls(status) {
  return {
    pending_confirm: 'st-pending',
    pending_approval: 'st-wait',
    completed: 'st-ok',
    declined: 'st-off',
    rejected: 'st-no',
    failed: 'st-fail'
  }[status] || ''
}

export function revokeModeLabel(mode) {
  return mode === REVOKE_MODE.REVOKE ? '收回原负责人全部权限' : '保留原负责人协作权限'
}

// ---------- 批次内分组/统计（供 UI 与 store 复用） ----------

// 分配给某接任者的条目
export function itemsForUser(h, userId) {
  return (h?.items || []).filter((it) => it.toUserId === userId)
}
// 某接任者名下、待其确认的条目
export function pendingItemsForUser(h, userId) {
  return itemsForUser(h, userId).filter((it) => it.status === HANDOVER_ITEM.PENDING_CONFIRM)
}
// 批次内是否还有待我确认的文档
export function handoverAwaitingMyConfirm(h, userId) {
  return pendingItemsForUser(h, userId).length > 0
}
// 可进入本批管理员批准/驳回的条目（接任者已确认）
export function approvableItems(h) {
  return (h?.items || []).filter((it) => it.status === HANDOVER_ITEM.PENDING_APPROVAL)
}
// 批次是否有待管理员处理（已确认待批准）的文档
export function handoverAwaitingApproval(h) {
  return approvableItems(h).length > 0
}
// 批次进度统计
export function handoverProgress(h) {
  const items = h?.items || []
  const p = {
    total: items.length,
    pending_confirm: 0,
    pending_approval: 0,
    completed: 0,
    declined: 0,
    rejected: 0,
    failed: 0
  }
  for (const it of items) {
    if (Object.prototype.hasOwnProperty.call(p, it.status)) p[it.status]++
  }
  p.pendingConfirm = p.pending_confirm
  p.pendingApproval = p.pending_approval
  p.open = p.pendingConfirm + p.pendingApproval
  p.processed = p.total - p.open
  return p
}

// 批次涉及的全部接任者 id（去重）
export function successorIds(h) {
  return [...new Set((h?.items || []).map((it) => it.toUserId))]
}

// ---------- 并发变更校验 ----------

// 文档保鲜配置签名：周期/到期点/轮次/流转中复核单任一变化都视为并发变更
export function freshnessSig(doc) {
  const f = doc?.freshness
  if (!f) return '-'
  return [f.cycleDays, f.nextDueAt, f.round, f.activeTicket || ''].join('|')
}

// 发起交接时的文档快照：批准执行时据此逐篇复核「交接期间是否发生并发变更」
export function handoverSnapshotOf(doc) {
  return {
    ownerId: doc.ownerId,
    updatedAt: doc.updatedAt,
    activeReviewId: doc.activeReviewId || null,
    freshnessSig: freshnessSig(doc)
  }
}

function conflictFieldsOf(item, doc) {
  if (!doc) return ['文档已删除']
  const snap = item.snapshot || {}
  const fields = []
  if (doc.ownerId !== snap.ownerId) fields.push('负责人已变更')
  if (doc.updatedAt !== snap.updatedAt) fields.push('内容已更新')
  if ((doc.activeReviewId || null) !== (snap.activeReviewId || null)) fields.push('评审状态已变化')
  if (freshnessSig(doc) !== snap.freshnessSig) fields.push('保鲜配置已变化')
  return fields
}

// 并发变更校验（纯函数）：以发起快照对比库中最新文档，返回不一致清单。
// 负责人变更、内容更新、评审状态变化、保鲜配置变化、文档被删除均视为冲突；
// 返回空数组表示可安全执行转移。
export function checkHandoverConflicts(handover, docMap) {
  const failures = []
  for (const item of handover?.items || []) {
    const doc = docMap[item.docId]
    const fields = conflictFieldsOf(item, doc)
    if (fields.length) failures.push({ docId: item.docId, title: doc?.title || item.title, fields })
  }
  return failures
}

// 针对本批待转移条目的校验：只检查给定 item 列表，返回 { conflictMap, failures }。
// 冲突 item 由调用方标记 failed，未冲突 item 照常转移（分批批准：单篇失败不影响其余）。
export function checkItemConflicts(items, docMap) {
  const conflictMap = {}
  const failures = []
  for (const item of items) {
    const doc = docMap[item.docId]
    const fields = conflictFieldsOf(item, doc)
    if (fields.length) {
      conflictMap[item.docId] = fields
      failures.push({ docId: item.docId, title: doc?.title || item.title, fields })
    }
  }
  return { conflictMap, failures }
}

// ---------- 权限判定 ----------

// 发起交接：登录成员（具体文档归属在 store 事务内逐篇复核）
export function canInitiateHandover(userId) {
  return !isGuestUser(userId)
}

// 某条目可否由当前用户确认/谢绝：仅该条目指定的接任者，且条目待确认
export function canRespondItem(item, userId) {
  return !!item && item.status === HANDOVER_ITEM.PENDING_CONFIRM &&
    !isGuestUser(userId) && item.toUserId === userId
}

// 批次是否还有当前用户可确认/谢绝的文档
export function canRespondHandover(h, userId) {
  return !!h && h.status !== HANDOVER.CANCELLED && pendingItemsForUser(h, userId).length > 0
}

// 管理员批准/驳回：仅管理员，且批次存在已确认待批准的文档
export function canDecideHandover(h, userId, role) {
  return !!h && h.status !== HANDOVER.CANCELLED && !isGuestUser(userId) &&
    role === ROLE.ADMIN && handoverAwaitingApproval(h)
}

// 取消交接：发起人或管理员，且批次仍在流转中
export function canCancelHandover(h, userId, role) {
  return isHandoverOpen(h) && !isGuestUser(userId) && (h.fromUserId === userId || role === ROLE.ADMIN)
}

// ---------- 留痕文案 ----------

// 交接留痕动作文案（交接单 timeline 全程保留）
export function handoverTimelineLabel(action) {
  return {
    initiate: '发起批量交接',
    confirm: '接任者确认接收',
    decline: '接任者谢绝交接',
    cancel: '取消交接',
    approve: '管理员批准 · 转移完成',
    reject: '管理员驳回',
    fail: '执行失败 · 已回退',
    partial: '分批处理'
  }[action] || action
}

// ---------- 老数据迁移（v9 → v10：单一接任者 → 逐篇接任者）----------

// 旧交接单状态 → 新结构。返回 { status, items }，把整单状态映射到每一篇 item。
// 迁移不改变任何文档归属，只是把原单状态展开到条目维度。
export function migrateLegacyHandover(h) {
  const oldStatus = h.status
  let itemStatus
  switch (oldStatus) {
    case HANDOVER.PENDING_CONFIRM:
      itemStatus = HANDOVER_ITEM.PENDING_CONFIRM
      break
    case HANDOVER.PENDING_APPROVAL:
      itemStatus = HANDOVER_ITEM.PENDING_APPROVAL
      break
    case HANDOVER.COMPLETED:
      itemStatus = HANDOVER_ITEM.COMPLETED
      break
    case HANDOVER.DECLINED:
      itemStatus = HANDOVER_ITEM.DECLINED
      break
    case HANDOVER.REJECTED:
      itemStatus = HANDOVER_ITEM.REJECTED
      break
    case HANDOVER.FAILED:
      itemStatus = HANDOVER_ITEM.FAILED
      break
    default:
      itemStatus = HANDOVER_ITEM.PENDING_CONFIRM
  }
  const items = (h.items || []).map((it) => ({
    ...it,
    toUserId: it.toUserId || h.toUserId,
    status: it.status || itemStatus,
    confirmedAt: it.confirmedAt || (itemStatus === HANDOVER_ITEM.PENDING_APPROVAL ||
      itemStatus === HANDOVER_ITEM.COMPLETED ||
      itemStatus === HANDOVER_ITEM.REJECTED ||
      itemStatus === HANDOVER_ITEM.FAILED
      ? (h.confirmedAt || null) : null),
    decidedBy: it.decidedBy || (ITEM_CLOSED.has(itemStatus) || itemStatus === HANDOVER_ITEM.COMPLETED
      ? (h.decidedBy || null) : null),
    decidedAt: it.decidedAt || (ITEM_CLOSED.has(itemStatus) || itemStatus === HANDOVER_ITEM.COMPLETED
      ? (h.decidedAt || null) : null),
    completedAt: it.completedAt || (itemStatus === HANDOVER_ITEM.COMPLETED ? (h.completedAt || h.decidedAt || null) : null),
    failReason: it.failReason || (itemStatus === HANDOVER_ITEM.FAILED ? (h.failReason || '') : '')
  }))
  // cancelled 为整批覆盖状态，仍保留原单状态；其余按条目重新汇总
  const status = oldStatus === HANDOVER.CANCELLED ? HANDOVER.CANCELLED : deriveHandoverStatus(items)
  return { ...h, items, status, schemaVersion: 10 }
}
