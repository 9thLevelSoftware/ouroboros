use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read},
};
pub const MAX_FRAME: usize = 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub run_id: String,
    pub generation: u64,
    pub action_id: String,
    pub role: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Authorization {
    #[serde(rename = "user-task")]
    UserTask {
        #[serde(rename = "authorizationId")]
        authorization_id: String,
        #[serde(rename = "taskHash")]
        task_hash: String,
    },
    Qualified {
        #[serde(rename = "qualificationRef")]
        qualification_ref: String,
    },
    Qualification {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "probeId")]
        probe_id: String,
        #[serde(rename = "fixtureRoots")]
        fixture_roots: Vec<String>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub run_id: String,
    pub generation: u64,
    pub action_id: String,
    pub role: String,
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub boundary_hash: String,
    pub authorization: Authorization,
    pub lease_ttl_ms: u64,
    pub deadline: u64,
    #[serde(default, deserialize_with = "optional_cutoff", skip_serializing_if = "Option::is_none")]
    pub launch_not_after: Option<u64>,
    #[serde(default = "closed_stdin")]
    pub stdin: String,
}
fn closed_stdin() -> String {
    "closed".into()
}
fn optional_cutoff<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    // Omission is compatible with older callers; an explicit null is not a cutoff.
    u64::deserialize(deserializer).map(Some)
}
impl LaunchSpec {
    pub fn owner(&self) -> Owner {
        Owner {
            run_id: self.run_id.clone(),
            generation: self.generation,
            action_id: self.action_id.clone(),
            role: self.role.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if !uuid(&self.run_id)
            || !uuid(&self.action_id)
            || self.generation == 0
            || self.generation > 9007199254740991
            || self.role.trim().is_empty()
        {
            return Err("invalid owner".into());
        }
        if !matches!(self.stdin.as_str(), "closed" | "pipe") || self.deadline == 0 || self.deadline > 9007199254740991 {
            return Err("invalid input mode or deadline".into());
        }
        if self.launch_not_after.is_some_and(|cutoff| cutoff == 0 || cutoff > self.deadline) {
            return Err("invalid launch admission cutoff".into());
        }
        if !std::path::Path::new(&self.executable).is_absolute()
            || !std::path::Path::new(&self.cwd).is_absolute()
        {
            return Err("absolute executable and cwd required".into());
        }
        if self.executable.contains('\0')
            || self.cwd.contains('\0')
            || self.argv.iter().any(|s| s.contains('\0'))
        {
            return Err("NUL in launch input".into());
        }
        let mut keys = std::collections::BTreeSet::new();
        for (k, v) in &self.env {
            if k.is_empty()
                || k.contains(['=', '\0'])
                || v.contains('\0')
                || !keys.insert(k.to_uppercase())
            {
                return Err("invalid or duplicate environment key".into());
            }
        }
        if self.boundary_hash.len() != 64
            || !self
                .boundary_hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || self.lease_ttl_ms == 0
            || self.lease_ttl_ms > 10000
        {
            return Err("invalid hash or lease".into());
        }
        match &self.authorization {
            Authorization::UserTask { authorization_id, task_hash }
                if !uuid(authorization_id) || !sha256(task_hash) =>
            {
                return Err("invalid user-task authorization declaration".into());
            }
            Authorization::Qualified { qualification_ref }
                if qualification_ref.trim().is_empty() =>
            {
                return Err("qualification reference required".into());
            }
            Authorization::Qualification {
                request_id,
                probe_id,
                fixture_roots,
            } if !uuid(request_id)
                || probe_id.trim().is_empty()
                || fixture_roots.is_empty()
                || fixture_roots
                    .iter()
                    .any(|p| p.contains('\0') || !std::path::Path::new(p).is_absolute()) =>
            {
                return Err("invalid qualification declaration".into());
            }
            _ => (),
        }
        Ok(())
    }
    // Recheck at each irreversible launch boundary; this cutoff never shortens
    // the task's execution deadline after the root has started.
    pub fn ensure_launch_current(&self, now: u64) -> Result<(), String> {
        if self.deadline <= now {
            return Err("deadline expired before launch".into());
        }
        if self.launch_not_after.is_some_and(|cutoff| cutoff <= now) {
            return Err("launch admission cutoff expired".into());
        }
        Ok(())
    }
}
fn sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub protocol_version: u32,
    pub run_id: String,
    pub generation: u64,
    pub action_id: String,
    pub role: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub spec: Option<LaunchSpec>,
    pub sequence: Option<u64>,
    pub reason: Option<String>,
    pub data: Option<String>,
    pub lease_sequence: Option<u64>,
}
impl Control {
    pub fn owner(&self) -> Owner {
        Owner {
            run_id: self.run_id.clone(),
            generation: self.generation,
            action_id: self.action_id.clone(),
            role: self.role.clone(),
        }
    }
}
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Control>> {
    let mut prefix = [0; 4];
    let n = reader.read(&mut prefix[..1])?;
    if n == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut prefix[1..])?;
    let size = u32::from_le_bytes(prefix) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame size"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes)?;
    let text =
        std::str::from_utf8(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    serde_json::from_str(text)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = *chunk.get(1).unwrap_or(&0) as u32;
        let c = *chunk.get(2).unwrap_or(&0) as u32;
        let bits = (a << 16) | (b << 8) | c;
        out.push(TABLE[((bits >> 18) & 63) as usize] as char);
        out.push(TABLE[((bits >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub fn decode_base64(s: &str) -> Option<Vec<u8>> {
    if s.len() > 87384 || s.len() % 4 != 0 {
        return None;
    }
    let mut bytes = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
        }
    }
    if base64(&bytes) == s {
        Some(bytes)
    } else {
        None
    }
}

#[cfg(test)]
mod launch_admission_tests {
    use super::*;
    use serde_json::json;

    fn spec_value() -> serde_json::Value {
        let root = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        json!({"runId":"11111111-1111-4111-8111-111111111111","generation":1,
            "actionId":"22222222-2222-4222-8222-222222222222","role":"implementation",
            "executable":std::env::current_exe().unwrap().to_string_lossy(),"cwd":root,"argv":[],"env":{},
            "boundaryHash":"a".repeat(64),"leaseTtlMs":10000,"deadline":2000,
            "authorization":{"kind":"user-task","authorizationId":"33333333-3333-4333-8333-333333333333","taskHash":"b".repeat(64)}})
    }
    #[test]
    fn user_task_exact_wire_roundtrip_and_validation() {
        let value = spec_value();
        let spec: LaunchSpec = serde_json::from_value(value.clone()).unwrap();
        spec.validate().unwrap();
        assert_eq!(serde_json::to_value(&spec).unwrap()["authorization"], value["authorization"]);
        for (field, bad) in [("authorizationId", "not-a-uuid"), ("taskHash", "invalid-hash")] {
            let mut invalid = value.clone(); invalid["authorization"][field] = bad.into();
            assert!(serde_json::from_value::<LaunchSpec>(invalid).unwrap().validate().is_err());
        }
        let mut invalid = value; invalid["authorization"]["kind"] = "userTask".into();
        assert!(serde_json::from_value::<LaunchSpec>(invalid).is_err());
    }
    #[test]
    fn historical_authorizations_and_missing_cutoff_remain_compatible() {
        for authorization in [json!({"kind":"qualified","qualificationRef":"old-receipt"}),
            json!({"kind":"qualification","requestId":"33333333-3333-4333-8333-333333333333","probeId":"probe","fixtureRoots":[std::env::current_dir().unwrap().to_string_lossy()]})] {
            let mut value = spec_value(); value["authorization"] = authorization;
            let spec: LaunchSpec = serde_json::from_value(value).unwrap();
            spec.validate().unwrap(); assert_eq!(spec.launch_not_after, None);
            assert!(serde_json::to_value(&spec).unwrap().get("launchNotAfter").is_none());
            spec.ensure_launch_current(1999).unwrap();
        }
    }
    #[test]
    fn cutoff_expires_at_boundary_independently_of_task_deadline() {
        let mut value = spec_value(); value["launchNotAfter"] = 1500.into();
        let spec: LaunchSpec = serde_json::from_value(value).unwrap(); spec.validate().unwrap();
        spec.ensure_launch_current(1499).unwrap();
        assert_eq!(spec.ensure_launch_current(1500).unwrap_err(), "launch admission cutoff expired");
        assert_eq!(spec.ensure_launch_current(1501).unwrap_err(), "launch admission cutoff expired");
        assert_eq!(spec.deadline, 2000);
        assert_eq!(spec.ensure_launch_current(2000).unwrap_err(), "deadline expired before launch");
    }
    #[test]
    fn cutoff_is_positive_safe_and_no_later_than_deadline() {
        for cutoff in [0u64, 2001, 9007199254740992] {
            let mut value = spec_value(); value["launchNotAfter"] = cutoff.into();
            assert!(serde_json::from_value::<LaunchSpec>(value).unwrap().validate().is_err());
        }
        for cutoff in [serde_json::Value::Null, json!(1.5), json!(-1)] {
            let mut value = spec_value(); value["launchNotAfter"] = cutoff;
            assert!(serde_json::from_value::<LaunchSpec>(value).is_err());
        }
        let mut value = spec_value(); value["launchNotAfter"] = 2000.into();
        serde_json::from_value::<LaunchSpec>(value).unwrap().validate().unwrap();
    }
}
