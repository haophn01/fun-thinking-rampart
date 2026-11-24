import { describe, expect, it } from 'vitest';
import { DevPortsError, resolveDevPorts } from './dev-ports';

describe('dev ports', () => {
  it('resolves web and api ports', () => {
    // Defaults: the plan's port base 3000.
    expect(resolveDevPorts({})).toEqual({ web: 3000, api: 3001 });
    // An empty value counts as unset, like `set API_PORT=` in cmd.
    expect(resolveDevPorts({ WEB_PORT: '', API_PORT: '' })).toEqual({ web: 3000, api: 3001 });

    // Env wins, including both ends of the valid range.
    expect(resolveDevPorts({ WEB_PORT: '3010', API_PORT: '3011' })).toEqual({
      web: 3010,
      api: 3011,
    });
    expect(resolveDevPorts({ WEB_PORT: '1', API_PORT: '65535' })).toEqual({ web: 1, api: 65535 });

    // Non-integer or out-of-range values are rejected.
    for (const bad of ['0', '65536', '-1', 'abc', '3000.5', '1e3', ' 3000', '0x10', '3000abc']) {
      expect(() => resolveDevPorts({ WEB_PORT: bad }), `WEB_PORT=${bad}`).toThrow(DevPortsError);
      expect(() => resolveDevPorts({ API_PORT: bad }), `API_PORT=${bad}`).toThrow(DevPortsError);
    }

    // One error names every bad key.
    expect(() => resolveDevPorts({ WEB_PORT: 'x', API_PORT: '70000' })).toThrow(
      /WEB_PORT.*"x".*API_PORT.*"70000"/s,
    );

    // The two servers cannot share a port.
    expect(() => resolveDevPorts({ WEB_PORT: '3001' })).toThrow(/WEB_PORT and API_PORT/);
  });
});
