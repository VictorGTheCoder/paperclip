"""Assemble an immutable complete release from verified baseline libraries and fully rebuilt application packages.
No compilation, npm resolution, production install-store access, or database access occurs here.
The resulting package lock records workspace provenance rather than old registry integrities.
Rebuild this payload using this recipe and the two checksummed input artifacts, not npm ci in place.
"""
import pathlib,json,hashlib,subprocess,shutil,os,stat
public=pathlib.Path('/home/bobby/artifacts/paperclip-maintenance-release-20261030');root=pathlib.Path('/var/lib/paperclip-maintenance-runtime-20261030');inst=root/'rehearsal-store/cli/installs';base=inst/'npm/2026.1012.0';fresh=inst/'git/4b978f3414a2';stage=root/'pinned-stage';payload=stage/'payload';sha='4b978f3414a2cb8afa5c8d4fba5b3e1bae98ff90'
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
provenance=json.loads((public/'deployable-artifact/package-provenance.json').read_text());assert provenance['source']==sha
assert digest(public/'deployable-artifact/paperclip-maintenance-linux-x64.tar.gz')=='1589ca9b3fdcbf8b6f577542d417d87ea3c3895a47f62db503c9ece494ae5404'
snapshot=json.loads((public/'snapshot-evidence.json').read_text());assert snapshot['archiveSha256']=='50aa91af27b46add1fa865187dae55e7945731e6bf86d75998ee71ea6a1ae184'
names=[x['name'] for x in provenance['workspacePackages']]+['paperclipai'];owned={pathlib.PurePosixPath('node_modules')/n for n in names}
old_lock=json.loads((base/'package-lock.json').read_text());new_lock=json.loads((fresh/'package-lock.json').read_text())
internal_paths={k for k in old_lock['packages'] if k and (k.rsplit('node_modules/',1)[-1]=='paperclipai' or k.rsplit('node_modules/',1)[-1].startswith('@paperclipai/'))};assert internal_paths=={str(p) for p in owned},internal_paths
for n in names:
 x=json.loads((base/'node_modules'/n/'package.json').read_text());y=json.loads((fresh/'node_modules'/n/'package.json').read_text())
 for section in ['dependencies','optionalDependencies','peerDependencies']:
  ext=lambda q:{k:v for k,v in q.get(section,{}).items() if not k.startswith('@paperclipai/') and k!='paperclipai'}
  assert ext(x)==ext(y),(n,section)
 assert x.get('bin')==y.get('bin'),n
stage.mkdir(mode=0o700);subprocess.run(['cp','-a','--reflink=auto',str(base),str(payload)],check=True)
for n in names:
 a=payload/'node_modules'/n;b=fresh/'node_modules'/n
 for p in list(a.iterdir()):
  if p.name=='node_modules':continue
  if p.is_dir() and not p.is_symlink():shutil.rmtree(p)
  else:p.unlink()
 for p in b.iterdir():
  if p.name=='node_modules':continue
  target=a/p.name
  if p.is_symlink():target.symlink_to(os.readlink(p),target_is_directory=p.is_dir())
  elif p.is_dir():shutil.copytree(p,target,symlinks=True,copy_function=shutil.copy2)
  else:shutil.copy2(p,target)
def entries(where,kind):
 out=[]
 for p in sorted(where.rglob('*')):
  rel=pathlib.PurePosixPath(str(p.relative_to(where)))
  is_owned=any(rel.is_relative_to(a) and (len(rel.parts)==len(a.parts) or rel.parts[len(a.parts)]!='node_modules') for a in owned)
  if str(rel) in {'package.json','package-lock.json','node_modules/.package-lock.json'}:continue
  # Owner-root directories retain baseline ownership/mode; compare application contents below them.
  if rel in owned:continue
  if is_owned!=(kind=='application'):continue
  st=p.lstat();r={'path':str(rel),'mode':stat.S_IMODE(st.st_mode)}
  if p.is_symlink():r.update(type='symlink',target=os.readlink(p))
  elif p.is_file():r.update(type='file',sha256=digest(p),bytes=st.st_size)
  elif p.is_dir():r.update(type='directory')
  else:raise RuntimeError('Special file '+str(p))
  out.append(r)
 return out
assert entries(base,'external')==entries(payload,'external'),'External dependency bytes or modes changed'
assert entries(fresh,'application')==entries(payload,'application'),'Application package content differs from exact hosted build'
root_manifest={'name':'paperclip-controlled-maintenance-payload','version':'0.0.0','private':True,'description':'Immutable offline payload. Regenerate using the checksummed assembly recipe and input artifacts; do not npm install in place.','dependencies':{n:json.loads((payload/'node_modules'/n/'package.json').read_text())['version'] for n in names}}
(payload/'package.json').write_text(json.dumps(root_manifest,indent=2)+'\n')
lock=old_lock;lock['name']=root_manifest['name'];lock['version']=root_manifest['version'];lock['packages']['']=root_manifest
for key in sorted(internal_paths):
 e=dict(new_lock['packages'][key]);e.pop('resolved',None);e.pop('integrity',None);e['paperclipSourceCommit']=sha;lock['packages'][key]=e
lock['paperclipRelease']={'source':sha,'applicationBuildArtifactSha256':'1589ca9b3fdcbf8b6f577542d417d87ea3c3895a47f62db503c9ece494ae5404','externalDependencyBaselineArchiveSha256':snapshot['archiveSha256'],'regeneration':'pin-baseline-runtime.py with the two immutable inputs; workspace registry integrities intentionally replaced by exact source provenance'}
(payload/'package-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
hidden=payload/'node_modules/.package-lock.json'
if hidden.exists():
 j=json.loads(hidden.read_text())
 for key in internal_paths:
  if key in j['packages']:j['packages'][key]=lock['packages'][key]
 hidden.write_text(json.dumps(j,indent=2)+'\n')
application=entries(payload,'application');external=entries(payload,'external');(public/'pinned-application-files.json').write_text(json.dumps(application,indent=2))
canonical=lambda x:hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
result={'source':sha,'applicationPackages':names,'applicationContentMatchesHostedBuild':True,'applicationFileEntries':len(application),'applicationManifestSha256':canonical(application),'externalDependencyContractUnchanged':True,'externalDependencyContentMatchesRetainedBaseline':True,'externalFileEntries':len(external),'externalManifestSha256':canonical(external),'externalDependencyVersionUpdates':0,'allWorkspacePackagesRebuilt':True,'baselineArchiveSha256':snapshot['archiveSha256'],'hostedApplicationArchiveSha256':'1589ca9b3fdcbf8b6f577542d417d87ea3c3895a47f62db503c9ece494ae5404','assemblyRecipeSha256':digest(pathlib.Path(__file__)),'lockNote':lock['paperclipRelease']['regeneration'],'compilerOrModelExecutedDuringAssembly':False}
(stage/'package-provenance.json').write_text(json.dumps(result,indent=2)+'\n')
archive=public/'paperclip-maintenance-pinned-linux-x64.tar.gz'
subprocess.run(['nice','-n','15','tar','--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-I','gzip -n -6','-cf',str(archive),'-C',str(stage),'payload','package-provenance.json'],check=True)
result.update(artifact=str(archive),artifactSha256=digest(archive),artifactBytes=archive.stat().st_size,payload=str(payload),installedLockSha256=digest(payload/'package-lock.json'))
(public/'pinned-artifact-evidence.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
