#![cfg(target_os = "linux")]
const MAX_FRAME: usize = 1024 * 1024;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn identity(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{pid}/stat"))
        .unwrap()
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .to_string()
}
struct Fixture {
    bridge: Child,
    rx: mpsc::Receiver<Value>,
    receipt: Value,
    root: std::path::PathBuf,
    action: String,
}
impl Fixture {
    fn launch(case: u64) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            ^ ((std::process::id() as u128) << 64)
            ^ case as u128;
        let token = format!("{nonce:032x}");
        let action = format!(
            "{}-{}-4{}-8{}-{}",
            &token[..8],
            &token[8..12],
            &token[13..16],
            &token[17..20],
            &token[20..]
        );
        let root = std::env::temp_dir().join(format!("ouroboros-t4-{action}"));
        fs::create_dir(&root).unwrap();
        let heartbeat = root.join("heartbeat");
        let script = root.join("fork.py");
        fs::write(&script,format!("import os,time\nif os.fork()==0:\n os.setsid()\n if os.fork()==0:\n  while True:\n   with open({:?},'a') as f: f.write('x')\n   time.sleep(.025)\n os._exit(0)\nwhile True: time.sleep(.1)\n",heartbeat.to_str().unwrap())).unwrap();
        let owner = json!({"runId":"11111111-1111-4111-8111-111111111111","generation":1,"actionId":action,"role":"qualification"});
        let mut bridge = Command::new(env!("CARGO_BIN_EXE_ouroboros-supervisor"))
            .arg("bridge")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stderr = bridge.stderr.take().unwrap();
        let diagnostics = root.join("bridge-stderr.log");
        std::thread::spawn(move || {
            let mut file = fs::File::create(diagnostics).unwrap();
            let mut bytes = [0; 4096];
            let mut remaining = 65536usize;
            while remaining > 0 {
                match stderr.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let take = n.min(remaining);
                        file.write_all(&bytes[..take]).unwrap();
                        remaining -= take;
                    }
                }
            }
            let _ = file.sync_all();
        });
        let spec = json!({"runId":owner["runId"],"generation":1,"actionId":action,"role":"qualification","executable":"/usr/bin/python3","argv":[script],"cwd":root,"env":{"PATH":"/usr/bin:/bin"},"boundaryHash":"a".repeat(64),"authorization":{"kind":"qualification","requestId":owner["runId"],"probeId":format!("task4-ownership-{case}"),"fixtureRoots":[root]},"stdin":"closed","leaseTtlMs":10000,"deadline":now()+30000});
        let mut initial = owner.as_object().unwrap().clone();
        initial.extend(
            json!({"protocolVersion":1,"type":"launch","spec":spec})
                .as_object()
                .unwrap()
                .clone(),
        );
        send(&mut bridge, Value::Object(initial));
        let (mut output, tx) = (bridge.stdout.take().unwrap(), {
            let (tx, rx) = mpsc::channel::<Value>();
            (tx, rx)
        });
        let (rx_sender, rx) = tx;
        std::thread::spawn(move || {
            loop {
                let mut prefix = [0; 4];
                if output.read_exact(&mut prefix).is_err() {
                    break;
                }
                let len = u32::from_le_bytes(prefix) as usize;
                assert!(len > 0 && len <= MAX_FRAME);
                let mut bytes = vec![0; len];
                if output.read_exact(&mut bytes).is_err() {
                    break;
                }
                if rx_sender
                    .send(serde_json::from_slice(&bytes).unwrap())
                    .is_err()
                {
                    break;
                }
            }
        });
        let receipt = loop {
            let frame = rx
                .recv_timeout(Duration::from_secs(15))
                .unwrap_or_else(|error| {
                    let detail =
                        fs::read_to_string(root.join("bridge-stderr.log")).unwrap_or_default();
                    panic!("launch receipt: {error}; bounded diagnostics: {detail}")
                });
            if frame["type"] == "launched" {
                break frame["receipt"].clone();
            }
        };
        assert_eq!(receipt["environment"], "wsl2");
        assert_eq!(receipt["identityCapturedBeforeExec"], true);
        assert_eq!(receipt["observationArmedBeforeExec"], true);
        assert!(receipt.get("jobIdentity").is_none());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0) < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "double-fork heartbeat did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Self {
            bridge,
            rx,
            receipt,
            root,
            action,
        }
    }
    fn drain(&mut self) {
        send(
            &mut self.bridge,
            json!({"protocolVersion":1,"runId":"11111111-1111-4111-8111-111111111111","generation":1,"actionId":self.action,"role":"qualification","type":"drain","sequence":1,"reason":"owned-test-drain"}),
        );
    }
    fn evidence(&mut self) -> Value {
        loop {
            let frame = self
                .rx
                .recv_timeout(Duration::from_secs(20))
                .expect("drain evidence");
            if frame["type"] == "drained" {
                return frame["evidence"].clone();
            }
        }
    }
    fn assert_drained(&mut self) {
        let evidence = self.evidence();
        assert_eq!(evidence["cgroupPopulated"], 0);
        assert_eq!(evidence["membershipEmpty"], true);
        assert!(evidence["membershipObservedAt"].as_u64().is_some());
        assert_eq!(evidence["outputComplete"], true);
        assert_eq!(evidence["unresolvedOutputStreams"], json!([]));
        assert_eq!(evidence["unresolvedUnits"], json!([]));
        let before = fs::metadata(self.root.join("heartbeat")).unwrap().len();
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(
            fs::metadata(self.root.join("heartbeat")).unwrap().len(),
            before
        );
        assert_eq!(self.bridge.wait().unwrap().code(), Some(0));
    }
}
fn send(child: &mut Child, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    let input = child.stdin.as_mut().unwrap();
    input
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    input.write_all(&bytes).unwrap();
    input.flush().unwrap();
}
#[test]
fn double_fork_drains() {
    let mut fixture = Fixture::launch(1);
    fixture.drain();
    fixture.assert_drained();
}
#[test]
fn helper_exit_drains_unit() {
    let mut fixture = Fixture::launch(2);
    let pid = fixture.receipt["helper"]["pid"].as_u64().unwrap() as u32;
    assert_eq!(
        identity(pid),
        fixture.receipt["helper"]["startTimeTicks"]
            .as_str()
            .unwrap()
    );
    assert!(
        Command::new("/usr/bin/kill")
            .args(["-9", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    fixture.assert_drained();
}
#[test]
fn other_unit_survives() {
    let mut first = Fixture::launch(3);
    let mut other = Fixture::launch(4);
    first.drain();
    first.assert_drained();
    let before = fs::metadata(other.root.join("heartbeat")).unwrap().len();
    std::thread::sleep(Duration::from_millis(200));
    assert!(fs::metadata(other.root.join("heartbeat")).unwrap().len() > before);
    other.drain();
    other.assert_drained();
}
