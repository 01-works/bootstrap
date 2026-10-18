// 저장소의 사용자 스킬 원본을 Claude/Codex 검색 경로에 한 번씩 연결한다.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../agents/skills/', import.meta.url));

function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function main() {
  const args = process.argv.slice(2);
  let targetHome = homedir();
  let check = false;
  let dryRun = process.env.DRY_RUN === '1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) targetHome = resolve(args[++i]);
    else if (args[i] === '--check') check = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error(`알 수 없는 인자: ${args[i]}`);
  }
  const missing = [];
  // 충돌은 전체 계획을 확인한 뒤 쓰기 전에 거부한다. 개인 스킬은 덮어쓰지 않는다.
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const src = join(sourceRoot, entry.name);
    if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`SKILL.md 없음: ${src}`);
    const legacy = join(targetHome, '.codex/skills', entry.name);
    if (present(legacy)) throw new Error(`Codex 중복 스킬 확인 필요: ${legacy}. 기존 스킬은 유지했습니다.`);
    for (const scope of ['.agents/skills', '.claude/skills']) {
      const dst = join(targetHome, scope, entry.name);
      if (present(dst)) {
        if (lstatSync(dst).isSymbolicLink() && resolve(dirname(dst), readlinkSync(dst)) === src) continue;
        throw new Error(`스킬 경로 충돌: ${dst}. 기존 스킬은 유지했습니다.`);
      }
      missing.push({ src, dst });
    }
  }
  if (!missing.length) { console.log('사용자 스킬 연결이 저장소와 일치합니다.'); return; }
  for (const { src, dst } of missing) {
    console.log(`${check ? '누락' : dryRun ? '[dry-run] 연결' : '연결'}: ${dst} → ${src}`);
    if (check || dryRun) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst, 'dir');
  }
  if (check) process.exitCode = 1;
}

try { main(); }
catch (error) { console.error(`사용자 스킬: ${error.message}`); process.exitCode = 1; }
