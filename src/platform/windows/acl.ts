import child_process from 'node:child_process'
import { UserFacingError } from '../../core/types.js'

export type ExecOptions = { windowsVerbatimArguments?: boolean }
export type ExecFn = (file: string, args: string[], options?: ExecOptions) => Promise<{ stdout: string; stderr: string }>

export const defaultExec: ExecFn = async (file: string, args: string[], options?: ExecOptions): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    child_process.execFile(file, args, { windowsVerbatimArguments: options?.windowsVerbatimArguments ?? false }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }))
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    })
  })
}

export async function setAdminOnlyAcl(dirPath: string, exec: ExecFn = defaultExec, recursive = true): Promise<void> {
  try {
    const path = Buffer.from(dirPath, 'utf8').toString('base64')
    const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'));
$root=Get-Item -LiteralPath $p -Force;
if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse point refused'};
$items=@($root)${recursive ? '+@(Get-ChildItem -LiteralPath $p -Force -Recurse)' : ''};
foreach($i in $items){if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse point refused'}};
$admins=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');
foreach($i in $items){
 if($i.PSIsContainer){$acl=New-Object Security.AccessControl.DirectorySecurity; $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
 else{$acl=New-Object Security.AccessControl.FileSecurity; $inherit=[Security.AccessControl.InheritanceFlags]::None};
 $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($admins);
 foreach($sid in @('S-1-5-18','S-1-5-32-544')){
  $id=New-Object Security.Principal.SecurityIdentifier($sid);
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl',$inherit,'None','Allow')));
 };
 if($i.PSIsContainer){[IO.Directory]::SetAccessControl($i.FullName,$acl)}else{[IO.File]::SetAccessControl($i.FullName,$acl)}
}`
    const { stdout, stderr } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    if (/Failed processing [1-9]/i.test(stdout) || /Failed processing [1-9]/i.test(stderr)) {
      throw new Error(`icacls failed: ${stdout || stderr}`)
    }
  } catch (err: any) {
    if (err instanceof UserFacingError) {
      throw err
    }
    throw new UserFacingError(
      `Failed to set administrator-only permissions on ${dirPath}: ${err?.message ?? String(err)}`
    )
  }
}
