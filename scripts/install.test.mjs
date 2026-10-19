import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

// 원본 저장소 대역: bootstrap.sh는 받은 인자만 기록한다.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-install-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source/bootstrap');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'bootstrap.sh'), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(root, 'calls'))}\n`, { mode: 0o755 });
  const git = (...args) => spawnSync('git', args, { cwd: source, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  const runEnv = (extraEnv, dir, ...args) => spawnSync('/bin/bash', ['-c', readFileSync(installer, 'utf8'), 'install', ...args], {
    env: { ...process.env, ...gitEnv, ...extraEnv, BOOTSTRAP_REPO: source, BOOTSTRAP_DIR: dir }, encoding: 'utf8'
  });
  const calls = () => readFileSync(join(root, 'calls'), 'utf8');
  const run = (dir, ...args) => runEnv({}, dir, ...args);
  return { root, source, git, run, runEnv, calls };
}

test('처음엔 받아서 실행하고, 다시 실행하면 갱신 후 실행하며 인자를 넘긴다', t => {
  const f = fixture(t);
  const dir = join(f.root, 'home/dev/bootstrap');
  const first = f.run(dir, '--dry-run');
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(dir, '.git')));
  writeFileSync(join(f.source, 'NEW'), 'x');
  f.git('add', '.');
  f.git('commit', '-q', '-m', 'next');
  const second = f.run(dir);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(existsSync(join(dir, 'NEW')), 'fast-forward 갱신');
  assert.equal(f.calls(), '--dry-run\n\n');
});

test('git 저장소가 아닌 폴더나 다른 저장소는 건드리지 않고 멈춘다', t => {
  const f = fixture(t);
  const plain = join(f.root, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'keep'), 'mine');
  const result = f.run(plain);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git 저장소가 아닙니다/);
  assert.equal(readFileSync(join(plain, 'keep'), 'utf8'), 'mine');
  const other = join(f.root, 'other');
  mkdirSync(other);
  spawnSync('git', ['init', '-q'], { cwd: other });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/else.git'], { cwd: other });
  assert.match(f.run(other).stderr, /다른 저장소/);
  assert.equal(existsSync(join(f.root, 'calls')), false);
});


test('설치 진입점은 Apple Silicon·Intel만 받고 macOS가 아닌 환경은 변경하지 않는다', t => {
  const f = fixture(t);
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'uname'), `#!/bin/sh
case "$1" in
  -s) printf '%s\\n' "$BOOTSTRAP_TEST_OS" ;;
  -m) printf '%s\\n' "$BOOTSTRAP_TEST_CPU" ;;
  *) exec /usr/bin/uname "$@" ;;
esac
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, BOOTSTRAP_TEST_OS: 'Darwin' };
  for (const cpu of ['arm64', 'x86_64']) {
    const result = f.runEnv({ ...env, BOOTSTRAP_TEST_CPU: cpu }, join(f.root, cpu), '--dry-run');
    assert.equal(result.status, 0, result.stderr);
  }
  const before = f.calls();
  for (const [os, cpu] of [['Darwin', 'i386'], ['Linux', 'x86_64']]) {
    const dir = join(f.root, `${os}-${cpu}`);
    const result = f.runEnv({ ...env, BOOTSTRAP_TEST_OS: os, BOOTSTRAP_TEST_CPU: cpu }, dir);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(dir), false);
  }
  assert.equal(f.calls(), before);
});
