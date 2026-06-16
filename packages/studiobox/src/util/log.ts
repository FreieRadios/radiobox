/** Minimal tagged logger; mirrors radiobox's `[tag] message` console style. */
function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function makeLog(tag: string) {
  const prefix = `[${tag}]`;
  return {
    info: (...args: unknown[]) => console.log(ts(), prefix, ...args),
    warn: (...args: unknown[]) => console.warn(ts(), prefix, ...args),
    error: (...args: unknown[]) => console.error(ts(), prefix, ...args),
  };
}

export type Log = ReturnType<typeof makeLog>;
