export const extname = p => { const b = String(p).split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export default { extname };
