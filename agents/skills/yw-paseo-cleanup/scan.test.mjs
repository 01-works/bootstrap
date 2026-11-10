import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeAgent, serializeSnapshot, parseOptions, parseStatus, extractTranscript, collect } from './scan.mjs';
const observation = (kind, data) => ({ serverId: 'srv_fixture', observedAt: new Date().toISOString(), scope: kind === 'live' ? 'listed_agents' : kind === 'terminals' && data.observations ? 'cwd' : 'all', ...(kind === 'live' ? { agents: data } : kind === 'pending' ? { permissions: data } : data) });
const oldWorkspace = { createdAt: '2026-01-01', updatedAt: '2026-01-01' };

test('allowlisted agent fields and strings never emit credentials or unknown objects', () => {
  const raw = { id: 'fake', cwd: '/fake', title: 'Bearer fake-sensitive-value', config: { token: 'private' }, runtimeInfo: { secret: 'private' }, launchEnv: { SECRET: 'private' }, unknown: 'private', labels: { role: 'x'.repeat(1000), token: 'Bearer example-token' }, persistence: { sessionId: 'fake-session', metadata: { token: 'private' } } };
  const a = serializeSnapshot(sanitizeAgent(raw)), json = JSON.stringify(a);
  assert.doesNotMatch(json, /Bearer |"config"|runtimeInfo|launchEnv|persistence|private/); assert.equal(a.labels.role.length, 512);
});
test('CLI input contracts validate age and unknown options', () => {
  assert.deepEqual(parseOptions(['--live', '/fake/live.json', '--pending', '/fake/pending.json', '--gh']).gh, true);
  assert.throws(() => parseOptions(['--min-age-hours', '-1'])); assert.throws(() => parseOptions(['--delete'])); assert.throws(() => parseOptions(['--out']));
});
test('porcelain parser handles rename source paths, embedded newlines and ignored entries', () => {
  const text = '1 M. N... 100644 100644 100644 abc abc file\0' + '2 R. N... 100644 100644 100644 abc abc R100 new\0? source-name\0? untracked\nname\0! node_modules/\0';
  assert.deepEqual(parseStatus(text), { dirtyCount: 2, untrackedCount: 1, ignoredCount: 1, ignoredPaths: ['node_modules/'] });
});
test('provider transcript extraction ignores tool results and reasoning, caps body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-transcript-'));
  try {
    const claude = join(dir, 'claude.jsonl');
    writeFileSync(claude, [
      { type: 'user', timestamp: '2026-01-01', message: { role: 'user', content: [{ type: 'text', text: 'request' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'x'.repeat(700) }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'private tool result' }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    const c = serializeSnapshot(await extractTranscript(claude, 'claude')); assert.equal(c.user.text, 'request'); assert.equal(c.assistant.text.length, 600); assert.equal(c.assistant.truncated, true); assert.doesNotMatch(JSON.stringify(c), /private/);
    const codex = join(dir, 'codex.jsonl');
    writeFileSync(codex, [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex request' }] } },
      { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'text', text: 'private' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'result' }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    const cdx = await extractTranscript(codex, 'codex'); assert.equal(cdx.user.text, 'codex request'); assert.equal(cdx.assistant.text, 'result'); assert.doesNotMatch(JSON.stringify(cdx), /private/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('collector records malformed schemas and strips live permission payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-fixture-'));
  try {
    mkdirSync(join(dir, 'agents/fake'), { recursive: true }); mkdirSync(join(dir, 'projects')); mkdirSync(join(dir, 'schedules')); mkdirSync(join(dir, 'worktrees'));
    writeFileSync(join(dir, 'agents/fake/one.json'), JSON.stringify({ id: 'fake-agent', cwd: '/fake/missing-directory', lastStatus: 'closed', labels: {}, config: { token: 'Bearer private-token' } }));
    writeFileSync(join(dir, 'agents/fake/bad.json'), '{');
    writeFileSync(join(dir, 'projects/workspaces.json'), '{}'); writeFileSync(join(dir, 'projects/projects.json'), '[]'); writeFileSync(join(dir, 'finish-subscriptions.json'), '[]');
    writeFileSync(join(dir, 'schedules/one.json'), JSON.stringify({ id: 'schedule', status: 'active', target: { type: 'new-agent', config: { cwd: '/fake/scheduled', prompt: 'private' } }, prompt: 'private' }));
    writeFileSync(join(dir, 'server-id'), 'srv_fixture');
    const live = join(dir, 'live.json'), pending = join(dir, 'pending.json');
    writeFileSync(live, JSON.stringify(observation('live', { 'fake-agent': { status: 'idle', pendingPermissions: [{ token: 'Bearer private-token' }] } }))); writeFileSync(pending, JSON.stringify(observation('pending', [{ agentId: 'fake-agent', kind: 'question', prompt: 'private' }])));
    const snapshot = await collect({ paseoHome: dir, live, pending, minAgeHours: 72 });
    assert.equal(snapshot.agents[0].pendingCount, 1); assert.equal(snapshot.agents[0].statusSource, 'live'); assert.equal(snapshot.classification.agents[0].work, 'waiting_user');
    assert.ok(snapshot.meta.gaps.some(g => g.reason === 'invalid-json')); assert.ok(snapshot.meta.gaps.some(g => g.reason === 'expected-array'));
    assert.equal(snapshot.schedules[0].cwd, '/fake/scheduled'); assert.doesNotMatch(JSON.stringify(snapshot), /Bearer |"config"|private-token|"prompt"/);
    const out = join(dir, 'out');
    const script = new URL('./scan.mjs', import.meta.url).pathname;
    const args = [script, '--paseo-home', dir, '--out', out];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(child.status, 0, child.stderr);
    assert.equal(statSync(out).mode & 0o777, 0o700); assert.equal(statSync(join(out, 'scan.json')).mode & 0o777, 0o600); assert.equal(statSync(join(out, 'plan-draft.md')).mode & 0o777, 0o600);
    assert.notEqual(spawnSync(process.execPath, args).status, 0, 'never overwrite original scan');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('collector source restricts subprocesses to read commands, classifier has no I/O', () => {
  const source = readFileSync(new URL('./scan.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:rmSync|unlink|execSync|execFile|fetch)\s*\(|worktree[ '\",]+(?:remove|prune)|spawn(?:Sync)?\(['"]paseo|['"](?:kill|cancel|send|archive)['"]/);
  for (const match of source.matchAll(/run\('([^']+)'/g)) assert.ok(['git', 'gh'].includes(match[1]));
  assert.match(source, /GIT_OPTIONAL_LOCKS: '0'/);
  const classifier = readFileSync(new URL('./classify.mjs', import.meta.url), 'utf8'); assert.doesNotMatch(classifier, /\bimport\b|node:|\b(?:process|require|fetch)\b/);
});

test('real Git checks distinguish nested directories, broken gitdir, ignored data, detached refs and dirt', async () => {
  const { inspectGit } = await import('./scan.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-git-'));
  const git = (...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n'); writeFileSync(join(dir, 'tracked'), 'fixture'); git('add', '.'); git('commit', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/fake-owner/fake-project.git'); git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    mkdirSync(join(dir, 'ignored')); writeFileSync(join(dir, 'ignored/data'), 'fixture'); mkdirSync(join(dir, 'nested'));
    const gaps = [], good = inspectGit(dir, {}, gaps, new Map());
    assert.equal(good.registered, true); assert.equal(good.dirtyCount, 0); assert.equal(good.ignoredCount, 1); assert.equal(good.mergedIntoDefault, true); assert.deepEqual(good.errors, []); assert.equal(good.prCheck, 'unchecked');
    assert.equal(inspectGit(join(dir, 'nested'), {}, gaps, new Map()).kind, 'nested');
    const broken = join(dir, 'broken'); mkdirSync(broken); writeFileSync(join(broken, '.git'), 'gitdir: /fake/missing-gitdir'); assert.equal(inspectGit(broken, {}, gaps, new Map()).kind, 'broken');
    git('checkout', '--detach'); const detached = inspectGit(dir, {}, gaps, new Map()); assert.equal(detached.detached, true); assert.ok(detached.reachableRefs.includes('refs/heads/main'));
    writeFileSync(join(dir, 'tracked'), 'changed'); writeFileSync(join(dir, 'new-file'), 'fixture'); const dirty = inspectGit(dir, {}, gaps, new Map()); assert.equal(dirty.dirtyCount, 1); assert.equal(dirty.untrackedCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P1 label allowlist drops opaque credentials and unknown keys without emitting their names', () => {
  const labels = { api_key: 'opaque_fixture_credential_0123456789', AUTH_HEADER: 'opaque-fixture', 'custom-token': 'opaque-fixture', arbitrary: 'unapproved', role: 'builder', 'paseo.parent-agent-id': 'fake-parent', issue: '123' };
  const a = sanitizeAgent({ id: 'fake', labels });
  assert.deepEqual(a.labels, { role: 'builder', 'paseo.parent-agent-id': 'fake-parent', issue: '123' }); assert.equal(a.droppedLabelCount, 4);
  assert.doesNotMatch(JSON.stringify(a), /opaque|api_key|AUTH_HEADER|custom-token|arbitrary/);
});
test('P2 transcript source hides path and native session ID; only response after last request is paired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-pair-'));
  try {
    const file = join(dir, '11111111-1111-4111-8111-111111111111.jsonl');
    const message = (role, text, timestamp) => ({ type: role, timestamp, message: { role, content: text } });
    writeFileSync(file, [message('user', 'old request', '2026-01-01T00:00:00Z'), message('assistant', 'old answer', '2026-01-01T00:01:00Z'), message('user', 'new request', '2026-01-01T00:02:00Z')].map(JSON.stringify).join('\n'));
    let result = await extractTranscript(file, 'claude', 'zerosub-home');
    assert.equal(result.source, 'claude:zerosub-home'); assert.equal(result.user.text, 'new request'); assert.equal(result.assistant, null); assert.equal(result.pairUncertain, true); assert.doesNotMatch(JSON.stringify(result), /11111111|cleanup-pair|\.jsonl/);
    writeFileSync(file, [message('user', 'request', '2026-01-01T00:02:00Z'), message('assistant', 'out of order', '2026-01-01T00:01:00Z')].map(JSON.stringify).join('\n'));
    result = await extractTranscript(file, 'claude'); assert.equal(result.assistant, null); assert.equal(result.pairUncertain, true);
    writeFileSync(file, [message('user', 'request', '2026-01-01T00:02:00Z'), message('assistant', 'new answer', '2026-01-01T00:03:00Z')].map(JSON.stringify).join('\n'));
    result = await extractTranscript(file, 'claude'); assert.equal(result.assistant.text, 'new answer'); assert.equal(result.pairUncertain, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('P2 supervisor header variants resolve owner; absent header produces a scoped gap', async () => {
  const { collectSupervisors } = await import('./scan.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-owner-')), owner = '11111111-1111-4111-8111-111111111111', member = '22222222-2222-4222-8222-222222222222';
  try {
    const headers = ['감독:', '감독자:', '현재 소유 감독:', '소유 감독:', '- 감독:', 'owner:', 'supervisor:'];
    for (let i = 0; i < headers.length; i++) { const target = join(dir, 'yw-supervisor', `fake-${i}`); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'tasks.md'), `${headers[i]} ${owner}\nworker ${member}`); }
    const unknown = join(dir, 'yw-supervisor/unknown'); mkdirSync(unknown); writeFileSync(join(unknown, 'tasks.md'), `worker ${member}\n/tmp/fake/.paseo/worktrees/project/orphan`);
    const gaps = [], records = collectSupervisors(dir, gaps);
    for (const r of records.filter(r => r.directory !== 'unknown')) assert.deepEqual(r.ownerIds, [owner]);
    assert.equal(gaps.length, 1); assert.equal(gaps[0].reason, 'supervisor_owner_unknown'); assert.deepEqual(gaps[0].scope.agentIds, [member]); assert.deepEqual(gaps[0].scope.paths, ['/tmp/fake/.paseo/worktrees/project/orphan']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('P1 terminal observation coverage and definitions are distinct from runtime checks', async () => {
  const { normalizeTerminals, observePath } = await import('./scan.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-observe-'));
  try {
    const canonical = (await import('node:fs')).realpathSync(dir), gaps = [];
    let observations = normalizeTerminals({ observations: [{ cwd: canonical, terminals: [] }] }, gaps);
    let r = observePath(canonical, { prCheck: 'confirmed_none' }, observations, gaps);
    assert.equal(r.checks.terminals, 'confirmed_none'); assert.equal(r.checks.processes, 'unchecked'); assert.equal(r.checks.scripts, 'unchecked'); assert.equal(r.checks.teardown, 'confirmed_none');
    assert.equal(observePath(`${canonical}/unobserved`, {}, observations, gaps).checks.terminals, 'unchecked');
    observations = normalizeTerminals({ observations: [{ cwd: canonical, terminals: [{ cwd: `${canonical}/sub`, title: 'not exported' }] }] }, gaps); assert.equal(observePath(canonical, {}, observations, gaps).checks.terminals, 'present');
    writeFileSync(join(dir, 'paseo.json'), JSON.stringify({ scripts: { dev: { command: 'opaque fixture command' } }, worktree: { teardown: ['opaque fixture teardown'] } }));
    r = observePath(canonical, { prCheck: 'unchecked' }, [], gaps);
    assert.deepEqual(r.definitions, { scripts: ['dev'], teardown: true }); assert.equal(r.checks.teardown, 'present'); assert.equal(r.checks.scripts, 'unchecked'); assert.equal(r.checks.prs, 'unchecked'); assert.doesNotMatch(JSON.stringify(r), /opaque/);
    assert.equal(normalizeTerminals({}, gaps)[0].state, 'unchecked'); assert.ok(gaps.some(g => g.reason === 'expected observations array'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P2 native provider IDs embedded in titles or message text are scrubbed without hiding agent IDs', async () => {
  const { redactSessionText } = await import('./scan.mjs');
  const nativeId = '11111111-1111-4111-8111-111111111111', agentId = '22222222-2222-4222-8222-222222222222';
  const result = redactSessionText(`provider ${nativeId}, agent ${agentId}`, new Set([nativeId]));
  assert.equal(result, `provider [PROVIDER_SESSION], agent ${agentId}`);
});

function syntheticStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-schema-'));
  for (const relative of ['agents/fake', 'projects', 'schedules', 'worktrees', 'state/yw-supervisor/fake', 'directory']) mkdirSync(join(dir, relative), { recursive: true });
  const cwd = join(dir, 'directory'), stateHome = join(dir, 'state');
  const owner = '11111111-1111-4111-8111-111111111111';
  writeFileSync(join(dir, 'server-id'), 'srv_fixture'); writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '0.15.4' }));
  writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ ...oldWorkspace, workspaceId: 'wks_fake', cwd, kind: 'directory' }]));
  writeFileSync(join(dir, 'projects/projects.json'), '[]'); writeFileSync(join(dir, 'finish-subscriptions.json'), '[]');
  writeFileSync(join(dir, 'agents/fake/owner.json'), JSON.stringify({ id: owner, cwd: '/fake/supervisor-owner', lastStatus: 'closed', lastActivityAt: '2026-01-01T00:00:00Z', archivedAt: '2026-01-02T00:00:00Z' }));
  writeFileSync(join(stateHome, 'yw-supervisor/fake/tasks.md'), `owner: ${owner}`);
  for (const [name, value] of [['live', {}], ['pending', []], ['terminals', { observations: [{ cwd, terminals: [] }] }]]) writeFileSync(join(dir, `${name}.json`), JSON.stringify(observation(name, value)));
  return { dir, cwd, options: { paseoHome: dir, stateHome, live: join(dir, 'live.json'), pending: join(dir, 'pending.json'), terminals: join(dir, 'terminals.json'), minAgeHours: 72 } };
}
const invalidStoreCases = [
  ...[null, [], {}, false, 0, 'schema-change'].map(value => ['agents/fake/bad.json', value, 'invalid agent schema']),
  ...[null, [], {}, false, 0, 'schema-change'].map(value => ['schedules/bad.json', value, 'invalid schedule schema']),
  ...[null, {}, false, 0, 'schema-change'].map(value => ['finish-subscriptions.json', value, 'expected-array']),
  ...[null, {}, false, 0].map(value => ['projects/workspaces.json', value, 'expected-array']),
  ...[null, [], {}].map(value => ['finish-subscriptions.json', [value], 'invalid record:0']),
];
for (const [relative, value, reason] of invalidStoreCases) test(`R3 P1 parsed ${JSON.stringify(value)} in ${relative} creates blocking schema gap`, async () => {
  const { dir, options } = syntheticStore();
  try {
    const baseline = await collect(options); assert.equal(baseline.classification.workspaces[0].verdict, 'batch_candidate');
    writeFileSync(join(dir, relative), JSON.stringify(value));
    const s = await collect(options);
    assert.ok(s.meta.gaps.some(g => g.source === join(dir, relative) && g.reason === reason));
    assert.ok(s.classification.workspaces.every(r => r.verdict !== 'batch_candidate'));
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
    const { classify } = await import('./classify.mjs');
    const r = classify({ ...fixture, meta: { ...fixture.meta, gaps: s.meta.gaps }, workspaces: [{ ...oldWorkspace, workspaceId: 'wks_other', cwd: '/fake/other', kind: 'worktree', git: fixture.fixtureGit, checks: fixture.fixtureChecks }] });
    assert.equal(r.workspaces[0].verdict, 'review', 'unknown failed scope blocks another otherwise eligible resource');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R3 P1 read and parse failures remain distinguishable from parsed null schema errors', async () => {
  const { dir, options } = syntheticStore(), file = join(dir, 'finish-subscriptions.json');
  try {
    for (const [content, expected] of [['{', 'invalid-json'], ['null', 'expected-array']]) {
      writeFileSync(file, content); const s = await collect(options); assert.ok(s.meta.gaps.some(g => g.source === file && g.reason === expected));
      assert.equal(s.classification.workspaces[0].verdict, 'review');
    }
    rmSync(file); const missing = await collect(options); assert.ok(missing.meta.gaps.some(g => g.source === file && g.reason === 'ENOENT'));
    assert.equal(missing.classification.workspaces[0].verdict, 'review');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R3 P1 malformed duplicate terminal observation overrides empty success independent of row order', async () => {
  const { dir, cwd, options } = syntheticStore();
  try {
    const good = { cwd, terminals: [] }, bad = { cwd, terminals: 'schema-change' };
    for (const observations of [[good, bad], [bad, good], [good, { cwd, terminals: [null] }]]) {
      writeFileSync(options.terminals, JSON.stringify(observation('terminals', { observations }))); const s = await collect(options);
      assert.equal(s.workspaces[0].checks.terminals, 'unchecked'); assert.equal(s.classification.workspaces[0].verdict, 'review');
      assert.ok(s.meta.gaps.some(g => g.reason === 'invalid terminal observation' && g.scope?.paths.length === 1));
    }
    writeFileSync(options.terminals, JSON.stringify(observation('terminals', { observations: [good, { terminals: [] }] })));
    const global = await collect(options); assert.equal(global.workspaces[0].checks.terminals, 'unchecked'); assert.equal(global.classification.workspaces[0].verdict, 'review');
    assert.ok(global.meta.gaps.some(g => g.reason === 'invalid terminal observation' && !g.scope));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R3 P1 unknown supervisor scope contains agent, workspace and path references; incomplete scope is global', async () => {
  const { collectSupervisors } = await import('./scan.mjs');
  const { classify } = await import('./classify.mjs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-scope-')), recordDir = join(dir, 'yw-supervisor/fake');
  const member = '22222222-2222-4222-8222-222222222222', worktree = '/tmp/fake/.paseo/worktrees/project/lane';
  try {
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, 'tasks.md'), `agent ${member}\nworkspace wks_target\npath ${worktree}`);
    const gaps = [], supervisors = collectSupervisors(dir, gaps);
    assert.deepEqual(gaps[0].scope, { agentIds: [member], workspaceIds: ['wks_target'], paths: [worktree] });
    const workspace = (id, cwd) => ({ ...oldWorkspace, workspaceId: id, cwd, kind: 'worktree', isPaseoOwnedWorktree: true, worktreeRoot: cwd, mainRepoRoot: '/fake/main', checks: fixture.fixtureChecks, git: fixture.fixtureGit });
    const snapshot = { ...fixture, meta: { ...fixture.meta, gaps }, supervisors, workspaces: [workspace('wks_target', '/fake/target'), workspace('wks_path', worktree), workspace('wks_unrelated', '/fake/unrelated')] };
    const r = classify(snapshot); assert.equal(r.workspaces[0].verdict, 'review'); assert.equal(r.workspaces[1].verdict, 'review'); assert.equal(r.workspaces[2].verdict, 'batch_candidate');
    for (const ambiguous of ['~/.paseo/worktrees/project/lane', '${PASEO_HOME}/worktrees/project/lane', 'wks_…']) {
      writeFileSync(join(recordDir, 'tasks.md'), `agent ${member}\n${ambiguous}`);
      const incomplete = []; const records = collectSupervisors(dir, incomplete);
      assert.equal(records[0].scopeComplete, false); assert.equal(incomplete[0].scope, undefined);
      const global = classify({ ...snapshot, meta: { ...fixture.meta, gaps: incomplete }, supervisors: records }); assert.ok(global.workspaces.every(w => w.verdict !== 'batch_candidate'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R3 P2 Unicode and plus refs agree with Git and query failures stay local', async () => {
  const { validRefName, assertReadOnlyCommand, inspectGit } = await import('./scan.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-refs-')), repo = join(dir, 'repo'), bin = join(dir, 'bin');
  const originalPath = process.env.PATH;
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    mkdirSync(repo); mkdirSync(bin);
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'tracked'), 'fixture'); git('add', 'tracked'); git('commit', '-m', 'fixture'); git('remote', 'add', 'origin', 'https://github.com/fake-owner/fake-project.git');
    const refs = ['refs/remotes/origin/release+v2', 'refs/remotes/origin/개발', 'refs/heads/emoji-🌱', 'refs/heads/@', 'refs/heads/a.lock', 'refs/heads/a..b', 'refs/heads/.hidden', 'refs/heads/a@{b', 'refs/heads/a b', 'refs/heads/a[b', 'refs/heads/a\\b', 'refs/heads/a/', 'refs/heads/a.'];
    for (const ref of refs) {
      const format = spawnSync('git', ['check-ref-format', ref]); assert.equal(validRefName(ref), format.status === 0, ref);
      if (format.status === 0) {
        assert.doesNotThrow(() => assertReadOnlyCommand('git', ['-C', repo, 'merge-base', '--is-ancestor', 'HEAD', ref]));
        git('update-ref', ref, 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', ref);
        const gaps = [], result = inspectGit(repo, {}, gaps, new Map()); assert.equal(result.mergedIntoDefault, true, ref); assert.deepEqual(result.errors, []);
      } else assert.throws(() => assertReadOnlyCommand('git', ['-C', repo, 'merge-base', '--is-ancestor', 'HEAD', ref]));
    }
    const realGit = spawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(realGit.startsWith('/'));
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$3" = "symbolic-ref" ] && [ "$5" = "refs/remotes/origin/HEAD" ]; then\n  printf '%s\\n' 'refs/remotes/origin/bad..name'\n  exit 0\nfi\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${originalPath}`;
    const gaps = []; let affected;
    assert.doesNotThrow(() => { affected = inspectGit(repo, {}, gaps, new Map()); });
    assert.ok(affected.errors.some(e => e.command === 'merge-base' && e.code === 'read-query-rejected'));
    assert.ok(gaps.some(g => g.source === 'git' && g.path === repo));
    process.env.PATH = originalPath;
    const unaffected = inspectGit(repo, {}, [], new Map()); assert.equal(unaffected.kind, 'git'); assert.deepEqual(unaffected.errors, []);
  } finally { process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
});

test('R4 collector retains canonical archived worktreeRoot for supervisor ID-to-path protection', async () => {
  const { dir, cwd, options } = syntheticStore();
  try {
    writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ workspaceId: 'wks_archived', cwd, worktreeRoot: dir, kind: 'worktree', archivedAt: '2026-01-02' }]));
    writeFileSync(join(options.stateHome, 'yw-supervisor/fake/tasks.md'), 'workspace wks_archived');
    const snapshot = await collect(options), canonical = (await import('node:fs')).realpathSync(dir);
    assert.equal(snapshot.workspaces[0].worktreeRoot, canonical);
    assert.ok(!snapshot.meta.gaps.some(g => g.reason === 'supervisor_workspace_unresolved'));
    writeFileSync(join(options.stateHome, 'yw-supervisor/fake/tasks.md'), 'workspace wks_missing');
    const unresolved = await collect(options); assert.ok(unresolved.meta.gaps.some(g => g.reason === 'supervisor_workspace_unresolved' && !g.scope));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R4 plan summary displays live and terminal coverage plus global blocker counts', async () => {
  const { planMarkdown } = await import('./scan.mjs'); const { classify } = await import('./classify.mjs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/base.json', import.meta.url)));
  const snapshot = { ...fixture, meta: { ...fixture.meta, gaps: [{ source: 'live', reason: 'live_missing' }] }, agents: [{ ...fixture.fixtureAgent, statusSource: 'store' }], workspaces: [{ workspaceId: 'wks_fake', cwd: '/fake/workspace', kind: 'directory', checks: { terminals: 'unchecked' } }] };
  snapshot.classification = classify(snapshot); const plan = planMarkdown(snapshot);
  assert.match(plan, /Live 관측: 0\/1 비보관 agent; 저장값 대체 1/); assert.match(plan, /터미널 관측\(고유 cwd\): 0\/1/); assert.match(plan, /unchecked=1/); assert.match(plan, /전역 차단 gap\(사유별 건수\): \{"live_missing":1\}/);
});

test('R4 deployed skill directory symlink runs CLI entry point', async () => {
  const { symlinkSync } = await import('node:fs'), { resolve } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-cli-link-'));
  try {
    const link = join(dir, 'installed-skill'); symlinkSync(resolve(new URL('.', import.meta.url).pathname), link);
    const result = spawnSync(process.execPath, [join(link, 'scan.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^Usage:/); assert.match(result.stdout, /--terminals/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R6 global terminal observation confirms all absent cwd and protects listed descendants', async () => {
  const { normalizeTerminals, observePath } = await import('./scan.mjs');
  const gaps = [], collectedAt = '2026-01-01T00:00:00Z';
  let observations = normalizeTerminals({ scope: 'all', collectedAt, terminals: [] }, gaps);
  for (const cwd of ['/fake/one', '/fake/two/sub']) assert.equal(observePath(cwd, {}, observations, gaps).checks.terminals, 'confirmed_none');
  observations = normalizeTerminals({ scope: 'all', collectedAt, terminals: [{ cwd: '/fake/one/sub', title: 'private fixture text' }] }, gaps);
  assert.equal(observePath('/fake/one', {}, observations, gaps).checks.terminals, 'present');
  assert.equal(observePath('/fake/one/sub', {}, observations, gaps).checks.terminals, 'present');
  assert.equal(observePath('/fake/unrelated', {}, observations, gaps).checks.terminals, 'confirmed_none');
  assert.doesNotMatch(JSON.stringify(observations), /private fixture/); assert.deepEqual(gaps, []);
});
for (const invalid of [{ scope: 'all', terminals: [] }, { scope: 'all', collectedAt: 'invalid', terminals: [] }, { scope: 'all', collectedAt: '2026-01-01', terminals: [null] }, { scope: 'all', collectedAt: '2026-01-01', terminals: [{}] }, { scope: 'all', collectedAt: '2026-01-01', terminals: [{ cwd: 'relative' }] }, { scope: 'other', observations: [] }]) test(`R6 malformed global terminals cannot confirm absence ${JSON.stringify(invalid)}`, async () => {
  const { normalizeTerminals, observePath } = await import('./scan.mjs');
  const gaps = [], observations = normalizeTerminals(invalid, gaps);
  assert.equal(observePath('/fake/one', {}, observations, gaps).checks.terminals, 'unchecked'); assert.equal(gaps.length, 1); assert.equal(gaps[0].scope, undefined);
});
test('R6 live missing agents create a scoped gap while global terminals allow an unrelated workspace batch', async () => {
  const { dir, cwd, options } = syntheticStore();
  try {
    const own = join(dir, 'missing-cwd'), parentCwd = join(dir, 'parent-cwd'); mkdirSync(own); mkdirSync(parentCwd);
    const missing = '22222222-2222-4222-8222-222222222222', parent = '33333333-3333-4333-8333-333333333333';
    const agent = (id, cwd, workspaceId, labels = {}) => ({ id, cwd, workspaceId, labels, lastStatus: 'closed', lastActivityAt: '2026-01-01T00:00:00Z' });
    writeFileSync(join(dir, 'agents/fake/missing.json'), JSON.stringify(agent(missing, own, 'wks_missing', { 'paseo.parent-agent-id': parent })));
    writeFileSync(join(dir, 'agents/fake/parent.json'), JSON.stringify(agent(parent, parentCwd, 'wks_parent')));
    writeFileSync(options.live, JSON.stringify(observation('live', { [parent]: { status: 'closed' } })));
    writeFileSync(options.terminals, JSON.stringify(observation('terminals', { terminals: [] })));
    writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ ...oldWorkspace, workspaceId: 'wks_fake', cwd, kind: 'directory' }, { ...oldWorkspace, workspaceId: 'wks_missing', cwd: own, kind: 'directory' }, { ...oldWorkspace, workspaceId: 'wks_parent', cwd: parentCwd, kind: 'directory' }]));
    const s = await collect(options), gap = s.meta.gaps.find(g => g.reason === 'live_missing');
    assert.deepEqual(gap.scope, { agentIds: [missing] });
    assert.equal(s.agents.find(a => a.id === missing).statusSource, 'store');
    assert.equal(s.classification.agents.find(a => a.id === missing).work, 'unknown');
    assert.equal(s.classification.agents.find(a => a.id === parent).work, 'waiting_work');
    assert.notEqual(s.classification.workspaces.find(w => w.id === 'wks_missing').verdict, 'batch_candidate');
    assert.equal(s.classification.workspaces.find(w => w.id === 'wks_parent').verdict, 'exclude');
    assert.equal(s.classification.workspaces.find(w => w.id === 'wks_fake').verdict, 'batch_candidate');
    assert.ok(s.workspaces.every(w => w.checks.terminals === 'confirmed_none'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
for (const content of [undefined, '{', 'null', '[]']) test(`R6 unavailable live map stays globally blocking ${content}`, async () => {
  const { dir, options } = syntheticStore();
  try {
    if (content === undefined) delete options.live; else writeFileSync(options.live, content);
    const s = await collect(options); assert.equal(s.classification.workspaces[0].verdict, 'review');
    assert.ok(s.meta.gaps.some(g => !g.scope && (g.source === 'live' || g.source === options.live)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7 directories without tasks are informational and do not block otherwise eligible resources', async () => {
  const { dir, options } = syntheticStore();
  try {
    const taskDir = join(options.stateHome, 'yw-supervisor/unrelated-work'); mkdirSync(taskDir); writeFileSync(join(taskDir, 'orders.json'), '{}');
    const s = await collect(options);
    assert.deepEqual(s.meta.supervisorDirsWithoutTasks, ['unrelated-work']);
    assert.ok(!s.meta.gaps.some(g => g.source?.includes('unrelated-work')));
    assert.equal(s.supervisors.length, 1); assert.equal(s.classification.workspaces[0].verdict, 'batch_candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R7 lstat success followed by read ENOENT remains a global protection gap', async () => {
  const { dir, options } = syntheticStore();
  try {
    const taskDir = join(options.stateHome, 'yw-supervisor/disappeared'); mkdirSync(taskDir);
    const file = join(taskDir, 'tasks.md'); symlinkSync(join(dir, 'gone-after-enumeration.md'), file);
    const s = await collect(options), gap = s.meta.gaps.find(g => g.source === file);
    assert.equal(gap.reason, 'ENOENT'); assert.equal(gap.scope, undefined);
    assert.deepEqual(s.meta.supervisorDirsWithoutTasks, []);
    assert.equal(s.classification.workspaces[0].verdict, 'review');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('R7 unreadable existing tasks stay globally blocking', { skip: process.getuid?.() === 0 ? 'root bypasses Unix read permission bits' : false }, async () => {
  const { dir, options } = syntheticStore(), file = join(options.stateHome, 'yw-supervisor/fake/tasks.md');
  try {
    chmodSync(file, 0o000);
    const s = await collect(options), gap = s.meta.gaps.find(g => g.source === file);
    assert.ok(['EACCES', 'EPERM'].includes(gap.reason)); assert.equal(gap.scope, undefined);
    assert.deepEqual(s.meta.supervisorDirsWithoutTasks, []); assert.equal(s.classification.workspaces[0].verdict, 'review');
  } finally { chmodSync(file, 0o600); rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ['live', 'pending', 'terminals']) test(`#68 R3 ${kind} provenance errors fail closed at collection boundary`, async () => {
  const { dir, options } = syntheticStore();
  try {
    const valid = JSON.parse(readFileSync(options[kind], 'utf8'));
    for (const change of [{ serverId: 'srv_other' }, { observedAt: undefined }, { observedAt: '2026-01-01T00:00:00Z' }, { scope: undefined }]) {
      writeFileSync(options[kind], JSON.stringify({ ...valid, ...change }));
      const s = await collect(options); assert.equal(s.meta.inputObservations[kind].state, 'unchecked'); assert.notEqual(s.classification.workspaces[0].verdict, 'batch_candidate');
      assert.ok(s.meta.gaps.some(g => g.source === kind && g.reason.startsWith('input_')));
      if (kind === 'terminals') { assert.equal(s.workspaces[0].checks.terminals, 'unchecked'); assert.ok(!s.classification.agents[0].reasons.some(r => r.startsWith('protection_gap:input_'))); }
      else assert.ok(s.classification.workspaces[0].reasons.some(r => r.startsWith('protection_gap:input_')));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#68 R3 validated envelopes preserve input observation time separately from scan time', async () => {
  const { dir, options } = syntheticStore();
  try {
    const s = await collect(options);
    assert.equal(s.classification.workspaces[0].verdict, 'batch_candidate');
    for (const kind of ['live', 'pending', 'terminals']) { assert.equal(s.meta.inputObservations[kind].state, 'confirmed'); assert.equal(s.meta.inputObservations[kind].serverId, 'srv_fixture'); assert.equal(s.meta.inputObservations[kind].observedAt, JSON.parse(readFileSync(options[kind], 'utf8')).observedAt); }
    assert.ok(s.meta.collectedAt); assert.equal(s.meta.options.maxInputAgeMinutes, 30);
    for (const value of [null, [], false, undefined]) {
      const input = observation('live', {}); input.agents = value; writeFileSync(options.live, JSON.stringify(input));
      const bad = await collect(options); assert.notEqual(bad.classification.workspaces[0].verdict, 'batch_candidate'); assert.ok(bad.meta.gaps.some(g => g.reason === 'expected agent status map' && !g.scope));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#68 R3 legacy live pending and terminal shapes are retained as unchecked', async () => {
  const { dir, options } = syntheticStore();
  try {
    writeFileSync(options.live, '{}'); writeFileSync(options.pending, '[]'); writeFileSync(options.terminals, JSON.stringify({ observations: [{ cwd: join(dir, 'directory'), terminals: [] }] }));
    const s = await collect(options); assert.ok(Object.values(s.meta.inputObservations).every(i => i.state === 'unchecked')); assert.notEqual(s.classification.workspaces[0].verdict, 'batch_candidate'); assert.equal(s.workspaces[0].checks.terminals, 'unchecked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#68 F8 unavailable version stays null with a protection gap', async () => {
  const { dir, options } = syntheticStore();
  try {
    rmSync(join(dir, 'version.json')); options.paseoInfoPlist = join(dir, 'not-installed/Info.plist');
    const s = await collect(options); assert.equal(s.meta.paseoVersion, null); assert.ok(s.meta.gaps.some(g => g.reason === 'paseo_version_unknown')); assert.notEqual(s.classification.workspaces[0].verdict, 'batch_candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#68 F8 and F7 stored unknown schedule and canonical ownership fields remain visible', async () => {
  const { dir, cwd, options } = syntheticStore();
  try {
    writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ ...oldWorkspace, workspaceId: 'wks_fake', cwd, mainRepoRoot: join(cwd, '..'), worktreeRoot: cwd, isPaseoOwnedWorktree: true, kind: 'directory' }]));
    writeFileSync(join(dir, 'schedules/unknown.json'), JSON.stringify({ id: 'unknown', target: { type: 'new-agent', cwd }, status: 'new-version-state' }));
    const s = await collect(options); assert.equal(s.workspaces[0].worktreeRoot, s.workspaces[0].cwd); assert.ok(s.workspaces[0].mainRepoRoot.startsWith('/')); assert.ok(s.meta.gaps.some(g => g.reason === 'schedule_status_unknown')); assert.ok(s.classification.workspaces[0].hold.includes('schedule_dependency')); assert.ok(s.classification.workspaces[0].hold.includes('data'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('#68 R5 explicit and invalid selections never permit unselected excerpt reading', async () => {
  const { dir, options } = syntheticStore();
  try {
    const ids = join(dir, 'ids.json'), selected = '11111111-1111-4111-8111-111111111111';
    writeFileSync(ids, JSON.stringify([selected]));
    let s = await collect({ ...options, excerptIds: ids }); assert.deepEqual(s.meta.excerptSelection, { mode: 'selected_ids', count: 1 }); assert.ok(!s.meta.warnings.length); assert.ok(s.agents[0].excerptReason, 'explicit historical target is processed');
    for (const value of [null, ['short-id'], {}]) { writeFileSync(ids, JSON.stringify(value)); s = await collect({ ...options, excerpts: true, excerptIds: ids }); assert.equal(s.meta.excerptSelection.count, 0); assert.equal(s.agents[0].excerptReason, undefined); assert.ok(s.meta.gaps.some(g => g.reason === 'excerpt_ids_invalid')); }
    s = await collect({ ...options, excerpts: true }); assert.ok(s.meta.gaps.some(g => g.reason === 'excerpt_ids_required')); assert.equal(s.meta.excerptSelection.mode, 'blocked_missing_ids'); assert.equal(s.meta.excerptSelection.count, 0); assert.equal(s.agents[0].excerptReason, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#68 F7 malformed ownership fields cannot downgrade a destructive workspace to safe local', async () => {
  const { dir, cwd, options } = syntheticStore();
  try {
    for (const change of [{ mainRepoRoot: {} }, { worktreeRoot: 1 }, { mainRepoRoot: 'relative/path' }, { isPaseoOwnedWorktree: 'yes' }]) {
      writeFileSync(join(dir, 'projects/workspaces.json'), JSON.stringify([{ ...oldWorkspace, workspaceId: 'wks_fake', cwd, mainRepoRoot: cwd, worktreeRoot: cwd, isPaseoOwnedWorktree: true, ...change }]));
      const s = await collect(options); assert.ok(s.meta.gaps.some(g => g.reason === 'invalid workspace ownership schema')); assert.notEqual(s.classification.workspaces[0].verdict, 'batch_candidate');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
