// secrets 단계(scripts/steps/72-secrets.sh): 가짜 infisical·security로 설정·인증·검증·원자적 쓰기를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), bin = join(root, 'bin'), log = join(root, 'calls.log');
  mkdirSync(home);
  mkdirSync(bin);
  // 가짜 infisical: FAKE_* 환경 변수로 동작을 고른다. 호출 인자와 받은 비밀 환경 변수 유무를 기록한다(값은 기록하지 않음).
  writeFileSync(join(bin, 'infisical'), `#!/bin/bash
printf '%s|secret_env=%s|token_env=%s\\n' "$*" "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:+set}" "\${INFISICAL_TOKEN:+set}" >>"${log}"
case "$1 $2" in
  "login status") if [[ -n "\${FAKE_SESSION:-}" ]]; then printf '{\\n  "sessions": [\\n    { "email": "x" }\\n  ]\\n}\\n'; else printf '{\\n  "sessions": []\\n}\\n'; fi; exit 0 ;;
  "login --method=universal-auth") [[ "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}" == s3cret ]] || { echo bad >&2; exit 1; }; printf 'tok-123\\n'; exit 0 ;;
esac
if [[ "$1" == export ]]; then
  [[ -n "\${FAKE_SLEEP:-}" ]] && sleep "$FAKE_SLEEP"
  case "\${FAKE_EXPORT:-ok}" in
    ok) printf "export OPENROUTER_API_KEY='abc'\\nexport OTHER_KEY='x y'\\n" ;;
    prompt) printf '\\033[2K? Select your hosting option:\\n' ; echo 'No valid login session found' >&2; exit 1 ;;
    junk) printf "export A='1'\\ncontinued line\\n" ;;
  esac
  exit 0
fi
exit 0
`, { mode: 0o755 });
  // 가짜 security: FAKE_KEYCHAIN=1이면 기기 계정 값을 돌려준다.
  writeFileSync(join(bin, 'security'), `#!/bin/bash
[[ "\${FAKE_KEYCHAIN:-}" == 1 ]] || exit 44
case "$*" in
  *"-a client-id"*) echo cid-1 ;;
  *"-a client-secret"*) echo s3cret ;;
  *) exit 44 ;;
esac
`, { mode: 0o755 });
  const config = join(home, '.config/bootstrap/secrets.env');
  const writeConfig = (text = `INFISICAL_PROJECT_ID=${PROJECT}\nINFISICAL_ENV=prod\nINFISICAL_PATH=/common\n`) => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, text);
  };
  const run = (env = {}, path = `${bin}:/usr/bin:/bin`) => spawnSync('/bin/bash', [join(repo, 'scripts/steps/72-secrets.sh')], {
    env: { PATH: path, HOME: home, BOOTSTRAP_ROOT: repo, BOOTSTRAP_BREW_PREFIX: join(root, 'no-brew'), DRY_RUN: '0', XDG_STATE_HOME: join(root, 'state'), TMPDIR: root, ...env },
    encoding: 'utf8', input: ''
  });
  const target = join(home, '.zsh_secrets.infisical');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { root, home, run, writeConfig, target, calls };
}

test('secrets 단계: 설정이 없으면 아무것도 하지 않는다', t => {
  const s = sandbox(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /비밀값 동기화 설정 없음/);
  assert.equal(existsSync(s.target), false);
  assert.equal(s.calls(), '');
});

test('secrets 단계: 사람 로그인 세션으로 받아 600 파일로 원자적으로 쓰고, ~/.zsh_secrets는 건드리지 않는다', t => {
  const s = sandbox(t);
  s.writeConfig();
  writeFileSync(join(s.home, '.zsh_secrets'), 'export MINE=1\n', { mode: 0o600 });
  const result = s.run({ FAKE_SESSION: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /비밀값 2개/);
  const text = readFileSync(s.target, 'utf8');
  assert.match(text, /^# bootstrap secrets 단계/);
  assert.match(text, /export OPENROUTER_API_KEY='abc'/);
  assert.equal(statSync(s.target).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(s.home, '.zsh_secrets'), 'utf8'), 'export MINE=1\n');
  const state = readFileSync(join(s.root, 'state/bootstrap/secrets/last-sync'), 'utf8');
  assert.match(state, /count=2/);
  assert.doesNotMatch(state, /abc/, '상태 파일에 값을 남기지 않는다');
  assert.match(s.calls(), new RegExp(`export --silent --projectId ${PROJECT} --env prod --path /common --format dotenv-export`));
});

test('secrets 단계: 자동 갱신에서 로그인이 없으면 수동 작업 대기(2)로 남긴다', t => {
  const s = sandbox(t);
  s.writeConfig();
  const result = s.run({ BOOTSTRAP_UNATTENDED: '1' });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /Infisical 로그인/);
  assert.doesNotMatch(s.calls(), /^export /m);
});

test('secrets 단계: 실패한 export의 출력은 쓰지 않고 기존 파일을 지킨다', t => {
  const s = sandbox(t);
  s.writeConfig();
  writeFileSync(s.target, "export OLD='keep'\n", { mode: 0o600 });
  let result = s.run({ FAKE_SESSION: '1', FAKE_EXPORT: 'prompt' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /비밀값 받기 실패 \(exit 1\)/);
  assert.equal(readFileSync(s.target, 'utf8'), "export OLD='keep'\n");

  result = s.run({ FAKE_SESSION: '1', FAKE_EXPORT: 'junk' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /export 줄이 아닌 것/);
  assert.equal(readFileSync(s.target, 'utf8'), "export OLD='keep'\n");
});

test('secrets 단계: 기기 계정은 키체인 값을 환경 변수로만 넘기고 토큰으로 받는다', t => {
  const s = sandbox(t);
  s.writeConfig();
  const result = s.run({ FAKE_KEYCHAIN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /기기 계정/);
  const calls = s.calls();
  assert.match(calls, /^login --method=universal-auth --silent --plain\|secret_env=set\|/m);
  assert.doesNotMatch(calls, /s3cret|cid-1|tok-123/, '비밀값·토큰은 인자로 넘기지 않는다');
  assert.match(calls, /^export .*\|token_env=set$/m);
  assert.doesNotMatch(calls, /login status/, '기기 계정이면 사람 세션을 보지 않는다');
});

test('secrets 단계: 멈춘 명령은 시간 제한으로 끊고 실패로 알린다', t => {
  const s = sandbox(t);
  s.writeConfig();
  const result = s.run({ FAKE_SESSION: '1', FAKE_SLEEP: '5', BOOTSTRAP_SECRETS_TIMEOUT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timeout after 1s/);
  assert.equal(existsSync(s.target), false);
});

test('secrets 단계: dry-run은 받지 않고, CLI가 없으면 대기, 설정 형식이 틀리면 실패', t => {
  const s = sandbox(t);
  s.writeConfig();
  let result = s.run({ FAKE_SESSION: '1', DRY_RUN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/);
  assert.equal(existsSync(s.target), false);
  assert.doesNotMatch(s.calls(), /^export /m);

  result = s.run({}, '/usr/bin:/bin');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Infisical CLI가 없습니다/);

  s.writeConfig('INFISICAL_PROJECT_ID=abc; rm -rf ~\n');
  result = s.run({ FAKE_SESSION: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /값 형식이 잘못됐습니다/);

  s.writeConfig(`INFISICAL_PROJECT_ID=${PROJECT}\nINFISICAL_DOMAIN=http://insecure.example\n`);
  result = s.run({ FAKE_SESSION: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /https:\/\//);
});
