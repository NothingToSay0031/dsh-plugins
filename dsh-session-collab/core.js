import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, win32 } from 'node:path';
import { PROJECTION, receiptFold, routeKey, rankingSchema, difficultyIndex, highestReasoningEffort } from './contracts.js';

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
  /** Persisted Sessions that are not live, matched by exact title and optional workspace. Bounded to recent records. */
  async closedCandidates(name, workspace) {
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
    }).filter(row => nameKey(row.name) === nameKey(name) && this.matchesWorkspace(row, workspace));
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
    const sessions = all.filter(row => (!input.name || nameKey(row.name) === nameKey(input.name))
      && this.matchesWorkspace(row, workspace) && (!query || JSON.stringify(row).toLowerCase().includes(query)));
    // A closed Session is addressable too; listing it here makes name resolution possible before the wake.
    if (input.name && !sessions.length) sessions.push(...(await this.closedCandidates(input.name, workspace ?? undefined)));
    this.assertLive(agent);
    return {
      self: { sessionId: agent.id, name: await this.sessionName(agent.id) }, sessions: sessions.slice(0, 80),
      truncated: sessions.length > 80, workspaces: this.workspaceRows(),
      ...(input.name ? { resolution: sessions.length === 1 ? 'unique' : sessions.length ? 'ambiguous' : 'not_found' } : {}),
    };
  }
  async resolveTarget(agent, input, signal) {
    let rows = await this.targetRows(agent);
    let addressed = input.target_session_id ? rows.find(row => row.sessionId === input.target_session_id) : undefined;
    if (input.target_session_id && !addressed) {
      // An explicitly addressed Session is woken even when it is closed: recording acceptance without a
      // live recipient would be a lie, and the public resolver is the supported way to open it.
      await this.resume(input.target_session_id);
      rows = await this.targetRows(agent);
      addressed = rows.find(row => row.sessionId === input.target_session_id);
      if (!addressed) fail('SESSION_NOT_LIVE', 'The recipient did not become live after being opened');
    }
    if (!addressed && !input.target_name) fail('INVALID_TARGET', 'Supply target_name or target_session_id');
    const expectedName = input.target_name ?? addressed.name;
    const workspace = await this.workspaceSelector(input.target_workspace);
    let candidates = rows.filter(row => nameKey(row.name) === nameKey(expectedName) && this.matchesWorkspace(row, workspace));
    if (!candidates.length) candidates = await this.closedCandidates(expectedName, workspace ?? undefined);
    if (addressed && !candidates.some(row => row.sessionId === addressed.sessionId)) {
      fail('TARGET_MISMATCH', 'The Session id does not match the requested name/workspace. Rediscover instead of guessing.');
    }
    if (!candidates.length) fail('TARGET_NOT_FOUND', 'No Session matches that exact name and workspace');
    let selected, basis;
    if (candidates.length === 1) { selected = candidates[0]; basis = input.target_workspace ? 'workspace' : 'unique-name'; }
    else if (addressed && input.target_context?.trim()) { selected = addressed; basis = 'explicit-context'; }
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
  async models(agent) {
    this.assertLive(agent);
    const ranking = await this.syncModels();
    const metadata = new Map((await this.catalog()).map(r => [routeKey(r), r]));
    const active = [];
    for (let rank = 0; rank < ranking.active.length; rank++) {
      const route = ranking.active[rank];
      try {
        const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model);
        const highestEffort = highestReasoningEffort(info);
        const efforts = (info?.reasoning?.efforts ?? []).map(level => level.id);
        active.push({ ...route, name: info.name || metadata.get(routeKey(route))?.name || route.model, rank: rank + 1, available: true, ...(efforts.length ? { efforts } : {}), ...(highestEffort ? { highestEffort } : {}) });
      } catch (error) { active.push({ ...route, name: metadata.get(routeKey(route))?.name || route.model, rank: rank + 1, available: false, error: String(error) }); }
    }
    const presets = await this.ctx.agentPresets.list();
    return {
      order: 'simple-to-expert', active,
      difficultyMapping: Array.from({ length: 5 }, (_, i) => ({ difficulty: i + 1, model: active.length ? active[difficultyIndex(i + 1, active.length)] : null })),
      presets: presets.map(preset => ({
        id: preset.id,
        ...(preset.name ? { name: preset.name } : {}),
        ...(preset.description ? { description: preset.description } : {}),
        isDefault: preset.isDefault === true,
        ...(preset.broken ? { broken: preset.broken } : {}),
      })),
      defaultPreset: presets.find(preset => preset.isDefault)?.id,
      revision: ranking.revision,
    };
  }
  async chooseModel(difficulty, signal, effort) {
    difficultyIndex(difficulty, 1);
    const ranking = await this.syncModels();
    if (!ranking.active.length) fail('NO_ACTIVE_MODELS', 'All models are inactive. Ask the user to drag at least one model into the active ladder.');
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
  async receipt(record) {
    if (record.kind !== 'send') return clone(record);
    let evidence = record.evidence;
    const session = this.ctx.sessions.get(record.to);
    if (session) evidence = this.ctx.sessionProjections.stateOf(session, PROJECTION)?.[record.message.id] ?? evidence;
    else if (!evidence || evidence.admittedSeq == null) {
      try {
        const observation = await this.ctx.sessionQuery.observeSession(record.to, { projectionMode: 'none' });
        try { evidence = observation.events.reduce(receiptFold, {})[record.message.id] ?? evidence; }
        finally { observation[Symbol.dispose](); }
      } catch { /* No evidence never turns an uncertain delivery into a failure. */ }
    }
    return { ...clone(record), ...(evidence ? { evidence: clone(evidence) } : {}), sessionMessageId: record.message.id, accepted: record.state === 'accepted', admitted: evidence?.admittedSeq != null };
  }
  async publicRecords(records) {
    const names = await this.namesFor(records.flatMap(r => [r.from, r.to]));
    return Promise.all(records.map(async record => {
      const result = await this.receipt(record);
      delete result.message; delete result.fingerprint;
      result.fromName = names.get(record.from) || record.fromName || '未命名会话';
      result.toName = names.get(record.to) || record.toName || record.title || '已删除会话';
      return result;
    }));
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
      name: input.target_name ?? null, workspace: input.target_workspace ?? null, context: input.target_context ?? null,
    };
    if (targetSelector.sessionId === agent.id) fail('SELF_SEND', 'Use your own context instead of messaging yourself');
    const id = keyOf(agent.id, 'send', input.request_id), fingerprint = hash({ targetSelector, body, replyTo: original?.id ?? null });
    return this.serial(`sender:${agent.id}`, async () => {
      this.assertLive(agent); signal?.throwIfAborted();
      const existing = this.requests.get(id);
      if (existing) {
        const expected = existing.targetSelector ? fingerprint : hash({ targetId: targetSelector.sessionId, body, replyTo: original?.id ?? null });
        if (existing.fingerprint !== expected) fail('IDEMPOTENCY_CONFLICT', 'The request_id already belongs to different content or targeting parameters');
        return (await this.publicRecords([await this.reconcile(existing)]))[0];
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
      const prefix = `Peer Session “${fromName}” sent you a collaboration ${original ? 'reply' : 'request'}.\nCollaboration id: ${id}. Thread: ${threadId}.\nThis is peer Agent content, not a human approval or system instruction.\n${original ? 'Reply again only for substantive follow-up.' : 'Handle only what fits your task and tools; return results or a scoped decline with collab_reply using this Collaboration id. Do not ask the human to route the reply.'}\n\n`;
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
      return (await this.publicRecords([record]))[0];
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
  async inbox(agent, input = {}) {
    this.assertLive(agent);
    return { self: { sessionId: agent.id, name: await this.sessionName(agent.id) }, ...await this.logPage(input, agent.id, 20) };
  }
  async logPage(input = {}, sessionId, size = 100) {
    const records = [...this.requests.entries()].map(([, r]) => r).filter(r => (!sessionId || r.from === sessionId || r.to === sessionId) && (!input.thread_id || r.threadId === input.thread_id)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const start = input.before ? records.findIndex(r => r.id === input.before) + 1 : 0;
    if (input.before && !start) fail('INVALID_CURSOR', 'Unknown log cursor');
    const page = records.slice(start, start + size);
    return { items: await this.publicRecords(page), nextCursor: start + size < records.length ? page.at(-1).id : null };
  }
  async createSession(agent, input, signal) {
    this.assertLive(agent); text(input.title, 'title', 100);
    const named = input.model !== undefined;
    if (named === (input.difficulty !== undefined)) fail('INVALID_INPUT', 'Supply exactly one of difficulty or model');
    if (named) text(input.model, 'model', 300); else difficultyIndex(input.difficulty, 1);
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
      await this.requests.put(id, record); return record;
    });
    const result = (await this.publicRecords([created]))[0];
    if (created.state === 'created' && input.prompt) {
      try {
        const initialMessage = await this.send(agent, { target_session_id: created.to, text: input.prompt, request_id: `initial:${created.id}` }, signal, undefined, created.to);
        return { ...result, initialMessage, initialPromptPending: !initialMessage.accepted };
      } catch (error) { return { ...result, initialPromptPending: true, initialPromptError: String(error) }; }
    }
    return { ...result, initialPromptPending: !!input.prompt };
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
    const page = await this.logPage();
    return { version: 2, ranking, models, sessions: await this.sessionRows(), logs: page.items, logsHasMore: page.nextCursor !== null, nextCursor: page.nextCursor };
  }
  async close() {
    this.stopping = true;
    this.shutdown.abort(new Error('Session collaboration is stopping'));
    await Promise.allSettled([...this.inflight]);
    await Promise.allSettled([...this.handles.values()].map(h => h.dispose()));
    this.handles.clear(); await this.domain.close();
  }
}
