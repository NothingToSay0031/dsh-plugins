(() => {
function register() {
window.__ModuleLoader__.load({
  id: '@local/dsh-compaction-targets',
  factory(require) {
    const React = require('react');
    const { IconCompactOutlineRegular, MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    const NS = 'compactionTargets';
    const PANEL_ID = 'compaction-targets';
    const DICTS = {
      en: {
        tab: 'Compaction targets',
        title: 'Compaction targets',
        intro: 'Absolute token targets are converted to the ratio DSH stores. Model windows and output reserves come from llm-pi-ai and are read-only here.',
        model: 'Model',
        window: 'Window',
        windowHelp: 'Context window; read-only.',
        compactAt: 'Compact at (tokens)',
        compactHelp: 'Compaction starts when the context reaches this many tokens.',
        policy: 'Write policy',
        policyHint: 'Checked writes a model policy; unchecked keeps the fallback ratio.',
        presets: 'Apply to presets',
        presetsHint: 'The same compaction values are written into each checked Agent preset. All usable presets are checked by default.',
        filesNote: 'The generated preset rows are written to the home layer (~/.dsh/cordis.patch.yml), which the Host applies after the profile layer and therefore wins over it. The hand written profile file is never written by this plugin.',
        profilePath: 'Hand written profile file',
        prunerNote: 'Besides the compaction values, saving also turns off the tool-result-pruner plugin (tool-result pruning; writes disabled: true) in every checked preset. It is the only change outside this page\'s settings; presets that do not declare the plugin are left unchanged.',
        prunerResult: 'tool-result-pruner: disabled in the checked presets that declare it.',
        defaultPreset: 'default',
        brokenPreset: 'broken',
        overrideExists: 'existing override',
        overrideWillAdd: 'will add override',
        drift: 'differs from the upstream declaration',
        driftHint: 'The profile row of this preset holds customisations the upstream declaration does not. Declare them in the profile row "compaction-targets" under config.presetOverrides.{id}, or let the save drop them.',
        dropUndeclared: 'Drop the undeclared customisations and rebuild from the upstream declaration',
        driftDropped: 'Rebuilt from the upstream declaration; dropped {count} undeclared customisation(s): {paths}',
        modelSelection: 'Child model selection',
        modelSelectionNote: 'The default child route belongs to this page: it is written into each generated preset row (home layer) with the rest of the save. The subagent tool and model discovery keep the upstream declaration; the fork tool (subagent_fork) keeps inheriting the parent route. The row "subagent-model-selection-settings" (enabled, allowedModels) below is read-only and lives in the hand written profile file; a default route does not have to be on that list. A preset revision is fixed when a Session starts, so start a new Session after a change.',
        modelSelectionPolicy: 'Session allowlist',
        modelSelectionAllowed: 'Routes a new Session may select',
        modelSelectionAllowedHint: 'Read-only here; change it in the profile row "subagent-model-selection-settings". A default child route does not need to be on this list.',
        modelSelectionRoutes: 'none',
        modelSelectionPreset: 'Preset',
        modelSelectionTool: 'Subagent tool',
        modelSelectionDiscovery: 'Model discovery',
        modelSelectionDefault: 'Default child route',
        modelSelectionDefaultNone: 'inherits the parent route',
        modelSelectionYes: 'on',
        modelSelectionNo: 'off',
        modelSelectionNoTool: 'no delegation tool',
        modelSelectionRouteEffortDefault: 'model default (no reasoningEffort)',
        modelSelectionRouteMissing: 'not in llm-pi-ai',
        modelSelectionRouteNotAllowed: 'Not in the allowlist: delegation still uses it, but the model cannot select it explicitly.',
        modelSelectionRouteUnchecked: 'This preset is unchecked; saving will not write it.',
        modelSelectionRouteFromUpstream: 'From the upstream declaration; saved into the generated row.',
        modelSelectionOverlay: 'The profile row presetOverrides.{preset} still declares the default route {route}; this page wins.',
        subagentRoutesResult: 'Child default routes',
        checkPolicyMissing: 'The Host row "subagent-model-selection-settings" is not declared; a new Session may only select its own route.',
        checkPolicyDisabled: 'The Host row "subagent-model-selection-settings" has enabled: false; a new Session may only select its own route.',
        checkPresetModelSelectionOff: 'Preset "{preset}": the subagent tool does not set modelSelection, so explicit selection is rejected.',
        checkPresetModelDiscoveryOff: 'Preset "{preset}": modelDiscovery is off, so there is no list_subagent_models tool.',
        checkPresetNoDelegationTool: 'Preset "{preset}": no delegation tool, so subagents are not offered.',
        checkDefaultRouteNotAllowed: 'Preset "{preset}": the default route {route} is not in the allowlist, so the model cannot select it explicitly.',
        global: 'Global compaction settings',
        retain: 'Retain tokens',
        retainHelp: 'Recent verbatim tail kept after compaction; not summarized.',
        headroom: 'Headroom tokens',
        headroomHelp: 'Safety buffer subtracted from the window.',
        summarizer: 'Summarizer max tokens',
        summarizerHelp: 'Maximum tokens for the compaction summary, not the normal answer reserve.',
        summarizerUnlimited: 'No separate limit (each model keeps its own output cap)',
        summarizerUnlimitedHelp: 'Each model then gets its own declared output ceiling; the number above stops applying.',
        reserveHidden: 'The normal output reserve comes from llm-pi-ai maxTokens; this page only reads it.',
        reload: 'Reload',
        save: 'Save',
        saving: 'Saving…',
        loading: 'Loading…',
        noModels: 'No models were found under any llm-pi-ai provider.',
        error: 'Error',
        changed: 'Written. A preset revision and the sampled authorization are fixed when a Session starts, so start a new Session for it to take effect.',
        unchanged: 'No change. The patch was not written.',
        result: 'Save result',
        path: 'Written file (home layer)',
        backup: 'Backup',
        snapshot: 'JSON snapshot',
        target: 'Target',
        actual: 'Actual',
        appliedPresets: 'Presets',
        restart: 'Start a new Session for the new preset revision to take effect.',
        jsonNotUpdated: 'JSON snapshot was not updated',
        loadFailed: 'Could not load the current compaction targets',
        saveFailed: 'Could not save the compaction targets',
      },
      zh: {
        tab: '压缩点',
        title: '压缩点设置',
        intro: '这里填 token 绝对值，DSH 只保存比例，由插件换算。模型窗口和输出预留来自 llm-pi-ai，页面只读。',
        model: '模型',
        window: '窗口',
        windowHelp: '模型上下文窗口，只读。',
        compactAt: '压缩点（token）',
        compactHelp: '上下文达到这个 token 数时触发压缩。',
        policy: '单独策略',
        policyHint: '勾选后为该模型写入单独策略；不勾选沿用 fallback。',
        presets: '应用到预设',
        presetsHint: '同一套压缩值会写进每个勾选的 Agent 预设；默认勾选全部可用预设。',
        filesNote: '生成的预设覆盖写在 home 层（~/.dsh/cordis.patch.yml）：Host 先应用 profile 层再应用 home 层，所以 home 层优先级更高。手工维护的 profile 文件本插件不会写入。',
        profilePath: '手工维护的 profile 文件',
        prunerNote: '保存除了写入压缩值，还会关闭每个勾选预设的 tool-result-pruner（工具结果剪枝，写入 disabled: true）。这是本页设置之外唯一的改动；预设里没有这个插件时不会新增，保持原样。',
        prunerResult: 'tool-result-pruner：勾选的预设中存在该项的都已关闭。',
        defaultPreset: '默认',
        brokenPreset: '不可用',
        overrideExists: '已有覆盖',
        overrideWillAdd: '保存时新增覆盖',
        drift: '与上游声明不一致',
        driftHint: '这个预设的 profile 覆盖里有上游声明没有的定制。把它写进 profile 的 compaction-targets 行的 config.presetOverrides.{id}，或者在下面勾选丢弃它们。',
        dropUndeclared: '丢弃未声明的定制，按上游声明重建',
        driftDropped: '已按上游声明重建，丢弃了 {count} 处未声明的定制：{paths}',
        modelSelection: '子代理模型选择',
        modelSelectionNote: '子代理默认路由是这一页管理的：保存时和压缩值一起写进生成的预设行（home 层）。子代理工具与模型发现保持上游声明；fork 工具（subagent_fork）仍继承父会话路由。下面的 subagent-model-selection-settings 行（enabled、allowedModels）只读，位于手工维护的 profile 文件；默认路由不必出现在这份清单里。预设版本在会话创建时固定，改完请新建会话。',
        modelSelectionPolicy: '会话允许清单',
        modelSelectionAllowed: '新会话可以显式选择的路由',
        modelSelectionAllowedHint: '此处只读；要改请编辑 profile 的 subagent-model-selection-settings 行。默认路由不必在这份清单里。',
        modelSelectionRoutes: '无',
        modelSelectionPreset: '预设',
        modelSelectionTool: '子代理工具',
        modelSelectionDiscovery: '模型发现',
        modelSelectionDefault: '子代理默认路由',
        modelSelectionDefaultNone: '继承父会话路由',
        modelSelectionYes: '开',
        modelSelectionNo: '关',
        modelSelectionNoTool: '没有委派工具',
        modelSelectionRouteEffortDefault: '模型默认（不写 reasoningEffort）',
        modelSelectionRouteMissing: '不在 llm-pi-ai 清单中',
        modelSelectionRouteNotAllowed: '不在允许清单里：默认委派仍用它，但模型不能显式选择它。',
        modelSelectionRouteUnchecked: '该预设未勾选，保存时不会写入。',
        modelSelectionRouteFromUpstream: '来自上游声明，保存后写入生成的预设行。',
        modelSelectionOverlay: 'profile 的 presetOverrides.{preset} 仍声明了默认路由 {route}；以本页的值为准。',
        subagentRoutesResult: '子代理默认路由',
        checkPolicyMissing: '没有声明 Host 行 subagent-model-selection-settings，新会话只能选择父会话自己的路由。',
        checkPolicyDisabled: 'Host 行 subagent-model-selection-settings 里 enabled: false，新会话只能选择父会话自己的路由。',
        checkPresetModelSelectionOff: '预设 {preset}：subagent 工具没有开 modelSelection，显式选择会被拒绝。',
        checkPresetModelDiscoveryOff: '预设 {preset}：modelDiscovery 是关的，没有 list_subagent_models 工具。',
        checkPresetNoDelegationTool: '预设 {preset}：没有委派工具，不提供子代理。',
        checkDefaultRouteNotAllowed: '预设 {preset}：默认路由 {route} 不在允许清单里，模型无法显式选它。',
        global: '全局压缩设置',
        retain: '保留尾巴 token',
        retainHelp: '压缩后原样保留的最近对话尾部，不总结。',
        headroom: '余量 token',
        headroomHelp: '从窗口扣除的安全缓冲，避免贴近上限。',
        summarizer: '摘要输出上限',
        summarizerHelp: '压缩摘要最多输出多少 token，不是正常回答的预留。',
        summarizerUnlimited: '不单独限制（用模型自己的输出上限）',
        summarizerUnlimitedHelp: '每个模型用自己声明的输出上限，上面那个数字不再生效。',
        reserveHidden: '正常输出预留由 llm-pi-ai 的 maxTokens 决定，插件只读，不在本页设置。',
        reload: '重新读取',
        save: '保存',
        saving: '保存中…',
        loading: '读取中…',
        noModels: 'llm-pi-ai 的各 provider 下都没有模型清单。',
        error: '错误',
        changed: '已写入。预设版本和采样到的授权在会话创建时固定，请新建会话后生效。',
        unchanged: '没有变化，未写文件。',
        result: '保存结果',
        path: '写入文件（home 层）',
        backup: '备份',
        snapshot: 'JSON 快照',
        target: '目标',
        actual: '实际',
        appliedPresets: '已写预设',
        restart: '请新建会话，新的预设版本才会生效。',
        jsonNotUpdated: 'JSON 快照未更新',
        loadFailed: '读取当前压缩点失败',
        saveFailed: '保存压缩点失败',
      },
    };

    function fallbackTranslate(key, vars) {
      const language = (typeof navigator !== 'undefined' && navigator.language || 'en').toLowerCase();
      const dict = language.startsWith('zh') ? DICTS.zh : DICTS.en;
      let text = dict[key] ?? DICTS.en[key] ?? key;
      if (vars) {
        text = String(text).replace(/\{(\w+)\}/g, (match, name) => (
          vars[name] === undefined ? match : String(vars[name])
        ));
      }
      return text;
    }

    function number(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    async function request(method, body) {
      const url = new URL('api/compaction-targets', document.baseURI || window.location.href);
      const response = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || data?.ok === false) {
        const message = data?.error?.message || `${method} ${url.pathname} returned ${response.status}`;
        const error = new Error(message);
        error.details = data?.error?.details;
        throw error;
      }
      return data;
    }

    function field(label, input, hint) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        input,
        hint ? h('span', { style: styles.hint }, hint) : null);
    }

    function Page(props) {
      const t = props.t || fallbackTranslate;
      const [snapshot, setSnapshot] = React.useState(null);
      const [rows, setRows] = React.useState([]);
      const [global, setGlobal] = React.useState({
        retainTokens: '30000',
        headroomTokens: '8192',
        summarizerMaxTokens: '20000',
        summarizerUnlimited: false,
      });
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [loadError, setLoadError] = React.useState(null);
      const [saveError, setSaveError] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [presets, setPresets] = React.useState([]);
      const [selectedPresets, setSelectedPresets] = React.useState([]);
      // A preset row that holds customisations the upstream declaration does
      // not is never rewritten behind the user's back: the save refuses until
      // the customisations are declared or this box says to drop them.
      const [dropUndeclared, setDropUndeclared] = React.useState(false);
      // preset id -> { provider, model, reasoningEffort? } | null (inherit).
      // A preset without an entry has no delegation tool to configure.
      const [routes, setRoutes] = React.useState({});

      async function load() {
        setLoading(true);
        setLoadError(null);
        try {
          const data = await request('GET');
          setSnapshot(data);
          const availablePresets = (data.presets || []).filter(preset => preset && preset.id);
          setPresets(availablePresets);
          setSelectedPresets(current => {
            const usable = availablePresets.filter(preset => !preset.broken).map(preset => preset.id);
            const kept = current.filter(id => usable.includes(id));
            return kept.length > 0 ? kept : usable;
          });
          setRows((data.models || []).map(model => ({
            provider: model.provider,
            model: model.model,
            name: model.name || model.model,
            window: model.window,
            compactAtTokens: String(model.compactAtTokens),
            enabled: model.enabled === true,
          })));
          setGlobal({
            retainTokens: String(data.global.retainTokens),
            headroomTokens: String(data.global.headroomTokens),
            summarizerMaxTokens: String(data.global.summarizerMaxTokens),
            summarizerUnlimited: data.global.summarizerUnlimited === true,
          });
          const nextRoutes = {};
          for (const row of data.modelSelection?.presets || []) {
            if (!row || !row.tool) continue;
            const options = row.tool.agentOptions;
            nextRoutes[row.id] = options && options.provider && options.model
              ? {
                provider: options.provider,
                model: options.model,
                ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
              }
              : null;
          }
          setRoutes(nextRoutes);
        } catch (error) {
          setLoadError(error);
        } finally {
          setLoading(false);
        }
      }

      React.useEffect(() => {
        void load();
      }, []);

      function updateRow(index, patch) {
        setRows(current => current.map((row, position) => (
          position === index ? { ...row, ...patch } : row
        )));
      }

      function togglePreset(id) {
        setSelectedPresets(current => (
          current.includes(id) ? current.filter(item => item !== id) : [...current, id]
        ));
      }

      function routeKey(route) {
        return route ? `${route.provider}\u0000${route.model}` : '';
      }

      function findModel(route) {
        if (!route) return undefined;
        return (snapshot?.models || []).find(model => model.provider === route.provider && model.model === route.model);
      }

      function selectPreset(id) {
        setSelectedPresets(current => (current.includes(id) ? current : [...current, id]));
      }

      // Picking a route is a request to write that preset, so the preset is
      // checked as soon as its route is edited.
      function changeRoute(id, value) {
        const previous = routes[id];
        const [provider, model] = value === '' ? [undefined, undefined] : value.split('\u0000');
        const next = provider ? { provider, model } : null;
        const info = findModel(next);
        const effort = previous ? previous.reasoningEffort : undefined;
        const kept = next && effort && (info?.efforts || []).includes(effort) ? effort : undefined;
        setRoutes(current => ({ ...current, [id]: kept ? { ...next, reasoningEffort: kept } : next }));
        selectPreset(id);
      }

      function changeEffort(id, value) {
        const previous = routes[id];
        if (!previous) return;
        const next = value
          ? { provider: previous.provider, model: previous.model, reasoningEffort: value }
          : { provider: previous.provider, model: previous.model };
        setRoutes(current => ({ ...current, [id]: next }));
        selectPreset(id);
      }

      // Only presets being written carry a route, and only those that declare
      // a delegation tool. A preset the page cannot configure is never sent.
      function selectedRoutes() {
        const result = {};
        for (const id of selectedPresets) {
          if (!Object.prototype.hasOwnProperty.call(routes, id)) continue;
          result[id] = routes[id];
        }
        return result;
      }

      async function save() {
        setSaving(true);
        setSaveError(null);
        setResult(null);
        try {
          const data = await request('POST', {
            models: rows.map(row => ({
              provider: row.provider,
              model: row.model,
              enabled: row.enabled === true,
              compactAtTokens: number(row.compactAtTokens),
            })),
            presets: selectedPresets,
            subagentRoutes: selectedRoutes(),
            dropUndeclared,
            retainTokens: number(global.retainTokens),
            headroomTokens: number(global.headroomTokens),
            summarizerMaxTokens: global.summarizerUnlimited === true
              ? 'model'
              : number(global.summarizerMaxTokens),
          });
          setResult(data);
          await load();
        } catch (error) {
          setSaveError(error);
        } finally {
          setSaving(false);
        }
      }

      if (loading && !snapshot) {
        return h('div', { style: styles.page }, h('p', null, t('loading')));
      }
      if (loadError) {
        return h('div', { style: styles.page },
          h('h2', { style: styles.title }, t('title')),
          h('p', { style: styles.error }, `${t('loadFailed')}: ${loadError.message}`),
          h('button', { type: 'button', style: styles.button, onClick: () => void load() }, t('reload')),
        );
      }

      return h('div', { style: styles.page },
        h('div', { style: styles.content },
        h('div', null,
          h('h2', { style: styles.title }, t('title')),
          h('p', { style: styles.intro }, t('intro')),
        ),
        h('section', { style: styles.section },
          h('h3', { style: styles.subtitle }, t('presets')),
          presets.length === 0
            ? h('p', { style: styles.hint }, 'standard')
            : h('div', { style: styles.grid },
              presets.map(preset => h('label', {
                key: preset.id,
                style: styles.field,
              },
              h('span', { style: styles.label },
                h('input', {
                  type: 'checkbox',
                  disabled: Boolean(preset.broken),
                  checked: selectedPresets.includes(preset.id),
                  onChange: () => togglePreset(preset.id),
                }),
                ' ',
                preset.name ? `${preset.name} (${preset.id})` : preset.id,
                preset.isDefault ? ` · ${t('defaultPreset')}` : '',
                preset.broken ? ` · ${t('brokenPreset')}` : '',
              ),
              h('span', { style: styles.hint },
                preset.hasOverride ? t('overrideExists') : t('overrideWillAdd'),
              ),
              preset.drift && preset.drift.length > 0
                ? h('span', { style: styles.error },
                  `${t('drift')}: ${preset.drift.map(entry => entry.path).join(', ')}`,
                )
                : null,
              preset.drift && preset.drift.length > 0
                ? h('span', { style: styles.hint }, t('driftHint', { id: preset.id }))
                : null,
              )),
            ),
          h('p', { style: styles.hint }, t('presetsHint')),
          h('p', { style: styles.note },
            t('filesNote'),
            h('br'),
            `${t('path')}: ${snapshot?.patchPath ?? ''}`,
            snapshot?.profilePatchPath ? ` · ${t('profilePath')}: ${snapshot.profilePatchPath}` : null,
          ),
          h('label', { style: styles.field },
            h('span', { style: styles.label },
              h('input', {
                type: 'checkbox',
                checked: dropUndeclared,
                onChange: () => setDropUndeclared(value => !value),
              }),
              ' ',
              t('dropUndeclared'),
            ),
          ),
          h('p', { style: styles.note }, t('prunerNote')),
        ),
        rows.length === 0
          ? h('p', null, t('noModels'))
          : h('div', { style: styles.tableWrap },
            h('table', { style: styles.table },
              h('thead', null,
                h('tr', null,
                  [t('model'), t('window'), t('compactAt'), t('policy')]
                    .map((label, index) => h('th', { key: `h-${index}`, style: styles.th }, label)),
                ),
              ),
              h('tbody', null,
                rows.map((row, index) => h('tr', { key: `${row.provider}/${row.model}` },
                  h('td', { style: styles.td },
                    h('div', { style: styles.modelName }, row.name || row.model),
                    h('div', { style: styles.mono }, `${row.provider}/${row.model}`),
                  ),
                  h('td', { style: styles.td },
                    h('div', null, row.window.toLocaleString()),
                    h('div', { style: styles.hint }, t('windowHelp')),
                  ),
                  h('td', { style: styles.td },
                    h('input', {
                      type: 'number',
                      min: 1,
                      step: 1,
                      value: row.compactAtTokens,
                      style: styles.input,
                      onChange: event => updateRow(index, {
                        compactAtTokens: event.target.value,
                        enabled: true,
                      }),
                    }),
                    h('div', { style: styles.hint }, t('compactHelp')),
                  ),
                  h('td', { style: styles.td },
                    h('input', {
                      type: 'checkbox',
                      checked: row.enabled === true,
                      onChange: event => updateRow(index, { enabled: event.target.checked }),
                    }),
                    h('div', { style: styles.hint }, t('policyHint')),
                  ),
                )),
              ),
            ),
          ),
        h('section', { style: styles.section },
          h('h3', { style: styles.subtitle }, t('global')),
          h('div', { style: styles.grid },
            field(t('retain'), h('input', {
              type: 'number',
              min: 1,
              step: 1,
              value: global.retainTokens,
              style: styles.input,
              onChange: event => setGlobal(current => ({ ...current, retainTokens: event.target.value })),
            }), t('retainHelp')),
            field(t('headroom'), h('input', {
              type: 'number',
              min: 0,
              step: 1,
              value: global.headroomTokens,
              style: styles.input,
              onChange: event => setGlobal(current => ({ ...current, headroomTokens: event.target.value })),
            }), t('headroomHelp')),
            field(t('summarizer'), h('input', {
              type: 'number',
              min: 1,
              step: 1,
              value: global.summarizerMaxTokens,
              disabled: global.summarizerUnlimited === true,
              style: styles.input,
              onChange: event => setGlobal(current => ({ ...current, summarizerMaxTokens: event.target.value })),
            }), t('summarizerHelp')),
            field(t('summarizerUnlimited'), h('input', {
              type: 'checkbox',
              checked: global.summarizerUnlimited === true,
              onChange: event => setGlobal(current => ({ ...current, summarizerUnlimited: event.target.checked })),
            }), t('summarizerUnlimitedHelp')),
          ),
          h('p', { style: styles.hint }, t('reserveHidden')),
        ),
        (() => {
          // The child default route is editable here; the tool row's own
          // flags and the Host allowlist stay read-only reports.
          const report = snapshot?.modelSelection;
          if (!report) return null;
          const policy = report.policy || {};
          const allowed = Array.isArray(policy.allowedModels) ? policy.allowedModels : [];
          const presetRows = Array.isArray(report.presets) ? report.presets : [];
          const checks = Array.isArray(report.checks) ? report.checks : [];
          const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
          const flag = value => (value ? t('modelSelectionYes') : t('modelSelectionNo'));
          const checkKey = code => `check${code.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
          const routeText = route => (route
            ? `${route.provider}/${route.model}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ''}`
            : t('modelSelectionDefaultNone'));
          const cell = (id) => {
            const route = routes[id];
            const info = findModel(route);
            const efforts = Array.isArray(info?.efforts) ? info.efforts : [];
            const allowedRoute = route
              ? allowed.some(item => item.provider === route.provider && item.model === route.model)
              : false;
            const declared = presetRows.find(item => item.id === id)?.declaredRoute;
            const declaredDiffers = declared
              && (!route
                || declared.provider !== route.provider
                || declared.model !== route.model
                || (declared.reasoningEffort ?? '') !== (route.reasoningEffort ?? ''));
            return h('div', null,
              h('select', {
                style: styles.input,
                value: routeKey(route),
                onChange: event => changeRoute(id, event.target.value),
              },
              h('option', { value: '' }, t('modelSelectionDefaultNone')),
              route && !info
                ? h('option', { value: routeKey(route) }, `${route.provider}/${route.model} · ${t('modelSelectionRouteMissing')}`)
                : null,
              models.map(model => h('option', {
                key: `${model.provider}/${model.model}`,
                value: `${model.provider}\u0000${model.model}`,
              }, `${model.provider}/${model.model}${model.name && model.name !== model.model ? ` · ${model.name}` : ''}`)),
              ),
              route
                ? h('select', {
                  style: { ...styles.input, marginTop: '4px' },
                  value: route.reasoningEffort ?? '',
                  onChange: event => changeEffort(id, event.target.value),
                },
                h('option', { value: '' }, t('modelSelectionRouteEffortDefault')),
                efforts.map(effort => h('option', { key: effort, value: effort }, effort)),
                route.reasoningEffort && !efforts.includes(route.reasoningEffort)
                  ? h('option', { value: route.reasoningEffort }, `${route.reasoningEffort} · ${t('modelSelectionRouteMissing')}`)
                  : null,
                )
                : null,
              route && !allowedRoute ? h('div', { style: styles.hint }, t('modelSelectionRouteNotAllowed')) : null,
              route && !selectedPresets.includes(id)
                ? h('div', { style: styles.hint }, t('modelSelectionRouteUnchecked'))
                : null,
              declaredDiffers
                ? h('div', { style: styles.hint }, t('modelSelectionOverlay', { preset: id, route: routeText(declared) }))
                : null,
              presetRows.find(item => item.id === id)?.source === 'upstream'
                ? h('div', { style: styles.hint }, t('modelSelectionRouteFromUpstream'))
                : null,
            );
          };
          return h('section', { style: styles.section },
            h('h3', { style: styles.subtitle }, t('modelSelection')),
            h('p', { style: styles.hint }, t('modelSelectionNote')),
            h('div', { style: styles.grid },
              h('div', { style: styles.field },
                h('span', { style: styles.label }, t('modelSelectionPolicy')),
                h('span', null, flag(policy.enabled === true)),
                h('span', { style: styles.hint }, t('modelSelectionAllowed')),
                allowed.length === 0
                  ? h('div', { style: styles.mono }, t('modelSelectionRoutes'))
                  : h('div', { style: styles.mono }, allowed.map(route => `${route.provider}/${route.model}`).join(', ')),
                h('span', { style: styles.hint }, t('modelSelectionAllowedHint')),
              ),
            ),
            presetRows.length === 0
              ? null
              : h('div', { style: styles.tableWrap },
                h('table', { style: styles.table },
                  h('thead', null,
                    h('tr', null,
                      [t('modelSelectionPreset'), t('modelSelectionTool'), t('modelSelectionDiscovery'), t('modelSelectionDefault')]
                        .map((label, index) => h('th', { key: `ms-${index}`, style: styles.th }, label)),
                    ),
                  ),
                  h('tbody', null,
                    presetRows.map(row => h('tr', { key: row.id },
                      h('td', { style: styles.td }, row.id),
                      h('td', { style: styles.td },
                        row.tool ? flag(row.tool.disabled !== true) : h('span', { style: styles.hint }, t('modelSelectionNoTool'))),
                      h('td', { style: styles.td }, row.tool ? flag(row.tool.modelDiscovery === true) : '—'),
                      h('td', { style: styles.td },
                        row.tool
                          ? cell(row.id)
                          : h('div', { style: styles.hint }, t('modelSelectionDefaultNone'))),
                    )),
                  ),
                ),
              ),
            checks.map((check, index) => h('p', {
              key: `ms-check-${index}`,
              style: check.level === 'warn' ? styles.warning : styles.hint,
            }, t(checkKey(check.code), {
              preset: check.preset ?? '',
              route: check.route ?? '',
            }))),
          );
        })(),
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.button,
            disabled: saving || loading,
            onClick: () => void save(),
          }, saving ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            style: styles.secondary,
            disabled: saving,
            onClick: () => void load(),
          }, t('reload')),
        ),
        saveError
          ? h('div', { style: styles.errorBox },
            h('strong', null, `${t('saveFailed')}: `),
            h('span', null, saveError.message),
            saveError.details ? h('pre', { style: styles.pre }, JSON.stringify(saveError.details, null, 2)) : null,
          )
          : null,
        result
          ? h('section', { style: styles.resultBox },
            h('h3', { style: styles.subtitle }, t('result')),
            h('p', { style: result.changed ? styles.success : styles.muted },
              result.changed ? t('changed') : t('unchanged')),
            h('p', { style: styles.hint },
              `${t('path')}: ${result.patchPath}`,
              result.backupPath ? ` · ${t('backup')}: ${result.backupPath}` : '',
            ),
            Array.isArray(result.presets) && result.presets.length > 0
              ? h('p', { style: styles.hint }, `${t('appliedPresets')}: ${result.presets.join(', ')}`)
              : null,
            result.changed ? h('p', { style: styles.hint }, t('prunerResult')) : null,
            Array.isArray(result.subagentRoutes) && result.subagentRoutes.length > 0
              ? h('p', { style: styles.hint }, `${t('subagentRoutesResult')}: ${result.subagentRoutes.map(route => (
                `${route.preset} → ${route.inherited
                  ? t('modelSelectionDefaultNone')
                  : `${route.provider}/${route.model}${route.reasoningEffort ? ` (${route.reasoningEffort})` : ''}`}`
              )).join('，')}`)
              : null,
            (result.routeNotes || []).map((note, index) => h('p', { key: `rn-${index}`, style: styles.warning }, note)),
            Array.isArray(result.drift) && result.drift.length > 0
              ? h('p', { style: styles.hint },
                result.drift.map(entry => t('driftDropped', {
                  count: entry.entries.length,
                  paths: entry.entries.map(item => item.path).join(', '),
                })).join(' '),
              )
              : null,
            h('table', { style: styles.table },
              h('thead', null,
                h('tr', null,
                  [t('model'), t('target'), t('actual')]
                    .map((label, index) => h('th', { key: `r-${index}`, style: styles.th }, label)),
                ),
              ),
              h('tbody', null,
                (result.models || []).map(row => h('tr', { key: `${row.provider}/${row.model}` },
                  h('td', { style: styles.td }, `${row.provider}/${row.model}`),
                  h('td', { style: styles.td }, row.targetTokens.toLocaleString()),
                  h('td', { style: styles.td }, row.actualTokens.toLocaleString()),
                )),
              ),
            ),
            (result.reserveNotes || []).map((note, index) => h('p', { key: `n-${index}`, style: styles.warning }, note)),
            result.jsonSnapshot
              ? h('p', { style: styles.hint },
                `${t('snapshot')}: ${result.jsonSnapshot.path}`,
                result.jsonSnapshot.updated
                  ? ''
                  : ` · ${t('jsonNotUpdated')}${result.jsonSnapshot.reason ? ` (${result.jsonSnapshot.reason})` : ''}${result.jsonSnapshot.error ? `: ${result.jsonSnapshot.error}` : ''}`,
              )
              : null,
            h('p', { style: styles.restart }, t('restart')),
          )
          : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        const locale = ctx.get('locale');
        let translate = fallbackTranslate;
        let disposeLocale = null;
        if (locale && typeof locale.register === 'function') {
          try {
            disposeLocale = locale.register(NS, DICTS);
            if (typeof locale.bind === 'function') translate = locale.bind(NS);
            ctx.effect(() => () => {
              if (typeof disposeLocale === 'function') disposeLocale();
            }, 'compaction-targets: locale dictionary');
          } catch (error) {
            console.error('[compaction-targets] locale registration failed', error);
          }
        }
        const t = (key, vars) => {
          let text;
          try {
            text = translate(key);
          } catch {
            text = fallbackTranslate(key);
          }
          if (vars) {
            text = String(text).replace(/\{(\w+)\}/g, (match, name) => (
              vars[name] === undefined ? match : String(vars[name])
            ));
          }
          return text;
        };
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, props => h(Page, { ...props, t })));
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
          name: 'sidebar.panellist.actions',
          id: PANEL_ID,
          order: -10,
          locale: NS,
        }, ({ onDismiss }) => h(MenuItemButton, {
          icon: h(IconCompactOutlineRegular, { size: 16 }),
          current: ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID,
          onSelect: () => {
            onDismiss();
            ctx.layout.selectPanel(PANEL_ID);
          },
        }, t('tab'))));
      },
    };
  },
});
}

const styles = {
  page: {
    boxSizing: 'border-box',
    height: '100%',
    minHeight: 0,
    overflow: 'auto',
    padding: 'calc(var(--dsh-frame-top-clearance, 24px) + 10px) 28px 36px',
    paddingLeft: 'max(28px, var(--dsh-frame-leading-clearance, 0px))',
    color: 'inherit',
    fontSize: '13px',
    lineHeight: 1.45,
  },
  content: {
    display: 'grid',
    gap: '16px',
    maxWidth: '1120px',
    margin: '0 auto',
  },
  title: { margin: 0, fontSize: '18px', fontWeight: 600 },
  subtitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
  intro: { margin: '6px 0 0', opacity: 0.75, maxWidth: '820px' },
  tableWrap: { overflowX: 'auto', border: '1px solid var(--dsh-color-border, #d0d7de)', borderRadius: '8px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: {
    textAlign: 'left',
    padding: '9px 10px',
    borderBottom: '1px solid var(--dsh-color-border, #d0d7de)',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    opacity: 0.8,
  },
  td: {
    verticalAlign: 'top',
    padding: '10px',
    borderBottom: '1px solid var(--dsh-color-border-muted, rgba(127,127,127,.18))',
  },
  modelName: { fontWeight: 600, marginBottom: '2px' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', opacity: 0.65, wordBreak: 'break-all' },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', opacity: 0.6, wordBreak: 'break-all' },
  hint: { margin: '4px 0 0', fontSize: '11px', opacity: 0.65 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 8px',
    border: '1px solid var(--dsh-color-border, #d0d7de)',
    borderRadius: '6px',
    background: 'var(--dsh-color-surface, transparent)',
    color: 'inherit',
    font: 'inherit',
  },
  section: { display: 'grid', gap: '10px', paddingTop: '4px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' },
  field: { display: 'grid', gap: '4px' },
  label: { fontSize: '11px', opacity: 0.75 },
  actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  button: {
    padding: '7px 14px',
    border: '1px solid var(--dsh-color-border, #d0d7de)',
    borderRadius: '7px',
    background: 'var(--dsh-color-accent, #247bbf)',
    color: '#fff',
    cursor: 'pointer',
    font: 'inherit',
  },
  secondary: {
    padding: '7px 14px',
    border: '1px solid var(--dsh-color-border, #d0d7de)',
    borderRadius: '7px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  },
  error: { color: '#c62828' },
  errorBox: {
    padding: '10px 12px',
    border: '1px solid rgba(198,40,40,.35)',
    borderRadius: '8px',
    background: 'rgba(198,40,40,.06)',
    color: 'inherit',
  },
  pre: { whiteSpace: 'pre-wrap', fontSize: '11px', margin: '8px 0 0' },
  resultBox: {
    display: 'grid',
    gap: '8px',
    padding: '12px',
    border: '1px solid var(--dsh-color-border, #d0d7de)',
    borderRadius: '8px',
  },
  success: { margin: 0, color: '#1b7f3b', fontWeight: 600 },
  muted: { margin: 0, opacity: 0.75 },
  warning: { margin: '4px 0', color: '#9a5b00', fontSize: '12px' },
  note: {
    margin: '4px 0 0',
    padding: '8px 10px',
    border: '1px solid rgba(154,91,0,.35)',
    borderLeft: '3px solid #9a5b00',
    borderRadius: '6px',
    background: 'rgba(154,91,0,.07)',
    fontSize: '12px',
  },
  restart: { margin: 0, fontWeight: 600 },
};

register();
})();

