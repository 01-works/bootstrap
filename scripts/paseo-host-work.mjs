// 개인 배치표대로 이 기기 데몬에 등록된 Paseo host의 metadata.work를 맞춘다 (agents/paseo.md "작업 배치").
// 배치표: ${XDG_CONFIG_HOME:-~/.config}/bootstrap/host-work. 줄마다 "serverId work값", #부터 줄 끝은 주석. 저장소에 두지 않는다.
// 등록된 host 중 배치표에 있는 것만, 값이 다를 때만 paseo host update <등록 ID> --meta work=<값>.
// host 추가·삭제·켜고 끄기, work 밖의 metadata, 데몬 시작은 하지 않는다.
// 배치표 없음·형식 오류·데몬 응답 실패는 알리고 0으로 끝난다(자동 갱신을 막지 않는다). 결과 한 줄을 상태 파일에 남긴다.
// 자동 갱신(scripts/update.sh)이 바뀐 파일과 관계없이 매번 부른다. --auto는 바꾼 것과 바뀐 결과만 출력한다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pretty = path => path.startsWith(`${homedir()}/`) ? `~/${path.slice(homedir().length + 1)}` : path;

// 배치표 내용 → Map(serverId → work 값). 형식이 틀린 줄이 하나라도 있으면 전체를 쓰지 않는다(일부만 맞추지 않는다).
export function parseTable(text) {
  const table = new Map();
  text.split('\n').forEach((raw, index) => {
    const fields = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
    if (!fields.length) return;
    if (fields.length !== 2) throw new Error(`줄 ${index + 1}: "serverId work값" 두 칸이 아닙니다`);
    if (table.has(fields[0])) throw new Error(`줄 ${index + 1}: serverId가 중복됩니다`);
    table.set(fields[0], fields[1]);
  });
  return table;
}

// 등록 host 목록과 배치표 → 바꿀 것, 맞는 것, 이 데몬에 등록되지 않은 배치표 serverId 수.
export function plan(hosts, table) {
  const changes = [], matched = [];
  for (const host of hosts) {
    const want = table.get(host?.serverId);
    if (want === undefined || !host.registrationId) continue;
    const from = host.metadata?.work ?? '';
    (from === want ? matched : changes).push({ host, from, to: want });
  }
  const registered = new Set(hosts.map(host => host?.serverId));
  return { changes, matched, unregistered: [...table.keys()].filter(id => !registered.has(id)).length };
}

const name = host => `${host.label || host.registrationId} (${host.serverId})`;

function paseo(args, home) {
  return spawnSync('paseo', [...args, '--home', home], { encoding: 'utf8', timeout: 30_000 });
}

// 결과 한 줄(상태 파일에 남김)과 그 전에 출력할 줄을 돌려준다.
function sync(tablePath, home, dryRun) {
  let text;
  try { text = readFileSync(tablePath, 'utf8'); } catch (error) {
    const why = error.code === 'ENOENT' ? '배치표 없음' : `배치표를 읽을 수 없음 (${error.code})`;
    return { result: `host work 맞춤 건너뜀: ${why} (${pretty(tablePath)})`, lines: [] };
  }
  let table;
  try { table = parseTable(text); } catch (error) {
    return { result: `host work 맞춤 건너뜀: 배치표 형식 오류 (${pretty(tablePath)} ${error.message})`, lines: [] };
  }
  if (!table.size) return { result: `host work 맞춤 건너뜀: 배치표가 비어 있음 (${pretty(tablePath)})`, lines: [] };

  const listed = paseo(['host', 'ls', '--json'], home);
  let hosts;
  try { hosts = JSON.parse(listed.stdout); } catch { hosts = null; }
  if (listed.status !== 0 || !Array.isArray(hosts)) {
    const why = listed.error?.code === 'ENOENT' ? 'paseo 없음'
      : hosts?.error?.code ?? listed.error?.code ?? `종료 ${listed.status ?? listed.signal}`;
    return { result: `host work 맞춤 실패: 데몬 응답 없음 (paseo host ls: ${why}). 다음 갱신에서 다시 확인합니다`, lines: [] };
  }

  const { changes, matched, unregistered } = plan(hosts, table);
  const lines = [], failed = [];
  for (const { host, from, to } of changes) {
    const line = `host work 맞춤: ${name(host)} ${from || '(없음)'} → ${to}`;
    if (dryRun) { lines.push(`[dry-run] ${line}`); continue; }
    const updated = paseo(['host', 'update', host.registrationId, '--meta', `work=${to}`], home);
    if (updated.status === 0) lines.push(line);
    else failed.push(`${name(host)} 종료 ${updated.status ?? updated.error?.code ?? updated.signal}`);
  }
  if (failed.length) return { result: `host work 맞춤 실패: ${failed.join(', ')}. 다음 갱신에서 다시 시도합니다`, lines };
  const extra = unregistered ? `, 이 데몬에 등록되지 않은 serverId ${unregistered}개는 건너뜀` : '';
  return { result: `host work 일치 (배치표 대상 등록 host ${matched.length + changes.length}개${extra})`, lines };
}

function main() {
  const auto = process.argv.includes('--auto');
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const state = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'bootstrap/update/host-work');
  const home = process.env.PASEO_HOME || join(homedir(), '.paseo');
  const { result, lines } = sync(join(config, 'bootstrap/host-work'), home, dryRun);
  let previous = null;
  try { previous = readFileSync(state, 'utf8').trim(); } catch {}
  for (const line of lines) console.log(line);
  if (!auto || result !== previous) console.log(result);
  if (!dryRun && result !== previous) {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, `${result}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
