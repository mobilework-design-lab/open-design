import { describe, expect, it, vi } from 'vitest';

import { logDaemonFatalError } from '../src/routes/telemetry.js';

describe('daemon fatal error logging', () => {
  it('writes the fatal event, message, and stack to stderr before exit', () => {
    const error = vi.fn();

    logDaemonFatalError(
      'daemon_unhandled_rejection',
      {
        error_message: "Cannot access 'status' before initialization",
        error_stack: 'ReferenceError: status is not initialized',
      },
      { error },
    );

    expect(error).toHaveBeenCalledWith(
      "[daemon] daemon_unhandled_rejection: Cannot access 'status' before initialization\n"
        + 'ReferenceError: status is not initialized',
    );
  });
});
