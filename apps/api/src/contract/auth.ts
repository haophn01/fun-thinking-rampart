import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema, roleSchema } from './common';

/** The signed-in user as the session reports them. */
export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** `GET /api/session`, and the result of setup and sign-in. */
export const sessionResponseSchema = z.object({
  setupRequired: z.boolean(),
  user: sessionUserSchema.nullable(),
  csrfToken: z.string().nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** `POST /api/setup`: the first admin. */
export const setupRequestSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});
export type SetupRequest = z.infer<typeof setupRequestSchema>;

/**
 * `POST /api/session` (sign in). No email format or password length rule beyond sanity limits,
 * so every wrong guess gets the same "Email or password is incorrect." answer.
 */
export const signInRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;
