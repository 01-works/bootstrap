import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-shell-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/steps'), { recursive: true });
  copyFileSync(join(repo, 'bootstrap.sh'), join(root, 'bootstrap.sh'));
  copyFileSync(join(repo, 'scripts/lib.sh'), join(root, 'scripts/lib.sh'));
  const run = (...args) => spawnSync('/bin/bash', [join(root, 'bootstrap.sh'), ...args], {
    env: { ...process.env, DRY_RUN: '0', ASSUME_YES: '0' }, encoding: 'utf8'
  });
  return { root, run };
}

test('전체 실행은 doctor 실패·수동 대기를 보존하고 부분 실패 뒤에도 진행한다', t => {
  const { root, run } = sandbox(t);
  writeFileSync(join(root, 'scripts/steps/10-mock.sh'), 'exit 0\n');
  writeFileSync(join(root, 'scripts/doctor.sh'), 'exit 1\n');
  assert.equal(run().status, 1);
  writeFileSync(join(root, 'scripts/doctor.sh'), 'exit 2\n');
  assert.equal(run().status, 2);
  writeFileSync(join(root, 'scripts/doctor.sh'), 'exit 0\n');
  assert.equal(run().status, 0);
  writeFileSync(join(root, 'scripts/steps/20-homebrew.sh'), 'exit 3\n');
  writeFileSync(join(root, 'scripts/steps/30-next.sh'), `touch ${quote(join(root, 'next-ran'))}\n`);
  assert.equal(run('--only', 'homebrew,next').status, 1);
  assert.equal(existsSync(join(root, 'next-ran')), true);
  rmSync(join(root, 'next-ran'));
  writeFileSync(join(root, 'scripts/steps/20-homebrew.sh'), 'exit 1\n');
  assert.equal(run('--only', 'homebrew,next').status, 1);
  assert.equal(existsSync(join(root, 'next-ran')), false, 'Homebrew 자체 실패는 후속 중단');
  writeFileSync(join(root, 'scripts/steps/20-homebrew.sh'), 'exit 2\n');
  assert.equal(run('--only', 'homebrew,next').status, 2);
  assert.equal(existsSync(join(root, 'next-ran')), true);
  writeFileSync(join(root, 'scripts/steps/30-next.sh'), 'exit 1\n');
  assert.equal(run('--only', 'homebrew,next').status, 1, '실패가 대기보다 우선');
});

// 원본 단계는 그대로 실행하고 외부 명령만 셸 함수로 대체한다.
function mockStep(t, name, mocks) {
  const { root } = sandbox(t);
  writeFileSync(join(root, 'scripts/lib.sh'), readFileSync(join(root, 'scripts/lib.sh'), 'utf8') + '\n' + mocks);
  const result = spawnSync('/bin/bash', [join(repo, 'scripts/steps', name)], {
    env: { ...process.env, BOOTSTRAP_ROOT: root, DRY_RUN: '0', ASSUME_YES: '0' }, encoding: 'utf8'
  });
  return { root, result };
}

test('Homebrew bundle 실패는 부분 실패 코드로 전달', t => {
  const { result } = mockStep(t, '20-homebrew.sh', `
uv() { echo 'uv test'; }
brew() { if [[ "$1" == --version ]]; then echo 'Homebrew test'; else return 1; fi; }
`);
  assert.equal(result.status, 3, result.stderr);
});

test('Claude/Codex 실행 실패를 설치 성공으로 처리하거나 덮어쓰지 않는다', t => {
  const { result } = mockStep(t, '60-agents.sh', `
claude() { return 1; }
codex() { return 1; }
paseo() { return 0; }
curl() { echo 'unexpected installer download'; return 99; }
`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude 실행 실패/);
  assert.match(result.stderr, /codex 실행 실패/);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected installer/);
});

test('CLI 기동 검사와 SSH 기본키 상태를 실제 임시 파일로 검사', t => {
  const { root } = sandbox(t);
  const key = join(root, 'id_ed25519');
  const run = expr => spawnSync('/bin/bash', ['-c', `source ${quote(join(repo, 'scripts/lib.sh'))}\n${expr}`], { encoding: 'utf8' });
  const state = () => run(`ssh_key_state ${quote(key)}`).status;
  assert.equal(state(), 1);
  writeFileSync(`${key}.pub`, 'test public key');
  assert.equal(state(), 2);
  writeFileSync(key, '');
  assert.equal(state(), 2);
  writeFileSync(key, 'test private key placeholder');
  assert.equal(state(), 0);
  rmSync(key); rmSync(`${key}.pub`);
  writeFileSync(`${key}.backup`, 'backup is not the configured key');
  assert.equal(state(), 1);
  assert.equal(run('broken() { return 1; }; cli_works broken').status, 1);
  assert.equal(run('healthy() { return 0; }; cli_works healthy').status, 0);
});

test('공개키만 있는 auth 단계는 키를 덮어쓰지 않고 수동 대기를 반환', t => {
  const { result } = mockStep(t, '70-auth.sh', `
gh() { return 0; }
git() { echo 'gh auth git-credential'; }
ssh_key_state() { return 2; }
ssh-keygen() { echo 'unexpected key overwrite'; return 99; }
`);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /불완전/);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected key overwrite/);
});


test('Intel uv 설치 실패는 Brewfile 설치를 막지 않고 부분 실패로 전달', t => {
  const { root, result } = mockStep(t, '20-homebrew.sh', `
uname() { echo x86_64; }
uv() { return 1; }
curl() { echo 'unexpected download'; return 99; }
brew() {
  if [[ "$1" == --version ]]; then echo 'Homebrew test';
  else touch "$BOOTSTRAP_ROOT/bundle-ran"; fi
}
`);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(existsSync(join(root, 'bundle-ran')), true);
  assert.doesNotMatch(result.stdout + result.stderr, /unexpected download/);
});


test('별도 Git 디렉터리를 쓰는 checkout에도 커밋 검사 훅을 설정한다', t => {
  const { root, result } = mockStep(t, '10-xcode.sh', `
xcode-select() { echo '/mock/CommandLineTools'; }
git init -q --separate-git-dir "$BOOTSTRAP_ROOT/git-dir" "$BOOTSTRAP_ROOT"
`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(join(root, '.git'), 'utf8').startsWith('gitdir:'));
  const config = spawnSync('git', ['-C', root, 'config', 'core.hooksPath'], { encoding: 'utf8' });
  assert.equal(config.status, 0, config.stderr);
  assert.equal(config.stdout.trim(), '.githooks');
});
