//! Opt-in qualification observation. The external guardian owns only an OUTER
//! Job. The real helper is the sole inner-Job owner; that handle is never sent,
//! duplicated, queried by the guardian, or confused with the outer-superset proof.
use crate::{protocol::{self,Owner,LaunchSpec},windows::{self,Job,OwnedChild,ExactProcess}};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::BTreeMap,fs::File,io::{self,Read,Write},mem::{size_of,zeroed},os::windows::io::{AsRawHandle,FromRawHandle},ptr::{null,null_mut},sync::{Arc,Mutex,mpsc},time::{Duration,Instant}};
use windows_sys::Win32::{Foundation::*,Security::{SECURITY_ATTRIBUTES,Authorization::*,Cryptography::*},Storage::FileSystem::*,System::{Pipes::*,Threading::*}};

fn bad(message:&str)->io::Error{io::Error::other(message)}
fn check(value:i32)->io::Result<()>{if value==0{Err(io::Error::last_os_error())}else{Ok(())}}
fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain([0]).collect()}
pub fn read_value(reader:&mut impl Read)->io::Result<Option<Value>>{
    let mut header=[0u8;4];if reader.read(&mut header[..1])?==0{return Ok(None);}reader.read_exact(&mut header[1..])?;
    let length=u32::from_le_bytes(header) as usize;if length==0||length>protocol::MAX_FRAME{return Err(bad("invalid observation frame size"));}
    let mut bytes=vec![0;length];reader.read_exact(&mut bytes)?;let text=std::str::from_utf8(&bytes).map_err(io::Error::other)?;
    serde_json::from_str(text).map(Some).map_err(io::Error::other)
}
fn write_value(writer:&mut impl Write,value:&Value)->io::Result<()>{let bytes=serde_json::to_vec(value)?;if bytes.is_empty()||bytes.len()>protocol::MAX_FRAME{return Err(bad("observation frame too large"));}writer.write_all(&(bytes.len() as u32).to_le_bytes())?;writer.write_all(&bytes)?;writer.flush()}
fn timed_read(pipe:&File,end:Instant)->io::Result<Value>{let mut reader=pipe.try_clone()?;let(tx,rx)=mpsc::sync_channel(1);std::thread::spawn(move||{let _=tx.send(read_value(&mut reader));});rx.recv_timeout(end.saturating_duration_since(Instant::now())).map_err(|_|bad("rendezvous read timeout"))??.ok_or_else(||bad("rendezvous EOF"))}
fn parse_owner(value:&Value)->io::Result<Owner>{serde_json::from_value(json!({"runId":value["runId"],"generation":value["generation"],"actionId":value["actionId"],"role":value["role"]})).map_err(io::Error::other)}
fn strict_keys(value:&Value,keys:&[&str])->io::Result<()>{if value.as_object().is_none_or(|v|v.keys().any(|key|!keys.contains(&key.as_str()))){return Err(bad("unknown observation field"));}Ok(())}
fn raw_field(value:&Value,key:&str)->io::Result<usize>{value[key].as_str().and_then(|v|v.parse().ok()).filter(|v|*v!=0).ok_or_else(||bad("invalid transferred handle"))}
fn duplicate(source:&ExactProcess,raw:usize,rights:Option<u32>)->io::Result<usize>{unsafe{let mut target=null_mut();check(DuplicateHandle(source.raw() as HANDLE,raw as HANDLE,GetCurrentProcess(),&mut target,rights.unwrap_or(0),0,if rights.is_none(){DUPLICATE_SAME_ACCESS}else{0}))?;Ok(target as usize)}}
fn owned_file(raw:usize)->File{unsafe{File::from_raw_handle(raw as _)}}
fn random_nonce()->io::Result<String>{let mut bytes=[0;32];unsafe{if BCryptGenRandom(null_mut(),bytes.as_mut_ptr(),bytes.len() as u32,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0{return Err(bad("system random generator failed"));}}Ok(bytes.iter().map(|b|format!("{b:02x}")).collect())}
fn server(name:&str)->io::Result<File>{unsafe{
    // Protected owner/system DACL, first-instance binding, one client, local only,
    // and a random unguessable name. No rendezvous handle is inherited by a child.
    let mut descriptor=null_mut();check(ConvertStringSecurityDescriptorToSecurityDescriptorW(wide("D:P(A;;GA;;;SY)(A;;GA;;;OW)").as_ptr(),SDDL_REVISION_1,&mut descriptor,null_mut()))?;
    let attrs=SECURITY_ATTRIBUTES{nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor:descriptor,bInheritHandle:0};
    let handle=CreateNamedPipeW(wide(name).as_ptr(),PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE,PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_NOWAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,0,&attrs);LocalFree(descriptor);
    if handle.is_null()||handle==INVALID_HANDLE_VALUE{return Err(io::Error::last_os_error());}Ok(owned_file(handle as usize))
}}
fn poll_accept(pipe:&File)->io::Result<Option<u32>>{unsafe{
    let connected=ConnectNamedPipe(pipe.as_raw_handle() as HANDLE,null_mut());let code=GetLastError();
        if connected!=0||code==ERROR_PIPE_CONNECTED{let mode=PIPE_WAIT|PIPE_READMODE_BYTE;check(SetNamedPipeHandleState(pipe.as_raw_handle() as HANDLE,&mode,null(),null()))?;let mut pid=0;check(GetNamedPipeClientProcessId(pipe.as_raw_handle() as HANDLE,&mut pid))?;return Ok(Some(pid));}
        if code!=ERROR_PIPE_LISTENING&&code!=ERROR_NO_DATA{return Err(io::Error::last_os_error());}Ok(None)
}}
pub struct HelperObservation{pub reader:Option<File>,writer:File}
impl HelperObservation{
    pub fn publish_members(&mut self,job:&Job,root:&OwnedChild)->io::Result<()>{let mut members=Vec::new();for pid in job.members()?{if pid!=root.pid{let process=ExactProcess::observe(pid)?;members.push(json!({"pid":pid,"creationIdentity":process.creation,"jobIdentity":format!("job:{}:{}",std::process::id(),root.creation)}));}}
        write_value(&mut self.writer,&json!({"type":"members","members":members}))
    }
    pub fn termination(&mut self,reason:&str,root_exited:bool)->io::Result<()>{write_value(&mut self.writer,&json!({"type":"termination","reason":reason,"rootAlreadyExited":root_exited}))}
}
pub fn helper_handoff(child:&mut OwnedChild,owner:&Owner,boundary_hash:&str)->io::Result<Option<HelperObservation>>{
    let args=std::env::args().skip(1).collect::<Vec<_>>();if args.is_empty(){return Ok(None);}if args.len()!=5||args[0]!="--qualification-handoff-v1"||!args[1].starts_with(r"\\.\pipe\")||args[2].len()!=64{return Err(bad("invalid helper observation mode"));}
    let guardian_pid:u32=args[3].parse().map_err(|_|bad("invalid guardian identity"))?;let guardian=ExactProcess::observe(guardian_pid)?;
    let end=Instant::now()+Duration::from_secs(10);let pipe=loop{unsafe{let raw=CreateFileW(wide(&args[1]).as_ptr(),GENERIC_READ|GENERIC_WRITE,0,null(),OPEN_EXISTING,0,null_mut());if raw!=INVALID_HANDLE_VALUE{break owned_file(raw as usize);}}
        if Instant::now()>=end{return Err(bad("guardian rendezvous unavailable"));}std::thread::sleep(Duration::from_millis(10));};
    unsafe{let mut actual=0;check(GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE,&mut actual))?;if actual!=guardian.pid{return Err(bad("guardian server identity mismatch"));}}
    if guardian.creation!=args[4]{return Err(bad("guardian creation identity mismatch"));}
    let mut writer=pipe.try_clone()?;let inner=format!("job:{}:{}",std::process::id(),child.creation);
    write_value(&mut writer,&json!({"type":"offer","nonce":args[2],"owner":owner,"boundaryHash":boundary_hash,"helperCreationIdentity":windows::helper_creation_identity()?,"root":{"pid":child.pid,"creationIdentity":child.creation},"innerJobIdentity":inner,
        "stdout":(child.stdout.as_ref().ok_or_else(||bad("stdout missing"))?.as_raw_handle() as usize).to_string(),"stderr":(child.stderr.as_ref().ok_or_else(||bad("stderr missing"))?.as_raw_handle() as usize).to_string(),"process":child.process_raw().to_string()}))?;
    if timed_read(&pipe,end)?["type"]!="taken"{return Err(bad("guardian transfer refused"));}
    // Guardian has duplicated the READ handles. Close both local copies before
    // sending closed and awaiting the final acknowledgment. Never tee/compete.
    drop(child.stdout.take());drop(child.stderr.take());write_value(&mut writer,&json!({"type":"closed"}))?;
    if timed_read(&pipe,end)?["type"]!="armed"{return Err(bad("guardian handoff not acknowledged"));}
    Ok(Some(HelperObservation{reader:Some(pipe),writer}))
}

#[derive(Deserialize,Serialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Identity{pid:u32,creation_identity:String}
#[derive(Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]struct Unrelated{pid:u32,creation_identity:String,name:String}
struct StreamCapture{bytes:u64,data:Vec<u8>,eof:u32}
struct Capture{streams:BTreeMap<(&'static str,&'static str),StreamCapture>,total:u64,limit:usize,retained:usize,overflow:bool,reader_failure:bool}
impl Capture{
    fn new(limit:usize)->Self{Self{streams:[("root","stdout"),("root","stderr"),("controller","stdout"),("controller","stderr")].into_iter().map(|key|(key,StreamCapture{bytes:0,data:Vec::new(),eof:0})).collect(),total:0,limit,retained:0,overflow:false,reader_failure:false}}
    fn record(&mut self,source:&'static str,stream:&'static str,bytes:&[u8]){self.total+=bytes.len() as u64;let take=bytes.len().min(self.limit.saturating_sub(self.retained));let state=self.streams.get_mut(&(source,stream)).unwrap();state.bytes+=bytes.len() as u64;state.data.extend_from_slice(&bytes[..take]);self.retained+=take;if take!=bytes.len(){self.overflow=true;}}
    fn complete(&self)->bool{!self.overflow&&!self.reader_failure&&self.streams.values().all(|s|s.eof==1)}
    fn streams(&self)->Vec<Value>{self.streams.iter().map(|((source,stream),v)|json!({"source":source,"stream":stream,"bytes":v.bytes,"eofCount":v.eof})).collect()}
    fn page(&self,offset:usize)->Value{let mut skip=offset;let mut remaining=262144usize;let mut consumed=0;let streams=self.streams.iter().map(|((source,stream),v)|{let start=skip.min(v.data.len());skip-=start;let take=(v.data.len()-start).min(remaining);remaining-=take;consumed+=take;json!({"source":source,"stream":stream,"bytes":v.bytes,"eofCount":v.eof,"data":protocol::base64(&v.data[start..start+take])})}).collect::<Vec<_>>();json!({"streams":streams,"totalBytes":self.total,"overflow":self.overflow,"readerFailure":self.reader_failure,"offset":offset,"nextOffset":if offset+consumed<self.retained{Some(offset+consumed)}else{None}})}
}
fn message(owner:&Owner,kind:&str,sequence:Option<u64>,value:Value)->Value{let mut frame=serde_json::to_value(owner).unwrap();let object=frame.as_object_mut().unwrap();object.insert("observationVersion".into(),1.into());object.insert("type".into(),kind.into());if let Some(sequence)=sequence{object.insert("sequence".into(),sequence.into());}object.insert("value".into(),value);frame}
fn reader(mut pipe:File,source:&'static str,stream:&'static str,capture:Arc<Mutex<Capture>>,output:mpsc::SyncSender<Value>,owner:Owner,remote:Option<mpsc::SyncSender<Value>>){std::thread::spawn(move||{
    let mut bytes=[0u8;16384];loop{match pipe.read(&mut bytes){Ok(0)=>{capture.lock().unwrap().streams.get_mut(&(source,stream)).unwrap().eof=1;if let Some(remote)=&remote{if matches!(remote.try_send(json!({"type":"outputEof","stream":stream})),Err(mpsc::TrySendError::Full(_))){capture.lock().unwrap().reader_failure=true;}}break;},Ok(count)=>{
        // Charge actual bytes before retaining, forwarding, projecting or discarding.
        capture.lock().unwrap().record(source,stream,&bytes[..count]);let mut frame=message(&owner,if source=="root"{"rawOutput"}else{"controllerOutput"},None,Value::Null);frame.as_object_mut().unwrap().remove("value");frame["data"]=protocol::base64(&bytes[..count]).into();frame["stream"]=stream.into();
        if output.try_send(frame).is_err(){capture.lock().unwrap().reader_failure=true;}
        if let Some(remote)=&remote{if matches!(remote.try_send(json!({"type":"output","stream":stream,"data":protocol::base64(&bytes[..count])})),Err(mpsc::TrySendError::Full(_))){capture.lock().unwrap().reader_failure=true;}}
    },Err(_)=>{capture.lock().unwrap().reader_failure=true;break;}}}
});}
fn wait_exact(process:&ExactProcess,end:Instant)->io::Result<()>{while !process.exited()?{if Instant::now()>=end{return Err(bad("exact process exit unobserved"));}std::thread::sleep(Duration::from_millis(10));}Ok(())}
fn terminal(owner:&Owner,description:&Value,root:&ExactProcess,helper:&ExactProcess,controller:&ExactProcess,outer:&Job,capture:&Arc<Mutex<Capture>>,trigger:&Value,emergency:bool,retired:bool,cause:&str,unrelated:&Option<(ExactProcess,String)>)->Value{
    let status=root.exit_code();let (code,root_error)=match status{Ok(value)=>(value,false),Err(_)=>(None,true)};let active=outer.active();let query_error=active.as_ref().err().map(ToString::to_string);let count=active.ok();let raw=capture.lock().unwrap();
    let root_bytes=raw.streams.iter().filter(|((source,_),_)|*source=="root").map(|(_,v)|v.bytes).sum();let controller_bytes=raw.streams.iter().filter(|((source,_),_)|*source=="controller").map(|(_,v)|v.bytes).sum();
    let meters=[root.meter("root",Some(root_bytes)),helper.meter("helper",None),controller.meter("controller",Some(controller_bytes)),ExactProcess::observe(std::process::id()).and_then(|p|p.meter("guardian",None))];let meter_error=meters.iter().any(Result::is_err);let meters=meters.into_iter().filter_map(Result::ok).collect::<Vec<_>>();
    let lifetime=|kind:&str|meters.iter().find(|v|v["kind"]==kind&&!v["exitedAt"].is_null()).and_then(|v|v["activeMs"].as_u64());let root_lifetime=lifetime("root");let helper_lifetime=lifetime("helper");
    let mut v=serde_json::to_value(owner).unwrap();v.as_object_mut().unwrap().extend(json!({"schemaVersion":1,"description":description,"processMeters":meters,"processMeterError":meter_error,"rootLifetimeMs":root_lifetime,"helperLifetimeMs":helper_lifetime,"rootExited":code.is_some(),"rootExitCode":code,"rootExitCause":if emergency{"emergency-cleanup"}else if root_error{"unknown"}else{cause},"helperExited":helper.exited().unwrap_or(false),"controllerExited":controller.exited().unwrap_or(false),"controllerExitCode":controller.exit_code().ok().flatten(),"outerActiveProcesses":count,"outerMembershipEmpty":count.map(|v|v==0),"outerQueryError":query_error,"proofMethod":"windows-outer-superset-v1","outputComplete":raw.complete(),"streams":raw.streams(),"totalRawBytes":raw.total,"overflow":raw.overflow,"readerFailure":raw.reader_failure,"emergencyTerminated":emergency,"controllerRetiredAfterHelperExit":retired,"trigger":trigger,
        "unrelated":unrelated.as_ref().map(|(p,name)|json!({"identity":p.identity(),"name":name,"alive":p.exited().map(|v|!v).unwrap_or(false),"outsideHierarchy":outer.contains(p).map(|v|!v).unwrap_or(false)})),"observedAt":crate::now_ms()}).as_object().unwrap().clone());v
}
pub fn run(args:&[String])->Result<(),Box<dyn std::error::Error>>{
    if args.len()!=1{return Err(bad("invalid guardian arguments").into());}
    let initial=read_value(&mut std::io::stdin().lock())?.ok_or_else(||bad("EOF before observation start"))?;
    strict_keys(&initial,&["observationVersion","runId","generation","actionId","role","type","controller","boundaryHash","rawOutputLimitBytes","unrelated"])?;
    if initial["observationVersion"]!=1||initial["type"]!="start"{return Err(bad("observation start required").into());}let owner=parse_owner(&initial)?;
    let mut spec:LaunchSpec=serde_json::from_value(initial["controller"].clone())?;spec.validate()?;
    let boundary=initial["boundaryHash"].as_str().filter(|s|s.len()==64&&s.bytes().all(|c|c.is_ascii_hexdigit())).ok_or_else(||bad("invalid observed boundary"))?;
    let limit=initial["rawOutputLimitBytes"].as_u64().filter(|v|*v>0&&*v<=10*1024*1024).ok_or_else(||bad("invalid capture limit"))? as usize;
    let deadline=Instant::now()+Duration::from_millis(spec.deadline.checked_sub(crate::now_ms()).filter(|v|*v>0).ok_or_else(||bad("expired observation"))?);
    let nonce=random_nonce()?;let name=format!(r"\\.\pipe\ouroboros-observation-{}-{}",std::process::id(),nonce);let mut rendezvous=server(&name)?;let guardian_creation=windows::helper_creation_identity()?;
    let outer=Job::new()?;let observer=ExactProcess::observe(std::process::id())?;if outer.contains(&observer)?{return Err(bad("guardian unexpectedly inside outer Job").into());}
    let unrelated=if initial["unrelated"].is_null(){None}else{let identity:Unrelated=serde_json::from_value(initial["unrelated"].clone())?;let exact=ExactProcess::observe(identity.pid)?;if exact.creation!=identity.creation_identity||exact.exited()?||!exact.image()?.rsplit(['\\','/']).next().is_some_and(|v|v.eq_ignore_ascii_case(&identity.name)){return Err(bad("unrelated exact identity mismatch").into());}Some((exact,identity.name))};
    for(key,value)in[("OUROBOROS_QUALIFICATION_RENDEZVOUS",name),("OUROBOROS_QUALIFICATION_NONCE",nonce.clone()),("OUROBOROS_QUALIFICATION_GUARDIAN_PID",std::process::id().to_string()),("OUROBOROS_QUALIFICATION_GUARDIAN_CREATION",guardian_creation.clone())]{if spec.env.keys().any(|k|k.eq_ignore_ascii_case(key)){return Err(bad("reserved guardian environment supplied").into());}spec.env.insert(key.into(),value);}
    let mut controller_child=outer.launch(&spec)?;let controller=controller_child.exact_process()?;let mut controller_pipe=controller_child.stdin.take().ok_or_else(||bad("controller requires piped stdin"))?;
    let capture=Arc::new(Mutex::new(Capture::new(limit)));let(output_tx,output_rx)=mpsc::sync_channel::<Value>(128);let(flush_tx,flush_rx)=mpsc::channel();
    let(controller_input_tx,controller_input_rx)=mpsc::sync_channel::<Option<Vec<u8>>>(16);let mut controller_input=Some(controller_input_tx);let input_capture=capture.clone();
    std::thread::spawn(move||{for bytes in controller_input_rx{match bytes{Some(bytes)=>if controller_pipe.write_all(&bytes).and_then(|_|controller_pipe.flush()).is_err(){input_capture.lock().unwrap().reader_failure=true;break;},None=>break,}}});
    std::thread::spawn(move||{let mut stdout=std::io::stdout().lock();for frame in output_rx{let closing=frame["type"]=="closed";if write_value(&mut stdout,&frame).is_err(){break;}if closing{let _=flush_tx.send(());}}});
    reader(controller_child.stdout.take().unwrap(),"controller","stdout",capture.clone(),output_tx.clone(),owner.clone(),None);reader(controller_child.stderr.take().unwrap(),"controller","stderr",capture.clone(),output_tx.clone(),owner.clone(),None);
    let(control_tx,control_rx)=mpsc::sync_channel(32);std::thread::spawn(move||{let mut stdin=std::io::stdin().lock();loop{let value=read_value(&mut stdin);let done=!matches!(value,Ok(Some(_)));if control_tx.send(value).is_err()||done{break;}}});
    let mut sequence=0;
    if Instant::now()>=deadline{return Err(bad("observation expired before controller resume").into());}
    controller_child.resume()?;
    output_tx.try_send(message(&owner,"started",None,json!({"schemaVersion":1,"runId":owner.run_id,"generation":owner.generation,"actionId":owner.action_id,"role":owner.role,"observer":observer.identity(),"controller":controller.identity(),"outerJobIdentity":format!("outer:{}:{}",std::process::id(),guardian_creation),"capturedAt":crate::now_ms()})))?;
    // The actual controller must first receive its launch RPC. Pump only its
    // bounded opaque channel while waiting for the helper's protected handoff.
    // Waiting for helper registration before servicing that channel deadlocks.
    let handoff_end=(Instant::now()+Duration::from_secs(15)).min(deadline);
    let helper_pid=loop{
        if let Some(pid)=poll_accept(&rendezvous)?{break pid;}
        if Instant::now()>=handoff_end{return Err(bad("helper handoff timeout").into());}
        let control=match control_rx.recv_timeout(Duration::from_millis(10)){Err(mpsc::RecvTimeoutError::Timeout)=>continue,Ok(Ok(Some(value)))=>value,_=>return Err(bad("controller channel lost before helper handoff").into())};
        strict_keys(&control,&["observationVersion","runId","generation","actionId","role","type","sequence","data"])?;
        if control["observationVersion"]!=1||parse_owner(&control)?!=owner{return Err(bad("startup control identity mismatch").into());}
        let next=control["sequence"].as_u64().filter(|v|*v>sequence&&*v<=9007199254740991).ok_or_else(||bad("stale startup control sequence"))?;sequence=next;
        match control["type"].as_str(){Some("controllerInput")=>{let bytes=control["data"].as_str().and_then(protocol::decode_base64).filter(|v|v.len()<=65536).ok_or_else(||bad("invalid startup controller input"))?;controller_input.as_ref().ok_or_else(||bad("controller input absent"))?.try_send(Some(bytes)).map_err(io::Error::other)?;output_tx.try_send(message(&owner,"ack",Some(next),Value::Null))?;},_=>{let mut frame=message(&owner,"error",Some(next),Value::Null);frame["message"]="helper handoff not established".into();output_tx.try_send(frame)?;}}
    };let offer=timed_read(&rendezvous,handoff_end)?;
    strict_keys(&offer,&["type","nonce","owner","boundaryHash","helperCreationIdentity","root","innerJobIdentity","stdout","stderr","process"])?;
    if offer["type"]!="offer"||offer["nonce"]!=nonce||offer["boundaryHash"]!=boundary||serde_json::from_value::<Owner>(offer["owner"].clone())?!=owner{return Err(bad("handoff binding mismatch").into());}
    let helper=ExactProcess::open(helper_pid,offer["helperCreationIdentity"].as_str().ok_or_else(||bad("helper creation missing"))?)?;
    if !outer.contains(&helper)?||windows::parent_pid(helper.pid)?!=controller.pid||!helper.image()?.eq_ignore_ascii_case(&std::env::current_exe()?.to_string_lossy()){return Err(bad("actual helper ancestry/image mismatch").into());}
    let root_identity:Identity=serde_json::from_value(offer["root"].clone())?;
    let root=ExactProcess::from_transferred(duplicate(&helper,raw_field(&offer,"process")?,Some(PROCESS_QUERY_LIMITED_INFORMATION|PROCESS_SYNCHRONIZE))?,root_identity.pid,&root_identity.creation_identity)?;
    if !outer.contains(&root)?||root.exited()?||windows::parent_pid(root.pid)?!=helper.pid{return Err(bad("root outer-subset assignment missing").into());}
    let stdout=owned_file(duplicate(&helper,raw_field(&offer,"stdout")?,None)?);let stderr=owned_file(duplicate(&helper,raw_field(&offer,"stderr")?,None)?);
    write_value(&mut rendezvous,&json!({"type":"taken"}))?;if timed_read(&rendezvous,handoff_end)?!=json!({"type":"closed"}){return Err(bad("helper read-copy closure missing").into());}
    let inner=offer["innerJobIdentity"].as_str().ok_or_else(||bad("inner Job identity missing"))?;if inner!=format!("job:{}:{}",helper.pid,root.creation){return Err(bad("inner Job binding mismatch").into());}
    let(remote_tx,remote_rx)=mpsc::sync_channel::<Value>(128);let mut remote_writer=rendezvous.try_clone()?;let captured_at=crate::now_ms();
    write_value(&mut rendezvous,&json!({"type":"armed"}))?;
    std::thread::spawn(move||{for frame in remote_rx{if write_value(&mut remote_writer,&frame).is_err(){break;}}});
    reader(stdout,"root","stdout",capture.clone(),output_tx.clone(),owner.clone(),Some(remote_tx.clone()));reader(stderr,"root","stderr",capture.clone(),output_tx.clone(),owner.clone(),Some(remote_tx));
    let(helper_tx,helper_rx)=mpsc::sync_channel(32);std::thread::spawn(move||{while let Ok(Some(value))=read_value(&mut rendezvous){if helper_tx.try_send(value).is_err(){break;}}});
    let mut description=json!({"schemaVersion":1,"runId":owner.run_id,"generation":owner.generation,"actionId":owner.action_id,"role":owner.role,"boundaryHash":boundary,"observer":{"pid":std::process::id(),"creationIdentity":guardian_creation},"controller":controller.identity(),"helper":helper.identity(),"root":root.identity(),"outerJobIdentity":format!("outer:{}:{}",std::process::id(),guardian_creation),"innerJobIdentity":inner,"proofMethod":"windows-outer-superset-v1","nestedSubsetEstablished":true,"assignedBeforeResume":true,"handoffBeforeResume":true,"helperOwnsOnlyInnerJobHandle":true,"capturedAt":captured_at,"descendants":[]});
    let mut trigger=Value::Null;let mut emergency=false;let mut retired=false;let mut cause="unknown".to_string();let mut pending_terminal:Option<(u64,Instant)>=None;let mut terminal_observed=false;let mut cleaned=false;
    loop{
        while let Ok(event)=helper_rx.try_recv(){match event["type"].as_str(){Some("members")=>{if let Some(members)=event["members"].as_array(){let mut accepted=Vec::new();for member in members{if member["jobIdentity"]!=inner{continue;}if let Ok(id)=serde_json::from_value::<Identity>(json!({"pid":member["pid"],"creationIdentity":member["creationIdentity"]})){if let Ok(exact)=ExactProcess::observe(id.pid){if exact.creation==id.creation_identity&&outer.contains(&exact).unwrap_or(false){accepted.push(member.clone());}}}}description["descendants"]=accepted.into();}},Some("termination")=>{if event["rootAlreadyExited"]==true&&event["reason"]=="root_exit"{cause="natural".into();}else if trigger.is_null(){cause="supervisor-drain".into();}},_=>{}}
        }
        if let Some((seq,end))=pending_terminal{let value=terminal(&owner,&description,&root,&helper,&controller,&outer,&capture,&trigger,emergency,retired,&cause,&unrelated);if (value["rootExited"]==true&&value["outerMembershipEmpty"]==true&&capture.lock().unwrap().streams.values().all(|s|s.eof==1))||Instant::now()>=end{output_tx.try_send(message(&owner,"terminal",Some(seq),value))?;pending_terminal=None;terminal_observed=true;}}
        if Instant::now()>=deadline{if outer.active().ok()!=Some(0){emergency=true;let _=outer.terminate();}return Err(bad("guardian deadline expired; fallback containment").into());}
        let control=match control_rx.recv_timeout(Duration::from_millis(10)){Err(mpsc::RecvTimeoutError::Timeout)=>continue,Err(_)|Ok(Ok(None))=>{if outer.active().ok()!=Some(0){let _=outer.terminate();}return Ok(());},Ok(Err(error))=>{let _=outer.terminate();return Err(error.into());},Ok(Ok(Some(value)))=>value};
        strict_keys(&control,&["observationVersion","runId","generation","actionId","role","type","sequence","target","timeoutMs","offset","data","reason"])?;
        if control["observationVersion"]!=1||parse_owner(&control)?!=owner{return Err(bad("observer control identity mismatch").into());}
        let next=control["sequence"].as_u64().filter(|v|*v>sequence&&*v<=9007199254740991).ok_or_else(||bad("stale observation sequence"))?;sequence=next;
        let kind=control["type"].as_str().ok_or_else(||bad("missing observer operation"))?;
        let result:io::Result<Option<(&str,Value)>>=(||{Ok(Some(match kind{
            "describeObservedExecution"=>("described",description.clone()),
            "triggerDeath"=>{if !trigger.is_null(){return Err(bad("death already triggered"));}let target=&control["target"];strict_keys(target,&["kind","identity"])?;let target_kind=target["kind"].as_str().ok_or_else(||bad("invalid death target"))?;let exact=match target_kind{"helper"=>&helper,"controller"=>&controller,_=>return Err(bad("death target not allowed"))};if target["identity"]!=exact.identity(){return Err(bad("exact death target mismatch"));}if root.exited()?{return Err(bad("root already exited before death trigger"));}if exact.exited()?{return Err(bad("death target already exited"));}let at=crate::now_ms();exact.terminate()?;wait_exact(exact,(Instant::now()+Duration::from_secs(5)).min(deadline))?;let exited_at=crate::now_ms();if target_kind=="helper"{cause="helper-job-close".into();if !controller.exited()?{controller.terminate()?;wait_exact(&controller,(Instant::now()+Duration::from_secs(5)).min(deadline))?;}retired=true;}else{cause="controller-eof".into();}trigger=json!({"target":target,"triggeredAt":at,"targetExited":true,"targetExitedAt":exited_at});("triggered",trigger.clone())},
            "observeTerminal"=>{if pending_terminal.is_some(){return Err(bad("terminal observation already pending"));}let timeout=control["timeoutMs"].as_u64().filter(|v|*v>0&&*v<=60000).ok_or_else(||bad("invalid terminal timeout"))?;pending_terminal=Some((next,(Instant::now()+Duration::from_millis(timeout)).min(deadline)));return Ok(None);},
            "readCapturedOutput"=>{let offset=control["offset"].as_u64().unwrap_or(0) as usize;("captured",capture.lock().unwrap().page(offset))},
            "controllerInput"=>{let bytes=control["data"].as_str().and_then(protocol::decode_base64).filter(|v|v.len()<=65536).ok_or_else(||bad("invalid controller input"))?;controller_input.as_ref().ok_or_else(||bad("controller input closed"))?.try_send(Some(bytes)).map_err(io::Error::other)?;("ack",Value::Null)},
            "controllerEnd"=>{controller_input.take();("ack",Value::Null)},
            "emergencyCleanup"=>{if control["reason"].as_str().is_none_or(|v|v.trim().is_empty()||v.len()>4096){return Err(bad("invalid cleanup reason"));}emergency=true;outer.terminate()?;cleaned=true;("cleaned",json!({"emergencyTerminated":true,"observedAt":crate::now_ms()}))},
            "close"=>{if !(terminal_observed&&outer.active()?==0&&capture.lock().unwrap().complete())&&!cleaned{return Err(bad("guardian close requires terminal reconciliation or emergency cleanup"));}output_tx.try_send(message(&owner,"closed",Some(next),Value::Null)).map_err(io::Error::other)?;flush_rx.recv_timeout(Duration::from_secs(1)).map_err(io::Error::other)?;return Ok(None);},
            _=>return Err(bad("observer operation not allowed")),
        }))})();
        match result{Ok(Some((response,value)))=>output_tx.try_send(message(&owner,response,Some(next),value))?,Ok(None)=>{if kind=="close"{return Ok(());}},Err(error)=>{let mut frame=message(&owner,"error",Some(next),Value::Null);frame["message"]=error.to_string().into();output_tx.try_send(frame)?;}}
    }
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn frame_and_capture_bounds_are_explicit(){let mut capture=Capture::new(3);capture.record("root","stdout",b"tail");assert!(capture.overflow);assert_eq!(capture.total,4);assert_eq!(capture.retained,3);assert!(!capture.complete());assert!(strict_keys(&json!({"pid":1}),&["kind"]).is_err());}
    #[test]fn missing_eof_and_query_unknown_are_not_empty(){let capture=Capture::new(10);assert!(!capture.complete());let mut malformed=&[0u8,0,0,0][..];assert!(read_value(&mut malformed).is_err());}
}
