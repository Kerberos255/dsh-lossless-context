import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema, nativeConfig } from '../config.js';
import { ConfigFile } from '../plugin-settings/file-config.js';
test('LCM config defaults to automatic rotation thresholds',()=>{
 const old={...schema.defaults,rotationMode:undefined,rotationFileMiB:undefined,rotationEventLimit:undefined,thresholdRatio:0.3,deferredRatio:0.3};
 delete old.rotationMode;delete old.rotationFileMiB;delete old.rotationEventLimit;
 const parsed=schema.validate(old);
 assert.equal(parsed.thresholdRatio,0.3);
 assert.equal(parsed.rotationMode,'auto');
 assert.equal(parsed.rotationFileMiB,20);
 assert.equal(parsed.rotationEventLimit,10000);
 for(const value of [{rotationMode:'notify'},{rotationFileMiB:0},{rotationFileMiB:2049},{rotationEventLimit:99},{rotationEventLimit:1000001}])
   assert.throws(()=>schema.validate({...parsed,...value}));
});

test('legacy ConfigFile can read/save/reload new thresholds without losing LCM tuning',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-lcm-config-'));
 const target=path.join(dir,'config.json'),old={...schema.defaults,thresholdRatio:0.3,deferredRatio:0.3};
 delete old.rotationMode;delete old.rotationFileMiB;delete old.rotationEventLimit;
 fs.writeFileSync(target,JSON.stringify(old));
 const file=new ConfigFile(target,{...schema,watch:false});
 try{
   const initial=file.snapshot();assert.equal(initial.value.rotationFileMiB,20);
   const saved=file.save({...initial.value,rotationFileMiB:32,rotationEventLimit:15000},initial.revision);
   assert.equal(saved.value.thresholdRatio,0.3);
   assert.equal(file.reload().value.rotationEventLimit,15000);
   assert.equal(JSON.parse(fs.readFileSync(target,'utf8')).rotationFileMiB,32);
 }finally{file.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('summaryModel is a single validated configuration value and maps to native DSH fields', () => {
 const follow=schema.validate({summaryModel:{provider:'',model:''}});
 assert.deepEqual(follow.summaryModel,{provider:'',model:''});
 assert(!Object.hasOwn(follow,'summarizationProvider'));
 assert(!Object.hasOwn(follow,'summarizationModel'));
 const nativeFollow=nativeConfig(follow);
 assert.equal(nativeFollow.summarizationProvider,'');
 assert.equal(nativeFollow.summarizationModel,'');
 const configured=schema.validate({...follow,summaryModel:{provider:'opencode-go',model:'deepseek-v4-flash'}});
 const native=nativeConfig(configured);
 assert.equal(native.summarizationProvider,'opencode-go');
 assert.equal(native.summarizationModel,'deepseek-v4-flash');
 for(const summaryModel of [null,[],{}, {provider:'foo'}, {model:'bar'}, {provider:'foo',model:''}, {provider:'',model:'bar'}, {provider:12,model:'bar'}, {provider:'foo',model:'bar',extra:true}, {provider:'x'.repeat(257),model:'bar'}]){
  assert.throws(()=>schema.validate({...follow,summaryModel}),'invalid summaryModel');
 }
 for(const legacy of [{summarizationProvider:'old'}, {summarizationModel:'old'}, {summarizationProvider:'',summarizationModel:''}]){
  assert.throws(()=>schema.validate({...follow,...legacy}),'old split summary fields must be rejected');
 }
});
