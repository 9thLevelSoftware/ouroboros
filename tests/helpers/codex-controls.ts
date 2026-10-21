/** Independent explicit policy fixture. Deliberately does not call production
 * projections or infer missing restrictions from requested overrides. */
export function fixtureCodexControls() {
  return {
    permissions:{ouroboros_worker:{filesystem:{':minimal':'read','C:\\fixture':'read','C:\\controller':'deny'},network:{enabled:false,allow_local_binding:false,allow_upstream_proxy:false,dangerously_allow_all_unix_sockets:false,dangerously_allow_non_loopback_proxy:false,domains:{}}}},
    shell_environment_policy:{inherit:'none',ignore_default_excludes:false,exclude:[],include_only:['SystemRoot','SystemDrive','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'],experimental_use_profile:false,set:{SystemRoot:'C:\\Windows',SystemDrive:'C:',WINDIR:'C:\\Windows',TEMP:'C:\\fixture\\temp',TMP:'C:\\fixture\\temp',USERPROFILE:'C:\\fixture\\user',APPDATA:'C:\\fixture\\user\\AppData\\Roaming',LOCALAPPDATA:'C:\\fixture\\user\\AppData\\Local'}},
  };
}
