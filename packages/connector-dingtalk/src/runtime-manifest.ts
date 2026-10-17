/** Project only original Host settings metadata for the retained SDK15 validator.
 * Host admission keeps the full declaration; runtime authority fields are untouched.
 */
export function legacyRuntimeManifest(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const { permissions, ...runtime } = input;
  if (permissions !== undefined) {
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions) ||
        !Object.hasOwn(permissions, 'label') || typeof (permissions as Record<string, unknown>).label !== 'string' ||
        Object.keys(permissions).some(key => key !== 'label')) {
      throw new TypeError('Invalid original connector permissions declaration');
    }
  }
  if (Array.isArray(input.steps)) runtime.steps = input.steps.map(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const { mode, ...textStep } = step as Record<string, unknown>;
    if (mode !== undefined && typeof mode !== 'string') throw new TypeError('Invalid original setup step mode');
    return textStep;
  });
  return runtime;
}
