import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { configureChrome, enableChromeDebugging } from './browser-settings.mjs';

test('Chrome 설정 병합은 개인 설정과 기존 devtools 값을 보존한다', () => {
  const original = {
    profile: { last_used: 'Profile 2', info_cache: { custom: { name: 'test' } } },
    custom: ['keep'],
    devtools: { preferences: { theme: 'dark' }, remote_debugging: { 'user-enabled': false, other: 42 } }
  };
  const copy = structuredClone(original);
  const result = enableChromeDebugging(original);
  assert.deepEqual(original, copy);
  assert.equal(result.devtools.remote_debugging['user-enabled'], true);
  result.devtools.remote_debugging['user-enabled'] = false;
  assert.deepEqual(result, original);
});

test('초기 설정과 재실행을 지원하고 잘못된 형식을 덮어쓰지 않는다', () => {
  const expected = { devtools: { remote_debugging: { 'user-enabled': true } } };
  assert.deepEqual(enableChromeDebugging({}), expected);
  assert.deepEqual(enableChromeDebugging(expected), expected);
  for (const input of [null, [], { devtools: [] }, { devtools: 'invalid' }, { devtools: { remote_debugging: [] } }]) {
    const before = structuredClone(input);
    assert.throws(() => enableChromeDebugging(input));
    assert.deepEqual(input, before);
  }
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-browser-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const stateHome = join(dir, 'state');
  const chrome = join(home, 'Library/Application Support/Google/Chrome/Local State');
  mkdirSync(dirname(chrome), { recursive: true });
  const original = JSON.stringify({ profile: { last_used: 'Profile 2' }, custom: 'preserve' });
  writeFileSync(chrome, original);
  return { dir, home, stateHome, chrome, original };
}

const stopped = () => ({ status: 1 });

test('Chrome 파일 적용: check·dry-run·실행 중에는 무변경, 백업·권한·재실행 검증', t => {
  const f = fixture(t);
  const options = { home: f.home, stateHome: f.stateHome, run: stopped };
  const noProcessCheck = () => { throw new Error('검사만 할 때 프로세스 실행 금지'); };
  assert.equal(configureChrome({ ...options, check: true, run: noProcessCheck }), 2);
  assert.equal(configureChrome({ ...options, dryRun: true, run: noProcessCheck }), 0);
  assert.equal(configureChrome({ ...options, run: () => ({ status: 0 }) }), 2);
  assert.equal(readFileSync(f.chrome, 'utf8'), f.original);
  assert.equal(existsSync(f.stateHome), false);
  assert.equal(configureChrome(options), 0);
  assert.deepEqual(JSON.parse(readFileSync(f.chrome)), enableChromeDebugging(JSON.parse(f.original)));
  const backups = join(f.stateHome, 'bootstrap/backup');
  const [entry] = readdirSync(backups);
  assert.match(entry, /^browser-chrome-/);
  assert.equal(readFileSync(join(backups, entry, 'Local State'), 'utf8'), f.original);
  assert.equal(readFileSync(join(backups, entry, 'source-path.txt'), 'utf8'), `${f.chrome}\n`);
  assert.equal(statSync(join(backups, entry)).mode & 0o777, 0o700);
  assert.equal(statSync(join(backups, entry, 'Local State')).mode & 0o777, 0o600);
  assert.equal(statSync(f.chrome).mode & 0o777, 0o600);
  assert.equal(configureChrome(options), 0);
  assert.equal(configureChrome({ ...options, check: true }), 0);
  assert.equal(readdirSync(backups).length, 1);
});

test('Chrome 실패 경로: 잘못된 JSON·프로세스 검사 오류·동시 변경을 보존', t => {
  const f = fixture(t);
  const options = { home: f.home, stateHome: f.stateHome, run: stopped };
  writeFileSync(f.chrome, '{broken');
  assert.throws(() => configureChrome(options));
  assert.equal(readFileSync(f.chrome, 'utf8'), '{broken');
  assert.equal(existsSync(f.stateHome), false);
  writeFileSync(f.chrome, f.original);
  assert.throws(() => configureChrome({ ...options, run: () => ({ status: 2 }) }), /실행 상태/);
  let calls = 0;
  assert.throws(() => configureChrome({ ...options, run: () => {
    if (++calls === 2) writeFileSync(f.chrome, '{"changed":true}');
    return { status: 1 };
  } }), /설정이 변경/);
  assert.equal(readFileSync(f.chrome, 'utf8'), '{"changed":true}');
  assert.deepEqual(readdirSync(dirname(f.chrome)), ['Local State'], '실패한 임시 파일 정리');
});

test('Chrome이 쓰기 준비 중 시작되면 원본을 교체하지 않는다', t => {
  const f = fixture(t);
  let calls = 0;
  assert.equal(configureChrome({ home: f.home, stateHome: f.stateHome,
    run: () => ({ status: ++calls === 1 ? 1 : 0 }) }), 2);
  assert.equal(readFileSync(f.chrome, 'utf8'), f.original);
  assert.deepEqual(readdirSync(dirname(f.chrome)), ['Local State']);
});

test('Chrome 최초 설정은 새 디렉터리에 생성 가능', t => {
  const f = fixture(t);
  rmSync(f.home, { recursive: true });
  assert.equal(configureChrome({ home: f.home, stateHome: f.stateHome, run: stopped }), 0);
  assert.equal(JSON.parse(readFileSync(f.chrome)).devtools.remote_debugging['user-enabled'], true);
  assert.equal(existsSync(f.stateHome), false, '기존 파일이 없으므로 백업 없음');
});
