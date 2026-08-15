/**
 * Push current HEAD to GitHub via Git Data API (api.github.com),
 * used when github.com:443 is unreachable but `gh api` works.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OWNER = 'wjh2113';
const REPO = 'projectMsg';
const BRANCH = 'main';

function ghJson(args, input) {
  const opts = {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  try {
    const out = execFileSync('gh', ['api', ...args], {
      ...opts,
      input: input || undefined,
    });
    return out ? JSON.parse(out) : {};
  } catch (err) {
    const stderr = err.stderr?.toString?.() || err.message;
    throw new Error(`gh api ${args.join(' ')} failed: ${stderr}`);
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function walkTree(prefix = '') {
  const lines = git(['ls-tree', '-r', 'HEAD', '--full-tree', prefix || '.']).split('\n').filter(Boolean);
  // mode type sha\tpath
  return lines.map((line) => {
    const [meta, filePath] = line.split('\t');
    const [mode, type, sha] = meta.split(/\s+/);
    return { mode, type, sha, path: filePath };
  });
}

async function main() {
  const commitMsg = git(['log', '-1', '--format=%B']);
  const files = walkTree();
  console.log(`Uploading ${files.length} blobs…`);

  const tree = [];
  for (const f of files) {
    const abs = path.resolve(f.path);
    const buf = fs.readFileSync(abs);
    const isText = !/\.(png|jpg|jpeg|gif|webp|ico|woff2?|zip|7z|exe|dll)$/i.test(f.path);
    const body = isText
      ? JSON.stringify({ content: buf.toString('utf8'), encoding: 'utf-8' })
      : JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' });

    const blob = ghJson(
      ['-X', 'POST', `repos/${OWNER}/${REPO}/git/blobs`, '--input', '-'],
      body,
    );
    tree.push({
      path: f.path.replace(/\\/g, '/'),
      mode: f.mode === '100755' ? '100755' : '100644',
      type: 'blob',
      sha: blob.sha,
    });
    console.log(`  blob ${f.path}`);
  }

  const treeRes = ghJson(
    ['-X', 'POST', `repos/${OWNER}/${REPO}/git/trees`, '--input', '-'],
    JSON.stringify({ tree }),
  );
  console.log(`tree ${treeRes.sha}`);

  let parent = null;
  try {
    const ref = ghJson([`repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`]);
    parent = ref.object?.sha || null;
  } catch {
    parent = null;
  }

  const commitBody = {
    message: commitMsg || 'Initial commit',
    tree: treeRes.sha,
    parents: parent ? [parent] : [],
  };
  const commit = ghJson(
    ['-X', 'POST', `repos/${OWNER}/${REPO}/git/commits`, '--input', '-'],
    JSON.stringify(commitBody),
  );
  console.log(`commit ${commit.sha}`);

  if (parent) {
    ghJson(
      ['-X', 'PATCH', `repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, '--input', '-'],
      JSON.stringify({ sha: commit.sha, force: false }),
    );
  } else {
    ghJson(
      ['-X', 'POST', `repos/${OWNER}/${REPO}/git/refs`, '--input', '-'],
      JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
    );
  }

  console.log(`OK https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
