import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import { PROJECTION, receiptFold, routeKey, rankingSchema, validateDifficulty, difficultyIndex, highestReasoningEffort } from './contracts.js';

export class CollabError extends Error {
  constructor(code, message) { super(message); this.name = 'CollabError'; this.code = code; }
}
const fail = (code, message) => { throw new CollabError(code, message); };
const clone = value => structuredClone(value);
const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  : Array.isArray(value) ? value.map(canonical) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const text = (value, field, max = 16000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT', `${field} must contain 1–${max} characters`);
  return value;
};
const keyOf = (from, kind, key) => `collab-${kind}-${hash([from, text(key, 'request_id', 160)]).slice(0, 40)}`;
const nameKey = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
/** Newest delivery records kept for idempotency, reply routing and rate limits. */
const MAX_REQUESTS = 2000;
/** Records younger than this are never pruned, so rate limiting and idempotency stay exact. */
const REQUEST_RETENTION_MS = 60000;
/** Cold Session logs read at the same time. One workspace log reaches tens of MB. */
const MAX_LOG_READS = 2;
/** Cold Session logs read per page, so one inbox page cannot turn into a hundred reads. */
const MAX_LOG_READS_PER_CALL = 4;
/** How long a negative acceptance result is trusted before the log is read again. */
const EVIDENCE_TTL_MS = 60000;

/** Counting semaphore that hands its slot straight to the next waiter. */
class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active >= this.limit) await new Promise(resolve => this.waiters.push(resolve));
    else this.active += 1;
  }
  release() {
    const next = this.waiters.shift();
    if (next) next(); else this.active -= 1;
  }
}
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
};

/** Autonomous peer coordination. The UI owns only model ordering; Agent tools own all messaging. */
export class Collaboration {
  constructor(ctx, domain, options = {}) {
    this.ctx = ctx; this.domain = domain; this.requests = domain.table('requests');
    this.locks = new Map(); this.inflight = new Set(); this.handles = new Map(); this.stopping = false;
    this.createdLimit = options.createdLimit ?? 24; this.perMinute = options.perMinute ?? 40;
    this.catalogCache = null;
    this.shutdown = new AbortController();
    // Acceptance evidence for a closed target lives in that Session's log, and
    // one workspace log reaches tens of MB, so the reads are bounded, grouped
    // by target, and remembered instead of repeated for every call.
    this.evidence = new Map(); this.evidenceCursor = 0; this.logReads = new Semaphore(MAX_LOG_READS);
  }
  async run(fn) {
    if (this.stopping) fail('STOPPED', 'Session collaboration is stopping');
    const work = Promise.resolve().then(() => {
      if (this.stopping) fail('STOPPED', 'Session collaboration is stopping');
      return fn();
    });
    this.inflight.add(work);
    try { return await work; } finally { this.inflight.delete(work); }
  }
  async serial(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(fn); this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
  archived(id) { return (this.ctx.workspaceRegistry.archivedSessionIds ?? []).includes(id); }
  ordinary(agent) { return !!agent && agent.session.header.origin !== 'subagent'; }
  assertLive(agent) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) fail('STALE_SESSION', 'The Session is no longer live; discover running or idle peers again');
    if (!this.ordinary(agent)) fail('NOT_INDEPENDENT', 'Use the existing Subagent tools for parent/child Agents');
    if (this.archived(agent.id)) fail('ARCHIVED', 'Archived Sessions do not participate in autonomous collaboration');
    return agent;
  }
  // A persisted subagent has the same Session surface as an independent peer.
  // Check its header before resolveAgent() so a closed-target resume cannot wake
  // a child that still belongs to the native parent/child router.
  async assertIndependentTarget(sessionId) {
    const live = this.ctx.agents.get(sessionId);
    if (live) return this.assertLive(live);
    if (!this.ctx.sessionQuery || typeof this.ctx.sessionQuery.listSessions !== 'function') return undefined;
    let records;
    try { records = await this.ctx.sessionQuery.listSessions(); } catch { return undefined; }
    const record = records.find(item => item?.header?.id === sessionId);
    if (record?.header?.origin === 'subagent') fail('NOT_INDEPENDENT', 'Use the existing Subagent tools for parent/child Agents');
    return undefined;
  }
  livePeers() { return this.ctx.agents.list().filter(a => this.ordinary(a) && !this.archived(a.id)); }
  settings() { return clone(this.domain.global.get()); }
  ranking() {
    const s = this.settings();
    if (s.version !== 2) fail('NOT_READY', 'The model ladder is still initializing');
    return { active: s.active, inactive: s.inactive, revision: s.revision };
  }
  async catalog(force = false) {
    const providers = this.ctx.llm.listProviders();
    const providerSignature = providers.map(p => p.id).sort().join('\n');
    if (!force && this.catalogCache && this.catalogCache.providerSignature === providerSignature && this.catalogCache.expires > Date.now()) return clone(this.catalogCache.rows);
    const rows = [], failures = [];
    for (const provider of providers) {
      try {
        for (const model of await this.ctx.llm.listModels(provider.id)) {
          rows.push({ provider: provider.id, model: model.id, name: model.name || model.id, providerName: provider.name, available: true });
        }
      } catch (error) { failures.push({ provider: provider.id, error: String(error) }); }
    }
    const unique = [...new Map(rows.map(r => [routeKey(r), r])).values()];
    this.catalogCache = { rows: unique, failures, providerSignature, expires: Date.now() + 30000 };
    return clone(unique);
  }
  async initialModels() {
    const catalog = await this.catalog();
    await this.serial('ranking', async () => {
      const old = this.settings();
      if (old.version === 1) {
        const initial = old.modelsConfigured ? old.allowedModels : catalog.map(({ provider, model }) => ({ provider, model }));
        const active = [...new Map(initial.map(r => [routeKey(r), r])).values()];
        const activeKeys = new Set(active.map(routeKey));
        await this.domain.global.set({ version: 2, active, inactive: catalog.filter(r => !activeKeys.has(routeKey(r))).map(({ provider, model }) => ({ provider, model })), revision: 1 });
      } else if (old.revision === 0 && !old.active.length && !old.inactive.length) {
        await this.domain.global.set({ version: 2, active: catalog.map(({ provider, model }) => ({ provider, model })), inactive: [], revision: 1 });
      }
    });
    return this.syncModels(catalog);
  }
  async syncModels(catalog) {
    const rows = catalog ?? await this.catalog();
    return this.serial('ranking', async () => {
      const current = this.ranking();
      const advertised = new Set(rows.map(routeKey));
      const providers = new Set(this.ctx.llm.listProviders().map(p => p.id));
      const failed = new Set((this.catalogCache?.failures ?? []).map(f => f.provider));
      // Only the current DSH catalog is a source of selectable routes. Old settings are not another provider directory.
      // A failed listing is not an authoritative removal: preserve those entries until that provider can be queried.
      const keep = r => advertised.has(routeKey(r)) || (providers.has(r.provider) && failed.has(r.provider));
      const active = current.active.filter(keep), inactive = current.inactive.filter(keep);
      const known = new Set([...active, ...inactive].map(routeKey));
      const fresh = rows.filter(r => !known.has(routeKey(r))).map(({ provider, model }) => ({ provider, model }));
      if (!fresh.length && active.length === current.active.length && inactive.length === current.inactive.length) return current;
      const next = { active, inactive: [...inactive, ...fresh], revision: current.revision + 1 };
      await this.domain.global.set({ version: 2, ...next }); return next;
    });
  }
  /** User-only ordering entry point; no Agent tool can enable, disable, or reorder models. */
  async saveRanking(input) {
    const parsed = rankingSchema.parse(input);
    const catalog = await this.catalog();
    await this.syncModels(catalog);
    return this.serial('ranking', async () => {
      const current = this.ranking();
      if (current.revision !== parsed.revision) fail('REVISION_CONFLICT', 'Model ranking revision conflict. Reload the latest revision and retry your order.');
      const keys = [...parsed.active, ...parsed.inactive].map(routeKey);
      if (new Set(keys).size !== keys.length) fail('DUPLICATE_MODEL', 'A model must appear in exactly one position');
      const existing = new Set([...current.active, ...current.inactive].map(routeKey));
      if (keys.length !== existing.size || keys.some(k => !existing.has(k))) fail('INVALID_RANKING', 'Ranking must preserve all known models; move unused models to the inactive section');
      const next = { active: parsed.active, inactive: parsed.inactive, revision: current.revision + 1 };
      await this.domain.global.set({ version: 2, ...next }); return next;
    });
  }
  async namesFor(ids) {
    const unique = [...new Set(ids.filter(Boolean))], names = new Map();
    const titleService = this.ctx.get('sessionTitle');
    const cold = [];
    for (const id of unique) {
      const session = this.ctx.sessions.get(id);
      const title = session ? titleService?.get(session)?.title : undefined;
      if (title) names.set(id, title); else cold.push(id);
    }
    if (cold.length) {
      try {
        for (const result of await this.ctx.sessionQuery.readTitleSnapshots(cold)) {
          if (result.status === 'fulfilled' && result.value.title?.title) names.set(result.sessionId, result.value.title.title);
        }
      } catch { /* Stored send-time names remain available if a Session cannot be read. */ }
    }
    return names;
  }
  async sessionName(id, fallback = '未命名会话') { return (await this.namesFor([id])).get(id) || fallback; }
  /** Wake a persisted but closed Session through the public Session Controller, then re-read the live Agent. */
  async resume(sessionId) {
    if (this.archived(sessionId)) fail('ARCHIVED', 'Archived Sessions do not participate in autonomous collaboration');
    const live = await this.assertIndependentTarget(sessionId);
    if (live) return live;
    const controller = this.ctx.sessionController ?? this.ctx.get?.('sessionController');
    if (!controller || typeof controller.resolveAgent !== 'function') fail('RESUME_UNAVAILABLE', 'This deployment cannot open a closed Session; ask the user to open it first');
    let resolved;
    try { resolved = await controller.resolveAgent(sessionId); }
    catch (error) { fail('RESUME_FAILED', `The closed Session could not be opened: ${error?.message ?? error}`); }
    // The public resolver reports a stable failure object instead of throwing.
    const failure = resolved?.error;
    if (failure) fail('RESUME_FAILED', `The closed Session could not be opened: ${failure.code ?? 'error'}: ${failure.message ?? JSON.stringify(failure)}`);
    const target = this.ctx.agents.get(sessionId);
    if (!target) fail('RESUME_FAILED', 'The closed Session did not become live; it may be open in another DSH instance');
    return target;
  }
  /** Persisted Sessions that are not live, as routing rows. Bounded to recent records. */
  async closedRows() {
    if (!this.ctx.sessionQuery || typeof this.ctx.sessionQuery.listSessions !== 'function') return [];
    const records = await this.ctx.sessionQuery.listSessions();
    const closed = records.filter(record => record.header?.origin !== 'subagent' && !record.live && !this.ctx.agents.get(record.header.id) && !this.archived(record.header.id))
      .sort((left, right) => right.header.createdAt - left.header.createdAt).slice(0, 200);
    if (!closed.length) return [];
    const names = await this.namesFor(closed.map(record => record.header.id));
    const workspaces = this.ctx.workspaceRegistry.list();
    return closed.map(record => {
      const cwd = record.header.cwd ?? '';
      const match = workspaces.find(row => cwd && (nameKey(cwd) === nameKey(row.path) || nameKey(cwd).startsWith(nameKey(row.path) + '\\')));
      return { sessionId: record.header.id, name: names.get(record.header.id) || '未命名会话', workspaceId: match?.id ?? null, workspaceTitle: match?.title ?? '', workspacePath: match?.path ?? '', cwd, status: 'closed' };
    });
  }
  /** Closed Sessions matched by exact title and optional workspace. */
  async closedCandidates(name, workspace) {
    return (await this.closedRows()).filter(row => nameKey(row.name) === nameKey(name) && this.matchesWorkspace(row, workspace));
  }
  /** Closed Sessions matched by exact id, without depending on a readable title. */
  async closedCandidateById(sessionId) {
    return (await this.closedRows()).find(row => row.sessionId === sessionId);
  }
  workspaceRows() { return this.ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path })); }
  routingRows() {
    const titles = this.ctx.get('sessionTitle');
    if (!titles) fail('TITLE_SERVICE_UNAVAILABLE', 'Live Session titles cannot be validated; refuse to guess a recipient');
    const workspaces = this.ctx.workspaceRegistry.list();
    return this.livePeers().map(a => {
      const workspace = workspaces.find(w => w.sessionIds.includes(a.id));
      return { sessionId: a.id, name: titles.get(a.session)?.title || '未命名会话', workspaceId: workspace?.id ?? null, workspaceTitle: workspace?.title ?? '', workspacePath: workspace?.path ?? '', cwd: a.session.header.cwd ?? '', status: a.status === 'running' ? 'running' : 'idle' };
    });
  }
  async sessionRows() { return this.routingRows(); }
  async workspaceSelector(workspace) {
    if (workspace === undefined) return undefined;
    const value = text(workspace, 'workspace', 1000).trim();
    const exact = this.ctx.workspaceRegistry.get(value);
    if (exact) return { id: exact.id };
    if (isAbsolute(value) || win32.isAbsolute(value)) {
      try {
        const resolved = await this.ctx.workspaceRegistry.resolveByPath(value);
        if (!resolved) fail('WORKSPACE_NOT_FOUND', 'The directory is not a registered workspace');
        return { id: resolved.id };
      } catch (error) {
        if (error instanceof CollabError) throw error;
        fail('WORKSPACE_NOT_FOUND', 'The workspace directory cannot be resolved; do not guess from similar names');
      }
    }
    return { title: nameKey(value) };
  }
  matchesWorkspace(row, selector) {
    return !selector || (selector.id !== undefined ? row.workspaceId === selector.id : nameKey(row.workspaceTitle) === selector.title);
  }
  async targetRows(agent) {
    return (await this.sessionRows()).filter(row => row.sessionId !== agent.id);
  }
  annotateNames(rows) {
    const count = new Map();
    for (const row of rows) count.set(nameKey(row.name), (count.get(nameKey(row.name)) ?? 0) + 1);
    return rows.map(row => ({ ...row, sameNameCount: count.get(nameKey(row.name)), needsDisambiguation: count.get(nameKey(row.name)) > 1 }));
  }
  async discover(agent, input = {}) {
    this.assertLive(agent);
    const query = nameKey(input.query), workspace = await this.workspaceSelector(input.workspace);
    const all = this.annotateNames(await this.targetRows(agent));
    let sessions;
    if (input.session_id) {
      // An explicit id is exact: name, query and workspace filters do not apply.
      const id = text(input.session_id, 'session_id', 200);
      sessions = all.filter(row => row.sessionId === id);
      // Closed Sessions are addressable by id too, without needing a readable title.
      if (!sessions.length) { const closed = await this.closedCandidateById(id); if (closed) sessions = [closed]; }
    } else {
      sessions = all.filter(row => (!input.name || nameKey(row.name) === nameKey(input.name))
        && this.matchesWorkspace(row, workspace) && (!query || JSON.stringify(row).toLowerCase().includes(query)));
      // A closed Session is addressable too; listing it here makes name resolution possible before the wake.
      if (input.name && !sessions.length) sessions.push(...(await this.closedCandidates(input.name, workspace ?? undefined)));
    }
    this.assertLive(agent);
    const result = {
      sessions: sessions.slice(0, 80).map(row => ({ sessionId: row.sessionId, name: row.name, ...(row.workspaceTitle ? { workspace: row.workspaceTitle } : {}), ...(row.needsDisambiguation ? { ambiguous: true } : {}) })),
    };
    if (sessions.length > 80) result.truncated = true;
    if (input.include_workspaces) {
      const workspaces = this.workspaceRows(), counts = new Map();
      for (const workspace of workspaces) counts.set(nameKey(workspace.title), (counts.get(nameKey(workspace.title)) ?? 0) + 1);
      result.workspaces = workspaces.map(row => ({ id: row.id, title: row.title, ...(counts.get(nameKey(row.title)) > 1 ? { path: row.path } : {}) }));
    }
    return result;
  }
  async resolveTarget(agent, input, signal) {
    const rows = await this.targetRows(agent);
    let selected, basis, workspace = null;
    if (input.target_session_id) {
      // An explicit Session id is an exact address: no name matching, no ambiguity prompt.
      const id = text(input.target_session_id, 'target_session_id', 200);
      if (id === agent.id) fail('SELF_SEND', 'Use your own context instead of messaging yourself');
      selected = rows.find(row => row.sessionId === id) ?? await this.closedCandidateById(id);
      if (!selected) fail('TARGET_NOT_FOUND', 'No Session matches that Session id');
      basis = 'session-id';
    } else {
      if (!input.target_name) fail('INVALID_TARGET', 'Supply a target name or session id');
      const expectedName = input.target_name;
      workspace = await this.workspaceSelector(input.target_workspace);
      let candidates = rows.filter(row => nameKey(row.name) === nameKey(expectedName) && this.matchesWorkspace(row, workspace));
      if (!candidates.length) candidates = await this.closedCandidates(expectedName, workspace ?? undefined);
      if (!candidates.length) fail('TARGET_NOT_FOUND', 'No Session matches that exact name and workspace');
      if (candidates.length === 1) { selected = candidates[0]; basis = input.target_workspace ? 'workspace' : 'unique-name'; }
      else {
        const questions = this.ctx.get('userQuestions');
        const labels = candidates.map((row, index) => `${index + 1}. ${row.name} · ${row.workspaceTitle || '未归属工作区'} · ${row.cwd || '无目录'} · ${row.sessionId.slice(-8)}`);
        if (!questions) fail('AMBIGUOUS_TARGET', `Several Sessions share this name. Ask the user which one; do not pick the first or broadcast. Candidates: ${labels.join('; ')}`);
        // This is a recipient clarification, not a new authority grant. The human answer is not model-supplied.
        const answer = await questions.ask({
          agent, signal: AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]),
          questions: [{ id: 'collab-target', header: '确认接收会话', question: `找到 ${candidates.length} 个名为“${expectedName}”的会话，你指的是哪一个？`,
            detail: '名称不唯一，尚未发送任何消息。请选择工作区；同工作区重名时，用会话标识尾号区分。',
            options: labels.map((label, index) => ({ label, description: `${candidates[index].status} · ${candidates[index].cwd || '无目录'}` })), multiSelect: false }],
        });
        const item = answer.answers.find(value => value.id === 'collab-target');
        const index = item?.selected.length === 1 ? labels.indexOf(item.selected[0]) : -1;
        if (index < 0) fail('TARGET_NOT_SELECTED', 'No single offered Session was chosen. Do not infer a recipient from free text; clarify again.');
        selected = candidates[index]; basis = 'human-confirmed';
      }
    }
    signal?.throwIfAborted(); this.assertLive(agent);
    let target = this.ctx.agents.get(selected.sessionId);
    if (!target) {
      target = await this.resume(selected.sessionId);
      const live = this.routingRows().find(row => row.sessionId === target.id);
      if (live) selected = live;
      basis = 'resumed-session';
    }
    this.assertLive(target);
    return { target, row: selected, basis, requestedWorkspace: workspace ?? null };
  }
  validateTarget(agent, resolution) {
    this.assertLive(agent); this.assertLive(resolution.target);
    if (['thread', 'created-session'].includes(resolution.basis)) return;
    if (resolution.basis === 'session-id') {
      // The id already pins the recipient; a later rename must not redirect this delivery.
      if (resolution.target.id !== resolution.row.sessionId) fail('TARGET_CHANGED', 'The addressed Session changed before delivery. Nothing has been sent.');
      this.assertLive(agent); this.assertLive(resolution.target);
      return;
    }
    if (resolution.basis === 'resumed-session') {
      // A just-resumed Session may not be registered under a workspace yet, so compare durable identity instead.
      if ((resolution.target.session.header.cwd ?? '') !== (resolution.row.cwd ?? '')) fail('TARGET_CHANGED', 'The reopened Session moved before delivery. Nothing has been sent.');
      this.assertLive(agent); this.assertLive(resolution.target);
      return;
    }
    // No await between this live registry/title snapshot and steer: asynchronous history reads cannot validate routing.
    const rows = this.routingRows().filter(row => row.sessionId !== agent.id), current = rows.find(row => row.sessionId === resolution.target.id);
    if (!current || nameKey(current.name) !== nameKey(resolution.row.name) || current.workspaceId !== resolution.row.workspaceId || current.workspacePath !== resolution.row.workspacePath || current.cwd !== resolution.row.cwd) {
      fail('TARGET_CHANGED', 'The chosen Session was renamed, moved, or closed before delivery. Rediscover; nothing has been sent.');
    }
    if (!this.matchesWorkspace(current, resolution.requestedWorkspace ?? undefined)) fail('TARGET_CHANGED', 'The selected Session no longer belongs to the requested workspace');
    if (['unique-name', 'workspace'].includes(resolution.basis)) {
      const candidates = rows.filter(row => nameKey(row.name) === nameKey(current.name) && this.matchesWorkspace(row, resolution.requestedWorkspace ?? undefined));
      if (candidates.length !== 1 || candidates[0].sessionId !== resolution.target.id) fail('AMBIGUOUS_TARGET', 'Another same-named Session appeared before delivery. Clarify the recipient before retrying.');
    }
    this.assertLive(agent); this.assertLive(resolution.target);
  }
  async models(agent, input = {}) {
    this.assertLive(agent);
    const ranking = await this.syncModels();
    const metadata = new Map((await this.catalog()).map(r => [routeKey(r), r]));
    const active = [];
    for (let rank = 0; rank < ranking.active.length; rank++) {
      const route = ranking.active[rank];
      try {
        const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model);
        const efforts = (info?.reasoning?.efforts ?? []).map(level => level.id);
        active.push({ model: `${route.provider}/${route.model}`, name: info.name || metadata.get(routeKey(route))?.name || route.model, difficulty: rank + 1, ...(input.include_efforts && efforts.length ? { efforts } : {}) });
      } catch {
        active.push({ model: `${route.provider}/${route.model}`, name: metadata.get(routeKey(route))?.name || route.model, difficulty: rank + 1, available: false });
      }
    }
    const result = { models: active };
    if (input.include_presets) {
      const presets = await this.ctx.agentPresets.list();
      result.presets = presets.filter(preset => !preset.broken).map(preset => ({ id: preset.id, ...(preset.name ? { name: preset.name } : {}) }));
    } else {
      result.defaultPreset = (await this.ctx.agentPresets.list()).find(preset => preset.isDefault && !preset.broken)?.id;
    }
    if (input.include_efforts) result.order = 'difficulty asc; 1 = simplest';
    return result;
  }
  async chooseModel(difficulty, signal, effort) {
    validateDifficulty(difficulty);
    const ranking = await this.syncModels();
    if (!ranking.active.length) fail('NO_ACTIVE_MODELS', 'All models are inactive. Ask the user to drag at least one model into the active ladder.');
    if (difficulty > ranking.active.length) {
      fail('INVALID_INPUT', `difficulty must be between 1 and ${ranking.active.length}, the number of active models`);
    }
    return this.selectionFor(ranking.active[difficultyIndex(difficulty, ranking.active.length)], signal, effort);
  }
  /** Select one explicitly named model, but only from the user's active ladder. */
  async chooseNamedModel(model, signal, effort) {
    const wanted = text(model, 'model', 300).trim();
    const ranking = await this.syncModels();
    if (!ranking.active.length) fail('NO_ACTIVE_MODELS', 'All models are inactive. Ask the user to drag at least one model into the active ladder.');
    const routes = ranking.active, metadata = new Map((await this.catalog()).map(row => [routeKey(row), row])), labels = new Map();
    for (const route of routes) {
      let name;
      try { name = (await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal))?.name; } catch { /* Match by id now; an unresolvable model is refused at use time. */ }
      labels.set(routeKey(route), name || metadata.get(routeKey(route))?.name || route.model);
    }
    const aliases = route => [route.model, `${route.provider}/${route.model}`, labels.get(routeKey(route))];
    const exact = routes.filter(route => aliases(route).includes(wanted));
    const matches = [...new Map((exact.length ? exact : routes.filter(route => aliases(route).some(alias => alias.toLowerCase() === wanted.toLowerCase()))).map(route => [routeKey(route), route])).values()];
    if (matches.length > 1) fail('MODEL_AMBIGUOUS', `Several allowed models match "${wanted}". Pass provider/model from collab_models.`);
    if (!matches.length) fail('MODEL_NOT_ALLOWED', `"${wanted}" is not in the active model ladder. Use a model listed by collab_models, or ask the user to enable it.`);
    return this.selectionFor(matches[0], signal, effort);
  }
  async selectionFor(route, signal, effort) {
    if (!this.ctx.llm.listProviders().some(p => p.id === route.provider)) fail('MODEL_UNAVAILABLE', 'The selected model is unavailable; do not silently change the user’s ladder');
    const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal);
    let chosen = effort === undefined ? undefined : text(effort, 'reasoning_effort', 100).trim();
    if (chosen === undefined) chosen = highestReasoningEffort(info);
    else {
      const supported = (info?.reasoning?.efforts ?? []).map(level => level.id);
      if (!supported.includes(chosen)) fail('EFFORT_UNAVAILABLE', `"${chosen}" is not a reasoning effort ${route.provider}/${route.model} supports${supported.length ? `: ${supported.join(', ')}` : ''}. Omit reasoning_effort to use the highest supported level.`);
    }
    const resolved = await this.ctx.llm.resolveCallConfig({ ...route, ...(chosen ? { reasoningEffort: chosen } : {}) }, signal);
    return { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) };
  }
  /** Evidence already known for one record, without reading any Session log. */
  knownEvidence(record) {
    if (record.kind !== 'send') return undefined;
    if (record.evidence) return record.evidence;
    const cached = this.evidence.get(record.id);
    return cached ? cached.evidence ?? undefined : undefined;
  }
  /**
   * Whether one record still needs its target Session log read.
   *
   * A record is settled once its message was admitted into a model step. A
   * message that was only spliced into the inbox is re-checked after a grace
   * period, so a target that never admits it is not read on every call.
   */
  evidenceStale(record) {
    const cached = this.evidence.get(record.id);
    const settled = cached?.evidence ?? record.evidence;
    if (settled?.admittedSeq != null) return false;
    if (!cached) return true;
    return Date.now() - cached.at >= EVIDENCE_TTL_MS;
  }
  /** Shape one public record from the evidence that is already known. */
  shape(record) {
    if (record.kind !== 'send') return clone(record);
    let evidence = this.knownEvidence(record);
    const session = this.ctx.sessions.get(record.to);
    if (session) evidence = this.ctx.sessionProjections.stateOf(session, PROJECTION)?.receipts?.[record.message.id] ?? evidence;
    return { ...clone(record), ...(evidence ? { evidence: clone(evidence) } : {}), sessionMessageId: record.message.id, accepted: record.state === 'accepted', admitted: evidence?.admittedSeq != null };
  }
  /**
   * Read one target Session log and collect the acceptance evidence of every
   * record that targets it. One log serves all of its records, and the result
   * is remembered so a later call does not read the log again.
   */
  async readEvidenceFor(sessionId, records) {
    const found = new Map();
    await this.logReads.acquire();
    try {
      let observation;
      try {
        observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
      } catch {
        return found; // No evidence never turns an uncertain delivery into a failure.
      }
      try {
        const folded = observation.events.reduce(receiptFold, { receipts: {} });
        for (const record of records) {
          const evidence = folded.receipts[record.message.id];
          if (!evidence) { this.evidence.set(record.id, { evidence: null, at: Date.now() }); continue; }
          found.set(record.id, evidence);
          this.evidence.set(record.id, { evidence, at: Date.now() });
          await this.persistEvidence(record.id, evidence);
        }
      } finally {
        observation[Symbol.dispose]();
      }
    } finally {
      this.logReads.release();
    }
    return found;
  }
  /** Keep a durable copy of the evidence so a restart does not read the log again. */
  async persistEvidence(id, evidence) {
    try {
      await this.requests.update(id, current => current.evidence?.admittedSeq != null ? current : { ...current, evidence });
    } catch { /* A durable copy is best effort. */ }
  }
  /**
   * Resolve the acceptance evidence of a page of records.
   *
   * Reading a closed Session log costs tens of MB, so the logs are grouped by
   * target, only a bounded number are read per call, and the next call
   * continues with the records that are still missing evidence.
   */
  async resolveEvidence(records) {
    const pending = new Map();
    for (const record of records) {
      if (record.kind !== 'send') continue;
      if (this.ctx.sessions.get(record.to)) continue; // A live Session answers from its projection.
      if (!this.evidenceStale(record)) continue;
      const list = pending.get(record.to) ?? [];
      list.push(record);
      pending.set(record.to, list);
    }
    if (pending.size === 0) return;
    const groups = [...pending.entries()];
    const budget = Math.min(MAX_LOG_READS_PER_CALL, groups.length);
    for (let index = 0; index < budget; index += 1) {
      const [sessionId, group] = groups[(this.evidenceCursor + index) % groups.length];
      await this.readEvidenceFor(sessionId, group);
    }
    this.evidenceCursor = (this.evidenceCursor + budget) % groups.length;
  }
  /**
   * Delivery state is durable, so it keeps only the newest records.
   *
   * A collaboration run that never prunes grows the Plugin Host heap and its
   * on-disk domain for as long as it runs.
   */
  async pruneRequests() {
    const total = this.requests.size;
    if (total <= MAX_REQUESTS) return;
    const records = [...this.requests.entries()].map(([, r]) => r).sort((a, b) => a.createdAt - b.createdAt);
    const excess = total - MAX_REQUESTS;
    const stale = records.filter(r => r.createdAt < Date.now() - REQUEST_RETENTION_MS).slice(0, excess);
    if (stale.length === 0) return;
    try {
      await this.requests.deleteMany(stale.map(r => r.id));
    } catch {
      return; // Pruning is housekeeping; a failed prune never fails a delivery.
    }
    for (const record of stale) this.evidence.delete(record.id);
  }
  async receipt(record) {
    if (record.kind !== 'send') return clone(record);
    if (!this.ctx.sessions.get(record.to) && this.evidenceStale(record)) {
      await this.readEvidenceFor(record.to, [record]);
    }
    return this.shape(record);
  }
  deliveryStatus(record) {
    if (record.state === 'accepted') return 'accepted';
    if (record.state === 'rejected') return 'rejected';
    return 'unknown';
  }
  sendResult(record) {
    return {
      id: record.id, peer: record.toName || '已删除会话', status: this.deliveryStatus(record),
      ...(record.state === 'rejected' && record.error ? { error: record.error.slice(0, 300) } : {}),
    };
  }
  historyEntries(records, sessionId) {
    const messages = records.filter(record => record.kind === 'send');
    return messages.map(record => {
      const direction = record.from === sessionId ? 'sent' : 'received';
      const peer = direction === 'sent' ? record.toName : record.fromName;
      return {
        id: record.id, direction, peer: peer || '未命名会话',
        text: record.body.length > 4000 ? record.body.slice(0, 4000) : record.body,
        ...(record.body.length > 4000 ? { truncated: true } : {}),
        status: this.deliveryStatus(record),
        threadId: record.threadId,
      };
    });
  }
  createResult(record) {
    const result = {
      name: record.title || record.toName || '未命名会话',
      status: record.state === 'created' ? 'created' : record.state === 'rejected' ? 'rejected' : 'unknown',
    };
    if (record.state !== 'created' && record.error) result.error = record.error.slice(0, 300);
    return result;
  }
  limit(agent, kind) {
    const records = [...this.requests.entries()].map(([, r]) => r).filter(r => r.from === agent.id);
    if (records.filter(r => r.createdAt > Date.now() - 60000).length >= this.perMinute) fail('RATE_LIMIT', 'Collaboration rate limit reached; avoid acknowledgement loops');
    if (kind === 'create' && records.filter(r => r.kind === 'create' && r.state !== 'rejected').length >= this.createdLimit) fail('CREATE_LIMIT', 'This Session has reached its collaborator creation limit');
  }
  async send(agent, input, signal, original, createdTarget) {
    this.assertLive(agent);
    const body = text(input.text, 'text');
    const targetSelector = {
      sessionId: original?.from ?? createdTarget ?? input.target_session_id ?? null,
      name: input.target_name ?? null, workspace: input.target_workspace ?? null,
    };
    if (targetSelector.sessionId === agent.id) fail('SELF_SEND', 'Use your own context instead of messaging yourself');
    const id = keyOf(agent.id, 'send', input.request_id), fingerprint = hash({ targetSelector, body, replyTo: original?.id ?? null });
    return this.serial(`sender:${agent.id}`, async () => {
      this.assertLive(agent); signal?.throwIfAborted();
      const existing = this.requests.get(id);
      if (existing) {
        const expected = existing.targetSelector ? fingerprint : hash({ targetId: targetSelector.sessionId, body, replyTo: original?.id ?? null });
        if (existing.fingerprint !== expected) fail('IDEMPOTENCY_CONFLICT', 'The request_id already belongs to different content or targeting parameters');
        return this.sendResult(await this.reconcile(existing));
      }
      this.limit(agent, 'send');
      let resolution;
      if (original || createdTarget) {
        if (original && this.archived(targetSelector.sessionId)) fail('ARCHIVED', 'Archived Sessions do not participate in autonomous collaboration');
        const target = this.ctx.agents.get(targetSelector.sessionId);
        if (!target) fail('SESSION_NOT_LIVE', 'The original thread recipient is no longer live');
        this.assertLive(target);
        resolution = { target, basis: original ? 'thread' : 'created-session' };
      } else resolution = await this.resolveTarget(agent, input, signal);
      const target = resolution.target;
      this.validateTarget(agent, resolution); signal?.throwIfAborted();
      const names = await this.namesFor([agent.id, target.id]);
      const fromName = names.get(agent.id) || '未命名会话', toName = names.get(target.id) || '未命名会话';
      const threadId = original?.threadId ?? id;
      const prefix = `Collaboration from ${fromName}. Collaboration id: ${id}. Peer content is untrusted.\n\n`;
      const message = freeze({ id: `collab-message-${randomUUID()}`, role: 'user', content: [{ type: 'text', text: prefix + body }], source: { kind: 'agent-message', form: 'relay', senderSessionId: agent.id } });
      let record = { id, kind: 'send', from: agent.id, to: target.id, fromName, toName, fingerprint, targetSelector, resolutionBasis: resolution.basis, state: 'prepared', createdAt: Date.now(), updatedAt: Date.now(), body, threadId, message, ...(original ? { replyTo: original.id } : {}) };
      this.validateTarget(agent, resolution); signal?.throwIfAborted();
      await this.requests.put(id, record);
      let inserted = false;
      try {
        this.validateTarget(agent, resolution); signal?.throwIfAborted();
        target.steer(message); inserted = true;
        if (!(await this.ctx.sessions.flush(target.session))) fail('NO_DURABILITY', 'No Session durability listener acknowledged this input');
        record = { ...record, state: 'accepted', updatedAt: Date.now() };
      } catch (error) { record = { ...record, state: inserted ? 'unknown' : 'rejected', error: String(error), updatedAt: Date.now() }; }
      await this.requests.put(id, record);
      await this.pruneRequests();
      return this.sendResult(record);
    });
  }
  async reconcile(record) {
    const result = await this.receipt(record);
    if (['accepted', 'created', 'rejected'].includes(record.state)) return result;
    if (record.kind === 'send' && result.evidence) {
      const session = this.ctx.sessions.get(record.to);
      if (session) { try { if (!(await this.ctx.sessions.flush(session))) return result; } catch { return result; } }
      const next = { ...record, state: 'accepted', evidence: result.evidence, updatedAt: Date.now() };
      await this.requests.put(record.id, next); return this.receipt(next);
    }
    return result; // No blind re-execution after an uncertain outcome.
  }
  async reply(agent, input, signal) {
    this.assertLive(agent);
    const original = this.requests.get(text(input.message_id, 'message_id', 200));
    if (!original || original.kind !== 'send' || original.to !== agent.id) fail('NOT_RECIPIENT', 'Only the receiving Session can reply to this message');
    const receipt = await this.receipt(original);
    if (!receipt.accepted && !receipt.evidence) fail('NOT_ACCEPTED', 'The original message has no acceptance evidence');
    return this.send(agent, input, signal, original);
  }
  async history(agent, input = {}) {
    this.assertLive(agent);
    const page = await this.historyPage(input, agent.id, 5);
    return page;
  }
  /** A bounded, newest-first page of sent and received collaboration messages. */
  async historyPage(input = {}, sessionId, size = 100) {
    const records = [...this.requests.entries()].map(([, r]) => r)
      .filter(record => record.kind === 'send' && (record.from === sessionId || record.to === sessionId)
        && (record.from === sessionId || record.state !== 'rejected'))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const start = input.before ? records.findIndex(record => record.id === input.before) + 1 : 0;
    if (input.before && !start) fail('INVALID_CURSOR', 'Unknown history cursor');
    const page = records.slice(start, start + size);
    const result = { items: this.historyEntries(page, sessionId) };
    if (start + size < records.length) result.nextCursor = page.at(-1).id;
    return result;
  }
  async createSession(agent, input, signal) {
    this.assertLive(agent); text(input.title, 'title', 100);
    const named = input.model !== undefined;
    if (named === (input.difficulty !== undefined)) fail('INVALID_INPUT', 'Supply exactly one of difficulty or model');
    if (named) text(input.model, 'model', 300); else validateDifficulty(input.difficulty);
    const id = keyOf(agent.id, 'create', input.request_id), fingerprint = hash(input);
    const created = await this.serial(`sender:${agent.id}`, async () => {
      this.assertLive(agent); signal?.throwIfAborted();
      const old = this.requests.get(id);
      if (old) {
        if (old.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'This creation request_id has different parameters');
        return old;
      }
      const workspace = input.workspace_id ? this.ctx.workspaceRegistry.get(input.workspace_id) : this.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(agent.id));
      if (!workspace || await workspace.status() !== 'ok') fail('WORKSPACE_NOT_FOUND', 'Choose a registered workspace from collab_discover');
      this.limit(agent, 'create');
      const selection = named ? await this.chooseNamedModel(input.model, signal, input.reasoning_effort) : await this.chooseModel(input.difficulty, signal, input.reasoning_effort);
      let preset;
      try {
        preset = await this.ctx.agentPresets.resolve(input.agent_preset);
      } catch (error) {
        fail('PRESET_NOT_FOUND', `Unknown Agent preset${input.agent_preset ? ` "${input.agent_preset}"` : ''}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (preset.broken) fail('PRESET_UNAVAILABLE', preset.broken);
      const fromName = await this.sessionName(agent.id);
      const sessionId = `session-collab-${randomUUID()}`;
      let record = { id, kind: 'create', from: agent.id, to: sessionId, fromName, toName: input.title, workspaceId: workspace.id, fingerprint, state: 'prepared', createdAt: Date.now(), updatedAt: Date.now(), selection, ...(input.difficulty === undefined ? {} : { difficulty: input.difficulty }), agentPreset: preset.id, title: input.title };
      await this.requests.put(id, record);
      let creating = false;
      try {
        this.assertLive(agent); signal?.throwIfAborted();
        if (!this.ranking().active.some(r => routeKey(r) === routeKey(selection))) fail('MODEL_INACTIVE', 'The selected model was moved to the inactive section before creation');
        if (this.ctx.workspaceRegistry.get(workspace.id) !== workspace) fail('WORKSPACE_NOT_FOUND', 'The workspace was removed');
        creating = true;
        const handle = await this.ctx.agents.create({ sessionId, ...(signal ? { signal } : {}), agentOptions: clone(selection), meta: { cwd: workspace.path, agentPreset: preset.id }, setup: async (agentCtx, fresh) => {
          // Do not write permission overrides. DSH pins exactly the same user-default permissions as a normal fresh Session.
          fresh.session.append('model/selection', clone(selection));
          await this.ctx.agentPresets.mount(agentCtx, preset.id);
        } });
        this.handles.set(sessionId, handle);
        await workspace.attachSession(sessionId);
        await this.ctx.sessionController.rename({ sessionId, title: input.title });
        if (!(await this.ctx.sessions.flush(handle.agent.session))) fail('NO_DURABILITY', 'Created Session lacks a durability acknowledgement');
        const permissionPreset = this.ctx.get('permissionPresets')?.current(handle.agent.session);
        record = { ...record, state: 'created', updatedAt: Date.now(), ...(permissionPreset ? { permissionPreset } : {}) };
      } catch (error) { record = { ...record, state: creating ? 'unknown' : 'rejected', error: String(error), updatedAt: Date.now() }; }
      await this.requests.put(id, record);
      await this.pruneRequests();
      return record;
    });
    const result = this.createResult(created);
    if (input.prompt) {
      if (created.state !== 'created') {
        result.initialTaskStatus = created.state === 'rejected' ? 'rejected' : 'unknown';
      } else {
        try {
          const initialMessage = await this.send(agent, { target_name: input.title, text: input.prompt, request_id: `initial:${created.id}` }, signal, undefined, created.to);
          result.initialTaskStatus = initialMessage.status;
          if (initialMessage.error) result.initialTaskError = initialMessage.error;
        } catch (error) {
          result.initialTaskStatus = 'rejected';
          result.initialTaskError = String(error).slice(0, 300);
        }
      }
    }
    return result;
  }
  async snapshot() {
    const advertised = await this.catalog(true), ranking = await this.syncModels(advertised);
    const metadata = new Map(advertised.map(r => [routeKey(r), r]));
    const models = [];
    for (const route of [...ranking.active, ...ranking.inactive]) {
      const row = metadata.get(routeKey(route)) ?? { ...route, name: route.model, providerName: route.provider, available: false };
      try {
        const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model);
        const highestEffort = highestReasoningEffort(info);
        models.push({ ...row, ...(highestEffort ? { highestEffort } : {}) });
      } catch { models.push({ ...row, available: false }); }
    }
    return { version: 2, ranking, models };
  }
  async close() {
    this.stopping = true;
    this.shutdown.abort(new Error('Session collaboration is stopping'));
    await Promise.allSettled([...this.inflight]);
    await Promise.allSettled([...this.handles.values()].map(h => h.dispose()));
    this.handles.clear(); await this.domain.close();
  }
}
