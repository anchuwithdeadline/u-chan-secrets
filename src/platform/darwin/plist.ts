export const PLIST_LABEL = 'com.uchan.secrets'
export const PLIST_PATH = '/Library/LaunchDaemons/com.uchan.secrets.plist'

export interface PlistConfig {
  nodePath: string
  serviceScriptPath: string
  homeDir: string
  outLogPath: string
  errLogPath: string
}

export function generateLaunchdPlist(cfg: PlistConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${cfg.nodePath}</string>
        <string>${cfg.serviceScriptPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${cfg.homeDir}</string>
    <key>StandardOutPath</key>
    <string>${cfg.outLogPath}</string>
    <key>StandardErrorPath</key>
    <string>${cfg.errLogPath}</string>
</dict>
</plist>
`
}
