/**
 * A small JSONC reader: strict JSON plus `//` and block comments and trailing
 * commas. OpenCode's config ships as either `.json` or `.jsonc`.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

function stripJsonc(text: string): string {
  let out = '';
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (char === '\\') {
        out += text[index + 1] ?? '';
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }

    out += char;
  }

  return out.replace(/,(\s*[}\]])/g, '$1');
}
