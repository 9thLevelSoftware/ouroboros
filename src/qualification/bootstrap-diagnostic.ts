/** Untrusted bootstrap stderr -> bounded, typed diagnostic facts. This is a
 * deliberately small catalog, not a general log sanitizer. Unsupported frames
 * are withheld in their entirety. Provenance proves identity, never policy. */
export const BOOTSTRAP_DIAGNOSTIC_PARSER_VERSION='bootstrap-diagnostic/1' as const;
export const BOOTSTRAP_DIAGNOSTIC_CATALOG_VERSION='codex-0.162.1/structural-1' as const;
const SOURCE_HASH='7933a70506e753a6e98c16800d2a76770b2af2b7295491f8f0b8e713e952027e' as const;
const SOURCE_COMMIT='092d3acd6bec3e3a14bdc7e7a2810ab628ab759d' as const;
export type DiagnosticInput={prefix:Uint8Array;totalBytes:number;streamHash:string;stream:'stderr';runtimeIdentity:string;streamIdentity:string;truncated:boolean;drainageComplete:boolean;approvedUnknownField?:string};
type ActualType='map'|'sequence'|'unit'|'boolean'|'integer'|'float'|'string'|'character'|'byte array';
type Primitive='sequence'|'map'|'string'|'boolean'|'integer'|'float'|'unit';
// These are schema positions verified against the pinned config.schema.json,
// not words that are permitted anywhere in a message. RawMcpServerConfig is
// the actual schema type; McpServerConfig is intentionally not inferred.
const schemaTypes=['RawMcpServerConfig','FilesystemPermissionToml','FilesystemPermissionsToml','PermissionProfileToml','NetworkToml','WindowsToml','ConfigToml','Tui'] as const;
type SchemaType=typeof schemaTypes[number];
const schemaFields=['command','url','enabled','filesystem','network','sandbox','model','default_permissions','workspace_roots'] as const;
type SchemaField=typeof schemaFields[number];
type ExpectedSchema={category:'primitive';name:Primitive}|{category:'struct'|'untagged-enum';name:SchemaType}|{category:'enum';name:'windows-sandbox'|'filesystem-access'|'sandbox-mode'}|{category:'field';name:SchemaField};
const paths=['windows.sandbox','mcp_servers.*','mcp_servers.*.enabled','mcp_servers.*.command','mcp_servers.*.url','mcp_servers.*.env','mcp_servers.*.env.*','mcp_servers.*.http_headers','mcp_servers.*.http_headers.*','permissions.*','permissions.*.filesystem','permissions.*.filesystem.*','permissions.*.filesystem.*.*','permissions.*.network','permissions.*.workspace_roots','tui.keymap.editor.insert_newline'] as const;
type SchemaPath=typeof paths[number];
type Kind='invalid-type'|'invalid-value'|'unknown-variant'|'unknown-field'|'duplicate-field'|'missing-field'|'untagged-enum'|'load-configuration'|'load-bootstrap-configuration'|'sandbox-default-permissions-conflict'|'profile-default-permissions-conflict'|'unsupported-strict-config-argument';
type Provenance={parserVersion:typeof BOOTSTRAP_DIAGNOSTIC_PARSER_VERSION;catalogVersion:typeof BOOTSTRAP_DIAGNOSTIC_CATALOG_VERSION;sourceHash:typeof SOURCE_HASH;sourceCommit:typeof SOURCE_COMMIT;streamHash:string|null;totalBytes:number|null;runtimeIdentity:string|null;streamIdentity:string|null;semantics:'diagnostic-only'};
type Flags={provenance:Provenance;truncated:boolean;invalidUtf8:boolean;redactionApplied:boolean;unsupportedContent:boolean};
export type SafeBootstrapDiagnostic=Flags&({status:'recognized';kind:Kind;actualType?:ActualType;expected?:ExpectedSchema;schemaPath?:SchemaPath;location?:{line:number;column:number};matchesApprovedUnknownField?:boolean}|{status:'withheld';reason:'empty'|'invalid-input'|'invalid-utf8'|'controls'|'truncated'|'incomplete-stream'|'unsupported-frame'});
type Facts={kind:Kind;actualType?:ActualType;expected?:ExpectedSchema;schemaPath?:SchemaPath;location?:{line:number;column:number};matchesApprovedUnknownField?:boolean;redactionApplied:boolean};
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const includes=<T extends string>(values:readonly T[],value:string):value is T=>values.includes(value as T);

/** Cursor ownership matters: quoted contents are consumed as one opaque token.
 * Neither commas nor embedded newlines within them can start another slot. */
class Cursor{
 index=0;
 readonly text:string;
 constructor(text:string){this.text=text;}
 take(value:string){if(!this.text.startsWith(value,this.index))return false;this.index+=value.length;return true;}
 token(pattern:RegExp){const match=pattern.exec(this.text.slice(this.index));if(!match)return undefined;this.index+=match[0].length;return match[0];}
 quoted():{value:string;escaped:boolean}|undefined{
  const delimiter=this.text[this.index];if(!['"',"'",'`'].includes(delimiter))return undefined;
  const start=++this.index;let escaped=false;
  while(this.index<this.text.length){const c=this.text[this.index++];if(c===delimiter)return {value:this.text.slice(start,this.index-1),escaped};if(c==='\\'){escaped=true;if(this.index===this.text.length)return undefined;this.index++;}}
  return undefined;
 }
 get rest(){return this.text.slice(this.index);}
}
function expected(cursor:Cursor):ExpectedSchema|undefined{
 const primitive=cursor.token(/^(?:a sequence|a map|a string|a boolean|an integer|a float|unit)(?=$|\n| in `)/);
 if(primitive)return {category:'primitive',name:primitive.replace(/^(?:a|an) /,'') as Primitive};
 const category=cursor.take('struct ')?'struct':cursor.take('untagged enum ')?'untagged-enum':undefined;
 if(category){const name=cursor.token(/^[A-Za-z_][A-Za-z0-9_]*/);return name&&includes(schemaTypes,name)?{category,name}:undefined;}
 // Serde expected enum lists are accepted only as complete pinned lists. No
 // actual scalar/variant text participates in this catalog lookup.
 const enums=[['`elevated`, `unelevated`, or `mxc`','windows-sandbox'],['`read`, `write`, or `deny`','filesystem-access'],['`read-only`, `workspace-write`, or `danger-full-access`','sandbox-mode']] as const;
 for(const [template,name] of enums)if(cursor.take(template))return {category:'enum',name};
 return undefined;
}
function contextPath(cursor:Cursor):SchemaPath|undefined{
 if(!cursor.take('`'))return undefined;
 const segments:string[]=[];
 while(true){
  let segment:string|undefined;
  if(cursor.rest.startsWith('"')||cursor.rest.startsWith("'")){const quoted=cursor.quoted();if(!quoted)return undefined;segment=quoted.value;}
  else segment=cursor.token(/^[A-Za-z_][A-Za-z0-9_-]*/);
  if(segment===undefined)return undefined;segments.push(segment);
  if(cursor.take('`'))break;if(!cursor.take('.'))return undefined;
 }
 const root=segments[0];
 // Dynamic namespaces lose their keys before any catalog test, even if a key
 // is spelled exactly like a public schema field. Map descendants stay maps.
 if(root==='mcp_servers'&&segments.length>=2){segments[1]='*';if(['env','http_headers'].includes(segments[2])&&segments.length>=4)segments[3]='*';}
 if(root==='permissions'&&segments.length>=2){segments[1]='*';if(segments[2]==='filesystem')for(let i=3;i<segments.length;i++)segments[i]='*';}
 const path=segments.join('.');return includes(paths,path)?path:undefined;
}
function parseFrame(text:string,approvedUnknownField:string|undefined):Facts|undefined{
 const cursor=new Cursor(text);let location:Facts['location'],redactionApplied=false;
 cursor.take('Error: ')||cursor.take('error: ');
 if(cursor.take('failed to load bootstrap configuration')){if(!cursor.rest)return {kind:'load-bootstrap-configuration',redactionApplied:false};if(!(cursor.take(': ')||cursor.take('\n')))return undefined;}
 else if(cursor.take('failed to load configuration')){if(!cursor.rest)return {kind:'load-configuration',redactionApplied:false};if(!(cursor.take(': ')||cursor.take('\n')))return undefined;}
 cursor.take('Caused by:\n');
 const toml=/^TOML parse error at line ([1-9][0-9]{0,5}), column ([1-9][0-9]{0,5})\n/.exec(cursor.rest);
 if(toml){cursor.index+=toml[0].length;location={line:Number(toml[1]),column:Number(toml[2])};}
 // A Windows absolute path is an opaque prefix, never a source of schema
 // tokens. More exotic display names/paths are intentionally unsupported.
 const located=/^[A-Za-z]:\\[^\n\r:]*:([1-9][0-9]{0,5}):([1-9][0-9]{0,5}): /.exec(cursor.rest);
 if(located){if(location)return undefined;cursor.index+=located[0].length;location={line:Number(located[1]),column:Number(located[2])};redactionApplied=true;}
 let facts:Facts|undefined;
 const fixed=[['`sandbox_mode` and `default_permissions` overrides cannot both be set','sandbox-default-permissions-conflict'],['`permission_profile` and `default_permissions` overrides cannot both be set','profile-default-permissions-conflict'],["unexpected argument '--strict-config' found",'unsupported-strict-config-argument']] as const;
 for(const [template,kind] of fixed)if(cursor.take(template)){facts={kind,redactionApplied};break;}
 if(!facts){
  const kind=cursor.take('invalid type: ')?'invalid-type':cursor.take('invalid value: ')?'invalid-value':undefined;
  if(kind){
   const actualType=cursor.token(/^(?:byte array|map|sequence|unit|boolean|integer|float|string|character)(?= |,)/) as ActualType|undefined;
   if(!actualType)return undefined;
   if(cursor.take(' ')){if(['map','sequence','unit'].includes(actualType)||!cursor.quoted())return undefined;redactionApplied=true;}
   if(!cursor.take(', expected '))return undefined;const schema=expected(cursor);if(!schema)return undefined;
   facts={kind,actualType,expected:schema,redactionApplied};
  }
 }
 if(!facts&&cursor.take('data did not match any variant of untagged enum ')){
  const name=cursor.token(/^[A-Za-z_][A-Za-z0-9_]*/);if(!name||!includes(schemaTypes,name))return undefined;
  facts={kind:'untagged-enum',expected:{category:'untagged-enum',name},redactionApplied};
 }
 if(!facts&&cursor.take('unknown variant ')){
  if(!cursor.rest.startsWith('`')||!cursor.quoted()||!cursor.take(', expected '))return undefined;
  const schema=expected(cursor);if(schema?.category!=='enum')return undefined;facts={kind:'unknown-variant',expected:schema,redactionApplied:true};
 }
 if(!facts){
  const kind=cursor.take('unknown configuration field ')?'unknown-field':cursor.take('unknown field ')?'unknown-field':cursor.take('duplicate field ')?'duplicate-field':cursor.take('missing field ')?'missing-field':undefined;
  if(kind){
   if(!cursor.rest.startsWith('`'))return undefined;const field=cursor.quoted();if(!field||field.escaped||/[\n\r]/.test(field.value))return undefined;
   if(kind==='missing-field'){if(!includes(schemaFields,field.value))return undefined;facts={kind,expected:{category:'field',name:field.value},redactionApplied};}
   else{
    // strict_config.rs:158-165 renders a raw joined key inside backticks,
    // without escaping embedded backticks. Its complete producer grammar ends
    // immediately after that key. The related serde unknown/duplicate-key
    // forms are likewise accepted only without any suffix. Otherwise an
    // attacker-controlled key could manufacture a context and impersonate the
    // controller-owned approved field by closing the first backtick early.
    // Do not let these raw-key forms reach the shared optional-context parser.
    if(cursor.rest)return undefined;
    facts={kind,redactionApplied:true,...(kind==='unknown-field'&&approvedUnknownField!==undefined?{matchesApprovedUnknownField:field.value===approvedUnknownField}:{})};
   }
  }
 }
 if(!facts)return undefined;
 if(cursor.take('\nin ')||cursor.take(' in ')){const schemaPath=contextPath(cursor);if(!schemaPath)return undefined;facts.schemaPath=schemaPath;facts.redactionApplied=true;}
 if(cursor.rest)return undefined;
 return {...facts,...(location?{location}:{})};
}
export function projectBootstrapDiagnostic(input:DiagnosticInput):SafeBootstrapDiagnostic{
 const provenance:Provenance={parserVersion:BOOTSTRAP_DIAGNOSTIC_PARSER_VERSION,catalogVersion:BOOTSTRAP_DIAGNOSTIC_CATALOG_VERSION,sourceHash:SOURCE_HASH,sourceCommit:SOURCE_COMMIT,streamHash:isHash(input.streamHash)?input.streamHash:null,totalBytes:Number.isSafeInteger(input.totalBytes)&&input.totalBytes>=0?input.totalBytes:null,runtimeIdentity:isHash(input.runtimeIdentity)?input.runtimeIdentity:null,streamIdentity:isHash(input.streamIdentity)?input.streamIdentity:null,semantics:'diagnostic-only'};
 const flags={provenance,truncated:input.truncated===true,invalidUtf8:false,redactionApplied:true,unsupportedContent:true};
 const withheld=(reason:Extract<SafeBootstrapDiagnostic,{status:'withheld'}>['reason']):SafeBootstrapDiagnostic=>({...flags,status:'withheld',reason});
 if(!(input.prefix instanceof Uint8Array)||input.prefix.length>8192||provenance.totalBytes===null||input.totalBytes<input.prefix.length||!isHash(input.streamHash)||!isHash(input.runtimeIdentity)||!isHash(input.streamIdentity)||input.stream!=='stderr'||typeof input.truncated!=='boolean'||typeof input.drainageComplete!=='boolean'||(input.approvedUnknownField!==undefined&&!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(input.approvedUnknownField)))return withheld('invalid-input');
 if(input.truncated||input.totalBytes>input.prefix.length){flags.truncated=true;return withheld('truncated');}
 if(!input.drainageComplete)return withheld('incomplete-stream');
 if(!input.totalBytes)return withheld('empty');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input.prefix);}catch{flags.invalidUtf8=true;return withheld('invalid-utf8');}
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))return withheld('controls');
 text=text.replace(/\r\n/g,'\n');if(text.endsWith('\n'))text=text.slice(0,-1);
 const facts=parseFrame(text,input.approvedUnknownField);return facts?{...flags,...facts,status:'recognized',unsupportedContent:false}:withheld('unsupported-frame');
}

/** Compatibility rendering uses exclusively constants and validated fields. */
export function renderBootstrapDiagnostic(result:SafeBootstrapDiagnostic):string{
 if(result.status==='withheld')return result.reason==='empty'?'':'[stderr withheld]';
 const expected=result.expected;let description='';
 if(expected){if(expected.category==='primitive')description=expected.name==='integer'?'an integer':expected.name==='unit'?'unit':'a '+expected.name;
  else if(expected.category==='enum')description=({'windows-sandbox':'`elevated`, `unelevated`, or `mxc`','filesystem-access':'`read`, `write`, or `deny`','sandbox-mode':'`read-only`, `workspace-write`, or `danger-full-access`'} as const)[expected.name];
  else if(expected.category==='field')description='`'+expected.name+'`';else description=(expected.category==='struct'?'struct ':'untagged enum ')+expected.name;}
 const fixed:Partial<Record<Kind,string>>={'load-configuration':'failed to load configuration','load-bootstrap-configuration':'failed to load bootstrap configuration','sandbox-default-permissions-conflict':'`sandbox_mode` and `default_permissions` overrides cannot both be set','profile-default-permissions-conflict':'`permission_profile` and `default_permissions` overrides cannot both be set','unsupported-strict-config-argument':"unexpected argument '--strict-config' found"};
 let message=fixed[result.kind]??'';
 if(result.kind==='invalid-type'||result.kind==='invalid-value')message=(result.kind==='invalid-type'?'invalid type: ':'invalid value: ')+result.actualType+(result.actualType&&['map','sequence','unit'].includes(result.actualType)?'':' [redacted]')+', expected '+description;
 if(result.kind==='unknown-variant')message='unknown variant `[redacted]`, expected '+description;
 if(result.kind==='untagged-enum')message='data did not match any variant of '+description;
 if(result.kind==='missing-field')message='missing field '+description;
 if(result.kind==='unknown-field'||result.kind==='duplicate-field')message=(result.kind==='unknown-field'?'unknown field':'duplicate field')+' `[redacted]`';
 if(result.location)message='[config path]:'+result.location.line+':'+result.location.column+': '+message;
 if(result.schemaPath)message+='\nin `'+result.schemaPath+'`';
 return message.length<=4096?message:'[stderr withheld]';
}
