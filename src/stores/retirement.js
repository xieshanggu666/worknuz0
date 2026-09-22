import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { RETIRE, isRetirementOpen, isRetirementActive } from '@/utils/retirement'
import { GAP } from '@/utils/gap'
import { isItemOfDocOpen } from '@/utils/handover'
import { GUEST_ID, isGuestUser, ROLE } from '@/utils/permission'
import { useKbStore } from './kb'

// 知识退役替代 store：
// 负责人发起文档退役并指定替代文档（pending）→ 管理员批准（approved），在同一事务内：
// - doc.retirement 记录生效退役，旧文档立即停止搜索命中与问答引用（详情仍可访问）；
// - 旧文档全部「有效」共享链接批量撤销（revokedAt + 撤销原因，记录保留不删除）；
// - 已解决缺口工单（resolved、答案来源指向旧文档）的 docId 改挂替代文档并逐条留痕；
// 管理员可驳回（rejected）、发起人审批前可撤销（cancelled）；退役生效后发起人/管理员可撤销退役
// （revoked）：同事务恢复搜索/问答引用、恢复被本次退役撤销的共享链接、答案来源回挂旧文档。
// 退役单（retirements）与其 timeline、联动结果（effects）全程保留。
export const useRetirementStore = defineStore('retirement', () => {
  const retirements = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    retirements.value = await db.retirements.toArray()
  }

  const sorted = computed(() =>
    [...retirements.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 某文档流转中（待审批）的退役单：同一文档同时只允许一个
  function openRetirementOfDoc(docId) {
    return retirements.value.find((r) => isRetirementOpen(r) && r.docId === docId) || null
  }

  // 某文档当前生效退役（旧文档退役态）
  function activeRetirementOfDoc(docId) {
    return retirements.value.find((r) => isRetirementActive(r) && r.docId === docId) || null
  }

  // 某文档是否被某条生效退役指定为替代文档（用于阻止替代文档自身被退役/删除）
  function activeRetirementUsingAsReplacement(docId) {
    return retirements.value.find((r) => isRetirementActive(r) && r.replacementDocId === docId) || null
  }

  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((r) => r.status === RETIRE.PENDING)
  }

  function initiatedBy(userId) {
    return sorted.value.filter((r) => r.initiatedBy === userId)
  }

  function involvedIn(userId) {
    return sorted.value.filter((r) => r.initiatedBy === userId || r.replacementOwnerId === userId)
  }

  // 侧栏角标：（管理员）待审批退役单数
  function pendingCountFor(role) {
    return pendingApprovalFor(role).length
  }

  // 发起退役：事务内逐篇/逐条复核归属、替代文档合法性与各类占用（评审/交接/退役）
  // 返回 { status: 'ok', retirement } | 'guest' | 'denied' | 'missing' | 'bad-replacement'
  //       | 'replacement-retired' | 'in-retirement' | 'in-review' | 'in-handover'
  async function initiateRetirement({ docId, replacementDocId, reason }, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.docs, db.retirements, db.reviews, db.handovers, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'missing' }; return }
      if (doc.ownerId !== userId && role !== ROLE.ADMIN) { result = { status: 'denied', title: doc.title }; return }
      if (doc.retirement?.status === RETIRE.APPROVED) { result = { status: 'in-retirement', title: doc.title }; return }

      const dup = await db.retirements.filter((r) => isRetirementOpen(r) && r.docId === docId).first()
      if (dup) { result = { status: 'in-retirement', title: doc.title, retirement: dup }; return }

      // 替代文档合法性
      if (!replacementDocId || replacementDocId === docId) { result = { status: 'bad-replacement' }; return }
      const replacement = await db.docs.get(replacementDocId)
      if (!replacement) { result = { status: 'bad-replacement' }; return }
      if (replacement.retirement?.status === RETIRE.APPROVED) { result = { status: 'replacement-retired', title: replacement.title }; return }
      const repOpen = await db.retirements.filter((r) => isRetirementOpen(r) && r.docId === replacementDocId).first()
      if (repOpen) { result = { status: 'replacement-retired', title: replacement.title }; return }

      // 评审中的文档先走完评审再退役，避免锁定与引用状态交错
      const pendingReview = await db.reviews
        .where('docId').equals(docId)
        .filter((rv) => rv.status === 'pending').first()
      if (pendingReview) { result = { status: 'in-review', title: doc.title }; return }

      // 交接中的文档先完成/取消交接，避免所有权与退役责任交错（分批模式按该文档条目判断）
      const handover = await db.handovers.filter((h) => isItemOfDocOpen(h, docId)).first()
      if (handover) { result = { status: 'in-handover', title: doc.title }; return }

      const retirement = {
        id: uid('rt'),
        status: RETIRE.PENDING,
        docId,
        docTitle: doc.title,
        replacementDocId,
        replacementTitle: replacement.title,
        replacementOwnerId: replacement.ownerId,
        initiatedBy: userId,
        reason: String(reason || '').trim(),
        createdAt: nowIso,
        decidedBy: null,
        decidedAt: null,
        decideNote: '',
        approvedAt: null,
        revokedBy: null,
        revokedAt: null,
        revokeNote: '',
        // effects：批准/撤销退役时的联动结果（改挂的工单、撤销的共享链接），撤销时据此逐项还原
        effects: null,
        timeline: [buildTimelineEntry('initiate', userId, reason, nowIso)]
      }
      await db.retirements.add(retirement)
      result = { status: 'ok', retirement }
    })

    await reload()
    return result
  }

  // 发起人在审批前撤销退役申请
  async function cancelRetirement(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, async () => {
      const r = await db.retirements.get(id)
      if (!r) { result = { status: 'missing' }; return }
      if (!isRetirementOpen(r)) { result = { status: 'changed', retirement: r }; return }
      if (r.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }
      const updated = {
        ...r,
        status: RETIRE.CANCELLED,
        timeline: [...(r.timeline || []), buildTimelineEntry('cancel', userId, '', nowIso)]
      }
      await db.retirements.put(updated)
      result = { status: 'ok', retirement: updated }
    })

    await reload()
    return result
  }

  // 管理员审批：reject 驳回（文档保持原状）/ approve 生效（同事务执行全部联动）
  async function decideRetirement(id, decision, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (isGuestUser(userId)) return { status: 'guest' }
    if (currentUser?.role !== ROLE.ADMIN) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const decideNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.retirements, db.docs, db.shares, db.gapTickets, db.reviews, db.handovers,
      async () => {
        const r = await db.retirements.get(id)
        if (!r) { result = { status: 'missing' }; return }
        if (!isRetirementOpen(r)) { result = { status: 'changed', retirement: r }; return }

        if (decision === 'reject') {
          const rejected = {
            ...r,
            status: RETIRE.REJECTED,
            decidedBy: userId,
            decidedAt: nowIso,
            decideNote,
            timeline: [...(r.timeline || []), buildTimelineEntry('reject', userId, decideNote, nowIso)]
          }
          await db.retirements.put(rejected)
          result = { status: 'ok', approved: false, retirement: rejected }
          return
        }

        // ---- 批准生效：事务内重读，复核并发变更 ----
        const doc = await db.docs.get(r.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        const replacement = await db.docs.get(r.replacementDocId)
        if (!replacement) { result = { status: 'replacement-missing' }; return }
        // 替代文档在审批期间也被退役 → 不允许（避免替代链落到已退役文档）
        if (replacement.retirement?.status === RETIRE.APPROVED) { result = { status: 'replacement-retired', title: replacement.title }; return }
        // 旧文档审批期间进入评审/交接 → 驳回本次执行，发起人处理完后可重新发起
        const pendingReview = await db.reviews
          .where('docId').equals(doc.id)
          .filter((rv) => rv.status === 'pending').first()
        if (pendingReview) { result = { status: 'in-review', title: doc.title }; return }
        const handover = await db.handovers.filter((h) => isItemOfDocOpen(h, doc.id)).first()
        if (handover) { result = { status: 'in-handover', title: doc.title }; return }

        // ① 共享链接：撤销旧文档全部「有效」链接（未过期、未撤销），保留记录与撤销时间，撤销退役时可恢复
        const shares = await db.shares.where('docId').equals(doc.id).toArray()
        const revokedShareIds = []
        for (const s of shares) {
          const expired = s.expiresAt && new Date(s.expiresAt) <= new Date(nowIso)
          if (s.revokedAt || expired) continue
          await db.shares.update(s.id, {
            revokedAt: nowIso,
            revokeReason: 'retirement:' + r.id
          })
          revokedShareIds.push(s.id)
        }

        // ② 已解决缺口工单：答案来源（docId）由旧文档改挂替代文档，逐条留痕；撤销退役时据此回挂
        const resolvedTickets = await db.gapTickets
          .where('docId').equals(doc.id)
          .filter((t) => t.status === GAP.RESOLVED).toArray()
        const repointedTicketIds = []
        for (const t of resolvedTickets) {
          await db.gapTickets.update(t.id, {
            docId: replacement.id,
            timeline: [
              ...(t.timeline || []),
              buildTimelineEntry('gap-repoint', userId, '答案来源文档《' + doc.title + '》已退役，改挂替代文档《' + replacement.title + '》（退役单 ' + r.id + '）', nowIso)
            ]
          })
          repointedTicketIds.push(t.id)
        }

        // ③ 文档置退役态：记录生效退役（搜索/问答闸门据此停止引用）
        await db.docs.update(doc.id, {
          retirement: {
            id: r.id,
            status: RETIRE.APPROVED,
            replacementDocId: replacement.id,
            replacementTitle: replacement.title,
            approvedBy: userId,
            approvedAt: nowIso
          }
        })

        const effects = {
          revokedShareIds,
          repointedTicketIds,
          shareCountBefore: shares.length,
          resolvedCount: resolvedTickets.length
        }
        const approved = {
          ...r,
          status: RETIRE.APPROVED,
          decidedBy: userId,
          decidedAt: nowIso,
          decideNote,
          approvedAt: nowIso,
          replacementTitle: replacement.title,
          replacementOwnerId: replacement.ownerId,
          effects,
          timeline: [
            ...(r.timeline || []),
            buildTimelineEntry('approve', userId, decideNote, nowIso),
            buildTimelineEntry('gap-repoint', userId, '已解决缺口工单 ' + repointedTicketIds.length + ' 张答案来源改挂《' + replacement.title + '》', nowIso),
            buildTimelineEntry('share-revoke', userId, '旧文档有效共享链接 ' + revokedShareIds.length + ' 条随退役撤销', nowIso)
          ]
        }
        await db.retirements.put(approved)
        result = { status: 'ok', approved: true, retirement: approved, effects }
      }
    )

    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  // 撤销已生效的退役：同事务逐项还原（搜索/引用、共享链接、答案来源），退役单置 revoked 并保留记录
  async function revokeRetirement(id, note, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    const nowIso = new Date().toISOString()
    const revokeNote = String(note || '').trim()
    let result = { status: 'error' }

    await db.transaction('rw', db.retirements, db.docs, db.shares, db.gapTickets, async () => {
      const r = await db.retirements.get(id)
      if (!r) { result = { status: 'missing' }; return }
      if (!isRetirementActive(r)) { result = { status: 'changed', retirement: r }; return }
      if (r.initiatedBy !== userId && role !== ROLE.ADMIN) { result = { status: 'denied' }; return }

      const doc = await db.docs.get(r.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      const replacement = await db.docs.get(r.replacementDocId)

      // ① 共享链接：恢复被本次退役撤销、且当前仍未被再次撤销的链接（清除退役撤销标记）
      const restoredShareIds = []
      for (const sid of r.effects?.revokedShareIds || []) {
        const s = await db.shares.get(sid)
        // 仅恢复仍带有本次退役撤销标记的链接：退役期间被人工再次撤销的不恢复
        if (!s || s.revokeReason !== 'retirement:' + r.id) continue
        await db.shares.update(s.id, { revokedAt: null, revokeReason: null })
        restoredShareIds.push(s.id)
      }

      // ② 答案来源回挂旧文档：仅回挂「仍指向替代文档、且改挂记录来自本退役单」的工单，
      //    退役期间被另行处理（重新送审/改挂其他文档）的工单不强行覆盖
      const restoredTicketIds = []
      for (const tid of r.effects?.repointedTicketIds || []) {
        const t = await db.gapTickets.get(tid)
        if (!t || t.docId !== r.replacementDocId) continue
        // 以退役单 id 标记识别本次改挂；若之后又产生了非本退役的处理记录，则不覆盖
        const repointIdx = (t.timeline || []).findLastIndex
          ? t.timeline.findLastIndex((x) => x.action === 'gap-repoint' && (x.note || '').includes(r.id))
          : (() => {
              for (let i = t.timeline.length - 1; i >= 0; i--) {
                if (t.timeline[i].action === 'gap-repoint' && (t.timeline[i].note || '').includes(r.id)) return i
              }
              return -1
            })()
        if (repointIdx < 0) continue
        const after = (t.timeline || []).slice(repointIdx + 1)
        // 退役改挂之后若工单又被退回/重新送审/再次改挂，则保持现状不回挂
        if (after.some((x) => ['return', 'reset', 'submit', 'resolve', 'gap-repoint'].includes(x.action))) continue
        await db.gapTickets.update(t.id, {
          docId: doc.id,
          timeline: [
            ...(t.timeline || []),
            buildTimelineEntry('gap-restore', userId, '退役已撤销，答案来源回挂《' + doc.title + '》（退役单 ' + r.id + '）', nowIso)
          ]
        })
        restoredTicketIds.push(t.id)
      }

      // ③ 文档解除退役态：恢复搜索与问答引用
      await db.docs.update(doc.id, { retirement: null })

      const revoked = {
        ...r,
        status: RETIRE.REVOKED,
        revokedBy: userId,
        revokedAt: nowIso,
        revokeNote,
        effects: { ...(r.effects || {}), restoredShareIds, restoredTicketIds },
        timeline: [
          ...(r.timeline || []),
          buildTimelineEntry('revoke', userId, revokeNote, nowIso),
          buildTimelineEntry('gap-restore', userId, '答案来源回挂 ' + restoredTicketIds.length + ' 张工单', nowIso),
          buildTimelineEntry('share-restore', userId, '共享链接恢复 ' + restoredShareIds.length + ' 条', nowIso)
        ]
      }
      await db.retirements.put(revoked)
      result = { status: 'ok', retirement: revoked, restoredShareIds, restoredTicketIds, replacementMissing: !replacement }
    })

    const { useGapStore } = await import('./gap')
    const gap = useGapStore()
    await Promise.all([reload(), kb.reloadDocs(), gap.reload()])
    return result
  }

  return {
    retirements, loaded, loadAll, reload, sorted,
    openRetirementOfDoc, activeRetirementOfDoc, activeRetirementUsingAsReplacement,
    pendingApprovalFor, initiatedBy, involvedIn, pendingCountFor,
    initiateRetirement, cancelRetirement, decideRetirement, revokeRetirement
  }
})
