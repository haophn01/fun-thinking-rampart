import type { AuditAction, AuditEntityType } from '@rampart/api/contract';

/** What each audit action reads as in the log. Typed over the contract, so a new action fails to compile here. */
export const ACTION_LABELS: Record<AuditAction, string> = {
  'user.created': 'User created',
  'user.updated': 'User changed',
  'user.password_reset': 'Password reset',
  'auth.signed_in': 'Signed in',
  'auth.signed_out': 'Signed out',
  'auth.locked_out': 'Account locked after failed sign-ins',
  'assessment.created': 'Assessment created',
  'assessment.updated': 'Assessment settings changed',
  'objective_result.updated': 'Objective result updated',
  'requirement_state.updated': 'Requirement updated',
};

export const ENTITY_LABELS: Record<AuditEntityType, string> = {
  user: 'User',
  assessment: 'Assessment',
  objective_result: 'Objective',
  requirement_state: 'Requirement',
};
