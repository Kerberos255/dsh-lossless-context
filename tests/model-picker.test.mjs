import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const configExample = JSON.parse(read('../config.example.json'));

test('summary model uses one DSH chat-model selector with a session-following default', () => {
  const fields = JSON.parse(read("../tools/settings/pages.json"))['dsh-lossless-context'].fields;
  const summaryFields = fields.filter(field => field.key.startsWith('summaryModel.') || ['summarizationProvider', 'summarizationModel'].includes(field.key));
  assert.equal(summaryFields.length, 1, 'provider ID must not be rendered as a separate input');
  const [model] = summaryFields;
  assert.deepEqual({
    key: model.key, providerKey: model.providerKey, type: model.type,
    kind: model.kind, label: model.label, emptyLabel: model.emptyLabel,
  }, {
    key: 'summaryModel.model', providerKey: 'summaryModel.provider',
    type: 'model', kind: 'chat', label: '摘要模型', emptyLabel: '跟随当前会话模型',
  });
  assert.deepEqual(configExample.summaryModel, {provider:'',model:''});
  assert(!Object.hasOwn(configExample,'summarizationProvider'));
  assert(!Object.hasOwn(configExample,'summarizationModel'));
});

test('native model picker offers a session-following entry and preserves specified provider/model', () => {
  const snippet = read("../tools/settings/settings-client.inc.js");
  const start = snippet.indexOf('function ModelPicker(');
  const end = snippet.indexOf('function FileConfigPage(');
  assert(start !== -1 && end > start);
  const mockReact = {
    createElement: (type, props, ...children) => ({type, props, children}),
    useState: initial => [initial, () => {}],
    useEffect() {},
  };
  const pick = vm.runInNewContext(snippet.slice(start, end) + '\nModelPicker', {React: mockReact});
  const changes = [];
  const render = props => pick({scope: {call() {}}, provider:'', model:'', kind:'chat', disabled:false,
    label:'摘要模型', emptyLabel:'跟随当前会话模型', onChange: value => changes.push(value), ...props});
  const first = render({});
  const select = first.children.find(node => node?.type === 'select');
  assert.equal(select.props.value, JSON.stringify(['', '']));
  assert.equal(select.children[0].children[0], '跟随当前会话模型');
  select.props.onChange({target:{value:JSON.stringify(['opencode-go','deepseek-v4-flash'])}});
  assert.deepEqual({...changes[0]}, {provider:'opencode-go',model:'deepseek-v4-flash'});
  select.props.onChange({target:{value:JSON.stringify(['',''])}});
  assert.deepEqual({...changes[1]}, {provider:'',model:''});
  const selected = render({provider:'opencode-go',model:'deepseek-v4-flash'});
  const chosenSelect = selected.children.find(node => node?.type === 'select');
  assert.equal(chosenSelect.props.value, JSON.stringify(['opencode-go','deepseek-v4-flash']));
  assert(chosenSelect.children.some(node => node?.type==='option' && node?.children[0]?.includes('当前配置')));
});

test('selector edits one nested model object and runtime emits native IDs only at the boundary', () => {
  const snippet = read("../tools/settings/settings-client.inc.js");
  assert(snippet.includes("scope.call('modelCatalog',{kind})"), 'model list must come from DSH model catalog');
  assert(snippet.includes('emptyLabel:spec.emptyLabel'), 'model selector must receive its custom fallback label');
  assert(snippet.includes('configChange(configChange(previous.draft,spec.providerKey,selection.provider),spec.key,selection.model)'),
    'provider and model must update together');
  const config = read('../config.js');
  assert(config.includes("summaryModel:{provider:'',model:''}"), 'one nested model object is the default');
  assert(config.includes("summaryModel:v=>"), 'nested model pair is validated');
  assert(!config.includes("summarizationProvider:(v,c)=>"), 'obsolete schema rule removed');
  assert(config.includes('summarizationProvider:value.summaryModel.provider.trim()'), 'native provider comes from new model object');
  assert(config.includes('summarizationModel:value.summaryModel.model.trim()'), 'native model comes from new model object');
  const changer = vm.runInNewContext(snippet.slice(snippet.indexOf('const configChange='),snippet.indexOf('function ModelPicker('))+'\nconfigChange', {});
  const selected = changer(changer(configExample,'summaryModel.provider','opencode-go'),'summaryModel.model','deepseek-v4-flash');
  assert.deepEqual({...selected.summaryModel}, {provider:'opencode-go', model:'deepseek-v4-flash'});
  const reset = changer(changer(selected,'summaryModel.provider',''),'summaryModel.model','');
  assert.deepEqual({...reset.summaryModel}, {provider:'', model:''});
});
