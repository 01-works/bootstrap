// yw-gh 에이전트 모드 본체. 앞단 scripts/yw-gh.sh가 에이전트 모드일 때만 실행한다. 동작·한계: agents/github-app.md
// - gh 명령: 항상 App 설치 토큰을 GH_TOKEN으로 넣어 실제 gh를 실행한다. 인자·cwd로 대상을 추론하지 않는다.
// - git credential get: path의 owner가 설정 owner면 App 토큰, 다른 owner면 소유자 인증, path가 없으면 quit=true.
// - 설정·키·발급 실패는 오류로 끝낸다. 소유자 인증으로 넘어가는 경로는 없다.
// 의존성 없이 Node 내장 모듈만 쓴다.
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFUSED_AUTH = new Set(['login', 'logout', 'switch', 'refresh', 'setup-git']);
// Bearer 토큰 문자 집합 (RFC 6750 b64token). 길이·접두사는 가정하지 않는다.
const TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;
// git이 넘기는 원격 경로: <owner>/<repo>[.git][/]. 그 밖은 파싱 실패로 본다.
const PATH_RE = /^([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+(?:\.git)?\/?$/;

export class YwGhError extends Error {}
const fail = message => { throw new YwGhError(message); };

function settings(env) {
  return {
    real: env.YW_GH_REAL || fail('YW_GH_REAL이 없습니다 (앞단 yw-gh.sh로 실행하세요)'),
    self: env.YW_GH_SELF || '',
    configDir: env.YW_GH_APP_CONFIG_DIR || join(homedir(), '.config', 'yw-gh-app'),
    api: (env.YW_GH_APP_API || 'https://api.github.com').replace(/\/+$/, ''),
    cacheDir: join(env.TMPDIR || tmpdir(), `yw-gh-app-${process.getuid()}`),
  };
}

// 다른 사용자가 읽거나 바꿀 수 있는 경로는 쓰지 않는다. 링크도 따라가지 않는다.
function assertPrivate(path, kind) {
  let st;
  try { st = lstatSync(path); } catch { fail(`${path} 가 없습니다 (agents/github-app.md의 키 배치)`); }
  const okKind = kind === 'dir' ? st.isDirectory() : st.isFile();
  if (!okKind) fail(`${path} 는 ${kind === 'dir' ? '디렉터리' : '일반 파일'}여야 합니다`);
  if (st.uid !== process.getuid()) fail(`${path} 의 소유자가 현재 사용자가 아닙니다`);
  if (st.mode & 0o077) fail(`${path} 권한이 너무 넓습니다 (${kind === 'dir' ? '700' : '600'}으로 맞추세요)`);
}

export function loadConfig(configDir) {
  assertPrivate(configDir, 'dir');
  const configPath = join(configDir, 'config.json');
  const keyPath = join(configDir, 'private-key.pem');
  assertPrivate(configPath, 'file');
  assertPrivate(keyPath, 'file');
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { fail(`${configPath} 를 읽지 못했습니다`); }
  const appId = String(config?.appId ?? '');
  const installationId = String(config?.installationId ?? '');
  const owner = String(config?.owner ?? '');
  if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId) || !owner) {
    fail(`${configPath} 에 appId·installationId(숫자)와 owner가 필요합니다`);
  }
  let key;
  try { key = createPrivateKey(readFileSync(keyPath)); } catch { fail(`${keyPath} 를 private key로 읽지 못했습니다`); }
  return { appId, installationId, owner, key };
}

const b64url = buf => Buffer.from(buf).toString('base64url');

// GitHub 규칙: RS256, iss=App ID, iat는 시계 오차를 감안해 60초 전, exp는 10분 이내.
export function appJwt(config, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }));
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), config.key);
  return `${head}.${body}.${b64url(sig)}`;
}

async function mintToken(config, s, fetchImpl) {
  const url = `${s.api}/app/installations/${config.installationId}/access_tokens`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt(config)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'yw-gh',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // 오류 원문(서버 메시지·네트워크 오류)은 출력하지 않는다.
    fail('App 토큰 발급 요청 실패 (네트워크 또는 시간 초과)');
  }
  if (!res.ok) fail(`App 토큰 발급 실패 (HTTP ${res.status})`);
  let data = null;
  try { data = await res.json(); } catch {}
  const token = data?.token;
  const expiresAt = Date.parse(data?.expires_at ?? '');
  if (typeof token !== 'string' || !TOKEN_RE.test(token) || !(expiresAt > Date.now())) {
    fail('App 토큰 발급 응답이 올바르지 않습니다');
  }
  return { token, expiresAt };
}

function ensureCacheDir(dir) {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') fail(`캐시 디렉터리를 만들지 못했습니다: ${e.message}`); }
  assertPrivate(dir, 'dir');
}

function readCache(file, config) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077) return null;
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c.appId === config.appId && c.installationId === config.installationId && typeof c.token === 'string'
      && TOKEN_RE.test(c.token) && Number.isFinite(c.expiresAt) && c.expiresAt - Date.now() > REFRESH_MARGIN_MS) return c.token;
  } catch {}
  return null; // 없거나 깨졌거나 남의 것이거나 다른 App 것이거나 곧 만료: 새로 발급한다 (소유자로 넘기지 않는다).
}

function writeCache(file, config, minted) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify({ appId: config.appId, installationId: config.installationId, ...minted }));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export async function installationToken(s, fetchImpl = fetch) {
  const config = loadConfig(s.configDir);
  ensureCacheDir(s.cacheDir);
  const file = join(s.cacheDir, 'token.json');
  const cached = readCache(file, config);
  if (cached) return { token: cached, config };
  // 잠금은 두지 않는다. 동시에 캐시가 비면 각자 발급하지만 무해하고, 캐시는 원자적 rename이라 깨지지 않는다.
  const minted = await mintToken(config, s, fetchImpl);
  writeCache(file, config, minted);
  return { token: minted.token, config };
}

// 이 앞단이 넣은 토큰만 지운다. 사용자가 직접 넣은 GH_TOKEN은 건드리지 않는다.
function ownerEnv(env) {
  const out = { ...env };
  if (out.YW_GH_INJECTED === '1') { delete out.GH_TOKEN; delete out.YW_GH_INJECTED; }
  return out;
}

function agentEnv(env, s, token) {
  const out = { ...env, GH_TOKEN: token, YW_GH_INJECTED: '1' };
  if (s.self) out.GH_PATH = s.self; // 확장·helper가 gh를 다시 부를 때 이 앞단을 거치게 한다.
  return out;
}

function exitLike(r) {
  if (r.error) fail(`실제 gh 실행 실패: ${r.error.message}`);
  if (r.signal) { process.kill(process.pid, r.signal); return 1; }
  return r.status ?? 1;
}

export function parseCredential(text) {
  const attrs = {};
  for (const line of text.split('\n')) {
    if (!line) break;
    const i = line.indexOf('=');
    if (i > 0) attrs[line.slice(0, i)] = line.slice(i + 1);
  }
  return attrs;
}

async function gitCredential(op, s, env, io) {
  // store·erase: 에이전트 모드에서는 저장하거나 지울 자격 증명이 없다.
  if (op !== 'get') return 0;
  const raw = io.readStdin();
  const quit = message => { io.stdout('quit=true\n'); fail(message); };
  const attrs = parseCredential(raw);
  if (attrs.protocol !== 'https' || attrs.host !== 'github.com') quit(`github.com https 자격 증명만 처리합니다 (host: ${attrs.host || '없음'})`);
  if (!attrs.path) quit('git이 path를 넘기지 않았습니다 (credential.https://github.com.useHttpPath=true 필요)');
  const owner = PATH_RE.exec(attrs.path)?.[1];
  if (!owner) quit('원격 경로를 <owner>/<repo>로 읽지 못했습니다');
  let config;
  try { config = loadConfig(s.configDir); } catch (e) { quit(e.message); }
  if (owner.toLowerCase() !== config.owner.toLowerCase()) {
    // 대상 저장소의 owner가 App 범위 밖: 소유자 인증 (git이 넘긴 실제 원격 경로로 정한다).
    return exitLike(io.spawn(s.real, ['auth', 'git-credential', 'get'], { input: raw, stdio: ['pipe', 'inherit', 'inherit'], env: ownerEnv(env) }));
  }
  let token;
  try { ({ token } = await installationToken(s, io.fetch)); } catch (e) { quit(e.message); }
  io.stdout(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n`);
  return 0;
}

export async function main(args, env = process.env, io = {}) {
  io = {
    spawn: spawnSync,
    fetch: globalThis.fetch,
    readStdin: () => readFileSync(0, 'utf8'),
    stdout: text => process.stdout.write(text),
    ...io,
  };
  const s = settings(env);
  if (args[0] === 'auth' && REFUSED_AUTH.has(args[1])) {
    fail(`에이전트 모드에서는 gh auth ${args[1]}를 실행하지 않습니다. 계정 관리는 사람 터미널에서 하세요`);
  }
  if (args[0] === 'auth' && args[1] === 'git-credential') return gitCredential(args[2], s, env, io);
  const { token } = await installationToken(s, io.fetch);
  return exitLike(io.spawn(s.real, args, { stdio: 'inherit', env: agentEnv(env, s, token) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => {
    process.stderr.write(`yw-gh: ${e instanceof YwGhError ? e.message : e.stack}\n`);
    process.exit(1);
  });
}
