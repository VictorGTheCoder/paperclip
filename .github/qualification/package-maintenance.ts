import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveGitInstallWorkspacePackages} from '../../cli/src/commands/install.ts';
const root=process.cwd(), out=path.resolve('release-output'), packs=path.join(out,'packages'), payload=path.join(out,'payload');
fs.mkdirSync(packs,{recursive:true});
const run=(cmd:string,args:string[],cwd=root,extra={})=>execFileSync(cmd,args,{cwd,stdio:'inherit',env:{...process.env,...extra},maxBuffer:64*1024*1024});
const entries=resolveGitInstallWorkspacePackages(root);
const workspaceVersions=new Map(entries.map(e=>[e.name,JSON.parse(fs.readFileSync(path.join(root,e.dir,'package.json'),'utf8')).version]));
run('bash',['scripts/prepare-server-ui-dist.sh'],root,{PAPERCLIP_RELEASE_REUSE_UI_DIST:'1'});
for(const dir of ['server','packages/adapters/claude-local','packages/adapters/codex-local']) fs.cpSync(path.resolve('skills'),path.join(root,dir,'skills'),{recursive:true});
run('bash',['scripts/build-npm.sh','--skip-checks','--skip-typecheck']);
for(const [i,e] of entries.entries()){
 const dir=path.resolve(e.dir),pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
 if((pkg.bundleDependencies??pkg.bundledDependencies??[]).length){
  const stage=path.join(out,`pack-stage-${i}`);
  run('node',['scripts/prepare-bundled-package.mjs',dir,stage]);
  // workspace:* means the dependency's version, which can differ from the consumer's.
  const packed=JSON.parse(fs.readFileSync(path.join(stage,'package.json'),'utf8'));
  for(const section of ['dependencies','optionalDependencies','peerDependencies']) for(const [name,spec] of Object.entries(pkg[section]??{})){
   if(typeof spec==='string' && spec.startsWith('workspace:')){
    const version=workspaceVersions.get(name);if(!version)throw Error('Missing workspace version '+name);
    const range=spec.slice('workspace:'.length);packed[section][name]=(range==='^'||range==='~'?range:'')+version;
   }
  }
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(packed,null,2)+'\n');
  run('npm',['pack','--ignore-scripts',stage,'--pack-destination',packs]);
 } else run('pnpm',['--dir',dir,'pack','--pack-destination',packs],root,{PAPERCLIP_RELEASE_REUSE_UI_DIST:'1'});
}
run('npm',['pack','--pack-destination',packs],path.resolve('cli'));
const tarballs=fs.readdirSync(packs).filter(x=>x.endsWith('.tgz')).map(x=>path.join(packs,x));
if(tarballs.length!==entries.length+1)throw Error('Missing package tarball');
run('npm',['install','--prefix',payload,...tarballs,'--no-audit','--no-fund']);
const platformDir=path.join(payload,'node_modules/@embedded-postgres/linux-x64');
const platformPackage=JSON.parse(fs.readFileSync(path.join(platformDir,'package.json'),'utf8'));
if(platformPackage.version!=='18.1.0-beta.16')throw Error('Unexpected embedded PostgreSQL platform version');
run('node',[path.join(platformDir,'scripts/hydrate-symlinks.js')],platformDir);
run(path.join(platformDir,'native/bin/initdb'),['--version']);
run('node',[path.join(payload,'node_modules/paperclipai/dist/index.js'),'--version']);
for(const e of entries){
 const installed=JSON.parse(fs.readFileSync(path.join(payload,'node_modules',e.name,'package.json'),'utf8'));
 if(installed.version!==workspaceVersions.get(e.name))throw Error('Wrong installed workspace version '+e.name);
 for(const section of ['dependencies','optionalDependencies','peerDependencies'])for(const [name,spec] of Object.entries(installed[section]??{})){
  const version=workspaceVersions.get(name);if(version && ![version,'^'+version,'~'+version].includes(String(spec)))throw Error('Mismatched packaged workspace dependency '+e.name+' -> '+name+' '+spec);
 }
}
const stamp=JSON.parse(fs.readFileSync(path.join(payload,'node_modules/@paperclipai/server/dist/build-info.json'),'utf8'));
if(stamp.commit!==process.env.RELEASE_SHA)throw Error('Installed stamp mismatch');
if(!fs.existsSync(path.join(payload,'node_modules/@paperclipai/server/ui-dist/index.html')))throw Error('Missing UI');
fs.writeFileSync(path.join(out,'package-provenance.json'),JSON.stringify({source:process.env.RELEASE_SHA,node:process.version,platform:process.platform,arch:process.arch,workspacePackages:entries,installedStamp:stamp,packaging:'Native git installer package closure and bundled-dependency preparation; prebuilt payload, no install or network required at activation'},null,2));
fs.copyFileSync(path.join(payload,'package-lock.json'),path.join(out,'installed-package-lock.json'));
run('git',['restore','cli/package.json','cli/README.md']);
run('tar',['-czf',path.join(out,'paperclip-maintenance-linux-x64.tar.gz'),'-C',out,'payload','package-provenance.json']);
