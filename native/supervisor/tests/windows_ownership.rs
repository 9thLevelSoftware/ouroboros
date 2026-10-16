#![cfg(windows)]
#[path = "../src/windows.rs"]
#[allow(dead_code)]
mod windows;
#[path = "../src/protocol.rs"]
#[allow(dead_code)]
mod protocol;

use serde_json::{Value, json};
use std::{collections::{BTreeMap,VecDeque}, io::{Read, Write}, ops::{Deref,DerefMut}, process::{Child, Command, Stdio}, sync::{mpsc, Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}, path::PathBuf};
use windows_sys::Win32::{Foundation::{CloseHandle, INVALID_HANDLE_VALUE, WAIT_TIMEOUT}, System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject}};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[test]
fn harness_matches_ack_and_output_in_either_order() {
    for ack_first in [true,false] {
        let (tx,rx)=mpsc::channel();
        let output=json!({"type":"output","stream":"stdout","data":protocol::base64(b"{\"inputEnded\":true}\n")});
        let ack=json!({"type":"ack","sequence":2,"operation":"endInput"});
        let stale=json!({"type":"ack","sequence":1,"operation":"input"});
        tx.send(ReaderEvent::Frame(stale)).unwrap();
        for msg in if ack_first {vec![ack,output]}else{vec![output,ack]} {tx.send(ReaderEvent::Frame(msg)).unwrap();}
        let transcript=std::sync::Arc::new(std::sync::Mutex::new(Transcript::default()));
        let mut inbox=EventInbox::new(rx,transcript);
        let ack=inbox.take(|msg|msg["type"]=="ack" && msg["sequence"]==2 && msg["operation"]=="endInput",Duration::from_millis(50)).unwrap();
        assert_eq!(ack["sequence"],2);
        assert_eq!(decode(&inbox.take(|msg|msg["type"]=="output",Duration::from_millis(50)).unwrap()).unwrap()["inputEnded"],true);
        assert_eq!(inbox.take(|msg|msg["sequence"]==1,Duration::from_millis(50)).unwrap()["operation"],"input");
    }
}
#[test]
fn harness_retains_terminal_diagnostics_and_eof_tails() {
    let (tx,rx)=mpsc::channel();let transcript=std::sync::Arc::new(std::sync::Mutex::new(Transcript::default()));
    let mut assembler=OutputAssembler::default();
    assert!(assembler.push(json!({"type":"output","stream":"stderr","data":protocol::base64(b"fixture startup failed without newline")})).unwrap().is_empty());
    for frame in assembler.finish() {tx.send(ReaderEvent::Frame(frame)).unwrap();}
    tx.send(ReaderEvent::Frame(json!({"type":"drained","evidence":{"reason":"root_exit"}}))).unwrap();tx.send(ReaderEvent::Eof).unwrap();
    let mut inbox=EventInbox::new(rx,transcript);
    let error=inbox.take(|msg|decode(msg).is_some_and(|body|body["descendantPid"].is_number()),Duration::from_millis(50)).unwrap_err();
    assert!(error.contains("root_exit"));assert!(error.contains("fixture startup failed without newline"));
    assert!(error.contains("EOF"));
}
#[test]
fn harness_guard_cleans_owned_fixture_on_unwind() {
    let dir=std::env::temp_dir().join(format!("ouroboros-guard-{}",std::process::id()));std::fs::create_dir_all(&dir).unwrap();
    let child=Command::new("node.exe").args(["-e","setInterval(()=>{},1000)"]).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let pid=child.id();
    // Keep an independent kernel handle for the assertion and emergency test cleanup.
    let handle=unsafe {OpenProcess(PROCESS_SYNCHRONIZE|windows_sys::Win32::System::Threading::PROCESS_TERMINATE|PROCESS_QUERY_LIMITED_INFORMATION,0,pid)};
    assert!(!handle.is_null());let creation=windows::creation_identity(handle).unwrap();
    let unwind=std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {let _guard=OwnedFixtureGuard::new(child);panic!("deliberate fixture unwind");}));
    let exited=unsafe {WaitForSingleObject(handle,5000)}==windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    if !exited {unsafe {windows_sys::Win32::System::Threading::TerminateProcess(handle,1);WaitForSingleObject(handle,5000);}}
    unsafe {CloseHandle(handle);}
    assert!(unwind.is_err());assert!(exited,"owned guard failed to terminate/wait PID {pid} creation {creation}");
}
struct OwnedFixtureGuard {child:Child}
impl OwnedFixtureGuard {fn new(child:Child)->Self {Self {child}}}
impl Deref for OwnedFixtureGuard {type Target=Child;fn deref(&self)->&Child {&self.child}}
impl DerefMut for OwnedFixtureGuard {fn deref_mut(&mut self)->&mut Child {&mut self.child}}
impl Drop for OwnedFixtureGuard {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        self.child.stdin.take();
        if !matches!(self.child.try_wait(),Ok(Some(_))) {let _=self.child.kill();}
        let wait=unsafe {WaitForSingleObject(self.child.as_raw_handle(),5000)};
        let status=self.child.try_wait();
        eprintln!("owned fixture cleanup pid={} wait={} status={status:?}",self.child.id(),wait);
    }
}
#[derive(Default)]
struct Transcript {entries:VecDeque<String>,bytes:usize}
impl Transcript {
    fn add(&mut self,text:String) {
        let text=if text.len()>4096 {format!("{} [truncated]",String::from_utf8_lossy(&text.as_bytes()[..4096]))}else{text};
        self.bytes+=text.len();self.entries.push_back(text);
        while self.bytes>32768 {if let Some(old)=self.entries.pop_front(){self.bytes-=old.len();}else{break;}}
    }
    fn frame(&mut self,msg:&Value) {
        if msg["type"]=="output" {
            let bytes=protocol::decode_base64(msg["data"].as_str().unwrap_or_default()).unwrap_or_default();
            let text=if let Ok(mut fixture)=serde_json::from_slice::<Value>(&bytes) {
                if let Some(object)=fixture.as_object_mut(){if object.remove("inputBase64").is_some(){object.insert("inputEcho".into(),"[payload omitted]".into());}}fixture.to_string()
            }else{String::from_utf8_lossy(&bytes).into_owned()};
            self.add(format!("child {}: {text}",msg["stream"]));
        }else{self.add(msg.to_string());}
    }
    fn text(&self)->String {self.entries.iter().cloned().collect::<Vec<_>>().join("\n")}
}
#[derive(Debug)]
enum ReaderEvent {Frame(Value),Eof,Fault(String)}
#[derive(Default)]
struct OutputAssembler {streams:BTreeMap<String,(Value,Vec<u8>)>}
impl OutputAssembler {
    fn push(&mut self,msg:Value)->Result<Vec<Value>,String> {
        let stream=msg["stream"].as_str().filter(|s|matches!(*s,"stdout"|"stderr")).ok_or("invalid output stream")?.to_string();
        let bytes=protocol::decode_base64(msg["data"].as_str().ok_or("missing output data")?).ok_or("invalid output base64")?;
        let (last,buffer)=self.streams.entry(stream).or_insert_with(||(msg.clone(),Vec::new()));*last=msg;
        if buffer.len()+bytes.len()>1024*1024 {return Err("fixture output line exceeded bound".into());}buffer.extend(bytes);
        let mut frames=Vec::new();
        while let Some(end)=buffer.iter().position(|b|*b==b'\n') {let line:Vec<_>=buffer.drain(..=end).collect();let mut frame=last.clone();frame["data"]=protocol::base64(&line).into();frames.push(frame);}
        Ok(frames)
    }
    fn finish(&mut self)->Vec<Value> {
        std::mem::take(&mut self.streams).into_values().filter_map(|(mut frame,bytes)|{if bytes.is_empty(){None}else{frame["data"]=protocol::base64(&bytes).into();Some(frame)}}).collect()
    }
}
struct EventInbox {rx:mpsc::Receiver<ReaderEvent>,pending:VecDeque<Value>,transcript:Arc<Mutex<Transcript>>,ended:bool}
impl EventInbox {
    fn new(rx:mpsc::Receiver<ReaderEvent>,transcript:Arc<Mutex<Transcript>>)->Self {Self {rx,pending:VecDeque::new(),transcript,ended:false}}
    fn ingest(&mut self,event:ReaderEvent)->Result<(),String> {
        match event {
            ReaderEvent::Frame(msg)=>{self.transcript.lock().unwrap().frame(&msg);if self.pending.len()>=128 {return Err("fixture pending-event bound exceeded".into());}self.pending.push_back(msg);},
            ReaderEvent::Eof=>{self.ended=true;self.transcript.lock().unwrap().add("reader EOF".into());},
            ReaderEvent::Fault(error)=>{self.ended=true;self.transcript.lock().unwrap().add(format!("reader error: {error}"));},
        }Ok(())
    }
    fn take(&mut self,predicate:impl Fn(&Value)->bool,timeout:Duration)->Result<Value,String> {
        let until=Instant::now()+timeout;
        loop {
            if let Some(index)=self.pending.iter().position(&predicate) {return Ok(self.pending.remove(index).unwrap());}
            if self.pending.iter().any(|msg|msg["type"]=="drained" || msg["type"]=="error") {
                // Collect late stderr/tails until EOF, retaining the original terminal failure.
                let tail_until=Instant::now()+Duration::from_millis(1500);
                while !self.ended {match self.rx.recv_timeout(tail_until.saturating_duration_since(Instant::now())) {Ok(event)=>{if self.ingest(event).is_err(){break;}},Err(_)=>break}}
                return Err(format!("unexpected terminal frame before expected fixture event\n{}",self.transcript.lock().unwrap().text()));
            }
            if self.ended {return Err(format!("fixture reader ended before expected event\n{}",self.transcript.lock().unwrap().text()));}
            match self.rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                Ok(event)=>{if let Err(error)=self.ingest(event){return Err(format!("{error}\n{}",self.transcript.lock().unwrap().text()));}},
                Err(error)=>return Err(format!("fixture event wait: {error}\n{}",self.transcript.lock().unwrap().text())),
            }
        }
    }
}
#[derive(Default)]
struct FinalCapture {stdout:Vec<u8>,stderr:Vec<u8>,terminal:bool,late_output:bool,eof:bool}
impl FinalCapture {
    fn frame(&mut self,msg:&Value)->Result<(),String> {
        if msg["type"]=="drained" {self.terminal=true;}
        if msg["type"]=="output" {
            self.late_output|=self.terminal;
            let bytes=protocol::decode_base64(msg["data"].as_str().ok_or("missing payload")?).ok_or("invalid payload")?;
            if self.stdout.len()+self.stderr.len()+bytes.len()>512*1024 {return Err("raw fixture output bound exceeded".into());}
            if msg["stream"]=="stdout" {self.stdout.extend(bytes);}else{self.stderr.extend(bytes);}
        }Ok(())
    }
}
struct Harness { helper: OwnedFixtureGuard, inbox:EventInbox, capture:Arc<Mutex<FinalCapture>>, root: PathBuf, descendant: PathBuf, spec: Value }
impl Harness {
    fn new(mode: &str, ttl: u64, args: &[&str]) -> Self {
        let dir = std::env::temp_dir().join(format!("ouroboros-owned-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("root.txt"); let descendant = dir.join("descendant.txt");
        let node = String::from_utf8(Command::new("where.exe").arg("node.exe").output().unwrap().stdout).unwrap().lines().next().unwrap().to_string();
        // Node's main-script resolution rejects the namespaced path returned by
        // canonicalize on this host (captured EISDIR/lstat D:). Preserve an
        // ordinary absolute fixture argument; this changes no production path policy.
        let fixture = std::path::absolute(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/support/heartbeat-child.mjs")).unwrap();
        assert!(fixture.is_absolute() && fixture.is_file(),"existing absolute fixture required");
        let mut argv = vec![fixture.to_string_lossy().to_string(), mode.to_string(), root.to_string_lossy().to_string(), descendant.to_string_lossy().to_string()];
        argv.extend(args.iter().map(|x| x.to_string()));
        let mut env: std::collections::BTreeMap<String,String> = std::env::vars().collect(); env.insert("OUROBOROS_ARG_TEST".into(), "explicit ✓".into());
        let spec = json!({"runId":"11111111-1111-4111-8111-111111111111","generation":1,"actionId":"22222222-2222-4222-8222-222222222222","role":"implementation","executable":node,"argv":argv,"cwd":dir,"env":env,"stdin":if mode=="input" {"pipe"} else {"closed"},"boundaryHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","authorization":{"kind":"qualification","requestId":"33333333-3333-4333-8333-333333333333","probeId":"ownership-fixture","fixtureRoots":[dir]},"leaseTtlMs":ttl,"deadline":now_ms()+60000});
        let mut helper = OwnedFixtureGuard::new(Command::new(env!("CARGO_BIN_EXE_ouroboros-supervisor")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap());
        let transcript=Arc::new(Mutex::new(Transcript::default()));
        transcript.lock().unwrap().add(format!("fixture root={} helperPid={}",dir.display(),helper.id()));
        let mut stderr=helper.stderr.take().unwrap();let stderr_transcript=transcript.clone();
        std::thread::spawn(move || {let mut bytes=[0;4096];let mut total=0;while let Ok(n)=stderr.read(&mut bytes){if n==0 {break;}total+=n;stderr_transcript.lock().unwrap().add(format!("helper stderr: {}",String::from_utf8_lossy(&bytes[..n])));if total>=32768 {break;}}});
        let mut stdout = helper.stdout.take().unwrap(); let (tx, rx) = mpsc::sync_channel(256);
        let capture=Arc::new(Mutex::new(FinalCapture::default()));let reader_capture=capture.clone();
        std::thread::spawn(move || {
            let mut assembler=OutputAssembler::default();
            let result=(|| -> Result<(),String> {loop {
                let mut prefix=[0;4];let n=stdout.read(&mut prefix[..1]).map_err(|e|e.to_string())?;if n==0 {return Ok(());}stdout.read_exact(&mut prefix[1..]).map_err(|e|format!("truncated prefix: {e}"))?;
                let n=u32::from_le_bytes(prefix) as usize;if n==0 || n>1024*1024 {return Err(format!("invalid frame size {n}"));}
                let mut body=vec![0;n];stdout.read_exact(&mut body).map_err(|e|format!("truncated body: {e}"))?;
                let msg:Value=serde_json::from_slice(&body).map_err(|e|e.to_string())?;
                reader_capture.lock().unwrap().frame(&msg)?;
                let frames=if msg["type"]=="output" {assembler.push(msg)?}else{vec![msg]};
                for frame in frames {tx.send(ReaderEvent::Frame(frame)).map_err(|e|e.to_string())?;}
            }})();
            for frame in assembler.finish(){let _=tx.send(ReaderEvent::Frame(frame));}
            let _=tx.send(match result {Ok(())=>ReaderEvent::Eof,Err(error)=>ReaderEvent::Fault(error)});
            reader_capture.lock().unwrap().eof=true;
        });
        let inbox=EventInbox::new(rx,transcript);
        let mut h = Self { helper, inbox, capture, root, descendant, spec }; h.send("launch", json!({"spec":h.spec})); h
    }
    fn send(&mut self, kind: &str, extras: Value) {
        let mut msg = json!({"protocolVersion":1,"runId":self.spec["runId"],"generation":1,"actionId":self.spec["actionId"],"role":"implementation","type":kind});
        msg.as_object_mut().unwrap().extend(extras.as_object().unwrap().clone());
        let bytes = serde_json::to_vec(&msg).unwrap(); let pipe = self.helper.stdin.as_mut().unwrap(); pipe.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap(); pipe.write_all(&bytes).unwrap(); pipe.flush().unwrap();
    }
    fn matching(&mut self,predicate:impl Fn(&Value)->bool)->Value {
        match self.inbox.take(predicate,Duration::from_secs(20)) {Ok(msg)=>msg,Err(error)=>{let status=self.helper.try_wait();panic!("{error}\nhelper pid={} exit={status:?}",self.helper.id());}}
    }
    fn event(&mut self,kind:&str)->Value {self.matching(|msg|msg["type"]==kind)}
    fn ack(&mut self,operation:&str,sequence:u64)->Value {self.matching(|msg|msg["type"]=="ack" && msg["operation"]==operation && msg["sequence"]==sequence)}
    fn output(&mut self,predicate:impl Fn(&Value)->bool)->Value {decode(&self.matching(|msg|msg["type"]=="output" && decode(msg).is_some_and(|body|predicate(&body)))).unwrap()}
    fn ready(&mut self) -> (u32,u32,Value) {
        let receipt = self.event("launched"); let root = receipt["receipt"]["pid"].as_u64().unwrap() as u32;
        let body=self.output(|body|body["descendantPid"].is_number());(root,body["descendantPid"].as_u64().unwrap() as u32,receipt)
    }
    fn drain(&mut self) -> Value { self.send("drain",json!({"sequence":10,"reason":"fixture complete"})); self.event("drained") }
}
fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 }
fn running(pid:u32) -> bool { unsafe { let h=OpenProcess(PROCESS_SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,0,pid); if h.is_null() {return false;} let live=WaitForSingleObject(h,0)==WAIT_TIMEOUT; CloseHandle(h); live } }
fn stopped(pid:u32) { let until=Instant::now()+Duration::from_secs(10); while running(pid) { assert!(Instant::now()<until,"owned PID still alive {pid}"); std::thread::sleep(Duration::from_millis(30)); } }
fn decode(msg:&Value) -> Option<Value> { // tiny fixture-only base64 decoder
    let s=msg["data"].as_str()?; let mut acc=0u32; let mut bits=0; let mut bytes=Vec::new();
    for c in s.bytes() { if c==b'=' {break;} let v=match c {b'A'..=b'Z'=>c-b'A',b'a'..=b'z'=>c-b'a'+26,b'0'..=b'9'=>c-b'0'+52,b'+'=>62,b'/'=>63,_=>return None}; acc=(acc<<6)|v as u32; bits+=6; if bits>=8 {bits-=8;bytes.push((acc>>bits) as u8);} }
    serde_json::from_slice(&bytes).ok()
}
#[test]
fn review_final_unterminated_output_precedes_terminal_drain() {
    let mut h=Harness::new("final-output",10000,&[]);h.event("launched");let report=h.event("drained");
    // Consume assembler EOF tails so its bounded queue cannot block the reader.
    let _=h.inbox.take(|_|false,Duration::from_secs(2));
    let until=Instant::now()+Duration::from_secs(2);
    while !h.capture.lock().unwrap().eof {assert!(Instant::now()<until,"bounded raw reader EOF");std::thread::sleep(Duration::from_millis(5));}
    let capture=h.capture.lock().unwrap();
    let mut stdout=vec![b'O';131072];stdout.extend(b"FINAL-STDOUT");let mut stderr=vec![b'E';131072];stderr.extend(b"FINAL-STDERR");
    assert_eq!(capture.stdout,stdout,"all final stdout must precede drainage");
    assert_eq!(capture.stderr,stderr,"all final stderr must precede drainage");
    assert!(!capture.late_output,"no child payload may follow terminal drainage");
    assert_eq!(report["evidence"]["outputComplete"],true);
    assert_eq!(report["evidence"]["unresolvedOutputStreams"],json!([]));
    assert!(report["evidence"]["outputCompletedAt"].as_u64().is_some());
    assert_eq!(report["evidence"]["activeProcesses"],0);
}
#[test] fn child_input_round_trip_and_fence_rejects_further_input() {
    let mut h=Harness::new("input",10000,&[]);h.ready();h.send("input",json!({"sequence":1,"data":"eyJ0eXBlIjoiZHJhaW5lZCJ9AAo="}));
    h.ack("input",1);
    assert_eq!(h.output(|body|body.get("inputBase64").is_some())["inputBase64"],"eyJ0eXBlIjoiZHJhaW5lZCJ9AAo=");
    h.send("endInput",json!({"sequence":2}));h.ack("endInput",2);assert_eq!(h.output(|body|body["inputEnded"]==true)["inputEnded"],true);
    h.send("fence",json!({"sequence":3}));h.ack("fence",3);h.send("input",json!({"sequence":4,"data":"YQ=="}));assert_eq!(h.matching(|msg|msg["type"]=="error" && msg["sequence"]==4)["code"],"INPUT_CLOSED");h.drain();
}
#[test] fn owns_child_before_resume() {
    let mut h=Harness::new("root",10000,&[]); let (root,descendant,receipt)=h.ready();
    assert_eq!(receipt["receipt"]["assignedBeforeResume"],true);
    assert!(!receipt["receipt"]["creationIdentity"].as_str().unwrap().is_empty());
    let report=h.drain(); assert_eq!(report["evidence"]["activeProcesses"],0); assert_eq!(report["evidence"]["childRanBeforeAssignment"],false); stopped(root); stopped(descendant);
}
#[test] fn controller_eof_kills_descendants() { let mut h=Harness::new("root",10000,&[]); let (root,descendant,_)=h.ready(); h.helper.stdin.take(); let report=h.event("drained"); assert_eq!(report["evidence"]["activeProcesses"],0); stopped(root); stopped(descendant); let bytes=std::fs::metadata(&h.descendant).unwrap().len(); std::thread::sleep(Duration::from_secs(2)); assert_eq!(std::fs::metadata(&h.descendant).unwrap().len(),bytes); }
#[test] fn helper_death_closes_job() { let mut h=Harness::new("root",10000,&[]); let (root,descendant,_)=h.ready(); h.helper.kill().unwrap(); h.helper.wait().unwrap(); stopped(root); stopped(descendant); }
#[test] fn unrelated_same_name_survives() {
    let mut unrelated_process=OwnedFixtureGuard::new(Command::new("node.exe").args(["-e","setInterval(()=>{},1000)"]).spawn().unwrap());
    let mut h=Harness::new("root",10000,&[]); h.ready(); let report=h.drain(); assert_eq!(report["evidence"]["activeProcesses"],0);
    let live=unrelated_process.try_wait().unwrap().is_none(); let _=unrelated_process.kill(); let _=unrelated_process.wait(); assert!(live,"unrelated process must survive");
}
#[test] fn job_assignment_failure_never_runs_child() {
    let h=Harness::new("root",10000,&[]); // use exact disposable spec with a fresh marker
    let mut spec: protocol::LaunchSpec=serde_json::from_value(h.spec.clone()).unwrap(); let marker=h.root.with_file_name("never-ran.txt"); spec.argv[2]=marker.to_string_lossy().into_owned();
    // The Windows kernel rejects this invalid job. Transaction rollback must terminate the suspended child.
    let result=unsafe { windows::launch_in_job(INVALID_HANDLE_VALUE,&spec) }; assert!(result.is_err()); std::thread::sleep(Duration::from_millis(300)); assert!(!marker.exists());
}
#[test] fn normal_root_exit_drains_surviving_grandchild() { let mut h=Harness::new("root-exits",10000,&[]); let (root,descendant,_)=h.ready(); let report=h.event("drained"); assert_eq!(report["evidence"]["rootExited"],true); assert_eq!(report["evidence"]["activeProcesses"],0); stopped(root); stopped(descendant); }
#[test] fn lease_expiry_drains_without_renewal() { let mut h=Harness::new("root",700,&[]); let (root,descendant,_)=h.ready(); let report=h.event("drained"); assert_eq!(report["evidence"]["reason"],"lease_expired"); assert_eq!(report["evidence"]["activeProcesses"],0); stopped(root); stopped(descendant); }
#[test] fn arguments_round_trip_and_forged_child_output_stays_payload() {
    let mut h=Harness::new("root",10000,&["", "spaces here", "quote\"here", "tail\\", "slashes\\\\\"quote", "unicode ✓"]);
    h.event("launched");
    let body=h.output(|body|body.get("args").is_some());assert_eq!(body["args"],json!(["", "spaces here", "quote\"here", "tail\\", "slashes\\\\\"quote", "unicode ✓"]));assert_eq!(body["env"],"explicit ✓");
    assert_eq!(h.output(|body|body["type"]=="drained")["activeProcesses"],0);
    h.drain();
}
