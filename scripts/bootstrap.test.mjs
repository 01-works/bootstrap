import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync, lstatSync, readlinkSync, readdirSync,
  openSync, readSync, closeSync } from 'node:fs';
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
    env: { ...process.env, DRY_RUN: '0', ASSUME_YES: '0', XDG_STATE_HOME: join(root, 'state') }, encoding: 'utf8'
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
function mockStep(t, name, mocks, env = {}) {
  const { root } = sandbox(t);
  writeFileSync(join(root, 'scripts/lib.sh'), readFileSync(join(root, 'scripts/lib.sh'), 'utf8') + '\n' + mocks);
  const rerun = () => spawnSync('/bin/bash', [join(repo, 'scripts/steps', name)], {
    env: { ...process.env, BOOTSTRAP_ROOT: root, DRY_RUN: '0', ASSUME_YES: '0', XDG_STATE_HOME: join(root, 'state'), ...env }, encoding: 'utf8'
  });
  return { root, result: rerun(), rerun };
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

test('CLI 기동 검사는 실행 성공 여부로 판단', t => {
  const run = expr => spawnSync('/bin/bash', ['-c', `source ${quote(join(repo, 'scripts/lib.sh'))}\n${expr}`], { encoding: 'utf8' });
  assert.equal(run('broken() { return 1; }; cli_works broken').status, 1);
  assert.equal(run('healthy() { return 0; }; cli_works healthy').status, 0);
});

test('Tailscale 상태는 연결 상태와 키 만료를 한 줄로, 앱이 꺼져 있으면 빈 값', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-tailscale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const status = (body) => {
    const cli = join(dir, 'Tailscale');
    writeFileSync(cli, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return spawnSync('/bin/bash', ['-c', `source ${quote(join(repo, 'scripts/lib.sh'))}\ntailscale_status`], {
      env: { ...process.env, TAILSCALE_APP_CLI: cli }, encoding: 'utf8'
    }).stdout;
  };
  assert.equal(status(`echo '{"BackendState":"Running","Self":{"KeyExpiry":"2026-12-23T16:26:36Z","Tags":null}}'`), 'Running 2026-12-23T16:26:36Z\n');
  assert.equal(status(`echo '{"BackendState":"Running","Self":{"Online":true}}'`), 'Running -\n', '만료를 끄면 KeyExpiry가 없다');
  assert.equal(status(`echo '{"BackendState":"NeedsLogin","Self":null}'`), 'NeedsLogin -\n');
  assert.equal(status(`echo 'The Tailscale GUI failed to start' >&2; exit 1`), '', '앱이 꺼져 있음');
});

test('auth 단계는 묻지 않고, SSH 키를 만들지 않으며, 로그인할 앱은 처음 한 번만 연다', t => {
  const mocks = `
gh() { if [[ "$1 $2" == "auth status" ]]; then return 1; fi; printf 'gh %s\\n' "$*" >> "$BOOTSTRAP_ROOT/calls"; }
git() { :; }
open() { printf 'open %s\\n' "$*" >> "$BOOTSTRAP_ROOT/calls"; }
launchctl() { printf 'launchctl %s\\n' "$*" >> "$BOOTSTRAP_ROOT/calls"; }
ssh-keygen() { printf 'unexpected ssh-keygen\\n' >> "$BOOTSTRAP_ROOT/calls"; return 99; }
is_laptop() { return 0; }
`;
  const { root, result, rerun } = mockStep(t, '70-auth.sh', mocks);
  assert.equal(result.status, 0, result.stderr);
  let calls = readFileSync(join(root, 'calls'), 'utf8');
  assert.match(calls, /gh auth login --web --clipboard --git-protocol https/);
  assert.match(calls, /open -a Claude/);
  assert.match(calls, /launchctl kickstart gui\/\d+\/local\.bootstrap\.agent-chrome/);
  assert.doesNotMatch(calls, /ssh-keygen/);
  rmSync(join(root, 'calls'));
  assert.equal(rerun().status, 0);
  assert.doesNotMatch(readFileSync(join(root, 'calls'), 'utf8'), /open -a/, '두 번째부터는 앱을 열지 않음');
});

test('데스크톱 auth: FileVault가 켜져 있으면 대기, 꺼져 있으면 자동 로그인을 켠다', t => {
  const base = `
gh() { return 0; }
git() { echo 'gh auth git-credential'; }
open() { :; }
launchctl() { :; }
is_laptop() { return 1; }
sudo() { printf 'sudo %s\\n' "$*" >> "$BOOTSTRAP_ROOT/calls"; }
`;
  const locked = mockStep(t, '70-auth.sh', base + 'filevault_off() { return 1; }\nautologin_on() { return 1; }\n');
  assert.equal(locked.result.status, 2, locked.result.stderr);
  assert.match(locked.result.stderr, /fdesetup disable/);
  assert.equal(existsSync(join(locked.root, 'calls')), false, 'FileVault가 켜져 있으면 자동 로그인을 시도하지 않음');
  const open = mockStep(t, '70-auth.sh', base + 'filevault_off() { return 0; }\nautologin_on() { return 1; }\n');
  assert.equal(open.result.status, 0, open.result.stderr);
  assert.match(readFileSync(join(open.root, 'calls'), 'utf8'), /sudo sysadminctl -autologin set -userName \S+ -password -/);
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

test('자동 갱신(무인 실행)에서는 비밀번호·설치 창·로그인·앱 열기 대신 수동 작업 대기로 남긴다', t => {
  const unattended = { BOOTSTRAP_UNATTENDED: '1' };
  const record = 'printf \'%s %s\\n\' "$FUNCNAME" "$*" >> "$BOOTSTRAP_ROOT/calls"';
  const cases = [
    ['35-power.sh', `is_laptop() { return 1; }\npower_ok() { return 1; }\nsudo() { ${record}; }\n`],
    ['35-power.sh', `is_laptop() { return 0; }\npower_ok() { return 1; }\nsudo() { ${record}; }\n`],
    ['10-xcode.sh', `xcode-select() { [[ "$1" == -p ]] && return 1; ${record}; }\n`],
    ['70-auth.sh', `gh() { [[ "$1 $2" == "auth status" ]] && return 1; [[ "$1 $2" == "auth login" ]] && ${record}; return 0; }
git() { echo 'gh auth git-credential'; }
open() { ${record}; }
launchctl() { ${record}; }
sudo() { ${record}; }
is_laptop() { return 1; }
filevault_off() { return 0; }
autologin_on() { return 1; }
`],
  ];
  for (const [name, mocks] of cases) {
    const { root, result } = mockStep(t, name, mocks, unattended);
    assert.equal(result.status, 2, `${name}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /자동 갱신에서는 하지 않습니다 → 터미널에서 \.\/bootstrap\.sh update/);
    assert.equal(existsSync(join(root, 'calls')), false, `${name}: ${existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : ''}`);
  }
});

test('browser 단계: 자동 갱신 중 에이전트 Chrome 등록이 바뀌었으면 대기, 다른 실패가 있으면 실패', t => {
  const run = setup => mockStep(t, '62-browser.sh', `has() { return 0; }\nis_laptop() { return 1; }\n${setup}`, { BOOTSTRAP_UNATTENDED: '1' }).result;
  const pending = run(`node() { [[ "$1" == *launch-agents.mjs ]] || return 0; [[ " $* " == *" --no-restart "* ]] && return 2; return 9; }`);
  assert.equal(pending.status, 2, pending.stdout + pending.stderr);
  const failed = run(`node() { [[ "$1" == *launch-agents.mjs ]] && return 2; return 1; }`);
  assert.equal(failed.status, 1);
});

test('heavy 단계: yw-heavy를 원자적으로 교체 설치하고, 예전 경로는 없을 때만 링크로 만든다', t => {
  const { root } = sandbox(t);
  const home = join(root, 'home'), compat = join(root, 'cc-yw-heavy.sh'), dst = join(home, '.local/bin/yw-heavy');
  copyFileSync(join(repo, 'scripts/yw-heavy.sh'), join(root, 'scripts/yw-heavy.sh'));
  const step = (env = {}) => spawnSync('/bin/bash', [join(repo, 'scripts/steps/66-heavy.sh')], {
    env: { ...process.env, BOOTSTRAP_ROOT: root, HOME: home, DRY_RUN: '0', XDG_STATE_HOME: join(root, 'state'), YW_HEAVY_COMPAT_PATH: compat, ...env },
    encoding: 'utf8'
  });
  mkdirSync(home);

  // lockf fd 모드가 동작하지 않으면 설치하지 않는다.
  const badLockf = join(root, 'lockf');
  writeFileSync(badLockf, '#!/bin/sh\nexit 64\n', { mode: 0o755 });
  let result = step({ YW_HEAVY_LOCKF_CHECK: badLockf });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fd 모드 잠금이 동작하지 않습니다/);
  assert.equal(existsSync(dst), false);

  result = step({ DRY_RUN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dst), false, 'dry-run은 설치하지 않는다');
  assert.equal(existsSync(compat), false);

  result = step();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(dst, 'utf8'), readFileSync(join(repo, 'scripts/yw-heavy.sh'), 'utf8'));
  assert.equal(statSync(dst).mode & 0o777, 0o755);
  assert.equal(readlinkSync(compat), dst);
  const ino = statSync(dst).ino;
  result = step();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(dst).ino, ino, '같으면 그대로 둔다');
  assert.deepEqual(readdirSync(join(home, '.local/bin')), ['yw-heavy'], '임시 파일을 남기지 않는다');

  // 실행 중인 대기자가 연 이전 파일은 이전 내용을 끝까지 읽는다.
  const fd = openSync(dst, 'r');
  t.after(() => closeSync(fd));
  const old = readFileSync(dst, 'utf8');
  writeFileSync(join(root, 'scripts/yw-heavy.sh'), old + '# changed\n');
  result = step();
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(statSync(dst).ino, ino, '교체는 새 파일을 mv로 옮긴다');
  assert.equal(readFileSync(dst, 'utf8'), old + '# changed\n');
  const buffer = Buffer.alloc(Buffer.byteLength(old) + 100);
  assert.equal(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString(), old);

  // 예전 경로에 일반 파일(구버전)이 있으면 그대로 둔다.
  rmSync(compat);
  writeFileSync(compat, 'legacy\n');
  result = step();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(compat, 'utf8'), 'legacy\n');
  assert.equal(lstatSync(compat).isSymbolicLink(), false);
  assert.match(result.stdout, /agents\/heavy-queue\.md/);
});

test('role 명령은 scripts/role.sh로 넘기고, roles 단계는 켠 역할이 없으면 아무것도 하지 않는다', t => {
  const { root, run } = sandbox(t);
  const home = join(root, 'home');
  mkdirSync(home);
  copyFileSync(join(repo, 'scripts/role.sh'), join(root, 'scripts/role.sh'));
  const env = { ...process.env, BOOTSTRAP_ROOT: root, HOME: home, DRY_RUN: '0', XDG_STATE_HOME: join(root, 'state') };
  delete env.XDG_CONFIG_HOME;
  const bootstrap = (...args) => spawnSync('/bin/bash', [join(root, 'bootstrap.sh'), ...args], { env, encoding: 'utf8' });
  let result = bootstrap('role', 'status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /기기 역할 없음/);
  result = bootstrap('role', 'status', 'verifier');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verifier 꺼짐/);
  result = bootstrap('role');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /role add verifier/);
  assert.match(run('--help').stdout, /role add\|status\|remove verifier/);

  result = spawnSync('/bin/bash', [join(repo, 'scripts/steps/90-roles.sh')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /기기 역할 없음/);
  assert.deepEqual(readdirSync(home), [], '역할이 없으면 홈을 건드리지 않는다');
});

test('모든 bash 스크립트는 변수 이름 바로 뒤에 비ASCII 문자를 붙이지 않는다', () => {
  const files = ['bootstrap.sh', 'install.sh', ...readdirSync(join(repo, 'scripts'), { recursive: true })
    .filter(name => name.endsWith('.sh')).map(name => join('scripts', name))];
  assert.ok(files.includes(join('scripts', 'steps', '65-paseo.sh')));
  for (const file of files) {
    // UTF-8 로캘의 bash 3.2는 변수 이름 바로 뒤의 비ASCII 문자를 이름의 일부로 읽어 set -u에서 멈춘다: ${installed}로 처럼 쓴다.
    assert.doesNotMatch(readFileSync(join(repo, file), 'utf8'), /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/, `${file}: 변수 뒤에 붙은 비ASCII 문자`);
  }
});
