// Pure classification. Every input path must already be canonicalized by the collector.
const parentKey = 'paseo.parent-agent-id';
const continuationKeys = ['zerosub.continued-from', 'handoff.from', 'agent-list.continued-from'];
const waiting = ['active', 'waiting_user', 'waiting_work', 'waiting_schedule'];
export const within = (path, root) => Boolean(path && root && (path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)));
const overlaps = (a, b) => within(a, b) || within(b, a);
export function ageHours(time, now) {
  const value = Date.parse(time), current = Date.parse(now);
  return Number.isFinite(value) && Number.isFinite(current) ? (current - value) / 3600000 : null;
}
function scopedGap(gap) {
  // Source-specific data failures are already represented on the affected entity.
  if (['excerpt', 'git', 'gh'].includes(gap.domain ?? gap.source)) return false;
  return true;
}
function gapAffects(gap, { id, path, workspaceId, memberIds = [] }) {
  const scope = gap.scope;
  if (!scope || !(scope.agentIds?.length || scope.paths?.length || scope.workspaceIds?.length)) return true;
  return scope.agentIds?.includes(id) || scope.workspaceIds?.includes(id) || scope.workspaceIds?.includes(workspaceId) || memberIds.some(member => scope.agentIds?.includes(member)) || scope.paths?.some(p => overlaps(path, p));
}
export const minWorkspacePrefixLength = 4;
export function protectionContext(snapshot) {
  const workspaces = new Map((snapshot.workspaces ?? []).map(w => [w.workspaceId, w]));
  const aliases = new Map(), generatedGaps = [];
  const resolve = reference => {
    if (workspaces.has(reference)) return workspaces.get(reference);
    if (typeof reference !== 'string' || !reference.startsWith('wks_') || reference.length < 4 + minWorkspacePrefixLength) return null;
    const matches = [...workspaces.keys()].filter(id => id.startsWith(reference));
    return matches.length === 1 ? workspaces.get(matches[0]) : null;
  };
  const supervisors = (snapshot.supervisors ?? []).map(record => {
    const paths = new Set(record.paths ?? []), workspaceIds = new Set();
    const workspaceRefs = record.workspaceRefs ?? record.workspaceIds ?? [];
    for (const reference of workspaceRefs) {
      const workspace = resolve(reference);
      const id = workspace?.workspaceId ?? reference;
      workspaceIds.add(id);
      if (workspace) aliases.set(reference, id);
      const candidates = workspace ? [workspace.cwd, workspace.worktreeRoot].filter(value => value !== undefined && value !== null) : [];
      if (!candidates.length || candidates.some(value => typeof value !== 'string' || !value.startsWith('/') || value.includes('\0'))) {
        generatedGaps.push({ domain: 'protection', source: `supervisor:${record.directory}`, reason: 'supervisor_workspace_unresolved', workspaceId: reference });
      }
      for (const path of candidates) if (typeof path === 'string' && path.startsWith('/') && !path.includes('\0')) paths.add(path);
    }
    return { ...record, workspaceRefs, workspaceIds: [...workspaceIds], paths: [...paths] };
  });
  const observedGaps = (snapshot.meta?.gaps ?? []).map(gap => gap.scope?.workspaceIds ? { ...gap, scope: { ...gap.scope, workspaceIds: gap.scope.workspaceIds.map(id => aliases.get(id) ?? id) } } : gap);
  const gaps = [...new Map([...observedGaps, ...generatedGaps].map(gap => [JSON.stringify(gap), gap])).values()].filter(scopedGap);
  return { supervisors, generatedGaps, gaps };
}
export function scanSummary(snapshot) {
  const active = (snapshot.agents ?? []).filter(a => !a.archivedAt);
  const live = active.filter(a => a.statusSource === 'live').length;
  const paths = new Map();
  for (const entity of [...(snapshot.workspaces ?? []).filter(w => !w.archivedAt), ...(snapshot.orphans ?? [])]) {
    const path = entity.cwd ?? entity.path, rawState = entity.checks?.terminals, state = ['confirmed_none', 'present', 'unchecked'].includes(rawState) ? rawState : 'unchecked';
    const previous = paths.get(path), rank = { confirmed_none: 0, present: 1, unchecked: 2 };
    if (previous === undefined || (rank[state] ?? 2) > (rank[previous] ?? 2)) paths.set(path, state);
  }
  const terminals = { total: paths.size, confirmed_none: 0, present: 0, unchecked: 0 };
  for (const state of paths.values()) terminals[state]++;
  const globalBlockers = {};
  for (const gap of protectionContext(snapshot).gaps) if (!gap.scope || !(gap.scope.agentIds?.length || gap.scope.workspaceIds?.length || gap.scope.paths?.length)) globalBlockers[gap.reason ?? 'unknown'] = (globalBlockers[gap.reason ?? 'unknown'] ?? 0) + 1;
  return { live: { activeTotal: active.length, observed: live, storedFallback: active.length - live }, terminals, globalBlockers };
}
export function classify(snapshot, { now = snapshot.meta?.collectedAt, minAgeHours = 72, selfAgentId, selfCwd } = {}) {
  const agents = snapshot.agents ?? [], byId = new Map(agents.map(a => [a.id, a]));
  const result = { agents: [], workspaces: [], orphans: [] }, records = new Map();
  const { supervisors, gaps: protectionGaps } = protectionContext(snapshot);
  const make = (id, age = null) => ({ id, work: 'unknown', hold: [], verdict: 'review', reasons: [], ageHours: age, remainingChecks: [] });
  let changed = false;
  const hold = (r, kind, reason) => {
    if (!r.hold.includes(kind)) { r.hold.push(kind); changed = true; }
    if (!r.reasons.includes(reason)) { r.reasons.push(reason); changed = true; }
  };
  const waitingForWork = r => {
    if (!waiting.includes(r.work) && !r.reasons.includes('ambiguous continuation graph')) { r.work = 'waiting_work'; changed = true; }
  };
  const protectedRecord = (a, r) => waiting.includes(r.work) || r.hold.some(h => ['self', 'recent', 'active_lane', 'schedule_dependency', 'supervisor_scope'].includes(h)) || r.reasons.some(reason => reason.startsWith('protection_gap:')) || (!a.archivedAt && r.work === 'unknown');
  const applyGaps = (r, entity) => {
    for (const gap of protectionGaps) if (gapAffects(gap, entity)) {
      hold(r, 'data', `protection_gap:${gap.reason ?? 'unknown'}`);
      if (r.work === 'candidate') r.work = 'unknown';
    }
  };
  const self = new Set(selfAgentId ? [selfAgentId] : []), seen = new Set();
  let cursor = selfAgentId;
  while (cursor && !seen.has(cursor)) { seen.add(cursor); self.add(cursor); cursor = byId.get(cursor)?.labels?.[parentKey]; }
  const descendants = new Set(selfAgentId ? [selfAgentId] : []);
  for (let expanded = true; expanded;) {
    expanded = false;
    for (const a of agents) if (descendants.has(a.labels?.[parentKey]) && !descendants.has(a.id)) { descendants.add(a.id); self.add(a.id); expanded = true; }
  }
  for (const a of agents) {
    const age = ageHours(a.lastUserMessageAt ?? a.lastActivityAt, now), activityAge = ageHours(a.lastActivityAt, now);
    const r = make(a.id, age), status = a.status ?? a.lastStatus;
    records.set(a.id, r); result.agents.push(r);
    r.work = ['running', 'initializing'].includes(status) ? 'active' : status === 'closed' ? 'candidate' : 'unknown';
    if (a.statusSource === 'store' && protectionGaps.some(g => g.reason === 'live_missing' && g.scope?.agentIds?.includes(a.id))) r.work = 'unknown';
    r.reasons.push(`status:${status ?? 'missing'} (${a.statusSource ?? 'store'})`);
    if (a.pendingCount > 0) r.work = 'waiting_user';
    r.recentActivityOnly = age !== null && age >= minAgeHours && activityAge !== null && activityAge < minAgeHours;
    if (self.has(a.id) || within(a.cwd, selfCwd)) hold(r, 'self', 'current cleanup scope');
    if (age === null || age < minAgeHours || (activityAge !== null && activityAge < minAgeHours)) hold(r, 'recent', 'recent or unknown activity time');
    if (a.archivedAt) r.reasons.push('historical record; not a cleanup target');
  }
  const schedules = (snapshot.schedules ?? []).filter(s => ['active', 'paused'].includes(s.status));
  for (const s of schedules) if (s.target?.type === 'agent' && records.has(s.target.agentId)) {
    const r = records.get(s.target.agentId);
    if (!['active', 'waiting_user'].includes(r.work)) r.work = 'waiting_schedule';
    hold(r, 'schedule_dependency', `heartbeat:${s.id}`);
  }
  for (const scope of supervisors) {
    const unknownOwner = !scope.ownerIds?.length;
    if (unknownOwner || scope.ownerIds.some(id => byId.has(id) && !byId.get(id).archivedAt)) {
      for (const id of new Set([...(scope.agentIds ?? []), ...(scope.ownerIds ?? [])])) if (records.has(id)) hold(records.get(id), 'supervisor_scope', `${unknownOwner ? 'unresolved owner' : 'supervisor record'}:${scope.directory}`);
    }
  }
  const successors = new Map(), predecessors = new Map();
  for (const a of agents) for (const old of new Set(continuationKeys.map(k => a.labels?.[k]).filter(Boolean))) {
    if (!successors.has(old)) successors.set(old, new Set()); successors.get(old).add(a.id);
    if (!predecessors.has(a.id)) predecessors.set(a.id, new Set()); predecessors.get(a.id).add(old);
  }
  const components = [], visited = new Set();
  for (const start of new Set([...successors.keys(), ...predecessors.keys()])) {
    if (visited.has(start)) continue;
    const ids = new Set(), queue = [start];
    while (queue.length) { const id = queue.pop(); if (ids.has(id)) continue; ids.add(id); visited.add(id); queue.push(...(successors.get(id) ?? []), ...(predecessors.get(id) ?? [])); }
    const leaves = [...ids].filter(id => !successors.get(id)?.size);
    const ambiguous = leaves.length !== 1 || [...ids].some(id => (successors.get(id)?.size ?? 0) > 1 || (predecessors.get(id)?.size ?? 0) > 1 || !byId.has(id));
    components.push({ ids, latestId: leaves[0], ambiguous });
    if (ambiguous) for (const id of ids) if (records.has(id)) { records.get(id).work = 'unknown'; hold(records.get(id), 'active_lane', 'ambiguous continuation graph'); }
  }
  // Seed evidence gaps before the fixed point so their protection also crosses relations.
  for (const a of agents) applyGaps(records.get(a.id), { id: a.id, path: a.cwd, workspaceId: a.workspaceId });
  // All protection relations share one monotonic fixed point, including historical nodes.
  do {
    changed = false;
    for (const edge of snapshot.subscriptions ?? []) for (const id of [edge.callerAgentId, edge.childAgentId]) if (records.has(id)) {
      const r = records.get(id); hold(r, 'active_lane', `finish-subscription:${edge.callerAgentId}->${edge.childAgentId}`); waitingForWork(r);
    }
    for (const a of agents) {
      const r = records.get(a.id), p = records.get(a.labels?.[parentKey]);
      if (p && protectedRecord(a, r)) { hold(p, 'active_lane', `protected descendant:${a.id}`); waitingForWork(p); }
    }
    for (const component of components) {
      if (component.ambiguous) continue;
      const latest = records.get(component.latestId), agent = byId.get(component.latestId);
      if (protectedRecord(agent, latest) || latest.work !== 'candidate') for (const id of component.ids) if (id !== component.latestId && records.has(id)) {
        const r = records.get(id); hold(r, 'active_lane', `unfinished successor:${component.latestId}`); waitingForWork(r);
      }
    }
  } while (changed);
  for (const a of agents) {
    const r = records.get(a.id);
    r.verdict = a.archivedAt || waiting.includes(r.work) || r.hold.some(h => ['self', 'recent', 'active_lane', 'schedule_dependency'].includes(h)) ? 'exclude' : 'review';
    r.remainingChecks.push('completion_evidence');
    if (!r.hold.length) r.hold.push('none');
  }
  const dataChecks = (r, git) => {
    if (git?.ignoredCount > 0) { hold(r, 'data', 'ignored_present'); r.remainingChecks.push('ignored_reproducibility'); }
    if (!git || git.kind !== 'git' || git.errors?.length) hold(r, 'data', 'git information unavailable or incomplete');
    if (git?.dirtyCount || git?.untrackedCount) hold(r, 'data', 'uncommitted or untracked files');
    if (git?.prs?.some(p => p.state === 'OPEN')) hold(r, 'data', 'open pull request');
    const ownRef = git?.branch ? `refs/heads/${git.branch}` : null;
    const surviving = git?.reachableRefs?.filter(ref => ref !== ownRef) ?? [];
    const preserved = git?.mergedIntoDefault || git?.prs?.some(p => p.state === 'MERGED' && p.headRefOid === git.head) || (git?.detached && surviving.length > 0);
    if (!preserved) hold(r, 'data', 'HEAD preservation not proven');
    if (git?.locked || git?.prunable) hold(r, 'data', 'worktree locked or registration marked stale');
  };
  const observationChecks = (r, entity, local = false) => {
    for (const key of ['terminals', 'prs']) {
      const state = local && key === 'prs' ? 'confirmed_none' : entity.checks?.[key] ?? (key === 'prs' ? entity.git?.prCheck : null) ?? 'unchecked';
      if (state !== 'confirmed_none') hold(r, 'data', `${key}:${state}`);
    }
    for (const key of ['processes', 'scripts', 'teardown']) {
      const state = entity.checks?.[key] ?? 'unchecked';
      if (key !== 'teardown' && state === 'present') hold(r, 'data', `${key}:present`);
      if (state !== 'confirmed_none') r.remainingChecks.push(key === 'teardown' ? `teardown_impact${entity.definitions?.teardown ? ':defined' : ''}` : key === 'scripts' ? `script_runtime${entity.definitions?.scripts?.length ? ':defined' : ''}` : 'process_usage');
    }
  };
  const root = a => { const ids = new Set(); while (byId.has(a.labels?.[parentKey]) && !ids.has(a.id)) { ids.add(a.id); a = byId.get(a.labels[parentKey]); } return a.id; };
  for (const w of snapshot.workspaces ?? []) {
    const r = make(w.workspaceId), members = agents.filter(a => a.workspaceId === w.workspaceId), active = members.filter(a => !a.archivedAt);
    result.workspaces.push(r);
    if (overlaps(w.cwd, selfCwd) || members.some(a => records.get(a.id).hold.includes('self'))) hold(r, 'self', 'current cleanup workspace');
    if (members.some(a => {
      const record = records.get(a.id);
      const signals = waiting.includes(record.work) || record.hold.some(h => ['self', 'recent', 'active_lane', 'schedule_dependency', 'supervisor_scope'].includes(h));
      return signals || (!a.archivedAt && record.work === 'unknown' && !record.reasons.some(reason => reason.startsWith('protection_gap:')));
    })) hold(r, 'active_lane', 'member requires protection');
    if (active.length >= 15 || new Set(active.map(root)).size > 1) hold(r, 'hub', 'multiple independent lanes or at least 15 members');
    if (schedules.some(s => s.target?.type === 'new-agent' && overlaps(s.cwd, w.cwd))) hold(r, 'schedule_dependency', 'scheduled working directory');
    if ((snapshot.workspaces ?? []).some(other => other.workspaceId !== w.workspaceId && !other.archivedAt && overlaps(other.cwd, w.cwd))) hold(r, 'active_lane', 'overlapping active workspace path');
    if (agents.some(a => !a.archivedAt && a.workspaceId !== w.workspaceId && within(a.cwd, w.cwd))) hold(r, 'active_lane', 'external agent uses workspace path');
    if (supervisors.some(s => s.workspaceIds?.includes(w.workspaceId) || s.paths?.some(p => overlaps(p, w.cwd)))) hold(r, 'supervisor_scope', 'workspace path referenced by supervisor record');
    const local = w.kind !== 'worktree';
    if (!local) dataChecks(r, w.git);
    else { r.deleteDirectory = false; r.reasons.push('local directory remains'); }
    observationChecks(r, w, local);
    r.work = r.hold.length ? 'unknown' : 'candidate';
    applyGaps(r, { id: w.workspaceId, path: w.cwd, memberIds: members.map(a => a.id) });
    r.verdict = w.archivedAt || r.hold.some(h => ['self', 'active_lane', 'hub', 'schedule_dependency'].includes(h)) ? 'exclude' : r.hold.length || active.some(a => records.get(a.id).verdict === 'review') ? 'review' : 'batch_candidate';
    if (w.archivedAt) r.reasons.push('historical workspace');
    if (!r.hold.length) r.hold.push('none');
  }
  for (const o of snapshot.orphans ?? []) {
    const r = make(o.path, ageHours(o.modifiedAt, now)); result.orphans.push(r);
    dataChecks(r, o.git); observationChecks(r, o);
    if (!o.git || o.git.kind !== 'git') { r.listOnly = true; r.reasons.push('list_only: nonstandard directory'); }
    if (!o.git?.registered) hold(r, 'data', 'not registered with owning repository');
    if (overlaps(o.path, selfCwd)) hold(r, 'self', 'current cleanup directory');
    if (agents.some(a => !a.archivedAt && within(a.cwd, o.path))) hold(r, 'active_lane', 'agent working directory inside path');
    if (supervisors.some(s => s.paths?.some(p => overlaps(p, o.path)))) hold(r, 'supervisor_scope', 'referenced by supervisor record');
    if (schedules.some(s => overlaps(s.cwd, o.path))) hold(r, 'schedule_dependency', 'scheduled working directory');
    if (r.ageHours === null) hold(r, 'data', 'unknown directory modification time');
    else if (r.ageHours < minAgeHours) hold(r, 'recent', 'recent directory modification');
    r.work = r.hold.length ? 'unknown' : 'candidate';
    applyGaps(r, { path: o.path });
    r.verdict = r.hold.some(h => ['self', 'active_lane', 'schedule_dependency', 'recent'].includes(h)) ? 'exclude' : r.hold.length ? 'review' : 'batch_candidate';
    if (r.listOnly) r.verdict = 'review';
    if (!r.hold.length) r.hold.push('none');
  }
  return result;
}
