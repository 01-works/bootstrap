import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, lstatSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// 구현 전 실패 확인: YW_HEAVY_SCRIPT=<반려된 구현> node --test --test-name-pattern 'D[1-4]-legacy' scripts/yw-heavy.test.mjs
const script = process.env.YW_HEAVY_SCRIPT || fileURLToPath(new URL('./yw-heavy.sh', import.meta.url));
const legacyFixture = fileURLToPath(new URL('./fixtures/cc-yw-heavy-legacy.sh', import.meta.url));
const quote = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(r => setTimeout(r, ms));
const read = p => existsSync(p) ? readFileSync(p, 'utf8') : '';
const dead = '2147483647';
// 구버전 대기자가 실제로 쓰는 경로는 이 기기의 실제 작업 때문에 바뀔 수 있다. 거기에는 테스트 표지(worker w·wk, 새 버전 편집 표지)가
// 들어가지 않았는지만 보고, 구버전이 건드리지 않는 경로는 inode·mtime이 그대로인지 본다.
const strictLivePaths = ['/tmp/yw-heavy-queue.flock', '/tmp/yw-heavy-queue.log', '/tmp/yw-heavy-queue.no-reclaim', '/tmp/cc-yw-heavy.sh',
  join(process.env.HOME, '.local/bin/yw-heavy')];
function snapshot(paths) {
  return paths.map(p => { try { const s = lstatSync(p); return [p, s.ino, s.mtimeMs]; } catch { return [p, null]; } });
}
function assertLiveUntouched(before) {
  assert.deepEqual(snapshot(strictLivePaths), before, '실제 heavy 경로의 inode/mtime은 바꾸지 않는다');
  assert.doesNotMatch(read('/tmp/yw-heavy-queue'), / worker=wk? /, '실제 대기열에 테스트 줄이 없다');
  assert.doesNotMatch(read('/tmp/yw-heavy-check.lock/owner.txt'), /"worker":"wk?"/, '실제 실행 lock이 테스트 것이 아니다');
  let edit = null; try { edit = lstatSync('/tmp/yw-heavy-queue.edit.lock'); } catch {}
  assert.ok(!edit || edit.isDirectory(), '실제 편집 lock 경로에 새 버전 표지가 없다');
}
// 디렉터리 아래 모든 항목의 inode·mtime·크기 (status 읽기 전용 확인용).
function tree(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name), s = lstatSync(p);
    out.push([p, s.ino, s.mtimeMs, s.size]);
    if (s.isDirectory()) out.push(...tree(p));
  }
  return out;
}
// ps와 같은 형식의 시작 시각 (Mon_Oct_19_05:08:49_2026).
const procStart = pid => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, encoding: 'utf8' })
  .stdout.trim().split(/\s+/).join('_');

function fixture(t) {
  const before = snapshot(strictLivePaths);
  const dir = mkdtempSync(join(tmpdir(), 'yw-heavy-test-'));
  const q = join(dir, 'q'), x = join(dir, 'x'), e = join(dir, 'e');
  const hook = join(dir, 'bash-env');
  // Deterministic EPERM even when this suite is run outside the agent sandbox.
  const baseHook = `kill() { if [ "$1" = -0 ] && [ "$2" = 1 ]; then echo 'kill: (1) - Operation not permitted' >&2; return 1; fi; builtin kill "$@"; }\nsleep() { case "$1" in 30|2) /bin/sleep .05;; *) /bin/sleep "$@";; esac; }\n`;
  writeFileSync(hook, baseHook);
  // 기본 대역에 셸 함수를 더한 BASH_ENV (특정 구간에서 자기 자신을 kill -9하는 shim 등).
  let hooks = 0;
  const hookWith = extra => { const path = join(dir, `bash-env-${++hooks}`); writeFileSync(path, baseHook + extra + '\n'); return path; };
  const env = { ...process.env, HOME: join(dir, 'home'), BASH_ENV: hook, YW_HEAVY_QUEUE: q, YW_HEAVY_EXEC_LOCK: x, YW_HEAVY_EDIT_LOCK: e,
    YW_HEAVY_FLOCK: join(dir, 'flock'), YW_HEAVY_LOG: join(dir, 'log'), YW_HEAVY_NO_RECLAIM: join(dir, 'no-reclaim'), YW_HEAVY_POLL: '.05' };
  mkdirSync(env.HOME);
  const children = [];
  const track = p => {
    p.out = ''; p.err = ''; p.stdout?.on('data', b => p.out += b); p.stderr?.on('data', b => p.err += b);
    p.done = new Promise(resolve => p.on('close', (code, signal) => { p.result = { code, signal }; resolve(p.result); }));
    children.push(p); return p;
  };
  // 자식마다 프로세스 그룹을 따로 두고 정리할 때 그룹째 끝낸다. 남은 손자가 출력 파이프를 붙잡아 정리가 멈추지 않게 한다.
  const start = (args, options = {}) => track(spawn('/bin/bash', args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, ...options }));
  const cli = (...args) => start([script, ...args]);
  const cliEnv = (extra, ...args) => start([script, ...args], { env: { ...env, ...extra } });
  // 살아 있는 프로세스 (holder·대기자 대역). 테스트가 끝나면 정리한다.
  const live = () => track(spawn('/bin/sleep', ['30'], { stdio: 'ignore', detached: true }));
  const sync = (...args) => spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8' });
  const wait = async (fn, message = 'condition', timeout = 3500) => {
    const end = Date.now() + timeout;
    while (!fn()) { if (Date.now() >= end) assert.fail(`timeout: ${message}`); await pause(20); }
  };
  const finish = async (p, timeout) => { await wait(() => p.result, `exit: ${p.out} ${p.err}`, timeout); return p.result.code; };
  t.after(async () => {
    for (const p of children) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
    await Promise.all(children.map(p => p.done));
    rmSync(dir, { recursive: true, force: true });
    assertLiveUntouched(before);
  });
  const owner = data => { mkdirSync(x, { recursive: true }); writeFileSync(join(x, 'owner.txt'), JSON.stringify(data) + '\n'); };
  const ownerText = () => read(join(x, 'owner.txt'));
  const line = (id, pid = dead, start = '-', sup = 's') => `${id} worker=w supervisor=${sup} v=2 pid=${pid} start=${start}\n`;
  // 구버전 원문에서 경로만 임시 디렉터리로 바꾼다. sleep은 BASH_ENV가 줄인다.
  const legacy = () => {
    const path = join(dir, 'legacy.sh');
    writeFileSync(path, readFileSync(legacyFixture, 'utf8')
      .replace('Q=/tmp/yw-heavy-queue\n', `Q=${quote(q)}\n`)
      .replace('EL=/tmp/yw-heavy-queue.edit.lock\n', `EL=${quote(e)}\n`)
      .replace('XL=/tmp/yw-heavy-check.lock\n', `XL=${quote(x)}\n`)
      .replaceAll('mktemp /tmp/yw-heavy-queue.tmp.XXXXXX', `mktemp ${quote(q)}.tmp.XXXXXX`), { mode: 0o755 });
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\/tmp\/yw-heavy/, '구버전 사본은 실제 /tmp 경로를 쓰지 않는다');
    return path;
  };
  return { dir, q, x, e, env, start, cli, cliEnv, live, sync, wait, finish, owner, ownerText, line, legacy, hookWith, log: () => read(env.YW_HEAVY_LOG) };
}

// ---- 반려 결함 재현 (구 CLI만 쓰는 *-legacy는 반려 구현에서 실패해야 한다) ----

for (const [name, pid] of [['D1-legacy EPERM owner 보존', 1], ['D3-legacy 죽은 구형식 owner 보존', Number(dead)]]) {
  test(name, async t => {
    const f = fixture(t); f.owner({ pid, task: 'OLD' });
    const before = read(join(f.x, 'owner.txt'));
    const p = f.cli('acquire', 'B', 'w', 's');
    await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(350);
    assert.equal(p.out, ''); assert.equal(read(join(f.x, 'owner.txt')), before);
  });
}
test('D2-legacy 곧 끝나는 래퍼 뒤에도 holder 없는 lock 보존', async t => {
  const f = fixture(t);
  const wrapper = f.start(['-c', `/bin/bash -c '${quote(script).replaceAll("'", "'\\''")} acquire A w s; :' ; /bin/sleep .5`]);
  await f.wait(() => wrapper.out.includes('ACQUIRED A'), 'A acquired');
  const p = f.cli('acquire', 'B', 'w', 'other');
  await pause(250); assert.equal(p.out, '', '바깥 작업이 살아 있을 때');
  assert.equal(await f.finish(wrapper), 0); await pause(250);
  assert.equal(p.out, '', '작업 종료 뒤에도 명시적 release가 필요');
  assert.equal(JSON.parse(read(join(f.x, 'owner.txt'))).task, 'A');
});
test('D4-legacy 죽은 같은 ID를 재시도하면 획득', async t => {
  const f = fixture(t); writeFileSync(f.q, f.line('X'));
  const p = f.cli('acquire', 'X', 'w', 's');
  assert.equal(await f.finish(p), 0); assert.equal(p.out, 'ACQUIRED X\n');
});

test('D1-v2 holder와 맨 앞 대기 줄이 EPERM이면 둘 다 보존', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'H', v: 2, holder: 1 });
  writeFileSync(f.q, f.line('L1', 1));
  const before = f.ownerText();
  const p = f.cli('acquire', 'B', 'w', 'other');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(350);
  assert.equal(p.out, '');
  assert.match(read(f.q), /^L1 worker=w supervisor=s v=2 pid=1 start=-\n/);
  assert.equal(f.ownerText(), before);
  assert.equal(f.log(), '');
});

test('D2-holder: holder가 살아 있으면 대기, kill -9 뒤 회수하고 기록', async t => {
  const f = fixture(t);
  const h = f.start(['-c', `${quote(script)} acquire A w s --holder $$ && exec /bin/sleep 30`]);
  await f.wait(() => h.out.includes('ACQUIRED A'), 'A acquired');
  const b = f.cli('acquire', 'B', 'w', 'other');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, '', 'holder 생존 중');
  h.kill('SIGKILL');
  assert.equal(await f.finish(b), 0); assert.equal(b.out, 'ACQUIRED B\n');
  assert.match(f.log(), new RegExp(`reclaim kind=exec task=A pid=${h.pid} start=\\S+ reason=esrch by=\\d+:B`));
  assert.doesNotMatch(read(f.q), /^A /m, '죽은 holder의 줄도 함께 지운다');
});

test('D3-gate: 구형식 줄이 있으면 죽은 v2 holder도 보존, 구형식 줄이 빠지면 회수', async t => {
  const f = fixture(t);
  f.owner({ pid: Number(dead), task: 'V', v: 2, holder: Number(dead) });
  writeFileSync(f.q, 'OLD worker=w supervisor=o\n');
  const b = f.cli('acquire', 'B', 'w', 's');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, ''); assert.equal(JSON.parse(f.ownerText()).task, 'V');
  const status = f.sync('status');
  assert.match(status.stdout, /관문: 닫힘 \(구형식 줄 1개\)/);
  assert.match(status.stdout, /1\. OLD {2}구형식/);
  assert.equal(await f.finish(f.cli('release', 'OLD')), 0);
  assert.equal(await f.finish(b), 0); assert.equal(b.out, 'ACQUIRED B\n');
  assert.match(f.log(), /reclaim kind=exec task=V pid=2147483647 start=- reason=esrch/);
});

test('D3-stress: 구버전 3개·새 버전 여럿 동시 실행과 holder kill -9에도 이중 보유 0', async t => {
  const f = fixture(t);
  const legacy = f.legacy(), inside = join(f.dir, 'inside'), fails = join(f.dir, 'fails');
  const crit = name => `{ mkdir ${quote(inside)} 2>/dev/null || echo ${name} >> ${quote(fails)}; echo ${name} > ${quote(inside)}/who; /bin/sleep .15; rm -rf ${quote(inside)}; }`;
  const S = quote(script), L = quote(legacy);
  const workers = [];
  for (const i of [1, 2, 3]) workers.push(f.start(['-c', `/bin/bash ${L} acquire L${i} w sl${i} >/dev/null && ${crit(`L${i}`)}; /bin/bash ${L} release L${i} >/dev/null`]));
  workers.push(f.cli('run', 'R1', 'w', 'sr1', '--', '/bin/bash', '-c', crit('R1')));
  workers.push(f.cli('run', 'R2', 'w', 'sr2', '--', '/bin/bash', '-c', crit('R2')));
  workers.push(f.start(['-c', `${S} acquire H1 w sh1 --holder $$ >/dev/null && ${crit('H1')}; ${S} release H1 >/dev/null`]));
  // 구버전 줄이 모두 들어간 뒤에 온 대기자는 구버전 줄이 다 빠진 뒤(관문 열림)에 차례를 받는다.
  await f.wait(() => [1, 2, 3].every(i => read(f.q).includes(`L${i} `) || workers[i - 1].result), 'legacy enqueued', 5000);
  const victim = f.start(['-c', `${S} acquire H2 w sh2 --holder $$ >/dev/null && { mkdir ${quote(inside)} 2>/dev/null || echo H2 >> ${quote(fails)}; echo H2 > ${quote(inside)}/who; exec /bin/sleep 30; }`]);
  await pause(30);
  workers.push(f.start(['-c', `${S} acquire H3 w sh3 --holder $$ >/dev/null && ${crit('H3')}; ${S} release H3 >/dev/null`]));
  workers.push(f.cli('run', 'R3', 'w', 'sr3', '--', '/bin/bash', '-c', crit('R3')));
  await f.wait(() => read(join(inside, 'who')).trim() === 'H2', 'victim inside', 15000);
  assert.doesNotMatch(read(f.q), /^L\d /m, '구버전 줄이 모두 빠진 뒤');
  rmSync(inside, { recursive: true, force: true });
  victim.kill('SIGKILL');
  for (const w of workers) assert.equal(await f.finish(w, 15000), 0, `${w.out} ${w.err}`);
  assert.equal(read(fails), '', '보유 구간이 겹치지 않는다');
  assert.equal(read(f.q).trim(), '', '살아 남은 작업이 모두 끝나면 대기열이 빈다');
  assert.equal(existsSync(f.x), false);
  const reclaimed = [...f.log().matchAll(/reclaim kind=(?:exec|line) task=\S+ pid=(\d+)/g)].map(m => Number(m[1]));
  assert.ok(reclaimed.includes(victim.pid), f.log());
  assert.deepEqual(reclaimed.filter(pid => pid !== victim.pid), [], '살아 있는 pid를 회수하지 않는다');
});

test('D3-enqueue: 구 acquire의 "$0" enqueue가 새 도구로 연결되어도 구형식 줄로 정상 획득', async t => {
  const f = fixture(t);
  const link = join(f.dir, 'cc.sh');
  symlinkSync(script, link);
  const source = readFileSync(f.legacy(), 'utf8');
  const p = f.start(['-c', source, link, 'acquire', 'E', 'w', 's']);
  assert.equal(await f.finish(p), 0); assert.equal(p.out, 'ACQUIRED E\n');
  assert.equal(read(f.q), 'E worker=w supervisor=s\n');
  assert.equal(JSON.parse(f.ownerText()).task, 'E');
  assert.equal(await f.finish(f.start([link, 'release', 'E'])), 0);
  assert.equal(read(f.q), ''); assert.equal(existsSync(f.x), false);
});

test('D4-live: 살아 있는 같은 ID 대기자는 이어받히고 종료 코드 3', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'HEAD' });
  writeFileSync(f.q, 'HEAD worker=w supervisor=o\n');
  const a1 = f.cli('acquire', 'X', 'w', 's');
  await f.wait(() => read(f.q).includes('X '), 'X enqueued');
  const a2 = f.cli('acquire', 'X', 'w', 's');
  assert.equal(await f.finish(a1), 3); assert.match(a1.err, /superseded by pid \d+/);
  assert.match(f.log(), new RegExp(`takeover task=X pid=${a1.pid} start=\\S+ state=alive`));
  assert.equal(read(f.q).split('\n').filter(l => l.startsWith('X ')).length, 1);
  assert.equal(await f.finish(f.cli('release', 'HEAD')), 0);
  assert.equal(await f.finish(a2), 0); assert.equal(a2.out, 'ACQUIRED X\n');
});

test('D4-held·D4-old: 같은 ID가 차례를 가졌거나 구형식 줄이면 바로 종료 코드 3', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'X', v: 2 });
  const held = f.cli('acquire', 'X', 'w', 's');
  assert.equal(await f.finish(held, 1500), 3); assert.match(held.err, /이미 차례를 가진 ID.*release X/);
  const g = fixture(t);
  writeFileSync(g.q, 'X worker=w supervisor=s\n');
  const old = g.cli('acquire', 'X', 'w', 's');
  assert.equal(await g.finish(old, 1500), 3); assert.match(old.err, /구버전 대기 줄/);
  assert.equal(read(g.q), 'X worker=w supervisor=s\n');
});

test('D4-release: 대기 중에 release되면 대기자는 종료 코드 3', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'O' });
  const w = f.cli('acquire', 'X', 'w', 's');
  await f.wait(() => read(f.q).includes('X '), 'X enqueued');
  assert.equal(await f.finish(f.cli('release', 'X')), 0);
  assert.equal(await f.finish(w), 3); assert.match(w.err, /entry removed/);
  assert.equal(JSON.parse(f.ownerText()).task, 'O', '남의 실행 lock은 그대로');
});

// ---- 편집 lock ----

const exists = p => { try { lstatSync(p); return true; } catch { return false; } };
test('flock을 잡은 뒤 남아 있는 새 버전 편집 표지는 죽은 것이므로 지우고 기록한다', async t => {
  for (const make of [p => writeFileSync(p, `yw-heavy-v2:pid=${dead}:task=Z\n`), p => symlinkSync(`yw-heavy-v2:pid=${dead}:task=Z`, p)]) {
    const f = fixture(t);
    make(f.e);
    const p = f.cli('acquire', 'A', 'w', 's');
    assert.equal(await f.finish(p), 0);
    assert.match(f.log(), /reclaim kind=edit task=Z pid=2147483647 start=- reason=stale-edit-mark/);
    assert.equal(exists(f.e), false, '작업이 끝나면 자기 표지도 지운다');
  }
});

test('표지에서 읽은 task의 제어 문자와 $·`는 기록에 남기지 않는다', async t => {
  const f = fixture(t);
  writeFileSync(f.e, `yw-heavy-v2:pid=${dead}:task=Z$(id)\`id\`\x1b[31m\r\x07\n`);
  assert.equal(await f.finish(f.cli('acquire', 'A', 'w', 's')), 0);
  assert.match(f.log(), /reclaim kind=edit task=Z\(id\)id\[31m pid=2147483647 start=- reason=stale-edit-mark/);
  assert.doesNotMatch(f.log(), /[$`\x00-\x09\x0b-\x1f\x7f]/);
});

test('flock을 쥔 프로세스가 kill -9되면 다음 작업이 바로 진행한다', async t => {
  const f = fixture(t);
  const holder = f.start(['-c', `exec /usr/bin/lockf -k ${quote(f.env.YW_HEAVY_FLOCK)} /bin/sleep 2`]);
  await f.wait(() => spawnSync('/usr/bin/lockf', ['-k', '-t', '0', f.env.YW_HEAVY_FLOCK, 'true']).status === 75, 'flock held');
  const p = f.cli('acquire', 'A', 'w', 's');
  await pause(300); assert.equal(p.out, '', 'flock을 기다린다');
  holder.kill('SIGKILL');
  assert.equal(await f.finish(p, 1500), 0); assert.equal(p.out, 'ACQUIRED A\n');
});

test('구형식 디렉터리 편집 lock: 죽은 owner는 회수, 판단 불가는 보존', async t => {
  const f = fixture(t);
  mkdirSync(f.e); writeFileSync(join(f.e, 'owner.txt'), `{"pid":${dead},"task":"T"}\n`);
  assert.equal(await f.finish(f.cli('acquire', 'A', 'w', 's')), 0);
  assert.match(f.log(), /reclaim kind=edit task=T pid=2147483647 start=- reason=legacy-edit-esrch/);

  const g = fixture(t);
  mkdirSync(g.e); writeFileSync(join(g.e, 'owner.txt'), '{"pid":1,"task":"T"}\n');
  const p = g.cli('acquire', 'A', 'w', 's');
  await pause(400); assert.equal(p.out, ''); assert.deepEqual(readdirSync(g.e), ['owner.txt'], 'EPERM owner 보존, 디렉터리 안에 아무것도 만들지 않는다');
  rmSync(g.e, { recursive: true });
  assert.equal(await g.finish(p), 0, '수동 제거 뒤 진행');

  const h = fixture(t);
  mkdirSync(h.e);
  const w = h.cliEnv({ YW_HEAVY_EDIT_WARN: '0' }, 'acquire', 'A', 'w', 's');
  await h.wait(() => w.err.includes('편집 lock이 0초 넘게 남아 있습니다'), 'warning');
  assert.equal(w.out, ''); assert.deepEqual(readdirSync(h.e), [], 'owner.txt 없는 lock 보존');
  assert.match(h.sync('status').stdout, /편집 lock: 구형식, owner.txt 없음/);
  rmSync(h.e, { recursive: true });
  assert.equal(await h.finish(w), 0);
  assert.equal(h.log(), '');
});

// ---- PID 재사용과 ps ----

test('PID 재사용: 살아 있는 pid라도 시작 시각이 다르면 회수, 같으면 보존', async t => {
  const f = fixture(t);
  const s = f.live();
  await f.wait(() => procStart(s.pid), 'ps start');
  f.owner({ pid: s.pid, task: 'S', v: 2, holder: s.pid, holderStart: 'Thu_Jan_1_00:00:00_1970' });
  const b = f.cli('acquire', 'B', 'w', 's');
  assert.equal(await f.finish(b), 0);
  assert.match(f.log(), new RegExp(`reclaim kind=exec task=S pid=${s.pid} start=Thu_Jan_1_00:00:00_1970 reason=start-mismatch`));

  const g = fixture(t);
  g.owner({ pid: s.pid, task: 'S', v: 2, holder: s.pid, holderStart: procStart(s.pid) });
  const c = g.cli('acquire', 'C', 'w', 's');
  await g.wait(() => read(g.q).includes('C '), 'C enqueued'); await pause(300);
  assert.equal(c.out, ''); assert.equal(JSON.parse(g.ownerText()).task, 'S');
});

test('ps가 실패하면 시작 시각이 틀려도 보존 (unknown)', async t => {
  const f = fixture(t);
  const bin = join(f.dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const s = f.live();
  f.owner({ pid: s.pid, task: 'S', v: 2, holder: s.pid, holderStart: 'Thu_Jan_1_00:00:00_1970' });
  writeFileSync(f.q, f.line('W', s.pid, 'Thu_Jan_1_00:00:00_1970', 'o'));
  const b = f.cliEnv({ PATH: `${bin}:${process.env.PATH}` }, 'acquire', 'B', 'w', 's');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, ''); assert.equal(JSON.parse(f.ownerText()).task, 'S');
  assert.match(read(f.q), /^W /); assert.equal(f.log(), '');
});

// ---- 규약 ----

test('출력·v2 줄 형식·owner JSON(구 필드 포함)과 사용법 오류', async t => {
  const f = fixture(t);
  const s = f.live();
  await f.wait(() => procStart(s.pid), 'ps start');
  const a = f.cli('acquire', 'X', 'wk', 'sp', '--holder', String(s.pid));
  assert.equal(await f.finish(a), 0); assert.equal(a.out, 'ACQUIRED X\n');
  assert.equal(read(f.q), `X worker=wk supervisor=sp v=2 pid=${s.pid} start=${procStart(s.pid)}\n`, '획득 뒤 줄은 holder를 가리킨다');
  const owner = JSON.parse(f.ownerText());
  assert.deepEqual(Object.keys(owner), ['pid', 'startedAt', 'supervisor', 'task', 'worker', 'cwd', 'v', 'holder', 'holderStart']);
  assert.equal(owner.pid, s.pid); assert.equal(owner.holder, s.pid); assert.equal(owner.holderStart, procStart(s.pid));
  assert.match(owner.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual([owner.supervisor, owner.task, owner.worker, owner.v], ['sp', 'X', 'wk', 2]);
  assert.deepEqual(f.sync('release', 'X').stdout, 'released X\n');
  assert.equal(read(f.q), ''); assert.equal(existsSync(f.x), false);

  const n = f.cli('acquire', 'N', 'w', 's');
  assert.equal(await f.finish(n), 0);
  assert.equal(read(f.q), 'N worker=w supervisor=s v=2 pid=- start=-\n', 'holder가 없으면 회수 대상이 아니다');
  assert.equal(JSON.parse(f.ownerText()).holder, undefined);
  assert.equal(typeof JSON.parse(f.ownerText()).pid, 'number');
  assert.equal(f.sync('enqueue', 'E', 'w', 's').stdout, 'enqueued E\n');
  assert.equal(read(f.q), 'N worker=w supervisor=s v=2 pid=- start=-\nE worker=w supervisor=s\n');

  for (const args of [['acquire', 'a b', 'w', 's'], ['acquire', 'A', 'w'], ['acquire', 'A', 'w', 's', '--holder', 'x'],
    ['acquire', 'A', 'w', 's', '--holder', dead], ['run', 'A', 'w', 's', 'true'], ['release'], ['nope']]) {
    assert.equal(f.sync(...args).status, 2, args.join(' '));
  }
});

test('감독자별 상한 2줄: 세 번째는 대기, 자기 ID 재시도와 죽은 줄은 세지 않고, 동시 등록도 넘지 않는다', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'HOLD' });
  writeFileSync(f.q, 'A worker=w supervisor=S\nB worker=w supervisor=S\n');
  const c = f.cli('acquire', 'C', 'w', 'S');
  await f.wait(() => c.err.includes('대기 줄이 이미 2개'), 'cap message');
  assert.doesNotMatch(read(f.q), /^C /m);
  assert.equal(await f.finish(f.cli('release', 'A')), 0);
  await f.wait(() => read(f.q).includes('C '), 'C enqueued after release');

  const g = fixture(t);
  g.owner({ pid: 1, task: 'HOLD' });
  writeFileSync(g.q, 'A worker=w supervisor=S\n' + g.line('X', dead, '-', 'S'));
  const x = g.cli('acquire', 'X', 'w', 'S');
  await g.wait(() => new RegExp(`^X .* pid=${x.pid} `, 'm').test(read(g.q)), 'X takeover');

  const h = fixture(t);
  writeFileSync(h.q, h.line('D1', dead, '-', 'S') + h.line('D2', dead, '-', 'S'));
  const d = h.cli('acquire', 'C', 'w', 'S');
  assert.equal(await h.finish(d), 0);
  assert.equal((h.log().match(/reclaim kind=line/g) || []).length, 2);

  const k = fixture(t);
  k.owner({ pid: 1, task: 'HOLD' });
  writeFileSync(k.q, 'A worker=w supervisor=S\n');
  k.cli('acquire', 'C1', 'w', 'S'); k.cli('acquire', 'C2', 'w', 'S');
  await k.wait(() => /^C\d /m.test(read(k.q)), 'one enqueued'); await pause(400);
  assert.equal(read(k.q).split('\n').filter(l => l.includes('supervisor=S')).length, 2);
});

test('run: 종료 코드 전달, 끝나면 해제, SIGTERM은 명령이 끝날 때까지 유지 후 143, fd 9 미상속, stdin 전달', async t => {
  const f = fixture(t);
  const failed = f.cli('run', 'R', 'w', 's', '--', '/bin/sh', '-c', 'exit 7');
  assert.equal(await f.finish(failed), 7);
  assert.equal(existsSync(f.x), false); assert.equal(read(f.q), '');
  const okRun = f.cli('run', 'R', 'w', 's', '--', '/bin/sh', '-c', 'echo "$1"', '_', 'a b');
  assert.equal(await f.finish(okRun), 0); assert.equal(okRun.out, 'a b\n');
  assert.equal(existsSync(f.x), false);

  const term = f.cli('run', 'R', 'w', 's', '--', '/bin/sh', '-c', 'echo started; /bin/sleep .6; echo done');
  await f.wait(() => term.out.includes('started'), 'started');
  term.kill('SIGTERM');
  await pause(200);
  assert.equal(JSON.parse(f.ownerText()).task, 'R', '명령이 끝날 때까지 차례 유지');
  assert.equal(await f.finish(term), 143); assert.match(term.out, /done/);
  assert.equal(existsSync(f.x), false); assert.equal(read(f.q), '');

  const free = f.cli('run', 'R', 'w', 's', '--', '/bin/sh', '-c', `/usr/bin/lockf -k -t 0 ${quote(f.env.YW_HEAVY_FLOCK)} true && echo free`);
  assert.equal(await f.finish(free), 0); assert.equal(free.out, 'free\n');

  const cat = f.cli('run', 'R', 'w', 's', '--', '/bin/cat');
  cat.stdin.end('hello\n');
  assert.equal(await f.finish(cat), 0); assert.equal(cat.out, 'hello\n');
});

test('no-reclaim 파일이 있으면 죽은 holder·줄도 회수하지 않는다', async t => {
  const f = fixture(t);
  writeFileSync(f.env.YW_HEAVY_NO_RECLAIM, '');
  f.owner({ pid: Number(dead), task: 'V', v: 2, holder: Number(dead) });
  writeFileSync(f.q, f.line('V') + f.line('D', dead, '-', 'o'));
  const b = f.cli('acquire', 'B', 'w', 's');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, ''); assert.equal(JSON.parse(f.ownerText()).task, 'V');
  assert.match(read(f.q), /^D /m); assert.equal(f.log(), '');
  assert.match(f.sync('status').stdout, /회수: 꺼짐/);
});

test('status는 읽기 전용이고 관문·구형식 줄·holder 상태를 보인다', async t => {
  const f = fixture(t);
  f.owner({ pid: Number(dead), task: 'V', v: 2, holder: Number(dead) });
  writeFileSync(f.q, f.line('V') + 'OLD worker=w supervisor=o\n');
  writeFileSync(f.e, `yw-heavy-v2:pid=${dead}:task=Z\n`);
  writeFileSync(f.env.YW_HEAVY_LOG, 'earlier reclaim kind=line\n');
  const before = tree(f.dir);
  const status = f.sync('status');
  assert.equal(status.status, 0);
  assert.deepEqual(tree(f.dir), before, 'status는 아무 파일도 만들거나 바꾸지 않는다');
  assert.match(status.stdout, /1\. V {2}v2 {2}s {2}\[pid 2147483647 dead:esrch\]/);
  assert.match(status.stdout, /2\. OLD {2}구형식/);
  assert.match(status.stdout, /실행 lock: task=V holder=2147483647 dead:esrch/);
  assert.match(status.stdout, /편집 lock: yw-heavy-v2:pid=2147483647:task=Z/);
  assert.match(status.stdout, /관문: 닫힘 \(구형식 줄 1개\)/);
  assert.match(status.stdout, /earlier reclaim/);
});

test('bash 3.2 문법만 쓴다', () => {
  for (const file of [script, fileURLToPath(new URL('./steps/66-heavy.sh', import.meta.url))]) {
    const syntax = spawnSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const source = readFileSync(file, 'utf8');
    // ko_KR 로캘의 bash 3.2는 변수 이름 바로 뒤의 비ASCII 문자(한글·기호)를 이름의 일부로 읽는다: ${SUP}의 처럼 쓴다.
    assert.doesNotMatch(source, /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/, `${file}: 변수 뒤에 붙은 비ASCII 문자`);
    for (const pattern of [/declare -A/, /\bmapfile\b/, /\breadarray\b/, /\$\{[^}]*,,\}/, /\$\{[^}]*\^\^\}/, /\|&/, /&>>/]) {
      assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
    }
  }
  assert.match(spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' }).stdout, /version 3\.2/);
});

// ---- 리뷰 지적 보강 ----

test('실행 lock을 만들던 중 SIGKILL되어 owner가 없으면 관문이 열려 있고 오래됐을 때만 회수', async t => {
  const f = fixture(t);
  const killAfterMkdir = f.hookWith('mkdir() { command mkdir "$@" || return; [ "$1" = "$YW_HEAVY_EXEC_LOCK" ] && builtin kill -9 $$; return 0; }');
  const a = f.cliEnv({ BASH_ENV: killAfterMkdir }, 'acquire', 'A', 'w', 's');
  assert.equal((await a.done).signal, 'SIGKILL');
  assert.deepEqual(readdirSync(f.x), [], 'owner 없는 실행 lock이 남는다');
  const young = f.cliEnv({ YW_HEAVY_OWNERLESS_AGE: '3600' }, 'acquire', 'B', 'w', 'other');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(young.out, '', '최근에 바뀐 것은 보존');
  assert.match(f.sync('status').stdout, /실행 lock: .* \(owner 없음, \d+초 전 변경\)\. 관문이 열려 있고 \d+초가 지나면 자동 회수/);
  writeFileSync(f.env.YW_HEAVY_NO_RECLAIM, '');
  const off = f.sync('status').stdout;
  assert.match(off, /실행 lock: .* \(owner 없음, \d+초 전 변경\)\. 회수가 꺼져 있어 자동 회수하지 않음/);
  assert.doesNotMatch(off, /지나면 자동 회수/, 'no-reclaim이면 자동 회수라고 하지 않는다');
  rmSync(f.env.YW_HEAVY_NO_RECLAIM);
  young.kill('SIGKILL'); await young.done;
  const b = f.cliEnv({ YW_HEAVY_OWNERLESS_AGE: '0' }, 'acquire', 'B', 'w', 'other');
  assert.equal(await f.finish(b), 0); assert.equal(b.out, 'ACQUIRED B\n');
  assert.match(f.log(), /reclaim kind=exec task=- pid=- start=- reason=ownerless-stale/);
  assert.match(f.log(), new RegExp(`reclaim kind=line task=A pid=${a.pid} `), '죽은 대기자 줄도 회수');
});

test('실행 lock을 지우던 중 SIGKILL되어도 회수하고, 관문이 닫혀 있으면 보존, release는 사실대로 알린다', async t => {
  const f = fixture(t);
  assert.equal(await f.finish(f.cli('acquire', 'A', 'w', 's')), 0);
  const killAfterRm = f.hookWith(`rm() { command rm "$@"; case " $* " in *" $YW_HEAVY_EXEC_LOCK/owner.txt "*) builtin kill -9 $$ ;; esac; }`);
  const rel = f.cliEnv({ BASH_ENV: killAfterRm }, 'release', 'A');
  assert.equal((await rel.done).signal, 'SIGKILL');
  assert.deepEqual(readdirSync(f.x), []);
  writeFileSync(f.q, read(f.q) + 'OLD worker=w supervisor=o\n');
  const b = f.cliEnv({ YW_HEAVY_OWNERLESS_AGE: '0' }, 'acquire', 'B', 'w', 'other');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, '', '관문이 닫혀 있으면 보존'); assert.ok(existsSync(f.x));
  const old = f.sync('release', 'OLD');
  assert.equal(old.status, 0); assert.equal(old.stdout, 'released OLD\n');
  assert.match(old.stderr, /owner 없는 실행 lock이 남아 있어 .*대기 줄만 지웠습니다/);
  // 관문이 열리면(A 줄은 owner가 없어 v2 실행 lock 회수와 무관) owner 없는 lock을 회수한다.
  assert.equal(f.sync('release', 'A').status, 0);
  assert.equal(await f.finish(b), 0);
  assert.match(f.log(), /reason=ownerless-stale/);

  const g = fixture(t);
  g.owner({ pid: 1, task: 'X', v: 2 });
  writeFileSync(join(g.x, 'extra'), '');
  writeFileSync(g.q, 'X worker=w supervisor=s\n');
  const stuck = g.sync('release', 'X');
  assert.equal(stuck.status, 1, '실행 lock을 지우지 못하면 1');
  assert.match(stuck.stderr, /실행 lock을 지우지 못했습니다.*대기 줄만 지웠습니다/);
  assert.equal(read(g.q), '');
});

test('상한 때문에 기다리는 동안 holder가 끝나면 등록하지 않고 종료 코드 3', async t => {
  const f = fixture(t);
  f.owner({ pid: 1, task: 'HOLD' });
  writeFileSync(f.q, 'A worker=w supervisor=S\nB worker=w supervisor=S\n');
  const s = f.live();
  await f.wait(() => procStart(s.pid), 'ps start');
  const c = f.cli('acquire', 'C', 'w', 'S', '--holder', String(s.pid));
  await f.wait(() => c.err.includes('대기 줄이 이미 2개'), 'cap message');
  s.kill('SIGKILL');
  assert.equal(await f.finish(c), 3); assert.match(c.err, /holder \d+가 끝나 대기를 그만둡니다/);
  assert.equal(await f.finish(f.cli('release', 'A')), 0);
  await pause(200);
  assert.doesNotMatch(read(f.q), /^C /m);
});

test('콜론 뒤 공백이 있는 owner JSON과 R1-heavy.py 형식 편집 lock도 읽는다', async t => {
  const f = fixture(t);
  mkdirSync(f.x); writeFileSync(join(f.x, 'owner.txt'), '{"pid": 1, "startedAt": "2026-10-31T00:00:00+00:00", "supervisor": "s", "task": "R1", "worker": "w", "cwd": "/"}\n');
  const same = f.cli('acquire', 'R1', 'w', 's');
  assert.equal(await f.finish(same, 1500), 3, '같은 ID가 차례를 가진 것으로 읽는다');
  const b = f.cli('acquire', 'B', 'w', 's');
  await f.wait(() => read(f.q).includes('B '), 'B enqueued'); await pause(300);
  assert.equal(b.out, '', '구형식(v 없음)이라 회수하지 않는다');
  assert.equal(f.sync('release', 'R1').status, 0);
  assert.equal(await f.finish(b), 0);

  const g = fixture(t);
  mkdirSync(g.e); writeFileSync(join(g.e, 'owner.txt'), `pid=${dead} task=R1-prep\n`);
  assert.equal(await g.finish(g.cli('acquire', 'A', 'w', 's')), 0);
  assert.match(g.log(), /reclaim kind=edit task=R1-prep pid=2147483647 start=- reason=legacy-edit-esrch/);
  const h = fixture(t);
  mkdirSync(h.e); writeFileSync(join(h.e, 'owner.txt'), 'pid=1 task=R1-prep\n');
  const w = h.cli('acquire', 'A', 'w', 's');
  await pause(300); assert.equal(w.out, ''); assert.match(h.sync('status').stdout, /편집 lock: 구형식 pid=1 task=R1-prep \(pid 1 unknown/);
});
