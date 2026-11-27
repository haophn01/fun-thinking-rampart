import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAudit } from '../audit/record';
import {
  signInNoticeResponseSchema,
  updateSignInNoticeRequestSchema,
  type SignInNoticeResponse,
} from '../contract';
import { AppError } from '../errors';
import { respond } from '../respond';
import type { ApiDeps } from '../routes';
import { getSignInNotice, getSignInNoticeText, setSignInNotice } from './repository';

/**
 * `PUT /api/settings/sign-in-notice`: stores the trimmed text (null or blank turns the notice
 * off) and audits `settings.updated` with before and after. Saving the text already stored
 * changes nothing and writes no event.
 */
function updateSignInNotice(deps: ApiDeps, request: FastifyRequest): SignInNoticeResponse {
  const actor = request.auth?.user.id;
  if (actor === undefined) throw new AppError('unauthenticated', 'Sign in to continue.');
  const { text } = updateSignInNoticeRequestSchema.parse(request.body);
  const now = deps.now();
  return deps.db.transaction((tx) => {
    const current = getSignInNoticeText(tx);
    if (current !== text) {
      setSignInNotice(tx, text, actor, now);
      recordAudit(tx, {
        at: now,
        actorUserId: actor,
        action: 'settings.updated',
        entityType: 'settings',
        entityId: 'sign_in_notice',
        before: { signInNotice: current },
        after: { signInNotice: text },
        requestId: request.id,
      });
    }
    return { signInNotice: getSignInNotice(tx) };
  });
}

/** App-wide settings: admins change them; everyone reads the notice from `GET /api/session`. */
export function registerSettingsRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.put('/api/settings/sign-in-notice', { config: { role: 'admin' } }, (request) =>
    respond(signInNoticeResponseSchema, updateSignInNotice(deps, request)),
  );
}
