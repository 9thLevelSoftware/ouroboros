mod protocol;
#[cfg(windows)] mod windows;
#[cfg(target_os="linux")] mod linux;
#[cfg(windows)]
fn main() {
    if let Err(error)=run() {eprintln!("supervisor: {error}");std::process::exit(1);}
}
#[cfg(target_os="linux")] fn main(){if let Err(error)=linux::run(){eprintln!("supervisor: {error}");std::process::exit(1);}}
#[cfg(not(any(windows,target_os="linux")))] fn main(){eprintln!("unsupported supervisor environment");std::process::exit(1);}
#[cfg(windows)]
fn now_ms()->u64 {std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64}
#[cfg(windows)]
fn envelope(owner:&protocol::Owner,kind:&str,extra:serde_json::Value)->serde_json::Value {
    let mut value=serde_json::to_value(owner).unwrap();value.as_object_mut().unwrap().insert("protocolVersion".into(),1.into());value.as_object_mut().unwrap().insert("type".into(),kind.into());value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());value
}
#[cfg(windows)]
fn run()->Result<(),Box<dyn std::error::Error>> {
    use std::{collections::BTreeMap,io::{Read,Write}, sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering},mpsc}, time::{Instant,Duration}};
    use serde_json::json;
    // Control input is separate from child stdio. Truncation/malformed input is a fatal EOF-equivalent.
    let (control_tx,control_rx)=mpsc::sync_channel(32);
    std::thread::spawn(move || {let mut input=std::io::stdin().lock();loop {let next=protocol::read_frame(&mut input);let end=!matches!(next,Ok(Some(_)));if control_tx.send(next).is_err() || end {break;}}});
    // No job exists until a bounded initial launch has arrived.
    let initial=control_rx.recv_timeout(Duration::from_secs(10))??.ok_or("EOF before launch")?;
    if initial.protocol_version!=1 || initial.kind!="launch" || initial.sequence.is_some() || initial.reason.is_some() || initial.data.is_some() || initial.lease_sequence.is_some() {return Err("first frame must be launch".into());}
    let spec=initial.spec.as_ref().ok_or("launch spec missing")?;spec.validate()?;let owner=spec.owner();if owner!=initial.owner(){return Err("launch owner identity mismatch".into());}
    let remaining=spec.deadline.checked_sub(now_ms()).filter(|n|*n>0).ok_or("deadline expired")?;
    let deadline=Instant::now().checked_add(Duration::from_millis(remaining)).ok_or("deadline outside monotonic clock range")?;let mut lease=Instant::now()+Duration::from_millis(spec.lease_ttl_ms);
    let job=windows::Job::new()?;let mut child=job.launch(spec)?;
    let fault=Arc::new(AtomicBool::new(false));let total=Arc::new(AtomicU64::new(0));
    // Bounded writer decouples lease enforcement from a controller that stops reading stdout.
    let (output_tx,output_rx)=mpsc::sync_channel::<serde_json::Value>(128);let (flushed_tx,flushed_rx)=mpsc::channel();let writer_fault=fault.clone();
    std::thread::spawn(move || {let mut output=std::io::stdout().lock();for msg in output_rx {let bytes=serde_json::to_vec(&msg).unwrap();if bytes.len()>protocol::MAX_FRAME || output.write_all(&(bytes.len() as u32).to_le_bytes()).and_then(|_|output.write_all(&bytes)).and_then(|_|output.flush()).is_err() {writer_fault.store(true,Ordering::Release);break;}if msg["type"]=="drained" {let _=flushed_tx.send(());}}});
    let receipt=json!({"schemaVersion":1,"runId":owner.run_id,"generation":owner.generation,"actionId":owner.action_id,"role":owner.role,"environment":"windows","pid":child.pid,"creationIdentity":child.creation,"helperPid":std::process::id(),"helperCreationIdentity":windows::helper_creation_identity()?,"jobIdentity":format!("job:{}:{}",std::process::id(),child.creation),"boundaryHash":spec.boundary_hash,"assignedBeforeResume":true,"capturedAt":now_ms()});
    output_tx.try_send(envelope(&owner,"launched",json!({"receipt":receipt})))?;
    child.resume()?;
    // The gate serializes bounded try_send acceptance with terminal closure. No
    // blocking pipe read/write or queue wait is performed while holding it.
    struct OutputGate {closed:bool,completed:BTreeMap<&'static str,bool>}
    let output_gate=Arc::new(Mutex::new(OutputGate {closed:false,completed:BTreeMap::new()}));
    let (reader_done_tx,reader_done_rx)=mpsc::sync_channel(2);let mut output_readers=Vec::new();
    for (stream,mut pipe) in [("stdout",child.stdout.take().unwrap()),("stderr",child.stderr.take().unwrap())] {
        let tx=output_tx.clone();let fault=fault.clone();let total=total.clone();let owner=owner.clone();
        let gate=output_gate.clone();let done=reader_done_tx.clone();
        output_readers.push(std::thread::spawn(move || {
            let mut complete=false;let mut bytes=[0;16384];
            loop {match pipe.read(&mut bytes) {
                Ok(0)=>{complete=true;break;},
                Ok(n)=>{
                    let gate=gate.lock().unwrap();if gate.closed {break;}
                    if total.fetch_add(n as u64,Ordering::Relaxed)+n as u64>10*1024*1024 || tx.try_send(envelope(&owner,"output",json!({"stream":stream,"data":protocol::base64(&bytes[..n])}))).is_err(){fault.store(true,Ordering::Release);break;}
                },
                Err(_)=>{fault.store(true,Ordering::Release);break;},
            }}
            gate.lock().unwrap().completed.insert(stream,complete);let _=done.try_send(());
        }));
    }
    drop(reader_done_tx);
    let mut input_tx=child.stdin.take().map(|mut pipe| {let(tx,rx)=mpsc::sync_channel::<Option<Vec<u8>>>(16);let fault=fault.clone();std::thread::spawn(move || {for bytes in rx {match bytes {Some(bytes)=>if pipe.write_all(&bytes).is_err(){fault.store(true,Ordering::Release);break;},None=>break}}});tx});
    let mut fenced=false;let mut sequence=0;let mut lease_sequence=0;let mut acknowledged=false;
    let reason=loop {
        if fault.load(Ordering::Acquire){break "io_or_output_limit".to_string();}
        if Instant::now()>=deadline {break "deadline_expired".to_string();}
        if Instant::now()>=lease {break "lease_expired".to_string();}
        if child.exited()? {break "root_exit".to_string();}
        match control_rx.recv_timeout(Duration::from_millis(25)) {
            Err(mpsc::RecvTimeoutError::Timeout)=>continue,
            Err(_)|Ok(Ok(None))=>break "controller_eof".to_string(),
            Ok(Err(_))=>break "protocol_error".to_string(),
            Ok(Ok(Some(msg)))=>{
                if msg.protocol_version!=1 || msg.owner()!=owner || msg.kind=="launch" || msg.spec.is_some() {break "stale_or_invalid_control".to_string();}
                let next=match msg.sequence {Some(next) if next>sequence && next<=9007199254740991=>next,_=>break "stale_sequence".to_string()};sequence=next;
                if msg.kind!="renewLease" && msg.lease_sequence.is_some() {break "invalid_control".into();}
                match msg.kind.as_str() {
                    "renewLease" if msg.reason.is_none() && msg.data.is_none()=>{match msg.lease_sequence {Some(next) if next>lease_sequence && next<=9007199254740991=>lease_sequence=next,_=>break "stale_lease_sequence".into()};lease=Instant::now()+Duration::from_millis(spec.lease_ttl_ms);},
                    "fence" if msg.reason.is_none() && msg.data.is_none()=>{fenced=true;input_tx.take();},
                    "describe" if msg.reason.is_none() && msg.data.is_none()=>{output_tx.try_send(envelope(&owner,"described",json!({"sequence":sequence,"receipt":receipt})))?;continue;},
                    "drain" if msg.data.is_none()=>{acknowledged=true;break msg.reason.filter(|s|!s.trim().is_empty()).unwrap_or_else(||"requested".into());},
                    "input" if msg.reason.is_none()=>{
                        if fenced || input_tx.is_none() {output_tx.try_send(envelope(&owner,"error",json!({"sequence":sequence,"code":"INPUT_CLOSED","message":"child input is closed"})))?;continue;}
                        let bytes=match msg.data.as_deref().and_then(protocol::decode_base64){Some(bytes) if bytes.len()<=65536=>bytes,_=>break "invalid_input_payload".to_string()};
                        if input_tx.as_ref().unwrap().try_send(Some(bytes)).is_err(){break "input_backpressure".to_string();}
                    },
                    "endInput" if msg.reason.is_none() && msg.data.is_none()=>{if let Some(tx)=input_tx.take(){if tx.try_send(None).is_err(){break "input_backpressure".into();}}},
                    _=>break "invalid_control".to_string(),
                }
                output_tx.try_send(envelope(&owner,"ack",json!({"sequence":sequence,"operation":msg.kind})))?;
            }
        }
    };
    // Fencing precedes termination. Generic subprocesses have no safe universal graceful
    // signal; provider adapters perform their supported grace before requesting this drain.
    input_tx.take();let requested=now_ms();let evidence_deadline=Instant::now()+Duration::from_secs(15);let ack_at=if acknowledged {Some(requested)}else{None};
    if acknowledged {let _=output_tx.try_send(envelope(&owner,"ack",json!({"sequence":sequence,"operation":"drain"})));}
    let _=job.terminate();let (root_exited,active,members)=windows::observe_drain(&job,&child,evidence_deadline);let observed=now_ms();
    // Finish accepted output before the terminal frame, bounded by the same
    // process-evidence deadline. Missing/error/aborted readers stay unresolved.
    while output_gate.lock().unwrap().completed.len()<2 {
        if reader_done_rx.recv_timeout(evidence_deadline.saturating_duration_since(Instant::now())).is_err(){break;}
    }
    let unresolved_output={let mut gate=output_gate.lock().unwrap();gate.closed=true;["stdout","stderr"].into_iter().filter(|stream|gate.completed.get(stream)!=Some(&true)).collect::<Vec<_>>()};
    let output_complete=unresolved_output.is_empty();let output_observed=now_ms();
    // Completion signals, rather than an unbounded join, establish queue
    // finalization. Timed-out readers cannot enqueue after the closed gate.
    drop(output_readers);
    let evidence=json!({"schemaVersion":1,"runId":owner.run_id,"generation":owner.generation,"actionId":owner.action_id,"role":owner.role,"reason":reason,"requestAcknowledged":acknowledged,"requestedAt":requested,"acknowledgedAt":ack_at,"rootExited":root_exited,"rootExitedAt":if root_exited {Some(observed)}else{None},"membershipEmpty":active==0,"membershipObservedAt":observed,"activeProcesses":active,"unresolvedExecutions":members,"outputComplete":output_complete,"unresolvedOutputStreams":unresolved_output,"outputCompletedAt":if output_complete {Some(output_observed)}else{None},"childRanBeforeAssignment":false,"completedAt":output_observed});
    let mut terminal=envelope(&owner,"drained",json!({"evidence":evidence}));
    let queued=loop {match output_tx.try_send(terminal) {
        Ok(())=>break true,
        Err(mpsc::TrySendError::Full(frame))=>{terminal=frame;if Instant::now()>=evidence_deadline {break false;}std::thread::sleep(Duration::from_millis(5).min(evidence_deadline.saturating_duration_since(Instant::now())));},
        Err(mpsc::TrySendError::Disconnected(_))=>break false,
    }};
    let flushed=queued && flushed_rx.recv_timeout(Duration::from_secs(1).min(evidence_deadline.saturating_duration_since(Instant::now()))).is_ok();
    // The sole job handle closes before process exit, including on all early errors/panic unwind.
    drop(child);drop(job);std::process::exit(if active==0 && root_exited && output_complete && flushed {0}else{2});
}
