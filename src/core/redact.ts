export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]')
  return out
}
