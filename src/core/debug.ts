/** `?debug` in the URL: exposes `window.app` / `window.THREE` and logs build timings. */
export const DEBUG = new URLSearchParams(location.search).has('debug');
