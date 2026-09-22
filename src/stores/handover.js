import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { ACCESS, isGrantActive, buildAccessTimelineEntry } from '@/utils/access'
import { isFreshTicketOpen, buildFreshTimelineEntry } from '@/utils/freshness'
import {
  HANDOVER, REVOKE_MODE, isHandoverOpen, handoverSnapshotOf, checkHandoverConflicts
} from '@/utils/handover'
import { isDocRetired } from '@/utils/retirement'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { useKbStore } from './kb'
import { useAuthStore } from './auth'

// 知识责任交接 store：
// 负责人勾选名下文档批量发起交接 → 接任者确认 → 管理员批准后在同一事务内统一转移：
// - 所有权：doc.ownerId 交给接任者，原负责人任期追加进 doc.ownerHistory（历史归属全程保留）；
// - 待办审批：文档上流转中的评审单（原负责人名下）改挂接任者，待审批的访问申请随所有权自动转移；
// - 保鲜责任：复核周期随所有权转移，流转中的复核单留痕并改挂送审人；
// - 权限收回：按发起时的交接决定（keep/revoke）保留或收回原负责人的协作成员身份与有效授权。
// 批准执行时先以发起快照逐篇复核并发变更（负责人/内容/评审/保鲜配置），任何一篇不一致即
// 整体失败回退（事务内不写入任何转移）；转移途中异常由 Dexie 事务自动整体回滚。
export const useHandoverStore = defineStore('handover', () => {
  const handovers = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    handovers.value = await db.handovers.toArray()
  }

  const sorted = computed(() =>
    [...handovers.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 待我确认（我作为接任者）
  function pendingConfirmFor(userId) {
    return sorted.value.filter((h) => h.status === HANDOVER.PENDING_CONFIRM && h.toUserId === userId)
  }

  // 待管理员批准
  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((h) => h.status === HANDOVER.PENDING_APPROVAL)
  }

  // 我发起的
  function initiatedBy(userId) {
    return sorted.value.filter((h) => h.fromUserId === userId)
  }

  // 我相关的（发起或接收），普通成员的「全部记录」范围
  function involvedIn(userId) {
    return sorted.value.filter((h) => h.fromUserId === userId || h.toUserId === userId)
  }

  // 文档当前是否有流转中的交接单（同一文档同时只允许一个）
  function activeHandoverOfDoc(docId) {
    return handovers.value.find((h) => isHandoverOpen(h) && (h.docIds || []).includes(docId)) || null
  }

  // 侧栏角标：待我确认 + （管理员）待批准
  function pendingCountFor(userId, role) {
    return pendingConfirmFor(userId).length + pendingApprovalFor(role).length
  }

  // 负责人发起批量交接：逐篇复核归属并为每篇文档打快照（批准执行时据此校验并发变更）。
  // 返回 { status: 'ok', handover } | 'guest' | 'no-docs' | 'bad-target' | 'missing' | 'denied' | 'in-handover'
  async function initiateHandover({ docIds, toUserId, revokeMode, note }, currentUser) {
    const kb = useKbStore()
    const auth = useAuthStore()
    await Promise.all([kb.loadAll(), auth.loadUsers()])
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const ids = [...new Set(docIds || [])]
    if (!ids.length) return { status: 'no-docs' }
    // 接任者必须是已注册成员且不能是自己
    if (!toUserId || toUserId === userId || !auth.users.some((u) => u.id === toUserId)) {
      return { status: 'bad-target' }
    }
    const mode = revokeMode === REVOKE_MODE.REVOKE ? REVOKE_MODE.REVOKE : REVOKE_MODE.KEEP
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.handovers, db.retirements, async () => {
      const items = []
      for (const docId of ids) {
        // 事务内重读：归属与交接占用以库中最新数据为准，防止多窗口并发发起
        const doc = await db.docs.get(docId)
        if (!doc) { result = { status: 'missing', docId }; return }
        if (doc.ownerId !== userId) { result = { status: 'denied', docId, title: doc.title }; return }
        // 已退役文档不再参与责任交接（只读归档）；流转中退役单也先完成/取消，避免两流程交错
        if (isDocRetired(doc)) { result = { status: 'retired', docId, title: doc.title }; return }
        const dupRetire = await db.retirements.filter((rt) => rt.docId === docId && rt.status === 'pending').first()
        if (dupRetire) { result = { status: 'in-retirement', docId, title: doc.title }; return }
        const dup = await db.handovers
          .filter((h) => isHandoverOpen(h) && (h.docIds || []).includes(docId)).first()
        if (dup) { result = { status: 'in-handover', docId, title: doc.title, handover: dup }; return }
        items.push({ docId, title: doc.title, snapshot: handoverSnapshotOf(doc), result: null })
      }

      const handover = {
        id: uid('ho'),
        status: HANDOVER.PENDING_CONFIRM,
        fromUserId: userId,
        toUserId,
        docIds: ids,
        revokeMode: mode,
        note: String(note || '').trim(),
        items,
        createdAt: nowIso,
        confirmedAt: null,
        decidedBy: null,
        decidedAt: null,
        decideNote: '',
        completedAt: null,
        failReason: '',
        timeline: [buildTimelineEntry('initiate', userId, note, nowIso)]
      }
      await db.handovers.add(handover)
      result = { status: 'ok', handover }
    })

    await reload()
    return result
  }

  // 接任者确认接收 → 进入待管理员批准
  async function confirmHandover(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      if (h.status !== HANDOVER.PENDING_CONFIRM) { result = { status: 'changed', handover: h }; return }
      if (h.toUserId !== userId || isGuestUser(userId)) { result = { status: 'denied' }; return }
      const updated = {
        ...h,
        status: HANDOVER.PENDING_APPROVAL,
        confirmedAt: nowIso,
        timeline: [...(h.timeline || []), buildTimelineEntry('confirm', userId, '', nowIso)]
      }
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated }
    })

    await reload()
    return result
  }

  // 接任者谢绝交接 → 交接终止，文档保持原状
  async function declineHandover(id, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      if (h.status !== HANDOVER.PENDING_CONFIRM) { result = { status: 'changed', handover: h }; return }
      if (h.toUserId !== userId || isGuestUser(userId)) { result = { status: 'denied' }; return }
      const updated = {
        ...h,
        status: HANDOVER.DECLINED,
        decideNote: String(note || '').trim(),
        timeline: [...(h.timeline || []), buildTimelineEntry('decline', userId, note, nowIso)]
      }
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated }
    })

    await reload()
    return result
  }

  // 发起人/管理员取消流转中的交接
  async function cancelHandover(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      if (!isHandoverOpen(h)) { result = { status: 'changed', handover: h }; return }
      if (isGuestUser(userId) || (h.fromUserId !== userId && role !== ROLE.ADMIN)) { result = { status: 'denied' }; return }
      const updated = {
        ...h,
        status: HANDOVER.CANCELLED,
        timeline: [...(h.timeline || []), buildTimelineEntry('cancel', userId, '', nowIso)]
      }
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated }
    })

    await reload()
    return result
  }

  // 管理员审批：approve 执行统一转移 / reject 驳回。
  // 批准路径在同一事务内：① 以发起快照逐篇复核并发变更 → ② 全部一致才统一转移
  // （所有权 + 历史归属 + 待办审批 + 保鲜责任 + 按决定收回权限）→ ③ 交接单置为已完成。
  // 校验不一致：事务内不写入任何转移，仅把交接单标记为已失败回退；
  // 转移途中抛错：Dexie 事务整体回滚，catch 中补记失败，绝不留下部分转移。
  async function decideHandover(id, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    try {
      await db.transaction('rw', db.handovers, db.docs, db.reviews, db.accessRequests, db.freshnessTickets, async () => {
        const h = await db.handovers.get(id)
        if (!h) { result = { status: 'missing' }; return }
        if (h.status !== HANDOVER.PENDING_APPROVAL) { result = { status: 'changed', handover: h }; return }

        if (decision === 'reject') {
          const rejected = {
            ...h,
            status: HANDOVER.REJECTED,
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            timeline: [...(h.timeline || []), buildTimelineEntry('reject', userId, decideNote, nowIso)]
          }
          await db.handovers.put(rejected)
          result = { status: 'ok', approved: false, handover: rejected }
          return
        }

        // ① 并发变更校验：事务内重读全部文档，与发起快照逐篇对比
        const docMap = {}
        for (const docId of h.docIds) docMap[docId] = (await db.docs.get(docId)) || null
        const conflicts = checkHandoverConflicts(h, docMap)
        if (conflicts.length) {
          const failReason = '交接期间文档发生并发变更：' +
            conflicts.map((c) => '《' + c.title + '》' + c.fields.join('、')).join('；') +
            '。本次交接未执行任何转移，请确认后重新发起。'
          const failed = {
            ...h,
            status: HANDOVER.FAILED,
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            failReason,
            timeline: [...(h.timeline || []), buildTimelineEntry('fail', userId, failReason, nowIso)]
          }
          await db.handovers.put(failed)
          result = { status: 'changed', conflicts, handover: failed }
          return
        }

        // ② 统一转移（同一事务，任一写入异常整体回滚）
        const from = h.fromUserId
        const to = h.toUserId
        const doneItems = []
        for (const item of h.items) {
          const doc = docMap[item.docId]

          // 所有权：交接给接任者；原负责人任期追加进 ownerHistory（历史归属保留）
          const ownerHistory = [
            ...(doc.ownerHistory || []),
            { ownerId: from, until: nowIso, handoverId: h.id, toUserId: to }
          ]
          // 协作成员：接任者加入；按交接决定保留/移出原负责人
          let editors = [...(doc.editors || [])]
          if (!editors.includes(to)) editors.push(to)
          if (h.revokeMode === REVOKE_MODE.REVOKE) editors = editors.filter((e) => e !== from)
          await db.docs.update(doc.id, { ownerId: to, editors, ownerHistory })

          // 待办审批（评审）：文档上流转中的评审单，原负责人名下的改挂接任者并留痕
          const transferredReviewIds = []
          const pendingReviews = await db.reviews
            .where('docId').equals(doc.id)
            .filter((r) => r.status === 'pending').toArray()
          for (const rv of pendingReviews) {
            if (rv.submittedBy !== from) continue
            await db.reviews.update(rv.id, {
              submittedBy: to,
              timeline: [...(rv.timeline || []), buildTimelineEntry('handover', userId, '负责人交接：评审待办随文档责任转移给接任者', nowIso)]
            })
            transferredReviewIds.push(rv.id)
          }

          // 保鲜责任：复核周期随所有权转移；流转中的复核单留痕并改挂送审人
          let freshTicketId = null
          const openFresh = await db.freshnessTickets
            .where('docId').equals(doc.id)
            .filter((t) => isFreshTicketOpen(t)).first()
          if (openFresh) {
            await db.freshnessTickets.update(openFresh.id, {
              ...(openFresh.submittedBy === from ? { submittedBy: to } : {}),
              timeline: [...(openFresh.timeline || []), buildFreshTimelineEntry('handover', userId, '负责人交接：保鲜复核责任转移给接任者', nowIso)]
            })
            freshTicketId = openFresh.id
          }

          // 待办审批（访问申请）：审批责任随所有权自动转移，此处统计留痕
          const accessPending = await db.accessRequests
            .where('docId').equals(doc.id)
            .filter((r) => r.status === ACCESS.PENDING).count()

          // 按交接决定收回原负责人在本文档上的有效限时授权（阅读/协作）
          let revokedGrants = 0
          if (h.revokeMode === REVOKE_MODE.REVOKE) {
            const grants = await db.accessRequests
              .where('docId').equals(doc.id)
              .filter((r) => r.applicantId === from && isGrantActive(r, new Date(nowIso))).toArray()
            for (const g of grants) {
              await db.accessRequests.update(g.id, {
                status: ACCESS.REVOKED,
                revokedAt: nowIso,
                grant: { ...(g.grant || {}), revokedAt: nowIso },
                timeline: [...(g.timeline || []), buildAccessTimelineEntry('revoke', userId, '负责人交接，按交接决定收回原负责人权限', nowIso)]
              })
              revokedGrants++
            }
          }

          doneItems.push({
            ...item,
            result: { reviewIds: transferredReviewIds, freshTicketId, accessPending, revokedGrants }
          })
        }

        // ③ 交接单完成：逐篇转移结果随单留档
        const completed = {
          ...h,
          status: HANDOVER.COMPLETED,
          items: doneItems,
          decidedBy: userId,
          decidedAt: nowIso,
          decideNote,
          completedAt: nowIso,
          timeline: [...(h.timeline || []), buildTimelineEntry('approve', userId, decideNote, nowIso)]
        }
        await db.handovers.put(completed)
        result = { status: 'ok', approved: true, handover: completed }
      })
    } catch (e) {
      // 转移途中异常：事务已整体回滚（无任何部分转移），补记失败留痕，可排查后重新发起
      const failReason = '交接执行异常，已整体回退：' + (e && e.message ? e.message : String(e))
      try {
        const cur = await db.handovers.get(id)
        if (cur && isHandoverOpen(cur)) {
          await db.handovers.put({
            ...cur,
            status: HANDOVER.FAILED,
            decidedBy: userId,
            decidedAt: nowIso,
            failReason,
            timeline: [...(cur.timeline || []), buildTimelineEntry('fail', userId, failReason, nowIso)]
          })
        }
      } catch { /* 补记失败本身出错时保持原状，交接单仍处于流转态可重试 */ }
      result = { status: 'error' }
    }

    // 联动刷新：所有权/评审待办/授权/保鲜责任均已变化
    const [{ useReviewStore }, { useAccessStore }, { useFreshnessStore }] = await Promise.all([
      import('./review'), import('./access'), import('./freshness')
    ])
    const review = useReviewStore()
    const access = useAccessStore()
    const freshness = useFreshnessStore()
    await Promise.all([
      reload(),
      kb.reloadDocs(),
      review.loaded ? review.reload() : Promise.resolve(),
      access.loaded ? access.reload() : Promise.resolve(),
      freshness.loaded ? freshness.reload() : Promise.resolve()
    ])
    return result
  }

  return {
    handovers, loaded, loadAll, reload, sorted,
    pendingConfirmFor, pendingApprovalFor, initiatedBy, involvedIn,
    activeHandoverOfDoc, pendingCountFor,
    initiateHandover, confirmHandover, declineHandover, cancelHandover, decideHandover
  }
})
