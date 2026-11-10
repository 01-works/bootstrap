import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify } from './classify.mjs';
const base = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
const a = (id, extra = {}) => ({ ...structuredClone(base.fixtureAgent), id, ...extra });
const w = (extra = {}) => ({ workspaceId: 'wks_fake', cwd: '/fake/worktrees/project/lane', kind: 'worktree', isPaseoOwnedWorktree: true, worktreeRoot: extra.cwd ?? '/fake/worktrees/project/lane', mainRepoRoot: '/fake/main', createdAt: '2026-01-01', updatedAt: '2026-01-01', checks: structuredClone(base.fixtureChecks), git: structuredClone(base.fixtureGit), ...extra });
const o = (extra = {}) => ({ path: '/fake/worktrees/project/orphan', mtime: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z', checks: structuredClone(base.fixtureChecks), git: structuredClone(base.fixtureGit), ...extra });
const scan = (data = {}, options = {}) => classify({ ...structuredClone(base), ...data }, options);
const record = (result, id) => result.agents.find(r => r.id === id);

test('pure classification does not mutate snapshot; self idle finished, ancestors and descendants excluded', () => {
  const data = { ...base, agents: [a('self', { lastStatus: 'idle', attentionReason: 'finished', labels: { 'paseo.parent-agent-id': 'ancestor' } }), a('child', { labels: { 'paseo.parent-agent-id': 'self' } }), a('ancestor')] };
  const before = structuredClone(data); const r = classify(data, { selfAgentId: 'self' });
  for (const x of r.agents) { assert.equal(x.verdict, 'exclude'); assert.ok(x.hold.includes('self')); }
  assert.deepEqual(data, before);
});
test('self cwd containment is component aware', () => {
  const r = scan({ agents: [a('inside', { cwd: '/fake/lane/nested' }), a('other', { cwd: '/fake/lane-other' })] }, { selfCwd: '/fake/lane' });
  assert.ok(record(r, 'inside').hold.includes('self')); assert.ok(!record(r, 'other').hold.includes('self'));
});
test('idle and historical pending both wait for user; historical pending blocks workspace', () => {
  const r = scan({ agents: [a('idle', { lastStatus: 'idle', pendingCount: 1 }), a('historical', { archivedAt: '2026-01-02', pendingCount: 1 })], workspaces: [w()] });
  assert.equal(record(r, 'idle').work, 'waiting_user'); assert.equal(record(r, 'historical').work, 'waiting_user'); assert.ok(r.workspaces[0].hold.includes('active_lane'));
});
test('cross-workspace running child protects all idle ancestors', () => {
  const r = scan({ agents: [a('parent', { lastStatus: 'idle', labels: { 'paseo.parent-agent-id': 'root' } }), a('root'), a('child', { workspaceId: 'elsewhere', lastStatus: 'running', labels: { 'paseo.parent-agent-id': 'parent' } })], workspaces: [w()] });
  assert.equal(record(r, 'parent').work, 'waiting_work'); assert.equal(record(r, 'root').work, 'waiting_work'); assert.ok(r.workspaces[0].hold.includes('active_lane'));
});
test('finish subscription protects both parties without parent labels', () => {
  const r = scan({ agents: [a('caller'), a('child')], subscriptions: [{ callerAgentId: 'caller', childAgentId: 'child' }] });
  for (const x of r.agents) { assert.equal(x.work, 'waiting_work'); assert.equal(x.verdict, 'exclude'); }
});
for (const status of ['active', 'paused']) test(`${status} heartbeat keeps idle target waiting`, () => {
  const r = scan({ agents: [a('target', { lastStatus: 'idle' })], schedules: [{ id: 'heartbeat', status, target: { type: 'agent', agentId: 'target' } }] });
  assert.equal(r.agents[0].work, 'waiting_schedule');
});
test('continuation protects old sessions while latest unfinished; branch and cycle unknown', () => {
  const r = scan({ agents: [a('old'), a('middle', { labels: { 'handoff.from': 'old' } }), a('latest', { lastStatus: 'idle', labels: { 'zerosub.continued-from': 'middle' } })] });
  assert.equal(record(r, 'old').verdict, 'exclude'); assert.equal(record(r, 'middle').verdict, 'exclude');
  const branch = scan({ agents: [a('old'), a('one', { labels: { 'handoff.from': 'old' } }), a('two', { labels: { 'agent-list.continued-from': 'old' } })] });
  assert.ok(branch.agents.every(x => x.work === 'unknown'));
  const cycle = scan({ agents: [a('one', { labels: { 'handoff.from': 'two' } }), a('two', { labels: { 'handoff.from': 'one' } })] });
  assert.ok(cycle.agents.every(x => x.work === 'unknown'));
});
test('recent closed and missing timestamp excluded; old closed leaf only review', () => {
  const r = scan({ agents: [a('recent', { lastUserMessageAt: '2026-01-10T01:00:00Z' }), a('missing', { lastActivityAt: null }), a('old'), a('new-result', { lastUserMessageAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-10T01:00:00Z' })] });
  for (const id of ['recent', 'missing', 'new-result']) { assert.equal(record(r, id).verdict, 'exclude'); assert.ok(record(r, id).hold.includes('recent')); }
  assert.equal(record(r, 'old').work, 'candidate'); assert.equal(record(r, 'old').verdict, 'review');
});
test('active supervisor record protects mentioned candidates', () => {
  const r = scan({ agents: [a('owner'), a('member')], supervisors: [{ directory: 'fake-chief', ownerIds: ['owner'], agentIds: ['member'] }], workspaces: [w()] });
  assert.ok(record(r, 'member').hold.includes('supervisor_scope')); assert.equal(record(r, 'member').verdict, 'review'); assert.ok(r.workspaces[0].hold.includes('active_lane'));
});
test('empty integrated clean workspace candidate; member reviews prevent batch', () => {
  assert.equal(scan({ workspaces: [w()] }).workspaces[0].verdict, 'batch_candidate');
  assert.equal(scan({ agents: [a('member')], workspaces: [w()] }).workspaces[0].verdict, 'review');
});
for (const git of [{ dirtyCount: 1 }, { untrackedCount: 1 }, { prs: [{ state: 'OPEN', headRefOid: 'abcdef1234' }] }, { mergedIntoDefault: false, prs: [{ state: 'MERGED', headRefOid: 'different' }] }, { errors: [{ command: 'status', code: 'exit:1' }] }]) test(`workspace data hold ${JSON.stringify(git)}`, () => {
  const r = scan({ workspaces: [w({ git: { ...base.fixtureGit, ...git } })] }).workspaces[0]; assert.ok(r.hold.includes('data')); assert.equal(r.verdict, 'review');
});
test('workspace schedule, hub, local directory retention', () => {
  const scheduled = scan({ workspaces: [w()], schedules: [{ id: 'schedule', status: 'active', target: { type: 'new-agent' }, cwd: '/fake/worktrees/project/lane/sub' }] }); assert.ok(scheduled.workspaces[0].hold.includes('schedule_dependency'));
  const hub = scan({ workspaces: [w()], agents: Array.from({ length: 15 }, (_, i) => a(`member-${i}`)) }); assert.ok(hub.workspaces[0].hold.includes('hub'));
  const roots = scan({ workspaces: [w()], agents: [a('a'), a('b')] }); assert.ok(roots.workspaces[0].hold.includes('hub'));
  const local = scan({ workspaces: [w({ kind: 'local_directory', isPaseoOwnedWorktree: false })] }); assert.equal(local.workspaces[0].deleteDirectory, false);
});
test('orphan abnormal directories list only; registered clean integrated candidate', () => {
  for (const kind of ['broken', 'non-git', 'nested']) { const r = scan({ orphans: [o({ git: { kind } })] }).orphans[0]; assert.equal(r.verdict, 'review'); assert.equal(r.listOnly, true); }
  const r = scan({ orphans: [o({ git: { ...base.fixtureGit, mergedIntoDefault: false, prs: [{ state: 'MERGED', headRefOid: 'abcdef1234' }] } })] }); assert.equal(r.orphans[0].verdict, 'batch_candidate');
});
test('orphan agent child cwd, tasks reference, schedule, recent mtime protect', () => {
  for (const data of [{ agents: [a('user', { cwd: '/fake/worktrees/project/orphan/sub' })] }, { supervisors: [{ paths: ['/fake/worktrees/project/orphan'] }] }, { schedules: [{ status: 'active', cwd: '/fake/worktrees/project/orphan', target: { type: 'new-agent' } }] }]) assert.equal(scan({ orphans: [o()], ...data }).orphans[0].verdict, data.supervisors ? 'review' : 'exclude');
  assert.equal(scan({ orphans: [o({ modifiedAt: '2026-01-10T10:00:00Z' })] }).orphans[0].verdict, 'exclude');
});
test('orphan unregistered locked or detached without retained ref requires review', () => {
  for (const patch of [{ registered: false }, { locked: true }, { detached: true, mergedIntoDefault: false, reachableRefs: [] }]) assert.equal(scan({ orphans: [o({ git: { ...base.fixtureGit, ...patch } })] }).orphans[0].verdict, 'review');
  assert.equal(scan({ orphans: [o({ git: { ...base.fixtureGit, detached: true, reachableRefs: ['refs/remotes/origin/main'] } })] }).orphans[0].verdict, 'batch_candidate');
});

test('ignored paths always require review for owned workspace and orphan', () => {
  const git = { ...base.fixtureGit, ignoredCount: 1, ignoredPaths: ['cache/'] };
  const r = scan({ workspaces: [w({ isPaseoOwnedWorktree: true, git })], orphans: [o({ git })] });
  for (const x of [r.workspaces[0], r.orphans[0]]) { assert.equal(x.verdict, 'review'); assert.ok(x.hold.includes('data')); assert.ok(x.reasons.includes('ignored_present')); }
});
test('workspace detached HEAD requires a surviving branch or tag', () => {
  const git = { ...base.fixtureGit, detached: true, reachableRefs: [] };
  assert.equal(scan({ workspaces: [w({ git: { ...git, mergedIntoDefault: false } })] }).workspaces[0].verdict, 'review');
  assert.equal(scan({ workspaces: [w({ git: { ...git, reachableRefs: ['refs/tags/keep'] } })] }).workspaces[0].verdict, 'batch_candidate');
});
test('archived active or waiting members hold workspace', () => {
  for (const extra of [{ lastStatus: 'running' }, { pendingCount: 1 }, { lastStatus: 'initializing' }]) {
    const r = scan({ workspaces: [w()], agents: [a('history', { archivedAt: '2026-01-02', ...extra })] }); assert.ok(r.workspaces[0].hold.includes('active_lane')); assert.equal(r.workspaces[0].verdict, 'exclude');
  }
});
test('workspace overlapping paths, external agent and supervisor path references hold', () => {
  const cases = [
    { workspaces: [w(), w({ workspaceId: 'other', cwd: '/fake/worktrees/project/lane/sub' })] },
    { agents: [a('external', { workspaceId: 'other', cwd: '/fake/worktrees/project/lane/sub' })] },
    { supervisors: [{ paths: ['/fake/worktrees/project/lane/sub'] }] },
  ];
  for (const data of cases) { const r = scan({ workspaces: [w()], ...data }); assert.equal(r.workspaces[0].verdict, data.supervisors ? 'review' : 'exclude'); }
});
test('local workspace does not require directory deletion Git checks', () => {
  assert.equal(scan({ workspaces: [w({ kind: 'local_directory', isPaseoOwnedWorktree: false, git: null })] }).workspaces[0].verdict, 'batch_candidate');
});
test('recent activity fallback marked separately from primary user-message age', () => {
  const r = scan({ agents: [a('restart', { lastUserMessageAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-10T00:00:00Z' })] });
  assert.equal(r.agents[0].recentActivityOnly, true); assert.equal(r.agents[0].verdict, 'exclude'); assert.ok(r.agents[0].hold.includes('recent'));
});
test('orphan unknown modification time is review, composite recent time excludes even with old root mtime', () => {
  assert.equal(scan({ orphans: [o({ modifiedAt: null })] }).orphans[0].verdict, 'review');
  assert.equal(scan({ orphans: [o({ mtime: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-10T10:00:00Z' })] }).orphans[0].verdict, 'exclude');
});
test('workspace parent directory contains self cwd and must be protected', () => {
  const r = scan({ workspaces: [w()] }, { selfCwd: '/fake/worktrees/project/lane/sub' }); assert.ok(r.workspaces[0].hold.includes('self')); assert.equal(r.workspaces[0].verdict, 'exclude');
});

// Review regressions: incomplete evidence may never become absence.
for (const source of ['agents/fake/record.json', 'finish-subscriptions.json', 'schedules/fake.json', 'projects/workspaces.json', '/fake/tasks.md', 'live']) test(`P1 protection gap blocks every unscoped candidate: ${source}`, () => {
  const r = scan({ meta: { ...base.meta, gaps: [{ source, reason: 'invalid-json' }] }, agents: [a('leaf')], workspaces: [w()], orphans: [o()] });
  assert.equal(r.agents[0].work, 'unknown');
  assert.equal(r.workspaces[0].verdict, 'review'); assert.equal(r.workspaces[0].work, 'unknown');
  assert.equal(r.orphans[0].verdict, 'review'); assert.ok(r.orphans[0].reasons.some(reason => reason.startsWith('protection_gap:')));
});
test('P1 scoped protection gap affects mentioned paths; excerpt gaps do not hide unrelated candidates', () => {
  const gaps = [{ domain: 'protection', source: 'tasks.md', reason: 'supervisor_owner_unknown', scope: { paths: ['/fake/worktrees/project/lane'] } }, { source: 'excerpt', reason: 'excerpt truncated' }];
  const r = scan({ meta: { ...base.meta, gaps }, workspaces: [w()], orphans: [o()] });
  assert.equal(r.workspaces[0].verdict, 'review'); assert.equal(r.orphans[0].verdict, 'batch_candidate');
});
for (const key of ['terminals', 'prs']) test(`P1 unchecked or present ${key} blocks workspace and orphan`, () => {
  for (const state of ['unchecked', 'present']) {
    const checks = { ...base.fixtureChecks, [key]: state };
    const r = scan({ workspaces: [w({ checks })], orphans: [o({ checks })] });
    assert.equal(r.workspaces[0].verdict, 'review'); assert.equal(r.orphans[0].verdict, 'review');
  }
});
test('P1 model-only checks remain explicit on batch candidates, including defined teardown and scripts', () => {
  const checks = { ...base.fixtureChecks, processes: 'unchecked', scripts: 'unchecked', teardown: 'present' };
  const definitions = { scripts: ['dev'], teardown: true };
  const r = scan({ workspaces: [w({ checks, definitions })], orphans: [o({ checks, definitions })] });
  for (const record of [r.workspaces[0], r.orphans[0]]) { assert.equal(record.verdict, 'batch_candidate'); assert.deepEqual(record.remainingChecks, ['process_usage', 'script_runtime:defined', 'teardown_impact:defined', ...(record === r.workspaces[0] ? ['workspace_owned_terminals'] : [])]); }
});
for (const signal of [{ lastStatus: 'running' }, { pendingCount: 1 }, { lastActivityAt: '2026-01-10T11:00:00Z' }]) test(`P1 historical child propagates protection: ${JSON.stringify(signal)}`, () => {
  const r = scan({ agents: [a('parent'), a('archived-child', { archivedAt: '2026-01-03', workspaceId: 'other', labels: { 'paseo.parent-agent-id': 'parent' }, ...signal })], workspaces: [w({ workspaceId: 'other' }), w()] });
  assert.equal(record(r, 'parent').work, 'waiting_work'); assert.equal(record(r, 'parent').verdict, 'exclude');
  assert.ok(r.workspaces.every(w => w.hold.includes('active_lane')));
});
test('P1 fixed point crosses archived old -> closed successor -> running child and finish subscription', () => {
  const data = { agents: [a('old', { archivedAt: '2026-01-02' }), a('successor', { workspaceId: 'other', labels: { 'handoff.from': 'old' } }), a('running-child', { lastStatus: 'running', workspaceId: 'other', labels: { 'paseo.parent-agent-id': 'successor' } }), a('subscriber', { workspaceId: 'third' })], subscriptions: [{ callerAgentId: 'subscriber', childAgentId: 'old' }], workspaces: [w()] };
  const r = scan(data); assert.equal(record(r, 'old').work, 'waiting_work'); assert.ok(record(r, 'old').reasons.includes('unfinished successor:successor')); assert.equal(r.workspaces[0].verdict, 'exclude');
  const permuted = scan({ ...data, agents: [...data.agents].reverse() });
  for (const x of r.agents) { const y = record(permuted, x.id); assert.equal(x.work, y.work); assert.equal(x.verdict, y.verdict); assert.deepEqual([...x.hold].sort(), [...y.hold].sort()); }
});
test('P2 detached retained tag is independent of default integration; target branch alone does not count', () => {
  const detached = { ...base.fixtureGit, mergedIntoDefault: false, detached: true, reachableRefs: ['refs/tags/retain'] };
  for (const entity of [scan({ orphans: [o({ git: detached })] }).orphans[0], scan({ workspaces: [w({ git: detached })] }).workspaces[0]]) assert.equal(entity.verdict, 'batch_candidate');
  const ownBranch = { ...detached, branch: 'target', reachableRefs: ['refs/heads/target'] };
  assert.equal(scan({ orphans: [o({ git: ownBranch })] }).orphans[0].verdict, 'review');
});
test('P2 ownerless record protects referenced agents and paths for review', () => {
  const r = scan({ agents: [a('mentioned')], supervisors: [{ directory: 'unknown-owner', ownerIds: [], agentIds: ['mentioned'], paths: ['/fake/worktrees/project/orphan'] }], orphans: [o()] });
  assert.equal(r.agents[0].verdict, 'review'); assert.ok(r.agents[0].hold.includes('supervisor_scope')); assert.equal(r.orphans[0].verdict, 'review');
});

test('R3 scoped gap seeds protection before ancestor and continuation fixed point, including archived source', () => {
  const gaps = [{ source: 'live', reason: 'live_missing', scope: { agentIds: ['leaf'] } }];
  const data = { meta: { ...base.meta, gaps }, agents: [a('old', { archivedAt: '2026-01-02' }), a('successor', { workspaceId: 'other', labels: { 'handoff.from': 'old' } }), a('leaf', { workspaceId: 'third', archivedAt: '2026-01-02', labels: { 'paseo.parent-agent-id': 'successor' } })], workspaces: [w()] };
  for (const agents of [data.agents, [...data.agents].reverse()]) {
    const r = scan({ ...data, agents }); assert.equal(record(r, 'leaf').work, 'unknown');
    assert.equal(record(r, 'successor').work, 'waiting_work'); assert.ok(record(r, 'old').reasons.includes('unfinished successor:successor'));
    assert.equal(r.workspaces[0].verdict, 'exclude');
  }
});
test('R3 workspace-scoped gap also seeds member protection through parent relations', () => {
  const r = scan({ meta: { ...base.meta, gaps: [{ source: 'tasks.md', reason: 'supervisor_owner_unknown', scope: { workspaceIds: ['wks_child'] } }] }, agents: [a('parent'), a('child', { workspaceId: 'wks_child', labels: { 'paseo.parent-agent-id': 'parent' } })], workspaces: [w()] });
  assert.equal(record(r, 'parent').work, 'waiting_work'); assert.equal(r.workspaces[0].verdict, 'exclude');
});

for (const ownerKnown of [false, true]) test(`R4 archived workspace ID resolves to orphan cwd protection, owner known=${ownerKnown}`, () => {
  const orphan = o(), owner = a('owner', { workspaceId: 'elsewhere', cwd: '/fake/owner' });
  const history = w({ workspaceId: 'wks_archived', cwd: orphan.path, archivedAt: '2026-01-02' });
  const data = { agents: ownerKnown ? [owner] : [], workspaces: [history], orphans: [orphan] };
  assert.equal(scan(data).orphans[0].verdict, 'batch_candidate');
  const r = scan({ ...data, supervisors: [{ directory: 'fake-record', ownerIds: ownerKnown ? ['owner'] : [], workspaceIds: ['wks_archived'], agentIds: [], paths: [] }] });
  assert.equal(r.orphans[0].verdict, 'review'); assert.ok(r.orphans[0].hold.includes('supervisor_scope')); assert.equal(r.workspaces[0].verdict, 'exclude');
});
test('R4 workspace worktreeRoot is protected even when cwd points elsewhere', () => {
  const r = scan({ workspaces: [w({ workspaceId: 'wks_archived', cwd: '/fake/elsewhere', worktreeRoot: '/fake/worktrees/project/orphan', archivedAt: '2026-01-02' })], supervisors: [{ directory: 'fake-record', ownerIds: [], workspaceIds: ['wks_archived'] }], orphans: [o()] });
  assert.equal(r.orphans[0].verdict, 'review'); assert.ok(r.orphans[0].hold.includes('supervisor_scope'));
});
for (const workspace of [null, { workspaceId: 'wks_unresolved' }, { workspaceId: 'wks_unresolved', cwd: 'relative/path' }, { workspaceId: 'wks_unresolved', cwd: '/fake/cwd', worktreeRoot: 'relative/root' }]) test(`R4 unresolved workspace reference blocks globally: ${JSON.stringify(workspace)}`, () => {
  const r = scan({ workspaces: [w(), ...(workspace ? [workspace] : [])], orphans: [o()], supervisors: [{ directory: 'fake-record', ownerIds: [], workspaceIds: ['wks_unresolved'], agentIds: ['other-id'], paths: ['/fake/unrelated'] }] });
  assert.equal(r.orphans[0].verdict, 'review'); assert.ok(r.orphans[0].reasons.includes('protection_gap:supervisor_workspace_unresolved')); assert.notEqual(r.workspaces[0].verdict, 'batch_candidate');
});
test('R4 generated workspace-resolution gaps are pure and counted once when persisted in metadata', async () => {
  const { protectionContext, scanSummary } = await import('./classify.mjs');
  const snapshot = { ...structuredClone(base), supervisors: [{ directory: 'fake-record', workspaceIds: ['wks_missing'], paths: [] }] }, before = structuredClone(snapshot);
  const context = protectionContext(snapshot); assert.equal(context.generatedGaps.length, 1); assert.deepEqual(snapshot, before);
  snapshot.meta.gaps = context.generatedGaps;
  assert.equal(protectionContext(snapshot).gaps.length, 1); assert.equal(scanSummary(snapshot).globalBlockers.supervisor_workspace_unresolved, 1);
});
test('R4 coverage summary counts unique terminal cwd and global reasons without scoped or excerpt gaps', async () => {
  const { scanSummary } = await import('./classify.mjs');
  const snapshot = { ...structuredClone(base), meta: { ...base.meta, gaps: [{ source: 'live', reason: 'live_missing' }, { source: '/fake/a/tasks.md', reason: 'ENOENT' }, { source: '/fake/b/tasks.md', reason: 'ENOENT' }, { source: 'tasks.md', reason: 'supervisor_owner_unknown', scope: { agentIds: ['a'] } }, { source: 'excerpt', reason: 'excerpt_pair_uncertain' }] }, agents: [a('a', { statusSource: 'live' }), a('b', { statusSource: 'live' }), a('c', { statusSource: 'store' }), a('archived', { archivedAt: '2026-01-02', statusSource: 'live' })], workspaces: [w({ checks: { terminals: 'confirmed_none' } }), w({ workspaceId: 'duplicate', checks: { terminals: 'unchecked' } }), w({ workspaceId: 'present', cwd: '/fake/present', checks: { terminals: 'present' } })], orphans: [o({ checks: { terminals: 'confirmed_none' } })] };
  const summary = scanSummary(snapshot);
  assert.deepEqual(summary.live, { activeTotal: 3, observed: 2, storedFallback: 1 });
  assert.deepEqual(summary.terminals, { total: 3, confirmed_none: 1, present: 1, unchecked: 1 });
  assert.deepEqual(summary.globalBlockers, { live_missing: 1, ENOENT: 2 });
});

for (const archived of [false, true]) test(`R5 unique four-character workspace prefix normalizes stored ID, archived=${archived}`, async () => {
  const { protectionContext } = await import('./classify.mjs');
  const full = 'wks_abcd000000000001', ref = 'wks_abcd';
  const data = { ...structuredClone(base), workspaces: [w({ workspaceId: full, cwd: '/fake/worktrees/project/orphan', archivedAt: archived ? '2026-01-02' : null })], supervisors: [{ directory: 'prefix-owner', ownerIds: [], workspaceIds: [ref], paths: [] }], orphans: [o()] };
  const context = protectionContext(data);
  assert.deepEqual(context.supervisors[0].workspaceIds, [full]); assert.deepEqual(context.supervisors[0].workspaceRefs, [ref]); assert.deepEqual(context.generatedGaps, []);
  const r = scan(data); assert.equal(r.orphans[0].verdict, archived ? 'review' : 'exclude'); assert.ok(r.orphans[0].hold.includes('supervisor_scope'));
});
for (const [ref, ids] of [['wks_abcd', ['wks_abcd000000000001', 'wks_abcd000000000002']], ['wks_dead', ['wks_abcd000000000001']], ['wks_abc', ['wks_abcd000000000001']]]) test(`R5 ambiguous, absent or too-short prefix remains globally blocked: ${ref} ${ids.length}`, async () => {
  const { protectionContext, minWorkspacePrefixLength } = await import('./classify.mjs'); assert.equal(minWorkspacePrefixLength, 4);
  const data = { ...structuredClone(base), workspaces: ids.map(id => w({ workspaceId: id, cwd: `/fake/${id}`, archivedAt: '2026-01-02' })), supervisors: [{ directory: 'prefix-owner', workspaceIds: [ref], paths: ['/fake/unrelated'] }], orphans: [o()] };
  const context = protectionContext(data); assert.equal(context.generatedGaps[0].reason, 'supervisor_workspace_unresolved'); assert.equal(context.generatedGaps[0].scope, undefined); assert.equal(scan(data).orphans[0].verdict, 'review');
});
test('R5 owner-unknown gap scope normalizes prefix before member and ancestor protection', async () => {
  const full = 'wks_abcd000000000001', ref = 'wks_abcd';
  const data = { meta: { ...base.meta, gaps: [{ source: 'tasks.md', reason: 'supervisor_owner_unknown', scope: { workspaceIds: [ref] } }] }, workspaces: [w({ workspaceId: full, cwd: '/fake/child' }), w()], supervisors: [{ directory: 'prefix-owner', workspaceIds: [ref], ownerIds: [], paths: [] }], agents: [a('parent'), a('child', { cwd: '/fake/child', workspaceId: full, labels: { 'paseo.parent-agent-id': 'parent' } })] };
  const r = scan(data); assert.equal(record(r, 'parent').work, 'waiting_work'); assert.equal(record(r, 'parent').verdict, 'exclude');
});
test('R5 normalized supervisor context is stable when source references are retained', async () => {
  const { protectionContext } = await import('./classify.mjs');
  const data = { ...structuredClone(base), workspaces: [w({ workspaceId: 'wks_abcd000000000001' })], supervisors: [{ directory: 'prefix-owner', workspaceIds: ['wks_abcd'] }] };
  const first = protectionContext(data), second = protectionContext({ ...data, supervisors: first.supervisors });
  assert.deepEqual(first, second);
});

test('R6 scoped live gap protects relations and cwd while unrelated resources remain eligible', () => {
  const agents = [a('missing', { statusSource: 'store', lastStatus: 'running', workspaceId: 'wks_missing', cwd: '/fake/missing/sub', labels: { 'paseo.parent-agent-id': 'parent', 'handoff.from': 'old' } }), a('parent', { workspaceId: 'wks_parent', cwd: '/fake/parent' }), a('old', { workspaceId: 'wks_old', cwd: '/fake/old', archivedAt: '2026-01-02' }), a('subscriber', { workspaceId: 'wks_subscriber', cwd: '/fake/subscriber' })];
  const data = { meta: { ...base.meta, gaps: [{ source: 'live', reason: 'live_missing', scope: { agentIds: ['missing'] } }] }, agents, subscriptions: [{ callerAgentId: 'subscriber', childAgentId: 'missing' }], workspaces: [w({ workspaceId: 'wks_missing', cwd: '/fake/missing' }), w({ workspaceId: 'wks_parent', cwd: '/fake/parent' }), w({ workspaceId: 'wks_subscriber', cwd: '/fake/subscriber' }), w({ workspaceId: 'wks_other', cwd: '/fake/other' }), w({ workspaceId: 'wks_path', cwd: '/fake/missing/sub' })], orphans: [o({ path: '/fake/missing' }), o({ path: '/fake/unrelated' })] };
  const r = scan(data);
  for (const id of ['parent', 'old', 'subscriber']) assert.ok(record(r, id).hold.includes('active_lane'));
  for (const id of ['wks_missing', 'wks_parent', 'wks_subscriber', 'wks_path']) assert.notEqual(r.workspaces.find(w => w.id === id).verdict, 'batch_candidate');
  assert.equal(r.workspaces.find(w => w.id === 'wks_other').verdict, 'batch_candidate');
  assert.equal(r.orphans[0].verdict, 'exclude'); assert.equal(r.orphans[1].verdict, 'batch_candidate');
  const leaf = scan({ ...data, subscriptions: [] }); assert.equal(record(leaf, 'missing').work, 'unknown', 'stored running does not claim live observation');
});
