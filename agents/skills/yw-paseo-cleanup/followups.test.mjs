import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, protectionContext } from './classify.mjs';
import { extractTranscript, redact, validateObservation, readPaseoVersion, addExcerpts, planMarkdown, parseOptions, collect } from './scan.mjs';
const base = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
const now = base.meta.collectedAt, old = '2026-01-01T00:00:00Z';
const agent = (id, extra = {}) => ({ ...structuredClone(base.fixtureAgent), id, ...extra });
const workspace = (extra = {}) => ({ workspaceId: 'wks_lane', cwd: '/fake/lane', isPaseoOwnedWorktree: true, worktreeRoot: '/fake/lane', mainRepoRoot: '/fake/main', createdAt: old, updatedAt: old, git: structuredClone(base.fixtureGit), checks: structuredClone(base.fixtureChecks), ...extra });
const orphan = (extra = {}) => ({ path: '/fake/orphan', observedTimesMax: old, git: structuredClone(base.fixtureGit), checks: structuredClone(base.fixtureChecks), ...extra });
const scan = data => classify({ ...structuredClone(base), ...data });
const message = (role, text) => ({ type: role, timestamp: old, message: { role, content: text } });

test('F2 delegated requests replace the previous pair, including unanswered latest request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-f2-'));
  try {
    const file = join(dir, 'fixture.jsonl'), delegated = '<paseo-system version="1" kind="agent-message">B request</paseo-system>';
    const rows = [message('user', 'A request'), message('assistant', 'A complete'), message('user', delegated)];
    writeFileSync(file, rows.map(JSON.stringify).join('\n'));
    let r = await extractTranscript(file, 'claude'); assert.equal(r.user.text, delegated); assert.equal(r.assistant, null); assert.equal(r.pairUncertain, true);
    writeFileSync(file, [...rows, message('assistant', 'B complete')].map(JSON.stringify).join('\n'));
    r = await extractTranscript(file, 'claude'); assert.equal(r.user.text, delegated); assert.equal(r.assistant.text, 'B complete'); assert.equal(r.pairUncertain, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const skipped of [message('user', '<paseo-system kind="other">unknown</paseo-system>'), message('user', '<turn_aborted>'), { type: 'turn_aborted' }, { type: 'event_msg', payload: { type: 'turn_aborted' } }]) test(`F2 skipped later system or abort row makes the pair uncertain ${JSON.stringify(skipped)}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-f2-skipped-'));
  try {
    const file = join(dir, 'fixture.jsonl'); writeFileSync(file, [message('user', 'request'), message('assistant', 'answer'), skipped].map(JSON.stringify).join('\n'));
    const r = await extractTranscript(file, 'claude'); assert.equal(r.pairUncertain, true); assert.equal(r.user.text, 'request');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('F4 live supervisor scope crosses parent descendants and continuation successors to a fixed point', () => {
  const r = scan({ agents: [agent('owner'), agent('child', { labels: { 'paseo.parent-agent-id': 'owner' } }), agent('successor', { labels: { 'handoff.from': 'child' } }), agent('grandchild', { labels: { 'paseo.parent-agent-id': 'successor' } })], supervisors: [{ directory: 'fake', ownerIds: ['owner'], agentIds: [] }] });
  assert.ok(r.agents.every(a => a.hold.includes('supervisor_scope')));
  const archived = scan({ agents: [agent('owner', { archivedAt: old }), agent('child', { labels: { 'paseo.parent-agent-id': 'owner' } })], supervisors: [{ directory: 'fake', ownerIds: ['owner'] }] });
  assert.ok(!archived.agents.find(a => a.id === 'child').hold.includes('supervisor_scope'));
});
for (const change of [{ createdAt: '2026-01-10T11:00:00Z' }, { updatedAt: '2026-01-10T11:00:00Z' }, { createdAt: null }, { updatedAt: undefined }, { updatedAt: 'invalid' }]) test(`F5 workspace recent or missing time excludes ${JSON.stringify(change)}`, () => {
  const r = scan({ workspaces: [workspace(change)] }).workspaces[0]; assert.ok(r.hold.includes('recent')); assert.equal(r.verdict, 'exclude');
});
for (const pathKey of ['cwd', 'worktreeRoot']) test(`F6 nested active workspace ${pathKey} protects orphan even without agents`, () => {
  const r = scan({ workspaces: [workspace({ cwd: '/fake/elsewhere', worktreeRoot: '/fake/elsewhere', [pathKey]: '/fake/orphan/nested' })], orphans: [orphan()] }); assert.equal(r.orphans[0].verdict, 'exclude'); assert.ok(r.orphans[0].hold.includes('active_lane'));
});
test('F7 daemon ownership flags determine destructive workspace Git checks, regardless of kind', () => {
  const owned = scan({ workspaces: [workspace({ kind: 'directory', git: { ...base.fixtureGit, dirtyCount: 1 } })] }).workspaces[0]; assert.equal(owned.verdict, 'review'); assert.ok(owned.hold.includes('data')); assert.equal(owned.deleteDirectory, undefined);
  for (const change of [{ isPaseoOwnedWorktree: false }, { worktreeRoot: null }, { mainRepoRoot: null }]) { const local = scan({ workspaces: [workspace({ kind: 'worktree', git: null, ...change })] }).workspaces[0]; assert.equal(local.verdict, 'batch_candidate'); assert.equal(local.deleteDirectory, false); }
});
for (const status of [undefined, 'unknown-new-status', null]) test(`F8 unknown schedule status protects both target types ${status}`, () => {
  const data = { agents: [agent('target')], workspaces: [workspace()], orphans: [orphan()], schedules: [{ id: 'heartbeat', status, target: { type: 'agent', agentId: 'target' } }, { id: 'schedule', status, target: { type: 'new-agent' }, cwd: '/fake/orphan/sub' }, { id: 'workspace-schedule', status, target: { type: 'new-agent' }, cwd: '/fake/lane' }] };
  const r = scan(data); assert.equal(r.agents[0].work, 'waiting_schedule'); assert.ok(r.workspaces[0].hold.includes('schedule_dependency')); assert.ok(r.orphans[0].hold.includes('schedule_dependency')); assert.equal(protectionContext({ ...base, ...data }).generatedGaps.filter(g => g.reason === 'schedule_status_unknown').length, 3);
  assert.equal(scan({ ...data, schedules: data.schedules.map(s => ({ ...s, status: 'completed' })) }).agents[0].work, 'candidate');
});
test('F8 version is read from app plist or home metadata without a subprocess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-version-'));
  try {
    const plist = join(dir, 'Info.plist'); writeFileSync(plist, '<plist><dict><key>CFBundleShortVersionString</key><string>0.15.4</string></dict></plist>');
    assert.deepEqual(readPaseoVersion(dir, plist), { version: '0.15.4', source: 'app_info_plist' });
    writeFileSync(join(dir, 'version.json'), '{"version":"0.16.0-beta.1"}'); assert.equal(readPaseoVersion(dir, join(dir, 'missing')).version, '0.16.0-beta.1');
    rmSync(join(dir, 'version.json')); assert.deepEqual(readPaseoVersion(dir, join(dir, 'missing')), { version: null, source: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('F9 old lastUserMessageAt cannot bypass missing lastActivityAt protection', () => {
  for (const lastActivityAt of [undefined, null, 'invalid']) { const r = scan({ agents: [agent('old-request', { lastUserMessageAt: old, lastActivityAt })] }).agents[0]; assert.ok(r.hold.includes('recent')); assert.equal(r.verdict, 'exclude'); }
});
for (const secret of [('AKIA' + 'ABCDEFGHIJKLMNOP'), ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmaXh0dXJlIn0', 'fixture_signature'].join('.'), 'xoxb-fixture-123456', 'xoxa-fixture-123456', 'xoxp-fixture-123456', 'xoxr-fixture-123456', 'xoxs-fixture-123456', 'NPM_TOKEN=opaque-fixture-value', 'CUSTOM_SECRET="opaque fixture value"']) test(`F12 credential family is redacted ${secret.split(/[=-]/)[0]}`, () => { const r = redact(`prefix ${secret} suffix`); assert.ok(r.includes('[REDACTED]')); assert.ok(!r.includes(secret)); assert.doesNotMatch(r, /opaque|eyJhb|AKIAABC|xox[baprs]-/); });
for (const signal of [{ lastStatus: 'running' }, { pendingCount: 1 }, { lastStatus: 'idle' }, { labels: { 'paseo.parent-agent-id': 'owner' } }]) test(`R1 protected historical cwd blocks unrelated workspace and orphan ${JSON.stringify(signal)}`, () => {
  const r = scan({ agents: [agent('owner'), agent('historical', { archivedAt: old, workspaceId: 'wks_old', cwd: '/fake/orphan/nested', ...signal })], supervisors: [{ directory: 'fake', ownerIds: ['owner'] }], workspaces: [workspace({ cwd: '/fake/orphan', worktreeRoot: '/fake/orphan' })], orphans: [orphan()] });
  assert.ok(r.workspaces[0].hold.includes('active_lane')); assert.equal(r.orphans[0].verdict, 'exclude');
});
test('R1 archived heartbeat target cwd is a path dependency', () => {
  const r = scan({ agents: [agent('historical', { archivedAt: old, cwd: '/fake/orphan/sub' })], schedules: [{ id: 'active', status: 'active', target: { type: 'agent', agentId: 'historical' } }], orphans: [orphan()] }); assert.equal(r.orphans[0].verdict, 'exclude');
});
test('R2 any unresolved supervisor owner scopes mentioned agents, workspace and path', () => {
  const data = { agents: [agent('archived-owner', { archivedAt: old }), agent('member')], workspaces: [workspace()], orphans: [orphan()], supervisors: [{ directory: 'fake', ownerIds: ['archived-owner', 'unknown-owner'], agentIds: ['member'], workspaceIds: ['wks_lane'], paths: ['/fake/orphan'] }] };
  const context = protectionContext({ ...base, ...data }); assert.ok(context.generatedGaps.some(g => g.reason === 'supervisor_owner_unresolved')); const r = scan(data); assert.ok(r.agents.find(a => a.id === 'member').hold.includes('supervisor_scope')); assert.notEqual(r.workspaces[0].verdict, 'batch_candidate'); assert.notEqual(r.orphans[0].verdict, 'batch_candidate');
});
for (const kind of ['live', 'pending', 'terminals']) test(`R3 ${kind} observation provenance and 30 minute freshness boundary`, () => {
  const valid = { serverId: 'srv_fixture', observedAt: '2026-01-10T11:30:00Z', scope: 'all' };
  assert.equal(validateObservation(kind, valid, 'srv_fixture', now).state, 'confirmed');
  for (const change of [{ serverId: 'srv_other' }, { serverId: undefined }, { observedAt: undefined }, { observedAt: '2026-01-10T11:29:59Z' }, { observedAt: 'invalid' }, { observedAt: '2026-01-11T00:00:00Z' }, { scope: undefined }, { scope: 'unknown' }]) assert.equal(validateObservation(kind, { ...valid, ...change }, 'srv_fixture', now).state, 'unchecked');
  assert.equal(validateObservation(kind, { ...valid, observedAt: '2026-01-10T11:00:00Z' }, 'srv_fixture', now, 60).state, 'confirmed');
});
test('R4 every workspace batch includes workspace ownership terminal verification', () => {
  for (const isPaseoOwnedWorktree of [true, false]) assert.ok(scan({ workspaces: [workspace({ isPaseoOwnedWorktree })] }).workspaces[0].remainingChecks.includes('workspace_owned_terminals'));
});
test('R5 selected excerpt IDs read only selected agents, including explicitly selected archived agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-selection-')), selected = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
  const session = '33333333-3333-4333-8333-333333333333', otherSession = '44444444-4444-4444-8444-444444444444';
  try {
    const transcripts = join(dir, '.claude/projects/fake'); mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${session}.jsonl`), [message('user', 'selected request'), message('assistant', 'selected response')].map(JSON.stringify).join('\n'));
    writeFileSync(join(transcripts, `${otherSession}.jsonl`), 'intentionally invalid unselected transcript');
    const s = { ...structuredClone(base), meta: { ...base.meta, gaps: [] }, agents: [agent(selected, { provider: 'claude', archivedAt: old }), agent(other, { provider: 'claude' })], classification: { agents: [{ id: selected, verdict: 'exclude' }, { id: other, verdict: 'review' }] } };
    await addExcerpts(s, new Map([[selected, session], [other, otherSession]]), dir, join(dir, 'paseo'), new Set([selected]));
    assert.equal(s.agents[0].excerpt.user.text, 'selected request'); assert.equal(s.agents[1].excerpt, undefined); assert.deepEqual(s.meta.gaps, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R6 orphan plan explicitly labels the maximum as observed timestamps rather than proof of last work', () => {
  const s = { ...structuredClone(base), meta: { ...base.meta, gaps: [] }, orphans: [orphan()] }; s.classification = classify(s); assert.equal(s.classification.orphans[0].timeBasis, 'observed_times_max'); assert.match(planMarkdown(s), /관측한 시각 기준; 마지막 작업 시각의 증명 아님/);
});
test('new CLI contracts enforce observation age and make selected excerpts explicit', () => {
  assert.equal(parseOptions(['--excerpt-ids', '/fake/ids.json']).excerpts, true); assert.equal(parseOptions([]).maxInputAgeMinutes, 30); assert.equal(parseOptions(['--max-input-age-minutes', '60']).maxInputAgeMinutes, 60); assert.throws(() => parseOptions(['--max-input-age-minutes', '-1']));
});
test('F6 collector canonicalizes symlinked active workspace roots before orphan path protection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-realpath-'));
  try {
    for (const p of ['agents', 'projects', 'schedules', 'worktrees/group/outer/nested', 'state/yw-supervisor']) mkdirSync(join(dir, p), { recursive: true });
    const alias = join(dir, 'alias'); symlinkSync(join(dir, 'worktrees/group/outer/nested'), alias, 'dir');
    writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ ...workspace({ isPaseoOwnedWorktree: false, worktreeRoot: alias }), cwd: alias }]));
    writeFileSync(join(dir, 'projects/projects.json'), '[]'); writeFileSync(join(dir, 'finish-subscriptions.json'), '[]'); writeFileSync(join(dir, 'server-id'), 'srv_fixture');
    const s = await collect({ paseoHome: dir, stateHome: join(dir, 'state') });
    assert.notEqual(s.workspaces[0].cwd, alias); const o = s.classification.orphans.find(o => o.id.endsWith('/outer')); assert.ok(o.hold.includes('active_lane'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('F2 Codex delegated requests also become the latest pair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-f2-codex-'));
  try {
    const file = join(dir, 'fixture.jsonl'), text = '<paseo-system kind="agent-message">followup request</paseo-system>';
    const codex = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
    writeFileSync(file, [codex('user', 'old request'), codex('assistant', 'old response'), codex('user', text), codex('assistant', 'followup response')].map(JSON.stringify).join('\n'));
    const r = await extractTranscript(file, 'codex'); assert.equal(r.user.text, text); assert.equal(r.assistant.text, 'followup response'); assert.equal(r.pairUncertain, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('F7 destructive root receives self and schedule protection even when cwd is elsewhere', () => {
  const s = { ...base, workspaces: [workspace({ cwd: '/fake/elsewhere', worktreeRoot: '/fake/destructive-root' })] };
  assert.ok(classify(s, { selfCwd: '/fake/destructive-root/sub' }).workspaces[0].hold.includes('self'));
  s.schedules = [{ id: 'schedule', status: 'active', target: { type: 'new-agent' }, cwd: '/fake/destructive-root/child' }]; assert.ok(classify(s).workspaces[0].hold.includes('schedule_dependency'));
});
test('F12 allowlisted labels and provider text share credential redaction', () => {
  const secrets = [('AKIA' + 'ABCDEFGHIJKLMNOP'), 'xoxb-fixture-123456', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmaXh0dXJlIn0', 'fixture_signature'].join('.'), 'NPM_TOKEN=opaque_fixture_value'].join(' ');
  const output = redact(secrets); assert.doesNotMatch(output, /AKIA|xoxb-|eyJ|opaque_fixture/); assert.equal((output.match(/\[REDACTED\]/g) ?? []).length, 4);
});
