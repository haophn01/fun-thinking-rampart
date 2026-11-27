import { z } from 'zod';
import { displayNameSchema, emailSchema, passwordSchema, roleSchema } from './common';

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Two-step sign-in is set up (`mfa_enrolled_at` is set). Old answers read as not set up. */
  mfaEnrolled: z.boolean().default(false),
});
export type User = z.infer<typeof userSchema>;

/** `GET /api/users`. */
export const usersResponseSchema = z.object({ users: z.array(userSchema) });
export type UsersResponse = z.infer<typeof usersResponseSchema>;

/** `POST /api/users` and `PATCH /api/users/:id`. */
export const userResponseSchema = z.object({ user: userSchema });
export type UserResponse = z.infer<typeof userResponseSchema>;

/** `POST /api/users` (admin). */
export const createUserRequestSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  role: roleSchema,
  password: passwordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** `PATCH /api/users/:id` (admin). At least one key; `password` resets it. */
export const updateUserRequestSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    password: passwordSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
