import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveGitInstallWorkspacePackages} from '../../cli/src/commands/install.ts';
const root=process.cwd(), out=path.resolve('release-output'), packs=path.join(out,'packages'), payload=path.join(out,'payload');
fs.mkdirSync(packs,{recursive:true});
const run=(cmd:string,args:string[],cwd=root,extra={})=>execFileSync(cmd,args,{cwd,stdio:'inherit',env:{...process.env,...extra},maxBuffer:64*1024*1024});
const entries=resolveGitInstallWorkspacePackages(root);
run('bash',['scripts/build-npm.sh','--skip-checks','--skip-typecheck']);
for(const [i,e] of entries.entries()){
 const dir=path.resolve(e.dir),pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
 if((pkg.bundleDependencies??pkg.bundledDependencies??[]).length){
  const stage=path.join(out,`pack-stage-${i}`);
  run('node',['scripts/prepare-bundled-package.mjs',dir,stage]);
  run('npm',['pack',stage,'--pack-destination',packs]);
 } else run('pnpm',['--dir',dir,'pack','--pack-destination',packs],root,{PAPERCLIP_RELEASE_REUSE_UI_DIST:'1'});
}
run('npm',['pack','--pack-destination',packs],path.resolve('cli'));
const tarballs=fs.readdirSync(packs).filter(x=>x.endsWith('.tgz')).map(x=>path.join(packs,x));
if(tarballs.length!==entries.length+1)throw Error('Missing package tarball');
run('npm',['install','--prefix',payload,...tarballs,'--no-audit','--no-fund']);
run('node',[path.join(payload,'node_modules/paperclipai/dist/index.js'),'--version']);
const stamp=JSON.parse(fs.readFileSync(path.join(payload,'node_modules/@paperclipai/server/dist/build-info.json'),'utf8'));
if(stamp.commit!==process.env.RELEASE_SHA)throw Error('Installed stamp mismatch');
if(!fs.existsSync(path.join(payload,'node_modules/@paperclipai/server/ui-dist/index.html')))throw Error('Missing UI');
fs.writeFileSync(path.join(out,'package-provenance.json'),JSON.stringify({source:process.env.RELEASE_SHA,node:process.version,platform:process.platform,arch:process.arch,workspacePackages:entries,installedStamp:stamp,packaging:'Native git installer package closure and bundled-dependency preparation; prebuilt payload, no install or network required at activation'},null,2));
fs.copyFileSync(path.join(payload,'package-lock.json'),path.join(out,'installed-package-lock.json'));
run('git',['restore','cli/package.json']);
run('tar',['-czf',path.join(out,'paperclip-maintenance-linux-x64.tar.gz'),'-C',out,'payload','package-provenance.json']);
