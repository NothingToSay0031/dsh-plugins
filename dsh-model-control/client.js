window.__ModuleLoader__.load({
  id: '@local/dsh-model-control',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = '@local/dsh-model-control';
    const PROVENANCE = 'localModelReplyProvenance';
    const NS = 'local-model-control';
    const en = {
      title: 'Model Control', description: 'Provider context budgets, compatible model switching, and per-reply model details.',
      model: 'Model', effort: 'Reasoning effort', providerDefault: 'Default', search: 'Search models…',      chooseModel: 'Select model', loading: 'Loading…', retry: 'Retry', noModels: 'No available models.', noMatch: 'No matching models.',
      selectionFailed: 'Model selection failed', unavailable: 'Model selection is unavailable for this session.',
      settingsUnavailable: 'Model Control settings could not be loaded. Retry before choosing a model.',
      unknownModel: 'Unknown model', unknownEffort: 'Unknown effort', noEffort: 'No reasoning / unspecified',
      highest: 'Use the target model’s highest supported effort when switching models',
      highestHelp: 'Applies only when selecting a different model in this picker. A later manual effort choice, including Default, is kept.',
      showReply: 'Show the actual model and effort below assistant replies',
      budgetTitle: 'Provider context budgets', defaultLimit: 'Default context budget (tokens)',
      budgetHelp: 'These settings synchronize real provider contextWindow fields; they are not a hard prompt truncation. Effective budgets cannot exceed the observed native capacity.',
      ruleHelp: 'Exact rules win over prefix rules. Within each type the first matching rule wins. Prefix matching also uses the model basename (for example, gpt- after vendor/). An empty provider matches every provider.',
      match: 'Match', exact: 'Exact', prefix: 'Prefix', modelPattern: 'Model ID / prefix', provider: 'Provider (optional)', tokens: 'Tokens',
      addRule: 'Add rule', remove: 'Remove', save: 'Save and synchronize', sync: 'Synchronize budgets', reload: 'Reload',
      restore: 'Restore original provider budgets before disabling',
      restoreHelp: 'Disabling the plugin alone does not undo persisted provider changes. Restore first; conflicting external edits are preserved. Synchronize or save to apply budgets again after restoration.',
      restoreConfirm: 'Restore the actual provider contextWindow fields previously changed by Model Control? Only plugin-owned values are restored; external edits are preserved. This does not reset your rules.',
      discardConfirm: 'Discard unsaved Model Control changes and reload?', dirty: 'Unsaved changes', saveFirst: 'Save or reload your draft before synchronizing or restoring.',
      saved: 'Settings saved. Review the synchronization results below.', synchronized: 'Budget synchronization finished.', restored: 'Restoration finished. Automatic synchronization is suspended until you save or synchronize again.',
      status: 'Synchronization status', lastSynced: 'Last synchronized', never: 'Not yet', configured: 'Configured', effective: 'Effective', native: 'Native', result: 'Result',
      pending: 'Pending', syncing: 'Synchronizing', applied: 'Applied', partial: 'Partial / needs attention', restoredState: 'Restored',
      unsupported: 'Unsupported provider', conflict: 'External edit conflict', supported: 'Supported', issues: 'Issues', emptyStatus: 'No model synchronization results yet.',
      catalogFailures: 'Unavailable provider catalogs', invalidLimit: 'Token limits must be whole numbers between 1,000 and 10,000,000.',
      invalidRule: 'Every rule needs a non-empty model ID or prefix and a unique ID.', staleModel: 'The model catalog changed. Reload and select an available model.',
      operationFailed: 'Operation failed', settings: 'Settings',
    };
    const zh = {
      title: '模型控制', description: '提供方上下文预算、兼容的模型切换，以及每条回复的实际模型。',
      model: '模型', effort: '思考强度', providerDefault: 'Default（提供方默认）', search: '搜索模型…',
      chooseModel: '选择模型', loading: '正在加载…', retry: '重试', noModels: '没有可用模型。', noMatch: '没有匹配模型。',
      selectionFailed: '模型选择失败', unavailable: '此会话不可独立选择模型。',
      settingsUnavailable: '无法加载模型控制设置，请重试后再选择模型。',
      unknownModel: '模型未知', unknownEffort: '强度未知', noEffort: '无思考／未指定',
      highest: '切换模型时，默认使用目标模型支持的最高思考强度',
      highestHelp: '仅在此选择器选择不同模型时生效。随后手动选择的合法低档或 Default 会被保留，不会每步强制调高。',
      showReply: '在助手回复下显示实际模型与思考强度',
      budgetTitle: '提供方上下文预算', defaultLimit: '默认上下文预算（tokens）',
      budgetHelp: '这里同步的是提供方真实的 contextWindow 字段，不是对提示词进行硬截断；有效预算不会超过已观察到的模型原生容量。',
      ruleHelp: '精确规则优先于前缀规则；同类规则按列表顺序采用第一条匹配。前缀也匹配去掉 vendor/ 等路径后的模型名。提供方留空表示不限。',
      match: '匹配方式', exact: '精确', prefix: '前缀', modelPattern: '模型 ID／前缀', provider: '提供方（可选）', tokens: 'Tokens',
      addRule: '新增规则', remove: '删除', save: '保存并同步', sync: '同步提供方预算', reload: '重新加载',
      restore: '停用前恢复原提供方预算',
      restoreHelp: '仅停用插件不会撤销已持久化的提供方更改，请先恢复。外部编辑产生的冲突会保留；恢复后，只有再次保存或同步才会重新应用预算。',
      restoreConfirm: '确认恢复模型控制曾修改的真实提供方 contextWindow 字段？只恢复仍由本插件拥有的值，保留外部编辑；不会清空你的规则。',
      discardConfirm: '放弃尚未保存的模型控制设置，并重新加载？', dirty: '有未保存的更改', saveFirst: '请先保存或重新加载草稿，再同步或恢复。',
      saved: '设置已保存，请查看下方同步结果。', synchronized: '提供方预算同步已结束。', restored: '恢复已结束；在下次保存或同步前，不会自动再次覆盖预算。',
      status: '同步状态', lastSynced: '上次同步', never: '尚未同步', configured: '配置预算', effective: '有效预算', native: '原生容量', result: '结果',
      pending: '待同步', syncing: '同步中', applied: '已应用', partial: '部分应用／需要处理', restoredState: '已恢复',
      unsupported: '不支持的提供方', conflict: '外部编辑冲突', supported: '支持同步', issues: '问题', emptyStatus: '暂无模型预算同步结果。',
      catalogFailures: '不可用的提供方目录', invalidLimit: 'Token 预算必须是 1,000 至 10,000,000 之间的整数。',
      invalidRule: '每条规则都需要非空的模型 ID／前缀和唯一 ID。', staleModel: '模型目录已更改，请重新加载后选择可用模型。',
      operationFailed: '操作失败', settings: '设置',
    };
    const CSS = `
.lmc-picker{position:relative;min-width:0;max-width:min(360px,45cqw)}
.lmc-trigger{display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;height:28px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.lmc-trigger:hover:not(:disabled),.lmc-option:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.lmc-trigger:focus-visible,.lmc-option:focus-visible,.lmc-button:focus-visible,.lmc-input:focus-visible,.lmc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.lmc-trigger:disabled,.lmc-button:disabled,.lmc-option:disabled{opacity:.55;cursor:default}
.lmc-trigger-text{display:var(--dsh-composer-model-text-display,block);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmc-trigger-icon{display:var(--dsh-composer-model-icon-display,none);flex:none}
.lmc-caption{color:var(--dsw-alias-label-secondary)}
.lmc-menu{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1100;width:min(360px,calc(100vw - 48px));max-height:min(440px,65vh);overflow:auto;padding:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 5px 22px var(--dsw-alias-border-l1);font-size:13px;line-height:1.5}
.lmc-menu-title{font-weight:600;margin:3px 3px 7px}.lmc-group-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;padding:10px 7px 4px;overflow-wrap:anywhere}
.lmc-option{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:7px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.lmc-option[aria-checked=true]{background:var(--dsw-alias-bg-layer-2)}.lmc-option-name{min-width:0;overflow-wrap:anywhere}
.lmc-efforts{border-top:1px solid var(--dsw-alias-border-l1);margin-top:9px;padding-top:9px}.lmc-help{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:5px 0 10px;overflow-wrap:anywhere}
.lmc-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0}.lmc-notice{font-size:13px;line-height:1.6;margin:10px 0;color:var(--dsw-alias-label-secondary)}
.lmc-badge{order:1;flex:none;display:inline-flex;align-items:center;gap:4px;max-width:100%;font-size:11px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;vertical-align:middle}
.lmc-page{box-sizing:border-box;width:100%;height:100%;overflow:auto;color:var(--dsw-alias-label-primary);padding:calc(var(--dsh-frame-top-clearance,24px) + 10px) 28px 36px;padding-left:max(28px,var(--dsh-frame-leading-clearance,0px));font-size:13px;line-height:1.5}
.lmc-config{height:auto;max-height:75vh;padding:12px}.lmc-page-inner{max-width:980px;margin:0 auto}.lmc-page h1{font-size:23px;line-height:1.4;font-weight:600;margin:0 0 6px}.lmc-page h2{font-size:16px;font-weight:600;margin:0 0 12px}
.lmc-section{padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.lmc-field{display:flex;flex-direction:column;gap:6px;margin:10px 0}.lmc-field>span,.lmc-field>label{font-weight:500}
.lmc-input,.lmc-select{box-sizing:border-box;min-width:0;max-width:100%;width:100%;min-height:32px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.lmc-check{display:flex;gap:9px;align-items:flex-start;margin:12px 0}.lmc-check input{margin-top:4px;accent-color:var(--dsw-alias-brand-primary)}
.lmc-rule{display:grid;grid-template-columns:90px minmax(100px,1.4fr) minmax(90px,1fr) 116px auto;gap:8px;align-items:end;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.lmc-rule .lmc-field{margin:0}.lmc-rule-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.lmc-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:6px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.lmc-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.lmc-primary{color:var(--dsw-alias-brand-primary)}.lmc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0}.lmc-table-wrap{overflow:auto}.lmc-table{width:100%;border-collapse:collapse;font-size:12px}.lmc-table th,.lmc-table td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}.lmc-table th{color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}.lmc-table td:first-child{overflow-wrap:anywhere;min-width:170px}.lmc-table td:not(:first-child){white-space:nowrap}.lmc-issues{padding-left:20px;font-size:12px;overflow-wrap:anywhere}.lmc-status{display:inline-block;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:12px}
@media(max-width:720px){.lmc-page{padding:24px 16px}.lmc-rule{grid-template-columns:90px minmax(90px,1fr)}.lmc-rule>:last-child{justify-self:start}.lmc-menu{width:min(320px,calc(100vw - 40px))}}
`;
    function errorText(error) {
      if (!error) return 'Unknown error';
      return `${error.code ? `${error.code}: ` : ''}${error.message || String(error)}`;
    }
    function basename(model) { return String(model || '').split('/').at(-1); }
    function ModelIcon() {
      return h('svg', { width:16, height:16, viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', strokeWidth:1.6, 'aria-hidden':true },
        h('path', { d:'M4 5h16v14H4zM4 10h16M9 10v9M7 7.5h.01M10 7.5h.01M13 7.5h4M13 14h4M13 17h3' }));
    }
    function createControl() {
      const snapshot = { settings:{ version:2, revision:0, highestOnModelSwitch:true, showReplyModel:true } };
      const state = { snapshot, loading:false, error:null };
      return { getSnapshot:() => state, subscribe:() => () => {}, load:async () => snapshot, dispose() {} };
    }
    function useControl(control) {
      const state = React.useSyncExternalStore(control.subscribe, control.getSnapshot);
      React.useEffect(() => { control.load().catch(() => {}); }, [control]);
      return state;
    }
    function Picker({ locked, available, directory, load, select, control, t }) {
      const state = React.useSyncExternalStore(
        React.useCallback(listener => directory.subscribe(listener), [directory]),
        React.useCallback(() => directory.getSnapshot(), [directory]));
      const config = useControl(control);
      const [open,setOpen] = React.useState(false), [query,setQuery] = React.useState(''), [error,setError] = React.useState(null);
      const rootRef=React.useRef(null), triggerRef=React.useRef(null), searchRef=React.useRef(null), mounted=React.useRef(true);
      const menuId=React.useId();
      const busy=state.pending!==null;
      const current=state.current;
      const groups=state.groups || [];
      const selectedGroup=groups.find(group => group.id===current?.provider);
      const selectedModel=selectedGroup?.models.find(model => model.id===current?.model);
      const reasoning=selectedModel?.reasoning;
      const effectiveEffort=current?.reasoningEffort ?? reasoning?.defaultEffort;
      const effortName=reasoning?.efforts.find(effort => effort.id===effectiveEffort)?.name ?? effectiveEffort;
      const modelLabel=selectedModel?.name ?? t('chooseModel');
      const caption=selectedModel && reasoning ? (effortName ?? t('providerDefault')) : '';
      const normalized=query.trim().toLowerCase();
      const visibleGroups=groups.map(group => ({ ...group, models:group.models.filter(model => `${model.name} ${model.id} ${group.name}`.toLowerCase().includes(normalized)) })).filter(group => group.models.length);
      const close=React.useCallback((restoreFocus=false) => {
        setOpen(false);
        if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
      }, []);
      React.useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; }, []);
      React.useEffect(() => { if (locked || !available) setOpen(false); }, [locked,available]);
      React.useEffect(() => {
        if (!open) return;
        const outside=event => { if (!rootRef.current?.contains(event.target)) close(false); };
        document.addEventListener('pointerdown',outside,true);
        searchRef.current?.focus();
        return () => document.removeEventListener('pointerdown',outside,true);
      }, [open,close]);
      async function submit(selection) {
        if (!available || locked || busy || !config.snapshot) return;
        setError(null);
        triggerRef.current?.focus();
        try {
          const result=await select(selection);
          if (result && result.ok===false) throw result.error;
          if (mounted.current) close(true);
        } catch (failure) { if (mounted.current) setError(`${t('selectionFailed')}: ${errorText(failure)}`); }
      }
      function chooseModel(group,model) {
        if (current?.provider===group.id && current.model===model.id) { close(true); return; }
        const actual=directory.getSnapshot().groups.find(item => item.id===group.id)?.models.find(item => item.id===model.id);
        if (!actual) { setError(t('staleModel')); return; }
        // Adapter metadata orders its effort scale from least to greatest. Never inherit the old route's effort.
        const effort=config.snapshot?.settings.highestOnModelSwitch ? actual.reasoning?.efforts.at(-1)?.id : actual.reasoning?.defaultEffort;
        return submit({ provider:group.id,model:model.id,...effort===undefined?{}:{reasoningEffort:effort} });
      }
      function chooseEffort(effort) {
        if (!current) return;
        if (!reasoning?.efforts.some(level => level.id===effort)) { setError(t('staleModel')); return; }
        return submit({ provider:current.provider,model:current.model,reasoningEffort:effort });
      }
      function onKeyDown(event) {
        if (event.nativeEvent?.isComposing || !open) return;
        if (event.key==='Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
        if (event.key==='Tab' && event.shiftKey && event.target===searchRef.current) { event.preventDefault(); close(true); return; }
        if (event.key!=='ArrowDown' && event.key!=='ArrowUp') return;
        const options=Array.from(rootRef.current?.querySelectorAll('[role="menuitemradio"]:not(:disabled)') || []);
        if (!options.length) return;
        event.preventDefault(); event.stopPropagation();
        const index=options.indexOf(document.activeElement), direction=event.key==='ArrowDown'?1:-1;
        options[index<0 ? (direction>0?0:options.length-1) : (index+direction+options.length)%options.length]?.focus();
      }
      function refresh() { setError(null); Promise.all([load(),control.load(true)]).catch(failure => { if (mounted.current) setError(errorText(failure)); }); }
      if (!available) return null;
      const selectionDisabled=locked || busy || !config.snapshot || config.loading;
      return h('div',{ className:'lmc-picker',ref:rootRef,onKeyDown,
        onBlur:event => { if (!event.relatedTarget || !rootRef.current?.contains(event.relatedTarget)) close(false); } },
        h('style',null,CSS),
        h('button',{ type:'button',className:'lmc-trigger',ref:triggerRef,disabled:locked||busy,'aria-haspopup':'menu','aria-expanded':open,'aria-controls':open?menuId:undefined,'aria-busy':busy,
          title:[modelLabel,caption].filter(Boolean).join(' · '),'aria-label':[t('chooseModel'),modelLabel,caption].filter(Boolean).join(', '),
          onClick:() => { if (open) close(true); else { setQuery('');setError(null);setOpen(true);load().catch(failure => setError(errorText(failure))); } } },
          h('span',{className:'lmc-trigger-icon'},h(ModelIcon)),h('span',{className:'lmc-trigger-text'},modelLabel,caption?h('span',{className:'lmc-caption'},` · ${caption}`):null),h('span',{'aria-hidden':true},busy?'…':'⌄')),
        open?h('div',{id:menuId,className:'lmc-menu',role:'menu','aria-label':`${t('model')} / ${t('effort')}`},
          h('div',{className:'lmc-menu-title'},t('model')),
          h('input',{type:'search',className:'lmc-input',ref:searchRef,value:query,placeholder:t('search'),'aria-label':t('search'),onChange:event=>setQuery(event.target.value)}),
          config.loading || state.status==='loading' ? h('div',{className:'lmc-help',role:'status'},t('loading')):null,
          !config.snapshot && config.error ? h('div',{className:'lmc-error',role:'alert'},t('settingsUnavailable'),h('div',null,config.error)):null,
          error?h('div',{className:'lmc-error',role:'alert'},error):null,
          state.error?h('div',{className:'lmc-error'},state.error):null,
          error || state.error || config.error ? h('button',{type:'button',className:'lmc-button',disabled:busy||config.loading,onClick:refresh},t('retry')):null,
          ...(state.failures||[]).map(failure=>h('div',{key:failure.id,className:'lmc-error'},`${failure.name||failure.id}: ${failure.message}`)),
          ...visibleGroups.map(group=>h('div',{key:group.id},h('div',{className:'lmc-group-label'},group.name),
            ...group.models.map(model=>{const checked=current?.provider===group.id&&current.model===model.id;return h('button',{key:model.id,type:'button',role:'menuitemradio','aria-checked':checked,className:'lmc-option',disabled:selectionDisabled,title:`${group.id}/${model.id}`,onClick:()=>chooseModel(group,model)},h('span',{className:'lmc-option-name'},model.name),h('span',{'aria-hidden':true},state.pending?.provider===group.id&&state.pending.model===model.id?'…':checked?'✓':''));}))),
          visibleGroups.length===0?h('div',{className:'lmc-help',role:'status'},t(groups.length?'noMatch':'noModels')):null,
          current && reasoning ? h('div',{className:'lmc-efforts'},h('div',{className:'lmc-menu-title'},t('effort')),
            ...reasoning.efforts.map(level=>h('button',{key:level.id,type:'button',role:'menuitemradio','aria-checked':effectiveEffort===level.id,className:'lmc-option',disabled:selectionDisabled,onClick:()=>chooseEffort(level.id)},level.name,h('span',{'aria-hidden':true},effectiveEffort===level.id?'✓':'')))):null):null);
    }
    function ProvenanceBadge({messageId,useProjection,control,t}) {
      const config=useControl(control);
      const reply=useProjection(PROVENANCE,value=>value?.replies?.[messageId] ?? value?.[messageId]);
      if (!config.snapshot?.settings.showReplyModel) return null;
      const model=reply?.model ? basename(reply.model) : t('unknownModel');
      const effort=!reply || !reply.effortKnown ? t('unknownEffort') : reply.reasoningEffort===null || reply.reasoningEffort===undefined ? t('noEffort') : reply.reasoningEffort;
      return h(React.Fragment,null,h('style',null,CSS),h('span',{className:'lmc-badge',title:reply?`${reply.provider}/${reply.model} · ${effort}`:`${model} · ${effort}`},`${model} · ${effort}`));
    }
    return {
      inject:['slots','connection','locale','remote','remote.session'],
      apply(ctx) {
        ctx.effect(()=>ctx.locale.register(NS,{en,zh}),'model-control: locale');
        const t=ctx.locale.bind(NS), control=createControl();
        ctx.effect(()=>()=>control.dispose(),'model-control: requests');
        ctx.slots.inject('conversation.chat.assistant-actions',()=>ctx.slots.register({name:'conversation.chat.assistant-actions',id:'local-model-provenance',order:100},props=>h(ProvenanceBadge,{...props,control,t})));
        ctx.inject(['sessions','modelDirectories','remote','remote.session'],scope=>{
          const models=scope.get('modelDirectories');
          if(!models)return;
          scope.slots.inject('conversation.input.model',()=>scope.slots.register({name:'conversation.input.model',priority:-10,locale:NS,
            inject:sessionId=>{
              const directory=models.directoryFor(sessionId);
              const available=scope.sessions.subagentAddress(sessionId)===undefined;
              return {available,directory:directory.store,load:()=>available?directory.load():Promise.resolve(),select:selection=>available?directory.select(selection):Promise.reject(new Error(t('unavailable')))};
            }},props=>h(Picker,{...props,control,t})));
        });
      },
    };
  },
});
