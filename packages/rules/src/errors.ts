export class RulesInputError extends Error { constructor(
  readonly code: 'unknown_objective' | 'duplicate_objective' | 'unknown_requirement' | 'invalid_implementation_level' | 'invalid_date',
  message: string) { super(message); this.name = 'RulesInputError'; } }
