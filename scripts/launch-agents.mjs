// 로그인 시 실행할 사용자 LaunchAgent: 에이전트 전용 Chrome, (늘 켜두는 기기) Paseo 데몬.
// plist에는 이 기기의 절대 경로가 들어가므로 저장소에 두지 않고 여기서 만든다.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const AGENT_CHROME_PORT = 9333;
export const AGENT_CHROME_URL = `http://127.0.0.1:${AGENT_CHROME_PORT}`;
export const CHROME_BETA = '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta';
// cask는 /opt/homebrew/bin에, 앱 직접 설치는 다른 곳에 링크하므로 앱 안의 CLI를 직접 쓴다.
export const PASEO_CLI = '/Applications/Paseo.app/Contents/Resources/bin/paseo';
export const LABELS = { 'agent-chrome': 'local.bootstrap.agent-chrome', paseo: 'local.bootstrap.paseo' };

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist({ label, args, runAtLoad, keepAlive, interactive, env }) {
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
  if (interactive) lines.push('  <key>ProcessType</key><string>Interactive</string>');
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

// 노트북은 필요할 때 시작하고(launchctl kickstart), 늘 켜두는 기기는 로그인할 때 시작한다.
export function definitions({ home, laptop, env = {} }) {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local/share');
  const profile = join(dataHome, 'bootstrap/agent-chrome');
  return {
    'agent-chrome': {
      label: LABELS['agent-chrome'],
      args: [CHROME_BETA, `--user-data-dir=${profile}`, `--remote-debugging-port=${AGENT_CHROME_PORT}`,
        '--no-first-run', '--no-default-browser-check'],
      runAtLoad: !laptop, keepAlive: !laptop, interactive: true, dirs: [profile],
    },
    // 노트북의 Paseo 자동 시작은 선택 사항이라 만들지 않는다 (시스템 설정 > 일반 > 로그인 항목).
    // 데몬만 띄운다(앱 불필요). 이미 실행 중이면 그대로 둔다. 데몬이 claude·codex를 찾을 수 있게 PATH를 준다.
    paseo: laptop ? null : {
      label: LABELS.paseo, args: [PASEO_CLI, 'daemon', 'start'], runAtLoad: true, keepAlive: false,
      env: { PATH: [join(home, '.local/bin'), join(home, 'Library/pnpm/bin'), join(home, '.local/share/fnm/aliases/default/bin'),
        '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') },
    },
  };
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

function ensureAgent(def, { home, check, dryRun, run, uid }) {
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

export function apply({ home = homedir(), env = process.env, laptop, only, check = false, dryRun = false,
  run = spawnSync, uid = process.getuid(), chromeBinary = CHROME_BETA } = {}) {
  if (typeof laptop !== 'boolean') throw new Error('--laptop 또는 --desktop이 필요합니다');
  const defs = definitions({ home, laptop, env });
  let status = 0;
  for (const name of only ? [only] : Object.keys(defs)) {
    if (!(name in defs)) throw new Error(`알 수 없는 대상: ${name}`);
    const def = defs[name];
    if (!def) { console.log('Paseo 자동 시작: 노트북은 선택 사항 (시스템 설정 > 일반 > 로그인 항목)'); continue; }
    if (name === 'agent-chrome') {
      if (!existsSync(chromeBinary)) {
        console.error('Chrome Beta 없음. ./bootstrap.sh --only homebrew,browser');
        status = 1;
        continue;
      }
      status = Math.max(status, ensureHarnessEnv({ home, env, check, dryRun }));
    }
    status = Math.max(status, ensureAgent(def, { home, check, dryRun, run, uid }));
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let only;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--only' && args[i + 1]) only = args[++i];
      else if (!['--check', '--dry-run', '--laptop', '--desktop'].includes(args[i])) throw new Error(`알 수 없는 인자: ${args[i]}`);
    }
    const laptop = args.includes('--laptop') ? true : args.includes('--desktop') ? false : undefined;
    process.exitCode = apply({ laptop, only, check: args.includes('--check'),
      dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1' });
  } catch (error) { console.error(`자동 시작: ${error.message}`); process.exitCode = 1; }
}
