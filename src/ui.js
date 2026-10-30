// Terminal output helpers.

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  dim: wrap('2'),
  italic: wrap('3'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export const write = (s) => process.stdout.write(s);

export function truncateLines(text, maxLines) {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
}

export function indent(text, prefix = '  ') {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

// Length of a string as displayed, ignoring ANSI color codes.
export const visibleLength = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
