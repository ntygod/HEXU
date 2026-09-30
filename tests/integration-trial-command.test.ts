import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  integrationTrialCommand,
  integrationCandidateApplicationCommand,
  integrationTrialDifferenceCommand,
  quoteShellArgument,
  sortTrialPaths,
} from '../apps/web/src/integration-trial-command.js';

function argumentsOf(command: string): string[] {
  // Parse via a real POSIX shell without invoking npm, node, or the trial writer.
  const result = spawnSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').slice(0, -1);
}

test('trial command shell quoting keeps every path and placeholder one literal argument', () => {
  const paths = [
    "notes/it's a file.txt",
    '$(printf INJECTED); file.txt',
    '"quote".txt',
    '`printf altered`.txt',
    '中文 空格.txt',
  ];
  const input = [...paths];
  const args = argumentsOf(integrationTrialCommand('operation-fixed', paths));
  assert.deepEqual(args, [
    'npm',
    'run',
    'runner:integration-trial',
    '--',
    '--operation',
    'operation-fixed',
    '--state',
    '<原节点状态目录>',
    '--target',
    '<新的绝对目录>',
    '--files',
    JSON.stringify(sortTrialPaths(paths)),
  ]);
  assert.deepEqual(paths, input, 'command generation does not mutate selection');
  assert.deepEqual(JSON.parse(args.at(-1)!), sortTrialPaths(paths));
});

test('shell arguments handle empty strings, apostrophes, newlines and metacharacters literally', () => {
  const values = ['', "'", "a'b'c", 'one\ntwo', '${HOME} * ? < > & | ; \\ "'];
  assert.deepEqual(argumentsOf(values.map(quoteShellArgument).join(' ')), values);
});

test('trial selection uses UTF-8 byte order rather than UTF-16 or locale ordering', () => {
  const values = ['𐀀.txt', '\ue000.txt', 'é.txt', 'e\u0301.txt', 'a.txt', 'A.txt'];
  assert.deepEqual(
    sortTrialPaths(values),
    [...values].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  );
});

test('difference command retains original operation and explicitly requires local ready trial ID', () => {
  assert.deepEqual(argumentsOf(integrationTrialDifferenceCommand('original-operation')), [
    'npm',
    'run',
    'runner:integration-trial-diff',
    '--',
    '--operation',
    'original-operation',
    '--state',
    '<原节点状态目录>',
    '--trial',
    '<本机 ready 候选的 trialId>',
  ]);
});

test('candidate application command binds operation and quotes the separately selected private backup path', () => {
  assert.deepEqual(argumentsOf(integrationCandidateApplicationCommand("op'fixed")), [
    'npm',
    'run',
    'runner:integration-apply',
    '--',
    '--operation',
    "op'fixed",
    '--state',
    '<原节点状态目录>',
    '--backup',
    '<全新私有备份绝对目录>',
  ]);
});
