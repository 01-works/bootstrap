import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const BODY = 'AAAAC3NzaC1lZDI1NTE5AAAAIVerifierTestKey0123456789abcdefghijklmnop';
const COLIMA = '# Number of CPUs\ncpu: 2\n\n# Size of the memory in GiB\nmemory: 2\n\nvz:\n  memory: 9\n';
const mode = path => statSync(path).mode & 0o777;
const read = path => existsSync(path) ? readFileSync(path, 'utf8') : null;

// 샌드박스 저장소와 임시 HOME. 실제 role.sh를 쓰고 lib.sh 끝에 대역(원격 로그인·기기 종류·colima)을 붙인다.
// launch-agents.mjs는 대역으로 바꿔 받은 인자만 기록한다. 실제 launchctl·홈·colima는 건드리지 않는다.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-role-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), mock = join(root, 'mock');
  for (const dir of [join(root, 'scripts'), home, mock]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, 'scripts/verifier-logs.sh'), join(root, 'scripts/verifier-logs.sh'));
  writeFileSync(join(root, 'scripts/lib.sh'), readFileSync(join(repo, 'scripts/lib.sh'), 'utf8') + `
sharing_enabled() { [[ "$1" == com.openssh.sshd && ! -e "$MOCK/sshd-off" ]]; }
is_laptop() { return 1; }
colima() { [[ "$1" == status && -e "$MOCK/colima-running" ]]; }
`);
  writeFileSync(join(root, 'scripts/launch-agents.mjs'), `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK + '/agents', args.join(' ') + '\\n');
const code = process.env.MOCK + '/agents-exit' + (args.includes('--check') ? '-check' : '');
process.exitCode = existsSync(code) ? Number(readFileSync(code, 'utf8')) : 0;
`);
  const env = { ...process.env, HOME: home, MOCK: mock, BOOTSTRAP_ROOT: root, XDG_STATE_HOME: join(root, 'state'),
    BOOTSTRAP_BREW_PREFIX: join(root, 'no-brew'), DRY_RUN: '0', ASSUME_YES: '0' };
  for (const key of ['XDG_CONFIG_HOME', 'COLIMA_HOME', 'BOOTSTRAP_LOCKED', 'BOOTSTRAP_UNATTENDED', 'BOOTSTRAP_RESULTS']) delete env[key];
  const keyFile = join(root, 'key.pub');
  writeFileSync(keyFile, `ssh-ed25519 ${BODY} reader@other-mac\n`);
  const colima = join(home, '.colima/default/colima.yaml');
  mkdirSync(join(colima, '..'), { recursive: true });
  writeFileSync(colima, COLIMA, { mode: 0o644 });
  const paths = {
    state: join(home, '.config/bootstrap/roles/verifier'), colima, keyFile,
    ssh: join(home, '.ssh'), auth: join(home, '.ssh/authorized_keys'),
    bin: join(home, '.local/bin/verifier-logs'), logs: join(home, '.local/state/verifier/logs'),
  };
  const line = `restrict,command="${paths.bin}" ssh-ed25519 ${BODY} bootstrap-role-verifier`;
  return {
    root, home, mock, env, line, ...paths,
    role: (...args) => spawnSync('/bin/bash', [join(repo, 'scripts/role.sh'), ...args], { env, encoding: 'utf8' }),
    // 대역 launch-agents.mjs가 받은 호출을 돌려주고 비운다.
    agents() { const lines = (read(join(mock, 'agents')) || '').split('\n').filter(Boolean); rmSync(join(mock, 'agents'), { force: true }); return lines; },
    stateOf: () => Object.fromEntries((read(paths.state) || '').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
    memory: () => /^memory: (\S+)$/m.exec(readFileSync(colima, 'utf8'))[1],
  };
}
const out = result => result.stdout + result.stderr;

// 디렉터리 아래 모든 파일의 내용·권한 (바뀌지 않았는지 비교용).
function tree(dir) {
  const result = {};
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name), s = statSync(p);
      if (s.isDirectory()) { result[p] = `dir ${s.mode & 0o777}`; walk(p); } else result[p] = `${s.mode & 0o777} ${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return result;
}

test('처음 켤 때 --ssh-key가 없으면 아무것도 바꾸지 않고 실패한다', t => {
  const f = sandbox(t);
  const before = tree(f.home);
  const result = f.role('add', 'verifier');
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /--ssh-key/);
  assert.deepEqual(tree(f.home), before);
  assert.deepEqual(f.agents(), []);
  for (const args of [['add'], ['add', 'builder'], ['nope'], []]) assert.equal(f.role(...args).status, 1, args.join(' '));
  writeFileSync(f.keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nxxx\n-----END OPENSSH PRIVATE KEY-----\n');
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 1, '공개키가 아니면 거부');
  assert.equal(f.role('add', 'verifier', '--ssh-key', join(f.root, 'missing.pub')).status, 1);
  assert.deepEqual(tree(f.home), before);
});

test('켜기: colima 메모리와 이전 값, 정확한 키 한 줄과 권한, 강제 명령·로그 디렉터리, 자동 시작 끄기. 다시 실행해도 그대로', t => {
  const f = sandbox(t);
  mkdirSync(f.ssh, { mode: 0o755 });
  chmodSync(f.ssh, 0o755);
  writeFileSync(f.auth, 'ssh-rsa AAAAOTHER other@host', { mode: 0o644 });
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 0, out(result));

  assert.equal(readFileSync(f.colima, 'utf8'), COLIMA.replace('memory: 2', 'memory: 6'), '최상위 memory 한 줄만, 기본 6 GiB');
  assert.equal(mode(f.colima), 0o644);
  const state = f.stateOf();
  assert.equal(state.colima_memory, '6');
  assert.equal(state.colima_memory_before, '2');
  assert.equal(state.ssh_key_line, `ssh-ed25519 ${BODY}`);
  assert.match(state.added_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(mode(f.state), 0o600);

  assert.equal(readFileSync(f.auth, 'utf8'), `ssh-rsa AAAAOTHER other@host\n${f.line}\n`, '기존 줄 보존, 정확한 한 줄 추가');
  assert.equal(mode(f.ssh), 0o700);
  assert.equal(mode(f.auth), 0o600);
  assert.equal(readFileSync(f.bin, 'utf8'), readFileSync(join(repo, 'scripts/verifier-logs.sh'), 'utf8'));
  assert.equal(mode(f.bin), 0o755);
  assert.equal(mode(f.logs), 0o700);
  assert.deepEqual(f.agents(), ['--only agent-chrome --desktop', '--only paseo --desktop', '--only paseo-upgrade --desktop'],
    '상태 파일을 쓴 뒤 launch-agents.mjs가 세 등록을 끈다');

  const snapshot = tree(f.home);
  result = f.role('add', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(tree(f.home), snapshot, '다시 실행하면 저장된 값으로 같은 결과');
  result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(tree(f.home), snapshot);

  writeFileSync(join(f.mock, 'colima-running'), '');
  result = f.role('add', 'verifier', '--colima-memory', '8');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.memory(), '8');
  assert.equal(f.stateOf().colima_memory, '8');
  assert.equal(f.stateOf().colima_memory_before, '2', '원래 값은 처음 것만');
  assert.match(result.stdout, /다음 시작부터 적용/, '실행 중인 VM은 다시 시작하지 않는다');
  assert.equal(f.role('add', 'verifier', '--colima-memory', '0').status, 1);
  assert.equal(f.role('add', 'verifier', '--colima-memory', '6GiB').status, 1);

  writeFileSync(f.keyFile, `ssh-ed25519 ${BODY}OTHER reader@other-mac\n`);
  const before = tree(f.home);
  result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 1, '저장된 키와 다르면 실패');
  assert.match(result.stderr, /role remove verifier/);
  assert.deepEqual(tree(f.home), before);
});

test('같은 키가 제한 없는 다른 줄에 있으면 고치지 않고 실패한다', t => {
  const f = sandbox(t);
  mkdirSync(f.ssh, { mode: 0o700 });
  const original = `ssh-rsa AAAAOTHER other\nssh-ed25519 ${BODY} me@laptop\n`;
  writeFileSync(f.auth, original, { mode: 0o600 });
  const before = tree(f.home);
  const result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /줄 2.*같은 키/);
  assert.deepEqual(tree(f.home), before, '상태 파일·colima·authorized_keys 모두 그대로');
  assert.deepEqual(f.agents(), []);

  // 켠 뒤에 누가 무제한 줄을 넣으면 status가 실패로 알리고, add도 고치지 않는다.
  writeFileSync(f.auth, 'ssh-rsa AAAAOTHER other\n');
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(f.auth, `${readFileSync(f.auth, 'utf8')}ssh-ed25519 ${BODY} me@laptop\n`);
  const status = f.role('status', 'verifier');
  assert.equal(status.status, 1, out(status));
  assert.match(status.stderr, /읽기 전용이 아님/);
  const text = readFileSync(f.auth, 'utf8');
  assert.equal(f.role('add', 'verifier').status, 1);
  assert.equal(readFileSync(f.auth, 'utf8'), text);
});

test('status 종료 코드: 준비 0, 원격 로그인 꺼짐 2, 어긋남·꺼짐 1', t => {
  const f = sandbox(t);
  let result = f.role('status', 'verifier');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verifier 꺼짐/);
  result = f.role('status');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /기기 역할 없음/);

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  f.agents();
  const before = tree(f.home);
  result = f.role('status', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.ok(result.stdout.includes(`log_dir=${f.logs}\n`), '로그 디렉터리 경로를 알린다');
  assert.deepEqual(f.agents(), ['--check --only agent-chrome --desktop', '--check --only paseo --desktop', '--check --only paseo-upgrade --desktop']);
  assert.deepEqual(tree(f.home), before, 'status는 아무것도 바꾸지 않는다');
  assert.equal(f.role('status').status, 0);

  writeFileSync(join(f.mock, 'sshd-off'), '');
  result = f.role('status', 'verifier');
  assert.equal(result.status, 2, out(result));
  assert.match(result.stderr, /원격 로그인 꺼짐/);
  assert.equal(f.role('add', 'verifier').status, 2, 'add도 원격 로그인은 사람에게 맡긴다');
  writeFileSync(join(f.mock, 'agents-exit-check'), '2');
  assert.equal(f.role('status', 'verifier').status, 2, '실행 중이라 등록만 남은 것은 대기');
  rmSync(join(f.mock, 'sshd-off'));
  rmSync(join(f.mock, 'agents-exit-check'));

  for (const [label, breakIt, fix] of [
    ['authorized_keys 권한', () => chmodSync(f.auth, 0o644), () => chmodSync(f.auth, 0o600)],
    ['자동 시작 남음', () => writeFileSync(join(f.mock, 'agents-exit-check'), '1'), () => rmSync(join(f.mock, 'agents-exit-check'))],
    ['verifier-logs 다름', () => writeFileSync(f.bin, 'changed'), () => copyFileSync(join(repo, 'scripts/verifier-logs.sh'), f.bin)],
    ['colima 값 다름', () => writeFileSync(f.colima, COLIMA), () => writeFileSync(f.colima, COLIMA.replace('memory: 2', 'memory: 6'))],
    ['로그 디렉터리 권한', () => chmodSync(f.logs, 0o755), () => chmodSync(f.logs, 0o700)],
  ]) {
    breakIt();
    assert.equal(f.role('status', 'verifier').status, 1, label);
    fix();
    assert.equal(f.role('status', 'verifier').status, 0, `${label} 복구`);
  }
});

test('colima 설정이 없으면 수동 작업 대기로 두고 나머지는 적용한다', t => {
  const f = sandbox(t);
  rmSync(join(f.home, '.colima'), { recursive: true });
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 2, out(result));
  assert.match(result.stderr, /colima start --memory 6/);
  assert.equal(readFileSync(f.auth, 'utf8'), `${f.line}\n`);
  assert.equal(f.stateOf().colima_memory_before, '');
  assert.equal(f.role('status', 'verifier').status, 2);
  assert.equal(existsSync(join(f.home, '.colima')), false, 'colima 설정·템플릿을 만들지 않는다');

  mkdirSync(join(f.colima, '..'), { recursive: true });
  writeFileSync(f.colima, COLIMA);
  result = f.role('add', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.memory(), '6');
  assert.equal(f.stateOf().colima_memory_before, '2');
});

test('끄기: 원래 값으로 되돌리고, 그 줄만 지우고, 로그는 보존하고, 다시 실행해도 같다', t => {
  const f = sandbox(t);
  mkdirSync(f.ssh, { mode: 0o700 });
  writeFileSync(f.auth, 'ssh-rsa AAAAOTHER other\n', { mode: 0o600 });
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(join(f.logs, 'run.log'), 'kept\n');
  f.agents();

  let result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.equal(readFileSync(f.colima, 'utf8'), COLIMA);
  assert.equal(readFileSync(f.auth, 'utf8'), 'ssh-rsa AAAAOTHER other\n', '그 줄만 지운다');
  assert.equal(mode(f.auth), 0o600);
  assert.equal(existsSync(f.bin), false);
  assert.equal(readFileSync(join(f.logs, 'run.log'), 'utf8'), 'kept\n', '로그는 지우지 않는다');
  assert.match(result.stdout, /로그를 보존합니다/);
  assert.equal(existsSync(f.state), false);
  assert.deepEqual(f.agents(), ['--only agent-chrome --desktop', '--only paseo --desktop', '--only paseo-upgrade --desktop'],
    '상태 파일을 지운 뒤 자동 시작을 원래대로');

  const snapshot = tree(f.home);
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(tree(f.home), snapshot, '다시 실행해도 같다');

  rmSync(join(f.logs, 'run.log'));
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.equal(existsSync(join(f.home, '.local/state/verifier')), false, '빈 로그 디렉터리는 정리');

  // 켠 뒤 사람이 colima 값을 바꿨으면 되돌리지 않는다. 원본과 다른 verifier-logs도 그대로 둔다.
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(f.colima, COLIMA.replace('memory: 2', 'memory: 4'));
  writeFileSync(f.bin, 'local edit\n');
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.memory(), '4');
  assert.match(result.stderr, /그대로 둡니다/);
  assert.equal(readFileSync(f.bin, 'utf8'), 'local edit\n');

  writeFileSync(join(f.mock, 'agents-exit'), '1');
  assert.equal(f.role('remove', 'verifier').status, 1, '자동 시작을 되돌리지 못하면 실패');
});

test('dry-run은 아무것도 바꾸지 않는다', t => {
  const f = sandbox(t);
  const before = tree(f.home);
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile, '--dry-run');
  assert.equal(result.status, 0, out(result));
  assert.match(result.stdout, /\[dry-run\] colima 메모리 2 → 6 GiB/);
  assert.deepEqual(tree(f.home), before);
  assert.equal(existsSync(join(f.root, 'state/bootstrap/lock')), false);
  assert.ok(f.agents().every(call => call.endsWith('--dry-run')), 'launch-agents.mjs에도 dry-run');

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(join(f.logs, 'x.log'), '');
  const on = tree(f.home);
  result = f.role('remove', 'verifier', '--dry-run');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(tree(f.home), on);
});

test('apply-active: 켠 역할이 없으면 아무것도 하지 않고, 있으면 저장된 값으로 다시 맞춘다', t => {
  const f = sandbox(t);
  const before = tree(f.home);
  let result = f.role('apply-active');
  assert.equal(result.status, 0, out(result));
  assert.match(result.stdout, /기기 역할 없음/);
  assert.deepEqual(tree(f.home), before);
  assert.deepEqual(f.agents(), []);

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile, '--colima-memory', '7').status, 0);
  writeFileSync(f.colima, COLIMA);
  rmSync(f.bin);
  writeFileSync(f.auth, '');
  result = f.role('apply-active');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.memory(), '7');
  assert.ok(existsSync(f.bin));
  assert.equal(readFileSync(f.auth, 'utf8'), `${f.line}\n`);
});

test('설치·자동 갱신 잠금을 잡고 끝나면 푼다. 이미 잡은 실행 안에서는 이어서 쓴다', t => {
  const f = sandbox(t);
  const lock = join(f.root, 'state/bootstrap/lock');
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  assert.equal(existsSync(lock), false, '끝나면 잠금을 푼다');
  // 다른 살아 있는 실행이 잡은 잠금: 기다린다. 그 실행(이 테스트 프로세스)의 하위 실행으로 부르면 이어서 쓴다.
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  const waited = spawnSync('/bin/bash', [join(repo, 'scripts/role.sh'), 'remove', 'verifier'], { env: f.env, encoding: 'utf8', timeout: 1500 });
  assert.equal(waited.signal, 'SIGTERM', '다른 실행이 끝나기를 기다린다');
  assert.ok(existsSync(f.state), '기다리는 동안 바꾸지 않는다');
  const inherited = spawnSync('/bin/bash', [join(repo, 'scripts/role.sh'), 'apply-active'],
    { env: { ...f.env, BOOTSTRAP_LOCKED: String(process.pid) }, encoding: 'utf8' });
  assert.equal(inherited.status, 0, out(inherited));
  assert.ok(existsSync(lock), '물려받은 잠금은 풀지 않는다');
});

test('bash 3.2 문법만 쓴다', () => {
  for (const file of ['role.sh', 'verifier-logs.sh', 'steps/90-roles.sh'].map(name => join(repo, 'scripts', name))) {
    const syntax = spawnSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const source = readFileSync(file, 'utf8');
    // ko_KR 로캘의 bash 3.2는 변수 이름 바로 뒤의 비ASCII 문자를 이름의 일부로 읽는다: ${memory} 처럼 쓴다.
    assert.doesNotMatch(source, /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/, `${file}: 변수 뒤에 붙은 비ASCII 문자`);
    for (const pattern of [/declare -A/, /\bmapfile\b/, /\breadarray\b/, /\$\{[^}]*,,\}/, /\$\{[^}]*\^\^\}/, /\|&/, /&>>/]) {
      assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
    }
  }
});
