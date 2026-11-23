// 개인 배치표대로 이 기기 데몬에 등록된 Paseo host의 metadata.work를 맞춘다 (agents/paseo.md "작업 배치").
// 배치표: Infisical bootstrap 프로젝트 prod /paseo-hosts의 HOST_WORK. 줄마다 "serverId work값", #부터 줄 끝은 주석인 여러 줄 값.
// 로그인한 Infisical CLI 프로필로 읽는다(scripts/paseo-api-key.py와 같은 방식). 값은 출력·로그·명령 인자에 남기지 않는다.
// 등록된 host 중 배치표에 있는 것만, 값이 다를 때만 paseo host update <등록 ID> --meta work=<값>.
// host 추가·삭제·켜고 끄기, work 밖의 metadata, 데몬 시작은 하지 않는다. Paseo CLI의 --meta는 조회한 metadata 전체에 넘긴 키를
// 합쳐 통째로 바꾸므로, work 밖의 키가 있는 host는 동시에 바뀐 그 키를 되돌리지 않도록 자동으로 쓰지 않는다.
// 배치표 조회 실패·형식 오류·데몬 응답 실패는 짧은 코드로 알리고 0으로 끝난다(자동 갱신을 막지 않는다). 결과 한 줄을 상태 파일에 남긴다.
// 자동 갱신(scripts/update.sh)이 바뀐 파일과 관계없이 매번 부른다. --auto는 바꾼 것과 바뀐 결과만 출력한다.
// Infisical·Paseo 호출 전체는 20초 안에 끝낸다. 넘기면 SIGKILL로 끝내고 다음 주기에 다시 본다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pretty = path => path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path;
const SERVER_ID = /^[A-Za-z0-9_-]+$/;
const WORK = /^[가-힣A-Za-z0-9_-]+(,[가-힣A-Za-z0-9_-]+)*$/;
const WORK_MAX = 256;  // Paseo는 metadata 값을 4096자까지 받는다
const TIMEOUT_MS = 20_000;
export const INFISICAL = { domain: 'https://app.infisical.com/api', projectId: '3ce526b3-d09b-4c7e-b116-873ce8a9cd2f', env: 'prod', path: '/paseo-hosts', key: 'HOST_WORK' };
// host ls --json은 stderr에 JSON 오류를, host update는 "Error: <메시지>" 텍스트를 낸다. 텍스트에서는 알려진 코드만 뽑는다.
const KNOWN_ERRORS = [['DAEMON_NOT_RUNNING', /DAEMON_NOT_RUNNING|Daemon is not running/], ['permission_denied', /permission_denied/i]];

// 배치표 내용 → Map(serverId → work 값). 틀린 줄이 하나라도 있으면 전체를 쓰지 않는다(일부만 맞추지 않는다).
export function parseTable(text) {
  const table = new Map();
  text.split('\n').forEach((raw, index) => {
    const fields = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
    if (!fields.length) return;
    const [id, work] = fields;
    if (fields.length !== 2 || !SERVER_ID.test(id) || !WORK.test(work) || work.length > WORK_MAX) {
      throw new Error(`줄 ${index + 1}: "serverId work값" 형식이 아닙니다 (serverId는 영숫자·_·-, work는 한글·영숫자·_·-를 쉼표로 이은 ${WORK_MAX}자 이하)`);
    }
    if (table.has(id)) throw new Error(`줄 ${index + 1}: serverId가 중복됩니다`);
    table.set(id, work);
  });
  return table;
}

// 등록 host 목록과 배치표 → 바꿀 것과, 바꿔야 하지만 work 밖 metadata가 있어 건너뛸 것.
export function plan(hosts, table) {
  const changes = [], skipped = [];
  for (const host of hosts) {
    const want = table.get(host?.serverId);
    if (want === undefined || !host.registrationId) continue;
    const from = host.metadata?.work ?? '';
    if (from === want) continue;
    const others = Object.keys(host.metadata ?? {}).filter(key => key !== 'work');
    (others.length ? skipped : changes).push({ host, from, to: want, others });
  }
  return { changes, skipped };
}

const name = host => `${host.label || host.registrationId} (${host.serverId})`;

// 오류는 코드만 남긴다(메시지에는 경로 등이 들어간다). 코드를 못 찾으면 종료 코드만.
function why(result) {
  if (result.error?.code === 'ENOENT') return 'paseo 없음';
  if (result.error?.code === 'ETIMEDOUT') return '시간 초과';
  try {
    const code = JSON.parse(result.stderr).error.code;
    if (typeof code === 'string' && /^[A-Za-z_]+$/.test(code)) return code;
  } catch {}
  const known = KNOWN_ERRORS.find(([, pattern]) => pattern.test(result.stderr ?? ''));
  return known ? known[0] : `종료 ${result.status ?? result.signal}`;
}

// Infisical에서 배치표 값을 읽는다. { text } 또는 { code }(짧은 건너뜀 이유). 키가 없으면 CLI는 종료 0에 빈 값을 낸다.
function readTable(run) {
  const env = { ...process.env };
  delete env.INFISICAL_TOKEN;  // 로그인 프로필로만 읽는다
  const infisical = args => run('infisical', [...args, '--silent'], { cwd: '/', env });
  const login = infisical(['profile', 'current', '--plain']);
  const cliCode = result => result.error?.code === 'ENOENT' ? 'infisical 없음' : result.error?.code === 'ETIMEDOUT' ? '시간 초과' : null;
  if (cliCode(login)) return { code: cliCode(login) };
  const profile = login.stdout.trim();
  if (login.status !== 0 || !profile || profile.includes('\n')) return { code: 'infisical 미로그인' };
  const scope = ['--profile', profile, '--domain', INFISICAL.domain];
  const got = infisical(['secrets', 'get', INFISICAL.key, ...scope, '--projectId', INFISICAL.projectId,
    '--env', INFISICAL.env, '--path', INFISICAL.path, '--plain', '--expand=false']);
  if (cliCode(got)) return { code: cliCode(got) };
  if (got.status === 0) return got.stdout.trim() ? { text: got.stdout } : { code: '키 없음' };
  const status = infisical(['login', 'status', ...scope]);
  if (cliCode(status)) return { code: cliCode(status) };
  return { code: status.status !== 0 ? 'infisical 미로그인' : `조회 실패(종료 ${got.status ?? got.signal})` };
}

function sync(home, deadline) {
  const run = (command, args, options = {}) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) return { error: { code: 'ETIMEDOUT' } };
    return spawnSync(command, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  };
  const paseo = args => run('paseo', [...args, '--home', home]);
  const source = `Infisical ${INFISICAL.path}/${INFISICAL.key}`;
  const { text, code } = readTable(run);
  if (code) return { result: `host work 맞춤 건너뜀: 배치표 조회 안 됨 (${code})`, lines: [] };
  let table;
  try { table = parseTable(text); } catch (error) {
    return { result: `host work 맞춤 건너뜀: 배치표 형식 오류 (${source} ${error.message})`, lines: [] };
  }
  if (!table.size) return { result: `host work 맞춤 건너뜀: 배치표가 비어 있음 (${source})`, lines: [] };

  const listed = paseo(['host', 'ls', '--json']);
  let hosts = null;
  try { hosts = JSON.parse(listed.stdout); } catch {}
  if (listed.status !== 0 || !Array.isArray(hosts)) {
    return { result: `host work 맞춤 실패: 데몬 응답 없음 (paseo host ls: ${why(listed)}). 다음 갱신에서 다시 확인합니다`, lines: [] };
  }

  const { changes, skipped } = plan(hosts, table);
  const lines = [];
  const problems = skipped.map(({ host, others }) => `${name(host)} work 밖 metadata(${others.join(',')})가 있어 수동으로 맞춤`);
  for (const { host, from, to } of changes) {
    const updated = paseo(['host', 'update', host.registrationId, '--meta', `work=${to}`]);
    if (updated.status === 0) lines.push(`host work 맞춤: ${name(host)} ${from || '(없음)'} → ${to}`);
    else problems.push(`${name(host)} 실패 (${why(updated)})`);
  }
  if (problems.length) return { result: `host work 맞춤 남음: ${problems.join(', ')}`, lines };
  return { result: 'host work 일치', lines };
}

function main() {
  const auto = process.argv.includes('--auto');
  const state = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'bootstrap/update/host-work');
  const home = process.env.PASEO_HOME || join(homedir(), '.paseo');
  const { result, lines } = sync(home, Date.now() + TIMEOUT_MS);
  let previous = null;
  try { previous = readFileSync(state, 'utf8').trim(); } catch {}
  for (const line of lines) console.log(line);
  if (!auto || result !== previous) console.log(result);
  if (result === previous) return;
  try {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, `${result}\n`);
  } catch (error) {
    console.log(`host work 상태 기록 실패 (${pretty(state)}: ${error.code})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
