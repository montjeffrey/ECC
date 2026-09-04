/**
 * Tests for the essential/extended split of the command and agent surfaces.
 *
 * commands-core shipped all 94 commands and agents-core all 68 agents, so
 * `minimal` cost the same listing tokens as `full` on those two surfaces and
 * could not fit a context budget. The split introduces commands-essential /
 * commands-extended and agents-essential / agents-extended, and keeps the
 * old ids as aggregates so nothing that already selects them changes.
 *
 * Run with: node tests/lib/install-module-granularity.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { test, banner } = require('./helpers/mini-test-runner');
const { resolveInstallPlan } = require('../../scripts/lib/install-manifests');

const repoRoot = path.resolve(__dirname, '../..');
const CHARS_PER_TOKEN = 3.2;
const BUDGET = 8000;

let passed = 0;
let failed = 0;

function run(name, fn) {
  if (test(name, fn)) passed++;
  else failed++;
}

/** Every repo-relative file a selection installs, with directories expanded. */
function installedFiles(selection) {
  const plan = resolveInstallPlan({ repoRoot, ...selection });
  const files = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        files.add(path.relative(repoRoot, abs).split(path.sep).join('/'));
      }
    }
  };
  for (const module of plan.selectedModules) {
    for (const relPath of module.paths || []) {
      const abs = path.join(repoRoot, ...relPath.split('/'));
      if (!fs.existsSync(abs)) {
        files.add(relPath);
      } else if (fs.statSync(abs).isDirectory()) {
        walk(abs);
      } else {
        files.add(relPath);
      }
    }
  }
  return files;
}

function countIn(files, prefix) {
  return [...files].filter(f => f.startsWith(prefix) && f.endsWith('.md')).length;
}

/** Listing characters for a set of Markdown surfaces, as the ledger counts them. */
function listingChars(files) {
  let chars = 0;
  for (const rel of files) {
    if (!rel.endsWith('.md')) {
      continue;
    }
    // Only the three surfaces Claude Code lists. `.agents/skills/**` is an
    // installer surface for the Antigravity target, not session context.
    const listed = rel.startsWith('commands/')
      || rel.startsWith('agents/')
      || (rel.startsWith('skills/') && rel.split('/').length === 3 && rel.endsWith('/SKILL.md'));
    if (!listed) {
      continue;
    }
    const source = fs.readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match) {
      continue;
    }
    const lines = match[1].split(/\r?\n/);
    const nameLine = lines.find(line => /^name:/.test(line));
    const name = nameLine ? nameLine.slice(5).trim().replace(/^["']|["']$/g, '') : path.basename(rel, '.md');
    const start = lines.findIndex(line => /^description:/.test(line));
    let description = '';
    if (start !== -1) {
      const inline = lines[start].slice('description:'.length).trim();
      if (/^([>|])([-+]?)$/.test(inline)) {
        const body = [];
        for (let i = start + 1; i < lines.length; i += 1) {
          if (lines[i].trim() === '') { body.push(''); continue; }
          if (!/^\s/.test(lines[i])) break;
          body.push(lines[i].trim());
        }
        description = body.join(' ');
      } else {
        description = inline.replace(/^["']|["']$/g, '');
      }
    }
    chars += `${name}: ${description.replace(/\s+/g, ' ').trim()}`.length;
  }
  return chars;
}

banner('Testing install module granularity');

function diskCount(dir) {
  return fs.readdirSync(path.join(repoRoot, dir)).filter(f => f.endsWith('.md')).length;
}

run('core and extended partition the surface with nothing lost or duplicated', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifests', 'install-modules.json'), 'utf8'));
  for (const [dir, coreId, extendedId] of [['commands', 'commands-core', 'commands-extended'], ['agents', 'agents-core', 'agents-extended']]) {
    const core = manifest.modules.find(m => m.id === coreId).paths.filter(p => p.startsWith(`${dir}/`));
    const extended = manifest.modules.find(m => m.id === extendedId).paths.filter(p => p.startsWith(`${dir}/`));
    const union = [...core, ...extended];
    assert.strictEqual(new Set(union).size, union.length, `${dir}: a file is claimed by both modules`);
    assert.strictEqual(union.length, diskCount(dir), `${dir}: every file must be in exactly one module`);
    assert.ok(core.length > 0 && extended.length > 0, `${dir}: both halves must be non-empty`);
  }
});

run('core and extended are independently selectable, and together are the whole surface', () => {
  for (const [coreId, extendedId, dir] of [
    ['commands-core', 'commands-extended', 'commands'],
    ['agents-core', 'agents-extended', 'agents'],
  ]) {
    const core = countIn(installedFiles({ moduleIds: [coreId] }), `${dir}/`);
    const extended = countIn(installedFiles({ moduleIds: [extendedId] }), `${dir}/`);
    assert.ok(core > 0 && extended > 0, `${dir}: both halves must select on their own`);
    assert.strictEqual(core + extended, diskCount(dir), `${dir}: the two halves must sum to the whole`);
    assert.strictEqual(
      countIn(installedFiles({ moduleIds: [coreId, extendedId] }), `${dir}/`),
      diskCount(dir),
      `${dir}: selecting both must give the pre-split surface`
    );
  }
});

run('the extended modules take no dependency on the core, so --without still works', () => {
  // agents-extended depending on agents-core would turn every existing
  // `--without agent:<id>` exclusion into a hard error, because excluding a
  // module that something else depends on is a refusal, not a filter.
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifests', 'install-modules.json'), 'utf8'));
  for (const [extendedId, coreId] of [['commands-extended', 'commands-core'], ['agents-extended', 'agents-core']]) {
    const module = manifest.modules.find(entry => entry.id === extendedId);
    assert.ok(module, `${extendedId} must exist`);
    assert.ok(!module.dependencies.includes(coreId), `${extendedId} must not depend on ${coreId}`);
  }
});

run('machine-learning names the agent it needs instead of relying on a whole directory', () => {
  // It used to get mle-reviewer.md incidentally, because agents-core shipped
  // agents/ wholesale. With the split that is no longer true, so the
  // dependency has to be explicit or a minimal ML install loses the reviewer.
  const files = installedFiles({ moduleIds: ['machine-learning'] });
  assert.ok(files.has('agents/mle-reviewer.md'), 'an ML install must still carry the MLE reviewer');
});

run('every profile except minimal installs an identical file set', () => {
  // The whole point of keeping the old ids as aggregates: this change is a
  // granularity change, not a surface change, for everyone but minimal.
  for (const profileId of ['opencode', 'core', 'developer', 'security', 'research', 'full']) {
    const files = installedFiles({ profileId });
    assert.strictEqual(
      countIn(files, 'commands/'),
      fs.readdirSync(path.join(repoRoot, 'commands')).filter(f => f.endsWith('.md')).length,
      `${profileId} must still install every command`
    );
    if (resolveInstallPlan({ repoRoot, profileId }).selectedModuleIds.some(id => id.startsWith('agents'))) {
      assert.strictEqual(
        countIn(files, 'agents/'),
        fs.readdirSync(path.join(repoRoot, 'agents')).filter(f => f.endsWith('.md')).length,
        `${profileId} must still install every agent`
      );
    }
  }
});

run('minimal drops only the extended halves, and adds nothing', () => {
  const files = installedFiles({ profileId: 'minimal' });
  assert.ok(countIn(files, 'commands/') < diskCount('commands'), 'minimal must not carry every command');
  assert.ok(countIn(files, 'agents/') < diskCount('agents'), 'minimal must not carry every agent');

  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifests', 'install-modules.json'), 'utf8'));
  const coreOnly = new Set([
    ...manifest.modules.find(m => m.id === 'commands-core').paths,
    ...manifest.modules.find(m => m.id === 'agents-core').paths,
  ]);
  for (const rel of [...files].filter(f => f.startsWith('commands/') || f.startsWith('agents/'))) {
    assert.ok(coreOnly.has(rel), `${rel} is in minimal but not in a core module`);
  }
});

run('minimal now fits the 8000-token listing budget', () => {
  const files = installedFiles({ profileId: 'minimal' });
  const chars = listingChars(files);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  assert.ok(
    tokens <= BUDGET,
    `minimal listing is ${tokens} tokens (${chars} chars), over the ${BUDGET} budget`
  );
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
