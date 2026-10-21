export function cloneState<T>(s: T): T { return JSON.parse(JSON.stringify(s)) as T; }
