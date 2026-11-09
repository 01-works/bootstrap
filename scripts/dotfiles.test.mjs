import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, lstatSync, readdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const relative = 'home/claude/.claude/settings.json';
const defaults = readFileSync(join(repo, relative), 'utf8');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-dotfiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'repo'), home = join(root, 'home'), seed = join(work, relative);
  const local = join(home, '.claude/settings.json'), backup = join(root, 'state/bootstrap/backup');
  for (const dir of [dirname(seed), dirname(local), join(work, 'scripts')]) mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, 'scripts/lib.sh'), join(work, 'scripts/lib.sh'));
  writeFileSync(seed, defaults);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    BOOTSTRAP_ROOT: work, DRY_RUN: '0', ASSUME_YES: '0' };
  return {
    root, work, home, seed, local, backup,
    run: (...args) => spawnSync('/bin/bash', [join(repo, 'scripts/steps/40-dotfiles.sh')], { env: { ...env, DRY_RUN: args.includes('--dry-run') ? '1' : '0' }, encoding: 'utf8' }),
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
      return spawnSync('/bin/bash', ['-c', 'source "$BOOTSTRAP_ROOT/scripts/lib.sh"\npass() { ok "$*"; }; miss() { fail "$*"; failed=1; }; failed=0\n' + checks + '\nexit "$failed"'], { env, encoding: 'utf8' });
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

test('기존 일반 파일은 seed와 달라도 그대로 두고 반복 실행해도 백업하지 않는다', t => {
  const f = fixture(t);
  const current = '{"model":"local","theme":"light","enabledPlugins":{"custom":true}}\n';
  writeFileSync(f.local, current);
  for (let i = 0; i < 2; i++) assert.equal(f.run().status, 0);
  assert.equal(readFileSync(f.local, 'utf8'), current);
  assert.deepEqual(f.backups(), []);
  assert.equal(f.doctor().status, 0);
});

test('읽을 수 있는 기존 링크의 현재 내용을 일반 파일로 백업하고 그대로 전환한다', t => {
  const f = fixture(t);
  const target = join(f.root, 'current-settings.json');
  const current = '{"model":"local","theme":"light","enabledPlugins":{"custom":true}}\n';
  writeFileSync(target, current);
  symlinkSync(target, f.local);
  assert.equal(f.doctor().status, 1, '아직 링크면 전환 필요');
  let result = f.run('--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(f.local).isSymbolicLink());
  assert.deepEqual(f.backups(), []);
  result = f.run();
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
  assert.equal(f.run().status, 1);
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
    const result = f.run();
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /보류/);
    assert.equal(readFileSync(f.local, 'utf8'), latest);
    assert.equal(lstatSync(f.local).isSymbolicLink(), !name.startsWith('로컬'));
    assert.equal(readFileSync(f.backups()[0], 'utf8'), defaults, '복사 시점 내용도 백업에 남긴다');
    assert.deepEqual(readdirSync(dirname(f.local)).filter(p => p.includes('.bootstrap.')), [], '임시 파일 정리');
    assert.equal(f.run().status, 0, '다음 실행은 현재 최신 값으로 마이그레이션하거나 기존 일반 파일 보존');
    assert.ok(lstatSync(f.local).isFile());
    assert.equal(readFileSync(f.local, 'utf8'), latest);
  });
}
