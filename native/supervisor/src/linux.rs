//! Finite sibling observer/target services and an observer-bound exclusive slice.
//! Only an actual original-slice cgroup.events populated=0 read proves drainage.
use crate::protocol::{self, Control, LaunchSpec, Owner};
use serde_json::{Value, json};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::fd::FromRawFd,
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        net::UnixStream,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::{Fd, OwnedObjectPath, Value as BusValue},
};
type Error = Box<dyn std::error::Error>;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}
fn envelope(owner: &Owner, kind: &str, extra: Value) -> Value {
    let mut value = serde_json::to_value(owner).unwrap();
    let object = value.as_object_mut().unwrap();
    object.insert("protocolVersion".into(), 1.into());
    object.insert("type".into(), kind.into());
    object.extend(extra.as_object().unwrap().clone());
    value
}
fn write_json(output: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > protocol::MAX_FRAME {
        return Err(std::io::Error::other("frame size"));
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}
fn read_json(input: &mut impl Read) -> std::io::Result<Value> {
    let mut prefix = [0; 4];
    input.read_exact(&mut prefix)?;
    let length = u32::from_le_bytes(prefix) as usize;
    if length == 0 || length > protocol::MAX_FRAME {
        return Err(std::io::Error::other("frame size"));
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(std::io::Error::other)
}
fn persist(path: &Path, value: &Value) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    File::open(path.parent().unwrap())?.sync_all()
}
fn diagnostic_stage(root: &Path, role: &str, stage: &str) -> std::io::Result<()> {
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(root.join(format!("{role}-stages.jsonl")))?;
    if log.metadata()?.len() >= 65536 {
        return Err(std::io::Error::other("diagnostic budget"));
    }
    serde_json::to_writer(&mut log, &json!({"at":now(),"stage":stage}))?;
    log.write_all(b"\n")?;
    log.sync_all()
}
fn diagnostic_error(root: &Path, role: &str, error: &dyn std::fmt::Display) {
    let message: String = error.to_string().chars().take(16384).collect();
    let _ = persist(
        &root.join(format!("{role}-error.json")),
        &json!({"at":now(),"error":message}),
    );
}
/// Startup diagnostics begin before target creation. On launch failure, closing
/// the separate control socket lets the trusted target report EOF while this
/// reader remains alive for at most 500ms; no command stdin is recorded.
struct StartupStderr {
    state: Arc<AtomicU64>,
    control: UnixStream,
    reader: Option<std::thread::JoinHandle<std::io::Result<UnixStream>>>,
}
impl StartupStderr {
    fn new(mut pipe: UnixStream, control: &UnixStream, root: &Path) -> std::io::Result<Self> {
        pipe.set_read_timeout(Some(Duration::from_millis(50)))?;
        let state = Arc::new(AtomicU64::new(0));
        let reading = state.clone();
        let path = root.join("target-startup-stderr.bin");
        let reader = std::thread::spawn(move || {
            let mut log = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)?;
            let mut bytes = [0; 4096];
            let mut retained = 0usize;
            loop {
                let mode = reading.load(Ordering::Acquire);
                if mode == 1 || (mode > 1 && now() >= mode) {
                    break;
                }
                match pipe.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(n) => {
                        let take = n.min(65536usize.saturating_sub(retained));
                        log.write_all(&bytes[..take])?;
                        retained += take;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            log.sync_all()?;
            pipe.set_read_timeout(None)?;
            Ok(pipe)
        });
        Ok(Self {
            state,
            control: control.try_clone()?,
            reader: Some(reader),
        })
    }
    fn handoff(mut self) -> Result<UnixStream, Error> {
        self.state.store(1, Ordering::Release);
        Ok(self
            .reader
            .take()
            .unwrap()
            .join()
            .map_err(|_| "startup diagnostic reader panic")??)
    }
}
impl Drop for StartupStderr {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            let _ = self.control.shutdown(std::net::Shutdown::Both);
            self.state.store(now() + 500, Ordering::Release);
            let _ = reader.join();
        }
    }
}
fn start_ticks(pid: u32) -> std::io::Result<String> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, tail) = text
        .rsplit_once(") ")
        .ok_or_else(|| std::io::Error::other("invalid proc stat"))?;
    tail.split_whitespace()
        .nth(19)
        .map(str::to_owned)
        .ok_or_else(|| std::io::Error::other("missing start ticks"))
}
fn in_cgroup(pid: u32, path: &str) -> bool {
    fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .map(|v| v.lines().any(|line| line == format!("0::{path}")))
        .unwrap_or(false)
}
fn alive(identity: &Value) -> bool {
    match (
        identity["pid"]
            .as_u64()
            .and_then(|pid| start_ticks(pid as u32).ok()),
        identity["startTimeTicks"].as_str(),
    ) {
        (Some(actual), Some(expected)) => actual == expected,
        _ => false,
    }
}
fn boot() -> std::io::Result<String> {
    fs::read_to_string("/proc/sys/kernel/random/boot_id").map(|v| v.trim().to_string())
}
fn population(file: &mut File) -> std::io::Result<u8> {
    file.seek(SeekFrom::Start(0))?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    text.lines()
        .find_map(|line| line.strip_prefix("populated "))
        .and_then(|v| v.parse().ok())
        .filter(|v| *v <= 1)
        .ok_or_else(|| std::io::Error::other("invalid cgroup populated value"))
}
fn close_extra_descriptors() -> std::io::Result<()> {
    let entries = fs::read_dir("/proc/self/fd")?;
    let descriptors: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let target = fs::read_link(entry.path()).ok()?;
            if target == PathBuf::from(format!("/proc/{}/fd", std::process::id())) {
                return None;
            }
            entry.file_name().to_str()?.parse::<i32>().ok()
        })
        .filter(|fd| *fd > 2)
        .collect();
    for fd in descriptors {
        unsafe {
            drop(File::from_raw_fd(fd));
        }
    }
    Ok(())
}
fn controller_root() -> Result<PathBuf, Error> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or(
            PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?).join(".local/share"),
        );
    if !base.is_absolute() {
        return Err("absolute controller data root required".into());
    }
    Ok(base.join("ouroboros/controller/executions"))
}
fn spool_path(owner: &Owner) -> Result<PathBuf, Error> {
    if owner.generation == 0
        || !owner
            .run_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
        || owner.run_id.len() != 36
        || !owner
            .action_id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() || c == b'-')
        || owner.action_id.len() != 36
    {
        return Err("invalid spool identity".into());
    }
    Ok(controller_root()?
        .join(&owner.run_id)
        .join(owner.generation.to_string())
        .join(&owner.action_id))
}
fn input_channel() -> mpsc::Receiver<std::io::Result<Option<Control>>> {
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let next = protocol::read_frame(&mut input);
            let end = !matches!(next, Ok(Some(_)));
            if tx.send(next).is_err() || end {
                break;
            }
        }
    });
    rx
}
fn service_properties<'a>(runtime: u64) -> Vec<(&'a str, BusValue<'a>)> {
    vec![
        ("Type", BusValue::from("exec")),
        ("ExitType", BusValue::from("main")),
        ("KillMode", BusValue::from("control-group")),
        ("SendSIGKILL", BusValue::from(true)),
        ("TimeoutStopUSec", BusValue::from(5_000_000u64)),
        ("Restart", BusValue::from("no")),
        ("Delegate", BusValue::from(false)),
        ("RuntimeMaxUSec", BusValue::from(runtime)),
    ]
}
fn authority<'a>(
    connection: &'a Connection,
    path: &'a str,
    interface: &'a str,
) -> zbus::Result<Proxy<'a>> {
    zbus::blocking::proxy::Builder::new(connection)
        .destination("org.freedesktop.systemd1")?
        .path(path)?
        .interface(interface)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
}
fn unit<'a>(connection: &'a Connection, path: &'a OwnedObjectPath) -> zbus::Result<Proxy<'a>> {
    authority(connection, path.as_str(), "org.freedesktop.systemd1.Unit")
}
pub fn run() -> Result<(), Error> {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("bridge") => bridge(),
        Some("observer") if args.len() == 3 => {
            let root = Path::new(&args[2]);
            let result = observer(root);
            if let Err(ref error) = result {
                diagnostic_error(root, "observer", error);
            }
            result
        }
        Some("target") if args.len() == 3 => {
            let spec_path = Path::new(&args[2]);
            let result = match std::panic::catch_unwind(|| target(spec_path)) {
                Ok(result) => result,
                Err(payload) => {
                    let message = payload
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| payload.downcast_ref::<&str>().copied())
                        .unwrap_or("target panic payload unavailable");
                    if let Some(root) = spec_path.parent() {
                        diagnostic_error(root, "target-panic", &message);
                    }
                    Err("target startup/runtime panic; see owned diagnostic receipt".into())
                }
            };
            if let Err(ref error) = result {
                if let Some(root) = spec_path.parent() {
                    diagnostic_error(root, "target", error);
                }
            }
            result
        }
        Some("child") if args.len() == 3 => child(Path::new(&args[2])),
        Some("retrieve") if args.len() == 5 => {
            let owner = Owner {
                run_id: args[2].clone(),
                generation: args[3].parse()?,
                action_id: args[4].clone(),
                role: "retrieval".into(),
            };
            let root = spool_path(&owner)?;
            let receipt: Value = serde_json::from_slice(&fs::read(root.join("ownership.json"))?)?;
            let evidence: Value = serde_json::from_slice(&fs::read(root.join("drain.json"))?)?;
            println!("{}", json!({"receipt":receipt,"evidence":evidence}));
            Ok(())
        }
        _ => Err("explicit bridge/observer/target/child mode required".into()),
    }
}
fn bridge() -> Result<(), Error> {
    let input = input_channel();
    let initial = input
        .recv_timeout(Duration::from_secs(10))??
        .ok_or("EOF before launch")?;
    if initial.kind != "launch"
        || initial.protocol_version != 1
        || initial.sequence.is_some()
        || initial.reason.is_some()
        || initial.data.is_some()
        || initial.lease_sequence.is_some()
    {
        return Err("first frame must be launch".into());
    }
    let spec = initial.spec.as_ref().ok_or("missing launch spec")?;
    spec.validate()?;
    if spec.owner() != initial.owner() || spec.deadline <= now() {
        return Err("launch owner/deadline mismatch".into());
    }
    spec.ensure_launch_current(now())?;
    let root = spool_path(&spec.owner())?;
    let parent = root.parent().unwrap();
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    DirBuilder::new().mode(0o700).create(&root)?;
    persist(&root.join("spec.json"), &serde_json::to_value(spec)?)?;
    let distro =
        std::env::var("WSL_DISTRO_NAME").map_err(|_| "WSL distribution identity missing")?;
    persist(
        &root.join("pending.json"),
        &json!({"schemaVersion":1,"owner":spec.owner(),"boundaryHash":spec.boundary_hash,"distro":distro,"createdAt":now(),"status":"pending"}),
    )?;
    let name = format!(
        "ouroboros-observer-{}-g{}.service",
        spec.action_id.replace('-', ""),
        spec.generation
    );
    let runtime = (spec.deadline - now()).saturating_add(25000);
    let mut observer = Command::new("/usr/bin/systemd-run")
        .args([
            "--user",
            "--pipe",
            "--quiet",
            &format!("--unit={name}"),
            "--property=Type=exec",
            "--property=ExitType=main",
            "--property=KillMode=control-group",
            "--property=SendSIGKILL=yes",
            "--property=TimeoutStopSec=5s",
            "--property=Restart=no",
            "--property=Delegate=no",
            &format!("--property=RuntimeMaxSec={}ms", runtime),
        ])
        .arg(std::env::current_exe()?)
        .arg("observer")
        .arg(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut control = observer.stdin.take().unwrap();
    std::thread::spawn(move || {
        for next in input {
            match next {
                Ok(Some(message)) => {
                    if write_json(&mut control, &serde_json::to_value(message).unwrap()).is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });
    let mut output = observer.stdout.take().unwrap();
    let copied = std::io::copy(&mut output, &mut std::io::stdout().lock());
    let status = observer.wait()?;
    copied?;
    std::process::exit(status.code().unwrap_or(2));
}
fn child(spec_path: &Path) -> Result<(), Error> {
    close_extra_descriptors()?;
    let spec: LaunchSpec = serde_json::from_slice(&fs::read(spec_path)?)?;
    spec.validate()?;
    let mut gate = [0];
    std::io::stdin().read_exact(&mut gate)?;
    if gate != [0x7e] {
        return Err("pre-exec gate not released".into());
    }
    let mut command = Command::new(&spec.executable);
    command.args(&spec.argv).current_dir(&spec.cwd).env_clear().envs(&spec.env);
    spec.ensure_launch_current(now())?;
    let error = command.exec();
    Err(error.into())
}
fn target(spec_path: &Path) -> Result<(), Error> {
    close_extra_descriptors()?;
    let spec: LaunchSpec = serde_json::from_slice(&fs::read(spec_path)?)?;
    spec.validate()?;
    diagnostic_stage(
        spec_path.parent().ok_or("spec parent missing")?,
        "target",
        "waiting_prepare",
    )?;
    let mut control = unsafe { UnixStream::from_raw_fd(0) };
    control.set_read_timeout(Some(Duration::from_secs(10)))?;
    control.set_write_timeout(Some(Duration::from_millis(500)))?;
    let prepare = read_json(&mut control)?;
    if prepare != json!({"type":"prepare"}) {
        return Err("invalid target prepare".into());
    }
    spec.ensure_launch_current(now())?;
    let mut root = Command::new(std::env::current_exe()?)
        .arg("child")
        .arg(spec_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut root_input = root.stdin.take();
    let helper =
        json!({"pid":std::process::id(),"startTimeTicks":start_ticks(std::process::id())?});
    let root_identity = json!({"pid":root.id(),"startTimeTicks":start_ticks(root.id())?});
    write_json(
        &mut control,
        &json!({"type":"prepared","helper":helper,"root":root_identity}),
    )?;
    let release = read_json(&mut control)?;
    if release != json!({"type":"exec"}) {
        return Err("invalid target exec release".into());
    }
    root_input.as_mut().unwrap().write_all(&[0x7e])?;
    if spec.stdin == "closed" {
        root_input.take();
    }
    write_json(&mut control, &json!({"type":"executing"}))?;
    control.set_read_timeout(None)?;
    let mut input = control.try_clone()?;
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        loop {
            let next = protocol::read_frame(&mut input);
            let end = !matches!(next, Ok(Some(_)));
            if tx.send(next).is_err() || end {
                break;
            }
        }
    });
    let mut lease = Instant::now() + Duration::from_millis(spec.lease_ttl_ms);
    let remaining = spec.deadline.checked_sub(now()).ok_or("deadline expired")?;
    let deadline = Instant::now() + Duration::from_millis(remaining);
    let mut last = 0;
    let mut lease_sequence = 0;
    loop {
        if root.try_wait()?.is_some() {
            return Ok(());
        }
        if Instant::now() >= lease || Instant::now() >= deadline {
            return Err("target lease/deadline expired".into());
        }
        let message = match rx.recv_timeout(Duration::from_millis(25)) {
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Ok(Ok(Some(message))) => message,
            _ => return Err("target controller EOF/protocol failure".into()),
        };
        if message.protocol_version != 1
            || message.owner() != spec.owner()
            || message.spec.is_some()
        {
            return Err("target control identity".into());
        }
        let sequence = message
            .sequence
            .filter(|s| *s > last && *s <= 9007199254740991)
            .ok_or("target stale control")?;
        last = sequence;
        match message.kind.as_str() {
            "renewLease" => {
                let next = message
                    .lease_sequence
                    .filter(|s| *s > lease_sequence)
                    .ok_or("stale lease")?;
                lease_sequence = next;
                lease = Instant::now() + Duration::from_millis(spec.lease_ttl_ms);
            }
            "fence" => {
                root_input.take();
            }
            "input" => {
                let bytes = message
                    .data
                    .as_deref()
                    .and_then(protocol::decode_base64)
                    .filter(|bytes| bytes.len() <= 65536)
                    .ok_or("invalid target input")?;
                root_input
                    .as_mut()
                    .ok_or("input closed")?
                    .write_all(&bytes)?;
            }
            "endInput" => {
                root_input.take();
            }
            "drain" => return Ok(()),
            _ => return Err("invalid target control".into()),
        }
        write_json(
            &mut control,
            &json!({"type":"ack","sequence":sequence,"operation":message.kind}),
        )?;
    }
}
type PopulationObservation = (Option<u8>, Option<u64>, Option<String>);
fn finalize_population(
    observation: &Mutex<PopulationObservation>,
    incarnation_valid: bool,
    target_unit: &str,
) -> Value {
    let (populated, observed_at, observation_error) = if incarnation_valid {
        observation.lock().unwrap().clone()
    } else {
        // The reader may publish a late sample after mismatch detection. The
        // immutable authority decision must override it after the reader joins.
        (
            None,
            None,
            Some("unit/boot incarnation changed before stop".into()),
        )
    };
    let empty = populated == Some(0);
    json!({"membershipEmpty":empty,"membershipObservedAt":observed_at,"cgroupPopulated":populated,
        "observationError":observation_error,"unresolvedUnits":if empty{vec![]}else{vec![target_unit]}})
}
fn observer(root: &Path) -> Result<(), Error> {
    diagnostic_stage(root, "observer", "read_spec")?;
    let spec: LaunchSpec = serde_json::from_slice(&fs::read(root.join("spec.json"))?)?;
    spec.validate()?;
    let owner = spec.owner();
    if spool_path(&owner)? != root {
        return Err("spool owner mismatch".into());
    }
    let pending: Value = serde_json::from_slice(&fs::read(root.join("pending.json"))?)?;
    let distro = pending["distro"].as_str().ok_or("distro missing")?;
    let suffix = format!("{}-g{}", spec.action_id.replace('-', ""), spec.generation);
    let observer_name = format!("ouroboros-observer-{suffix}.service");
    let target_name = format!("ouroboros-target-{suffix}.service");
    let slice_name = format!("ouroboros_{}.slice", suffix.replace('-', "_"));
    let connection = Connection::session()?;
    let manager = authority(
        &connection,
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
    )?;
    let observer_path: OwnedObjectPath = manager.call("GetUnit", &(&observer_name,))?;
    let observer_unit = unit(&connection, &observer_path)?;
    let observer_inv: Vec<u8> = observer_unit.get_property("InvocationID")?;
    if hex(&observer_inv) != std::env::var("INVOCATION_ID")?
        || observer_unit.get_property::<String>("ActiveState")? != "active"
    {
        return Err("observer not exact active service".into());
    }
    let slice_properties = vec![
        ("BindsTo", BusValue::new(vec![observer_name.as_str()])),
        ("After", BusValue::new(vec![observer_name.as_str()])),
        ("StopWhenUnneeded", BusValue::from(false)),
    ];
    let auxiliary: Vec<(&str, Vec<(&str, BusValue<'_>)>)> = vec![];
    diagnostic_stage(root, "observer", "create_slice")?;
    let _: OwnedObjectPath = manager.call(
        "StartTransientUnit",
        &(&slice_name, "fail", slice_properties, &auxiliary),
    )?;
    manager.call::<_, _, ()>("RefUnit", &(&slice_name,))?;
    let slice_path: OwnedObjectPath = manager.call("GetUnit", &(&slice_name,))?;
    let slice = unit(&connection, &slice_path)?;
    let slice_specific = authority(
        &connection,
        slice_path.as_str(),
        "org.freedesktop.systemd1.Slice",
    )?;
    let (mut helper_control, target_control) = UnixStream::pair()?;
    helper_control.set_read_timeout(Some(Duration::from_secs(5)))?;
    helper_control.set_write_timeout(Some(Duration::from_millis(500)))?;
    let (stdout, stdout_target) = UnixStream::pair()?;
    let (stderr, stderr_target) = UnixStream::pair()?;
    let startup_stderr = StartupStderr::new(stderr, &helper_control, root)?;
    let runtime = spec
        .deadline
        .checked_sub(now())
        .filter(|n| *n > 0)
        .ok_or("observer deadline expired")?
        .saturating_add(1000)
        * 1000;
    let executable = std::env::current_exe()?;
    let executable = executable.to_str().ok_or("helper path UTF8")?;
    let spec_path = root.join("spec.json");
    let spec_text = spec_path.to_str().ok_or("spec path UTF8")?;
    let mut properties = service_properties(runtime);
    properties.extend([
        ("Slice", BusValue::from(slice_name.as_str())),
        (
            "ExecStart",
            BusValue::new(vec![(
                executable,
                vec![executable, "target", spec_text],
                false,
            )]),
        ),
        (
            "StandardInputFileDescriptor",
            BusValue::new(Fd::from(&target_control)),
        ),
        (
            "StandardOutputFileDescriptor",
            BusValue::new(Fd::from(&stdout_target)),
        ),
        (
            "StandardErrorFileDescriptor",
            BusValue::new(Fd::from(&stderr_target)),
        ),
    ]);
    diagnostic_stage(root, "observer", "create_target")?;
    let _: OwnedObjectPath = manager.call(
        "StartTransientUnit",
        &(&target_name, "fail", properties, &auxiliary),
    )?;
    drop(target_control);
    drop(stdout_target);
    drop(stderr_target);
    manager.call::<_, _, ()>("RefUnit", &(&target_name,))?;
    let target_path: OwnedObjectPath = manager.call("GetUnit", &(&target_name,))?;
    let target_unit = unit(&connection, &target_path)?;
    let service = authority(
        &connection,
        target_path.as_str(),
        "org.freedesktop.systemd1.Service",
    )?;
    diagnostic_stage(root, "observer", "capture_target_identity")?;
    let capture_deadline = Instant::now() + Duration::from_secs(5);
    let mut first_capture: Option<Value> = None;
    let (helper_pid, target_inv, target_group) = loop {
        let pid: u32 = service.get_property("MainPID")?;
        let inv: Vec<u8> = target_unit.get_property("InvocationID")?;
        let group: String = service.get_property("ControlGroup")?;
        let capture = json!({"at":now(),"pid":pid,"invocationId":hex(&inv),"controlGroup":group});
        if first_capture.is_none() {
            first_capture = Some(capture.clone());
        }
        if pid > 0 && inv.len() == 16 && !group.is_empty() {
            break (pid, inv, group);
        }
        if Instant::now() >= capture_deadline {
            persist(
                &root.join("capture-timeout.json"),
                &json!({"first":first_capture,"last":capture}),
            )?;
            return Err("target identity deadline".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let slice_inv: Vec<u8> = slice.get_property("InvocationID")?;
    let slice_group: String = slice_specific.get_property("ControlGroup")?;
    let observer_group: String = authority(
        &connection,
        observer_path.as_str(),
        "org.freedesktop.systemd1.Service",
    )?
    .get_property("ControlGroup")?;
    if slice_inv.len() != 16
        || slice_group.is_empty()
        || !target_group.starts_with(&format!("{slice_group}/"))
        || observer_group.starts_with(&format!("{slice_group}/"))
        || !in_cgroup(helper_pid, &target_group)
    {
        return Err("exclusive target/helper ancestry invalid".into());
    }
    let target_type: String = service.get_property("Type")?;
    let exit_type: String = service.get_property("ExitType")?;
    let kill: String = service.get_property("KillMode")?;
    let sigkill: bool = service.get_property("SendSIGKILL")?;
    let stop: u64 = service.get_property("TimeoutStopUSec")?;
    let restart: String = service.get_property("Restart")?;
    let delegate: bool = service.get_property("Delegate")?;
    let runtime_actual: u64 = service.get_property("RuntimeMaxUSec")?;
    let bindings: Vec<String> = slice.get_property("BindsTo")?;
    let after: Vec<String> = slice.get_property("After")?;
    let unneeded: bool = slice.get_property("StopWhenUnneeded")?;
    if target_type != "exec"
        || exit_type != "main"
        || kill != "control-group"
        || !sigkill
        || stop != 5_000_000
        || restart != "no"
        || delegate
        || runtime_actual != runtime
        || bindings != [observer_name.as_str()]
        || !after.contains(&observer_name)
        || unneeded
    {
        return Err("effective target/slice properties mismatch".into());
    }
    let boot_id = boot()?;
    let mut events = File::open(format!("/sys/fs/cgroup{slice_group}/cgroup.events"))?;
    let file_identity = events.metadata()?;
    if population(&mut events)? != 1 {
        return Err("observation must arm on actual populated1".into());
    }
    let observation_slice = json!({"unitName":slice_name,"invocationId":hex(&slice_inv),"controlGroup":slice_group,"fileDevice":file_identity.dev().to_string(),"fileInode":file_identity.ino().to_string()});
    let observer_identity = json!({"unitName":observer_name,"invocationId":hex(&observer_inv)});
    persist(
        &root.join("identity.json"),
        &json!({"unitName":target_name,"invocationId":hex(&target_inv),"bootId":boot_id,"controlGroup":target_group,"observationSlice":observation_slice,"observer":observer_identity,"armedAt":now(),"populated":1}),
    )?;
    diagnostic_stage(root, "observer", "prepare_child")?;
    write_json(&mut helper_control, &json!({"type":"prepare"}))?;
    let prepared = read_json(&mut helper_control)?;
    let helper = prepared["helper"].clone();
    let child_identity = prepared["root"].clone();
    let child_pid = child_identity["pid"].as_u64().ok_or("child PID missing")? as u32;
    if prepared["type"] != "prepared"
        || helper["pid"] != helper_pid
        || !alive(&helper)
        || !alive(&child_identity)
        || !in_cgroup(child_pid, &target_group)
        || population(&mut events)? != 1
    {
        return Err("gated child/helper identity invalid".into());
    }
    let mut receipt = serde_json::to_value(&owner)?;
    receipt.as_object_mut().unwrap().extend(json!({"schemaVersion":1,"environment":"wsl2","distro":distro,"unitName":target_name,"invocationId":hex(&target_inv),"bootId":boot_id,"controlGroup":target_group,"observationSlice":observation_slice,"observer":observer_identity,"helper":helper,"root":child_identity,"boundaryHash":spec.boundary_hash,"identityCapturedBeforeExec":true,"observationArmedBeforeExec":true,"capturedAt":now()}).as_object().unwrap().clone());
    persist(&root.join("ownership.json"), &receipt)?;
    let stderr = startup_stderr.handoff()?;
    // Original retained slice FD is observed independently; no vanished path is reopened.
    let observation = Arc::new(Mutex::new((Some(1u8), Some(now()), None::<String>)));
    let observing = Arc::new(AtomicBool::new(true));
    let observed = observation.clone();
    let running = observing.clone();
    let observation_reader = std::thread::spawn(move || {
        while running.load(Ordering::Acquire) {
            match population(&mut events) {
                Ok(value) => {
                    *observed.lock().unwrap() = (Some(value), Some(now()), None);
                    if value == 0 {
                        break;
                    }
                }
                Err(error) => {
                    *observed.lock().unwrap() = (None, None, Some(error.to_string()));
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    let fault = Arc::new(AtomicBool::new(false));
    let total = Arc::new(AtomicU64::new(0));
    let (output_tx, output_rx) = mpsc::sync_channel::<Value>(128);
    let (flushed_tx, flushed_rx) = mpsc::channel();
    let writer_fault = fault.clone();
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        for frame in output_rx {
            let terminal = frame["type"] == "drained";
            if write_json(&mut output, &frame).is_err() {
                writer_fault.store(true, Ordering::Release);
                break;
            }
            if terminal {
                let _ = flushed_tx.send(());
            }
        }
    });
    output_tx.try_send(envelope(&owner, "launched", json!({"receipt":receipt})))?;
    struct Gate {
        closed: bool,
        complete: std::collections::BTreeMap<&'static str, bool>,
    }
    let gate = Arc::new(Mutex::new(Gate {
        closed: false,
        complete: std::collections::BTreeMap::new(),
    }));
    let (done_tx, done_rx) = mpsc::sync_channel(2);
    for (stream, mut pipe) in [("stdout", stdout), ("stderr", stderr)] {
        let tx = output_tx.clone();
        let owner = owner.clone();
        let fault = fault.clone();
        let total = total.clone();
        let gate = gate.clone();
        let done = done_tx.clone();
        let path = root.join(format!("{stream}.bin"));
        std::thread::spawn(move || {
            let mut complete = false;
            let mut bytes = [0; 16384];
            let result = (|| -> std::io::Result<()> {
                let mut spool = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .mode(0o600)
                    .open(path)?;
                loop {
                    match pipe.read(&mut bytes) {
                        Ok(0) => {
                            spool.sync_all()?;
                            complete = true;
                            break;
                        }
                        Ok(count) => {
                            let mut gate = gate.lock().unwrap();
                            if gate.closed {
                                break;
                            }
                            if total.fetch_add(count as u64, Ordering::Relaxed) + count as u64
                                > 10 * 1024 * 1024
                            {
                                return Err(std::io::Error::other("output budget"));
                            }
                            spool.write_all(&bytes[..count])?;
                            if tx.try_send(envelope(&owner,"output",json!({"stream":stream,"data":protocol::base64(&bytes[..count])}))).is_err(){gate.closed=true;return Err(std::io::Error::other("output backpressure"));}
                        }
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })();
            if result.is_err() {
                fault.store(true, Ordering::Release);
            }
            gate.lock().unwrap().complete.insert(stream, complete);
            let _ = done.try_send(());
        });
    }
    drop(done_tx);
    write_json(&mut helper_control, &json!({"type":"exec"}))?;
    if read_json(&mut helper_control)? != json!({"type":"executing"}) {
        return Err("exec release acknowledgment missing".into());
    }
    helper_control.set_read_timeout(Some(Duration::from_millis(500)))?;
    let input = input_channel();
    let mut lease = Instant::now() + Duration::from_millis(spec.lease_ttl_ms);
    let deadline = Instant::now() + Duration::from_millis(spec.deadline.saturating_sub(now()));
    let mut last = 0;
    let mut lease_sequence = 0;
    let mut acknowledged = false;
    let mut fenced = spec.stdin == "closed";
    let reason = loop {
        if fault.load(Ordering::Acquire) {
            break "io_or_output_limit".to_string();
        }
        if Instant::now() >= lease {
            break "lease_expired".into();
        }
        if Instant::now() >= deadline {
            break "deadline_expired".into();
        }
        if !alive(&helper) {
            break "helper_exit".into();
        }
        if !alive(&child_identity) {
            break "root_exit".into();
        }
        let message = match input.recv_timeout(Duration::from_millis(25)) {
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Ok(Ok(Some(message))) => message,
            Ok(Err(_)) => break "protocol_error".into(),
            _ => break "controller_eof".into(),
        };
        if message.protocol_version != 1 || message.owner() != owner || message.spec.is_some() {
            break "invalid_control_identity".into();
        }
        let sequence = match message.sequence {
            Some(next) if next > last && next <= 9007199254740991 => next,
            _ => break "stale_sequence".into(),
        };
        last = sequence;
        if (message.kind != "renewLease" && message.lease_sequence.is_some())
            || (message.kind != "input" && message.data.is_some())
            || (message.kind != "drain" && message.reason.is_some())
        {
            break "invalid_control".into();
        }
        match message.kind.as_str() {
            "describe" => {
                let _ = output_tx.try_send(envelope(
                    &owner,
                    "described",
                    json!({"sequence":sequence,"receipt":receipt}),
                ));
                continue;
            }
            "drain" => {
                acknowledged = true;
                break message
                    .reason
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| "requested".into());
            }
            "renewLease" => {
                let next = match message.lease_sequence {
                    Some(next) if next > lease_sequence => next,
                    _ => break "stale_lease".into(),
                };
                lease_sequence = next;
                lease = Instant::now() + Duration::from_millis(spec.lease_ttl_ms);
            }
            "fence" => fenced = true,
            "input" if !fenced => {
                if message
                    .data
                    .as_deref()
                    .and_then(protocol::decode_base64)
                    .filter(|bytes| bytes.len() <= 65536)
                    .is_none()
                {
                    break "invalid_input".into();
                }
            }
            "input" => {
                let _=output_tx.try_send(envelope(&owner,"error",json!({"sequence":sequence,"code":"INPUT_CLOSED","message":"child input closed"})));
                continue;
            }
            "endInput" => fenced = true,
            _ => break "invalid_control".into(),
        }
        if write_json(&mut helper_control, &serde_json::to_value(&message)?).is_err() {
            break "helper_control_write_failure".into();
        }
        let ack = match read_json(&mut helper_control) {
            Ok(value) => value,
            Err(_) => break "helper_control_read_failure".into(),
        };
        if ack != json!({"type":"ack","sequence":sequence,"operation":message.kind}) {
            break "helper_ack_invalid".into();
        }
        let _ = output_tx.try_send(envelope(
            &owner,
            "ack",
            json!({"sequence":sequence,"operation":message.kind}),
        ));
    };
    let requested = now();
    let acknowledged_at = if acknowledged { Some(requested) } else { None };
    if acknowledged {
        let _ = output_tx.try_send(envelope(
            &owner,
            "ack",
            json!({"sequence":last,"operation":"drain"}),
        ));
    }
    // Stop only the captured target incarnation; never search/kill arbitrary PIDs or units.
    let current_inv: Vec<u8> = target_unit.get_property("InvocationID")?;
    let current_slice: Vec<u8> = slice.get_property("InvocationID")?;
    let incarnation_valid =
        current_inv == target_inv && current_slice == slice_inv && boot()? == boot_id;
    if incarnation_valid {
        let stopped: Result<OwnedObjectPath, _> =
            manager.call("StopUnit", &(&target_name, "replace"));
        persist(
            &root.join("stop.json"),
            &json!({"requestedAt":requested,"error":stopped.err().map(|e|e.to_string()),"invocationId":hex(&target_inv)}),
        )?;
    } else {
        *observation.lock().unwrap() = (
            None,
            None,
            Some("unit/boot incarnation changed before stop".into()),
        );
        observing.store(false, Ordering::Release);
    }
    drop(helper_control);
    let evidence_deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < evidence_deadline {
        let observed = observation.lock().unwrap();
        if observed.0 == Some(0) || observed.2.is_some() {
            break;
        }
        drop(observed);
        std::thread::sleep(Duration::from_millis(5));
    }
    while gate.lock().unwrap().complete.len() < 2 {
        if done_rx
            .recv_timeout(evidence_deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            break;
        }
    }
    let unresolved_output = {
        let mut gate = gate.lock().unwrap();
        gate.closed = true;
        ["stdout", "stderr"]
            .into_iter()
            .filter(|stream| gate.complete.get(stream) != Some(&true))
            .collect::<Vec<_>>()
    };
    let output_complete = unresolved_output.is_empty();
    let output_time = now();
    let root_exited = !alive(&child_identity);
    observing.store(false, Ordering::Release);
    let _ = observation_reader.join();
    let population_fields = finalize_population(&observation, incarnation_valid, &target_name);
    let empty = population_fields["membershipEmpty"] == true;
    let mut evidence = serde_json::to_value(&owner)?;
    evidence.as_object_mut().unwrap().extend(json!({"schemaVersion":1,"environment":"wsl2","unitName":target_name,"invocationId":hex(&target_inv),"bootId":boot_id,"controlGroup":target_group,"observationSlice":observation_slice,"observer":observer_identity,"reason":reason,"requestAcknowledged":acknowledged,"requestedAt":requested,"acknowledgedAt":acknowledged_at,"rootExited":root_exited,"rootExitedAt":if root_exited{Some(output_time)}else{None},"outputComplete":output_complete,"unresolvedOutputStreams":unresolved_output,"outputCompletedAt":if output_complete{Some(output_time)}else{None},"completedAt":now()}).as_object().unwrap().clone());
    evidence
        .as_object_mut()
        .unwrap()
        .extend(population_fields.as_object().unwrap().clone());
    persist(&root.join("drain.json"), &evidence)?;
    let terminal = envelope(&owner, "drained", json!({"evidence":evidence}));
    let _ = output_tx.try_send(terminal);
    let flushed = flushed_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    // Evidence is durable before releasing the exclusive slice. Observer remains active here.
    if slice.get_property::<Vec<u8>>("InvocationID")? == slice_inv && boot()? == boot_id {
        let _: OwnedObjectPath = manager.call("StopUnit", &(&slice_name, "replace"))?;
    }
    manager.call::<_, _, ()>("UnrefUnit", &(&target_name,))?;
    manager.call::<_, _, ()>("UnrefUnit", &(&slice_name,))?;
    std::process::exit(if empty && root_exited && output_complete && flushed {
        0
    } else {
        2
    });
}

#[cfg(test)]
mod review_regressions {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn incarnation_mismatch_is_sticky_after_late_zero() {
        let observation = Arc::new(Mutex::new((Some(1u8), Some(1u64), None::<String>)));
        let sampled = Arc::new(Barrier::new(2));
        let publish = Arc::new(Barrier::new(2));
        let reader_observation = observation.clone();
        let reader_sampled = sampled.clone();
        let reader_publish = publish.clone();
        let reader = std::thread::spawn(move || {
            let late_zero = (Some(0u8), Some(2u64), None::<String>);
            reader_sampled.wait();
            reader_publish.wait();
            *reader_observation.lock().unwrap() = late_zero;
        });
        sampled.wait();
        let incarnation_valid = false;
        *observation.lock().unwrap() = (
            None,
            None,
            Some("unit/boot incarnation changed before stop".into()),
        );
        publish.wait();
        reader.join().unwrap();
        let authority =
            finalize_population(&observation, incarnation_valid, "owned-target.service");
        assert!(authority["cgroupPopulated"].is_null());
        assert!(authority["membershipObservedAt"].is_null());
        assert_eq!(authority["membershipEmpty"], false);
        assert!(
            authority["observationError"]
                .as_str()
                .unwrap()
                .contains("incarnation")
        );
        assert_eq!(
            authority["unresolvedUnits"],
            json!(["owned-target.service"])
        );
    }
}
