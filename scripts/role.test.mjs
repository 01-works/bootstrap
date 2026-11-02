import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, chmodSync, readdirSync, symlinkSync } from 'node:fs';
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
// launch-agents.mjs는 대역으로 바꿔 받은 인자만 기록한다. 실제 launchctl·홈·brew services·colima·Docker는 건드리지 않는다.
function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-role-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), mock = join(root, 'mock');
  for (const dir of [join(root, 'scripts'), home, mock]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, 'scripts/verifier-logs.sh'), join(root, 'scripts/verifier-logs.sh'));
  writeFileSync(join(root, 'scripts/lib.sh'), readFileSync(join(repo, 'scripts/lib.sh'), 'utf8') + `
sharing_enabled() { [[ "$1" == com.openssh.sshd && ! -e "$MOCK/sshd-off" ]]; }
is_laptop() { return 1; }
has() {
  case "$1" in brew|docker) [[ ! -e "$MOCK/$1-missing" ]] ;; *) command -v "$1" >/dev/null 2>&1 ;; esac
}
colima() {
  printf '%s\\n' "$*" >>"$MOCK/colima-calls"
  [[ "$1" == status && -e "$MOCK/colima-running" ]]
}
brew() {
  printf '%s\\n' "$*" >>"$MOCK/brew-calls"
  case "$*" in
    'services info colima --json')
      [[ ! -e "$MOCK/info-fail" ]] || return 1
      if [[ -e "$MOCK/info-json" ]]; then cat "$MOCK/info-json"; return; fi
      local registered=false file='/opt/homebrew/opt/colima/sh.brew.colima.plist'
      if [[ -e "$MOCK/registered" ]]; then
        registered=true
        file="$HOME/Library/LaunchAgents/sh.brew.colima.plist"
      fi
      printf '[{"name":"colima","service_name":"sh.brew.colima","registered":%s,"running":false,"file":"%s"}]\\n' "$registered" "$file"
      ;;
    'services start colima')
      [[ ! -e "$MOCK/start-fail" ]] || return 1
      # 소유 기록과 메모리를 start 전에 남겼는지 확인한다.
      grep -qx 'colima_service=role' "$HOME/.config/bootstrap/roles/verifier" || return 99
      cp "$HOME/.colima/default/colima.yaml" "$MOCK/config-at-start"
      [[ -e "$MOCK/start-noop" ]] || touch "$MOCK/registered"
      [[ ! -e "$MOCK/start-partial" ]]
      ;;
    'services stop colima')
      [[ ! -e "$MOCK/stop-fail" ]] || return 1
      [[ -e "$MOCK/stop-noop" ]] || rm -f "$MOCK/registered"
      ;;
    *) return 99 ;;
  esac
}
docker() {
  printf '%s context=%s host=%s tls=%s cert=%s\\n' "$*" "\${DOCKER_CONTEXT:-}" "\${DOCKER_HOST:-}" "\${DOCKER_TLS_VERIFY:-}" "\${DOCKER_CERT_PATH:-}" >>"$MOCK/docker-calls"
  [[ "$1" == --host && "$3" == info && ! -e "$MOCK/docker-off" ]]
}
`);
  writeFileSync(join(root, 'scripts/launch-agents.mjs'), `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK + '/agents', args.join(' ') + '\\n');
const suffix = args.includes('--check') ? '-check' : '';
const only = args[args.indexOf('--only') + 1];
const code = [\`\${process.env.MOCK}/agents-exit\${suffix}-\${only}\`, \`\${process.env.MOCK}/agents-exit\${suffix}\`].find(path => existsSync(path));
process.exitCode = code ? Number(readFileSync(code, 'utf8')) : 0;
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
    calls(name) { const lines = (read(join(mock, `${name}-calls`)) || '').split('\n').filter(Boolean); rmSync(join(mock, `${name}-calls`), { force: true }); return lines; },
    serviceChanges() { return this.calls('brew').filter(line => !line.startsWith('services info ')); },
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
  assert.deepEqual(f.agents(), ['agent-chrome', 'paseo', 'paseo-upgrade'].map(name => `--only ${name} --desktop --dry-run --roles verifier`),
    '상태 파일을 쓰기 전이라 켠 뒤의 역할로 미리 본다');

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(join(f.logs, 'x.log'), '');
  const on = tree(f.home);
  f.agents();
  result = f.role('remove', 'verifier', '--dry-run');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(tree(f.home), on);
  assert.deepEqual(f.agents(), ['agent-chrome', 'paseo', 'paseo-upgrade'].map(name => `--only ${name} --desktop --dry-run --roles none`),
    '상태 파일이 남아 있어도 끈 뒤(자동 시작 복구)로 미리 본다');
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

test('끄기에서 colima 복원이 실패하면 상태 파일과 나머지를 그대로 두고 원래 값을 알린다. 고친 뒤 다시 실행하면 이어서 끈다', t => {
  const f = sandbox(t);
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  f.agents();
  const dir = join(f.colima, '..');
  chmodSync(dir, 0o555);
  t.after(() => { try { chmodSync(dir, 0o755); } catch {} });
  const before = tree(f.home);
  let result = f.role('remove', 'verifier');
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /원래 값 2 GiB/);
  assert.deepEqual(tree(f.home), before, '상태 파일·키 줄·verifier-logs 모두 그대로');
  assert.deepEqual(f.agents(), [], '자동 시작도 되돌리지 않는다');
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 1, '다시 실행해도 0으로 끝나지 않는다');
  chmodSync(dir, 0o755);
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.memory(), '2');
  assert.equal(existsSync(f.state), false);
});

test('authorized_keys를 읽을 수 없으면 add·remove 모두 기존 키를 지우지 않고 실패한다', t => {
  const f = sandbox(t);
  mkdirSync(f.ssh, { mode: 0o700 });
  writeFileSync(f.auth, 'ssh-rsa AAAAOTHER other\n', { mode: 0o600 });
  t.after(() => { try { chmodSync(f.auth, 0o600); } catch {} });
  chmodSync(f.auth, 0o000);
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /읽을 수 없어/);
  assert.equal(existsSync(f.state), false, '아무것도 켜지 않는다');
  chmodSync(f.auth, 0o600);
  assert.equal(readFileSync(f.auth, 'utf8'), 'ssh-rsa AAAAOTHER other\n');

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  const text = readFileSync(f.auth, 'utf8');
  chmodSync(f.auth, 0o000);
  result = f.role('status', 'verifier');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /읽을 수 없음/);
  assert.equal(f.role('add', 'verifier').status, 1, '저장된 값으로 다시 맞출 때도 실패');
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /읽을 수 없어 읽기 전용 키 줄을 지우지 않았습니다/);
  chmodSync(f.auth, 0o600);
  assert.equal(readFileSync(f.auth, 'utf8'), text, '내용을 잃지 않는다');
  assert.equal(f.role('remove', 'verifier').status, 0, '고친 뒤 다시 실행하면 지운다');
  assert.equal(readFileSync(f.auth, 'utf8'), 'ssh-rsa AAAAOTHER other\n');
});

test('~/.ssh·authorized_keys·로그 디렉터리가 링크면 고치지 않고 알린다', t => {
  const f = sandbox(t);
  const real = join(f.root, 'real-ssh');
  mkdirSync(real, { mode: 0o755 });
  chmodSync(real, 0o755);
  symlinkSync(real, f.ssh);
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /\.ssh가 링크라 고치지 않습니다/);
  assert.equal(mode(real), 0o755, '링크 대상 권한을 바꾸지 않는다');
  assert.equal(existsSync(f.state), false);
  rmSync(f.ssh);

  const realLogs = join(f.root, 'real-logs');
  mkdirSync(realLogs);
  mkdirSync(join(f.logs, '..'), { recursive: true });
  symlinkSync(realLogs, f.logs);
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 1);
  rmSync(f.logs);

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  rmSync(f.logs, { recursive: true });
  symlinkSync(realLogs, f.logs);
  chmodSync(realLogs, 0o700);
  result = f.role('status', 'verifier');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /로그 디렉터리가 링크임/);
  rmSync(f.logs);
  mkdirSync(f.logs, { mode: 0o700 });

  const realKeys = join(f.root, 'real-keys');
  writeFileSync(realKeys, readFileSync(f.auth, 'utf8'));
  rmSync(f.auth);
  symlinkSync(realKeys, f.auth);
  assert.equal(f.role('status', 'verifier').status, 1);
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 1, '링크면 조용히 0으로 끝내지 않는다');
  assert.match(result.stderr, /링크라 읽기 전용 키 줄을 지우지 않았습니다/);
  assert.match(readFileSync(realKeys, 'utf8'), /bootstrap-role-verifier/);
});

test('대기(2) 메시지에 실제로 남은 자동 시작 이름을 쓴다', t => {
  const f = sandbox(t);
  writeFileSync(join(f.mock, 'agents-exit-paseo'), '2');
  const result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 2, out(result));
  assert.match(result.stderr, /실행 중이라 등록이 남은 자동 시작: paseo\./);
  assert.doesNotMatch(result.stderr, /에이전트 Chrome이 실행 중/);
});


test('colima 자동 시작: 메모리·소유 기록 후 한 번 등록, add·apply-active 재적용은 실행 중인 VM을 재시작하지 않는다', t => {
  const f = sandbox(t);
  writeFileSync(join(f.mock, 'colima-running'), '');
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 0, out(result));
  assert.equal(f.stateOf().colima_service, 'role');
  assert.equal(existsSync(join(f.mock, 'registered')), true);
  assert.equal(readFileSync(join(f.mock, 'config-at-start'), 'utf8'), COLIMA.replace('memory: 2', 'memory: 6'));
  assert.deepEqual(f.serviceChanges(), ['services start colima']);
  const before = tree(f.home);
  for (const args of [['add', 'verifier'], ['apply-active']]) {
    result = f.role(...args);
    assert.equal(result.status, 0, out(result));
    assert.deepEqual(tree(f.home), before);
    assert.deepEqual(f.serviceChanges(), [], '기등록 서비스에 start·restart·stop 없음');
  }
  assert.deepEqual(f.calls('colima'), ['status'], '메모리 변경 때 조회만 했고 VM 조작 없음');
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(f.serviceChanges(), ['services stop colima']);
  assert.equal(existsSync(join(f.mock, 'registered')), false);
  assert.equal(existsSync(f.state), false);
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), []);
});

test('기존 등록은 실행 여부와 무관하게 보존하고 구버전 역할 파일도 기존 서비스로 기록한다', t => {
  const f = sandbox(t);
  writeFileSync(join(f.mock, 'registered'), 'user service');
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 0, out(result));
  assert.equal(f.stateOf().colima_service, 'existing');
  assert.equal(f.role('add', 'verifier').status, 0);
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), []);
  assert.equal(readFileSync(join(f.mock, 'registered'), 'utf8'), 'user service');

  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  writeFileSync(f.state, readFileSync(f.state, 'utf8').replace(/^colima_service=.*\n/m, ''));
  assert.equal(f.role('status', 'verifier').status, 1, '자동 시작 소유 기록 없는 구버전 상태는 재적용 필요');
  result = f.role('apply-active');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.stateOf().colima_service, 'existing');
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), []);
});

test('기존 등록이 사라지면 재적용으로 만든 서비스부터 role 소유가 된다', t => {
  const f = sandbox(t);
  writeFileSync(join(f.mock, 'registered'), '');
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  rmSync(join(f.mock, 'registered'));
  assert.equal(f.role('apply-active').status, 0);
  assert.equal(f.stateOf().colima_service, 'role');
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), ['services start colima', 'services stop colima']);
});

test('colima 서비스 등록·해제 실패나 성공 코드만 준 무변경을 감지하며 소유 기록으로 재시도한다', t => {
  for (const failure of ['start-fail', 'start-noop', 'start-partial']) {
    const f = sandbox(t);
    writeFileSync(join(f.mock, failure), '');
    let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
    assert.equal(result.status, 1, out(result));
    assert.equal(f.stateOf().colima_service, 'role');
    assert.match(result.stderr, /등록 실패/);
    rmSync(join(f.mock, failure));
    result = f.role('add', 'verifier');
    assert.equal(result.status, 0, out(result));
    assert.equal(f.stateOf().colima_service, 'role', '실패 뒤 생긴 등록을 기존 것으로 오인하지 않음');
    for (const stop of ['stop-fail', 'stop-noop', 'info-fail']) {
      writeFileSync(join(f.mock, stop), '');
      result = f.role('remove', 'verifier');
      assert.equal(result.status, 1, out(result));
      assert.equal(f.stateOf().colima_service, 'role');
      assert.equal(existsSync(f.auth), true, '실패하면 키·상태를 지우기 전에 멈춤');
      rmSync(join(f.mock, stop));
    }
    assert.equal(f.role('remove', 'verifier').status, 0);
    assert.equal(existsSync(f.state), false);
    assert.equal(existsSync(join(f.mock, 'registered')), false);
  }
});

test('colima 서비스 조회 실패·잘못된 JSON·root 서비스·brew 없음은 미등록으로 오인해 덮어쓰지 않는다', t => {
  const f = sandbox(t);
  for (const [marker, content] of [
    ['info-fail', ''], ['brew-missing', ''], ['info-json', 'not JSON'],
    ['info-json', '[]'], ['info-json', '[{"name":"colima","registered":"false"}]'],
    ['info-json', JSON.stringify([{ name: 'colima', registered: true, user: 'root', file: '/Library/LaunchDaemons/sh.brew.colima.plist' }])],
    ['info-json', JSON.stringify([{ name: 'colima', registered: true, file: '/other/sh.brew.colima.plist' }])],
  ]) {
    writeFileSync(join(f.mock, marker), content);
    const before = tree(f.home);
    const result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
    assert.equal(result.status, 1, out(result));
    assert.match(result.stderr, /자동 시작 설정 조회 실패/);
    assert.deepEqual(tree(f.home), before);
    assert.deepEqual(f.serviceChanges(), []);
    rmSync(join(f.mock, marker));
  }
});

test('status는 자동 시작 등록과 현재 Docker 응답을 분리하며 실패 1이 수동 대기 2보다 우선한다', t => {
  const f = sandbox(t);
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  f.serviceChanges();
  let result = f.role('status', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.match(result.stdout, /colima 자동 시작 설정: 등록됨/);
  assert.match(result.stdout, /지금 Docker 응답: 정상/);
  writeFileSync(join(f.mock, 'docker-off'), '');
  result = f.role('status', 'verifier');
  assert.equal(result.status, 1, out(result));
  assert.match(result.stdout, /colima 자동 시작 설정: 등록됨/);
  assert.match(result.stderr, /지금 Docker 응답: 없음/);
  writeFileSync(join(f.mock, 'sshd-off'), '');
  assert.equal(f.role('status', 'verifier').status, 1, '실행 실패가 수동 대기보다 우선');
  rmSync(join(f.mock, 'docker-off'));
  rmSync(join(f.mock, 'sshd-off'));
  rmSync(join(f.mock, 'registered'));
  result = f.role('status', 'verifier');
  assert.equal(result.status, 1, out(result));
  assert.match(result.stderr, /colima 자동 시작 설정: 미등록/);
  assert.match(result.stdout, /지금 Docker 응답: 정상/, 'Docker 응답만으로 준비 완료는 아님');
  assert.deepEqual(f.serviceChanges(), [], 'status는 서비스를 고치지 않는다');
  assert.equal(f.role('add', 'verifier').status, 0);
  for (const marker of ['info-fail', 'brew-missing', 'docker-missing']) {
    writeFileSync(join(f.mock, marker), '');
    assert.equal(f.role('status', 'verifier').status, 1, marker);
    rmSync(join(f.mock, marker));
  }
});

test('Docker 검사는 다른 context·host·TLS 설정을 무시하고 COLIMA_HOME의 기본 소켓을 쓴다', t => {
  const f = sandbox(t);
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 0);
  const custom = join(f.root, 'custom colima');
  mkdirSync(join(custom, 'default'), { recursive: true });
  copyFileSync(f.colima, join(custom, 'default/colima.yaml'));
  Object.assign(f.env, { COLIMA_HOME: custom, DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'tcp://remote:2376',
    DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/remote/certs' });
  const result = f.role('status', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(f.calls('docker'), [`--host unix://${custom}/default/docker.sock info context= host= tls= cert=`]);
});

test('인스턴스 없음은 수동 대기 2로 두고 준비 후 등록하며 dry-run은 서비스도 바꾸지 않는다', t => {
  const f = sandbox(t);
  rmSync(join(f.home, '.colima'), { recursive: true });
  writeFileSync(join(f.mock, 'docker-off'), '');
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 2, out(result));
  assert.deepEqual(f.serviceChanges(), [], '설정 없이 기본 VM을 자동 생성하지 않음');
  assert.equal(f.role('status', 'verifier').status, 2);
  mkdirSync(join(f.colima, '..'), { recursive: true });
  writeFileSync(f.colima, COLIMA);
  result = f.role('add', 'verifier', '--dry-run');
  assert.equal(result.status, 0, out(result));
  assert.match(result.stdout, /\[dry-run\] colima 자동 시작 설정: brew services start colima/);
  assert.deepEqual(f.serviceChanges(), []);
  assert.equal(f.role('add', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), ['services start colima']);
  const before = tree(f.home);
  result = f.role('remove', 'verifier', '--dry-run');
  assert.equal(result.status, 0, out(result));
  assert.match(result.stdout, /\[dry-run\] colima 자동 시작 설정: brew services stop colima/);
  assert.deepEqual(f.serviceChanges(), []);
  assert.deepEqual(tree(f.home), before);
  assert.equal(existsSync(join(f.mock, 'registered')), true);
});


test('등록 미시도 뒤 사용자가 등록한 서비스는 remove가 해제하지 않는다', t => {
  const f = sandbox(t);
  rmSync(join(f.home, '.colima'), { recursive: true });
  let result = f.role('add', 'verifier', '--ssh-key', f.keyFile);
  assert.equal(result.status, 2, out(result));
  assert.deepEqual(f.serviceChanges(), [], '인스턴스가 없어 등록하지 않았음');
  const ownerBefore = f.stateOf().colima_service;
  writeFileSync(join(f.mock, 'registered'), 'user registered');
  result = f.role('status', 'verifier');
  assert.equal(result.status, 2, out(result));
  assert.match(result.stdout, /colima 자동 시작 설정: 등록됨/);
  result = f.role('remove', 'verifier');
  assert.equal(result.status, 0, out(result));
  assert.deepEqual(f.serviceChanges(), [], '외부 등록에 stop을 호출하면 안 됨');
  assert.equal(readFileSync(join(f.mock, 'registered'), 'utf8'), 'user registered');
  assert.equal(ownerBefore, 'pending', '미시도는 role 소유가 아님');
});

test('등록 미시도 뒤 외부 등록을 apply-active가 기존 서비스로 기록하고 이후 remove도 보존한다', t => {
  const f = sandbox(t);
  rmSync(join(f.home, '.colima'), { recursive: true });
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 2);
  assert.deepEqual(f.serviceChanges(), []);
  writeFileSync(join(f.mock, 'registered'), 'user registered');
  let result = f.role('apply-active');
  assert.equal(result.status, 2, out(result));
  assert.equal(f.stateOf().colima_service, 'existing');
  assert.deepEqual(f.serviceChanges(), []);
  mkdirSync(join(f.colima, '..'), { recursive: true });
  writeFileSync(f.colima, COLIMA);
  result = f.role('apply-active');
  assert.equal(result.status, 0, out(result));
  assert.equal(f.stateOf().colima_service, 'existing');
  assert.equal(f.role('status', 'verifier').status, 0);
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), []);
  assert.equal(readFileSync(join(f.mock, 'registered'), 'utf8'), 'user registered');
});

test('등록 미시도는 status 2·재적용·dry-run에서 pending을 유지하고 실제 start 직전에만 role이 된다', t => {
  const f = sandbox(t);
  rmSync(join(f.home, '.colima'), { recursive: true });
  writeFileSync(join(f.mock, 'docker-off'), '');
  assert.equal(f.role('add', 'verifier', '--ssh-key', f.keyFile).status, 2);
  assert.equal(f.stateOf().colima_service, 'pending');
  let result = f.role('status', 'verifier');
  assert.equal(result.status, 2, out(result));
  assert.match(result.stderr, /colima 자동 시작 설정: 인스턴스 준비/);
  assert.equal(f.role('apply-active').status, 2);
  assert.equal(f.stateOf().colima_service, 'pending');
  assert.deepEqual(f.serviceChanges(), []);
  mkdirSync(join(f.colima, '..'), { recursive: true });
  writeFileSync(f.colima, COLIMA);
  assert.equal(f.role('add', 'verifier', '--dry-run').status, 0);
  assert.equal(f.stateOf().colima_service, 'pending');
  assert.deepEqual(f.serviceChanges(), []);
  writeFileSync(join(f.mock, 'start-partial'), '');
  result = f.role('apply-active');
  assert.equal(result.status, 1, out(result));
  assert.equal(f.stateOf().colima_service, 'role', '등록 시도 후 부분 실패의 소유 기록은 보존');
  assert.deepEqual(f.serviceChanges(), ['services start colima']);
  assert.equal(f.role('remove', 'verifier').status, 0);
  assert.deepEqual(f.serviceChanges(), ['services stop colima']);
});
