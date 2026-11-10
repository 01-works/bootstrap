import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const stepScript = process.env.YW_HEAVY_INSTALL_STEP || join(repo, 'scripts/steps/66-heavy.sh');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'yw-heavy-install-'));
  const home = join(root, 'home'), bin = join(root, 'bin'), dst = join(home, '.local/bin/yw-heavy');
  for (const dir of [join(root, 'scripts'), join(home, '.local/bin'), bin]) mkdirSync(dir, { recursive: true });
  for (const file of ['lib.sh', 'yw-heavy.sh']) copyFileSync(join(repo, 'scripts', file), join(root, 'scripts', file));
  const snapshot = join(root, 'ps-snapshot'), compat = join(root, 'cc-yw-heavy.sh');
  writeFileSync(snapshot, '1 launchd /sbin/launchd\n');
  writeFileSync(dst, '#!/bin/bash\n# old installation\n', { mode: 0o755 });
  writeFileSync(compat, '# legacy helper\n');
  writeFileSync(join(bin, 'ps'), `#!/bin/bash
[ "$*" = '-axww -o pid=,ucomm=,args=' ] || exit 64
[ "\${HEAVY_TEST_PS_ERROR:-0}" = 0 ] || exit 1
if [ -n "\${HEAVY_TEST_PID:-}" ]; then exec /bin/ps -ww -p "$HEAVY_TEST_PID" -o pid=,ucomm=,args=; fi
cat "$HEAVY_TEST_SNAPSHOT"
`, { mode: 0o755 });
  const env = { ...process.env, BOOTSTRAP_ROOT: root, HOME: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, DRY_RUN: '0', YW_HEAVY_COMPAT_PATH: compat, HEAVY_TEST_SNAPSHOT: snapshot,
    YW_HEAVY_QUEUE: join(root, 'q'), YW_HEAVY_FLOCK: join(root, 'flock'), YW_HEAVY_EXEC_LOCK: join(root, 'exec'),
    YW_HEAVY_EDIT_LOCK: join(root, 'edit'), YW_HEAVY_LOG: join(root, 'log'), YW_HEAVY_EVENTS: join(root, 'events'),
    YW_HEAVY_NO_RECLAIM: join(root, 'no-reclaim'), YW_HEAVY_GENERATION: '', YW_HEAVY_TOKEN: '' };
  delete env.BASH_ENV;
  const children = [];
  const start = args => {
    const p = spawn('/bin/bash', args, { env: { ...env, PATH: process.env.PATH }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.out = ''; p.err = '';
    p.stdout.on('data', b => p.out += b); p.stderr.on('data', b => p.err += b);
    p.done = new Promise(resolve => p.on('close', (code, signal) => { p.result = { code, signal }; resolve(p.result); }));
    children.push(p); return p;
  };
  t.after(async () => {
    for (const p of children) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
    await Promise.all(children.map(p => p.done));
    rmSync(root, { recursive: true, force: true });
  });
  const wait = async (fn, name) => {
    const end = Date.now() + 10000;
    while (!fn()) { if (Date.now() > end) assert.fail(`timeout: ${name}`); await pause(10); }
  };
  const step = extra => spawnSync('/bin/bash', [stepScript], { env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, dst, compat, snapshot, env, start, wait, step };
}

// ps의 args는 따옴표를 재현하지 않는다. 공백 경로도 끝의 이름과 인자 경계로 검출한다.
test('heavy install guard: 참여자의 이름 경계·실행기를 판정하고 보수적 오탐은 보류한다', t => {
  const f = fixture(t);
  const before = readFileSync(f.dst, 'utf8'), inode = statSync(f.dst).ino;
  const active = [
    '42 bash /bin/bash /home/u/.local/bin/yw-heavy run ID w s -- true',
    '42 bash /bin/bash /home/u/.local/bin/yw-heavy acquire ID w s',
    '42 bash /bin/bash /tmp/with spaces/yw-heavy.sh acquire ID w s',
    '42 sh sh /tmp/yw-heavy release ID',
    '42 zsh zsh /tmp/yw-heavy.sh enqueue ID w s',
    '42 bash bash /tmp/cc-yw-heavy.sh acquire ID w s',
    '42 bash bash /tmp/cc-yw-heavy run ID w s -- true',
    '42 zsh zsh /tmp/heavy.sh ID',
    '42 Python /usr/bin/python3 /tmp/R1-heavy.py ID',
    '42 yw-heavy /home/u/.local/bin/yw-heavy run ID w s -- true',
    // 셸 -c 문자열과 무관한 동명 helper도 보수적으로 보류한다.
    '42 bash bash -c echo /tmp/yw-heavy run ID w s',
  ];
  for (const row of active) {
    writeFileSync(f.snapshot, row + '\n');
    const result = f.step();
    assert.equal(result.status, 2, row + result.stderr);
    assert.match(result.stderr, /실행 중 참여자 PID 42/);
    assert.doesNotMatch(result.stderr, /ID w s/, '명령 인자는 진단에 노출하지 않는다');
    assert.equal(statSync(f.dst).ino, inode);
    assert.equal(readFileSync(f.dst, 'utf8'), before);
    assert.equal(readFileSync(f.compat, 'utf8'), '# legacy helper\n');
    assert.deepEqual(readdirSync(join(f.env.HOME, '.local/bin')), ['yw-heavy']);
  }
  for (const extra of [{ HEAVY_TEST_PS_ERROR: '1' }, {}]) {
    writeFileSync(f.snapshot, 'unparseable\n');
    assert.equal(f.step(extra).status, 2, '조회 실패·잘못된 결과는 설치를 보류');
    assert.equal(statSync(f.dst).ino, inode);
  }
  rmSync(f.dst);
  rmSync(f.compat);
  writeFileSync(f.snapshot, active[0] + '\n');
  assert.equal(f.step().status, 2, '최초 설치도 참여자 생존 중에는 보류');
  assert.equal(existsSync(f.dst), false);
  assert.equal(existsSync(f.compat), false, '보류 중에는 호환 링크도 만들지 않는다');
  assert.equal(f.step({ DRY_RUN: '1' }).status, 2, 'dry-run도 사용 중 보류를 알린다');
});

test('heavy install guard: 읽기 전용·비슷한 이름·다른 실행기는 제외하고 변경이 없으면 조회하지 않는다', t => {
  const f = fixture(t);
  const quiet = [
    '1 launchd /sbin/launchd',
    '42 bash bash /tmp/yw-heavy status',
    '43 bash bash /tmp/yw-heavy capabilities',
    '44 bash bash /tmp/not-yw-heavy acquire ID w s',
    '45 bash bash /tmp/yw-heavy-helper acquire ID w s',
    '46 bash bash /tmp/yw-heavy.sh.backup run ID w s',
    '47 node node --test scripts/yw-heavy.test.mjs',
    '48 rg rg /tmp/yw-heavy run',
    '49 gh gh issue create --body /tmp/yw-heavy run',
  ];
  writeFileSync(f.snapshot, quiet.join('\n') + '\n');
  const result = f.step();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.dst, 'utf8'), readFileSync(join(repo, 'scripts/yw-heavy.sh'), 'utf8'));
  const inode = statSync(f.dst).ino;
  assert.equal(f.step({ HEAVY_TEST_PS_ERROR: '1' }).status, 0, '같은 내용이면 교체하지 않는다');
  assert.equal(statSync(f.dst).ino, inode);
});

test('heavy install guard: 실제 구 spin acquire가 있으면 신 backoff 설치를 보류하고 drain 후 다시 설치한다', async t => {
  const f = fixture(t);
  const oldDir = join(f.root, 'old'); mkdirSync(oldDir);
  const oldPath = join(oldDir, 'yw-heavy.sh');
  copyFileSync(join(repo, 'scripts/fixtures/yw-heavy-v2.sh'), oldPath);
  copyFileSync(oldPath, f.dst);
  const inode = statSync(f.dst).ino, before = readFileSync(f.dst, 'utf8');
  const holder = f.start(['-c', `exec 9>>${quote(f.env.YW_HEAVY_FLOCK)}; /usr/bin/lockf -s -t 0 9 || exit; echo held; read -r _`]);
  await f.wait(() => holder.out.includes('held'), 'isolated flock held');
  const waiter = f.start([oldPath, 'acquire', 'OLD', 'w', 'S']);
  const result = f.step({ HEAVY_TEST_PID: String(waiter.pid) });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(readFileSync(f.dst, 'utf8'), before);
  assert.equal(statSync(f.dst).ino, inode);
  assert.match(result.stderr, new RegExp(`PID ${waiter.pid}`));
  assert.equal(waiter.result, undefined);
  holder.stdin.end('release\n');
  assert.equal((await holder.done).code, 0);
  await f.wait(() => waiter.result, 'old waiter drained');
  assert.equal(waiter.result.code, 0, waiter.err);
  assert.match(waiter.out, /ACQUIRED OLD/);
  const installed = f.step();
  assert.equal(installed.status, 0, installed.stderr);
  assert.notEqual(statSync(f.dst).ino, inode);
  assert.equal(readFileSync(f.dst, 'utf8'), readFileSync(join(repo, 'scripts/yw-heavy.sh'), 'utf8'));
});
