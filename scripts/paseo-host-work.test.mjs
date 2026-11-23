import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTable, plan } from './paseo-host-work.mjs';

const script = new URL('./paseo-host-work.mjs', import.meta.url).pathname;

test('배치표: 줄마다 serverId와 work 값, #부터는 주석. 허용 문자 밖이거나 틀린 줄이 있으면 전체를 거부한다', () => {
  assert.deepEqual([...parseTable('# 배치\n\nsrv_a 외주,01-software\n  srv-b\t실험  # 메모\n')], [['srv_a', '외주,01-software'], ['srv-b', '실험']]);
  assert.equal(parseTable('# 주석만\n').size, 0);
  assert.throws(() => parseTable('srv_a 외주\nsrv_b\n'), /줄 2/);
  assert.throws(() => parseTable('srv_a 외주 실험\n'), /줄 1/);
  assert.throws(() => parseTable('srv_a 외주\nsrv_a 실험\n'), /줄 2: serverId가 중복/);
  for (const line of ['srv/a 외주', 'srv_a 외주,', 'srv_a ,외주', 'srv_a 외주,,실험', 'srv_a work=x', 'srv_a $(x)', 'srv.a 외주']) {
    assert.throws(() => parseTable(`srv_ok 외주\n${line}\n`), /줄 2/, line);
  }
});

test('계획: 등록된 host 중 배치표에 있고 값이 다른 것만, work 밖 metadata가 있으면 건너뛴다', () => {
  const hosts = [
    { registrationId: 'r1', serverId: 'srv_a', metadata: { work: '실험' } },
    { registrationId: 'r2', serverId: 'srv_b', metadata: { work: 'verifier', team: 'x' } },
    { registrationId: 'r3', serverId: 'srv_c' },
    { registrationId: 'r4', serverId: 'srv_x', metadata: { work: '외주' } },
    { registrationId: 'r5', serverId: 'srv_d', metadata: { work: '실험', team: 'x' } },
  ];
  const result = plan(hosts, parseTable('srv_a 외주\nsrv_b verifier\nsrv_c 실험\nsrv_d 외주\nsrv_z 외주\n'));
  assert.deepEqual(result.changes.map(({ host, from, to }) => [host.registrationId, from, to]), [['r1', '실험', '외주'], ['r3', '', '실험']]);
  assert.deepEqual(result.skipped.map(({ host, others }) => [host.registrationId, others]), [['r5', ['team']]], '값이 같으면 다른 키가 있어도 알리지 않는다');
});

// 임시 HOME과 PATH 앞의 가짜 paseo. 가짜는 host ls·update만 알고 호출을 기록한다. 실제 데몬은 건드리지 않는다.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-host-work-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), bin = join(root, 'bin'), fake = join(root, 'fake');
  for (const dir of [home, bin, fake]) mkdirSync(dir, { recursive: true });
  const hostsFile = join(fake, 'hosts.json');
  writeFileSync(join(bin, 'paseo'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = args.indexOf('--home');
const home = at < 0 ? null : args.splice(at, 2)[1];
fs.appendFileSync(${JSON.stringify(join(fake, 'calls'))}, args.join(' ') + '\\n');
if (home !== ${JSON.stringify(join(home, '.paseo'))}) process.exit(8);
if (fs.existsSync(${JSON.stringify(join(fake, 'hang'))})) {
  fs.writeFileSync(${JSON.stringify(join(fake, 'hang-pid'))}, String(process.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  return;
}
if (fs.existsSync(${JSON.stringify(join(fake, 'down'))})) {
  console.error(JSON.stringify({ error: { code: 'DAEMON_NOT_RUNNING', message: 'Daemon is not running at ' + home } }));
  process.exit(1);
}
const hosts = JSON.parse(fs.readFileSync(${JSON.stringify(hostsFile)}, 'utf8'));
if (args.join(' ') === 'host ls --json') { console.log(JSON.stringify(hosts)); process.exit(0); }
if (args[0] === 'host' && args[1] === 'update' && args[3] === '--meta' && args.length === 5) {
  if (process.env.FAIL_UPDATE === args[2]) { console.error(JSON.stringify({ error: { code: 'HOST_UPDATE_FAILED' } })); process.exit(1); }
  const host = hosts.find(h => h.registrationId === args[2]);
  const [key, ...value] = args[4].split('=');
  // Paseo 0.16.2: 조회한 metadata 객체에 넘긴 키를 합쳐 metadata 전체를 바꾼다(그 사이 바뀐 다른 키는 되돌아간다).
  const looked = { ...host.metadata };
  host.metadata = { ...looked, [key]: value.join('=') };
  fs.writeFileSync(${JSON.stringify(hostsFile)}, JSON.stringify(hosts));
  process.exit(0);
}
process.exit(9);
`, { mode: 0o755 });
  writeFileSync(hostsFile, JSON.stringify([
    { registrationId: 'reg-a', serverId: 'srv_a', label: 'A', metadata: { work: '실험' }, enabled: true },
    { registrationId: 'reg-b', serverId: 'srv_b', label: 'B', metadata: { work: 'verifier' }, enabled: true },
    { registrationId: 'reg-c', serverId: 'srv_c', label: 'C', metadata: { work: '실험' }, enabled: true },
    { registrationId: 'reg-d', serverId: 'srv_d', label: 'D', metadata: { work: '실험', team: 'x' }, enabled: true },
  ]));
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'PASEO_HOME', 'BOOTSTRAP_HOST_WORK_TIMEOUT']) delete env[key];
  const table = join(home, '.config/bootstrap/host-work');
  const state = join(home, '.local/state/bootstrap/update/host-work');
  const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
  return {
    fake, table, statePath: state,
    run: (args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    writeTable(text) { mkdirSync(join(home, '.config/bootstrap'), { recursive: true }); writeFileSync(table, text); },
    calls() { const lines = read(join(fake, 'calls')).split('\n').filter(Boolean); rmSync(join(fake, 'calls'), { force: true }); return lines; },
    hosts: () => JSON.parse(read(hostsFile)),
    state: () => read(state).trim(),
  };
}

test('CLI: 배치표에 있는 등록 host만 바꾸고, work 밖 metadata가 있는 host·배치표 밖 host는 그대로, 같은 값이면 무변경', t => {
  const f = fixture(t);
  f.writeTable('# 개인 배치\nsrv_a 외주,01-software\nsrv_b verifier\nsrv_d 외주\nsrv_z 실험\n');
  let result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['host ls --json', 'host update reg-a --meta work=외주,01-software']);
  assert.match(result.stdout, /host work 맞춤: A \(srv_a\) 실험 → 외주,01-software/);
  assert.match(result.stdout, /host work 맞춤 남음: D \(srv_d\) work 밖 metadata\(team\)가 있어 수동으로 맞춤/);
  assert.deepEqual(f.hosts().map(host => host.metadata), [
    { work: '외주,01-software' }, { work: 'verifier' }, { work: '실험' }, { work: '실험', team: 'x' },
  ]);

  result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['host ls --json'], '같은 값이면 update를 부르지 않는다');
  assert.equal(result.stdout, '', '자동 갱신은 결과가 같으면 기록하지 않는다');
  assert.match(f.state(), /^host work 맞춤 남음: D/);

  // 배치를 바꾸면 다음 실행이 따라간다.
  f.writeTable('srv_a 외주\nsrv_b 실험\n');
  result = f.run(['--auto']);
  assert.deepEqual(f.calls(), ['host ls --json', 'host update reg-a --meta work=외주', 'host update reg-b --meta work=실험']);
  assert.match(result.stdout, /host work 일치$/m);
  result = f.run();
  assert.equal(result.stdout, 'host work 일치\n', '터미널에서는 매번 보여 준다');
});

test('CLI: 배치표 없음·읽을 수 없음·형식 오류는 paseo를 부르지 않고 알린 뒤 0으로 끝난다', t => {
  const f = fixture(t);
  let result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /건너뜀: 배치표 없음 \(~\/\.config\/bootstrap\/host-work\)/);
  assert.equal(f.run(['--auto']).stdout, '', '같은 결과는 한 번만 기록한다');

  f.writeTable('srv_a 외주\nsrv_b 실험;rm\n');
  result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /건너뜀: 배치표 형식 오류 \(.* 줄 2:/);

  rmSync(f.table);
  mkdirSync(f.table);
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /배치표를 읽을 수 없음 \(EISDIR\)/);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.hosts()[0].metadata.work, '실험');
});

test('CLI: 데몬 응답 실패·paseo 없음·update 실패는 stderr의 오류 코드만 상태로 남기고 0으로 끝나며 다음 실행에서 다시 시도한다', t => {
  const f = fixture(t);
  f.writeTable('srv_a 외주\nsrv_c 외주\n');
  writeFileSync(join(f.fake, 'down'), '');
  let result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'host work 맞춤 실패: 데몬 응답 없음 (paseo host ls: DAEMON_NOT_RUNNING). 다음 갱신에서 다시 확인합니다\n', '오류 코드만 남긴다');
  assert.deepEqual(f.calls(), ['host ls --json'], '데몬을 켜거나 다른 명령을 부르지 않는다');
  assert.match(f.state(), /DAEMON_NOT_RUNNING/);
  assert.equal(f.run(['--auto']).stdout, '', '같은 실패는 한 번만 기록한다');
  f.calls();

  result = f.run([], { PATH: `${join(f.fake, 'empty')}:/usr/bin:/bin` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /데몬 응답 없음 \(paseo host ls: paseo 없음\)/);

  rmSync(join(f.fake, 'down'));
  result = f.run(['--auto'], { FAIL_UPDATE: 'reg-a' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /host work 맞춤: C \(srv_c\) 실험 → 외주/, '실패한 host와 관계없이 나머지는 맞춘다');
  assert.match(result.stdout, /host work 맞춤 남음: A \(srv_a\) 실패 \(HOST_UPDATE_FAILED\)/);
  f.calls();
  result = f.run(['--auto']);
  assert.deepEqual(f.calls(), ['host ls --json', 'host update reg-a --meta work=외주']);
  assert.match(result.stdout, /host work 일치/);
});

test('CLI: 멈춘 paseo는 TERM을 무시해도 시간 상한에 SIGKILL로 끝내고, 상태 파일 쓰기 실패는 한 줄만 남긴다', t => {
  const f = fixture(t);
  f.writeTable('srv_a 외주\n');
  writeFileSync(join(f.fake, 'hang'), '');
  const started = Date.now();
  let result = f.run(['--auto'], { BOOTSTRAP_HOST_WORK_TIMEOUT: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 5000, '시간 상한 안에 끝난다');
  assert.match(result.stdout, /데몬 응답 없음 \(paseo host ls: 시간 초과\)/);
  assert.throws(() => process.kill(Number(readFileSync(join(f.fake, 'hang-pid'), 'utf8')), 0), '멈춘 paseo를 남기지 않는다');
  rmSync(join(f.fake, 'hang'));

  rmSync(f.statePath);
  mkdirSync(f.statePath);
  result = f.run(['--auto']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^host work 상태 기록 실패 \(~\/\.local\/state\/bootstrap\/update\/host-work: EISDIR\)$/m);
  assert.equal(result.stderr, '', '스택을 남기지 않는다');
});
