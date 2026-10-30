"""Extract verified hosted application package content, not its floating external libraries."""
import pathlib,json,tarfile,hashlib,sys
public=pathlib.Path('/home/bobby/artifacts/paperclip-issue-containment-20261030');inputs=json.loads((public/'hosted-input.json').read_text())
archive=public/'deployable-artifact/paperclip-maintenance-linux-x64.tar.gz'
h=hashlib.sha256()
with archive.open('rb') as f:
 for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
assert h.hexdigest()==inputs['payloadSha256']
provenance=json.loads((public/'deployable-artifact/package-provenance.json').read_text());assert provenance['source']==inputs['release']
names=[x['name'] for x in provenance['workspacePackages']]+['paperclipai'];owned={'payload/node_modules/'+n for n in names}
root=pathlib.Path('/var/lib/paperclip-issue-containment-20261030/hosted-applications');root.mkdir(parents=True,mode=0o700,exist_ok=False)
def selected(name):
 if name in ['package-provenance.json','payload/package.json','payload/package-lock.json']:return True
 for owner in owned:
  if name==owner or name.startswith(owner+'/') and not name.startswith(owner+'/node_modules/') and name!=owner+'/node_modules':return True
 return False
with tarfile.open(archive,'r:gz') as t:
 for member in t:
  if not selected(member.name):continue
  rel=pathlib.PurePosixPath(member.name);assert not rel.is_absolute() and '..' not in rel.parts
  t.extract(member,root,filter='data')
print(json.dumps({'source':inputs['release'],'packageCount':len(names),'applicationRoot':str(root/'payload'),'externalLibrariesExtracted':False}))
