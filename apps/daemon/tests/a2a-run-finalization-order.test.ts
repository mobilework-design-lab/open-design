import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('A2A run finalization ordering', () => {
  it('classifies the child close status before checking A2A success', async () => {
    const source = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    const closeHandlerStart = source.indexOf("child.on('close', async (code, signal) => {");
    const statusDeclaration = source.indexOf(
      'const status = classifyChatRunCloseStatus({',
      closeHandlerStart,
    );
    const a2aSuccessGuard = source.indexOf(
      "status === 'succeeded' && run.a2aClient && !run.questionForm",
      closeHandlerStart,
    );

    expect(closeHandlerStart).toBeGreaterThanOrEqual(0);
    expect(statusDeclaration).toBeGreaterThan(closeHandlerStart);
    expect(a2aSuccessGuard).toBeGreaterThan(statusDeclaration);
  });
});
