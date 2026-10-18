import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enableChromeDebugging } from './browser-settings.mjs';

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

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { configureChrome, configurePaseo } from './browser-settings.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-browser-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const stateHome = join(dir, 'state');
  const chrome = join(home, 'Library/Application Support/Google/Chrome/Local State');
  const paseoHome = join(dir, 'paseo');
  const paseo = join(paseoHome, 'config.json');
  mkdirSync(dirname(chrome), { recursive: true });
  mkdirSync(paseoHome);
  const original = JSON.stringify({ profile: { last_used: 'Profile 2' }, custom: 'preserve' });
  writeFileSync(chrome, original);
  return { dir, home, stateHome, chrome, paseoHome, paseo, original };
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

test('Paseo 설정: 초기화 대기·무변경 검사·부분 저장 후 실패와 재시도', t => {
  const f = fixture(t);
  const options = { home: f.paseoHome, stateHome: f.stateHome };
  assert.equal(configurePaseo(options), 2);
  assert.equal(configurePaseo({ ...options, check: true }), 2);
  assert.equal(existsSync(f.paseo), false);
  const original = JSON.stringify({ daemon: { listen: '127.0.0.1:7777' }, custom: true });
  writeFileSync(f.paseo, original);
  const never = () => { throw new Error('check·dry-run에서 CLI 호출 금지'); };
  assert.equal(configurePaseo({ ...options, check: true, run: never }), 1);
  assert.equal(configurePaseo({ ...options, dryRun: true, run: never }), 0);
  assert.equal(existsSync(f.stateHome), false);
  let calls = [];
  const save = (cmd, args) => {
    assert.equal(cmd, 'paseo');
    assert.deepEqual(args.slice(0, 3), ['daemon', 'config', 'set']);
    assert.deepEqual(args.slice(4), ['true', '--home', f.paseoHome]);
    calls.push(args[3]);
    const value = JSON.parse(readFileSync(f.paseo));
    const [, group, key] = args[3].split('.');
    value.daemon[group] ??= {};
    value.daemon[group][key] = true;
    writeFileSync(f.paseo, JSON.stringify(value));
    return { status: 0 };
  };
  assert.throws(() => configurePaseo({ ...options, run: (cmd, args) => {
    if (calls.length === 1) return { status: 1 }; // 두 번째 변경 실패
    return save(cmd, args);
  } }), /일부 값이 저장/);
  assert.deepEqual(calls, ['daemon.mcp.injectIntoAgents']);
  const root = join(f.stateHome, 'bootstrap/backup');
  const [first] = readdirSync(root);
  assert.equal(readFileSync(join(root, first, 'config.json'), 'utf8'), original);
  assert.equal(statSync(join(root, first, 'config.json')).mode & 0o777, 0o600);
  calls = [];
  assert.equal(configurePaseo({ ...options, run: save }), 0);
  assert.deepEqual(calls, ['daemon.browserTools.enabled'], '재시도에서는 빠진 값만 적용');
  assert.equal(JSON.parse(readFileSync(f.paseo)).daemon.listen, '127.0.0.1:7777');
  assert.equal(configurePaseo({ ...options, run: never }), 0);
  assert.equal(configurePaseo({ ...options, check: true }), 0);
});

test('Paseo CLI 실행 오류는 실패로 전달하고 원본 보존', t => {
  const f = fixture(t);
  writeFileSync(f.paseo, '{}');
  assert.throws(() => configurePaseo({ home: f.paseoHome, stateHome: f.stateHome,
    run: () => ({ error: new Error('spawn ENOENT') }) }), /ENOENT/);
  assert.equal(readFileSync(f.paseo, 'utf8'), '{}');
});

test('Paseo 저장 후 reload 실패도 적용 성공으로 보고하지 않는다', t => {
  const f = fixture(t);
  writeFileSync(f.paseo, '{"daemon":{"mcp":{"injectIntoAgents":true}}}');
  assert.throws(() => configurePaseo({ home: f.paseoHome, stateHome: f.stateHome,
    run: () => {
      const value = JSON.parse(readFileSync(f.paseo));
      value.daemon.browserTools = { enabled: true };
      writeFileSync(f.paseo, JSON.stringify(value));
      return { status: 1 };
    } }), /저장 후 reload 실패/);
  assert.equal(JSON.parse(readFileSync(f.paseo)).daemon.browserTools.enabled, true);
  // check는 저장값만 검사한다. 실제 반영 실패 시 안내대로 별도 reload가 필요하다.
  assert.equal(configurePaseo({ home: f.paseoHome, check: true }), 0);
});
