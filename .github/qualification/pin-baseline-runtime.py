"""Assemble an immutable complete release from verified baseline libraries and fully rebuilt application packages.
No compilation, npm resolution, production install-store access, or database access occurs here.
The resulting package lock records workspace provenance rather than old registry integrities.
Rebuild this payload using this recipe and the two checksummed input artifacts, not npm ci in place.
"""
import pathlib,json,hashlib,subprocess,shutil,os,stat,sys
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
if not stage.exists():
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
elif '--resume' not in sys.argv:raise RuntimeError('Existing staging directory: explicitly resume and reverify')
excluded={'package.json','package-lock.json','node_modules/.package-lock.json'}
owned_strings={str(p) for p in owned}
def app_path(rel):
 parts=rel.split('/')
 if len(parts)<2 or parts[0]!='node_modules':return False
 if parts[1]=='paperclipai':depth=2
 elif parts[1]=='@paperclipai' and len(parts)>2 and '/'.join(parts[:3]) in owned_strings:depth=3
 else:return False
 return len(parts)>depth and parts[depth]!='node_modules'
def entries(where,kind):
 out=[]
 def scan(directory,relative):
  with os.scandir(directory) as it:children=list(it)
  for e in children:
   rel=(relative+'/' if relative else '')+e.name
   if rel in excluded:continue
   st=e.stat(follow_symlinks=False)
   if kind=='external' and rel in owned_strings:
    nested=pathlib.Path(e.path)/'node_modules'
    if nested.is_dir():
     ns=nested.lstat();out.append({'path':rel+'/node_modules','mode':stat.S_IMODE(ns.st_mode),'type':'directory'});scan(nested,rel+'/node_modules')
    continue
   if kind=='application' and rel in owned_strings:
    with os.scandir(e.path) as inner: own_children=[i for i in inner if i.name!='node_modules']
    for child in own_children: add(child,rel+'/'+child.name)
    continue
   add(e,rel,st)
 def add(e,rel,st=None):
  st=st or e.stat(follow_symlinks=False);r={'path':rel,'mode':stat.S_IMODE(st.st_mode)}
  if stat.S_ISLNK(st.st_mode):r.update(type='symlink',target=os.readlink(e.path))
  elif stat.S_ISREG(st.st_mode):r.update(type='file',sha256=digest(pathlib.Path(e.path)),bytes=st.st_size)
  elif stat.S_ISDIR(st.st_mode):r.update(type='directory')
  else:raise RuntimeError('Special file '+e.path)
  out.append(r)
  if r['type']=='directory':scan(e.path,rel)
 if kind=='application':
  for rel in sorted(owned_strings):
   with os.scandir(where/rel) as it:children=[e for e in it if e.name!='node_modules']
   for e in children:add(e,rel+'/'+e.name)
 else:scan(where,'')
 return sorted(out,key=lambda r:tuple(r['path'].split('/')))
initial_file=pathlib.Path('/var/lib/paperclip-maintenance-20261030/baseline-files.json');assert digest(initial_file)==snapshot['manifestSha256']
expected_external=[]
for old in json.loads(initial_file.read_text()):
 rel=old['path']
 if rel in excluded or rel in owned_strings or app_path(rel):continue
 row={k:v for k,v in old.items() if k in {'path','mode','type','target','sha256'}}
 if old['type']=='file':row['bytes']=old['size']
 expected_external.append(row)
expected_external.sort(key=lambda r:tuple(r['path'].split('/')))
external=entries(payload,'external');assert external==expected_external,'External dependency bytes or modes differ from immutable snapshot'
application=entries(payload,'application');assert application==entries(fresh,'application'),'Application content differs from exact hosted build'
print('Verified retained external dependency contents and all rebuilt application content',flush=True)
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
(public/'pinned-application-files.json').write_text(json.dumps(application,indent=2))
canonical=lambda x:hashlib.sha256(json.dumps(x,sort_keys=True,separators=(',',':')).encode()).hexdigest()
result={'source':sha,'applicationPackages':names,'applicationContentMatchesHostedBuild':True,'applicationFileEntries':len(application),'applicationManifestSha256':canonical(application),'externalDependencyContractUnchanged':True,'externalDependencyContentMatchesRetainedBaseline':True,'externalFileEntries':len(external),'externalManifestSha256':canonical(external),'externalDependencyVersionUpdates':0,'allWorkspacePackagesRebuilt':True,'baselineArchiveSha256':snapshot['archiveSha256'],'hostedApplicationArchiveSha256':'1589ca9b3fdcbf8b6f577542d417d87ea3c3895a47f62db503c9ece494ae5404','assemblyRecipeSha256':digest(pathlib.Path(__file__)),'lockNote':lock['paperclipRelease']['regeneration'],'compilerOrModelExecutedDuringAssembly':False}
(stage/'package-provenance.json').write_text(json.dumps(result,indent=2)+'\n')
archive=public/'paperclip-maintenance-pinned-linux-x64.tar.gz'
subprocess.run(['nice','-n','15','tar','--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-I','gzip -n -6','-cf',str(archive),'-C',str(stage),'payload','package-provenance.json'],check=True)
result.update(artifact=str(archive),artifactSha256=digest(archive),artifactBytes=archive.stat().st_size,payload=str(payload),installedLockSha256=digest(payload/'package-lock.json'))
(public/'pinned-artifact-evidence.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
