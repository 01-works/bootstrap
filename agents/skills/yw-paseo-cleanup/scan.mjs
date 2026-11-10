#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, realpathSync, existsSync, mkdirSync, chmodSync, writeFileSync, lstatSync, globSync, createReadStream } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { classify, protectionContext, scanSummary, isOwnedWorkspace } from './classify.mjs';

const labelKeys = new Set(['paseo.parent-agent-id', 'paseo.parent-server-id', 'zerosub.continued-from', 'handoff.from', 'handoff.profile', 'agent-list.continued-from', 'agent-list.original-title', 'supervisor', 'role', 'lane', 'issue', 'pr', 'task']);
const agentFields = ['id', 'provider', 'cwd', 'workspaceId', 'createdAt', 'updatedAt', 'lastActivityAt', 'lastUserMessageAt', 'title', 'lastStatus', 'archivedAt', 'requiresAttention', 'attentionReason', 'internal'];
export function redact(text, limit = 2000) {
  return String(text).replace(/Bearer\s+[^\s"'`]+/gi, '[REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]+\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*_(?:TOKEN|SECRET)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .slice(0, limit);
}
const pick = (object, fields) => Object.fromEntries(fields.filter(k => object[k] === null || ['string', 'number', 'boolean'].includes(typeof object[k])).map(k => [k, object[k]]));
const nativeIdsBySnapshot = new WeakMap();
const relationLabels = new Set(['paseo.parent-agent-id', 'paseo.parent-server-id', 'zerosub.continued-from', 'handoff.from', 'agent-list.continued-from']);
const freeTextFields = new Set(['title', 'displayName', 'attentionReason', 'text', 'excerptReason', 'reason', 'reasons', 'warnings', 'timeBasis']);
// This is an output boundary. Decisions always use the unmodified canonical inventory.
export function serializeSnapshot(snapshot) {
  const nativeIds = nativeIdsBySnapshot.get(snapshot) ?? new Set();
  let structuralHashCount = 0;
  const structural = value => {
    if (redact(value, Infinity) === value) return value;
    structuralHashCount++;
    return `[STRUCT_SHA256:${createHash('sha256').update(value).digest('hex')}]`;
  };
  const visit = (value, key = '', parent = '') => {
    if (Array.isArray(value)) return value.map(item => visit(item, key, parent));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [structural(name), visit(item, name, key)]));
    if (typeof value !== 'string') return value;
    const free = freeTextFields.has(key) || (parent === 'labels' && !relationLabels.has(key)) || (parent === 'definitions' && key === 'scripts');
    if (free) {
      const limit = key === 'text' ? 600 : parent === 'labels' ? 512 : key === 'scripts' ? 128 : 2000;
      return redactSessionText(redact(value, Infinity), nativeIds).slice(0, limit);
    }
    return structural(value);
  };
  const output = visit(snapshot);
  if (structuralHashCount && output?.meta) output.meta.outputRedaction = { structuralHashCount, classificationUsedOriginalCanonicalValues: true, reclassificationRequiresOriginalInventory: true };
  return output;
}
export function sanitizeAgent(raw) {
  const a = pick(raw, agentFields);
  a.labels = Object.fromEntries(Object.entries(raw.labels ?? {}).filter(([k, v]) => labelKeys.has(k) && !/(?:secret|token|key|password|auth|credential)/i.test(k) && typeof v === 'string'));
  a.droppedLabelCount = Object.keys(raw.labels ?? {}).length - Object.keys(a.labels).length;
  return a;
}
export function redactSessionText(value, sessionIds) {
  if (typeof value !== 'string') return value;
  return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => sessionIds.has(id) ? '[PROVIDER_SESSION]' : id);
}
export function parseOptions(argv) {
  const options = { minAgeHours: 72, maxInputAgeMinutes: 30, gh: false, excerpts: false };
  const values = { '--out': 'out', '--paseo-home': 'paseoHome', '--live': 'live', '--pending': 'pending', '--terminals': 'terminals', '--self-agent': 'selfAgentId', '--self-cwd': 'selfCwd', '--min-age-hours': 'minAgeHours', '--max-input-age-minutes': 'maxInputAgeMinutes', '--excerpt-ids': 'excerptIds' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--gh') options.gh = true;
    else if (arg === '--excerpts') options.excerpts = true;
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[values[arg]] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  options.minAgeHours = Number(options.minAgeHours);
  if (!Number.isFinite(options.minAgeHours) || options.minAgeHours < 0) throw new Error('min-age-hours must be nonnegative');
  options.maxInputAgeMinutes = Number(options.maxInputAgeMinutes);
  if (!Number.isFinite(options.maxInputAgeMinutes) || options.maxInputAgeMinutes < 0) throw new Error('max-input-age-minutes must be nonnegative');
  if (options.excerptIds) options.excerpts = true;
  if (options.excerpts && !options.excerptIds && !options.help) throw new Error('--excerpts requires --excerpt-ids');
  return options;
}
const jsonReadFailed = Symbol('json-read-failed');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateObservation(kind, input, serverId, now, maxAgeMinutes = 30) {
  const metadata = { serverId: typeof input?.serverId === 'string' ? input.serverId : null, observedAt: typeof input?.observedAt === 'string' ? input.observedAt : null, scope: typeof input?.scope === 'string' ? input.scope : null, state: 'unchecked', issues: [] };
  if (!serverId || metadata.serverId !== serverId) metadata.issues.push('input_server_mismatch_or_missing');
  const observed = Date.parse(metadata.observedAt), scan = Date.parse(now);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(metadata.observedAt ?? '') || !Number.isFinite(observed)) metadata.issues.push('input_observed_at_missing_or_invalid');
  else if (scan - observed > maxAgeMinutes * 60000) metadata.issues.push('input_stale');
  else if (observed - scan > 60000) metadata.issues.push('input_from_future');
  const scopes = kind === 'live' ? ['all', 'listed_agents'] : kind === 'pending' ? ['all'] : ['all', 'cwd'];
  if (!scopes.includes(metadata.scope)) metadata.issues.push('input_scope_missing_or_invalid');
  metadata.state = metadata.issues.length ? 'unchecked' : 'confirmed';
  return metadata;
}
export function readPaseoVersion(paseoHome, infoPlist = '/Applications/Paseo.app/Contents/Info.plist') {
  const sources = [{ path: infoPlist, kind: 'app_info_plist' }, { path: join(paseoHome, 'version.json'), kind: 'paseo_home_version' }, { path: join(paseoHome, 'package.json'), kind: 'paseo_home_package' }];
  for (const source of sources) {
    try {
      const text = readFileSync(source.path, 'utf8');
      const version = source.kind === 'app_info_plist' ? text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] : JSON.parse(text)?.version;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return { version, source: source.kind };
    } catch { /* Try the next read-only source. */ }
  }
  return { version: null, source: null };
}
function canonical(path) { try { return realpathSync(path); } catch { return resolve(path); } }
export function validRefName(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.endsWith('.') || ref.includes('..') || ref.includes('@{')) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)) return false;
  return ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
export function assertReadOnlyCommand(command, args) {
  if (!Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Invalid subprocess arguments');
  if (command === 'gh') {
    const fixed = ['pr', 'list', '--repo', null, '--state', 'all', '--head', null, '--limit', '100', '--json', 'number,state,headRefOid,mergedAt,url'];
    if (args.length === fixed.length && fixed.every((value, i) => value === null ? args[i].length > 0 && !args[i].startsWith('-') : args[i] === value)) return;
    throw new Error('Command outside read-only allowlist');
  }
  if (command !== 'git' || args[0] !== '-C' || !args[1]) throw new Error('Command outside read-only allowlist');
  const query = args.slice(2);
  const fixed = [
    ['rev-parse', '--show-toplevel'], ['rev-parse', 'HEAD'], ['rev-parse', '--git-common-dir'], ['rev-parse', '--absolute-git-dir'],
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'], ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
    ['status', '--porcelain=v2', '-z', '--untracked-files=all'], ['status', '--ignored=matching', '--porcelain=v2', '-z'],
    ['worktree', 'list', '--porcelain', '-z'], ['branch', '-a', '--contains', 'HEAD', '--format=%(refname)'],
    ['tag', '--contains', 'HEAD'], ['log', '-1', '--format=%cI', 'HEAD'], ['config', '--get', 'remote.origin.url'],
  ];
  if (fixed.some(allowed => JSON.stringify(allowed) === JSON.stringify(query))) return;
  if (query.length === 4 && query[0] === 'merge-base' && query[1] === '--is-ancestor' && query[2] === 'HEAD' && validRefName(query[3])) return;
  throw new Error('Command outside read-only allowlist');
}
export function run(command, args, cwd) {
  assertReadOnlyCommand(command, args);
  const r = spawnSync(command, args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, code: r.status, text: r.stdout ?? '', error: r.error?.code ?? (r.status === 0 ? null : `exit:${r.status ?? 'unknown'}`) };
}
export function parseStatus(text) {
  const entries = text.split('\0'); let dirtyCount = 0, untrackedCount = 0; const ignored = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (/^[12u] /.test(entry)) { dirtyCount++; if (entry.startsWith('2 ')) i++; }
    else if (entry.startsWith('? ')) untrackedCount++;
    else if (entry.startsWith('! ')) ignored.push(entry.slice(2));
  }
  return { dirtyCount, untrackedCount, ignoredCount: ignored.length, ignoredPaths: ignored.slice(0, 30) };
}
function safeOrigin(raw) {
  const github = raw.match(/^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/git@|git@)([^/:]+)[:/]([^?#]+?)(?:\.git)?$/);
  if (!github) return null;
  return github[1] === 'github.com' ? `${github[1]}/${github[2].replace(/\.git$/, '')}` : null;
}
export function inspectGit(path, options, gaps, prCache) {
  const g = { kind: 'git', errors: [], registered: false, prs: [], prCheck: 'unchecked' };
  const git = (args, allow = []) => {
    let r;
    try { r = run('git', ['-C', path, ...args]); }
    catch { r = { ok: false, code: null, text: '', error: 'read-query-rejected' }; }
    if (!r.ok && !allow.includes(r.code)) g.errors.push({ command: args[0], code: r.error });
    return r;
  };
  const dotgit = join(path, '.git');
  try {
    if (statSync(dotgit).isFile()) {
      const match = readFileSync(dotgit, 'utf8').match(/^gitdir: (.+)\s*$/);
      if (!match || !existsSync(resolve(path, match[1]))) { g.kind = 'broken'; g.errors.push({ command: 'gitdir', code: 'missing-target' }); gaps.push({ source: 'git', path, reason: 'missing gitdir target' }); return g; }
    }
  } catch (e) { if (e.code !== 'ENOENT') g.errors.push({ command: 'gitdir', code: e.code }); }
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) { g.kind = 'non-git'; gaps.push({ source: 'git', path, reason: 'repository lookup failed', commands: g.errors }); return g; }
  if (canonical(top.text.trim()) !== canonical(path)) { g.kind = 'nested'; return g; }
  const head = git(['rev-parse', 'HEAD']); g.head = head.ok ? head.text.trim() : null;
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], [1]); g.branch = branch.ok ? branch.text.trim() : null; g.detached = !branch.ok && branch.code === 1;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], [128]); g.upstream = upstream.ok ? upstream.text.trim() : null;
  if (g.upstream) { const diff = git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']); if (diff.ok) [g.ahead, g.behind] = diff.text.trim().split(/\s+/).map(Number); }
  const status = git(['status', '--porcelain=v2', '-z', '--untracked-files=all']); if (status.ok) Object.assign(g, parseStatus(status.text));
  const ignored = git(['status', '--ignored=matching', '--porcelain=v2', '-z']); if (ignored.ok) { const parsed = parseStatus(ignored.text); g.ignoredCount = parsed.ignoredCount; g.ignoredPaths = parsed.ignoredPaths; }
  const common = git(['rev-parse', '--git-common-dir']);
  if (common.ok) g.commonDir = canonical(resolve(path, common.text.trim()));
  const list = git(['worktree', 'list', '--porcelain', '-z']);
  if (list.ok) for (const block of list.text.split('\0\0')) {
    const lines = block.split('\0'), line = lines.find(l => l.startsWith('worktree '));
    if (line && canonical(line.slice(9)) === canonical(path)) { g.registered = true; g.locked = lines.some(l => /^locked(?: |$)/.test(l)); g.prunable = lines.some(l => /^prunable(?: |$)/.test(l)); }
  }
  const base = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']); g.defaultRef = base.ok ? base.text.trim() : null;
  if (g.defaultRef && g.head) { const merged = git(['merge-base', '--is-ancestor', 'HEAD', g.defaultRef], [1]); g.mergedIntoDefault = merged.ok ? true : merged.code === 1 ? false : null; }
  else g.mergedIntoDefault = null;
  {
    const branches = git(['branch', '-a', '--contains', 'HEAD', '--format=%(refname)']), tags = git(['tag', '--contains', 'HEAD']);
    if (branches.ok && tags.ok) g.reachableRefs = [...branches.text.split('\n').filter(s => s.startsWith('refs/')), ...tags.text.split('\n').filter(Boolean).map(s => `refs/tags/${s}`)].filter(ref => ref !== (g.branch ? `refs/heads/${g.branch}` : null));
  }
  const commitTime = git(['log', '-1', '--format=%cI', 'HEAD']);
  g.headCommittedAt = commitTime.ok ? commitTime.text.trim() : null;
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  g.modificationTimes = { headCommit: g.headCommittedAt, root: null, index: null, gitHead: null };
  try { g.modificationTimes.root = statSync(path).mtime.toISOString(); } catch { g.errors.push({ command: 'stat-root', code: 'unavailable' }); }
  if (gitDir.ok) for (const [key, filename] of [['index', 'index'], ['gitHead', 'HEAD']]) {
    try { g.modificationTimes[key] = statSync(join(gitDir.text.trim(), filename)).mtime.toISOString(); } catch { g.errors.push({ command: `stat-${filename}`, code: 'unavailable' }); }
  }
  g.modifiedAt = Object.values(g.modificationTimes).every(t => Number.isFinite(Date.parse(t))) ? new Date(Math.max(...Object.values(g.modificationTimes).map(t => Date.parse(t)))).toISOString() : null;
  const origin = git(['config', '--get', 'remote.origin.url']); g.origin = origin.ok ? safeOrigin(origin.text.trim()) : null;
  if (options.gh && g.branch && g.origin) {
    const key = `${g.origin}:${g.branch}`;
    if (!prCache.has(key)) {
      const r = run('gh', ['pr', 'list', '--repo', g.origin, '--state', 'all', '--head', g.branch, '--limit', '100', '--json', 'number,state,headRefOid,mergedAt,url'], path);
      try {
        if (!r.ok) throw new Error(r.error);
        const data = JSON.parse(r.text); if (!Array.isArray(data)) throw new Error('schema');
        prCache.set(key, { prs: data.map(p => pick(p, ['number', 'state', 'headRefOid', 'mergedAt', 'url'])) });
      } catch { prCache.set(key, { error: r.error ?? 'invalid-json' }); gaps.push({ source: 'gh', path, reason: r.error ?? 'invalid-json' }); }
    }
    const cached = prCache.get(key);
    if (cached.error) g.errors.push({ command: 'gh pr list', code: cached.error }); else { g.prs = cached.prs.map(p => ({ ...p, headMatches: p.headRefOid === g.head })); g.prCheck = g.prs.some(p => p.state === 'OPEN') ? 'present' : 'confirmed_none'; }
  }
  if (g.errors.length) gaps.push({ source: 'git', path, reason: 'command failures', commands: g.errors });
  return g;
}
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
export function supervisorReferences(body) {
  const agentIds = [...new Set(body.match(uuidPattern) ?? [])];
  const workspaceMatches = [...body.matchAll(/\bwks_[A-Za-z0-9_-]+\b/g)];
  const workspaceIds = [...new Set(workspaceMatches.map(match => match[0]))];
  const matches = [...body.matchAll(/\/[^\s`<>"'()[\]\]|,;]*\bworktrees(?:\/[^\s`<>"'()[\]\]|,;]+)?/g)];
  const safeMatches = matches.filter(match => !/[~$\w}:]/.test(body[match.index - 1] ?? ''));
  const paths = [...new Set(safeMatches.map(match => canonical(match[0])))];
  const pathMarkers = [...body.matchAll(/\bworktrees\b/g)];
  const unresolvedEnvironmentPath = /(?:\$\{?PASEO_HOME\}?|~)[^\s`<>]*\/worktrees(?:\/|\b)/.test(body);
  const scopeComplete = !unresolvedEnvironmentPath && pathMarkers.length === matches.length && safeMatches.length === matches.length && (body.match(/\bwks_/g) ?? []).length === workspaceMatches.length;
  return { agentIds, workspaceIds, paths, scopeComplete };
}
export function collectSupervisors(stateHome, gaps, dirsWithoutTasks = []) {
  const root = join(stateHome, 'yw-supervisor'), records = [];
  if (!existsSync(root)) { gaps.push({ source: root, reason: 'not found' }); return records; }
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(root, dir.name, 'tasks.md');
    try { lstatSync(file); }
    catch (e) {
      if (e.code === 'ENOENT') dirsWithoutTasks.push(dir.name);
      else gaps.push({ source: file, reason: e.code ?? 'stat-error' });
      continue;
    }
    try {
      const body = readFileSync(file, 'utf8');
      const headers = body.split('\n').slice(0, 100).filter(line => /(?:현재\s*소유\s*감독|소유\s*감독|감독자?|owner|supervisor)\s*[:：]/i.test(line));
      const record = { directory: dir.name, chief: dir.name.includes('-chief'), ownerIds: [...new Set(headers.flatMap(line => line.match(uuidPattern) ?? []))], mtime: statSync(file).mtime.toISOString(), ...supervisorReferences(body) };
      records.push(record);
      if (!record.ownerIds.length) {
        const gap = { domain: 'protection', source: file, reason: 'supervisor_owner_unknown' };
        if (record.scopeComplete) gap.scope = { agentIds: record.agentIds, workspaceIds: record.workspaceIds, paths: record.paths };
        else gap.scopeIncomplete = true;
        gaps.push(gap);
      }
    } catch (e) { gaps.push({ source: file, reason: e.code ?? 'read-error' }); }
  }
  return records;
}
export async function extractTranscript(file, provider, rootKind = 'provider-home') {
  let user = null, assistant = null, malformed = 0, pairUncertain = false;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (row.type === 'turn_aborted' || row.payload?.type === 'turn_aborted') { if (user) pairUncertain = true; continue; }
    let role, content, time = row.timestamp ?? null;
    if (provider === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isMeta) { role = row.message?.role; content = row.message?.content; }
    if (provider === 'codex' && row.type === 'response_item' && row.payload?.type === 'message') { role = row.payload.role; content = row.payload.content; }
    if (!['user', 'assistant'].includes(role)) continue;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text ?? '').join('\n') : '';
    const agentMessage = /^\s*<paseo-system\b[^>]*\bkind\s*=\s*["']agent-message["'][^>]*>/i.test(text);
    if (role === 'user' && !agentMessage && /^\s*<(?:paseo-system|turn_aborted)\b/.test(text)) { if (user) pairUncertain = true; continue; }
    if (!text.trim() || (role === 'user' && /^\s*<(?:environment_context|permissions instructions|INSTRUCTIONS)/.test(text))) continue;
    const value = { text, timestamp: typeof time === 'string' ? time : null, truncated: text.length > 600 };
    if (role === 'user') { user = value; assistant = null; pairUncertain = false; }
    else if (user) {
      if (value.timestamp && user.timestamp && Date.parse(value.timestamp) < Date.parse(user.timestamp)) pairUncertain = true;
      else assistant = value;
    }
  }
  return { source: `${provider}:${rootKind}`, user, assistant, malformedLines: malformed, pairUncertain: pairUncertain || !user || !assistant || malformed > 0, reason: user || assistant ? null : 'unsupported or empty transcript' };
}
export async function addExcerpts(snapshot, sessionIds, home, paseoHome, selectedIds) {
  if (!(selectedIds instanceof Set)) { snapshot.meta.gaps.push({ source: 'excerpt', reason: 'excerpt_ids_required' }); return; }
  if (!snapshot.agents.some(a => selectedIds.has(a.id))) return;
  const roots = [{ path: join(home, '.claude/projects'), provider: 'claude', kind: 'provider-home' }, { path: join(home, '.codex/sessions'), provider: 'codex', kind: 'provider-home' }];
  const zero = join(paseoHome, 'zerosub/homes');
  if (existsSync(zero)) for (const d of readdirSync(zero, { withFileTypes: true })) if (d.isDirectory()) {
    for (const suffix of ['projects', '.claude/projects']) roots.push({ path: join(zero, d.name, suffix), provider: 'claude', kind: 'zerosub-home' });
    for (const suffix of ['sessions', '.codex/sessions']) roots.push({ path: join(zero, d.name, suffix), provider: 'codex', kind: 'zerosub-home' });
  }
  const index = new Map();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    try { for (const relative of globSync('**/*.jsonl', { cwd: root.path })) {
      const name = basename(relative), ids = name.match(uuidPattern) ?? [];
      for (const id of ids) { const key = `${root.provider}:${id}`; if (!index.has(key)) index.set(key, []); index.get(key).push({ file: canonical(join(root.path, relative)), kind: root.kind }); }
    } } catch (e) { snapshot.meta.gaps.push({ source: 'excerpt', reason: e.code ?? 'transcript-discovery' }); }
  }
  for (const r of snapshot.classification.agents) {
    const a = snapshot.agents.find(a => a.id === r.id);
    if (!selectedIds.has(a.id)) continue;
    const files = [...new Map((index.get(`${a.provider}:${sessionIds.get(a.id)}`) ?? []).map(entry => [entry.file, entry])).values()];
    a.excerpt = null;
    if (files.length !== 1) { a.excerptReason = files.length ? 'ambiguous transcript paths' : 'transcript not found'; snapshot.meta.gaps.push({ source: 'excerpt', agentId: a.id, reason: a.excerptReason }); continue; }
    try { const excerpt = await extractTranscript(files[0].file, a.provider, files[0].kind); if (excerpt.user || excerpt.assistant) { a.excerpt = excerpt; if (excerpt.pairUncertain) snapshot.meta.gaps.push({ source: 'excerpt', agentId: a.id, reason: 'excerpt_pair_uncertain' }); if (excerpt.user?.truncated || excerpt.assistant?.truncated) snapshot.meta.gaps.push({ source: 'excerpt', agentId: a.id, reason: 'excerpt truncated' }); } else { a.excerptReason = excerpt.reason; snapshot.meta.gaps.push({ source: 'excerpt', agentId: a.id, reason: 'excerpt_pair_uncertain' }); } }
    catch (e) { a.excerptReason = e.code ?? 'transcript-read-error'; snapshot.meta.gaps.push({ source: 'excerpt', agentId: a.id, reason: a.excerptReason }); }
  }
}
export function normalizeTerminals(input, gaps = []) {
  if (input === undefined) return [];
  const invalid = cwd => ({ cwd, state: 'unchecked', invalid: true, terminalCount: null, terminalCwds: [] });
  if (isRecord(input) && input.scope === 'all') {
    const observedAt = input.observedAt ?? input.collectedAt;
    if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)) || !Array.isArray(input.terminals) || input.terminals.some(t => !isRecord(t) || typeof t.cwd !== 'string' || !t.cwd.startsWith('/') || t.cwd.includes('\0'))) {
      gaps.push({ domain: 'terminals', source: 'terminals', reason: 'invalid all-scope terminal observation' });
      return [invalid(null)];
    }
    return [{ scope: 'all', observedAt, cwd: null, state: 'confirmed_none', terminalCount: input.terminals.length, terminalCwds: input.terminals.map(t => canonical(t.cwd)) }];
  }
  if (isRecord(input) && input.scope !== undefined && input.scope !== 'cwd') {
    gaps.push({ domain: 'terminals', source: 'terminals', reason: 'unknown terminal scope' });
    return [invalid(null)];
  }
  if (!isRecord(input) || !Array.isArray(input.observations)) {
    gaps.push({ domain: 'terminals', source: 'terminals', reason: 'expected observations array' });
    return [invalid(null)];
  }
  const observations = [];
  for (const item of input.observations) {
    const cwdValid = isRecord(item) && typeof item.cwd === 'string' && item.cwd.startsWith('/') && !item.cwd.includes('\0');
    if (!cwdValid || !Array.isArray(item.terminals) || item.terminals.some(t => !isRecord(t) || (t.cwd !== undefined && (typeof t.cwd !== 'string' || !t.cwd.startsWith('/') || t.cwd.includes('\0'))))) {
      const cwd = cwdValid ? canonical(item.cwd) : null;
      const gap = { domain: 'terminals', source: 'terminals', reason: 'invalid terminal observation' };
      if (cwd) gap.scope = { paths: [cwd] };
      gaps.push(gap); observations.push(invalid(cwd));
      continue;
    }
    observations.push({ cwd: canonical(item.cwd), state: item.terminals.length ? 'present' : 'confirmed_none', terminalCount: item.terminals.length, terminalCwds: item.terminals.map(t => canonical(t.cwd ?? item.cwd)) });
  }
  return observations;
}
export function observePath(path, git, observations, gaps) {
  let terminals = 'unchecked';
  if (observations.some(o => o.invalid && (!o.cwd || withinPath(path, o.cwd) || withinPath(o.cwd, path)))) terminals = 'unchecked';
  else if (observations.some(o => o.terminalCwds.some(cwd => withinPath(cwd, path)))) terminals = 'present';
  else if (observations.some(o => o.scope === 'all')) terminals = 'confirmed_none';
  else if (observations.some(o => o.cwd === path && o.state === 'confirmed_none')) terminals = 'confirmed_none';
  const definitions = { scripts: [], teardown: false }, file = join(path, 'paseo.json');
  let teardown = 'confirmed_none';
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('schema');
    if (raw.scripts !== undefined && (!raw.scripts || typeof raw.scripts !== 'object' || Array.isArray(raw.scripts))) throw new Error('schema');
    definitions.scripts = Object.keys(raw.scripts ?? {});
    const value = raw.worktree?.teardown;
    definitions.teardown = Array.isArray(value) ? value.length > 0 : Boolean(value);
    teardown = definitions.teardown ? 'present' : 'confirmed_none';
  } catch (error) {
    if (error.code !== 'ENOENT') {
      teardown = 'unchecked'; definitions.teardown = null;
      gaps.push({ domain: 'protection', source: file, reason: 'paseo_definition_unreadable', scope: { paths: [path] } });
    }
  }
  return { checks: { terminals, prs: git?.prCheck ?? 'unchecked', processes: 'unchecked', scripts: 'unchecked', teardown }, definitions };
}
const withinPath = (path, root) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
export function planMarkdown(snapshot) {
  const summary = serializeSnapshot(scanSummary(snapshot));
  snapshot = serializeSnapshot(snapshot);
  const rows = [], counts = {};
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  for (const verdict of ['batch_candidate', 'review', 'exclude']) {
    rows.push(`## ${verdict}`, '', '| 유형 | 전체 ID / 경로 | 제목 | workspace | 나이(h) | 근거 |', '|---|---|---|---|---:|---|');
    for (const [kind, list] of Object.entries(snapshot.classification)) for (const r of list) {
      counts[kind] ??= {}; counts[kind][verdict] ??= 0;
      if (r.verdict !== verdict) continue; counts[kind][verdict]++;
      const entity = kind === 'agents' ? snapshot.agents.find(a => a.id === r.id) : kind === 'workspaces' ? snapshot.workspaces.find(w => w.workspaceId === r.id) : snapshot.orphans.find(o => o.path === r.id);
      const reasons = [...r.reasons, ...(kind === 'orphans' ? ['관측한 시각 기준; 마지막 작업 시각의 증명 아님'] : []), `remainingChecks:${(r.remainingChecks ?? []).join(',')}`,  `holds:${r.hold.join(',')}`, ...(entity?.git?.ignoredCount ? [`ignored:${entity.git.ignoredCount} ${entity.git.ignoredPaths.join(', ')}`] : [])];
      rows.push(`| ${kind} | ${cell(r.id)} | ${cell((entity?.title ?? entity?.displayName ?? '').slice(0, 60))} | ${cell(entity?.workspaceId)} | ${r.ageHours?.toFixed(1) ?? '?'} | ${cell(reasons.join('; '))} |`);
    }
    rows.push('');
  }
  return `# Paseo cleanup plan draft\n\nCollected: ${snapshot.meta.collectedAt}\n\n입력별 관측 시각 및 출처: ${cell(JSON.stringify(snapshot.meta.inputObservations ?? {}))}\n\nThis draft is not approval. Gaps: ${snapshot.meta.gaps.length}. Git refs are local observations.\n\nLive 관측: ${summary.live.observed}/${summary.live.activeTotal} 비보관 agent; 저장값 대체 ${summary.live.storedFallback}.\n\n터미널 관측(고유 cwd): ${summary.terminals.confirmed_none + summary.terminals.present}/${summary.terminals.total}; confirmed_none=${summary.terminals.confirmed_none}, present=${summary.terminals.present}, unchecked=${summary.terminals.unchecked}.\n\n전역 차단 gap(사유별 건수): ${JSON.stringify(summary.globalBlockers)}.\n\nCounts: ${JSON.stringify(counts)}\n\n${rows.join('\n')}\n`;
}
export async function collect(options) {
  const home = homedir(), paseoHome = resolve(options.paseoHome ?? process.env.PASEO_HOME ?? join(home, '.paseo'));
  const stateHome = options.stateHome ?? process.env.XDG_STATE_HOME ?? join(home, '.local/state'), gaps = [], sessionIds = new Map();
  const collectedAt = new Date().toISOString();
  const snapshot = { meta: { paseoHome, serverId: null, paseoVersion: null, collectedAt, options: pick({ maxInputAgeMinutes: 30, ...options }, ['minAgeHours', 'maxInputAgeMinutes', 'gh', 'excerpts', 'excerptIds', 'selfAgentId', 'selfCwd', 'live', 'pending', 'terminals']), gaps, warnings: [], inputObservations: {}, statusSource: options.live ? 'mixed' : 'store', liveCoverage: 0 }, agents: [], workspaces: [], projects: [], schedules: [], subscriptions: [], supervisors: [], orphans: [] };
  const read = (file, domain) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { gaps.push({ source: file, ...(domain ? { domain } : {}), reason: e.code ?? 'invalid-json' }); return jsonReadFailed; } };
  const array = (file, required) => { const value = read(file); if (!Array.isArray(value)) { if (value !== jsonReadFailed) gaps.push({ source: file, reason: 'expected-array' }); return []; } return value.filter((v, i) => { const ok = isRecord(v) && required.every(k => typeof v[k] === 'string'); if (!ok) gaps.push({ source: file, reason: `invalid record:${i}` }); return ok; }); };
  try { snapshot.meta.serverId = readFileSync(join(paseoHome, 'server-id'), 'utf8').trim(); } catch (e) { gaps.push({ source: 'server-id', reason: e.code }); }
  const version = readPaseoVersion(paseoHome, options.paseoInfoPlist);
  snapshot.meta.paseoVersion = version.version; snapshot.meta.paseoVersionSource = version.source;
  if (!version.version) gaps.push({ domain: 'protection', source: 'paseo-version', reason: 'paseo_version_unknown' });
  const observationInput = kind => {
    const input = options[kind] ? read(options[kind], kind === 'terminals' ? 'terminals' : undefined) : undefined;
    const metadata = validateObservation(kind, input, snapshot.meta.serverId, collectedAt, options.maxInputAgeMinutes ?? 30);
    snapshot.meta.inputObservations[kind] = metadata;
    for (const reason of metadata.issues) gaps.push({ domain: kind === 'terminals' ? 'terminals' : 'protection', source: kind, reason });
    return { input, trusted: metadata.state === 'confirmed' };
  };
  const agentRoot = join(paseoHome, 'agents');
  if (!existsSync(agentRoot)) gaps.push({ source: agentRoot, reason: 'agent_store_missing' });
  let agentFiles = []; try { agentFiles = globSync('*/*.json', { cwd: agentRoot }); } catch (e) { gaps.push({ source: agentRoot, reason: e.code }); }
  const liveInput = observationInput('live');
  let live = isRecord(liveInput.input) && ['serverId', 'observedAt', 'scope', 'agents'].some(k => Object.hasOwn(liveInput.input, k)) ? liveInput.input.agents : liveInput.input;
  const liveMapUsable = liveInput.trusted && isRecord(live);
  if (!isRecord(live)) { gaps.push({ source: options.live, reason: 'expected agent status map' }); live = {}; }
  if (!liveMapUsable) live = {};
  const pending = new Map();
  const pendingInput = observationInput('pending');
  if (options.pending) {
    const input = pendingInput.input, list = Array.isArray(input) ? input : input?.permissions;
    if (!Array.isArray(list)) gaps.push({ source: options.pending, reason: 'expected array or permissions array' });
    else if (pendingInput.trusted) for (const entry of list) { if (typeof entry?.agentId === 'string') pending.set(entry.agentId, (pending.get(entry.agentId) ?? 0) + 1); else gaps.push({ source: options.pending, reason: 'pending missing agentId' }); }
  } else gaps.push({ source: 'pending', reason: 'live pending observation not provided' });
  for (const relative of agentFiles) {
    const file = join(agentRoot, relative), raw = read(file);
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.cwd !== 'string' || (raw.labels != null && (typeof raw.labels !== 'object' || Array.isArray(raw.labels)))) { if (raw !== jsonReadFailed) gaps.push({ source: file, reason: 'invalid agent schema' }); continue; }
    const a = sanitizeAgent(raw); a.cwd = canonical(a.cwd); a.statusSource = 'store'; a.status = a.lastStatus;
    const state = live[a.id];
    if (state) {
      if (['initializing', 'running', 'idle', 'closed', 'error'].includes(state.status) && (state.pendingPermissions === undefined || Array.isArray(state.pendingPermissions))) { a.status = state.status; a.statusSource = 'live'; snapshot.meta.liveCoverage++; }
      else gaps.push({ source: options.live, reason: `invalid live record:${a.id}`, scope: { agentIds: [a.id] } });
    }
    a.pendingCount = Math.max(pending.get(a.id) ?? 0, Array.isArray(state?.pendingPermissions) ? state.pendingPermissions.length : 0);
    if (typeof raw.persistence?.sessionId === 'string') sessionIds.set(a.id, raw.persistence.sessionId);
    snapshot.agents.push(a);
  }
  const missingLive = snapshot.agents.filter(a => !a.archivedAt && a.statusSource !== 'live').map(a => a.id);
  if (missingLive.length) gaps.push({ domain: 'protection', source: 'live', reason: 'live_missing', count: missingLive.length, ...(liveMapUsable ? { scope: { agentIds: missingLive } } : {}) });
  if (!options.live) gaps.push({ source: 'live', reason: 'stored statuses can lag; live observation not provided' });
  const wfile = join(paseoHome, 'projects/workspaces.json');
  snapshot.workspaces = array(wfile, ['workspaceId', 'cwd']).map(w => {
    const invalidOwnership = (w.isPaseoOwnedWorktree !== undefined && typeof w.isPaseoOwnedWorktree !== 'boolean') || ['worktreeRoot', 'mainRepoRoot'].some(k => w[k] != null && (typeof w[k] !== 'string' || (w[k] && !w[k].startsWith('/'))));
    if (invalidOwnership) gaps.push({ domain: 'protection', source: wfile, reason: 'invalid workspace ownership schema', scope: { workspaceIds: [w.workspaceId], paths: [canonical(w.cwd)] } });
    return { ...pick(w, ['workspaceId', 'projectId', 'cwd', 'kind', 'displayName', 'title', 'branch', 'worktreeRoot', 'mainRepoRoot', 'createdAt', 'updatedAt', 'archivedAt', 'isPaseoOwnedWorktree']), cwd: canonical(w.cwd), ...Object.fromEntries(['worktreeRoot', 'mainRepoRoot'].filter(k => typeof w[k] === 'string' && w[k]).map(k => [k, canonical(w[k])])) };
  });
  snapshot.projects = array(join(paseoHome, 'projects/projects.json'), ['projectId', 'rootPath']).map(p => pick(p, ['projectId', 'rootPath', 'kind', 'displayName', 'archivedAt']));
  snapshot.subscriptions = array(join(paseoHome, 'finish-subscriptions.json'), ['callerAgentId', 'childAgentId']).map(s => pick(s, ['callerAgentId', 'childAgentId']));
  const scheduleRoot = join(paseoHome, 'schedules');
  if (!existsSync(scheduleRoot)) gaps.push({ source: scheduleRoot, reason: 'schedule_store_missing' });
  let schedules = []; try { schedules = globSync('*.json', { cwd: scheduleRoot }); } catch (e) { gaps.push({ source: scheduleRoot, reason: e.code }); }
  for (const relative of schedules) {
    const file = join(scheduleRoot, relative), raw = read(file);
    if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.target) || !['agent', 'new-agent'].includes(raw.target.type)) { if (raw !== jsonReadFailed) gaps.push({ source: file, reason: 'invalid schedule schema' }); continue; }
    const s = pick(raw, ['id', 'status', 'pausedAt', 'expiresAt', 'nextRunAt']); s.target = pick(raw.target, ['type', 'agentId']);
    const cwd = raw.target.type === 'new-agent' ? raw.target.cwd ?? raw.target.config?.cwd ?? raw.cwd : null;
    if (typeof cwd === 'string') s.cwd = canonical(cwd);
    if ((s.target.type === 'agent' && !s.target.agentId) || (s.target.type === 'new-agent' && !s.cwd)) gaps.push({ source: file, reason: 'schedule target incomplete' });
    snapshot.schedules.push(s);
  }
  snapshot.meta.supervisorDirsWithoutTasks = [];
  snapshot.supervisors = collectSupervisors(stateHome, gaps, snapshot.meta.supervisorDirsWithoutTasks);
  const context = protectionContext(snapshot);
  snapshot.supervisors = context.supervisors;
  gaps.push(...context.generatedGaps);
  const paths = new Map(), prCache = new Map();
  for (const w of snapshot.workspaces) if (!w.archivedAt) { paths.set(w.cwd, null); if (isOwnedWorkspace(w)) paths.set(w.worktreeRoot, null); }
  const treeRoot = join(paseoHome, 'worktrees');
  try { for (const group of readdirSync(treeRoot, { withFileTypes: true })) if (group.isDirectory()) for (const entry of readdirSync(join(treeRoot, group.name), { withFileTypes: true })) if (entry.isDirectory()) paths.set(canonical(join(treeRoot, group.name, entry.name)), null); }
  catch (e) { gaps.push({ source: treeRoot, reason: e.code }); }
  for (const path of paths.keys()) paths.set(path, inspectGit(path, options, gaps, prCache));
  const terminalInput = observationInput('terminals');
  const observations = terminalInput.trusted ? normalizeTerminals(terminalInput.input, gaps) : [{ cwd: null, state: 'unchecked', invalid: true, terminalCount: null, terminalCwds: [] }];
  snapshot.terminalObservations = observations;
  for (const w of snapshot.workspaces) if (!w.archivedAt) {
    w.git = paths.get(isOwnedWorkspace(w) ? w.worktreeRoot : w.cwd);
    Object.assign(w, observePath(isOwnedWorkspace(w) ? w.worktreeRoot : w.cwd, w.git, observations, gaps));
  }
  const active = new Set(snapshot.workspaces.filter(w => !w.archivedAt).flatMap(w => [w.cwd, ...(isOwnedWorkspace(w) ? [w.worktreeRoot] : [])]));
  for (const [path, git] of paths) if (!active.has(path)) {
    let mtime = null; try { mtime = statSync(path).mtime.toISOString(); } catch (e) { gaps.push({ source: path, reason: e.code }); }
    snapshot.orphans.push({ path, mtime, observedTimesMax: git.modifiedAt ?? null, timeBasis: 'maximum of observed root, HEAD commit, git index and HEAD timestamps; not proof of last work', git, ...observePath(path, git, observations, gaps) });
  }
  snapshot.meta.statusSource = snapshot.meta.liveCoverage === 0 ? 'store' : snapshot.meta.liveCoverage === snapshot.agents.length ? 'live' : 'mixed';
  snapshot.classification = classify(snapshot, { ...options, now: collectedAt, selfCwd: options.selfCwd ? canonical(options.selfCwd) : undefined });
  if (options.excerpts || options.excerptIds) {
    let selected = null;
    if (options.excerptIds) {
      selected = new Set();
      const ids = read(options.excerptIds);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) gaps.push({ source: 'excerpt', reason: 'excerpt_ids_invalid' });
      else for (const id of ids) { selected.add(id); if (!snapshot.agents.some(a => a.id === id)) gaps.push({ source: 'excerpt', agentId: id, reason: 'excerpt_agent_not_found' }); }
    } else gaps.push({ source: 'excerpt', reason: 'excerpt_ids_required' });
    snapshot.meta.excerptSelection = { mode: selected ? 'selected_ids' : 'blocked_missing_ids', count: selected?.size ?? 0 };
    if (selected) await addExcerpts(snapshot, sessionIds, home, paseoHome, selected);
  }
  nativeIdsBySnapshot.set(snapshot, new Set(sessionIds.values()));
  snapshot.classification = classify(snapshot, { ...options, now: collectedAt, selfCwd: options.selfCwd ? canonical(options.selfCwd) : undefined });
  return snapshot;
}
export function writeOutputs(out, snapshot) {
  out = resolve(out);
  if (existsSync(out) && (lstatSync(out).isSymbolicLink() || !statSync(out).isDirectory())) throw new Error('Output must be a directory, not a link');
  for (const name of ['scan.json', 'plan-draft.md']) if (existsSync(join(out, name))) throw new Error('Output already exists; use a fresh directory');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  writeFileSync(join(out, 'scan.json'), `${JSON.stringify(serializeSnapshot(snapshot), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(out, 'plan-draft.md'), planMarkdown(snapshot), { mode: 0o600, flag: 'wx' });
}
async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scan.mjs [--out DIR] [--paseo-home DIR] [--self-agent ID] [--self-cwd PATH] [--min-age-hours 72] [--max-input-age-minutes 30] [--gh] [--excerpts] [--excerpt-ids FILE] [--live FILE] [--pending FILE] [--terminals FILE]
Every observation requires serverId matching the local server-id, observedAt (ISO 8601 with Z or an explicit UTC offset), and scope. Inputs older than --max-input-age-minutes (default 30), over one minute in the future, or missing metadata are unchecked. Legacy payloads are accepted as unchecked; live/pending uncertainty blocks all batch candidates.
--live: {"serverId":"srv_example","observedAt":"2026-01-01T00:00:00Z","scope":"listed_agents","agents":{"full-agent-id":{"status":"idle","pendingPermissions":[]}}} (scope all is also accepted; missing agents remain scoped unknown)
--pending: {"serverId":"srv_example","observedAt":"2026-01-01T00:00:00Z","scope":"all","permissions":[{"agentId":"full-agent-id","kind":"question"}]}
--terminals (all cwd): {"serverId":"srv_example","observedAt":"2026-01-01T00:00:00Z","scope":"all","terminals":[{"cwd":"/absolute/path"}]} (absent cwd confirmed_none; terminal cwd inside target path present)
--terminals (per cwd): {"serverId":"srv_example","observedAt":"2026-01-01T00:00:00Z","scope":"cwd","observations":[{"cwd":"/absolute/path","terminals":[]}]} (unobserved cwd unchecked)
--excerpt-ids: ["11111111-1111-4111-8111-111111111111"] (JSON full agent IDs; implies --excerpts and reads only those agents, including historical records; invalid list reads none)
--excerpts requires --excerpt-ids; without a selection the CLI exits with an error and reads no transcript bodies.
Classification uses original canonical paths/IDs. Output free text is redacted; secret-like structural values are replaced with [STRUCT_SHA256:...] only after classification.
Only pending counts are retained. No daemon calls. Outputs: scan.json, plan-draft.md; meta.inputObservations separates input observedAt from scan collectedAt. Existing outputs are never overwritten.`); return;
  }
  const out = resolve(options.out ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'yw-paseo-cleanup', new Date().toISOString().replaceAll(':', '-')));
  const snapshot = await collect(options);
  writeOutputs(out, snapshot);
  const counts = Object.fromEntries(Object.entries(snapshot.classification).map(([kind, list]) => [kind, list.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {})]));
  console.log(JSON.stringify(serializeSnapshot({ out, counts, gaps: snapshot.meta.gaps.length })));
}
if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
