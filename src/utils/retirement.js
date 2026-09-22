// 知识退役替代：状态常量、退役/引用/搜索闸门、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 流程：文档负责人发起退役并指定替代文档（pending）→ 管理员批准（approved）后同事务：
// 旧文档停止搜索命中与问答引用、共享链接批量撤销（记录保留）、已解决缺口工单的答案来源改挂替代文档；
// 管理员可驳回（rejected）、发起人可在审批前撤销（cancelled）；退役生效后可由发起人/管理员撤销退役
// （revoked：恢复搜索引用、恢复共享链接、答案来源回挂旧文档）。退役单与时间线全程保留。
import { ROLE, isGuestUser } from './permission'

// 退役单状态
export const RETIRE = {
  PENDING: 'pending', // 待审批：负责人已发起，等待管理员处理
  APPROVED: 'approved', // 已生效：旧文档已退役，搜索/问答引用已停止，答案来源改挂替代文档
  REJECTED: 'rejected', // 已驳回：管理员不批准本次退役，文档保持原状
  CANCELLED: 'cancelled', // 已撤销：发起人在审批前主动撤销
  REVOKED: 'revoked' // 已撤销退役：生效后被发起人/管理员撤销，旧文档恢复，记录保留
}

export function retireStatusLabel(status) {
  return {
    pending: '待管理员审批',
    approved: '已退役',
    rejected: '已驳回',
    cancelled: '已撤销',
    revoked: '已撤销退役'
  }[status] || status
}

export function retireStatusCls(status) {
  return {
    pending: 'st-pending',
    approved: 'st-retired',
    rejected: 'st-no',
    cancelled: 'st-off',
    revoked: 'st-restore'
  }[status] || ''
}

// 退役单是否仍在审批流转中（可驳回/可由发起人撤销）
export function isRetirementOpen(r) {
  return !!r && r.status === RETIRE.PENDING
}

// 退役已生效（旧文档处于退役态；可撤销退役）
export function isRetirementActive(r) {
  return !!r && r.status === RETIRE.APPROVED
}

// ---- 文档退役闸门 ----

// 文档是否已退役（doc.retirement 指向一条生效退役）。
// 生效退役的文档保留可读详情，但退出搜索与问答引用、禁止编辑/删除
export function isDocRetired(doc, activeRetirement) {
  if (activeRetirement) return true
  return !!doc?.retirement && doc.retirement.status === RETIRE.APPROVED
}

// 文档是否可被搜索/问答检索：已退役文档一律不可
export function isDocSearchable(doc, activeRetirement) {
  return !!doc && !isDocRetired(doc, activeRetirement)
}

// 文档是否可被问答引用：已退役文档一律不可
export function isDocRetireCitable(doc, activeRetirement) {
  return !!doc && !isDocRetired(doc, activeRetirement)
}

// ---- 发起/审批/撤销资格 ----

// 发起退役：登录成员且为文档负责人（拥有者）或管理员；
// 退役中（流转单）、已退役、评审中、交接中的文档不可发起；替代文档必须与旧文档不同且未退役
export function canInitiateRetirement(doc, userId, role, ctx = {}) {
  if (!doc || isGuestUser(userId)) return false
  if (doc.ownerId !== userId && role !== ROLE.ADMIN) return false
  if (isDocRetired(doc, ctx.activeRetirement)) return false
  if (ctx.openRetirement) return false
  if (ctx.pendingReview) return false
  if (ctx.activeHandover) return false
  return true
}

// 替代文档合法性（纯函数）：必须存在、与旧文档不同、自身未退役、不在退役中
export function isValidReplacement(oldDoc, replacementDoc, ctx = {}) {
  if (!oldDoc || !replacementDoc) return false
  if (replacementDoc.id === oldDoc.id) return false
  if (isDocRetired(replacementDoc, ctx.activeRetirementOf?.(replacementDoc.id))) return false
  if (ctx.openRetirementOf?.(replacementDoc.id)) return false
  return true
}

// 管理员审批（批准/驳回）：仅管理员，且退役单仍待处理
export function canDecideRetirement(r, userId, role) {
  return isRetirementOpen(r) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 发起人在审批前撤销退役申请
export function canCancelRetirement(r, userId, role) {
  if (!isRetirementOpen(r) || isGuestUser(userId)) return false
  return r.initiatedBy === userId || role === ROLE.ADMIN
}

// 撤销已生效的退役：发起人本人或管理员
export function canRevokeRetirement(r, userId, role) {
  if (!isRetirementActive(r) || isGuestUser(userId)) return false
  return r.initiatedBy === userId || role === ROLE.ADMIN
}

// 退役留痕动作文案（退役单 timeline 全程保留）
export function retireTimelineLabel(action) {
  return {
    initiate: '发起文档退役',
    approve: '管理员批准 · 退役生效',
    reject: '管理员驳回',
    cancel: '发起人撤销退役申请',
    revoke: '撤销退役 · 恢复旧文档',
    // 退役生效时的联动结果
    'gap-repoint': '已解决缺口工单答案来源改挂替代文档',
    'share-revoke': '共享链接随退役批量撤销',
    // 撤销退役时的联动结果
    'gap-restore': '答案来源回挂旧文档',
    'share-restore': '共享链接随撤销退役恢复'
  }[action] || action
}
