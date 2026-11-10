import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify } from './classify.mjs';
import { sanitizeAgent, serializeSnapshot, collect, writeOutputs, validateObservation, addExcerpts, parseOptions, parseStatus } from './scan.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
const old = '2026-01-01T00:00:00Z';

test('review P1 secret-like paths and IDs stay original until classification completes', () => {
  const cwd = '/fake/worktrees/project/xoxb-example', id = 'xoxb-agent-example';
  const a = { ...sanitizeAgent({ ...fixture.fixtureAgent, id, cwd, lastStatus: 'running', title: 'token xoxb-free-title' }), statusSource: 'live' };
  assert.equal(a.cwd, cwd); assert.equal(a.id, id); assert.equal(a.title, 'token xoxb-free-title');
  const snapshot = { ...structuredClone(fixture), meta: { ...fixture.meta, gaps: [] }, agents: [a], orphans: [{ path: cwd, observedTimesMax: old, git: fixture.fixtureGit, checks: fixture.fixtureChecks }] };
  snapshot.classification = classify(snapshot);
  assert.equal(snapshot.classification.orphans[0].verdict, 'exclude'); assert.ok(snapshot.classification.orphans[0].hold.includes('active_lane'));
  const before = structuredClone(snapshot), output = serializeSnapshot(snapshot);
  assert.deepEqual(snapshot, before); assert.equal(output.classification.orphans[0].verdict, 'exclude');
  assert.match(output.agents[0].cwd, /^\[STRUCT_SHA256:[a-f0-9]{64}\]$/); assert.equal(output.agents[0].cwd, output.orphans[0].path); assert.equal(output.orphans[0].path, output.classification.orphans[0].id);
  assert.match(output.agents[0].id, /^\[STRUCT_SHA256:/); assert.equal(output.agents[0].title, 'token [REDACTED]');
  assert.doesNotMatch(JSON.stringify(output), /xoxb-example|xoxb-agent-example|xoxb-free-title/);
});
test('review P1 parent relation labels are never redacted before the protection fixed point', () => {
  const parentId = 'xoxb-parent-example';
  const agents = [sanitizeAgent({ ...fixture.fixtureAgent, id: parentId }), sanitizeAgent({ ...fixture.fixtureAgent, id: 'child', lastStatus: 'running', labels: { 'paseo.parent-agent-id': parentId } })];
  assert.equal(agents[1].labels['paseo.parent-agent-id'], parentId);
  const s = { ...structuredClone(fixture), agents }; s.classification = classify(s);
  assert.equal(s.classification.agents[0].work, 'waiting_work');
  const output = serializeSnapshot(s); assert.equal(output.agents[1].labels['paseo.parent-agent-id'], output.agents[0].id); assert.match(output.agents[0].id, /^\[STRUCT_SHA256:/);
});
test('review P1 collector and both output files preserve a live agent path dependency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-raw-cwd-'));
  try {
    const cwd = join(dir, 'worktrees/fake/xoxb-example');
    for (const p of ['agents/fake', 'projects', 'schedules', 'state/yw-supervisor', 'worktrees/fake/xoxb-example']) mkdirSync(join(dir, p), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111', serverId = 'xoxb-server-example';
    writeFileSync(join(dir, 'server-id'), serverId); writeFileSync(join(dir, 'version.json'), '{"version":"0.15.4"}');
    writeFileSync(join(dir, 'projects/workspaces.json'), '[]'); writeFileSync(join(dir, 'projects/projects.json'), '[]'); writeFileSync(join(dir, 'finish-subscriptions.json'), '[]');
    writeFileSync(join(dir, 'agents/fake/one.json'), JSON.stringify({ id, cwd, lastStatus: 'running', lastActivityAt: old, title: 'Bearer fake-fixture-credential' }));
    const observedAt = new Date().toISOString();
    const inputs = { live: { serverId, observedAt, scope: 'all', agents: { [id]: { status: 'running' } } }, pending: { serverId, observedAt, scope: 'all', permissions: [] }, terminals: { serverId, observedAt, scope: 'all', terminals: [] } };
    for (const [kind, value] of Object.entries(inputs)) writeFileSync(join(dir, `${kind}.json`), JSON.stringify(value));
    const s = await collect({ paseoHome: dir, stateHome: join(dir, 'state'), live: join(dir, 'live.json'), pending: join(dir, 'pending.json'), terminals: join(dir, 'terminals.json') });
    assert.equal(s.agents[0].cwd, s.orphans[0].path); assert.ok(s.agents[0].cwd.endsWith('/xoxb-example')); assert.equal(s.agents[0].statusSource, 'live'); assert.ok(s.classification.orphans[0].hold.includes('active_lane'));
    s.orphans[0].git = structuredClone(fixture.fixtureGit); s.orphans[0].checks = structuredClone(fixture.fixtureChecks); s.orphans[0].observedTimesMax = old;
    s.classification = classify(s); assert.equal(s.classification.orphans[0].verdict, 'exclude');
    const out = join(dir, 'out'); writeOutputs(out, s);
    const json = readFileSync(join(out, 'scan.json'), 'utf8'), plan = readFileSync(join(out, 'plan-draft.md'), 'utf8'), emitted = JSON.parse(json);
    assert.equal(emitted.classification.orphans[0].verdict, 'exclude'); assert.equal(emitted.agents[0].cwd, emitted.orphans[0].path); assert.equal(emitted.meta.serverId, emitted.meta.inputObservations.live.serverId);
    assert.ok(plan.includes(emitted.orphans[0].path)); assert.doesNotMatch(json + plan, /xoxb-example|xoxb-server-example|Bearer |fake-fixture-credential/);
    assert.ok(s.agents[0].cwd.endsWith('/xoxb-example'), 'writing never changes classification inventory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('review P1 structural values are hashed as complete values and are never truncated', () => {
  const rawPath = '/fake/xoxb-example/nested', longId = 'a'.repeat(3000), ignored = parseStatus('! xoxb-local/data\0');
  const value = { cwd: rawPath, id: longId, scope: { paths: [rawPath] }, git: { ignoredPaths: ignored.ignoredPaths }, labels: { role: 'r'.repeat(700) }, excerpt: { text: 'x'.repeat(590) + ' AKIA' + 'ABCDEFGHIJKLMNOP' } };
  assert.equal(ignored.ignoredPaths[0], 'xoxb-local/data'); const output = serializeSnapshot(value);
  assert.equal(output.cwd, output.scope.paths[0]); assert.match(output.git.ignoredPaths[0], /^\[STRUCT_SHA256:/); assert.equal(output.id, longId); assert.equal(output.labels.role.length, 512); assert.equal(output.excerpt.text.length, 600); assert.doesNotMatch(output.excerpt.text, /AKIA/); assert.deepEqual(serializeSnapshot(output), output);
});
for (const kind of ['live', 'pending', 'terminals']) test(`review P2 ${kind} rejects local or non-ISO observation timestamps`, () => {
  const now = '2026-01-10T12:00:00Z', d = new Date(now), pad = n => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  for (const observedAt of [local, '2026-01-10', 'Sat, 10 Jan 2026 12:00:00 GMT', '2026-01-10 12:00:00Z']) {
    const r = validateObservation(kind, { serverId: 'srv_fixture', observedAt, scope: 'all' }, 'srv_fixture', now); assert.equal(r.state, 'unchecked'); assert.ok(r.issues.includes('input_observed_at_missing_or_invalid'));
  }
  for (const observedAt of [now, '2026-01-10T21:00:00+09:00', '2026-01-10T21:00:00+0900', '2026-01-10T06:30:00-05:30', '2026-01-10T12:00:00.000000Z']) assert.equal(validateObservation(kind, { serverId: 'srv_fixture', observedAt, scope: 'all' }, 'srv_fixture', now).state, 'confirmed');
});
test('review P2 CLI refuses excerpts without a selected ID file before collecting data', () => {
  assert.throws(() => parseOptions(['--excerpts']), /requires --excerpt-ids/);
  assert.equal(parseOptions(['--excerpts', '--excerpt-ids', '/fake/ids.json']).excerpts, true);
  const r = spawnSync(process.execPath, [new URL('./scan.mjs', import.meta.url).pathname, '--excerpts'], { encoding: 'utf8' }); assert.notEqual(r.status, 0); assert.match(r.stderr, /requires --excerpt-ids/);
});
test('review P2 excerpt helper reads no bodies without a selected ID set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-selection-required-')), id = '11111111-1111-4111-8111-111111111111', sessionId = '22222222-2222-4222-8222-222222222222';
  try {
    const transcripts = join(dir, '.claude/projects/fake'); mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, `${sessionId}.jsonl`), [{ type: 'user', message: { role: 'user', content: 'unselected request' } }, { type: 'assistant', message: { role: 'assistant', content: 'unselected response' } }].map(JSON.stringify).join('\n'));
    const s = { ...structuredClone(fixture), meta: { ...fixture.meta, gaps: [] }, agents: [{ ...fixture.fixtureAgent, id, provider: 'claude' }], classification: { agents: [{ id, verdict: 'review' }] } };
    await addExcerpts(s, new Map([[id, sessionId]]), dir, join(dir, 'paseo'));
    assert.equal(s.agents[0].excerpt, undefined); assert.ok(s.meta.gaps.some(g => g.reason === 'excerpt_ids_required'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('review P1 plan summary resolves supervisor paths before hashing structural values', async () => {
  const { planMarkdown } = await import('./scan.mjs');
  const cwd = '/fake/worktrees/project/xoxb-example';
  const s = { ...structuredClone(fixture), meta: { ...fixture.meta, gaps: [] }, workspaces: [{ workspaceId: 'wks_fake', cwd, worktreeRoot: cwd, mainRepoRoot: '/fake/main', isPaseoOwnedWorktree: true, createdAt: old, updatedAt: old, git: fixture.fixtureGit, checks: fixture.fixtureChecks }], supervisors: [{ directory: 'fake', workspaceIds: ['wks_fake'], ownerIds: [] }] };
  s.classification = classify(s); const plan = planMarkdown(s), emitted = serializeSnapshot(s);
  assert.match(plan, /전역 차단 gap\(사유별 건수\): \{\}/); assert.doesNotMatch(plan, /supervisor_workspace_unresolved|xoxb-example/); assert.equal(emitted.meta.outputRedaction.classificationUsedOriginalCanonicalValues, true); assert.equal(emitted.meta.outputRedaction.reclassificationRequiresOriginalInventory, true);
});
