<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useHandoverStore } from '@/stores/handover'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  HANDOVER, REVOKE_MODE, handoverStatusLabel, handoverStatusCls,
  handoverItemStatusLabel, handoverItemStatusCls, revokeModeLabel,
  canRespondHandover, canDecideHandover, canCancelHandover, handoverTimelineLabel,
  pendingItemsForUser, approvableItems, handoverProgress, successorIds
} from '@/utils/handover'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const handoverStore = useHandoverStore()

const tab = ref('confirm') // confirm | approve | mine | all
const busyId = ref('')
const noteMap = ref({})

// ---- 发起批量交接（同批逐篇指定接任者）----
const creating = ref(false)
const picked = ref([]) // 选中的文档 id
const targetMap = reactive({}) // 每篇文档选定的接任者 { [docId]: userId }
const defaultTo = ref('') // 批量默认接任者
const revokeMode = ref(REVOKE_MODE.KEEP)
const note = ref('')
const initiateBusy = ref(false)

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

// 我负责的文档（可交接）；已有流转中交接条目的文档不可重复发起
const ownDocs = computed(() =>
  kb.docs
    .filter((d) => d.ownerId === auth.user?.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)
const successors = computed(() => auth.users.filter((u) => u.id !== auth.user?.id))

const confirmList = computed(() => handoverStore.pendingConfirmFor(auth.user?.id))
const approveList = computed(() => handoverStore.pendingApprovalFor(auth.user?.role))
const mineList = computed(() => handoverStore.initiatedBy(auth.user?.id))
const allList = computed(() =>
  auth.user?.role === 'admin' ? handoverStore.sorted : handoverStore.involvedIn(auth.user?.id)
)
const list = computed(() => {
  if (tab.value === 'confirm') return confirmList.value
  if (tab.value === 'approve') return approveList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})
const counts = computed(() => ({
  confirm: confirmList.value.length,
  approve: approveList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

// 勾选/取消勾选文档；勾选时若未指定接任者则套用批量默认接任者
function togglePick(id) {
  const i = picked.value.indexOf(id)
  if (i >= 0) {
    picked.value.splice(i, 1)
    delete targetMap[id]
  } else {
    picked.value.push(id)
    if (!targetMap[id]) targetMap[id] = defaultTo.value
  }
}

function openCreate() {
  creating.value = true
  picked.value = []
  Object.keys(targetMap).forEach((k) => delete targetMap[k])
  defaultTo.value = successors.value[0]?.id || ''
  revokeMode.value = REVOKE_MODE.KEEP
  note.value = ''
}

// 批量默认接任者：应用到所有已勾选文档（仍可逐篇改）
function applyDefaultTo() {
  picked.value.forEach((id) => { targetMap[id] = defaultTo.value })
}

const pickedAllAssigned = computed(() =>
  picked.value.length > 0 && picked.value.every((id) => targetMap[id])
)

async function submitInitiate() {
  if (initiateBusy.value) return
  if (!picked.value.length) { alert('请至少选择一篇要交接的文档'); return }
  if (!pickedAllAssigned.value) { alert('请为每一篇文档指定接任者'); return }
  initiateBusy.value = true
  try {
    const items = picked.value.map((docId) => ({ docId, toUserId: targetMap[docId] }))
    const res = await handoverStore.initiateHandover(
      { items, revokeMode: revokeMode.value, note: note.value.trim() },
      auth.user
    )
    if (res.status === 'ok') {
      creating.value = false
      tab.value = 'mine'
    } else if (res.status === 'denied') {
      alert('发起失败：《' + (res.title || res.docId) + '》的负责人不是你，无法交接。')
    } else if (res.status === 'in-handover') {
      alert('发起失败：《' + (res.title || res.docId) + '》已有流转中的交接单，请先完成或取消。')
    } else if (res.status === 'bad-target') {
      alert('发起失败：《' + (res.title || res.docId || '') + '》的接任者无效（不能指定自己或不存在的成员）。')
    } else if (res.status === 'guest') {
      alert('请先登录后再发起交接。')
    } else {
      alert('发起失败，请稍后重试。')
    }
  } finally {
    initiateBusy.value = false
  }
}

// ---- 接任者：独立确认/谢绝分配给我的文档 ----
function myPendingItems(h) {
  return pendingItemsForUser(h, auth.user?.id)
}

async function respond(h, decision) {
  if (busyId.value) return
  busyId.value = h.id
  try {
    const docIds = myPendingItems(h).map((it) => it.docId)
    const res = await handoverStore.respondHandover(
      h.id, decision, (noteMap.value[h.id] || '').trim(), auth.user, docIds
    )
    if (res.status !== 'ok') alert('操作失败：交接状态已变化')
  } finally {
    busyId.value = ''
  }
}

// ---- 管理员：按确认结果分批批准/驳回（勾选已确认文档）----
const approveSel = reactive({}) // { [handoverId]: Set<docId> }
function approvableOf(h) {
  return approvableItems(h)
}
function isApproveChecked(h, docId) {
  return (approveSel[h.id] || new Set()).has(docId)
}
function toggleApprove(h, docId) {
  if (!approveSel[h.id]) approveSel[h.id] = new Set(approvableOf(h).map((it) => it.docId))
  const s = approveSel[h.id]
  if (s.has(docId)) s.delete(docId); else s.add(docId)
}
function allApproveChecked(h) {
  const ids = approvableOf(h).map((it) => it.docId)
  return ids.length > 0 && ids.every((id) => isApproveChecked(h, id))
}
function toggleApproveAll(h) {
  const ids = approvableOf(h).map((it) => it.docId)
  if (allApproveChecked(h)) approveSel[h.id] = new Set()
  else approveSel[h.id] = new Set(ids)
}

async function decide(h, decision) {
  if (busyId.value) return
  const docIds = [...(approveSel[h.id] || new Set())]
  if (!docIds.length) { alert('请先勾选要' + (decision === 'approve' ? '批准转移' : '驳回') + '的文档'); return }
  busyId.value = h.id
  try {
    const res = await handoverStore.decideHandover(
      h.id, decision, (noteMap.value[h.id] || '').trim(), auth.user, docIds
    )
    if (res.status === 'changed' && res.conflicts) {
      alert('本批未执行转移：' + res.handover.failReason)
    } else if (res.status === 'ok' && decision === 'approve' && res.conflicts?.length) {
      alert('已转移 ' + res.transferred + ' 篇；' + res.conflicts.length + ' 篇因并发变更未转移：' +
        res.conflicts.map((c) => '《' + c.title + '》').join('、'))
    } else if (res.status !== 'ok') {
      alert('操作失败：交接状态已变化')
    }
  } finally {
    busyId.value = ''
  }
}

async function cancel(h) {
  if (!confirm('确定整批取消本次交接？取消后各文档保持原状。')) return
  const res = await handoverStore.cancelHandover(h.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：交接状态已变化')
}

// 逐篇转移结果摘要
function itemResultText(item) {
  const r = item.result
  if (!r) return ''
  const parts = ['所有权已转移']
  if (r.reviewIds?.length) parts.push('评审待办 ' + r.reviewIds.length + ' 项已改挂')
  if (r.freshTicketId) parts.push('保鲜复核单已留痕')
  if (r.accessPending) parts.push('待审批访问申请 ' + r.accessPending + ' 项随负责人转移')
  if (r.revokedGrants) parts.push('收回原负责人授权 ' + r.revokedGrants + ' 项')
  return parts.join(' · ')
}

// 批次按接任者分组（头部展示）
function groupsOf(h) {
  const map = {}
  for (const it of h.items || []) {
    if (!map[it.toUserId]) map[it.toUserId] = { userId: it.toUserId, count: 0 }
    map[it.toUserId].count++
  }
  return Object.values(map)
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), auth.loadUsers(), handoverStore.loadAll()])
  // 有待确认/待批准事项时直接落在对应页签
  if (confirmList.value.length) tab.value = 'confirm'
  else if (approveList.value.length) tab.value = 'approve'
  else tab.value = 'mine'
})
</script>

<template>
  <div class="ho-page">
    <header class="head">
      <h2>🤝 责任交接</h2>
      <p class="sub">
        负责人勾选名下文档批量发起交接，在同一批中逐篇指定接任者；各接任者独立确认或谢绝分配给自己的文档，
        管理员按确认结果分批勾选批准。批准时逐篇转移所有权、待办审批与保鲜责任，并保留历史归属；
        交接期间校验并发变更，单篇不一致仅该篇回退，不影响同批其他文档。
      </p>
      <div class="head-row">
        <div class="tabs">
          <button :class="{ on: tab === 'confirm' }" @click="tab = 'confirm'">待我确认 <em>{{ counts.confirm }}</em></button>
          <button v-if="auth.user?.role === 'admin'" :class="{ on: tab === 'approve' }" @click="tab = 'approve'">待批准 <em>{{ counts.approve }}</em></button>
          <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我发起的 <em>{{ counts.mine }}</em></button>
          <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
        </div>
        <button class="btn primary" @click="openCreate">＋ 发起批量交接</button>
      </div>
    </header>

    <!-- 发起批量交接 -->
    <div v-if="creating" class="create card">
      <div class="c-title">📦 发起批量交接 · 逐篇指定接任者</div>
      <div class="c-hint">勾选你负责的文档，并为每一篇指定接任者；可先用「批量默认接任者」再逐篇调整。交接流转期间请避免修改这些文档。</div>
      <div v-if="!ownDocs.length" class="c-empty">你名下暂无可交接的文档</div>
      <template v-else>
        <div class="doc-pick">
          <label v-for="d in ownDocs" :key="d.id" class="dp" :class="{ disabled: handoverStore.activeHandoverOfDoc(d.id) }">
            <input
              type="checkbox"
              :checked="picked.includes(d.id)"
              :disabled="!!handoverStore.activeHandoverOfDoc(d.id)"
              @change="togglePick(d.id)"
            />
            <span class="dp-title">{{ d.title }}</span>
            <select
              v-if="picked.includes(d.id)"
              class="dp-sel"
              v-model="targetMap[d.id]"
              @click.stop
            >
              <option v-for="u in successors" :key="u.id" :value="u.id">{{ u.name }}（{{ u.title || u.role }}）</option>
            </select>
            <span v-if="handoverStore.activeHandoverOfDoc(d.id)" class="dp-tag">交接流转中</span>
          </label>
        </div>
        <div class="c-form">
          <label class="f-item">
            <span class="f-k">批量默认接任者</span>
            <select v-model="defaultTo" class="f-sel" @change="applyDefaultTo">
              <option v-for="u in successors" :key="u.id" :value="u.id">{{ u.name }}（{{ u.title || u.role }}）</option>
            </select>
          </label>
          <label class="f-item">
            <span class="f-k">原负责人权限</span>
            <span class="f-radios">
              <label><input type="radio" value="keep" v-model="revokeMode" /> 保留协作权限</label>
              <label><input type="radio" value="revoke" v-model="revokeMode" /> 收回全部权限</label>
            </span>
          </label>
          <input v-model="note" class="f-note" placeholder="交接说明（可选，将写入交接记录）" />
        </div>
      </template>
      <div class="c-acts">
        <button class="btn ghost" @click="creating = false">取消</button>
        <button class="btn primary" :disabled="initiateBusy || !pickedAllAssigned" @click="submitInitiate">
          {{ initiateBusy ? '提交中…' : '提交交接（已选 ' + picked.length + ' 篇）' }}
        </button>
      </div>
    </div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🤝</div>
      {{ tab === 'confirm' ? '暂无待你确认的交接' : tab === 'approve' ? '暂无待批准的交接' : tab === 'mine' ? '你还没有发起过交接' : '暂无交接记录' }}
    </div>

    <div v-else class="ho-list">
      <div v-for="h in list" :key="h.id" class="ho card">
        <div class="ho-top">
          <div class="ho-main">
            <span class="ho-users">
              <span class="ava" :style="{ background: avatarColor(h.fromUserId) }">{{ userById[h.fromUserId]?.avatar || '?' }}</span>
              {{ userName(h.fromUserId) }}
              <span class="arrow">→</span>
              <span class="succ-list">
                <span v-for="g in groupsOf(h)" :key="g.userId" class="succ">
                  <span class="ava sm" :style="{ background: avatarColor(g.userId) }">{{ userById[g.userId]?.avatar || '?' }}</span>
                  {{ userName(g.userId) }}<em v-if="g.count > 1"> ×{{ g.count }}</em>
                </span>
              </span>
            </span>
            <span class="ho-count">{{ h.docIds.length }} 篇文档</span>
          </div>
          <div class="ho-side">
            <span class="st" :class="handoverStatusCls(h.status)">{{ handoverStatusLabel(h.status) }}</span>
            <span class="ho-time">{{ formatDate(h.createdAt) }}</span>
          </div>
        </div>

        <!-- 分批进度 -->
        <div class="progress">
          <span class="pg">共 {{ handoverProgress(h).total }} 篇</span>
          <span v-if="handoverProgress(h).pendingConfirm" class="pg pg-pc">待确认 {{ handoverProgress(h).pendingConfirm }}</span>
          <span v-if="handoverProgress(h).pendingApproval" class="pg pg-pa">待批准 {{ handoverProgress(h).pendingApproval }}</span>
          <span v-if="handoverProgress(h).completed" class="pg pg-ok">已完成 {{ handoverProgress(h).completed }}</span>
          <span v-if="handoverProgress(h).declined" class="pg pg-off">已谢绝 {{ handoverProgress(h).declined }}</span>
          <span v-if="handoverProgress(h).rejected" class="pg pg-no">已驳回 {{ handoverProgress(h).rejected }}</span>
          <span v-if="handoverProgress(h).failed" class="pg pg-fail">已回退 {{ handoverProgress(h).failed }}</span>
        </div>

        <div class="ho-docs">
          <div
            v-for="item in h.items"
            :key="item.docId"
            class="hd"
            :class="{ 'hd-mine': tab === 'confirm' && item.toUserId === auth.user?.id && item.status === 'pending_confirm' }"
          >
            <div class="hd-line">
              <!-- 管理员分批批准勾选 -->
              <input
                v-if="tab === 'approve' && item.status === 'pending_approval'"
                type="checkbox"
                class="hd-check"
                :checked="isApproveChecked(h, item.docId)"
                @change="toggleApprove(h, item.docId)"
              />
              <span class="hd-title" @click="docById[item.docId] && router.push('/docs/' + item.docId)">
                {{ docById[item.docId]?.title || item.title }}
              </span>
              <DocPill v-if="docById[item.docId]" :doc="docById[item.docId]" />
              <span class="hd-to">
                <span class="ava xs" :style="{ background: avatarColor(item.toUserId) }">{{ userById[item.toUserId]?.avatar || '?' }}</span>
                {{ userName(item.toUserId) }}
              </span>
              <span class="st smst" :class="handoverItemStatusCls(item.status)">{{ handoverItemStatusLabel(item.status) }}</span>
            </div>
            <div v-if="item.result" class="hd-result">✅ {{ itemResultText(item) }}</div>
            <div v-if="item.failReason" class="hd-fail">⚠ {{ item.failReason }}</div>
          </div>
        </div>

        <div class="ho-info">
          <span class="dim">{{ revokeModeLabel(h.revokeMode) }}</span>
          <span v-if="h.decidedAt" class="dim">{{ userName(h.decidedBy) }} 于 {{ formatDate(h.decidedAt) }} 最近处理</span>
        </div>

        <p v-if="h.note" class="note">交接说明：“{{ h.note }}”</p>

        <!-- 接任者确认 / 谢绝（仅对分配给我的待确认文档）-->
        <div v-if="canRespondHandover(h, auth.user?.id) && myPendingItems(h).length" class="decide-box">
          <span class="my-todo">你有 {{ myPendingItems(h).length }} 篇待回应：
            {{ myPendingItems(h).map((it) => '《' + (docById[it.docId]?.title || it.title) + '》').join('、') }}
          </span>
          <input v-model="noteMap[h.id]" class="note-in" placeholder="备注（可选，谢绝时将写入交接记录）" />
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === h.id" @click="respond(h, 'decline')">✕ 谢绝这 {{ myPendingItems(h).length }} 篇</button>
            <button class="btn sm ok-solid" :disabled="busyId === h.id" @click="respond(h, 'confirm')">✓ 确认接收这 {{ myPendingItems(h).length }} 篇</button>
          </div>
        </div>

        <!-- 管理员分批批准 / 驳回 -->
        <div v-if="canDecideHandover(h, auth.user?.id, auth.user?.role)" class="decide-box">
          <label class="sel-all"><input type="checkbox" :checked="allApproveChecked(h)" @change="toggleApproveAll(h)" /> 全选待批准文档</label>
          <input v-model="noteMap[h.id]" class="note-in" placeholder="审批备注（可选，将写入交接记录）" />
          <div class="decide-actions">
            <button class="btn sm" :disabled="busyId === h.id" @click="decide(h, 'reject')">✕ 驳回所选</button>
            <button class="btn sm ok-solid" :disabled="busyId === h.id" @click="decide(h, 'approve')">✓ 分批批准并转移所选</button>
          </div>
        </div>

        <!-- 发起人 / 管理员整批取消 -->
        <div v-if="canCancelHandover(h, auth.user?.id, auth.user?.role)" class="row-actions">
          <button class="btn sm ghost" @click="cancel(h)">整批取消交接</button>
        </div>

        <details class="timeline">
          <summary>查看交接记录（{{ (h.timeline || []).length }}）</summary>
          <div v-for="(t, i) in h.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ handoverTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ho-page { max-width: 960px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.head-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }

.create { margin-top: 16px; padding: 16px 20px; }
.c-title { font-weight: 700; font-size: 14px; }
.c-hint { color: var(--text-3); font-size: 12px; margin: 6px 0 12px; }
.c-empty { color: var(--text-3); font-size: 13px; padding: 12px 0; }
.doc-pick { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.dp { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.dp:hover { background: var(--primary-weak); }
.dp.disabled { opacity: 0.55; cursor: not-allowed; }
.dp-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-sel { border: 1px solid var(--primary); border-radius: 6px; padding: 4px 6px; font-size: 12px; background: #fff; max-width: 200px; }
.dp-tag { font-size: 11px; color: #b45309; background: #fef3c7; border-radius: 999px; padding: 1px 8px; }
.c-form { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; }
.f-item { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; }
.f-k { color: var(--text-2); }
.f-sel { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: #fff; }
.f-radios { display: inline-flex; gap: 12px; font-size: 13px; color: var(--text-2); }
.f-note { flex: 1; min-width: 220px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.f-note:focus { border-color: var(--primary); }
.c-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

.ho-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ho { padding: 16px 20px; }
.ho-top { display: flex; justify-content: space-between; gap: 14px; }
.ho-main { min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ho-users { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; font-size: 15px; flex-wrap: wrap; }
.ho-users .arrow { color: var(--text-3); font-weight: 400; }
.succ-list { display: inline-flex; gap: 8px; flex-wrap: wrap; }
.succ { display: inline-flex; align-items: center; gap: 4px; font-weight: 600; font-size: 13px; }
.succ em { font-style: normal; color: var(--text-3); font-size: 11px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.ava.sm { width: 18px; height: 18px; font-size: 9px; }
.ava.xs { width: 16px; height: 16px; font-size: 8px; }
.ho-count { font-size: 12px; color: var(--primary); background: var(--primary-weak); border-radius: 999px; padding: 1px 9px; }
.ho-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.st.smst { padding: 1px 8px; font-size: 11px; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-wait { background: var(--primary-weak); color: var(--primary); }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-fail { background: #ffe9ea; color: var(--danger); }
.ho-time { color: var(--text-3); font-size: 12px; }

.progress { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.pg { font-size: 12px; border-radius: 999px; padding: 1px 9px; background: var(--panel-2); color: var(--text-3); }
.pg-pc { background: #fef3c7; color: #b45309; }
.pg-pa { background: var(--primary-weak); color: var(--primary); }
.pg-ok { background: #dcfce7; color: #15803d; }
.pg-off { background: var(--panel-2); color: var(--text-3); }
.pg-no { background: #fee2e2; color: #b91c1c; }
.pg-fail { background: #ffe9ea; color: var(--danger); }

.ho-docs { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.hd { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--panel-2); }
.hd-mine { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary) inset; }
.hd-line { display: flex; align-items: center; gap: 10px; }
.hd-check { margin: 0; }
.hd-title { font-weight: 600; font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hd-title:hover { color: var(--primary); }
.hd-to { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-2); white-space: nowrap; }
.hd-result { margin-top: 4px; font-size: 12px; color: #15803d; }
.hd-fail { margin-top: 4px; font-size: 12px; color: #b91c1c; }

.ho-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; }
.dim { color: var(--text-3); font-size: 12px; }
.note { margin: 8px 0 0; font-size: 13px; color: var(--text-2); }

.decide-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.my-todo { width: 100%; font-size: 13px; color: var(--primary); font-weight: 600; }
.sel-all { font-size: 13px; color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.note-in { flex: 1; min-width: 200px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; outline: none; }
.note-in:focus { border-color: var(--primary); }
.decide-actions { display: flex; gap: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.row-actions { margin-top: 10px; }

.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 170px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
