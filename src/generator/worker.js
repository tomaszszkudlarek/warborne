import { generateMap } from './generate.js';

// Runs generation off the main thread; typed arrays are transferred, not copied.
self.onmessage = (e) => {
  const { id, params } = e.data;
  try {
    const map = generateMap(params, (stage, progress) => self.postMessage({ type: 'progress', id, stage, progress }));
    const transfer = new Set();
    const collect = (v) => {
      if (ArrayBuffer.isView(v)) transfer.add(v.buffer);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(map);
    self.postMessage({ type: 'done', id, map }, [...transfer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message, stack: err.stack });
  }
};
