import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { main, withLock, YwGhError } from './yw-gh-app.mjs';

// 실제 GitHub·실제 gh·실제 홈을 쓰지 않는다. 키는 테스트마다 만들고, API는 주입한 fetch나 로컬 서버로 대신한다.
const root = fileURLToPath(new URL('..', import.meta.url));
const frontSrc = join(root, 'scripts/yw-gh.sh');
const coreSrc = join(root, 'scripts/yw-gh-app.mjs');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });

function fixture(t, { config = { appId: 11, installationId: 22, owner: '01-office' }, keyMode = 0o600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yw-gh-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  mkdirSync(configDir, { mode: 0o700 });
  if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(configDir, 'private-key.pem'), pem, { mode: keyMode });
  chmodSync(join(configDir, 'private-key.pem'), keyMode);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  // 실제 gh 대역: 인자·주요 환경·stdin을 기록하고 YW_FAKE_GH_EXIT로 종료한다.
  const record = join(dir, 'gh-record.json');
  const real = join(dir, 'real-gh');
  writeFileSync(real, `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
if (process.argv[2] === 'auth' && process.argv[3] === 'git-credential') stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin,
  GH_TOKEN: process.env.GH_TOKEN ?? null, GH_PATH: process.env.GH_PATH ?? null, YW_GH_INJECTED: process.env.YW_GH_INJECTED ?? null }));
if (stdin) process.stdout.write('username=owner\\npassword=owner-token\\n');
process.exit(Number(process.env.YW_FAKE_GH_EXIT || 0));
`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: join(dir, 'home'), TMPDIR: tmp, YW_GH_REAL: real, YW_GH_SELF: '/shim/gh',
    YW_GH_APP_CONFIG_DIR: configDir, YW_GH_APP_LOCK_WAIT_MS: '500' };
  const calls = () => existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null;
  return { dir, configDir, tmp, real, env, calls, cacheFile: join(tmp, `yw-gh-app-${process.getuid()}`, 'token.json') };
}

// 주입용 fetch: 발급 요청 수를 세고, JWT 서명·클레임을 공개키로 검증한다.
function fakeFetch({ status = 201, token = 'ghs_test', ttlMs = 3600_000, delayMs = 0, throws = null } = {}) {
  const f = async (url, init) => {
    f.count++;
    if (throws) throw new Error(throws);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    f.urls.push(url);
    f.jwts.push(init.headers.Authorization.replace(/^Bearer /, ''));
    const body = status < 300 ? { token, expires_at: new Date(Date.now() + ttlMs).toISOString() } : { message: 'boom' };
    return { ok: status < 300, status, json: async () => body };
  };
  f.count = 0; f.urls = []; f.jwts = [];
  return f;
}

function checkJwt(jwt, appId) {
  const [h, b, s] = jwt.split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url')), 'RS256 서명이 맞다');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, String(appId));
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.iat <= now - 30 && claims.exp > now && claims.exp - claims.iat <= 600, 'iat는 과거, exp는 10분 이내');
}

const noSpawn = () => { throw new Error('실제 gh를 실행하면 안 된다'); };
const run = (f, args, io = {}, env = {}) => main(args, { ...f.env, ...env }, { spawn: spawnSync, readStdin: () => '', stdout: () => {}, ...io });

test('에이전트 gh 명령: App 토큰·주입 표시·GH_PATH를 넣어 실제 gh를 실행하고 종료 코드를 그대로 돌려준다', async t => {
  const f = fixture(t);
  const fetch = fakeFetch();
  const code = await run(f, ['pr', 'list'], { fetch }, { YW_FAKE_GH_EXIT: '3' });
  assert.equal(code, 3);
  assert.deepEqual(f.calls(), { args: ['pr', 'list'], stdin: '', GH_TOKEN: 'ghs_test', GH_PATH: '/shim/gh', YW_GH_INJECTED: '1' });
  assert.equal(fetch.count, 1);
  assert.match(fetch.urls[0], /\/app\/installations\/22\/access_tokens$/);
  checkJwt(fetch.jwts[0], 11);
});

test('캐시: 유효하면 다시 쓰고, 손상·다른 App·5분 내 만료면 새로 발급한다 (소유자로 넘기지 않음)', async t => {
  const f = fixture(t);
  const fetch = fakeFetch();
  await run(f, ['api', 'x'], { fetch });
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 1, '두 번째는 캐시');
  assert.equal(readFileSync(f.cacheFile).length > 0, true);
  const stat = spawnSync('stat', ['-f', '%Lp', f.cacheFile], { encoding: 'utf8' }).stdout.trim();
  assert.equal(stat, '600');

  writeFileSync(f.cacheFile, '{not json');
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 2, '손상된 캐시는 새로 발급');

  writeFileSync(f.cacheFile, JSON.stringify({ appId: '99', installationId: '22', token: 'other', expiresAt: Date.now() + 3600_000 }));
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 3, '다른 App 캐시는 쓰지 않음');
  assert.equal(f.calls().GH_TOKEN, 'ghs_test');

  const soon = fakeFetch({ ttlMs: 4 * 60_000, token: 'ghs_soon' });
  writeFileSync(f.cacheFile, '');
  await run(f, ['api', 'x'], { fetch: soon });
  await run(f, ['api', 'x'], { fetch: soon });
  assert.equal(soon.count, 2, '5분 안에 만료되는 토큰은 다시 발급');
});

test('설정 누락·형식 오류·넓은 키 권한이면 오류로 끝나고 실제 gh를 실행하지 않는다', async t => {
  const missing = fixture(t, { config: null });
  await assert.rejects(run(missing, ['pr', 'list'], { fetch: fakeFetch(), spawn: noSpawn }), YwGhError);
  const bad = fixture(t, { config: { appId: 'x', installationId: 22, owner: '01-office' } });
  await assert.rejects(run(bad, ['pr', 'list'], { fetch: fakeFetch(), spawn: noSpawn }), /appId/);
  const wide = fixture(t, { keyMode: 0o644 });
  await assert.rejects(run(wide, ['pr', 'list'], { fetch: fakeFetch(), spawn: noSpawn }), /권한이 너무 넓습니다/);
});

test('발급 실패(HTTP 오류·네트워크 오류·잘못된 응답)면 오류로 끝나고 실제 gh를 실행하지 않는다', async t => {
  const f = fixture(t);
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ status: 500 }), spawn: noSpawn }), /HTTP 500/);
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ throws: 'offline' }), spawn: noSpawn }), /offline/);
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ token: '' }), spawn: noSpawn }), /응답이 올바르지 않습니다/);
  assert.equal(f.calls(), null);
});

test('에이전트 모드에서 계정 관리 auth 명령은 거절한다', async t => {
  const f = fixture(t);
  for (const sub of ['login', 'logout', 'switch', 'refresh', 'setup-git']) {
    await assert.rejects(run(f, ['auth', sub], { fetch: fakeFetch(), spawn: noSpawn }), /사람 터미널/);
  }
});

test('git credential: 설정 owner면 App 토큰, 다른 owner면 소유자 인증 (주입 토큰 제거), path 없으면 quit=true', async t => {
  const f = fixture(t);
  const out = [];
  const io = (input, fetch = fakeFetch()) => ({ fetch, readStdin: () => input, stdout: s => out.push(s) });

  out.length = 0;
  assert.equal(await run(f, ['auth', 'git-credential', 'get'], io('protocol=https\nhost=github.com\npath=01-office/01-software.git\n\n')), 0);
  assert.equal(out.join(''), 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test\n');
  assert.equal(f.calls(), null, '실제 gh를 부르지 않는다');

  const other = 'protocol=https\nhost=github.com\npath=01-works/bootstrap.git\n\n';
  assert.equal(await run(f, ['auth', 'git-credential', 'get'], io(other), { GH_TOKEN: 'app-token', YW_GH_INJECTED: '1' }), 0);
  assert.deepEqual(f.calls(), { args: ['auth', 'git-credential', 'get'], stdin: other, GH_TOKEN: null, GH_PATH: null, YW_GH_INJECTED: null });

  for (const input of ['protocol=https\nhost=github.com\n\n', 'protocol=https\nhost=gist.github.com\npath=abc.git\n\n']) {
    out.length = 0;
    await assert.rejects(run(f, ['auth', 'git-credential', 'get'], { ...io(input), spawn: noSpawn }), YwGhError);
    assert.equal(out.join(''), 'quit=true\n');
  }
  out.length = 0;
  writeFileSync(f.cacheFile, '');
  await assert.rejects(run(f, ['auth', 'git-credential', 'get'], { ...io('protocol=https\nhost=github.com\npath=01-office/x.git\n\n', fakeFetch({ status: 401 })), spawn: noSpawn }), /HTTP 401/);
  assert.equal(out.join(''), 'quit=true\n', '발급 실패도 quit=true');

  const missing = fixture(t, { config: null });
  out.length = 0;
  await assert.rejects(run(missing, ['auth', 'git-credential', 'get'], { ...io('protocol=https\nhost=github.com\npath=01-works/b.git\n\n'), spawn: noSpawn }), YwGhError);
  assert.equal(out.join(''), 'quit=true\n', '설정 누락이면 다른 owner라도 소유자 인증으로 넘기지 않는다');

  out.length = 0;
  for (const op of ['store', 'erase']) assert.equal(await run(f, ['auth', 'git-credential', op], { ...io('x'), spawn: noSpawn }), 0);
  assert.equal(out.join(''), '');
});

test('동시 호출은 잠금 덕분에 한 번만 발급한다', async t => {
  const f = fixture(t);
  const fetch = fakeFetch({ delayMs: 150 });
  const codes = await Promise.all(Array.from({ length: 5 }, () => run(f, ['api', 'x'], { fetch })));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  assert.equal(fetch.count, 1);
});

test('잠금: 죽은 소유자 것만 회수하고, 살아 있는 소유자 것은 기다리다 실패하며, 해제는 자기 잠금만', async t => {
  const f = fixture(t);
  const lock = join(f.tmp, 'lock');
  writeFileSync(lock, '2147483646 deadbeef\n');
  assert.equal(await withLock(lock, 500, async () => 'ran'), 'ran', '죽은 pid 잠금은 회수');
  assert.equal(existsSync(lock), false, '자기 잠금은 해제');

  writeFileSync(lock, `${process.ppid} live\n`);
  const started = Date.now();
  await assert.rejects(withLock(lock, 300, async () => 'never'), /잠금을/);
  assert.ok(Date.now() - started >= 300, '대기 시간만큼 기다린 뒤 실패');
  assert.equal(readFileSync(lock, 'utf8'), `${process.ppid} live\n`, '살아 있는 소유자의 잠금은 그대로');
  rmSync(lock);

  await withLock(lock, 500, async () => { writeFileSync(lock, 'someone else\n'); });
  assert.equal(readFileSync(lock, 'utf8'), 'someone else\n', '남의 잠금은 지우지 않는다');
});

// 앞단(bash)은 설치 단계처럼 경로를 채워 실행한다.
function renderFront(f, core = coreSrc) {
  const front = join(f.dir, 'gh');
  const text = readFileSync(frontSrc, 'utf8').replaceAll('__YW_GH_REAL__', f.real).replaceAll('__YW_GH_CORE__', core).replaceAll('__YW_GH_SELF__', front);
  writeFileSync(front, text, { mode: 0o755 });
  return front;
}
const runFront = (front, args, env) => new Promise(resolve => {
  const p = spawn(front, args, { env });
  let err = '';
  p.stderr.on('data', b => { err += b; });
  p.on('close', code => resolve({ code, err }));
});

test('앞단: 에이전트 모드가 아니면 node 없이 실제 gh를 그대로 실행하고, 토큰을 바꾸지 않는다', async t => {
  const f = fixture(t);
  const front = renderFront(f, '/nonexistent/core.mjs');
  const env = { PATH: '/usr/bin:/bin', HOME: f.env.HOME, GH_TOKEN: 'user-set', YW_FAKE_GH_EXIT: '5' };
  // 대역 gh는 node로 돌므로 node 경로만 절대 경로로 바꿔 준다.
  writeFileSync(f.real, readFileSync(f.real, 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`));
  const r = await runFront(front, ['repo', 'view'], env);
  assert.equal(r.code, 5);
  assert.deepEqual(f.calls(), { args: ['repo', 'view'], stdin: '', GH_TOKEN: 'user-set', GH_PATH: null, YW_GH_INJECTED: null });
});

test('앞단: YW_GH_IDENTITY=owner는 주입된 App 토큰만 지우고, 알 수 없는 값은 거절한다', async t => {
  const f = fixture(t);
  const front = renderFront(f);
  const base = { PATH: process.env.PATH, HOME: f.env.HOME, PASEO_AGENT_ID: 'a1' };
  await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'owner', GH_TOKEN: 'app', YW_GH_INJECTED: '1' });
  assert.equal(f.calls().GH_TOKEN, null);
  await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'owner', GH_TOKEN: 'user-set' });
  assert.equal(f.calls().GH_TOKEN, 'user-set');
  const bad = await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'bot' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /agent 또는 owner/);
});

test('앞단 → 본체 → 로컬 API 서버: PASEO_AGENT_ID면 실제 fetch로 발급한 App 토큰으로 실행한다', async t => {
  const f = fixture(t);
  const front = renderFront(f);
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    checkJwt(req.headers.authorization.replace(/^Bearer /, ''), 11);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'ghs_e2e', expires_at: new Date(Date.now() + 3600_000).toISOString() }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { PATH: process.env.PATH, HOME: f.env.HOME, TMPDIR: f.tmp, PASEO_AGENT_ID: 'a1', YW_GH_APP_CONFIG_DIR: f.configDir,
    YW_GH_APP_API: `http://127.0.0.1:${server.address().port}` };
  const r = await runFront(front, ['issue', 'list'], env);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(f.calls(), { args: ['issue', 'list'], stdin: '', GH_TOKEN: 'ghs_e2e', GH_PATH: front, YW_GH_INJECTED: '1' });
  await runFront(front, ['issue', 'list'], env);
  assert.equal(hits, 1, '두 번째 프로세스는 캐시를 쓴다');

  rmSync(join(f.configDir, 'config.json'));
  const missing = await runFront(front, ['issue', 'list'], env);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /config\.json/);
});

// 설치 단계: 대역 홈·PATH로 실행한다.
function runStep(f, env) {
  return spawnSync('bash', [join(root, 'scripts/steps/67-ghapp.sh')], {
    env: { PATH: env.PATH, HOME: f.env.HOME, BOOTSTRAP_ROOT: root, DRY_RUN: '0', YW_GH_APP_CONFIG_DIR: f.configDir, ...env }, encoding: 'utf8',
  });
}

test('설치 단계: 설정이 없으면 아무것도 설치하지 않는다', t => {
  const f = fixture(t, { config: null });
  const r = runStep(f, { PATH: process.env.PATH });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(f.env.HOME, '.local/bin/gh')), false);
});

test('설치 단계: ~/.local/bin을 건너뛴 실제 gh 절대 경로를 적고, 다시 실행해도 같으며, 남의 gh는 덮어쓰지 않는다', t => {
  const f = fixture(t);
  const bin = join(f.env.HOME, '.local/bin');
  const realDir = join(f.dir, 'brew-bin');
  mkdirSync(realDir);
  writeFileSync(join(realDir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const PATH = `${bin}:${realDir}:/usr/bin:/bin`;
  const env = { PATH, YW_GH_SEARCH_PATH: PATH };
  const r1 = runStep(f, env);
  assert.equal(r1.status, 0, r1.stderr);
  const front = readFileSync(join(bin, 'gh'), 'utf8');
  assert.match(front, new RegExp(`^real='${join(realDir, 'gh')}'$`, 'm'), '실제 gh는 ~/.local/bin 밖의 첫 gh');
  assert.match(front, new RegExp(`^self='${join(bin, 'gh')}'$`, 'm'));
  assert.doesNotMatch(front, /__YW_GH_/);
  assert.equal(readFileSync(join(f.env.HOME, '.local/share/yw-gh/yw-gh-app.mjs'), 'utf8'), readFileSync(coreSrc, 'utf8'));

  const r2 = runStep(f, env);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(bin, 'gh'), 'utf8'), front, '다시 실행해도 같다 (자기 자신을 실제 gh로 적지 않음)');

  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho mine\n');
  const r3 = runStep(f, env);
  assert.notEqual(r3.status, 0);
  assert.equal(readFileSync(join(bin, 'gh'), 'utf8'), '#!/bin/sh\necho mine\n');
});
