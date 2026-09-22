import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { ACCESS, isGrantActive, buildAccessTimelineEntry } from '@/utils/access'
import { isFreshTicketOpen, buildFreshTimelineEntry } from '@/utils/freshness'
import {
  HANDOVER, HANDOVER_ITEM, REVOKE_MODE,
  isHandoverOpen, isItemOpen, handoverSnapshotOf,
  deriveHandoverStatus, checkItemConflicts,
  pendingItemsForUser, approvableItems, successorIds
} from '@/utils/handover'
import { isDocRetired } from '@/utils/retirement'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { useKbStore } from './kb'
import { useAuthStore } from './auth'

// 知识责任交接 store（同批逐篇指定接任者）：
// 负责人勾选名下文档批量发起交接，在同一批中逐篇指定接任者 → 各接任者只对分配给自己的文档
// 独立确认/谢绝（互不阻塞）→ 管理员按确认结果分批勾选批准：已确认的文档在同一事务内统一转移。
// - 所有权：doc.ownerId 交给该篇接任者，原负责人任期追加进 doc.ownerHistory（历史归属全程保留）；
// - 待办审批：文档上流转中的评审单（原负责人名下）改挂接任者，待审批的访问申请随所有权自动转移；
// - 保鲜责任：复核周期随所有权转移，流转中的复核单留痕并改挂送审人；
// - 权限收回：按发起时整批的交接决定（keep/revoke）保留或收回原负责人的协作成员身份与有效授权。
// 分批批准时以发起快照逐篇复核并发变更：本批内某篇不一致仅标记该篇失败回退（不转移该篇），
// 其余文档照常转移；同一事务内写入，转移途中异常由 Dexie 事务整体回滚，绝不留下部分转移。
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

  // 待我确认（我作为某篇文档的接任者，且尚有分配给我的待确认条目）
  function pendingConfirmFor(userId) {
    if (isGuestUser(userId)) return []
    return sorted.value.filter((h) => h.status !== HANDOVER.CANCELLED && pendingItemsForUser(h, userId).length > 0)
  }

  // 待管理员批准（批次内存在已确认待批准的文档）
  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((h) => h.status !== HANDOVER.CANCELLED && approvableItems(h).length > 0)
  }

  // 我发起的
  function initiatedBy(userId) {
    return sorted.value.filter((h) => h.fromUserId === userId)
  }

  // 我相关的（发起或被指定为某篇接任者），普通成员的「全部记录」范围
  function involvedIn(userId) {
    return sorted.value.filter((h) => h.fromUserId === userId || successorIds(h).includes(userId))
  }

  // 文档当前是否有流转中的交接条目（同一文档同时只允许一个）。
  // 返回 { handover, item }：分批模式下接任者/状态以该文档条目为准。
  function activeHandoverOfDoc(docId) {
    for (const h of handovers.value) {
      if (h.status === HANDOVER.CANCELLED) continue
      const item = (h.items || []).find((it) => it.docId === docId && isItemOpen(it))
      if (item) return { ...h, item }
    }
    return null
  }

  // 侧栏角标：待我确认 + （管理员）待批准
  function pendingCountFor(userId, role) {
    return pendingConfirmFor(userId).length + pendingApprovalFor(role).length
  }

  // 归一化发起参数：新接口传 items[{docId,toUserId}]；兼容旧接口 { docIds, toUserId }
  function normalizeTargets(payload) {
    if (Array.isArray(payload.items) && payload.items.length) {
      return payload.items
        .map((it) => ({ docId: it.docId, toUserId: it.toUserId }))
        .filter((it) => it.docId)
    }
    return (payload.docIds || []).map((docId) => ({ docId, toUserId: payload.toUserId }))
  }

  // 负责人发起批量交接：逐篇指定接任者，逐篇复核归属并打快照（批准执行时据此校验并发变更）。
  // 返回 { status: 'ok', handover } | 'guest' | 'no-docs' | 'bad-target' | 'missing' |
  //       'denied' | 'retired' | 'in-retirement' | 'in-handover'
  async function initiateHandover(payload, currentUser) {
    const kb = useKbStore()
    const auth = useAuthStore()
    await Promise.all([kb.loadAll(), auth.loadUsers()])
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }

    const targets = normalizeTargets(payload)
    // 去重（同一文档只保留一次指定）
    const seen = new Set()
    const uniq = []
    for (const t of targets) {
      if (seen.has(t.docId)) continue
      seen.add(t.docId)
      uniq.push(t)
    }
    if (!uniq.length) return { status: 'no-docs' }
    // 每篇的接任者必须是已注册成员且不能是文档负责人自己
    const validUserIds = new Set(auth.users.map((u) => u.id))
    for (const t of uniq) {
      if (!t.toUserId || t.toUserId === userId || !validUserIds.has(t.toUserId)) {
        return { status: 'bad-target', docId: t.docId }
      }
    }
    const mode = payload.revokeMode === REVOKE_MODE.REVOKE ? REVOKE_MODE.REVOKE : REVOKE_MODE.KEEP
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.handovers, db.retirements, async () => {
      const items = []
      for (const t of uniq) {
        // 事务内重读：归属与交接占用以库中最新数据为准，防止多窗口并发发起
        const doc = await db.docs.get(t.docId)
        if (!doc) { result = { status: 'missing', docId: t.docId }; return }
        if (doc.ownerId !== userId) { result = { status: 'denied', docId: t.docId, title: doc.title }; return }
        // 已退役文档不再参与责任交接（只读归档）；流转中退役单也先完成/取消，避免两流程交错
        if (isDocRetired(doc)) { result = { status: 'retired', docId: t.docId, title: doc.title }; return }
        const dupRetire = await db.retirements.filter((rt) => rt.docId === t.docId && rt.status === 'pending').first()
        if (dupRetire) { result = { status: 'in-retirement', docId: t.docId, title: doc.title }; return }
        const dup = await db.handovers
          .filter((h) => h.status !== HANDOVER.CANCELLED &&
            (h.items || []).some((it) => it.docId === t.docId && isItemOpen(it))).first()
        if (dup) { result = { status: 'in-handover', docId: t.docId, title: doc.title, handover: dup }; return }
        items.push({
          docId: t.docId,
          title: doc.title,
          toUserId: t.toUserId,
          status: HANDOVER_ITEM.PENDING_CONFIRM,
          snapshot: handoverSnapshotOf(doc),
          confirmedAt: null,
          decidedBy: null,
          decidedAt: null,
          completedAt: null,
          failReason: '',
          result: null
        })
      }

      const handover = {
        id: uid('ho'),
        schemaVersion: 10,
        status: HANDOVER.PENDING_CONFIRM,
        fromUserId: userId,
        // toUserId 为兼容旧索引/展示保留：取首任接任者；逐篇接任者以 items[].toUserId 为准
        toUserId: items[0].toUserId,
        docIds: items.map((it) => it.docId),
        revokeMode: mode,
        note: String(payload.note || '').trim(),
        items,
        createdAt: nowIso,
        confirmedAt: null,
        decidedBy: null,
        decidedAt: null,
        decideNote: '',
        completedAt: null,
        failReason: '',
        timeline: [buildTimelineEntry('initiate', userId, payload.note, nowIso)]
      }
      await db.handovers.add(handover)
      result = { status: 'ok', handover }
    })

    await reload()
    return result
  }

  // 接任者回应（独立确认/谢绝分配给自己的文档）。
  // decision: 'confirm' | 'decline'；docIds 省略时作用于该用户名下全部待确认条目。
  // 返回 { status: 'ok', handover, affected } | 'guest' | 'missing' | 'denied' | 'none' | 'changed'
  async function respondHandover(id, decision, note, currentUser, docIds) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const nowIso = new Date().toISOString()
    const respNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction('rw', db.handovers, async () => {
      const h = await db.handovers.get(id)
      if (!h) { result = { status: 'missing' }; return }
      if (h.status === HANDOVER.CANCELLED) { result = { status: 'changed', handover: h }; return }
      // 只处理「分配给我 + 仍待确认 + 在本次指定范围内」的条目
      const scope = docIds && docIds.length ? new Set(docIds) : null
      const targets = h.items.filter(
        (it) => it.status === HANDOVER_ITEM.PENDING_CONFIRM && it.toUserId === userId &&
          (!scope || scope.has(it.docId))
      )
      if (!targets.length) { result = { status: 'denied' }; return }

      const targetIds = new Set(targets.map((it) => it.docId))
      const nextStatus = decision === 'confirm' ? HANDOVER_ITEM.PENDING_APPROVAL : HANDOVER_ITEM.DECLINED
      const titles = targets.map((it) => '《' + it.title + '》')
      const items = h.items.map((it) => {
        if (!targetIds.has(it.docId)) return it
        const updated = {
          ...it,
          status: nextStatus,
          decidedAt: null, decidedBy: null, failReason: ''
        }
        if (decision === 'confirm') updated.confirmedAt = nowIso
        return updated
      })

      const action = decision === 'confirm' ? 'confirm' : 'decline'
      const actionNote = (decision === 'confirm' ? '确认接收 ' : '谢绝交接 ') +
        targets.length + ' 篇：' + titles.join('、') + (respNote ? '。备注：' + respNote : '')
      const derived = deriveHandoverStatus(items)
      // 全部条目终态（如全部谢绝）时记录整批结案时间
      const allSettled = items.every((it) => [HANDOVER_ITEM.COMPLETED, HANDOVER_ITEM.DECLINED, HANDOVER_ITEM.REJECTED, HANDOVER_ITEM.FAILED].includes(it.status))
      const updated = {
        ...h,
        items,
        status: derived,
        ...(decision === 'confirm' ? { confirmedAt: nowIso } : {}),
        ...(allSettled && !h.completedAt ? { completedAt: nowIso } : {}),
        timeline: [...(h.timeline || []), buildTimelineEntry(action, userId, actionNote, nowIso)]
      }
      await db.handovers.put(updated)
      result = { status: 'ok', handover: updated, affected: targets.length, declined: decision !== 'confirm' }
    })

    await reload()
    return result
  }

  // 兼容旧调用：整批确认（作用于调用者名下全部待确认条目，单接任者批次即整批）
  async function confirmHandover(id, currentUser) {
    return respondHandover(id, 'confirm', '', currentUser)
  }

  // 兼容旧调用：整批谢绝
  async function declineHandover(id, note, currentUser) {
    return respondHandover(id, 'decline', note, currentUser)
  }

  // 发起人/管理员取消流转中的交接（整批未结条目一并取消）
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

  // 单篇文档转移：所有权 + 历史归属 + 待办审批 + 保鲜责任 + 按整批决定收回权限。
  // 必须运行在交接审批事务内；返回逐篇转移结果（随单留档）。
  async function transferOne({ h, item, doc, adminId, nowIso }) {
    const from = h.fromUserId
    const to = item.toUserId

    // 所有权：交接给该篇接任者；原负责人任期追加进 ownerHistory（历史归属保留）
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
        timeline: [...(rv.timeline || []), buildTimelineEntry('handover', adminId, '负责人交接：评审待办随文档责任转移给接任者', nowIso)]
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
        timeline: [...(openFresh.timeline || []), buildFreshTimelineEntry('handover', adminId, '负责人交接：保鲜复核责任转移给接任者', nowIso)]
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
          timeline: [...(g.timeline || []), buildAccessTimelineEntry('revoke', adminId, '负责人交接，按交接决定收回原负责人权限', nowIso)]
        })
        revokedGrants++
      }
    }

    return { reviewIds: transferredReviewIds, freshTicketId, accessPending, revokedGrants }
  }

  // 管理员分批审批：approve 对选定的已确认文档执行统一转移 / reject 逐篇驳回。
  // docIds 省略时作用于批次内全部「已确认待批准」条目。
  // 批准路径在同一事务内：① 以发起快照逐篇复核并发变更 → ② 冲突条目仅标记该篇失败回退，
  //   其余选定条目统一转移（所有权 + 历史归属 + 待办审批 + 保鲜责任 + 按决定收回权限）→
  //   ③ 重算批次状态（全部完成才置 completed，否则保持分批处理中）。
  // 返回 { status: 'ok', approved, rejected, conflicts, handover } | 'guest' | 'denied' |
  //       'missing' | 'none' | 'changed'（整批选定条目全部冲突）| 'error'
  async function decideHandover(id, decision, note, currentUser, docIds) {
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
        if (h.status === HANDOVER.CANCELLED) { result = { status: 'changed', handover: h }; return }

        const scope = docIds && docIds.length ? new Set(docIds) : null
        const targets = approvableItems(h).filter((it) => !scope || scope.has(it.docId))
        if (!targets.length) { result = { status: 'none', handover: h }; return }
        const targetIds = new Set(targets.map((it) => it.docId))

        // ---- 驳回路径：选定条目逐篇驳回，文档保持原状，其余条目不受影响 ----
        if (decision === 'reject') {
          const titles = targets.map((it) => '《' + it.title + '》')
          const items = h.items.map((it) => targetIds.has(it.docId)
            ? { ...it, status: HANDOVER_ITEM.REJECTED, decidedBy: userId, decidedAt: nowIso, failReason: '' }
            : it)
          const actionNote = '驳回 ' + targets.length + ' 篇：' + titles.join('、') + (decideNote ? '。备注：' + decideNote : '')
          const rejectSettled = items.every((it) =>
            [HANDOVER_ITEM.COMPLETED, HANDOVER_ITEM.DECLINED, HANDOVER_ITEM.REJECTED, HANDOVER_ITEM.FAILED].includes(it.status))
          const updated = {
            ...h,
            items,
            status: deriveHandoverStatus(items),
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            completedAt: rejectSettled ? (h.completedAt || nowIso) : (h.completedAt || null),
            timeline: [...(h.timeline || []), buildTimelineEntry('reject', userId, actionNote, nowIso)]
          }
          await db.handovers.put(updated)
          result = { status: 'ok', approved: false, rejected: targets.length, handover: updated }
          return
        }

        // ---- 批准路径 ----
        // ① 并发变更校验：只复核本次选定条目，冲突仅影响该篇
        const docMap = {}
        for (const it of targets) docMap[it.docId] = (await db.docs.get(it.docId)) || null
        const { conflictMap, failures } = checkItemConflicts(targets, docMap)

        const itemMap = {}
        // 冲突条目：本批不转移，逐篇标记失败回退（其余文档照常转移）
        for (const f of failures) {
          const reason = '交接期间文档发生并发变更：' + f.fields.join('、') +
            '。本文档本次未转移，其余确认文档不受影响，可确认后重新发起。'
          itemMap[f.docId] = {
            status: HANDOVER_ITEM.FAILED,
            decidedBy: userId, decidedAt: nowIso, completedAt: null, failReason: reason
          }
        }

        // ② 统一转移未冲突条目（同一事务，任一写入异常整体回滚）
        const doneTitles = []
        for (const item of targets) {
          if (conflictMap[item.docId]) continue
          const doc = docMap[item.docId]
          const transferResult = await transferOne({ h, item, doc, adminId: userId, nowIso })
          doneTitles.push('《' + item.title + '》')
          itemMap[item.docId] = {
            status: HANDOVER_ITEM.COMPLETED,
            result: transferResult,
            decidedBy: userId, decidedAt: nowIso, completedAt: nowIso, failReason: ''
          }
        }

        const items = h.items.map((it) =>
          itemMap[it.docId] ? { ...it, ...itemMap[it.docId] } : it
        )
        const newStatus = deriveHandoverStatus(items)
        // 全部条目终态（全部完成，或完成/谢绝/驳回/失败均已结案）→ 记录整批结案时间
        const allSettled = items.every((it) =>
          [HANDOVER_ITEM.COMPLETED, HANDOVER_ITEM.DECLINED, HANDOVER_ITEM.REJECTED, HANDOVER_ITEM.FAILED].includes(it.status))

        const timeline = [...(h.timeline || [])]
        if (doneTitles.length) {
          const approveNote = '批准转移 ' + doneTitles.length + ' 篇：' + doneTitles.join('、') +
            (decideNote ? '。备注：' + decideNote : '')
          timeline.push(buildTimelineEntry('approve', userId, approveNote, nowIso))
        }
        if (failures.length) {
          const failNote = failures.map((f) => '《' + f.title + '》' + f.fields.join('、')).join('；')
          timeline.push(buildTimelineEntry('fail', userId, '以下文档并发变更、本批未转移：' + failNote, nowIso))
        }

        // ③ 交接单更新：逐篇转移结果随单留档；整批全部结案才记录完成时间
        const updated = {
          ...h,
          items,
          status: newStatus,
          decidedBy: userId,
          decidedAt: nowIso,
          decideNote,
          completedAt: allSettled ? (h.completedAt || nowIso) : (h.completedAt || null),
          failReason: failures.length
            ? '本批 ' + failures.length + ' 篇并发变更未转移：' +
              failures.map((f) => '《' + f.title + '》').join('、')
            : ''
        }
        updated.timeline = timeline
        await db.handovers.put(updated)

        if (!doneTitles.length) {
          // 选定条目全部冲突：无任何转移
          result = { status: 'changed', conflicts: failures, handover: updated }
        } else {
          result = { status: 'ok', approved: true, transferred: doneTitles.length, conflicts: failures, handover: updated }
        }
      })
    } catch (e) {
      // 转移途中异常：事务已整体回滚（无任何部分转移），把本批选定条目补记失败留痕，可重新发起
      const failReason = '交接执行异常，已整体回退：' + (e && e.message ? e.message : String(e))
      try {
        const cur = await db.handovers.get(id)
        if (cur && isHandoverOpen(cur)) {
          const scope = docIds && docIds.length ? new Set(docIds) : null
          const items = cur.items.map((it) =>
            it.status === HANDOVER_ITEM.PENDING_APPROVAL && (!scope || scope.has(it.docId))
              ? { ...it, status: HANDOVER_ITEM.FAILED, decidedBy: userId, decidedAt: nowIso, failReason }
              : it
          )
          await db.handovers.put({
            ...cur,
            items,
            status: deriveHandoverStatus(items),
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
    initiateHandover, respondHandover, confirmHandover, declineHandover,
    cancelHandover, decideHandover
  }
})
