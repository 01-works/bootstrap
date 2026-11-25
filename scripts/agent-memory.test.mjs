import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, lstatSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./agent-memory.mjs', import.meta.url));
function fixture(t, { settings, codex = 'false' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-agent-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, '.claude/settings.json'), state = join(root, 'codex-memories');
  for (const dir of [dirname(file), join(root, 'bin')]) mkdirSync(dir);
  if (settings !== undefined) writeFileSync(file, settings, { mode: 0o600 });
  writeFileSync(state, codex);
  writeFileSync(join(root, 'bin/codex'), `#!/bin/sh
[ -z "$CODEX_HOME" ] || exit 9
case "$*" in
  'features list') printf 'external_agent_memory_import  under development  true\\nmemories   stable   %s\\n' "$(cat '${state}')" ;;
  'features disable memories') printf false >'${state}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: root, CODEX_HOME: join(root, 'other'), PATH: `${join(root, 'bin')}:/usr/bin:/bin` }, encoding: 'utf8'
  });
  return { root, file, run, codexState: () => readFileSync(state, 'utf8') };
}

test('기존 설정의 다른 값과 권한을 유지하고 메모리 끄기·자동 요약 창만 넣는다. 다시 실행해도 그대로', t => {
  const f = fixture(t, { settings: '{"model":"x","autoMemoryEnabled":true,"permissions":{"allow":["a"]}}', codex: 'true' });
  assert.equal(f.run('--check').status, 1);
  assert.equal(f.run('--dry-run').status, 0);
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).autoMemoryEnabled, true, '미리보기는 바꾸지 않음');
  assert.equal(f.codexState(), 'true');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')),
    { model: 'x', autoMemoryEnabled: false, permissions: { allow: ['a'] }, autoCompactWindow: 400000 });
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.codexState(), 'false');
  assert.deepEqual(readdirSync(dirname(f.file)), ['settings.json'], '임시 파일 없음');
  const after = readFileSync(f.file, 'utf8');
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.file, 'utf8'), after);
  assert.equal(f.run('--check').status, 0);
});

test('기기에서 정한 자동 요약 창은 그대로 둔다', t => {
  const f = fixture(t, { settings: '{"autoMemoryEnabled":false,"autoCompactWindow":600000}' });
  const before = readFileSync(f.file, 'utf8');
  assert.equal(f.run('--check').status, 0);
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});

test('손상된 설정은 그대로 두고 실패하며 Codex는 계속 처리한다', t => {
  const f = fixture(t, { settings: '{broken', codex: 'true' });
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(f.file, 'utf8'), '{broken');
  assert.equal(f.codexState(), 'false');
});

test('저장소 링크는 고치지 않고 실제 값으로 판정한다', t => {
  const f = fixture(t);
  const target = join(f.root, 'repo.json');
  symlinkSync(target, f.file);
  writeFileSync(target, '{}');
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(target, 'utf8'), '{}');
  writeFileSync(target, '{"autoMemoryEnabled":false,"autoCompactWindow":400000}');
  assert.equal(f.run().status, 0);
  assert.ok(lstatSync(f.file).isSymbolicLink());
});

test('설정이 없으면 만들지 않고 알린다', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 1);
  assert.equal(existsSync(f.file), false);
});
