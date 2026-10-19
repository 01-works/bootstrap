// Chrome 승인형 원격 디버깅 설정. 인증·프로필 데이터는 저장소에 복사하지 않는다.
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export function enableChromeDebugging(config) {
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(config) || (config.devtools != null && !isObject(config.devtools)) ||
      (config.devtools?.remote_debugging != null && !isObject(config.devtools.remote_debugging))) {
    throw new Error('Chrome devtools 설정이 객체 형식이 아닙니다. 기존 설정을 유지합니다.');
  }
  const result = structuredClone(config);
  result.devtools ??= {};
  result.devtools.remote_debugging ??= {};
  result.devtools.remote_debugging['user-enabled'] = true;
  return result;
}

const defaultStateHome = () => process.env.XDG_STATE_HOME || join(homedir(), '.local/state');

function backup(path, stateHome) {
  if (!existsSync(path)) return;
  const root = join(stateHome, 'bootstrap/backup');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'browser-chrome-'));
  const dst = join(dir, 'Local State');
  copyFileSync(path, dst);
  chmodSync(dst, 0o600);
  writeFileSync(join(dir, 'source-path.txt'), `${path}\n`, { mode: 0o600 });
  console.log(`설정 백업: ${dst}`);
}

function readObject(path) {
  const text = readFileSync(path, 'utf8');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`객체 형식이 아닙니다: ${path}`);
  return { text, value };
}

// 경로와 외부 명령을 주입할 수 있어 실제 홈·브라우저 없이 파일 적용 경로를 검증한다.
export function configureChrome({ home = homedir(), stateHome = defaultStateHome(), check = false, dryRun = false, run = spawnSync } = {}) {
  const path = join(home, 'Library/Application Support/Google/Chrome/Local State');
  const before = existsSync(path) ? readObject(path) : { text: null, value: {} };
  if (before.value.devtools?.remote_debugging?.['user-enabled'] === true) {
    console.log('Chrome 승인형 원격 디버깅 설정: 켜짐 (실제 연결 승인은 별도)');
    return 0;
  }
  if (check) {
    console.error('Chrome 설정 대기: Chrome 종료 후 ./bootstrap.sh --only browser');
    return 2;
  }
  if (dryRun) {
    console.log('[dry-run] Chrome이 종료되어 있으면 승인형 원격 디버깅 설정; 실행 중이면 안내');
    return 0;
  }
  const running = () => {
    const result = run('/usr/bin/pgrep', ['-x', 'Google Chrome']);
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Chrome 실행 상태 확인 실패');
    return result.status === 0;
  };
  if (running()) {
    console.error('Chrome 실행 중: 파일을 유지했습니다. chrome://inspect/#remote-debugging 에서 켜거나 종료 후 ./bootstrap.sh --only browser 를 실행하세요.');
    return 2;
  }
  const after = enableChromeDebugging(before.value);
  const assertUnchanged = () => {
    if ((existsSync(path) ? readFileSync(path, 'utf8') : null) !== before.text) throw new Error('Chrome 설정이 변경되었습니다. 다시 실행하세요.');
  };
  assertUnchanged();
  backup(path, stateHome);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.bootstrap-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(after));
    // 준비 도중 Chrome이 시작되거나 설정을 바꾼 경우에도 원본을 보존한다.
    if (running()) { console.error('설정 준비 중 Chrome이 시작되었습니다. 종료 후 다시 실행하세요.'); return 2; }
    assertUnchanged();
    renameSync(temp, path);
  } finally {
    closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
  console.log('Chrome 승인형 원격 디버깅 설정 완료. 다음 Chrome 실행부터 적용됩니다.');
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--dry-run'].includes(arg))) throw new Error('지원 인자: --check --dry-run');
  process.exitCode = configureChrome({ check: args.includes('--check'), dryRun: args.includes('--dry-run') || process.env.DRY_RUN === '1' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
