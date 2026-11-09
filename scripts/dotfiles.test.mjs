import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, lstatSync, readdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const relative = 'home/claude/.claude/settings.json.seed';
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

test('이름 변경으로 끊긴 기존 저장소 링크는 복구하되 모르는 깨진 링크는 보존하고 실패한다', t => {
  const f = fixture(t);
  symlinkSync(f.seed.slice(0, -'.seed'.length), f.local);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(f.local).isFile());
  assert.equal(readFileSync(f.local, 'utf8'), defaults);
  assert.equal(readFileSync(f.backups()[0], 'utf8'), defaults);
  rmSync(f.local);
  const missing = join(f.root, 'missing.json');
  symlinkSync(missing, f.local);
  assert.equal(f.run().status, 1);
  assert.equal(readlinkSync(f.local), missing);
});
