type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (reason?: any) => void;
};

/**
 * @returns An object containing a promise and its resolve/reject methods.
 */
export function createDeferredPromise<T>(): DeferredPromise<T> {
  let res: any;
  let rej: any;
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });

  return {promise, resolve: res, reject: rej} as DeferredPromise<T>;
}
