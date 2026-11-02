(() => {
function register() {
window.__ModuleLoader__.load({
  id: '@local/dsh-compaction-targets',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'compactionTargets';
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
        prunerNote: 'Besides the compaction values, saving also turns off the tool-result-pruner plugin (tool-result pruning; writes disabled: true) in every checked preset. It is the only change outside this page\'s settings; presets that do not declare the plugin are left unchanged.',
        prunerResult: 'tool-result-pruner: disabled in the checked presets that declare it.',
        defaultPreset: 'default',
        brokenPreset: 'broken',
        overrideExists: 'existing override',
        overrideWillAdd: 'will add override',
        global: 'Global compaction settings',
        retain: 'Retain tokens',
        retainHelp: 'Recent verbatim tail kept after compaction; not summarized.',
        headroom: 'Headroom tokens',
        headroomHelp: 'Safety buffer subtracted from the window.',
        summarizer: 'Summarizer max tokens',
        summarizerHelp: 'Maximum tokens for the compaction summary, not the normal answer reserve.',
        reserveHidden: 'The normal output reserve comes from llm-pi-ai maxTokens; this page only reads it.',
        reload: 'Reload',
        save: 'Save',
        saving: 'Saving…',
        loading: 'Loading…',
        noModels: 'No models were found under any llm-pi-ai provider.',
        error: 'Error',
        changed: 'Written. Restart the client for it to take effect.',
        unchanged: 'No change. The patch was not written.',
        result: 'Save result',
        path: 'Patch',
        backup: 'Backup',
        snapshot: 'JSON snapshot',
        target: 'Target',
        actual: 'Actual',
        appliedPresets: 'Presets',
        restart: 'Restart the client for it to take effect.',
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
        prunerNote: '保存除了写入压缩值，还会关闭每个勾选预设的 tool-result-pruner（工具结果剪枝，写入 disabled: true）。这是本页设置之外唯一的改动；预设里没有这个插件时不会新增，保持原样。',
        prunerResult: 'tool-result-pruner：勾选的预设中存在该项的都已关闭。',
        defaultPreset: '默认',
        brokenPreset: '不可用',
        overrideExists: '已有覆盖',
        overrideWillAdd: '保存时新增覆盖',
        global: '全局压缩设置',
        retain: '保留尾巴 token',
        retainHelp: '压缩后原样保留的最近对话尾部，不总结。',
        headroom: '余量 token',
        headroomHelp: '从窗口扣除的安全缓冲，避免贴近上限。',
        summarizer: '摘要输出上限',
        summarizerHelp: '压缩摘要最多输出多少 token，不是正常回答的预留。',
        reserveHidden: '正常输出预留由 llm-pi-ai 的 maxTokens 决定，插件只读，不在本页设置。',
        reload: '重新读取',
        save: '保存',
        saving: '保存中…',
        loading: '读取中…',
        noModels: 'llm-pi-ai 的各 provider 下都没有模型清单。',
        error: '错误',
        changed: '已写入。需要重启客户端才生效。',
        unchanged: '没有变化，未写文件。',
        result: '保存结果',
        path: 'Patch',
        backup: '备份',
        snapshot: 'JSON 快照',
        target: '目标',
        actual: '实际',
        appliedPresets: '已写预设',
        restart: '需要重启客户端才生效。',
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
      });
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [loadError, setLoadError] = React.useState(null);
      const [saveError, setSaveError] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [presets, setPresets] = React.useState([]);
      const [selectedPresets, setSelectedPresets] = React.useState([]);

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
          });
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
            retainTokens: number(global.retainTokens),
            headroomTokens: number(global.headroomTokens),
            summarizerMaxTokens: number(global.summarizerMaxTokens),
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
              ))),
            ),
          h('p', { style: styles.hint }, t('presetsHint')),
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
              style: styles.input,
              onChange: event => setGlobal(current => ({ ...current, summarizerMaxTokens: event.target.value })),
            }), t('summarizerHelp')),
          ),
          h('p', { style: styles.hint }, t('reserveHidden')),
        ),
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
      );
    }

    return {
      inject: ['slots', 'locale'],
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
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'compaction-targets',
          order: 100,
          label: () => t('tab'),
        }, props => h(Page, { ...props, t })));
      },
    };
  },
});
}

const styles = {
  page: {
    display: 'grid',
    gap: '16px',
    padding: '4px 0 28px',
    maxWidth: '1120px',
    color: 'inherit',
    fontSize: '13px',
    lineHeight: 1.45,
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
