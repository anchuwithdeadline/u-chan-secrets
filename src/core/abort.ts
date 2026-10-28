/** Cancels owned resources before rejecting; late initialization results are disposed. */
export async function abortable<T>(
  work: Promise<T>, signal?: AbortSignal, cancel: () => Promise<unknown> = async () => {},
  disposeLate?: (value: T) => Promise<unknown>,
): Promise<T> {
  if (!signal) return work
  let cleanup: Promise<unknown> | undefined
  let reject!: (reason: unknown) => void
  const stopped = new Promise<never>((_resolve, r) => { reject = r })
  const abort = () => {
    cleanup ??= Promise.resolve().then(cancel)
    void cleanup.then(() => reject(signal.reason), reject)
  }
  const running = work.then(async value => {
    if (signal.aborted) {
      await disposeLate?.(value)
      throw signal.reason
    }
    return value
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try { return await Promise.race([running, stopped]) }
  finally {
    signal.removeEventListener('abort', abort)
    if (signal.aborted) await cleanup?.catch(() => {})
  }
}
