import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, lstatSync, readdirSync, symlinkSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const relative = 'home/claude/.claude/settings.json';
const defaults = readFileSync(join(repo, relative), 'utf8');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bootstrap-dotfiles-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'repo'), home = join(root, 'home'), seed = join(work, relative);
  const local = join(home, '.claude/settings.json'), backup = join(root, 'state/bootstrap/backup');
  for (const dir of [dirname(seed), dirname(local), join(work, 'scripts/steps'), join(root, 'bin')]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, 'scripts/lib.sh'), join(work, 'scripts/lib.sh'));
  copyFileSync(join(repo, 'bootstrap.sh'), join(work, 'bootstrap.sh'));
  copyFileSync(join(repo, 'scripts/steps/40-dotfiles.sh'), join(work, 'scripts/steps/40-dotfiles.sh'));
  writeFileSync(join(work, 'scripts/doctor.sh'), 'exit 0\n');
  writeFileSync(join(root, 'bin/ps'), '#!/bin/sh\nprintf \'%s\\n\' codex /path/claude-helper\n', { mode: 0o755 });
  writeFileSync(seed, defaults);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    BOOTSTRAP_ROOT: work, DRY_RUN: '0', ASSUME_YES: '0', PATH: `${join(root, 'bin')}:${process.env.PATH}` };
  return {
    root, work, home, seed, local, backup,
    run: (...args) => spawnSync('/bin/bash', [join(work, 'bootstrap.sh'), '--only', 'dotfiles', ...args], { env, encoding: 'utf8' }),
    install: () => spawnSync('/bin/bash', [join(work, 'bootstrap.sh')], { env, encoding: 'utf8' }),
    migrate: (...args) => spawnSync('/bin/bash', [join(work, 'bootstrap.sh'), '--only', 'dotfiles', '--migrate-claude-settings', ...args], { env, encoding: 'utf8' }),
    processes(output, code = 0) {
      writeFileSync(join(root, 'bin/ps'), `#!/bin/sh\ncat <<'PROCESSES'\n${output}\nPROCESSES\nexit ${code}\n`, { mode: 0o755 });
    },
    shellHook(body) {
      const hook = join(root, 'bash-env');
      writeFileSync(hook, body);
      env.BASH_ENV = hook;
    },
    injectBeforeCopy(body) {
      const hook = join(root, 'bash-env');
      writeFileSync(hook, `cp() {
  ${body}
  command cp "$@"
}
`);
      env.BASH_ENV = hook;
    },
    injectAfterCopy(body, copyNumber = 1) {
      const hook = join(root, 'bash-env');
      writeFileSync(hook, `cp() {
  command cp "$@" || return
  _test_copy_count=$(( \${_test_copy_count:-0} + 1 ))
  if [[ "$_test_copy_count" == ${copyNumber} && ! -e "$HOME/injected" ]]; then
    touch "$HOME/injected"
    ${body}
  fi
}
`);
      env.BASH_ENV = hook;
    },
    backups: () => existsSync(backup) ? readdirSync(backup, { recursive: true }).filter(p => p.endsWith('/.claude/settings.json')).map(p => join(backup, p)) : [],
    // doctor의 설정 파일 검사만 실행해 외부 도구·시스템 검사는 격리한다.
    doctor: () => {
      const script = readFileSync(join(repo, 'scripts/doctor.sh'), 'utf8');
      const checks = script.slice(script.indexOf('step "설정 파일"'), script.indexOf('step "사용자 스킬'));
      return spawnSync('/bin/bash', ['-c', 'source "$BOOTSTRAP_ROOT/scripts/lib.sh"\npass() { ok "$*"; }; miss() { fail "$*"; failed=1; }; wait_for_user() { warn "$*"; failed=2; }; failed=0\n' + checks + '\nexit "$failed"'], { env, encoding: 'utf8' });
    },
  };
}

test('새 설치는 설정 기본값을 일반 파일로 복사하고 doctor가 로컬 파일을 정상으로 본다', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(defaults).enabledPlugins?.['sentry@sentry'], undefined);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(f.local).isFile());
  assert.equal(readFileSync(f.local, 'utf8'), defaults);
  assert.deepEqual(f.backups(), []);
  assert.equal(f.doctor().status, 0);
});

for (const invocation of ['run', 'install']) {
  test(`${invocation}: 저장 중에도 기존 링크는 그대로 두고 pending으로 다른 dotfiles를 적용한다`, t => {
    const f = fixture(t);
    symlinkSync(f.seed, f.local);
    mkdirSync(join(f.work, 'home/zsh'), { recursive: true });
    writeFileSync(join(f.work, 'home/zsh/.zshrc'), '# zsh\n');
    // 스캔 시 실제 저장을 주입하고, 리뷰어의 마지막 cmp 직후 원자적 저장 재현도 설치한다.
    f.shellHook(`find() {
  printf '%s\\n' '{"theme":"latest"}' > "$BOOTSTRAP_ROOT/home/claude/.claude/settings.json"
  command find "$@"
}
cmp() {
  command cmp "$@" || return
  touch "$HOME/cmp-called"
  printf '%s\\n' '{"theme":"late-save"}' > "$HOME/.claude/saved.json"
  command mv -f "$HOME/.claude/saved.json" "$HOME/.claude/settings.json"
}
`);
    const result = f[invocation]();
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /기존 링크 전환 필요/);
    assert.equal(readlinkSync(f.local), f.seed);
    assert.equal(readFileSync(f.local, 'utf8'), '{"theme":"latest"}\n');
    assert.ok(!existsSync(join(f.home, 'cmp-called')), '자동 경로는 최종 cmp·교체 코드 자체를 실행하지 않음');
    assert.deepEqual(f.backups(), []);
    assert.equal(readlinkSync(join(f.home, '.zshrc')), join(f.work, 'home/zsh/.zshrc'));
    if (invocation === 'install') {
      assert.match(readFileSync(join(f.root, 'state/bootstrap/update/status'), 'utf8'), /result=pending[\s\S]*pending=dotfiles/);
    }
  });
}

for (const process of ['claude', '/test/bin/claude', '/test/path with spaces/claude']) {
  test(`수동 전환은 Claude 실행 파일(${process})이 있으면 거부한다`, t => {
    const f = fixture(t);
    symlinkSync(f.seed, f.local);
    f.processes(`codex\n${process}\nnode`);
    const result = f.migrate();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /claude.*실행 중.*거부/);
    assert.equal(readlinkSync(f.local), f.seed);
    assert.deepEqual(f.backups(), []);
  });
}

test('수동 전환은 프로세스 목록 조회 실패 시에도 거부한다', t => {
  const f = fixture(t);
  symlinkSync(f.seed, f.local);
  f.processes('', 1);
  const result = f.migrate();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /프로세스를 조회하지 못해/);
  assert.equal(readlinkSync(f.local), f.seed);
  assert.deepEqual(f.backups(), []);
});

test('무인 실행에서는 명시적 전환 옵션도 거부한다', t => {
  const f = fixture(t);
  symlinkSync(f.seed, f.local);
  f.shellHook('export BOOTSTRAP_UNATTENDED=1\n');
  const result = f.migrate();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /자동 실행에서는 기존 설정 링크를 전환하지 않습니다/);
  assert.equal(readlinkSync(f.local), f.seed);
  assert.deepEqual(f.backups(), []);
});

test('수동 전환 후 검증이 실패하면 다시 덮어쓰지 않고 현재 내용과 백업을 보존한다', t => {
  const f = fixture(t);
  symlinkSync(f.seed, f.local);
  f.shellHook(`mv() {
  command mv "$@" || return
  printf '%s\\n' '{"theme":"post-save"}' > "$HOME/.claude/settings.json"
}
`);
  const result = f.migrate();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /전환 후 내용 확인 실패/);
  assert.equal(readFileSync(f.local, 'utf8'), '{"theme":"post-save"}\n');
  assert.equal(readFileSync(f.backups()[0], 'utf8'), defaults);
});

test('기존 일반 파일은 seed와 달라도 그대로 두고 반복 실행해도 백업하지 않는다', t => {
  const f = fixture(t);
  const current = '{"model":"local","theme":"light","enabledPlugins":{"custom":true}}\n';
  writeFileSync(f.local, current);
  for (let i = 0; i < 2; i++) assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.local, 'utf8'), current);
  assert.deepEqual(f.backups(), []);
  assert.equal(f.doctor().status, 0);
});

test('초기 복사 직전에 다른 프로세스가 만든 설정 파일은 덮어쓰지 않는다', t => {
  const f = fixture(t);
  const current = '{"theme":"light","model":"latest"}\n';
  f.injectBeforeCopy(`printf '%s\\n' '{"theme":"light","model":"latest"}' > "$HOME/.claude/settings.json"`);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(lstatSync(f.local).isFile());
  assert.equal(readFileSync(f.local, 'utf8'), current);
  assert.equal(readFileSync(f.seed, 'utf8'), defaults);
  assert.deepEqual(readdirSync(dirname(f.local)), ['settings.json'], '임시 파일 정리');
  assert.deepEqual(f.backups(), []);
});

test('초기 복사 직전에 생긴 링크와 링크 대상도 그대로 보존한다', t => {
  const f = fixture(t);
  const target = join(dirname(f.local), 'current.json');
  writeFileSync(target, 'latest');
  f.injectBeforeCopy('command ln -s "$HOME/.claude/current.json" "$HOME/.claude/settings.json"');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readlinkSync(f.local), target);
  assert.equal(readFileSync(target, 'utf8'), 'latest');
  assert.deepEqual(readdirSync(dirname(f.local)), ['current.json', 'settings.json']);
});

test('초기 복사 직전에 생긴 디렉터리 안에도 기본값이나 임시 파일을 만들지 않는다', t => {
  const f = fixture(t);
  f.injectBeforeCopy('mkdir "$HOME/.claude/settings.json"');
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(lstatSync(f.local).isDirectory());
  assert.deepEqual(readdirSync(f.local), []);
  assert.deepEqual(readdirSync(dirname(f.local)), ['settings.json']);
});

test('대상 생성이 다른 이유로 실패해도 임시 파일을 정리하고 실패를 알린다', t => {
  const f = fixture(t);
  f.injectBeforeCopy('link() { return 1; }');
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /기본값 생성 실패/);
  assert.ok(!existsSync(f.local));
  assert.deepEqual(readdirSync(dirname(f.local)), []);
});

test('읽을 수 있는 기존 링크의 현재 내용을 일반 파일로 백업하고 그대로 전환한다', t => {
  const f = fixture(t);
  const target = join(f.root, 'current-settings.json');
  const current = '{"model":"local","theme":"light","enabledPlugins":{"custom":true}}\n';
  writeFileSync(target, current);
  symlinkSync(target, f.local);
  assert.equal(f.doctor().status, 2, '아직 링크면 수동 전환 대기');
  let result = f.migrate('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(f.local).isSymbolicLink());
  assert.deepEqual(f.backups(), []);
  result = f.migrate();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(f.local).isFile());
  assert.equal(readFileSync(f.local, 'utf8'), current);
  const [backup] = f.backups();
  assert.equal(f.backups().length, 1);
  assert.ok(lstatSync(backup).isFile());
  assert.equal(readFileSync(backup, 'utf8'), current);
  assert.equal(readFileSync(target, 'utf8'), current, '원래 대상은 바꾸지 않음');
  writeFileSync(f.local, 'local edit');
  assert.equal(readFileSync(backup, 'utf8'), current, '백업은 독립적인 복사본');
  assert.equal(f.run().status, 0);
  assert.equal(f.backups().length, 1);
  assert.equal(readFileSync(f.local, 'utf8'), 'local edit');
});

test('모르는 깨진 링크는 기본값으로 덮어쓰지 않고 보존한다', t => {
  const f = fixture(t);
  const missing = join(f.root, 'missing.json');
  symlinkSync(missing, f.local);
  assert.equal(f.run().status, 2, '기본 실행에서는 깨진 링크도 교체하지 않음');
  assert.equal(f.migrate().status, 1);
  assert.equal(readlinkSync(f.local), missing);
  assert.deepEqual(f.backups(), []);
});

for (const [name, injection, copyNumber = 1] of [
  ['로컬 경로에 원자적으로 저장', 'command mv -f "$HOME/.claude/latest.json" "$HOME/.claude/settings.json"'],
  ['로컬 경로에 원자적으로 저장(백업 직후)', 'command mv -f "$HOME/.claude/latest.json" "$HOME/.claude/settings.json"', 2],
  ['링크 대상에 원자적으로 저장', 'command mv -f "$HOME/.claude/latest.json" "$BOOTSTRAP_ROOT/home/claude/.claude/settings.json"'],
  ['같은 내용의 다른 대상으로 링크 변경', 'command ln -sf "$HOME/.claude/latest.json" "$HOME/.claude/settings.json"'],
]) {
  test(`복사 ${copyNumber}회 직후 ${name}: 최신 값을 보존하고 전환을 보류한다`, t => {
    const f = fixture(t);
    const latest = name.startsWith('같은 내용') ? defaults : '{"theme":"light","model":"latest"}\n';
    writeFileSync(join(f.home, '.claude/latest.json'), latest);
    symlinkSync(f.seed, f.local);
    f.injectAfterCopy(injection, copyNumber);
    const result = f.migrate();
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /보류/);
    assert.equal(readFileSync(f.local, 'utf8'), latest);
    assert.equal(lstatSync(f.local).isSymbolicLink(), !name.startsWith('로컬'));
    assert.equal(readFileSync(f.backups()[0], 'utf8'), defaults, '복사 시점 내용도 백업에 남긴다');
    assert.deepEqual(readdirSync(dirname(f.local)).filter(p => p.includes('.bootstrap.')), [], '임시 파일 정리');
    assert.equal(f.migrate().status, 0, '다음 수동 실행은 현재 최신 값으로 전환하거나 기존 일반 파일 보존');
    assert.ok(lstatSync(f.local).isFile());
    assert.equal(readFileSync(f.local, 'utf8'), latest);
  });
}
