//! Narrow Windows FFI boundary. Every returned owned handle has one RAII owner.
use crate::protocol::LaunchSpec;
use std::{ffi::c_void, fs::File, io, mem::{size_of, size_of_val, zeroed}, os::windows::io::{FromRawHandle, RawHandle}, ptr::{null, null_mut}, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, Security::SECURITY_ATTRIBUTES, System::{JobObjects::*, Pipes::CreatePipe, Threading::*}};
struct Handle(HANDLE);
impl Handle { fn new(raw:HANDLE)->io::Result<Self> {if raw.is_null() || raw==INVALID_HANDLE_VALUE {Err(io::Error::last_os_error())} else {Ok(Self(raw))}} }
impl Drop for Handle {fn drop(&mut self){unsafe {CloseHandle(self.0);}}}
fn check(ok:i32)->io::Result<()> {if ok==0 {Err(io::Error::last_os_error())} else {Ok(())}}
fn wide(s:&str)->Vec<u16> {s.encode_utf16().chain([0]).collect()}
pub fn creation_identity(handle:HANDLE)->io::Result<String> {
    // FILETIMEs are initialized outputs; the retained kernel process handle prevents PID reuse ambiguity.
    unsafe {let mut c=zeroed();let mut e=zeroed();let mut k=zeroed();let mut u=zeroed();check(GetProcessTimes(handle,&mut c,&mut e,&mut k,&mut u))?;Ok(format!("{:016x}",((c.dwHighDateTime as u64)<<32)|c.dwLowDateTime as u64))}
}
pub fn helper_creation_identity()->io::Result<String> {unsafe {creation_identity(GetCurrentProcess())}}
pub struct Job {handle:Handle}
impl Job {
    pub fn new()->io::Result<Self> {
        unsafe {let handle=Handle::new(CreateJobObjectW(null(),null()))?;let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=zeroed();
            // No breakaway flags; the unnamed noninheritable job handle lives only in this helper.
            limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            check(SetInformationJobObject(handle.0,JobObjectExtendedLimitInformation,&limits as *const _ as *const c_void,size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32))?;Ok(Self {handle})}
    }
    pub fn launch(&self,spec:&LaunchSpec)->io::Result<OwnedChild> {unsafe {launch_in_job(self.handle.0,spec)}}
    pub fn active(&self)->io::Result<u32> {unsafe {let mut info:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=zeroed();check(QueryInformationJobObject(self.handle.0,JobObjectBasicAccountingInformation,&mut info as *mut _ as *mut c_void,size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,null_mut()))?;Ok(info.ActiveProcesses)}}
    pub fn members(&self)->io::Result<Vec<u32>> {
        // Allocate aligned storage, retry a growth race, and never turn a query failure into emptiness.
        unsafe {let mut capacity=self.active()? as usize+16;for _ in 0..4 {
            let bytes=size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()+capacity*size_of::<usize>();let mut storage=vec![0usize;bytes.div_ceil(size_of::<usize>())];
            let ptr=storage.as_mut_ptr() as *mut JOBOBJECT_BASIC_PROCESS_ID_LIST;
            if QueryInformationJobObject(self.handle.0,JobObjectBasicProcessIdList,ptr as *mut c_void,bytes as u32,null_mut())!=0 {
                let count=(*ptr).NumberOfProcessIdsInList as usize;if count>capacity {return Err(io::Error::other("invalid job membership length"));}
                return Ok(std::slice::from_raw_parts((*ptr).ProcessIdList.as_ptr(),count).iter().map(|pid|*pid as u32).collect());
            } capacity=capacity.saturating_mul(2);
        }Err(io::Error::last_os_error())}
    }
    pub fn terminate(&self)->io::Result<()> {unsafe {check(TerminateJobObject(self.handle.0,1))}}
}
pub struct OwnedChild {process:Handle, thread:Handle, pub pid:u32, pub creation:String, pub stdout:Option<File>, pub stderr:Option<File>, pub stdin:Option<File>, resumed:bool}
impl OwnedChild {
    pub fn resume(&mut self)->io::Result<()> {unsafe {if ResumeThread(self.thread.0)==u32::MAX {return Err(io::Error::last_os_error());}}self.resumed=true;Ok(())}
    pub fn exited(&self)->io::Result<bool> {unsafe {match WaitForSingleObject(self.process.0,0) {WAIT_OBJECT_0=>Ok(true),WAIT_TIMEOUT=>Ok(false),_=>Err(io::Error::last_os_error())}}}
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.resumed {
            // Any failure between CreateProcess and ResumeThread rolls back the still-suspended root.
            unsafe {TerminateProcess(self.process.0,1);WaitForSingleObject(self.process.0,5000);}
        }
    }
}
struct Attributes {ptr:LPPROC_THREAD_ATTRIBUTE_LIST, _storage:Vec<usize>}
impl Drop for Attributes {fn drop(&mut self){unsafe {DeleteProcThreadAttributeList(self.ptr);}}}
fn pipe()->io::Result<(Handle,Handle)> {
    unsafe {let sa=SECURITY_ATTRIBUTES {nLength:size_of::<SECURITY_ATTRIBUTES>() as u32,lpSecurityDescriptor:null_mut(),bInheritHandle:1};let mut read=null_mut();let mut write=null_mut();check(CreatePipe(&mut read,&mut write,&sa,0))?;Ok((Handle::new(read)?,Handle::new(write)?))}
}
fn file(handle:Handle)->File {let raw=handle.0;std::mem::forget(handle);unsafe {File::from_raw_handle(raw as RawHandle)}}
/// Caller supplies a Job Object HANDLE for the duration of the call. Invalid handles
/// are rejected by the kernel, with rollback; this function never dereferences a handle.
pub unsafe fn launch_in_job(job:HANDLE,spec:&LaunchSpec)->io::Result<OwnedChild> {
    spec.validate().map_err(io::Error::other)?;
    let (stdin_read,stdin_write)=pipe()?;let (stdout_read,stdout_write)=pipe()?;let (stderr_read,stderr_write)=pipe()?;
    unsafe {check(SetHandleInformation(stdin_write.0,HANDLE_FLAG_INHERIT,0))?;}
    let stdin=if spec.stdin=="pipe" {Some(file(stdin_write))}else{drop(stdin_write);None};
    unsafe {check(SetHandleInformation(stdout_read.0,HANDLE_FLAG_INHERIT,0))?;check(SetHandleInformation(stderr_read.0,HANDLE_FLAG_INHERIT,0))?;}
    let mut handles=[stdin_read.0,stdout_write.0,stderr_write.0];
    let mut bytes=0;unsafe {InitializeProcThreadAttributeList(null_mut(),1,0,&mut bytes);}
    if bytes==0 {return Err(io::Error::last_os_error());}
    let mut storage=vec![0usize;bytes.div_ceil(size_of::<usize>())];let ptr=storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    unsafe {check(InitializeProcThreadAttributeList(ptr,1,0,&mut bytes))?;}
    let attributes=Attributes {ptr,_storage:storage};
    unsafe {check(UpdateProcThreadAttribute(attributes.ptr,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,handles.as_mut_ptr() as *mut c_void,size_of_val(&handles),null_mut(),null_mut()))?;}
    let mut startup:STARTUPINFOEXW=unsafe {zeroed()};startup.StartupInfo.cb=size_of::<STARTUPINFOEXW>() as u32;startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;startup.StartupInfo.hStdInput=stdin_read.0;startup.StartupInfo.hStdOutput=stdout_write.0;startup.StartupInfo.hStdError=stderr_write.0;startup.lpAttributeList=attributes.ptr;
    let executable=wide(&spec.executable);let cwd=wide(&spec.cwd);
    let command=std::iter::once(spec.executable.as_str()).chain(spec.argv.iter().map(String::as_str)).map(quote_argument).collect::<Vec<_>>().join(" ");let mut command=wide(&command);
    if command.len()>32767 {return Err(io::Error::other("Windows command line exceeds 32767 UTF-16 units"));}
    let mut env=Vec::new();let mut entries:Vec<_>=spec.env.iter().collect();entries.sort_by_key(|(k,_)|k.to_uppercase());for (k,v) in entries {env.extend(format!("{k}={v}").encode_utf16());env.push(0);}env.push(0);if env.len()==1 {env.push(0);}
    let mut process:PROCESS_INFORMATION=unsafe {zeroed()};
    unsafe {check(CreateProcessW(executable.as_ptr(),command.as_mut_ptr(),null(),null(),1,CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,env.as_ptr() as *const c_void,cwd.as_ptr(),&startup.StartupInfo,&mut process))?;}
    let mut child=OwnedChild {process:Handle::new(process.hProcess)?,thread:Handle::new(process.hThread)?,pid:process.dwProcessId,creation:String::new(),stdout:Some(file(stdout_read)),stderr:Some(file(stderr_read)),stdin,resumed:false};
    unsafe {check(AssignProcessToJobObject(job,child.process.0))?;}
    child.creation=creation_identity(child.process.0)?;
    // Child-side pipe handles and attribute storage close here, leaving only the explicit inherited copies.
    Ok(child)
}
fn quote_argument(arg:&str)->String {
    // Microsoft CRT/CommandLineToArgvW convention: double slash runs before quotes
    // and at the closing quote. Always quote, including the empty argument.
    let mut out=String::from("\"");let mut slashes=0;
    for c in arg.chars() {if c=='\\' {slashes+=1;continue;} if c=='"' {out.push_str(&"\\".repeat(slashes*2+1));out.push('"');}else{out.push_str(&"\\".repeat(slashes));out.push(c);}slashes=0;}
    out.push_str(&"\\".repeat(slashes*2));out.push('"');out
}
pub fn observe_drain(job:&Job,child:&OwnedChild,end:Instant)->(bool,u32,Vec<u32>) {
    loop {
        let exited=child.exited().unwrap_or(false);let active=job.active().unwrap_or(u32::MAX);
        if exited && active==0 {return (true,0,Vec::new());}
        if Instant::now()>=end {return (exited,active,job.members().unwrap_or_else(|_|vec![child.pid]));}
        std::thread::sleep(Duration::from_millis(25).min(end.saturating_duration_since(Instant::now())));
    }
}
