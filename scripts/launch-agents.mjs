// 사용자 LaunchAgent: 에이전트 전용 Chrome, (늘 켜두는 기기) Paseo 데몬·Paseo 업그레이드, (모든 기기) 저장소 자동 갱신.
// plist에는 이 기기의 절대 경로가 들어가므로 저장소에 두지 않고 여기서 만든다.
// 기기 역할(scripts/role.sh)이 끈 등록은 만들지 않고, 있으면 내린다.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const AGENT_CHROME_PORT = 9333;
export const AGENT_CHROME_URL = `http://127.0.0.1:${AGENT_CHROME_PORT}`;
export const CHROME_BETA = '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta';
// cask는 /opt/homebrew/bin에, 앱 직접 설치는 다른 곳에 링크하므로 앱 안의 CLI를 직접 쓴다.
export const PASEO_CLI = '/Applications/Paseo.app/Contents/Resources/bin/paseo';
export const LABELS = { 'agent-chrome': 'local.bootstrap.agent-chrome', paseo: 'local.bootstrap.paseo',
  'paseo-upgrade': 'local.bootstrap.paseo-upgrade', update: 'local.bootstrap.update' };
// 자동 갱신 주기(초). 잠들어 있던 기기는 깨어나면 놓친 주기를 한 번 실행한다.
export const UPDATE_INTERVAL = 600;
// Paseo 업그레이드 확인 주기(초). 최신 버전은 하루에 한 번 확인하고, 올릴 버전이 있으면 에이전트가 쉴 때까지 이 주기로 다시 본다.
export const PASEO_UPGRADE_INTERVAL = 3600;
// 역할별로 끄는 자동 시작. verifier 기기는 검증만 하므로 에이전트 Chrome과 Paseo 데몬을 띄우지 않는다.
// 업그레이드도 끈다: 새 버전을 올린 뒤 데몬을 띄우기 때문이다 (scripts/paseo-upgrade.sh).
export const ROLE_DISABLED = { verifier: ['agent-chrome', 'paseo', 'paseo-upgrade'] };
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 켠 역할: 상태 파일(~/.config/bootstrap/roles/<역할>)이 있는 역할.
export function activeRoles({ home, env = {} }) {
  const dir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'bootstrap/roles');
  return Object.keys(ROLE_DISABLED).filter(role => existsSync(join(dir, role)));
}
const disabledBy = (name, roles) => roles.find(role => ROLE_DISABLED[role].includes(name));

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist({ label, args, runAtLoad, keepAlive, processType, startInterval, log, env }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${escape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map(arg => `    <string>${escape(arg)}</string>`),
    '  </array>',
    `  <key>RunAtLoad</key><${runAtLoad}/>`,
  ];
  if (env) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [key, value] of Object.entries(env)) lines.push(`    <key>${escape(key)}</key><string>${escape(value)}</string>`);
    lines.push('  </dict>');
  }
  // 비정상 종료만 다시 띄운다. 사용자가 직접 종료하면 다음 로그인까지 그대로 둔다.
  if (keepAlive) lines.push('  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
  if (processType) lines.push(`  <key>ProcessType</key><string>${processType}</string>`);
  if (startInterval) lines.push(`  <key>StartInterval</key><integer>${startInterval}</integer>`);
  if (log) lines.push(`  <key>StandardOutPath</key><string>${escape(log)}</string>`, `  <key>StandardErrorPath</key><string>${escape(log)}</string>`);
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

// 노트북은 필요할 때 시작하고(launchctl kickstart), 늘 켜두는 기기는 로그인할 때 시작한다.
// roles: 켠 역할. 역할이 끈 등록은 null이다.
export function definitions({ home, laptop, env = {}, root = REPO_ROOT, roles = [] }) {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local/share');
  const profile = join(dataHome, 'bootstrap/agent-chrome');
  const stateHome = join(env.XDG_STATE_HOME || join(home, '.local/state'), 'bootstrap');
  const updateState = join(stateHome, 'update');
  const upgradeState = join(stateHome, 'paseo-upgrade');
  const stateEnv = env.XDG_STATE_HOME ? { XDG_STATE_HOME: env.XDG_STATE_HOME } : undefined;
  const defs = {
    'agent-chrome': {
      label: LABELS['agent-chrome'],
      args: [CHROME_BETA, `--user-data-dir=${profile}`, `--remote-debugging-port=${AGENT_CHROME_PORT}`,
        '--no-first-run', '--no-default-browser-check'],
      runAtLoad: !laptop, keepAlive: !laptop, processType: 'Interactive', dirs: [profile],
    },
    // 노트북의 Paseo 자동 시작은 선택 사항이라 만들지 않는다 (시스템 설정 > 일반 > 로그인 항목).
    // 데몬만 띄운다(앱 불필요). 이미 실행 중이면 그대로 둔다. 데몬이 claude·codex를 찾을 수 있게 PATH를 준다.
    paseo: laptop ? null : {
      label: LABELS.paseo, args: [PASEO_CLI, 'daemon', 'start'], runAtLoad: true, keepAlive: false,
      env: { PATH: [join(home, '.local/bin'), join(home, 'Library/pnpm/bin'), join(home, '.local/share/fnm/aliases/default/bin'),
        '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') },
    },
    // 앱 없이 데몬만 도는 기기는 앱의 자동 업데이트가 돌지 않아 따로 올린다 (scripts/paseo-upgrade.sh). 노트북은 앱이 올린다.
    // 데몬과 동시에 뜨지 않도록 로그인할 때는 실행하지 않는다.
    'paseo-upgrade': laptop ? null : {
      label: LABELS['paseo-upgrade'], args: ['/bin/bash', join(root, 'bootstrap.sh'), 'paseo-upgrade', '--auto'],
      runAtLoad: false, keepAlive: false, processType: 'Background', startInterval: PASEO_UPGRADE_INTERVAL,
      log: join(upgradeState, 'upgrade.log'), dirs: [upgradeState], env: stateEnv,
    },
    // 모든 기기가 같다. 로그인할 때와 주기마다 저장소를 확인해 바뀐 부분만 적용한다 (scripts/update.sh).
    // 다른 일을 방해하지 않게 낮은 우선순위로 돈다. 출력은 update.log에 이어 쓴다.
    // 셸에서 XDG_STATE_HOME을 바꿔 쓰면 launchd에도 같은 값을 줘서 상태·잠금 위치를 맞춘다.
    update: {
      label: LABELS.update, args: ['/bin/bash', join(root, 'bootstrap.sh'), 'update', '--auto'],
      runAtLoad: true, keepAlive: false, processType: 'Background', startInterval: UPDATE_INTERVAL,
      log: join(updateState, 'update.log'), dirs: [updateState], env: stateEnv,
    },
  };
  for (const name of Object.keys(defs)) if (disabledBy(name, roles)) defs[name] = null;
  return defs;
}

// Browser Use가 읽는 .env (browser_harness/paths.py와 같은 위치). 기본 연결 대상을 에이전트 Chrome으로 둔다.
export function harnessEnvPath({ home, env = {} }) {
  if (env.BH_AGENT_WORKSPACE) return join(env.BH_AGENT_WORKSPACE, '.env');
  const root = env.BH_HOME || env.BROWSER_HARNESS_HOME || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'browser-harness');
  return join(root, 'agent-workspace/.env');
}

function ensureHarnessEnv({ home, env, check, dryRun }) {
  const path = harnessEnvPath({ home, env });
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = text.split('\n').map(l => l.trim()).find(l => /^BU_CDP_URL\s*=/.test(l));
  if (line) {
    const value = line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
    if (value === AGENT_CHROME_URL) { console.log(`Browser Use 기본 연결: ${AGENT_CHROME_URL}`); return 0; }
    throw new Error(`${path}의 BU_CDP_URL이 다른 값입니다(${value}). 덮어쓰지 않았습니다.`);
  }
  if (check) { console.error(`Browser Use 기본 연결 설정 없음: ${path}`); return 1; }
  console.log(`${dryRun ? '[dry-run] ' : ''}Browser Use 기본 연결 추가: ${path}`);
  if (dryRun) return 0;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 다른 값(API 키 등)이 있을 수 있으므로 한 줄만 덧붙인다.
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}BU_CDP_URL=${AGENT_CHROME_URL}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return 0;
}

// noRestart: 자동 갱신 중에는 실행 중인 등록을 내렸다 올리지 않는다. 에이전트 Chrome·Paseo 데몬·자동 갱신 자신이
// 작업 도중에 끝나기 때문이다. 내용이 바뀌었으면 수동 작업 대기(2)로 알린다. 등록이 없을 때는 그대로 올린다.
function ensureAgent(def, { home, check, dryRun, noRestart, run, uid }) {
  const path = join(home, 'Library/LaunchAgents', `${def.label}.plist`);
  const want = plist(def);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const domain = `gui/${uid}`;
  const loaded = () => run('/bin/launchctl', ['print', `${domain}/${def.label}`], { encoding: 'utf8' }).status === 0;
  if (current === want && loaded()) { console.log(`자동 시작 등록됨: ${def.label}`); return 0; }
  if (check) {
    console.error(`자동 시작 ${current === null ? '없음' : current === want ? '미등록' : '내용 다름'}: ${def.label}`);
    return 1;
  }
  if (noRestart && current !== null && current !== want && loaded()) {
    console.error(`자동 시작 내용이 바뀜: ${def.label}. 실행 중이라 자동 갱신에서는 다시 올리지 않습니다 → 터미널에서 ./bootstrap.sh update`);
    return 2;
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}자동 시작 등록: ${path}`);
  if (dryRun) return 0;
  for (const dir of def.dirs || []) mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  // 내용이 바뀐 경우에만 내렸다 올린다. 에이전트 Chrome이 실행 중이면 이때 다시 시작된다.
  if (current !== null && current !== want && loaded()) run('/bin/launchctl', ['bootout', `${domain}/${def.label}`]);
  if (current !== want) writeFileSync(path, want);
  if (!loaded()) {
    const result = run('/bin/launchctl', ['bootstrap', domain, path], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`launchctl bootstrap 실패: ${def.label} ${result.stderr || result.error?.message || ''}`);
  }
  return 0;
}

// 역할이 끈 등록을 내리고 plist를 지운다. 실행 중인 프로세스(에이전트 Chrome)는 끄지 않는다. 내리면 함께 끝나기 때문이다.
// 그때는 plist만 지워 다음 로그인부터 시작하지 않게 하고 수동 작업 대기(2)로 알린다. 끝난 뒤 다시 실행하면 내린다.
// check: 0 꺼짐, 1 남아 있음, 2 실행 중이라 등록만 남음.
function removeAgent(label, role, { home, check, dryRun, run, uid }) {
  const path = join(home, 'Library/LaunchAgents', `${label}.plist`);
  const target = `gui/${uid}/${label}`;
  const printed = run('/bin/launchctl', ['print', target], { encoding: 'utf8' });
  const loaded = printed.status === 0;
  const running = loaded && /^\s*pid = \d+/m.test(printed.stdout || '');
  const present = existsSync(path);
  if (!loaded && !present) { console.log(`${role}: 자동 시작 꺼짐 ${label}`); return 0; }
  if (running) {
    if (check && present) { console.error(`${role}: 자동 시작이 남아 있음 ${label}`); return 1; }
    console.error(`${role}: ${label} 실행 중이라 내리지 않음. ${present ? 'plist를 지워 ' : ''}다음 로그인부터 시작하지 않습니다` +
      ` (지금 끄려면: launchctl bootout ${target})`);
    if (!check && present && !dryRun) rmSync(path, { force: true });
    return 2;
  }
  if (check) { console.error(`${role}: 자동 시작이 남아 있음 ${label}`); return 1; }
  console.log(`${dryRun ? '[dry-run] ' : ''}${role}: 자동 시작 해제 ${label}`);
  if (dryRun) return 0;
  if (loaded) {
    const result = run('/bin/launchctl', ['bootout', target], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`launchctl bootout 실패: ${label} ${result.stderr || result.error?.message || ''}`);
  }
  rmSync(path, { force: true });
  return 0;
}

// 결과: 0 완료, 1 실패, 2 수동 작업 대기(noRestart, 역할이 끈 등록이 실행 중). 실패가 대기보다 우선한다.
// roles: 켠 역할을 상태 파일 대신 정한다. role.sh의 dry-run이 상태 파일을 바꾸기 전에 바꾼 뒤의 결과를 미리 보여 줄 때 쓴다.
export function apply({ home = homedir(), env = process.env, laptop, only, check = false, dryRun = false, noRestart = false,
  run = spawnSync, uid = process.getuid(), chromeBinary = CHROME_BETA, roles: forcedRoles } = {}) {
  if (typeof laptop !== 'boolean') throw new Error('--laptop 또는 --desktop이 필요합니다');
  for (const role of forcedRoles || []) if (!(role in ROLE_DISABLED)) throw new Error(`알 수 없는 역할: ${role}`);
  const roles = forcedRoles || activeRoles({ home, env });
  const defs = definitions({ home, laptop, env, roles });
  let status = 0;
  let pending = false;
  for (const name of only ? [only] : Object.keys(defs)) {
    if (!(name in defs)) throw new Error(`알 수 없는 대상: ${name}`);
    const def = defs[name];
    const role = disabledBy(name, roles);
    if (role) {
      const result = removeAgent(LABELS[name], role, { home, check, dryRun, run, uid });
      if (result === 2) pending = true;
      else status = Math.max(status, result);
      continue;
    }
    if (!def) {
      console.log(name === 'paseo' ? 'Paseo 자동 시작: 노트북은 선택 사항 (시스템 설정 > 일반 > 로그인 항목)'
        : 'Paseo 업그레이드: 노트북은 앱이 스스로 업데이트');
      continue;
    }
    if (name === 'agent-chrome') {
      if (!existsSync(chromeBinary)) {
        console.error('Chrome Beta 없음. ./bootstrap.sh --only homebrew,browser');
        status = 1;
        continue;
      }
      status = Math.max(status, ensureHarnessEnv({ home, env, check, dryRun }));
    }
    const result = ensureAgent(def, { home, check, dryRun, noRestart, run, uid });
    if (result === 2) pending = true;
    else status = Math.max(status, result);
  }
  return status || (pending ? 2 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let only, roles;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--only' && args[i + 1]) only = args[++i];
      else if (args[i] === '--roles' && args[i + 1]) roles = args[++i] === 'none' ? [] : args[i].split(',');
      else if (!['--check', '--dry-run', '--no-restart', '--laptop', '--desktop'].includes(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
    }
    const laptop = args.includes('--laptop') ? true : args.includes('--desktop') ? false : undefined;
    process.exitCode = apply({ laptop, only, roles, check: args.includes('--check'), noRestart: args.includes('--no-restart'),
      dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1' });
  } catch (error) { console.error(`자동 시작: ${error.message}`); process.exitCode = 1; }
}
