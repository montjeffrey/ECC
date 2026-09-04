#!/usr/bin/env node
/**
 * Propose and cost a core/extended split of the command and agent surfaces.
 *
 * The install profiles were never tuned to a context budget: `commands-core`
 * ships every command and `agents-core` every agent, so `minimal` costs the
 * same listing tokens as `full` on those two surfaces. This tool makes the
 * cut explicit and checkable: it prints the character and token cost of the
 * proposed core sets, the extended remainder, and the resulting `minimal`
 * ledger against the 8k budget.
 *
 * It is a review aid, not a generator: the chosen ids live in
 * manifests/install-modules.json, and this file only explains and costs them.
 *
 * Usage:
 *   node scripts/ci/propose-core-split.js
 *   node scripts/ci/propose-core-split.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CHARS_PER_TOKEN = 3.2;
const BUDGET = 8000;

// The daily set. Selection rule: every command in COMMANDS-QUICK-REF.md's
// "Core Workflow", "Session Management" and "Planning & Architecture"
// sections that is not language-specific, plus the generic entries from
// Testing, Code Review, Build Fixers, Learning and Project & Infrastructure.
// Everything language- or framework-specific (react-*, go-*, cpp-*, rust-*,
// kotlin-*, flutter-*, vue-*, fastapi-*, python-*, gradle-*) is extended, as
// are the multi-model, PRP, epic, orch, hookify and marketing families.
const CORE_COMMANDS = [
  'aside',
  'auto-update',
  'build-fix',
  'checkpoint',
  'code-review',
  'cost-report',
  'ecc-guide',
  'evolve',
  'feature-dev',
  'harness-audit',
  'learn',
  'learn-eval',
  'loop-start',
  'loop-status',
  'model-route',
  'plan',
  'plan-canvas',
  'plan-prd',
  'pr',
  'project-init',
  'projects',
  'quality-gate',
  'refactor-clean',
  'resume-session',
  'review-pr',
  'save-session',
  'security-scan',
  'sessions',
  'setup-pm',
  'skill-create',
  'skill-health',
  'test-coverage',
  'update-codemaps',
  'update-docs',
];

// The agents a generic session actually reaches for: planning, review,
// testing, refactoring, docs, and the harness itself. Every language- or
// framework-specific reviewer and build-resolver is extended.
const CORE_AGENTS = [
  'agent-evaluator',
  'architect',
  'build-error-resolver',
  'code-architect',
  'code-explorer',
  'code-reviewer',
  'code-simplifier',
  'database-reviewer',
  'doc-updater',
  'docs-lookup',
  'e2e-runner',
  'harness-optimizer',
  'loop-operator',
  'performance-optimizer',
  'planner',
  'refactor-cleaner',
  'security-reviewer',
  'silent-failure-hunter',
  'tdd-guide',
  'typescript-reviewer',
];

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) {
    return { name: '', description: '' };
  }
  const lines = match[1].split(/\r?\n/);
  const nameLine = lines.find(line => /^name:/.test(line));
  const name = nameLine ? nameLine.slice('name:'.length).trim().replace(/^["']|["']$/g, '') : '';
  const start = lines.findIndex(line => /^description:/.test(line));
  if (start === -1) {
    return { name, description: '' };
  }
  const inline = lines[start].slice('description:'.length).trim();
  const block = /^([>|])([-+]?)$/.exec(inline);
  if (!block) {
    return { name, description: inline.replace(/^["']|["']$/g, '') };
  }
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      body.push('');
      continue;
    }
    if (!/^\s/.test(lines[i])) {
      break;
    }
    body.push(lines[i].trim());
  }
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
  }
  const folded = block[1] === '>';
  let description = '';
  for (const line of body) {
    if (line === '') {
      description += '\n';
    } else if (description === '' || description.endsWith('\n')) {
      description += line;
    } else {
      description += folded ? ` ${line}` : `\n${line}`;
    }
  }
  return { name, description: description.trim() };
}

function listingCost(dir, file) {
  const { name, description } = parseFrontmatter(fs.readFileSync(path.join(REPO_ROOT, dir, file), 'utf8'));
  const id = name || file.replace(/\.md$/, '');
  return `${id}: ${String(description || '').replace(/\s+/g, ' ').trim()}`.length;
}

function split(dir, coreIds) {
  const all = fs.readdirSync(path.join(REPO_ROOT, dir)).filter(f => f.endsWith('.md'));
  const known = new Set(all.map(f => f.replace(/\.md$/, '')));
  const missing = coreIds.filter(id => !known.has(id));
  const core = all.filter(f => coreIds.includes(f.replace(/\.md$/, '')));
  const extended = all.filter(f => !coreIds.includes(f.replace(/\.md$/, '')));
  const sum = files => files.reduce((total, f) => total + listingCost(dir, f), 0);
  return {
    core: { files: core, count: core.length, chars: sum(core) },
    extended: { files: extended, count: extended.length, chars: sum(extended) },
    missing,
  };
}

function minimalSkillChars() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8'));
  const ids = new Set();
  for (const moduleId of ['workflow-quality', 'skill-unified-memory']) {
    const module = manifest.modules.find(entry => entry.id === moduleId);
    for (const relPath of (module && module.paths) || []) {
      ids.add(relPath);
    }
  }
  let chars = 0;
  let count = 0;
  for (const relPath of ids) {
    const file = path.join(REPO_ROOT, relPath, 'SKILL.md');
    if (!fs.existsSync(file)) {
      continue;
    }
    const { name, description } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    chars += `${name || relPath}: ${String(description || '').replace(/\s+/g, ' ').trim()}`.length;
    count += 1;
  }
  return { chars, count };
}

function main() {
  const asJson = process.argv.includes('--json');
  const commands = split('commands', CORE_COMMANDS);
  const agents = split('agents', CORE_AGENTS);
  const skills = minimalSkillChars();

  // The catalog skill the carrier synthesizes is one extra listing entry.
  const catalogChars = 246;
  const minimalChars = skills.chars + catalogChars + agents.core.chars + commands.core.chars;
  const minimalTokens = Math.ceil(minimalChars / CHARS_PER_TOKEN);
  const beforeChars = skills.chars + catalogChars
    + agents.core.chars + agents.extended.chars
    + commands.core.chars + commands.extended.chars;

  const report = {
    commands: { core: commands.core.count, coreChars: commands.core.chars, extended: commands.extended.count, extendedChars: commands.extended.chars },
    agents: { core: agents.core.count, coreChars: agents.core.chars, extended: agents.extended.count, extendedChars: agents.extended.chars },
    minimalSkills: skills,
    before: { chars: beforeChars, tokens: Math.ceil(beforeChars / CHARS_PER_TOKEN) },
    after: { chars: minimalChars, tokens: minimalTokens },
    budget: BUDGET,
    withinBudget: minimalTokens <= BUDGET,
    unknownCoreIds: [...commands.missing, ...agents.missing],
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`commands: core ${commands.core.count} (${commands.core.chars} chars), `
    + `extended ${commands.extended.count} (${commands.extended.chars} chars)`);
  console.log(`agents:   core ${agents.core.count} (${agents.core.chars} chars), `
    + `extended ${agents.extended.count} (${agents.extended.chars} chars)`);
  console.log(`minimal skills: ${skills.count} (${skills.chars} chars)`);
  console.log('');
  console.log(`minimal before: ${report.before.chars} chars = ${report.before.tokens} tokens`);
  console.log(`minimal after:  ${report.after.chars} chars = ${report.after.tokens} tokens `
    + `(budget ${BUDGET}: ${report.withinBudget ? 'WITHIN' : 'OVER'})`);
  if (report.unknownCoreIds.length > 0) {
    console.error(`\nERROR: core list names things that do not exist: ${report.unknownCoreIds.join(', ')}`);
    process.exitCode = 1;
  }
}

main();

module.exports = { CORE_COMMANDS, CORE_AGENTS };
