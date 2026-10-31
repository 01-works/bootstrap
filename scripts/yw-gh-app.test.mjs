import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { main, YwGhError } from './yw-gh-app.mjs';

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

  const valid = { appId: '11', installationId: '22', expiresAt: Date.now() + 3600_000 };
  writeFileSync(f.cacheFile, JSON.stringify({ ...valid, token: 'bad\ntoken' }));
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 4, '허용 문자 밖 토큰(줄바꿈)은 손상으로 보고 새로 발급');

  writeFileSync(f.cacheFile, JSON.stringify({ ...valid, token: 'cached_ok' }));
  chmodSync(f.cacheFile, 0o644);
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 5, '남이 읽을 수 있는 캐시 파일은 쓰지 않음');
  assert.equal(f.calls().GH_TOKEN, 'ghs_test');

  const elsewhere = join(f.dir, 'elsewhere.json');
  writeFileSync(elsewhere, JSON.stringify({ ...valid, token: 'linked' }), { mode: 0o600 });
  rmSync(f.cacheFile);
  symlinkSync(elsewhere, f.cacheFile);
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, 6, '링크된 캐시 파일은 따라가지 않음');
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
  for (const owner of ['01-office ', ' ', '01-office/', '-office', 'office-', '01_office', '01--office', 'a'.repeat(40), '', 123, null]) {
    const f = fixture(t, { config: { appId: 11, installationId: 22, owner } });
    await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch(), spawn: noSpawn }), /owner\(GitHub 계정 이름\)/, JSON.stringify(owner));
    const out = [];
    await assert.rejects(run(f, ['auth', 'git-credential', 'get'], { fetch: fakeFetch(), spawn: noSpawn, stdout: x => out.push(x),
      readStdin: () => 'protocol=https\nhost=github.com\npath=01-office/01-software.git\n\n' }), YwGhError);
    assert.equal(out.join(''), 'quit=true\n', `잘못된 owner ${JSON.stringify(owner)}는 소유자 helper로 넘기지 않는다`);
  }
  const longest = fixture(t, { config: { appId: 11, installationId: 22, owner: 'a'.repeat(39) } });
  assert.equal(await run(longest, ['pr', 'list'], { fetch: fakeFetch() }), 0, '39자 owner는 유효');
  const wide = fixture(t, { keyMode: 0o644 });
  await assert.rejects(run(wide, ['pr', 'list'], { fetch: fakeFetch(), spawn: noSpawn }), /권한이 너무 넓습니다/);
});

test('발급 실패(HTTP 오류·네트워크 오류·잘못된 응답)면 오류로 끝나고 실제 gh를 실행하지 않는다', async t => {
  const f = fixture(t);
  // 서버 message·네트워크 오류 원문은 내보내지 않고 HTTP 상태와 고정 설명만 쓴다.
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ status: 500 }), spawn: noSpawn }), e => /HTTP 500\)$/.test(e.message) && !/boom/.test(e.message));
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ throws: 'secret-detail' }), spawn: noSpawn }), e => /네트워크/.test(e.message) && !/secret-detail/.test(e.message));
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ token: '' }), spawn: noSpawn }), /응답이 올바르지 않습니다/);
  await assert.rejects(run(f, ['pr', 'list'], { fetch: fakeFetch({ token: 'a b' }), spawn: noSpawn }), /응답이 올바르지 않습니다/);
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

  const badPaths = ['', 'owner', '01-office', '../01-office/x.git', '01-office/x/y.git', '01-office/x?y', 'own er/x.git', '01_office/x.git', '/01-office/x.git'];
  for (const input of ['protocol=https\nhost=github.com\n\n', 'protocol=https\nhost=gist.github.com\npath=abc.git\n\n',
    ...badPaths.map(p => `protocol=https\nhost=github.com\npath=${p}\n\n`)]) {
    out.length = 0;
    await assert.rejects(run(f, ['auth', 'git-credential', 'get'], { ...io(input), spawn: noSpawn }), YwGhError);
    assert.equal(out.join(''), 'quit=true\n', input);
  }
  for (const ok of ['01-office/01-software', '01-office/01-software.git/', '01-office/a.b_c-d']) {
    out.length = 0;
    assert.equal(await run(f, ['auth', 'git-credential', 'get'], io(`protocol=https\nhost=github.com\npath=${ok}\n\n`)), 0);
    assert.match(out.join(''), /username=x-access-token/, ok);
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

test('동시 호출: 잠금 없이 모두 성공하고, 캐시가 비어 있으면 각자 발급할 수 있다 (무해한 중복)', async t => {
  const f = fixture(t);
  const fetch = fakeFetch({ delayMs: 100 });
  const codes = await Promise.all(Array.from({ length: 5 }, () => run(f, ['api', 'x'], { fetch })));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  assert.ok(fetch.count >= 1 && fetch.count <= 5);
  const after = fetch.count;
  await run(f, ['api', 'x'], { fetch });
  assert.equal(fetch.count, after, '그 뒤에는 캐시를 쓴다');
});

// 앞단(bash)은 설치 단계처럼 경로를 채워 실행한다.
function renderFront(f, core = coreSrc) {
  const front = join(f.dir, 'gh');
  const text = readFileSync(frontSrc, 'utf8').replaceAll('__YW_GH_REAL__', f.real).replaceAll('__YW_GH_CORE__', core).replaceAll('__YW_GH_SELF__', front);
  writeFileSync(front, text, { mode: 0o755 });
  return front;
}
const runFront = (front, args, env, input = '') => new Promise(resolve => {
  const p = spawn(front, args, { env });
  let out = '', err = '';
  p.stdout.on('data', b => { out += b; });
  p.stderr.on('data', b => { err += b; });
  p.on('close', code => resolve({ code, out, err }));
  p.stdin.end(input);
});
// 대역 gh를 node 없는 PATH에서도 돌게 node 절대 경로로 바꾼다.
const pinNode = f => writeFileSync(f.real, readFileSync(f.real, 'utf8').replace('#!/usr/bin/env node', `#!${process.execPath}`));

test('앞단: 에이전트 모드가 아니면 node 없이 실제 gh를 그대로 실행하고, 토큰을 바꾸지 않는다', async t => {
  const f = fixture(t);
  const front = renderFront(f, '/nonexistent/core.mjs');
  const env = { PATH: '/usr/bin:/bin', HOME: f.env.HOME, GH_TOKEN: 'user-set', YW_FAKE_GH_EXIT: '5' };
  pinNode(f);
  const r = await runFront(front, ['repo', 'view'], env);
  assert.equal(r.code, 5);
  assert.deepEqual(f.calls(), { args: ['repo', 'view'], stdin: '', GH_TOKEN: 'user-set', GH_PATH: front, YW_GH_INJECTED: null },
    '사람 분기도 GH_PATH는 앞단 (setup-git이 실제 gh 경로를 helper로 적지 않게)');
});

test('앞단: YW_GH_IDENTITY=owner는 주입된 App 토큰만 지우고, 알 수 없는 값은 거절한다', async t => {
  const f = fixture(t);
  const front = renderFront(f);
  const base = { PATH: process.env.PATH, HOME: f.env.HOME, PASEO_AGENT_ID: 'a1' };
  await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'owner', GH_TOKEN: 'app', YW_GH_INJECTED: '1' });
  assert.equal(f.calls().GH_TOKEN, null);
  assert.equal(f.calls().GH_PATH, front);
  await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'owner', GH_TOKEN: 'user-set' });
  assert.equal(f.calls().GH_TOKEN, 'user-set');
  const bad = await runFront(front, ['pr', 'list'], { ...base, YW_GH_IDENTITY: 'bot' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /agent 또는 owner/);
  const badCred = await runFront(front, ['auth', 'git-credential', 'get'], { ...base, YW_GH_IDENTITY: 'bot' }, 'protocol=https\nhost=github.com\n\n');
  assert.equal(badCred.out, 'quit=true\n');
});

test('앞단: 기기 단위 끄기 파일이 있으면 설정이 없어도 에이전트 모드가 소유자 인증을 쓴다 (gh·git credential)', async t => {
  const f = fixture(t, { config: null });
  writeFileSync(join(f.configDir, 'disabled'), '');
  const front = renderFront(f, '/nonexistent/core.mjs');
  const env = { PATH: process.env.PATH, HOME: f.env.HOME, PASEO_AGENT_ID: 'a1', YW_GH_APP_CONFIG_DIR: f.configDir, GH_TOKEN: 'app', YW_GH_INJECTED: '1' };
  const r = await runFront(front, ['pr', 'list'], env);
  assert.equal(r.code, 0, r.err);
  assert.equal(f.calls().GH_TOKEN, null, '주입된 App 토큰은 지운다');
  const input = 'protocol=https\nhost=github.com\npath=01-office/x.git\n\n';
  const c = await runFront(front, ['auth', 'git-credential', 'get'], env, input);
  assert.equal(c.code, 0, c.err);
  assert.equal(c.out, 'username=owner\npassword=owner-token\n');
});

test('앞단: 믿을 수 없는 끄기 파일(디렉터리·링크·group/other 쓰기 가능한 설정 디렉터리)은 무시하고 설정 없음으로 실패한다', async t => {
  const cases = {
    '끄기 파일이 디렉터리': f => mkdirSync(join(f.configDir, 'disabled')),
    '끄기 파일이 링크': f => { writeFileSync(join(f.dir, 'elsewhere'), ''); symlinkSync(join(f.dir, 'elsewhere'), join(f.configDir, 'disabled')); },
    '설정 디렉터리 0777': f => { writeFileSync(join(f.configDir, 'disabled'), '', { mode: 0o666 }); chmodSync(join(f.configDir, 'disabled'), 0o666); chmodSync(f.configDir, 0o777); },
    '설정 디렉터리 0720': f => { writeFileSync(join(f.configDir, 'disabled'), ''); chmodSync(f.configDir, 0o720); },
  };
  for (const [name, make] of Object.entries(cases)) {
    const f = fixture(t, { config: null });
    make(f);
    const front = renderFront(f);
    const env = { PATH: process.env.PATH, HOME: f.env.HOME, TMPDIR: f.tmp, PASEO_AGENT_ID: 'a1', YW_GH_APP_CONFIG_DIR: f.configDir };
    const r = await runFront(front, ['pr', 'list'], env);
    assert.equal(r.code, 1, name);
    assert.equal(f.calls(), null, `${name}: 소유자 gh로 넘기지 않는다`);
    const c = await runFront(front, ['auth', 'git-credential', 'get'], env, 'protocol=https\nhost=github.com\npath=01-works/b.git\n\n');
    assert.deepEqual([c.code, c.out], [1, 'quit=true\n'], name);
    const lib = spawnSync('bash', ['-c', `source "$1"; yw_gh_disabled "$2"`, '_', join(root, 'scripts/yw-gh-lib.sh'), f.configDir], { env: { ...env, BOOTSTRAP_ROOT: root } });
    assert.equal(lib.status, 1, `${name}: 설치 단계·doctor의 판정도 같다`);
    chmodSync(f.configDir, 0o700);
  }
});

test('앞단: 에이전트 git credential은 node 없음·본체 누락·본체 실패에도 quit=true로 멈춘다', async t => {
  const f = fixture(t);
  pinNode(f);
  const input = 'protocol=https\nhost=github.com\npath=01-office/x.git\n\n';
  const base = { HOME: f.env.HOME, PASEO_AGENT_ID: 'a1', YW_GH_APP_CONFIG_DIR: f.configDir, TMPDIR: f.tmp };
  const noNode = await runFront(renderFront(f), ['auth', 'git-credential', 'get'], { ...base, PATH: '/usr/bin:/bin' }, input);
  assert.deepEqual([noNode.code, noNode.out], [1, 'quit=true\n'], 'node 없음');
  const noCore = await runFront(renderFront(f, join(f.dir, 'missing.mjs')), ['auth', 'git-credential', 'get'], { ...base, PATH: process.env.PATH }, input);
  assert.deepEqual([noCore.code, noCore.out], [1, 'quit=true\n'], '본체 누락');
  const crash = join(f.dir, 'crash.mjs');
  writeFileSync(crash, "process.stdout.write('username=x\\npassword=half\\n'); throw new Error('boom');\n");
  const crashed = await runFront(renderFront(f, crash), ['auth', 'git-credential', 'get'], { ...base, PATH: process.env.PATH }, input);
  assert.deepEqual([crashed.code, crashed.out], [1, 'quit=true\n'], '본체가 중간에 죽으면 출력하던 자격 증명을 버리고 quit=true');
  const silent = join(f.dir, 'silent.mjs');
  writeFileSync(silent, '// 아무것도 하지 않고 0으로 끝난다\n');
  const empty = await runFront(renderFront(f, silent), ['auth', 'git-credential', 'get'], { ...base, PATH: process.env.PATH }, input);
  assert.deepEqual([empty.code, empty.out], [1, 'quit=true\n'], 'get에 빈 응답·종료 0은 실패로 본다');
  const store = await runFront(renderFront(f, silent), ['auth', 'git-credential', 'store'], { ...base, PATH: process.env.PATH }, input);
  assert.deepEqual([store.code, store.out], [0, ''], 'store·erase의 빈 응답은 정상');
  const noNodeGh = await runFront(renderFront(f), ['pr', 'list'], { ...base, PATH: '/usr/bin:/bin' });
  assert.equal(noNodeGh.code, 1);
  assert.equal(f.calls(), null, '소유자 gh로 넘기지 않는다');
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

  // 상위 경로에 링크가 있는 곳에 설치한 본체 복사본도 실제로 실행된다 (macOS /var → /private/var 같은 경우).
  const realRoot = join(f.dir, 'real-root');
  mkdirSync(join(realRoot, 'share'), { recursive: true });
  writeFileSync(join(realRoot, 'share/yw-gh-app.mjs'), readFileSync(coreSrc));
  symlinkSync(realRoot, join(f.dir, 'linked-root'));
  const linkedFront = renderFront(f, join(f.dir, 'linked-root/share/yw-gh-app.mjs'));
  rmSync(f.cacheFile);
  const viaLink = await runFront(linkedFront, ['issue', 'view', '1'], env);
  assert.equal(viaLink.code, 0, viaLink.err);
  assert.deepEqual(f.calls(), { args: ['issue', 'view', '1'], stdin: '', GH_TOKEN: 'ghs_e2e', GH_PATH: linkedFront, YW_GH_INJECTED: '1' });
  assert.equal(hits, 2, '링크 경로의 본체가 실제로 발급했다');
  const cred = await runFront(linkedFront, ['auth', 'git-credential', 'get'], env, 'protocol=https\nhost=github.com\npath=01-office/01-software.git\n\n');
  assert.equal(cred.code, 0, cred.err);
  assert.equal(cred.out, 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_e2e\n');

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

function stepEnv(f) {
  const realDir = join(f.dir, 'brew-bin');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
  const PATH = `${join(f.env.HOME, '.local/bin')}:${realDir}:/usr/bin:/bin`;
  return { realGh: join(realDir, 'gh'), env: { PATH, YW_GH_SEARCH_PATH: PATH } };
}

test('설치 단계: 설정이 없어도 설치하고 수동 작업 대기(2)로 알리며, 끄기 파일이 있으면 완료(0)', t => {
  const f = fixture(t, { config: null });
  const { env } = stepEnv(f);
  const r = runStep(f, env);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /App 설정이 없어/);
  assert.equal(existsSync(join(f.env.HOME, '.local/bin/gh')), true);
  assert.equal(existsSync(join(f.configDir, 'disabled')), false, '끄기 파일을 만들지 않는다');
  writeFileSync(join(f.configDir, 'disabled'), '');
  assert.equal(runStep(f, env).status, 0);
});

test('설치 단계: 전역 credential helper(~/.gitconfig와 include한 ~/.gitconfig.local)가 실제 gh를 가리키면 고치지 않고 경고한다', t => {
  const f = fixture(t);
  const { env, realGh } = stepEnv(f);
  mkdirSync(f.env.HOME, { recursive: true });
  const helper = `[credential "https://github.com"]\n\thelper = \n\thelper = !${realGh} auth git-credential\n`;
  writeFileSync(join(f.env.HOME, '.gitconfig'), helper);
  const r = runStep(f, env);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /실제 gh를 직접 가리켜/);
  assert.equal(readFileSync(join(f.env.HOME, '.gitconfig'), 'utf8'), helper, '자동으로 고치지 않는다');

  // 저장소 .gitconfig처럼 정상 helper + ~/.gitconfig.local include. 우회 helper는 include한 파일에만 있다.
  writeFileSync(join(f.env.HOME, '.gitconfig'), '[credential "https://github.com"]\n\thelper = \n\thelper = !gh auth git-credential\n[include]\n\tpath = ~/.gitconfig.local\n');
  assert.equal(runStep(f, env).status, 0, '정상 helper만 있으면 완료');
  writeFileSync(join(f.env.HOME, '.gitconfig.local'), helper);
  const local = runStep(f, env);
  assert.equal(local.status, 2, local.stderr);
  assert.match(local.stderr, /실제 gh를 직접 가리켜/);
});

test('doctor 판정: 설치한 앞단은 기대 내용과 같고, 구버전 앞단은 다르다고 본다', t => {
  const f = fixture(t);
  const { env, realGh } = stepEnv(f);
  assert.equal(runStep(f, env).status, 0);
  const front = join(f.env.HOME, '.local/bin/gh');
  const core = join(f.env.HOME, '.local/share/yw-gh/yw-gh-app.mjs');
  const same = () => spawnSync('bash', ['-c', 'source "$BOOTSTRAP_ROOT/scripts/yw-gh-lib.sh"; real="$(yw_gh_find_real "$HOME/.local/bin")" && [[ "$real" == "$1" ]] && cmp -s "$2" <(yw_gh_render "$real" "$3" "$2")',
    '_', realGh, front, core], { env: { ...env, HOME: f.env.HOME, BOOTSTRAP_ROOT: root } }).status;
  assert.equal(same(), 0);
  writeFileSync(front, readFileSync(front, 'utf8').replace('export GH_PATH="$self"\n', ''));
  assert.notEqual(same(), 0, 'marker가 있어도 내용이 다르면 최신이 아니다');
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
