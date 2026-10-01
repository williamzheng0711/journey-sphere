// Shorten SVG syntax without changing any coordinate, ring, or closing edge.
// Repeated relative line commands may omit their command letter, and a minus
// sign separates adjacent numbers without whitespace under the SVG grammar.
export function compactWorldPath(path) {
  if (typeof path !== 'string') throw new Error('Invalid compiler world path.');
  const source = path.trim().replace(/\s+/g, ' ');
  if (!/^(?:M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)(?: M-?\d+ -?\d+(?:l-?\d+ -?\d+){3,}z)*$/.test(source)) {
    throw new Error('Invalid compiler world path.');
  }
  const pair = (x, y) => `${x}${y < 0 ? '' : ' '}${y}`;
  return [...source.matchAll(/M[^M]+/g)].map(([ring]) => {
    const commands = [...ring.matchAll(/(M|l)(-?\d+) (-?\d+)/g)];
    return commands.map(([, command, a, b], index) => {
      const x = Number(a), y = Number(b);
      const prefix = index < 2 ? command : x < 0 ? '' : ' ';
      return `${prefix}${pair(x, y)}`;
    }).join('') + 'z';
  }).join('');
}
