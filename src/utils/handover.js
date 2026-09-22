// 知识责任交接：状态常量、并发变更校验、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：负责人勾选名下文档批量发起交接（pending_confirm）→ 接任者确认（pending_approval）→
// 管理员批准后统一执行转移（completed）：所有权（保留历史归属）、待办审批、保鲜责任一并转移，
// 并按交接决定保留/收回原负责人权限；接任者可谢绝（declined）、管理员可驳回（rejected）、
// 发起人可取消（cancelled）。批准执行时以发起快照逐篇复核并发变更，任何一篇不一致即
// 整体失败回退（failed），不产生部分转移。
import { ROLE, isGuestUser } from './permission'

// 交接单状态
export const HANDOVER = {
  PENDING_CONFIRM: 'pending_confirm', // 待接任者确认：负责人已发起，等待接任者接受
  PENDING_APPROVAL: 'pending_approval', // 待管理员批准：接任者已确认，等待管理员审批执行
  COMPLETED: 'completed', // 已完成：所有权/待办审批/保鲜责任已统一转移
  DECLINED: 'declined', // 已谢绝：接任者拒绝接收
  REJECTED: 'rejected', // 已驳回：管理员不批准本次交接
  CANCELLED: 'cancelled', // 已取消：发起人（或管理员）在流转中取消
  FAILED: 'failed' // 已失败回退：执行时校验到并发变更/异常，整体回退，未产生任何转移
}

// 原负责人权限处理（发起时选定的交接决定）
export const REVOKE_MODE = {
  KEEP: 'keep', // 保留协作权限：原负责人留在协作成员中，可继续编辑
  REVOKE: 'revoke' // 收回全部权限：移出协作成员，并撤销其在文档上的有效限时授权
}

// 交接单是否仍在流转中（可确认/可审批/可取消）
export function isHandoverOpen(h) {
  return !!h && (h.status === HANDOVER.PENDING_CONFIRM || h.status === HANDOVER.PENDING_APPROVAL)
}

export function handoverStatusLabel(status) {
  return {
    pending_confirm: '待接任者确认',
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
    pending_approval: 'st-wait',
    completed: 'st-ok',
    declined: 'st-off',
    rejected: 'st-no',
    cancelled: 'st-off',
    failed: 'st-fail'
  }[status] || ''
}

export function revokeModeLabel(mode) {
  return mode === REVOKE_MODE.REVOKE ? '收回原负责人全部权限' : '保留原负责人协作权限'
}

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

// 并发变更校验（纯函数）：以发起快照对比库中最新文档，返回不一致清单。
// 负责人变更、内容更新、评审状态变化、保鲜配置变化、文档被删除均视为冲突；
// 返回空数组表示可安全执行整体转移。
export function checkHandoverConflicts(handover, docMap) {
  const failures = []
  for (const item of handover?.items || []) {
    const doc = docMap[item.docId]
    if (!doc) {
      failures.push({ docId: item.docId, title: item.title, fields: ['文档已删除'] })
      continue
    }
    const snap = item.snapshot || {}
    const fields = []
    if (doc.ownerId !== snap.ownerId) fields.push('负责人已变更')
    if (doc.updatedAt !== snap.updatedAt) fields.push('内容已更新')
    if ((doc.activeReviewId || null) !== (snap.activeReviewId || null)) fields.push('评审状态已变化')
    if (freshnessSig(doc) !== snap.freshnessSig) fields.push('保鲜配置已变化')
    if (fields.length) failures.push({ docId: item.docId, title: doc.title, fields })
  }
  return failures
}

// 发起交接：登录成员且为全部所选文档的负责人（具体文档归属在 store 事务内逐篇复核）
export function canInitiateHandover(userId) {
  return !isGuestUser(userId)
}

// 接任者确认/谢绝：仅交接单指定的接任者，且处于待确认状态
export function canConfirmHandover(h, userId) {
  return !!h && h.status === HANDOVER.PENDING_CONFIRM && !isGuestUser(userId) && h.toUserId === userId
}

// 管理员批准/驳回：仅管理员，且接任者已确认
export function canDecideHandover(h, userId, role) {
  return !!h && h.status === HANDOVER.PENDING_APPROVAL && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 取消交接：发起人或管理员，且交接单仍在流转中
export function canCancelHandover(h, userId, role) {
  return isHandoverOpen(h) && !isGuestUser(userId) && (h.fromUserId === userId || role === ROLE.ADMIN)
}

// 交接留痕动作文案（交接单 timeline 全程保留）
export function handoverTimelineLabel(action) {
  return {
    initiate: '发起批量交接',
    confirm: '接任者确认接收',
    decline: '接任者谢绝交接',
    cancel: '取消交接',
    approve: '管理员批准 · 统一转移完成',
    reject: '管理员驳回',
    fail: '执行失败 · 已整体回退'
  }[action] || action
}
