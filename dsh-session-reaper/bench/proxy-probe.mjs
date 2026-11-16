// Scratch: is a text-length proxy a SAFE replacement for the estimateBytes object walk?
// Compares accuracy (vs the full walk) and CPU on three payload shapes. Read-only experiment.

// Replicated from lazy.mjs:890 (the current full walk).
function estimateBytes(value) {
  const scalar = (item) => (typeof item === 'string' ? 16 + item.length * 2 : 8);
  if (value === null || typeof value !== 'object') return scalar(value);
  let total = 32;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) {
        if (item !== null && typeof item === 'object') { total += 32; stack.push(item); }
        else total += scalar(item);
      }
    } else {
      for (const key of Object.keys(current)) {
        total += 16 + key.length * 2;
        const child = current[key];
        if (child !== null && typeof child === 'object') { total += 32; stack.push(child); }
        else total += scalar(child);
      }
    }
  }
  return total;
}

// Candidate A: pure text length (what I proposed).
const pureText = (text) => text.length * 2;

// Candidate B: structural text scan — text bytes + object/array/key headers counted from the source.
function structural(text) {
  let objects = 0, arrays = 0, keys = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 123) objects += 1;        // {
    else if (c === 91) arrays += 1;     // [
    else if (c === 58) keys += 1;       // :
  }
  return text.length * 2 + objects * 32 + arrays * 32 + keys * 16;
}

const shapes = {
  'string-dominated (200k text)': { type: 'tool/result', seq: 0, time: 1, data: { text: 'x'.repeat(200_000) } },
  'object-heavy (15k rows)': { type: 'tool/result', seq: 0, time: 1, data: { rows: Array.from({ length: 15_000 }, (_, i) => ({ i, s: 'abcdefghij' })) } },
  'mixed (content blocks)': { type: 'assistant/message', seq: 0, time: 1, data: { message: { role: 'assistant', content: Array.from({ length: 200 }, (_, i) => ({ type: 'text', text: `block ${i} `.padEnd(2000, 'y') })) } } },
};

const N = 200;
for (const [name, value] of Object.entries(shapes)) {
  const text = JSON.stringify(value);
  const walk = estimateBytes(value);
  const a = pureText(text);
  const b = structural(text);
  const bench = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < N; i += 1) fn(); return Number(process.hrtime.bigint() - t) / 1e6 / N; };
  const msWalk = bench(() => estimateBytes(value));
  const msA = bench(() => pureText(text));
  const msB = bench(() => structural(text));
  console.log(`\n${name}`);
  console.log(`  text.length=${text.length}`);
  console.log(`  full walk   = ${walk} bytes  (${msWalk.toFixed(3)} ms)`);
  console.log(`  pureText    = ${a} bytes  (${msA.toFixed(3)} ms)  ratio=${(a / walk).toFixed(2)}x  ${a < walk ? 'UNDERCOUNTS' : 'ok'}`);
  console.log(`  structural  = ${b} bytes  (${msB.toFixed(3)} ms)  ratio=${(b / walk).toFixed(2)}x  ${b < walk ? 'UNDERCOUNTS' : 'ok'}`);
}