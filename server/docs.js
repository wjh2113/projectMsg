import fs from 'node:fs/promises';
import path from 'node:path';

const README_CANDIDATES = [
  'README.md',
  'readme.md',
  'README.MD',
  'README',
  'AGENTS.md',
  'docs/README.md',
];

const MAKEMONEY_CANDIDATES = [
  'makemoney.md',
  'MakeMoney.md',
  'MAKEMONEY.md',
  'make-money.md',
  'make_money.md',
  'docs/makemoney.md',
  'docs/MakeMoney.md',
];

async function readFirstExisting(projectPath, candidates, maxBytes = 200_000) {
  const abs = path.resolve(projectPath);
  for (const rel of candidates) {
    const full = path.join(abs, rel);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      const content = await fs.readFile(full, 'utf8');
      return {
        name: rel,
        path: full,
        size: st.size,
        mtime: st.mtime.toISOString(),
        content: content.slice(0, maxBytes),
        truncated: content.length > maxBytes,
      };
    } catch {
      // skip missing
    }
  }
  return null;
}

export async function readMakemoney(projectPath) {
  return readFirstExisting(projectPath, MAKEMONEY_CANDIDATES, 200_000);
}

export async function readProjectDocs(projectPath) {
  const abs = path.resolve(projectPath);
  const files = [];

  for (const rel of README_CANDIDATES) {
    const full = path.join(abs, rel);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      const content = await fs.readFile(full, 'utf8');
      files.push({
        name: rel,
        path: full,
        size: st.size,
        mtime: st.mtime.toISOString(),
        content: content.slice(0, 200_000),
        truncated: content.length > 200_000,
      });
    } catch {
      // skip missing
    }
  }

  const readme = files.find((f) => /^readme/i.test(path.basename(f.name))) || files[0] || null;
  const makemoney = await readMakemoney(abs);
  return {
    readme,
    makemoney,
    docs: files,
  };
}
