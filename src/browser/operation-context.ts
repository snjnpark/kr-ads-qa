let signal: AbortSignal | undefined;
export function setOperationSignal(value?: AbortSignal) { signal = value; }
export const operationFetch: typeof fetch = (input, init = {}) => {
  const signals = [signal, init.signal].filter((item): item is AbortSignal => !!item);
  return fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
};
