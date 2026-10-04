import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { WorkspaceError } from './errors.ts'

const execute = promisify(execFile)

/** Provision only a new caller-owned private box for the pinned SDK's ACL API.
 * The caller needs WRITE_OWNER to assign the low-integrity label. This does not
 * give the restricted child a capability SID granting WRITE_OWNER or WRITE_DAC.
 */
export async function prepareNativeSandboxDirectory(box: string, home: string, tempRoot: string): Promise<void> {
  if (process.platform !== 'win32') return
  const root = resolve(box)
  const privateHome = resolve(home)
  const temp = resolve(tempRoot)
  if (!isAbsolute(box) || !isAbsolute(home) || !isAbsolute(tempRoot)
      || basename(root) !== 'box' || privateHome !== join(root, 'state', 'home')
      || temp !== join(dirname(root), 'tmp')) {
    throw new WorkspaceError('invalid_path', 'Native ACL preparation requires a private box and child home')
  }
  // Reject junctions in every existing component, including service-root ancestors.
  for (const target of [root, privateHome, temp]) {
    let current = target
    while (dirname(current) !== current) {
      if ((await lstat(current)).isSymbolicLink()) throw new WorkspaceError('invalid_path', 'Native ACL path contains a link')
      current = dirname(current)
    }
    if ((await realpath(target)).toLowerCase() !== target.toLowerCase()) {
      throw new WorkspaceError('invalid_path', 'Native ACL path is not canonical')
    }
  }
  const script = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($path in @($env:LACHESIS_PRIVATE_BOX, $env:LACHESIS_PRIVATE_TMP)) {
$acl = Get-Acl -LiteralPath $path
$owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $identity.Value) { throw 'Private box must be owned by the current service identity' }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
$saved = Get-Acl -LiteralPath $path
$found = $saved.Access | Where-Object { (-not $_.IsInherited) -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $identity.Value -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl }
if (-not $found) { throw 'Private box caller ACL was not saved' }
}
`
  const powershellRoot = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  await execute(join(powershellRoot, 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, LACHESIS_PRIVATE_BOX: root, LACHESIS_PRIVATE_TMP: temp,
        HOME: privateHome, USERPROFILE: privateHome, DSH_HOME: privateHome,
        TEMP: temp, TMP: temp, TMPDIR: temp,
        PSModulePath: join(powershellRoot, 'Modules'),
        APPDATA: join(privateHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(privateHome, 'AppData', 'Local') },
    })
}
