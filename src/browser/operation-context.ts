let signal: AbortSignal | undefined;
export function setOperationSignal(value?: AbortSignal) { signal = value; }
export function getOperationSignal() { return signal; }
export const operationFetch: typeof fetch = (input, init = {}) => {
  const signals = [signal, init.signal, input instanceof Request ? input.signal : undefined].filter((item): item is AbortSignal => !!item);
  return fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
};
