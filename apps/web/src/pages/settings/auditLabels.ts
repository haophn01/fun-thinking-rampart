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
  'poam_item.created': 'POA&M item created',
  'poam_item.updated': 'POA&M item changed',
  'poam_item.closed': 'POA&M item closed out',
  'evidence.created': 'Evidence created',
  'evidence.updated': 'Evidence changed',
  'evidence.links_updated': 'Evidence objective links changed',
  'evidence.version_added': 'Evidence version added',
  'policy.created': 'Policy created',
  'policy.updated': 'Policy changed',
  'policy.links_updated': 'Policy requirement links changed',
  'policy.version_added': 'Policy version added',
  'system_profile.updated': 'System profile changed',
};

export const ENTITY_LABELS: Record<AuditEntityType, string> = {
  user: 'User',
  assessment: 'Assessment',
  objective_result: 'Objective',
  requirement_state: 'Requirement',
  poam_item: 'POA&M item',
  evidence_item: 'Evidence',
  policy: 'Policy',
  system_profile: 'System profile',
};
