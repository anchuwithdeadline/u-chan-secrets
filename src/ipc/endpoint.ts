export function defaultEndpoint(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.U_CHAN_IPC) return env.U_CHAN_IPC
  if (platform === 'win32') return String.raw`\\.\pipe\u-chan-secrets`
  return '/var/run/u-chan-secrets/ipc.sock'
}
