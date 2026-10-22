import fs from 'node:fs';

// The plugin settings page lives in the workspace, not in this repository, so a
// standalone checkout can still run every test that does not inspect it.
const url = name => new URL(`../../_shared/plugin-settings/${name}`, import.meta.url);
export const hasSharedSettings = fs.existsSync(url('pages.json'));
export const readShared = name => fs.readFileSync(url(name), 'utf8');
export const skipWithoutShared = hasSharedSettings
  ? false
  : '需要工作区的 _shared/plugin-settings（不在插件仓库内）';
